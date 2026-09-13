-- Announcements: one row per message a member of staff sent to the students of a unit
-- they teach. Additive only — one new table, two foreign keys, one index; nothing
-- existing is touched, so there is no data step and nothing here can destroy a row.
--
-- The DELIVERY is not in this table. Each recipient gets an ordinary Notification row
-- (and a push) through notify.js#notifyStudent at send time, exactly as a query reply
-- or a check-in confirmation does, so the student app needs no new surface and reads
-- nothing from here. This table is the SENDER's record: what was said, to whom, when.
--
-- audienceLabel and recipientCount freeze the audience as words and a number at the
-- moment of sending. Enrolment lists move and units get renamed or deleted, and the
-- question this row answers is "who was told, at the time" — deriving it back through
-- unitId would quietly re-answer with today's truth. unitId is kept as a convenience
-- link while the unit lives, and goes NULL when the unit goes, rather than taking the
-- record with it: deleting a module must never delete the fact that its students were
-- told something (same reasoning as Referral.department being a plain string).
CREATE TABLE "Announcement" (
  "id"             TEXT NOT NULL,
  "senderId"       TEXT NOT NULL,
  "unitId"         TEXT,
  "audienceLabel"  TEXT NOT NULL,
  "message"        TEXT NOT NULL,
  "recipientCount" INTEGER NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CASCADE from the sender, matching every other staff-owned record (Notification,
-- CheckIn, Leave): a deleted staff account takes its sent-history with it. SET NULL
-- from the unit, per the comment above.
ALTER TABLE "Announcement"
  ADD CONSTRAINT "Announcement_senderId_fkey"
  FOREIGN KEY ("senderId") REFERENCES "Staff"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Announcement"
  ADD CONSTRAINT "Announcement_unitId_fkey"
  FOREIGN KEY ("unitId") REFERENCES "Unit"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- The one read path is "what have I sent, newest first" (GET /announcements/mine),
-- which filters on senderId and orders by createdAt — one compound index serves both.
CREATE INDEX "Announcement_senderId_createdAt_idx" ON "Announcement"("senderId", "createdAt");
