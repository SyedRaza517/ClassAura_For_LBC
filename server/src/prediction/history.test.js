// Tests for the trajectory layer.
//
// Weighted toward the cases where a plausible number would be a lie: a student scored for
// the first time today, six snapshots from one afternoon, a model upgrade, and a college
// that renamed its bands. Each of those produces a confident-looking figure if the guard
// is missing, and each is a real thing that happens.
//
// Run with: node --test src/prediction/history.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  evaluate, bandRuns, oscillation, recovered, usableRun, bandLadder, HISTORY, HISTORY_CODES,
} = require("./history");

const TODAY = "2026-08-28";

// The platform ladder, deliberately given OUT of order so nothing can quietly depend on
// array position — see bandLadder().
const BANDS = [
  { key: "R3", label: "Moderate Risk", min: 55, max: 69.99 },
  { key: "R1", label: "Very High Progression Confidence", min: 85, max: 100 },
  { key: "R5", label: "Critical Risk", min: 0, max: 39.99 },
  { key: "R2", label: "Likely to Progress", min: 70, max: 84.99 },
  { key: "R4", label: "High Risk", min: 40, max: 54.99 },
];
const CFG = { bands: BANDS, interventionBand: "R3" };

const snap = (on, riskLevel, progressionScore = 60, modelVersion = "PROG-1.0") =>
  ({ on, riskLevel, progressionScore, modelVersion });

/** N daily snapshots ending on `end`, all in one band. */
function daily(end, days, band, score = 45) {
  const out = [];
  const t = Date.parse(`${end}T00:00:00Z`);
  for (let i = days - 1; i >= 0; i -= 1) {
    out.push(snap(new Date(t - i * 86400000).toISOString().slice(0, 10), band, score));
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* The ladder                                                                  */
/* -------------------------------------------------------------------------- */

test("the ladder is ordered by min, not by array position or by key string", () => {
  // BANDS above is deliberately shuffled. Array order would give R3 first; a key-string
  // sort would give R1..R5 by luck here but breaks the moment a college uses "AMBER" and
  // "RED", or ten bands where "R10" sorts before "R2".
  assert.deepEqual(bandLadder(BANDS), ["R1", "R2", "R3", "R4", "R5"]);
});

test("a college with its own four bands works unchanged", () => {
  const own = [
    { key: "GREEN", min: 70, max: 100 },
    { key: "RED", min: 0, max: 34.99 },
    { key: "AMBER", min: 35, max: 69.99 },
  ];
  assert.deepEqual(bandLadder(own), ["GREEN", "AMBER", "RED"]);
});

/* -------------------------------------------------------------------------- */
/* No trajectory                                                               */
/* -------------------------------------------------------------------------- */

test("a student scored for the first time today has NO trajectory, not a flat one", () => {
  // The rule the whole module rests on. Zero band changes would claim "we watched and it
  // never moved", which is a finding; one snapshot supports no finding at all.
  const r = evaluate({ today: TODAY, history: [snap(TODAY, "R4")] }, CFG);

  assert.equal(r.bandChanges, null);
  assert.equal(r.currentBandSince, null);
  assert.equal(r.recoveredPoints, null);
  assert.deepEqual(r.codes, []);
  // But how much history exists IS measurable from one row, and it is what explains the
  // nulls beside it rather than leaving a reader to think the feature is broken.
  assert.equal(r.observedDays, 1);
});

test("no history at all returns nulls and raises nothing", () => {
  const r = evaluate({ today: TODAY, history: [] }, CFG);
  assert.equal(r.observedDays, null);
  assert.equal(r.bandChanges, null);
  assert.deepEqual(r.codes, []);
});

/* -------------------------------------------------------------------------- */
/* Six snapshots from one afternoon                                            */
/* -------------------------------------------------------------------------- */

test("many runs on ONE day are one day of evidence, not many", () => {
  // runner.js writes a row per scoring RUN, and markStale fires on any data event — a
  // register taken, a grade arriving, a review saved. Counting rows would make a busy
  // Tuesday look like a fortnight of stability.
  const sameDay = [
    snap("2026-08-28", "R4", 45), snap("2026-08-28", "R4", 45), snap("2026-08-28", "R4", 45),
    snap("2026-08-28", "R4", 45), snap("2026-08-28", "R4", 45), snap("2026-08-28", "R4", 45),
  ];
  const r = evaluate({ today: TODAY, history: sameDay }, CFG);

  assert.equal(r.observedDays, 1, "six rows on one day is one day");
  assert.equal(r.bandChanges, null, "and one day is below the floor");
  assert.deepEqual(r.codes, []);
});

test("the LAST snapshot of a day wins, because it has seen the most", () => {
  const rows = [
    snap("2026-08-26", "R2", 75), snap("2026-08-27", "R2", 75),
    // Two on the 28th: the morning still said R2, the afternoon says R4.
    snap("2026-08-28", "R2", 75), snap("2026-08-28", "R4", 45),
  ];
  const run = usableRun(rows, {});
  assert.equal(run.length, 3);
  assert.equal(run[2].riskLevel, "R4", "the afternoon view is the settled one");
});

/* -------------------------------------------------------------------------- */
/* Chronic against acute — the distinction the module exists for              */
/* -------------------------------------------------------------------------- */

test("a long unbroken run at the intervention band or worse is CHRONIC", () => {
  const r = evaluate({ today: TODAY, history: daily(TODAY, 40, "R4") }, CFG);

  assert.ok(r.codes.includes(HISTORY.CHRONIC_RISK));
  assert.equal(r.currentBandSince, "2026-07-20");
  assert.equal(r.worstBandHeld, "R4");
});

test("a student who fell to the same band LAST WEEK is not chronic", () => {
  // The whole point. Both students are at R4 today and sort identically on the register;
  // one has had an intervention that did not work and one has had nothing tried at all.
  const history = [...daily("2026-08-21", 30, "R2", 75), ...daily(TODAY, 7, "R4", 45)];
  const r = evaluate({ today: TODAY, history }, CFG);

  assert.equal(r.codes.includes(HISTORY.CHRONIC_RISK), false);
  assert.equal(r.currentBandSince, "2026-08-22");
});

test("a long run in a GOOD band raises nothing", () => {
  // Chronic is about being stuck somewhere bad. A student at R1 all year is the outcome
  // the college wants, and a code on it would be a caseload of the whole cohort.
  const r = evaluate({ today: TODAY, history: daily(TODAY, 60, "R1", 92) }, CFG);
  assert.deepEqual(r.codes, []);
});

test("the intervention band comes from config, not from a position in the ladder", () => {
  // A college that only intervenes at its worst band must not have this fire at the
  // second-worst. settings.js refuses to save an interventionBand naming a band that
  // does not exist, precisely so this lookup cannot silently miss.
  const strict = { ...CFG, interventionBand: "R5" };
  const r = evaluate({ today: TODAY, history: daily(TODAY, 40, "R4") }, strict);
  assert.deepEqual(r.codes, []);
});

/* -------------------------------------------------------------------------- */
/* Oscillation                                                                 */
/* -------------------------------------------------------------------------- */

test("a fall and a recovery is NOT instability", () => {
  // Two changes is the most ordinary shape a year has, and a student who dipped and came
  // back is the college's own success story. Reporting them as unstable would put the
  // best outcome on a caseload.
  const history = [
    ...daily("2026-07-10", 5, "R2", 75),
    ...daily("2026-07-30", 5, "R4", 45),
    ...daily(TODAY, 5, "R2", 75),
  ];
  const r = evaluate({ today: TODAY, history }, CFG);

  assert.equal(r.bandChanges, 2);
  assert.equal(r.codes.includes(HISTORY.RISK_OSCILLATING), false);
});

test("a band that will not settle IS instability", () => {
  const history = [
    snap("2026-08-01", "R2", 75), snap("2026-08-08", "R4", 45),
    snap("2026-08-15", "R2", 75), snap("2026-08-22", "R4", 45),
  ];
  const r = evaluate({ today: TODAY, history }, CFG);

  assert.equal(r.bandChanges, 3);
  assert.ok(r.codes.includes(HISTORY.RISK_OSCILLATING));
});

test("changes are counted, not distinct bands", () => {
  // A slow steady decline through four bands changed three times and visited four. A
  // student flipping between two every week is the unstable one, and counting distinct
  // bands would rate the decline as worse.
  const decline = [
    snap("2026-08-01", "R1", 92), snap("2026-08-08", "R2", 75),
    snap("2026-08-15", "R3", 60), snap("2026-08-22", "R4", 45),
  ];
  const r = oscillation(decline, { bands: BANDS });
  assert.equal(r.bandChanges, 3);
  assert.equal(r.bandsVisited, 4);
});

/* -------------------------------------------------------------------------- */
/* The model version boundary                                                  */
/* -------------------------------------------------------------------------- */

test("snapshots from an older engine are DISCARDED, not compared against", () => {
  // settings.js: modelVersion "identifies the ENGINE, not the college's policy, and two
  // rows scored by different versions are not comparable". A weight change moves every
  // score in the institution on the day it ships; comparing across it would report a
  // model upgrade as the whole college deteriorating on one morning.
  const history = [
    ...daily("2026-07-20", 20, "R1", 92).map((h) => ({ ...h, modelVersion: "PROG-0.9" })),
    ...daily(TODAY, 4, "R4", 45),
  ];
  const r = evaluate({ today: TODAY, history }, CFG);

  assert.equal(r.observedDays, 4, "only the current engine's rows are usable");
  assert.equal(r.bandChanges, 0, "and inside them nothing changed");
  assert.equal(r.codes.includes(HISTORY.RISK_OSCILLATING), false);
});

test("a row with no model version is not assumed to be the current engine", () => {
  const history = [
    ...daily("2026-08-20", 5, "R2", 75).map((h) => ({ ...h, modelVersion: null })),
    ...daily(TODAY, 3, "R4", 45),
  ];
  assert.equal(usableRun(history, {}).length, 3);
});

/* -------------------------------------------------------------------------- */
/* A renamed band                                                              */
/* -------------------------------------------------------------------------- */

test("a history row carrying a band the college has since deleted is skipped, not ranked worst", () => {
  // Treating an unknown key as the worst band would report a RENAME as a college-wide
  // collapse — every student who has ever been scored, all on the same day, for a reason
  // no tutor could find.
  const history = [
    snap("2026-08-01", "OLD_BAND", 60), snap("2026-08-08", "R2", 75),
    snap("2026-08-15", "R2", 75), snap("2026-08-22", "R2", 75),
  ];
  const r = evaluate({ today: TODAY, history }, CFG);
  assert.equal(r.worstBandHeld, "R2", "the unrecognised key must not become the worst");
});

/* -------------------------------------------------------------------------- */
/* Recovery                                                                    */
/* -------------------------------------------------------------------------- */

test("a real recovery is recorded, with the date it was reached", () => {
  // The only evidence in this pipeline about the college's own interventions on THIS
  // student: somebody who has fallen and come back is somebody the college has already
  // helped successfully.
  const history = [
    snap("2026-08-01", "R2", 72), snap("2026-08-08", "R4", 44),
    snap("2026-08-15", "R3", 58), snap("2026-08-22", "R2", 71),
  ];
  const r = recovered(history, { bands: BANDS });

  assert.equal(r.recoveredPoints, 27);
  assert.equal(r.recoveredBy, "2026-08-22");
  assert.equal(r.lowestScore, 44);
  assert.equal(r.lowestOn, "2026-08-08");
});

test("a recovery that was later lost still counts as a recovery", () => {
  // "Latest minus lowest" answers a different question. That this student was once able
  // to come back is the fact worth having, and it survives them falling again.
  const history = [
    snap("2026-08-01", "R4", 40), snap("2026-08-08", "R2", 72),
    snap("2026-08-15", "R4", 41), snap("2026-08-22", "R4", 42),
  ];
  const r = recovered(history, { bands: BANDS });
  assert.equal(r.recoveredPoints, 32);
});

test("drift smaller than the threshold is not a recovery", () => {
  const history = [
    snap("2026-08-01", "R3", 60), snap("2026-08-08", "R3", 57),
    snap("2026-08-15", "R3", 61), snap("2026-08-22", "R3", 62),
  ];
  assert.equal(recovered(history, { bands: BANDS }).recoveredPoints, 0);
});

test("recovery is measured on the SCORE, so a rise inside one band still counts", () => {
  // A band is a coarse bucket. A student who climbed twelve points inside R3 recovered,
  // and the band never moved to show it.
  const history = [
    snap("2026-08-01", "R3", 56), snap("2026-08-08", "R3", 56),
    snap("2026-08-15", "R3", 62), snap("2026-08-22", "R3", 68),
  ];
  assert.equal(recovered(history, { bands: BANDS }).recoveredPoints, 12);
});

/* -------------------------------------------------------------------------- */
/* Dates in, dates out                                                         */
/* -------------------------------------------------------------------------- */

test("no returned figure is a day count", () => {
  // Nothing here runs on a schedule, so "in this band for 34 days" is wrong by the next
  // morning with nothing to correct it. The date it started is true for ever.
  const r = evaluate({ today: TODAY, history: daily(TODAY, 40, "R4") }, CFG);
  // `observedDays` is deliberately exempt and the distinction is worth stating: it is a
  // COUNT OF OBSERVATIONS, not a duration since something. Yesterday's count is still
  // correct today, whereas "in this band for 34 days" is wrong by the next morning. The
  // rule is about figures that decay, not about the word "days".
  for (const k of Object.keys(r)) {
    if (k === "observedDays") continue;
    assert.ok(!/days|until|weeks|ago/i.test(k), `${k} names a duration and would go stale`);
  }
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.currentBandSince));
});

test("an unreadable today produces no dated finding rather than a wrong one", () => {
  const r = evaluate({ today: "yesterday", history: daily(TODAY, 40, "R4") }, CFG);
  assert.equal(r.currentBandSince, null);
  assert.equal(r.codes.includes(HISTORY.CHRONIC_RISK), false);
});

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                              */
/* -------------------------------------------------------------------------- */

test("every code is TRIP_-prefixed and the vocabulary is pinned", () => {
  // The prefix is structural — see the header. Adding a code has to break this test and
  // force the argument about whether it can fire cohort-wide.
  assert.deepEqual([...HISTORY_CODES].sort(), ["TRIP_CHRONIC_RISK", "TRIP_RISK_OSCILLATING"]);
  for (const c of HISTORY_CODES) assert.ok(c.startsWith("TRIP_"), c);
});
