// Moodle (VLE) sync — status, preview and run.
// Admin-only: a sync creates students, units and grades, so it sits behind the same
// pages that already let someone manage those.
const router = require("express").Router();
const prisma = require("../db");
const audit = require("../audit");
const { requireAuth, requireAnyPage } = require("../auth");
const moodle = require("../moodle");
const cfg = require("../integrationConfig");

// A sync is not confined to the gradebook: it creates students, enrolments, courses
// and units, all of which require the registers/students pages everywhere else in the
// app. Gating on "settings" alone let an admin given only app configuration create
// student records and rewrite marks, so those pages are demanded too.
const READ_PAGES = ["settings", "assessments", "registers", "students"];
const SYNC_PAGES = ["registers", "students"];
router.use(requireAuth, requireAnyPage(READ_PAGES));

const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const sRun = (r) => r && ({
  id: r.id,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt,
  status: r.status,
  mode: r.mode,
  startedBy: r.startedBy,
  summary: parse(r.summary, {}),
  issues: parse(r.issues, []),
  error: r.error || null,
});

// What the admin screen needs to render before anyone presses anything: is Moodle
// configured, is a run in progress, and how did the last few go.
router.get("/status", async (req, res) => {
  // A process killed mid-sync (deploy, restart, out-of-memory) leaves its row saying
  // "running" for ever. Nothing else ever resolves it, so the card read "Never run"
  // (it keys off finishedAt) and the nightly job's 12-hour dedupe counted the ghost as
  // tonight's run and skipped. Anything still "running" while nothing is in flight is
  // by definition abandoned.
  // Only rows old enough that no live run could still own them. isRunning() is
  // per-process, so on a multi-instance deploy this GET could otherwise mark ANOTHER
  // instance's in-flight sync as failed. A real run never approaches this age.
  const STALE_AFTER_MS = 60 * 60 * 1000;
  if (!moodle.isRunning()) {
    await prisma.moodleSync.updateMany({
      where: { status: "running", startedAt: { lt: new Date(Date.now() - STALE_AFTER_MS) } },
      data: { status: "failed", finishedAt: new Date(), error: "Interrupted — the server restarted while this sync was running." },
    });
  }
  const history = await prisma.moodleSync.findMany({ orderBy: { startedAt: "desc" }, take: 10 });
  // Prime this institution's own configuration before reporting on it.
  //
  // This used to answer with process.env.MOODLE_URL and moodle.isConfigured() read
  // off a cold cache, which meant a college that had saved its own Moodle URL in
  // Settings was shown the SERVER's URL — or, on a server with no MOODLE_URL at all,
  // was told Moodle "isn't set up yet" while its own credentials sat saved and
  // working one screen away. Both readings were about a different institution's
  // configuration than the one asking.
  await cfg.load("moodle");
  const resolved = cfg.peek("moodle");
  const savedHere = Boolean((await prisma.tenantIntegration.findFirst({ where: { provider: "moodle" } }))?.enabled);
  res.json({
    configured: moodle.isConfigured(),
    running: moodle.isRunning(),
    // The URL is safe to show (it's the college's own VLE); the token never leaves
    // the server.
    url: resolved.url || "",
    // Where that configuration came from, so "why is this not what I typed?" is
    // answerable from the screen rather than from the server's environment.
    source: savedHere ? "institution" : (resolved.url || resolved.token) ? "server" : "none",
    last: sRun(history[0]) || null,
    history: history.map(sRun),
  });
});

// Dry run: report exactly what a sync would change, writing nothing.
router.get("/preview", async (req, res) => {
  if (!moodle.isConfigured()) return res.status(400).json({ error: "Moodle isn't set up yet. Add your Moodle URL and web-services token under Settings → Connected systems." });
  if (moodle.isRunning()) return res.status(409).json({ error: "A sync is already running. Wait for it to finish." });
  try {
    const { summary, issues } = await moodle.syncFromMoodle({ dryRun: true });
    res.json({ preview: true, summary, issues });
  } catch (e) {
    res.status(502).json({ error: `Couldn't read Moodle: ${e.message}` });
  }
});

// Start a real sync and return straight away. Reading a whole VLE can take longer
// than a proxy will hold a request open, so the run continues server-side and the
// caller polls /status for the outcome — which is also recorded in MoodleSync, so
// closing the browser doesn't lose the result.
router.post("/sync", requireAnyPage(SYNC_PAGES), async (req, res) => {
  if (!moodle.isConfigured()) return res.status(400).json({ error: "Moodle isn't set up yet. Add your Moodle URL and web-services token under Settings → Connected systems." });
  if (moodle.isRunning()) return res.status(409).json({ error: "A sync is already running. Wait for it to finish." });

  // runSync already records the failure against the run row; catching here stops it
  // surfacing as an unhandled rejection now that nobody awaits this promise.
  // A sync creates students, units and grades from an external system, so starting
  // one by hand is a privileged action even though the caller writes nothing directly.
  // Recorded at the point it is STARTED, because that is the decision a person made —
  // the outcome lands in MoodleSync, which the status endpoint reads. Nothing about
  // the connection itself is written: the token lives in the tenant's integration
  // record and has no business in a log an administrator can export.
  audit.record(req, {
    action: "moodle.sync.started", entity: "MoodleSync",
    summary: `Moodle sync started manually by ${req.user?.name || req.user?.email || "an administrator"} — it may create or update students, units and grades`,
    after: { mode: "manual" },
  });

  moodle
    .runSync({ startedBy: req.user?.name || req.user?.email || null, mode: "manual" })
    .catch((e) => console.error("[moodle] sync failed:", e.message));

  res.status(202).json({ started: true });
});

module.exports = router;
