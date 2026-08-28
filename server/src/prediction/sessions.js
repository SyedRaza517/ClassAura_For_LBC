// Sessions: what SHAPE does this student's absence take, beyond how much of it there is?
//
// PURE. No database, no clock, no tenant. Everything arrives as arguments, today's date
// included — the same seam as tripwires.js, coverage.js, workload.js and engine.js, and
// for the same reason: these are lines a college will be asked to defend at an appeal,
// so they have to be checkable without standing up an institution's worth of fixtures.
//
// THE INPUT SHAPE, AND THE ONE FIELD THAT IS NOT THERE YET.
//
// metrics.js already flattens every AttendanceMark to
//
//     { status, sessionId, date, startTime, unitId }
//
// and this module assumes exactly that shape. It also reads ONE field metrics.js does
// NOT currently carry:
//
//     kind        HndSession.kind — "Teaching", "Seminar", … defaulting to ""
//
// `endTime` is likewise not carried, and nothing here needs it: session LENGTH is a
// different question (an hour missed is not the same as six), and answering it from
// startTime/endTime would need a duration model this layer has no business inventing.
// Until `kind` is added to the select in metrics.js, kindShape() returns nulls for every
// student at every college — which is the correct reading of "we cannot see it", not a
// bug, and the institution probe below is what makes that state legible rather than
// silent.
//
// WHY THIS LAYER EXISTS AT ALL, AND WHAT IT DELIBERATELY DOES NOT RE-REPORT.
//
// A percentage answers HOW MUCH teaching a student has had. Six figures already answer
// adjacent questions about it, and this module is written around them rather than over
// them — trap five, stated up front so a later reader does not add a seventh count of
// the same thing:
//
//   * `absenceStreak` (tripwires.attendanceShape) counts the trailing run of consecutive
//     ABSENT MARKS, and E breaks it. It is a count of rows. A week in which no session
//     was timetabled produces no rows, so it neither extends nor breaks the run — the
//     streak simply cannot see weeks at all. consecutiveWeeks() below is the different
//     question: how many WEEKS the register ran in and recorded no attendance. See its
//     own header for the four ways the two answers diverge.
//   * `attendanceSlope` compares two equal windows and says whether the volume is
//     falling. It says nothing about where within a week the absence sits.
//   * `attendanceRegularity` is a standard deviation of WEEKLY PERCENTAGES. It says the
//     week-to-week volume is erratic; it cannot say that every one of the gaps is a
//     Friday, because a weekly percentage has already thrown the weekday away.
//   * `firstSessionAbsenceRate` / `laterSessionAbsenceRate` split a DAY into its first
//     register and the rest — "can they get here in the morning". That is the WITHIN-day
//     shape. This module is the within-WEEK shape, and the two are orthogonal: a student
//     who misses every Friday morning appears in both, and one who misses whole Fridays
//     appears only here.
//   * `unitAttendanceSpread` splits attendance by UNIT. A weekday and a unit are only
//     the same slice at a college that teaches one unit per day, and where they are the
//     same the two figures agree rather than disagreeing — which is why this returns the
//     weekday alongside the rate, so a reader can see when they coincide.
//   * `registerCoverage` (coverage.js) is about whether the register was TAKEN. Nothing
//     here re-derives it, and every function below reads only marks that exist.
//
// WHY THERE IS ONLY ONE CODE HERE, AND WHY THE TWO OBVIOUS ONES ARE FIGURES.
//
// This is the whole design of the file and it is deliberate, not an omission.
//
// "This student misses every Friday" is a compelling sentence and it must not be a
// caseload entry, because one student's own marks cannot distinguish it from "nobody
// attends the Friday nine o'clock". CLAUDE.md is explicit — "A signal that fires for a
// whole cohort at once is a FIGURE, not a code" — and names this exact case: a college
// that timetables nothing on Fridays, or a cohort that all misses the same week. A
// weekday code would fire identically for a student avoiding a lecturer and for an
// entire unit whose last session of the week is unloved, and a hundred rows carrying an
// identical reason is the same as no caseload.
//
// The evidence that would separate the two is the REST OF THE COHORT's Friday, and it
// does not live in this module — it lives in cohort.js, which is built once per run from
// StudentPredictionCurrent. Until somebody threads a per-weekday cohort baseline through
// there, the honest output is a figure a human reads next to the timetable. So
// dayOfWeekShape() and kindShape() return numbers and raise nothing, exactly as
// coverage.js refuses to add a "coverage unknown" code and metrics.js refuses to raise
// one on `assessmentsDueSoon`.
//
// The one code, TRIP_WEEKS_UNSEEN, survives that test because a cohort-wide holiday
// produces NO MARKS and is therefore invisible to it (see consecutiveWeeks), while a run
// of weeks in which the register ran and recorded nothing is a fact about this student
// that the rest of the cohort does not share by construction.
//
// WHY THE CODE IS NAMESPACED `TRIP_`.
//
// It is appended to `riskDriverCodes`, the same array engine.js builds from its six RED
// indicators. `redIndicatorCount` — the input to OVR-004, which can worsen a band — is
// derived by engine.js from its own internal `reds` array, and `riskDriverCodes` is a
// copy taken afterwards, so appending here provably cannot reach the override. The
// prefix is what keeps that visible: a code named `RED_`-anything would read as the
// engine's own, and the next person to take a count off the copy rather than off
// engine.js's `reds` would silently wire the shape of a timetable into a student's band.
// Keep the prefix; keep the count off the copy.
const { isStatus } = require("../attendance");

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

// Stored in StudentPredictionCurrent.riskDriverCodes and in every history row, so these
// strings outlive several rewrites of the screen. Structured codes, never display text —
// the client maps them to wording, and rewording must not orphan a stored row.
const SESSIONS = {
  // Consecutive weeks in which the register RAN for this student and recorded no
  // attendance at all. Named for the weeks rather than for the student: "TRIP_ABSENT_"
  // anything would read as a judgement, and an excused fortnight counts here (see
  // consecutiveWeeks) precisely because the finding is "they have not been in a room",
  // not "they are in trouble".
  WEEKS_UNSEEN: "TRIP_WEEKS_UNSEEN",
};

const SESSIONS_CODES = Object.values(SESSIONS);

// Turning up. Identical to tripwires.ATTENDED and duplicated rather than imported for
// the reason workload.js duplicates shiftDays: this file has no other reason to depend
// on tripwires.js, and a shared constants module would be a change to four files for one
// line. L is late but present — the student was in the room, and a shape built on
// treating a late arrival as a disappearance would find patterns in the traffic.
const ATTENDED = new Set(["P", "L"]);

const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const round1 = (n) => Math.round(n * 10) / 10;

/** A YYYY-MM-DD string this module is prepared to treat as a date. The regex is not
 *  decoration: `Date.parse` accepts "2026-8-4" and a dozen other shapes, and this module
 *  compares dates as strings, where "2026-8-4" sorts BEFORE "2026-10-01" and after
 *  "2026-07-31" — a silently wrong ordering rather than a loud failure. */
const isDate = (s) =>
  typeof s === "string"
  && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && Number.isFinite(Date.parse(`${s}T00:00:00Z`));

/**
 * Whole days between two YYYY-MM-DD dates, `to` minus `from`, or NULL if either cannot
 * be parsed.
 *
 * coverage.daysBetween's contract rather than tripwires.daysBetween's, and the choice
 * matters: tripwires returns 0 for an unparseable date, which is the right shrug there
 * because it makes a code fail to fire. Here 0 would mean "marked today", which is the
 * strongest possible statement of freshness about a register nobody can date, and it
 * would be produced by a malformed string rather than by evidence.
 */
function daysBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

// Platform defaults, in the shape settings.js uses: defaults in code, overridden by
// whatever the caller merges over them. Deliberately NOT added to settings.js here —
// wiring is a separate change, and a config key that nothing reads is worse than no key
// at all. Every function takes an `opts`/`config` spread OVER these, so the day they
// move into DEFAULTS the callers do not change.
//
// EVERY RATE IN THIS FILE CARRIES A MINIMUM DENOMINATOR, and each of the six below is
// argued against the floors settings.js already carries — slopeMinMarks 3 (one rolling
// window), disperseMinMarks 4 (one unit), minMarksForRate 6 (the whole register) —
// rather than picked for looking round.
const SESSIONS_DEFAULTS = {
  // THE FEWEST MARKS ON ONE WEEKDAY BEFORE ITS ABSENCE RATE MAY BE NAMED.
  //
  // Four, which is disperseMinMarks exactly, because it is the same shape of question:
  // a weekday is a SLICE of the register being compared against other slices, precisely
  // as a unit is. The argument settings.js gives there transfers word for word — "a unit
  // holding one register reads 0% or 100%, and left in the comparison it is always the
  // worst unit" — and a weekday is worse, because there are up to seven of them and the
  // maximum of seven noisy numbers is noisier than the maximum of three.
  //
  // NOT minMarksForRate (6). Six is the floor for the OVERALL figure, which spans every
  // unit in scope; applying it to a single weekday would silence this for any cohort
  // taught two days a week until well into a second term, which is exactly the part-time
  // and evening provision where a missed day is hardest to make up. Four is four
  // teaching weeks of one weekly slot: enough that one absence reads 25% rather than
  // 33% or 50%.
  weekdayMinMarks: 4,

  // THE FEWEST MARKS ON THE OTHER SIDE OF THE COMPARISON.
  //
  // Six — minMarksForRate — because the other side is the whole register minus one day,
  // which is the figure minMarksForRate was chosen for. A gap is two numbers, and a
  // floor on only the interesting one is the classic half-guard: "80% absent on Fridays
  // against 0% on the two Mondays we looked at" is a 80-point gap drawn from two rows.
  weekdayMinOtherMarks: 6,

  // HOW MANY WEEKDAYS MUST CLEAR THE FLOOR BEFORE ONE IS CALLED THE WORST.
  //
  // Two, mirroring unitDispersion's `usable.length < 2`. "The worst weekday" is a
  // superlative, and a superlative over one candidate is not a comparison — it is a
  // restatement of that day's rate wearing a comparative's clothes, and it would read on
  // the screen as though six other days had been ruled out.
  minWeekdaysMeasured: 2,

  // The same three floors again, for session kind. Identical values on purpose: the
  // question has the same shape (a slice of the register against the rest of it), and
  // inventing a second opinion for it would leave two numbers to drift apart with no
  // reason ever recorded for why they differed.
  kindMinMarks: 4,
  kindMinOtherMarks: 6,
  minKindsMeasured: 2,

  // HOW MANY CONSECUTIVE OBSERVED WEEKS WITH NO ATTENDANCE COUNT AS A DISAPPEARANCE.
  //
  // Two. One week in which a student attended nothing is a bad week — a virus, a funeral,
  // a train strike, a childcare arrangement that fell through — and firing on it would
  // put a large slice of any cohort on the caseload in any given week, which CLAUDE.md
  // is blunt is the same as no caseload.
  //
  // Two is also deliberately commensurable with notSeenDays (14) rather than
  // independently invented, and the pair is the point: NOT_SEEN answers "has this person
  // been in" from the CALENDAR and therefore fires across a whole college every summer,
  // because it cannot tell a holiday from a disappearance. This answers the same question
  // from the REGISTER, and cannot fire on a holiday at all because a week nobody
  // timetabled produces no marks. Two signals, same horizon, opposite failure modes.
  zeroWeekLimit: 2,

  // THE FEWEST MARKS THE RUN AS A WHOLE MUST REST ON.
  //
  // Three — absenceStreakSessions and slopeMinMarks — and it is a floor on the RUN
  // rather than on each week for a reason that only shows up at real colleges. A week
  // floor of two would make this structurally unable to fire at a provider teaching one
  // session a week, however long the student had been gone; a week floor of one would let
  // two single-register weeks raise the loudest code on the screen from two rows. A floor
  // on the total lets the two shapes trade off honestly: four sessions a week fires at
  // two weeks, one session a week fires at three.
  zeroWeekMinMarks: 3,

  // HOW STALE THE REGISTER MAY BE BEFORE A RUN STOPS BEING "CURRENT".
  //
  // Twenty-one days, which is coverage.staleRegisterDays, and the handover between the
  // two is the reason for the number. Weeks with no marks are transparent to the run (see
  // consecutiveWeeks), which is what lets a run survive a reading week — and, unguarded,
  // is also what would keep a run lit through the summer for a student who vanished in
  // May, with no event able to clear it.
  //
  // So the run must be anchored to a register somebody has opened recently. Past three
  // weeks of silence the finding is no longer "this student is not coming in", it is
  // "nobody has marked this student", and that is coverage.js's TRIP_REGISTER_STALE — a
  // finding about the college, raised by the module that can see the timetable. Handing
  // over at the same number is what stops one event producing two rows with two different
  // owners.
  runRecencyDays: 21,
};

/* -------------------------------------------------------------------------- */
/* Weekday arithmetic — no clock, no timezone, no Date                         */
/* -------------------------------------------------------------------------- */

/**
 * The ISO-8601 weekday of a YYYY-MM-DD string: 1 = Monday … 7 = Sunday. Null for
 * anything this module will not treat as a date.
 *
 * WHY THIS IS INTEGER ARITHMETIC AND NOT `new Date(...).getUTCDay()`.
 *
 * The Date idiom is CORRECT, and it is worth writing down exactly why before explaining
 * why it is still not what this file uses. `new Date("2026-08-28")` parses as UTC
 * midnight: ES2015 onwards specifies the date-only forms of the ISO grammar as UTC,
 * while date-TIME forms with no offset are local — the asymmetry that is the single most
 * misremembered thing about JavaScript dates, and the reason every date helper in this
 * codebase appends `T00:00:00Z` rather than trusting it. Read back with `getUTCDay()`,
 * the answer is the weekday of that calendar date, and it is right because the mapping
 * from a civil date to a weekday is pure arithmetic — days since the epoch, modulo seven
 * — with no zone in it at all.
 *
 * The trouble is that the correctness lives in a PAIRING, not in either half. Parse as Z
 * and read with `getUTCDay()`: right. Parse as Z and read with `getDay()`: wrong, and
 * wrong invisibly — a host in London or on a UTC CI runner returns the same answer, so
 * the mistake ships green and only misreports for a deployment west of Greenwich, where
 * UTC midnight is the previous evening and every date slides back one weekday. That is
 * the D8 failure in STATUS.md wearing a different hat: something read a local clock and
 * the bug was a timezone wide.
 *
 * `src/clock.js` pins APP_TIMEZONE precisely because the host clock is not the college's
 * day, and a YYYY-MM-DD here is already a date in the college's own zone — resolved once,
 * by the caller, on the way in. Converting it to an instant and back is a round trip
 * through a representation that has a zone, in order to answer a question that does not.
 * So this does the arithmetic directly and the class of bug is removed rather than
 * guarded: there is no Date object, no `getDay`, and nothing for a later reader to
 * quietly change one half of.
 *
 * The algorithm is Howard Hinnant's days_from_civil, exact for any proleptic Gregorian
 * date, and 1970-01-01 was a Thursday — which is where the +3 comes from and which the
 * tests pin against a table of known weekdays including both British clock-change
 * weekends, where a zone-sensitive implementation would disagree.
 */
function weekdayOf(iso) {
  if (!isDate(iso)) return null;

  const y0 = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));

  // Rejecting the out-of-range pieces `isDate` cannot see. Date.parse already refuses a
  // 13th month and a 31st of February, so this is belt and braces for a caller that
  // hands over a string from somewhere else entirely — and it is cheaper than reasoning
  // about what days_from_civil does with month 0.
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;

  // March-based year: the leap day moves to the end, so no branch inside the loop-free
  // arithmetic below has to know about it.
  const y = y0 - (m <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;                                  // [0, 399]
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  const days = era * 146097 + doe - 719468;                   // days since 1970-01-01

  // 1970-01-01 was a Thursday = ISO 4, so day 0 must land on 4: (0 + 3) % 7 + 1 = 4.
  // The double modulo keeps pre-1970 dates positive; they cannot occur in an academic
  // register, and a negative weekday index would be a silent array miss rather than an
  // error, which is exactly the kind of thing that survives review.
  return (((days + 3) % 7) + 7) % 7 + 1;
}

/** The Monday of the week containing a YYYY-MM-DD date, as a YYYY-MM-DD string.
 *
 *  The bucket key for every weekly question in this file, and it is a DATE rather than a
 *  week NUMBER on purpose: ISO week numbers wrap at the year boundary, so week 1 of 2027
 *  sorts before week 52 of 2026 under every string and numeric comparison, and a run
 *  spanning Christmas would break in a way nobody would find until January.
 *
 *  This one does use a Date, and safely, because it is doing date ARITHMETIC rather than
 *  asking a calendrical question: parse at an explicit UTC midnight, shift by whole days
 *  with setUTCDate, format back with toISOString. Every step is UTC and the same idiom
 *  tripwires.shiftDays and workload.shiftDays already use. The weekday it shifts by comes
 *  from weekdayOf above, so the zone-sensitive `getDay()` never appears. */
function weekStartOf(iso) {
  const weekday = weekdayOf(iso);
  if (weekday === null) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (weekday - 1));
  return d.toISOString().slice(0, 10);
}

/* -------------------------------------------------------------------------- */
/* The institution probe                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Refuse to answer a session-kind question without an institution-wide answer to "does
 * this college record what KIND of session a register is, at all?"
 *
 * WHY THIS THROWS INSTEAD OF DEFAULTING TO SILENCE, AND WHY IT IS POSITIONAL.
 *
 * `HndSession.kind` is `@default("")`. Registers created in Staff Hub before the column
 * meant anything carry "", every register the Moodle importer creates carries "" because
 * nothing maps a Moodle session type onto it, and a college that simply does not use the
 * field carries "" on every row it will ever write. So at most colleges every mark this
 * module sees belongs to one nameless bucket.
 *
 * Read from the chunk, that is invisible. CLAUDE.md records this as the most repeated bug
 * in this area, got wrong three times: gather() runs on chunks of 200 and the ordinary
 * incremental path scores the handful of students markStale flagged — often exactly one.
 * One student whose sessions all carry "" is entirely ordinary at a college that uses
 * kinds properly on other units; a college where every row is "" is a college with no
 * such field. The two are the same array at chunk size.
 *
 * And the failure is not merely a missing signal. Treat "" as a kind and every mark falls
 * in a single bucket that is 100% of the register, which either reads as a perfectly
 * concentrated "kind" finding for the entire institution at once, or — after somebody
 * "fixes" that by filtering the empty bucket out — as a clean sheet for every student
 * alive. Manufactured alarm and manufactured reassurance from the same missing boolean.
 *
 * The existing guards in tripwires.js take a boolean that defaults to falsy and fall
 * silent when it is missing. That is right for them: a missing flag there costs one code
 * that does not fire. Here it would cost the whole kind dimension permanently and
 * silently — every figure null for every student at every college, no test failing, no
 * row looking wrong. A feature that quietly does nothing is not discoverable by reading
 * the output.
 *
 * So this fails the way db.js fails a query with no tenant context, and the way
 * coverage.js and workload.js fail a missing probe: loudly, at the first call, in the
 * caller's own test run. A TypeError at wiring time is recoverable; three years of blank
 * columns nobody questioned is not.
 *
 * It is a POSITIONAL parameter rather than a key on `opts` for the same reason
 * coverage.registerCoverage and workload.carriedBacklog take theirs positionally: an
 * options bag is the thing a caller assembles from a config object and forgets to add to,
 * and `kindShape(marks, opts)` would still be a legal-looking call.
 *
 * WHAT THE PROBE MUST ACTUALLY COUNT, because the obvious query is wrong:
 *
 *     count(HndSession where kind not "") > 0     — institution-wide, unfiltered by
 *                                                   student, hoisted out of the chunk loop
 *
 * NOT `count(HndSession) > 0`, which is true at every college that ever timetabled
 * anything and answers a different question — the same mistake the timetable probe in
 * coverage.js exists to warn about.
 *
 * @param {{kindRecorded:boolean}} institution
 */
function assertInstitutionProbe(institution, fnName) {
  if (!institution || typeof institution.kindRecorded !== "boolean") {
    throw new TypeError(
      `${fnName}: institution.kindRecorded must be a boolean — an institution-wide probe `
      + "result, decided once per run and never derived from one student's rows",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* The shared slice comparison                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The engine behind both dayOfWeekShape() and kindShape(): given marks already labelled
 * with a slice key, which slice does the absence concentrate in, and how far is it from
 * the rest of the student's register?
 *
 * ABSENCE HERE MEANS "NOT IN THE ROOM" — A OR E — AND THAT IS A DELIBERATE CHOICE.
 *
 * The question this module asks is about the SHAPE of the gap in somebody's week, and an
 * excused Friday is still a Friday they were not taught. A student with a standing
 * Wednesday hospital appointment shows up here, and that is the point: it is a timetable
 * conversation, and it is a conversation the college can actually have. Whether the
 * absence was explained is a different question that is already answered, once, by
 * `unexplainedShare` — re-deriving it per slice would need its own denominators and would
 * put four thin percentages on the row where one solid one already sits.
 *
 * A ROW WITH AN UNRECOGNISED STATUS IS NOT AN OBSERVATION. `isStatus` is the same filter
 * attendance.summarise() applies before counting anything, so the two sides of any
 * comparison a caller makes stay in step.
 *
 * A MARK WITH NO SLICE KEY LEAVES BOTH SIDES and is counted rather than dropped, exactly
 * as workload.deadlineClusters counts undated assessments. It is not evidence about any
 * slice and it is not evidence that any slice is clean; the count is returned so the
 * caller can see how much of the register was invisible.
 *
 * THE COMPARISON IS WORST-AGAINST-THE-POOLED-REST, not worst-against-best, and this is
 * the one place this file deliberately diverges from unitDispersion(). Two reasons. The
 * denominator: "the rest of the week" is every other mark the student has, which is a far
 * steadier number than one other weekday chosen for being the best — and the best of six
 * noisy rates is as noisy as the worst. The sentence: "she is at 20% on Fridays and 90%
 * the rest of the week" is what a tutor says, while "her best day is Tuesday" is not a
 * finding about Friday at all.
 *
 * THE POOLED SIDE INCLUDES SLICES TOO THIN TO BE NAMED. A weekday holding two marks
 * cannot be called the worst — that is what minMarks is for — but those two marks are
 * still two honest observations of what this student does when it is not a Friday.
 * Excluding them would shrink the only denominator in the comparison that is meant to be
 * large.
 *
 * THE GAP IS NOT CLAMPED AT ZERO. The worst NAMEABLE slice can sit below the pooled rest,
 * because the pool contains slices that were too thin to name and one of them may be
 * worse. A negative gap is the honest reading — "the day we can measure is not the
 * problem" — and clamping it to 0 would manufacture a tie between that and a student
 * whose week is genuinely flat. coverage.staleness leaves a negative day count alone for
 * the same reason.
 *
 * @param {Array<{key:string|number|null, absent:boolean}>} labelled
 * @param {{minMarks, minOtherMarks, minMeasured}} floors
 * @returns {{slices:Array, worst, worstRate, gap, measured, seen, unkeyed}}
 */
function sliceShape(labelled, floors) {
  const buckets = new Map();
  let unkeyed = 0;
  let totalMarked = 0;
  let totalAbsent = 0;

  for (const row of labelled || []) {
    if (!row) continue;
    if (row.key === null || row.key === undefined || row.key === "") { unkeyed += 1; continue; }
    const b = buckets.get(row.key) || { key: row.key, marked: 0, absent: 0 };
    b.marked += 1;
    if (row.absent) b.absent += 1;
    buckets.set(row.key, b);
    totalMarked += 1;
    if (row.absent) totalAbsent += 1;
  }

  const empty = {
    slices: [],
    worst: null,
    worstRate: null,
    gap: null,
    measured: 0,
    seen: buckets.size,
    unkeyed,
  };

  if (!buckets.size) return empty;

  // Sorted by key so the output is deterministic — a figure that changed between two runs
  // with nothing about the student having changed makes the whole row untrustworthy, and
  // Map iteration order is insertion order, which is the order Postgres happened to
  // return the marks in.
  const slices = [...buckets.values()]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((b) => ({
      key: b.key,
      marked: b.marked,
      absent: b.absent,
      // The rate on a slice is always computable — this is the slice's OWN denominator,
      // which is at least 1 by construction. Whether it may be REPORTED is the floor's
      // question, below, and the two are kept separate so a test can see a thin slice's
      // arithmetic without the module having claimed anything about it.
      absenceRate: round1((b.absent / b.marked) * 100),
      measurable: b.marked >= floors.minMarks,
    }));

  const measurable = slices.filter((s) => s.measurable);

  const base = { slices, measured: measurable.length, seen: buckets.size, unkeyed };

  // NOT ENOUGH NAMEABLE SLICES. Null, never 0 and never the single slice's own rate: with
  // one measurable weekday there is nothing to concentrate against, and printing its rate
  // under the heading "worst weekday" would state a comparison that was never made.
  if (measurable.length < floors.minMeasured) {
    return { ...base, worst: null, worstRate: null, gap: null };
  }

  // Highest absence rate wins; ties go to the lowest key. `slices` is already sorted by
  // key, so a STRICT `>` keeps the first of equals without a second comparison — the same
  // tie-break workload.peakLoad uses, and it is easy to lose to a later `>=`.
  let worst = measurable[0];
  for (const s of measurable) if (s.absenceRate > worst.absenceRate) worst = s;

  const otherMarked = totalMarked - worst.marked;
  const otherAbsent = totalAbsent - worst.absent;

  // THE OTHER SIDE HAS ITS OWN FLOOR. A gap is two numbers and a guard on only the
  // interesting one is the classic half-guard: eighty per cent absent on Fridays against
  // nought on the two other marks in the register is an eighty-point gap drawn from two
  // rows. The slice's own rate is still reported — it is a measurement — but the GAP,
  // which is the thing that reads as a pattern, is withheld.
  if (otherMarked < floors.minOtherMarks) {
    return { ...base, worst: worst.key, worstRate: worst.absenceRate, gap: null };
  }

  const otherRate = (otherAbsent / otherMarked) * 100;
  return {
    ...base,
    worst: worst.key,
    worstRate: worst.absenceRate,
    gap: round1(worst.absenceRate - otherRate),
  };
}

/* -------------------------------------------------------------------------- */
/* Which day of the week does the absence land on?                             */
/* -------------------------------------------------------------------------- */

/**
 * Does this student's absence concentrate on particular weekdays?
 *
 * A student who misses every Friday is a different case from one absent at random. The
 * first is a timetable problem — a shift, a caring day, a lecturer, a train that does not
 * run — and it has an answer. The second is disengagement and needs a different
 * conversation entirely. Both produce the same overall percentage, the same
 * `attendanceSlope` and, at the same volume, the same `attendanceRegularity`: a weekly
 * percentage has already thrown the weekday away before regularity ever sees it.
 *
 * A FIGURE, NEVER A CODE. See the file header: within one student's marks there is
 * nothing to distinguish "this student avoids Fridays" from "nobody attends the Friday
 * nine o'clock", and CLAUDE.md names that exact case as a fact about the timetable rather
 * than about the student. The evidence that would separate them is the cohort's Friday,
 * which lives in cohort.js and not here.
 *
 * A WEEKDAY THE STUDENT HAS NEVER HAD A SESSION ON IS NOT 100% ATTENDANCE AND NOT 0%.
 * This is trap one and it falls out of the structure rather than needing a branch: the
 * buckets are built FROM the marks, so a weekday with no marks has no bucket, appears in
 * no denominator and in no numerator, and cannot be named the worst. A college that
 * timetables nothing on Fridays produces no Friday bucket for anybody — a fact about the
 * timetable that this module is simply unable to report as a fact about a student. An
 * implementation that seeded seven zeroed buckets to "make the array complete" would
 * invert exactly that, and it is the obvious tidy-up.
 *
 * NO INSTITUTION PROBE, and the asymmetry against kindShape() is worth stating because
 * the next reader will wonder. A weekday is DERIVED from `date`, which is NOT NULL on
 * HndSession and present on every mark this pipeline has ever seen — there is no college
 * at which weekdays go unrecorded, so there is no institution-wide question to answer. A
 * probe threaded through here "for consistency" would teach the next reader that probes
 * are ceremony, and then it gets dropped from the one place it was load-bearing.
 *
 * @param {Array<{status, date}>} marks  any order
 * @param {{weekdayMinMarks, weekdayMinOtherMarks, minWeekdaysMeasured}} [opts]
 * @returns {{weekdays, worstWeekday, worstWeekdayAbsenceRate, weekdayAbsenceGap,
 *            weekdaysMeasured, weekdaysSeen, undated}}
 */
function dayOfWeekShape(marks, opts) {
  const cfg = { ...SESSIONS_DEFAULTS, ...(opts || {}) };

  const labelled = (marks || [])
    .filter((m) => m && isStatus(m.status))
    .map((m) => ({
      // A mark whose date will not parse cannot be placed in a week and leaves both
      // sides, counted as `undated` rather than dropped. Same rule metrics.js applies to
      // an assessment with no due date, pointed at a register.
      key: weekdayOf(m.date),
      absent: !ATTENDED.has(m.status),
    }));

  const shape = sliceShape(labelled, {
    minMarks: cfg.weekdayMinMarks,
    minOtherMarks: cfg.weekdayMinOtherMarks,
    minMeasured: cfg.minWeekdaysMeasured,
  });

  return {
    // ISO-8601 weekday numbers, 1 = Monday … 7 = Sunday. Numbers rather than "Fri"
    // because they are stored and the client renders them: a college running in Welsh or
    // marking a Saturday cohort should not have an English abbreviation baked into a
    // history row, and ISO is the one numbering that does not need a comment saying which
    // day the week starts on.
    weekdays: shape.slices,
    worstWeekday: shape.worst,
    worstWeekdayAbsenceRate: shape.worstRate,
    weekdayAbsenceGap: shape.gap,
    weekdaysMeasured: shape.measured,
    weekdaysSeen: shape.seen,
    undated: shape.unkeyed,
  };
}

/* -------------------------------------------------------------------------- */
/* Which kind of session does the absence land on?                             */
/* -------------------------------------------------------------------------- */

/**
 * Does this student's absence concentrate on particular kinds of session?
 *
 * A student who attends every lecture and no tutorial is a specific, actionable case —
 * small-group anxiety, an unmet support need, a group they have fallen out with, work
 * they cannot do in front of people — and it is invisible in every existing figure. The
 * overall percentage averages it away, `unitAttendanceSpread` only finds it if the kinds
 * happen to split along unit lines, and `firstSessionAbsenceRate` only if the tutorial is
 * always first.
 *
 * A FIGURE, NEVER A CODE, for the reason dayOfWeekShape is: a cohort that skips seminars
 * is a real and common thing, and one student's marks cannot tell that apart from this
 * student skipping seminars.
 *
 * THE INSTITUTION PROBE IS REQUIRED AND THIS THROWS WITHOUT IT — see
 * assertInstitutionProbe. `kind` defaults to "" and at most colleges every row carries
 * it, so "does this college record kind at all" is an institution-wide question that is
 * invisible in a chunk of 200 students, and answering it from the chunk is the most
 * repeated bug in this area.
 *
 * NOT WIRED YET. metrics.js does not currently carry `kind` on a flattened mark, so this
 * returns nulls for every student today. That is the correct output for "we cannot see
 * it" and the probe is what makes it legible: with kindRecorded false the nulls say the
 * college does not use the field, and with it true and every mark unkeyed the `kindUnset`
 * count says the select is the thing that is missing.
 *
 * @param {Array<{status, kind}>} marks  any order
 * @param {{kindRecorded:boolean}} institution  REQUIRED — throws without it
 * @param {{kindMinMarks, kindMinOtherMarks, minKindsMeasured}} [opts]
 */
function kindShape(marks, institution, opts) {
  assertInstitutionProbe(institution, "kindShape");
  const cfg = { ...SESSIONS_DEFAULTS, ...(opts || {}) };

  const known = (marks || []).filter((m) => m && isStatus(m.status));

  // THE INSTITUTION GUARD. Not an empty result computed from the marks — an explicit
  // refusal, with `kindUnset` reporting the whole register as unkeyed so a reader can see
  // that nothing was measured rather than that nothing was found. Returning zeroes here
  // would say "we looked at the kinds and there were none", about a college that does not
  // have the concept.
  if (!institution.kindRecorded) {
    return {
      kinds: [],
      worstKind: null,
      worstKindAbsenceRate: null,
      kindAbsenceGap: null,
      // NULL, NOT ZERO, and the distinction is the one this whole codebase turns on.
      // Zero says "we counted the kinds that cleared the floor and there were none" --
      // a statement about a sample. This branch is reached when the college records no
      // kinds AT ALL, so there was no sample to count and the honest answer is that the
      // question could not be asked. The same reasoning the submittedOnRecorded guard
      // gives for returning a null gradedWithDates rather than a 0.
      //
      // kindsSeen stays 0 because it means something different: how many distinct kind
      // strings appeared, and none did.
      kindsMeasured: null,
      kindsSeen: 0,
      kindUnset: known.length,
    };
  }

  const shape = sliceShape(
    known.map((m) => ({
      // "" is HndSession.kind's DEFAULT and means "unset", not "a session kind called
      // nothing" — the same reading workload.js gives a weight of 0 and tripwires.js
      // gives an unweighted mark. sliceShape drops "" into `unkeyed`, out of both sides.
      key: typeof m.kind === "string" ? m.kind.trim() : null,
      absent: !ATTENDED.has(m.status),
    })),
    {
      minMarks: cfg.kindMinMarks,
      minOtherMarks: cfg.kindMinOtherMarks,
      minMeasured: cfg.minKindsMeasured,
    },
  );

  return {
    kinds: shape.slices,
    worstKind: shape.worst,
    worstKindAbsenceRate: shape.worstRate,
    kindAbsenceGap: shape.gap,
    kindsMeasured: shape.measured,
    kindsSeen: shape.seen,
    kindUnset: shape.unkeyed,
  };
}

/* -------------------------------------------------------------------------- */
/* Weeks the register ran and saw nobody                                       */
/* -------------------------------------------------------------------------- */

/**
 * Consecutive weeks in which this student was marked and attended NOTHING.
 *
 * WHY THIS IS NOT `absenceStreak`, WHICH IS THE FIRST THING A READER WILL ASSUME.
 *
 * `absenceStreak` counts the trailing run of consecutive marks whose status is A. It is a
 * count of ROWS, and the four ways the two answers come apart are all real:
 *
 *   1. A WEEK WITH NO SESSIONS BREAKS NOTHING AND COUNTS AS NOTHING. A reading week, a
 *      bank holiday, a unit that had no timetabled sessions — none of them produces a
 *      mark, so a streak neither notices them nor is interrupted by them, and neither is
 *      this. Weeks with no marks are TRANSPARENT here: not counted as unseen (that would
 *      manufacture a disappearance out of a term calendar, which is the error
 *      weeklyRegularity exists to avoid) and not treated as a break (a student absent
 *      either side of a reading week has been gone for three weeks, and resetting the
 *      count at the holiday would hide exactly the students a holiday hides).
 *   2. E DOES NOT BREAK THIS RUN, and it breaks a streak by design. tripwires is asking
 *      "have we LOST CONTACT with this person", and a student who rang in has not been
 *      lost. This asks the regulator's question instead — has this person been in a room
 *      — and a fortnight of authorised absence is still a fortnight of no teaching, which
 *      a sponsoring provider must evidence and cannot evidence with a phone call.
 *   3. VOLUME IS NORMALISED BY THE WEEK. Three absent marks is a whole week at a college
 *      teaching three sessions a week and one afternoon at a college teaching twelve. A
 *      streak of three means opposite things at the two; two unseen weeks means the same
 *      thing at both.
 *   4. A PARTIAL WEEK BREAKS THIS AND NOT A STREAK. A student who comes in on Mondays and
 *      misses the rest of every week carries a permanent streak of several marks and has
 *      no unseen weeks at all — correctly, because somebody sees them every Monday. That
 *      pattern is dayOfWeekShape's question, not this one's.
 *
 * AND WHY IT IS NOT `TRIP_NOT_SEEN`, which counts days since the last attendance. That
 * one reads the CALENDAR and therefore cannot tell a holiday from a disappearance: it
 * fires across an entire college every summer and every Christmas, which is survivable
 * only because it is read alongside a date. This reads the REGISTER, and requires
 * positive evidence that sessions ran and recorded nothing — so it cannot fire on a
 * closed college at all.
 *
 * DATES, NEVER DAY COUNTS, AND NEVER A STORED WEEK COUNT EITHER. Nothing in this feature
 * runs on a schedule — markStale() fires on data events and a day passing is not an event
 * — so "unseen for two weeks" written to a column is wrong by the next fortnight with
 * nothing to correct it, while "unseen since the week beginning 2026-03-09" is true
 * forever. The count is returned so a code can be decided at calculation time; the DATE
 * is what a caller stores and the screen subtracts.
 *
 * @param {Array<{status, date}>} marks  any order
 * @param {string} today  YYYY-MM-DD, in the college's zone, passed in and never read
 *        from a clock
 * @param {{zeroWeekMinMarks, runRecencyDays}} [opts]
 * @returns {{observedWeeks, currentZeroWeeks, longestZeroWeeks, marksInRun,
 *            unseenSinceWeekOn, lastAttendedWeekOn, lastMarkOn, currentRunFresh}}
 */
function consecutiveWeeks(marks, today, opts) {
  const cfg = { ...SESSIONS_DEFAULTS, ...(opts || {}) };

  const unknown = {
    observedWeeks: 0,
    currentZeroWeeks: null,
    longestZeroWeeks: null,
    marksInRun: 0,
    unseenSinceWeekOn: null,
    lastAttendedWeekOn: null,
    lastMarkOn: null,
    currentRunFresh: null,
  };

  // AN UNPARSEABLE `today` CANNOT DECIDE WHAT IS IN THE PAST. Every comparison below
  // would silently be false, and the answer would be a confident "no unseen weeks" drawn
  // from a malformed string rather than from a register. Same refusal as
  // workload.deadlineClusters and coverage.daysBetween.
  if (!isDate(today)) return unknown;

  const weeks = new Map();
  let lastMarkOn = null;

  for (const m of marks || []) {
    if (!m || !isStatus(m.status) || !isDate(m.date)) continue;
    // MARKS DATED AFTER TODAY ARE NOT EVIDENCE ABOUT NOW. Registers can be generated
    // ahead of the sessions they belong to, and a register saved early for next week's
    // class would otherwise extend a run into the future — a disappearance dated forward,
    // which is not a thing that can be true.
    if (m.date > today) continue;

    const key = weekStartOf(m.date);
    if (key === null) continue;

    const w = weeks.get(key) || { key, marked: 0, attended: 0 };
    w.marked += 1;
    if (ATTENDED.has(m.status)) w.attended += 1;
    weeks.set(key, w);

    if (!lastMarkOn || m.date > lastMarkOn) lastMarkOn = m.date;
  }

  // NO OBSERVED WEEKS IS NULL, NOT ZERO. A student nobody has marked has not been seen
  // for nought weeks; the question has not been asked of them. Reporting 0 would read as
  // "we checked the register and they are fine", which is the inversion this codebase is
  // organised to avoid, and it would put a clean figure against every student in an
  // intake before a single session had run.
  if (!weeks.size) return unknown;

  // Monday keys are YYYY-MM-DD, so a string sort is a chronological sort — and it stays
  // one across a year boundary, which an ISO week NUMBER would not.
  const ordered = [...weeks.values()].sort((a, b) => (a.key < b.key ? -1 : 1));

  // The trailing run, walked backwards from the most recent OBSERVED week. Weeks that
  // produced no marks are not in this list at all, which is the transparency described
  // above: they are neither steps in the run nor breaks in it.
  let currentZeroWeeks = 0;
  let marksInRun = 0;
  let unseenSinceWeekOn = null;
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    if (ordered[i].attended > 0) break;
    currentZeroWeeks += 1;
    marksInRun += ordered[i].marked;
    unseenSinceWeekOn = ordered[i].key;
  }

  // The longest run anywhere in the record. A FIGURE ONLY and deliberately not a code: a
  // student who vanished for three weeks in October and has attended every session since
  // is a student who came back, and a caseload entry for it would sit on the row for the
  // rest of the programme with nothing able to clear it — the monotonic pile every
  // windowed signal in tripwires.js was rewritten to avoid. As context beside a live
  // finding it is worth a great deal: it is the difference between a first disappearance
  // and a pattern.
  let longestZeroWeeks = 0;
  let run = 0;
  for (const w of ordered) {
    if (w.attended > 0) { run = 0; continue; }
    run += 1;
    if (run > longestZeroWeeks) longestZeroWeeks = run;
  }

  let lastAttendedWeekOn = null;
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    if (ordered[i].attended > 0) { lastAttendedWeekOn = ordered[i].key; break; }
  }

  // IS THE RUN STILL CURRENT? The transparency of empty weeks is what lets a run survive
  // a reading week, and unguarded it is also what would keep a run lit all summer for a
  // student who stopped coming in May — with no event able to clear it, because a day
  // passing is not an event and nobody will mark them again until September.
  //
  // So the run has to be anchored to a register somebody has opened recently. Past
  // runRecencyDays of silence the finding is no longer "this student is not coming in",
  // it is "nobody is marking this student" — which is coverage.js's TRIP_REGISTER_STALE,
  // raised by the module that can see the timetable and owned by the college rather than
  // by the student.
  const sinceLastMark = daysBetween(lastMarkOn, today);
  const currentRunFresh = isNum(sinceLastMark) && sinceLastMark <= cfg.runRecencyDays;

  return {
    observedWeeks: ordered.length,
    currentZeroWeeks,
    longestZeroWeeks,
    // The denominator behind the run, returned so "unseen for two weeks" is auditable on
    // the day it fired rather than reconstructed later from a register that has moved on.
    marksInRun,
    // DATES. `unseenSinceWeekOn` is null when the run is zero — there is no week to name
    // — rather than being set to the current week, which would say the student is missing
    // from a week they attended.
    //
    // THE TERNARY IS DOCUMENTATION, NOT A GUARD, and it is written down because a mutation
    // pass proved it: with a run of zero the loop above breaks on its first iteration and
    // the local is still null, so removing the condition changes no behaviour and no test
    // can catch it. It stays because the INVARIANT is the load-bearing part — a later
    // reader who initialises the local to the most recent week key, or who moves the
    // assignment above the break, would silently start naming a week the student attended.
    // coverage.staleness carries the same note about its own untestable branch.
    unseenSinceWeekOn: currentZeroWeeks ? unseenSinceWeekOn : null,
    lastAttendedWeekOn,
    lastMarkOn,
    currentRunFresh,
  };
}

/* -------------------------------------------------------------------------- */
/* The evaluation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} raw
 *   today              {string} YYYY-MM-DD, passed in rather than read from a clock
 *   marks              {Array<{status, date, startTime, sessionId, unitId, kind}>} every
 *                      mark in scope, any order, exactly as metrics.js flattens them —
 *                      plus `kind`, which metrics.js does not carry yet
 *   weeksIntoProgramme {number|null} accepted and deliberately unused; see below
 *   institution        {{kindRecorded:boolean}} REQUIRED — throws without it
 * @param {object} [config] a settings config, spread over SESSIONS_DEFAULTS
 */
function evaluate(raw, config) {
  const cfg = { ...SESSIONS_DEFAULTS, ...(config || {}) };
  const input = raw || {};
  // Throws before anything else, so a caller that forgot the probe finds out on their
  // first fixture rather than after a term of blank columns.
  assertInstitutionProbe(input.institution, "evaluate");

  const codes = [];
  const marks = input.marks || [];

  const weekday = dayOfWeekShape(marks, cfg);
  const kinds = kindShape(marks, input.institution, cfg);
  const weeks = consecutiveWeeks(marks, input.today, cfg);

  /* --- the register ran and saw nobody ------------------------------------ */

  // THREE GUARDS, AND ALL THREE ARE LOAD-BEARING.
  //
  //   currentZeroWeeks   the run itself, in weeks — the shape nothing else measures.
  //   marksInRun         the minimum denominator. Two weeks holding one register each is
  //                      a claim about a fortnight drawn from two rows, and at a college
  //                      teaching one session a week it is the ordinary state of a
  //                      student who missed two classes.
  //   currentRunFresh    the run must reach up to a register somebody has opened
  //                      recently. Without it this is monotonic across a holiday: empty
  //                      weeks are transparent by design, so a student who vanished in
  //                      May still fires in October with nothing able to clear it.
  //
  // `isNum` is what keeps an unmeasured student out. A null run means nobody has marked
  // them at all, and a `>= 2` against null is silently false today and silently true the
  // day somebody replaces it with `|| 0`.
  if (isNum(weeks.currentZeroWeeks)
      && weeks.currentZeroWeeks >= cfg.zeroWeekLimit
      && weeks.marksInRun >= cfg.zeroWeekMinMarks
      && weeks.currentRunFresh === true) {
    codes.push(SESSIONS.WEEKS_UNSEEN);
  }

  /* --- the weekday and kind findings raise NOTHING, on purpose ------------ */

  // Trap six, enforced structurally rather than remembered. Both shapes above are
  // returned as figures and neither is consulted here, because within one student's marks
  // there is nothing to separate "this student misses Fridays" from "this cohort misses
  // Fridays" — and CLAUDE.md names that second thing as a fact about the timetable. The
  // half that would separate them is the rest of the cohort's Friday, which lives in
  // cohort.js and is not an input to this module.
  //
  // A reader who later wires a per-weekday cohort baseline through and wants a code has
  // to satisfy the same test workload.js already meets: every push guarded by the shared
  // half AND by something that is true of this student and not of their neighbours.

  /* --- the settling-in exemption, and why it is deliberately NOT applied --- */

  // CLAUDE.md: "`weeksIntoProgramme` mutes the disengagement codes inside a settling-in
  // period, because in week one nobody has attendance history, marks or a pastoral
  // record, and a caseload containing the whole intake is the same as no caseload. An
  // *unknown* programme age is deliberately not exempt."
  //
  // TRIP_WEEKS_UNSEEN IS NOT IN THAT CLASS, and the class is the reason rather than the
  // habit. The exemption covers codes that fire on the ABSENCE OF A RECORD, because in
  // week one that absence describes the calendar rather than the student.
  // tripwires.evaluate applies it to NO_PASTORAL_CONTACT and pointedly does NOT apply it
  // to ABSENCE_STREAK, whose argument transfers here word for word: this cannot fire on
  // an intake whose register nobody has taken, because with no marks there are no
  // observed weeks and the run is null rather than long. It fires only where the register
  // EXISTS, ran for two weeks or more, and says the student was not there — evidence, not
  // silence.
  //
  // And suppressing it would hide precisely the student it is best at finding: the
  // non-starter, somebody who enrolled and never once turned up, which is exactly who a
  // sponsoring provider has to identify and exactly inside the window they have to do it
  // in. tripwires.js records that as a bug its first version shipped with.
  //
  // `weeksIntoProgramme` is accepted in the input and read by nothing, ON PURPOSE, so the
  // decision is visible at the call site rather than looking like an oversight — and so
  // anybody who later decides this code DOES belong in the muted class has the field in
  // their hand and must confront the second half of the rule too: an unknown programme
  // age is NOT exempt, because muting every code for a student the calendar cannot place
  // fails safe in the wrong direction. Two tests pin both halves.

  return {
    /* --- weekday shape: figures only ------------------------------------- */
    // ISO-8601, 1 = Monday … 7 = Sunday.
    worstAbsenceWeekday: weekday.worstWeekday,
    worstWeekdayAbsenceRate: weekday.worstWeekdayAbsenceRate,
    weekdayAbsenceGap: weekday.weekdayAbsenceGap,
    // How many weekdays cleared the floor, so a reader can see the gap is a comparison
    // over four days rather than over two.
    weekdaysMeasured: weekday.weekdaysMeasured,

    /* --- kind shape: figures only ---------------------------------------- */
    worstAbsenceKind: kinds.worstKind,
    worstKindAbsenceRate: kinds.worstKindAbsenceRate,
    kindAbsenceGap: kinds.kindAbsenceGap,
    kindsMeasured: kinds.kindsMeasured,

    /* --- weeks: a count for the code, DATES for the row ------------------ */
    unseenWeekRun: weeks.currentZeroWeeks,
    // The storable fact. "Unseen since the week beginning 2026-03-09" is true forever;
    // "unseen for two weeks" is wrong by the next fortnight and nothing will correct it.
    unseenSinceWeekOn: weeks.unseenSinceWeekOn,
    lastAttendedWeekOn: weeks.lastAttendedWeekOn,
    // Context, never a code: a first disappearance and a fourth are different
    // conversations, and this is the only figure that tells them apart.
    longestUnseenWeekRun: weeks.longestZeroWeeks,
    observedWeeks: weeks.observedWeeks,

    codes,
  };
}

module.exports = {
  evaluate,
  dayOfWeekShape,
  kindShape,
  consecutiveWeeks,
  weekdayOf,
  weekStartOf,
  assertInstitutionProbe,
  SESSIONS,
  SESSIONS_CODES,
  SESSIONS_DEFAULTS,
};
