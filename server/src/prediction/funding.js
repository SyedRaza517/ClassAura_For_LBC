// Funding: is this student's money a reason they may not continue?
//
// PURE. No database, no clock, no tenant. Everything arrives as arguments, today's
// date included — the same seam as tripwires.js, coverage.js and engine.js, and for
// the same reason: these are lines a college will be asked to defend, in front of a
// student, so they have to be checkable without standing up an institution's worth of
// fixtures.
//
// WHY THIS LAYER EXISTS AT ALL.
//
// A student whose loan has not come through is at real risk of withdrawing, and it is
// one of the very few risks on this screen the college can actually DO something about
// — a hardship fund, a payment plan, a phone call to chase the evidence SLC asked for,
// a fee deferral. Every other signal in this pipeline tells a tutor that something is
// wrong; this one tells a finance officer what to do about it.
//
// It is also the risk that is LEAST VISIBLE in academic data. A student worrying about
// money attends, submits and gets marked right up until the week they leave, so the
// attendance percentage, the grade trend and the pastoral log are all clean on the day
// they withdraw. The weighted mean cannot see this because none of its seven components
// is about money, and no amount of reweighting them would make one appear.
//
// PREFER NULL. THE FAILURE MODE HERE IS HUMILIATING A STUDENT.
//
// This is the rule that decides every argument in this file, so it goes first.
//
// Everything below renders on a screen a tutor reads in the ten minutes before a
// one-to-one. A signal that wrongly says a student has no funding puts a member of
// staff in a room asking a person about their money on the strength of a row that was
// wrong — and the student who suffers it is disproportionately the one who is already
// on a bursary, already anxious about fees, or already the only person in their family
// who has been to a university. There is no version of that conversation that is
// recoverable by a correction on the next run.
//
// So the bar for saying anything is high, higher than anywhere else in this pipeline,
// and every ambiguous case in this file resolves to silence rather than to a finding.
// Silence costs a conversation that would have helped; a wrong finding costs a person
// their dignity in a meeting they did not ask for. Those are not symmetric and this
// file does not pretend they are.
//
// NO ROW MEANS "WE DO NOT KNOW", NOT "NO FUNDING". THIS IS THE WHOLE MODULE.
//
// It is the null-is-not-zero rule from CLAUDE.md pointed at the sharpest possible
// example, and it is the most repeated bug shape in this codebase. A student with no
// SlcApplication row is not a student without funding. They are:
//
//   * self-funding, which is entirely ordinary on a part-time or professional course;
//   * employer-sponsored, where an apprenticeship levy or a training budget pays and
//     the student never touches the SLC at all;
//   * an international student on a route the SLC does not serve, funded by a family,
//     a sponsor or a government scholarship;
//   * funded through an Advanced Learner Loan, a bursary, or a devolved-nation body
//     that is not the SLC and does not appear in this table;
//   * enrolled at a college that runs its student finance on a spreadsheet.
//
// Treating the absence of a row as a problem would put every self-funding student in
// the institution on a risk register for a loan they never wanted and never needed.
// So: no row, no figure, no code. Absence is `known: false` and every number is null.
//
// WHAT IS ACTUALLY POPULATED TODAY, WHICH IS LESS THAN IT LOOKS.
//
// At the time of writing, `src/routes/slc.js` is the ONLY writer of SlcApplication, and
// its `pick()` allowlist does not include `studentId`, `studentLinkSource`,
// `studentLinkedAt` or `statusChangedOn`. So today, at every college:
//
//   * every row's `studentId` is null — the backfill that would populate it has not
//     been run — which means no row in the table is reachable from a Student;
//   * every row's `statusChangedOn` is null, so "how long has this claim sat where it
//     is" has no anchor except the application date.
//
// That is the same shape as AssessmentSubmission in CLAUDE.md's "two dead ends" note:
// a signal reading an unwritten column measures the integration rather than the
// student. The difference is that this one is designed to KNOW it, and to fall silent
// until the columns mean something. `assertInstitutionProbe` below is what enforces
// that, and it is why this module currently produces nothing at every college — by
// design, not by accident. It comes to life one college at a time as their rows get
// linked, exactly as `overdueFollowUps` in tripwires.js comes to life once a college
// closes its first follow-up.
//
// WHY THE CODES ARE NAMESPACED `TRIP_`.
//
// They are appended to `riskDriverCodes`, the same array engine.js fills from its six
// RED indicators. `redIndicatorCount` — the input to OVR-004, which can worsen a band —
// is derived by engine.js from its own internal `reds` array, and `riskDriverCodes` is
// a copy taken afterwards, so appending here provably cannot reach the override. The
// prefix is what keeps that visible: a code named `RED_`-anything would read as the
// engine's own, and the next person to take a count off the copy would silently wire a
// student's bank balance into their risk band. Keep the prefix; keep the count off the
// copy.
//
// AND THERE IS A SECOND REASON HERE, SHARPER THAN THE STRUCTURAL ONE. A progression
// score that moves because of a student's funding is a score that ranks poorer students
// lower. It would be defensible nowhere — not to the student, not to a governing body,
// not to the OfS. This layer reports and never scores, and that is not a
// discretionary design choice.

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

// Stored in StudentPredictionCurrent.riskDriverCodes and in every history row, so these
// strings outlive several rewrites of the screen. Structured codes, never display text —
// the client maps them to wording, and rewording must not orphan a stored row.
//
// THREE CODES, AND EVERY ONE OF THEM FIRES ON THE PRESENCE OF A ROW SAYING SOMETHING
// SPECIFIC. Not one of them fires on an absence. That is the invariant that makes this
// module safe to put on a screen, and any fourth code added later has to satisfy it.
const FUNDING = {
  // A claim has sat in a non-terminal state past the point where somebody should have
  // chased it. ABOUT THE CLAIM, not about the student — the action is a phone call to
  // the SLC or to the finance office, not a conversation about commitment.
  STALLED: "TRIP_FUNDING_STALLED",
  // The SLC has asked for documents and has not had them. THE ONE CODE HERE WHERE THE
  // BALL IS IN THE STUDENT'S COURT, which is exactly why it is separate from STALLED:
  // the action is to sit down with them and help them find a passport or a payslip, and
  // that is a different task, done by a different person, from chasing a decision queue.
  EVIDENCE_OUTSTANDING: "TRIP_FUNDING_EVIDENCE_OUTSTANDING",
  // A claim was refused and nothing has replaced it. Terminal, and the opposite of
  // settled — see the argument at STATE below for why this is not lumped in with
  // "Cancelled", which is also terminal and means almost the reverse.
  REFUSED: "TRIP_FUNDING_REFUSED",
};

const FUNDING_CODES = Object.values(FUNDING);

// THE STATUS VOCABULARY, AND WHY "TERMINAL" IS NOT ONE BUCKET.
//
// `SlcApplication.status` is a free String column with `@default("Not applied")` and no
// enum, no check constraint and no database-level allowlist. The route allowlists on the
// way in (`STATUSES` in src/routes/slc.js), so a row written through the app carries an
// exact member of that set; a row written by an importer or by hand in a console may
// not, and that case is handled as UNRECOGNISED rather than guessed at.
//
// The five states below are the ones this module distinguishes, and the two that get
// lumped together by everybody who writes this feature the first time are `Declined` and
// `Cancelled`:
//
//   DECLINED — the SLC said no. The student has a tuition liability and no loan against
//   it. This is the single most actionable row in the whole table: it is what a hardship
//   fund, a payment plan, an appeal or a resubmission exists for, and it is knowable
//   months before the student decides to leave over it. It fires.
//
//   CANCELLED — the claim was withdrawn, and by far the commonest reason is that the
//   student no longer needed it. They got a bursary; an employer picked up the fee; they
//   changed course and reapplied under a fresh claim; the row was a duplicate an
//   administrator tidied away. A cancelled claim is the ABSENCE of a claim, not a
//   refusal of one, and reading it as "this student has no funding" would flag a student
//   whose employer is paying the whole fee. That is trap six in its purest form.
//
// So Cancelled is NEUTRAL: it raises nothing, and — the half that is easy to miss — it
// does not count as evidence of funding either. It leaves BOTH sides, the same way an
// unmarked unit leaves both sides of `unpassedUnits`. A student whose only row is
// Cancelled has an UNCLEAR position, which is honest, and no code, which is safe.
const STATE = {
  NOT_APPLIED: "not-applied",
  IN_FLIGHT: "in-flight",
  SETTLED: "settled",
  REFUSED: "refused",
  WITHDRAWN: "withdrawn",
  UNRECOGNISED: "unrecognised",
};

const STATUS_STATE = new Map([
  ["Not applied", STATE.NOT_APPLIED],
  ["Applied", STATE.IN_FLIGHT],
  ["Awaiting evidence", STATE.IN_FLIGHT],
  ["Approved", STATE.SETTLED],
  ["In payment", STATE.SETTLED],
  ["Paid", STATE.SETTLED],
  ["Declined", STATE.REFUSED],
  ["Cancelled", STATE.WITHDRAWN],
]);

// The one status that needs naming rather than only classifying, because it carries its
// own code and its own, shorter, clock.
const AWAITING_EVIDENCE = "Awaiting evidence";

// THE STUDENT'S OVERALL POSITION — a separate vocabulary from `status` above, and the
// separation is deliberate rather than fussy.
//
// CLAUDE.md records that "outcome" meaning two different things has caused three bugs,
// and that the fix is to name the variable for which one you mean. The same collision is
// waiting here: `status` is a property of ONE APPLICATION ROW, and a student may hold
// several. "Position" is the property of the STUDENT, derived across all of their rows.
// Reusing the word `status` for both would guarantee that within a year somebody writes
// `if (student.status === "Declined")` against a field that never holds that string.
const POSITION = {
  SETTLED: "settled",
  IN_FLIGHT: "in-flight",
  REFUSED: "refused",
  NOT_APPLIED: "not-applied",
  UNCLEAR: "unclear",
};

// The two loan types that name a specific liability. `loanType` is free text with a ""
// default and the route allows "", "Tuition Fee Loan", "Maintenance Loan", "Both" and
// "Other" — so anything outside this pair means "we cannot say which fee this claim
// covers", which is a different thing from "it covers neither".
const SPECIFIC_LOAN_TYPES = new Set(["Tuition Fee Loan", "Maintenance Loan"]);

/* -------------------------------------------------------------------------- */
/* Constants, and the arguments for them                                       */
/* -------------------------------------------------------------------------- */

// Platform defaults in the shape settings.js uses: defaults in code, overridden by
// whatever the caller merges over them. Deliberately NOT added to settings.js here —
// wiring is a separate change, and a config key that nothing reads is worse than no key
// at all. Every function takes an `opts`/`config` that is spread OVER these, so the day
// they move into DEFAULTS the callers do not change.
const FUNDING_DEFAULTS = {
  // HOW LONG A CLAIM MAY SIT SOMEWHERE NON-TERMINAL AFTER A RECORDED STATUS CHANGE.
  //
  // Four weeks. The reasoning is structural rather than an appeal to the SLC's published
  // turnaround, which varies by year, by route and by nation and which this file has no
  // business asserting as a constant:
  //
  //   * A term is roughly twelve teaching weeks. Four is a third of one — late enough
  //     that a claim which has genuinely stopped moving has stopped, and early enough
  //     that there is still most of a term in which a hardship payment or a payment plan
  //     can be arranged. Firing in week ten of a twelve-week term is a report, not an
  //     intervention, and CLAUDE.md is blunt that prediction without a named next step
  //     changes no outcomes.
  //   * It is twice `notSeenDays` (14), and the ordering is deliberate rather than
  //     incidental. A register is taken several times a week, so a fortnight of silence
  //     is a lot of missed opportunities to write something down. A finance queue is
  //     touched when something happens to it, which may be monthly, so the same fortnight
  //     is nothing. Reusing the register's clock here would light this code for every
  //     ordinary claim in the college.
  stalledStatusDays: 28,

  // THE SAME QUESTION WHEN NOBODY EVER RECORDED A STATUS CHANGE, WHICH IS EVERY ROW TODAY.
  //
  // With `statusChangedOn` null the only anchor is `applicationDate`, and that measures a
  // DIFFERENT thing: not "how long has this claim sat where it is" but "how long has this
  // claim been in the system without reaching a terminal state". The second is still
  // true — the row says non-terminal today, and it says it was submitted then — but it is
  // weaker evidence, because the claim may have moved between states last week with
  // nobody recording it.
  //
  // Weaker evidence gets a longer rope. Eight weeks rather than four, so that the
  // fallback cannot fire on a claim that is merely progressing normally through several
  // stages. The alternative — refusing to answer at all without `statusChangedOn` — was
  // rejected because it would take the stall signal off the air at every college in the
  // deployment for as long as the route does not stamp that column, and unlike the
  // evidence code below there is a genuinely true statement available: this claim was
  // submitted two months ago and is still not settled.
  unsettledApplicationDays: 56,

  // THE SHORTER CLOCK, FOR THE ONE STATE THE STUDENT CAN CLEAR THEMSELVES.
  //
  // Three weeks. Shorter than the stall limit on purpose, and the asymmetry is the point:
  // "Awaiting evidence" means somebody has asked this student for a document and not had
  // it. That is the one point in the process where the college can hand them the answer
  // this afternoon, and the cost of waiting is that a claim which could have been fixed
  // in an office in ten minutes instead expires.
  //
  // Three weeks is also the figure coverage.js uses for `staleRegisterDays`, on an
  // argument that transfers exactly: a fortnight can be a reading week plus a bank
  // holiday at almost any college, and three weeks cannot.
  evidenceOutstandingDays: 21,

  // THE CEILING, WITHOUT WHICH ALL OF THIS IS MONOTONIC.
  //
  // The same guard `unansweredQueryCeilingDays` carries in settings.js, for the same
  // reason. A row still reading "Applied" after eight months is not a claim in a queue —
  // the SLC does not take eight months, and by then the student has either been paid or
  // has gone. It is a row nobody closed. Without a ceiling, one abandoned row from a
  // student's first term pins a code on them for the remaining two years of a programme,
  // with no way to clear it from the prediction side, and a permanently lit column is a
  // column staff scroll past.
  //
  // 240 days is roughly a full academic year, September to May.
  stalledCeilingDays: 240,

  // HOW LONG A REFUSAL REMAINS A FINDING.
  //
  // A decline creates a liability, and the liability is what makes it worth reporting. A
  // decline from three academic years ago, on a student who is demonstrably still
  // enrolled and being scored by this pipeline, was evidently resolved some other way —
  // they are still here, which is real evidence, and it is the only evidence of
  // resolution this table can offer, because nothing writes a "resolved" status.
  //
  // A year, so a refusal is reportable across the whole of the year it was made in and
  // the enrolment decision that follows it, and no longer.
  refusedWindowDays: 365,
};

const isNum = (n) => typeof n === "number" && Number.isFinite(n);

/**
 * Whole days between two YYYY-MM-DD dates, `to` minus `from`, or NULL if either date
 * cannot be parsed.
 *
 * DELIBERATELY NOT tripwires.daysBetween, which returns 0 for an unparseable date. Zero
 * is the right shrug there — it makes a code fail to fire, which is silence. Here zero
 * would mean "this claim changed state today", which is the strongest possible
 * reassurance about a claim nobody can date, produced by a bad string rather than by
 * evidence. coverage.js took the same decision for the same reason.
 */
function daysBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Which of the five states a stored status string means.
 *
 * NO NORMALISATION, AND THAT IS A DECISION RATHER THAN AN OVERSIGHT. The obvious
 * kindness is to lowercase and trim before matching, so that "approved" and " Paid "
 * land where their author meant them to. It is refused because the easy cases are not
 * the ones that matter: "approved" is trivially recoverable, and the string that will
 * actually turn up from an importer is "Awaiting docs", "AWAITING EVIDENCE (SLC)" or a
 * college's own word for a stage the SLC does not have. Case folding would quietly
 * broaden the door for the harmless cases while doing nothing for the harmful ones, and
 * it would teach the next reader that this function guesses.
 *
 * An unrecognised status is UNRECOGNISED: reported, counted, and never guessed at. What
 * it must not be is silently treated as in-flight (a stall code on a status nobody can
 * read) or as settled (a student reported as funded on a string nobody can read).
 */
function classify(status) {
  if (typeof status !== "string") return STATE.UNRECOGNISED;
  return STATUS_STATE.get(status) || STATE.UNRECOGNISED;
}

/**
 * Whether a claim of type `a` could be covering the same liability as one of type `b`.
 *
 * ONLY USED TO SILENCE A REFUSAL, NEVER TO RAISE ONE, and that asymmetry is what makes
 * the permissive default the safe one. Two claims "overlap" unless both name a specific
 * and different liability, so a blank type — which is the DEFAULT VALUE of the column and
 * therefore the commonest one — always overlaps.
 *
 * Read the other way round: this file will not say a decline is uncovered unless it can
 * show that the student's live or settled claims are for a different fee. With an unknown
 * loan type it cannot show that, so it does not say it. An unproven refusal never reaches
 * the screen; the cost is a real uncovered decline going unreported at a college that
 * leaves the field blank, and against trap six that is the cheaper mistake.
 */
function loanTypesOverlap(a, b) {
  const x = typeof a === "string" ? a : "";
  const y = typeof b === "string" ? b : "";
  if (!SPECIFIC_LOAN_TYPES.has(x) || !SPECIFIC_LOAN_TYPES.has(y)) return true;
  return x === y;
}

/* -------------------------------------------------------------------------- */
/* The institution probe                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Refuse to answer a funding question without an institution-wide answer to "does this
 * college's student finance module hold records that are attached to actual students?"
 *
 * WHAT THE FLAG HAS TO MEAN, BECAUSE THE OBVIOUS PROBE IS WRONG.
 *
 * `count(SlcApplication) > 0` is the probe everybody writes, and it answers the wrong
 * question. `SlcApplication.studentId` is nullable, was added recently, and is populated
 * by a backfill that has NOT been run — and `src/routes/slc.js` does not write it either,
 * so no row created through the app has ever carried one. A college can therefore hold
 * four thousand finance records of which precisely zero are reachable from a Student.
 *
 * Under the naive probe that college passes. Every student then presents an empty
 * application array, every one of them is reported as `known: false`, and the row on the
 * screen says "we have no funding record for this person" about four thousand people who
 * have one. That is a measurement of a script nobody ran, dressed as a measurement of
 * students — the same manufactured-reassurance shape as coverage.js's timetable probe,
 * and the same reason a probe has to establish that the join can succeed rather than that
 * the table is non-empty.
 *
 * So the probe is:
 *
 *   at least one SlcApplication in this tenant with a NON-NULL studentId
 *
 * ISSUED ONCE PER RUN, UNFILTERED BY STUDENT, HOISTED OUT OF THE CHUNK LOOP. CLAUDE.md
 * records this as the most repeated bug in this area, got wrong three times, and the
 * reason is always the same: gather() runs on chunks of 200 and the ordinary incremental
 * path scores the handful of students markStale flagged, often exactly one. One student
 * with no linked finance record is completely ordinary — they are self-funding. A college
 * with none has no student finance data this module can read. Those two facts are
 * indistinguishable inside a chunk, and computing the flag from `applications.length`, or
 * from any array in this file, reproduces the bug exactly.
 *
 * WHY THIS THROWS INSTEAD OF DEFAULTING TO SILENCE.
 *
 * The guards in tripwires.js take a boolean that defaults to falsy and fall silent when
 * it is missing, and that is right for them: a missing flag there costs one code that
 * does not fire. Here a missing flag would cost the whole feature, silently and
 * permanently — every figure null for every student at every college, no test failing, no
 * row looking wrong. A feature that quietly does nothing is not discoverable by reading
 * the output.
 *
 * So this fails the way db.js fails a query with no tenant context: loudly, at the first
 * call, in the caller's own test run. A TypeError at wiring time is recoverable; three
 * years of blank columns nobody questioned is not. coverage.js's assertInstitutionProbe
 * makes the identical argument, and the two are deliberately the same shape.
 *
 * @param {{slcRecorded:boolean}} institution
 */
function assertInstitutionProbe(institution, fnName) {
  if (!institution || typeof institution.slcRecorded !== "boolean") {
    throw new TypeError(
      `${fnName}: institution.slcRecorded must be a boolean — an institution-wide probe ` +
      "result (at least one SlcApplication in this tenant with a non-null studentId), " +
      "decided once per run and never derived from one student's rows",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* One claim: how long has it sat where it is?                                 */
/* -------------------------------------------------------------------------- */

/**
 * How long a single claim has sat in a non-terminal state, expressed as the DATE it has
 * sat since.
 *
 * THIS ONE TAKES NO INSTITUTION PROBE, and the asymmetry is worth stating because the
 * next person will wonder. "How long has THIS claim been where it is" is a fact about one
 * row, answerable from that row, and one claim sitting still says nothing about the
 * college. "Does this college hold linked finance records at all" is not. The guard
 * belongs where the question is institution-wide and nowhere else — a probe threaded
 * through every function "for consistency" teaches the next reader that it is ceremony,
 * and then it gets dropped from the one place it was load-bearing. coverage.confidence
 * makes the same argument.
 *
 * WHICH DATE ANCHORS THE CLOCK, AND THE ONE THAT MUST NEVER BE USED.
 *
 *   `statusChangedOn` — the honest anchor, and the schema says why it exists: it is the
 *   date the status last actually CHANGED. Null on every row today, because nothing
 *   writes it, so this is the branch that comes to life later.
 *
 *   `applicationDate` — the fallback, and it answers a slightly different question: time
 *   in the pipeline rather than time in this state. Still a true statement, because the
 *   status says non-terminal TODAY. `basis` records which of the two was used, exactly as
 *   `weightedGrade` records whether it honoured the weighting, so a plausible number can
 *   never silently be the weaker one.
 *
 *   `updatedAt` — NEVER, and the schema comment on `statusChangedOn` exists precisely to
 *   say so: updatedAt moves when somebody corrects a typo in `notes`, so "days stalled"
 *   computed from it is a confidently wrong number that gets smaller every time an
 *   administrator tidies a record. `createdAt` is no better: a bulk import stamps every
 *   row in the college with the same instant, so every claim would appear to have stalled
 *   on the same day and the figure would be measuring the import.
 *
 * A DATE, NOT A DAY COUNT, IS WHAT A CALLER STORES. CLAUDE.md is explicit: nothing in
 * this feature runs on a schedule, markStale() fires on data events, and a day passing is
 * not an event — so "42 days awaiting evidence" written to a column is wrong by the next
 * morning with nothing to correct it, while the date it has been awaiting evidence since
 * is true forever. `daysUnsettled` is returned so a code can be decided at calculation
 * time and MUST NOT be persisted; `since` is the column.
 *
 * @param {{status, statusChangedOn, applicationDate}} application
 * @param {string} today  YYYY-MM-DD, in the college's own zone, passed in — there is no
 *        clock in this file, because a claim that changed at 23:30 in London is a
 *        different date on a server in UTC-5 and the answer must not depend on which
 *        machine ran the batch
 * @param {{stalledStatusDays, unsettledApplicationDays, stalledCeilingDays}} [opts]
 * @returns {{state, since:string|null, basis:string|null, daysUnsettled:number|null,
 *            stalled:boolean|null}}
 */
function stalledApplication(application, today, opts) {
  const cfg = { ...FUNDING_DEFAULTS, ...(opts || {}) };
  const row = application || {};
  const state = classify(row.status);

  // A TERMINAL STATE IS NOT A STALL, and `false` here is a real answer rather than a
  // shrug: we looked, the claim has finished, it is not sitting anywhere. That includes
  // Declined and Cancelled — both are finished, and a finished claim cannot be chased.
  // The problem with a decline is what it says, not how long it has been saying it, and
  // that is TRIP_FUNDING_REFUSED's job rather than this one's.
  //
  // UNRECOGNISED lands here too, and deliberately so. A status nobody can read must not
  // be treated as in-flight: that would attach a stall clock to a string whose meaning is
  // unknown, and the code would then say "chase this claim" about a claim that may have
  // been settled a year ago under a college's own vocabulary.
  if (state !== STATE.IN_FLIGHT) {
    return { state, since: null, basis: null, daysUnsettled: null, stalled: false };
  }

  const basis = row.statusChangedOn ? "status-change" : (row.applicationDate ? "application" : null);
  const since = basis === "status-change" ? row.statusChangedOn : (basis === "application" ? row.applicationDate : null);

  // AN UNDATEABLE CLAIM IS NULL, NOT FALSE, and the distinction is what stops a later
  // reader reading `stalled === false` as reassurance. A claim in flight with no dates on
  // it at all is one this module cannot place on a calendar; saying "not stalled" about it
  // would be a claim, and saying "stalled" would put a student on a caseload on no
  // evidence at all.
  if (!since) return { state, since: null, basis: null, daysUnsettled: null, stalled: null };

  const days = daysBetween(since, today);
  if (days === null) return { state, since, basis, daysUnsettled: null, stalled: null };

  // The weaker anchor gets the longer rope. See the constants.
  const floor = basis === "status-change" ? cfg.stalledStatusDays : cfg.unsettledApplicationDays;

  // A FLOOR AND A CEILING, like TRIP_QUERY_UNANSWERED. A negative count — a claim dated in
  // the future, which happens when an administrator types next year's date — fails the
  // floor and raises nothing, which is the right outcome and needs no branch of its own.
  const stalled = days >= floor && days <= cfg.stalledCeilingDays;

  return { state, since, basis, daysUnsettled: days, stalled };
}

/* -------------------------------------------------------------------------- */
/* The student: their position across every claim they hold                    */
/* -------------------------------------------------------------------------- */

/**
 * The student's overall funding position, derived across all of their claims.
 *
 * WHY THIS TAKES AN ARRAY AND NOT A ROW. The schema is explicit that one student
 * legitimately holds several: "a tuition loan and a maintenance loan are separate
 * applications, and a resubmission after a decline is another", and it refuses to put a
 * unique index on studentId for exactly that reason. A function that read only the newest
 * row would report a student whose resubmission was approved as refused, or a student
 * with a paid tuition loan and a declined maintenance loan as fully funded, depending
 * entirely on which row happened to sort first.
 *
 * NO ROW MEANS "WE DO NOT KNOW". See the header. `known: false` and every figure null.
 *
 * @param {Array<{studentId, status, loanType, applicationDate, decisionDate,
 *        statusChangedOn}>} applications  this student's claims, any order, ALREADY
 *        selected by studentId — see the unlinked guard below
 * @param {string} today  YYYY-MM-DD, in the college's zone
 * @param {{slcRecorded:boolean}} institution  see assertInstitutionProbe
 * @param {object} [opts]
 */
function fundingState(applications, today, institution, opts) {
  assertInstitutionProbe(institution, "fundingState");

  // One shape for every "we cannot say", so that no caller can accidentally get a partial
  // answer with some fields filled in. `unlinked` is the only field that survives, because
  // it is the one thing a caller needs in order to diagnose why they got nothing.
  const unknown = (unlinked) => ({
    known: false,
    position: null,
    applications: null,
    unlinked,
    unsettledSince: null,
    settledOn: null,
    refusedOn: null,
    refusedUncovered: null,
    unrecognised: null,
  });

  // THE INSTITUTION GUARD. A college that runs student finance somewhere other than this
  // module, or whose rows have never been linked to students, has no funding data about
  // anybody — and every figure must be null rather than a report that reads as a finding
  // about each student in turn.
  if (!institution.slcRecorded) return unknown(0);

  const rows = (applications || []).filter(Boolean);

  // THE LINK GUARD, AND IT REFUSES RATHER THAN FILTERS.
  //
  // CLAUDE.md's "dead ends" note says SlcApplication holds a student's name and typed
  // college ID as PLAIN STRINGS with no relation to Student. `studentId` has since been
  // added, but `studentName` and the free-text `studentRef` are still sitting there, and
  // they are what a caller in a hurry will match on — a LIKE on a name, or an equality on
  // a college ID somebody typed. That join is wrong for every student who shares a
  // surname with another, and the consequence of getting it wrong here is telling one
  // person about another person's money.
  //
  // A caller that selected `where: { studentId }` cannot produce a row without one. So a
  // row without one is evidence that the caller matched on something else, and the whole
  // answer is refused — not filtered down to the linked subset, which would silently
  // half-honour a bad join and produce a plausible figure from it. registerCoverage makes
  // the same call for the same reason when a mark has no sessionId: an unreconcilable
  // input yields no figure at all.
  //
  // Note what this deliberately does NOT do: it does not weigh `studentLinkSource`. A link
  // asserted by a named human and one made by a backfill script do not carry the same
  // weight at an appeal, and the schema keeps the field so that stays visible — but
  // refusing backfilled links here would take the feature off the air at precisely the
  // college that did the work to switch it on. Whether a link is good enough is the
  // caller's decision; this only refuses rows where identity was never asserted at all.
  const unlinked = rows.filter((r) => !r.studentId).length;
  if (unlinked) return unknown(unlinked);

  // NO ROWS IS NOT NO FUNDING. The single most important line in the file. See the header:
  // self-funding, employer-sponsored, international, bursary-funded and Advanced Learner
  // Loan students all legitimately have nothing here, and a figure of any kind about them
  // would be a claim about money nobody recorded.
  if (!rows.length) return unknown(0);

  const seen = rows.map((row) => ({ row, state: classify(row.status) }));
  const of = (state) => seen.filter((s) => s.state === state);

  const settled = of(STATE.SETTLED);
  const inFlight = of(STATE.IN_FLIGHT);
  const refused = of(STATE.REFUSED);
  const notApplied = of(STATE.NOT_APPLIED);
  const unrecognised = of(STATE.UNRECOGNISED);

  // WHICH REFUSALS STILL STAND.
  //
  // A decline beside a paid claim for the same loan is a resubmission that worked, and
  // reporting that student as refused would be the humiliation failure with the evidence
  // of its own wrongness sitting in the same array. So a decline is superseded by any
  // settled OR in-flight claim that could be covering the same liability.
  //
  // IN-FLIGHT COUNTS AS SUPERSEDING, which is the permissive choice and is deliberate: a
  // student who was declined and has reapplied has a live claim, and the finding about
  // them is the live claim's progress (TRIP_FUNDING_STALLED, in time), not the refusal
  // they have already acted on.
  //
  // NO DATE ORDERING IS USED, and that is not laziness. `decisionDate` is optional in the
  // form and null on most rows, and `statusChangedOn` is null on all of them, so an
  // ordering built from those dates would be decided by which rows happened to carry one —
  // meaning a resubmission would supersede a decline at colleges that fill in dates and
  // not at colleges that do not. Same-liability coexistence is the honest test the data
  // can actually support.
  const covering = [...settled, ...inFlight];
  const uncovered = refused.filter(
    (d) => !covering.some((c) => loanTypesOverlap(c.row.loanType, d.row.loanType)),
  );

  // THE POSITION LADDER, WORST FIRST.
  //
  // An uncovered refusal outranks a settled claim, and that is the whole reason the
  // loanType partition above exists: a student with a paid tuition loan and a declined
  // maintenance loan is not "funded". They have a roof over the fee and nothing to live
  // on, which is the version of this problem that actually makes people leave.
  //
  // WITHDRAWN APPEARS NOWHERE IN THIS LADDER. A cancelled claim is the absence of a claim.
  // A student whose only row is Cancelled falls through to UNCLEAR, which is the honest
  // answer: something was started and stood down, and this table does not record why.
  let position = POSITION.UNCLEAR;
  if (uncovered.length) position = POSITION.REFUSED;
  else if (settled.length) position = POSITION.SETTLED;
  else if (inFlight.length) position = POSITION.IN_FLIGHT;
  else if (notApplied.length) position = POSITION.NOT_APPLIED;

  // THE OLDEST CLAIM STILL IN FLIGHT, as a DATE. Oldest rather than newest because it is
  // the one that has been waiting longest and is therefore the one worth chasing; a
  // student with a three-day-old claim and a three-month-old one has a three-month
  // problem. Claims with no date at all contribute nothing here rather than an epoch,
  // which would sort them to the top of a chase list on no evidence.
  let unsettledSince = null;
  for (const s of inFlight) {
    const anchor = s.row.statusChangedOn || s.row.applicationDate;
    if (!anchor) continue;
    if (!unsettledSince || anchor < unsettledSince) unsettledSince = anchor;
  }

  // The most recent decision date on a settled claim, and on an uncovered refusal. Two
  // fields rather than one `decidedOn`, because a single overloaded column whose meaning
  // depends on another column is precisely the collision CLAUDE.md's "outcome" note is
  // about. Most recent rather than oldest: a decision supersedes the one before it.
  const latest = (list, field) => {
    let out = null;
    for (const s of list) {
      const d = s.row[field];
      if (!d) continue;
      if (!out || d > out) out = d;
    }
    return out;
  };

  return {
    known: true,
    position,
    // How many claims the position rests on, so a reader can see the sample and so the
    // classic chunk-derived failure stays detectable on the row.
    applications: rows.length,
    unlinked: 0,
    unsettledSince,
    settledOn: latest(settled, "decisionDate"),
    refusedOn: latest(uncovered, "decisionDate"),
    refusedUncovered: uncovered.length,
    // Reported rather than hidden: a college whose importer writes its own vocabulary
    // should be able to see that this module could read none of it, rather than wonder
    // why the column is empty.
    unrecognised: unrecognised.length,
  };
}

/* -------------------------------------------------------------------------- */
/* The evaluation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} raw
 *   today        {string} YYYY-MM-DD, passed in rather than read from a clock
 *   applications {Array} this student's SlcApplication rows, selected by studentId
 *   institution  {{slcRecorded:boolean}} the institution-wide probe; see
 *                assertInstitutionProbe. REQUIRED — this throws without it.
 * @param {object} [config] a settings config, spread over FUNDING_DEFAULTS
 * @returns {{fundingPosition, fundingUnsettledSince, fundingSettledOn, fundingRefusedOn,
 *            fundingApplications, fundingNotApplied, codes}}
 *
 * THERE IS NO SETTLING-IN EXEMPTION HERE, AND ITS ABSENCE IS A DECISION.
 *
 * Every other module in this family mutes its codes for a student in their first few
 * weeks, because those codes fire on the ABSENCE of a record and in week one nobody has
 * an attendance history, a mark or a pastoral note. All three codes here fire on the
 * PRESENCE of a row saying something specific, which puts them with ABSENCE_STREAK and
 * FOLLOWUP_MISSED on the outside of that grace.
 *
 * And more than that: week one is when funding problems are most actionable and most
 * likely. A loan that has not come through by enrolment is the classic autumn withdrawal,
 * and the hardship fund, the payment plan and the fee deferral that could keep the
 * student are all things that have to be arranged EARLY. A settling-in grace here would
 * switch the signal off in precisely the window it exists for.
 *
 * `weeksIntoProgramme` is therefore not read, and is deliberately not accepted as a
 * parameter either: settings.js makes the argument that a key nothing reads is worse than
 * no key at all, because somebody will believe they have configured something.
 */
function evaluate(raw, config) {
  const cfg = { ...FUNDING_DEFAULTS, ...(config || {}) };
  const input = raw || {};
  // Throws before anything else, so a caller who forgot the probe finds out on their first
  // fixture rather than after a term of blank columns.
  //
  // DELIBERATELY REDUNDANT WHILE fundingState() IS CALLED UNCONDITIONALLY BELOW, and the
  // mutation run says so: deleting this line kills no test, because fundingState asserts
  // on its own first statement. It stays for the reason coverage.js keeps the same pair —
  // the guarantee this function makes to its caller is "nothing is computed without a
  // probe", and that must not depend on which helper a later refactor happens to call
  // first. Anyone reordering evaluate() should keep it.
  assertInstitutionProbe(input.institution, "evaluate");

  const today = input.today;
  const codes = [];

  const state = fundingState(input.applications || [], today, input.institution, cfg);

  // NOTHING KNOWN, NOTHING SAID. Every figure null and not one code — no row, an unlinked
  // row, or a college that does not use this module all land here, and none of them is a
  // fact about a student. This early return is also what guarantees the invariant in the
  // vocabulary block above: no code in this file can be reached from an absence.
  if (!state.known) {
    return {
      fundingPosition: null,
      fundingUnsettledSince: null,
      fundingSettledOn: null,
      fundingRefusedOn: null,
      fundingApplications: null,
      fundingNotApplied: null,
      codes,
    };
  }

  const rows = (input.applications || []).filter(Boolean);

  /* --- a claim that has stopped moving ------------------------------------ */

  let stalled = false;
  let evidenceOutstanding = false;

  for (const row of rows) {
    const claim = stalledApplication(row, today, cfg);

    // `=== true` rather than a truthiness test, because `stalled` is tri-state and null is
    // falsy. It reads as redundant and it is not: it documents at the call site that the
    // third state exists, so that a later reader does not write `if (!claim.stalled)` and
    // quietly treat "could not be dated" as "checked, and fine".
    if (claim.stalled === true) stalled = true;

    // THE EVIDENCE CODE IS NOT A SUBSET OF THE STALL CODE, so it is computed here rather
    // than inside the branch above. Its threshold is SHORTER — three weeks against four —
    // precisely because it is the one the college can clear this afternoon, so a claim
    // awaiting evidence for 24 days must raise it while raising no stall.
    //
    // IT REQUIRES THE STATUS-CHANGE BASIS AND REFUSES THE FALLBACK, which is the one place
    // in this file where the weaker anchor is not merely given a longer rope but rejected
    // outright. "Awaiting evidence since the day they applied" is not a knowable statement:
    // `applicationDate` is when the claim entered the system, not when the SLC asked for a
    // document, and a claim that has been awaiting evidence since submission is
    // indistinguishable from one that was approved, reopened and asked again. Acting on
    // that would mean sitting a student down to help them find paperwork that may have
    // been submitted months ago.
    //
    // The consequence is that this code fires nowhere until the SLC route starts stamping
    // statusChangedOn. That will look broken to whoever ships it, and somebody will be
    // tempted to fix it by backfilling the column from updatedAt or createdAt. Both
    // reintroduce exactly the confidently-wrong number the schema comment on
    // statusChangedOn exists to warn about. It is the same self-healing watermark shape as
    // overdueFollowUps in tripwires.js, and it must be left alone.
    if (row && row.status === AWAITING_EVIDENCE
        && claim.basis === "status-change"
        && isNum(claim.daysUnsettled)
        && claim.daysUnsettled >= cfg.evidenceOutstandingDays
        && claim.daysUnsettled <= cfg.stalledCeilingDays) {
      evidenceOutstanding = true;
    }
  }

  // BOTH MAY FIRE AT ONCE, AND THAT IS ACCEPTED RATHER THAN FILTERED. Overlap is already
  // how this family behaves — ABSENCE_STREAK and NOT_SEEN both fire on one disappearance,
  // CONTACT_DEFICIT and NO_PASTORAL_CONTACT both fire on one silence. These name two
  // different next steps, done by two different people: chase the queue, and help the
  // student find the document. A claim that is both is worse than one that is either.
  if (stalled) codes.push(FUNDING.STALLED);
  if (evidenceOutstanding) codes.push(FUNDING.EVIDENCE_OUTSTANDING);

  /* --- a refusal nothing has replaced -------------------------------------- */

  // THE WINDOW CAN ONLY EVER SILENCE THIS CODE, NEVER RAISE IT, and that is what decides
  // how an undated refusal is treated.
  //
  // `decisionDate` is optional in the SLC form and null on most rows. A refusal that
  // cannot be placed on a calendar is still a refusal — the status says so, which is
  // evidence rather than a guess — so it fires, and it simply cannot be aged out. That is
  // queryBacklog's rule for an open query with no createdOn, in this file's words:
  // dropping it would hide a student with an unpaid fee, and dating it to the epoch would
  // put them at the top of a list on no evidence.
  //
  // A DATED refusal older than the window does not fire. See refusedWindowDays: a student
  // still enrolled three years after a decline resolved it some other way, and this table
  // has no "resolved" status with which to say so.
  const refusedAge = state.refusedOn ? daysBetween(state.refusedOn, today) : null;
  const agedOut = isNum(refusedAge) && refusedAge > cfg.refusedWindowDays;
  if (state.refusedUncovered >= 1 && !agedOut) codes.push(FUNDING.REFUSED);

  /* --- "Not applied" is a FIGURE and never a code -------------------------- */

  // TRAP TWO, AND THIS IS THE ARGUMENT.
  //
  // "Not applied" is genuinely ambiguous. It can mean "has not got round to it", which is
  // a real risk and an early, fixable one — or "is not applying, because they are
  // self-funding", which is not a risk at all. The row EXISTS, so this is a different
  // question from the header's "no row"; somebody did open a finance record for this
  // person. Three things decide it, and all three point the same way:
  //
  //   1. IT IS THE COLUMN'S DEFAULT VALUE. `status String @default("Not applied")`. A row
  //      created by an administrator typing a student's name into the SLC screen and
  //      pressing Save carries it without anybody having asserted anything about that
  //      student's money. The value is not evidence; it is the absence of an edit.
  //
  //   2. IT IS ALSO THE ROUTE'S FALLBACK FOR AN UNRECOGNISED INPUT. `pick()` in
  //      src/routes/slc.js reads `STATUSES.includes(str(b.status)) ? str(b.status) :
  //      "Not applied"`. A client that is one deploy behind, or that renames an option,
  //      has its status silently REWRITTEN to "Not applied" on save. So the string carries
  //      a third meaning — "the server did not understand what was sent" — and no code can
  //      be defended on top of a value that means three things, one of which is a bug.
  //
  //   3. IT WOULD FIRE FOR A WHOLE COHORT AT ONCE. A college that creates a finance record
  //      per student at enrolment, which is the obvious way to use this module, starts
  //      every one of them at "Not applied". CLAUDE.md's rule is explicit: a signal that
  //      fires for a whole cohort at once is a FIGURE, not a code, because riskDriverCodes
  //      is a per-student caseload array and a hundred rows carrying an identical reason
  //      is the same as no caseload. `assessmentsDueSoon` and `cohortStruggling` are both
  //      figures for exactly this reason.
  //
  // So it leaves as a figure. A finance officer can filter a list on it and work through
  // it, which is the right screen for it; a tutor's caseload is not. THE SAFE DIRECTION IS
  // EXPLICIT: this module will never tell anybody that a student has not applied for a
  // loan. It will only ever say that a row exists which has not been edited.
  //
  // `fundingNotApplied` is FALSE rather than null when the position is something else,
  // because at that point the question has genuinely been answered for this student. It is
  // null only where nothing is known at all, which is handled by the early return above.
  return {
    fundingPosition: state.position,
    // DATES, NOT DAY COUNTS. See stalledApplication.
    fundingUnsettledSince: state.unsettledSince,
    fundingSettledOn: state.settledOn,
    fundingRefusedOn: state.refusedOn,
    fundingApplications: state.applications,
    fundingNotApplied: state.position === POSITION.NOT_APPLIED,
    codes,
  };
}

module.exports = {
  evaluate,
  fundingState,
  stalledApplication,
  classify,
  loanTypesOverlap,
  FUNDING,
  FUNDING_CODES,
  FUNDING_DEFAULTS,
  POSITION,
  STATE,
};
