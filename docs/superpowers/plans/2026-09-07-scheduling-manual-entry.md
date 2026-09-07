# Scheduling, manual entry: school, sessions, and several modules at once

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An administrator picks a school and a group once, then adds every module that
group is taught — each with its own lecturer, room, days, dates and one or two daily
sessions — and saves the lot in one pass.

**Architecture:** Two sessions become **two events on the same date sharing a seriesId**,
not one event holding two time ranges. `TimetableEvent` already *is* one dated block with
a start and an end, and a register is already created per event per group, so sessions
cost no schema change and produce their registers for free. Multi-module is likewise
form-shaped: the client loops the existing create endpoint once per module block and
reports the combined result.

**Tech Stack:** Node 24, Express, Prisma 5, PostgreSQL, React 18, `node --test`.

**Source:** the owner's handwritten notes of 7 September 2026 (pages 1 and 3), plus the
three decisions taken in conversation:
school = existing `AcademicDepartment`; lecturers disambiguated by department; school
filters the pickers with a "show all" escape.

**Spec:** `docs/superpowers/specs/2026-09-07-timetabling-registers-design.md` (§8 is the
entry form this extends)

## Global Constraints

- **Never let `DATABASE_URL` fall through to `server/.env`** — it points at a live
  database. Pass it explicitly:
  `DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev"`
- **Unit tests use the glob**, never a bare directory: `node --test "src/**/*.test.js"`.
- **Serialise through allowlists, never blocklists.**
- **Dates are `YYYY-MM-DD`, times `HH:MM`, compared as strings.** Arithmetic in UTC.
- **Comments explain WHY, including why an alternative was rejected.**
- **Push to `origin`**; pin the commit SHA, because another session commits to this tree.
- Prove every regression test can fail before trusting it.

## What is already true (do not rebuild)

- Date range + weekday buttons + series creation — shipped, `seriesDates()`.
- Searchable module / lecturer / room / group pickers — shipped, `SearchOne`/`SearchMany`.
- Registers created per event per group — shipped, `registers.js`.
- `TimetableEvent.academicDepartmentId` **already exists as a column** and nothing sets it.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/src/timetabling/sessions.js` | Pure. Validate and normalise 1–2 session time ranges. |
| `server/src/routes/timetabling.js` | `GET /departments`; `POST /events` accepts `sessions[]` and `academicDepartmentId`. |
| `client/src/AdminTimetablePlanner.jsx` | School picker, session controls, module blocks, filtered pickers. |
| `client/src/api.js` | `ttDepartments()`. |
| `scripts/smoke-timetable-registers.mjs` | Sessions produce two events and two registers; school is stored. |

---

### Task 1: Session validation (pure)

**Files:**
- Create: `server/src/timetabling/sessions.js`
- Test: `server/src/timetabling/sessions.test.js`

**Interfaces:**
- Produces: `parseSessions(body) → { sessions: Array<{start,end}> } | { error: string }`

- [ ] **Step 1: Write the failing test**

```js
const { test } = require("node:test");
const assert = require("node:assert");
const { parseSessions } = require("./sessions");

test("no sessions falls back to the single start/end pair", () => {
  const r = parseSessions({ start: "09:00", end: "12:00" });
  assert.deepEqual(r.sessions, [{ start: "09:00", end: "12:00" }]);
});

test("two sessions come back in order", () => {
  const r = parseSessions({ sessions: [{ start: "13:00", end: "16:00" }, { start: "09:00", end: "12:00" }] });
  assert.deepEqual(r.sessions, [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "16:00" }]);
});

test("a session ending before it starts is refused", () => {
  assert.match(parseSessions({ sessions: [{ start: "12:00", end: "09:00" }] }).error, /after the start/i);
});

test("OVERLAPPING SESSIONS ARE REFUSED", () => {
  // Two blocks on one day that overlap are one block entered twice, and they would
  // produce two registers covering the same hour for the same students.
  assert.match(parseSessions({ sessions: [{ start: "09:00", end: "13:00" }, { start: "12:00", end: "15:00" }] }).error, /overlap/i);
});

test("back-to-back sessions are allowed", () => {
  // 09:00-12:00 then 12:00-15:00 is a normal teaching day, not a clash. Same half-open
  // rule overlap.js already uses for rooms.
  const r = parseSessions({ sessions: [{ start: "09:00", end: "12:00" }, { start: "12:00", end: "15:00" }] });
  assert.equal(r.sessions.length, 2);
});

test("more than two sessions is refused", () => {
  const three = [{ start: "09:00", end: "10:00" }, { start: "11:00", end: "12:00" }, { start: "13:00", end: "14:00" }];
  assert.match(parseSessions({ sessions: three }).error, /at most two/i);
});

test("a malformed time is refused rather than stored", () => {
  assert.match(parseSessions({ sessions: [{ start: "9am", end: "12:00" }] }).error, /HH:MM/);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd server && node --test src/timetabling/sessions.test.js
```
Expected: FAIL, `Cannot find module './sessions'`.

- [ ] **Step 3: Implement**

```js
// One teaching day is one or two blocks, each with its own hours.
//
// TWO SESSIONS BECOME TWO EVENTS, not one event holding two ranges — see the plan and
// the comment in routes/timetabling.js. This module only validates the pair; it does
// not know what the caller will do with them.
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function parseSessions(body) {
  const raw = Array.isArray(body?.sessions) && body.sessions.length
    ? body.sessions
    : [{ start: body?.start, end: body?.end }];

  if (raw.length > 2) return { error: "A day may have at most two sessions." };

  const out = [];
  for (const s of raw) {
    const start = typeof s?.start === "string" ? s.start.trim() : "";
    const end = typeof s?.end === "string" ? s.end.trim() : "";
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) return { error: "Session times must be HH:MM" };
    if (end <= start) return { error: "A session's end must be after the start" };
    out.push({ start, end });
  }
  out.sort((a, b) => a.start.localeCompare(b.start));

  // HALF-OPEN, so back-to-back is fine and a genuine overlap is not — the same rule
  // overlap.js applies to rooms. Two overlapping blocks on one day are one block
  // entered twice, and they would produce two registers covering the same hour for the
  // same students, which doubles that hour in every attendance denominator.
  if (out.length === 2 && out[0].end > out[1].start) {
    return { error: "The two sessions overlap. Back-to-back is fine; overlapping is not." };
  }
  return { sessions: out };
}

module.exports = { parseSessions, TIME_RE };
```

- [ ] **Step 4: Run and confirm PASS**

- [ ] **Step 5: Prove the overlap test can fail**

Change `out[0].end > out[1].start` to `false`, re-run, confirm "OVERLAPPING SESSIONS ARE
REFUSED" goes red, then restore.

- [ ] **Step 6: Commit**

```bash
git add server/src/timetabling/sessions.js server/src/timetabling/sessions.test.js
git commit -m "A teaching day is one or two blocks, and they may not overlap"
```

---

### Task 2: Departments the planner can read

**Files:**
- Modify: `server/src/routes/timetabling.js`, `client/src/api.js`

**Interfaces:**
- Produces: `GET /api/timetabling/departments` → `[{ id, name, colour }]`; `api.ttDepartments()`

Two routes, and the second is create-only for a reason recorded below.

- [ ] **Step 1: Add the route**

```js
// The school list, readable by the SCHEDULING page.
//
// /api/academic-departments already lists these, but it is gated on "settings" — and a
// timetabler is exactly the person who has scheduling and not settings. Without this
// they would get a 403 and an empty School picker on the screen they are meant to use.
//
// Names and colours only. Department MEMBERSHIP — which staff and which students are in
// one — is an access-control boundary and stays on the settings route.
router.get("/departments", async (_req, res) => {
  const rows = await prisma.academicDepartment.findMany({
    where: { active: true }, orderBy: { name: "asc" },
    select: { id: true, name: true, colour: true },
  });
  res.json(rows);
});
```

- [ ] **Step 1b: Add `POST /api/timetabling/departments` — CREATE ONLY.**

The owner asked to add a school from the planner, "like rooms and groups". So one
endpoint that makes one school, and nothing else.

**Not a reuse of `PUT /api/academic-departments`, and this is the important part.** That
route replaces the WHOLE LIST and retires by omission: anything absent from the
submission is switched off. Called from a planner that only knows about the schools it
has loaded, it would retire the college's entire organisation chart and return 200. Its
own source carries a long comment about exactly this hazard. No update and no delete
here either — `AcademicDepartment` is an access-control boundary and its real editor
stays on Settings.

`key` is `@unique` and lower-case-hyphenated, so derive it from the name; a name that
already exists (case-insensitively) is a 409 naming it, not a near-duplicate row.

- [ ] **Step 2: Add the client methods**, beside `ttCampuses`:

```js
  ttDepartments: () => request("/timetabling/departments"),
  ttCreateDepartment: (d) => request("/timetabling/departments", { method: "POST", body: d }),
```

- [ ] **Step 3: Verify it is gated**

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4010/api/timetabling/departments
```
Expected: `401`.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/timetabling.js client/src/api.js
git commit -m "The planner can read the school list without holding Settings"
```

---

### Task 3: Events accept sessions and a school

**Files:**
- Modify: `server/src/routes/timetabling.js` (`parseEvent`, `POST /events`)

- [ ] **Step 1: Let `parseEvent` carry the school**

Add `academicDepartmentId` to the nullable-relations loop that already handles
`unitId`, `courseId`, `roomId`, `categoryId`:

```js
  for (const [key, field] of [["unitId", "unitId"], ["courseId", "courseId"], ["roomId", "roomId"], ["categoryId", "categoryId"], ["academicDepartmentId", "academicDepartmentId"]]) {
```

The column already exists and nothing set it before now.

- [ ] **Step 2: Expand sessions in `POST /events`**

After `parseEvent` succeeds and before the date expansion, call `parseSessions(req.body)`
and 400 on its error. Then, **for each session**, run the existing series creation — so a
2-session, 3-day, 12-week module writes 72 events under **one** `seriesId`.

```js
  const { sessions, error: sErr } = parseSessions(req.body);
  if (sErr) return res.status(400).json({ error: sErr });
```

The per-date loop becomes a loop over `sessions × dates`, with
`{ ...data, date, startTime: s.start, endTime: s.end, seriesId }`.

- [ ] **Step 3: Report per session**

`created` counts every event written. Add `sessionsPerDay: sessions.length` so the
screen can say "24 days × 2 sessions" rather than an unexplained 48.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/timetabling.js
git commit -m "Two sessions are two events on one date, under one series"
```

---

### Task 4: Smoke assertions

**Files:**
- Modify: `scripts/smoke-timetable-registers.mjs`

- [ ] **Step 1: Add**, after the existing series block:

1. Two sessions on a one-day range create **two** events, same date, different times.
2. Both carry the **same `seriesId`**.
3. Publishing them creates **two registers** for one group — one per session.
4. Overlapping sessions are refused with 400.
5. Three sessions are refused with 400.
6. `academicDepartmentId` sent on create is **stored** and comes back on read.

- [ ] **Step 2: Run**

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" TEST_PORT=4010 npm test -- smoke-timetable-registers
```

- [ ] **Step 3: Prove assertion 3 can fail** by making the session loop create only the
first session; confirm it goes red; restore.

- [ ] **Step 4: Commit**

---

### Task 5: The form — school, sessions, module blocks

**Files:**
- Modify: `client/src/AdminTimetablePlanner.jsx`

- [ ] **Step 0: A "Schools" tab**, built exactly like `CampusesTab`: the list, plus a name
      box and an Add button.

      No delete and no rename, because the endpoint is create-only (Task 2, Step 1b). Say
      so in one short line on screen rather than showing buttons that refuse.

- [ ] **Step 1: School picker at the TOP of the event modal, ABOVE the Title.**

      The owner's words: *"despite of title it should say school which I need to choose"*
      — so School is the first field a person meets, not one buried among the rest. From
      `api.ttDepartments()`, stored on the event as `academicDepartmentId`.

- [ ] **Step 2: Filter the pickers by school, with an escape.**

Units and cohorts do **not** carry a department of their own, but both carry `courseId`,
and `store.courses` carries `academicDepartmentId` — so the filter is
`unit → course → department`, computed client-side with no server change.

A **"show all"** toggle sits beside the school. Strict filtering would make a genuinely
shared class impossible to enter and people would pick the wrong school to get round it.

Staff are **not** filtered: `sStaff` only carries `academicDepartmentIds` when the
relation is included, and lecturers routinely teach across schools. They get their
department as the row subtitle instead — which is what the duplicate-name question asked
for, and `SearchMany` already renders a `sub`.

- [ ] **Step 3: Session control.** Radio: `1 session` / `2 sessions`. One time pair, or
      two. Sent as `sessions: [{start,end}, …]`.

- [ ] **Step 4: Module blocks.** School and group(s) sit **above** the blocks; each block
      holds module, lecturer(s), room, category, days, start/end date and sessions.
      `+ Add another module` appends one; each is removable.

- [ ] **Step 5: The preview counts everything before the button.**

> 3 modules · 2 sessions · 12 weeks · 1 group = **72 classes, 72 registers**

- [ ] **Step 6: Save loops the endpoint once per block** and reports the combined result,
      naming any block that failed rather than a single "could not save".

- [ ] **Step 7: Build and verify the strings ship**

```bash
npm run --workspace client build
grep -c "Add another module" client/dist/assets/$(ls -S client/dist/assets/index-*.js | head -1 | xargs basename)
```

- [ ] **Step 8: Commit**

---

## Self-Review

**Coverage of the notes.** Page 1/3 (i) school → Tasks 2, 3, 5. (ii) start+end date →
already shipped. (iii)(iv)(v) searchable group/module/lecturer → already shipped;
lecturer disambiguation → Task 5 step 2. (vi) 1 or 2 sessions → Tasks 1, 3, 5. Page 4
"two or more modules in one go" → Task 5 step 4. Page 5 "registers per session" →
Task 3, asserted in Task 4.

**Deliberately not in this plan:** the file import and its review step (the owner chose
manual first), the lecturer-facing published search, and the student app fields. Each is
its own plan and each writes into the structures this one settles.

**Type consistency.** `parseSessions(body)` returns `{ sessions }` or `{ error }` in
Tasks 1, 3 identically. `sessions: [{start, end}]` is the wire shape in Tasks 3, 4, 5.
`academicDepartmentId` is the field name in the schema, the route and the client.
