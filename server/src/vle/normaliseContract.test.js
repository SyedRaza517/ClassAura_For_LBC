// The contract BOTH VLE normalisers must satisfy.
//
// canvasNormalise and blackboardNormalise are written from two very different APIs,
// and they were written days apart. Their own test files check each against its own
// provider's quirks — which is necessary and is not enough, because nothing there
// notices when the two answer the SAME REAL-WORLD FACT differently.
//
// That is not hypothetical. A code review found three instances at once:
//
//   * "the student did not hand it in" gave onTime:false from Canvas and onTime:true
//     from Blackboard. A college's on-time rate would have depended on which VLE it
//     ran, and a mixed estate would have been silently non-comparable.
//   * a zero or absent denominator was refused by Canvas and returned by Blackboard,
//     so the same gradebook column yielded null from one and a division by zero from
//     the other.
//   * Blackboard recorded submittedOn from the attempt RECEIPT but computed lateness
//     from the attempt DATE, so a row could read "submitted 28 April" and "late"
//     against a 1 May deadline at the same time.
//
// One sync will read both. So this file tests the SEAM: a table of facts, each
// expressed in both providers' shapes, asserting the two agree. It is the same idea
// as prediction/schema-contract.test.js — the bugs that survive are the ones in the
// gap between two things that each look right on their own.
//
// Run with: node --test src/vle/normaliseContract.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const canvas = require("./canvasNormalise");
const blackboard = require("./blackboardNormalise");

const DUE = "2026-05-01T23:59:00.000Z";
const BEFORE = "2026-04-28T09:00:00.000Z";
const AFTER = "2026-05-02T09:00:00.000Z";

// Clocks either side of the deadline. Canvas encodes overdue-ness in its own `missing`
// flag; Blackboard has to be told the time, so the pairs below supply both.
const PAST_DUE = Date.parse("2026-06-01T00:00:00.000Z");
const NOT_YET_DUE = Date.parse("2026-04-01T00:00:00.000Z");

/**
 * One real-world fact, written in each provider's own shape.
 *
 * `canvas` and `blackboard` are the arguments each normaliser takes for that fact;
 * `expect` is what BOTH must answer.
 */
const SUBMISSION_FACTS = [
  {
    fact: "handed in, before the deadline",
    canvas: [{ workflow_state: "submitted", submitted_at: BEFORE, late: false }],
    blackboard: [{ status: "Completed", attemptDate: BEFORE }, { grading: { due: DUE } }],
    expect: { status: "submitted", onTime: true },
  },
  {
    fact: "handed in, after the deadline",
    canvas: [{ workflow_state: "submitted", submitted_at: AFTER, late: true }],
    blackboard: [{ status: "Completed", attemptDate: AFTER }, { grading: { due: DUE } }],
    expect: { status: "submitted", onTime: false },
  },
  {
    fact: "past the deadline and nothing was handed in",
    canvas: [{ workflow_state: "unsubmitted", submitted_at: null, missing: true }],
    blackboard: [{ status: "NotAttempted" }, { grading: { due: DUE } }, PAST_DUE],
    // onTime must be NULL, not a boolean. You cannot be on time or late for work you
    // never submitted, and either boolean is a value an on-time rate would count.
    expect: { status: "not_submitted", onTime: null },
  },
  {
    fact: "not handed in and not yet due",
    canvas: [{ workflow_state: "unsubmitted", submitted_at: null, missing: false }],
    blackboard: [{ status: "InProgress" }, { grading: { due: DUE } }, NOT_YET_DUE],
    // Both must say "unknown": chasing a student over work set for next month is the
    // failure this pairing exists to prevent.
    expect: { status: "unknown", onTime: null },
  },
  {
    fact: "a state the provider added after this code was written",
    canvas: [{ workflow_state: "something_new", submitted_at: null }],
    blackboard: [{ status: "SomethingNew" }, { grading: { due: DUE } }, PAST_DUE],
    expect: { status: "unknown", onTime: null },
  },
];

test("both normalisers answer the same real-world fact the same way", () => {
  for (const c of SUBMISSION_FACTS) {
    const a = canvas.submissionOf(...c.canvas);
    const b = blackboard.submissionOf(...c.blackboard);

    for (const [key, want] of Object.entries(c.expect)) {
      assert.equal(a[key], want, `canvas disagrees on "${c.fact}": ${key} = ${a[key]}, expected ${want}`);
      assert.equal(b[key], want, `blackboard disagrees on "${c.fact}": ${key} = ${b[key]}, expected ${want}`);
    }
    // Belt and braces: even where the table does not pin a field, the two must not
    // diverge on it.
    assert.equal(a.status, b.status, `"${c.fact}": canvas says ${a.status}, blackboard says ${b.status}`);
    assert.equal(a.onTime, b.onTime, `"${c.fact}": canvas onTime=${a.onTime}, blackboard onTime=${b.onTime}`);
  }
});

test("onTime is never a boolean for work that was not submitted", () => {
  // The house rule the whole codebase runs on: unmeasurable is null, and null is
  // excluded from the denominator. A boolean here would be counted.
  const notSubmitted = [
    canvas.submissionOf({ workflow_state: "unsubmitted", submitted_at: null, missing: true }),
    canvas.submissionOf({ workflow_state: "unsubmitted", submitted_at: null, missing: false }),
    blackboard.submissionOf({ status: "NotAttempted" }, { grading: { due: DUE } }, PAST_DUE),
    blackboard.submissionOf({ status: "InProgress" }, { grading: { due: DUE } }, NOT_YET_DUE),
  ];
  for (const r of notSubmitted) {
    assert.equal(r.onTime, null, `expected null, got ${r.onTime} for status ${r.status}`);
  }
});

/* -------------------------------------------------------------------------- */
/* Marks                                                                       */
/* -------------------------------------------------------------------------- */

test("neither normaliser returns a mark without a usable denominator", () => {
  // possible <= 0 makes every percentage derived from it a division by zero, and a
  // null denominator makes it NaN. Both are numbers that look reasonable downstream.
  const noDenominator = [
    ["canvas points_possible 0", canvas.markOf({ workflow_state: "graded", score: 5 }, { points_possible: 0 })],
    ["canvas points_possible null", canvas.markOf({ workflow_state: "graded", score: 5 }, { points_possible: null })],
    ["blackboard possible 0", blackboard.markOf({ displayGrade: { scaleType: "Score", score: 5, possible: 0 } })],
    ["blackboard possible null", blackboard.markOf({ displayGrade: { scaleType: "Score", score: 5, possible: null } })],
    ["blackboard override with no displayGrade", blackboard.markOf({ overridden: true, score: 55 })],
  ];
  for (const [label, r] of noDenominator) {
    assert.equal(r, null, `${label}: expected null, got ${JSON.stringify(r)}`);
  }
});

test("a mark that IS returned always carries a positive denominator", () => {
  const marks = [
    canvas.markOf({ workflow_state: "graded", score: 72 }, { points_possible: 100 }),
    canvas.markOf({ workflow_state: "graded", score: 0 }, { points_possible: 50 }),
    blackboard.markOf({ displayGrade: { scaleType: "Score", score: 72, possible: 100 } }),
    blackboard.markOf({ overridden: true, score: 55, displayGrade: { scaleType: "Score", score: 72, possible: 100 } }),
  ];
  for (const m of marks) {
    assert.ok(m && typeof m.score === "number", `expected a mark, got ${JSON.stringify(m)}`);
    assert.ok(typeof m.possible === "number" && m.possible > 0,
      `a returned mark must have a positive denominator; got ${JSON.stringify(m)}`);
  }
});

test("a genuine zero survives in both", () => {
  assert.deepEqual(canvas.markOf({ workflow_state: "graded", score: 0 }, { points_possible: 50 }), { score: 0, possible: 50 });
  assert.deepEqual(blackboard.markOf({ displayGrade: { scaleType: "Score", score: 0, possible: 50 } }), { score: 0, possible: 50 });
});

/* -------------------------------------------------------------------------- */
/* Internal consistency of one row                                             */
/* -------------------------------------------------------------------------- */

test("the date a submission is recorded under is the date its lateness is judged by", () => {
  // Blackboard prefers the attempt RECEIPT for the recorded date, because attemptDate
  // moves when an attempt is reopened. Lateness was being computed from attemptDate,
  // so a reopened attempt produced a row reading "submitted 28 April" and "late"
  // against a 1 May deadline — simultaneously, in the same row.
  const r = blackboard.submissionOf({
    status: "Completed",
    attemptDate: AFTER,                                  // reopened after the deadline
    attemptReceipt: { submissionDate: BEFORE },          // actually handed in before it
  }, { grading: { due: DUE } });

  assert.equal(r.submittedOn, "2026-04-28");
  assert.equal(r.onTime, true,
    "a row recorded as submitted on 28 April cannot also be late for a 1 May deadline");
});

/* -------------------------------------------------------------------------- */
/* Dates                                                                       */
/* -------------------------------------------------------------------------- */

test("an academic date is the college's local date, not UTC", () => {
  // A hand-in at 00:30 BST on the deadline day is on the deadline day. Slicing the
  // UTC ISO string dates it to the day before — so a student who submitted half an
  // hour into the deadline day is recorded as having submitted the previous day, and
  // once lateness is derived from the same value it inherits the error.
  //
  // Both normalisers must agree, and must agree with src/clock.js, which pins
  // APP_TIMEZONE for exactly this reason.
  for (const [name, mod] of [["canvas", canvas], ["blackboard", blackboard]]) {
    assert.equal(mod.isoDate("2026-05-01T00:30:00+01:00"), "2026-05-01",
      `${name}: a 00:30 BST submission on 1 May must be dated 1 May`);
    assert.equal(mod.isoDate("2026-01-15T00:30:00Z"), "2026-01-15",
      `${name}: GMT (no offset) must be unaffected`);
  }
});

test("both normalisers reject unusable dates the same way", () => {
  for (const [name, mod] of [["canvas", canvas], ["blackboard", blackboard]]) {
    for (const bad of [null, undefined, "", "not a date", 12345]) {
      assert.equal(mod.isoDate(bad), null, `${name}: ${JSON.stringify(bad)} should be null`);
    }
  }
});
