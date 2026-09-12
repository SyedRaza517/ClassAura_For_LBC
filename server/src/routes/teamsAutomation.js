// The Teams automation controls: the two switches (auto-create meetings,
// provision class Teams), manual "Run now" for each, and their shared run history.
//
// Gated `attendance-settings`, NOT `settings`, for the identical reason
// routes/teamsAttendance.js gives at length in its own header comment (read that one
// first) — these back a section on the SAME attendance-settings screen
// (AdminNfcTags.jsx), so the grant that opens the screen is the grant every button on
// it works for. The Teams *credentials* (tenantId, clientId, clientSecret, organizer
// accounts, creatorAccount) stay behind `settings` on the generic
// `/integrations/teams` routes — connecting the college's Microsoft tenant at all is
// an institution-wide act, same category as branding, and belongs there rather than
// here.
//
// Two jobs, two switches, one router: `autoCreateMeetings` books the Teams meeting for
// a timetabled online session; `provisionTeams` creates the class Team and its
// channels. They are independent (see constraints.md — a college may want one without
// the other) but share a run log (`TeamsProvisionSync`, discriminated by `job`) and a
// settings row (`TeamsAutomationConfig`), so one router covers both rather than two
// near-duplicates.
//
// LAZY REQUIRES, ON PURPOSE: teamsMeetings.js and teamsProvisioning.js are being
// written by a concurrent agent on this same branch and may not exist yet at the
// moment this file is loaded (or may exist but export something this file has not
// seen). Requiring them at module load time would make `node --check` / `require()`
// of this router fail during that window purely on load order, not on anything wrong
// with either file. Requiring them INSIDE each handler defers that resolution to
// request time, by which point both files are expected to exist — mirrors the same
// reasoning `routes/teamsAttendance.js` applies to `teamsGraph.js` and `teamsSync.js`,
// just deferred one step further because those two already existed when this file was
// written and teamsMeetings/teamsProvisioning did not.
const express = require("express");
const prisma = require("./../db");
const { requireAuth, requirePage } = require("./../auth");
const audit = require("./../audit");
const config = require("./../teamsAutomationConfig");
const graph = require("./../teamsGraph");
const cfg = require("./../integrationConfig");

const router = express.Router();

// PRIME THIS INSTITUTION'S OWN TEAMS CREDENTIALS BEFORE ASKING WHETHER THEY ARE
// CONFIGURED — same fix, same reason, as GET /settings in routes/teamsAttendance.js
// (read that comment for the full "cold cache" explanation). Automation shares the
// same Teams app registration as attendance, so it shares the same trap: without this
// call, graph.isConfigured() answers from whatever integrationConfig last cached,
// which on a request that arrives before the hourly scheduler tick has ever run is
// process.env — empty on a deployment with no TEAMS_* variables — even though the
// college saved working credentials minutes ago.
router.get("/settings", requireAuth, requirePage("attendance-settings"), async (_req, res) => {
  await cfg.load("teams");
  // Required lazily — see the file header. Only isRunning() is needed here; each
  // engine's own module keeps the in-process "is a run in flight" flag conventions.md
  // describes (a Map/boolean correct for one Node process, not a cluster).
  const teamsMeetings = require("./../teamsMeetings");
  const teamsProvisioning = require("./../teamsProvisioning");
  res.json({
    settings: await config.get(),
    configured: graph.isConfigured(),
    meetingsRunning: teamsMeetings.isRunning(),
    provisioningRunning: teamsProvisioning.isRunning(),
  });
});

router.put("/settings", requireAuth, requirePage("attendance-settings"), async (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (body.autoCreateMeetings !== undefined) patch.autoCreateMeetings = body.autoCreateMeetings;
  if (body.provisionTeams !== undefined) patch.provisionTeams = body.provisionTeams;
  const { settings } = await config.save(patch, req.user?.email || null);
  audit.record(req, {
    action: "teamsAutomation.settings", entity: "TeamsAutomationConfig", entityId: "singleton",
    summary: `Teams automation settings saved — meeting creation ${settings.autoCreateMeetings ? "on" : "off"}, Team provisioning ${settings.provisionTeams ? "on" : "off"}`,
    after: settings,
  });
  res.json({ settings });
});

router.post("/run-meetings", requireAuth, requirePage("attendance-settings"), async (req, res) => {
  await cfg.load("teams"); // see the comment above GET /settings
  if (!graph.isConfigured()) return res.status(409).json({ error: "Teams automation is not configured — enter the credentials under Connected systems first." });
  // OFF MEANS NOTHING RUNS — same trap, same fix, as the `enabled` check in
  // routes/teamsAttendance.js's POST /sync (read its comment for the full story of why
  // this is a second, later check rather than folded into isConfigured() above). A
  // college can save working Teams credentials and press "Test connection" long before
  // it trusts the automation enough to flip this switch on; checking isConfigured()
  // alone would let a manual "Run now" press during that window create real meetings
  // on real timetabled sessions while the feature was, by the college's own choice,
  // switched off. Checked after isConfigured() so an admin with nothing configured yet
  // sees "not configured" — the actionable message for where they actually are —
  // rather than "switched off", which reads as one checkbox away from working.
  const { autoCreateMeetings } = await config.get();
  if (!autoCreateMeetings) return res.status(409).json({ error: "Meeting creation is switched off — turn it on first." });
  const teamsMeetings = require("./../teamsMeetings"); // lazy — see file header
  if (teamsMeetings.isRunning()) return res.status(409).json({ error: "A meetings run is already running." });
  try {
    const { summary, issues } = await teamsMeetings.runMeetingsSync({ mode: "manual", startedBy: req.user?.name || req.user?.email || null });
    res.json({ ok: true, summary, issues });
  } catch (e) {
    res.status(502).json({ error: "The run failed: " + e.message });
  }
});

router.post("/run-provisioning", requireAuth, requirePage("attendance-settings"), async (req, res) => {
  await cfg.load("teams"); // see the comment above GET /settings
  if (!graph.isConfigured()) return res.status(409).json({ error: "Teams automation is not configured — enter the credentials under Connected systems first." });
  // Same trap, same fix, same ordering as POST /run-meetings above: isConfigured()
  // first so an unconfigured college sees "not configured", the switch second so a
  // configured-but-not-yet-trusted college sees "switched off" rather than a Team
  // silently provisioned on a stray button press.
  const { provisionTeams } = await config.get();
  if (!provisionTeams) return res.status(409).json({ error: "Team provisioning is switched off — turn it on first." });
  const teamsProvisioning = require("./../teamsProvisioning"); // lazy — see file header
  if (teamsProvisioning.isRunning()) return res.status(409).json({ error: "A provisioning run is already running." });
  try {
    const { summary, issues } = await teamsProvisioning.runProvisioning({ mode: "manual", startedBy: req.user?.name || req.user?.email || null });
    res.json({ ok: true, summary, issues });
  } catch (e) {
    res.status(502).json({ error: "The run failed: " + e.message });
  }
});

// Allowlisted, not `{...r, ...}` — same idiom as routes/teamsAttendance.js's own
// `sRun` and for the same reason conventions.md states at length: a spread of the raw
// Prisma row ships a future column (an internal note, a retry count) to the browser
// the day it lands, with nothing here having to change for that to happen. `job` is
// the one field this table has that TeamsSync does not — it is what lets one runs list
// on the client show meetings runs and provisioning runs side by side.
const sRun = (r) => r && ({
  id: r.id,
  job: r.job,
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
  // Both jobs together, most recent first — the brief calls for one shared list ("last
  // 20 TeamsProvisionSync rows"), not 20 of each, so a college that runs one job far
  // more than the other still sees a genuinely recent history rather than the other
  // job crowding it out of a per-job cap.
  const runs = await prisma.teamsProvisionSync.findMany({ orderBy: { startedAt: "desc" }, take: 20 });
  res.json({ runs: runs.map(sRun) });
});

module.exports = router;
