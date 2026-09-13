// Tests for dueNext.js — the Home screen's "Due next" card.
//
// Run with: node --test client/src/student/dueNext.test.js   (from the repo root)
// client/package.json is "type": "module", so node runs this directly, the same way
// timetableView.test.js does (see that file's own header comment).
import test from "node:test";
import assert from "node:assert/strict";

import { dueNext } from "./dueNext.js";

// A fixed "now" so every test is deterministic regardless of the host clock — the
// same reason server/src/clock.js exists: nothing here may read `new Date()` itself.
const NOW = { date: "2026-09-13", time: "10:00" };

const assessment = (over = {}) => ({
  id: "a1", title: "Essay 1", unitCode: "U100", unitName: "Unit One",
  dueDate: "2026-09-14", marks: null, pct: null, ...over,
});
const event = (over = {}) => ({
  id: "e1", date: "2026-09-13", start: "14:00", end: "15:00",
  title: "Lecture", unitCode: "U100", unitName: "Unit One",
  teamsJoinUrl: null, sessionId: "s1", ...over,
});

test("an unmarked assessment due tomorrow is included", () => {
  const out = dueNext({ assessments: [assessment()], events: [], now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "assessment");
  assert.equal(out[0].id, "assessment:a1");
});

test("a marked assessment is dropped — it is no longer due", () => {
  const out = dueNext({ assessments: [assessment({ marks: 62, pct: 62 })], events: [], now: NOW });
  assert.deepEqual(out, []);
});

test("an assessment with no due date is dropped — nothing to interleave it by", () => {
  const out = dueNext({ assessments: [assessment({ dueDate: null })], events: [], now: NOW });
  assert.deepEqual(out, []);
});

test("an unmarked assessment whose due date has passed is flagged overdue", () => {
  const out = dueNext({ assessments: [assessment({ dueDate: "2026-09-01" })], events: [], now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "overdue");
});

test("an assessment due LATER today (end of day) is not yet overdue", () => {
  const out = dueNext({ assessments: [assessment({ dueDate: "2026-09-13" })], events: [], now: NOW });
  assert.equal(out[0].kind, "assessment"); // due date is today, treated as due by 23:59 today
});

test("a class starting within the next 48h is included", () => {
  const out = dueNext({ assessments: [], events: [event()], now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "class");
  assert.equal(out[0].id, "class:e1");
});

test("a class that already started is excluded — it is not 'next'", () => {
  const out = dueNext({ assessments: [], events: [event({ date: "2026-09-13", start: "09:00" })], now: NOW });
  assert.deepEqual(out, []);
});

test("a class more than 48h away is excluded", () => {
  // NOW is 2026-09-13T10:00; 48h later is 2026-09-15T10:00.
  const out = dueNext({ assessments: [], events: [event({ date: "2026-09-15", start: "11:00" })], now: NOW });
  assert.deepEqual(out, []);
});

test("a class exactly at the 48h edge is included, one minute past it is not", () => {
  const edge = dueNext({ assessments: [], events: [event({ date: "2026-09-15", start: "10:00" })], now: NOW });
  assert.equal(edge.length, 1);
  const justPast = dueNext({ assessments: [], events: [event({ date: "2026-09-15", start: "10:01" })], now: NOW });
  assert.equal(justPast.length, 0);
});

test("interleaved: soonest first, whether it is a class or an assessment", () => {
  const out = dueNext({
    assessments: [assessment({ id: "a1", dueDate: "2026-09-16" })], // due end of 16th
    events: [
      event({ id: "e1", date: "2026-09-13", start: "16:00" }),  // today 16:00
      event({ id: "e2", date: "2026-09-14", start: "09:00" }),  // tomorrow 09:00
    ],
    now: NOW,
  });
  assert.deepEqual(out.map((o) => o.id), ["class:e1", "class:e2", "assessment:a1"]);
});

test("an overdue item sorts before everything in the future — it is the most urgent", () => {
  const out = dueNext({
    assessments: [assessment({ id: "a1", dueDate: "2026-09-10" })], // 3 days overdue
    events: [event({ id: "e1", date: "2026-09-13", start: "11:00" })],
    now: NOW,
  });
  assert.deepEqual(out.map((o) => o.id), ["assessment:a1", "class:e1"]);
});

test("a class with a Teams link carries it through untouched", () => {
  const out = dueNext({ assessments: [], events: [event({ teamsJoinUrl: "https://teams.example/x" })], now: NOW });
  assert.equal(out[0].teamsJoinUrl, "https://teams.example/x");
});

test("rubbish input does not throw", () => {
  assert.deepEqual(dueNext({ assessments: null, events: null, now: NOW }), []);
  assert.deepEqual(dueNext({}), []);
  // A class missing its date/start is skipped rather than crashing the sort.
  assert.deepEqual(dueNext({ assessments: [], events: [{ id: "bad" }], now: NOW }), []);
});
