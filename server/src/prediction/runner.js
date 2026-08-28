// Recalculating progression scores for a cohort, and writing what the engine decided.
//
// BATCHED, NEVER SYNCHRONOUS WITH TEACHING. Taking a register must not wait on a
// cohort's worth of scoring, so nothing in the request path scores anybody: the
// things that invalidate a score call markStale() and return, and this runner picks
// up whatever is flagged. That is why StudentPredictionCurrent carries a `stale`
// column with an index on it.
//
// WHAT GETS WRITTEN
//
//   StudentPredictionCurrent  one row per student, overwritten in place
//   StudentPredictionHistory  append only — never updated, never deleted
//
// History is append-only because direction of travel is literally "this score minus
// the row nearest a month ago": editing history rewrites a student's past, and any
// model later trained on real progression outcomes trains on these rows. It is not
// appended on every run, though — a nightly recalculation that found nothing changed
// would otherwise write a row per student per night forever. See shouldAppend().
const prisma = require("../db");
const { localDate } = require("../clock");
const settings = require("./settings");
const { gather } = require("./metrics");
const { score } = require("./engine");
const tripwires = require("./tripwires");
const divergence = require("./divergence");

// How many students are gathered and scored at a time. The gather issues a fixed
// number of queries per chunk, each with an `IN (...)` of this size — large enough
// that a 500-student college is three round trips per table, small enough that the
// parameter list stays well inside what a pooled Postgres connection will accept.
const CHUNK = 200;

// A history row is written at least this often even when nothing has changed, so a
// student who is stable all term still has a row a month back for direction of
// travel to compare against.
const HISTORY_HEARTBEAT_DAYS = 7;

/* -------------------------------------------------------------------------- */

const chunk = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/**
 * Flag students for rescoring. Cheap, and safe to call from a request path.
 *
 * Called wherever something that feeds a score changes — a register taken, a mark
 * entered, an intervention reviewed, the settings saved. It deliberately does no
 * scoring of its own: the caller is usually in the middle of an admin's save and
 * must not be made to wait.
 *
 * A student with no row yet needs no flag — the runner treats "no row" as stale by
 * definition, which is also why the column defaults to true.
 */
async function markStale(studentIds) {
  const ids = [...new Set((studentIds || []).filter(Boolean))];
  if (!ids.length) return 0;

  let flagged = 0;
  for (const part of chunk(ids, CHUNK)) {
    const { count } = await prisma.studentPredictionCurrent.updateMany({
      where: { studentId: { in: part }, stale: false },
      data: { stale: true },
    });
    flagged += count;
  }
  return flagged;
}

/** Flag every student this institution holds — used when the settings change, since
 *  every stored score was produced under the old policy and is not comparable. */
async function markAllStale() {
  const { count } = await prisma.studentPredictionCurrent.updateMany({
    where: { stale: false },
    data: { stale: true },
  });
  return count;
}

/**
 * Whether this result is worth a history row.
 *
 * Yes when the student has never been scored, when anything a human would notice has
 * moved, or when the last row is old enough that direction of travel would lose its
 * comparison point. No when a nightly run has simply confirmed yesterday's answer.
 */
function shouldAppend(result, current, latestHistoryDate, today) {
  if (!current) return true;
  if (current.riskLevel !== result.riskLevel) return true;
  if (current.progressionScore !== result.progressionScore) return true;
  if (current.interventionRequired !== result.interventionRequired) return true;
  if (!latestHistoryDate) return true;

  const age = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${latestHistoryDate}T00:00:00Z`)) / 86_400_000);
  return age >= HISTORY_HEARTBEAT_DAYS;
}

/**
 * Score students and store the result.
 *
 * @param {object} opts
 *   opts.studentIds  score exactly these; omit to score everything stale
 *   opts.all         score every active student, stale or not (a full rebuild)
 *   opts.limit       stop after this many, so a manual run cannot hang a request
 * @returns {Promise<object>} a summary: how many were scored, skipped and why
 */
async function recalculate(opts = {}) {
  const config = await settings.get();
  const today = localDate();

  /* --- who --------------------------------------------------------------- */

  let ids = [];
  if (Array.isArray(opts.studentIds) && opts.studentIds.length) {
    ids = [...new Set(opts.studentIds.filter(Boolean))];
  } else if (opts.all) {
    ids = (await prisma.student.findMany({ where: { active: true }, select: { id: true } })).map((s) => s.id);
  } else {
    // Stale, plus everyone who has never been scored at all. "No row" is stale by
    // definition — a new student would otherwise never enter the register, because
    // markStale() has nothing to flag for them.
    const staleRows = await prisma.studentPredictionCurrent.findMany({ where: { stale: true }, select: { studentId: true } });
    const scored = await prisma.studentPredictionCurrent.findMany({ select: { studentId: true } });
    const scoredSet = new Set(scored.map((r) => r.studentId));
    const unscored = (await prisma.student.findMany({ where: { active: true }, select: { id: true } }))
      .map((s) => s.id)
      .filter((id) => !scoredSet.has(id));
    ids = [...new Set([...staleRows.map((r) => r.studentId), ...unscored])];
  }

  if (opts.limit && ids.length > opts.limit) ids = ids.slice(0, opts.limit);

  const summary = {
    modelVersion: config.modelVersion,
    requested: ids.length,
    scored: 0,
    insufficientData: 0,
    historyRows: 0,
    byRiskLevel: {},
    interventionRequired: 0,
    startedAt: new Date().toISOString(),
  };

  /* --- score ------------------------------------------------------------- */

  for (const part of chunk(ids, CHUNK)) {
    const gathered = await gather(part, config);

    const existing = await prisma.studentPredictionCurrent.findMany({
      where: { studentId: { in: part } },
      select: { id: true, studentId: true, riskLevel: true, progressionScore: true, interventionRequired: true },
    });
    const existingByStudent = new Map(existing.map((r) => [r.studentId, r]));

    // The newest history row per student, so shouldAppend can age it.
    const latestHistory = await prisma.studentPredictionHistory.findMany({
      where: { studentId: { in: part } },
      orderBy: { calculationDateTime: "desc" },
      select: { studentId: true, calculationDateTime: true },
    });
    const latestByStudent = new Map();
    for (const h of latestHistory) if (!latestByStudent.has(h.studentId)) latestByStudent.set(h.studentId, h.calculationDateTime);

    for (const studentId of part) {
      const entry = gathered.get(studentId);
      if (!entry) continue;

      const result = score(entry.raw, config);

      // Nothing measurable. Any score previously stored for this student was
      // produced from data that is no longer there, so it is removed rather than
      // left on screen looking current — but the history rows stay, because they
      // were true when they were written.
      if (result.insufficientData) {
        summary.insufficientData += 1;
        await prisma.studentPredictionCurrent.deleteMany({ where: { studentId } });
        continue;
      }

      const row = {
        scopeTermId: entry.scope.termId,
        scopeLabel: entry.scope.label,
        scopeFrom: entry.scope.from,
        scopeTo: entry.scope.to,

        overallAttendance: result.metrics.overallAttendance,
        recentAttendance: result.metrics.recentAttendance,
        submissionRate: result.metrics.submissionRate,
        onTimeRate: result.metrics.onTimeRate,
        missingAssessmentCount: result.metrics.missingAssessmentCount,
        averageGrade: result.metrics.averageGrade,

        gradeTrend: result.gradeTrend,
        gradeTrendScore: result.gradeTrendScore,
        interventionResponse: result.interventionResponse,
        interventionResponseScore: result.interventionResponseScore,

        baseProgressionScore: result.baseProgressionScore,
        progressionScore: result.progressionScore,
        baseRiskLevel: result.baseRiskLevel,
        riskLevel: result.riskLevel,
        directionOfTravel: result.directionOfTravel,
        redIndicatorCount: result.redIndicatorCount,
        overrideApplied: result.overrideApplied,
        overrideCodes: result.overrideCodes,
        // The tripwire codes ride the SAME column as the engine's risk drivers, and
        // deliberately so: staff read one list of reasons, not two. They are appended
        // rather than merged in, so the engine's own reds keep their order at the top.
        //
        // This cannot reach the override machinery. engine.js derives
        // redIndicatorCount from its internal `reds` array and takes a COPY of it into
        // riskDriverCodes, so what is added here is invisible to OVR-004. The TRIP_
        // prefix keeps that obvious to the next reader; the engine's own test suite
        // holds the guarantee.
        // THE CONTACT DEFICIT IS APPENDED HERE, NOT IN gather(), and the position is
        // the point. It crosses the risk level with the pastoral dates, and the only
        // risk level that is not stale is the one score() returned two lines above:
        // StudentPredictionCurrent.riskLevel belongs to the PREVIOUS run for everybody
        // in this batch, because being stale is why they are in it. Computing it
        // upstream would measure a student who has just deteriorated against the
        // comfortable band they held a fortnight ago, and stay silent.
        riskDriverCodes: [
          ...result.riskDriverCodes,
          ...(entry.tripwires ? entry.tripwires.codes : []),
          ...(entry.tripwires
            ? tripwires.contactDeficit({
                riskLevel: result.riskLevel,
                lastContactOn: entry.tripwires.lastPastoralOn,
                pastoralRecorded: entry.tripwires.pastoralRecorded,
                weeksIntoProgramme: entry.tripwires.weeksIntoProgramme,
                today,
              }, config).codes
            : []),
        ],
        // DIVERGENCE IS COMPUTED HERE, NOT IN gather(), for the same structural reason
        // contactDeficit is. It compares the submission RATE against attendance, and
        // engine.js derives submissionRate in measure() — which runs after gather(). The
        // alternative is a second implementation of a stored figure in the wiring, and
        // two definitions of one number on one screen is how they drift.
        //
        // It reads result.metrics.submissionRate, the engine's own output, so there is
        // exactly one definition of it in the codebase.
        ...(entry.tripwires
          ? (() => {
              const d = divergence.evaluate({
                attendancePct: result.metrics.overallAttendance,
                attendanceObservations: entry.tripwires.attendanceObservationsForDivergence,
                submissionRate: result.metrics.submissionRate,
                submissionObservations: (entry.tripwires.submittedCount || 0) + (entry.tripwires.notSubmittedCount || 0),
                vleActiveDayRate: entry.tripwires.vleActiveDayRate,
                vleObservedDays: entry.tripwires.vleObservedDaysForDivergence,
                averageGrade: entry.tripwires.averageGradeForDivergence,
                gradedCount: entry.tripwires.gradedCountForDivergence,
                attendanceSlope: entry.tripwires.attendanceSlope,
                weeksIntoProgramme: entry.tripwires.weeksIntoProgramme,
                institution: { submissionsRecorded: entry.tripwires.submissionsRecorded === true },
              }, config);
              return {
                divergenceShape: d.divergenceShape,
                attendanceSubmissionGap: d.attendanceSubmissionGap,
                attendanceVleGap: d.attendanceVleGap,
              };
            })()
          : { divergenceShape: null, attendanceSubmissionGap: null, attendanceVleGap: null }),
        positiveDriverCodes: result.positiveDriverCodes,
        primaryRiskDriver: result.primaryRiskDriver,
        interventionRequired: result.interventionRequired,
        modelVersion: result.modelVersion,

        // Dates, never day-counts. Nothing here runs on a schedule, so a stored
        // "days since" would be wrong by tomorrow morning with no event to correct
        // it, while the date itself stays true. The screen derives the age.
        absenceStreak: entry.tripwires ? entry.tripwires.absenceStreak : null,
        lastAttendedOn: entry.tripwires ? entry.tripwires.lastAttendedOn : null,
        oldestUnmarkedDueDate: entry.tripwires ? entry.tripwires.oldestUnmarkedDueDate : null,
        attendanceSlope: entry.tripwires ? entry.tripwires.attendanceSlope : null,
        lastEngagedOn: entry.tripwires ? entry.tripwires.lastEngagedOn : null,
        unexplainedShare: entry.tripwires ? entry.tripwires.unexplainedShare : null,
        latenessRate: entry.tripwires ? entry.tripwires.latenessRate : null,
        failCount: entry.tripwires ? entry.tripwires.failCount : null,
        nearFailCount: entry.tripwires ? entry.tripwires.nearFailCount : null,
        gradeVolatility: entry.tripwires ? entry.tripwires.volatility : null,
        worstUnitId: entry.tripwires ? entry.tripwires.worstUnitId : null,
        unitAttendanceSpread: entry.tripwires ? entry.tripwires.unitAttendanceSpread : null,
        unpassedUnitCount: entry.tripwires ? entry.tripwires.unpassedUnitCount : null,
        attendanceRegularity: entry.tripwires ? entry.tripwires.attendanceRegularity : null,
        lateSubmissionRate: entry.tripwires ? entry.tripwires.lateSubmissionRate : null,
        meanDaysLate: entry.tripwires ? entry.tripwires.meanDaysLate : null,
        weeksIntoProgramme: entry.tripwires ? entry.tripwires.weeksIntoProgramme : null,
        assessmentsDueSoon: entry.tripwires ? entry.tripwires.assessmentsDueSoon : null,
        gradedWithDates: entry.tripwires ? entry.tripwires.gradedWithDates : null,
        oldestOpenQueryOn: entry.tripwires ? entry.tripwires.oldestOpenQueryOn : null,
        openQueryCount: entry.tripwires ? entry.tripwires.openQueryCount : null,
        overdueFollowUpCount: entry.tripwires ? entry.tripwires.overdueFollowUpCount : null,
        openMitigationCount: entry.tripwires ? entry.tripwires.openMitigationCount : null,
        oldestOpenMitigationOn: entry.tripwires ? entry.tripwires.oldestOpenMitigationOn : null,
        mitigatedAssessmentCount: entry.tripwires ? entry.tripwires.mitigatedAssessmentCount : null,
        attendanceMitigated: entry.tripwires ? entry.tripwires.attendanceMitigated : null,
        registerCoverageRate: entry.tripwires ? entry.tripwires.registerCoverageRate : null,
        scheduledSessionCount: entry.tripwires ? entry.tripwires.scheduledSessionCount : null,
        markedSessionCount: entry.tripwires ? entry.tripwires.markedSessionCount : null,
        attendanceConfidence: entry.tripwires ? entry.tripwires.attendanceConfidence : null,
        attendanceObservations: entry.tripwires ? entry.tripwires.attendanceObservations : null,
        lastRegisterMarkOn: entry.tripwires ? entry.tripwires.lastRegisterMarkOn : null,
        cohortAttendancePercentile: entry.tripwires ? entry.tripwires.cohortAttendancePercentile : null,
        cohortAttainmentPercentile: entry.tripwires ? entry.tripwires.cohortAttainmentPercentile : null,
        cohortSize: entry.tripwires ? entry.tripwires.cohortSize : null,
        cohortStruggling: entry.tripwires ? entry.tripwires.cohortStruggling : null,
        vleLastAccessOn: entry.tripwires ? entry.tripwires.vleLastAccessOn : null,
        vleActiveDayRate: entry.tripwires ? entry.tripwires.vleActiveDayRate : null,
        vleObservedDays: entry.tripwires ? entry.tripwires.vleObservedDays : null,
        vleUnitsObserved: entry.tripwires ? entry.tripwires.vleUnitsObserved : null,
        peakFrom: entry.tripwires ? entry.tripwires.peakFrom : null,
        peakTo: entry.tripwires ? entry.tripwires.peakTo : null,
        peakCount: entry.tripwires ? entry.tripwires.peakCount : null,
        peakWeightShare: entry.tripwires ? entry.tripwires.peakWeightShare : null,
        peakWasWeighted: entry.tripwires ? entry.tripwires.peakWasWeighted : null,
        undatedAssessments: entry.tripwires ? entry.tripwires.undatedAssessments : null,
        carriedBacklogCount: entry.tripwires ? entry.tripwires.carriedBacklogCount : null,
        fundingPosition: entry.tripwires ? entry.tripwires.fundingPosition : null,
        fundingUnsettledSince: entry.tripwires ? entry.tripwires.fundingUnsettledSince : null,
        fundingSettledOn: entry.tripwires ? entry.tripwires.fundingSettledOn : null,
        fundingRefusedOn: entry.tripwires ? entry.tripwires.fundingRefusedOn : null,
        fundingApplications: entry.tripwires ? entry.tripwires.fundingApplications : null,
        fundingNotApplied: entry.tripwires ? entry.tripwires.fundingNotApplied : null,
        worstAbsenceWeekday: entry.tripwires ? entry.tripwires.worstAbsenceWeekday : null,
        worstWeekdayAbsenceRate: entry.tripwires ? entry.tripwires.worstWeekdayAbsenceRate : null,
        weekdayAbsenceGap: entry.tripwires ? entry.tripwires.weekdayAbsenceGap : null,
        weekdaysMeasured: entry.tripwires ? entry.tripwires.weekdaysMeasured : null,
        worstAbsenceKind: entry.tripwires ? entry.tripwires.worstAbsenceKind : null,
        worstKindAbsenceRate: entry.tripwires ? entry.tripwires.worstKindAbsenceRate : null,
        kindAbsenceGap: entry.tripwires ? entry.tripwires.kindAbsenceGap : null,
        kindsMeasured: entry.tripwires ? entry.tripwires.kindsMeasured : null,
        unseenWeekRun: entry.tripwires ? entry.tripwires.unseenWeekRun : null,
        unseenSinceWeekOn: entry.tripwires ? entry.tripwires.unseenSinceWeekOn : null,
        lastAttendedWeekOn: entry.tripwires ? entry.tripwires.lastAttendedWeekOn : null,
        longestUnseenWeekRun: entry.tripwires ? entry.tripwires.longestUnseenWeekRun : null,
        observedWeeks: entry.tripwires ? entry.tripwires.observedWeeks : null,
        entryProfileRecorded: entry.tripwires ? entry.tripwires.entryProfileRecorded : null,
        entryProfileOn: entry.tripwires ? entry.tripwires.entryProfileOn : null,
        entryProfileAnswered: entry.tripwires ? entry.tripwires.entryProfileAnswered : null,
        entryProfileQuestions: entry.tripwires ? entry.tripwires.entryProfileQuestions : null,
        entryProfileBarriers: entry.tripwires ? entry.tripwires.entryProfileBarriers : null,
        entryWifiAtHome: entry.tripwires ? entry.tripwires.entryWifiAtHome : null,
        entryKnowsOfficeSoftware: entry.tripwires ? entry.tripwires.entryKnowsOfficeSoftware : null,
        entryAdmittedOutcome: entry.tripwires ? entry.tripwires.entryAdmittedOutcome : null,
        rightToStudyExpiresOn: entry.tripwires ? entry.tripwires.rightToStudyExpiresOn : null,
        currentBandSince: entry.tripwires ? entry.tripwires.currentBandSince : null,
        worstBandHeld: entry.tripwires ? entry.tripwires.worstBandHeld : null,
        worstBandSince: entry.tripwires ? entry.tripwires.worstBandSince : null,
        observedDays: entry.tripwires ? entry.tripwires.observedDays : null,
        bandChanges: entry.tripwires ? entry.tripwires.bandChanges : null,
        bandsVisited: entry.tripwires ? entry.tripwires.bandsVisited : null,
        recoveredPoints: entry.tripwires ? entry.tripwires.recoveredPoints : null,
        recoveredBy: entry.tripwires ? entry.tripwires.recoveredBy : null,
        lowestScore: entry.tripwires ? entry.tripwires.lowestScore : null,
        lowestOn: entry.tripwires ? entry.tripwires.lowestOn : null,
        weightedAverageGrade: entry.tripwires ? entry.tripwires.weightedAverageGrade : null,
        gradeWasWeighted: entry.tripwires ? entry.tripwires.gradeWasWeighted : null,
        markingLatencyDays: entry.tripwires ? entry.tripwires.markingLatencyDays : null,
        firstSessionAbsenceRate: entry.tripwires ? entry.tripwires.firstSessionAbsenceRate : null,
        laterSessionAbsenceRate: entry.tripwires ? entry.tripwires.laterSessionAbsenceRate : null,
      };

      const current = existingByStudent.get(studentId);
      const latest = latestByStudent.get(studentId);
      const append = shouldAppend(result, current, latest ? latest.toISOString().slice(0, 10) : null, today);

      if (current) {
        await prisma.studentPredictionCurrent.update({
          where: { id: current.id },
          data: { ...row, lastCalculated: new Date(), stale: false },
        });
      } else {
        await prisma.studentPredictionCurrent.create({
          data: { ...row, studentId, lastCalculated: new Date(), stale: false },
        });
      }

      if (append) {
        await prisma.studentPredictionHistory.create({ data: { ...row, studentId } });
        summary.historyRows += 1;
      }

      summary.scored += 1;
      summary.byRiskLevel[result.riskLevel] = (summary.byRiskLevel[result.riskLevel] || 0) + 1;
      if (result.interventionRequired) summary.interventionRequired += 1;
    }
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}

module.exports = { recalculate, markStale, markAllStale, shouldAppend, CHUNK, HISTORY_HEARTBEAT_DAYS };
