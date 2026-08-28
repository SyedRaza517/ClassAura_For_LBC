-- Three layers: what the student said before they started, what their risk has DONE,
-- and what it means when their signals disagree with each other.
--
-- Twenty-two nullable columns on each prediction table. Nothing altered, nothing
-- backfilled.
--
-- INTAKE. The pre-entry self-assessment is the only evidence that exists in week one,
-- when attendance, marks and pastoral contact all have nothing in them -- and every
-- barrier it names is actionable by the college: no wifi at home, no office software, a
-- reservation recorded at interview.
--
-- It is reached ONLY by foreign key: Student.id <- Admission.linkedStudentId <-
-- Ism.admissionId. Admission also carries a plain string column literally called
-- studentId, which is a college ID an admin TYPED with no relation to anything -- the
-- schema comment there says the two names are ugly on purpose. Matching on it, or on a
-- name, would attach one person's visa expiry to another: a data-protection incident
-- rather than a bug.
--
-- ethnicity and religion sit on Admission under an EDI heading and are read by NOTHING.
-- Three source-reading tests assert the module never names them, and injecting a read of
-- ethnicity fails three of them.
--
-- entryProfileRecorded is TRI-STATE and the middle value is the finding: null = the
-- college has no linked ISM data at all, false = it does and this student has none (a
-- student nobody interviewed at a college that interviews), true = a row.
--
-- HISTORY. StudentPredictionHistory is written on every scoring run and the engine read
-- it for exactly one comparison. A student stuck at the same band all year and one who
-- fell there last week sorted identically -- the first has had an intervention that did
-- not work, the second has had nothing tried at all.
--
-- The unit of observation is a DAY, not a row: markStale fires on any data event, so one
-- student can carry six snapshots from a single afternoon. And snapshots from an older
-- modelVersion are DISCARDED rather than bridged, because a weight change moves every
-- score in the institution the day it ships, and comparing across that boundary would
-- report a model upgrade as the whole college deteriorating overnight.
--
-- DIVERGENCE. A weighted mean is precisely the operation that destroys disagreement: a
-- student at 95% attendance with 20% submission and one at 55% on both land close
-- together on the score, and they need opposite conversations -- academic support in the
-- first case, a conversation about timetabling or mode of study in the second.
--
-- Only opportunity-take rates are ever subtracted (attendance, submission rate, VLE
-- active-day rate -- all "of the chances given, what share was taken"). Average grade is
-- a quality measurement and is never subtracted from anything.
--
-- At most ONE shape is named per student, by precedence, so the caseload carries one
-- reason rather than four.
--
-- All twenty-two are null on both databases today: no assessments, no grades, no
-- admissions, one history row per student. That is the modules refusing to invent
-- figures, not a fault.

ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "entryProfileRecorded" BOOLEAN;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "entryProfileOn" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "entryProfileAnswered" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "entryProfileQuestions" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "entryProfileBarriers" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "entryWifiAtHome" BOOLEAN;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "entryKnowsOfficeSoftware" BOOLEAN;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "entryAdmittedOutcome" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "rightToStudyExpiresOn" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "currentBandSince" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "worstBandHeld" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "worstBandSince" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "observedDays" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "bandChanges" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "bandsVisited" INTEGER;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "recoveredPoints" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "recoveredBy" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "lowestScore" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "lowestOn" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "divergenceShape" TEXT;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "attendanceSubmissionGap" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionCurrent" ADD COLUMN "attendanceVleGap" DOUBLE PRECISION;

ALTER TABLE "StudentPredictionHistory" ADD COLUMN "entryProfileRecorded" BOOLEAN;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "entryProfileOn" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "entryProfileAnswered" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "entryProfileQuestions" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "entryProfileBarriers" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "entryWifiAtHome" BOOLEAN;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "entryKnowsOfficeSoftware" BOOLEAN;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "entryAdmittedOutcome" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "rightToStudyExpiresOn" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "currentBandSince" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "worstBandHeld" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "worstBandSince" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "observedDays" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "bandChanges" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "bandsVisited" INTEGER;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "recoveredPoints" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "recoveredBy" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "lowestScore" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "lowestOn" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "divergenceShape" TEXT;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "attendanceSubmissionGap" DOUBLE PRECISION;
ALTER TABLE "StudentPredictionHistory" ADD COLUMN "attendanceVleGap" DOUBLE PRECISION;
