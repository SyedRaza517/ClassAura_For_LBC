// Run with: node --test src/timetabling/campusMatch.test.js   (from server/)
const { test } = require("node:test");
const assert = require("node:assert");
const { normaliseCampus, groupCampuses } = require("./campusMatch");

test("normalise folds case and collapses whitespace", () => {
  assert.equal(normaliseCampus("  Ealing   Campus "), "ealing campus");
  assert.equal(normaliseCampus("EALING"), "ealing");
});

test("empty and whitespace-only names normalise to empty", () => {
  assert.equal(normaliseCampus(""), "");
  assert.equal(normaliseCampus("   "), "");
  assert.equal(normaliseCampus(null), "");
  assert.equal(normaliseCampus(undefined), "");
});

test("variants group under the most common spelling", () => {
  const g = groupCampuses(["Ealing", "ealing", "Ealing", "Harrow"]);
  assert.equal(g.length, 2);
  const ealing = g.find((x) => x.canonical === "Ealing");
  assert.ok(ealing, "the 3x spelling wins as canonical");
  assert.deepEqual(ealing.variants.slice().sort(), ["Ealing", "ealing"]);
});

test("blank names produce no campus at all", () => {
  // A room with no campus recorded must not manufacture a campus called "".
  assert.deepEqual(groupCampuses(["", "  ", null, undefined]), []);
});

test("ties break alphabetically so the result is deterministic", () => {
  const g = groupCampuses(["beta", "Beta"]);
  assert.equal(g.length, 1);
  assert.equal(g[0].canonical, "Beta");
});

test("two runs over the same data agree", () => {
  // A migration that picks a different winner on a re-run is one nobody can verify.
  const names = ["Harrow", "harrow", "HARROW", "Ealing", "ealing"];
  assert.deepEqual(groupCampuses(names), groupCampuses(names.slice().reverse()));
});

test("names differing by more than case stay separate", () => {
  // EXACT AND CASE-INSENSITIVE ONLY. Deciding "Ealing" and "Ealing Annexe" are the
  // same place merges two campuses in a filter somebody will count students with,
  // and the merge is invisible afterwards.
  const g = groupCampuses(["Ealing", "Ealing Annexe"]);
  assert.equal(g.length, 2);
});

test("internal whitespace differences DO group", () => {
  const g = groupCampuses(["Ealing  Campus", "Ealing Campus"]);
  assert.equal(g.length, 1);
  assert.equal(g[0].canonical, "Ealing Campus");
});
