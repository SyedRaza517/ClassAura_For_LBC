// Tests for the intake layer: what the student told us before they started, and whether
// their right to study runs out during the course.
//
// No database. intake.js is pure — it takes the Ism and Admission rows the gather has
// already selected BY FOREIGN KEY, today's date, and two institution-wide probe results,
// and returns plain data.
//
// WEIGHTED HARD TOWARDS NEGATIVE ASSERTIONS, and for two distinct reasons rather than one.
//
// The first is the one funding.js has: every failure this module can produce lands on a
// screen a tutor reads before a one-to-one, and a wrong row about somebody's internet
// access, their digital skills or their immigration paperwork is not recoverable by a
// correction on the next run.
//
// The second is sharper and belongs to this file alone. The two tables it reads are joined
// to a student by a foreign key that sits next to a free-text column of almost the same
// name, and the wrong join attaches ONE PERSON'S VISA EXPIRY TO ANOTHER. That is not a bug
// that shows up as a wrong number; it shows up as a plausible number about the wrong human
// being. So the tests below spend most of their effort on what is REFUSED, what comes back
// null rather than false, what is never read at all, and what a bad join costs.
//
// Run with: node --test src/prediction/intake.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  evaluate, entryProfile, rightToStudy, pickInterview, pickAdmission, usableExpiry,
  isIsoDate, assertInstitutionProbe, INTAKE, INTAKE_CODES, INTAKE_DEFAULTS, ADMITTED,
  PROSE_FIELDS,
} = require("./intake");

// All six vocabularies that already write into riskDriverCodes. schema-contract.test.js
// carries the same assertion across the family; this file proves the seventh is safe
// before it is wired, so a collision is caught by the module's own test run.
const { TRIP_CODES } = require("./tripwires");
const { COVERAGE_CODES } = require("./coverage");
const { COHORT_CODES } = require("./cohort");
const { WORKLOAD_CODES } = require("./workload");
const { FUNDING_CODES } = require("./funding");
const { SESSIONS_CODES } = require("./sessions");

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const TODAY = "2026-03-20";

/** A college that runs interviews through the ISM module AND parses expiry dates. */
const BOTH = { ismRecorded: true, idExpiryRecorded: true };
/** A college that interviews on paper, or has never run the link backfill. */
const NO_ISM = { ismRecorded: false, idExpiryRecorded: true };
/** A college that has never parsed an identity document expiry. */
const NO_EXPIRY = { ismRecorded: true, idExpiryRecorded: false };

/** YYYY-MM-DD, `n` days after TODAY. UTC midnight arithmetic, never a local Date. */
function daysAfter(n, from = TODAY) {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const daysBefore = (n, from = TODAY) => daysAfter(-n, from);

/**
 * One Ism row as the gather would hand it over: LINKED, and carrying nothing this module
 * is allowed to read except by name.
 */
const ism = (over = {}) => ({
  linkedStudentId: "stu-1",
  interviewDate: "2026-01-12",
  wifiAccess: null,
  officeSkills: null,
  admitted: null,
  courseUnderstanding: null,
  lastStudied: null,
  independentLearning: null,
  educationExperience: null,
  strengthsWeaknesses: null,
  prioritiseWorkload: null,
  working: null,
  teamworkExample: null,
  ...over,
});

/** One Admission row, linked, with a trustworthy parsed expiry unless a test says otherwise. */
const adm = (over = {}) => ({
  linkedStudentId: "stu-1",
  idExpiryOn: null,
  idExpiryStatus: null,
  ...over,
});

/** The shape a caller hands evaluate(). */
const input = (over = {}) => ({
  today: TODAY,
  isms: [],
  admissions: [],
  institution: BOTH,
  weeksIntoProgramme: 2,
  ...over,
});

/** Everything evaluate() returns that is not `codes`. */
const FIGURES = [
  "entryProfileRecorded", "entryProfileOn", "entryProfileAnswered", "entryProfileQuestions",
  "entryProfileBarriers", "entryWifiAtHome", "entryKnowsOfficeSoftware",
  "entryAdmittedOutcome", "rightToStudyExpiresOn",
];

/** The module's source with every comment removed, so a text assertion tests the CODE. */
function codeOnly() {
  const src = fs.readFileSync(path.join(__dirname, "intake.js"), "utf8");
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
}

/* ========================================================================== */
/* The codes themselves                                                       */
/* ========================================================================== */

test("every code is namespaced TRIP_", () => {
  // Structural, not decoration. These strings are appended to riskDriverCodes, the same
  // array engine.js fills from its six RED indicators. A code named RED_something would
  // read as the engine's own, and the next person to take redIndicatorCount off the copy
  // rather than off engine.js's internal `reds` array would silently wire a student's
  // immigration paperwork into their risk band via OVR-004.
  assert.ok(INTAKE_CODES.length > 0);
  for (const code of INTAKE_CODES) assert.ok(code.startsWith("TRIP_"), code);
});

test("no code collides with any of the six vocabularies already storing into the same column", () => {
  // Seven files now write into one array and every one of these strings outlives the screen
  // that renders it. A collision would make a stored history row mean two different things
  // depending on which module wrote it, with nothing on the row to say which.
  const others = [
    ...TRIP_CODES, ...COVERAGE_CODES, ...COHORT_CODES,
    ...WORKLOAD_CODES, ...FUNDING_CODES, ...SESSIONS_CODES,
  ];
  for (const code of INTAKE_CODES) assert.equal(others.includes(code), false, code);
});

test("the six existing vocabularies are themselves disjoint, so the check above means something", () => {
  // A guard on the guard. If two of the six already collided, `others` would contain a
  // duplicate and the assertion above would still pass — proving nothing about this module
  // while looking green. schema-contract.test.js owns this check for the family; it is
  // repeated here so that this file's own collision test is known to be discriminating.
  const all = [
    ...TRIP_CODES, ...COVERAGE_CODES, ...COHORT_CODES,
    ...WORKLOAD_CODES, ...FUNDING_CODES, ...SESSIONS_CODES,
  ];
  assert.equal(new Set(all).size, all.length);
});

test("the codes are unique within this module too", () => {
  assert.equal(new Set(INTAKE_CODES).size, INTAKE_CODES.length);
});

test("there is no clock anywhere in the module", () => {
  // src/clock.js pins APP_TIMEZONE precisely because the host clock is not the college's
  // day: a document that expires at midnight in London expires on a different date on a
  // server in UTC-5, and a module that called new Date() would give a different answer
  // depending on which machine ran the batch. Asserted as text, in the style of
  // schema-contract.test.js, because a behavioural test cannot see a clock that is only
  // read on one branch.
  const src = codeOnly();
  assert.equal(/Date\.now\(/.test(src), false, "intake.js reads the host clock");
  assert.equal(/new Date\(\s*\)/.test(src), false, "intake.js constructs a live Date");
});

/* ========================================================================== */
/* Trap three, at the level where it cannot be argued with: what is READ       */
/* ========================================================================== */

test("the module's CODE never names a protected characteristic", () => {
  // `Admission.ethnicity` and `Admission.religion` are collected for statutory equality
  // monitoring and are special category data under Article 9. A progression signal that
  // moves with either is unlawful discrimination dressed as analytics, and the fact that a
  // correlation exists in the data is the argument against reading them.
  //
  // Comments are stripped first, so the header is free to explain the rule at length
  // without the test mistaking the explanation for a violation. That distinction matters:
  // a naive grep over the raw file would fail on the paragraph that forbids the thing.
  const src = codeOnly();
  assert.equal(/ethnicity/i.test(src), false, "intake.js reads ethnicity");
  assert.equal(/religion/i.test(src), false, "intake.js reads religion");
});

test("the module's CODE never touches the free-text expiry column or the typed college ID", () => {
  // Two columns, two different disasters.
  //
  // `idDateOfExpiry` is free text that legitimately holds "12/05/2027" or "May 2027", and
  // comparing either against a YYYY-MM-DD string produces a confident WRONG answer rather
  // than an error — which is the entire reason `idExpiryOn` exists beside it.
  //
  // `Admission.studentId` is a college number an admin TYPED. Joining on it attaches one
  // person's immigration paperwork to another. The FK is `linkedStudentId`, and the schema
  // says the two names are ugly on purpose.
  const src = codeOnly();
  assert.equal(/idDateOfExpiry/.test(src), false, "intake.js reads the unvalidated expiry column");
  assert.equal(/\.studentId\b/.test(src), false, "intake.js reads the typed college ID");
  assert.equal(/["']studentId["']/.test(src), false, "intake.js names the typed college ID");
});

test("the module's CODE never touches a name, an email or a date of birth", () => {
  // The other join a caller in a hurry reaches for when the backfill has not run. Matching
  // on a name is wrong for every student who shares a surname with another, which at a
  // college running one course with two intakes a year is not a rare event.
  const src = codeOnly();
  for (const field of ["firstName", "surname", "middleName", "email", "\\bdob\\b", "niNumber"]) {
    assert.equal(new RegExp(field).test(src), false, `intake.js reads ${field}`);
  }
});

test("prose content changes NOTHING — two students differing only in their answers score identically", () => {
  // THE CENTRAL ASSERTION OF TRAP THREE, and the one a keyword rule cannot survive.
  //
  // Every prose field is an admissions officer's paraphrase typed at speed, not the
  // student's own writing, and inferring risk from it is unaccountable to the person it is
  // about: there is no rule to point at and no way they could have answered differently.
  // The bland row and the alarming row differ in every prose field and in nothing else.
  const bland = ism({
    courseUnderstanding: "Wants to move into management.",
    lastStudied: "Finished an access course last summer.",
    independentLearning: "Understands it means self-study.",
    educationExperience: "Positive.",
    strengthsWeaknesses: "Organised; would like to improve written English.",
    prioritiseWorkload: "Uses a diary.",
    working: "No",
    teamworkExample: "Ran a shift rota.",
  });
  const alarming = ism({
    courseUnderstanding: "Not really sure what the course involves at all.",
    lastStudied: "Left school in 2009, has not studied since, fifteen years ago.",
    independentLearning: "No idea what that means.",
    educationExperience: "Hated school, was excluded twice.",
    strengthsWeaknesses: "Struggles with everything, no support at home, very anxious.",
    prioritiseWorkload: "Does not plan, leaves things to the last minute.",
    working: "Full-time, 45 hours a week on nights",
    teamworkExample: "Prefers to work alone, does not get on with people.",
  });

  const a = evaluate(input({ isms: [bland] }), {});
  const b = evaluate(input({ isms: [alarming] }), {});
  assert.deepEqual(a, b);
  assert.deepEqual(a.codes, []);
});

test('"Full-time" in `working` raises nothing, because the control is a free-text box', () => {
  // The most tempting field in the file, and the reason it is listed in PROSE_FIELDS with a
  // paragraph attached. The literature is clear that full-time work on a full-time course
  // raises withdrawal risk — but the ISM form renders `working` as `type: "text"`, and the
  // route copies whatever arrives with nothing but a trim. So the column holds "Full-time",
  // "ft", "yes 16 hours", "no" and "Not currently", and the substring test somebody will
  // reach for classifies the LAST of those as full time.
  for (const value of ["Full-time", "Full time", "FULL TIME", "Not full time", "ft, 45hrs"]) {
    const r = evaluate(input({ isms: [ism({ working: value })] }), {});
    assert.deepEqual(r.codes, [], value);
  }
});

test("`working` moves the answered COUNT and nothing else — presence, never content", () => {
  // The one permitted use of a prose field. `entryProfileAnswered` is a fact about how much
  // of the interview form was filled in; every other figure must be untouched by it.
  const blank = evaluate(input({ isms: [ism()] }), {});
  const filled = evaluate(input({ isms: [ism({ working: "Full-time" })] }), {});

  assert.equal(blank.entryProfileAnswered, 0);
  assert.equal(filled.entryProfileAnswered, 1);
  for (const key of FIGURES) {
    if (key === "entryProfileAnswered") continue;
    assert.deepEqual(filled[key], blank[key], key);
  }
});

test("the answered count is presence, not length — one character and an essay both count once", () => {
  const short = evaluate(input({ isms: [ism({ strengthsWeaknesses: "x" })] }), {});
  const long = evaluate(input({ isms: [ism({ strengthsWeaknesses: "y".repeat(4000) })] }), {});
  assert.equal(short.entryProfileAnswered, 1);
  assert.equal(long.entryProfileAnswered, 1);
});

test("a whitespace-only answer is absent, not answered", () => {
  // The route trims and stores null for an empty string, so this cannot arise through the
  // app — but a backfill, a fixture or a reshaped row can carry "   ", and counting it
  // would report a form as more complete than it is.
  const r = evaluate(input({ isms: [ism({ teamworkExample: "   \n\t " })] }), {});
  assert.equal(r.entryProfileAnswered, 0);
});

test("every prose field counts, and the denominator is the number of them", () => {
  const all = {};
  for (const f of PROSE_FIELDS) all[f] = "something";
  const r = evaluate(input({ isms: [ism(all)] }), {});
  assert.equal(r.entryProfileAnswered, PROSE_FIELDS.length);
  assert.equal(r.entryProfileQuestions, PROSE_FIELDS.length);
});

test("a sparse interview form is a FIGURE and never a code", () => {
  // How much an admissions officer typed is a fact about the interviewer, not about the
  // student — coverage.js's argument for never scoring staff practice. It would also fire
  // for a whole cohort at once at a college whose officers write briefly, and CLAUDE.md is
  // explicit that a signal firing cohort-wide is a figure rather than a caseload entry.
  const r = evaluate(input({ isms: [ism()] }), {});
  assert.equal(r.entryProfileAnswered, 0);
  assert.deepEqual(r.codes, []);
});

test("extra columns on the admission row — including EDI ones — change nothing", () => {
  // Belt and braces beside the text assertions above. If a caller over-selects, the values
  // must not reach any output. Passing them here is the only way to prove the module
  // ignores them at runtime rather than merely not mentioning them.
  const plain = evaluate(input({
    admissions: [adm({ idExpiryOn: daysAfter(30), idExpiryStatus: "parsed" })],
  }), {});
  const noisy = evaluate(input({
    admissions: [adm({
      idExpiryOn: daysAfter(30), idExpiryStatus: "parsed",
      ethnicity: "Prefer not to say", religion: "None",
      firstName: "Sam", surname: "Okafor", dob: "1998-04-02", niNumber: "QQ123456C",
      idDateOfExpiry: "12/05/2020",
      criminalConviction: "Yes", medicalConditions: "Yes", learningDifficulty: "Yes",
    })],
  }), {});
  assert.deepEqual(noisy, plain);
});

/* ========================================================================== */
/* The institution probes                                                     */
/* ========================================================================== */

test("entryProfile REFUSES to answer without an institution-wide probe result", () => {
  // CLAUDE.md records this as the most repeated bug in this area, got wrong three times:
  // "does this college record this at all" answered from the chunk in front of the code.
  // gather() runs on chunks of 200 and the incremental path often scores exactly one
  // student, at which size the question is invisible.
  //
  // The tripwires guards default to falsy and fall silent, which is right there — one code
  // does not fire. Here a missing flag would null the whole feature silently and
  // permanently, and because this module is EXPECTED to be silent everywhere until the link
  // backfill runs, "it produces nothing" is not a symptom anybody would investigate.
  assert.throws(() => entryProfile(ism(), undefined), /institution-wide/);
  assert.throws(() => entryProfile(ism(), {}), /institution-wide/);
  assert.throws(() => entryProfile(ism(), { institution: {} }), /institution-wide/);
});

test("rightToStudy refuses the same way, on its own flag", () => {
  assert.throws(() => rightToStudy(adm(), TODAY, undefined), /institution-wide/);
  assert.throws(() => rightToStudy(adm(), TODAY, { institution: {} }), /idExpiryRecorded/);
});

test("a truthy non-boolean probe is refused, not coerced", () => {
  // The shape somebody reaches for when wiring in a hurry: a count, or the result of a
  // findFirst. `if (institution.ismRecorded)` would accept all of these and be right by
  // accident for one; `0` and `null` would be silently read as "this college has no
  // interview data" and take the feature off the air for everybody.
  for (const bad of [1, 0, "yes", null, {}, []]) {
    assert.throws(() => entryProfile(ism(), { institution: { ismRecorded: bad } }), /boolean/);
  }
});

test("evaluate demands BOTH probes, and half a wiring throws rather than losing a family silently", () => {
  // The failure this prevents: a caller wires ismRecorded, forgets idExpiryRecorded, and
  // ships a build where the entry profile works and the right-to-study half is null for
  // every student at every college for ever, with nothing on any row looking wrong.
  assert.throws(() => evaluate(input({ institution: undefined }), {}), /institution-wide/);
  assert.throws(() => evaluate(input({ institution: { ismRecorded: true } }), {}), /idExpiryRecorded/);
  assert.throws(() => evaluate(input({ institution: { idExpiryRecorded: true } }), {}), /ismRecorded/);
  assert.throws(() => evaluate(input({ institution: { ismRecorded: 3, idExpiryRecorded: true } }), {}), /boolean/);
});

test("evaluate demands the probes even on the path where no helper is reached", () => {
  // A mutation run found this, and it is why evaluate's own assertion is not the ceremony
  // its comment first claimed it was.
  //
  // When BOTH picks are refused, evaluate short-circuits to the blank shapes and never
  // calls entryProfile() or rightToStudy(). Every probe assertion in the module lives
  // inside those two functions, so on this path — a caller who forgot the probe AND joined
  // on the wrong column, which is one careless wiring rather than two — a module with no
  // top-level assertion would return silently and the missing probe would never surface.
  //
  // So the guarantee evaluate() makes to its caller is "nothing is computed without a
  // probe", and it has to be made by evaluate() rather than inherited from whichever helper
  // a later refactor happens to call first.
  const unlinked = {
    today: TODAY,
    isms: [ism({ linkedStudentId: null })],
    admissions: [adm({ linkedStudentId: null })],
    weeksIntoProgramme: 1,
  };
  assert.throws(() => evaluate({ ...unlinked, institution: undefined }, {}), /institution-wide/);
  assert.throws(() => evaluate({ ...unlinked, institution: { ismRecorded: true } }, {}), /idExpiryRecorded/);
  assert.throws(() => evaluate({ ...unlinked, institution: { idExpiryRecorded: true } }, {}), /ismRecorded/);
});

test("the error message says what the probe has to COUNT, because the error is where it gets read", () => {
  // A probe of `count(Ism) > 0` is true at a college holding eight hundred interview
  // records of which zero are reachable from a Student — the backfill has not run and
  // nothing in the app writes linkedStudentId. Under that probe every student presents an
  // empty array and the screen says "never interviewed" about all of them. The message has
  // to name the linked condition or the next wiring author writes the naive count.
  assert.throws(() => entryProfile(ism(), { institution: {} }), /linkedStudentId is not null/);
  assert.throws(
    () => rightToStudy(adm(), TODAY, { institution: {} }),
    /non-null linkedStudentId AND a non-null idExpiryOn/,
  );
});

test("the probe cannot be overridden by the rows in front of the code", () => {
  // THE BUG THIS EXISTS TO PREVENT, stated as a test. A college that interviews on paper is
  // ismRecorded: false, and the presence of a fully-populated row for one student must not
  // talk the module into answering. If this ever passes by reading isms.length instead of
  // the flag, the guard has been reimplemented from the chunk and CLAUDE.md's three-times
  // bug is back.
  const r = evaluate(input({
    institution: NO_ISM,
    isms: [ism({ wifiAccess: "No", officeSkills: "No", admitted: "May Be" })],
  }), {});

  assert.deepEqual(r.codes, []);
  assert.equal(r.entryProfileRecorded, null);
  assert.equal(r.entryWifiAtHome, null);
  assert.equal(r.entryKnowsOfficeSoftware, null);
  assert.equal(r.entryAdmittedOutcome, null);
  assert.equal(r.entryProfileBarriers, null);
  assert.equal(r.entryProfileAnswered, null);
});

test("the expiry probe cannot be overridden either — an expired document at a non-parsing college says nothing", () => {
  const r = evaluate(input({
    institution: NO_EXPIRY,
    admissions: [adm({ idExpiryOn: daysBefore(10), idExpiryStatus: "confirmed" })],
  }), {});

  assert.deepEqual(r.codes, []);
  assert.equal(r.rightToStudyExpiresOn, null);
});

test("the two probes are independent — switching one off leaves the other working", () => {
  // A guard against a lazy implementation that ANDs the two flags together, which would
  // take the whole module off the air at a college that runs interviews but has never
  // parsed a document.
  const r = evaluate(input({
    institution: NO_EXPIRY,
    isms: [ism({ wifiAccess: "No" })],
    admissions: [adm({ idExpiryOn: daysBefore(10), idExpiryStatus: "parsed" })],
  }), {});

  assert.deepEqual(r.codes, [INTAKE.NO_WIFI]);
  assert.equal(r.rightToStudyExpiresOn, null);
});

/* ========================================================================== */
/* Trap one: no row means "we do not know"                                    */
/* ========================================================================== */

test("a student with no ISM and no admission produces NO code at all", () => {
  // THE COMMONEST CASE BY A LONG WAY, today and probably for years. Both tables hold zero
  // LINKED rows in both databases; most people with an Admission row never became students;
  // and a college that joined the platform mid-programme has students who predate the
  // admissions module entirely.
  const r = evaluate(input({ isms: [], admissions: [] }), {});
  assert.deepEqual(r.codes, []);
});

test("with nothing recorded, every figure is null EXCEPT entryProfileRecorded, which is false", () => {
  // The title and the assertions have to agree, so the exception is named in the title
  // rather than quietly asserted. `entryProfileRecorded: false` is a deliberate,
  // load-bearing exception: this college DOES interview, and this student has none.
  const r = evaluate(input({ isms: [], admissions: [] }), {});
  assert.equal(r.entryProfileRecorded, false);
  for (const key of FIGURES) {
    if (key === "entryProfileRecorded") continue;
    assert.equal(r[key], null, key);
  }
});

test("recorded is FALSE at an interviewing college and NULL at one that does not interview", () => {
  // The three states, and the reason the probe is not ceremony. Without it, "this student
  // was never interviewed" and "this college does not use the interview module" collapse
  // into one value, and the screen makes the first claim about every student in an
  // institution on the strength of a script nobody ran.
  assert.equal(evaluate(input({ isms: [] }), {}).entryProfileRecorded, false);
  assert.equal(evaluate(input({ isms: [], institution: NO_ISM }), {}).entryProfileRecorded, null);
});

test("no ISM is null, never zero — the counts are withheld too", () => {
  // Null means "not measurable"; zero means zero. `entryProfileAnswered: 0` would read on
  // the row as "we have their interview form and it is blank", and `entryProfileBarriers:
  // 0` as "we asked and they reported no barriers" — about a student nobody interviewed.
  const r = evaluate(input({ isms: [] }), {});
  assert.notEqual(r.entryProfileAnswered, 0);
  assert.notEqual(r.entryProfileBarriers, 0);
  assert.notEqual(r.entryProfileQuestions, 0);
});

test("having no interview record is a FIGURE and can never become a code", () => {
  // A college part-way through adopting the module has this true for a whole cohort at
  // once, and CLAUDE.md's rule is explicit: a hundred rows carrying an identical reason is
  // the same as no caseload.
  const r = evaluate(input({ isms: [], admissions: [] }), {});
  assert.equal(r.entryProfileRecorded, false);
  assert.deepEqual(r.codes, []);
});

test("an interview with every constrained answer missing raises nothing", () => {
  // A row exists, so `recorded` is true and `answered` is a real count — but nobody filled
  // in the two Yes/No questions or the outcome, and none of the three can be guessed.
  const r = evaluate(input({ isms: [ism({ courseUnderstanding: "keen" })] }), {});
  assert.deepEqual(r.codes, []);
  assert.equal(r.entryProfileRecorded, true);
  assert.equal(r.entryProfileAnswered, 1);
  assert.equal(r.entryWifiAtHome, null);
  assert.equal(r.entryKnowsOfficeSoftware, null);
  assert.equal(r.entryProfileBarriers, null);
});

/* ========================================================================== */
/* The linkage: the trap that matters most                                    */
/* ========================================================================== */

test("an ISM with no linkedStudentId is REFUSED, not measured", () => {
  // Ism reaches a Student only through Admission.linkedStudentId. A row arriving without
  // one is evidence the caller joined on something else — a typed college ID, a name — and
  // that join is wrong for every student who shares a surname with another. The row here
  // carries an answer that would otherwise fire, so a permissive implementation is caught
  // rather than merely unproven.
  const r = evaluate(input({
    isms: [ism({ linkedStudentId: null, wifiAccess: "No", admitted: "May Be" })],
  }), {});

  assert.deepEqual(r.codes, []);
  assert.equal(r.entryProfileRecorded, null);
  assert.equal(r.entryWifiAtHome, null);
});

test("an unlinked ISM is NULL rather than false — a bad join is not evidence of no interview", () => {
  // The subtler half. `recorded: false` would claim this student was never interviewed on
  // the strength of a join the module had just rejected, which is a finding manufactured
  // out of a caller's mistake.
  const r = evaluate(input({ isms: [ism({ linkedStudentId: null })] }), {});
  assert.equal(r.entryProfileRecorded, null);
  assert.notEqual(r.entryProfileRecorded, false);
});

test("an admission with no linkedStudentId is refused even when it carries an expired document", () => {
  // The worst single output this pipeline can produce is one person's immigration paperwork
  // on another person's screen. An unlinked row is refused outright.
  const r = evaluate(input({
    admissions: [adm({ linkedStudentId: null, idExpiryOn: daysBefore(5), idExpiryStatus: "confirmed" })],
  }), {});

  assert.deepEqual(r.codes, []);
  assert.equal(r.rightToStudyExpiresOn, null);
});

test("the TYPED college ID cannot stand in for the foreign key", () => {
  // The whole reason the schema carries two columns whose names are ugly on purpose.
  // `studentId` on Admission is a number an admin typed into a text box: no relation, no
  // constraint, no uniqueness, routinely blank or reused across intakes.
  const r = evaluate(input({
    admissions: [adm({
      linkedStudentId: null, studentId: "HND-2026-0041",
      idExpiryOn: daysBefore(5), idExpiryStatus: "parsed",
    })],
    isms: [ism({ linkedStudentId: null, studentId: "HND-2026-0041", wifiAccess: "No" })],
  }), {});

  assert.deepEqual(r.codes, []);
  assert.equal(r.rightToStudyExpiresOn, null);
  assert.equal(r.entryProfileRecorded, null);
});

test("ONE unlinked row refuses the WHOLE answer — it is not filtered down to the linked rest", () => {
  // The tempting fix is `isms.filter(r => r.linkedStudentId)`, which silently half-honours
  // a bad join and produces a plausible figure from it. registerCoverage makes the same
  // call for a mark with no sessionId: an unreconcilable input yields no figure at all.
  // The linked row here would otherwise fire two codes, so a filtering implementation is
  // caught rather than merely unproven.
  const r = evaluate(input({
    isms: [
      ism({ interviewDate: "2026-01-10", wifiAccess: "No", admitted: "May Be" }),
      ism({ linkedStudentId: null, interviewDate: "2026-01-11" }),
    ],
  }), {});

  assert.deepEqual(r.codes, []);
  assert.equal(r.entryProfileRecorded, null);
});

test("one unlinked admission refuses the whole right-to-study answer as well", () => {
  const r = evaluate(input({
    admissions: [
      adm({ idExpiryOn: daysAfter(20), idExpiryStatus: "parsed" }),
      adm({ linkedStudentId: null, idExpiryOn: daysAfter(900), idExpiryStatus: "parsed" }),
    ],
  }), {});

  assert.deepEqual(r.codes, []);
  assert.equal(r.rightToStudyExpiresOn, null);
});

test("an unlinked admission the pick would have DISCARDED still refuses the answer", () => {
  // A mutation run found this gap, and it is the difference between refusing and filtering.
  //
  // In the test above the unlinked row carries the LATEST expiry, so it wins the pick and
  // rightToStudy's own guard catches it — the picker's guard could be deleted and nothing
  // would notice. Here the unlinked row carries an OLDER expiry, so a picker that merely
  // ignored the link would quietly select the linked row, answer from it, and fire a code.
  //
  // That is the failure exactly: a bad join half-honoured. The presence of a row this
  // module cannot attribute is evidence about the CALLER, not about the row that happens to
  // sort first, and the whole answer goes.
  const r = evaluate(input({
    admissions: [
      adm({ idExpiryOn: daysAfter(20), idExpiryStatus: "parsed" }),
      adm({ linkedStudentId: null, idExpiryOn: daysBefore(500), idExpiryStatus: "parsed" }),
    ],
  }), {});

  assert.deepEqual(r.codes, []);
  assert.equal(r.rightToStudyExpiresOn, null);
});

test("rightToStudy repeats the usability gate when called directly", () => {
  // The same shape of gap the mutation run found on the link guard: pickAdmission filters
  // to usable rows, so through evaluate() the gate inside rightToStudy is never reached and
  // could be deleted unnoticed. It is exported, a later caller will hand it a row they
  // fetched themselves, and the row they fetch will be whatever the quarantine queue holds.
  const opts = { institution: BOTH };

  // A well-formed date the parser was not sure about.
  assert.equal(rightToStudy(adm({ idExpiryOn: daysBefore(2), idExpiryStatus: "ambiguous" }), TODAY, opts).expired, null);
  // A date nobody examined.
  assert.equal(rightToStudy(adm({ idExpiryOn: daysBefore(2), idExpiryStatus: null }), TODAY, opts).expiresOn, null);
  // The free-text shape that sorts as already expired.
  assert.equal(rightToStudy(adm({ idExpiryOn: "12/05/2027", idExpiryStatus: "parsed" }), TODAY, opts).expiresOn, null);
});

test("entryProfile and rightToStudy repeat the link guard when called directly", () => {
  // The pickers are not the only door. Both functions are exported and a later caller will
  // fetch a row themselves; a guarantee that depends on which helper a refactor happens to
  // call first is not a guarantee.
  const opts = { institution: BOTH };
  assert.equal(entryProfile(ism({ linkedStudentId: null, wifiAccess: "No" }), opts).recorded, null);
  assert.equal(
    rightToStudy(adm({ linkedStudentId: null, idExpiryOn: daysBefore(1), idExpiryStatus: "parsed" }), TODAY, opts).expiresOn,
    null,
  );
});

/* ========================================================================== */
/* Constrained answers: matched exactly, never guessed                        */
/* ========================================================================== */

test('only exactly "Yes" and "No" are read — no case folding, no trimming, no guessing', () => {
  // funding.classify's argument. The easy cases are not the ones that matter: "yes" is
  // trivially recoverable, and the strings that actually turn up are "N/A", "Sometimes" and
  // "Only at the library". Case folding would broaden the door for the harmless cases,
  // do nothing for the harmful ones, and teach the next reader that this guesses about a
  // value it is about to raise a code on.
  for (const value of ["no", "NO", "N", "n/a", "N/A", " No", "No ", "None", "Sometimes", "Only at the library"]) {
    const r = evaluate(input({ isms: [ism({ wifiAccess: value })] }), {});
    assert.deepEqual(r.codes, [], value);
    assert.equal(r.entryWifiAtHome, null, value);
  }
});

test('an unrecognised wifi answer is null, and specifically not read as "No"', () => {
  // The direction that matters. "Only at the library" is a student saying something real
  // and specific, and reading it as "No" would raise a code on an interpretation the module
  // is not entitled to make.
  const r = evaluate(input({ isms: [ism({ wifiAccess: "Only at the library" })] }), {});
  assert.equal(r.entryWifiAtHome, null);
  assert.notEqual(r.entryWifiAtHome, false);
});

test('"Yes" to both questions is a real answer: barriers 0, and no code', () => {
  // Zero here is not the forbidden zero. The questions were asked, both answers were
  // recognised, and neither named a barrier — that is a measurement, and it is exactly what
  // `null` would be lying about if this returned null instead.
  const r = evaluate(input({ isms: [ism({ wifiAccess: "Yes", officeSkills: "Yes" })] }), {});
  assert.equal(r.entryProfileBarriers, 0);
  assert.equal(r.entryWifiAtHome, true);
  assert.equal(r.entryKnowsOfficeSoftware, true);
  assert.deepEqual(r.codes, []);
});

test("both barriers named fires both codes and counts two", () => {
  const r = evaluate(input({ isms: [ism({ wifiAccess: "No", officeSkills: "No" })] }), {});
  assert.equal(r.entryProfileBarriers, 2);
  assert.deepEqual(r.codes.sort(), [INTAKE.DIGITAL_SKILLS, INTAKE.NO_WIFI].sort());
});

test("one recognised answer is enough for a count; neither is null", () => {
  const one = evaluate(input({ isms: [ism({ wifiAccess: "No" })] }), {});
  assert.equal(one.entryProfileBarriers, 1);

  const none = evaluate(input({ isms: [ism({ wifiAccess: "maybe", officeSkills: "" })] }), {});
  assert.equal(none.entryProfileBarriers, null);
});

test('only "May Be" raises a reservation — "Yes" and "No" both stay silent', () => {
  // "No" is deliberately not a finding. This student is enrolled, so an admissions
  // recommendation against them was superseded by a later decision taken with more
  // information, and re-raising it on a tutor's screen months afterwards would relitigate
  // an admissions outcome nobody asked this module to review.
  assert.deepEqual(evaluate(input({ isms: [ism({ admitted: ADMITTED.YES })] }), {}).codes, []);
  assert.deepEqual(evaluate(input({ isms: [ism({ admitted: ADMITTED.NO })] }), {}).codes, []);
  assert.deepEqual(evaluate(input({ isms: [ism({ admitted: ADMITTED.MAYBE })] }), {}).codes, [INTAKE.RESERVATION]);
});

test("an unrecognised admitted value is null and raises nothing", () => {
  for (const value of ["maybe", "MAY BE", "Maybe", "Deferred", "", "  "]) {
    const r = evaluate(input({ isms: [ism({ admitted: value })] }), {});
    assert.equal(r.entryAdmittedOutcome, null, value);
    assert.deepEqual(r.codes, [], value);
  }
});

test("the outcome is reported as its string, not flattened to a boolean", () => {
  // Three values, and the interesting one is the middle. A boolean would collapse "No" and
  // "May Be" together, which are opposite findings about the same student.
  assert.equal(evaluate(input({ isms: [ism({ admitted: "May Be" })] }), {}).entryAdmittedOutcome, "May Be");
  assert.equal(evaluate(input({ isms: [ism({ admitted: "Yes" })] }), {}).entryAdmittedOutcome, "Yes");
});

/* ========================================================================== */
/* Trap four: dates are strings, today is an argument, day-counts are derived  */
/* ========================================================================== */

test("evaluate returns no day-count and no rotting flag", () => {
  // THE STORE-DATES RULE, ASSERTED ON THE SHAPE RATHER THAN ON A VALUE. Nothing here runs
  // on a schedule — markStale() fires on data events and a day passing is not an event — so
  // "expires in 34 days" written to a column is wrong by tomorrow morning with nothing to
  // correct it. The sharper half is that `expired` and `expiringSoon` rot the same way:
  // both flip as the calendar moves with no event to flip them. Only the DATE is true for
  // ever, so only the date leaves.
  const r = evaluate(input({
    admissions: [adm({ idExpiryOn: daysBefore(3), idExpiryStatus: "parsed" })],
  }), {});

  assert.deepEqual(Object.keys(r).sort(), [...FIGURES, "codes"].sort());
  for (const key of Object.keys(r)) {
    assert.equal(/Days$|DayCount|Age$/.test(key), false, `${key} looks like a day count`);
    assert.equal(/Expired$|ExpiringSoon$/.test(key), false, `${key} rots by tomorrow`);
  }
});

test("the same fixture gives different codes on different days, because today is an argument", () => {
  // The proof that there is no clock: only the parameter moves.
  const admissions = [adm({ idExpiryOn: "2026-06-01", idExpiryStatus: "parsed" })];
  const far = evaluate(input({ today: "2026-01-01", admissions }), {});
  const near = evaluate(input({ today: "2026-05-01", admissions }), {});
  const after = evaluate(input({ today: "2026-06-02", admissions }), {});

  assert.deepEqual(far.codes, []);
  assert.deepEqual(near.codes, [INTAKE.ID_EXPIRING]);
  assert.deepEqual(after.codes, [INTAKE.ID_EXPIRED]);
  // And the stored figure never moved.
  assert.equal(far.rightToStudyExpiresOn, "2026-06-01");
  assert.equal(after.rightToStudyExpiresOn, "2026-06-01");
});

test('"12/05/2027" is refused rather than compared — it must NOT read as already expired', () => {
  // The exact failure the two-column schema exists to prevent, and the reason a string
  // comparison is not enough on its own. "12/05/2027" sorts BEFORE "2026-03-20", so a naive
  // `expiresOn < today` reads it as expired and puts a student on a compliance list over a
  // document that is good for another year.
  const r = evaluate(input({
    admissions: [adm({ idExpiryOn: "12/05/2027", idExpiryStatus: "parsed" })],
  }), {});
  assert.deepEqual(r.codes, []);
  assert.equal(r.rightToStudyExpiresOn, null);
});

test('"May 2027" is refused rather than compared — it must NOT read as never expiring', () => {
  // The mirror, and the more dangerous of the two: it sorts AFTER any ISO date, so a naive
  // comparison gives a false all-clear for ever.
  const r = evaluate(input({
    admissions: [adm({ idExpiryOn: "May 2027", idExpiryStatus: "parsed" })],
  }), {});
  assert.deepEqual(r.codes, []);
  assert.equal(r.rightToStudyExpiresOn, null);
});

test("every junk expiry shape is refused, including the ones that parse as a Date", () => {
  for (const value of ["N/A", "", "2027", "2027-13-01", "2026-02-30", "20260601", "2026-6-1", null, 20260601]) {
    const r = evaluate(input({ admissions: [adm({ idExpiryOn: value, idExpiryStatus: "parsed" })] }), {});
    assert.equal(r.rightToStudyExpiresOn, null, String(value));
    assert.deepEqual(r.codes, [], String(value));
  }
});

test("isIsoDate accepts a real ISO date and nothing else", () => {
  assert.equal(isIsoDate("2026-03-20"), true);
  assert.equal(isIsoDate("2026-02-29"), false);   // 2026 is not a leap year
  assert.equal(isIsoDate("2024-02-29"), true);
  assert.equal(isIsoDate("2026-03-20T00:00:00Z"), false);
  assert.equal(isIsoDate(undefined), false);
});

test("a malformed interviewDate is dropped rather than stored", () => {
  // The caller stores this and the client subtracts it. A junk value would reach the screen
  // and be arithmetic'd against.
  const r = evaluate(input({ isms: [ism({ interviewDate: "12/01/2026" })] }), {});
  assert.equal(r.entryProfileOn, null);
  assert.equal(r.entryProfileRecorded, true);   // the row is still real
});

test("an unparseable `today` yields the date but no judgement", () => {
  // The date is a fact about the record and does not depend on today at all, so it still
  // returns. Whether it has passed does depend, and cannot be answered — null, never false,
  // which would be an all-clear produced by a bad argument.
  const r = rightToStudy(
    adm({ idExpiryOn: "2026-06-01", idExpiryStatus: "parsed" }),
    "not-a-date",
    { institution: BOTH },
  );
  assert.equal(r.expiresOn, "2026-06-01");
  assert.equal(r.expired, null);
  assert.equal(r.expiringSoon, null);
});

/* ========================================================================== */
/* Right to study: the window, the trust rule and the ceiling                 */
/* ========================================================================== */

test("a document expiring TODAY has not expired", () => {
  // Wrong in the direction that ends a conversation badly. A passport is valid for the day
  // it expires on, and telling a student it expired that morning is both incorrect and the
  // sort of thing they remember.
  const r = rightToStudy(adm({ idExpiryOn: TODAY, idExpiryStatus: "parsed" }), TODAY, { institution: BOTH });
  assert.equal(r.expired, false);
  assert.equal(r.expiringSoon, true);
});

test("the warning window has both ends, and the boundary is inclusive", () => {
  const at = (n) => evaluate(input({
    admissions: [adm({ idExpiryOn: daysAfter(n), idExpiryStatus: "parsed" })],
  }), {}).codes;

  assert.deepEqual(at(INTAKE_DEFAULTS.idExpiryWarnDays), [INTAKE.ID_EXPIRING]);
  assert.deepEqual(at(INTAKE_DEFAULTS.idExpiryWarnDays + 1), []);
  assert.deepEqual(at(1), [INTAKE.ID_EXPIRING]);
  assert.deepEqual(at(0), [INTAKE.ID_EXPIRING]);
});

test("expired and expiring can never both be true", () => {
  // Asserted across the whole range rather than at one point, because the mutual exclusion
  // is what stops a later edit producing a row that says a document is both expiring and
  // expired — two codes describing the same date, which is unreadable on a screen.
  for (let n = -400; n <= 400; n += 7) {
    const r = rightToStudy(
      adm({ idExpiryOn: daysAfter(n), idExpiryStatus: "parsed" }),
      TODAY,
      { institution: BOTH },
    );
    assert.equal(r.expired === true && r.expiringSoon === true, false, String(n));
  }
});

test("an untrusted idExpiryStatus refuses the date, however well-formed it is", () => {
  // "ambiguous" and "unparseable" are the quarantine queue — the schema has a partial index
  // for exactly that query — and a date sitting on a row in either state is a parser's
  // working, not an answer.
  for (const status of ["ambiguous", "unparseable", "pending", "", "Parsed", "CONFIRMED"]) {
    const r = evaluate(input({
      admissions: [adm({ idExpiryOn: daysBefore(2), idExpiryStatus: status })],
    }), {});
    assert.equal(r.rightToStudyExpiresOn, null, status);
    assert.deepEqual(r.codes, [], status);
  }
});

test("a NULL status is untrusted too — not-yet-examined is not a licence", () => {
  // The strictest of the three conditions and the one that will look over-strict. Null means
  // "not yet examined". A date present with nobody having examined it is a row written
  // around the parser, and accepting it would make the status column decorative — the first
  // importer to write idExpiryOn straight from a spreadsheet would switch this on across a
  // whole college with no human having looked at a single document.
  const r = evaluate(input({
    admissions: [adm({ idExpiryOn: daysBefore(2), idExpiryStatus: null })],
  }), {});
  assert.equal(r.rightToStudyExpiresOn, null);
  assert.deepEqual(r.codes, []);
});

test('"confirmed" is trusted, because a human outranks a machine parse', () => {
  const r = evaluate(input({
    admissions: [adm({ idExpiryOn: daysBefore(2), idExpiryStatus: "confirmed" })],
  }), {});
  assert.deepEqual(r.codes, [INTAKE.ID_EXPIRED]);
  assert.equal(r.rightToStudyExpiresOn, daysBefore(2));
});

test("usableExpiry needs all three conditions and says so one at a time", () => {
  assert.equal(usableExpiry(adm({ idExpiryOn: "2026-06-01", idExpiryStatus: "parsed" })), true);
  assert.equal(usableExpiry(adm({ idExpiryOn: "2026-06-01", idExpiryStatus: "ambiguous" })), false);
  assert.equal(usableExpiry(adm({ idExpiryOn: "01/06/2026", idExpiryStatus: "parsed" })), false);
  assert.equal(usableExpiry(adm({ idExpiryOn: null, idExpiryStatus: "confirmed" })), false);
  assert.equal(usableExpiry(null), false);
});

test("a long-expired document keeps its DATE and its FACT, but leaves the caseload", () => {
  // THE CEILING, and the reason it costs nothing. `expired: true` stays true, because it is:
  // folding the window into rightToStudy would make it return "we looked, the document is in
  // date" about an expired one, which is a lie told to the next caller. What ages out is the
  // caseload code, and the stored date means a compliance list built on the column still
  // sees every expired document regardless of age.
  const admission = adm({ idExpiryOn: daysBefore(400), idExpiryStatus: "parsed" });

  const fact = rightToStudy(admission, TODAY, { institution: BOTH });
  assert.equal(fact.expired, true);

  const r = evaluate(input({ admissions: [admission] }), {});
  assert.deepEqual(r.codes, []);
  assert.equal(r.rightToStudyExpiresOn, daysBefore(400));
});

test("the expiry ceiling is inclusive at its boundary", () => {
  const at = (n) => evaluate(input({
    admissions: [adm({ idExpiryOn: daysBefore(n), idExpiryStatus: "parsed" })],
  }), {}).codes;

  assert.deepEqual(at(INTAKE_DEFAULTS.idExpiredCeilingDays), [INTAKE.ID_EXPIRED]);
  assert.deepEqual(at(INTAKE_DEFAULTS.idExpiredCeilingDays + 1), []);
  assert.deepEqual(at(1), [INTAKE.ID_EXPIRED]);
});

test("the windows are configurable, and the config actually reaches the comparison", () => {
  // A change-detector on the wiring rather than on the numbers: if a later refactor stops
  // spreading config over the defaults, these fall over while the default-valued tests above
  // stay green.
  const admissions = [adm({ idExpiryOn: daysAfter(120), idExpiryStatus: "parsed" })];
  assert.deepEqual(evaluate(input({ admissions }), {}).codes, []);
  assert.deepEqual(evaluate(input({ admissions }), { idExpiryWarnDays: 180 }).codes, [INTAKE.ID_EXPIRING]);

  const old = [adm({ idExpiryOn: daysBefore(400), idExpiryStatus: "parsed" })];
  assert.deepEqual(evaluate(input({ admissions: old }), {}).codes, []);
  assert.deepEqual(evaluate(input({ admissions: old }), { idExpiredCeilingDays: 500 }).codes, [INTAKE.ID_EXPIRED]);
});

/* ========================================================================== */
/* Trap six: the entry profile decays, and an unknown age never buys silence   */
/* ========================================================================== */

test("the entry profile fires in week one, which is the whole point of it", () => {
  // Every other module is structurally blind here: no register, no marks, no pastoral note,
  // no VLE trail. tripwires.js MUTES its codes in this window for exactly that reason. This
  // is the only layer that has anything to say, and the actions it names — a laptop loan, a
  // place on the IT induction, a check-in — are all things week one is for.
  const r = evaluate(input({
    weeksIntoProgramme: 0,
    isms: [ism({ wifiAccess: "No", officeSkills: "No", admitted: "May Be" })],
  }), {});
  assert.equal(r.codes.length, 3);
});

test("the entry profile stops being a caseload entry once the window closes", () => {
  // Nothing ever updates an Ism — it is written once at interview and no route re-asks the
  // questions — so without a ceiling a September answer sits on the row in the second year
  // with no event that could ever clear it. By then the college has a register, marks and a
  // pastoral record about what this student ACTUALLY did.
  const isms = [ism({ wifiAccess: "No", officeSkills: "No", admitted: "May Be" })];
  assert.deepEqual(evaluate(input({ weeksIntoProgramme: INTAKE_DEFAULTS.entryProfileWeeks, isms }), {}).codes, []);
  assert.deepEqual(evaluate(input({ weeksIntoProgramme: 90, isms }), {}).codes, []);
});

test("the window boundary is exclusive on the last week inside it", () => {
  const isms = [ism({ wifiAccess: "No" })];
  const inside = INTAKE_DEFAULTS.entryProfileWeeks - 1;
  assert.deepEqual(evaluate(input({ weeksIntoProgramme: inside, isms }), {}).codes, [INTAKE.NO_WIFI]);
  assert.deepEqual(evaluate(input({ weeksIntoProgramme: INTAKE_DEFAULTS.entryProfileWeeks, isms }), {}).codes, []);
});

test("an UNKNOWN programme age never buys silence — the codes still fire", () => {
  // Both halves of the same rule, stated so it covers a ceiling as well as a floor.
  // tripwires.js refuses to grant the settling-in GRACE to a student the calendar cannot
  // place, because muting every code for them fails safe in the wrong direction. Here the
  // grace runs the other way, so the same rule means the DECAY is not granted either.
  //
  // NaN is in the list on purpose: it is the shape a subtraction against a missing cohort
  // start date produces, and `weeks >= 12` is false for it, so a naive implementation
  // reaches the right answer by luck rather than by the isNum guard.
  //
  // AND "20" IS IN THE LIST FOR THE OPPOSITE REASON, which a mutation run found: every
  // other value here is falsy under a bare `weeks >= 12`, so dropping the isNum guard
  // passes them all. A STRING coerces, `"20" >= 12` is true, and a caller who handed this
  // a string would silently lose the codes for every student far enough into a programme.
  // Only this value discriminates between the guard and its absence.
  const isms = [ism({ wifiAccess: "No", officeSkills: "No", admitted: "May Be" })];
  for (const weeks of [null, undefined, NaN, "8", "20", {}]) {
    const r = evaluate(input({ weeksIntoProgramme: weeks, isms }), {});
    assert.equal(r.codes.length, 3, String(weeks));
  }
});

test("a NEGATIVE programme age does not close the window either", () => {
  // A student whose cohort starts next month. They have not begun, so the entry profile is
  // the only evidence there is — the mirror of the week-one case rather than an exception.
  const r = evaluate(input({
    weeksIntoProgramme: -2,
    isms: [ism({ wifiAccess: "No" })],
  }), {});
  assert.deepEqual(r.codes, [INTAKE.NO_WIFI]);
});

test("the decay does NOT touch the right-to-study codes, in year two or ever", () => {
  // Both graces in this family exist for codes that fire on the ABSENCE of a record about a
  // student nobody has had time to observe. These fire on the PRESENCE of a date, which is
  // as true in year two as in week one — and a visa expiring in the second year of a
  // two-year programme is the case the whole signal exists for.
  const r = evaluate(input({
    weeksIntoProgramme: 200,
    isms: [ism({ wifiAccess: "No" })],
    admissions: [adm({ idExpiryOn: daysAfter(30), idExpiryStatus: "parsed" })],
  }), {});
  assert.deepEqual(r.codes, [INTAKE.ID_EXPIRING]);
});

test("the decay window suppresses codes without suppressing the figures", () => {
  // The figures are what the screen shows and what a later appeal reads; only the CASELOAD
  // entry ages out. Blanking the figures would delete the college's record of what the
  // student said, which is the opposite of what a decay window is for.
  const r = evaluate(input({
    weeksIntoProgramme: 80,
    isms: [ism({ wifiAccess: "No", officeSkills: "No", admitted: "May Be" })],
  }), {});
  assert.deepEqual(r.codes, []);
  assert.equal(r.entryWifiAtHome, false);
  assert.equal(r.entryKnowsOfficeSoftware, false);
  assert.equal(r.entryAdmittedOutcome, "May Be");
  assert.equal(r.entryProfileBarriers, 2);
});

/* ========================================================================== */
/* Choosing which row to read                                                 */
/* ========================================================================== */

test("with two dated interviews the LATER one is read", () => {
  // A re-interview on readmission supersedes the first. Reading the older one would report
  // a reservation somebody has since resolved.
  const r = evaluate(input({
    isms: [
      ism({ interviewDate: "2025-06-01", admitted: "May Be", wifiAccess: "No" }),
      ism({ interviewDate: "2026-01-04", admitted: "Yes", wifiAccess: "Yes" }),
    ],
  }), {});
  assert.deepEqual(r.codes, []);
  assert.equal(r.entryProfileOn, "2026-01-04");
  assert.equal(r.entryAdmittedOutcome, "Yes");
});

test("the later interview wins regardless of the order the rows arrive in", () => {
  // gather() groups rows from a query with no ORDER BY, so arrival order is whatever
  // Postgres returned. A pick that depended on it would give two different students two
  // different answers from identical data.
  const a = ism({ interviewDate: "2025-06-01", admitted: "May Be" });
  const b = ism({ interviewDate: "2026-01-04", admitted: "Yes" });
  assert.deepEqual(evaluate(input({ isms: [a, b] }), {}), evaluate(input({ isms: [b, a] }), {}));
});

test("two interviews that cannot be ordered are REFUSED, not guessed between", () => {
  // Same date, no date, or one of each. The two rows may carry opposite outcomes, and
  // picking isms[0] would make the answer depend on the order Postgres returned them in —
  // attendanceShape's sort comment, with a worse consequence.
  const pairs = [
    [ism({ interviewDate: "2026-01-04", admitted: "May Be" }), ism({ interviewDate: "2026-01-04", admitted: "Yes" })],
    [ism({ interviewDate: null, admitted: "May Be" }), ism({ interviewDate: null, admitted: "Yes" })],
    [ism({ interviewDate: "2026-01-04", admitted: "May Be" }), ism({ interviewDate: null, admitted: "Yes" })],
  ];
  for (const isms of pairs) {
    const r = evaluate(input({ isms }), {});
    assert.deepEqual(r.codes, []);
    assert.equal(r.entryProfileRecorded, null);
  }
});

test("a single UNDATED interview is still read — one row cannot be mis-ordered", () => {
  // The refusal above is about ordering, not about dates being mandatory. A college that
  // leaves the date blank still has one interview record, and there is nothing to confuse
  // it with.
  const r = evaluate(input({ isms: [ism({ interviewDate: null, wifiAccess: "No" })] }), {});
  assert.deepEqual(r.codes, [INTAKE.NO_WIFI]);
  assert.equal(r.entryProfileOn, null);
  assert.equal(r.entryProfileRecorded, true);
});

test("pickInterview separates 'no rows' from 'refused'", () => {
  // Two very different answers that a single null would collapse: one is a student with no
  // interview, the other is a caller whose join this module rejected.
  assert.deepEqual(pickInterview([]), { row: null, refused: false });
  assert.deepEqual(pickInterview(undefined), { row: null, refused: false });
  assert.equal(pickInterview([ism({ linkedStudentId: null })]).refused, true);
});

test("with two admissions the LATER expiry binds — a renewal, not a stale row", () => {
  // Both rows carry a transcription of the SAME person's document, taken at two moments, so
  // the later expiry is the later document. Reporting the earlier one would raise an expiry
  // the student has already replaced, with the evidence of its own wrongness sitting in the
  // same array.
  const r = evaluate(input({
    admissions: [
      adm({ idExpiryOn: daysBefore(30), idExpiryStatus: "parsed" }),
      adm({ idExpiryOn: daysAfter(900), idExpiryStatus: "parsed" }),
    ],
  }), {});
  assert.deepEqual(r.codes, []);
  assert.equal(r.rightToStudyExpiresOn, daysAfter(900));
});

test("an admission with no usable expiry leaves both sides rather than counting as no expiry", () => {
  const r = evaluate(input({
    admissions: [
      adm({ idExpiryOn: null, idExpiryStatus: null }),
      adm({ idExpiryOn: daysBefore(2), idExpiryStatus: "parsed" }),
    ],
  }), {});
  assert.deepEqual(r.codes, [INTAKE.ID_EXPIRED]);
  assert.equal(r.rightToStudyExpiresOn, daysBefore(2));
});

test("admissions with no usable expiry at all yield nothing, not a refusal", () => {
  const picked = pickAdmission([adm(), adm()]);
  assert.equal(picked.refused, false);
  assert.equal(picked.row, null);
  assert.equal(picked.seen, 2);
});

/* ========================================================================== */
/* Both halves together                                                       */
/* ========================================================================== */

test("the two families are independent — one silent half does not silence the other", () => {
  const r = evaluate(input({
    isms: [ism({ wifiAccess: "No" })],
    admissions: [adm({ idExpiryOn: daysAfter(10), idExpiryStatus: "parsed" })],
  }), {});
  assert.deepEqual(r.codes.sort(), [INTAKE.ID_EXPIRING, INTAKE.NO_WIFI].sort());
});

test("every code evaluate can emit is a member of the declared vocabulary", () => {
  // A code emitted but not exported would never reach the disjointness check in
  // schema-contract.test.js, so a later collision would ship unnoticed.
  const r = evaluate(input({
    weeksIntoProgramme: 1,
    isms: [ism({ wifiAccess: "No", officeSkills: "No", admitted: "May Be" })],
    admissions: [adm({ idExpiryOn: daysBefore(5), idExpiryStatus: "parsed" })],
  }), {});
  assert.equal(r.codes.length, 4);
  for (const code of r.codes) assert.ok(INTAKE_CODES.includes(code), code);
  assert.equal(new Set(r.codes).size, r.codes.length);
});

test("no input this module accepts can make it raise a code from an ABSENCE", () => {
  // THE INVARIANT funding.js established and this module inherits: every code fires on the
  // PRESENCE of a recorded value. A blank row, a default, a missing table and an
  // unconfigured college are all indistinguishable from a student who never existed, and
  // none of them can raise anything. Any sixth code added later has to satisfy this.
  const empties = [
    input({ isms: [], admissions: [] }),
    input({ isms: [ism()], admissions: [adm()] }),
    input({ isms: [ism()], admissions: [adm()], institution: NO_ISM }),
    input({ isms: [ism()], admissions: [adm()], institution: NO_EXPIRY }),
    input({ isms: [ism({ linkedStudentId: null })], admissions: [adm({ linkedStudentId: null })] }),
    input({ isms: undefined, admissions: undefined }),
    input({ weeksIntoProgramme: null }),
  ];
  for (const raw of empties) assert.deepEqual(evaluate(raw, {}).codes, []);
});

test("the defaults are the documented ones and are all positive finite numbers", () => {
  // A config key nothing reads is worse than no key at all (settings.js), so the three that
  // exist are asserted to exist. The values are named in the module's own comments and each
  // has an argument attached; changing one should require changing this line and reading it.
  assert.deepEqual(Object.keys(INTAKE_DEFAULTS).sort(), [
    "entryProfileWeeks", "idExpiredCeilingDays", "idExpiryWarnDays",
  ]);
  for (const [k, v] of Object.entries(INTAKE_DEFAULTS)) {
    assert.ok(Number.isFinite(v) && v > 0, `${k} is not a positive number`);
  }
});

test("assertInstitutionProbe names the function it was called from", () => {
  // The message is the only thing a wiring author reliably reads, and "which probe, in which
  // function" is what they need.
  assert.throws(() => assertInstitutionProbe({}, "somewhereElse", ["ismRecorded"]), /somewhereElse/);
});
