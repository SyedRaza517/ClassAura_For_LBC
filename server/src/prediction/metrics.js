// Gathering the raw material the engine scores: attendance, submissions, grades,
// interventions, and the score this student carried a month ago.
//
// This file is the ONLY part of the prediction feature that touches the database.
// engine.js is pure and knows nothing about Prisma; this module knows nothing about
// weights, bands or overrides. The seam is deliberate — the arithmetic is the part
// that gets argued with, and it stays testable without fixtures.
//
// BATCHED, NOT PER STUDENT. Everything here takes a LIST of students and issues a
// fixed number of queries for the whole list, grouping in Node. The obvious
// per-student shape would be six queries each, which is three thousand round trips
// for a five-hundred-student college and would make a recalculation unusable on a
// pooled connection.
//
// EVIDENCE, NEVER ASSUMPTION. Where the database cannot answer a question, the
// answer is null and the engine renormalises the component away. In particular a
// piece of work with no AssessmentSubmission row is NOT counted as missing: there is
// no record here of whether a student handed work in until Moodle says so, and
// inventing "not submitted" from silence would raise a missing-work flag on every
// student in a college that has never synced submissions.
const prisma = require("../db");
const { localDate, ZONE } = require("../clock");
const { isoDate } = require("../vle/isoDate");
const attendance = require("../attendance");
const tripwires = require("./tripwires");
const adjustments = require("./adjustments");
const coverage = require("./coverage");
const cohort = require("./cohort");
const engagement = require("../vle/engagementNormalise");
const workload = require("./workload");
const funding = require("./funding");
// NOT `sessions`: gather() already declares a local `sessions` array of HndSession rows
// for register coverage, and a const in that scope shadows this import silently. The unit
// tests could not see it -- they import evaluate directly -- and the first symptom was
// "sessions.evaluate is not a function" on a live run.
const sessionShape = require("./sessions");
const intake = require("./intake");
const historyShape = require("./history");
const assessmentType = require("./assessmentType");
const timetableShape = require("./timetable");

/* -------------------------------------------------------------------------- */
/* Dates                                                                       */
/* -------------------------------------------------------------------------- */

/** YYYY-MM-DD, `days` before `iso`. Plain string arithmetic on a UTC midnight, so
 *  it never drifts across a BST boundary the way a local Date would. */
function shiftDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days between two YYYY-MM-DD dates, `to` minus `from`. */
function daysBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

const inWindow = (date, from, to) => Boolean(date) && (!from || date >= from) && (!to || date <= to);

/* -------------------------------------------------------------------------- */
/* Attendance, under whichever model the college chose                         */
/* -------------------------------------------------------------------------- */

/**
 * A student's attendance percentage over a list of marks.
 *
 * TWO MODELS, because colleges genuinely mean different things by "attendance":
 *
 *   "points"  P=2, L=1, E=1, A=0 — the model attendance.js already uses, and
 *             therefore the number the Attendance % tab already displays. The engine
 *             must agree with that screen or staff will not trust either of them.
 *   "binary"  present or not; late and excused count as absent. What a provider
 *             reporting physical attendance on a Student visa means — a student who
 *             arrived an hour late was not there for the hour.
 *
 * Unmarked sessions are excluded under both, and a student with nothing marked has a
 * percentage of null rather than 0: a register nobody has taken is not an absence.
 */
function summariseAttendance(marks, mode) {
  if (mode !== "binary") return attendance.summarise(marks);

  let present = 0, marked = 0;
  for (const m of marks) {
    if (!attendance.isStatus(m.status)) continue;
    marked += 1;
    if (m.status === "P") present += 1;
  }
  return { marked, pct: marked > 0 ? Math.round((present / marked) * 1000) / 10 : null };
}

/* -------------------------------------------------------------------------- */
/* 1) Scope                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What one student's score covers: a dated window, and a label staff can read.
 *
 * "current-term" is the default and the one the design argues for — a strong first
 * year must not mask a collapse happening now. A student whose cohort has no term
 * containing today (between terms, or a cohort with no calendar) falls back to the
 * whole record rather than to an empty window, because a window with no sessions in
 * it would score every student as unmeasurable and empty the risk register.
 */
function resolveScope(student, config) {
  const today = localDate();
  const terms = (student.cohort && student.cohort.terms) || [];

  if (config.scope === "all" || !terms.length) {
    return { termId: null, label: "All time", from: null, to: null };
  }

  const current = terms.find((t) => t.start <= today && today <= t.end);

  if (config.scope === "current-term") {
    if (!current) return { termId: null, label: "All time (no term is running)", from: null, to: null };
    return { termId: current.id, label: current.name, from: current.start, to: current.end };
  }

  // current-year: every term of the year the student is in now.
  const year = current ? current.year : Math.max(...terms.map((t) => t.year));
  const ofYear = terms.filter((t) => t.year === year);
  if (!ofYear.length) return { termId: null, label: "All time", from: null, to: null };

  return {
    termId: current ? current.id : null,
    label: `Year ${year}`,
    from: ofYear.reduce((min, t) => (t.start < min ? t.start : min), ofYear[0].start),
    to: ofYear.reduce((max, t) => (t.end > max ? t.end : max), ofYear[0].end),
  };
}

/* -------------------------------------------------------------------------- */
/* 2) The gather                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Everything the engine needs, for a list of students, as a Map keyed by student id.
 *
 * @param {string[]} studentIds
 * @param {object} config - a complete config from settings.get()
 * @returns {Promise<Map<string, object>>} studentId -> { scope, raw }
 */
async function gather(studentIds, config) {
  const out = new Map();
  if (!studentIds.length) return out;

  const today = localDate();
  const recentFrom = shiftDays(today, -config.recentAttendanceDays);
  const directionCutoff = shiftDays(today, -config.directionOfTravelDays);

  // The window before the recent one, the same length and not overlapping it, so a
  // slope compares two equal periods rather than a period against itself. Both are
  // inclusive at each end, so the span is recentAttendanceDays + 1 days on each side —
  // equal is what matters, not the exact count.
  const concernSince = shiftDays(today, -config.concernWindowDays);
  const noShowSince = shiftDays(today, -config.noShowWindowDays);
  const followUpCutoff = shiftDays(today, -config.followUpGraceDays);
  const followUpSince = shiftDays(today, -config.followUpWindowDays);
  const priorTo = shiftDays(recentFrom, -1);
  const priorFrom = shiftDays(priorTo, -config.recentAttendanceDays);

  /* --- what this INSTITUTION records at all ------------------------------ */

  // These three ask "does this college use this field", and the answer must come from
  // the whole institution, never from the chunk.
  //
  // gather() is called per chunk of 200, and the ordinary incremental path scores only
  // the handful of students markStale() flagged — often one. Deciding "this college
  // does not record lateness" from a chunk of one student who happens to have no late
  // marks is not a fact about the college; it flips latenessRate between null ("not
  // recorded") and 0.0 ("never late") for the SAME student depending on who else was
  // in the batch, and the id list has no ORDER BY, so it is not even stable run to run.
  //
  // The pastoral pair is worse than unstable: it suppresses TRIP_NO_PASTORAL_CONTACT
  // for exactly the students it exists to find, because a chunk of never-contacted
  // students contains no contacts and therefore looks like a college with no pastoral
  // module at all.
  //
  // Six cheap existence probes, once per run, unfiltered by student and issued together
  // — none of them depends on any other, so serialising them would add round trips to
  // every chunk for no reason.
  const [lateMarks, contactRows, reviewRows, excusedMarks, submittedAtRows, submissionRows,
         answeredQueryRows, firstClosedContact, firstClosedReview,
         unmarkedSessions, linkedSlcRows, kindedSessions,
         linkedIsmRows, linkedExpiryRows, typedAssessments] = await Promise.all([
    prisma.attendanceMark.count({ where: { status: "L" } }),
    prisma.interaction.count(),
    prisma.studentReview.count(),
    prisma.attendanceMark.count({ where: { status: "E" } }),
    prisma.assessmentGrade.count({ where: { NOT: { submittedAt: null } } }),
    prisma.assessmentSubmission.count(),
    // Does this college answer queries THROUGH the system? Staff who read a query in
    // the app and reply in person never press Respond, so every query the college has
    // ever received sits at "open" for ever. That is a workflow fact, not a student's
    // wait — and computing it from the chunk would suppress the code for exactly the
    // students it exists to find, since a chunk of ignored students contains no
    // answered queries. The pastoral pair failed this way once already.
    prisma.studentQuery.count({ where: { status: "answered" } }),
    // THE WATERMARK, and the seventh guard of the same family. followUpCompletedOn did
    // not exist before its migration, so it is null on every row written earlier -- for
    // follow-ups held on the day exactly as much as for ones nobody made. Reading that
    // null as "not done" would put the college's whole historic backlog on the caseload
    // the morning the column shipped.
    //
    // Derived, never stamped: a constant would be a DEPLOY date, and the two databases
    // migrate on different days, so a value right for one is silently wrong for the
    // other. The earliest completion this college has EVER recorded is an observed
    // lower bound on when it became able to record one.
    // NOT _min(followUpCompletedOn). That is the earliest CLAIMED completion date, and
    // the routes deliberately accept a backdated one — "promised for 1 March, held on
    // 30 April" is a legitimate entry. So the first honest backdated close would drag
    // the watermark months into the past and make every untouched promise since then
    // judgeable in a single run: the institution-wide flood this design exists to
    // prevent, arriving the moment somebody works through their backlog. It is also
    // non-monotonic, because _min can only ever move EARLIER.
    //
    // The bound that matters is when the column became WRITABLE, which is what
    // updatedAt on a row carrying a completion tells us — a row cannot have been
    // updated with a completion before the migration existed.
    prisma.interaction.aggregate({ _min: { updatedAt: true }, where: { NOT: { followUpCompletedOn: null } } }),
    prisma.studentReview.aggregate({ _min: { updatedAt: true }, where: { NOT: { followUpCompletedOn: null } } }),
    // THE TENTH OF THE SAME FAMILY, and it means TWO things at once, which is why it is
    // a count of UNMARKED sessions rather than of sessions.
    //
    // Register coverage compares sessions a student should have been marked in against
    // marks they carry. That comparison is only meaningful if a session can EXIST without
    // a mark. At a college where sessions spring into being only when somebody takes a
    // register, scheduled and marked are the same set by construction, coverage is 100%
    // for everybody, and the screen prints manufactured reassurance -- the harder mirror
    // of the failure this figure exists to catch.
    //
    // count(HndSession) > 0 does NOT answer that: AttendanceMark.sessionId is NOT NULL,
    // so it is true at every college that ever took a single register. Only "a session
    // exists that nobody marked" separates the two, and it implies sessions exist.
    //
    // Institution-wide and unfiltered by student, like the nine above. One student with
    // no unmarked sessions is ordinary; a college with none has no timetable this can be
    // measured against, and every code depending on coverage must fall silent.
    prisma.hndSession.count({ where: { marks: { none: {} } } }),
    prisma.slcApplication.count({ where: { NOT: { studentId: null } } }),
    // THE TWELFTH, and it is a count of sessions carrying a NON-EMPTY kind rather than of
    // sessions. HndSession.kind defaults to "", so count(HndSession) > 0 is true at every
    // college that ever timetabled anything and would answer a different question
    // entirely -- the mistake coverage.js documents for its own probe.
    //
    // Empty on every row in both databases today, so the kind figures are null
    // everywhere. That is the guard working, not the feature failing.
    prisma.hndSession.count({ where: { NOT: { kind: "" } } }),
    // THE THIRTEENTH AND FOURTEENTH, and both count LINKED rows rather than rows.
    //
    // count(Ism) > 0 is true at a college holding four thousand interview records that
    // were never attached to an enrolled student, and the pipeline would then report
    // "never interviewed" about four thousand people who were. The same mistake
    // funding.js documents for slcRecorded, and the same one coverage.js documents for
    // its own probe: the naive count answers a different question.
    //
    // Both false everywhere today — nothing populates the links — so every intake figure
    // stays null. Correct, not broken.
    prisma.ism.count({ where: { admission: { linkedStudentId: { not: null } } } }),
    prisma.admission.count({ where: { linkedStudentId: { not: null }, idExpiryOn: { not: null } } }),
    // THE FIFTEENTH, and like the others it counts the thing that answers the question
    // rather than the thing that is easy to count. Assessment.type DEFAULTS to
    // "Assignment", so count(Assessment) > 0 is true at every college that ever created
    // one piece of work and would tell us nothing about whether types are distinguished.
    // "" is excluded alongside the default because a blank type is an unset one written
    // outside the route layer.
    prisma.assessment.count({ where: { type: { notIn: ["Assignment", ""] } } }),
  ]);
  // Does this college's feed carry submission dates at all? Fourth guard of the same
  // shape — nothing anywhere carrying a submittedAt means "0% late" is a statement
  // about the integration, not about anybody's coursework.
  const submittedOnRecorded = submittedAtRows > 0;
  const timetableRecorded = unmarkedSessions > 0;
  // THE ELEVENTH INSTITUTION PROBE. "At least one claim in this tenant is attached to a
  // real Student", and the attachment is the point -- count(SlcApplication) > 0 would be
  // true at a college holding four thousand UNLINKED rows, and the pipeline would then
  // report "no funding record" about four thousand people who have one.
  //
  // False everywhere today, because nothing writes studentId until the backfill runs.
  // Every funding figure therefore stays null, which is correct rather than broken.
  const slcRecorded = linkedSlcRows > 0;
  const kindRecorded = kindedSessions > 0;
  const ismRecorded = linkedIsmRows > 0;
  const idExpiryRecorded = linkedExpiryRows > 0;
  const assessmentTypesRecorded = typedAssessments > 0;

  // The fifth of the same family, and the one that was missed when the other four were
  // hoisted. It reads whether the college records submissions AT ALL, so it must be
  // asked of the institution — the per-chunk version was filtered by studentId AND by
  // this chunk's assessmentIds, which is two scopes narrower than the question.
  //
  // It happened to be harmless, because nothing in this codebase writes
  // AssessmentSubmission and the count is therefore zero everywhere, so it always
  // failed safe. That is luck, not design: the day something starts populating that
  // table, a chunk of one student with no submission rows would conclude the college
  // does not record submissions and silently switch TRIP_UNMARKED_WORK off for them.
  const submissionsRecorded = submissionRows > 0;
  const queryRepliesRecorded = answeredQueryRows > 0;

  // Null means the signal stays SILENT: this college has never closed a follow-up
  // anywhere, so nothing distinguishes an unkept promise from a kept one nobody wrote
  // down. The bedding-in gap is stated rather than hidden -- follow-ups falling due
  // between the migration and the first use of the button stay excluded for ever. That
  // under-reports, which is the safe direction, it is bounded, and it converges. The
  // alternative over-reports the entire history at once.
  const closureDates = [
    firstClosedContact._min.updatedAt,
    firstClosedReview._min.updatedAt,
  ].filter(Boolean).map((d) => d.toISOString().slice(0, 10));
  const followUpClosureFrom = closureDates.length ? closureDates.reduce((a, b) => (a < b ? a : b)) : null;
  const lateRecorded = lateMarks > 0;
  const excusedRecorded = excusedMarks > 0;
  const pastoralInUse = contactRows > 0 || reviewRows > 0;

  /* --- students and their term calendars -------------------------------- */

  const students = await prisma.student.findMany({
    where: { id: { in: studentIds } },
    select: {
      id: true,
      cohortId: true,
      cohort: { select: { id: true, startDate: true, terms: { select: { id: true, year: true, index: true, name: true, start: true, end: true } } } },
    },
  });

  const scopes = new Map();
  const cohortIdByStudent = new Map();
  for (const s of students) {
    scopes.set(s.id, resolveScope(s, config));
    cohortIdByStudent.set(s.id, s.cohortId || null);
  }

  // How long this student has been on the programme, in weeks. The cohort's own start
  // date wins; the earliest term is the fallback. NEVER Student.createdAt — for a
  // Moodle-imported college that is the sync date, which says when the row was made
  // rather than when the student arrived. Null when neither exists, and null is
  // deliberately NOT treated as "brand new" downstream.
  const weeksByStudent = new Map();
  for (const s of students) {
    const terms = (s.cohort && s.cohort.terms) || [];
    const start = (s.cohort && s.cohort.startDate)
      || (terms.length ? terms.reduce((min, t) => (t.start < min ? t.start : min), terms[0].start) : null);
    weeksByStudent.set(s.id, start ? Math.max(0, Math.floor(daysBetween(start, today) / 7)) : null);
  }

  /* --- attendance ------------------------------------------------------- */

  // Every mark with its session date. Filtered per student in Node against that
  // student's own window, because each student's term dates may differ (cohorts run
  // on their own calendars) and one SQL window cannot express that.
  const marks = await prisma.attendanceMark.findMany({
    where: { studentId: { in: studentIds } },
    // startTime is carried for the tripwire layer, which needs to order two registers
    // on the same day (a six-hour day is Teaching then Seminar) to tell "attended the
    // morning, missed the afternoon" from the reverse. Widening this select costs
    // nothing — it is the same row, already being read.
    // sessionId is carried because register coverage reconciles marks against the
    // SESSIONS a student should have been marked in, and a mark that cannot be tied to a
    // session cannot be reconciled. It comes free -- it is a column on the row already
    // being read, not a join.
    select: { studentId: true, status: true, sessionId: true, // endTime joins startTime for the same reason: it is a column on the row already
    // being read, and without it a teaching day has no length and no gaps — the two
    // questions timetable.js exists to ask.
    session: { select: { date: true, startTime: true, endTime: true, unitId: true, kind: true } } },
  });

  const marksByStudent = new Map();
  for (const m of marks) {
    if (!marksByStudent.has(m.studentId)) marksByStudent.set(m.studentId, []);
    marksByStudent.get(m.studentId).push({
      status: m.status,
      sessionId: m.sessionId,
      date: m.session ? m.session.date : null,
      startTime: m.session ? m.session.startTime : null,
      unitId: m.session ? m.session.unitId : null,
      kind: m.session ? m.session.kind : null,
      endTime: m.session ? m.session.endTime : null,
    });
  }

  /* --- assessments, grades and submissions ------------------------------ */

  // The units each student is enrolled on, so an assessment is only counted for the
  // students actually taking that unit.
  const enrolments = await prisma.enrolment.findMany({
    where: { studentId: { in: studentIds } },
    select: { studentId: true, unitId: true },
  });

  const unitIds = [...new Set(enrolments.map((e) => e.unitId))];
  const unitsByStudent = new Map();
  for (const e of enrolments) {
    if (!unitsByStudent.has(e.studentId)) unitsByStudent.set(e.studentId, new Set());
    unitsByStudent.get(e.studentId).add(e.unitId);
  }

  const assessments = unitIds.length
    ? await prisma.assessment.findMany({
        where: { unitId: { in: unitIds } },
        select: { id: true, unitId: true, dueDate: true, maxMarks: true, weight: true, type: true, unit: { select: { termId: true } } },
      })
    : [];

  const assessmentById = new Map(assessments.map((a) => [a.id, a]));
  const assessmentIds = assessments.map((a) => a.id);

  // Indexed by unit so a student's own assessments can be walked without scanning
  // every assessment in the chunk once per student. Built from rows already fetched;
  // no extra round trip.
  const assessmentsByUnit = new Map();
  for (const a of assessments) {
    if (!assessmentsByUnit.has(a.unitId)) assessmentsByUnit.set(a.unitId, []);
    assessmentsByUnit.get(a.unitId).push(a);
  }

  const grades = assessmentIds.length
    ? await prisma.assessmentGrade.findMany({
        where: { assessmentId: { in: assessmentIds }, studentId: { in: studentIds } },
        select: { assessmentId: true, studentId: true, marks: true, gradedOn: true, gradedAt: true, submittedAt: true },
      })
    : [];

  // WHAT THE ENGINE MAY KNOW ABOUT A MITIGATING CIRCUMSTANCE.
  //
  // The status, the window, whether it covers attendance, and the adjustments. NOT
  // `category`. NOT `detail`. Those are Article 9 health data -- illness, mental health,
  // bereavement, pregnancy -- collected so the college can support a student, and putting
  // them into a risk score is a different processing purpose from the one they were
  // collected for.
  //
  // The engine must know THAT a student has cover, never WHY. This select is the
  // enforcement point and schema-contract.test.js reads this file and fails if either
  // field ever appears in it.
  //
  // Per chunk rather than hoisted, unlike the institution probes above: "does this
  // student have cover" is a question about the student, which is exactly the shape the
  // hoisted probes are NOT. Nothing here asks whether the college uses the feature at
  // all, because nothing here needs to -- a college with no claims produces empty
  // coverage, and empty coverage returns every assessment's own dueDate unchanged.
  // THE COHORT POPULATION, and this is the one the header of cohort.js is about.
  //
  // ONE QUERY PER RUN, INSTITUTION-WIDE, UNFILTERED BY THE STALE SET, HOISTED OUT OF THE
  // CHUNK LOOP. gather() runs on chunks of 200 and the ordinary incremental path scores
  // the handful markStale() flagged -- often one. A mean taken from that is a mean of the
  // students who happen to be stale, which is not a cohort. This pipeline has got the
  // same shape of question wrong three times.
  //
  // READ FROM StudentPredictionCurrent, which carries a one-run-behind figure for anybody
  // being rescored in THIS run. That is a real weakness and it is the lesser one:
  //   * The alternative -- recomputing every student's attendance from AttendanceMark in
  //     SQL -- means a second implementation of the points model, which would drift from
  //     the one in attendance.js and produce a cohort mean the screen cannot reconcile
  //     with the figures it sits beside.
  //   * With the cohort floor at 12, one stale peer moves a mean by at most a twelfth of
  //     its own error, and percentile is a rank, which one value can move by one place.
  //   * On a first-ever run nobody has a row, the population is empty, and cohort.js
  //     returns null for everything rather than a confident figure from nothing.
  // The staleness is bounded by how often the runner runs, not by how long a student has
  // been drifting, so it cannot accumulate.
  const cohortRows = await prisma.studentPredictionCurrent.findMany({
    select: {
      overallAttendance: true, averageGrade: true,
      student: { select: { cohortId: true } },
    },
  });
  const cohortPops = new Map();
  for (const r of cohortRows) {
    const key = r.student && r.student.cohortId;
    // A student with no cohort has no peers to be ranked against. Falling back to the
    // whole college would mix first-years with finalists across different courses and
    // produce a confident-looking number about nothing, which is worse than a blank.
    if (!key) continue;
    if (!cohortPops.has(key)) cohortPops.set(key, { attendance: [], grades: [] });
    const bucket = cohortPops.get(key);
    // Nulls are DROPPED, not zeroed. A student whose register was never taken has no
    // attendance figure, and scoring that as 0 would drag the cohort mean toward a
    // measurement nobody made.
    if (typeof r.overallAttendance === "number") bucket.attendance.push(r.overallAttendance);
    if (typeof r.averageGrade === "number") bucket.grades.push(r.averageGrade);
  }

  const claims = await prisma.mitigatingCircumstance.findMany({
    where: { studentId: { in: studentIds } },
    select: {
      studentId: true, status: true, raisedOn: true,
      coversFrom: true, coversTo: true, coversAttendance: true,
      adjustments: { select: { assessmentId: true, adjustmentType: true, revisedDueDate: true } },
    },
  });

  const submissions = assessmentIds.length
    ? await prisma.assessmentSubmission.findMany({
        where: { assessmentId: { in: assessmentIds }, studentId: { in: studentIds } },
        select: { assessmentId: true, studentId: true, status: true, submittedOn: true },
      })
    : [];

  // The sessions a student should have been marked in. Per chunk, because it is a
  // question about these students' units -- not an institution-wide one.
  //
  // NOT filtered by HndSession.audience. A session addressed to a subset of a unit is
  // counted for everyone on that unit, which UNDERSTATES coverage for the students it
  // never applied to. That is the safe direction -- it can only ever say the register was
  // taken less than it was -- but it is why lowCoverageLimit is deliberately generous,
  // and it is the reason a coverage figure is reported rather than scored.
  const sessions = unitIds.length
    ? await prisma.hndSession.findMany({
        where: { unitId: { in: unitIds } },
        select: { id: true, unitId: true, date: true },
      })
    : [];
  const sessionsByUnit = new Map();
  for (const h of sessions) {
    if (!sessionsByUnit.has(h.unitId)) sessionsByUnit.set(h.unitId, []);
    sessionsByUnit.get(h.unitId).push(h);
  }

  // STUDENT FINANCE. Per chunk -- whose claim it is, is a question about the student.
  //
  // ONLY LINKED ROWS. SlcApplication.studentId is nullable and nothing populates it yet,
  // so an unlinked row belongs to a NAME rather than to a person: studentName and
  // studentRef are plain strings typed by an administrator, with no relation to Student.
  // Matching on them would attach one student's loan status to another with a similar
  // name, which is a data-protection incident rather than a bug.
  const slcRows = await prisma.slcApplication.findMany({
    where: { studentId: { in: studentIds } },
    select: {
      studentId: true, status: true, loanType: true,
      applicationDate: true, decisionDate: true, statusChangedOn: true,
    },
  });
  const slcByStudent = new Map();
  for (const r of slcRows) {
    if (!slcByStudent.has(r.studentId)) slcByStudent.set(r.studentId, []);
    slcByStudent.get(r.studentId).push(r);
  }

  // WHAT THE STUDENT SAID BEFORE THEY STARTED, and when their right to study runs out.
  //
  // REACHED ONLY BY FOREIGN KEY: Student.id <- Admission.linkedStudentId <-
  // Ism.admissionId. Admission ALSO carries a plain string column literally called
  // `studentId`, which is a college ID an administrator typed with no relation to
  // anything — the schema comment there says the two names are ugly on purpose. Matching
  // on it, or on a name, would attach one person's visa expiry to another, which is a
  // data-protection incident rather than a bug.
  //
  // `ethnicity` and `religion` sit on Admission under an EDI heading and are READ BY
  // NOTHING here. They are not in this select, they are not in the module, and three
  // source-reading tests in intake.test.js assert it stays that way.
  const ismRows = await prisma.ism.findMany({
    where: { admission: { linkedStudentId: { in: studentIds } } },
    select: {
      interviewDate: true, wifiAccess: true, officeSkills: true, admitted: true,
      courseUnderstanding: true, lastStudied: true, independentLearning: true,
      educationExperience: true, strengthsWeaknesses: true, prioritiseWorkload: true,
      working: true, teamworkExample: true,
      admission: { select: { linkedStudentId: true } },
    },
  });
  const ismByStudent = new Map();
  for (const r of ismRows) {
    const sid = r.admission && r.admission.linkedStudentId;
    if (!sid) continue;
    if (!ismByStudent.has(sid)) ismByStudent.set(sid, []);
    ismByStudent.get(sid).push({ ...r, linkedStudentId: sid });
  }

  const admissionRows = await prisma.admission.findMany({
    where: { linkedStudentId: { in: studentIds } },
    select: { linkedStudentId: true, idExpiryOn: true, idExpiryStatus: true },
  });
  const admissionByStudent = new Map();
  for (const r of admissionRows) {
    if (!admissionByStudent.has(r.linkedStudentId)) admissionByStudent.set(r.linkedStudentId, []);
    admissionByStudent.get(r.linkedStudentId).push(r);
  }

  // VLE engagement observations. Per chunk -- "did this student open the course" is a
  // question about the student. There is deliberately NO institution probe here and none
  // is needed: a college that is not observable has written no rows at all, every
  // student's list is empty, and summariseEngagement returns null for everything. Absence
  // IS the guard, which is the whole reason the table stores absence rather than zero.
  const engagementRows = await prisma.vleEngagement.findMany({
    where: { studentId: { in: studentIds } },
    select: { studentId: true, unitId: true, observedOn: true, accessed: true, lastAccessOn: true },
  });
  const engagementByStudent = new Map();
  for (const r of engagementRows) {
    if (!engagementByStudent.has(r.studentId)) engagementByStudent.set(r.studentId, []);
    engagementByStudent.get(r.studentId).push(r);
  }

  const claimsByStudent = new Map();
  for (const c of claims) {
    if (!claimsByStudent.has(c.studentId)) claimsByStudent.set(c.studentId, []);
    claimsByStudent.get(c.studentId).push(c);
  }

  const gradesByStudent = new Map();
  for (const g of grades) {
    if (!gradesByStudent.has(g.studentId)) gradesByStudent.set(g.studentId, []);
    gradesByStudent.get(g.studentId).push(g);
  }

  const submissionsByStudent = new Map();
  for (const s of submissions) {
    if (!submissionsByStudent.has(s.studentId)) submissionsByStudent.set(s.studentId, []);
    submissionsByStudent.get(s.studentId).push(s);
  }

  /* --- the most recent intervention ------------------------------------- */

  const interventions = await prisma.intervention.findMany({
    where: { studentId: { in: studentIds }, status: { in: ["open", "reviewed"] } },
    orderBy: { interventionDate: "desc" },
    select: {
      studentId: true, interventionDate: true, reviewDate: true, outcome: true,
      recentAttendanceAtIntervention: true, submissionRateAtIntervention: true, averageGradeAtIntervention: true,
    },
  });

  const interventionByStudent = new Map();
  for (const i of interventions) if (!interventionByStudent.has(i.studentId)) interventionByStudent.set(i.studentId, i);

  // Does this college record submissions AT ALL? Same shape of guard as lateRecorded,
  // and for a sharper reason: NOTHING in this codebase writes AssessmentSubmission —
  // the Canvas and Blackboard adapters make no Prisma call, and the Moodle importer
  // never touches it. Without this, "work past due with no record either way" is true
  // of every assessment at every college whose feed does not populate that table, and
  // the tripwire fires for the whole institution.
  const interventionCount = new Map();
  const overdueReviews = new Map();
  for (const i of interventions) {
    interventionCount.set(i.studentId, (interventionCount.get(i.studentId) || 0) + 1);
    // Past the date somebody agreed to look again, with no outcome recorded. The schema
    // documents a null outcome as "no response measured yet", so the absence IS the
    // finding. No review date means nobody promised one, so nothing is overdue.
    if (i.reviewDate && i.reviewDate < today && !i.outcome) {
      overdueReviews.set(i.studentId, (overdueReviews.get(i.studentId) || 0) + 1);
    }
  }

  /* --- pastoral contact --------------------------------------------------- */

  // TWO MORE QUERIES PER CHUNK. They
  // earn it: low one-to-one contact with staff is directly linked to students
  // contemplating withdrawal, and neither fact is derivable from anything already
  // fetched. Both are batched over the whole chunk like everything else here.
  //
  // queryType is free text in the schema but allowlisted at routes/interactions.js, so
  // an exact match is safe for anything created through the API. "Stage 2 - Absence
  // Concern Meeting" is the college's own escalation step and counts alongside a plain
  // no-show: a student who misses that meeting has missed the meeting about missing.
  const NO_SHOW_TYPES = ["No Show", "Stage 2 - Absence Concern Meeting"];

  const contacts = await prisma.interaction.findMany({
    where: { studentId: { in: studentIds } },
    select: { studentId: true, date: true, queryType: true,
              followUpRequired: true, followUpDate: true, followUpCompletedOn: true },
  });

  const reviews = await prisma.studentReview.findMany({
    where: { studentId: { in: studentIds } },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    select: { studentId: true, date: true, progress: true, concerns: true,
              followUp: true, followUpDate: true, followUpCompletedOn: true },
  });

  // A THIRD PASTORAL QUERY PER CHUNK, and it earns its round trip: a student who used
  // the one channel the college gave them and got silence is not derivable from
  // anything already fetched.
  //
  // THE SELECT IS NARROW ON PURPOSE. `subject`, `message` and `response` are free text
  // a student wrote about their own circumstances — money, health, a disclosure — and
  // they are gated behind the "studentqueries" page. This gather feeds a row read
  // behind requirePage("prediction"), a DIFFERENT grant. Four scalars cross that
  // boundary; nothing anybody wrote does. sAdmission is the standing warning.
  const studentQueries = await prisma.studentQuery.findMany({
    where: { studentId: { in: studentIds } },
    select: { studentId: true, status: true, respondedAt: true, createdAt: true },
  });

  const queriesByStudent = new Map();
  for (const sq of studentQueries) {
    if (!queriesByStudent.has(sq.studentId)) queriesByStudent.set(sq.studentId, []);
    queriesByStudent.get(sq.studentId).push({
      status: sq.status,
      respondedAt: sq.respondedAt,
      // createdAt is the ONLY DateTime among these inputs, and everything downstream
      // compares YYYY-MM-DD as strings, so it is truncated once, here.
      //
      // NOT .toISOString().slice(0,10), which is UTC. A query sent at 00:30 BST reads
      // as 23:30 the night before, dating it a day early and making the college look a
      // day slower than it was — and this signal exists to accuse the college, so it
      // must never round in the direction of the accusation.
      createdOn: sq.createdAt ? isoDate(sq.createdAt.toISOString(), ZONE) : null,
    });
  }

  const pastoralByStudent = new Map();
  for (const c of contacts) {
    const cur = pastoralByStudent.get(c.studentId) || { lastContactOn: null, noShowCount: 0, progress: null };
    if (c.date && (!cur.lastContactOn || c.date > cur.lastContactOn)) cur.lastContactOn = c.date;
    // WINDOWED, like the repeated concern beside it. Unbounded, a student who missed
    // two arranged meetings in their first term stays on the caseload for the rest of
    // the programme however faithfully they attend afterwards — and no amount of good
    // behaviour can decrement a count that only ever goes up.
    if (NO_SHOW_TYPES.includes(c.queryType) && (!c.date || c.date >= noShowSince)) cur.noShowCount += 1;
    // Promises, from BOTH tables. A signal that could see only half of them would be
    // worse than none, because which half depends on the screen a tutor happens to use.
    (cur.promises = cur.promises || []).push({
      followUpDate: c.followUpDate, followUpCompletedOn: c.followUpCompletedOn, stillFlagged: c.followUpRequired,
    });
    pastoralByStudent.set(c.studentId, cur);
  }
  for (const r of reviews) {
    const cur = pastoralByStudent.get(r.studentId) || { lastContactOn: null, noShowCount: 0, progress: null };
    if (r.date && (!cur.lastContactOn || r.date > cur.lastContactOn)) cur.lastContactOn = r.date;
    // Ordered date desc then createdAt desc, so the first review seen per student is
    // the latest one. Later rows must not overwrite it.
    if (cur.progress === null) cur.progress = r.progress;
    // Concerns is a JSON array stored in a String column, not a Json column, so it
    // cannot be queried in SQL and must be parsed here. A throw would take down the
    // whole chunk's gather, hence the try/catch the rest of the codebase also uses.
    let parsed = [];
    try { const j = JSON.parse(r.concerns || "[]"); if (Array.isArray(j)) parsed = j; } catch { /* leave empty */ }
    (cur.concernSets = cur.concernSets || []).push({ date: r.date, concerns: parsed });
    (cur.promises = cur.promises || []).push({
      followUpDate: r.followUpDate, followUpCompletedOn: r.followUpCompletedOn, stillFlagged: r.followUp,
    });
    pastoralByStudent.set(r.studentId, cur);
  }

  /* --- the score they carried a month ago ------------------------------- */

  // The most recent history row at or before the cutoff. A student whose history
  // does not reach back that far has no direction of travel yet, which the engine
  // reports as NEW rather than guessing at one from a fortnight of data.
  const history = await prisma.studentPredictionHistory.findMany({
    where: { studentId: { in: studentIds }, calculationDateTime: { lte: new Date(`${directionCutoff}T23:59:59Z`) } },
    orderBy: { calculationDateTime: "desc" },
    select: { studentId: true, progressionScore: true, calculationDateTime: true },
  });

  // THE WHOLE TRAJECTORY, not just the nearest row. The existing read below fetches one
  // snapshot for directionOfTravel; this one carries the shape.
  //
  // `on` is converted HERE, once, using the college's own zone. calculationDateTime is a
  // DateTime and slicing ten characters off its ISO string is UTC — vle/isoDate.js
  // documents at length why that dates a 00:30 BST event to the previous day. history.js
  // is pure and takes the date already converted, exactly as engagementNormalise takes a
  // toIsoDate.
  //
  // Ordered OLDEST FIRST, which is part of history.js's contract: two snapshots from one
  // afternoon share a date, so nothing in `on` can order them and the module relies on
  // this ordering to keep the settled one.
  const historyRows = await prisma.studentPredictionHistory.findMany({
    where: { studentId: { in: studentIds } },
    orderBy: { calculationDateTime: "asc" },
    select: {
      studentId: true, riskLevel: true, progressionScore: true,
      modelVersion: true, calculationDateTime: true,
    },
  });
  const historyByStudent = new Map();
  for (const h of historyRows) {
    if (!historyByStudent.has(h.studentId)) historyByStudent.set(h.studentId, []);
    historyByStudent.get(h.studentId).push({
      on: isoDate(h.calculationDateTime.toISOString(), ZONE),
      riskLevel: h.riskLevel,
      progressionScore: h.progressionScore,
      modelVersion: h.modelVersion,
    });
  }

  const previousByStudent = new Map();
  for (const h of history) if (!previousByStudent.has(h.studentId)) previousByStudent.set(h.studentId, h);

  /* --- assemble --------------------------------------------------------- */

  for (const id of studentIds) {
    const scope = scopes.get(id) || { termId: null, label: "All time", from: null, to: null };
    const mine = marksByStudent.get(id) || [];
    const myUnits = unitsByStudent.get(id) || new Set();

    // Attendance, over the scope window and over the recent window. The recent
    // window is NOT clipped to the term: a student between terms would otherwise
    // have no recent attendance at all and lose the component that exists precisely
    // to catch somebody who has just stopped coming.
    const overallMarks = mine.filter((m) => inWindow(m.date, scope.from, scope.to));
    const recentMarks = mine.filter((m) => inWindow(m.date, recentFrom, today));

    // The window immediately before the recent one, the same length, so the tripwire
    // layer can compare like with like. Not clipped to the term either, for the same
    // reason the recent window is not: a fall that straddles a term boundary is the
    // one most worth catching.
    const priorMarks = mine.filter((m) => inWindow(m.date, priorFrom, priorTo));

    // In scope: dated inside the window, or — for a piece of work with no due date,
    // which cannot be placed on a calendar — belonging to the term being scored.
    const inScopeAssessment = (a) => {
      if (!a || !myUnits.has(a.unitId)) return false;
      if (!scope.from && !scope.to) return true;
      if (a.dueDate) return inWindow(a.dueDate, scope.from, scope.to);
      return Boolean(scope.termId) && a.unit && a.unit.termId === scope.termId;
    };

    // The deadlines this student was ACTUALLY given, and which sessions a claim excuses.
    //
    // With no claims this is empty, effectiveDeadline() hands back each assessment's own
    // dueDate, and every count below is what it was before this feature existed.
    const myClaims = claimsByStudent.get(id) || [];
    const claimOpts = { pendingSuppresses: config.pendingClaimSuppresses !== false };
    const cover = adjustments.buildCoverage(myClaims, claimOpts);
    // Nullable rather than defaulting false: "no claim covers attendance" and "we have
    // not looked" are different facts, and only the first is a finding. A student with no
    // claims at all gets null, and every list below stays the raw one untouched.
    const anyAttendanceCover = adjustments.coversAnyAttendance(myClaims, claimOpts);
    const EXCLUDED = adjustments.STATE.EXCLUDED;
    const effective = (a) => adjustments.effectiveDeadline(a, cover, today);

    const mySubs = (submissionsByStudent.get(id) || []).filter((s) => inScopeAssessment(assessmentById.get(s.assessmentId)));

    let submitted = 0, notSubmitted = 0, unknown = 0, onTime = 0, missing = 0;
    const missingPieces = [];
    for (const s of mySubs) {
      const a = assessmentById.get(s.assessmentId);
      const eff = effective(a);
      // A SUPPRESSED ASSESSMENT LEAVES BOTH SIDES OF EVERY FRACTION. Never counted as
      // submitted, never as on time, never as missing -- so the engine renormalises
      // around it exactly as it does a component with no evidence, rather than being fed
      // a fake success. Counting it as submitted-on-time would inflate the score of a
      // student in genuine difficulty and quietly remove them from the register: the
      // mirror-image harm of the bug this feature exists to fix, and the quieter one.
      if (eff.state === EXCLUDED) continue;
      if (s.status === "submitted") {
        submitted += 1;
        // No due date means nothing to be late against, so it counts as on time
        // rather than silently deflating the component. An extension supplies a LATER
        // date here, so work that arrived inside one is on time -- which is what the
        // college decided when it granted the extension.
        if (!eff.due || (s.submittedOn && s.submittedOn <= eff.due)) onTime += 1;
      } else if (s.status === "not_submitted") {
        // ONLY once the deadline has passed — for the rate as well as for the count.
        // Moodle reports "not submitted" for every open assignment, so counting work
        // that is not yet due would deflate the submission rate of a student who has
        // done nothing wrong, and can push them under the red threshold purely because
        // the college set an assessment for next month.
        //
        // An assessment with no due date cannot be judged late or missing at all, so
        // it counts as neither — it is left out of the rate rather than held against
        // anybody.
        if (eff.due && eff.due < today) {
          notSubmitted += 1;
          missing += 1;
          // The same pieces the counter counts, kept as rows. workload.js needs the id
          // to dedupe this set against the unmarked one -- a piece can be BOTH reported
          // not-submitted and sitting unmarked, and counting it twice would inflate the
          // backlog that decides a code.
          missingPieces.push({ assessmentId: s.assessmentId, dueDate: eff.due });
        }
      } else {
        unknown += 1;
      }
    }

    // Grades. The AVERAGE is scoped; the TREND deliberately is not — a collapse that
    // began last term is the thing worth catching, and clipping the trend to the
    // current term would hide exactly that. Both are expressed as percentages of the
    // assessment's own maxMarks, because a mark out of 30 and a mark out of 100 are
    // not comparable numbers.
    const myGrades = (gradesByStudent.get(id) || [])
      .map((g) => {
        const a = assessmentById.get(g.assessmentId);
        const max = a && a.maxMarks > 0 ? a.maxMarks : 100;
        return { ...g, pct: Math.round((g.marks / max) * 1000) / 10, assessment: a };
      })
      .filter((g) => g.assessment && myUnits.has(g.assessment.unitId))
      // ORDERED DETERMINISTICALLY, because the grade trend reads the last N against
      // the N before them and a shuffled list produces a different answer each run.
      //
      // A day-resolution key is not enough on its own: a tutor entering one
      // assessment's marks in a sitting, or a first Moodle import where no grade item
      // carries a date, gives every row the same day. Equal keys then preserve
      // Postgres' arbitrary return order, and the same student comes back IMPROVING on
      // one run and DECLINING on the next with nothing about them having changed —
      // which also flips a red indicator and can tip OVR-004 into worsening a band.
      //
      // So: the graded date, then the full timestamp to separate marks entered on the
      // same day, then the assessment id as a final tie-break that is stable across
      // runs even when two rows share a timestamp exactly.
      .sort((a, b) => {
        const ad = a.gradedOn || (a.gradedAt ? a.gradedAt.toISOString().slice(0, 10) : "");
        const bd = b.gradedOn || (b.gradedAt ? b.gradedAt.toISOString().slice(0, 10) : "");
        if (ad !== bd) return ad < bd ? -1 : 1;
        const at = a.gradedAt ? a.gradedAt.getTime() : 0;
        const bt = b.gradedAt ? b.gradedAt.getTime() : 0;
        if (at !== bt) return at - bt;
        return a.assessmentId < b.assessmentId ? -1 : a.assessmentId > b.assessmentId ? 1 : 0;
      });

    const scopedGrades = myGrades.filter((g) => inScopeAssessment(g.assessment));

    // Work that is past its deadline and carries no definite answer either way.
    //
    // DISTINCT FROM `missing`. `missing` counts rows that positively say the work was
    // not handed in; this counts work with NO answer — either no submission row at
    // all, or one Moodle left as "unknown". That silence is not a fact about the
    // student and never touches the score, which is why it is a tripwire: it says
    // somebody needs to find out, not that anybody has done anything wrong.
    const decided = new Set(
      mySubs.filter((s) => s.status === "submitted" || s.status === "not_submitted")
        .map((s) => s.assessmentId)
    );

    const dueUnmarked = [];
    for (const unitId of myUnits) {
      for (const a of assessmentsByUnit.get(unitId) || []) {
        if (!inScopeAssessment(a)) continue;
        // No due date means nothing can be overdue against it — the same rule the
        // submission counts above already apply. And an extension that has NOT yet run
        // out means the same thing: an extension is a new deadline, not an exemption, so
        // one that HAS run out puts the work back in this list.
        const eff = effective(a);
        if (eff.state === EXCLUDED) continue;
        if (!eff.due || eff.due >= today) continue;
        if (decided.has(a.id)) continue;
        // assessmentId rides along for the same dedupe. It costs nothing -- the
        // assessment is already in hand.
        dueUnmarked.push({ assessmentId: a.id, dueDate: eff.due });
      }
    }

    // How many in-scope assessments a claim removed from the fractions. Counted once
    // over the student's own assessments rather than inside the loops above, which walk
    // overlapping sets and would double-count.
    //
    // It is REPORTED because the suppression must be visible on the screen it was
    // performed for: without it, a submission rate of 100% from two assessments looks
    // identical to one from twelve, and the reader has no way to tell that the
    // denominator shrank.
    let mitigatedAssessmentCount = 0;
    for (const unitId of myUnits) {
      for (const a of assessmentsByUnit.get(unitId) || []) {
        if (!inScopeAssessment(a)) continue;
        if (effective(a).state === EXCLUDED) mitigatedAssessmentCount += 1;
      }
    }

    // A STAFF signal, in the family of markingLatencyDays and overdueFollowUpCount: a
    // claim sitting undecided is a fact about the institution's decision queue, and the
    // student underneath it is the person being harmed by the delay. Reported, never
    // scored.
    //
    // Measured from raisedOn -- when the STUDENT asked -- and not from createdAt or
    // updatedAt. This is deliberately the opposite choice from the follow-up watermark,
    // which had to abandon a backdatable date. There the question was "when did this
    // college become able to record a completion", an institutional fact that a
    // backdated row would corrupt. Here the question is "how long has this student been
    // waiting", and if they raised it on 1 March and an administrator typed it in on the
    // 20th, they have been waiting since 1 March. Different questions, different dates.
    const openClaims = myClaims.filter((c) => c.status === "open");
    const oldestOpenMitigationOn = openClaims.length
      ? openClaims.map((c) => c.raisedOn).filter(Boolean).sort()[0] || null
      : null;

    const intervention = interventionByStudent.get(id) || null;
    const previous = previousByStudent.get(id) || null;

    // The tripwire layer reads the same in-memory shapes assembled above — it issues
    // no query of its own and adds nothing to the round-trip budget this file exists
    // to protect. Its output rides beside `raw` rather than inside it, because none
    // of it is an input to the score.
    // Raw status counts, which the two attendance MODELS deliberately discard — the
    // points model folds L and E into a single percentage. Lateness and unexplained
    // absence are orthogonal to both models and are reported as their own figures.
    // TWO LISTS, AND THE LINE BETWEEN THEM IS THE WHOLE DESIGN.
    //
    // `rateMarks` drops sessions an approved claim excuses and feeds the PERCENTAGES --
    // the figures that reach the score. A session the college agreed to excuse is not
    // evidence of disengagement, and leaving it in the denominator makes the
    // accommodation invisible while it goes on depressing the number.
    //
    // `overallMarks` stays RAW and feeds everything else: lastAttendedOn, the absence
    // streak, the weekly pattern, the first-session shape, and every pastoral code. A
    // student on approved mitigating circumstances is one the college should be speaking
    // to MORE, not one it should stop noticing -- and a sponsoring provider still has to
    // evidence engagement, which those dates are what answers. Muting the dates would
    // turn a support measure into a way of losing sight of the student it supports.
    //
    // With no attendance-covering claim the two lists are identical and nothing changes.
    const rateMarks = anyAttendanceCover
      ? overallMarks.filter((m) => !adjustments.attendanceCovered(m, myClaims, claimOpts))
      : overallMarks;
    const recentRateMarks = anyAttendanceCover
      ? recentMarks.filter((m) => !adjustments.attendanceCovered(m, myClaims, claimOpts))
      : recentMarks;
    const priorRateMarks = anyAttendanceCover
      ? priorMarks.filter((m) => !adjustments.attendanceCovered(m, myClaims, claimOpts))
      : priorMarks;

    // Unexplained absence is computed from the rate list too, and that is the point of
    // it: an absence covered by an approved claim is, by definition, explained. Counting
    // it as unexplained would have the screen report a student as unexplained-absent for
    // precisely the period the college accepted an explanation for.
    const counts = attendance.summarise(rateMarks);
    const quality = tripwires.attendanceQuality(counts, {
      lateRecorded, excusedRecorded, minAbsences: config.minAbsencesForShare,
    });

    const attainment = tripwires.attainmentShape(scopedGrades.map((g) => g.pct), config);

    // Attendance per unit, from the marks already in hand. Grouped in Node — the
    // session's unitId came along on the select that was already being issued.
    const byUnit = new Map();
    for (const m of rateMarks) {
      if (!m.unitId) continue;
      if (!byUnit.has(m.unitId)) byUnit.set(m.unitId, []);
      byUnit.get(m.unitId).push(m);
    }
    const perUnitAttendance = [...byUnit.entries()].map(([unitId, ms]) => {
      const sum = summariseAttendance(ms, config.attendanceMode);
      return { unitId, pct: sum.pct, marked: sum.marked };
    });
    const dispersion = tripwires.unitDispersion(perUnitAttendance, config);

    // Marks grouped by the unit they belong to, so "which units have nothing banked"
    // can be asked. Every unit the student is enrolled on appears, including the ones
    // with no marks at all — unpassedUnits() needs to see them to drop them.
    const gradesByUnit = new Map();
    for (const unitId of myUnits) gradesByUnit.set(unitId, []);
    for (const g of scopedGrades) {
      const unitId = g.assessment && g.assessment.unitId;
      if (unitId && gradesByUnit.has(unitId)) gradesByUnit.get(unitId).push(g.pct);
    }
    const banked = tripwires.unpassedUnits(
      [...gradesByUnit.entries()].map(([unitId, pcts]) => ({ unitId, pcts })), config
    );

    const regularity = tripwires.weeklyRegularity(overallMarks);

    // The weighting the engine has never read. Assessment.weight came along on the
    // select that was already being issued.
    const weighted = tripwires.weightedGrade(scopedGrades.map((g) => ({
      pct: g.pct, weight: g.assessment ? g.assessment.weight : 0,
    })));

    // A staff figure, from the two dates the Moodle importer already stores.
    const latency = tripwires.markingLatency(scopedGrades.map((g) => ({
      submittedAt: g.submittedAt || null, gradedOn: g.gradedOn || null,
    })));

    const dayShape = tripwires.firstSessionAbsence(overallMarks, { minDays: config.firstSessionMinDays });

    const lastGradedOn = myGrades.reduce(
      (max, g) => (g.gradedOn && (!max || g.gradedOn > max) ? g.gradedOn : max), null
    );

    const rawPastoral = pastoralByStudent.get(id) || { lastContactOn: null, noShowCount: 0, progress: null };
    const concernRepeat = tripwires.repeatConcerns(rawPastoral.concernSets || [], concernSince);
    const missedFollowUps = tripwires.overdueFollowUps(
      rawPastoral.promises || [], followUpClosureFrom, followUpCutoff, followUpSince
    );
    const pastoral = pastoralInUse
      ? { ...rawPastoral, repeated: concernRepeat.repeated || [], overdueFollowUps: missedFollowUps.overdue }
      : null;

    // Late submission, read from the marks rather than from AssessmentSubmission —
    // that table is written by nothing. Scoped like the average grade is.
    const backlog = tripwires.queryBacklog(queriesByStudent.get(id) || [], {
      repliesRecorded: queryRepliesRecorded,
    });

    // THE LIVE HARM, and the reason this whole feature exists. moodle.js populates
    // submittedAt from gradedatesubmitted and this comparison used the assessment's own
    // dueDate, because nothing recorded that an extension had been granted -- so
    // TRIP_CHRONIC_LATE fired on students for using an accommodation the college itself
    // granted them, with nothing on the screen saying so.
    //
    // Excluded work leaves the list entirely rather than arriving with a null date: a
    // null dueDate reads as "nothing to be late against", which counts the piece as ON
    // TIME and inflates the very rate this is meant to correct.
    const timing = tripwires.submissionTiming(
      scopedGrades
        .map((g) => ({ g, eff: effective(g.assessment) }))
        .filter((x) => x.eff.state !== EXCLUDED)
        .map(({ g, eff }) => ({ submittedOn: g.submittedAt || null, dueDate: eff.due })),
      { submittedOnRecorded }
    );

    // Assessments falling due in the near term. A fact about the timetable rather than
    // the student, so it is a figure and never a code — it would fire cohort-wide.
    let dueSoon = 0;
    const soonCutoff = shiftDays(today, config.dueSoonDays);
    for (const unitId of myUnits) {
      for (const a of assessmentsByUnit.get(unitId) || []) {
        // NOT inScopeAssessment. Under the default current-term scope the 14-day
        // horizon routinely runs past the end of term, and clipping it would report
        // "nothing due" in the last fortnight of every term — when the student is most
        // likely to have work waiting on the other side of the boundary. This figure is
        // about the timetable, and the timetable does not stop at scope.to.
        const eff = effective(a);
        if (eff.state === EXCLUDED) continue;
        if (!eff.due) continue;
        if (eff.due >= today && eff.due <= soonCutoff) dueSoon += 1;
      }
    }

    // WHETHER THE ATTENDANCE PERCENTAGE IS WORTH ANYTHING.
    //
    // Computed from `rateMarks`, the same list the percentage itself comes from, so the
    // observation count and the figure it qualifies can never disagree.
    //
    // The scheduled side is the student's own units clipped to the same scope window as
    // the marks. A mismatched scope would report falsely low coverage, which reads as an
    // accusation about a tutor.
    const myScheduled = [];
    for (const unitId of myUnits) {
      for (const h of sessionsByUnit.get(unitId) || []) {
        if (inWindow(h.date, scope.from, scope.to)) myScheduled.push(h);
      }
    }

    // Scoped like everything else. An observation from last term says nothing about
    // whether the student is opening the course now.
    const vle = engagement.summariseEngagement(
      (engagementByStudent.get(id) || []).filter((r) => inWindow(r.observedOn, scope.from, scope.to)),
      { minObservedDays: config.minObservedDays },
    );

    const attendanceSummary = summariseAttendance(rateMarks, config.attendanceMode);
    const reg = coverage.evaluate({
      today,
      overallAttendance: attendanceSummary.pct,
      marks: rateMarks,
      scheduledSessions: myScheduled,
      weeksIntoProgramme: weeksByStudent.get(id) ?? null,
      institution: { timetableRecorded },
    }, config);

    // WHERE THIS STUDENT STANDS AGAINST THEIR OWN COHORT.
    //
    // The population comes from the hoisted map above and is never derived from anything
    // in this loop. A student with no cohort gets empty arrays and cohort.js returns null
    // for everything, which is the honest answer: there are no peers to rank them against.
    // The SAME definition engine.js uses at line 196 -- round1(mean(pcts)) over the
    // scoped, graded pieces. It has to be, because the population above is read from the
    // stored averageGrade column: a percentile is only meaningful if the value and the
    // population were computed the same way, and a weighted figure ranked against plain
    // means would be a comparison of two different things wearing one label.
    const gradePcts = scopedGrades.map((g) => g.pct).filter((n) => typeof n === "number" && Number.isFinite(n));
    const avgGrade = gradePcts.length
      ? Math.round((gradePcts.reduce((a, b) => a + b, 0) / gradePcts.length) * 10) / 10
      : null;

    const myCohortId = cohortIdByStudent.get(id) || null;
    const pop = (myCohortId && cohortPops.get(myCohortId)) || { attendance: [], grades: [] };
    const standing = cohort.evaluate({
      // The SANITISED figure, so a student is never ranked on a percentage this run has
      // just decided is not reportable.
      attendancePct: reg.overallAttendance,
      cohortAttendancePcts: pop.attendance,
      averageGrade: avgGrade,
      cohortAverageGrades: pop.grades,
    }, config);

    // WORKLOAD. The assessments at their EFFECTIVE deadlines, with suppressed work
    // already gone, so a heavy fortnight is not manufactured out of pieces this student
    // has been excused from.
    const horizonAssessments = [];
    for (const unitId of myUnits) {
      for (const a of assessmentsByUnit.get(unitId) || []) {
        const eff = effective(a);
        if (eff.state === EXCLUDED) continue;
        horizonAssessments.push({ dueDate: eff.due, weight: a.weight });
      }
    }
    const load = workload.evaluate({
      today,
      assessments: horizonAssessments,
      backlog: { missing: missingPieces, unresolved: dueUnmarked },
      // The rolling window exactly as it was already summarised, never recomputed --
      // two definitions of "recent attendance" on one screen is how they drift.
      recentAttendance: summariseAttendance(recentRateMarks, config.attendanceMode),
      weeksIntoProgramme: weeksByStudent.get(id) ?? null,
      institution: { submissionsRecorded },
    }, config);

    // STUDENT FINANCE. A student whose loan has not come through attends and submits
    // right up until the day they leave, which is exactly why it is invisible in the
    // academic figures beside it.
    const money = funding.evaluate({
      today,
      applications: slcByStudent.get(id) || [],
      institution: { slcRecorded },
    }, config);

    // THE SHAPE OF THE ABSENCE. Reads the RAW marks, not rateMarks: a session an approved
    // claim excuses is still a session the student was not at, and the pattern this looks
    // for -- every Friday, or three whole weeks -- is exactly the kind of thing a claim
    // explains rather than erases. The percentages drop covered sessions; the shape does
    // not, for the same reason lastAttendedOn does not.
    const shape = sessionShape.evaluate({
      today,
      marks: overallMarks,
      weeksIntoProgramme: weeksByStudent.get(id) ?? null,
      institution: { kindRecorded },
    }, config);

    // WHICH KIND OF ASSESSMENT THEY FAIL. Takes the pct already computed for every other
    // grade figure rather than re-deriving it from marks/maxMarks — two definitions of a
    // percentage on one screen is how they drift.
    const byType = assessmentType.evaluate({
      grades: scopedGrades.map((g) => ({ pct: g.pct, type: g.assessment ? g.assessment.type : null })),
      institution: { assessmentTypesRecorded },
      weeksIntoProgramme: weeksByStudent.get(id) ?? null,
    }, config);

    // THE SHAPE OF THE TEACHING DAY. Reads the RAW marks like sessions.js and for the
    // same reason: a session an approved claim excuses is still a session the student was
    // not at, and a nine o'clock start is exactly the kind of thing a claim explains
    // rather than erases.
    //
    // lateRecorded is the probe computed at the top of this function — one argument, not
    // a new query. It is required because L counts as attendance in the absence rate, so
    // a college with no lateness code would otherwise report a confident zero.
    const dayShapeTimetable = timetableShape.evaluate({
      marks: overallMarks,
      institution: { lateRecorded },
      weeksIntoProgramme: weeksByStudent.get(id) ?? null,
    }, config);

    const entry = intake.evaluate({
      today,
      isms: ismByStudent.get(id) || [],
      admissions: admissionByStudent.get(id) || [],
      weeksIntoProgramme: weeksByStudent.get(id) ?? null,
      institution: { ismRecorded, idExpiryRecorded },
    }, config);

    const past = historyShape.evaluate({
      today,
      history: historyByStudent.get(id) || [],
    }, config);

    const trips = tripwires.evaluate({
      today,
      marks: overallMarks,
      recent: summariseAttendance(recentRateMarks, config.attendanceMode),
      prior: summariseAttendance(priorRateMarks, config.attendanceMode),
      dueUnmarked,
      submissionsRecorded,
      gradeDates: myGrades.map((g) => g.gradedOn || null),
      attainment,
      pastoral,
      dispersion,
      banked,
      timing,
      queries: backlog,
      weeksIntoProgramme: weeksByStudent.get(id) ?? null,
      interventions: { overdueReviews: overdueReviews.get(id) || 0 },
    }, config);

    // The most recent thing this student did that the college can see, of ANY kind.
    // Attendance alone is not engagement: a student who is not in class but is having
    // work marked is engaged, and a sponsoring provider is now required to evidence
    // academic engagement rather than attendance.
    const lastEngagedOn = tripwires.engagementRecency({
      lastAttendedOn: trips.lastAttendedOn,
      lastGradedOn,
      lastPastoralOn: pastoral ? pastoral.lastContactOn : null,
      lastVleAccessOn: vle.lastAccessOn,
      lastQueryOn: (queriesByStudent.get(id) || []).reduce(
        (max, sq) => (sq.createdOn && (!max || sq.createdOn > max) ? sq.createdOn : max), null
      ),
    });

    out.set(id, {
      scope,
      tripwires: {
        ...trips,
        ...quality,
        ...attainment,
        lastEngagedOn,
        openInterventionCount: interventionCount.get(id) || 0,
        worstUnitId: dispersion.worstUnitId,
        unitAttendanceSpread: dispersion.spread,
        unpassedUnitCount: banked.unpassed,
        attendanceRegularity: regularity,
        lateSubmissionRate: timing.lateRate,
        meanDaysLate: timing.meanDaysLate,
        gradedWithDates: timing.gradedWithDates,
        oldestOpenQueryOn: backlog.oldestOpenQueryOn,
        openQueryCount: backlog.openQueryCount,
        overdueFollowUpCount: missedFollowUps.overdue,
        openMitigationCount: myClaims.length ? openClaims.length : null,
        oldestOpenMitigationOn,
        mitigatedAssessmentCount: myClaims.length ? mitigatedAssessmentCount : null,
        attendanceMitigated: anyAttendanceCover,
        weightedAverageGrade: weighted.value,
        gradeWasWeighted: weighted.value === null ? null : weighted.weighted,
        markingLatencyDays: latency.meanDays,
        firstSessionAbsenceRate: dayShape.firstSessionRate,
        laterSessionAbsenceRate: dayShape.laterRate,
        // Forwarded for the contact deficit, which crosses the risk level with these
        // dates and therefore CANNOT be computed here: gather() runs before score(),
        // so the only risk level visible to it is the previous run's — and every
        // student in this batch is here precisely because that row is stale.
        // runner.js does the cross, downstream of scoring.
        lastPastoralOn: pastoral ? pastoral.lastContactOn : null,
        pastoralRecorded: pastoralInUse,
        weeksIntoProgramme: weeksByStudent.get(id) ?? null,
        assessmentsDueSoon: dueSoon,
        // Register coverage. A STAFF signal beside the score: a register nobody took is a
        // fact about a tutor, and the student sitting under it is the person whose figure
        // is being spoiled by it.
        registerCoverageRate: reg.coverageRate,
        scheduledSessionCount: reg.scheduledSessions,
        markedSessionCount: reg.markedSessions,
        attendanceConfidence: reg.confidence,
        attendanceObservations: reg.observations,
        lastRegisterMarkOn: reg.lastMarkOn,
        // Cohort standing. Context beside the score and never a replacement for it: a
        // student at the 90th percentile of a failing cohort is still failing.
        cohortAttendancePercentile: standing.attendance.percentile,
        cohortAttainmentPercentile: standing.attainment.percentile,
        cohortSize: standing.cohortAttendance.n,
        cohortStruggling: standing.cohortStruggling,
        // VLE engagement. All null where the college was never observable -- see the
        // table's own comment for why no count can reconstruct that distinction later.
        vleLastAccessOn: vle.lastAccessOn,
        vleActiveDayRate: vle.activeDayRate,
        vleObservedDays: vle.observedDays,
        vleUnitsObserved: vle.unitsObserved,
        peakFrom: load.peakFrom,
        peakTo: load.peakTo,
        peakCount: load.peakCount,
        peakWeightShare: load.peakWeightShare,
        peakWasWeighted: load.peakWasWeighted,
        undatedAssessments: load.undatedAssessments,
        carriedBacklogCount: load.carriedBacklogCount,
        fundingPosition: money.fundingPosition,
        fundingUnsettledSince: money.fundingUnsettledSince,
        fundingSettledOn: money.fundingSettledOn,
        fundingRefusedOn: money.fundingRefusedOn,
        fundingApplications: money.fundingApplications,
        fundingNotApplied: money.fundingNotApplied,
        worstAbsenceWeekday: shape.worstAbsenceWeekday,
        worstWeekdayAbsenceRate: shape.worstWeekdayAbsenceRate,
        weekdayAbsenceGap: shape.weekdayAbsenceGap,
        weekdaysMeasured: shape.weekdaysMeasured,
        worstAbsenceKind: shape.worstAbsenceKind,
        worstKindAbsenceRate: shape.worstKindAbsenceRate,
        kindAbsenceGap: shape.kindAbsenceGap,
        kindsMeasured: shape.kindsMeasured,
        unseenWeekRun: shape.unseenWeekRun,
        unseenSinceWeekOn: shape.unseenSinceWeekOn,
        lastAttendedWeekOn: shape.lastAttendedWeekOn,
        longestUnseenWeekRun: shape.longestUnseenWeekRun,
        observedWeeks: shape.observedWeeks,
        entryProfileRecorded: entry.entryProfileRecorded,
        entryProfileOn: entry.entryProfileOn,
        entryProfileAnswered: entry.entryProfileAnswered,
        entryProfileQuestions: entry.entryProfileQuestions,
        entryProfileBarriers: entry.entryProfileBarriers,
        entryWifiAtHome: entry.entryWifiAtHome,
        entryKnowsOfficeSoftware: entry.entryKnowsOfficeSoftware,
        entryAdmittedOutcome: entry.entryAdmittedOutcome,
        rightToStudyExpiresOn: entry.rightToStudyExpiresOn,
        currentBandSince: past.currentBandSince,
        worstBandHeld: past.worstBandHeld,
        worstBandSince: past.worstBandSince,
        observedDays: past.observedDays,
        bandChanges: past.bandChanges,
        bandsVisited: past.bandsVisited,
        recoveredPoints: past.recoveredPoints,
        recoveredBy: past.recoveredBy,
        lowestScore: past.lowestScore,
        lowestOn: past.lowestOn,
        // Forwarded for the DIVERGENCE layer, which like contactDeficit cannot be
        // computed here: it needs submissionRate, and engine.js derives that in measure()
        // — downstream of gather(). Recomputing it here would be a second implementation
        // of a stored figure, which is exactly the drift this pipeline keeps being bitten
        // by. runner.js does the call, after score().
        submittedCount: submitted,
        notSubmittedCount: notSubmitted,
        vleActiveDayRate: vle.activeDayRate,
        vleObservedDaysForDivergence: vle.observedDays,
        averageGradeForDivergence: avgGrade,
        gradedCountForDivergence: gradePcts.length,
        attendanceObservationsForDivergence: reg.observations,
        worstAssessmentType: byType.worstAssessmentType,
        worstAssessmentTypePassRate: byType.worstAssessmentTypePassRate,
        worstAssessmentTypeMeanPct: byType.worstAssessmentTypeMeanPct,
        assessmentTypePassRateGap: byType.assessmentTypePassRateGap,
        assessmentTypeMeanGap: byType.assessmentTypeMeanGap,
        assessmentTypesMeasured: byType.assessmentTypesMeasured,
        assessmentTypesSeen: byType.assessmentTypesSeen,
        untypedGradeCount: byType.untypedGradeCount,
        earlyStartAbsenceRate: dayShapeTimetable.earlyStartAbsenceRate,
        laterStartAbsenceRate: dayShapeTimetable.laterStartAbsenceRate,
        earlyStartAbsenceGap: dayShapeTimetable.earlyStartAbsenceGap,
        earlyStartLatenessRate: dayShapeTimetable.earlyStartLatenessRate,
        laterStartLatenessRate: dayShapeTimetable.laterStartLatenessRate,
        earlyStartLatenessGap: dayShapeTimetable.earlyStartLatenessGap,
        earlyStartDays: dayShapeTimetable.earlyStartDays,
        longDayMissedRate: dayShapeTimetable.longDayMissedRate,
        shortDayMissedRate: dayShapeTimetable.shortDayMissedRate,
        longDayMissedGap: dayShapeTimetable.longDayMissedGap,
        longDaysMeasured: dayShapeTimetable.longDaysMeasured,
        afterLongGapAbsenceRate: dayShapeTimetable.afterLongGapAbsenceRate,
        afterShortGapAbsenceRate: dayShapeTimetable.afterShortGapAbsenceRate,
        longGapAbsenceGap: dayShapeTimetable.longGapAbsenceGap,
        longGapSessions: dayShapeTimetable.longGapSessions,
        daysWithoutSessionEnd: dayShapeTimetable.daysWithoutSessionEnd,
        singleSessionDays: dayShapeTimetable.singleSessionDays,
        submissionsRecorded,
        // Appended AFTER the ...trips spread above, so this wins. Three vocabularies with
        // no overlapping strings, all TRIP_-prefixed, all landing in the same
        // riskDriverCodes column runner.js builds -- staff read one list of reasons, not
        // three. And, like every other TRIP_ code, none of them can reach OVR-004:
        // engine.js counts its own internal reds array and riskDriverCodes is a copy taken
        // afterwards.
        //
        // cohortStruggling is deliberately NOT in here. It is true of every student in the
        // cohort at once, and a hundred caseload rows carrying an identical reason is no
        // caseload -- the same judgement metrics.js already made for assessmentsDueSoon.
        codes: [
          ...(trips.codes || []), ...(reg.codes || []), ...(standing.codes || []),
          ...(load.codes || []), ...(money.codes || []), ...(shape.codes || []),
          ...(entry.codes || []), ...(past.codes || []),
          // timetable.js emits no codes at all, deliberately — its figures are the most
          // cohort-wide facts a college has. Spread anyway so that a future decision to
          // add one does not need this line found and changed.
          ...(byType.codes || []), ...(dayShapeTimetable.codes || []),
        ],
      },
      raw: {
        attendance: {
          // THE SANITISED FIGURE, and this is the point at which register coverage stops
          // being a caption and starts changing scores.
          //
          // A percentage resting on three marks is not a measurement of a student; it is a
          // measurement of how often somebody opened the register. Passing it to the engine
          // as though it were evidence lets one absence walk a student across a band.
          // coverage.evaluate() withholds it below the floor -- null, never a low number
          // and never zero -- and engine.js already renormalises a component with no
          // evidence out of both numerator and denominator, so the score becomes an honest
          // one built on the components that ARE supported.
          //
          // `marked` is left as counted so the screen can still say what was withheld and
          // why, rather than showing a blank nobody can account for.
          overall: { ...summariseAttendance(rateMarks, config.attendanceMode), pct: reg.overallAttendance },
          recent: summariseAttendance(recentRateMarks, config.attendanceMode),
        },
        assessments: {
          submitted, notSubmitted, unknown, onTime, missing,
          // The average uses the scoped marks; the trend uses all of them.
          graded: scopedGrades.map((g) => ({ pct: g.pct })),
          gradedForTrend: myGrades.map((g) => ({ pct: g.pct })),
        },
        intervention: intervention
          ? {
              daysSince: daysBetween(intervention.interventionDate, today),
              recentAttendanceAt: intervention.recentAttendanceAtIntervention,
              submissionRateAt: intervention.submissionRateAtIntervention,
              averageGradeAt: intervention.averageGradeAtIntervention,
            }
          : null,
        previous: previous ? { progressionScore: previous.progressionScore } : null,
      },
    });
  }

  return out;
}

module.exports = { gather, resolveScope, summariseAttendance, shiftDays, daysBetween };
