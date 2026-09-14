// Tests for the suggestion cards — the pure half of the insights feed.
//
// Every card here can put a student's name in front of a lecturer or send an
// administrator chasing a unit, so the dangerous failures are the quiet ones the
// rest of this codebase already guards against by rule: a student nobody ever
// measured must not be reported as "not seen" (null is not zero), a percentage
// resting on three marks must not drive a card (denominator floors), and a card
// that would fire for nobody must be null rather than an empty shell the screen
// has to special-case.
//
// Run with: node --test   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  staleAttendanceCard, lowAttendanceCard, unitTrendCards,
  unownedRiskCard, stalePendingLeaveCard,
} = require("./cards");

/* ----------------------------- stale attendance --------------------------- */

test("a student not seen for 14+ days makes the card; one seen yesterday does not", () => {
  const card = staleAttendanceCard({
    today: "2026-09-14",
    students: [
      { id: "a", name: "Aisha Khan", lastAttendedOn: "2026-08-25", hasMarks: true },  // 20 days
      { id: "b", name: "Ben Osei", lastAttendedOn: "2026-09-13", hasMarks: true },    // 1 day
    ],
  });
  assert.ok(card, "no card for a 20-day absence");
  assert.equal(card.count, 1);
  assert.match(card.detail, /Aisha Khan/);
  assert.doesNotMatch(card.detail, /Ben Osei/);
});

test("a student with NO marks at all is never reported as unseen — unmeasured is not absent", () => {
  const card = staleAttendanceCard({
    today: "2026-09-14",
    students: [{ id: "a", name: "Never Marked", lastAttendedOn: null, hasMarks: false }],
  });
  assert.equal(card, null);
});

test("a student with marks but no P/L in the window reads as 'a while', not as a fabricated date", () => {
  const card = staleAttendanceCard({
    today: "2026-09-14",
    students: [{ id: "a", name: "Long Gone", lastAttendedOn: null, hasMarks: true }],
  });
  assert.ok(card);
  assert.equal(card.severity, "urgent");
});

test("severity is urgent only when somebody has been gone 21+ days", () => {
  const warn = staleAttendanceCard({ today: "2026-09-14", students: [{ id: "a", name: "A", lastAttendedOn: "2026-08-29", hasMarks: true }] }); // 16 days
  const urgent = staleAttendanceCard({ today: "2026-09-14", students: [{ id: "a", name: "A", lastAttendedOn: "2026-08-20", hasMarks: true }] }); // 25 days
  assert.equal(warn.severity, "warn");
  assert.equal(urgent.severity, "urgent");
});

test("more than three names collapse into '+N more' rather than a paragraph", () => {
  const card = staleAttendanceCard({
    today: "2026-09-14",
    students: ["A", "B", "C", "D", "E"].map((n) => ({ id: n, name: `Student ${n}`, lastAttendedOn: "2026-08-01", hasMarks: true })),
  });
  assert.equal(card.count, 5);
  assert.match(card.detail, /\+2 more/);
});

/* ----------------------------- low attendance ----------------------------- */

test("low attendance needs a real denominator — five marked sessions is not a finding", () => {
  const thin = lowAttendanceCard({ rows: [{ name: "A", unitCode: "U1", pct: 20, marked: 5 }] });
  const thick = lowAttendanceCard({ rows: [{ name: "A", unitCode: "U1", pct: 20, marked: 6 }] });
  assert.equal(thin, null);
  assert.ok(thick);
});

test("a null percentage (never marked) is excluded, never treated as 0", () => {
  const card = lowAttendanceCard({ rows: [{ name: "A", unitCode: "U1", pct: null, marked: 10 }] });
  assert.equal(card, null);
});

test("60% is the line: 59.9 fires, 60 does not", () => {
  assert.ok(lowAttendanceCard({ rows: [{ name: "A", unitCode: "U1", pct: 59.9, marked: 8 }] }));
  assert.equal(lowAttendanceCard({ rows: [{ name: "A", unitCode: "U1", pct: 60, marked: 8 }] }), null);
});

/* ----------------------------- unit trend --------------------------------- */

test("a unit that fell 10+ points over the window makes a card; a stable one does not", () => {
  const cards = unitTrendCards({
    units: [
      { code: "ML", name: "Machine Learning", recentPct: 62, priorPct: 78, recentMarks: 40, priorMarks: 44 },
      { code: "DB", name: "Databases", recentPct: 80, priorPct: 82, recentMarks: 40, priorMarks: 44 },
    ],
  });
  assert.equal(cards.length, 1);
  assert.match(cards[0].title, /Machine Learning/);
  assert.match(cards[0].detail, /16/); // the size of the fall, in points
});

test("a window with too few marks proves nothing — both sides need the floor", () => {
  const cards = unitTrendCards({
    units: [{ code: "ML", name: "ML", recentPct: 40, priorPct: 90, recentMarks: 29, priorMarks: 100 }],
  });
  assert.deepEqual(cards, []);
});

test("a null percentage on either side excludes the unit — a term break is not a collapse", () => {
  const cards = unitTrendCards({
    units: [{ code: "ML", name: "ML", recentPct: null, priorPct: 90, recentMarks: 0, priorMarks: 100 }],
  });
  assert.deepEqual(cards, []);
});

/* ----------------------------- admin counts ------------------------------- */

test("unowned risk: a count makes an urgent card, zero makes none", () => {
  assert.equal(unownedRiskCard({ count: 0 }), null);
  const card = unownedRiskCard({ count: 4 });
  assert.equal(card.severity, "urgent");
  assert.match(card.detail, /no open intervention/);
});

test("stale pending leave: fires from 1, says how old the oldest is", () => {
  assert.equal(stalePendingLeaveCard({ count: 0, oldestDays: 0 }), null);
  const card = stalePendingLeaveCard({ count: 3, oldestDays: 12 });
  assert.ok(card);
  assert.match(card.detail, /12 day/);
});

/* ----------------------------- shape --------------------------------------- */

test("every card carries exactly the published fields, so the route cannot leak by accident", () => {
  const card = staleAttendanceCard({ today: "2026-09-14", students: [{ id: "a", name: "A", lastAttendedOn: "2026-08-01", hasMarks: true }] });
  assert.deepEqual(Object.keys(card).sort(), ["count", "detail", "kind", "screen", "severity", "title"]);
});
