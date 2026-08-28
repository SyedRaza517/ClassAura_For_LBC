// What a student's risk has DONE, as opposed to what it is today.
//
// PURE. No database, no clock, no tenant — the same seam tripwires.js, coverage.js and
// sessions.js keep, and for the same reason: these are the lines a college will be asked
// to defend when a student appeals a decision taken off the back of a risk level.
//
// WHY THIS EXISTS.
//
// StudentPredictionHistory is written on every scoring run and carries a full snapshot.
// The engine reads it for exactly ONE thing — directionOfTravel, a single comparison
// against the nearest score about a month back. Everything else in that table is thrown
// away.
//
// What that loses is the distinction a caseload turns on:
//
//     A student who has been at R4 all year and a student who fell to R4 last week are
//     not the same student.
//
// The first is CHRONIC: something was tried and it did not work, and repeating it is not
// a plan. The second is ACUTE: nobody has tried anything yet, and this week is when it
// would help. Today both render as "High Risk" and sort identically, so the caseload
// cannot tell a tutor which conversation to have.
//
// THE UNIT OF OBSERVATION IS A DAY, NOT A ROW.
//
// runner.js writes a row per scoring RUN, and a run is triggered by any data event —
// markStale() fires on a register being taken, a grade arriving, a review being saved. So
// a single student can carry six snapshots from one afternoon, all with the same band,
// and counting rows would report that afternoon as six times more evidence than a week in
// which nothing happened. Worse, it would make a busy day look like stability.
//
// Snapshots are therefore reduced to one per day — the LAST of that day, because it is
// the most settled view: it has seen every event the earlier ones saw and more.
//
// DATES ARE STRINGS HERE, AND THE CALLER CONVERTS.
//
// calculationDateTime is a DateTime, and slicing ten characters off its ISO string is
// UTC — which vle/isoDate.js documents at length as the bug that dates a 00:30 BST
// submission to the previous day. This module takes `on` already converted to the
// college's own YYYY-MM-DD, exactly as engagementNormalise takes a `toIsoDate`. The
// conversion belongs at the boundary, once, next to the query.
//
// AND DAY COUNTS ARE DERIVED AT RENDER. "In this band for 34 days" is wrong by tomorrow
// morning with nothing to correct it; the date the run STARTED is true for ever.

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

// TRIP_-prefixed, and the prefix is structural rather than decorative. OVR-004 worsens a
// band on redIndicatorCount, which engine.js derives from its OWN internal reds array;
// riskDriverCodes is a copy taken afterwards, so nothing appended here can reach the
// override. A code named RED_something would read as the engine's own and invite a later
// reader to take the count from the copy. See the Tripwires section of CLAUDE.md.
const HISTORY = {
  // At or below the intervention band for an unbroken run. The point is not that the
  // student is at risk — the band already says that, on the same screen, in bigger type.
  // The point is that it has been true for a long time, which means whatever was tried
  // has not worked and the next thing tried should be different.
  CHRONIC_RISK: "TRIP_CHRONIC_RISK",
  // The band keeps changing. A student oscillating R2/R4/R2/R4 is not "moderate on
  // average" — they are unstable, and the average is the one description that fits
  // neither endpoint. Instability is also what makes a single reading untrustworthy, so
  // this doubles as a warning about the number beside it.
  RISK_OSCILLATING: "TRIP_RISK_OSCILLATING",
};

const HISTORY_CODES = Object.values(HISTORY);

/* -------------------------------------------------------------------------- */
/* The constants, and the arguments for them                                   */
/* -------------------------------------------------------------------------- */

const HISTORY_DEFAULTS = {
  // THE FLOOR BELOW WHICH THERE IS NO TRAJECTORY.
  //
  // Distinct DAYS carrying a snapshot, not rows. Three is the smallest number that can
  // describe a shape at all: two points are a line and every line is either up or down,
  // so "oscillating" and "chronic" are both unfalsifiable below three. It also matches
  // the floors this codebase already carries for the narrowest questions —
  // slopeMinMarks 3, absenceStreakSessions 3.
  //
  // A student scored for the first time today has ONE day and gets null for everything,
  // which is the honest answer: they have no history, not a flat one.
  historyMinDays: 3,

  // HOW LONG A RUN HAS TO BE BEFORE IT IS CHRONIC RATHER THAN CURRENT.
  //
  // Days, from the date the run started to today. 28 matches recentAttendanceDays and
  // directionOfTravelDays, so the three windows in this pipeline say the same thing in
  // the same unit rather than contradicting each other on one screen. Shorter and it
  // fires for every student in the fortnight after a bad term starts; longer and the
  // chronic case is only reported once it is too late to change.
  chronicRunDays: 28,

  // HOW MANY BAND CHANGES COUNT AS OSCILLATION.
  //
  // Three, over the observed history. Two changes is a fall and a recovery, which is the
  // most ordinary shape a student's year has and is emphatically not instability — a
  // student who dipped at Christmas and came back is a success story, and reporting them
  // as unstable would put the college's own best outcome on a caseload. Three or more
  // means the band has not settled.
  oscillationLimit: 3,

  // A recovery has to be big enough to be a recovery rather than rounding. Ten points
  // matches attendanceSlopeDrop and cohortOutlierGap, which are the two other
  // "is this movement real" thresholds here.
  recoveryPoints: 10,
};

/* -------------------------------------------------------------------------- */
/* The band ladder                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The configured bands, best -> worst, as an array of keys.
 *
 * DERIVED FROM `min`, NEVER FROM ARRAY ORDER AND NEVER FROM THE KEY STRING.
 *
 * settings.js lets a college replace the ladder entirely: five bands is the platform
 * default, not a guarantee, and the keys are only R1..R5 until somebody renames them.
 * Three tempting shortcuts are all wrong:
 *
 *   * Array order — validate() sorts on the way in, but a hand-edited config column or a
 *     future caller need not, and "which band is worse" would then depend on how somebody
 *     dragged a row.
 *   * The key string — "R10" sorts before "R2" lexically, and a college using "AMBER" and
 *     "RED" has no ordering in its keys at all.
 *   * A hardcoded count — a college with four bands would silently lose one.
 *
 * `min` is the only thing that actually orders them, because it is what bandForScore
 * matches on. Highest min = best band = index 0.
 */
function bandLadder(bands) {
  return (bands || [])
    .filter((b) => b && typeof b.key === "string" && typeof b.min === "number")
    .slice()
    .sort((a, b) => b.min - a.min)
    .map((b) => b.key);
}

/** Where a band sits, 0 = best. -1 for a key the ladder does not contain — which happens
 *  for real: a history row written before a college renamed its bands keeps the old key,
 *  and treating an unknown key as "worst" would report a rename as a college-wide
 *  collapse. Unknown is excluded, never guessed. */
const rankOf = (ladder, key) => ladder.indexOf(key);

/* -------------------------------------------------------------------------- */
/* Reducing the history to something a shape can be read from                  */
/* -------------------------------------------------------------------------- */

/**
 * One snapshot per day, oldest first, within a single model version.
 *
 * TWO REDUCTIONS, AND THE SECOND IS THE ONE THAT IS EASY TO MISS.
 *
 * (1) One row per day, taking the LAST of that day — see the header.
 *
 * (2) ONLY THE MOST RECENT CONTIGUOUS RUN OF ONE modelVersion. settings.js is explicit
 *     that modelVersion "identifies the ENGINE, not the college's policy, and two rows
 *     scored by different versions are not comparable". A weight change or a new
 *     component moves every score in the institution on the day it ships, and comparing
 *     across that boundary would report a model upgrade as every student in the college
 *     deteriorating at once — on the same morning, with no cause a tutor could find.
 *
 *     Discarding the older rows rather than trying to bridge them is deliberate: there is
 *     no honest conversion between two engines' scores, and inventing one would put a
 *     fabricated number into a record an appeal turns on. The cost is that a trajectory
 *     restarts at a model upgrade, which is correct — it genuinely is a new measurement.
 */
function usableRun(history, opts) {
  const rows = (history || []).filter((h) => h && typeof h.on === "string" && h.on);

  // ONE PER DAY, KEEPING THE LAST — and "last" can only come from INPUT ORDER.
  //
  // `on` is a date, so two snapshots from the same afternoon are indistinguishable by it:
  // no comparison on `on` can order them, and a sort keyed on it leaves them wherever
  // they already were. The information about which came later exists only in
  // calculationDateTime, which the caller ordered by and this module deliberately does
  // not receive (it is a DateTime, and turning it into a date here would put the timezone
  // conversion in the wrong place -- see the header).
  //
  // So the contract is explicit: THE CALLER PASSES SNAPSHOTS OLDEST FIRST. Array.sort is
  // stable, so sorting by `on` ascending preserves that order within a day, and the last
  // write per day wins.
  //
  // An earlier version sorted DESCENDING and took the first seen per day, which reads as
  // the same thing and is not: with equal keys the sort is a no-op, so it kept the
  // MORNING snapshot -- the least settled view of the day, the one that had seen fewest
  // events. A test caught it.
  const sorted = rows.slice().sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0));
  const byDay = new Map();
  for (const r of sorted) byDay.set(r.on, r);     // later writes overwrite earlier ones

  const days = [...byDay.values()].reverse();   // latest-first, for the version walk
  if (!days.length) return [];

  // The newest row's version is the one in force. Walk back only while it holds.
  const version = days[0].modelVersion;
  const run = [];
  for (const d of days) {
    // A null version on either side is NOT a match. It means the row predates the stamp
    // or lost it, and "we do not know which engine produced this" cannot be treated as
    // "the same engine as today".
    if (!d.modelVersion || !version || d.modelVersion !== version) break;
    run.push(d);
  }

  return run.reverse();               // oldest first, which is how a shape reads
}

/* -------------------------------------------------------------------------- */
/* How long they have been where they are                                      */
/* -------------------------------------------------------------------------- */

/**
 * The current band, when the run of it started, and the worst unbroken stretch.
 *
 * @returns {{currentBand, currentBandSince, currentRunDays, worstBandHeld,
 *            worstBandSince, observedDays}} all null where there is no trajectory.
 *
 * currentRunDays is returned for the CALLER'S threshold test only and is deliberately not
 * a stored column — the date is what gets stored, because a day count is wrong by the
 * next morning and nothing in this feature runs on a schedule to correct it.
 */
function bandRuns(history, today, config) {
  const cfg = { ...HISTORY_DEFAULTS, ...(config || {}) };
  const ladder = bandLadder(cfg.bands);
  const run = usableRun(history, cfg);

  const empty = {
    currentBand: null, currentBandSince: null, currentRunDays: null,
    worstBandHeld: null, worstBandSince: null, observedDays: run.length || null,
  };
  // Below the floor there is no shape. Note observedDays still comes back: how much
  // history exists is measurable from one row, and it is what explains the nulls beside
  // it rather than leaving a reader to guess the feature is broken.
  if (run.length < cfg.historyMinDays) return empty;
  if (!isDate(today)) return empty;

  const latest = run[run.length - 1];
  const currentBand = latest.riskLevel || null;
  if (!currentBand || rankOf(ladder, currentBand) === -1) return empty;

  // Walk back while the band is unchanged. The run STARTED on the first day it held, not
  // on the day before it — a student first seen at R4 on the 3rd has been R4 since the
  // 3rd, and dating it to the 2nd claims an observation nobody made.
  let since = latest.on;
  for (let i = run.length - 1; i >= 0; i -= 1) {
    if (run[i].riskLevel !== currentBand) break;
    since = run[i].on;
  }

  // The worst band ever held in this run, and when it was first reached. Unknown keys are
  // skipped rather than ranked — see rankOf.
  let worstBandHeld = null, worstRank = -1, worstBandSince = null;
  for (const r of run) {
    const rank = rankOf(ladder, r.riskLevel);
    if (rank === -1) continue;
    if (rank > worstRank) { worstRank = rank; worstBandHeld = r.riskLevel; worstBandSince = r.on; }
  }

  return {
    currentBand,
    currentBandSince: since,
    currentRunDays: daysBetween(since, today),
    worstBandHeld,
    worstBandSince,
    observedDays: run.length,
  };
}

/* -------------------------------------------------------------------------- */
/* How settled it is                                                           */
/* -------------------------------------------------------------------------- */

/**
 * How many times the band CHANGED across the usable history.
 *
 * Changes, not distinct bands. A student who went R2 → R3 → R2 visited two bands and
 * changed twice, and it is the changing that says the score has not settled. Counting
 * distinct bands would rate a slow steady decline through four bands as more unstable
 * than a student flipping between two every week, which is backwards.
 *
 * Null below the floor — "we have not watched long enough to say" is not "never
 * changed", and 0 would claim the second.
 */
function oscillation(history, config) {
  const cfg = { ...HISTORY_DEFAULTS, ...(config || {}) };
  const ladder = bandLadder(cfg.bands);
  const run = usableRun(history, cfg).filter((r) => rankOf(ladder, r.riskLevel) !== -1);

  if (run.length < cfg.historyMinDays) return { bandChanges: null, bandsVisited: null };

  let changes = 0;
  const seen = new Set();
  for (let i = 0; i < run.length; i += 1) {
    seen.add(run[i].riskLevel);
    if (i > 0 && run[i].riskLevel !== run[i - 1].riskLevel) changes += 1;
  }
  return { bandChanges: changes, bandsVisited: seen.size };
}

/* -------------------------------------------------------------------------- */
/* Whether they have ever come back                                            */
/* -------------------------------------------------------------------------- */

/**
 * Has the score ever recovered meaningfully after falling?
 *
 * WHY THIS IS WORTH STORING. It is the only thing in this pipeline that is evidence
 * ABOUT THE COLLEGE'S OWN INTERVENTIONS on this particular student: somebody who has
 * fallen and come back once is somebody the college has already helped successfully, and
 * that is the strongest argument available for trying the same thing again rather than
 * escalating. Nothing else here can say that.
 *
 * Measured on the SCORE, not the band, because a band is a coarse bucket: a student who
 * climbed twelve points inside R3 recovered, and the band never moved to show it.
 *
 * @returns {{recoveredPoints, recoveredBy, lowestScore, lowestOn}}
 */
function recovered(history, config) {
  const cfg = { ...HISTORY_DEFAULTS, ...(config || {}) };
  const run = usableRun(history, cfg).filter((r) => isNum(r.progressionScore));

  const empty = { recoveredPoints: null, recoveredBy: null, lowestScore: null, lowestOn: null };
  if (run.length < cfg.historyMinDays) return empty;

  // The largest rise from any trough to any LATER point. Not simply
  // "latest minus lowest": that answers a different question, because the recovery may
  // have happened and then been lost again, and the fact that they were once able to
  // recover is what this figure is for.
  let lowest = run[0].progressionScore, lowestOn = run[0].on;
  let bestRise = 0, bestRiseOn = null;
  let trough = run[0].progressionScore;
  for (const r of run) {
    if (r.progressionScore < trough) trough = r.progressionScore;
    if (r.progressionScore < lowest) { lowest = r.progressionScore; lowestOn = r.on; }
    const rise = r.progressionScore - trough;
    if (rise > bestRise) { bestRise = rise; bestRiseOn = r.on; }
  }

  const real = bestRise >= cfg.recoveryPoints;
  return {
    // Rounded to one decimal like every other score figure here, so two views of the same
    // student cannot disagree in the last digit.
    recoveredPoints: real ? Math.round(bestRise * 10) / 10 : 0,
    recoveredBy: real ? bestRiseOn : null,
    lowestScore: Math.round(lowest * 10) / 10,
    lowestOn,
  };
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Whole days between two YYYY-MM-DD strings. Null rather than 0 for an unreadable pair:
 *  zero would say "these are the same day", which is a measurement, and we have none. */
function daysBetween(from, to) {
  if (!isDate(from) || !isDate(to)) return null;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

/* -------------------------------------------------------------------------- */
/* The evaluation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} raw
 *   today   {string} YYYY-MM-DD, passed in rather than read from a clock
 *   history {Array<{on, riskLevel, progressionScore, modelVersion}>} every snapshot for
 *           this student, any order. `on` must ALREADY be the college's own date — see
 *           the header for why slicing the ISO string is wrong.
 * @param {object} config a complete config from settings.get(); `bands` is required for
 *        the ladder, and the tunables fall back to HISTORY_DEFAULTS.
 * @returns figures plus `codes`.
 */
function evaluate(raw, config) {
  const cfg = { ...HISTORY_DEFAULTS, ...(config || {}) };
  const r = raw || {};
  const codes = [];

  const runs = bandRuns(r.history, r.today, cfg);
  const osc = oscillation(r.history, cfg);
  const rec = recovered(r.history, cfg);

  const ladder = bandLadder(cfg.bands);
  // Which band counts as "needing an intervention" is the college's own setting, not a
  // position in the ladder — interventionBand names a key, and settings.js refuses to
  // save one that does not exist precisely so this lookup cannot silently miss.
  const interventionRank = rankOf(ladder, cfg.interventionBand);
  const currentRank = rankOf(ladder, runs.currentBand);

  /* --- chronic, as opposed to merely current ------------------------------ */

  // isNum on the day count rather than a truthiness test: null means the run could not be
  // dated, and `null >= 28` is false only by luck. Written out so a later reader cannot
  // replace it with a `|| 0`, which would compare a number nobody measured.
  if (interventionRank !== -1 && currentRank !== -1
      && currentRank >= interventionRank
      && isNum(runs.currentRunDays)
      && runs.currentRunDays >= cfg.chronicRunDays) {
    codes.push(HISTORY.CHRONIC_RISK);
  }

  /* --- unsettled ---------------------------------------------------------- */

  if (isNum(osc.bandChanges) && osc.bandChanges >= cfg.oscillationLimit) {
    codes.push(HISTORY.RISK_OSCILLATING);
  }

  return {
    currentBandSince: runs.currentBandSince,
    worstBandHeld: runs.worstBandHeld,
    worstBandSince: runs.worstBandSince,
    observedDays: runs.observedDays,
    bandChanges: osc.bandChanges,
    bandsVisited: osc.bandsVisited,
    recoveredPoints: rec.recoveredPoints,
    recoveredBy: rec.recoveredBy,
    lowestScore: rec.lowestScore,
    lowestOn: rec.lowestOn,
    codes,
  };
}

module.exports = {
  evaluate, bandRuns, oscillation, recovered, usableRun, bandLadder,
  HISTORY, HISTORY_CODES, HISTORY_DEFAULTS,
};
