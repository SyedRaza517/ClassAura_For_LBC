// Intake: what did this student tell us about themselves before they started, and does
// their right to study run out during the course?
//
// PURE. No database, no clock, no tenant. Everything arrives as arguments, today's date
// included — the same seam as tripwires.js, coverage.js, funding.js and engine.js, and
// for the same reason: these are lines a college will be asked to defend, in front of a
// student and sometimes in front of a regulator, so they have to be checkable without
// standing up an institution's worth of fixtures.
//
// WHY THIS LAYER EXISTS AT ALL, AND WHY IT IS THE ONLY ONE THAT SPEAKS IN WEEK ONE.
//
// Every other module in this family reads something the college observed AFTER the
// student arrived: a register, a mark, a pastoral note, a VLE access, a finance queue.
// In week one none of those exist. The settling-in exemption in tripwires.js exists
// precisely because they do not — a caseload built from silence in week one contains the
// whole intake, which is the same as no caseload.
//
// So the pipeline is structurally blind in exactly the fortnight where withdrawal risk is
// highest and where an intervention is cheapest. This module is what fills that window,
// and it can only do it by reading what the student told the college BEFORE they started:
// the Intention to Study Meeting (Ism), a pre-entry self-assessment an admissions officer
// transcribes at interview.
//
// The two answers this module is prepared to act on — "I have no wifi at home" and "I have
// never used Word or PowerPoint" — are also the two most ACTIONABLE facts on the screen.
// A laptop loan, a dongle, a timetabled library slot, a place on the IT induction: all of
// them can be arranged in week one, by an administrator, without a tutor's caseload
// meeting. That is the test CLAUDE.md sets for this whole feature — prediction without a
// named next step changes no outcomes.
//
// AND THE SECOND FAMILY, WHICH IS NOT A PREDICTION AT ALL.
//
// A student whose passport, BRP or visa expires in the middle of their course cannot
// lawfully continue on it, and the college has a duty to notice BEFORE the date rather
// than after. That is a compliance fact with a deadline, and it is the one thing in this
// pipeline where the college's failure to look is itself the harm. It lives here rather
// than in its own file because it comes off the SAME table by the SAME linkage as the
// entry profile, and a second module repeating the linkage argument below would be a
// second place for that argument to rot.
//
// ────────────────────────────────────────────────────────────────────────────────────
// THE LINKAGE. READ THIS BEFORE CHANGING ANYTHING IN THIS FILE.
// ────────────────────────────────────────────────────────────────────────────────────
//
// The join from a prediction row back to an application is:
//
//     Student.id  ←  Admission.linkedStudentId          (a FOREIGN KEY)
//     Admission.id ←  Ism.admissionId                   (a FOREIGN KEY)
//
// and there is NO OTHER ACCEPTABLE PATH. In particular:
//
//   * `Admission.studentId` is NOT that. It is a college student number an admin TYPED
//     into a text box. It is a String with no relation, no constraint and no uniqueness,
//     it is used to name a SharePoint folder, and it is routinely blank, mistyped, or
//     reused across intakes. The schema comment on `linkedStudent` says the two names are
//     ugly on purpose, and it names this exact failure: "two columns called studentId on
//     one table, one a foreign key and one a typed label, is how somebody later attaches
//     the wrong person's document expiry to a student."
//
//   * `firstName` / `surname` / `email` / `dob` are not it either, and they are what a
//     caller in a hurry reaches for when the backfill has not run. Matching on a name is
//     wrong for every student who shares a surname with another, and at a college running
//     one course with two intakes a year that is not a rare event.
//
// GETTING THIS WRONG IS NOT A BUG. It attaches one person's immigration document expiry,
// or one person's interview record, to a different person; it renders that on a screen a
// member of staff acts on; and it stores it in a prediction history row that outlives the
// screen. That is inaccurate personal data about an identified individual, concerning
// immigration status, driving a decision. The migration that added `linkedStudentId` says
// the same thing in the same words and deliberately declines to populate the column,
// because the backfill is a dry-run-first, human-read step.
//
// So this module REFUSES rather than filters. A row that arrives without a
// `linkedStudentId` is not dropped from the set — it is evidence that the caller matched
// on something else, and the whole answer is withheld. Filtering would silently
// half-honour a bad join and produce a plausible figure from it. `fundingState` takes the
// identical decision for the identical reason, and `registerCoverage` does it for a mark
// with no `sessionId`.
//
// ────────────────────────────────────────────────────────────────────────────────────
// HARD RULE: THIS MODULE NEVER READS A PROTECTED CHARACTERISTIC, AND NEVER SCORES PROSE.
// ────────────────────────────────────────────────────────────────────────────────────
//
// `Admission` carries `ethnicity` and `religion` under an "EDI" heading. They are
// collected for equality monitoring — an aggregate, published, statutory purpose — and
// they are special category data under Article 9. This module does not read them, must
// never appear in a select that fetches them, and must never emit anything derived from
// them. There is no threshold, no configuration flag and no per-tenant setting that turns
// that on. A progression signal that moves with a student's ethnicity or religion is
// unlawful discrimination dressed as analytics, and the fact that a model could find a
// correlation in the data is the argument AGAINST reading them, not for it.
//
// The same rule, one step softer, covers the free-text answers. Seven of the eleven ISM
// questions are prose the interviewer typed: `courseUnderstanding`, `lastStudied`,
// `independentLearning`, `educationExperience`, `strengthsWeaknesses`,
// `prioritiseWorkload`, `teamworkExample` — and `working`, which the label frames as
// "Part-time / Full-time" but which the form renders as a plain TEXT INPUT, so it holds
// "no", "N/A", "20 hrs at a restaurant", "Full time (but leaving in Oct)".
//
// Inferring risk from any of that is refused, for four reasons and any one of them would
// be enough:
//
//   1. IT IS UNACCOUNTABLE TO THE STUDENT IT IS ABOUT. "The system rated your answer
//      about independent learning as weak" is not a sentence anybody can defend at an
//      appeal, because there is no rule to point at and no way for the student to have
//      answered differently.
//
//   2. IT IS NOT THE STUDENT'S WRITING. It is an admissions officer's paraphrase, typed
//      at speed during an interview. A terse transcriber would systematically produce
//      "weaker" students than a verbose one, and the signal would be measuring staff.
//
//   3. THE OBVIOUS KEYWORD RULES ARE WRONG IN THE OBVIOUS WAY. A substring test for
//      "full" on `working` classifies "Not full time" as full time, and one for "years"
//      on `lastStudied` reads "studied for 3 years, finished last June" as a long gap.
//      Every cheap version of this is a confidently wrong answer rather than an error.
//
//   4. IT WOULD LEAK PROTECTED CHARACTERISTICS BACK IN THROUGH THE SIDE DOOR. Prose about
//      caring responsibilities, a disability, a religious observance or an immigration
//      history is exactly what these questions elicit, and a keyword model over them is a
//      model of those characteristics with the audit trail removed.
//
// So the prose fields are reduced to PRESENT or ABSENT and nothing else — a count of how
// many questions carry any answer at all, which is a fact about the completeness of the
// FORM. Only `wifiAccess` and `officeSkills` ("Yes" | "No") and `admitted`
// ("Yes" | "No" | "May Be") have constrained values, and only those three are reduced to
// figures a code can be built on.
//
// ────────────────────────────────────────────────────────────────────────────────────
// NO ROW MEANS "WE DO NOT KNOW". NEVER "NO RISK", NEVER "HIGH RISK".
// ────────────────────────────────────────────────────────────────────────────────────
//
// Both tables are EMPTY of linked rows in both databases today, and that is the ordinary
// state rather than a fault:
//
//   * most people with an `Admission` row never became students — they were rejected, they
//     withdrew, or they went somewhere else;
//   * `linkedStudentId` is populated by a backfill that has not been run, and nothing in
//     the app writes it, so no `Admission` is reachable from a `Student` yet;
//   * a college that started using this platform mid-programme has students who enrolled
//     before the admissions module existed and will never have an application row;
//   * the ISM is one college's interview form. A college that interviews on paper, or does
//     not interview at all, has no `Ism` rows and is not doing anything wrong.
//
// So absence produces `null` everywhere and raises nothing. Not `false`, which reads on a
// screen as "we checked"; not `0`, which reads as a measurement. That is CLAUDE.md's
// null-is-not-zero rule, and here it is also the difference between "this student has no
// wifi" and "nobody asked this student about wifi".
//
// ────────────────────────────────────────────────────────────────────────────────────
// WHY THE CODES ARE NAMESPACED `TRIP_`, AND WHY EVERY ONE OF THEM ALSO SAYS `INTAKE`.
// ────────────────────────────────────────────────────────────────────────────────────
//
// They are appended to `riskDriverCodes`, the same array engine.js fills from its six RED
// indicators. `redIndicatorCount` — the input to OVR-004, which can worsen a band — is
// derived by engine.js from its own internal `reds` array, and `riskDriverCodes` is a copy
// taken afterwards, so appending here provably cannot reach the override. The prefix is
// what keeps that visible: a code named `RED_`-anything would read as the engine's own,
// and the next person to take a count off the copy would silently wire a student's
// immigration paperwork into their risk band. Keep the prefix; keep the count off the copy.
//
// The second segment (`INTAKE_`) names the MODULE rather than the topic, and that is
// deliberate. Seven files now write into one column. A member of staff looking at
// `TRIP_INTAKE_ID_EXPIRED` on a screen and wanting to argue with it needs to know which
// file decided it; a code named `TRIP_ID_EXPIRED` tells them nothing about where to go.
// It also makes collision with the six existing vocabularies impossible by construction
// rather than by a test that happens to be green today.
//
// AND A NOTE ON WORDING, WHICH IS NOT DECORATION. An expired document is a fact about
// PAPERWORK, not a judgement about a person. The client wording for these codes must read
// "the identity document on file expired on 4 March — check whether a renewal has been
// provided" and must never read "this student has no right to study", which is a legal
// conclusion this module has not made and is not equipped to make. Same for the entry
// profile: "no home internet recorded at interview — offer a laptop loan" is a sentence
// about a resource the college can supply. "Digitally excluded" is a label applied to a
// person, and it would follow them through a stored history row for two years.
//
// ────────────────────────────────────────────────────────────────────────────────────
// STORE DATES; DERIVE DAY-COUNTS AT RENDER TIME.
// ────────────────────────────────────────────────────────────────────────────────────
//
// Nothing in this feature runs on a schedule — `markStale()` fires on data events, and a
// day passing is not an event. So `expiresOn` and `interviewOn` are what a caller stores,
// and they are true for ever. "Expires in 34 days" is wrong by tomorrow morning with
// nothing to correct it.
//
// The sharper version, and it is easy to miss: `expired` and `expiringSoon` ROT THE SAME
// WAY. Both flip from false to true as the calendar moves, with nothing to flip them, so
// neither is returned by `evaluate()` as a stored figure. They exist as a snapshot on the
// codes — which is exactly what tripwires.js says codes are, "a snapshot of what was true
// at calculation time" — and the screen derives freshness from the date.
const isNum = (n) => typeof n === "number" && Number.isFinite(n);

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

// Stored in StudentPredictionCurrent.riskDriverCodes and in every history row, so these
// strings outlive several rewrites of the screen. Structured codes, never display text —
// the client maps them to wording, and rewording must not orphan a stored row.
//
// FIVE CODES, AND EVERY ONE FIRES ON THE PRESENCE OF A RECORDED VALUE. Not one fires on
// an absence, on a blank, or on a column's default. That is the invariant funding.js
// established and it is what makes a module reading pre-entry data safe to put on a
// screen: a student nobody interviewed and a student with no application row are
// indistinguishable from a student who never existed, and none of them can raise anything.
// Any sixth code added later has to satisfy it.
const INTAKE = {
  // THE STUDENT SAID, AT INTERVIEW, THAT THEY HAVE NO INTERNET AT HOME.
  //
  // About a RESOURCE, and the action is to supply it: a laptop loan, a mobile dongle, a
  // timetabled library slot, a paper alternative for the first assignment. It is the
  // single most actionable thing on this screen in week one and it is invisible to every
  // other module, because a student with no internet looks identical to an engaged one
  // until the first online submission is due.
  NO_WIFI: "TRIP_INTAKE_NO_WIFI",
  // THE STUDENT SAID THEY DO NOT KNOW HOW TO USE WORD OR POWERPOINT.
  //
  // Also about a resource — a place on the IT induction, an hour with a learning support
  // assistant — and it is a self-report of a SKILL GAP the college teaches, not a
  // character judgement. A student who says this is telling the truth about something
  // they came here to fix.
  DIGITAL_SKILLS: "TRIP_INTAKE_DIGITAL_SKILLS",
  // THE INTERVIEWER RECORDED A RESERVATION AND THE STUDENT ENROLLED ANYWAY.
  //
  // `admitted: "May Be"` is a qualified human's documented doubt at the point of entry,
  // and the student is here, so somebody overrode it or the doubt was resolved off the
  // record. Surfaced rather than scored, exactly as TRIP_TUTOR_AT_RISK surfaces a tutor's
  // "At Risk": when a human judgement and a number disagree, the disagreement should be
  // visible rather than averaged into invisibility. The action is a check-in, not a flag.
  RESERVATION: "TRIP_INTAKE_RESERVATION",
  // THE IDENTITY DOCUMENT ON FILE EXPIRES SOON.
  //
  // A DEADLINE, not a risk score. It is the only code in this family with a date the
  // college must beat, and it is the one that has to fire EARLY enough to be acted on —
  // renewals take weeks.
  ID_EXPIRING: "TRIP_INTAKE_ID_EXPIRING",
  // THE IDENTITY DOCUMENT ON FILE HAS ALREADY EXPIRED.
  //
  // About the RECORD. The commonest true explanation is that the student renewed and
  // nobody updated an admissions row that stops being maintained the day they enrol —
  // which is why the wording must ask, not assert. See `idExpiredCeilingDays` for what
  // happens to a very old one.
  ID_EXPIRED: "TRIP_INTAKE_ID_EXPIRED",
};

const INTAKE_CODES = Object.values(INTAKE);

// THE ONE CONSTRAINED ANSWER THAT IS NOT A YES/NO, kept as a named vocabulary rather than
// as three string literals scattered through the file. `Ism.admitted` is "Yes" | "No" |
// "May Be", the client renders it as a <select> with exactly those options, and
// `Admission.ismOutcome` mirrors it.
const ADMITTED = {
  YES: "Yes",
  NO: "No",
  MAYBE: "May Be",
};

const ADMITTED_VALUES = new Set(Object.values(ADMITTED));

// THE PROSE QUESTIONS, LISTED SO THAT THE ONE PERMITTED USE OF THEM IS EXPLICIT.
//
// This array exists to be COUNTED, never read. It is the denominator of "how much of the
// interview form was filled in", and the presence test below looks only at whether a
// string has any non-whitespace content.
//
// `working` is in this list and that will look like an oversight to whoever reads the
// label — "Are you working? Part-time / Full-time" is exactly the risk factor the
// literature names, and a student in full-time employment on a full-time course is at
// real elevated risk of withdrawal. It is here anyway because the FORM CONTROL IS A PLAIN
// TEXT INPUT (see ISM_FIELDS in client/src/StaffHub.jsx: `type: "text"`, no options), and
// the route's `pick()` copies whatever arrives with nothing but a trim and a 5000-character
// cap. So the column holds "Full-time", "ft", "yes 16 hours", "no", "N/A" and "Not
// currently" — and the substring test somebody will reach for classifies "Not full time"
// as full time.
//
// The right fix is a <select> on the form and a migration, at which point `working`
// becomes a constrained field and moves out of this list into a figure. Guessing at the
// prose in the meantime would produce a confidently wrong answer about somebody's
// employment, which is one of the more humiliating things this screen could get wrong.
const PROSE_FIELDS = [
  "courseUnderstanding",
  "lastStudied",
  "independentLearning",
  "educationExperience",
  "strengthsWeaknesses",
  "prioritiseWorkload",
  "working",
  "teamworkExample",
];

// The `idExpiryStatus` values a parsed date may be trusted under. See `usableExpiry()`.
const TRUSTED_EXPIRY_STATUS = new Set(["parsed", "confirmed"]);

/* -------------------------------------------------------------------------- */
/* Constants, and the arguments for them                                       */
/* -------------------------------------------------------------------------- */

// Platform defaults in the shape settings.js uses: defaults in code, overridden by
// whatever the caller merges over them. Deliberately NOT added to settings.js here —
// wiring is a separate change, and settings.js makes the argument that a config key
// nothing reads is worse than no key at all, because somebody will believe they have
// configured something. Every function takes an `opts`/`config` spread OVER these, so the
// day they move into DEFAULTS the callers do not change.
const INTAKE_DEFAULTS = {
  // HOW LONG THE ENTRY PROFILE REMAINS A CASELOAD FINDING. Twelve weeks — one teaching
  // term.
  //
  // THIS RUNS THE OPPOSITE WAY FROM `settlingInWeeks`, AND THAT IS THE WHOLE POINT.
  //
  // `settlingInWeeks` (3) is a FLOOR. It mutes codes that fire on the ABSENCE of a record,
  // because in week one nobody has attendance history, a mark or a pastoral note, and a
  // caseload containing the whole intake is the same as no caseload.
  //
  // Every code in the entry-profile half of this file fires on the PRESENCE of something a
  // student said before they arrived, and its value is at its MAXIMUM in week one — that
  // is the only window in which it is the only evidence there is. Muting it there would
  // switch the signal off in precisely the fortnight it exists for. So the window OPENS at
  // week zero and CLOSES later, which is a ceiling rather than a floor.
  //
  // WHY IT MUST CLOSE AT ALL, which is the half that is easy to skip. Nothing ever updates
  // an `Ism`: it is written once at interview, the admissions screens stop being touched
  // the day somebody enrols, and no route re-asks the questions. So a "no wifi" answer
  // given in September is still on the row in the second year of the programme, with no
  // event that could ever clear it — the same monotonic pile `unansweredQueryCeilingDays`
  // and `refusedWindowDays` exist to prevent, and a permanently lit column is one staff
  // scroll past. By week twelve the college has a register, marks, a VLE trail and a
  // pastoral record about this actual student, and a self-assessment made before they
  // arrived has been superseded by observation of what they actually did.
  //
  // Twelve rather than three: a term is roughly twelve teaching weeks, and the codes here
  // name an action (a laptop, an induction, a check-in) that a college has a term to
  // arrange. Three would close the window before a first-term timetable has settled.
  entryProfileWeeks: 12,

  // HOW FAR AHEAD AN EXPIRY IS WORTH SAYING. Ninety days.
  //
  // The constraint is not "when does it stop being true" — an expiry date is true from the
  // moment it is recorded — but "how much notice does the college need for the warning to
  // be an intervention rather than a report". Renewing a passport, a BRP or a visa needs
  // an appointment, documents, a fee and a processing queue, and the college's own part
  // (checking, copying, chasing, escalating to a compliance officer) sits on top of that.
  // Weeks, not days.
  //
  // Ninety days is a teaching term of notice: long enough that the student can start the
  // process and the college can chase it twice, short enough that the code is not lit for
  // most of a two-year programme. It is the same order of magnitude as funding.js's
  // `refusedWindowDays` being an academic year, and it is chosen structurally rather than
  // from any published Home Office turnaround, which varies by route and by year and which
  // this file has no business asserting as a constant.
  idExpiryWarnDays: 90,

  // HOW LONG AN EXPIRY THAT HAS ALREADY PASSED REMAINS A CASELOAD FINDING. A year.
  //
  // THIS IS THE UNCOMFORTABLE CONSTANT AND BOTH SIDES DESERVE STATING.
  //
  // A date in the past does not mean the student's document has expired. It means the
  // ADMISSIONS RECORD says so, and that record stops being maintained the day the
  // applicant becomes a student: nothing in the app edits an `Admission` afterwards, no
  // route re-reads the document, and a renewal is filed with a registry or a compliance
  // officer somewhere else entirely. So the commonest true reading of a two-year-old
  // expiry on a student who is still enrolled and still being scored is "they renewed and
  // this row was never updated".
  //
  // Against that: if it has NOT been renewed, this is a serious compliance failure and
  // silence is the wrong answer. The reason the window still wins is that nothing is
  // actually lost by it. `rightToStudyExpiresOn` is STORED and is true for ever, so a
  // compliance list built on the column sees every expired document regardless of age.
  // What ages out is only the CASELOAD CODE — the row on a tutor's ten-minute
  // pre-tutorial screen — and a code that can never clear is one that stops being read,
  // taking the recent expiries with it.
  //
  // A year, matching `refusedWindowDays`, on the same argument: a student still enrolled a
  // full academic year after the recorded date is evidence — the only evidence this table
  // can offer — that it was resolved some other way, because there is no "renewed" status
  // for anybody to have written.
  idExpiredCeilingDays: 365,
};

/* -------------------------------------------------------------------------- */
/* Dates                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Whether a value is a real YYYY-MM-DD date.
 *
 * THIS IS A LOAD-BEARING GUARD, NOT A TYPE CHECK, and it is the reason `idExpiryOn` exists
 * as a separate column from `idDateOfExpiry`.
 *
 * Academic dates in this codebase are strings compared as strings, which is correct and
 * cheap for well-formed ISO dates and catastrophic for anything else. The schema comment
 * on `idExpiryOn` spells out the failure: `idDateOfExpiry` is free text that legitimately
 * holds "12/05/2027", "May 2027" or "N/A", and comparing those against "2026-09-01"
 * produces confident WRONG answers rather than errors — "12/05/2027" sorts BEFORE it and
 * reads as already expired, "May 2027" sorts AFTER it and reads as never expiring. Two of
 * the three commonest junk values give a false all-clear about somebody's immigration
 * paperwork.
 *
 * `idExpiryOn` is supposed to be null unless exactly one date was possible, so in theory
 * this can never fire. It stays because "in theory" is doing a lot of work: the column has
 * no database-level format constraint, nothing writes it yet, and the first thing that
 * does will be a backfill script. An unparseable string arriving here must produce NO
 * ANSWER, never a comparison.
 */
function isIsoDate(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  // AND A ROUND TRIP, WHICH IS NOT BELT AND BRACES — the first version of this function
  // stopped at the line above and its own test caught it.
  //
  // `Date.parse("2026-02-30T00:00:00Z")` does NOT return NaN. V8 rolls the overflow
  // forward and hands back 2 March, so a shape check plus a finite parse accepts
  // "2026-02-30" and "2026-02-29" in a non-leap year — and then every later comparison in
  // this file happens against a date the record does not contain. That is the same class of
  // failure as comparing the free-text column: not an error, a confidently wrong answer,
  // about somebody's immigration paperwork.
  //
  // Re-serialising and comparing is the only cheap test that catches it, because it asks
  // the calendar rather than the parser.
  //
  // The shape check above is then PROVABLY REDUNDANT — a mutation run removed it and no
  // test could tell, across every junk shape this codebase has seen plus "+002026-03-20",
  // a Date object and an object with a helpful toString. It stays as an early-out and as
  // documentation of what the column is supposed to hold; the round trip is the guard.
  return new Date(t).toISOString().slice(0, 10) === v;
}

/**
 * Whole days between two YYYY-MM-DD dates, `to` minus `from`, or NULL if either date
 * cannot be parsed.
 *
 * DELIBERATELY NOT tripwires.daysBetween, which returns 0 for an unparseable date. Zero is
 * the right shrug there — it makes a code fail to fire, which is silence. Here zero would
 * mean "this document expires TODAY", the loudest possible statement, produced by a bad
 * string rather than by evidence. coverage.js and funding.js took the same decision for
 * the same reason.
 */
function daysBetween(from, to) {
  if (!isIsoDate(from) || !isIsoDate(to)) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Whether a free-text answer carries any content at all. Presence, never content. */
const answered = (v) => typeof v === "string" && v.trim() !== "";

/**
 * ONE SHAPE FOR EVERY "WE CANNOT SAY", so that no caller can accidentally receive a
 * partial answer with some fields filled in and read the blanks as measurements. Module
 * scope rather than a closure inside entryProfile(), because evaluate() needs the identical
 * shape when the ROW PICK is refused — and the alternative it replaced was calling
 * entryProfile() with a fabricated `ismRecorded: false`, which is a lie about an
 * institution probe told to get a null out of a function. A probe result invented at a call
 * site is exactly the thing three CLAUDE.md paragraphs are about.
 *
 * @param {boolean|null} recorded  see the three states documented on entryProfile()
 */
const blankProfile = (recorded) => ({
  recorded,
  interviewOn: null,
  answered: null,
  questions: null,
  barriers: null,
  wifiAtHome: null,
  knowsOfficeSoftware: null,
  admittedOutcome: null,
});

/** The same, for the right-to-study half. */
const blankRightToStudy = () => ({ expiresOn: null, expired: null, expiringSoon: null });

/* -------------------------------------------------------------------------- */
/* The institution probes                                                      */
/* -------------------------------------------------------------------------- */

// What each flag has to MEAN, in the error message, because the error is the only place a
// wiring author reliably reads.
//
// BOTH PROBES COUNT LINKED ROWS, AND THE LINK IS THE ENTIRE POINT.
//
// `count(Ism) > 0` and `count(Admission) > 0` are the probes everybody writes and they
// answer the wrong question. `Admission.linkedStudentId` is nullable, was added recently,
// and is populated by a backfill that has NOT been run — nothing in the app writes it
// either. A college can therefore hold four thousand applications and eight hundred
// interview records of which precisely zero are reachable from a `Student`.
//
// Under the naive probe that college passes. Every student then presents an empty array,
// every one of them is reported as having no entry profile and no document on file, and
// the screen says "never interviewed, no right-to-study evidence" about four thousand
// people whose records are sitting in the same database. That is a measurement of a script
// nobody ran, dressed as a measurement of students — the manufactured-alarm mirror of
// coverage.js's manufactured-reassurance timetable probe, and the same reason a probe has
// to establish that the JOIN CAN SUCCEED rather than that the table is non-empty.
// funding.js documents `slcRecorded` in exactly these words.
const PROBE_MEANING = {
  // At least one Ism in this tenant whose Admission carries a non-null linkedStudentId.
  ismRecorded:
    "at least one Ism in this tenant whose admission is linked to a Student " +
    "(admission.linkedStudentId is not null)",
  // At least one Admission in this tenant that is BOTH linked AND carries a parsed expiry.
  // Both halves are needed: a college with linked admissions and no parsed expiry dates has
  // not run the parser, and reporting "no document on file" for all of them would be the
  // same manufactured alarm one level in.
  idExpiryRecorded:
    "at least one Admission in this tenant with a non-null linkedStudentId AND a " +
    "non-null idExpiryOn",
};

/**
 * Refuse to answer without an institution-wide answer to "does this college record this
 * at all, in a form attached to actual students?"
 *
 * ISSUED ONCE PER RUN, UNFILTERED BY STUDENT, HOISTED OUT OF THE CHUNK LOOP. CLAUDE.md
 * records this as the most repeated bug in this area, got wrong three times, and the
 * reason is always the same: `gather()` runs on chunks of 200 and the ordinary incremental
 * path scores the handful of students `markStale` flagged, often exactly one. One student
 * with no interview record is completely ordinary — they enrolled before the module
 * existed, or the college interviews on paper. A college with none has no ISM data at all.
 * Those two facts are INDISTINGUISHABLE inside a chunk, and computing either flag from
 * `isms.length`, `admissions.length` or any array in this file reproduces the bug exactly.
 *
 * WHY THIS THROWS INSTEAD OF DEFAULTING TO SILENCE.
 *
 * The guards in tripwires.js take a boolean that defaults to falsy and fall silent when it
 * is missing, and that is right for them: a missing flag there costs one code that does not
 * fire. Here a missing flag would cost the whole feature, silently and permanently — every
 * figure null for every student at every college, no test failing, no row looking wrong. A
 * feature that quietly does nothing is not discoverable by reading the output, and this one
 * is ALREADY expected to be silent everywhere until the backfill runs, so "it produces
 * nothing" is not a symptom anyone would investigate.
 *
 * So it fails the way db.js fails a query with no tenant context: loudly, at the first
 * call, in the caller's own test run. coverage.js's and funding.js's assertInstitutionProbe
 * make the identical argument and the three are deliberately the same shape.
 *
 * @param {object} institution  the probe results, decided once per run
 * @param {string} fnName       for the message
 * @param {string[]} fields     which flags this caller needs. Named per-function rather
 *        than "both, always", because a probe threaded through a function that does not
 *        read it teaches the next reader that it is ceremony — and then it gets dropped
 *        from the one place it was load-bearing. coverage.confidence makes the same point.
 */
function assertInstitutionProbe(institution, fnName, fields) {
  for (const field of fields) {
    if (!institution || typeof institution[field] !== "boolean") {
      throw new TypeError(
        `${fnName}: institution.${field} must be a boolean — an institution-wide probe ` +
        `result (${PROBE_MEANING[field]}), decided once per run and never derived from ` +
        "one student's rows",
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Choosing which row to read                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The one ISM this student's entry profile should be read from.
 *
 * WHY THIS IS NOT `isms[0]`. A student can legitimately hold several: an interview, a
 * second interview after a deferral, a re-interview on readmission. `routes/ism.js` mirrors
 * "the most-recent ISM" onto `Admission.ismOutcome` and orders by `createdAt`, a
 * DateTime — which this pure layer deliberately does not accept, because a timestamp is
 * not a date in the college's own zone and `src/clock.js` exists precisely because the two
 * differ. `interviewDate` is the recorded date of the meeting and it is the only ordering
 * this module can honour.
 *
 * AMBIGUITY REFUSES RATHER THAN GUESSES. Two undated ISMs cannot be ordered, and taking the
 * first array element would make the answer depend on the order Postgres happened to
 * return the rows in — the same defect `attendanceShape`'s sort comment describes, with a
 * worse consequence, because here the two rows may carry opposite `admitted` outcomes. A
 * refusal costs a caseload entry; a guess puts the wrong interview on somebody's record.
 *
 * THE LINK GUARD LIVES HERE TOO, and it refuses rather than filters. See the header: a row
 * arriving without `linkedStudentId` is evidence the caller joined on a typed college ID
 * or on a name.
 *
 * @param {Array} isms  this student's Ism rows, flattened to carry the linked student id
 *        from their Admission — see the select in the module docs
 * @returns {{row: object|null, refused: boolean}}  `row: null, refused: false` means this
 *        student genuinely has no interview record
 */
function pickInterview(isms) {
  const rows = (isms || []).filter(Boolean);
  if (!rows.length) return { row: null, refused: false };

  // Any unlinked row poisons the whole answer, rather than being dropped. Filtering would
  // silently half-honour a bad join.
  if (rows.some((r) => !r.linkedStudentId)) return { row: null, refused: true };

  if (rows.length === 1) return { row: rows[0], refused: false };

  const dated = rows.filter((r) => isIsoDate(r.interviewDate));
  if (!dated.length) return { row: null, refused: true };

  let max = dated[0].interviewDate;
  for (const r of dated) if (r.interviewDate > max) max = r.interviewDate;

  // Ties refuse. Two interviews recorded on the same day are two records of the same
  // meeting or two meetings this module cannot separate, and they may disagree.
  const winners = dated.filter((r) => r.interviewDate === max);
  if (winners.length !== 1) return { row: null, refused: true };

  // AND A ROW WITHOUT A DATE STILL COUNTS AS A CONTENDER IT CANNOT BEAT. An undated ISM
  // beside a dated one is not evidence that the dated one is the later; it is a row nobody
  // dated. Refusing here rather than silently preferring the dated row keeps the "cannot
  // be ordered" rule consistent, which is what stops a later reader deciding that an
  // undated row is always the older one.
  if (dated.length !== rows.length) return { row: null, refused: true };

  return { row: winners[0], refused: false };
}

/**
 * The one Admission whose recorded expiry binds.
 *
 * WHY THE LATEST EXPIRY AND NOT THE EARLIEST. A student can hold two admissions — the
 * migration names the case: rejected in September, readmitted in January — and both carry
 * a transcription of the SAME PERSON'S identity document, taken at two different moments.
 * The later expiry is therefore the later document: a renewal, transcribed at
 * readmission. Reporting the earlier one would raise an expiry the student has already
 * replaced, which is the false-alarm failure with the evidence of its own wrongness
 * sitting in the same array.
 *
 * The alternative — refusing whenever two linked admissions disagree — was rejected
 * because the commonest cause of two rows is a duplicate an administrator tidied around,
 * and refusing there would take the feature off the air for exactly the students whose
 * admissions record is most disturbed. `applications` on funding's return exists so the
 * sample stays visible; the same reasoning applies here and `admissionsSeen` is returned.
 *
 * ROWS WITH NO USABLE EXPIRY CONTRIBUTE NOTHING rather than counting as "no expiry". They
 * leave BOTH sides, the way an unmarked unit leaves both sides of `unpassedUnits`.
 *
 * @returns {{row: object|null, refused: boolean, seen: number}}
 */
function pickAdmission(admissions) {
  const rows = (admissions || []).filter(Boolean);
  if (!rows.length) return { row: null, refused: false, seen: 0 };

  if (rows.some((r) => !r.linkedStudentId)) return { row: null, refused: true, seen: rows.length };

  let best = null;
  for (const r of rows) {
    if (!usableExpiry(r)) continue;
    if (!best || r.idExpiryOn > best.idExpiryOn) best = r;
  }

  return { row: best, refused: false, seen: rows.length };
}

/* -------------------------------------------------------------------------- */
/* (a) The entry profile                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A student's pre-entry self-assessment, reduced to figures.
 *
 * EVERY FIGURE HERE IS A SELF-REPORT TRANSCRIBED BY SOMEBODY ELSE, not an observation, and
 * the column names should keep saying so on the screen. The student said they have no
 * wifi; an admissions officer typed it; neither of them was under oath and neither was
 * asked again afterwards.
 *
 * THREE STATES FOR `recorded`, AND THE THIRD IS WHY THE PROBE IS NOT CEREMONY:
 *
 *   null  — this college has no linked ISM data at all. The question is unanswerable, and
 *           saying "never interviewed" about every student in the institution would be a
 *           statement about a backfill nobody ran.
 *   false — this college DOES record interviews, and this student has none. That is real
 *           news: somebody enrolled without the admissions step the college otherwise
 *           applies, which is a gap in the record worth seeing.
 *   true  — there is a row.
 *
 * `false` IS DELIBERATELY NOT A CODE. A college part-way through adopting the module has it
 * true for a whole cohort, and CLAUDE.md's rule is explicit: a signal that fires for a whole
 * cohort at once is a FIGURE, not a code, because `riskDriverCodes` is a per-student
 * caseload array and a hundred rows carrying an identical reason is the same as no
 * caseload. It is also a fact about admissions practice rather than about the student,
 * which is the coverage.js argument for not scoring staff behaviour.
 *
 * @param {object|null} ism  one Ism row (already picked and link-checked), or null
 * @param {object} opts  `{ institution: { ismRecorded: boolean } }` plus config
 */
function entryProfile(ism, opts) {
  const cfg = { ...INTAKE_DEFAULTS, ...(opts || {}) };
  assertInstitutionProbe(cfg.institution, "entryProfile", ["ismRecorded"]);

  // THE INSTITUTION GUARD. Null, not false — see the three states above.
  if (!cfg.institution.ismRecorded) return blankProfile(null);

  // NO ROW. `recorded: false` is the only non-null field, and it raises nothing.
  if (!ism) return blankProfile(false);

  // THE LINK GUARD, DEFENSIVELY REPEATED. `pickInterview` already refuses an unlinked row,
  // and this is not redundant: this function is exported and a later caller will use it
  // directly with a row they fetched themselves. The consequence of the join being wrong
  // is one person's interview record on another person's screen, and a guarantee that
  // depends on which helper a refactor happens to call first is not a guarantee.
  if (!ism.linkedStudentId) return blankProfile(null);

  // HOW MUCH OF THE FORM WAS FILLED IN. Presence only — see PROSE_FIELDS. This is a figure
  // about the interview RECORD, never a code: a sparse form is an admissions officer who
  // was busy, and firing on it would put a caseload entry on a student because somebody
  // else typed less.
  let filled = 0;
  for (const field of PROSE_FIELDS) if (answered(ism[field])) filled += 1;

  // THE CONSTRAINED ANSWERS, MATCHED EXACTLY. NO CASE FOLDING, NO TRIMMING, NO
  // NORMALISATION, and that is a decision rather than an oversight.
  //
  // The obvious kindness is to lowercase before comparing so "yes" lands where its author
  // meant it to. It is refused for funding.classify's reason: the easy cases are not the
  // ones that matter. "yes" is trivially recoverable; the strings that will actually turn
  // up from an importer or a college's own form are "N/A", "Sometimes", "Only at the
  // library", "Y (mobile data)". Case folding would quietly broaden the door for the
  // harmless cases while doing nothing for the harmful ones, and it would teach the next
  // reader that this function guesses about a value it is about to raise a code on.
  //
  // Anything outside the pair is `null` — unrecognised, reported as unknown, never guessed
  // at, and specifically never read as "No". "Only at the library" is a student saying
  // something real and specific, and it is not this module's to interpret.
  const yesNo = (v) => (v === "Yes" ? true : v === "No" ? false : null);

  const wifiAtHome = yesNo(ism.wifiAccess);
  const knowsOfficeSoftware = yesNo(ism.officeSkills);

  // A COUNT OF THE BARRIERS THE STUDENT NAMED, so a screen can sort by it without the
  // reader having to combine two booleans. Null when NEITHER question was answered in a
  // form this module recognises: zero would say "we asked and they have no barriers",
  // which is a measurement of an interview that did not happen. A single recognised answer
  // is enough for a count, because "one of the two we could read" is still an observation.
  const known = [wifiAtHome, knowsOfficeSoftware].filter((v) => v !== null);
  const barriers = known.length
    ? (wifiAtHome === false ? 1 : 0) + (knowsOfficeSoftware === false ? 1 : 0)
    : null;

  return {
    recorded: true,
    // A DATE, and only when it is a real one. A malformed `interviewDate` is dropped rather
    // than passed through, because the caller stores this and the client subtracts it.
    interviewOn: isIsoDate(ism.interviewDate) ? ism.interviewDate : null,
    answered: filled,
    // The denominator, returned so the fraction on the screen shows what it rests on —
    // `gradedWithDates` in submissionTiming exists for the same reason.
    questions: PROSE_FIELDS.length,
    barriers,
    wifiAtHome,
    knowsOfficeSoftware,
    // Reported as the STRING rather than as a boolean, because it has three values and
    // "May Be" is the interesting one. Anything outside the vocabulary is null.
    admittedOutcome: ADMITTED_VALUES.has(ism.admitted) ? ism.admitted : null,
  };
}

/* -------------------------------------------------------------------------- */
/* (b) Right to study                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Whether an Admission row carries an expiry date this module is allowed to compare.
 *
 * THREE CONDITIONS, AND EACH ONE HAS COST SOMEBODY SOMEWHERE.
 *
 *   1. `idExpiryOn`, NEVER `idDateOfExpiry`. The free-text column is what the person typed
 *      and it is kept as a record; it is never overwritten and it is never read here. See
 *      isIsoDate for what comparing it would do.
 *
 *   2. A TRUSTED `idExpiryStatus`. The schema defines "parsed" | "ambiguous" |
 *      "unparseable" | "confirmed", where "confirmed" is a human's assertion that outranks
 *      a machine parse (matching AssessmentGrade.source). "ambiguous" and "unparseable"
 *      are the quarantine queue — a partial index exists for exactly that query — and a
 *      date sitting on a row in either state is a parser's working, not an answer.
 *
 *   3. A STATUS OF NULL IS NOT TRUSTED EITHER, and this is the one that will look
 *      over-strict. Null means "not yet examined". A date present with nobody having
 *      examined it is a row written around the parser — by a backfill, a fixture, or a
 *      hand-edit in a console — and the entire reason the column pair exists is that a
 *      date is only usable once something asserted it was the ONE unambiguous reading.
 *      Accepting it would make the status column decorative, and the first importer to
 *      write `idExpiryOn` straight from a spreadsheet would silently switch this feature
 *      on across a whole college with no human ever having looked.
 */
function usableExpiry(admission) {
  if (!admission) return false;
  if (!TRUSTED_EXPIRY_STATUS.has(admission.idExpiryStatus)) return false;
  return isIsoDate(admission.idExpiryOn);
}

/**
 * When the identity document on file runs out, and whether that has happened.
 *
 * @param {object|null} admission  one Admission row (already picked and link-checked)
 * @param {string} today  YYYY-MM-DD in the college's own zone, passed in — there is no
 *        clock in this file, because a document that expires at midnight in London expires
 *        on a different date on a server in UTC-5 and the answer must not depend on which
 *        machine ran the batch
 * @param {object} opts  `{ institution: { idExpiryRecorded: boolean } }` plus config
 * @returns {{expiresOn: string|null, expired: boolean|null, expiringSoon: boolean|null}}
 *
 * `expired` AND `expiringSoon` ARE FACTS AS AT `today`, AND THE CEILING IS NOT APPLIED
 * HERE. A document that expired three years ago is `expired: true`, because it did. What
 * `idExpiredCeilingDays` decides is whether that still belongs on a caseload, which is
 * evaluate()'s job. Folding the window in here would make this function return
 * `expired: false` for an expired document — "we looked, it is in date" — which is a lie
 * told to whoever calls this next, and the kind of lie that survives a refactor.
 *
 * NULL IS NOT FALSE. `expired: false` means there IS a date and it has not passed. Every
 * unanswerable case — no row, no parsed date, an untrusted status, a college that does not
 * record expiries, a `today` this module cannot parse — is null.
 */
function rightToStudy(admission, today, opts) {
  const cfg = { ...INTAKE_DEFAULTS, ...(opts || {}) };
  assertInstitutionProbe(cfg.institution, "rightToStudy", ["idExpiryRecorded"]);

  // THE INSTITUTION GUARD. A college that has not parsed a single expiry date has no
  // right-to-study data about anybody, and every figure must be null rather than a row
  // that reads as "no document on file" about each student in turn.
  if (!cfg.institution.idExpiryRecorded) return blankRightToStudy();

  if (!admission) return blankRightToStudy();

  // THE LINK GUARD, defensively repeated for the reason entryProfile repeats it. This is
  // the sharper of the two: an immigration document expiry attached to the wrong person is
  // the worst single output this pipeline can produce.
  if (!admission.linkedStudentId) return blankRightToStudy();

  if (!usableExpiry(admission)) return blankRightToStudy();

  const expiresOn = admission.idExpiryOn;
  const days = daysBetween(today, expiresOn);

  // An unparseable `today` yields nothing rather than a comparison. The date still returns,
  // because it is a fact about the record that does not depend on today at all — and a
  // caller storing it is storing something true.
  if (days === null) return { expiresOn, expired: null, expiringSoon: null };

  // STRICTLY IN THE PAST. A document that expires TODAY has not expired: it is valid for
  // the day, and telling a student their passport expired on the morning of the day it
  // runs out is wrong in the direction that ends a conversation badly. `days === 0`
  // therefore falls into `expiringSoon`, which is the finding that matters anyway.
  const expired = days < 0;

  // A WINDOW WITH BOTH ENDS. The far end is `idExpiryWarnDays`; the near end is today,
  // because an already-expired document is the other code and a value cannot be both. The
  // two are mutually exclusive by construction rather than by an ordering of ifs, which is
  // what stops a later edit producing a row that says a document is expiring and expired.
  const expiringSoon = !expired && days <= cfg.idExpiryWarnDays;

  return { expiresOn, expired, expiringSoon };
}

/* -------------------------------------------------------------------------- */
/* The evaluation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} raw
 *   today       {string} YYYY-MM-DD in the college's zone, passed in rather than read from
 *               a clock
 *   isms        {Array}  this student's Ism rows, each flattened to carry
 *               `linkedStudentId` from its Admission. Selected by the FOREIGN KEY. See the
 *               header, and the select in the module docs.
 *   admissions  {Array}  this student's Admission rows, selected by `linkedStudentId`
 *   institution {{ismRecorded:boolean, idExpiryRecorded:boolean}}  the institution-wide
 *               probes. REQUIRED — this throws without them.
 *   weeksIntoProgramme {number|null}  how far into the course this student is
 * @param {object} [config]  a settings config, spread over INTAKE_DEFAULTS
 *
 * @returns figures + codes. EVERY FIGURE IS A DATE, A COUNT OR A TRI-STATE FLAG THAT DOES
 * NOT ROT. No day counts, and no `expired` / `expiringSoon`: both of those flip as the
 * calendar moves with no event to flip them, and a column that is wrong by tomorrow
 * morning is worse than no column. The codes carry the snapshot; the date carries the
 * truth.
 */
function evaluate(raw, config) {
  const cfg = { ...INTAKE_DEFAULTS, ...(config || {}) };
  const input = raw || {};

  // Throws before anything else, so a caller who forgot a probe finds out on their first
  // fixture rather than after a term of blank columns.
  //
  // NOT REDUNDANT, WHICH IS WORTH SAYING BECAUSE IT LOOKS IT. coverage.js and funding.js
  // both carry the same pair and both describe theirs as belt-and-braces; a mutation run on
  // this file showed that here it is load-bearing on a real path. When BOTH row picks are
  // REFUSED — a caller who forgot the probe and joined on the wrong column, which is one
  // careless wiring rather than two — evaluate() short-circuits to the blank shapes and
  // never calls entryProfile() or rightToStudy(), where every other assertion in the module
  // lives. Without this line that caller gets silence instead of a TypeError.
  //
  // It would stay even if it were redundant, for the structural reason: the guarantee this
  // function makes to its caller is "nothing is computed without a probe", and that must not
  // depend on which helper a later refactor happens to call first.
  assertInstitutionProbe(input.institution, "evaluate", ["ismRecorded", "idExpiryRecorded"]);

  const today = input.today;
  const opts = { ...cfg, institution: input.institution };
  const codes = [];

  /* --- (a) the entry profile ---------------------------------------------- */

  const picked = pickInterview(input.isms);
  // A refused pick is `recorded: null` — unanswerable — and NOT `false`, which would claim
  // this student was never interviewed on the strength of a join the module just rejected.
  const profile = picked.refused ? blankProfile(null) : entryProfile(picked.row, opts);

  // THE DECAY WINDOW, WHICH RUNS THE OPPOSITE WAY FROM THE SETTLING-IN EXEMPTION.
  //
  // See `entryProfileWeeks`. Every code below fires on the PRESENCE of something the
  // student said before they arrived, and its value is highest in week one and lowest in
  // year two, when a register, marks and a pastoral record all exist about what they
  // actually did. So the window opens at week zero and closes at `entryProfileWeeks`.
  //
  // AN UNKNOWN PROGRAMME AGE IS NOT EXEMPT, AND THAT IS THE SAME RULE AS EVERYWHERE ELSE
  // IN THIS FAMILY EVEN THOUGH IT POINTS THE OTHER WAY. tripwires.js states it as "muting
  // every code for a student the calendar cannot place fails safe in the wrong direction".
  // Stated so it covers both files: AN UNKNOWN PROGRAMME AGE NEVER BUYS SILENCE. There, the
  // unknown student is not granted the settling-in grace; here, they are not granted the
  // decay. `isNum` is what enforces it — a null, an undefined or a NaN cannot close the
  // window.
  //
  // The cost of that choice here is a stale week-one code on a student whose cohort has no
  // start date, and it is the cheaper mistake: it is visible on the screen, it points at a
  // calendar the college should fix, and the alternative is silence about exactly the
  // students the timetable already cannot account for.
  const weeks = input.weeksIntoProgramme;
  const profileStale = isNum(weeks) && weeks >= cfg.entryProfileWeeks;

  if (!profileStale) {
    // `=== false` rather than a falsy test on all three, because every one of these is
    // tri-state and `null` is falsy. It reads as redundant and it is not: it documents at
    // the call site that "we do not know" exists, so a later reader cannot write
    // `if (!profile.wifiAtHome)` and quietly raise a code about a student nobody asked.
    if (profile.wifiAtHome === false) codes.push(INTAKE.NO_WIFI);
    if (profile.knowsOfficeSoftware === false) codes.push(INTAKE.DIGITAL_SKILLS);
    // Only "May Be". "No" is deliberately NOT a finding: this student is enrolled, so an
    // admissions recommendation against them was superseded by a later decision somebody
    // took with more information, and re-raising it here would relitigate an admissions
    // outcome on a tutor's screen months afterwards. "May Be" is different — nobody ever
    // resolved it, and the doubt is still open.
    if (profile.admittedOutcome === ADMITTED.MAYBE) codes.push(INTAKE.RESERVATION);
  }

  /* --- (b) right to study -------------------------------------------------- */

  const chosen = pickAdmission(input.admissions);
  // The explicit refusal branch is BEHAVIOURALLY EQUIVALENT TODAY and is kept anyway, which
  // a mutation run flagged and which is worth recording rather than tidying: `pickAdmission`
  // returns `row: null` alongside `refused: true`, so passing the row straight through would
  // reach the same blank shape by accident. It reaches it by accident. A later change that
  // let the picker return the best-guess row beside a refusal — which is exactly what
  // somebody adds when they want to show a "we found rows but could not attribute them"
  // message — would silently start answering from a rejected join.
  const rts = chosen.refused ? blankRightToStudy() : rightToStudy(chosen.row, today, opts);

  // NEITHER OF THESE IS MUTED BY PROGRAMME AGE, AND NOT BY THE SETTLING-IN EXEMPTION
  // EITHER. Both graces exist for codes that fire on the ABSENCE of a record about a
  // student the college has not had time to observe. These fire on the PRESENCE of a date,
  // which is as true in week one as in year two — and a visa expiring in the second year
  // of a two-year programme is the case the whole signal exists for. Muting it by
  // programme age would switch it off in exactly the window where the deadline falls.
  if (rts.expiringSoon === true) codes.push(INTAKE.ID_EXPIRING);

  if (rts.expired === true) {
    // THE CEILING, applied here rather than inside rightToStudy so that the FACT and the
    // CASELOAD DECISION stay separate. See `idExpiredCeilingDays`: a student still enrolled
    // a full academic year after the recorded date almost certainly renewed and nobody
    // updated an admissions row that stops being maintained at enrolment. The date is still
    // stored, so a compliance list sees it for ever; only the code ages out.
    const sinceExpiry = daysBetween(rts.expiresOn, today);
    if (isNum(sinceExpiry) && sinceExpiry <= cfg.idExpiredCeilingDays) {
      codes.push(INTAKE.ID_EXPIRED);
    }
  }

  return {
    entryProfileRecorded: profile.recorded,
    entryProfileOn: profile.interviewOn,
    entryProfileAnswered: profile.answered,
    entryProfileQuestions: profile.questions,
    entryProfileBarriers: profile.barriers,
    entryWifiAtHome: profile.wifiAtHome,
    entryKnowsOfficeSoftware: profile.knowsOfficeSoftware,
    entryAdmittedOutcome: profile.admittedOutcome,
    // THE ONLY RIGHT-TO-STUDY FIGURE, and it is a DATE. See the header.
    rightToStudyExpiresOn: rts.expiresOn,
    codes,
  };
}

module.exports = {
  evaluate,
  entryProfile,
  rightToStudy,
  pickInterview,
  pickAdmission,
  usableExpiry,
  isIsoDate,
  assertInstitutionProbe,
  INTAKE,
  INTAKE_CODES,
  INTAKE_DEFAULTS,
  ADMITTED,
  PROSE_FIELDS,
};
