// The Moodle sync must stamp a department on the rows it creates.
//
// WHY THIS IS A TEXT TEST rather than a smoke assertion. syncFromMoodle() talks to a real
// Moodle over HTTP; there is no fake, and scripts/ has no suite that can run it, so the
// behaviour these assertions describe cannot be exercised end to end on this machine.
// Reading the source is what is available, and the alternative was no coverage at all for
// a bug whose symptom is invisible: rows created correctly in every respect except that
// the staff who teach them cannot see them. schema-contract.test.js and
// academicDepartmentNaming.test.js read source as text for the same reason.
//
// WHAT WENT WRONG. A unit was created from `data` that carried courseId but no
// academicDepartmentId, and a student from a create with neither. A course mapped to
// Business therefore gained units, sessions, assessments and students that were visible
// only to college-wide accounts, because a null department means exactly that. Nothing on
// any screen said so: the sync reported them as created, and it had.
//
// These are a WEAK PROXY and say so. They prove the column is written beside courseId and
// on the student create, which is the half that was missing. They cannot prove the value
// is right. A rewrite of this file that keeps the behaviour and moves the text will fail
// them, and the right response then is to check the behaviour and update the patterns.
//
// Run with: node --test src/moodleDepartmentStamp.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const SRC = readFileSync(join(__dirname, "moodle.js"), "utf8");

test("a synced unit takes its department from its course", () => {
  // The unit's `data` object, from `code:` to the closing brace. Both the create and the
  // update path build from it, which is why the assertion is about the object rather
  // than about either call.
  const block = SRC.match(/const data = \{\s*\n\s*code: parsed\.code,[\s\S]*?\n {6}\};/);
  assert.ok(block, "the unit `data` object is no longer recognisable — check the sync still stamps a department");
  assert.match(
    block[0],
    /academicDepartmentId: dbCourse \? \(dbCourse\.academicDepartmentId \?\? null\) : null/,
    "a synced unit is not given its course's department, so its sessions and assessments will be invisible to that department's staff",
  );
  // Written in the SAME object as courseId, not in a separate follow-up update. A second
  // write is a second chance to be interrupted, and a unit that has a course but no
  // department for the length of a network hiccup is the bug in miniature.
  assert.match(block[0], /courseId: dbCourse \? dbCourse\.id : null/);
});

test("a synced student is created with the department of the course they were found on", () => {
  const block = SRC.match(/st = await prisma\.student\.create\(\{[\s\S]*?\n {12}\}\);/);
  assert.ok(block, "the student create is no longer recognisable — check the sync still stamps a department");
  assert.match(
    block[0],
    /academicDepartmentId: dbCourse\?\.academicDepartmentId \?\? null/,
    "a synced student gets no department, and with no cohort either they are visible only to college-wide accounts",
  );
});

test("an existing student's department is filled in but never overwritten", () => {
  // The guard is the whole point: rewriting this nightly would move students across an
  // access boundary depending on the order Moodle listed their courses in. Both
  // conditions are asserted, because dropping either turns a repair into a reassignment.
  assert.match(
    SRC,
    /if \(st\.academicDepartmentId == null && st\.cohortId == null && dbCourse\?\.academicDepartmentId\) \{/,
    "the repair path no longer refuses to overwrite an existing department or a cohorted student",
  );
});
