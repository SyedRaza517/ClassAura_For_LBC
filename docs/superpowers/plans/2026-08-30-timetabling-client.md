# CELCAT-style Timetabling — Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the CELCAT Calendar in front of staff — a Day/Week/Month/Timeline timetable they read on the web and in the phone app — and the planner behind it where an administrator places events and assigns rooms, staff and groups by hand.

**Architecture:** One presentational grid component (`TimetableCalendar`) drawn by two containers: `MyTimetable` for staff and `AdminTimetablePlanner` for administrators. All date-window arithmetic lives in one pure module with real tests, because the server half already produced one clock-change bug and the client repeats the same arithmetic. Two modals — the resource picker and My Settings — are their own files so neither container grows unreadable.

**Tech Stack:** React 18 + Vite, Tailwind utility classes, `lucide-react` icons, no router (screens are state). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-30-celcat-timetabling-design.md`
**Plan 1 (done):** `docs/superpowers/plans/2026-08-30-timetabling-server.md`

## Global Constraints

- **Do not add a dependency.** Everything here is React, Tailwind and `lucide-react`, all already present.
- **`client/package.json` has `"type": "module"`,** so `node --test` runs client `.js` files directly. That is why the pure module in Task 2 has real tests even though `CLAUDE.md` says there is no client test framework — and it is the only place in this plan that gets them. Everything else is verified by building.
- **All date arithmetic in UTC.** `new Date(\`${d}T00:00:00Z\`)`, `getUTCDay`, `setUTCDate`. Local-time arithmetic across the spring clock change lands on 23:00 the previous day and slips every subsequent date back by one — the server half hit exactly this and `recurrence.test.js` pins it.
- **Dates are `YYYY-MM-DD` strings, times `HH:MM`, compared as strings.** Never `Date` objects in state or props.
- **Weekdays are ISO 1–7, Monday = 1**, matching `TimetableSlot.day` and `settings.days`.
- **Brand colours come from `./branding`** — `NAVY`, `NAVY_DARK`, `MAROON`, `alpha()`. Never hardcode a hex except where a category supplies one.
- **`changedAt` is a timestamp; the screen subtracts.** Never store or pass a day count.
- **On a handset, Week falls back to List.** `useIsHandset()` from `./PhoneShell` decides. A seven-column hour grid at 390px is unreadable, and the source system's own mobile does the same.
- **Comments explain WHY, at length, including rejected alternatives.** Match the density of `AdminNfcTags.jsx` and `StaffHub.jsx`.
- **Never invent an endpoint.** The server is built and frozen for this plan; every shape it returns is listed in "The API as built" below.
- Verify each task with `npm run --workspace client build` from the repo root. The build is the only safety net most of this code has.

### The API as built

Copy these shapes exactly; they are read from `server/src/routes/`.

| Call | Returns |
|---|---|
| `GET /my-timetable?from&to[&type&ids]` | `{ from, to, scope: {type, ids}, events: [Event], settings: Settings }` |
| `GET /my-timetable/resources?type&q[&limit]` | `{ type, total, results: [{id,label,sub}], needsQuery? }` |
| `GET /my-timetable/settings` | `{ settings, tenant }` |
| `PUT /my-timetable/settings` | `{ settings }` |
| `GET /timetabling/rooms` | `[Room]` |
| `POST/PUT /timetabling/rooms[/:id]` | `Room` — 409 on duplicate name+campus |
| `DELETE /timetabling/rooms/:id` | `{ ok, eventsLeftWithoutARoom }` |
| `GET /timetabling/categories` | `[Category]` |
| `POST/PUT /timetabling/categories[/:id]` | `Category` — 400 on non-hex colour |
| `DELETE /timetabling/categories/:id` | `{ ok, eventsLeftWithoutACategory }` |
| `GET /timetabling/events?from&to[&roomId&staffId&cohortId&unitId&published]` | `[Event]` |
| `POST /timetabling/events` | `{ event, warnings }` — **201 even with warnings** |
| `PUT /timetabling/events/:id` | `{ event, warnings }` |
| `DELETE /timetabling/events/:id` | `{ ok }` |
| `POST /timetabling/events/:id/repeat` | `{ created, dates, warnings: [{date, clashes}] }` |
| `POST /timetabling/events/publish` | `{ updated }` |
| `GET /timetabling/settings` | `{ defaults, tenant }` |
| `PUT /timetabling/settings` | `{ tenant }` |

`Event` = `{ id, date, start, end, title, notes, published, changedAt, unitId, unitCode, unitName, courseId, courseName, roomId, room, categoryId, category, categoryColour, staff: [{id,name}], groups: [{id,name}] }`

`Room` = `{ id, name, floor, campus, capacity, kind, active, label }`
`Category` = `{ id, name, colour, active }`
`Settings` = `{ view, layout, days, periods:[{start,end}], colourBy, colourVariant, showEventTimes, showEventId, showAvailability, swapAxes, highlightChangedDays, annotations, notice:{enabled,text} }`

**A clash warning is not an error.** `POST`/`PUT` return 201/200 *with* `warnings`. Treat a non-empty `warnings` as something to show, never as a failed save — the server deliberately warns rather than blocks.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `client/src/timetableView.js` | Pure: date windows per view, weekday filtering, anchor navigation, event→grid placement, colour and annotation resolution. No React. |
| `client/src/timetableView.test.js` | `node:test` tests for the above. |
| `client/src/TimetableCalendar.jsx` | Presentational. Draws Day/Week/Month/Timeline/List from `{events, settings, view, anchor}`. Fetches nothing. |
| `client/src/SelectTimetablesModal.jsx` | The "Select timetables" picker across the five resource types. |
| `client/src/TimetableSettingsModal.jsx` | My Settings — the three tabs. |
| `client/src/MyTimetable.jsx` | Staff container: fetches, holds view/anchor, renders banner + toolbar + calendar + modals. |
| `client/src/AdminTimetablePlanner.jsx` | Admin container: rooms, categories, the event editor, clash warnings, publish, college settings. |

**Modified:**

| File | Change |
|---|---|
| `client/src/api.js` | ~20 new methods. |
| `client/src/StaffHub.jsx` | Staff tile + screen + header title; admin tab entry + render line; two imports. |
| `scripts/test.mjs` | One extra `node --test` invocation so the client's pure tests actually run. |

---

## Task 1: API methods

**Files:**
- Modify: `client/src/api.js`

**Interfaces:**
- Consumes: the existing `request()` helper in that file.
- Produces, on the exported `api` object:
  `myTimetable(from, to, type, ids)`, `myTimetableResources(type, q, limit)`, `myTimetableSettings()`, `saveMyTimetableSettings(patch)`,
  `ttRooms()`, `ttCreateRoom(d)`, `ttUpdateRoom(id, d)`, `ttDeleteRoom(id)`,
  `ttCategories()`, `ttCreateCategory(d)`, `ttUpdateCategory(id, d)`, `ttDeleteCategory(id)`,
  `ttEvents(params)`, `ttCreateEvent(d)`, `ttUpdateEvent(id, d)`, `ttDeleteEvent(id)`, `ttRepeatEvent(id, d)`, `ttPublish(d)`,
  `ttSettings()`, `ttSaveSettings(patch)`

- [ ] **Step 1: Add the methods**

Insert into the `api` object in `client/src/api.js`, immediately after the existing `removeTimetableSlot` line (which ends the old timetable block):

```js
  // CELCAT-style timetabling. Two groups, and the split is the point: `myTimetable*`
  // is what every lecturer calls and needs no admin page, while `tt*` is the planner
  // and 403s for anyone without the "scheduling" page. Naming them apart keeps a
  // planner call from being pasted into a staff screen, where it would work for the
  // developer testing it as an admin and 403 for every real user of that screen.
  myTimetable: (from, to, type, ids) => {
    const q = new URLSearchParams({ from, to });
    // Sent only together. `type` without `ids` means "my own", which is the default
    // the server already applies — sending a bare type would be a no-op that reads
    // like a filter.
    if (type && ids?.length) { q.set("type", type); q.set("ids", ids.join(",")); }
    return request(`/my-timetable?${q.toString()}`);
  },
  myTimetableResources: (type, q = "", limit = 25) =>
    request(`/my-timetable/resources?${new URLSearchParams({ type, q, limit: String(limit) })}`),
  myTimetableSettings: () => request("/my-timetable/settings"),
  saveMyTimetableSettings: (patch) => request("/my-timetable/settings", { method: "PUT", body: patch }),

  ttRooms: () => request("/timetabling/rooms"),
  ttCreateRoom: (d) => request("/timetabling/rooms", { method: "POST", body: d }),
  ttUpdateRoom: (id, d) => request(`/timetabling/rooms/${id}`, { method: "PUT", body: d }),
  ttDeleteRoom: (id) => request(`/timetabling/rooms/${id}`, { method: "DELETE" }),

  ttCategories: () => request("/timetabling/categories"),
  ttCreateCategory: (d) => request("/timetabling/categories", { method: "POST", body: d }),
  ttUpdateCategory: (id, d) => request(`/timetabling/categories/${id}`, { method: "PUT", body: d }),
  ttDeleteCategory: (id) => request(`/timetabling/categories/${id}`, { method: "DELETE" }),

  ttEvents: (params) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
    return request(`/timetabling/events?${q.toString()}`);
  },
  ttCreateEvent: (d) => request("/timetabling/events", { method: "POST", body: d }),
  ttUpdateEvent: (id, d) => request(`/timetabling/events/${id}`, { method: "PUT", body: d }),
  ttDeleteEvent: (id) => request(`/timetabling/events/${id}`, { method: "DELETE" }),
  ttRepeatEvent: (id, d) => request(`/timetabling/events/${id}/repeat`, { method: "POST", body: d }),
  ttPublish: (d) => request("/timetabling/events/publish", { method: "POST", body: d }),

  ttSettings: () => request("/timetabling/settings"),
  ttSaveSettings: (patch) => request("/timetabling/settings", { method: "PUT", body: patch }),
```

- [ ] **Step 2: Verify every method exists**

**Do not try to `import` `api.js` under plain `node`.** It reads `import.meta.env.VITE_API_URL` at module top level, which Vite injects and Node leaves `undefined`, so the module throws during evaluation before any export is reachable — on the unmodified file just as much as on yours. Check the source text instead, with a shell loop rather than a `node -e` regex (the escaping does not survive the layers), then let the build do the rest.

```bash
cd "c:/Users/Lenovo/Documents/Edtech" && for m in myTimetable myTimetableResources myTimetableSettings saveMyTimetableSettings ttRooms ttCreateRoom ttUpdateRoom ttDeleteRoom ttCategories ttCreateCategory ttUpdateCategory ttDeleteCategory ttEvents ttCreateEvent ttUpdateEvent ttDeleteEvent ttRepeatEvent ttPublish ttSettings ttSaveSettings; do grep -q "  $m:" client/src/api.js || echo "MISSING $m"; done | grep MISSING || echo "PASS: all 20 present"
npm run --workspace client build 2>&1 | tail -3
```

Expected: `PASS: all 20 present`, then `✓ built in …`.

- [ ] **Step 3: Commit**

```bash
git add client/src/api.js
git commit -m "Client calls for the timetable, named apart so a planner call cannot pass for a staff one"
```

---

## Task 2: The pure view module

**Files:**
- Create: `client/src/timetableView.js`
- Test: `client/src/timetableView.test.js`
- Modify: `scripts/test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `windowFor(view: string, anchor: string): {from: string, to: string}`
  - `shiftAnchor(view: string, anchor: string, delta: number, big?: boolean): string`
  - `datesIn(from: string, to: string, days: number[]): string[]`
  - `isoDay(date: string): number` — 1 (Mon) … 7 (Sun)
  - `minutes(hhmm: string): number`
  - `placeEvent(event, periods): {topPct: number, heightPct: number} | null`
  - `colourOf(event, colourBy: string): string`
  - `annotationLines(event, annotations: string[]): string[]`
  - `changedWithin(event, days: number, today: string): boolean`
  - `RANGE_LABEL(view, from, to): string`

- [ ] **Step 1: Write the failing test**

Create `client/src/timetableView.test.js`:

```js
// Tests for the timetable's date arithmetic and grid placement.
//
// This is the ONLY tested file in the client, and it is tested because the server
// half already produced a clock-change bug in exactly this arithmetic
// (server/src/timetabling/recurrence.test.js pins it) and this module repeats the
// shape. client/package.json has "type": "module", so node runs these directly.
//
// Run with: node --test client/src/timetableView.test.js   (from the repo root)
import test from "node:test";
import assert from "node:assert/strict";

import {
  windowFor, shiftAnchor, datesIn, isoDay, minutes,
  placeEvent, colourOf, annotationLines, changedWithin,
} from "./timetableView.js";

const PERIODS = [
  { start: "09:00", end: "10:00" }, { start: "10:00", end: "11:00" },
  { start: "11:00", end: "12:00" }, { start: "12:00", end: "13:00" },
];

/* ------------------------------------------------------------- weekdays -- */

test("isoDay puts Monday at 1 and Sunday at 7", () => {
  assert.equal(isoDay("2026-08-31"), 1);  // a Monday
  assert.equal(isoDay("2026-09-06"), 7);  // the Sunday after
});

/* --------------------------------------------------------------- window -- */

test("a week window runs Monday to Sunday, whatever day the anchor is", () => {
  assert.deepEqual(windowFor("week", "2026-09-02"), { from: "2026-08-31", to: "2026-09-06" });
  assert.deepEqual(windowFor("week", "2026-08-31"), { from: "2026-08-31", to: "2026-09-06" });
  assert.deepEqual(windowFor("week", "2026-09-06"), { from: "2026-08-31", to: "2026-09-06" });
});

test("a day window is that one day", () => {
  assert.deepEqual(windowFor("day", "2026-09-02"), { from: "2026-09-02", to: "2026-09-02" });
});

test("a month window covers WHOLE weeks, so the grid has no ragged edge", () => {
  // September 2026 starts on a Tuesday, so the grid must open on Mon 31 Aug.
  assert.deepEqual(windowFor("month", "2026-09-15"), { from: "2026-08-31", to: "2026-10-04" });
});

test("a timeline window is two weeks from the anchor's Monday", () => {
  assert.deepEqual(windowFor("timeline", "2026-09-02"), { from: "2026-08-31", to: "2026-09-13" });
});

/* ----------------------------------------------------------- navigation -- */

test("next and previous move by the view's own unit", () => {
  assert.equal(shiftAnchor("day", "2026-09-02", 1), "2026-09-03");
  assert.equal(shiftAnchor("week", "2026-09-02", 1), "2026-09-09");
  assert.equal(shiftAnchor("week", "2026-09-02", -1), "2026-08-26");
});

test("the big jump moves a month in day/week and a year in month", () => {
  assert.equal(shiftAnchor("week", "2026-09-02", 1, true), "2026-10-02");
  assert.equal(shiftAnchor("month", "2026-09-02", 1, true), "2027-09-02");
});

test("a month step from the 31st does not skip a month", () => {
  // 31 Jan + 1 month is 31 Feb, which JS silently rolls into March. A user pressing
  // "next month" on the 31st would then see March and never February.
  assert.equal(shiftAnchor("month", "2026-01-31", 1), "2026-02-28");
});

test("stepping survives the spring clock change without drifting a day", () => {
  // 29 March 2026 is when BST starts. Local-time arithmetic lands on 23:00 the
  // previous day and slips every later date back one.
  assert.equal(shiftAnchor("day", "2026-03-28", 1), "2026-03-29");
  assert.equal(shiftAnchor("week", "2026-03-23", 1), "2026-03-30");
});

/* ---------------------------------------------------------------- dates -- */

test("datesIn returns every date in the window", () => {
  assert.deepEqual(datesIn("2026-09-01", "2026-09-04", [1, 2, 3, 4, 5, 6, 7]),
    ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]);
});

test("datesIn drops the weekdays the reader has switched off", () => {
  // A lecturer who hides Saturday and Sunday must not get two empty columns.
  assert.deepEqual(datesIn("2026-08-31", "2026-09-06", [1, 2, 3, 4, 5]),
    ["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]);
});

test("datesIn with no allowed days returns nothing rather than everything", () => {
  // Failing closed. An empty list is a settings bug, and showing the whole week
  // would hide it; showing nothing is visibly wrong and gets reported.
  assert.deepEqual(datesIn("2026-08-31", "2026-09-06", []), []);
});

/* -------------------------------------------------------------- placing -- */

test("minutes parses HH:MM", () => {
  assert.equal(minutes("09:30"), 570);
  assert.equal(minutes("00:00"), 0);
});

test("an event fills the fraction of the grid its times cover", () => {
  // The grid runs 09:00-13:00 = 240 minutes. 10:00-11:00 starts a quarter in and
  // covers a quarter.
  const p = placeEvent({ start: "10:00", end: "11:00" }, PERIODS);
  assert.equal(Math.round(p.topPct), 25);
  assert.equal(Math.round(p.heightPct), 25);
});

test("an event outside the shown periods is not placed at all", () => {
  // Not clamped to the edge. A 20:00 class drawn on the last row of a grid that
  // stops at 13:00 is a lie about when it happens; leaving it out is honest, and
  // the reader's own settings are what excluded it.
  assert.equal(placeEvent({ start: "20:00", end: "21:00" }, PERIODS), null);
});

test("an event that starts before the grid is clipped, not dropped", () => {
  // It genuinely overlaps the visible hours, so it must appear — starting at the top.
  const p = placeEvent({ start: "08:00", end: "10:00" }, PERIODS);
  assert.equal(Math.round(p.topPct), 0);
  assert.equal(Math.round(p.heightPct), 25);
});

/* --------------------------------------------------------------- colour -- */

test("colour follows the chosen dimension, not the event", () => {
  const e = { categoryColour: "#111111", roomId: "r1", unitId: "u1", groups: [{ id: "g1" }] };
  assert.equal(colourOf(e, "category"), "#111111");
  // The others are derived from the id, so the same room is the same colour every
  // time without anybody having to assign one.
  assert.equal(colourOf(e, "room"), colourOf({ ...e, categoryColour: "#999999" }, "room"));
  assert.notEqual(colourOf(e, "room"), colourOf({ ...e, roomId: "r2" }, "room"));
});

test("an event with nothing on the chosen dimension still gets a colour", () => {
  // Never undefined — an undefined colour renders as an invisible event.
  assert.match(colourOf({}, "room"), /^#|^var\(/);
});

/* ---------------------------------------------------------- annotations -- */

test("annotations print in the order given, skipping what the event lacks", () => {
  const e = { title: "Systems", unitCode: "U1", room: "101 [Harrow]", staff: [{ name: "A B" }], groups: [], category: null };
  assert.deepEqual(annotationLines(e, ["title", "room", "category", "staff", "group"]),
    ["Systems", "101 [Harrow]", "A B"]);
});

test("reordering annotations reorders the output, because the order IS the setting", () => {
  const e = { title: "Systems", room: "101" };
  assert.deepEqual(annotationLines(e, ["room", "title"]), ["101", "Systems"]);
});

/* ------------------------------------------------------------- recently -- */

test("recently-changed is computed from the timestamp at render time", () => {
  // Never a stored day count: that would be wrong by the next morning with nothing
  // to correct it.
  const e = { changedAt: "2026-09-01T10:00:00.000Z" };
  assert.equal(changedWithin(e, 7, "2026-09-03"), true);
  assert.equal(changedWithin(e, 1, "2026-09-03"), false);
});

test("zero days means the highlight is off, not 'changed today'", () => {
  assert.equal(changedWithin({ changedAt: "2026-09-03T10:00:00.000Z" }, 0, "2026-09-03"), false);
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd "c:/Users/Lenovo/Documents/Edtech" && node --test client/src/timetableView.test.js
```

Expected: FAIL — `Cannot find module ./timetableView.js`.

- [ ] **Step 3: Write the implementation**

Create `client/src/timetableView.js`:

```js
// The timetable's arithmetic: which dates a view covers, where an event sits in the
// grid, what colour it is and what it says.
//
// Pure, and separate from the components for one reason above all: this is the code
// that goes wrong. The server half of this feature produced a clock-change bug in
// exactly this shape of arithmetic, and this module repeats it. Everything here is
// therefore in UTC, takes strings and returns strings, and has tests — which no
// other file in the client does.

/** A YYYY-MM-DD string as a UTC Date. */
const utc = (d) => new Date(`${d}T00:00:00Z`);
/** A UTC Date back to YYYY-MM-DD. */
const iso = (dt) => dt.toISOString().slice(0, 10);

/** ISO weekday: 1 = Monday … 7 = Sunday. JS gives 0 for Sunday. */
export function isoDay(date) {
  const d = utc(date).getUTCDay();
  return d === 0 ? 7 : d;
}

/** `date` moved by n days, in UTC. */
export function addDays(date, n) {
  const dt = utc(date);
  dt.setUTCDate(dt.getUTCDate() + n);
  return iso(dt);
}

/**
 * `date` moved by n months, clamped to the last day of the target month.
 *
 * Without the clamp, 31 January + 1 month is "31 February", which JS silently rolls
 * into March — so a reader pressing "next month" on the 31st would jump from January
 * to March and never see February.
 */
export function addMonths(date, n) {
  const dt = utc(date);
  const day = dt.getUTCDate();
  dt.setUTCDate(1);
  dt.setUTCMonth(dt.getUTCMonth() + n);
  const lastDay = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
  dt.setUTCDate(Math.min(day, lastDay));
  return iso(dt);
}

/** The Monday of the week containing `date`. Weeks start Monday, as ISO 1-7 does. */
export const mondayOf = (date) => addDays(date, -(isoDay(date) - 1));

/**
 * The date range one view covers.
 *
 * Month covers WHOLE WEEKS rather than the 1st to the 30th, so the grid is a
 * rectangle. September 2026 begins on a Tuesday; a window starting on the 1st would
 * leave a ragged first row with a hole where Monday should be.
 */
export function windowFor(view, anchor) {
  switch (view) {
    case "day":
      return { from: anchor, to: anchor };
    case "month": {
      const first = `${anchor.slice(0, 7)}-01`;
      const lastDay = new Date(Date.UTC(Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7)), 0)).getUTCDate();
      const last = `${anchor.slice(0, 7)}-${String(lastDay).padStart(2, "0")}`;
      return { from: mondayOf(first), to: addDays(mondayOf(last), 6) };
    }
    case "timeline":
      // Two weeks. One is a Week view laid sideways and adds nothing; a term is
      // unreadable at any zoom that still shows a room name.
      return { from: mondayOf(anchor), to: addDays(mondayOf(anchor), 13) };
    case "week":
    default:
      return { from: mondayOf(anchor), to: addDays(mondayOf(anchor), 6) };
  }
}

/**
 * The anchor moved one step. `big` is the ⟪ ⟫ pair, which moves further.
 *
 * The unit is the view's own: pressing "next" in Week means next week, not next day.
 * A single shared "+7" would make the arrows mean different amounts of travel
 * depending on a setting the reader cannot see.
 */
export function shiftAnchor(view, anchor, delta, big = false) {
  if (view === "month") return addMonths(anchor, big ? delta * 12 : delta);
  if (big) return addMonths(anchor, delta);
  if (view === "day") return addDays(anchor, delta);
  if (view === "timeline") return addDays(anchor, delta * 14);
  return addDays(anchor, delta * 7);
}

/**
 * Every date from `from` to `to` whose weekday the reader has switched on.
 *
 * An empty `days` returns nothing, deliberately. It can only come from a broken
 * settings blob, and quietly showing the whole week instead would hide the fault;
 * an empty grid is visibly wrong and gets reported.
 */
export function datesIn(from, to, days) {
  const allowed = new Set(days || []);
  const out = [];
  if (!allowed.size || to < from) return out;
  // A year of days is the widest any view asks for, and the guard stops a bad
  // window spinning the browser.
  for (let d = from, guard = 0; d <= to && guard < 400; d = addDays(d, 1), guard++) {
    if (allowed.has(isoDay(d))) out.push(d);
  }
  return out;
}

/** "HH:MM" as minutes past midnight. */
export function minutes(hhmm) {
  const [h, m] = String(hhmm || "0:0").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * Where an event sits in the grid, as percentages of the visible span.
 *
 * Returns null when the event does not overlap the shown periods at all. NOT clamped
 * to the nearest edge: a 20:00 class drawn on the last row of a grid that stops at
 * 13:00 is a lie about when it happens, and the reader's own settings are what
 * excluded it. An event that only PARTLY overlaps is clipped and shown, because it
 * genuinely occurs during hours the reader is looking at.
 */
export function placeEvent(event, periods) {
  if (!periods?.length) return null;
  const gridStart = minutes(periods[0].start);
  const gridEnd = minutes(periods[periods.length - 1].end);
  const span = gridEnd - gridStart;
  if (span <= 0) return null;

  const start = Math.max(minutes(event.start), gridStart);
  const end = Math.min(minutes(event.end), gridEnd);
  if (end <= start) return null;

  return { topPct: ((start - gridStart) / span) * 100, heightPct: ((end - start) / span) * 100 };
}

// A fixed, deliberately unsaturated wheel for the dimensions that carry no colour of
// their own. Derived from the id so the same room is the same colour on every
// screen, every day, without anybody assigning one.
const WHEEL = ["#1f6f8b", "#7a4988", "#b06d2b", "#2f7a4f", "#8a3d52", "#3f5f9e", "#6b7a2b", "#8b4a2b"];
const hashOf = (s) => { let h = 0; for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0; return Math.abs(h); };

/**
 * The colour for an event under the reader's chosen dimension.
 *
 * Colour is a CHOSEN DIMENSION here, not a property of the event — the source
 * system's "Event colour key" is a question about what colour should mean. Never
 * returns undefined: an undefined colour renders as an invisible event.
 */
export function colourOf(event, colourBy) {
  const byId = (id) => WHEEL[hashOf(id || "none") % WHEEL.length];
  switch (colourBy) {
    case "category": return event?.categoryColour || byId(event?.categoryId);
    case "room":     return byId(event?.roomId);
    case "module":   return byId(event?.unitId);
    case "course":   return byId(event?.courseId);
    case "group":    return byId(event?.groups?.[0]?.id);
    default:         return event?.categoryColour || byId(event?.id);
  }
}

/**
 * What prints inside an event tile, in the reader's chosen order.
 *
 * The ORDER is the setting — it is what a lecturer sees first when a tile is too
 * small for everything. Fields the event lacks are skipped rather than printed
 * blank, so a tile never carries an empty line pushing the useful ones out of view.
 */
export function annotationLines(event, annotations) {
  const value = (key) => {
    switch (key) {
      case "title":    return event?.title || "";
      case "unit":     return event?.unitCode || event?.unitName || "";
      case "category": return event?.category || "";
      case "room":     return event?.room || "";
      case "staff":    return (event?.staff || []).map((s) => s.name).filter(Boolean).join(", ");
      case "group":    return (event?.groups || []).map((g) => g.name).filter(Boolean).join(", ");
      case "course":   return event?.courseName || "";
      case "eventId":  return event?.id || "";
      default:         return "";
    }
  };
  return (annotations || []).map(value).filter(Boolean);
}

/**
 * Has this event moved within the last `days` days?
 *
 * Computed here, at render time, from the timestamp — never read from a stored day
 * count, which would be wrong by the next morning with nothing to correct it.
 * `days === 0` means the highlight is switched off, which is not the same as
 * "changed today".
 */
export function changedWithin(event, days, today) {
  if (!days || days <= 0 || !event?.changedAt) return false;
  const changed = String(event.changedAt).slice(0, 10);
  return changed >= addDays(today, -days) && changed <= today;
}

const DMY = { day: "numeric", month: "short" };
/** The label between the navigation arrows: "24 - 30 Aug 26", "30 Aug 2026". */
export function RANGE_LABEL(view, from, to) {
  const f = utc(from), t = utc(to);
  const yr = t.getUTCFullYear();
  if (view === "day") return `${f.toLocaleDateString("en-GB", { ...DMY, year: "numeric", timeZone: "UTC" })}`;
  if (view === "month") return f.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  return `${f.toLocaleDateString("en-GB", { ...DMY, timeZone: "UTC" })} - ${t.toLocaleDateString("en-GB", { ...DMY, timeZone: "UTC" })} ${String(yr).slice(2)}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd "c:/Users/Lenovo/Documents/Edtech" && node --test client/src/timetableView.test.js
```

Expected: PASS, 20 tests.

- [ ] **Step 5: Prove the clock-change and month-step tests can fail**

Two deliberate breaks, one at a time, each run and reverted. A test that cannot fail is not coverage — that has already happened twice in this repo, and once in Plan 1.

1. In `addDays`, change `setUTCDate`/`getUTCDate` to `setDate`/`getDate` and `utc()` to `new Date(\`${d}T00:00:00\`)`. Run with `TZ=Europe/London`. **"stepping survives the spring clock change" must fail.** Revert.
2. In `addMonths`, delete the `lastDay` clamp (just `dt.setUTCMonth(dt.getUTCMonth() + n)` on the original date). **"a month step from the 31st does not skip a month" must fail** with `2026-03-03`. Revert.

```bash
cd "c:/Users/Lenovo/Documents/Edtech" && TZ=Europe/London node --test client/src/timetableView.test.js
```

- [ ] **Step 6: Wire the client's pure tests into the runner**

Without this the tests rot — nothing would ever run them again. In `scripts/test.mjs`, immediately after the existing server unit-test block (the `results.push({ suite: "unit tests (node --test)" ... })` line and its `console.log("")`), add:

```js
  // The client has no test framework, and this is not one. It is the single pure
  // module in client/src — the timetable's date arithmetic — which is tested because
  // the server half produced a clock-change bug in exactly this shape and the client
  // repeats it. client/package.json is "type": "module", so node runs it directly.
  // An explicit file, not a glob: there is one such file, and a glob would invite
  // somebody to point it at src/ where every .jsx would be dragged in.
  console.log(`${"─".repeat(64)}\n▶ unit tests (client/src, pure)\n${"─".repeat(64)}`);
  const rc = spawnSync("node", ["--test", "src/timetableView.test.js"], { cwd: join(root, "client"), stdio: "inherit", shell: false, env: { ...process.env } });
  results.push({ suite: "unit tests (client, pure)", status: rc.status === 0 ? "passed" : "failed", code: rc.status });
  console.log("");
```

- [ ] **Step 7: Verify the runner picks them up**

```bash
cd "c:/Users/Lenovo/Documents/Edtech" && DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- unit 2>&1 | grep -E "client, pure|passed|failed"
```

Expected: a line naming `unit tests (client, pure)` with `PASS`.

- [ ] **Step 8: Commit**

```bash
git add client/src/timetableView.js client/src/timetableView.test.js scripts/test.mjs
git commit -m "The timetable's arithmetic, in UTC and under test — the one client file that gets both"
```

---

## Task 3: The calendar grid

**Files:**
- Create: `client/src/TimetableCalendar.jsx`

**Interfaces:**
- Consumes: `./timetableView` (all exports), `./branding` (`NAVY`, `alpha`), `./PhoneShell` (`useIsHandset`), `lucide-react`.
- Produces: default export `TimetableCalendar({ events, settings, view, anchor, today, onSelectEvent, selectedId })`. **Presentational only — it fetches nothing and owns no data state.**

- [ ] **Step 1: Write the component**

Create `client/src/TimetableCalendar.jsx`:

```jsx
// The timetable grid itself — Day, Week, Month, Timeline and List.
//
// PRESENTATIONAL ONLY. It takes events and settings and draws them; it fetches
// nothing and owns no data. That is what lets the same component serve the staff
// screen and the administrator's planner without either growing a copy of the other's
// loading, error and refresh logic — and it is why the two containers can differ in
// everything except how a timetable looks.
import React, { useMemo } from "react";
import { CalendarDays, Clock3 } from "lucide-react";
import {
  windowFor, datesIn, isoDay, placeEvent, colourOf, annotationLines, changedWithin, minutes,
} from "./timetableView";
import { NAVY, alpha } from "./branding";
import { useIsHandset } from "./PhoneShell";

const DAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const dayLabel = (d) => {
  const dt = new Date(`${d}T00:00:00Z`);
  return `${DAY_SHORT[isoDay(d)]} ${dt.getUTCDate()} ${dt.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })}`;
};

/** One event, drawn as a coloured tile. Shared by every view so they cannot drift. */
function EventTile({ event, settings, today, onSelect, selected, style, compact }) {
  const colour = colourOf(event, settings.colourBy);
  const lines = annotationLines(event, settings.annotations);
  const recent = changedWithin(event, settings.highlightChangedDays, today);
  // "light" repaints the tile as a tint with dark text. On a dense week grid the
  // solid variant is a wall of colour that makes the text the hard part to read,
  // which is the whole reason the source system offers the choice.
  const light = settings.colourVariant === "light";
  return (
    <button
      type="button"
      onClick={() => onSelect?.(event)}
      style={{
        ...style,
        background: light ? alpha(colour, 14) : colour,
        color: light ? "#0f172a" : "#fff",
        borderLeft: `3px solid ${colour}`,
        // A changed event is ringed rather than recoloured: recolouring would fight
        // the colour key, which is answering a different question.
        boxShadow: recent ? "0 0 0 2px #f59e0b" : undefined,
      }}
      className={`overflow-hidden rounded-md px-1.5 py-1 text-left transition hover:brightness-110 ${selected ? "ring-2 ring-offset-1" : ""}`}
      title={`${event.title}${event.room ? ` · ${event.room}` : ""} · ${event.start}-${event.end}`}
    >
      {settings.showEventTimes && !compact && (
        <p className="text-[10px] font-semibold opacity-80">{event.start}–{event.end}</p>
      )}
      {lines.map((l, i) => (
        <p key={i} className={`truncate ${i === 0 ? "text-[11px] font-bold leading-tight" : "text-[10px] leading-tight opacity-85"}`}>{l}</p>
      ))}
      {settings.showEventId && <p className="truncate text-[9px] opacity-60">{event.id}</p>}
      {!event.published && <p className="text-[9px] font-bold uppercase tracking-wide opacity-90">Draft</p>}
    </button>
  );
}

function EmptyGrid({ msg }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white/60 py-16 text-center">
      <CalendarDays size={28} className="mb-2 text-slate-300" />
      <p className="text-sm font-semibold text-slate-500">{msg}</p>
    </div>
  );
}

/* ------------------------------------------------------- day / week grid -- */

function ColumnGrid({ dates, events, settings, today, onSelectEvent, selectedId }) {
  const periods = settings.periods || [];
  const byDate = useMemo(() => {
    const m = new Map();
    for (const e of events) { if (!m.has(e.date)) m.set(e.date, []); m.get(e.date).push(e); }
    return m;
  }, [events]);

  // A fixed pixel height per period, not a percentage of the viewport: an hour must
  // look like an hour whether the reader has four periods switched on or twelve.
  const ROW_H = 52;
  const bodyH = Math.max(periods.length * ROW_H, ROW_H);

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[640px]">
        {/* Day headers */}
        <div className="flex border-b border-slate-200">
          <div className="w-14 shrink-0" />
          {dates.map((d) => (
            <div key={d} className={`flex-1 px-2 py-1.5 text-center text-[11px] font-bold ${d === today ? "text-sky-600" : "text-slate-500"}`}>
              {dayLabel(d)}
            </div>
          ))}
        </div>
        <div className="flex" style={{ height: bodyH }}>
          {/* Hour gutter */}
          <div className="w-14 shrink-0">
            {periods.map((p) => (
              <div key={p.start} style={{ height: ROW_H }} className="border-b border-slate-100 pr-1 text-right text-[10px] font-semibold text-slate-400">
                {p.start}
              </div>
            ))}
          </div>
          {dates.map((d) => (
            <div key={d} className={`relative flex-1 border-l border-slate-200 ${d === today ? "bg-sky-50/60" : "bg-white"}`}>
              {periods.map((p) => <div key={p.start} style={{ height: ROW_H }} className="border-b border-slate-100" />)}
              {(byDate.get(d) || []).map((e) => {
                const pos = placeEvent(e, periods);
                // Null means the event falls entirely outside the periods this
                // reader has switched on. Not drawn, and not clamped to the edge —
                // see placeEvent.
                if (!pos) return null;
                return (
                  <EventTile
                    key={e.id} event={e} settings={settings} today={today}
                    onSelect={onSelectEvent} selected={selectedId === e.id}
                    style={{ position: "absolute", top: `${pos.topPct}%`, height: `${pos.heightPct}%`, left: 2, right: 2 }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ month view -- */

function MonthGrid({ dates, events, settings, today, onSelectEvent, selectedId, anchor }) {
  const month = anchor.slice(0, 7);
  const byDate = useMemo(() => {
    const m = new Map();
    for (const e of events) { if (!m.has(e.date)) m.set(e.date, []); m.get(e.date).push(e); }
    return m;
  }, [events]);
  const cols = new Set(dates.map(isoDay)).size || 7;

  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[640px] gap-px bg-slate-200" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` }}>
        {dates.map((d) => {
          const inMonth = d.slice(0, 7) === month;
          const list = byDate.get(d) || [];
          return (
            <div key={d} className={`min-h-[92px] p-1 ${inMonth ? "bg-white" : "bg-slate-50"} ${d === today ? "ring-2 ring-inset ring-sky-400" : ""}`}>
              {/* Days outside the anchored month are dimmed rather than blank — the
                  grid is whole weeks, and an empty cell reads as "no classes" when
                  it actually means "not this month". */}
              <p className={`mb-1 text-[10px] font-bold ${inMonth ? "text-slate-500" : "text-slate-300"}`}>
                {new Date(`${d}T00:00:00Z`).getUTCDate()}
              </p>
              <div className="space-y-0.5">
                {list.slice(0, 3).map((e) => (
                  <EventTile key={e.id} event={e} settings={settings} today={today} compact
                    onSelect={onSelectEvent} selected={selectedId === e.id} style={{ display: "block", width: "100%" }} />
                ))}
                {list.length > 3 && <p className="pl-1 text-[10px] font-semibold text-slate-400">+{list.length - 3} more</p>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* --------------------------------------------------------- timeline view -- */

function TimelineGrid({ dates, events, settings, today, onSelectEvent, selectedId }) {
  const periods = settings.periods || [];
  const gridStart = periods.length ? minutes(periods[0].start) : 0;
  const gridEnd = periods.length ? minutes(periods[periods.length - 1].end) : 1440;
  const span = Math.max(gridEnd - gridStart, 1);
  const DAY_W = 260;

  const byDate = useMemo(() => {
    const m = new Map();
    for (const e of events) { if (!m.has(e.date)) m.set(e.date, []); m.get(e.date).push(e); }
    return m;
  }, [events]);

  // Time runs left to right and each day is a band. This is the view for "when is
  // this room free across a fortnight", which the day columns answer badly.
  return (
    <div className="overflow-x-auto">
      <div style={{ minWidth: dates.length * DAY_W }}>
        {dates.map((d) => (
          <div key={d} className="flex items-stretch border-b border-slate-100">
            <div className={`w-28 shrink-0 px-2 py-2 text-[11px] font-bold ${d === today ? "text-sky-600" : "text-slate-500"}`}>{dayLabel(d)}</div>
            <div className="relative h-11 flex-1 bg-white">
              {(byDate.get(d) || []).map((e) => {
                const s = Math.max(minutes(e.start), gridStart), en = Math.min(minutes(e.end), gridEnd);
                if (en <= s) return null;
                return (
                  <EventTile key={e.id} event={e} settings={settings} today={today} compact
                    onSelect={onSelectEvent} selected={selectedId === e.id}
                    style={{ position: "absolute", top: 3, bottom: 3, left: `${((s - gridStart) / span) * 100}%`, width: `${((en - s) / span) * 100}%` }} />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- list view -- */

function ListView({ dates, events, settings, today, onSelectEvent, selectedId }) {
  const byDate = useMemo(() => {
    const m = new Map();
    for (const e of events) { if (!m.has(e.date)) m.set(e.date, []); m.get(e.date).push(e); }
    return m;
  }, [events]);
  const withAny = dates.filter((d) => (byDate.get(d) || []).length);
  if (!withAny.length) return <EmptyGrid msg="Nothing timetabled in this period." />;

  return (
    <div className="space-y-3">
      {withAny.map((d) => (
        <div key={d}>
          <p className={`mb-1 text-xs font-extrabold ${d === today ? "text-sky-600" : "text-slate-500"}`}>{dayLabel(d)}</p>
          <div className="space-y-1.5">
            {(byDate.get(d) || []).map((e) => (
              <button key={e.id} type="button" onClick={() => onSelectEvent?.(e)}
                className={`flex w-full items-stretch gap-2 overflow-hidden rounded-xl bg-white text-left shadow-sm ring-1 ring-slate-200 ${selectedId === e.id ? "ring-2" : ""}`}>
                <span className="w-1.5 shrink-0" style={{ background: colourOf(e, settings.colourBy) }} />
                <span className="flex-1 py-2 pr-2">
                  <span className="flex items-center gap-1 text-[11px] font-bold text-slate-400"><Clock3 size={11} /> {e.start}–{e.end}{e.room ? ` · ${e.room}` : ""}</span>
                  {annotationLines(e, settings.annotations).map((l, i) => (
                    <span key={i} className={`block truncate ${i === 0 ? "text-sm font-bold text-slate-800" : "text-xs text-slate-500"}`}>{l}</span>
                  ))}
                  {!e.published && <span className="text-[10px] font-bold uppercase tracking-wide text-amber-600">Draft</span>}
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ root -- */

export default function TimetableCalendar({ events = [], settings, view = "week", anchor, today, onSelectEvent, selectedId }) {
  const handset = useIsHandset();
  const { from, to } = useMemo(() => windowFor(view, anchor), [view, anchor]);
  const dates = useMemo(() => datesIn(from, to, settings?.days), [from, to, settings?.days]);

  if (!settings) return null;

  // ON A HANDSET, THE COLUMN GRIDS BECOME A LIST. Seven columns of hour rows at
  // 390px is unreadable — the tiles are narrower than a word — and the source
  // system's own mobile presentation does the same. The reader's chosen view is not
  // overwritten, only how it draws, so rotating to a tablet restores the grid.
  const effective = settings.layout === "list" || (handset && (view === "week" || view === "timeline")) ? "list" : view;

  if (!dates.length) return <EmptyGrid msg="No days are switched on in your settings." />;

  switch (effective) {
    case "list":     return <ListView dates={dates} events={events} settings={settings} today={today} onSelectEvent={onSelectEvent} selectedId={selectedId} />;
    case "month":    return <MonthGrid dates={dates} events={events} settings={settings} today={today} anchor={anchor} onSelectEvent={onSelectEvent} selectedId={selectedId} />;
    case "timeline": return <TimelineGrid dates={dates} events={events} settings={settings} today={today} onSelectEvent={onSelectEvent} selectedId={selectedId} />;
    default:         return <ColumnGrid dates={dates} events={events} settings={settings} today={today} onSelectEvent={onSelectEvent} selectedId={selectedId} />;
  }
}
```

- [ ] **Step 2: Build**

```bash
cd "c:/Users/Lenovo/Documents/Edtech" && npm run --workspace client build 2>&1 | tail -5
```

Expected: `✓ built in …`.

- [ ] **Step 3: Commit**

```bash
git add client/src/TimetableCalendar.jsx
git commit -m "One grid, five views, and no data of its own"
```

---

## Task 4: The "Select timetables" picker

**Files:**
- Create: `client/src/SelectTimetablesModal.jsx`

**Interfaces:**
- Consumes: `./api` (`api.myTimetableResources`), `./branding` (`NAVY`), `lucide-react`.
- Produces: default export `SelectTimetablesModal({ open, initialType, initialSelected, onApply, onClose })`. `onApply({ type, ids, labels })`; `onApply({ type: null, ids: [] })` on Reset, meaning "back to my own timetable".

- [ ] **Step 1: Write the component**

Create `client/src/SelectTimetablesModal.jsx`:

```jsx
// "Select timetables" — whose timetable am I looking at?
//
// Five types, matching the system this reproduces: module offerings, rooms, teaching
// staff, students and groups. Resetting means "my own", which is the default the
// server applies when no type is sent — there is no separate "my timetable" mode to
// get out of sync with this one.
//
// STUDENTS ARE BEHIND A SEARCH BOX AND THE SERVER ENFORCES IT. An empty student
// search returns nothing with `needsQuery: true`, rather than the first 25 of
// several thousand named people, because a picker you can scroll is a directory.
import React, { useEffect, useState, useCallback } from "react";
import { X, Search, PlusCircle, MinusCircle, RotateCcw, BookOpen, DoorOpen, User, GraduationCap, Users } from "lucide-react";
import { api } from "./api";
import { NAVY } from "./branding";

const TYPES = [
  { key: "module",  label: "Module Offerings", I: BookOpen,       placeholder: "Name and code…" },
  { key: "room",    label: "Rooms",            I: DoorOpen,       placeholder: "Name and campus…" },
  { key: "staff",   label: "Teaching Staff",   I: User,           placeholder: "Name…" },
  { key: "student", label: "Students",         I: GraduationCap,  placeholder: "Student reference or name…" },
  { key: "group",   label: "Groups",           I: Users,          placeholder: "Name…" },
];

export default function SelectTimetablesModal({ open, initialType, initialSelected = [], onApply, onClose }) {
  const [type, setType] = useState(initialType || "");
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [total, setTotal] = useState(0);
  const [needsQuery, setNeedsQuery] = useState(false);
  const [selected, setSelected] = useState(initialSelected);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Re-run when the type or the query changes. Debounced, because this searches
  // thousands of rows and a request per keystroke would both hammer the API and
  // deliver results out of order.
  useEffect(() => {
    if (!open || !type) { setResults([]); setTotal(0); setNeedsQuery(false); return; }
    let cancelled = false;
    setBusy(true); setErr("");
    const t = setTimeout(async () => {
      try {
        const r = await api.myTimetableResources(type, q, 25);
        if (cancelled) return;
        setResults(r.results || []); setTotal(r.total || 0); setNeedsQuery(!!r.needsQuery);
      } catch (e) {
        if (!cancelled) setErr(e?.message || "Could not search.");
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [open, type, q]);

  const add = useCallback((row) => setSelected((s) => (s.some((x) => x.id === row.id) ? s : [...s, row])), []);
  const drop = useCallback((id) => setSelected((s) => s.filter((x) => x.id !== id)), []);

  if (!open) return null;
  const meta = TYPES.find((t) => t.key === type);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-3">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 text-white" style={{ background: NAVY }}>
          <p className="text-base font-extrabold">Select timetables</p>
          <button onClick={onClose} aria-label="Close" className="rounded-full p-1.5 hover:bg-white/20"><X size={18} /></button>
        </div>

        <div className="flex flex-col gap-2 border-b border-slate-200 p-3 sm:flex-row">
          <select value={type} onChange={(e) => { setType(e.target.value); setQ(""); }}
            className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700 sm:w-56">
            <option value="">Choose Timetable Type</option>
            {TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} disabled={!type}
              placeholder={meta?.placeholder || "Choose a type first…"}
              className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm disabled:bg-slate-50" />
          </div>
        </div>

        <div className="grid flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 sm:grid-cols-2">
          <div>
            <p className="mb-2 border-b border-slate-200 pb-1 text-sm font-bold text-slate-600">Result <span className="font-normal text-slate-400">({total})</span></p>
            {err && <p className="text-xs font-semibold text-rose-600">{err}</p>}
            {!type && <p className="py-6 text-center text-xs text-slate-400">Choose a timetable type to search.</p>}
            {/* The server says WHY the list is empty. "Search for a student by name or
                reference" is a next step; a bare "no results" reads as "this college
                has no students". */}
            {type && needsQuery && <p className="py-6 text-center text-xs text-slate-400">Search for a student by name or reference.</p>}
            {type && !needsQuery && !busy && !results.length && <p className="py-6 text-center text-xs text-slate-400">No timetables match your search criteria.</p>}
            <div className="space-y-0.5">
              {results.map((r) => (
                <button key={r.id} type="button" onClick={() => add(r)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-slate-50">
                  <PlusCircle size={18} className="shrink-0 text-slate-400" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-slate-700">{r.label}</span>
                    {r.sub && <span className="block truncate text-[11px] text-slate-400">{r.sub}</span>}
                  </span>
                </button>
              ))}
            </div>
            {total > results.length && (
              <p className="pt-2 text-[11px] text-slate-400">Showing {results.length} of {total} — narrow your search to see the rest.</p>
            )}
          </div>

          <div>
            <p className="mb-2 border-b border-slate-200 pb-1 text-sm font-bold text-slate-600">Selected <span className="font-normal text-slate-400">({selected.length})</span></p>
            {!selected.length && <p className="py-6 text-center text-xs text-slate-400">There are no selected timetables.</p>}
            <div className="space-y-0.5">
              {selected.map((r) => (
                <button key={r.id} type="button" onClick={() => drop(r.id)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-rose-50">
                  <MinusCircle size={18} className="shrink-0 text-rose-400" />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-700">{r.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 p-3">
          {/* Reset means "back to my own timetable", not "clear the boxes" — that is
              what the server does with no type, so there is one meaning, not two. */}
          <button onClick={() => { setSelected([]); onApply?.({ type: null, ids: [], labels: [] }); }}
            className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-bold text-slate-500 hover:bg-slate-100">
            <RotateCcw size={15} /> Reset to my timetable
          </button>
          <button disabled={!selected.length}
            onClick={() => onApply?.({ type, ids: selected.map((s) => s.id), labels: selected })}
            className="rounded-lg px-4 py-2 text-sm font-bold text-white disabled:opacity-40" style={{ background: NAVY }}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build**

```bash
cd "c:/Users/Lenovo/Documents/Edtech" && npm run --workspace client build 2>&1 | tail -5
```

Expected: `✓ built in …`.

- [ ] **Step 3: Commit**

```bash
git add client/src/SelectTimetablesModal.jsx
git commit -m "Whose timetable am I looking at — five types, students behind a search box"
```

---

## Task 5: My Settings

**Files:**
- Create: `client/src/TimetableSettingsModal.jsx`

**Interfaces:**
- Consumes: `./branding` (`NAVY`), `lucide-react`.
- Produces: default export `TimetableSettingsModal({ open, settings, scope, onSave, onClose })`.
  - `scope` is `"me"` or `"college"`. `"me"` hides the notice banner tab section entirely — the server drops it from a user patch, and offering a control that is silently ignored is worse than not offering it.
  - `onSave(patch)` receives only changed keys.

- [ ] **Step 1: Write the component**

Create `client/src/TimetableSettingsModal.jsx`:

```jsx
// My Settings — the three tabs the source system offers, over the same merged blob
// the server resolves: platform defaults, then the college's, then this person's.
//
// `scope` decides which layer is being edited. At scope "me" the NOTICE BANNER IS NOT
// SHOWN AT ALL, because the server drops it from a user patch: it carries compliance
// wording and is an institutional statement. Offering a field that is silently
// discarded is worse than not offering it — the reader types, saves, and is told
// nothing.
import React, { useState } from "react";
import { X, ArrowUp, ArrowDown, Plus } from "lucide-react";
import { NAVY } from "./branding";

const DAYS = [[1, "Monday"], [2, "Tuesday"], [3, "Wednesday"], [4, "Thursday"], [5, "Friday"], [6, "Saturday"], [7, "Sunday"]];
const COLOUR_BY = [["category", "Event Category"], ["module", "Module Offering"], ["room", "Room"], ["group", "Group"], ["course", "Course Offering"]];
const ANNOTATIONS = [["title", "Event name"], ["unit", "Module Offering"], ["category", "Event Category"], ["room", "Room"], ["staff", "Teaching Staff"], ["group", "Group"], ["course", "Course Offering"], ["eventId", "Event ID"]];
const ALL_PERIODS = Array.from({ length: 15 }, (_, i) => {
  const h = 7 + i;
  return { start: `${String(h).padStart(2, "0")}:00`, end: `${String(h + 1).padStart(2, "0")}:00` };
});

function Check({ on, onChange, label }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 py-1 text-sm text-slate-700">
      <input type="checkbox" checked={!!on} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
      {label}
    </label>
  );
}

export default function TimetableSettingsModal({ open, settings, scope = "me", onSave, onClose }) {
  const [tab, setTab] = useState("calendar");
  const [draft, setDraft] = useState(settings || {});
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));

  if (!open) return null;
  const periods = draft.periods || [];
  const annotations = draft.annotations || [];
  const hasPeriod = (p) => periods.some((x) => x.start === p.start && x.end === p.end);

  const togglePeriod = (p, on) => {
    const next = on ? [...periods, p] : periods.filter((x) => !(x.start === p.start && x.end === p.end));
    // Sorted here as well as on the server, so the list a reader sees while editing
    // matches the one they get back after saving.
    set("periods", next.sort((a, b) => a.start.localeCompare(b.start)));
  };
  const moveAnnotation = (i, by) => {
    const next = [...annotations];
    const j = i + by;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    set("annotations", next);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-3">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 text-white" style={{ background: NAVY }}>
          <p className="text-base font-extrabold">{scope === "me" ? "My Settings" : "Timetable display — college defaults"}</p>
          <button onClick={onClose} aria-label="Close" className="rounded-full p-1.5 hover:bg-white/20"><X size={18} /></button>
        </div>

        <div className="flex gap-1 border-b border-slate-200 px-3 pt-2">
          {[["calendar", "Calendar view"], ["events", "Events"], ["annotations", "Annotations"]].map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`rounded-t-lg px-3 py-2 text-sm font-bold ${tab === k ? "border-b-2 text-slate-800" : "text-slate-400 hover:text-slate-600"}`}
              style={tab === k ? { borderColor: NAVY } : undefined}>{l}</button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {tab === "calendar" && (
            <div className="grid gap-6 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-sm font-bold text-slate-600">Periods</p>
                <p className="mb-2 text-[11px] text-slate-400">Hours to show on the grid. Switching one off hides that row entirely.</p>
                {ALL_PERIODS.map((p) => (
                  <Check key={p.start} on={hasPeriod(p)} onChange={(on) => togglePeriod(p, on)} label={`${p.start} – ${p.end}`} />
                ))}
              </div>
              <div>
                <p className="mb-1 text-sm font-bold text-slate-600">Days</p>
                <p className="mb-2 text-[11px] text-slate-400">Weekdays to show as columns.</p>
                {DAYS.map(([n, l]) => (
                  <Check key={n} on={(draft.days || []).includes(n)}
                    onChange={(on) => set("days", on ? [...(draft.days || []), n].sort((a, b) => a - b) : (draft.days || []).filter((d) => d !== n))}
                    label={l} />
                ))}
                <div className="mt-4 border-t border-slate-100 pt-3">
                  <Check on={draft.swapAxes} onChange={(v) => set("swapAxes", v)} label="Swap grid axes" />
                  <Check on={draft.showAvailability} onChange={(v) => set("showAvailability", v)} label="Show timetable availability on the event grid" />
                </div>
              </div>
            </div>
          )}

          {tab === "events" && (
            <div className="space-y-5">
              <div>
                <p className="mb-1 text-sm font-bold text-slate-600">Default view</p>
                <select value={draft.view || "week"} onChange={(e) => set("view", e.target.value)}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
                  {["day", "week", "month", "timeline"].map((v) => <option key={v} value={v}>{v[0].toUpperCase() + v.slice(1)}</option>)}
                </select>
              </div>
              <div>
                <p className="mb-1 text-sm font-bold text-slate-600">Event colour key</p>
                <p className="mb-2 text-[11px] text-slate-400">What colour should mean.</p>
                <select value={draft.colourBy || "category"} onChange={(e) => set("colourBy", e.target.value)}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
                  {COLOUR_BY.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
              <div>
                <p className="mb-1 text-sm font-bold text-slate-600">Event colour variant</p>
                {[["normal", "Normal"], ["light", "Light"]].map(([k, l]) => (
                  <label key={k} className="flex cursor-pointer items-center gap-2 py-1 text-sm text-slate-700">
                    <input type="radio" name="variant" checked={(draft.colourVariant || "normal") === k} onChange={() => set("colourVariant", k)} />
                    {l}
                  </label>
                ))}
              </div>
              {/* College scope only. See the file header: at "me" scope the server
                  drops this, so showing it would be a control that does nothing. */}
              {scope === "college" && (
                <div className="border-t border-slate-100 pt-4">
                  <p className="mb-1 text-sm font-bold text-slate-600">Notice banner</p>
                  <p className="mb-2 text-[11px] text-slate-400">Shown across the top of every timetable in this college. Staff cannot change it.</p>
                  <Check on={draft.notice?.enabled} onChange={(v) => set("notice", { ...(draft.notice || {}), enabled: v })} label="Show the notice" />
                  <textarea rows={4} value={draft.notice?.text || ""} onChange={(e) => set("notice", { ...(draft.notice || {}), text: e.target.value })}
                    className="mt-2 w-full rounded-lg border border-slate-300 p-2 text-sm" placeholder="e.g. attendance requirements for funding eligibility" />
                </div>
              )}
            </div>
          )}

          {tab === "annotations" && (
            <div className="grid gap-6 sm:grid-cols-2">
              <div>
                <Check on={draft.showEventTimes} onChange={(v) => set("showEventTimes", v)} label="Show event times on grid view" />
                <Check on={draft.showEventId} onChange={(v) => set("showEventId", v)} label="Show Event ID" />
                <div className="mt-3">
                  <p className="text-sm text-slate-700">Highlight recently changed events</p>
                  <p className="mb-1 text-[11px] text-slate-400">Days to look back. 0 switches the highlight off.</p>
                  <input type="number" min={0} max={90} value={draft.highlightChangedDays ?? 0}
                    onChange={(e) => set("highlightChangedDays", Number(e.target.value))}
                    className="w-24 rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
                </div>
              </div>
              <div>
                <p className="mb-1 text-sm font-bold text-slate-600">Event annotations</p>
                {/* The ORDER is the setting: it decides what a reader sees first when
                    a tile is too small for everything. */}
                <p className="mb-2 text-[11px] text-slate-400">What appears inside an event, top first.</p>
                <div className="space-y-1">
                  {annotations.map((a, i) => (
                    <div key={a} className="flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-1.5">
                      <span className="flex-1 text-sm font-semibold text-slate-700">{(ANNOTATIONS.find(([k]) => k === a) || [a, a])[1]}</span>
                      <button onClick={() => moveAnnotation(i, -1)} aria-label="Move up" className="rounded p-1 text-slate-400 hover:bg-white"><ArrowUp size={14} /></button>
                      <button onClick={() => moveAnnotation(i, 1)} aria-label="Move down" className="rounded p-1 text-slate-400 hover:bg-white"><ArrowDown size={14} /></button>
                      <button onClick={() => set("annotations", annotations.filter((x) => x !== a))} aria-label="Remove" className="rounded p-1 text-slate-400 hover:bg-white"><X size={14} /></button>
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {ANNOTATIONS.filter(([k]) => !annotations.includes(k)).map(([k, l]) => (
                    <button key={k} onClick={() => set("annotations", [...annotations, k])}
                      className="flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-500 hover:bg-slate-50">
                      <Plus size={12} /> {l}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 p-3">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-bold text-slate-500 hover:bg-slate-100">Cancel</button>
          <button disabled={saving}
            onClick={async () => { setSaving(true); try { await onSave?.(draft); } finally { setSaving(false); } }}
            className="rounded-lg px-4 py-2 text-sm font-bold text-white disabled:opacity-50" style={{ background: NAVY }}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build**

```bash
cd "c:/Users/Lenovo/Documents/Edtech" && npm run --workspace client build 2>&1 | tail -5
```

Expected: `✓ built in …`.

- [ ] **Step 3: Commit**

```bash
git add client/src/TimetableSettingsModal.jsx
git commit -m "My Settings, three tabs, and no banner field for someone who cannot set it"
```

---

## Task 6: The staff container

**Files:**
- Create: `client/src/MyTimetable.jsx`

**Interfaces:**
- Consumes: `./api`, `./TimetableCalendar`, `./SelectTimetablesModal`, `./TimetableSettingsModal`, `./timetableView` (`windowFor`, `shiftAnchor`, `RANGE_LABEL`), `./branding`, `lucide-react`.
- Produces: default export `MyTimetable()`. Takes no props — it is the whole screen.

- [ ] **Step 1: Write the component**

Create `client/src/MyTimetable.jsx`:

```jsx
// My Timetable — what a member of staff reads, on the website and in the phone app.
//
// ONE COMPONENT SERVES BOTH. StaffApp already renders through PhoneShell on a
// desktop and a handset alike, so there is no second implementation to keep in step;
// TimetableCalendar decides for itself when a grid should become a list.
//
// It calls /api/my-timetable, which needs no admin page. With no resource selected
// the server answers with THIS PERSON'S teaching, found by a join on their id — not
// a match on their name, which is the entire reason this module exists.
import React, { useCallback, useEffect, useState } from "react";
import {
  CalendarDays, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight,
  Settings as SettingsIcon, Search, Printer, Loader2, AlertTriangle, X, MapPin, Users, BookOpen, Clock3,
} from "lucide-react";
import { api } from "./api";
import TimetableCalendar from "./TimetableCalendar";
import SelectTimetablesModal from "./SelectTimetablesModal";
import TimetableSettingsModal from "./TimetableSettingsModal";
import { windowFor, shiftAnchor, RANGE_LABEL } from "./timetableView";
import { NAVY, alpha } from "./branding";

// The app's own idea of today, taken once per mount. Not recomputed on every render:
// a component that re-reads the clock mid-render can highlight two different days in
// one paint.
const todayISO = () => new Date().toISOString().slice(0, 10);

export default function MyTimetable() {
  const [today] = useState(todayISO);
  const [anchor, setAnchor] = useState(todayISO);
  const [view, setView] = useState("week");
  const [scope, setScope] = useState({ type: null, ids: [], labels: [] });
  const [events, setEvents] = useState([]);
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState("");
  const [picker, setPicker] = useState(false);
  const [prefs, setPrefs] = useState(false);
  const [selected, setSelected] = useState(null);
  const [noticeOpen, setNoticeOpen] = useState(true);

  const load = useCallback(async () => {
    setBusy(true); setErr("");
    try {
      const { from, to } = windowFor(view, anchor);
      const r = await api.myTimetable(from, to, scope.type, scope.ids);
      setEvents(r.events || []);
      setSettings(r.settings || null);
      // The saved default view applies on FIRST load only. Re-applying it on every
      // fetch would yank a reader out of Month the moment they pressed "next".
      setView((v) => (settings ? v : (r.settings?.view || v)));
    } catch (e) {
      setErr(e?.message || "Could not load your timetable.");
    } finally {
      setBusy(false);
    }
    // `settings` is deliberately not a dependency — it is written by this effect, and
    // including it would re-fetch on every settings change forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, anchor, scope.type, scope.ids]);

  useEffect(() => { load(); }, [load]);

  const saveSettings = async (patch) => {
    const r = await api.saveMyTimetableSettings(patch);
    setSettings(r.settings);
    setPrefs(false);
  };

  const { from, to } = windowFor(view, anchor);
  const scopeLabel = scope.type ? scope.labels.map((l) => l.label).join(", ") : "My timetable";

  return (
    <div className="p-3 sm:p-4">
      {/* Toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button onClick={() => setAnchor(today)} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50">Today</button>
        <div className="flex items-center gap-0.5">
          <button onClick={() => setAnchor((a) => shiftAnchor(view, a, -1, true))} aria-label="Jump back" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"><ChevronsLeft size={16} /></button>
          <button onClick={() => setAnchor((a) => shiftAnchor(view, a, -1))} aria-label="Previous" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"><ChevronLeft size={16} /></button>
          <p className="min-w-[150px] text-center text-sm font-extrabold text-slate-700">{RANGE_LABEL(view, from, to)}</p>
          <button onClick={() => setAnchor((a) => shiftAnchor(view, a, 1))} aria-label="Next" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"><ChevronRight size={16} /></button>
          <button onClick={() => setAnchor((a) => shiftAnchor(view, a, 1, true))} aria-label="Jump forward" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"><ChevronsRight size={16} /></button>
        </div>
        <select value={view} onChange={(e) => setView(e.target.value)}
          className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-bold text-slate-600">
          {["day", "week", "month", "timeline"].map((v) => <option key={v} value={v}>{v[0].toUpperCase() + v.slice(1)}</option>)}
        </select>
        {/* Jump to a date. The source system puts a small month calendar in a left
            sidebar; a native date field does the same job in one control, works with
            a thumb on a phone where a 7x6 grid of tap targets does not, and brings
            the platform's own picker with it. The sidebar calendar is recorded as a
            gap rather than half-built. */}
        <input type="date" value={anchor} onChange={(e) => e.target.value && setAnchor(e.target.value)}
          aria-label="Jump to date" className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-bold text-slate-600" />
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => setPicker(true)} className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50"><Search size={14} /> Select timetables</button>
          {/* Print is the browser's own, which is all the source system's Print menu
              item does. Share is NOT offered: it would need a server-side shareable
              link, and a button that copies a URL only the signed-in reader can open
              is worse than no button. */}
          <button onClick={() => window.print()} aria-label="Print" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><Printer size={16} /></button>
          <button onClick={() => setPrefs(true)} aria-label="My settings" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><SettingsIcon size={16} /></button>
        </div>
      </div>

      {/* Whose timetable, when it is not the reader's own. Stated plainly, because a
          grid of somebody else's classes is indistinguishable from your own. */}
      {scope.type && (
        <div className="mb-2 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 ring-1 ring-amber-200">
          <CalendarDays size={14} /> Viewing: {scopeLabel}
          <button onClick={() => setScope({ type: null, ids: [], labels: [] })} className="ml-auto rounded px-2 py-0.5 font-bold hover:bg-amber-100">Back to mine</button>
        </div>
      )}

      {settings?.notice?.enabled && settings.notice.text && noticeOpen && (
        <div className="mb-3 flex items-start gap-2 rounded-xl bg-white p-3 text-[13px] leading-relaxed text-slate-600 shadow-sm ring-1 ring-slate-200">
          <p className="flex-1 whitespace-pre-wrap">{settings.notice.text}</p>
          <button onClick={() => setNoticeOpen(false)} aria-label="Hide notice" className="rounded p-1 text-slate-400 hover:bg-slate-100"><X size={14} /></button>
        </div>
      )}

      {err && (
        <div className="mb-3 flex items-center gap-2 rounded-xl bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700 ring-1 ring-rose-200">
          <AlertTriangle size={16} /> {err}
          <button onClick={load} className="ml-auto rounded px-2 py-0.5 text-xs font-bold hover:bg-rose-100">Retry</button>
        </div>
      )}

      {busy && !settings ? (
        <div className="flex justify-center py-20 text-slate-400"><Loader2 size={22} className="animate-spin" /></div>
      ) : (
        <TimetableCalendar
          events={events} settings={settings} view={view} anchor={anchor} today={today}
          onSelectEvent={setSelected} selectedId={selected?.id}
        />
      )}

      {/* Event detail. A panel rather than a tooltip: a tile is too small for the
          room, the group and the staff at once, and a lecturer checking where to be
          needs all three. */}
      {selected && (
        <div className="fixed inset-x-0 bottom-0 z-40 rounded-t-2xl bg-white p-4 shadow-2xl ring-1 ring-slate-200 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-80 sm:rounded-2xl">
          <div className="mb-2 flex items-start justify-between gap-2">
            <p className="text-base font-extrabold text-slate-800">{selected.title}</p>
            <button onClick={() => setSelected(null)} aria-label="Close" className="rounded-full p-1 text-slate-400 hover:bg-slate-100"><X size={16} /></button>
          </div>
          <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-500"><Clock3 size={14} /> {selected.date} · {selected.start}–{selected.end}</p>
          {selected.room && <p className="flex items-center gap-1.5 py-0.5 text-sm text-slate-600"><MapPin size={14} className="text-slate-400" /> {selected.room}</p>}
          {selected.unitCode && <p className="flex items-center gap-1.5 py-0.5 text-sm text-slate-600"><BookOpen size={14} className="text-slate-400" /> {selected.unitCode}{selected.unitName ? ` — ${selected.unitName}` : ""}</p>}
          {!!selected.staff?.length && <p className="flex items-center gap-1.5 py-0.5 text-sm text-slate-600"><Users size={14} className="text-slate-400" /> {selected.staff.map((s) => s.name).join(", ")}</p>}
          {!!selected.groups?.length && <p className="flex items-center gap-1.5 py-0.5 text-sm text-slate-600"><Users size={14} className="text-slate-400" /> {selected.groups.map((g) => g.name).join(", ")}</p>}
          {selected.notes && <p className="mt-2 whitespace-pre-wrap rounded-lg bg-slate-50 p-2 text-xs text-slate-600">{selected.notes}</p>}
          {selected.category && <p className="mt-2 inline-block rounded-full px-2 py-0.5 text-[11px] font-bold" style={{ background: alpha(selected.categoryColour || NAVY, 14), color: selected.categoryColour || NAVY }}>{selected.category}</p>}
        </div>
      )}

      <SelectTimetablesModal
        open={picker} initialType={scope.type} initialSelected={scope.labels}
        onClose={() => setPicker(false)}
        onApply={(s) => { setScope({ type: s.type, ids: s.ids, labels: s.labels || [] }); setPicker(false); }}
      />
      {settings && (
        <TimetableSettingsModal open={prefs} settings={settings} scope="me" onClose={() => setPrefs(false)} onSave={saveSettings} />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Build**

```bash
cd "c:/Users/Lenovo/Documents/Edtech" && npm run --workspace client build 2>&1 | tail -5
```

Expected: `✓ built in …`.

- [ ] **Step 3: Commit**

```bash
git add client/src/MyTimetable.jsx
git commit -m "My Timetable — one screen for the website and the phone, because PhoneShell already serves both"
```

---

## Task 7: Wire it into the staff app

**Files:**
- Modify: `client/src/StaffHub.jsx`

**Interfaces:**
- Consumes: `./MyTimetable`.
- Produces: a `"timetable"` screen in `StaffApp`, a tile in `TILES`, a header title, and a push-notification link key.

- [ ] **Step 1: Import the component**

Near the other local imports at the top of `client/src/StaffHub.jsx` (beside `import AdminNfcTags from "./AdminNfcTags";`):

```js
import MyTimetable from "./MyTimetable";
```

- [ ] **Step 2: Add the tile**

In the `TILES` array, insert **second** — directly after the `checkin` entry. A lecturer opens this app to answer "where am I meant to be", and that question is asked more often than any other on the list:

```js
  { key: "timetable", label: "My Timetable", Icon: CalendarDays, sub: "Where you're teaching" },
```

`CalendarDays` must be added to the `lucide-react` import at the top of the file if it is not already there. Check first — `Calendar` is imported, which is a different icon.

- [ ] **Step 3: Add the screen**

In `StaffApp`'s screen list, beside `{screen === "checkin" && <CheckInScreen store={store} me={me} />}`:

```jsx
      {screen === "timetable" && <MyTimetable />}
```

- [ ] **Step 4: Add the header title and the push link**

In `AppHeader`, add `timetable: "My Timetable",` to the `title` map.

In the `useEffect` that handles `push:open`, add `"timetable"` to the `KNOWN` array, so a notification about a moved class can open this screen rather than dropping the reader on Home.

- [ ] **Step 5: Verify all four edits landed, then build**

```bash
cd "c:/Users/Lenovo/Documents/Edtech" && node -e "
const s = require('fs').readFileSync('client/src/StaffHub.jsx','utf8');
const checks = [
  ['import',  /import MyTimetable from ".\/MyTimetable";/],
  ['tile',    /key: \"timetable\", label: \"My Timetable\"/],
  ['screen',  /screen === \"timetable\" && <MyTimetable/],
  ['title',   /timetable: \"My Timetable\"/],
  ['push',    /KNOWN = \[[^\]]*\"timetable\"/],
];
let ok = true;
for (const [n, re] of checks) { const hit = re.test(s); if (!hit) ok = false; console.log((hit?'PASS  ':'FAIL  ')+n); }
process.exit(ok?0:1);"
npm run --workspace client build 2>&1 | tail -5
```

Expected: five `PASS` lines, then `✓ built in …`.

- [ ] **Step 6: Commit**

```bash
git add client/src/StaffHub.jsx
git commit -m "My Timetable becomes the second tile, because 'where am I meant to be' is the question"
```

---

## Task 8: The planner — rooms and categories

**Files:**
- Create: `client/src/AdminTimetablePlanner.jsx`

**Interfaces:**
- Consumes: `./api`, `./branding`, `lucide-react`.
- Produces: default export `AdminTimetablePlanner()` with a three-tab shell (`Calendar` / `Rooms` / `Categories`) where the Calendar tab is a placeholder this task does not fill — Task 9 fills it.

- [ ] **Step 1: Write the component**

Create `client/src/AdminTimetablePlanner.jsx`:

```jsx
// Scheduling — the planner half. An administrator places an event and ASSIGNS a
// room, staff and groups to it, from dropdowns backed by real foreign keys.
//
// This is a different page from "Timetable", which still serves the older weekly
// TimetableSlot screen and the student timetable. They are deliberately not merged:
// that one is scoped to a course/year/term and has free-text lecturer and room, and
// folding this into it would mean one screen where half the fields are relations and
// half are strings.
import React, { useCallback, useEffect, useState } from "react";
import {
  DoorOpen, Tag, CalendarDays, Plus, Trash2, Loader2, AlertTriangle, X, Check,
} from "lucide-react";
import { api } from "./api";
import { NAVY, alpha } from "./branding";

function Field({ label, children, hint }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] font-bold uppercase tracking-wide text-slate-400">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-[11px] text-slate-400">{hint}</span>}
    </label>
  );
}
const inputCls = "w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm";

/* ------------------------------------------------------------------ rooms -- */

function RoomsTab() {
  const [rooms, setRooms] = useState([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState("");
  const [draft, setDraft] = useState({ name: "", floor: "", campus: "", capacity: "", kind: "" });

  const load = useCallback(async () => {
    setBusy(true); setErr("");
    try { setRooms(await api.ttRooms()); }
    catch (e) { setErr(e?.message || "Could not load rooms."); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setErr("");
    try {
      await api.ttCreateRoom(draft);
      setDraft({ name: "", floor: "", campus: "", capacity: "", kind: "" });
      load();
    } catch (e) {
      // 409 is the duplicate case and it is worth saying precisely, because the
      // constraint is (name, campus): the same room number on another campus is
      // allowed, and an administrator hitting this needs to know that.
      setErr(e?.message?.includes("already exists") ? "That room already exists on that campus. The same number on a different campus is fine." : (e?.message || "Could not add the room."));
    }
  };

  const remove = async (r) => {
    setErr("");
    try {
      const res = await api.ttDeleteRoom(r.id);
      // Deleting a room does NOT delete the classes that were in it — the events
      // survive with no room. Saying so is the difference between an administrator
      // fixing them and never knowing.
      if (res?.eventsLeftWithoutARoom > 0) setErr(`Room deleted. ${res.eventsLeftWithoutARoom} event(s) now have no room and need one.`);
      load();
    } catch (e) { setErr(e?.message || "Could not delete the room."); }
  };

  return (
    <div>
      {err && <div className="mb-3 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800 ring-1 ring-amber-200"><AlertTriangle size={15} /> {err}</div>}
      <div className="mb-4 grid gap-2 rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200 sm:grid-cols-6">
        <Field label="Name"><input className={inputCls} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="101" /></Field>
        <Field label="Floor"><input className={inputCls} value={draft.floor} onChange={(e) => setDraft({ ...draft, floor: e.target.value })} placeholder="First floor" /></Field>
        <Field label="Campus"><input className={inputCls} value={draft.campus} onChange={(e) => setDraft({ ...draft, campus: e.target.value })} placeholder="Harrow" /></Field>
        <Field label="Seats" hint="Blank = not recorded"><input className={inputCls} type="number" min={0} value={draft.capacity} onChange={(e) => setDraft({ ...draft, capacity: e.target.value })} /></Field>
        <Field label="Kind"><input className={inputCls} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })} placeholder="Lecture" /></Field>
        <div className="flex items-end">
          <button onClick={create} disabled={!draft.name.trim()} className="flex w-full items-center justify-center gap-1 rounded-lg py-2 text-sm font-bold text-white disabled:opacity-40" style={{ background: NAVY }}><Plus size={15} /> Add</button>
        </div>
      </div>

      {busy ? <div className="flex justify-center py-10 text-slate-400"><Loader2 className="animate-spin" size={20} /></div> : (
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-slate-200 text-left text-[11px] font-bold uppercase tracking-wide text-slate-400">
              <th className="px-3 py-2">Room</th><th className="px-3 py-2">Campus</th><th className="px-3 py-2">Seats</th><th className="px-3 py-2">Kind</th><th className="px-3 py-2" />
            </tr></thead>
            <tbody>
              {!rooms.length && <tr><td colSpan={5} className="px-3 py-8 text-center text-slate-400">No rooms yet. Add the first one above.</td></tr>}
              {rooms.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-2 font-semibold text-slate-700">{r.label}</td>
                  <td className="px-3 py-2 text-slate-500">{r.campus || "—"}</td>
                  {/* Null prints as an em dash, never as 0 — "not recorded" and
                      "seats nobody" are different facts. */}
                  <td className="px-3 py-2 text-slate-500">{r.capacity ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-500">{r.kind || "—"}</td>
                  <td className="px-3 py-2 text-right"><button onClick={() => remove(r)} aria-label={`Delete ${r.label}`} className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 size={15} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- categories -- */

function CategoriesTab() {
  const [cats, setCats] = useState([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState("");
  const [draft, setDraft] = useState({ name: "", colour: "#1a3a8f" });

  const load = useCallback(async () => {
    setBusy(true); setErr("");
    try { setCats(await api.ttCategories()); }
    catch (e) { setErr(e?.message || "Could not load categories."); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      {err && <div className="mb-3 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800 ring-1 ring-amber-200"><AlertTriangle size={15} /> {err}</div>}
      <p className="mb-3 text-xs text-slate-500">Categories are what an event <em>is</em> — Lecture, Seminar, Exam. The colour is used when a reader colours their timetable by category.</p>
      <div className="mb-4 flex flex-wrap items-end gap-2 rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
        <Field label="Name"><input className={inputCls} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Lecture" /></Field>
        <Field label="Colour"><input type="color" className="h-9 w-16 rounded border border-slate-300" value={draft.colour} onChange={(e) => setDraft({ ...draft, colour: e.target.value })} /></Field>
        <button
          onClick={async () => { setErr(""); try { await api.ttCreateCategory(draft); setDraft({ name: "", colour: "#1a3a8f" }); load(); } catch (e) { setErr(e?.message || "Could not add."); } }}
          disabled={!draft.name.trim()} className="flex items-center gap-1 rounded-lg px-4 py-2 text-sm font-bold text-white disabled:opacity-40" style={{ background: NAVY }}><Plus size={15} /> Add</button>
      </div>

      {busy ? <div className="flex justify-center py-10 text-slate-400"><Loader2 className="animate-spin" size={20} /></div> : (
        <div className="flex flex-wrap gap-2">
          {!cats.length && <p className="py-8 text-center text-sm text-slate-400">No categories yet.</p>}
          {cats.map((c) => (
            <span key={c.id} className="flex items-center gap-2 rounded-full py-1.5 pl-3 pr-1.5 text-sm font-bold" style={{ background: alpha(c.colour, 14), color: c.colour }}>
              {c.name}
              <button onClick={async () => { try { const r = await api.ttDeleteCategory(c.id); if (r?.eventsLeftWithoutACategory > 0) setErr(`Deleted. ${r.eventsLeftWithoutACategory} event(s) now have no category.`); load(); } catch (e) { setErr(e?.message || "Could not delete."); } }}
                aria-label={`Delete ${c.name}`} className="rounded-full p-1 hover:bg-white/60"><X size={13} /></button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- root -- */

export default function AdminTimetablePlanner() {
  const [tab, setTab] = useState("calendar");
  const TABS = [["calendar", "Calendar", CalendarDays], ["rooms", "Rooms", DoorOpen], ["categories", "Categories", Tag]];
  return (
    <div>
      <div className="mb-4 flex gap-1 border-b border-slate-200">
        {TABS.map(([k, l, I]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm font-bold ${tab === k ? "border-b-2 text-slate-800" : "text-slate-400 hover:text-slate-600"}`}
            style={tab === k ? { borderColor: NAVY } : undefined}>
            <I size={15} /> {l}
          </button>
        ))}
      </div>
      {/* Filled by Task 9. Left explicit rather than blank so a half-finished build
          says so instead of looking like a broken tab. */}
      {tab === "calendar" && <PlannerCalendarTab />}
      {tab === "rooms" && <RoomsTab />}
      {tab === "categories" && <CategoriesTab />}
    </div>
  );
}

function PlannerCalendarTab() {
  return <p className="py-10 text-center text-sm text-slate-400">The event planner lands in the next change.</p>;
}
```

- [ ] **Step 2: Build**

```bash
cd "c:/Users/Lenovo/Documents/Edtech" && npm run --workspace client build 2>&1 | tail -5
```

Expected: `✓ built in …`.

- [ ] **Step 3: Commit**

```bash
git add client/src/AdminTimetablePlanner.jsx
git commit -m "Rooms and categories get a screen, and a deleted room says what it left behind"
```

---

## Task 9: The planner — event editor, clashes, publish

**Files:**
- Modify: `client/src/AdminTimetablePlanner.jsx` (replace `PlannerCalendarTab`)
- Modify: `client/src/StaffHub.jsx` (admin tab entry, render line, import)

**Interfaces:**
- Consumes: Task 8's file; `./TimetableCalendar`; `./TimetableSettingsModal`; `./timetableView` (`windowFor`, `shiftAnchor`, `RANGE_LABEL`); `api.ttEvents/ttCreateEvent/ttUpdateEvent/ttDeleteEvent/ttRepeatEvent/ttPublish/ttSettings/ttSaveSettings`; `api.hndCourses`-style lookups for units and cohorts (**verify the existing method names in `api.js` before using them** — do not invent).
- Produces: the working planner tab and the `"scheduling"` admin page.

- [ ] **Step 1: Confirm the lookups (already verified — this step is a re-check, not a search)**

The event editor offers units, cohorts and staff. **These come from the `store` that `StaffHub` already loads, not from new API calls** — verified against `client/src/StaffHub.jsx`, which uses `store.units` (48 times), `store.staff` (52), `store.cohorts` (11) and `store.courses` (28). Add no endpoint.

```bash
cd "c:/Users/Lenovo/Documents/Edtech/client/src" && node -e "
const s=require('fs').readFileSync('StaffHub.jsx','utf8');
for (const k of ['store.units','store.staff','store.cohorts','store.courses']) console.log((s.includes(k)?'PASS  ':'FAIL  ')+k);"
```

Expected: four `PASS` lines. Label a cohort the way the rest of the file already does — `${course.name} — ${cohort.name}`, falling back to the cohort name when the course is missing — because a bare intake label like "SEP 2025" repeats across every course in the college.

- [ ] **Step 2: Replace `PlannerCalendarTab`**

Replace the placeholder in `client/src/AdminTimetablePlanner.jsx` with the following, and add the imports it needs at the top of the file (`TimetableCalendar`, `TimetableSettingsModal`, `windowFor`, `shiftAnchor`, `RANGE_LABEL`, and the extra lucide icons `ChevronLeft`, `ChevronRight`, `Send`, `Repeat`, `Settings as SettingsIcon`).

```jsx
function PlannerCalendarTab({ staff = [], units = [], cohorts = [] }) {
  const [today] = useState(() => new Date().toISOString().slice(0, 10));
  const [anchor, setAnchor] = useState(today);
  const [view, setView] = useState("week");
  const [events, setEvents] = useState([]);
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState("");
  const [warnings, setWarnings] = useState([]);
  const [editing, setEditing] = useState(null);   // the event being edited, or a blank draft
  const [prefs, setPrefs] = useState(false);
  const [rooms, setRooms] = useState([]);
  const [cats, setCats] = useState([]);

  const { from, to } = windowFor(view, anchor);

  const load = useCallback(async () => {
    setBusy(true); setErr("");
    try {
      // Drafts included, deliberately: an administrator building next term must see
      // what they are building. That is the difference between this screen and the
      // staff one, which is published-only.
      const [ev, st, rm, ct] = await Promise.all([api.ttEvents({ from, to }), api.ttSettings(), api.ttRooms(), api.ttCategories()]);
      setEvents(ev || []);
      // The planner draws with the COLLEGE's settings merged over the defaults, not
      // with this administrator's personal ones — they are laying out a timetable
      // other people will read, and their own hidden weekend would hide events they
      // had scheduled on it.
      setSettings({ ...st.defaults, ...st.tenant });
      setRooms(rm || []); setCats(ct || []);
    } catch (e) { setErr(e?.message || "Could not load the timetable."); }
    finally { setBusy(false); }
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  const blank = () => ({ date: anchor, start: "09:00", end: "10:00", title: "", notes: "", roomId: "", categoryId: "", unitId: "", staffIds: [], cohortIds: [], published: false });

  const save = async () => {
    setErr(""); setWarnings([]);
    try {
      const body = { ...editing, staffIds: editing.staffIds || [], cohortIds: editing.cohortIds || [] };
      const r = editing.id ? await api.ttUpdateEvent(editing.id, body) : await api.ttCreateEvent(body);
      // A CLASH IS A WARNING, NOT A FAILURE. The server saved it. Closing the editor
      // and showing the warnings above the grid is the honest reading; refusing to
      // close would imply the save had not happened.
      setWarnings(r.warnings || []);
      setEditing(null);
      load();
    } catch (e) { setErr(e?.message || "Could not save the event."); }
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button onClick={() => setAnchor(today)} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50">Today</button>
        <button onClick={() => setAnchor((a) => shiftAnchor(view, a, -1))} aria-label="Previous" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"><ChevronLeft size={16} /></button>
        <p className="min-w-[150px] text-center text-sm font-extrabold text-slate-700">{RANGE_LABEL(view, from, to)}</p>
        <button onClick={() => setAnchor((a) => shiftAnchor(view, a, 1))} aria-label="Next" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"><ChevronRight size={16} /></button>
        <select value={view} onChange={(e) => setView(e.target.value)} className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-bold text-slate-600">
          {["day", "week", "month", "timeline"].map((v) => <option key={v} value={v}>{v[0].toUpperCase() + v.slice(1)}</option>)}
        </select>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => setEditing(blank())} className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold text-white" style={{ background: NAVY }}><Plus size={14} /> New event</button>
          <button onClick={async () => { if (!confirm(`Publish every event from ${from} to ${to}? Staff will see them immediately.`)) return; const r = await api.ttPublish({ from, to, published: true }); setErr(`${r.updated} event(s) published.`); load(); }}
            className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50"><Send size={14} /> Publish this period</button>
          <button onClick={() => setPrefs(true)} aria-label="Display settings" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><SettingsIcon size={16} /></button>
        </div>
      </div>

      {err && <div className="mb-3 rounded-lg bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700">{err}</div>}

      {/* Clash warnings sit ABOVE the grid and stay until the next save. They are the
          only thing on this screen that reports a decision the administrator may want
          to undo, and burying them in a toast that vanishes would be the same as not
          showing them. */}
      {!!warnings.length && (
        <div className="mb-3 rounded-xl bg-amber-50 p-3 ring-1 ring-amber-200">
          <p className="mb-1 flex items-center gap-1.5 text-sm font-extrabold text-amber-800"><AlertTriangle size={15} /> Saved, but this clashes</p>
          <ul className="space-y-0.5 text-xs text-amber-800">
            {warnings.map((w, i) => (
              <li key={i}>
                {w.date ? `${w.date}: ` : ""}
                {(w.clashes || [w]).map((c, j) => <span key={j}>{c.kind === "room" ? "Room" : c.kind === "staff" ? "Staff" : "Group"} <b>{c.resource}</b> is already on “{c.event?.title}” {c.event?.start}–{c.event?.end}{j < (w.clashes || [w]).length - 1 ? "; " : ""}</span>)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {busy && !settings ? <div className="flex justify-center py-16 text-slate-400"><Loader2 className="animate-spin" size={20} /></div> : (
        <TimetableCalendar events={events} settings={settings} view={view} anchor={anchor} today={today} onSelectEvent={setEditing} selectedId={editing?.id} />
      )}

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-3">
          <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between px-4 py-3 text-white" style={{ background: NAVY }}>
              <p className="text-base font-extrabold">{editing.id ? "Edit event" : "New event"}</p>
              <button onClick={() => setEditing(null)} aria-label="Close" className="rounded-full p-1.5 hover:bg-white/20"><X size={18} /></button>
            </div>
            <div className="grid flex-1 gap-3 overflow-y-auto p-4 sm:grid-cols-2">
              <Field label="Title"><input className={inputCls} value={editing.title || ""} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></Field>
              <Field label="Date"><input type="date" className={inputCls} value={editing.date || ""} onChange={(e) => setEditing({ ...editing, date: e.target.value })} /></Field>
              <Field label="Start"><input type="time" className={inputCls} value={editing.start || ""} onChange={(e) => setEditing({ ...editing, start: e.target.value })} /></Field>
              <Field label="End"><input type="time" className={inputCls} value={editing.end || ""} onChange={(e) => setEditing({ ...editing, end: e.target.value })} /></Field>
              <Field label="Room"><select className={inputCls} value={editing.roomId || ""} onChange={(e) => setEditing({ ...editing, roomId: e.target.value })}>
                <option value="">No room</option>{rooms.filter((r) => r.active).map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select></Field>
              <Field label="Category"><select className={inputCls} value={editing.categoryId || ""} onChange={(e) => setEditing({ ...editing, categoryId: e.target.value })}>
                <option value="">No category</option>{cats.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></Field>
              {/* Nullable on purpose. An exam, a workshop or a staff meeting belongs
                  to no module, which is the whole reason this table is not HndSession. */}
              <Field label="Module" hint="Optional — exams and meetings have none"><select className={inputCls} value={editing.unitId || ""} onChange={(e) => setEditing({ ...editing, unitId: e.target.value })}>
                <option value="">No module</option>{units.map((u) => <option key={u.id} value={u.id}>{u.code ? `${u.code} — ` : ""}{u.name}</option>)}
              </select></Field>
              <Field label="Teaching staff" hint="Ctrl/Cmd-click for more than one">
                <select multiple size={4} className={inputCls} value={editing.staffIds || []}
                  onChange={(e) => setEditing({ ...editing, staffIds: [...e.target.selectedOptions].map((o) => o.value) })}>
                  {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </Field>
              <Field label="Groups" hint="Ctrl/Cmd-click for more than one">
                <select multiple size={4} className={inputCls} value={editing.cohortIds || []}
                  onChange={(e) => setEditing({ ...editing, cohortIds: [...e.target.selectedOptions].map((o) => o.value) })}>
                  {cohorts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
              <div className="sm:col-span-2">
                <Field label="Notes"><textarea rows={2} className={inputCls} value={editing.notes || ""} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} /></Field>
              </div>
              <label className="flex items-center gap-2 text-sm font-semibold text-slate-600 sm:col-span-2">
                <input type="checkbox" checked={!!editing.published} onChange={(e) => setEditing({ ...editing, published: e.target.checked })} className="h-4 w-4 rounded border-slate-300" />
                Published — visible to staff
              </label>
            </div>
            <div className="flex items-center gap-2 border-t border-slate-200 p-3">
              {editing.id && (
                <>
                  <button onClick={async () => { const until = prompt("Repeat weekly until (YYYY-MM-DD)?"); if (!until) return; const r = await api.ttRepeatEvent(editing.id, { until }); setWarnings(r.warnings || []); setErr(`${r.created} weekly copies created.`); setEditing(null); load(); }}
                    className="flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50"><Repeat size={14} /> Repeat weekly</button>
                  <button onClick={async () => { if (!confirm("Delete this event?")) return; await api.ttDeleteEvent(editing.id); setEditing(null); load(); }}
                    className="flex items-center gap-1 rounded-lg px-3 py-2 text-sm font-bold text-rose-600 hover:bg-rose-50"><Trash2 size={14} /> Delete</button>
                </>
              )}
              <button onClick={() => setEditing(null)} className="ml-auto rounded-lg px-4 py-2 text-sm font-bold text-slate-500 hover:bg-slate-100">Cancel</button>
              <button onClick={save} disabled={!editing.title?.trim() || !editing.date} className="flex items-center gap-1 rounded-lg px-4 py-2 text-sm font-bold text-white disabled:opacity-40" style={{ background: NAVY }}><Check size={15} /> Save</button>
            </div>
          </div>
        </div>
      )}

      {settings && (
        <TimetableSettingsModal open={prefs} settings={settings} scope="college" onClose={() => setPrefs(false)}
          onSave={async (patch) => { const r = await api.ttSaveSettings(patch); setSettings((s) => ({ ...s, ...r.tenant })); setPrefs(false); }} />
      )}
    </div>
  );
}
```

Then thread the lists through from the root component:

```jsx
export default function AdminTimetablePlanner({ store }) {
  // ...
  {tab === "calendar" && <PlannerCalendarTab staff={store?.staff || []} units={store?.units || []} cohorts={store?.cohorts || []} />}
```

**Verify `store.cohorts` exists** before relying on it:

```bash
cd "c:/Users/Lenovo/Documents/Edtech/client/src" && grep -n "cohorts" StaffHub.jsx | head -5
```

If it does not, load cohorts inside the tab with whatever `api.js` method exists for them, or drop the Groups field and say so in the commit message rather than inventing an endpoint.

- [ ] **Step 3: Wire the admin page into `StaffHub.jsx`**

Import beside the other admin page imports:

```js
import AdminTimetablePlanner from "./AdminTimetablePlanner";
```

Add the tab entry, directly after the existing `{ key: "timetable", label: "Timetable", I: CalendarClock },` line:

```js
    { key: "scheduling", label: "Scheduling", I: CalendarDays },
```

Add the render line, beside `{activeKey === "timetable" && <AdminTimetable store={store} />}`:

```jsx
        {activeKey === "scheduling" && <AdminTimetablePlanner store={store} />}
```

`"scheduling"` is already in both `ADMIN_PAGES` copies (Plan 1, Task 7), so no change is needed there.

- [ ] **Step 4: Verify the wiring and build**

```bash
cd "c:/Users/Lenovo/Documents/Edtech" && node -e "
const s = require('fs').readFileSync('client/src/StaffHub.jsx','utf8');
const checks = [
  ['import',  /import AdminTimetablePlanner from ".\/AdminTimetablePlanner";/],
  ['tab',     /key: \"scheduling\", label: \"Scheduling\"/],
  ['render',  /activeKey === \"scheduling\" && <AdminTimetablePlanner/],
];
let ok = true;
for (const [n, re] of checks) { const hit = re.test(s); if (!hit) ok = false; console.log((hit?'PASS  ':'FAIL  ')+n); }
process.exit(ok?0:1);"
npm run --workspace client build 2>&1 | tail -5
```

Expected: three `PASS` lines, then `✓ built in …`.

- [ ] **Step 5: Run the whole suite, to prove the server half still passes**

The client cannot break the server, but `scripts/test.mjs` was edited in Task 2 and that can.

```bash
cd "c:/Users/Lenovo/Documents/Edtech" && DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test 2>&1 | tail -12
```

Expected: the same set as before plus `unit tests (client, pure)`, 0 failed.

- [ ] **Step 6: Commit**

```bash
git add client/src/AdminTimetablePlanner.jsx client/src/StaffHub.jsx
git commit -m "Place an event, assign a room and a person to it, and be told what it clashes with"
```

---

## Done when

- [ ] `node --test client/src/timetableView.test.js` passes, and its two deliberate breaks were run and seen to fail.
- [ ] `DATABASE_URL=…edtech_dev npm test` passes, now including `unit tests (client, pure)`.
- [ ] `npm run --workspace client build` succeeds.
- [ ] A staff account sees **My Timetable** as the second tile, and it draws.
- [ ] An account granted **Scheduling** can add a room, add a category, place an event with a room and a member of staff, see a clash warning, and publish.
- [ ] `git status` is clean.

## Known gaps, recorded rather than forgotten

- **No client test framework**, so everything except `timetableView.js` is verified by building. `StaffHub.jsx` is ~14k lines and has never had one.
- **`showAvailability` and `swapAxes` are stored and offered but not yet drawn.** They round-trip through settings; the grid ignores them. Better than dropping the controls, which would lose a college's saved choice.
- **No iCal feed and no change notifications**, both of which the source system has. `changedAt` is stored and the highlight works, so the data for notifications exists.
- **No drag-and-drop.** An event is moved by editing its date and time. Worth adding once the shape is proven; it is not what makes the feature usable.
- **No left sidebar mini-month calendar.** The screenshots have one; a native `<input type="date">` does the same job in the toolbar and is usable with a thumb, which a 7x6 grid of tap targets is not. The sidebar version is cosmetic and can follow.
- **Share is not offered, only Print.** Sharing needs a server-side link anyone can open; copying a URL that only the signed-in reader can load would look like it worked and would not.
