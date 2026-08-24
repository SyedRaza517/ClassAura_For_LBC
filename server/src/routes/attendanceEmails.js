// Attendance Emails — the admin tool + automated month-end recognition/engagement emails.
//
// Students are banded by their attendance % for the CURRENT semester against THIS
// college's own bands (attendanceBandConfig.js — a college that has set none gets the
// defaults in attendanceBands.js), and each band has its own editable email template.
// At month-end (or on a manual "send now") every current-semester student whose band
// triggers a letter is emailed the template for their band, personalised with their
// overall % and a per-module breakdown. The compute and send live in
// attendanceEmailService.js; the config + monthly run in attendanceRunner.js. This
// router is the admin surface, gated on "attendance-emails".
const router = require("express").Router();
const { requireAuth, requirePage } = require("../auth");
const service = require("../attendanceEmailService");
const runner = require("../attendanceRunner");
const bandConfig = require("../attendanceBandConfig");
const audit = require("../audit");

router.use(requireAuth, requirePage("attendance-emails"));

// Accept a "YYYY-MM-DD" query/body date, or null. Backs the optional custom From–To range.
const validDate = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

// GET /data — attendance for the reporting period: the auto current term (from the registers)
// by default, or a custom ?from=YYYY-MM-DD&to=YYYY-MM-DD range. Returns every active student's
// attendance (overall % + band + per-module) and a per-band headcount. `custom` flags a range.
router.get("/data", async (req, res) => {
  const from = validDate(req.query.from), to = validDate(req.query.to);
  const custom = !!(from && to);
  // This college's ladder, resolved ONCE and then used both to classify the students
  // and to label the headcounts. Two lookups could straddle a save and produce a table
  // whose totals were counted against thresholds the header no longer shows.
  const list = await bandConfig.get();
  const term = custom ? service.termFromRange(from, to) : await service.currentTerm();
  if (!term) {
    return res.json({ term: null, custom, period: "", bands: list.map((b) => ({ ...b, count: 0 })), students: [] });
  }
  const out = await service.computeCurrentTermAttendance(term, list);
  const counts = {};
  for (const s of out.students) if (s.bandKey) counts[s.bandKey] = (counts[s.bandKey] || 0) + 1;
  res.json({
    term: out.term,
    custom,
    period: out.period,
    bands: list.map((b) => ({ ...b, count: counts[b.key] || 0 })),
    students: out.students,
  });
});

// GET /config — the resolved config (stored blob merged over the code defaults).
router.get("/config", async (_req, res) => {
  res.json(await runner.loadConfig());
});

// PUT /config — save any of automation / respondDays / sendHour / institution values /
// band templates / the BANDS themselves. Missing keys are left untouched (deep-merged
// in the runner).
//
// Bands ride on this endpoint rather than a sibling of their own, because they are one
// screen with the templates that hang off them: an administrator who renames a band and
// rewrites its letter is making a single edit, and splitting it across two requests
// would let the rename land while the letter failed.
router.put("/config", async (req, res) => {
  const b = req.body || {};
  const patch = {};

  // Bands FIRST, and returning on failure, so a rejected ladder cannot leave the
  // templates saved against thresholds that were never applied. `null` explicitly means
  // "reset to the platform defaults"; absent means "leave them alone".
  if (b.bands !== undefined) {
    const saved = await bandConfig.save(b.bands === null ? null : b.bands, req.user?.email);
    // The message names the band and what a student would experience. It is written to
    // be shown verbatim — an administrator cannot act on "invalid".
    if (!saved.ok) return res.status(400).json({ error: saved.error });
    audit.record(req, {
      action: "attendance.bands.saved",
      entity: "AttendanceBandConfig",
      summary: saved.reset
        ? `Attendance bands reset to the defaults by ${req.user?.name || "an administrator"}`
        : `Attendance bands saved by ${req.user?.name || "an administrator"} (${saved.bands.length} band${saved.bands.length === 1 ? "" : "s"}, ${saved.bands.filter((x) => x.emailTrigger).length} emailing)`,
      after: saved.bands,
    });
  }

  if (b.autoEnabled != null) patch.autoEnabled = !!b.autoEnabled;
  if (b.respondDays != null) patch.respondDays = Math.max(1, Math.min(30, Number(b.respondDays) || 5));
  // NaN-safe and allows 0 (midnight): `Number(0) || 9` wrongly forced a valid 0 to 9.
  if (b.sendHour != null) { const h = Number(b.sendHour); if (Number.isFinite(h)) patch.sendHour = Math.max(0, Math.min(23, Math.trunc(h))); }
  if (b.values && typeof b.values === "object") patch.values = b.values;
  if (b.templates && typeof b.templates === "object") patch.templates = b.templates;
  // A request that only changed the bands has nothing to merge into the template blob,
  // and writing an unchanged blob would create a row for a college that has never
  // touched its templates — the same "no row means never customised" distinction the
  // bands themselves keep.
  if (!Object.keys(patch).length) return res.json(await runner.loadConfig());
  res.json(await runner.saveConfig(patch));
});

// POST /run — send this month's emails now. A manual press defaults to force (ignore the
// once-a-month de-dupe); pass { force:false } to respect it.
router.post("/run", async (req, res) => {
  const force = req.body?.force !== false;
  const from = validDate(req.body?.from), to = validDate(req.body?.to);
  const range = from && to ? { from, to } : {};
  const out = await runner.runMonthly({ force, ...range });
  if (!out.ok && out.reason === "no-current-term") {
    return res.status(400).json({ error: "No teaching term is running right now (no units have current start/end dates on the registers). Pick a From–To date range to send for a specific period instead." });
  }
  // Email off — an error, not a result. Every message was printed to the server console
  // and no student received anything, which used to come back as a 200 full of "skipped"
  // and read on screen as a successful send. Same 400 and the same wording as /send-one
  // below, so the two paths cannot disagree about what happened.
  // Every band has its email trigger switched off, so this run would have emailed
  // nobody. Told plainly rather than reported as a successful send of zero — the fix is
  // one checkbox away and the administrator is the only person who can find it.
  if (!out.ok && out.reason === "no-email-bands") {
    return res.status(400).json({ error: "None of your attendance bands are set to send an email, so nothing was sent. Open Settings → Attendance bands and switch on 'sends email' for the bands you want written to." });
  }
  if (!out.ok && out.reason === "email-off") {
    // `stubbed` — the messages that reached the mailer and were printed to the console —
    // not `total`. total counts every student considered, including those with no marks,
    // no address, and (now) those in a band this college does not email at all, so it
    // reported far more people as "due an email" than were ever going to receive one.
    return res.status(400).json({ error: `Email isn't configured on the server, so nothing was sent (${out.stubbed} student${out.stubbed === 1 ? "" : "s"} were due an email). Set RESEND_API_KEY or the SMTP_* variables, then run it again.` });
  }
  res.json(out);
});

// POST /send-one — send ONE student their band email now (the per-student send).
router.post("/send-one", async (req, res) => {
  const studentId = String(req.body?.studentId || "");
  if (!studentId) return res.status(400).json({ error: "A student is required." });
  const from = validDate(req.body?.from), to = validDate(req.body?.to);
  const out = await runner.sendOneStudent(studentId, from && to ? { from, to } : {});
  if (!out.ok) {
    const msg = {
      "no-current-term": "No teaching term is running right now.",
      "not-found": "That student isn't in the current term.",
      "no-email": "That student has no email address on file.",
      "no-attendance": "That student has no attendance marks yet this term.",
      "email-off": "Email isn't configured on the server.",
    }[out.reason] || out.error || "Could not send the email.";
    return res.status(400).json({ error: msg });
  }
  res.json(out);
});

module.exports = router;
