// Tests for the funding layer: is this student's money a reason they may not continue?
//
// No database. funding.js is pure — it takes the SlcApplication rows the gather has
// already selected, today's date, and an institution-wide probe result, and returns
// plain data.
//
// WEIGHTED HARD TOWARDS NEGATIVE ASSERTIONS, and more so than anywhere else in this
// family. Every failure this module exists to prevent is a screen telling a tutor that
// a student has no money, on the strength of a row that was ambiguous, a column nobody
// writes, or a default value. So most of what follows asserts what does NOT fire, what
// comes back null rather than false, and what is refused outright.
//
// Run with: node --test src/prediction/funding.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  evaluate, fundingState, stalledApplication, classify, loanTypesOverlap,
  FUNDING, FUNDING_CODES, FUNDING_DEFAULTS, POSITION, STATE,
} = require("./funding");
const { TRIP_CODES } = require("./tripwires");
const { COVERAGE_CODES } = require("./coverage");
const { COHORT_CODES } = require("./cohort");

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const TODAY = "2026-03-20";

/** A college whose finance records exist AND are linked to actual students. */
const LINKED = { slcRecorded: true };
/** A college that runs student finance somewhere other than this module. */
const NO_SLC = { slcRecorded: false };

/** YYYY-MM-DD, `n` days before TODAY. UTC midnight arithmetic, never a local Date. */
function daysBefore(n, from = TODAY) {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** One SlcApplication row, linked, with every date absent unless a test fills it. */
const app = (over = {}) => ({
  studentId: "stu-1",
  status: "Applied",
  loanType: "",
  applicationDate: null,
  decisionDate: null,
  statusChangedOn: null,
  ...over,
});

/** The shape a caller hands evaluate(). */
const input = (over = {}) => ({
  today: TODAY,
  applications: [],
  institution: LINKED,
  ...over,
});

/** Everything evaluate() can return that is not `codes`. */
const FIGURES = [
  "fundingPosition", "fundingUnsettledSince", "fundingSettledOn",
  "fundingRefusedOn", "fundingApplications", "fundingNotApplied",
];

/* ========================================================================== */
/* The codes themselves                                                       */
/* ========================================================================== */

test("every code is namespaced TRIP_", () => {
  // Structural, not decoration. These strings are appended to riskDriverCodes, the same
  // array engine.js fills from its six RED indicators. A code named RED_something would
  // read as the engine's own, and the next person to take redIndicatorCount off the copy
  // rather than off engine.js's internal `reds` array would silently wire a student's
  // bank balance into their risk band via OVR-004.
  assert.ok(FUNDING_CODES.length > 0);
  for (const code of FUNDING_CODES) assert.ok(code.startsWith("TRIP_"), code);
});

test("no code collides with one another module already stores", () => {
  // Four files now write into the same array and every one of these strings outlives the
  // screen that renders it. A collision would make a stored history row mean two things.
  const others = [...TRIP_CODES, ...COVERAGE_CODES, ...COHORT_CODES];
  for (const code of FUNDING_CODES) assert.equal(others.includes(code), false, code);
});

test("there is no clock anywhere in the module", () => {
  // src/clock.js pins APP_TIMEZONE precisely because the host clock is not the college's
  // day: a claim decided at 23:30 in London is a different date on a server in UTC-5, and
  // a module that called new Date() would give a different answer depending on which
  // machine ran the batch. Asserted as text, in the style of schema-contract.test.js,
  // because a behavioural test cannot see a clock that is only read on one branch.
  const src = fs.readFileSync(path.join(__dirname, "funding.js"), "utf8");
  assert.equal(/Date\.now\(/.test(src), false, "funding.js reads the host clock");
  assert.equal(/new Date\(\s*\)/.test(src), false, "funding.js constructs a live Date");
});

/* ========================================================================== */
/* The institution probe                                                      */
/* ========================================================================== */

test("funding REFUSES to answer without an institution-wide probe result", () => {
  // CLAUDE.md records this as the most repeated bug in this area, got wrong three times:
  // "does this college record this at all" answered from the chunk in front of the code.
  // gather() runs on chunks of 200 and the incremental path often scores exactly one
  // student, at which size the question is invisible.
  //
  // The tripwires guards default to falsy and fall silent, which is right there — one
  // code does not fire. Here a missing flag would null the whole feature silently and
  // permanently, and nothing in any output would look wrong. So it throws, the way db.js
  // throws on a query with no tenant context.
  assert.throws(() => fundingState([], TODAY, undefined), /institution-wide/);
  assert.throws(() => fundingState([], TODAY, {}), /institution-wide/);
});

test("a truthy non-boolean probe is refused, not coerced", () => {
  // The shape somebody reaches for when wiring in a hurry: a count, or the result of a
  // findFirst. `if (institution.slcRecorded)` would accept all of these and be right by
  // accident for one; `0` and `null` would be silently read as "this college has no
  // finance data" and take the feature off the air for everybody.
  assert.throws(() => fundingState([], TODAY, { slcRecorded: 1 }), /boolean/);
  assert.throws(() => fundingState([], TODAY, { slcRecorded: "yes" }), /boolean/);
  assert.throws(() => fundingState([], TODAY, { slcRecorded: null }), /boolean/);
  assert.throws(() => fundingState([], TODAY, { slcRecorded: {} }), /boolean/);
});

test("evaluate refuses the same way, before it computes anything", () => {
  assert.throws(() => evaluate({ ...input(), institution: undefined }, {}), /institution-wide/);
  assert.throws(() => evaluate({ ...input(), institution: { slcRecorded: 3 } }, {}), /boolean/);
});

test("the probe cannot be overridden by the rows in front of the code", () => {
  // THE BUG THIS EXISTS TO PREVENT, stated as a test. A college that runs its student
  // finance elsewhere is `slcRecorded: false`, and the presence of rows for one student
  // must not talk the module into answering. If this ever passes by reading
  // applications.length instead of the flag, the guard has been reimplemented from the
  // chunk and CLAUDE.md's three-times bug is back.
  const r = evaluate(input({
    institution: NO_SLC,
    applications: [
      app({ status: "Declined", decisionDate: daysBefore(10) }),
      app({ status: "Awaiting evidence", statusChangedOn: daysBefore(200) }),
    ],
  }), {});

  assert.deepEqual(r.codes, []);
  for (const key of FIGURES) assert.equal(r[key], null, key);
});

/* ========================================================================== */
/* Trap one: no row means "we do not know", not "no funding"                   */
/* ========================================================================== */

test("a student with no SlcApplication row produces NO figure and NO code", () => {
  // THE SINGLE MOST IMPORTANT ASSERTION IN THE FILE. Self-funding, employer-sponsored,
  // international and bursary-funded students all legitimately have nothing here.
  // Treating absence as a problem would put every self-funding student in the institution
  // on a risk register for a loan they never wanted.
  const r = evaluate(input({ applications: [] }), {});

  assert.deepEqual(r.codes, []);
  for (const key of FIGURES) assert.equal(r[key], null, key);
});

test("absence is `known: false`, and specifically NOT a position of any kind", () => {
  // The failure this guards is a later reader defaulting `position` to "not-applied" or
  // to "unclear" for a student with no rows. Both are claims about somebody's money made
  // from an empty array, and both would render on the screen as a finding.
  const s = fundingState([], TODAY, LINKED);

  assert.equal(s.known, false);
  assert.equal(s.position, null);
  assert.equal(s.applications, null);
  assert.equal(s.refusedUncovered, null);
});

test("no rows is null, never zero — the counts are withheld too", () => {
  // Null means "not measurable"; zero means zero. `applications: 0` would read on the row
  // as "we looked at this student's finance record and there is nothing in it", which is
  // a claim, and `refusedUncovered: 0` would read as "we checked, they have not been
  // refused" about a student nobody has a record for.
  const s = fundingState([], TODAY, LINKED);
  assert.notEqual(s.applications, 0);
  assert.notEqual(s.refusedUncovered, 0);
});

/* ========================================================================== */
/* The link guard: rows that were never tied to this student                   */
/* ========================================================================== */

test("a row with no studentId is refused, not measured", () => {
  // CLAUDE.md's dead-ends note: SlcApplication holds a student's name and typed college
  // ID as plain strings with no relation to Student. A caller that matched on studentRef
  // or on studentName produces rows with a null studentId, and that join is wrong for
  // every student who shares a surname with another. The consequence of getting it wrong
  // here is telling one person about another person's money.
  const r = evaluate(input({
    applications: [app({ studentId: null, status: "Declined", decisionDate: daysBefore(5) })],
  }), {});

  assert.deepEqual(r.codes, []);
  assert.equal(r.fundingPosition, null);
});

test("ONE unlinked row refuses the whole answer — it is not filtered down to the rest", () => {
  // The tempting fix is `applications.filter(r => r.studentId)`, which silently
  // half-honours a bad join and produces a plausible figure from it. registerCoverage
  // makes the same call for a mark with no sessionId: an unreconcilable input yields no
  // figure at all. The linked row here is a decline that would otherwise fire, so a
  // filtering implementation is caught rather than merely unproven.
  const r = evaluate(input({
    applications: [
      app({ status: "Declined", loanType: "Tuition Fee Loan", decisionDate: daysBefore(5) }),
      app({ studentId: null, status: "Paid" }),
    ],
  }), {});

  assert.deepEqual(r.codes, []);
  assert.equal(r.fundingPosition, null);
});

test("the unlinked count survives the refusal, so a caller can diagnose it", () => {
  const s = fundingState([app({ studentId: null }), app({ studentId: null })], TODAY, LINKED);
  assert.equal(s.known, false);
  assert.equal(s.unlinked, 2);
});

/* ========================================================================== */
/* Trap two: "Not applied" is a FIGURE and never a code                        */
/* ========================================================================== */

test("`Not applied` raises no code at all", () => {
  // It is the column's DEFAULT VALUE (`status String @default("Not applied")`), so a row
  // created by an administrator typing a name and pressing Save carries it without
  // anybody having asserted anything. It is ALSO what pick() in src/routes/slc.js writes
  // when it does not recognise the status sent, so a client one deploy behind has its
  // status silently rewritten to this string. A code cannot be defended on a value that
  // means three things, one of which is a bug.
  const r = evaluate(input({ applications: [app({ status: "Not applied" })] }), {});

  assert.deepEqual(r.codes, []);
  assert.equal(r.fundingPosition, POSITION.NOT_APPLIED);
  assert.equal(r.fundingNotApplied, true);
});

test("an ANCIENT `Not applied` still raises no code", () => {
  // The obvious "improvement": if it has said Not applied for two years, surely that is a
  // finding. It is not — two years of an unedited default is still an unedited default,
  // and ageing it only means nobody has been back to the record.
  const r = evaluate(input({
    applications: [app({ status: "Not applied", applicationDate: daysBefore(700) })],
  }), {});

  assert.deepEqual(r.codes, []);
});

test("a whole intake at `Not applied` produces a caseload of nobody", () => {
  // A college that creates a finance record per student at enrolment — the obvious way to
  // use the module — starts every one of them here. CLAUDE.md: a signal that fires for a
  // whole cohort at once is a FIGURE, not a code, because riskDriverCodes is a per-student
  // caseload array and a hundred rows carrying an identical reason is the same as no
  // caseload.
  for (let i = 0; i < 200; i += 1) {
    const r = evaluate(input({
      applications: [app({ studentId: `stu-${i}`, status: "Not applied" })],
    }), {});
    assert.deepEqual(r.codes, [], `student ${i}`);
  }
});

test("fundingNotApplied is FALSE, not null, once the question has an answer", () => {
  // Null is reserved for "nothing is known". A student with a paid loan has been asked
  // the question and the answer is no, and a null there would be indistinguishable on the
  // row from a student with no finance record at all.
  const r = evaluate(input({ applications: [app({ status: "Paid" })] }), {});
  assert.equal(r.fundingNotApplied, false);
});

/* ========================================================================== */
/* Trap five: terminal states, and why two of them are opposites               */
/* ========================================================================== */

test("Approved, In payment and Paid are settled — no codes, ever", () => {
  for (const status of ["Approved", "In payment", "Paid"]) {
    const r = evaluate(input({
      applications: [app({ status, applicationDate: daysBefore(400), decisionDate: daysBefore(300) })],
    }), {});
    assert.deepEqual(r.codes, [], status);
    assert.equal(r.fundingPosition, POSITION.SETTLED, status);
  }
});

test("a settled claim can never be stalled, however old it is", () => {
  // A settled claim is not sitting anywhere. `false` here is a real answer rather than a
  // shrug — we looked, it has finished — and it must not be null, which would read as
  // "could not tell".
  for (const status of ["Approved", "In payment", "Paid", "Declined", "Cancelled"]) {
    const s = stalledApplication(
      app({ status, applicationDate: daysBefore(900), statusChangedOn: daysBefore(900) }),
      TODAY,
    );
    assert.equal(s.stalled, false, status);
    assert.equal(s.since, null, status);
  }
});

test("Declined fires, because a refusal is the opposite of settled", () => {
  const r = evaluate(input({
    applications: [app({ status: "Declined", decisionDate: daysBefore(30) })],
  }), {});

  assert.deepEqual(r.codes, [FUNDING.REFUSED]);
  assert.equal(r.fundingPosition, POSITION.REFUSED);
  assert.equal(r.fundingRefusedOn, daysBefore(30));
});

test("Cancelled fires NOTHING — it is the absence of a claim, not a refusal", () => {
  // THE TRAP IN TRAP FIVE. Both are terminal and everybody lumps them together the first
  // time. A claim is cancelled overwhelmingly because the student stopped needing it: a
  // bursary came through, an employer picked up the fee, they changed course and
  // reapplied, or an administrator tidied a duplicate. Reading it as "no funding" flags a
  // student whose employer is paying the whole fee.
  const r = evaluate(input({
    applications: [app({ status: "Cancelled", decisionDate: daysBefore(10) })],
  }), {});

  assert.deepEqual(r.codes, []);
  assert.notEqual(r.fundingPosition, POSITION.REFUSED);
});

test("Cancelled is not evidence of funding either — it leaves BOTH sides", () => {
  // The half that is easy to miss. Having declined to call it a refusal, the next mistake
  // is to let it count as a settled claim and quietly reassure. A student whose only row
  // is Cancelled has an UNCLEAR position, which is the honest answer.
  const r = evaluate(input({ applications: [app({ status: "Cancelled" })] }), {});
  assert.equal(r.fundingPosition, POSITION.UNCLEAR);
});

test("a cancelled claim does not cover a declined one", () => {
  // Following from the two above: if Cancelled were treated as live or settled it would
  // supersede the decline beside it and silence the one code that matters.
  const r = evaluate(input({
    applications: [
      app({ status: "Cancelled", loanType: "Tuition Fee Loan" }),
      app({ status: "Declined", loanType: "Tuition Fee Loan", decisionDate: daysBefore(20) }),
    ],
  }), {});

  assert.deepEqual(r.codes, [FUNDING.REFUSED]);
});

/* ========================================================================== */
/* Several rows for one student: which refusals still stand                    */
/* ========================================================================== */

test("a decline beside a paid claim for the same loan raises NOTHING", () => {
  // The schema is explicit that "a resubmission after a decline is another [row]". A
  // student whose resubmission was approved has a loan, and reporting them as refused
  // would be the humiliation failure with the evidence of its own wrongness sitting in
  // the same array.
  const r = evaluate(input({
    applications: [
      app({ status: "Declined", loanType: "Tuition Fee Loan", decisionDate: daysBefore(60) }),
      app({ status: "Paid", loanType: "Tuition Fee Loan", decisionDate: daysBefore(20) }),
    ],
  }), {});

  assert.deepEqual(r.codes, []);
  assert.equal(r.fundingPosition, POSITION.SETTLED);
});

test("a LIVE resubmission also covers the decline it replaced", () => {
  const r = evaluate(input({
    applications: [
      app({ status: "Declined", loanType: "Maintenance Loan", decisionDate: daysBefore(60) }),
      app({ status: "Applied", loanType: "Maintenance Loan", applicationDate: daysBefore(5) }),
    ],
  }), {});

  assert.deepEqual(r.codes, []);
  assert.equal(r.fundingPosition, POSITION.IN_FLIGHT);
});

test("a paid TUITION loan does NOT cover a declined MAINTENANCE loan", () => {
  // The whole reason the loan type is partitioned. A roof over the fee and nothing to
  // live on is the version of this problem that actually makes people leave, and a
  // student-level "are they funded" test would call this one funded.
  const r = evaluate(input({
    applications: [
      app({ status: "Paid", loanType: "Tuition Fee Loan", decisionDate: daysBefore(40) }),
      app({ status: "Declined", loanType: "Maintenance Loan", decisionDate: daysBefore(30) }),
    ],
  }), {});

  assert.deepEqual(r.codes, [FUNDING.REFUSED]);
  assert.equal(r.fundingPosition, POSITION.REFUSED);
});

test("an UNKNOWN loan type silences the refusal rather than raising it", () => {
  // loanType is free text with a "" default, so blank is the commonest value in the
  // table. The overlap test is permissive on purpose and is only ever used to SILENCE a
  // refusal, never to raise one: this file will not say a decline is uncovered unless it
  // can show the live claims are for a different fee. With a blank type it cannot show
  // that, so it does not say it. An unproven refusal never reaches the screen.
  const r = evaluate(input({
    applications: [
      app({ status: "Paid", loanType: "" }),
      app({ status: "Declined", loanType: "Tuition Fee Loan", decisionDate: daysBefore(30) }),
    ],
  }), {});

  assert.deepEqual(r.codes, []);
});

test('"Both" covers either specific liability', () => {
  const r = evaluate(input({
    applications: [
      app({ status: "In payment", loanType: "Both" }),
      app({ status: "Declined", loanType: "Maintenance Loan", decisionDate: daysBefore(30) }),
    ],
  }), {});

  assert.deepEqual(r.codes, []);
});

test("loanTypesOverlap is permissive in BOTH directions", () => {
  // Argument order must not decide whether a student is reported as refused.
  assert.equal(loanTypesOverlap("Tuition Fee Loan", "Maintenance Loan"), false);
  assert.equal(loanTypesOverlap("Maintenance Loan", "Tuition Fee Loan"), false);
  assert.equal(loanTypesOverlap("Tuition Fee Loan", "Tuition Fee Loan"), true);
  assert.equal(loanTypesOverlap("Tuition Fee Loan", ""), true);
  assert.equal(loanTypesOverlap("", "Tuition Fee Loan"), true);
  assert.equal(loanTypesOverlap("Other", "Maintenance Loan"), true);
  assert.equal(loanTypesOverlap(undefined, "Maintenance Loan"), true);
});

/* ========================================================================== */
/* The stall clock                                                            */
/* ========================================================================== */

test("a recorded status change at the limit stalls; one day short does not", () => {
  const at = evaluate(input({
    applications: [app({ status: "Applied", statusChangedOn: daysBefore(28) })],
  }), {});
  const under = evaluate(input({
    applications: [app({ status: "Applied", statusChangedOn: daysBefore(27) })],
  }), {});

  assert.deepEqual(at.codes, [FUNDING.STALLED]);
  assert.deepEqual(under.codes, []);
});

test("the WEAKER anchor gets a longer rope, and it is not the same limit", () => {
  // With statusChangedOn null — which is every row today, because nothing writes it — the
  // only anchor is applicationDate, and it answers a different question: time in the
  // pipeline, not time in this state. The claim may have moved last week with nobody
  // recording it. So four weeks is not enough evidence and eight is.
  const short = evaluate(input({
    applications: [app({ status: "Applied", applicationDate: daysBefore(28) })],
  }), {});
  const long = evaluate(input({
    applications: [app({ status: "Applied", applicationDate: daysBefore(56) })],
  }), {});

  assert.deepEqual(short.codes, []);
  assert.deepEqual(long.codes, [FUNDING.STALLED]);
});

test("the row records WHICH anchor it used, so a plausible number is never the weaker one", () => {
  const strong = stalledApplication(app({ statusChangedOn: daysBefore(10) }), TODAY);
  const weak = stalledApplication(app({ applicationDate: daysBefore(10) }), TODAY);

  assert.equal(strong.basis, "status-change");
  assert.equal(weak.basis, "application");
});

test("statusChangedOn wins over applicationDate when both are present", () => {
  // A claim submitted a hundred days ago whose status moved three days ago is a claim
  // that is moving. Preferring the application date would report the whole of a slow but
  // healthy process as a stall.
  //
  // THE FIXTURE'S NUMBERS ARE LOAD-BEARING and the first version of this test got them
  // wrong: with an application date 300 days old, an implementation that read the wrong
  // anchor fell out past `stalledCeilingDays` and produced no code either, so the test
  // passed while discriminating nothing. 100 days sits above `unsettledApplicationDays`
  // (56) and below the ceiling (240), so the wrong anchor DOES fire and the assertion has
  // something to catch.
  const row = app({
    status: "Applied",
    applicationDate: daysBefore(100),
    statusChangedOn: daysBefore(3),
  });

  assert.deepEqual(evaluate(input({ applications: [row] }), {}).codes, []);

  const s = stalledApplication(row, TODAY);
  assert.equal(s.basis, "status-change");
  assert.equal(s.since, daysBefore(3));
  assert.equal(s.stalled, false);
});

test("updatedAt and createdAt are NEVER read", () => {
  // The schema comment on statusChangedOn exists to say so: updatedAt moves when somebody
  // corrects a typo in `notes`, so days-stalled computed from it is a confidently wrong
  // number that shrinks every time an administrator tidies a record. createdAt is no
  // better — a bulk import stamps every row in the college with the same instant, so every
  // claim would appear to have stalled on the same day and the figure would be measuring
  // the import. A row carrying only those two must be undateable.
  const s = stalledApplication(
    { studentId: "stu-1", status: "Applied", updatedAt: daysBefore(90), createdAt: daysBefore(90) },
    TODAY,
  );

  assert.equal(s.stalled, null);
  assert.equal(s.since, null);

  const r = evaluate(input({
    applications: [{ studentId: "stu-1", status: "Applied", updatedAt: daysBefore(90), createdAt: daysBefore(90) }],
  }), {});
  assert.deepEqual(r.codes, []);
});

test("an undateable in-flight claim is NULL, not false", () => {
  // The distinction stops a later reader treating `stalled === false` as reassurance. A
  // claim in flight with no dates at all cannot be placed on a calendar: "not stalled"
  // would be a claim and "stalled" would be a caseload entry on no evidence.
  const s = stalledApplication(app({ status: "Applied" }), TODAY);
  assert.equal(s.stalled, null);
  assert.notEqual(s.stalled, false);
});

test("an unparseable date is unknown, not `changed today`", () => {
  // tripwires.daysBetween returns 0 for a bad date, which is the right shrug there — it
  // makes a code fail to fire. Here 0 would mean "this claim changed state today", the
  // strongest possible reassurance about a claim nobody can date, produced by a bad string
  // rather than by evidence.
  const s = stalledApplication(app({ status: "Applied", statusChangedOn: "not-a-date" }), TODAY);
  assert.equal(s.daysUnsettled, null);
  assert.equal(s.stalled, null);
});

test("the ceiling stops this being monotonic across a three-year programme", () => {
  // A row still reading "Applied" after eight months is a row nobody closed, not a claim
  // in a queue. Without a ceiling, one abandoned row from a first term pins a code on a
  // student for the rest of the programme with no way to clear it, and a permanently lit
  // column is one staff scroll past. The same guard unansweredQueryCeilingDays carries.
  const r = evaluate(input({
    applications: [app({ status: "Applied", statusChangedOn: daysBefore(400) })],
  }), {});

  assert.deepEqual(r.codes, []);
});

test("a claim dated in the future raises nothing", () => {
  // An administrator typing next year's date. The floor comparison already handles it and
  // there is deliberately no branch of its own, but the behaviour is asserted so a later
  // reader adding an abs() is caught.
  const r = evaluate(input({
    applications: [app({ status: "Applied", statusChangedOn: daysBefore(-30) })],
  }), {});

  assert.deepEqual(r.codes, []);
});

/* ========================================================================== */
/* Evidence outstanding: the shorter clock, and the anchor it refuses          */
/* ========================================================================== */

test("awaiting evidence fires on its OWN, shorter limit before any stall", () => {
  // Three weeks against four, and the asymmetry is the point: this is the one state the
  // college can clear this afternoon by sitting down with the student and a passport.
  const r = evaluate(input({
    applications: [app({ status: "Awaiting evidence", statusChangedOn: daysBefore(21) })],
  }), {});

  assert.deepEqual(r.codes, [FUNDING.EVIDENCE_OUTSTANDING]);
  assert.equal(r.codes.includes(FUNDING.STALLED), false);
});

test("one day short of the evidence limit fires nothing", () => {
  const r = evaluate(input({
    applications: [app({ status: "Awaiting evidence", statusChangedOn: daysBefore(20) })],
  }), {});

  assert.deepEqual(r.codes, []);
});

test("past both limits, BOTH fire — the overlap is accepted, not filtered", () => {
  // ABSENCE_STREAK and NOT_SEEN both fire on one disappearance; CONTACT_DEFICIT and
  // NO_PASTORAL_CONTACT both fire on one silence. These name two different next steps,
  // done by two different people: chase the queue, and help the student find the document.
  const r = evaluate(input({
    applications: [app({ status: "Awaiting evidence", statusChangedOn: daysBefore(30) })],
  }), {});

  assert.equal(r.codes.includes(FUNDING.EVIDENCE_OUTSTANDING), true);
  assert.equal(r.codes.includes(FUNDING.STALLED), true);
});

test("the evidence code REFUSES the applicationDate fallback, however old", () => {
  // The one place the weaker anchor is rejected outright rather than given a longer rope.
  // "Awaiting evidence since the day they applied" is not a knowable statement:
  // applicationDate is when the claim entered the system, not when the SLC asked for a
  // document, and a claim awaiting evidence since submission is indistinguishable from one
  // that was approved, reopened and asked again. Acting on it would mean sitting a student
  // down to help them find paperwork submitted months ago.
  //
  // The stall code still fires on the same row, which is what makes this test
  // discriminating: an implementation that dropped the basis check would produce two codes
  // here rather than one.
  const r = evaluate(input({
    applications: [app({ status: "Awaiting evidence", applicationDate: daysBefore(100) })],
  }), {});

  assert.deepEqual(r.codes, [FUNDING.STALLED]);
});

test("`Applied` never raises the evidence code, only the stall", () => {
  // Nobody has asked this student for anything. Firing the evidence code here would send
  // staff looking for a document the SLC has not requested.
  const r = evaluate(input({
    applications: [app({ status: "Applied", statusChangedOn: daysBefore(60) })],
  }), {});

  assert.deepEqual(r.codes, [FUNDING.STALLED]);
});

test("the evidence code respects the ceiling too", () => {
  const r = evaluate(input({
    applications: [app({ status: "Awaiting evidence", statusChangedOn: daysBefore(400) })],
  }), {});

  assert.deepEqual(r.codes, []);
});

/* ========================================================================== */
/* The refusal window                                                         */
/* ========================================================================== */

test("a refusal inside the window fires", () => {
  const r = evaluate(input({
    applications: [app({ status: "Declined", decisionDate: daysBefore(300) })],
  }), {});
  assert.deepEqual(r.codes, [FUNDING.REFUSED]);
});

test("a refusal older than the window does NOT", () => {
  // A student still enrolled and still being scored three academic years after a decline
  // resolved it some other way — they are still here, which is the only evidence of
  // resolution this table can offer, because nothing writes a "resolved" status. Reporting
  // it for the rest of the programme is the monotonic pile again.
  const r = evaluate(input({
    applications: [app({ status: "Declined", decisionDate: daysBefore(400) })],
  }), {});
  assert.deepEqual(r.codes, []);
});

test("an UNDATED refusal fires, because the window can only ever silence", () => {
  // decisionDate is optional in the SLC form and null on most rows. A refusal that cannot
  // be placed on a calendar is still a refusal — the status says so, which is evidence
  // rather than a guess — so it fires and simply cannot be aged out. queryBacklog takes
  // the same line for an open query with no createdOn: dropping it would hide a student
  // with an unpaid fee, and dating it to the epoch would put them top of a list on no
  // evidence.
  const r = evaluate(input({ applications: [app({ status: "Declined" })] }), {});

  assert.deepEqual(r.codes, [FUNDING.REFUSED]);
  assert.equal(r.fundingRefusedOn, null);
});

/* ========================================================================== */
/* Statuses nobody can read                                                   */
/* ========================================================================== */

test("an unrecognised status is never guessed at", () => {
  // status is a free String column with no enum and no check constraint. The route
  // allowlists on the way in, so anything outside the set came from an importer or a
  // console. What it must not be is silently read as in-flight (a stall clock on a string
  // nobody can read) or as settled (a student reported as funded on a string nobody can
  // read).
  for (const status of ["Awaiting Evidence", "approved", "AWAITING DOCS", "", "In Payment"]) {
    const r = evaluate(input({ applications: [app({ status })] }), {});
    assert.deepEqual(r.codes, [], status);
    assert.equal(r.fundingPosition, POSITION.UNCLEAR, status);
  }
});

test("case folding is deliberately NOT applied", () => {
  // The kindness that gets refused. "approved" is trivially recoverable; the string that
  // will actually turn up is a college's own word for a stage the SLC does not have, and
  // folding case would broaden the door for the harmless cases while teaching the next
  // reader that this function guesses.
  assert.equal(classify("Approved"), STATE.SETTLED);
  assert.equal(classify("approved"), STATE.UNRECOGNISED);
  assert.equal(classify("Awaiting evidence"), STATE.IN_FLIGHT);
  assert.equal(classify("Awaiting Evidence"), STATE.UNRECOGNISED);
});

test("a non-string status is unrecognised, not a crash and not in-flight", () => {
  assert.equal(classify(null), STATE.UNRECOGNISED);
  assert.equal(classify(undefined), STATE.UNRECOGNISED);
  assert.equal(classify(7), STATE.UNRECOGNISED);

  const r = evaluate(input({ applications: [app({ status: null })] }), {});
  assert.deepEqual(r.codes, []);
});

test("unrecognised rows are counted so the college can see they were unreadable", () => {
  const s = fundingState([app({ status: "Awaiting Evidence" }), app({ status: "Paid" })], TODAY, LINKED);
  assert.equal(s.unrecognised, 1);
  assert.equal(s.position, POSITION.SETTLED);
});

/* ========================================================================== */
/* Dates, not day counts                                                      */
/* ========================================================================== */

test("evaluate returns DATES and stores no day count", () => {
  // CLAUDE.md: nothing in this feature runs on a schedule, markStale() fires on data
  // events, and a day passing is not an event — so "42 days awaiting evidence" written to
  // a column is wrong by the next morning with nothing to correct it, while the date is
  // true forever. The day count exists inside stalledApplication so a code can be decided
  // at calculation time; it must not reach the return.
  const r = evaluate(input({
    applications: [
      // Note the SPECIFIC loan types. A blank type on the live claim would silence the
      // decline beside it — see the permissive-overlap tests above — and this fixture
      // would then be asserting nothing about the refusal date.
      app({ status: "Awaiting evidence", loanType: "Tuition Fee Loan", statusChangedOn: daysBefore(40) }),
      app({ status: "Declined", loanType: "Maintenance Loan", decisionDate: daysBefore(50) }),
    ],
  }), {});

  for (const key of Object.keys(r)) {
    assert.equal(/day|week|age|elapsed|since\w/i.test(key), false, `${key} looks like a duration`);
  }
  assert.equal(r.fundingUnsettledSince, daysBefore(40));
  assert.equal(r.fundingRefusedOn, daysBefore(50));
});

test("every returned date is a YYYY-MM-DD string", () => {
  const r = evaluate(input({
    applications: [
      app({ status: "Applied", applicationDate: daysBefore(70) }),
      app({ status: "Paid", loanType: "Tuition Fee Loan", decisionDate: daysBefore(15) }),
    ],
  }), {});

  for (const key of ["fundingUnsettledSince", "fundingSettledOn"]) {
    assert.match(r[key], /^\d{4}-\d{2}-\d{2}$/, key);
  }
});

test("the OLDEST in-flight claim is the one reported, not the newest", () => {
  // A student with a three-day-old claim and a three-month-old one has a three-month
  // problem, and it is the old one that is worth chasing.
  const r = evaluate(input({
    applications: [
      app({ status: "Applied", statusChangedOn: daysBefore(5) }),
      app({ status: "Applied", statusChangedOn: daysBefore(90) }),
    ],
  }), {});

  assert.equal(r.fundingUnsettledSince, daysBefore(90));
});

test("an undated in-flight claim contributes no date rather than an epoch", () => {
  // An epoch would sort the student to the top of a chase list on no evidence at all.
  const r = evaluate(input({
    applications: [app({ status: "Applied" }), app({ status: "Applied", statusChangedOn: daysBefore(9) })],
  }), {});

  assert.equal(r.fundingUnsettledSince, daysBefore(9));
});

/* ========================================================================== */
/* today is an argument                                                       */
/* ========================================================================== */

test("the same rows give different answers on different days, and only because `today` moved", () => {
  // The proof that there is no clock: a fixed statusChangedOn read against two todays.
  const row = app({ status: "Applied", statusChangedOn: "2026-01-01" });

  const early = evaluate({ today: "2026-01-20", applications: [row], institution: LINKED }, {});
  const late = evaluate({ today: "2026-02-20", applications: [row], institution: LINKED }, {});

  assert.deepEqual(early.codes, []);
  assert.deepEqual(late.codes, [FUNDING.STALLED]);
});

test("no `today` at all yields no codes rather than a fabricated age", () => {
  const r = evaluate({ applications: [app({ status: "Applied", statusChangedOn: "2020-01-01" })], institution: LINKED }, {});
  assert.deepEqual(r.codes, []);
});

/* ========================================================================== */
/* Configuration and hygiene                                                  */
/* ========================================================================== */

test("the thresholds are configurable, and the config actually reaches the arithmetic", () => {
  // A college whose finance office chases weekly is entitled to say so. The negative half
  // matters more: if the constants were read directly rather than through the merged
  // config, this test would pass at the default and silently ignore the override.
  const row = app({ status: "Applied", statusChangedOn: daysBefore(10) });

  assert.deepEqual(evaluate(input({ applications: [row] }), {}).codes, []);
  assert.deepEqual(
    evaluate(input({ applications: [row] }), { ...FUNDING_DEFAULTS, stalledStatusDays: 7 }).codes,
    [FUNDING.STALLED],
  );
});

test("a config that omits a key falls back to the platform default", () => {
  const r = evaluate(input({
    applications: [app({ status: "Applied", statusChangedOn: daysBefore(28) })],
  }), {});
  assert.deepEqual(r.codes, [FUNDING.STALLED]);
});

test("evaluate emits nothing outside its own vocabulary, and never a duplicate", () => {
  const r = evaluate(input({
    applications: [
      app({ status: "Awaiting evidence", loanType: "Tuition Fee Loan", statusChangedOn: daysBefore(60) }),
      app({ status: "Awaiting evidence", loanType: "Tuition Fee Loan", statusChangedOn: daysBefore(70) }),
      app({ status: "Declined", loanType: "Maintenance Loan", decisionDate: daysBefore(30) }),
      app({ status: "Paid", loanType: "Tuition Fee Loan", decisionDate: daysBefore(30) }),
    ],
  }), {});

  for (const code of r.codes) assert.ok(FUNDING_CODES.includes(code), code);
  // Two stalled claims are one finding. A caseload row saying the same thing twice is a
  // caseload row a tutor stops reading.
  assert.equal(new Set(r.codes).size, r.codes.length);
  assert.equal(r.codes.includes(FUNDING.REFUSED), true);
});

test("evaluate does not mutate what it was given", () => {
  // gather() reuses these arrays across several modules in one run; a sort or a splice
  // here would change what a later module sees, and the symptom would appear somewhere
  // else entirely.
  const rows = [
    app({ status: "Declined", loanType: "Tuition Fee Loan", decisionDate: daysBefore(30) }),
    app({ status: "Applied", statusChangedOn: daysBefore(60) }),
  ];
  const before = JSON.stringify(rows);

  evaluate(input({ applications: rows }), {});

  assert.equal(JSON.stringify(rows), before);
});

test("null and undefined rows are survived rather than thrown on", () => {
  const r = evaluate(input({
    applications: [null, undefined, app({ status: "Declined", decisionDate: daysBefore(10) })],
  }), {});
  assert.deepEqual(r.codes, [FUNDING.REFUSED]);
});

test("stalledApplication survives being handed nothing", () => {
  const s = stalledApplication(undefined, TODAY);
  assert.equal(s.state, STATE.UNRECOGNISED);
  assert.equal(s.stalled, false);
});
