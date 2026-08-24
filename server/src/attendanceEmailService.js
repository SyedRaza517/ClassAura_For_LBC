// Automated student-attendance emails — the compute + email-building core.
//
// This module turns "who is enrolled, and how are they attending this semester"
// into a set of ready-to-send, per-student emails, and sends them. It deliberately
// holds no HTTP/route logic: a route (or a scheduled job) resolves the semester and
// the template config, calls the functions here, and reports the result.
//
// Percentages ALWAYS come from summariseCounts() in ./attendance so this figure
// matches the register views, the student's own app and the executive dashboard —
// one student, one attendance number, everywhere.
//
// Which % lands in which template is a PER-COLLEGE decision: the bands are resolved
// through ./attendanceBandConfig, which serves that institution's own ladder and
// falls back to the defaults in ./attendanceBands for a college that has set none.
// ./attendanceBands also holds the default templates, used as the defensive fallback
// whenever the caller passes a partial config.

const prisma = require("./db");
// Raw SQL sits outside the isolation extension (which hooks $allModels only), so the
// aggregate below scopes itself rather than spanning every institution.
const { currentTenantId } = require("./db");
function tenantForSql() {
  const t = currentTenantId();
  if (!t) throw new Error("Raw SQL attempted with no tenant context");
  return t;
}
const { summariseCounts } = require("./attendance");
const email = require("./email");
const bands = require("./attendanceBands");
// This college's OWN bands — the code defaults are only what an unconfigured college
// resolves to. See attendanceBandConfig.js.
const bandConfig = require("./attendanceBandConfig");
const mailFrom = require("./mailFrom");
const mailAssets = require("./mailAssets");
const branding = require("./branding");
const clock = require("./clock");

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Inline-escape a value for a single-quoted SQL literal. Copied from the HND
// /attendance handler: the counting happens IN POSTGRES (grouping millions of
// marks in Node OOM-crashes at scale), and every value here comes from our own
// Semester rows — never user input — so inlining is safe.
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// HTML-escape any student/config-derived text before it goes into the HTML email.
const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// "<Month YYYY>" for a given date — the human {period} fallback when a semester
// has no name of its own.
const monthYearLabel = (d = new Date()) => `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

// Per-band visual theme for the HTML email — the whole email (header, hero, bullets,
// module table, signature) is tinted to the student's band, so a top attender gets a
// green, celebratory email and a high-risk one a serious, red email.
//
// These six are PRESETS for the built-in band keys, not the only themes possible: a
// college can invent bands, and every band carries its own colour, so themeForBand()
// below derives the whole palette from that colour for anything not listed here. The
// presets survive because they also carry a hand-written `note` line, which is prose
// about that specific band and cannot be computed from a hex value.
const BAND_THEME = {
  excellent: { grad: ["#0f7a4f", "#15803d"], accent: "#15803d", bar: "#22c55e", soft: "#ecfdf5", border: "#bbf7d0", note: "🌟 You're among the most consistent students in your cohort — keep it up!" },
  great:     { grad: ["#0e7490", "#0f766e"], accent: "#0f766e", bar: "#14b8a6", soft: "#ecfeff", border: "#a5f3fc", note: "👏 A strong, consistent record — you're almost at the top band." },
  good:      { grad: ["#1e40af", "#2563eb"], accent: "#2563eb", bar: "#3b82f6", soft: "#eff6ff", border: "#bfdbfe", note: "📌 A solid record — a little more consistency will make a real difference." },
  average:   { grad: ["#b45309", "#d97706"], accent: "#b45309", bar: "#f59e0b", soft: "#fffbeb", border: "#fde68a", note: "🔔 Your attendance has dipped below what the programme expects — let's talk." },
  risk:      { grad: ["#c2410c", "#ea580c"], accent: "#c2410c", bar: "#f97316", soft: "#fff7ed", border: "#fed7aa", note: "⚠️ Your attendance needs attention now to protect your progress." },
  highrisk:  { grad: ["#b91c1c", "#9f1239"], accent: "#b91c1c", bar: "#ef4444", soft: "#fef2f2", border: "#fecaca", note: "🚨 Urgent: your place on the programme is at risk — please respond." },
};
const DEFAULT_THEME = BAND_THEME.good;

// --- deriving a theme from a band's own colour ---------------------------------
//
// A college's own band ("Borderline", "Amber", a hard 80% visa line) has a colour and
// nothing else. Rather than fall back to the blue "good" theme — which would send a
// college's most serious letter looking identical to its most encouraging one — the
// six tints the email needs are computed from that one colour: a darker head for the
// gradient, a lighter bar, and two very pale mixes for the bullet card.

const clamp255 = (n) => Math.max(0, Math.min(255, Math.round(n)));
const toHex = (r, g, b) => "#" + [r, g, b].map((v) => clamp255(v).toString(16).padStart(2, "0")).join("");

// "#abc" and "#aabbcc" both parse; anything else returns null and the caller keeps
// the default theme rather than emitting a broken colour into a style attribute.
function hexToRgb(hex) {
  const s = String(hex || "").trim().replace(/^#/, "");
  const full = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}
// Mix towards white (t=1 is white) or towards black (t negative).
function mix(rgb, t) {
  const target = t >= 0 ? 255 : 0;
  const amount = Math.abs(t);
  return toHex(...rgb.map((c) => c + (target - c) * amount));
}

/**
 * The email palette for one band. A built-in band whose colour is still the built-in
 * colour keeps its preset verbatim — that is what makes "a college that configured
 * nothing looks exactly as it did" literally true, byte for byte. Everything else is
 * derived from the band's own colour, keeping the preset's note line if there is one.
 */
function themeForBand(band) {
  const b = band || {};
  const preset = BAND_THEME[b.key];
  if (preset && (!b.colour || String(b.colour).toLowerCase() === preset.accent)) return preset;
  const rgb = hexToRgb(b.colour);
  if (!rgb) return preset || DEFAULT_THEME;
  return {
    grad: [mix(rgb, -0.22), mix(rgb, -0.02)],
    accent: toHex(...rgb),
    bar: mix(rgb, 0.22),
    soft: mix(rgb, 0.94),
    border: mix(rgb, 0.74),
    // Prose about a specific band cannot be derived. A college's own band simply has
    // none, and htmlShell leaves the note card out rather than printing an empty one.
    note: preset ? preset.note : "",
  };
}

// The three-colour foreground palette for the per-module percentage cell:
// green >= 60, amber 40–59, red < 40.
// (Course names are stored verbosely, e.g. "HND Sustainable Business Management – June
// 2026 | Pearson BTEC Level 5 Higher National Diploma in Sustainable Business Management",
// which repeats the subject. cleanProgramme keeps the short human form before the
// "| Pearson BTEC …" title — or before a bare "Pearson BTEC …" when the pipe is missing —
// so the subject is shown once, not twice.)
function cleanProgramme(name) {
  if (!name) return "";
  let s = String(name).trim();
  const pipe = s.search(/\s*\|\s*Pearson\b/i);
  if (pipe > -1) s = s.slice(0, pipe);
  else {
    const bare = s.search(/\s+Pearson\s+BTEC\b/i);
    if (bare > -1) s = s.slice(0, bare);
  }
  return s.replace(/[\s|–-]+$/, "").trim();
}
// Just the foreground colour, for the per-module percentage cell.
function pctColour(pct) {
  if (pct == null) return "#64748b";
  if (pct >= 60) return "#047857";
  if (pct >= 40) return "#b45309";
  return "#b91c1c";
}

// ---------------------------------------------------------------------------
// 1) currentTerm — derived from the registers, not a separate setting
// ---------------------------------------------------------------------------

// A "Month YYYY" or "Month–Month YYYY" label for a date range (both "YYYY-MM-DD").
function rangeLabel(start, end) {
  if (!start) return monthYearLabel();
  const s = new Date(`${start}T00:00:00Z`);
  const e = new Date(`${end || start}T00:00:00Z`);
  const sm = MONTHS[s.getUTCMonth()], em = MONTHS[e.getUTCMonth()];
  if (s.getUTCFullYear() === e.getUTCFullYear() && sm === em) return `${sm} ${s.getUTCFullYear()}`;
  if (s.getUTCFullYear() === e.getUTCFullYear()) return `${sm}–${em} ${s.getUTCFullYear()}`;
  return `${sm} ${s.getUTCFullYear()}–${em} ${e.getUTCFullYear()}`;
}

// The current teaching term, taken FROM THE REGISTERS: the units running today
// (Unit.startDate <= today <= Unit.endDate — the admin-set teaching window that also
// drives register generation). Their combined date span and unit set define "this term".
// If no unit has teaching dates yet, fall back to a manually-set current Semester (scope by
// date only). Returns { name, start, end, unitIds } or null.
//   unitIds — the running units; attendance is restricted to these. null in the Semester
//   fallback, where we scope by the date range instead.
async function currentTerm() {
  const today = clock.localDate(); // YYYY-MM-DD in London (Europe/London), not UTC

  const running = await prisma.unit.findMany({
    where: { startDate: { not: null, lte: today }, endDate: { not: null, gte: today } },
    select: { id: true, startDate: true, endDate: true, term: { select: { name: true } } },
  });
  if (running.length) {
    const starts = running.map((u) => u.startDate).sort();
    const ends = running.map((u) => u.endDate).sort();
    const start = starts[0], end = ends[ends.length - 1];
    // If every running unit shares one dated Term, use its name; otherwise a date range.
    const termNames = [...new Set(running.map((u) => u.term && u.term.name).filter(Boolean))];
    const name = termNames.length === 1 ? termNames[0] : rangeLabel(start, end);
    return { name, start, end, unitIds: running.map((u) => u.id) };
  }

  // Fallback: an admin-set current Semester whose [start, end] contains today.
  const sems = await prisma.semester.findMany({
    where: { start: { lte: today }, end: { gte: today } },
    orderBy: { start: "desc" },
  });
  const s = sems[0];
  if (s) return { name: s.name, start: s.start, end: s.end, unitIds: null };
  return null;
}

// A custom, admin-chosen reporting period: attendance is computed over [from, to] across
// ALL of each student's current enrolments (no unit restriction), and the email's {period}
// reads as the month/range label. Both dates are "YYYY-MM-DD"; returns null if either is
// missing. Swapped inputs are tolerated. This backs the From–To picker on the tab.
function termFromRange(from, to) {
  if (!from || !to) return null;
  const a = String(from) <= String(to) ? from : to;
  const b = String(from) <= String(to) ? to : from;
  return { name: rangeLabel(a, b), start: a, end: b, unitIds: null };
}

// ---------------------------------------------------------------------------
// 2) computeCurrentTermAttendance
// ---------------------------------------------------------------------------

// Build the per-student attendance picture for the current term:
//   { term, period, students: [ { …, pct, bandKey, bandLabel, modules[] } ] }
//
// `term` = { name, start, end, unitIds } from currentTerm(). Only CURRENTLY-enrolled units
// count (the SQL joins Enrolment), and — when term.unitIds is set — only the units running
// this term, so a figure can't be dragged by a unit the student has left or that isn't part
// of this term. A student with no marks this term is still returned, but with pct null,
// modules [] and bandKey null, so the caller can simply skip them.
async function computeCurrentTermAttendance(term, bandList) {
  const semester = term; // same shape { start, end, name }; term.unitIds may restrict units
  // THIS college's bands. Passed in by a caller that already resolved them (the route
  // resolves them once to label its headcounts), otherwise looked up here — never the
  // code defaults, unless that is genuinely what this college uses.
  const tenantBands = Array.isArray(bandList) && bandList.length ? bandList : await bandConfig.get();
  const unitFilter = term.unitIds ? new Set(term.unitIds) : null;
  // Active students, with their programme (cohort → course) and current enrolments.
  const students = await prisma.student.findMany({
    where: { active: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    include: {
      cohort: { include: { course: { select: { name: true } } } },
      enrolments: { select: { unitId: true } },
    },
  });

  // unitId -> { code, name, course } for labelling the module list and deriving the
  // student's course/programme from the units they actually take.
  const unitRows = await prisma.unit.findMany({ select: { id: true, code: true, name: true, course: { select: { name: true } } } });
  const unitMap = new Map(unitRows.map((u) => [u.id, { code: u.code, name: u.name, course: u.course && u.course.name }]));

  // One aggregate row per (student, unit) — the four status counts, scoped to the
  // semester's dates and joined to Enrolment so only current enrolments are counted.
  const perSU = await prisma.$queryRawUnsafe(`
    SELECT am."studentId" sid, se."unitId" mid,
      count(*) FILTER (WHERE am.status='P')::int p,
      count(*) FILTER (WHERE am.status='L')::int l,
      count(*) FILTER (WHERE am.status='E')::int e,
      count(*) FILTER (WHERE am.status='A')::int a
    FROM "AttendanceMark" am
    JOIN "HndSession" se ON se.id = am."sessionId"
    JOIN "Enrolment" en ON en."studentId" = am."studentId" AND en."unitId" = se."unitId"
    WHERE am."tenantId" = ${q(tenantForSql())} AND se.date >= ${q(semester.start)} AND se.date <= ${q(semester.end)}
    GROUP BY am."studentId", se."unitId"`);

  // studentId -> Map(unitId -> { p, l, e, a }).
  const index = new Map();
  for (const r of perSU) {
    if (!index.has(r.sid)) index.set(r.sid, new Map());
    index.get(r.sid).set(r.mid, r);
  }

  const outStudents = students.map((s) => {
    const per = index.get(s.id) || new Map();
    // The units the student is actually enrolled on — the SQL already restricts rows
    // to these, but we intersect again defensively.
    const enrolledIds = new Set((s.enrolments || []).map((e) => e.unitId));

    const modules = [];
    const courseNames = new Set();
    const acc = { P: 0, L: 0, E: 0, A: 0 };
    for (const [unitId, c] of per) {
      if (!enrolledIds.has(unitId)) continue; // not currently enrolled → ignore
      if (unitFilter && !unitFilter.has(unitId)) continue; // not a unit running this term
      const sum = summariseCounts(c.p, c.l, c.e, c.a);
      const u = unitMap.get(unitId) || { code: "", name: "" };
      if (u.course) courseNames.add(u.course);
      modules.push({ unitId, code: u.code, name: u.name, pct: sum.pct, marked: sum.marked });
      acc.P += c.p; acc.L += c.l; acc.E += c.e; acc.A += c.a;
    }
    // Module list reads in code order.
    modules.sort((a, b) => String(a.code).localeCompare(String(b.code)));

    const overall = summariseCounts(acc.P, acc.L, acc.E, acc.A);
    const pct = overall.pct; // 0..100 (one decimal) or null when no marks this term
    const band = pct == null ? null : bands.bandForPct(pct, tenantBands);

    return {
      id: s.id,
      firstName: s.firstName,
      lastName: s.lastName,
      name: `${s.firstName} ${s.lastName}`,
      email: s.email,
      // Course comes from the units the student is actually taking this term (many students
      // have no cohort→course link); fall back to the cohort's course if there is one.
      programme: [...new Set([...courseNames].map(cleanProgramme).filter(Boolean))].join(", ") || cleanProgramme(s.cohort?.course?.name) || "",
      pct,
      bandKey: band ? band.key : null,
      bandLabel: band ? band.label : null,
      // Carried on the student so the admin table and the email can colour themselves
      // without a second lookup — and, more importantly, so neither has to keep its
      // own map from band key to colour. A college inventing a band would otherwise
      // get a grey, unstyled row on one screen and a themed email on another.
      bandColour: band ? band.colour : null,
      // Whether landing here sends the automated letter. Surfaced per student so the
      // table can say plainly which students the month-end run will actually email.
      bandTriggers: band ? !!band.emailTrigger : false,
      modules,
    };
  });

  return {
    term: { name: term.name, start: term.start, end: term.end },
    period: term.name || monthYearLabel(),
    // The bands these figures were classified against, returned WITH the figures so a
    // caller cannot pair one college's percentages with another list's labels.
    bands: tenantBands,
    students: outStudents,
  };
}

// ---------------------------------------------------------------------------
// 3) buildEmailFor
// ---------------------------------------------------------------------------

// Render the plain-text module list that replaces the {modules} token in the TEXT
// body. Empty string when the student has no modules to report.
function modulesToText(modules) {
  if (!modules || !modules.length) return "";
  const lines = modules.map(
    (m) => `• ${m.code} ${m.name} — ${m.pct == null ? "n/a" : m.pct}%`
  );
  return `Your attendance by module this term:\n${lines.join("\n")}`;
}

// Render the HTML module block that replaces the {modules} token: a titled, striped
// table of each module and its percentage (each % coloured by its own value). The title
// bar is tinted to the student's band via the passed theme.
function modulesToHtml(modules, theme) {
  if (!modules || !modules.length) return "";
  const t = theme || DEFAULT_THEME;
  const rows = modules
    .map((m, i) => {
      const colour = pctColour(m.pct);
      const val = m.pct == null ? "n/a" : `${esc(m.pct)}%`;
      const bg = i % 2 ? "#ffffff" : "#f8fafc";
      return `<tr>
          <td style="padding:9px 14px;border-bottom:1px solid #eef1f6;font-size:13px;color:#334155;background:${bg}">${esc(m.code)} ${esc(m.name)}</td>
          <td style="padding:9px 14px;border-bottom:1px solid #eef1f6;font-size:13px;font-weight:700;text-align:right;color:${colour};white-space:nowrap;background:${bg}">${val}</td>
        </tr>`;
    })
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;border:1px solid #e6eaf1;border-radius:12px;border-collapse:separate;overflow:hidden">
      <tr><td colspan="2" style="padding:10px 14px;background:${t.accent};color:#fff;font-size:12px;font-weight:700;letter-spacing:.06em">YOUR ATTENDANCE BY MODULE THIS TERM</td></tr>
      ${rows}
    </table>`;
}

// Turn a token-filled PLAIN-TEXT body into structured HTML: blank-line-separated
// paragraphs, "• " lines grouped into a tinted bullet card, and the "Dear …" greeting
// emphasised. This is what gives the email air and rhythm instead of one grey block.
function renderRichText(text, theme) {
  const t = theme || DEFAULT_THEME;
  const blocks = String(text || "").replace(/\r/g, "").split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const out = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const firstBullet = lines.findIndex((l) => /^•\s+/.test(l.trim()));
    if (firstBullet === -1) {
      const greet = /^Dear\b/i.test(block);
      out.push(`<p style="margin:0 0 14px;font-size:15px;line-height:1.66;color:#334155;${greet ? "font-weight:600;color:#0f172a;" : ""}">${esc(block).replace(/\n/g, "<br>")}</p>`);
    } else {
      const lead = lines.slice(0, firstBullet).join("\n").trim();
      if (lead) out.push(`<p style="margin:0 0 8px;font-size:15px;line-height:1.66;color:#334155">${esc(lead).replace(/\n/g, "<br>")}</p>`);
      const items = lines.slice(firstBullet).filter((l) => /^•\s+/.test(l.trim())).map((l) => {
        const item = l.trim().replace(/^•\s+/, "");
        return `<tr><td style="vertical-align:top;padding:5px 10px 5px 0;color:${t.accent};font-size:16px;font-weight:800;line-height:1.5">•</td><td style="padding:5px 0;font-size:14px;line-height:1.55;color:#334155">${esc(item)}</td></tr>`;
      }).join("");
      out.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:2px 0 16px;background:${t.soft};border:1px solid ${t.border};border-radius:12px"><tr><td style="padding:8px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items}</table></td></tr></table>`);
    }
  }
  return out.join("");
}

// Render the sign-off block (the text after {modules}) as a signature card with a
// band-coloured rule: closing line, then the tutor's name in bold, then their role lines.
function renderSignoff(text, theme) {
  const t = theme || DEFAULT_THEME;
  const lines = String(text || "").replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return "";
  const closing = lines[0];
  const name = lines[1] || "";
  const meta = lines.slice(2);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 2px"><tr>
      <td style="width:3px;background:${t.accent};border-radius:3px">&nbsp;</td>
      <td style="padding-left:14px">
        <p style="margin:0 0 6px;font-size:14px;color:#334155">${esc(closing)}</p>
        ${name ? `<p style="margin:0;font-size:15px;font-weight:700;color:#0f172a">${esc(name)}</p>` : ""}
        ${meta.map((mline) => `<p style="margin:2px 0 0;font-size:13px;color:#64748b">${esc(mline)}</p>`).join("")}
      </td></tr></table>`;
}

// Wrap the rendered body in the branded shell: a band-tinted header carrying the
// institution's own logo and name, a hero showing the big attendance % and a themed
// progress bar, a one-line band note, the body, and a footer.
// `meta` = { theme, pct, bandLabel, period, brand }.
//
// The header GRADIENT stays band-tinted rather than following the college's palette: it
// is how a student tells a "well done" from a "we need to hear from you" at a glance, and
// that meaning belongs to the band, not to the brand. The logo, the name and the footer
// underneath it are the college's.
function htmlShell(bodyHtml, meta) {
  const m = meta || {};
  const t = m.theme || DEFAULT_THEME;
  const brand = m.brand || {};
  const pct = m.pct;
  const barW = Math.max(2, Math.min(100, Number(pct) || 0));
  const hero = pct == null ? "" : `
      <div style="text-align:center;padding:6px 0 2px">
        <div style="font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:${t.accent}">${esc(m.bandLabel || "")}</div>
        <div style="font-size:54px;line-height:1;font-weight:800;color:${t.accent};margin:8px 0 2px">${esc(pct)}%</div>
        <div style="font-size:12px;color:#94a3b8">attendance${m.period ? ` &middot; ${esc(m.period)}` : ""}</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0 2px"><tr>
          <td style="height:12px;background:#e9edf4;border-radius:999px;padding:0">
            <table role="presentation" width="${barW}%" cellpadding="0" cellspacing="0"><tr><td style="height:12px;background:${t.bar};border-radius:999px;font-size:0;line-height:0">&nbsp;</td></tr></table>
          </td></tr></table>
      </div>` +
      // Only when the band HAS a note. A college's own band has none (see
      // themeForBand), and an empty tinted card reads as a rendering fault.
      (t.note ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0 20px"><tr><td style="background:${t.soft};border:1px solid ${t.border};border-radius:12px;padding:12px 16px;font-size:13px;line-height:1.5;color:${t.accent};text-align:center">${esc(t.note)}</td></tr></table>` : "");
  // Empty for a college that has filled in neither an address nor a contact detail; the
  // paragraph is then left out rather than printed as a bare separator.
  const footerHtml = mailAssets.footerHtml(brand);
  return `<div style="margin:0;padding:24px 12px;background:#eef1f6;font-family:'Segoe UI',system-ui,-apple-system,sans-serif">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 6px 24px rgba(15,23,42,.10)">
    <div style="background:linear-gradient(135deg,${t.grad[0]},${t.grad[1]});padding:22px 28px">
      ${mailAssets.logoImg(brand, { width: 46, height: 28 })}
      <p style="margin:0 0 2px;color:rgba(255,255,255,.72);font-size:11px;letter-spacing:.2em">STUDENT ATTENDANCE</p>
      ${mailAssets.wordmark(brand, { size: 19 })}
    </div>
    <div style="padding:26px 28px">
      ${hero}
      <div>${bodyHtml}</div>
    </div>
    <div style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e6eaf1">
      <p style="margin:0 0 3px;font-size:11px;color:#94a3b8">This is an automated attendance update${brand.displayName ? ` from ${mailAssets.esc(brand.displayName)}` : ""}. Reply to this email to reach the attendance team.</p>
      ${footerHtml ? `<p style="margin:0;font-size:11px;color:#b6becb">${footerHtml}</p>` : ""}
    </div>
  </div>
</div>`;
}

// Build the email for one student. Returns { subject, text, html }, or null when
// there is nothing to send (the student has no band — i.e. no attendance figure).
//
// config = { values, templates, respondDays, brand }; opts = { period, respondByDate }.
// Any missing piece falls back to the module defaults so a partial config still works.
//
// `config.brand` is the current institution's branding, resolved by the caller because
// this builder is synchronous — sendToStudents below does it once for the whole run. A
// caller that cannot await it (the single-student send in attendanceRunner) simply leaves
// it out: the header then shows no logo and the {institution} token falls back to the
// college's own attendance config, which is the value an admin typed. Neither path can
// show another college's name, which is the only outcome that matters here.
function buildEmailFor(student, config = {}, opts = {}) {
  // No band → no attendance figure this term → nothing to send.
  if (!student || student.bandKey == null) return null;

  // The college's saved letter for this band, else the starting letter for that band
  // key — the built-in one for a built-in band, the neutral generic one for a band the
  // college invented. templateForKey never returns undefined, so a new band cannot
  // silently swallow every student in it (a null template here means "skipped", with
  // nothing anywhere to say why).
  const template = (config.templates && config.templates[student.bandKey]) || bands.templateForKey(student.bandKey);
  if (!template) return null; // no template defined for this band

  // Institution tokens first, then the per-student tokens (which win on any clash).
  const vars = {
    ...(config.values || bands.DEFAULT_VALUES || {}),
    // {institution} signs every one of these letters. The stored config wins when an
    // admin has typed something there, because it may be a faculty or campus rather than
    // the whole college; branding fills it in when they have not. It is left EMPTY when
    // neither is set — the sign-off then ends one line early, which is better than a
    // letter signed with the name of a college the student does not attend.
    institution:
      (config.values && config.values.institution) ||
      (config.brand && config.brand.displayName) ||
      "",
    firstName: student.firstName || "",
    lastName: student.lastName || "",
    name: student.name || "",
    pct: student.pct == null ? "" : student.pct,
    period: opts.period || "",
    programme: student.programme || "",
    // A rough "you've missed about N in 10 classes" figure for the message body.
    missedRate: student.pct == null ? "" : Math.max(0, Math.round((100 - student.pct) / 10)),
    respondDays: config.respondDays != null ? config.respondDays : 5,
    respondByDate: opts.respondByDate || "",
  };

  const subject = bands.fillTemplate(template.subject || "", vars);
  const bodyTemplate = String(template.body || "");

  // --- Plain-text body ---
  // Replace {modules} with the plain-text list FIRST (so fillTemplate's handling of
  // unknown tokens can't blank it), then fill the remaining tokens.
  const textWithModules = bodyTemplate.split("{modules}").join(modulesToText(student.modules));
  const text = bands.fillTemplate(textWithModules, vars);

  // --- HTML body ---
  // Render the prose before {modules} as structured HTML, drop in the module table, then
  // render the sign-off after {modules} as a signature block — all tinted to the band.
  const theme = themeForBand({ key: student.bandKey, colour: student.bandColour });
  const slot = bodyTemplate.indexOf("{modules}");
  const beforeRaw = slot >= 0 ? bodyTemplate.slice(0, slot) : bodyTemplate;
  const afterRaw = slot >= 0 ? bodyTemplate.slice(slot + "{modules}".length) : "";
  const beforeHtml = renderRichText(bands.fillTemplate(beforeRaw, vars), theme);
  const modulesHtml = modulesToHtml(student.modules, theme);
  const afterFilled = bands.fillTemplate(afterRaw, vars);
  const signoffHtml = afterFilled.trim() ? renderSignoff(afterFilled, theme) : "";
  const html = htmlShell(beforeHtml + modulesHtml + signoffHtml, {
    theme,
    pct: student.pct == null ? null : student.pct,
    bandLabel: student.bandLabel,
    period: opts.period,
    brand: config.brand,
  });

  return { subject, text, html };
}

// ---------------------------------------------------------------------------
// 4) sendToStudents
// ---------------------------------------------------------------------------

// Send an email to each student that has one to receive. Returns a tally:
//   { sent, failed, skipped, stubbed, noAddress, total, errors[], emailConfigured }
// `skipped` means THIS STUDENT had nothing to send — no email address, no band, no
// template — which is a normal outcome on a perfectly healthy run. `stubbed` is the
// entirely different case where the SERVER has no mailer at all: the message was
// printed to the console and nobody received it.
//
// The two used to share the `skipped` counter, so a run against an unconfigured mailer
// delivered nothing and still reported "0 failed" — indistinguishable from a term where
// every student simply had no marks yet. They are counted apart now, and
// `emailConfigured` says outright whether a mailer exists, so no caller has to infer a
// dead mailer from a zero. Failures are collected (capped at 25) as "<name>: <error>"
// for the caller to surface.
async function sendToStudents(students, config = {}, opts = {}) {
  const list = students || [];
  const result = {
    sent: 0, failed: 0, skipped: 0, stubbed: 0, noAddress: 0,
    // Students whose band exists and is populated, but which this college has told us
    // NOT to email. Counted apart from `skipped` for the same reason `stubbed` is: a
    // college that only emails its bottom two bands would otherwise read a run as
    // "700 skipped" and reasonably conclude the run was broken.
    notTriggered: 0,
    total: list.length, errors: [],
    // Reported even on a run with nothing to send, so "is email switched on?" is
    // answerable from the response on its own.
    emailConfigured: email.isConfigured(),
  };

  // Resolved once for the whole run rather than per student: this is one institution's
  // batch, and every message in it must carry the same identity. `from` is undefined when
  // the college has not set an attendance mailbox, which sends as the server's own
  // MAIL_FROM — never as another institution's attendance team.
  const brand = config.brand || (await branding.get());
  const withBrand = { ...config, brand };
  const from = await mailFrom.resolve("attendance");

  for (const student of list) {
    // No address on file. Kept in `skipped` — it is a per-student fact, not a fault —
    // but counted separately too, so "nobody got one" can be told from "email is off".
    if (!student.email) { result.skipped++; result.noAddress++; continue; }
    if (student.bandKey == null) { result.skipped++; continue; }
    // This college's band says no letter. Not every band is a letter: a college may
    // band its whole cohort for the dashboard and only write to the two bands that
    // need intervention. Emailing a well-attending student a monthly note they never
    // asked for is the failure this flag exists to prevent.
    if (!student.bandTriggers) { result.notTriggered++; continue; }

    const built = buildEmailFor(student, withBrand, opts);
    if (!built) { result.skipped++; continue; }

    const r = await email.sendEmail(student.email, built.subject, built.text, { html: built.html, from });
    if (r.sent) {
      result.sent++;
    } else if (r.stubbed) {
      // Email isn't configured — printed to the console, so this student was NOT
      // emailed. Deliberately NOT folded into `skipped`: the caller turns any
      // stubbed > 0 into a failed run rather than letting a delivery of nothing report
      // itself as a clean sweep of skips.
      result.stubbed++;
    } else {
      result.failed++;
      if (result.errors.length < 25) {
        result.errors.push(`${student.name || student.email}: ${r.error}`);
      }
    }
  }

  return result;
}

module.exports = { currentTerm, termFromRange, computeCurrentTermAttendance, buildEmailFor, sendToStudents };
