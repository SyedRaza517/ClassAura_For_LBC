// Tests for session validation — the one or two teaching blocks that make up a day.
//
// No database. This file is pure, like overlap.test.js and recurrence.test.js beside
// it, and for the same reason: the arithmetic that decides how many registers a
// college ends up with should be provable without booting anything.
//
// Run with: node --test src/timetabling/sessions.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const { parseSessions } = require("./sessions");

test("no sessions falls back to the single start/end pair", () => {
  // Every client written before sessions existed sends start/end at the top level, and
  // POST /events must keep working for them unchanged. The fallback is what makes
  // `sessions` an addition rather than a breaking change.
  const r = parseSessions({ start: "09:00", end: "12:00" });
  assert.deepEqual(r.sessions, [{ start: "09:00", end: "12:00" }]);
  assert.equal(r.error, undefined);
});

test("an EMPTY sessions array also falls back", () => {
  // A form that renders "1 session" by clearing the array must not be refused for
  // sending the field at all. Present-but-empty means the same as absent.
  const r = parseSessions({ sessions: [], start: "09:00", end: "12:00" });
  assert.deepEqual(r.sessions, [{ start: "09:00", end: "12:00" }]);
});

test("a non-array sessions value falls back rather than throwing", () => {
  const r = parseSessions({ sessions: "09:00", start: "09:00", end: "12:00" });
  assert.deepEqual(r.sessions, [{ start: "09:00", end: "12:00" }]);
});

test("one session is returned as one session", () => {
  const r = parseSessions({ sessions: [{ start: "09:00", end: "12:00" }] });
  assert.deepEqual(r.sessions, [{ start: "09:00", end: "12:00" }]);
});

test("two sessions come back in order", () => {
  // Sorted, so the afternoon block cannot arrive first and make the morning one look
  // like the "second" session on every screen that numbers them.
  const r = parseSessions({ sessions: [{ start: "13:00", end: "16:00" }, { start: "09:00", end: "12:00" }] });
  assert.deepEqual(r.sessions, [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "16:00" }]);
});

test("times are trimmed", () => {
  const r = parseSessions({ sessions: [{ start: " 09:00 ", end: "12:00\t" }] });
  assert.deepEqual(r.sessions, [{ start: "09:00", end: "12:00" }]);
});

test("a session ending before it starts is refused", () => {
  assert.match(parseSessions({ sessions: [{ start: "12:00", end: "09:00" }] }).error, /after the start/i);
});

test("a zero-length session is refused", () => {
  // 09:00-09:00 is not a class. It would create a register for an hour nobody teaches,
  // and half-open comparison makes it overlap nothing, so it would slip past every
  // clash check in the module.
  assert.match(parseSessions({ sessions: [{ start: "09:00", end: "09:00" }] }).error, /after the start/i);
});

test("OVERLAPPING SESSIONS ARE REFUSED", () => {
  // Two blocks on one day that overlap are one block entered twice, and they would
  // produce two registers covering the same hour for the same students — which doubles
  // that hour in every attendance denominator the college reports on.
  assert.match(
    parseSessions({ sessions: [{ start: "09:00", end: "13:00" }, { start: "12:00", end: "15:00" }] }).error,
    /overlap/i,
  );
});

test("OVERLAP IS CAUGHT WHATEVER ORDER THEY ARRIVE IN", () => {
  // The sort runs before the overlap test on purpose. Checking the pair as submitted
  // would let the same two blocks through simply for being typed afternoon-first,
  // which is exactly how a bug like this survives a green suite.
  assert.match(
    parseSessions({ sessions: [{ start: "12:00", end: "15:00" }, { start: "09:00", end: "13:00" }] }).error,
    /overlap/i,
  );
});

test("a session wholly inside the other is refused", () => {
  assert.match(
    parseSessions({ sessions: [{ start: "09:00", end: "17:00" }, { start: "11:00", end: "12:00" }] }).error,
    /overlap/i,
  );
});

test("two sessions starting at the same minute are refused", () => {
  // Equal starts sort to either position, so this is the case a comparison written as
  // `out[0].end >= out[1].start` would get right by accident and `>` on unsorted input
  // would get wrong. Stated explicitly so it stays true.
  assert.match(
    parseSessions({ sessions: [{ start: "09:00", end: "10:00" }, { start: "09:00", end: "11:00" }] }).error,
    /overlap/i,
  );
});

test("back-to-back sessions are allowed", () => {
  // 09:00-12:00 then 12:00-15:00 is a normal teaching day, not a clash. The same
  // half-open rule overlap.js already applies to rooms — a closed interval here would
  // refuse the single most common two-session shape a college enters.
  const r = parseSessions({ sessions: [{ start: "09:00", end: "12:00" }, { start: "12:00", end: "15:00" }] });
  assert.equal(r.error, undefined);
  assert.equal(r.sessions.length, 2);
  assert.deepEqual(r.sessions, [{ start: "09:00", end: "12:00" }, { start: "12:00", end: "15:00" }]);
});

test("sessions with a gap between them are allowed", () => {
  const r = parseSessions({ sessions: [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "16:00" }] });
  assert.equal(r.error, undefined);
  assert.equal(r.sessions.length, 2);
});

test("more than two sessions is refused", () => {
  const three = [{ start: "09:00", end: "10:00" }, { start: "11:00", end: "12:00" }, { start: "13:00", end: "14:00" }];
  assert.match(parseSessions({ sessions: three }).error, /at most two/i);
});

test("a malformed time is refused rather than stored", () => {
  assert.match(parseSessions({ sessions: [{ start: "9am", end: "12:00" }] }).error, /HH:MM/);
});

test("times outside a real clock are refused", () => {
  // Not merely cosmetic. These are compared as STRINGS everywhere downstream, which is
  // only sound while they are zero-padded and in range: "9:00" sorts after "13:00",
  // and "24:00" would sort after every real end time and never clash with anything.
  assert.match(parseSessions({ sessions: [{ start: "24:00", end: "25:00" }] }).error, /HH:MM/);
  assert.match(parseSessions({ sessions: [{ start: "09:60", end: "10:00" }] }).error, /HH:MM/);
  assert.match(parseSessions({ sessions: [{ start: "9:00", end: "10:00" }] }).error, /HH:MM/);
});

test("a missing time is refused, not treated as blank", () => {
  assert.match(parseSessions({ sessions: [{ start: null, end: "12:00" }] }).error, /HH:MM/);
  assert.match(parseSessions({}).error, /HH:MM/);
});

test("a session that is not an object is refused", () => {
  assert.match(parseSessions({ sessions: ["09:00-12:00"] }).error, /HH:MM/);
});

test("nothing but start and end survives the parse", () => {
  // An allowlist, not a blocklist. A client sending extra keys on a session must not
  // have them reach the create — sAdmission is the standing cautionary tale.
  const r = parseSessions({ sessions: [{ start: "09:00", end: "12:00", published: true, id: "x" }] });
  assert.deepEqual(Object.keys(r.sessions[0]).sort(), ["end", "start"]);
});

test("a null or absent body is refused rather than throwing", () => {
  assert.match(parseSessions(null).error, /HH:MM/);
  assert.match(parseSessions(undefined).error, /HH:MM/);
});
