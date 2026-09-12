const { test } = require("node:test");
const assert = require("node:assert");
const { parseJoinUrl, matchMeeting, attendedMinutes, decideStatus } = require("./teamsAttendance");

test("parseJoinUrl accepts a real meetup-join link and rejects everything else", () => {
  const url = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%22Tid%22%3a%22t%22%2c%22Oid%22%3a%22o%22%7d";
  assert.equal(parseJoinUrl("  " + url + "  "), url);
  assert.equal(parseJoinUrl("https://example.com/x"), null);
  assert.equal(parseJoinUrl(""), null);
  assert.equal(parseJoinUrl(null), null);
});

test("matchMeeting: unique date+time match wins without any title help", () => {
  const r = matchMeeting({ subject: "anything", date: "2026-09-14", startTime: "09:00" },
    [{ id: "a", date: "2026-09-14", startTime: "09:00", title: "Databases" },
     { id: "b", date: "2026-09-14", startTime: "11:00", title: "Networks" }]);
  assert.deepEqual(r, { kind: "one", id: "a" });
});

test("matchMeeting: two classes at one time need the title, and no title match refuses", () => {
  const candidates = [
    { id: "a", date: "2026-09-14", startTime: "09:00", title: "Databases" },
    { id: "b", date: "2026-09-14", startTime: "09:00", title: "Networks" },
  ];
  assert.deepEqual(matchMeeting({ subject: "HND Databases week 3", date: "2026-09-14", startTime: "09:00" }, candidates), { kind: "one", id: "a" });
  assert.equal(matchMeeting({ subject: "Lecture", date: "2026-09-14", startTime: "09:00" }, candidates).kind, "ambiguous");
});

test("matchMeeting: nothing at that time is none, not ambiguous", () => {
  assert.equal(matchMeeting({ subject: "x", date: "2026-09-14", startTime: "13:00" },
    [{ id: "a", date: "2026-09-14", startTime: "09:00", title: "Databases" }]).kind, "none");
});

test("attendedMinutes clips to the session window and merges overlapping joins", () => {
  const session = { startTime: "09:00", endTime: "10:30" };
  // Joined early, left mid; rejoined overlapping; a stretch entirely after the end.
  const r = attendedMinutes([
    { joinedAt: "08:50", leftAt: "09:40" },   // clips to 09:00-09:40 = 40
    { joinedAt: "09:30", leftAt: "10:00" },   // overlap merges: 09:00-10:00 = 60 total
    { joinedAt: "11:00", leftAt: "11:30" },   // outside entirely = 0
  ], session);
  assert.equal(r.minutes, 60);
  assert.equal(r.firstJoin, "08:50");
});

test("attendedMinutes with no parseable interval is null firstJoin, zero minutes", () => {
  const r = attendedMinutes([], { startTime: "09:00", endTime: "10:00" });
  assert.equal(r.minutes, 0);
  assert.equal(r.firstJoin, null);
});

test("decideStatus: the threshold boundary is inclusive, lateness follows lateAfterMins", () => {
  const session = { startTime: "09:00", endTime: "10:30" }; // 90 min, 50% = 45
  const base = { session, minAttendancePct: 50, lateAfterMins: 10 };
  assert.equal(decideStatus({ ...base, minutes: 45, firstJoin: "09:05" }).status, "P");
  assert.equal(decideStatus({ ...base, minutes: 45, firstJoin: "09:10" }).status, "P"); // inclusive, like attendanceTap
  assert.equal(decideStatus({ ...base, minutes: 45, firstJoin: "09:11" }).status, "L");
  const a = decideStatus({ ...base, minutes: 44, firstJoin: "09:00" });
  assert.equal(a.status, "A");
  assert.equal(a.remark, "Joined 44 of 90 min");
  assert.equal(decideStatus({ ...base, minutes: 0, firstJoin: null }).status, "A");
});
