// Which KIND of assessment a Moodle grade item is.
//
// PURE, and imports nothing — the same seam isoDate.js keeps, and for the same reason:
// this is a judgement that will be argued with, and it has to be checkable without
// standing up a Moodle.
//
// WHY THIS EXISTS.
//
// moodle.js has always created assessments with `type: "Assignment"` hardcoded, so every
// piece of work at a synced college looks like coursework. prediction/assessmentType.js
// exists to find the student who passes every essay and fails every exam — and against a
// synced college it can never fire, because there are no exams in the data. Not because
// the college has none, but because the importer flattened them.
//
// Moodle already tells us. `itemmodule` is on every grade item and moodle.js already
// reads it, at the filter that drops attendance items. The information was on the wire
// and being discarded.
//
// THE MAPPING IS DELIBERATELY SHORT, AND THAT IS THE POINT.
//
// Only two mappings are confident enough to make. Everything else falls through to the
// existing default, because a WRONG type is worse than no type: it would put a student's
// coursework into the exam bucket and produce a confident "fails exams" finding about
// somebody who has never sat one. An unmapped module leaves the data exactly as it is
// today, so this change can only ever add information.
//
//   assign -> Assignment   Moodle's own coursework module. The current default anyway,
//                          named explicitly so the mapping reads as a decision.
//   quiz   -> Exam         A Moodle quiz is timed, auto-marked and sat in one sitting.
//                          NOT because every quiz is a formal exam -- some are formative
//                          practice -- but because it is the one module that differs IN
//                          KIND from coursework, which is the distinction the signal is
//                          about. A college using quizzes formatively will see the type
//                          on the assessment and can correct it; a college using them as
//                          exams gets the finding for free.
//
// WHAT IS DELIBERATELY NOT MAPPED:
//
//   workshop  peer assessment. It is neither an assignment nor an exam and forcing it
//             into either would misdescribe it.
//   lti / turnitintooltwo  an external tool, which is USUALLY an essay and sometimes a
//             timed test. STATUS.md notes most assessments at this college are LTI or
//             Turnitin grade items, so this is the common case -- and guessing on the
//             common case is exactly how a wrong finding becomes the normal one.
//   forum, glossary, data, lesson  gradeable activities that are rarely the assessment
//             a progression decision turns on.
//
// AND IT NEVER OVERWRITES A TYPE A HUMAN SET. The caller applies this on CREATE only.
// Staff can set a type on the Assessments page from an allowlist, and a sync that
// re-flattened their correction every night would be worse than never having mapped
// anything: the correction would appear to work and silently revert.

/** The types routes/assessments.js accepts. Duplicated deliberately rather than imported:
 *  this module must stay pure and free of the route layer, and a mismatch is caught by a
 *  test that reads the route's own list. */
const ASSESSMENT_TYPES = ["Assignment", "Exam", "Presentation", "Project", "Portfolio"];

const MODULE_TYPES = {
  assign: "Assignment",
  quiz: "Exam",
};

/**
 * @param {string} itemmodule  Moodle's own module name for the grade item
 * @returns {string|null} one of ASSESSMENT_TYPES, or null when nothing confident can be
 *          said — in which case the caller leaves its existing default alone.
 */
function assessmentTypeFor(itemmodule) {
  if (typeof itemmodule !== "string") return null;
  // Moodle lowercases module names, but a site with an odd plugin or a future API change
  // could differ, and matching case-sensitively would silently stop mapping anything --
  // failing to the default, invisibly, which is the failure mode this file is about.
  const key = itemmodule.trim().toLowerCase();
  return MODULE_TYPES[key] || null;
}

module.exports = { assessmentTypeFor, MODULE_TYPES, ASSESSMENT_TYPES };
