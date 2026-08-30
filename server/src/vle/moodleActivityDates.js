// When is a Moodle activity due?
//
// PURE. No network, no database — the same seam moodleItemType.js keeps, and for the
// same reason: this is a judgement that will be argued with, and it has to be checkable
// without standing up a Moodle.
//
// WHY THIS EXISTS.
//
// The sync creates an Assessment for every gradable item and has never written its
// dueDate. Every assessment at a synced college therefore arrives with no deadline at
// all — which is the one column the assessment tracker is built around. "When is the
// deadline" was unanswerable for exactly the colleges that import their assessments
// rather than typing them.
//
// AND IT COSTS NO EXTRA MOODLE CALLS. `core_course_get_contents` is already issued once
// per course by readMoodle(), and every module in its response already carries a
// `dates` array. The information was on the wire and being discarded — the same shape
// as the VLE-engagement finding, where `lastcourseaccess` was already in the enrolled-
// users response.
//
// The join is the course-module id: gradereport gives `item.cmid`, contents gives
// `module.id`, and Assessment already stores it as `moodleCmid`.
//
// WHICH LABEL COUNTS, AND WHY THE LIST IS SHORT.
//
// Moodle labels these per module and per language: "Due:", "Due date:", "Closed:",
// "Opened:", "Opens:". Only two of those are deadlines.
//
//   /due/i    — assign, turnitintooltwo and most activities. The primary match.
//   /clos/i   — a quiz's "Closes:" IS the last moment to submit, and a college that
//               assesses by quiz would otherwise get no deadline at all. Used ONLY
//               when no "due" label exists, so it can never displace a real due date.
//
// "Opened:" / "Opens:" is deliberately never matched. It is the moment work becomes
// AVAILABLE, and reading it as a deadline would mark every assessment overdue from the
// day it was set — manufacturing a screen full of red that describes nothing. A wrong
// deadline is worse than no deadline: no deadline reads as "not recorded", which is
// true, while a wrong one is a confident falsehood the tracker then colours red.
const { isoDate, DEFAULT_ZONE } = require("./isoDate");

// Moodle timestamps are Unix SECONDS. Converted to an ISO string and handed to
// isoDate rather than sliced here, so there is exactly one implementation of "an
// academic date is the college's local date, not UTC" — see isoDate.js. A 23:59 BST
// deadline sliced off a UTC string lands on the previous day, and every assessment
// would then read as due a day early.
function dateFromEpoch(seconds, zone = DEFAULT_ZONE) {
  const n = Number(seconds);
  // 0 is Moodle's "not set", not 1 January 1970. Negative and non-finite values are
  // corrupt rather than historic, and either way are not a deadline.
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n * 1000);
  if (!Number.isFinite(d.getTime())) return null;
  return isoDate(d.toISOString(), zone);
}

/**
 * The deadline on one `core_course_get_contents` module, or null.
 *
 * Exported for its own tests: the label rules above are the arguable part, and they
 * are easier to pin one module at a time than through the whole map.
 */
function dueDateOf(mod, zone = DEFAULT_ZONE) {
  const dates = Array.isArray(mod?.dates) ? mod.dates : [];
  let closes = null;
  for (const d of dates) {
    const label = String(d?.label || "");
    if (/open/i.test(label)) continue;          // availability, never a deadline
    if (/due/i.test(label)) {
      const iso = dateFromEpoch(d?.timestamp, zone);
      if (iso) return iso;                       // a real due date wins immediately
    } else if (/clos/i.test(label) && closes == null) {
      closes = dateFromEpoch(d?.timestamp, zone);
    }
  }
  return closes;
}

/**
 * Map of course-module id -> "YYYY-MM-DD", for every module in a course that has a
 * deadline. Modules with none are ABSENT rather than present-and-null, so a caller
 * reading this cannot accidentally write a null over a date somebody typed by hand.
 *
 * `sections` is the raw core_course_get_contents response. Sections nest, so this
 * walks them defensively — a Moodle course with no modules, or a section with no
 * `modules` array, must produce an empty map rather than throw into the sync.
 */
function dueDatesByCmid(sections, zone = DEFAULT_ZONE) {
  const out = new Map();
  for (const sec of Array.isArray(sections) ? sections : []) {
    for (const mod of Array.isArray(sec?.modules) ? sec.modules : []) {
      const id = Number(mod?.id);
      if (!Number.isFinite(id)) continue;
      const due = dueDateOf(mod, zone);
      if (due) out.set(id, due);
    }
  }
  return out;
}

module.exports = { dueDatesByCmid, dueDateOf, dateFromEpoch };
