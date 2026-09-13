-- Conduct events: the two-tap behaviour/merit capture, and the vocabulary it offers.
-- Additive only — two new tables, three foreign keys, three indexes; nothing existing
-- is touched.
--
-- ConductVocabularyConfig is the tenth constant-key config table (configuration.md):
-- one row, one JSON column holding the whole entry list, replaced atomically because
-- the list is only valid as a set. Defaults and validation live in
-- src/conductConfig.js; no row means "this college runs on the platform defaults".
CREATE TABLE "ConductVocabularyConfig" (
  "id"         TEXT NOT NULL DEFAULT 'singleton',
  "vocabulary" JSONB NOT NULL,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  "updatedBy"  TEXT,

  CONSTRAINT "ConductVocabularyConfig_pkey" PRIMARY KEY ("id")
);

-- ConductEvent freezes key/label/points/tone at log time — the vocabulary is how new
-- events are OFFERED, never what history joins back through, so a relabelled or
-- deleted entry rewrites nothing a student already carries.
--
-- The delete behaviours differ per edge, and each is a decision:
--   * student  CASCADE  — a deleted student takes their conduct history with them,
--                         like every other pastoral record;
--   * staff    SET NULL — the OPPOSITE of Announcement's cascade: a conduct event is
--                         part of the STUDENT's record, and a lecturer leaving must
--                         not erase a term of merits from the students who earned
--                         them. staffName is frozen beside the id for exactly that
--                         day;
--   * session  SET NULL — registers are regenerated and deleted as timetables
--                         change, and the event outlives the class it was logged in.
CREATE TABLE "ConductEvent" (
  "id"        TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "staffId"   TEXT,
  "staffName" TEXT NOT NULL,
  "key"       TEXT NOT NULL,
  "label"     TEXT NOT NULL,
  "points"    INTEGER NOT NULL,
  "tone"      TEXT NOT NULL,
  "note"      TEXT NOT NULL DEFAULT '',
  "sessionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ConductEvent_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ConductEvent"
  ADD CONSTRAINT "ConductEvent_studentId_fkey"
  FOREIGN KEY ("studentId") REFERENCES "Student"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConductEvent"
  ADD CONSTRAINT "ConductEvent_staffId_fkey"
  FOREIGN KEY ("staffId") REFERENCES "Staff"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ConductEvent"
  ADD CONSTRAINT "ConductEvent_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "HndSession"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- The two read paths: a student's history newest-first (the profile and the sheet's
-- running total), and "what did I log" (the lecturer's own view).
CREATE INDEX "ConductEvent_studentId_createdAt_idx" ON "ConductEvent"("studentId", "createdAt");
CREATE INDEX "ConductEvent_staffId_idx" ON "ConductEvent"("staffId");
