// PAT (Personal Academic Tutor) interactions — a log of meetings / contacts with
// a student. Reads require a signed-in user; every mutation is admin-only, in
// line with the rest of the admin console.
const router = require("express").Router();
const prisma = require("../db");
const { sInteraction } = require("../serializers");
const { requireAuth, requireAdmin, requirePage } = require("../auth");
const { isRealDate } = require("../validate");
// Best-effort outbound email: sendEmail(to, subject, text, { html }) -> { sent,
// stubbed, error } and never throws (see ../email).
const email = require("../email");
const mailFrom = require("../mailFrom");
const mailAssets = require("../mailAssets");

// DEF-01: PAT interactions contain sensitive wellbeing/absence notes and are an
// admin-only feature. Guard every route, reads included, against non-admin tokens.
router.use(requireAuth, requirePage("pat"));

const QUERY_TYPES = [
  "1 to 1 Meeting", "No Show", "Academic Query", "Assessment Queries",
  "Stage 2 - Absence Concern Meeting", "Progression Concerns",
  "Personal Wellbeing", "Feedback on Assignments", "Other",
];
const str = (v) => (typeof v === "string" ? v.trim() : "");
const isTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

// Build the "record of your meeting" email a student receives when a PAT
// interaction is logged. Returns { subject, text, html }; the caller sends it
// best-effort. Keeping this at module level keeps the route handler small and
// the plain-text / HTML bodies in lock-step (both are driven by the same `rows`).
function buildInteractionEmail(row) {
  // HTML-escape every interpolated value — student names and free-text notes are
  // untrusted and must never break out of the markup.
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const s = row.student || {};
  const first = str(s.firstName) || "Student";
  const type = row.queryType || "meeting";
  const dash = "—"; // em dash used as the placeholder for empty fields

  // Ordered label/value pairs, rendered identically in the text and HTML bodies.
  const rows = [
    ["Type", row.queryType || dash],
    ["Date", row.date || dash],
    ["Time", row.time || dash],
    ["Tutor", row.tutor || dash],
    ["Summary", row.summary || dash],
    ["Follow-up actions", row.followUpActions || dash],
  ];
  // Only mention a follow-up when one was actually arranged.
  if (row.followUpRequired) rows.push(["Follow-up arranged for", row.followUpDate || dash]);

  const subject = `EdTech — Record of your ${row.queryType || "meeting"}`;

  // Plain-text alternative.
  const text = [
    `Dear ${first},`,
    "",
    `A record of your ${type} on ${row.date} at ${row.time} has been logged by your tutor.`,
    "",
    ...rows.map(([k, v]) => `${k}: ${v}`),
    "",
    "Kind regards,",
    "EdTech",
  ].join("\n");

  // Branded HTML — table-safe, inline styles, everything interpolated is escaped.
  const heading = `Record of your ${esc(row.queryType || "meeting")}`;
  const tableRows = rows.map(([k, v]) => `
        <tr>
          <td style="padding:6px 16px 6px 0;color:#64748b;font-weight:600;vertical-align:top;white-space:nowrap">${esc(k)}</td>
          <td style="padding:6px 0;color:#0f172a">${esc(v)}</td>
        </tr>`).join("");
  const bodyHtml =
    `<p style="margin:0 0 14px">Dear ${esc(first)},</p>` +
    `<p style="margin:0 0 16px">A record of your ${esc(type)} on ${esc(row.date)} at ${esc(row.time)} has been logged by your tutor.</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:14px">${tableRows}\n      </table>` +
    `<p style="margin:16px 0 0">Kind regards,<br>EdTech</p>`;

  const html = `<div style="margin:0;padding:24px;background:#eef1f6;font-family:'Segoe UI',system-ui,-apple-system,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(15,23,42,.08)">
    <div style="background:linear-gradient(135deg,#1a3a8f,#9e1b32);padding:20px 24px">
      <img src="${mailAssets.logoUrl}" width="44" height="26" alt="EdTech" style="display:block;margin:0 0 10px;border:0;outline:none;max-width:44px" />
      <p style="margin:0 0 2px;color:rgba(255,255,255,.7);font-size:11px;letter-spacing:.18em">PERSONAL ACADEMIC TUTOR</p>
      <p style="margin:0;color:#fff;font-size:18px;font-weight:800">EdTech</p>
    </div>
    <div style="padding:24px">
      <h1 style="margin:0 0 12px;font-size:18px;color:#0f172a">${heading}</h1>
      <div style="font-size:14px;line-height:1.6;color:#334155">${bodyHtml}</div>
    </div>
    <div style="padding:14px 24px;background:#f8fafc;border-top:1px solid #e2e8f0">
      <p style="margin:0;font-size:11px;color:#94a3b8">EdTech · 42 The Burroughs, Hendon, London NW4 4AP · info@edtech.co.uk</p>
    </div>
  </div>
</div>`;

  return { subject, text, html };
}

// GET /api/interactions?studentId=&followUp=true
router.get("/", requireAuth, async (req, res) => {
  const where = {};
  const studentId = str(req.query?.studentId);
  if (studentId) where.studentId = studentId;
  if (req.query?.followUp === "true") where.followUpRequired = true;
  const rows = await prisma.interaction.findMany({
    where,
    include: { student: true },
    orderBy: [{ date: "desc" }, { time: "desc" }, { createdAt: "desc" }],
  });
  res.json(rows.map(sInteraction));
});

// Validate a create/update body. `partial` allows omitted fields on update.
async function validate(body, partial) {
  const data = {};
  const need = (k) => !partial || body?.[k] !== undefined;

  if (need("studentId")) {
    const studentId = str(body?.studentId);
    if (!studentId) return { error: "Student is required" };
    const exists = await prisma.student.findUnique({ where: { id: studentId } });
    if (!exists) return { error: "Unknown student" };
    data.studentId = studentId;
  }
  if (need("date")) {
    const date = str(body?.date);
    if (!isRealDate(date)) return { error: "Valid interaction date required (YYYY-MM-DD)" };
    data.date = date;
  }
  if (need("time")) {
    const time = str(body?.time);
    if (!isTime(time)) return { error: "Valid interaction time required (HH:MM)" };
    data.time = time;
  }
  if (need("queryType")) {
    const queryType = str(body?.queryType);
    if (!QUERY_TYPES.includes(queryType)) return { error: "Please choose a valid query type" };
    data.queryType = queryType;
  }
  if (body?.summary !== undefined) data.summary = str(body.summary).slice(0, 5000);
  if (body?.followUpActions !== undefined) data.followUpActions = str(body.followUpActions).slice(0, 5000);
  if (body?.followUpRequired !== undefined) {
    if (typeof body.followUpRequired !== "boolean") return { error: "followUpRequired must be true or false" };
    data.followUpRequired = body.followUpRequired;
  }
  if (body?.followUpDate !== undefined) {
    const d = str(body.followUpDate);
    // isRealDate, not a bare regex — the rest of this file (and studentReviews, and
    // checkins) already use it. "2026-02-30" matches the shape, gets stored verbatim,
    // and the follow-up view filters on the exact string, so the row becomes
    // unreachable: a student flagged for a wellbeing follow-up nobody can ever find.
    if (d && !isRealDate(d)) return { error: "followUpDate must be a real calendar date (YYYY-MM-DD)" };
    data.followUpDate = d || null;
  }
  // A date without a follow-up is meaningless, so switching the follow-up off clears
  // it. Read the incoming value when there is one, otherwise the stored one — checking
  // only the body made PUT {followUpDate} on an existing follow-up wipe what it set.
  const wantsFollowUp = data.followUpRequired !== undefined ? data.followUpRequired : undefined;
  if (wantsFollowUp === false) data.followUpDate = null;
  if (body?.tutor !== undefined) data.tutor = str(body.tutor).slice(0, 200);
  return { data };
}

router.post("/", requireAuth, requireAdmin, async (req, res) => {
  const v = await validate(req.body, false);
  if (v.error) return res.status(400).json({ error: v.error });
  const row = await prisma.interaction.create({
    data: { ...v.data, loggedBy: req.user?.name || null },
    include: { student: true },
  });
  res.status(201).json(sInteraction(row));

  // Fire-and-forget: email the student a branded record of the interaction. This
  // runs AFTER the response is sent and is never awaited, so it can neither delay
  // nor break the create. sendEmail already swallows its own errors; the .catch()
  // is a belt-and-braces guard so an unexpected rejection can't surface unhandled.
  if (row.student && row.student.email) {
    const name = [row.student.firstName, row.student.lastName].map(str).filter(Boolean).join(" ");
    const to = name ? `${name} <${row.student.email}>` : row.student.email;
    const { subject, text, html } = buildInteractionEmail(row);
    const from = /wellbeing/i.test(row.queryType || "") ? mailFrom.wellbeing : mailFrom.pat;
    email.sendEmail(to, subject, text, { html, from }).catch(() => {});
  }
});

router.put("/:id", requireAuth, requireAdmin, async (req, res) => {
  const existing = await prisma.interaction.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Interaction not found" });
  const v = await validate(req.body, true);
  if (v.error) return res.status(400).json({ error: v.error });
  const row = await prisma.interaction.update({ where: { id: existing.id }, data: v.data, include: { student: true } });
  res.json(sInteraction(row));
});

router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
  try { await prisma.interaction.delete({ where: { id: req.params.id } }); res.json({ ok: true }); }
  catch (_e) { res.status(404).json({ error: "Interaction not found" }); }
});

module.exports = router;
module.exports.QUERY_TYPES = QUERY_TYPES;
