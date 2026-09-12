// The Teams attendance controls: the switch and threshold, a manual "Sync now", and
// the run history (which is where unmatched meetings and unmatched participants
// surface — the spec's "reported, never guessed" needs somewhere to report TO).
const express = require("express");
const prisma = require("./../db");
const { requireAuth, requirePage } = require("./../auth");
const audit = require("./../audit");
const config = require("./../teamsAttendanceConfig");
const teamsSync = require("./../teamsSync");
const graph = require("./../teamsGraph");

const router = express.Router();

router.get("/settings", requireAuth, requirePage("settings"), async (_req, res) => {
  res.json({ settings: await config.get(), configured: graph.isConfigured(), running: teamsSync.isRunning() });
});

router.put("/settings", requireAuth, requirePage("settings"), async (req, res) => {
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

router.post("/sync", requireAuth, requirePage("settings"), async (req, res) => {
  if (!graph.isConfigured()) return res.status(409).json({ error: "Teams attendance is not configured — enter the credentials under Connected systems first." });
  if (teamsSync.isRunning()) return res.status(409).json({ error: "A sync is already running." });
  try {
    const { summary, issues } = await teamsSync.runSync({ mode: "manual", startedBy: req.user?.name || req.user?.email || null });
    res.json({ ok: true, summary, issues });
  } catch (e) {
    res.status(502).json({ error: "The sync failed: " + e.message });
  }
});

router.get("/runs", requireAuth, requirePage("settings"), async (_req, res) => {
  const runs = await prisma.teamsSync.findMany({ orderBy: { startedAt: "desc" }, take: 20 });
  res.json({ runs: runs.map((r) => ({ ...r, summary: JSON.parse(r.summary || "{}"), issues: JSON.parse(r.issues || "[]") })) });
});

module.exports = router;
