// Unit tests for teamsMeetings.js's one pure helper: meetingFingerprint. It is what
// replaced comparing TimetableEvent.updatedAt against teamsMeetingSyncedAt as the
// PATCH gate — that comparison never went false once true (updatedAt is @updatedAt,
// so the very write that stored teamsMeetingSyncedAt bumped updatedAt to a LATER
// instant), so every owned meeting was re-PATCHed, and every attendee re-notified,
// on every single hourly tick forever. These tests exist so that regression cannot
// come back silently: no database and no Microsoft tenant needed to prove the
// fingerprint is stable when nothing changed and different when something did.
const test = require("node:test");
const assert = require("node:assert/strict");
const { meetingFingerprint } = require("./teamsMeetings");

const base = { subject: "OBM Lecture", date: "2026-09-15", startTime: "10:00", endTime: "12:00", attendeeEmails: ["a@x.ac.uk", "b@x.ac.uk"] };

test("the same inputs produce the same fingerprint", () => {
  assert.equal(meetingFingerprint(base), meetingFingerprint({ ...base, attendeeEmails: [...base.attendeeEmails] }));
});

test("attendee order does not matter — only membership does", () => {
  const reordered = { ...base, attendeeEmails: [...base.attendeeEmails].reverse() };
  assert.equal(meetingFingerprint(base), meetingFingerprint(reordered));
});

test("a changed subject changes the fingerprint", () => {
  assert.notEqual(meetingFingerprint(base), meetingFingerprint({ ...base, subject: "OBM Seminar" }));
});

test("a changed time changes the fingerprint", () => {
  assert.notEqual(meetingFingerprint(base), meetingFingerprint({ ...base, startTime: "11:00" }));
});

test("an added or removed attendee changes the fingerprint", () => {
  assert.notEqual(meetingFingerprint(base), meetingFingerprint({ ...base, attendeeEmails: [...base.attendeeEmails, "c@x.ac.uk"] }));
  assert.notEqual(meetingFingerprint(base), meetingFingerprint({ ...base, attendeeEmails: ["a@x.ac.uk"] }));
});
