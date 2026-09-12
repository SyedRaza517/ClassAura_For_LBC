// computeStreaks — pure, no Prisma, no clock. See studentStreaks.js's own header for
// what "days" means (one entry per TEACHING day; a day with no session at all is
// simply absent from the array, never a false entry).
//
// Run with: node --test src/studentStreaks.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");
const { computeStreaks, attendedForDay } = require("./studentStreaks");

// Small builder: N consecutive calendar dates starting at `start` (YYYY-MM-DD),
// every one a "true" day, unless `overrides` supplies attended values by index.
function days(start, n, overrides = {}) {
  const out = [];
  const d = new Date(`${start}T00:00:00Z`);
  for (let i = 0; i < n; i++) {
    const date = d.toISOString().slice(0, 10);
    out.push({ date, attended: i in overrides ? overrides[i] : true });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/* ===================== attendedForDay: the day-bucketing rule ===================== */
//
// GET /me/streaks calls this once per calendar date, on the "P"|"L"|"E"|"A" statuses
// of every session this student was marked for that day, to build the `days` array
// computeStreaks consumes above. Pinned here per review: a mixed P/L + E day counts
// as attended (E's half-credit discount already applies once, at summarise()'s
// unit-percentage layer — applying it again here by refusing to count the day would
// double-charge it); only a day with NO P/L evidence at all (only E) is neutral.

test("attendedForDay: a P/L-only day is attended", () => {
  assert.equal(attendedForDay(["P"]), true);
  assert.equal(attendedForDay(["L"]), true);
  assert.equal(attendedForDay(["P", "L"]), true);
});

test("attendedForDay: [P, L, E] with no A is attended — the pinned mixed case", () => {
  assert.equal(attendedForDay(["P", "L", "E"]), true);
  assert.equal(attendedForDay(["P", "E"]), true);
  assert.equal(attendedForDay(["L", "E"]), true);
});

test("attendedForDay: [E] only, with no P/L and no A, is neutral", () => {
  assert.equal(attendedForDay(["E"]), null);
  assert.equal(attendedForDay(["E", "E"]), null);
});

test("attendedForDay: [P, A] — any A is not attended, even alongside a P/L", () => {
  assert.equal(attendedForDay(["P", "A"]), false);
  assert.equal(attendedForDay(["A"]), false);
});

test("attendedForDay: A wins over everything, including a mix of P/L and E", () => {
  assert.equal(attendedForDay(["P", "L", "E", "A"]), false);
  assert.equal(attendedForDay(["E", "A"]), false);
});

test("attendedForDay: no statuses at all is treated as neutral rather than thrown on", () => {
  assert.equal(attendedForDay([]), null);
  assert.equal(attendedForDay(undefined), null);
});

/* ===================== computeStreaks ===================== */

test("empty input: no streak, no badges, nothing throws", () => {
  const result = computeStreaks({ days: [] });
  assert.deepEqual(result, { current: 0, best: 0, badges: [] });
});

test("missing `days` entirely behaves like empty input", () => {
  const result = computeStreaks({});
  assert.deepEqual(result, { current: 0, best: 0, badges: [] });
});

test("single day, attended: current and best are both 1, no streak badge yet", () => {
  const result = computeStreaks({ days: [{ date: "2026-09-01", attended: true }] });
  assert.equal(result.current, 1);
  assert.equal(result.best, 1);
  assert.deepEqual(result.badges, []);
});

test("single day, not attended: current and best are both 0", () => {
  const result = computeStreaks({ days: [{ date: "2026-09-01", attended: false }] });
  assert.equal(result.current, 0);
  assert.equal(result.best, 0);
});

test("a gap (an absence) breaks the streak: current resets, best remembers the run before it", () => {
  const input = [
    ...days("2026-09-01", 3),                     // 3-day run
    { date: "2026-09-04", attended: false },       // the gap
    ...days("2026-09-05", 2),                      // a fresh, shorter run
  ];
  const result = computeStreaks({ days: input });
  assert.equal(result.current, 2, "trailing run is only the 2 days after the gap");
  assert.equal(result.best, 3, "best remembers the run the gap broke");
});

test("a neutral (E-only / no-evidence) day bridges the streak WITHOUT counting toward its length", () => {
  // true, true, null, true, true — 4 attended days either side of one neutral day.
  const input = [
    { date: "2026-09-01", attended: true },
    { date: "2026-09-02", attended: true },
    { date: "2026-09-03", attended: null },
    { date: "2026-09-04", attended: true },
    { date: "2026-09-05", attended: true },
  ];
  const result = computeStreaks({ days: input });
  // The neutral day neither breaks the run (so it is not reset to 0/1 after it) nor
  // adds to its length (so 5 days in only yields a run of 4, not 5) — it is a bridge,
  // not a no-op day that still counts.
  assert.equal(result.current, 4);
  assert.equal(result.best, 4);
});

test("a neutral day does NOT reset a run in progress: a gap either side of it still breaks separately", () => {
  const input = [
    { date: "2026-09-01", attended: true },
    { date: "2026-09-02", attended: null },
    { date: "2026-09-03", attended: false }, // this is what breaks it, not the null
    { date: "2026-09-04", attended: true },
  ];
  const result = computeStreaks({ days: input });
  assert.equal(result.current, 1, "only the single day after the real gap");
  assert.equal(result.best, 1, "the pre-gap run only ever reached 1 (the null didn't add to it)");
});

test("badge earnedOn is the date the threshold was CROSSED, not the first or last day of the run", () => {
  const input = days("2026-09-01", 5); // 5 consecutive attended days
  const result = computeStreaks({ days: input });
  const streak5 = result.badges.find((b) => b.key === "streak5");
  assert.ok(streak5, "streak5 badge is awarded on reaching day 5");
  assert.equal(streak5.earnedOn, "2026-09-05", "the 5th day is the one that crossed the threshold");
});

test("streak10 and streak25 badges fire on their own threshold days, each exactly once", () => {
  const input = days("2026-09-01", 25);
  const result = computeStreaks({ days: input });
  const byKey = Object.fromEntries(result.badges.map((b) => [b.key, b]));
  assert.equal(byKey.streak5.earnedOn, "2026-09-05");
  assert.equal(byKey.streak10.earnedOn, "2026-09-10");
  assert.equal(byKey.streak25.earnedOn, "2026-09-25");
  assert.equal(result.current, 25);
  assert.equal(result.best, 25);
  // Exactly one of each — reaching day 25 must not re-award streak5 or streak10 again.
  assert.equal(result.badges.filter((b) => b.key === "streak5").length, 1);
  assert.equal(result.badges.filter((b) => b.key === "streak10").length, 1);
  assert.equal(result.badges.filter((b) => b.key === "streak25").length, 1);
});

test("a streak badge already earned is not un-earned when a later gap breaks the run", () => {
  const input = [...days("2026-09-01", 6), { date: "2026-09-07", attended: false }];
  const result = computeStreaks({ days: input });
  assert.ok(result.badges.find((b) => b.key === "streak5"), "streak5 was earned on day 5 and stays earned");
  assert.equal(result.current, 0, "but the CURRENT streak is broken");
  assert.equal(result.best, 6);
});

test("reaching a threshold again after a break does not duplicate the badge", () => {
  // 5 attended, a gap, then 5 more attended — streak5 is crossed twice.
  const input = [
    ...days("2026-09-01", 5),
    { date: "2026-09-06", attended: false },
    ...days("2026-09-07", 5),
  ];
  const result = computeStreaks({ days: input });
  assert.equal(result.badges.filter((b) => b.key === "streak5").length, 1);
  // Kept at the FIRST time it was crossed, like any other achievement.
  assert.equal(result.badges.find((b) => b.key === "streak5").earnedOn, "2026-09-05");
});

test("perfectWeek: a fully-attended CLOSED week earns the badge, dated its last day", () => {
  // Mon-Sun 2026-08-31..09-06 all attended, then one day into the next week so the
  // first week is provably closed (a later day exists in a different week).
  const input = [...days("2026-08-31", 7), { date: "2026-09-07", attended: true }];
  const result = computeStreaks({ days: input });
  const badge = result.badges.find((b) => b.key === "perfectWeek");
  assert.ok(badge, "the closed week was fully attended");
  assert.equal(badge.earnedOn, "2026-09-06");
});

test("perfectWeek: the trailing (still-open) period never earns the badge on its own", () => {
  const input = days("2026-08-31", 5); // Mon-Fri, all attended, week not yet closed
  const result = computeStreaks({ days: input });
  assert.equal(result.badges.find((b) => b.key === "perfectWeek"), undefined);
});

test("perfectWeek: a week containing an absence is not perfect, even once closed", () => {
  const input = [
    ...days("2026-08-31", 6, { 2: false }), // one absence mid-week
    { date: "2026-09-07", attended: true },  // closes the week
  ];
  const result = computeStreaks({ days: input });
  assert.equal(result.badges.find((b) => b.key === "perfectWeek"), undefined);
});

test("perfectWeek: a week of only neutral (E) days is not perfect — no evidence is not 100%", () => {
  const input = [
    { date: "2026-08-31", attended: null },
    { date: "2026-09-01", attended: null },
    { date: "2026-09-07", attended: true }, // closes the first week
  ];
  const result = computeStreaks({ days: input });
  assert.equal(result.badges.find((b) => b.key === "perfectWeek"), undefined);
});

test("perfectMonth: a fully-attended closed month earns the badge, dated its last recorded day", () => {
  const input = [
    { date: "2026-08-03", attended: true },
    { date: "2026-08-28", attended: true },
    { date: "2026-09-01", attended: true }, // closes August
  ];
  const result = computeStreaks({ days: input });
  const badge = result.badges.find((b) => b.key === "perfectMonth");
  assert.ok(badge);
  assert.equal(badge.earnedOn, "2026-08-28");
});

test("badges is a flat array carrying only { key, earnedOn } shapes", () => {
  const input = days("2026-09-01", 5);
  const result = computeStreaks({ days: input });
  for (const b of result.badges) {
    assert.equal(typeof b.key, "string");
    assert.equal(typeof b.earnedOn, "string");
    assert.deepEqual(Object.keys(b).sort(), ["earnedOn", "key"]);
  }
});
