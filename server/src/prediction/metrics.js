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
const { localDate } = require("../clock");
const attendance = require("../attendance");

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

  /* --- students and their term calendars -------------------------------- */

  const students = await prisma.student.findMany({
    where: { id: { in: studentIds } },
    select: {
      id: true,
      cohortId: true,
      cohort: { select: { id: true, terms: { select: { id: true, year: true, index: true, name: true, start: true, end: true } } } },
    },
  });

  const scopes = new Map();
  for (const s of students) scopes.set(s.id, resolveScope(s, config));

  /* --- attendance ------------------------------------------------------- */

  // Every mark with its session date. Filtered per student in Node against that
  // student's own window, because each student's term dates may differ (cohorts run
  // on their own calendars) and one SQL window cannot express that.
  const marks = await prisma.attendanceMark.findMany({
    where: { studentId: { in: studentIds } },
    select: { studentId: true, status: true, session: { select: { date: true } } },
  });

  const marksByStudent = new Map();
  for (const m of marks) {
    if (!marksByStudent.has(m.studentId)) marksByStudent.set(m.studentId, []);
    marksByStudent.get(m.studentId).push({ status: m.status, date: m.session ? m.session.date : null });
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

  const grades = assessmentIds.length
    ? await prisma.assessmentGrade.findMany({
        where: { assessmentId: { in: assessmentIds }, studentId: { in: studentIds } },
        select: { assessmentId: true, studentId: true, marks: true, gradedOn: true, gradedAt: true },
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
      studentId: true, interventionDate: true,
      recentAttendanceAtIntervention: true, submissionRateAtIntervention: true, averageGradeAtIntervention: true,
    },
  });

  const interventionByStudent = new Map();
  for (const i of interventions) if (!interventionByStudent.has(i.studentId)) interventionByStudent.set(i.studentId, i);

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

    const intervention = interventionByStudent.get(id) || null;
    const previous = previousByStudent.get(id) || null;

    out.set(id, {
      scope,
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
