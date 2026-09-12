// Unit tests for teamsProvisioning.js's pure helpers only — truncateName and
// teamNameFor need no database and no Microsoft tenant to reason about, which is
// exactly testing.md's "pure logic beside its tests" rule. runProvisioning itself is
// wiring (Prisma reads, Graph writes, a run-row lifecycle) and is exercised by the
// smoke suite instead, the same split teamsSync.js and its suite already draw.
const test = require("node:test");
const assert = require("node:assert/strict");
const { truncateName, teamNameFor } = require("./teamsProvisioning");

test("truncateName leaves a short name untouched", () => {
  assert.equal(truncateName("HND Computing — SEP 2025", 120), "HND Computing — SEP 2025");
});

test("truncateName clips to the Graph limit rather than erroring", () => {
  const long = "x".repeat(200);
  assert.equal(truncateName(long, 120).length, 120);
});

test("truncateName treats a missing name as empty rather than throwing", () => {
  assert.equal(truncateName(undefined, 50), "");
  assert.equal(truncateName(null, 50), "");
});

test("teamNameFor combines the course and cohort names when a course is present", () => {
  const cohort = { name: "SEP 2025", course: { name: "HND Computing" } };
  assert.equal(teamNameFor(cohort), "HND Computing — SEP 2025");
});

test("teamNameFor falls back to the cohort name alone with no course link", () => {
  // Cohort.course is a required relation in schema.prisma, so this only happens if a
  // caller fetches a cohort without including it — exactly the case this fallback
  // guards, per teamNameFor's own comment.
  const cohort = { name: "SEP 2025" };
  assert.equal(teamNameFor(cohort), "SEP 2025");
});

test("teamNameFor truncates a combined name past Graph's 120-character limit", () => {
  const cohort = { name: "y".repeat(150), course: { name: "HND Computing" } };
  const name = teamNameFor(cohort);
  assert.equal(name.length, 120);
  assert.ok(name.startsWith("HND Computing — "));
});
