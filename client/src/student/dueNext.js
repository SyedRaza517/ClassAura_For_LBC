// The Home screen's "Due next" card: one interleaved, soonest-first list of what a
// student actually has to act on — assessments still awaiting a mark, and classes
// starting within the next 48 hours.
//
// PURE, on purpose, like timetableView.js and utils.js's date helpers. The card
// itself (Home.jsx) owns fetching `assessments`/`events` and "now"; this file only
// ever reasons about the arrays and the clock reading it is handed, which is what
// makes it testable with a plain object and nothing else (dueNext.test.js).
//
// WHY "now" IS A PARAMETER, NEVER `new Date()`. Every date/time in this codebase is a
// string compared as a string (conventions.md), read from the London wall clock via
// server/src/clock.js rather than the host's — and a pure client module has no
// server clock to ask. Taking `now` as `{ date, time }` keeps this file dependency-
// free and testable at a fixed instant (the host running the test suite is not
// necessarily in the same timezone as a college, and must not be able to make a test
// flake), and pushes "what time is it really" up to Home.jsx, which already reads it
// the same way CheckIn.jsx does (tapContext.date/time come from the server).

// Add whole hours to a "YYYY-MM-DDTHH:MM" key using explicit UTC arithmetic — the
// same trick Timetable.jsx's ttWeekStart/ttWeeksBetween use for exactly the same
// reason: this is calendar-and-clock arithmetic on a wall-clock reading that has
// already been decided (by the server, or by a test), not a real timezone-aware
// instant, and letting `Date` parse it as host-local would make the 48h boundary
// silently move depending on where this code happens to run.
function addHours(key, hours) {
  const [d, t] = key.split("T");
  const dt = new Date(`${d}T${t}:00Z`);
  dt.setUTCHours(dt.getUTCHours() + hours);
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}`;
}

/**
 * dueNext({ assessments, events, now }) -> [{ kind, id, sortKey, ... }]
 *
 * `assessments` — this student's own /me/assessments `.assessments` array (each
 *   carries `dueDate`, nullable, and `marks`, null until graded).
 * `events` — this student's own /me/timetable `.events` array (each carries `date`,
 *   `start`/`end`, and the nullable `teamsJoinUrl` the register itself resolved —
 *   see routes/student.js#studentEvents for why that beats the event's own copy).
 * `now` — `{ date: "YYYY-MM-DD", time: "HH:MM" }`, the London wall clock right now.
 *
 * Returns EVERY qualifying item, soonest-first — the caller (Home.jsx) decides how
 * many to actually show (the brief's "top 4"), which is a rendering decision and does
 * not belong in a pure module that a badge count or a "how many are overdue" figure
 * might one day also want the full list for.
 *
 * SORTING IS ONE COMPARISON, NOT TWO LISTS MERGED. Every item gets a single
 * chronological `sortKey` (a due deadline treated as end-of-day, or a class's exact
 * start) and the whole array sorts ascending on it. An overdue item's key is simply
 * in the past, so it floats to the top on its own — the MOST overdue item sorts
 * first, which is "soonest" read as "least able to wait any longer" rather than as
 * a countdown to zero. No special-casing overdue-vs-future was needed for that to
 * fall out correctly, which is the point of using one comparable key throughout
 * rather than two.
 */
export function dueNext({ assessments, events, now } = {}) {
  if (!now || !now.date || !now.time) return [];
  const nowKey = `${now.date}T${now.time}`;
  const windowEnd = addHours(nowKey, 48);

  const items = [];

  for (const a of Array.isArray(assessments) ? assessments : []) {
    if (!a || !a.dueDate) continue;       // nothing to place this by
    if (a.marks != null) continue;        // graded — no longer "due"
    // A deadline is due by the END of its day, not its start — a due-today
    // assessment must not outrank a class running at 2pm today, which is genuinely
    // the more time-sensitive of the two.
    const dueKey = `${a.dueDate}T23:59`;
    items.push({
      kind: dueKey < nowKey ? "overdue" : "assessment",
      id: `assessment:${a.id}`,
      sortKey: dueKey,
      assessmentId: a.id,
      title: a.title,
      unitCode: a.unitCode ?? null,
      unitName: a.unitName ?? null,
      dueDate: a.dueDate,
    });
  }

  for (const e of Array.isArray(events) ? events : []) {
    if (!e || !e.date || !e.start) continue;
    const startKey = `${e.date}T${e.start}`;
    // Outside [now, now+48h] — already started (or finished), or too far ahead to be
    // "next". A class already running is not excluded because it is unimportant; it
    // is excluded because CheckIn.jsx (TodaysClasses) is the screen that owns "what
    // is happening right now" and this card would otherwise duplicate it.
    if (startKey < nowKey || startKey > windowEnd) continue;
    items.push({
      kind: "class",
      id: `class:${e.id}`,
      sortKey: startKey,
      sessionId: e.sessionId ?? null,
      title: e.title || e.unitName || e.unitCode || "Class",
      unitCode: e.unitCode ?? null,
      unitName: e.unitName ?? null,
      date: e.date,
      start: e.start,
      end: e.end ?? null,
      room: e.room ?? null,
      teamsJoinUrl: e.teamsJoinUrl || null,
    });
  }

  items.sort((x, y) => (x.sortKey < y.sortKey ? -1 : x.sortKey > y.sortKey ? 1 : 0));
  return items;
}

export default dueNext;
