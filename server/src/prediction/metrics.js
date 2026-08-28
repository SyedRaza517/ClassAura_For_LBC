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
         answeredQueryRows, firstClosedContact, firstClosedReview] = await Promise.all([
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
    prisma.interaction.aggregate({ _min: { followUpCompletedOn: true } }),
    prisma.studentReview.aggregate({ _min: { followUpCompletedOn: true } }),
  ]);
  // Does this college's feed carry submission dates at all? Fourth guard of the same
  // shape — nothing anywhere carrying a submittedAt means "0% late" is a statement
  // about the integration, not about anybody's coursework.
  const submittedOnRecorded = submittedAtRows > 0;

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
    firstClosedContact._min.followUpCompletedOn,
    firstClosedReview._min.followUpCompletedOn,
  ].filter(Boolean);
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
  for (const s of students) scopes.set(s.id, resolveScope(s, config));

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
    select: { studentId: true, status: true, session: { select: { date: true, startTime: true, unitId: true } } },
  });

  const marksByStudent = new Map();
  for (const m of marks) {
    if (!marksByStudent.has(m.studentId)) marksByStudent.set(m.studentId, []);
    marksByStudent.get(m.studentId).push({
      status: m.status,
      date: m.session ? m.session.date : null,
      startTime: m.session ? m.session.startTime : null,
      unitId: m.session ? m.session.unitId : null,
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
        select: { id: true, unitId: true, dueDate: true, maxMarks: true, unit: { select: { termId: true } } },
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

  const submissions = assessmentIds.length
    ? await prisma.assessmentSubmission.findMany({
        where: { assessmentId: { in: assessmentIds }, studentId: { in: studentIds } },
        select: { assessmentId: true, studentId: true, status: true, submittedOn: true },
      })
    : [];

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

    const mySubs = (submissionsByStudent.get(id) || []).filter((s) => inScopeAssessment(assessmentById.get(s.assessmentId)));

    let submitted = 0, notSubmitted = 0, unknown = 0, onTime = 0, missing = 0;
    for (const s of mySubs) {
      const a = assessmentById.get(s.assessmentId);
      if (s.status === "submitted") {
        submitted += 1;
        // No due date means nothing to be late against, so it counts as on time
        // rather than silently deflating the component.
        if (!a.dueDate || (s.submittedOn && s.submittedOn <= a.dueDate)) onTime += 1;
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
        if (a.dueDate && a.dueDate < today) {
          notSubmitted += 1;
          missing += 1;
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
        // submission counts above already apply.
        if (!a.dueDate || a.dueDate >= today) continue;
        if (decided.has(a.id)) continue;
        dueUnmarked.push({ dueDate: a.dueDate });
      }
    }

    const intervention = interventionByStudent.get(id) || null;
    const previous = previousByStudent.get(id) || null;

    // The tripwire layer reads the same in-memory shapes assembled above — it issues
    // no query of its own and adds nothing to the round-trip budget this file exists
    // to protect. Its output rides beside `raw` rather than inside it, because none
    // of it is an input to the score.
    // Raw status counts, which the two attendance MODELS deliberately discard — the
    // points model folds L and E into a single percentage. Lateness and unexplained
    // absence are orthogonal to both models and are reported as their own figures.
    const counts = attendance.summarise(overallMarks);
    const quality = tripwires.attendanceQuality(counts, {
      lateRecorded, excusedRecorded, minAbsences: config.minAbsencesForShare,
    });

    const attainment = tripwires.attainmentShape(scopedGrades.map((g) => g.pct), config);

    // Attendance per unit, from the marks already in hand. Grouped in Node — the
    // session's unitId came along on the select that was already being issued.
    const byUnit = new Map();
    for (const m of overallMarks) {
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

    const lastGradedOn = myGrades.reduce(
      (max, g) => (g.gradedOn && (!max || g.gradedOn > max) ? g.gradedOn : max), null
    );

    const rawPastoral = pastoralByStudent.get(id) || { lastContactOn: null, noShowCount: 0, progress: null };
    const concernRepeat = tripwires.repeatConcerns(rawPastoral.concernSets || [], concernSince);
    const missedFollowUps = tripwires.overdueFollowUps(
      rawPastoral.promises || [], followUpClosureFrom, followUpCutoff
    );
    const pastoral = pastoralInUse
      ? { ...rawPastoral, repeated: concernRepeat.repeated || [], overdueFollowUps: missedFollowUps.overdue }
      : null;

    // Late submission, read from the marks rather than from AssessmentSubmission —
    // that table is written by nothing. Scoped like the average grade is.
    const backlog = tripwires.queryBacklog(queriesByStudent.get(id) || [], {
      repliesRecorded: queryRepliesRecorded,
    });

    const timing = tripwires.submissionTiming(
      scopedGrades.map((g) => ({
        submittedOn: g.submittedAt || null,
        dueDate: g.assessment ? g.assessment.dueDate : null,
      })),
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
        if (!a.dueDate) continue;
        if (a.dueDate >= today && a.dueDate <= soonCutoff) dueSoon += 1;
      }
    }

    const trips = tripwires.evaluate({
      today,
      marks: overallMarks,
      recent: summariseAttendance(recentMarks, config.attendanceMode),
      prior: summariseAttendance(priorMarks, config.attendanceMode),
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
        // Forwarded for the contact deficit, which crosses the risk level with these
        // dates and therefore CANNOT be computed here: gather() runs before score(),
        // so the only risk level visible to it is the previous run's — and every
        // student in this batch is here precisely because that row is stale.
        // runner.js does the cross, downstream of scoring.
        lastPastoralOn: pastoral ? pastoral.lastContactOn : null,
        pastoralRecorded: pastoralInUse,
        weeksIntoProgramme: weeksByStudent.get(id) ?? null,
        assessmentsDueSoon: dueSoon,
      },
      raw: {
        attendance: {
          overall: summariseAttendance(overallMarks, config.attendanceMode),
          recent: summariseAttendance(recentMarks, config.attendanceMode),
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
