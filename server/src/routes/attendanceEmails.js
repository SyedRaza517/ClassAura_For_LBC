// Attendance Emails — the admin tool + automated month-end recognition/engagement emails.
//
// Students are banded by their attendance % for the CURRENT semester (see
// attendanceBands.js), and each band has its own editable email template. At month-end
// (or on a manual "send now") every current-semester student is emailed the template for
// their band, personalised with their overall % and a per-module breakdown. The compute
// and send live in attendanceEmailService.js; the config + monthly run in
// attendanceRunner.js. This router is the admin surface, gated on "attendance-emails".
const router = require("express").Router();
const { requireAuth, requirePage } = require("../auth");
const service = require("../attendanceEmailService");
const runner = require("../attendanceRunner");
const bands = require("../attendanceBands");

router.use(requireAuth, requirePage("attendance-emails"));

// Accept a "YYYY-MM-DD" query/body date, or null. Backs the optional custom From–To range.
const validDate = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

// GET /data — attendance for the reporting period: the auto current term (from the registers)
// by default, or a custom ?from=YYYY-MM-DD&to=YYYY-MM-DD range. Returns every active student's
// attendance (overall % + band + per-module) and a per-band headcount. `custom` flags a range.
router.get("/data", async (req, res) => {
  const from = validDate(req.query.from), to = validDate(req.query.to);
  const custom = !!(from && to);
  const term = custom ? service.termFromRange(from, to) : await service.currentTerm();
  if (!term) {
    return res.json({ term: null, custom, period: "", bands: bands.BANDS.map((b) => ({ ...b, count: 0 })), students: [] });
  }
  const out = await service.computeCurrentTermAttendance(term);
  const counts = {};
  for (const s of out.students) if (s.bandKey) counts[s.bandKey] = (counts[s.bandKey] || 0) + 1;
  res.json({
    term: out.term,
    custom,
    period: out.period,
    bands: bands.BANDS.map((b) => ({ ...b, count: counts[b.key] || 0 })),
    students: out.students,
  });
});

// GET /config — the resolved config (stored blob merged over the code defaults).
router.get("/config", async (_req, res) => {
  res.json(await runner.loadConfig());
});

// PUT /config — save any of automation / respondDays / sendHour / institution values /
// band templates. Missing keys are left untouched (deep-merged in the runner).
router.put("/config", async (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.autoEnabled != null) patch.autoEnabled = !!b.autoEnabled;
  if (b.respondDays != null) patch.respondDays = Math.max(1, Math.min(30, Number(b.respondDays) || 5));
  // NaN-safe and allows 0 (midnight): `Number(0) || 9` wrongly forced a valid 0 to 9.
  if (b.sendHour != null) { const h = Number(b.sendHour); if (Number.isFinite(h)) patch.sendHour = Math.max(0, Math.min(23, Math.trunc(h))); }
  if (b.values && typeof b.values === "object") patch.values = b.values;
  if (b.templates && typeof b.templates === "object") patch.templates = b.templates;
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
  if (!out.ok && out.reason === "email-off") {
    return res.status(400).json({ error: `Email isn't configured on the server, so nothing was sent (${out.total} student${out.total === 1 ? "" : "s"} were due an email). Set RESEND_API_KEY or the SMTP_* variables, then run it again.` });
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
