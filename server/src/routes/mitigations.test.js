// Pure-logic coverage for the window-cap validator this file shares with
// routes/student.js — see mitigations.js's own module.exports comment for why it is
// attached to the router rather than living in its own module. No database: this is
// exactly the case testing.md describes ("pure logic lives in its own file with
// tests beside it and no database") — validateWindow touches only its two string
// arguments and the `cfg` object handed to it, never Prisma.
//
// Task 7 added a SECOND caller of this function (a student raising their own claim)
// and its own brief asks, deliberately narrower than a full smoke suite: "here at
// least the refusal paths by direct call" — Task 9 carries the HTTP-level suite for
// both routes. This is that direct call: every refusal validateWindow can produce,
// proven against the SAME function both routes now share, so a regression here is a
// regression for a student's own submission and an administrator's alike.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const mitigationsRouter = require("./mitigations");

const { validateWindow, CATEGORIES } = mitigationsRouter;

// A stand-in for the college's saved settings row — the real shape has far more on
// it (prediction/settings.js), but validateWindow reads exactly one field.
const cfg = (maxDays) => ({ mitigationWindowMaxDays: maxDays });

test("validateWindow: exported from the router, not re-implemented per caller", () => {
  // Proves the SEAM this test exists to guard: routes/student.js imports these two
  // names off the same router object index.js mounts. If a future edit swapped
  // `module.exports = router` for `module.exports = { router, validateWindow }` (a
  // very natural-looking refactor), wrapAsync(require("./routes/mitigations")) in
  // index.js would receive a plain object with no `.stack` and every mitigations
  // route would 500 on its very first request — silently, because Express would not
  // reject an object at require time. Asserting the router is still callable (a
  // function is what Express expects to mount) is the guard against exactly that.
  assert.equal(typeof mitigationsRouter, "function");
  assert.equal(typeof validateWindow, "function");
  assert.ok(Array.isArray(CATEGORIES) && CATEGORIES.length > 0);
});

test("validateWindow: refuses a date that is not real, naming the field", async () => {
  const r = await validateWindow({ coversFrom: "2026-02-30", coversTo: "2026-03-01" }, cfg(120));
  assert.ok(r.error, "expected a refusal for an impossible calendar date");
  assert.match(r.error, /real start and end date/);
});

test("validateWindow: refuses a missing date the same way as a malformed one", async () => {
  const r = await validateWindow({ coversFrom: "", coversTo: "2026-03-01" }, cfg(120));
  assert.ok(r.error);
  assert.match(r.error, /real start and end date/);
});

test("validateWindow: refuses a window that ends before it starts", async () => {
  // The exact failure this check exists to catch: adjustments.js compares every
  // date with `date >= from && date <= to`, so a reversed window would be stored,
  // displayed as though it protected the student, and silently cover nobody.
  const r = await validateWindow({ coversFrom: "2026-03-10", coversTo: "2026-03-01" }, cfg(120));
  assert.ok(r.error);
  assert.match(r.error, /ends before it starts/);
});

test("validateWindow: a single-day claim is valid (coversFrom === coversTo)", async () => {
  const r = await validateWindow({ coversFrom: "2026-03-01", coversTo: "2026-03-01" }, cfg(120));
  assert.equal(r.error, undefined);
  assert.equal(r.coversFrom, "2026-03-01");
  assert.equal(r.coversTo, "2026-03-01");
});

test("validateWindow: refuses a window longer than the college's own cap", async () => {
  // 10 days requested, a 5-day cap — inclusive-day arithmetic (span = daysBetween+1)
  // means this is the boundary case that most often gets an off-by-one wrong.
  const r = await validateWindow({ coversFrom: "2026-01-01", coversTo: "2026-01-10" }, cfg(5));
  assert.ok(r.error);
  assert.match(r.error, /longest a single claim may cover is 5/);
});

test("validateWindow: accepts a window exactly at the cap (inclusive)", async () => {
  // 5 days from Jan 1 to Jan 5 inclusive, against a 5-day cap — must pass, not be
  // treated as one day over by an off-by-one in the inclusive-span arithmetic.
  const r = await validateWindow({ coversFrom: "2026-01-01", coversTo: "2026-01-05" }, cfg(5));
  assert.equal(r.error, undefined);
});

test("validateWindow: trims surrounding whitespace before validating", async () => {
  const r = await validateWindow({ coversFrom: "  2026-03-01  ", coversTo: " 2026-03-02" }, cfg(120));
  assert.equal(r.error, undefined);
  assert.equal(r.coversFrom, "2026-03-01");
  assert.equal(r.coversTo, "2026-03-02");
});

test("CATEGORIES: carries the vocabulary the student form and the staff form both read", () => {
  // Not exhaustive of every entry — a change to the list itself is a product
  // decision, not a bug this test should pin down — but "other" and "illness" are
  // load-bearing: "other" is what stops a college being forced to misdescribe a
  // claim, and its absence would be caught by every category dropdown at once.
  assert.ok(CATEGORIES.includes("other"));
  assert.ok(CATEGORIES.includes("illness"));
});
