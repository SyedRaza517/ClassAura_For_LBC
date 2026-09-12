// The Teams attendance controls: the switch and threshold, a manual "Sync now", and
// the run history (which is where unmatched meetings and unmatched participants
// surface — the spec's "reported, never guessed" needs somewhere to report TO).
//
// Gated `attendance-settings`, NOT `settings`. These four endpoints back the "Teams
// online classes" section on the attendance-settings screen (AdminNfcTags.jsx), same
// screen and same grant as the NFC/QR/geofence controls beside it — so whoever holds
// the grant that opens that screen is the same person every button on it works for.
// `settings` would be both too broad (it also opens branding, document templates and
// every other institution-wide setting this feature has nothing to do with) and too
// narrow in the way that actually broke: a college can grant `attendance-settings`
// without `settings`, and that person saw this card render and then 403 on every call.
// The Teams *credentials* stay behind `settings` on the generic `/integrations/teams`
// routes, correctly — connecting the college's Microsoft tenant at all is exactly the
// kind of institution-wide act that belongs with branding and document templates, not
// with the attendance controls a subject-matter admin uses day to day.
const express = require("express");
const prisma = require("./../db");
const { requireAuth, requirePage } = require("./../auth");
const audit = require("./../audit");
const config = require("./../teamsAttendanceConfig");
const teamsSync = require("./../teamsSync");
const graph = require("./../teamsGraph");
const cfg = require("./../integrationConfig");

const router = express.Router();

// PRIME THIS INSTITUTION'S OWN TEAMS CREDENTIALS BEFORE ASKING WHETHER THEY ARE
// CONFIGURED — the same fix, for the same reason, as routes/moodle.js's /status
// handler ("Prime this institution's own configuration before reporting on it").
// graph.isConfigured() reads integrationConfig.peek("teams"), which is SYNCHRONOUS
// and answers from whatever integrationConfig.load("teams") last cached — falling
// back to process.env (empty on a deployment with no TEAMS_* variables) on a cold
// cache. Nothing else on the request path for /settings or /sync ever warms that
// cache: teamsGraph's own async entry points (getAccessToken, graphFetch) call
// load() themselves, but isConfigured() is a synchronous convenience built from
// peek() alone and is never one of them, and the fixture branch resolveOrganizers()
// takes when TEAMS_GRAPH_FIXTURES is set bypasses the Graph module entirely. Only
// scheduler.js's hourly tick (its own await cfg.load("teams")) ever primed this
// before — so a college that had just saved working credentials got "not
// configured" from the settings screen and a 409 from the manual "Sync now" button
// until the next hourly tick happened to run, which is not what either exists for.
router.get("/settings", requireAuth, requirePage("attendance-settings"), async (_req, res) => {
  await cfg.load("teams");
  res.json({ settings: await config.get(), configured: graph.isConfigured(), running: teamsSync.isRunning() });
});

router.put("/settings", requireAuth, requirePage("attendance-settings"), async (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (body.enabled !== undefined) patch.enabled = body.enabled;
  if (body.minAttendancePct !== undefined) patch.minAttendancePct = body.minAttendancePct;
  const { settings } = await config.save(patch, req.user?.email || null);
  audit.record(req, {
    action: "teamsAttendance.settings", entity: "TeamsAttendanceConfig", entityId: "singleton",
    summary: `Teams attendance settings saved — ${settings.enabled ? "on" : "off"}, present needs ${settings.minAttendancePct}% of the class`,
    after: settings,
  });
  res.json({ settings });
});

router.post("/sync", requireAuth, requirePage("attendance-settings"), async (req, res) => {
  await cfg.load("teams"); // see the comment above GET /settings
  if (!graph.isConfigured()) return res.status(409).json({ error: "Teams attendance is not configured — enter the credentials under Connected systems first." });
  // OFF MEANS NOTHING RUNS — this is not a second copy of the isConfigured() check above,
  // it is a different question with a different trap behind it. TEAMS_SETUP.md's own
  // Step 11 walks an administrator through saving credentials and pressing "Test
  // connection" BEFORE ever ticking the switch on the attendance-settings screen — and
  // for the whole of that window, graph.isConfigured() already answers true. Before this
  // check existed, "Sync now" only asked "is Teams configured" and "is a sync already
  // running", so a press in exactly that window — someone confirming the connection
  // works, not yet trusting it enough to switch marking on — ran a REAL sync and wrote
  // real marks onto real registers while the feature was still, by the college's own
  // choice, switched off. `enabled: false` in DEFAULTS ("ships switched off") is a
  // promise about what happens automatically; it is worthless if a manual button
  // ignores it. Checked after isConfigured() so an admin who has entered nothing yet
  // still gets "not configured" — the actionable message for where they actually are —
  // rather than "switched off", which reads as a solved problem one checkbox away.
  const { enabled } = await config.get();
  if (!enabled) return res.status(409).json({ error: "Teams attendance is switched off — turn it on under Attendance settings first." });
  if (teamsSync.isRunning()) return res.status(409).json({ error: "A sync is already running." });
  try {
    const { summary, issues } = await teamsSync.runSync({ mode: "manual", startedBy: req.user?.name || req.user?.email || null });
    res.json({ ok: true, summary, issues });
  } catch (e) {
    res.status(502).json({ error: "The sync failed: " + e.message });
  }
});

// Allowlisted, not `{...r, ...}` — the same shape as routes/moodle.js's own `sRun`
// (moodle.js:20-30), and for the same reason conventions.md states at length:
// `sAdmission` once stripped a fixed list of secrets rather than naming what may leave,
// so every column added to that table afterwards shipped to the browser by default. A
// spread of the raw Prisma row has the identical failure mode — a future migration adds
// a column to TeamsSync (an internal note, a retry count, anything not meant for the
// client) and it reaches the settings screen the day it lands, with nothing here having
// to change for that to happen. Naming the fields means a new column requires a
// deliberate decision to add it here, which is the property an allowlist buys.
const sRun = (r) => r && ({
  id: r.id,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt,
  status: r.status,
  mode: r.mode,
  startedBy: r.startedBy,
  summary: JSON.parse(r.summary || "{}"),
  issues: JSON.parse(r.issues || "[]"),
  error: r.error || null,
});

router.get("/runs", requireAuth, requirePage("attendance-settings"), async (_req, res) => {
  const runs = await prisma.teamsSync.findMany({ orderBy: { startedAt: "desc" }, take: 20 });
  res.json({ runs: runs.map(sRun) });
});

module.exports = router;
