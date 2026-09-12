// Pure logic, tested with no database — see .claude/rules/testing.md. titleFor is
// the one piece of notify.js with no I/O in it: everything else in that file talks
// to Prisma, sendEmail or sendPush, which is why this file tests titleFor alone
// rather than notifyStaff/notifyStudent themselves.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { titleFor } = require("./notify");

test("titleFor: a configured display name wins for either audience", () => {
  assert.equal(titleFor("Riverside College", "staff"), "Riverside College");
  assert.equal(titleFor("Riverside College", "student"), "Riverside College");
});

test("titleFor: an unbranded college falls back per audience, never to the other audience's product name", () => {
  // Staff falls back to the literal this function replaced, so an unbranded
  // college's staff pushes read exactly as they did before this change.
  assert.equal(titleFor(null, "staff"), "Staff Hub");
  assert.equal(titleFor(undefined, "staff"), "Staff Hub");
  assert.equal(titleFor("", "staff"), "Staff Hub");
  // Students never see "Staff Hub" — that names a screen they've never opened.
  assert.equal(titleFor(null, "student"), "ClassAura");
  assert.equal(titleFor(undefined, "student"), "ClassAura");
  assert.equal(titleFor("", "student"), "ClassAura");
});

test("titleFor: an unrecognised audience is treated as staff, matching every caller in this file", () => {
  // notify.js only ever passes "staff" or "student", but a third value should not
  // silently look like a student fallback — the safer default (this codebase's
  // existing product name) is what an unexpected caller should get.
  assert.equal(titleFor(null, "unknown"), "Staff Hub");
});
