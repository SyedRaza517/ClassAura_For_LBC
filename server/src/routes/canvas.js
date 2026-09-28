// Canvas — read-only for now.
//
// There is deliberately NO sync route here. vle/canvas.js and vle/canvasNormalise.js are
// complete but nothing writes Canvas data to this database yet, and a /sync endpoint
// that did nothing would be worse than none: it would read as a working integration.
//
// The one route is a preview, which reads Canvas and reports what an importer would
// find — chiefly whether this account's submissions carry real hand-in dates, the
// property that decides whether an importer is worth building at all.
const router = require("express").Router();
const { requireAuth, requireAnyPage, requireCollegeWide } = require("../auth");
const canvas = require("../vle/canvas");
const canvasPreview = require("../canvasPreview");
const cfg = require("../integrationConfig");

// The SAME pages the Moodle routes read behind. A preview writes nothing, but it reads
// a college's course, roster and grade data out of their VLE, which is not something to
// hand to an admin who was granted only app configuration.
const READ_PAGES = ["settings", "assessments", "registers", "students"];
router.use(requireAuth, requireAnyPage(READ_PAGES));

// Is Canvas set up, and does the token work? Cheap — two calls, no course sweep.
router.get("/status", async (_req, res) => {
  // PRIME THIS INSTITUTION'S CONFIGURATION FIRST. isConfigured() is synchronous and
  // reads integrationConfig's cache; called cold it answers from process.env and would
  // tell a college that saved its own Canvas credentials in Settings that Canvas "isn't
  // set up yet" while they sat working one screen away. routes/moodle.js carries the
  // same warning, having shipped that exact bug.
  await cfg.load("canvas");
  const configured = canvas.isConfigured();
  if (!configured) {
    return res.json({ configured: false, ok: false, note: "Canvas isn't set up yet. Add the Canvas address and an access token under Settings → Connected systems." });
  }
  const conn = await canvas.testConnection();
  res.json({ configured: true, ok: conn.ok, note: conn.note });
});

// What would an import find? Reads only.
// College-wide only, like the Moodle preview: it reads rosters out of the whole VLE,
// which no departmental filter in this database can narrow.
router.get("/preview", requireCollegeWide("A Canvas preview"), async (_req, res, next) => {
  try {
    const out = await canvasPreview.preview();
    // 200 even when ok:false. A token that cannot see courses is a FINDING to display,
    // not a server error — the screen shows the note and the administrator acts on it.
    res.json({ preview: true, ...out });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
