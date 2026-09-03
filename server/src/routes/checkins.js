const router = require("express").Router();
const prisma = require("../db");
const audit = require("../audit");
const { sCheckin } = require("../serializers");
const { requireAuth, requirePage, hasPage } = require("../auth");
const { isString, isRealDate, MAX_TEXT, isSite } = require("../validate");
const { localDate, localTime } = require("../clock");
const tapConfig = require("../attendanceTapConfig");

// HH:MM, 24-hour. Times are stored as plain strings and rendered verbatim.
const isTime = (v) => isString(v) && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

// Date and clock time in the organisation's local zone (London), NOT the server's.
// A UTC host would otherwise record every check-in an hour early in summer (BST).
const today = () => localDate();
const nowTime = () => localTime();

// GET /api/checkins?date=YYYY-MM-DD  — admin: everyone; staff: own only
router.get("/", requireAuth, async (req, res) => {
  const where = {};
  if (req.query.date) where.date = String(req.query.date);
  // Only an admin granted Check-In or Daily Summaries sees everyone; any other
  // admin is scoped to their own records like ordinary staff.
  // Pages that legitimately DISPLAY everyone's check-ins: the Check-In and Daily
  // Summaries screens, plus Overview (present-today), KPIs (punctuality) and Staff
  // (monthly hours). Gating on the owning page alone made those screens show zeros.
  if (!hasPage(req.user, ["checkin", "summaries", "overview", "kpi", "staff"])) where.staffId = req.user.id;
  const rows = await prisma.checkIn.findMany({ where, orderBy: { date: "desc" } });
  // Overview/KPI/Staff are widened above because they need dates and times — who is
  // in, punctuality, monthly hours. They do NOT need the free-text daily summary,
  // which "Daily Summaries" is a separate checkbox for, so it is blanked for them.
  // sCheckin emitted it unconditionally, handing every colleague's written account of
  // their day to admins granted an unrelated page.
  const canReadSummaries = hasPage(req.user, ["checkin", "summaries"]);
  res.json(rows.map((r) => {
    const out = sCheckin(r);
    if (!canReadSummaries && r.staffId !== req.user.id) out.summary = "";
    return out;
  }));
});

// GET /api/checkins/on-site — who is in today, for EVERY member of staff.
//
// Deliberately open to any signed-in staff member, unlike GET / above: knowing who
// else is in the building today is the point of the feature, and it is the sort of
// thing a wall board would show. It therefore returns only what a wall board would:
// name, initials, job title, home site and the clock-in time. No email, no notes, no
// check-out — nothing that turns a presence list into a timesheet on someone else.
//
// `site` is the staff member's HOME site, recorded when they signed up (HND / FE /
// SL), which is what "filter by building" means here. The check-in row carries its
// own optional site for where that particular clock-in happened; it is returned as
// `checkedInAt` so the two are never confused.
router.get("/on-site", requireAuth, async (req, res) => {
  const date = req.query.date ? String(req.query.date) : today();
  if (!isRealDate(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  // TODAY only, unless the caller holds a page that legitimately reviews history.
  // The date was unbounded, so any lecturer could walk backwards day by day and
  // rebuild every colleague's arrival and departure times — a timesheet on someone
  // else, which is exactly what the note above says this endpoint must never become.
  if (date !== today() && !hasPage(req.user, ["checkin", "summaries"])) {
    return res.status(403).json({ error: "You can only see who is on site today." });
  }
  // A wall board shows who is IN, so a row with no real clock-in isn't one. timeIn ""
  // is the sentinel PUT /summary writes for "wrote a summary, never checked in"; it
  // was listed as a present colleague with a blank arrival time, sorted to the very
  // top (""localeCompare beats every real time) and counted in "checked in today".
  const rows = await prisma.checkIn.findMany({
    where: { date, NOT: { timeIn: "" } },
    include: {
      staff: {
        select: { id: true, name: true, initials: true, colour: true, jobTitle: true, dept: true, site: true },
      },
    },
  });

  res.json({
    date,
    people: rows
      .filter((r) => r.staff)
      .map((r) => ({
        id: r.id,
        staffId: r.staff.id,
        name: r.staff.name,
        initials: r.staff.initials,
        colour: r.staff.colour,
        jobTitle: r.staff.jobTitle,
        dept: r.staff.dept,
        site: r.staff.site || null,       // home site, from sign-up — what the filter uses
        checkedInAt: r.site || null,       // where this clock-in happened, when recorded
        timeIn: r.timeIn,
        // Departure time is withheld from the general audience, as the note above
        // promises ("no check-out"). Arrival answers "is she in?"; arrival PLUS
        // departure is a record of how long a colleague worked, which is the Check-In
        // and Daily Summaries pages' business, not a wall board's.
        ...(hasPage(req.user, ["checkin", "summaries"]) ? { timeOut: r.timeOut || null } : {}),
      }))
      // Earliest arrival first: the list reads as the order people came in.
      .sort((a, b) => String(a.timeIn).localeCompare(String(b.timeIn))),
  });
});

// POST /api/checkins/check-in  — self, for today. Optional `site` (HND | FE | Online)
// records where this clock-in happened.
router.post("/check-in", requireAuth, async (req, res) => {
  const date = today();
  const site = req.body?.site;
  if (!isSite(site)) return res.status(400).json({ error: "site must be Onsite or Online" });

  // Where a college requires a sticker for onsite work, this route may not record one.
  //
  // Defence in depth, matching the note above the HND router: the app hides its ordinary
  // button in this case, but a hidden button is not a rule — the endpoint was still there
  // and still answered. Anything that can be worked around by knowing the URL is a
  // convention, and a timesheet is not a good place for one.
  //
  // ONLINE IS NEVER GATED, and that is the point of gating on `site` rather than on the
  // route. A sticker proves somebody stood in the building, which is precisely what a
  // person working from home cannot do; requiring one to record remote work would make
  // the honest answer the unrecordable one. An administrator's PUT / is also untouched,
  // because fixing a missed clock-in is exactly what that route is for.
  const tap = await tapConfig.get();
  if (site === "Onsite" && tap.enabled && tap.staffTapEnabled) {
    return res.status(409).json({
      error: "Onsite clock-in is by sticker here — tap the sticker in your building. Choose Online if you are working remotely.",
      reason: "tap_required",
    });
  }

  const existing = await prisma.checkIn.findUnique({ where: { staffId_date: { staffId: req.user.id, date } } });
  if (existing) {
    // A row created by a summary-first save has timeIn === "" — fill in the
    // real clock-in time now instead of leaving attendance blank for the day.
    if (existing.timeIn) return res.json(sCheckin(existing));
    // Record the site alongside the real clock-in time (don't wipe an existing one).
    const filled = await prisma.checkIn.update({ where: { id: existing.id }, data: { timeIn: nowTime(), ...(site ? { site } : {}) } });
    return res.json(sCheckin(filled));
  }
  // upsert (not create) closes the race where two concurrent check-ins both pass
  // the existence check and the second create() violates @@unique([staffId,date]).
  const rec = await prisma.checkIn.upsert({
    where: { staffId_date: { staffId: req.user.id, date } },
    update: {},
    create: { staffId: req.user.id, date, timeIn: nowTime(), site: site || null },
  });
  res.status(201).json(sCheckin(rec));
});

// GET /api/checkins/tap-settings — may I offer the tap button, and for how long?
//
// requireAuth ONLY, and that is the entire reason it exists. The full settings live on
// /api/tags/settings, whose router is gated on the attendance-tags admin page — so an
// ordinary lecturer asking whether they may tap got a 403, the client swallowed it, and
// the check-in card rendered nothing. The feature worked and was invisible to everybody
// it was built for.
//
// An allowlist of three booleans and a number. Nothing here is sensitive: it says only
// whether the college has switched the feature on. The lateness threshold, the grace
// window and who last changed them stay on the admin route.
router.get("/tap-settings", requireAuth, async (_req, res) => {
  const s = await tapConfig.get();
  res.json({ enabled: s.enabled, staffTapEnabled: s.staffTapEnabled, armSeconds: s.armSeconds });
});

// In-process and module-level, correct for ONE Node process; a clustered deployment needs
// Redis. The student route has had one from the start and this did not, which was an
// oversight rather than a decision: without it a staff account can try tag codes as fast
// as the API will answer, and nothing else here throttles that.
const staffTapHits = new Map(); // staffId -> number[] of timestamps
const STAFF_TAP_WINDOW_MS = 60_000;
const STAFF_TAP_MAX = 10;
function staffTapAllowed(staffId) {
  const now = Date.now();
  const recent = (staffTapHits.get(staffId) || []).filter((t) => now - t < STAFF_TAP_WINDOW_MS);
  if (recent.length >= STAFF_TAP_MAX) { staffTapHits.set(staffId, recent); return false; }
  recent.push(now);
  staffTapHits.set(staffId, recent);
  return true;
}

// POST /api/checkins/tap-check-in — clock in by touching an NFC sticker.
//
// `site` is NOT accepted and NOT asked for. Someone who touched a sticker in the
// building cannot be working online — the tap is what proves they were at that wall — so
// recording anything but "Onsite" would store a claim the tap itself disproves. Working
// online remains available through POST /check-in, which does take a site.
//
// WHAT THIS DOES AND DOES NOT PROVE
//
// It proves somebody was at the sticker, ONCE, with this account signed in. It does not
// prove they are there now. The code on a sticker is static and any phone with a generic
// NFC app can read it, so a member of staff who notes it down can clock in Onsite from
// home, and the tagId on the row would read as corroboration it is not. An earlier
// version of this comment claimed this was "the first time a staff clock-in has meant
// 'was in the building' rather than 'said so'" — that overstated it, and a claim like
// that in a timesheet record is worth more care than a claim about a feature.
//
// What it does raise is the bar: a clock-in now requires having walked past a sticker at
// least once rather than nothing at all, and every tap lands in TagTap with its IP, so a
// pattern is visible to somebody looking. Closing it properly needs rotating codes or a
// tag bound to a place — see the design note in docs/superpowers/specs/.
router.post("/tap-check-in", requireAuth, async (req, res) => {
  const settings = await tapConfig.get();
  if (!settings.enabled || !settings.staffTapEnabled) {
    // method on refusals too: NULL is defined as "row from before the column existed",
    // so a fresh refusal writing NULL would read as pre-feature history in the log.
    try { await prisma.tagTap.create({ data: { staffId: req.user.id, method: "nfc", outcome: "disabled", ip: req.ip ? String(req.ip).slice(0, 60) : null } }); }
    catch (e) { console.error("[tap] could not log a disabled staff tap:", e.message); }
    return res.status(403).json({ error: "Tap check-in isn't switched on for this college." });
  }

  const code = req.body?.tagCode;
  if (!isString(code) || !code.trim()) return res.status(400).json({ error: "A tag is required" });

  if (!staffTapAllowed(req.user.id)) {
    try { await prisma.tagTap.create({ data: { staffId: req.user.id, method: "nfc", outcome: "rate_limited", ip: req.ip ? String(req.ip).slice(0, 60) : null } }); }
    catch (e) { console.error("[tap] could not log a rate-limited staff tap:", e.message); }
    return res.status(429).json({ error: "Too many attempts — wait a moment and try again." });
  }

  // Tenant-scoped by db.js, so another college's tag is simply not found.
  const tag = await prisma.attendanceTag.findFirst({ where: { code: code.trim(), active: true } });
  if (!tag) {
    // The code itself is never stored — a log an administrator reads must not become a
    // list of the codes somebody has been trying.
    try { await prisma.tagTap.create({ data: { staffId: req.user.id, method: "nfc", outcome: "tag_unknown", ip: req.ip ? String(req.ip).slice(0, 60) : null } }); }
    catch (e) { console.error("[tap] could not log an unknown-tag staff tap:", e.message); }
    return res.status(404).json({ error: "That tag isn't recognised." });
  }

  const date = today();

  // Never throws into the request: the clock-in is the record, this is the account of it.
  const logTap = async (outcome, extra = {}) => {
    try {
      await prisma.tagTap.create({
        data: { tagId: tag.id, staffId: req.user.id, method: "nfc", outcome, ip: req.ip ? String(req.ip).slice(0, 60) : null, ...extra },
      });
    } catch (e) {
      console.error("[tap] could not log a staff tap:", e.message);
    }
  };

  const existing = await prisma.checkIn.findUnique({ where: { staffId_date: { staffId: req.user.id, date } } });

  // A real clock-in already stands. Re-tapping must not rewrite the arrival time — the
  // same rule POST /check-in follows, and for the same reason: a second tap on the way
  // past the door would otherwise falsify how long somebody was on site.
  if (existing && existing.timeIn) {
    await logTap("already_checked_in", { site: "Onsite" });
    return res.json({ ok: true, alreadyCheckedIn: true, ...sCheckin(existing) });
  }

  // timeIn "" is the sentinel PUT /summary writes for "wrote a summary, never checked
  // in". Fill in the real clock time rather than leaving the day blank.
  // updateMany with `timeIn: ""` in the WHERE, not a bare upsert. Two concurrent taps can
  // both pass the `existing.timeIn` guard above; a bare upsert then has the second one
  // rewrite the arrival time, which is exactly what that guard exists to prevent. Making
  // the condition part of the statement means the database settles it: the first write
  // fills the sentinel, the second matches nothing.
  const filled = await prisma.checkIn.updateMany({
    where: { staffId: req.user.id, date, timeIn: "" },
    data: { timeIn: nowTime(), site: "Onsite", tagId: tag.id },
  });
  let rec;
  if (filled.count === 0 && !existing) {
    try {
      rec = await prisma.checkIn.create({ data: { staffId: req.user.id, date, timeIn: nowTime(), site: "Onsite", tagId: tag.id } });
    } catch (e) {
      // P2002 on @@unique([staffId, date]) — somebody else's request created the row
      // between our read and this write. Their clock-in stands; report it as theirs
      // rather than as a 500.
      const now = await prisma.checkIn.findUnique({ where: { staffId_date: { staffId: req.user.id, date } } });
      if (!now) throw e;
      await logTap("already_checked_in", { site: "Onsite" });
      return res.json({ ok: true, alreadyCheckedIn: true, ...sCheckin(now) });
    }
  } else {
    rec = await prisma.checkIn.findUnique({ where: { staffId_date: { staffId: req.user.id, date } } });
  }

  await prisma.attendanceTag.update({ where: { id: tag.id }, data: { lastTapAt: new Date() } });
  await logTap("checked_in", { site: "Onsite" });

  // Not audited, matching POST /check-in: this records the present, in the caller's own
  // name, and cannot alter history. PUT / — which writes anyone's hours on any date —
  // is the one that is audited.
  res.status(201).json({ ok: true, ...sCheckin(rec) });
});

// POST /api/checkins/:id/check-out  — owner or admin
router.post("/:id/check-out", requireAuth, async (req, res) => {
  const rec = await prisma.checkIn.findUnique({ where: { id: req.params.id } });
  if (!rec) return res.status(404).json({ error: "Record not found" });
  if (rec.staffId !== req.user.id && !hasPage(req.user, "checkin")) return res.status(403).json({ error: "Forbidden" });
  // A summary-first row has timeIn === "" (no real clock-in). Checking it out would
  // create a record with an out-time but no in-time — block that.
  if (!rec.timeIn) return res.status(400).json({ error: "Cannot check out — no check-in recorded for this day" });
  // Checking out twice silently rewrote the recorded departure to the current clock,
  // with no trace of the original. A stale tab or a retry could therefore falsify how
  // long someone was on site, so the first check-out is final.
  if (rec.timeOut) return res.status(409).json({ error: `Already checked out at ${rec.timeOut}` });
  const updated = await prisma.checkIn.update({ where: { id: rec.id }, data: { timeOut: nowTime() } });
  res.json(sCheckin(updated));
});

// PUT /api/checkins  (admin) — upsert a record for any staff/date
router.put("/", requireAuth, requirePage("checkin"), async (req, res) => {
  const { staffId, date, in: tIn, out, site } = req.body || {};
  if (!staffId || !date || !tIn) return res.status(400).json({ error: "staffId, date and in required" });
  // Type checks, not just truthiness: a number or object here reached Prisma and
  // came back as an opaque 500.
  if (!isString(staffId)) return res.status(400).json({ error: "staffId must be text" });
  if (!isTime(tIn)) return res.status(400).json({ error: "in must be a time in HH:MM format" });
  if (out != null && out !== "" && !isTime(out)) return res.status(400).json({ error: "out must be a time in HH:MM format" });
  // When both times are present, out must be after in. Zero-padded 24h HH:MM strings sort
  // chronologically, so a plain string compare is enough. Records with in-only are untouched.
  if (out != null && out !== "" && out <= tIn) return res.status(400).json({ error: "Check-out must be after check-in." });
  if (!isSite(site)) return res.status(400).json({ error: "site must be Onsite or Online" });
  // Calendar validity, matching PUT /summary. Without it an admin could file a record
  // on 2026-02-30: the staff app rolls it to 2 March while the dashboard filters on
  // the exact string, so nobody can ever find the row to correct it.
  if (!isRealDate(date)) return res.status(400).json({ error: "date must be a valid calendar date in YYYY-MM-DD format" });
  const staffExists = await prisma.staff.findUnique({ where: { id: staffId } });
  if (!staffExists) return res.status(400).json({ error: "Unknown staff member" });
  // Read first, so the log can say what the record said before an administrator
  // changed it. This route writes a check-in for ANYONE on ANY date — it is how a
  // missed clock-in gets fixed, and equally how somebody's hours could be rewritten
  // after the fact. The staff member's own POST /check-in is not audited: it records
  // the present, in their own name, and cannot alter history.
  const prior = await prisma.checkIn.findUnique({ where: { staffId_date: { staffId, date } } });
  const rec = await prisma.checkIn.upsert({
    where: { staffId_date: { staffId, date } },
    update: { timeIn: tIn, timeOut: out || null, ...(site !== undefined ? { site: site || null } : {}) },
    create: { staffId, date, timeIn: tIn, timeOut: out || null, site: site || null },
  });
  audit.record(req, {
    action: prior ? "checkin.amended" : "checkin.created",
    entity: "CheckIn", entityId: rec.id,
    summary: `Check-in for ${staffExists.name} on ${date} ${prior ? "amended" : "entered"} by ${req.user.name} — ${rec.timeIn}${rec.timeOut ? " to " + rec.timeOut : " (no check-out)"}`,
    before: prior ? { timeIn: prior.timeIn, timeOut: prior.timeOut, site: prior.site } : null,
    after: { staffId, staffName: staffExists.name, date, timeIn: rec.timeIn, timeOut: rec.timeOut, site: rec.site },
  });
  res.json(sCheckin(rec));
});

// PUT /api/checkins/summary  — self, set daily summary (creates today's record if needed)
router.put("/summary", requireAuth, async (req, res) => {
  const { date, summary } = req.body || {};
  // Validate an explicit date so a malformed or calendar-invalid value can't be persisted
  // as the row key. Checked as a string first: String({toString:1}) throws, which used
  // to escape as a 500 before the regex ever ran.
  if (date != null && !isRealDate(date)) {
    return res.status(400).json({ error: "date must be a valid calendar date in YYYY-MM-DD format" });
  }
  // summary goes straight into a String column; a number or object threw inside Prisma.
  if (summary != null && !isString(summary)) return res.status(400).json({ error: "summary must be text" });
  if (isString(summary) && summary.length > MAX_TEXT) return res.status(400).json({ error: `summary is too long (${MAX_TEXT} characters maximum)` });
  const d = date || today();
  const rec = await prisma.checkIn.upsert({
    where: { staffId_date: { staffId: req.user.id, date: d } },
    update: { summary: summary || "" },
    // Deliberately empty timeIn: saving a summary for a day with no check-in must NOT
    // fabricate a clock-in time (that would invent attendance that never happened).
    // "" is the sentinel for "no check-in"; do not change this back to nowTime().
    create: { staffId: req.user.id, date: d, timeIn: "", summary: summary || "" },
  });
  res.json(sCheckin(rec));
});

module.exports = router;
