// Tests for the Moodle item-type mapping.
//
// Weighted toward what is NOT mapped, because that is where the harm is: a wrong type
// produces a confident "this student fails exams" about somebody who has never sat one,
// and it produces it about the COMMON case, since most assessments here are LTI or
// Turnitin items.
//
// Run with: node --test src/vle/moodleItemType.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { assessmentTypeFor, ASSESSMENT_TYPES } = require("./moodleItemType");

/* -------------------------------------------------------------------------- */
/* What is mapped                                                              */
/* -------------------------------------------------------------------------- */

test("a Moodle assignment is coursework", () => {
  assert.equal(assessmentTypeFor("assign"), "Assignment");
});

test("a Moodle quiz is an exam", () => {
  // The one module that differs IN KIND from coursework, which is the distinction
  // prediction/assessmentType.js exists to find.
  assert.equal(assessmentTypeFor("quiz"), "Exam");
});

test("the module name is matched case- and whitespace-insensitively", () => {
  // Matching case-sensitively would silently stop mapping anything if a site or a future
  // API differed — falling back to the default invisibly, which is the exact failure this
  // file was written to undo.
  for (const v of ["QUIZ", "Quiz", " quiz ", "\tquiz"]) {
    assert.equal(assessmentTypeFor(v), "Exam", JSON.stringify(v));
  }
});

/* -------------------------------------------------------------------------- */
/* What is deliberately NOT mapped — the important half                        */
/* -------------------------------------------------------------------------- */

test("an external tool is NOT guessed at, and it is the common case", () => {
  // STATUS.md records that most assessments here are LTI/Turnitin grade items. Guessing
  // on the common case is how a wrong finding becomes the normal one: an essay filed as
  // an exam would produce "fails exams" about a student who has never sat one.
  assert.equal(assessmentTypeFor("lti"), null);
  assert.equal(assessmentTypeFor("turnitintooltwo"), null);
});

test("peer assessment is neither an assignment nor an exam", () => {
  assert.equal(assessmentTypeFor("workshop"), null);
});

test("gradeable activities that are not the assessment a decision turns on are unmapped", () => {
  for (const m of ["forum", "glossary", "data", "lesson", "attendance", "choice"]) {
    assert.equal(assessmentTypeFor(m), null, m);
  }
});

test("nonsense produces no type rather than a wrong one", () => {
  for (const junk of [null, undefined, 42, {}, [], "", "   ", true]) {
    assert.equal(assessmentTypeFor(junk), null, JSON.stringify(junk));
  }
});

/* -------------------------------------------------------------------------- */
/* The two hand-maintained lists                                               */
/* -------------------------------------------------------------------------- */

test("every type this can produce is one the assessments route accepts", () => {
  // The allowlist is duplicated here so this module stays pure and free of the route
  // layer. Duplication is only safe while something checks it: a type produced here but
  // rejected there would fail the sync at the moment a college first ran one, and the
  // stack trace would point at Prisma rather than at this decision.
  const src = fs.readFileSync(path.join(__dirname, "..", "routes", "assessments.js"), "utf8");
  const m = src.match(/const TYPES = \[([^\]]+)\]/);
  assert.ok(m, "routes/assessments.js no longer declares TYPES — this test needs rewriting, not deleting");

  const routeTypes = m[1].match(/"[^"]+"/g).map((s) => s.slice(1, -1));
  assert.deepEqual(ASSESSMENT_TYPES, routeTypes, "the two type lists have drifted");

  for (const module of ["assign", "quiz"]) {
    const produced = assessmentTypeFor(module);
    assert.ok(routeTypes.includes(produced), `${module} maps to "${produced}", which the route would refuse`);
  }
});
