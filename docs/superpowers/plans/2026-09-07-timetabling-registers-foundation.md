# Timetabling → Registers, Phase 1: Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a published timetable event create its attendance registers — one per
group — with the real date, times and room, and never rewrite a register that has
already been marked.

**Architecture:** Three pure modules decide *what should happen* (roster derivation,
register action, campus name matching) and one database module *applies* it. Pure
modules get unit tests with no database; the applier gets an HTTP smoke suite. The
uniqueness guarantee that stops duplicate registers moves from a single Prisma
`@@unique` to two Postgres partial indexes, because merged classes legitimately need
two registers for one module at one time.

**Tech Stack:** Node 24, Express, Prisma 5, PostgreSQL, `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-07-timetabling-registers-design.md`

## Global Constraints

- **Never let `DATABASE_URL` fall through to `server/.env`** — it points at a live
  database. Every command below passes it explicitly:
  `DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev"`
- **Never rename a migration directory once applied anywhere.** Naming is
  `YYYYMMDDTHHMMSS_snake_case`.
- **Unit tests use the glob**, never a bare directory:
  `node --test "src/**/*.test.js"`. A bare directory walks into `src/index.js`, binds a
  port, starts the schedulers and never terminates.
- **Serialise through allowlists, never blocklists.**
- **Null means "not measurable"; zero means zero.** New numeric columns are nullable.
- **Dates are `YYYY-MM-DD` strings, times `HH:MM`, compared as strings.** All date
  arithmetic in UTC.
- **Comments explain WHY, at length, including why an alternative was rejected.** This
  is the house style and it is load-bearing.
- **Push to the `edtech` remote, not `origin`.**
- Prove every regression test can fail before trusting it.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/src/timetabling/roster.js` | Pure. Given cohort members, enrolled members and whether the unit has any enrolments, return who is on the register and which rule produced them. |
| `server/src/timetabling/registerRules.js` | Pure. Given an event and the state of its register, decide create / update / freeze / skip, with a reason. |
| `server/src/timetabling/campusMatch.js` | Pure. Normalise free-text campus strings and group them into distinct campuses. |
| `server/src/timetabling/registers.js` | Database. Applies the decisions above inside one transaction. |
| `server/src/routes/timetabling.js` | Gains campus CRUD and calls `registers.js` on publish. |
| `server/src/timetabling/serialize.js` | Gains `sCampus`; `sRoom` gains `campusId`. |
| `server/prisma/schema.prisma` | `Campus` model; new columns on `Room`, `TimetableEvent`, `HndSession`. |
| `server/prisma/migrations/20260907T120000_timetabling_registers/migration.sql` | Schema change, campus backfill, and the two partial indexes. |
| `scripts/smoke-timetable-registers.mjs` | The negative assertions: freeze, delete, merged classes, unitless events. |

---

### Task 1: Campus name matching (pure)

**Files:**
- Create: `server/src/timetabling/campusMatch.js`
- Test: `server/src/timetabling/campusMatch.test.js`

**Interfaces:**
- Produces: `normaliseCampus(s) → string`, `groupCampuses(names: string[]) → Array<{ canonical: string, variants: string[] }>`

- [ ] **Step 1: Write the failing test**

```js
const { test } = require("node:test");
const assert = require("node:assert");
const { normaliseCampus, groupCampuses } = require("./campusMatch");

test("normalise folds case and collapses whitespace", () => {
  assert.equal(normaliseCampus("  Ealing   Campus "), "ealing campus");
  assert.equal(normaliseCampus("EALING"), "ealing");
});

test("empty and whitespace-only names normalise to empty", () => {
  assert.equal(normaliseCampus(""), "");
  assert.equal(normaliseCampus("   "), "");
  assert.equal(normaliseCampus(null), "");
});

test("variants group under the most common spelling", () => {
  const g = groupCampuses(["Ealing", "ealing", "Ealing", "Harrow"]);
  assert.equal(g.length, 2);
  const ealing = g.find((x) => x.canonical === "Ealing");
  assert.ok(ealing, "the 3x spelling wins as canonical");
  assert.deepEqual(ealing.variants.sort(), ["Ealing", "ealing"]);
});

test("blank names produce no campus at all", () => {
  // A room with no campus recorded must not manufacture a campus called "".
  assert.deepEqual(groupCampuses(["", "  ", null]), []);
});

test("ties break alphabetically so the result is deterministic", () => {
  const g = groupCampuses(["beta", "Beta"]);
  assert.equal(g.length, 1);
  assert.equal(g[0].canonical, "Beta");
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd server && node --test src/timetabling/campusMatch.test.js
```
Expected: FAIL, `Cannot find module './campusMatch'`.

- [ ] **Step 3: Implement**

```js
// Matching the free-text campus strings on Room into a managed list.
//
// EXACT AND CASE-INSENSITIVE ONLY, deliberately. A fuzzy match that decides "Ealing"
// and "Ealing Annexe" are the same place merges two campuses in a filter that a head
// of department will later use to count students, and the merge is invisible
// afterwards. Anything this cannot group stays its own campus and a human decides.
const normaliseCampus = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Group spellings of the same campus. The canonical form is the most common spelling,
 * ties broken alphabetically so two runs over the same data agree — a migration that
 * picks a different winner on a re-run is one nobody can verify.
 */
function groupCampuses(names) {
  const byKey = new Map();
  for (const raw of names) {
    const key = normaliseCampus(raw);
    if (!key) continue; // no campus recorded is not a campus called ""
    const seen = byKey.get(key) || new Map();
    const spelling = String(raw).trim().replace(/\s+/g, " ");
    seen.set(spelling, (seen.get(spelling) || 0) + 1);
    byKey.set(key, seen);
  }
  return [...byKey.values()].map((counts) => {
    const variants = [...counts.keys()];
    const canonical = variants.slice().sort((a, b) => (counts.get(b) - counts.get(a)) || a.localeCompare(b))[0];
    return { canonical, variants };
  });
}

module.exports = { normaliseCampus, groupCampuses };
```

- [ ] **Step 4: Run and confirm PASS**

```bash
cd server && node --test src/timetabling/campusMatch.test.js
```

- [ ] **Step 5: Commit**

```bash
git add server/src/timetabling/campusMatch.js server/src/timetabling/campusMatch.test.js
git commit -m "Group campus spellings without guessing which are the same place"
```

---

### Task 2: Roster derivation (pure)

**Files:**
- Create: `server/src/timetabling/roster.js`
- Test: `server/src/timetabling/roster.test.js`

**Interfaces:**
- Produces: `deriveRoster({ cohortStudentIds, enrolledStudentIds, unitHasEnrolments }) → { studentIds: string[], rule: "cohort-and-enrolment" | "cohort-only" }`

- [ ] **Step 1: Write the failing test**

```js
const { test } = require("node:test");
const assert = require("node:assert");
const { deriveRoster } = require("./roster");

test("the roster is the intersection of cohort and enrolment", () => {
  const r = deriveRoster({
    cohortStudentIds: ["a", "b", "c"],
    enrolledStudentIds: ["b", "c", "d"],
    unitHasEnrolments: true,
  });
  assert.deepEqual(r.studentIds, ["b", "c"]);
  assert.equal(r.rule, "cohort-and-enrolment");
});

test("a unit with NO enrolment data at all falls back to the whole cohort", () => {
  // Moodle has not synced, or the module was added by hand. An empty register here
  // would look exactly like a class nobody joined.
  const r = deriveRoster({
    cohortStudentIds: ["a", "b"],
    enrolledStudentIds: [],
    unitHasEnrolments: false,
  });
  assert.deepEqual(r.studentIds, ["a", "b"]);
  assert.equal(r.rule, "cohort-only");
});

test("a unit that HAS enrolments but none in this cohort yields an empty roster", () => {
  // This is the case the fallback must NOT swallow: enrolment data exists and says
  // nobody in this group takes this module. That is an answer, not missing data.
  const r = deriveRoster({
    cohortStudentIds: ["a"],
    enrolledStudentIds: ["z"],
    unitHasEnrolments: true,
  });
  assert.deepEqual(r.studentIds, []);
  assert.equal(r.rule, "cohort-and-enrolment");
});

test("order follows the cohort and duplicates collapse", () => {
  const r = deriveRoster({
    cohortStudentIds: ["c", "a", "a"],
    enrolledStudentIds: ["a", "c"],
    unitHasEnrolments: true,
  });
  assert.deepEqual(r.studentIds, ["c", "a"]);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd server && node --test src/timetabling/roster.test.js
```
Expected: FAIL, `Cannot find module './roster'`.

- [ ] **Step 3: Implement**

```js
// Who is on a register.
//
// The intersection of "in this group" and "enrolled on this module", because a merged
// class keeps separate registers per group and enrolment alone would put both groups
// on both registers.
//
// THE FALLBACK IS THE INTERESTING HALF. `unitHasEnrolments` is a question about the
// UNIT, asked once, unfiltered by student — not "did anyone in this cohort enrol",
// which is a different question with the same shape and the wrong answer. A unit with
// no enrolment rows anywhere means Moodle has not synced or somebody added the module
// by hand; falling back to the cohort is right there. A unit that HAS enrolments and
// none of them in this group is data, and must produce an empty register rather than
// silently widening to everybody.
function deriveRoster({ cohortStudentIds = [], enrolledStudentIds = [], unitHasEnrolments = false }) {
  const cohort = [...new Set(cohortStudentIds)];
  if (!unitHasEnrolments) return { studentIds: cohort, rule: "cohort-only" };
  const enrolled = new Set(enrolledStudentIds);
  return { studentIds: cohort.filter((id) => enrolled.has(id)), rule: "cohort-and-enrolment" };
}

module.exports = { deriveRoster };
```

- [ ] **Step 4: Run and confirm PASS**

- [ ] **Step 5: Commit**

```bash
git add server/src/timetabling/roster.js server/src/timetabling/roster.test.js
git commit -m "A register's roster, and the one question that must not be asked per student"
```

---

### Task 3: Register action rules (pure)

**Files:**
- Create: `server/src/timetabling/registerRules.js`
- Test: `server/src/timetabling/registerRules.test.js`

**Interfaces:**
- Produces: `registerAction({ published, createRegisters, unitId, existing, event }) → { action: "create"|"update"|"skip"|"freeze", reason: string }` where `existing` is `null` or `{ id, hasMarks, date, startTime, endTime, roomId }`.

- [ ] **Step 1: Write the failing test**

```js
const { test } = require("node:test");
const assert = require("node:assert");
const { registerAction } = require("./registerRules");

const event = { date: "2026-09-15", startTime: "09:00", endTime: "15:00", roomId: "r1" };
const base = { published: true, createRegisters: true, unitId: "u1", existing: null, event };

test("a published unit-bearing event with no register creates one", () => {
  assert.equal(registerAction(base).action, "create");
});

test("an unpublished event creates nothing", () => {
  assert.equal(registerAction({ ...base, published: false }).action, "skip");
});

test("an event with the register option off creates nothing", () => {
  assert.equal(registerAction({ ...base, createRegisters: false }).action, "skip");
});

test("an event with no unit cannot have a register, and says so", () => {
  const r = registerAction({ ...base, unitId: null });
  assert.equal(r.action, "skip");
  assert.match(r.reason, /not a taught session/i);
});

test("an unmarked register follows the event when the event moves", () => {
  const existing = { id: "s1", hasMarks: false, date: "2026-09-15", startTime: "10:00", endTime: "13:00", roomId: null };
  assert.equal(registerAction({ ...base, existing }).action, "update");
});

test("an unmarked register that already matches needs no write", () => {
  const existing = { id: "s1", hasMarks: false, ...event };
  assert.equal(registerAction({ ...base, existing }).action, "skip");
});

test("A MARKED REGISTER IS NEVER MOVED", () => {
  // The rule the whole feature turns on. Editing a calendar entry must not rewrite
  // attendance evidence.
  const existing = { id: "s1", hasMarks: true, date: "2026-09-15", startTime: "10:00", endTime: "13:00", roomId: null };
  const r = registerAction({ ...base, existing });
  assert.equal(r.action, "freeze");
  assert.match(r.reason, /already been taken/i);
});

test("a marked register that still matches the event is not reported as diverged", () => {
  const existing = { id: "s1", hasMarks: true, ...event };
  assert.equal(registerAction({ ...base, existing }).action, "skip");
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd server && node --test src/timetabling/registerRules.test.js
```

- [ ] **Step 3: Implement**

```js
// What publishing an event should do to its register.
//
// Pure on purpose: this is the rule set most likely to be widened later by somebody
// building a screen, and a rule that lives in a route is a rule nobody can test in
// isolation.
const FIELDS = ["date", "startTime", "endTime", "roomId"];

const matches = (existing, event) => FIELDS.every((f) => (existing[f] ?? null) === (event[f] ?? null));

function registerAction({ published, createRegisters, unitId, existing, event }) {
  if (!unitId) {
    // HndSession.unitId is NOT NULL and TimetableEvent.unitId is nullable on purpose —
    // an exam, a workshop or a staff meeting belongs to no module. These structurally
    // cannot have registers, and the screen must SAY so rather than skip in silence.
    return { action: "skip", reason: "No register — not a taught session." };
  }
  if (!published) return { action: "skip", reason: "Draft events do not create registers." };
  if (!createRegisters) return { action: "skip", reason: "Register creation is switched off for this class." };
  if (!existing) return { action: "create", reason: "" };
  if (matches(existing, event)) return { action: "skip", reason: "" };

  if (existing.hasMarks) {
    // FROZEN, NOT FOLLOWED. Attendance is the record this college is asked to evidence
    // most often, and a design where editing a calendar entry silently rewrites a taken
    // register is one that eventually loses a dispute. Reporting the divergence is
    // louder than either following it or hiding it.
    return { action: "freeze", reason: "This register has already been taken — its times no longer match the timetable." };
  }
  return { action: "update", reason: "" };
}

module.exports = { registerAction, FIELDS };
```

- [ ] **Step 4: Run and confirm PASS**

- [ ] **Step 5: Prove the freeze test can fail**

Temporarily change `if (existing.hasMarks)` to `if (false)`, re-run, confirm the
"A MARKED REGISTER IS NEVER MOVED" test FAILS, then restore.

- [ ] **Step 6: Commit**

```bash
git add server/src/timetabling/registerRules.js server/src/timetabling/registerRules.test.js
git commit -m "A register freezes the moment it carries a mark"
```

---

### Task 4: Schema and migration

**Files:**
- Modify: `server/prisma/schema.prisma`
- Create: `server/prisma/migrations/20260907T120000_timetabling_registers/migration.sql`

**Interfaces:**
- Produces: `Campus` model; `Room.campusId`; `TimetableEvent.seriesId | createRegisters | publishedAt`; `HndSession.timetableEventId | cohortId | roomId`; partial indexes `HndSession_generated_key` and `HndSession_event_group_key`.

- [ ] **Step 1: Add the `Campus` model and `Room.campusId`**

```prisma
// The college's campuses, as a managed list rather than free text on each room.
//
// Room.campus was a plain string, so "Ealing", "ealing" and "Ealing Campus" were three
// campuses to any filter built on it — and the register dashboard filters by campus.
// A dropdown backed by rows cannot be misspelled; a text box silently splits a
// college's reporting in three.
model Campus {
  id        String   @id @default(cuid())
  name      String   @unique
  active    Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  rooms Room[]

  @@index([active])
}
```

On `Room`, add and change:

```prisma
  campusRef Campus? @relation(fields: [campusId], references: [id], onDelete: SetNull)
  campusId  String?
```

Replace `@@unique([name, campus])` with `@@unique([name, campusId])` and add
`@@index([campusId])`.

**Keep the `campus` string column.** It is the only record of what the free text said
if the match turns out wrong, and dropping it in the same migration that consumes it
leaves nothing to check against. Add a comment saying it is retained for one release.

- [ ] **Step 2: Add the new `TimetableEvent` columns**

```prisma
  // The occurrences one form submission created, so "cancel this class for the rest of
  // term" is expressible at all. Null for an event created singly.
  seriesId String?
  // The administrator's per-series answer to "should this produce registers".
  createRegisters Boolean @default(true)
  // NULL means never published. Distinct from published=false, which after a
  // withdrawal means "was published, is not now" — register creation triggers on the
  // transition and needs to tell those apart.
  publishedAt DateTime?
```

Plus `@@index([seriesId])`.

- [ ] **Step 3: Add the new `HndSession` columns and remove the `@@unique`**

```prisma
  // The timetabled event this register came from. NULL for registers created by the
  // three-hour-block generator in routes/hnd.js and by the Moodle import.
  timetableEvent   TimetableEvent? @relation(fields: [timetableEventId], references: [id], onDelete: SetNull)
  timetableEventId String?
  // WHICH GROUP this register is for. A merged class keeps separate registers per
  // group, so the event alone does not identify a register.
  cohort   Cohort? @relation(fields: [cohortId], references: [id], onDelete: SetNull)
  cohortId String?
  // Where the class is. The field the student app has been missing, and the reason it
  // could not show a room next to a class.
  room   Room?   @relation(fields: [roomId], references: [id], onDelete: SetNull)
  roomId String?
```

Delete the line `@@unique([unitId, date, startTime])` and replace it with:

```prisma
  // UNIQUENESS IS TWO PARTIAL INDEXES, NOT THIS @@unique, AND PRISMA CANNOT SEE THEM.
  //
  // The original @@unique([unitId, date, startTime]) stopped a second generate run
  // silently doubling every attendance denominator. That guarantee still holds for
  // generator- and Moodle-created registers, as HndSession_generated_key.
  //
  // But a MERGED CLASS legitimately needs two registers for one module at one time —
  // one per group — which that constraint forbids. Timetable-created registers are
  // therefore identified by HndSession_event_group_key on (timetableEventId,
  // COALESCE(cohortId,'')) instead.
  //
  // Both are raw SQL in 20260907T120000_timetabling_registers. Prisma cannot express a
  // partial unique index, so `prisma migrate dev` would drop them as drift and nothing
  // would notice until duplicate registers appeared. schema-contract.test.js asserts
  // this comment is present and the @@unique has not been reinstated.
```

- [ ] **Step 4: Add the back-relations**

On `Cohort`: `registers HndSession[]`. On `Room`: `registers HndSession[]`. On
`TimetableEvent`: `registers HndSession[]`.

- [ ] **Step 5: Generate the migration SQL, then hand-edit it**

```bash
cd server && DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" \
  npx prisma migrate dev --name timetabling_registers --create-only
```

Rename the generated directory to `20260907T120000_timetabling_registers` **before it
is applied anywhere** — renaming after application makes Prisma re-run it, fail on
"already exists", record it failed, and refuse every later migration with P3009.

Then hand-edit the SQL so it reads, in this order:

```sql
-- 1. Campus table and Room.campusId (as generated)

-- 2. BACKFILL, before the unique index that depends on it. One Campus per distinct
--    case-insensitive spelling; the most common spelling wins the name.
INSERT INTO "Campus" ("id", "name", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, name, NOW(), NOW()
FROM (
  SELECT DISTINCT ON (lower(btrim(regexp_replace("campus", '\s+', ' ', 'g'))))
         btrim(regexp_replace("campus", '\s+', ' ', 'g')) AS name
  FROM "Room"
  WHERE btrim("campus") <> ''
  ORDER BY lower(btrim(regexp_replace("campus", '\s+', ' ', 'g'))), count(*) OVER () DESC, name
) AS distinct_campuses;

UPDATE "Room" r SET "campusId" = c."id"
FROM "Campus" c
WHERE lower(btrim(regexp_replace(r."campus", '\s+', ' ', 'g'))) = lower(c."name");

-- 3. Drop the old unique, add the two partial indexes.
DROP INDEX IF EXISTS "HndSession_unitId_date_startTime_key";

CREATE UNIQUE INDEX "HndSession_generated_key"
  ON "HndSession" ("unitId", "date", "startTime")
  WHERE "timetableEventId" IS NULL;

CREATE UNIQUE INDEX "HndSession_event_group_key"
  ON "HndSession" ("timetableEventId", COALESCE("cohortId", ''))
  WHERE "timetableEventId" IS NOT NULL;
```

- [ ] **Step 6: Apply it and confirm the indexes exist**

```bash
cd server && DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npx prisma migrate deploy
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npx prisma generate
```

Verify with `psql`:
```sql
SELECT indexname FROM pg_indexes WHERE tablename = 'HndSession' ORDER BY indexname;
```
Expected: both `HndSession_generated_key` and `HndSession_event_group_key` present, and
`HndSession_unitId_date_startTime_key` absent.

- [ ] **Step 7: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations/20260907T120000_timetabling_registers
git commit -m "A register belongs to an event and a group, so a merged class keeps two"
```

---

### Task 5: Schema contract assertions

**Files:**
- Modify: `server/src/timetabling/schema-contract.test.js`

- [ ] **Step 1: Add the failing assertions**

```js
test("HndSession does NOT carry @@unique([unitId, date, startTime])", () => {
  // Reinstating it would forbid the second register a merged class needs, and would
  // do it at the database rather than in code, so the failure would be a 500 on
  // publish rather than anything legible.
  const block = model("HndSession");
  assert.ok(!/@@unique\(\[unitId, date, startTime\]\)/.test(block),
    "the @@unique was reinstated — see HndSession_generated_key in the 20260907 migration");
});

test("HndSession names both partial indexes in a comment", () => {
  // Prisma cannot see them, so this comment is the only thing standing between a
  // `prisma migrate dev` and two silently dropped uniqueness guarantees.
  const block = model("HndSession");
  assert.match(block, /HndSession_generated_key/);
  assert.match(block, /HndSession_event_group_key/);
});

test("HndSession.timetableEventId, cohortId and roomId are all nullable", () => {
  const block = model("HndSession");
  for (const f of ["timetableEventId", "cohortId", "roomId"]) {
    assert.match(block, new RegExp(`${f}\\s+String\\?`), `${f} must be nullable`);
  }
});

test("Campus.name is unique", () => {
  assert.match(model("Campus"), /name\s+String\s+@unique/);
});
```

Reuse the file's existing helper for extracting a model block; if it is named
differently from `model(...)`, use that name.

- [ ] **Step 2: Run and confirm PASS** (Task 4 already made them true)

```bash
cd server && node --test src/timetabling/schema-contract.test.js
```

- [ ] **Step 3: Prove they can fail**

Temporarily re-add `@@unique([unitId, date, startTime])` to `HndSession` in
`schema.prisma`, re-run, confirm the first test FAILS, then remove it again.

- [ ] **Step 4: Commit**

```bash
git add server/src/timetabling/schema-contract.test.js
git commit -m "Assert the two indexes Prisma cannot see are still described"
```

---

### Task 6: The register applier

**Files:**
- Create: `server/src/timetabling/registers.js`

**Interfaces:**
- Consumes: `deriveRoster` (Task 2), `registerAction` (Task 3)
- Produces: `syncEventRegisters(eventId) → { created: number, updated: number, frozen: Array<{ sessionId, reason }>, skipped: Array<{ reason }> }`

- [ ] **Step 1: Implement**

```js
// Turning a published timetable event into attendance registers.
//
// ONE REGISTER PER GROUP, not per event: a merged class is two groups sharing a room
// and a lecturer, and they do not share a mark sheet. An event with no groups gets one
// register with a null cohortId, which HndSession_event_group_key permits exactly once
// via COALESCE — a plain two-column unique would treat every NULL as distinct and
// accept unlimited duplicates.
const prisma = require("../db");
const { deriveRoster } = require("./roster");
const { registerAction } = require("./registerRules");

async function syncEventRegisters(eventId) {
  const event = await prisma.timetableEvent.findUnique({
    where: { id: eventId },
    include: { groups: { select: { cohortId: true } } },
  });
  if (!event) return { created: 0, updated: 0, frozen: [], skipped: [{ reason: "No such event." }] };

  const shape = { date: event.date, startTime: event.startTime, endTime: event.endTime, roomId: event.roomId ?? null };
  const gate = registerAction({
    published: event.published, createRegisters: event.createRegisters,
    unitId: event.unitId, existing: null, event: shape,
  });
  if (gate.action === "skip") return { created: 0, updated: 0, frozen: [], skipped: [{ reason: gate.reason }] };

  // ONE PROBE FOR THE WHOLE UNIT, hoisted out of the per-group loop and unfiltered by
  // student. "Does this module have enrolments at all" is a question about the module;
  // asked per group it answers "did anyone in THIS group enrol", which is a different
  // question that reads a legitimately empty group as missing data.
  const unitHasEnrolments = (await prisma.enrolment.count({ where: { unitId: event.unitId } })) > 0;

  const cohortIds = event.groups.length ? event.groups.map((g) => g.cohortId) : [null];
  const out = { created: 0, updated: 0, frozen: [], skipped: [] };

  for (const cohortId of cohortIds) {
    const existing = await prisma.hndSession.findFirst({
      where: { timetableEventId: event.id, cohortId },
      select: { id: true, date: true, startTime: true, endTime: true, roomId: true, _count: { select: { marks: true } } },
    });
    const decision = registerAction({
      published: event.published, createRegisters: event.createRegisters, unitId: event.unitId,
      existing: existing ? { ...existing, hasMarks: existing._count.marks > 0 } : null,
      event: shape,
    });

    if (decision.action === "freeze") { out.frozen.push({ sessionId: existing.id, reason: decision.reason }); continue; }
    if (decision.action === "skip") { if (decision.reason) out.skipped.push({ reason: decision.reason }); continue; }

    if (decision.action === "update") {
      await prisma.hndSession.update({ where: { id: existing.id }, data: shape });
      out.updated++;
      continue;
    }

    // create
    const [cohortStudents, enrolled] = await Promise.all([
      cohortId ? prisma.student.findMany({ where: { cohortId }, select: { id: true } }) : Promise.resolve([]),
      prisma.enrolment.findMany({ where: { unitId: event.unitId }, select: { studentId: true } }),
    ]);
    const roster = cohortId
      ? deriveRoster({
          cohortStudentIds: cohortStudents.map((s) => s.id),
          enrolledStudentIds: enrolled.map((e) => e.studentId),
          unitHasEnrolments,
        })
      : { studentIds: enrolled.map((e) => e.studentId), rule: "cohort-and-enrolment" };

    await prisma.hndSession.create({
      data: {
        unitId: event.unitId, timetableEventId: event.id, cohortId,
        ...shape,
        description: event.title || "",
        audience: roster.rule === "cohort-only" ? "All students in the group" : "Enrolled students",
      },
    });
    out.created++;
    // NO MARKS ARE WRITTEN HERE. A register starts empty: a student who has not
    // checked in is unmeasured, not absent, and pre-seeding an A would make "did not
    // attend" indistinguishable from "nobody has taken this yet".
  }
  return out;
}

module.exports = { syncEventRegisters };
```

- [ ] **Step 2: Commit**

```bash
git add server/src/timetabling/registers.js
git commit -m "Publishing an event builds one register per group, and never seeds a mark"
```

---

### Task 7: Campus CRUD and serialiser

**Files:**
- Modify: `server/src/timetabling/serialize.js`, `server/src/routes/timetabling.js`

**Interfaces:**
- Produces: `sCampus(c) → { id, name, active }`; routes `GET|POST /timetabling/campuses`, `PUT|DELETE /timetabling/campuses/:id`

- [ ] **Step 1: Add `sCampus` and extend `sRoom`**

```js
const sCampus = (c) => ({ id: c.id, name: c.name, active: !!c.active });
```

In `sRoom`, add `campusId: r.campusId ?? null` and make `campus` prefer the related
row: `campus: r.campusRef?.name ?? r.campus ?? ""`. Export `sCampus`.

- [ ] **Step 2: Add the routes**, following the existing rooms/categories shape exactly
      — `str()`, `MAX`, 400 on a blank name, and a `DELETE` that **deactivates rather
      than deletes when rooms still reference it**, since deleting a campus must not
      quietly detach every room on it.

- [ ] **Step 3: Verify the server still boots**

```bash
cd server && DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" node -e "require('./src/routes/timetabling.js'); console.log('router loads')"
```

- [ ] **Step 4: Commit**

```bash
git add server/src/timetabling/serialize.js server/src/routes/timetabling.js
git commit -m "Campuses become a list, and deleting one never detaches its rooms"
```

---

### Task 8: Wire publish to register creation

**Files:**
- Modify: `server/src/routes/timetabling.js` (the `POST /events/publish` handler, and
  `PUT /events/:id`)

- [ ] **Step 1: On publish**, set `publishedAt` when it transitions to published, then
      call `syncEventRegisters(id)` for each event and return the aggregate
      `{ created, updated, frozen, skipped }` so the screen can report what happened
      rather than saying "published" and leaving the admin to discover the rest.

- [ ] **Step 2: On event update**, call `syncEventRegisters(id)` afterwards and include
      the `frozen` array in the response — this is how the admin learns a taken
      register no longer matches.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/timetabling.js
git commit -m "Publishing reports what it created, updated and could not move"
```

---

### Task 9: The smoke suite

**Files:**
- Create: `scripts/smoke-timetable-registers.mjs`

- [ ] **Step 1: Write the suite**, asserting, in order:

1. Publishing a unit-bearing event with one group creates **one** register with the
   event's date, times and room.
2. A **merged** event with two groups creates **two** registers; a mark on one does not
   appear on the other.
3. An event with **no unit** creates none, and the response says *"not a taught
   session"*.
4. Moving an **unmarked** event moves its register.
5. **Moving a MARKED event does not move its register**, and the response reports it as
   frozen. *(The assertion this suite exists for.)*
6. **Deleting an event with marks does not delete the marks**; the register survives
   with a null `timetableEventId`.
7. A **draft** event creates no register.
8. A student token gets **403** on `/api/timetabling/campuses`.
9. A staff account without the `scheduling` page gets **403**.

- [ ] **Step 2: Run the whole suite against the local database**

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- smoke-timetable-registers
```

- [ ] **Step 3: Prove assertion 5 can fail**

In `registerRules.js` change `if (existing.hasMarks)` to `if (false)`, re-run the
suite, confirm assertion 5 FAILS, then restore and re-run to green.

- [ ] **Step 4: Run everything**

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test
cd server && node --test "src/**/*.test.js"
```

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-timetable-registers.mjs
git commit -m "Nine assertions, and the one that matters is that a marked register does not move"
```

---

## Self-Review

**Spec coverage.** §6.1 Campus → Tasks 1, 4, 7. §6.2 event columns → Task 4. §6.3
`HndSession` columns → Task 4. §6.4 partial indexes → Tasks 4, 5. §7 R1–R5 → Tasks 3,
6, 9. §7.1 roster → Task 2. §7.2 merged classes → Tasks 6, 9. Deliberately deferred to
Phase 2/3 and **not** gaps in this plan: §7.3 clash checking, §7.4 auto-close, §8 entry
form, §9 the three surfaces, §10 the `TimetableSlot` migration, §9.4 colour.

**Placeholders.** None: every code step carries the code.

**Type consistency.** `registerAction` takes `{ published, createRegisters, unitId,
existing, event }` in Tasks 3, 6 identically; `existing` carries `hasMarks` in both.
`deriveRoster` takes `{ cohortStudentIds, enrolledStudentIds, unitHasEnrolments }` in
Tasks 2 and 6. `syncEventRegisters(eventId)` returns the same four keys in Tasks 6 and 8.
