# CELCAT-style Timetabling — Server & Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the data model and API for a manually-assigned, CELCAT-style timetable, so that "show me my timetable" becomes a real database query instead of a name match.

**Architecture:** Seven new tenant-scoped tables, additive only. A `TimetableEvent` carries real foreign keys to `Room`, `EventCategory`, `Unit` and `Course`, plus join tables to `Staff` and `Cohort`. Two routers: `/api/timetabling` (admin, page-gated) and `/api/my-timetable` (any signed-in staff member, no page gate). Pure logic — interval overlap, weekly expansion, settings merge — lives in its own files with `node:test` tests and no database; everything else is covered by one HTTP smoke suite.

**Tech Stack:** Node 20 + Express 4, Prisma 5 + PostgreSQL, `node:test` for unit tests, plain `fetch` smoke suites in `scripts/`.

**Spec:** `docs/superpowers/specs/2026-08-30-celcat-timetabling-design.md`

**This is Plan 1 of 2.** Plan 2 covers the client (`TimetableCalendar.jsx`, `AdminTimetablePlanner.jsx`, the staff tile) and will be written once these endpoints exist.

## Global Constraints

Copied verbatim from `CLAUDE.md` and the spec. Every task's requirements implicitly include this section.

- **Never let `DATABASE_URL` fall through to `server/.env`** — it points at a live database. Always pass it on the command line: `DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev"`.
- **Never rename a migration directory once applied anywhere.** Prisma identifies migrations by directory name; a rename re-runs it, it fails, and P3009 then blocks every later migration and every deploy. This has happened twice.
- **Migration directory naming is `YYYYMMDDTHHMMSS_snake_name`** (note the `T`), e.g. `20260829T190000_early_window`. Prisma does not generate this format — use `migrate dev --create-only`, rename **before** applying, then apply.
- **Tenant scoping is automatic.** `server/src/db.js` filters and stamps every query. Do not write `tenantId` into any route's `where` clause; do not add these models to `UNSCOPED_MODELS`. Every new model needs the standard tenant block (below).
- **Null means "not measurable"; zero means zero.** New columns that can be unknown must be nullable.
- **Dates are strings.** `YYYY-MM-DD` for dates, `HH:MM` for times, compared as strings. Never use the host clock for a user-facing date — `src/clock.js` pins `APP_TIMEZONE`.
- **Serialise through allowlists, never blocklists.**
- **`ADMIN_PAGES` exists in two hand-maintained copies** — `server/src/validate.js` and `client/src/StaffHub.jsx` — and they must stay in sync.
- **Rate limiters and locks are in-process** module-level `Map`s, correct for one Node process only. Say so in a comment if you add one.
- **Comments explain WHY, at length, including why an alternative was rejected.** This is the house style and it is load-bearing. Match the density of the surrounding files.
- The new admin page key is **`"scheduling"`**, labelled **"Scheduling"**. The existing `"timetable"` page is untouched.
- Do not modify `HndSession`, `AttendanceMark`, `TimetableSlot`, `routes/timetable.js`, the register generator, or anything under `src/prediction/`.

**The standard tenant block**, appended inside every new model:

```prisma
  // Which institution this row belongs to. Enforced centrally — see db.js.
  tenantId String
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  @@index([tenantId])
```

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `server/src/timetabling/overlap.js` | Do two `HH:MM` ranges collide. Pure. |
| `server/src/timetabling/overlap.test.js` | Tests for the above. |
| `server/src/timetabling/recurrence.js` | Expand a weekly repeat into dates. Pure. |
| `server/src/timetabling/recurrence.test.js` | Tests for the above. |
| `server/src/timetabling/settingsDefaults.js` | Display defaults, the three-layer merge, the outbound allowlists, and validation. Pure. |
| `server/src/timetabling/settingsDefaults.test.js` | Tests for the above. |
| `server/src/timetabling/settings.js` | Tenant + per-user settings resolver, with cache. Touches the database. |
| `server/src/timetabling/serialize.js` | `sRoom`, `sCategory`, `sEvent`, `sResource`. Allowlists. |
| `server/src/timetabling/schema-contract.test.js` | Parses `schema.prisma` as text; fails if the model shape drifts. |
| `server/src/routes/timetabling.js` | Admin router. |
| `server/src/routes/myTimetable.js` | Staff-facing router. |
| `scripts/smoke-timetabling.mjs` | HTTP smoke suite. |
| `server/prisma/migrations/20260830T120000_timetabling/migration.sql` | The one migration. |

**Modified:**

| File | Change |
|---|---|
| `server/prisma/schema.prisma` | Seven new models appended; `Staff`, `Cohort`, `Unit`, `Course`, `Tenant` gain back-relation fields. |
| `server/src/index.js` | Two `app.use` lines. |
| `server/src/validate.js:61` | `"scheduling"` added to `ADMIN_PAGES`. |
| `client/src/StaffHub.jsx:2194-2195` | `"scheduling"` added to the client `ADMIN_PAGES` and `PAGE_LABELS`. |

Serializers live in `timetabling/serialize.js` rather than the shared `serializers.js` deliberately: the module is self-contained by instruction, and `serializers.js` is imported by thirty-odd files that have no business seeing these shapes.

---

## Task 1: Schema and migration

**Files:**
- Modify: `server/prisma/schema.prisma` (append models; add back-relations to `Staff`, `Cohort`, `Unit`, `Course`, `Tenant`)
- Create: `server/prisma/migrations/20260830T120000_timetabling/migration.sql`
- Test: `server/src/timetabling/schema-contract.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma models `Room`, `EventCategory`, `TimetableEvent`, `TimetableEventStaff`, `TimetableEventGroup`, `TimetableSettings`, `TimetableUserPref`. Client accessors are `prisma.room`, `prisma.eventCategory`, `prisma.timetableEvent`, `prisma.timetableEventStaff`, `prisma.timetableEventGroup`, `prisma.timetableSettings`, `prisma.timetableUserPref`.

- [ ] **Step 1: Write the failing contract test**

Create `server/src/timetabling/schema-contract.test.js`. This mirrors `src/prediction/schema-contract.test.js`: it reads the schema as text, so it catches a hand-edit that a runtime test would not.

```js
// The timetabling schema, asserted as text.
//
// Two of these assertions are not stylistic. TimetableEvent.unitId MUST stay
// nullable — it is the whole reason this table exists rather than an extension of
// HndSession, because an exam, a workshop or a staff meeting belongs to no module.
// And Room.capacity MUST stay nullable, because "we have not recorded how many this
// room seats" is not "this room seats nobody"; a zero would make the room unusable
// by any future capacity check.
//
// Run with: node --test src/timetabling/schema-contract.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "schema.prisma"), "utf8");

/** The body of one `model X { ... }` block, or null. */
function modelBody(name) {
  const m = SCHEMA.match(new RegExp(`\\nmodel ${name} \\{([\\s\\S]*?)\\n\\}`));
  return m ? m[1] : null;
}

const MODELS = [
  "Room", "EventCategory", "TimetableEvent",
  "TimetableEventStaff", "TimetableEventGroup",
  "TimetableSettings", "TimetableUserPref",
];

for (const name of MODELS) {
  test(`${name} exists`, () => {
    assert.ok(modelBody(name), `model ${name} is missing from schema.prisma`);
  });

  test(`${name} is tenant-scoped`, () => {
    const body = modelBody(name) || "";
    // Without this, db.js cannot filter the model and every query throws
    // TenantScopeError at runtime — or worse, would return every college's rows.
    assert.match(body, /tenantId\s+String/, `${name} has no tenantId`);
    assert.match(body, /@@index\(\[tenantId\]\)/, `${name} does not index tenantId`);
  });
}

test("TimetableEvent.unitId is nullable", () => {
  assert.match(modelBody("TimetableEvent"), /unitId\s+String\?/);
});

test("TimetableEvent.courseId, roomId and categoryId are nullable", () => {
  const body = modelBody("TimetableEvent");
  assert.match(body, /courseId\s+String\?/);
  assert.match(body, /roomId\s+String\?/);
  assert.match(body, /categoryId\s+String\?/);
});

test("Room.capacity is nullable", () => {
  assert.match(modelBody("Room"), /capacity\s+Int\?/);
});

test("a room number is unique per campus, not globally", () => {
  // Two campuses may both have a room 101 — the reference institution has exactly
  // that. A global unique on name would refuse the second one.
  assert.match(modelBody("Room"), /@@unique\(\[tenantId, name, campus\]\)/);
});

test("an event cannot list the same staff member or group twice", () => {
  assert.match(modelBody("TimetableEventStaff"), /@@unique\(\[eventId, staffId\]\)/);
  assert.match(modelBody("TimetableEventGroup"), /@@unique\(\[eventId, cohortId\]\)/);
});

test("one settings row per tenant, one pref row per staff member", () => {
  assert.match(modelBody("TimetableSettings"), /@@unique\(\[tenantId\]\)/);
  assert.match(modelBody("TimetableUserPref"), /@@unique\(\[tenantId, staffId\]\)/);
});

test("events are indexed by date, because every read is a date-window read", () => {
  assert.match(modelBody("TimetableEvent"), /@@index\(\[tenantId, date\]\)/);
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd server && node --test src/timetabling/schema-contract.test.js
```

Expected: FAIL — every `... exists` test fails with "model Room is missing from schema.prisma".

- [ ] **Step 3: Append the models to `server/prisma/schema.prisma`**

Append at the end of the file:

```prisma
// ============================================================================
// TIMETABLING
//
// A manually-assigned timetable, in the shape CELCAT uses: an EVENT is placed on a
// date at a time, and a room, one or more staff and one or more groups are assigned
// to it. Everything that identifies a resource is a real foreign key.
//
// WHY THIS IS NOT AN EXTENSION OF TimetableSlot OR HndSession
//
// TimetableSlot.lecturer and .room are free text. Answering "show me my timetable"
// over them means matching a person's NAME, so two lecturers sharing a surname see
// each other's classes, a lecturer entered once as "S. Raza" and once as "Syed Raza"
// sees half their week, and nothing anywhere reports that it happened. A timetable
// that is quietly wrong is worse than no timetable, because staff plan around it.
//
// HndSession was the other candidate — one row, one truth, a register and a
// timetable that cannot disagree. It was rejected on unitId, which is NOT NULL and
// which the whole attendance pipeline assumes. Exams, workshops, study support and
// staff meetings belong to no module, so representing them there would mean making
// unitId nullable, and that migration reaches attendance, banding and prediction for
// a feature that has not shipped.
//
// The seam is planned and not yet built: HndSession will later carry a
// timetableEventId FK back to the event it came from, so that moving an event moves
// its register. Until then the two are separate records and can drift.
// ============================================================================

// A teachable space. Decomposed rather than stored as one label because the source
// system displays "101 - First floor [Great Titchfield Street]" — name, floor and
// campus are three facts, and a room search by campus needs them apart.
model Room {
  id        String  @id @default(cuid())
  name      String                        // "101", "MG-05"
  floor     String  @default("")          // "First floor" — free text; buildings disagree about naming
  campus    String  @default("")          // "Harrow", "Great Titchfield Street"
  // NULLABLE ON PURPOSE. Null means "we have not recorded how many this room seats",
  // which is not the same as zero. A zero would make the room unusable by any future
  // capacity check, and would put a real room permanently out of use because nobody
  // had got round to measuring it.
  capacity  Int?
  kind      String  @default("")          // "Lecture", "Lab", "Studio" — free text by design; every college has its own vocabulary
  active    Boolean @default(true)        // retired rooms stay, so historic events keep their room
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  events TimetableEvent[]

  // Two campuses may both have a room 101, and the reference institution has exactly
  // that. A unique on name alone would refuse the second one.
  @@unique([tenantId, name, campus])
  @@index([tenantId, active])

  // Which institution this row belongs to. Enforced centrally — see db.js.
  tenantId String
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  @@index([tenantId])
}

// What kind of thing an event is — "Lecture", "Seminar", "Exam", "Tutorial".
// A table rather than the free string HndSession.kind uses, because the colour key
// colours BY category and a colour needs somewhere to live.
model EventCategory {
  id        String  @id @default(cuid())
  name      String
  colour    String  @default("#1a3a8f")   // hex, shown in the event colour key
  active    Boolean @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  events TimetableEvent[]

  @@unique([tenantId, name])
  @@index([tenantId, active])

  // Which institution this row belongs to. Enforced centrally — see db.js.
  tenantId String
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  @@index([tenantId])
}

// One timetabled event on one date.
model TimetableEvent {
  id        String @id @default(cuid())
  // Strings, compared as strings, like every other academic date in this schema.
  date      String                         // YYYY-MM-DD
  startTime String                         // HH:MM
  endTime   String                         // HH:MM
  title     String
  notes     String @default("")

  // NULLABLE, and that nullability is the point of this table. An exam, a workshop,
  // a study-support session or a staff meeting belongs to no module — which is
  // exactly what HndSession.unitId being NOT NULL cannot express.
  unit       Unit?          @relation(fields: [unitId], references: [id], onDelete: SetNull)
  unitId     String?
  course     Course?        @relation(fields: [courseId], references: [id], onDelete: SetNull)
  courseId   String?
  // SetNull, not Cascade: deleting a room must not delete the classes that were in
  // it. The event survives with no room, which is visibly wrong on the screen and
  // therefore gets fixed — a silently vanished lecture does not.
  room       Room?          @relation(fields: [roomId], references: [id], onDelete: SetNull)
  roomId     String?
  category   EventCategory? @relation(fields: [categoryId], references: [id], onDelete: SetNull)
  categoryId String?

  // Draft events are invisible to staff, exactly as TimetableSlot.published already
  // governs what students see.
  published Boolean @default(false)

  // WHEN this event last moved in time or space. A TIMESTAMP, deliberately, and not
  // a stored day count: "changed 3 days ago" written to a column is wrong by the
  // next morning with nothing to correct it, while the timestamp is true forever.
  // The screen subtracts. This backs "Highlight recently changed events".
  changedAt DateTime @default(now())
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  staff  TimetableEventStaff[]
  groups TimetableEventGroup[]

  // Every read of this table is a date-window read.
  @@index([tenantId, date])
  @@index([roomId])
  @@index([unitId])

  // Which institution this row belongs to. Enforced centrally — see db.js.
  tenantId String
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  @@index([tenantId])
}

// Which staff member teaches an event. Several are allowed — a lecture with a
// demonstrator is two.
//
// THIS JOIN IS THE POINT OF THE WHOLE MODULE. It is what turns "show me my
// timetable" into a query on an id instead of a match on a name.
model TimetableEventStaff {
  id      String         @id @default(cuid())
  event   TimetableEvent @relation(fields: [eventId], references: [id], onDelete: Cascade)
  eventId String
  staff   Staff          @relation(fields: [staffId], references: [id], onDelete: Cascade)
  staffId String

  @@unique([eventId, staffId])
  @@index([staffId])

  // Which institution this row belongs to. Enforced centrally — see db.js.
  tenantId String
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  @@index([tenantId])
}

// Which group (intake) attends an event.
model TimetableEventGroup {
  id       String         @id @default(cuid())
  event    TimetableEvent @relation(fields: [eventId], references: [id], onDelete: Cascade)
  eventId  String
  cohort   Cohort         @relation(fields: [cohortId], references: [id], onDelete: Cascade)
  cohortId String

  @@unique([eventId, cohortId])
  @@index([cohortId])

  // Which institution this row belongs to. Enforced centrally — see db.js.
  tenantId String
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  @@index([tenantId])
}

// One college's timetable display defaults, and its notice banner.
//
// Same shape as attendanceBandConfig and branding: platform defaults in code, one
// JSON column per tenant merged over them, no row until somebody edits something, an
// allowlist on the way out, a short cache invalidated on save.
model TimetableSettings {
  id        String   @id @default(cuid())
  // Everything the college sets for everybody. Shape and allowlist live in
  // timetabling/settingsDefaults.js; nothing here validates it, deliberately, so a
  // key added tomorrow needs no migration.
  display   Json     @default("{}")
  updatedBy String   @default("")
  updatedAt DateTime @updatedAt

  @@unique([tenantId])

  // Which institution this row belongs to. Enforced centrally — see db.js.
  tenantId String
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  @@index([tenantId])
}

// One staff member's own overrides, merged OVER the college's.
//
// WHY THIS IS A TABLE AND NOT localStorage
//
// These staff use the web app and the phone app. A lecturer who hides the weekend
// and the 20:00 period would have done it on one device only, and the app would
// disagree with the website about their own settings. It is also how the source
// system behaves: My Settings follows the person.
model TimetableUserPref {
  id        String   @id @default(cuid())
  staff     Staff    @relation(fields: [staffId], references: [id], onDelete: Cascade)
  staffId   String
  display   Json     @default("{}")
  updatedAt DateTime @updatedAt

  @@unique([tenantId, staffId])

  // Which institution this row belongs to. Enforced centrally — see db.js.
  tenantId String
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  @@index([tenantId])
}
```

Then add the back-relation fields Prisma requires. Inside `model Staff { ... }` add:

```prisma
  timetableEvents TimetableEventStaff[]
  timetablePref   TimetableUserPref[]
```

Inside `model Cohort { ... }` add:

```prisma
  timetableEvents TimetableEventGroup[]
```

Inside `model Unit { ... }` add:

```prisma
  timetableEvents TimetableEvent[]
```

Inside `model Course { ... }` add:

```prisma
  timetableEvents TimetableEvent[]
```

Inside `model Tenant { ... }` add:

```prisma
  rooms                Room[]
  eventCategories      EventCategory[]
  timetableEvents      TimetableEvent[]
  timetableEventStaff  TimetableEventStaff[]
  timetableEventGroups TimetableEventGroup[]
  timetableSettings    TimetableSettings[]
  timetableUserPrefs   TimetableUserPref[]
```

- [ ] **Step 4: Run the contract test to verify it passes**

```bash
cd server && node --test src/timetabling/schema-contract.test.js
```

Expected: PASS, all tests.

- [ ] **Step 5: Generate the migration WITHOUT applying it**

```bash
cd server && DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npx prisma migrate dev --create-only --name timetabling
```

- [ ] **Step 6: Rename the generated directory to the house format, BEFORE applying**

Prisma names it `<epoch>_timetabling`; this repo uses `YYYYMMDDTHHMMSS_name`. Renaming is safe **only** because nothing has applied it yet. Renaming an applied migration re-runs it, it fails on "already exists", and P3009 then blocks every later migration and every deploy — this has happened twice.

```bash
cd server/prisma/migrations && mv *_timetabling 20260830T120000_timetabling && ls | tail -3
```

- [ ] **Step 7: Apply it and regenerate the client**

```bash
cd server && DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npx prisma migrate deploy
cd server && DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npx prisma generate
```

Expected: "All migrations have been successfully applied", then "Generated Prisma Client".

- [ ] **Step 8: Prove the models are reachable and tenant-scoped**

A one-off check that `db.js` refuses an unscoped query on the new tables — this is the isolation guarantee, and it is worth seeing rather than assuming.

```bash
cd server && DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" node -e "
const prisma = require('./src/db');
prisma.room.findMany().then(
  () => { console.error('FAIL: unscoped query returned rows instead of throwing'); process.exit(1); },
  (e) => { console.log(e.name === 'TenantScopeError' ? 'PASS: ' + e.name : 'FAIL: ' + e.name); process.exit(e.name === 'TenantScopeError' ? 0 : 1); }
);"
```

Expected: `PASS: TenantScopeError`.

- [ ] **Step 9: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations server/src/timetabling/schema-contract.test.js
git commit -m "Seven tables so a timetable can name a person instead of guessing at their name"
```

---

## Task 2: Interval overlap

**Files:**
- Create: `server/src/timetabling/overlap.js`
- Test: `server/src/timetabling/overlap.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean`
  - `findClashes(candidate: {id?, date, startTime, endTime}, existing: Array<{id, date, startTime, endTime}>): Array<event>`

- [ ] **Step 1: Write the failing test**

Create `server/src/timetabling/overlap.test.js`:

```js
// Tests for interval overlap — the arithmetic behind clash detection.
//
// No database. This file is pure.
//
// Run with: node --test src/timetabling/overlap.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const { overlaps, findClashes } = require("./overlap");

const ev = (id, date, startTime, endTime) => ({ id, date, startTime, endTime });

test("two identical ranges overlap", () => {
  assert.equal(overlaps("09:00", "11:00", "09:00", "11:00"), true);
});

test("a range wholly inside another overlaps", () => {
  assert.equal(overlaps("09:00", "12:00", "10:00", "11:00"), true);
  assert.equal(overlaps("10:00", "11:00", "09:00", "12:00"), true);
});

test("partial overlap at either end counts", () => {
  assert.equal(overlaps("09:00", "11:00", "10:00", "12:00"), true);
  assert.equal(overlaps("10:00", "12:00", "09:00", "11:00"), true);
});

test("BACK-TO-BACK IS NOT A CLASH", () => {
  // The single most important case. Intervals are half-open: an event ending at
  // 11:00 and one starting at 11:00 do not collide. Consecutive classes are the
  // normal shape of a teaching day, and a warning that fires on every consecutive
  // pair is a warning nobody reads — which is the same as having no warning at all,
  // except that it also hides the real ones.
  assert.equal(overlaps("09:00", "11:00", "11:00", "13:00"), false);
  assert.equal(overlaps("11:00", "13:00", "09:00", "11:00"), false);
});

test("ranges that do not touch do not overlap", () => {
  assert.equal(overlaps("09:00", "10:00", "14:00", "15:00"), false);
});

test("times compare as strings, so a single-digit hour must be zero-padded", () => {
  // "9:00" < "10:00" is FALSE lexicographically, so an unpadded time would silently
  // compare wrong. The route layer validates HH:MM; this documents why it must.
  assert.equal(overlaps("09:00", "10:00", "09:30", "10:30"), true);
});

test("findClashes ignores events on a different date", () => {
  const found = findClashes(ev(null, "2026-09-01", "09:00", "11:00"), [
    ev("a", "2026-09-02", "09:00", "11:00"),
  ]);
  assert.deepEqual(found, []);
});

test("findClashes returns the colliding events", () => {
  const found = findClashes(ev(null, "2026-09-01", "09:00", "11:00"), [
    ev("a", "2026-09-01", "10:00", "12:00"),
    ev("b", "2026-09-01", "11:00", "12:00"),
    ev("c", "2026-09-01", "08:00", "09:00"),
  ]);
  assert.deepEqual(found.map((e) => e.id), ["a"]);
});

test("an event never clashes with ITSELF", () => {
  // Editing an event re-checks it against everything already stored, and that set
  // includes the row being edited. Without this, saving an event without moving it
  // would report the event double-booking its own room.
  const found = findClashes(ev("a", "2026-09-01", "09:00", "11:00"), [
    ev("a", "2026-09-01", "09:00", "11:00"),
  ]);
  assert.deepEqual(found, []);
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd server && node --test src/timetabling/overlap.test.js
```

Expected: FAIL — `Cannot find module './overlap'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/timetabling/overlap.js`:

```js
// Do two timetabled things collide?
//
// Nothing anywhere in this codebase checked this before. AUTO-TIMETABLING.md §1.3
// records the position it replaces: "A tutor can be given two rooms at 18:00 on a
// Tuesday and the system will save it, publish it, and show it to students on both
// courses."
//
// Pure — strings in, booleans out, no database. Times are HH:MM and compare as
// strings, which works only because they are zero-padded; the route layer validates
// that, and overlap.test.js records why it has to.

/**
 * Do [aStart, aEnd) and [bStart, bEnd) intersect?
 *
 * HALF-OPEN, and that is the whole subtlety. An event ending at 11:00 and one
 * starting at 11:00 do NOT clash — consecutive classes are the normal shape of a
 * teaching day. A closed interval here would fire a warning on every back-to-back
 * pair in the college, and a warning that fires constantly is worse than none: it
 * buries the real double-bookings it exists to surface.
 */
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Which of `existing` collide with `candidate`. Same date only.
 *
 * `candidate.id` is excluded from the result when set: editing an event re-checks it
 * against everything stored, and the stored set contains the row being edited, so
 * without this an untouched save would report the event double-booking its own room.
 */
function findClashes(candidate, existing) {
  return (existing || []).filter((e) =>
    e.id !== candidate.id &&
    e.date === candidate.date &&
    overlaps(candidate.startTime, candidate.endTime, e.startTime, e.endTime));
}

module.exports = { overlaps, findClashes };
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd server && node --test src/timetabling/overlap.test.js
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Prove the back-to-back test can fail**

Temporarily change `overlaps` to `aStart <= bEnd && bStart <= aEnd`, re-run, and confirm "BACK-TO-BACK IS NOT A CLASH" fails. Then revert. A test that cannot fail is not coverage — two tests in recent work passed while discriminating nothing.

```bash
cd server && node --test src/timetabling/overlap.test.js
```

Expected while broken: FAIL on that one test. Then revert and confirm PASS again.

- [ ] **Step 6: Commit**

```bash
git add server/src/timetabling/overlap.js server/src/timetabling/overlap.test.js
git commit -m "Clash detection, and the half-open interval that keeps it worth reading"
```

---

## Task 3: Weekly recurrence

**Files:**
- Create: `server/src/timetabling/recurrence.js`
- Test: `server/src/timetabling/recurrence.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `weeklyDates(startDate: string, endDate: string, opts?: { skip?: string[], maxWeeks?: number }): string[]` — every date on the same weekday as `startDate`, from `startDate` to `endDate` inclusive, minus `skip`.

- [ ] **Step 1: Write the failing test**

Create `server/src/timetabling/recurrence.test.js`:

```js
// Tests for weekly expansion — turning "this event, every week until December" into
// the dates it actually falls on.
//
// No database. This file is pure.
//
// Run with: node --test src/timetabling/recurrence.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const { weeklyDates } = require("./recurrence");

test("steps forward in 7-day increments from the start date", () => {
  assert.deepEqual(
    weeklyDates("2026-09-01", "2026-09-22"),
    ["2026-09-01", "2026-09-08", "2026-09-15", "2026-09-22"]);
});

test("the end date is inclusive when it lands on the weekday", () => {
  assert.deepEqual(weeklyDates("2026-09-01", "2026-09-08"), ["2026-09-01", "2026-09-08"]);
});

test("a range shorter than a week yields just the start date", () => {
  assert.deepEqual(weeklyDates("2026-09-01", "2026-09-03"), ["2026-09-01"]);
});

test("an end date before the start yields nothing", () => {
  assert.deepEqual(weeklyDates("2026-09-08", "2026-09-01"), []);
});

test("skipped dates are removed, not shifted", () => {
  // A cancelled week is a week with no class, not a class moved to the next week.
  // Shifting would silently push the whole term along by seven days.
  assert.deepEqual(
    weeklyDates("2026-09-01", "2026-09-22", { skip: ["2026-09-08"] }),
    ["2026-09-01", "2026-09-15", "2026-09-22"]);
});

test("it crosses a month and a year boundary correctly", () => {
  assert.deepEqual(
    weeklyDates("2026-12-22", "2027-01-12"),
    ["2026-12-22", "2026-12-29", "2027-01-05", "2027-01-12"]);
});

test("it survives the spring clock change without drifting a day", () => {
  // 29 March 2026 is when BST starts in the UK. Date arithmetic done in local time
  // lands on 23:00 the previous day and the whole series slips back one date. The
  // implementation works in UTC for exactly this reason.
  const out = weeklyDates("2026-03-23", "2026-04-06");
  assert.deepEqual(out, ["2026-03-23", "2026-03-30", "2026-04-06"]);
});

test("it is capped, so a typo in the end date cannot generate forever", () => {
  // The register generator caps at 60 weeks for the same reason. An end date of
  // 2999-01-01 is a slip of the keyboard, not a request for fifty thousand rows.
  const out = weeklyDates("2026-09-01", "2999-01-01");
  assert.equal(out.length, 60);
});

test("maxWeeks can be lowered but the default is 60", () => {
  assert.equal(weeklyDates("2026-09-01", "2999-01-01", { maxWeeks: 4 }).length, 4);
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd server && node --test src/timetabling/recurrence.test.js
```

Expected: FAIL — `Cannot find module './recurrence'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/timetabling/recurrence.js`:

```js
// Weekly expansion: "this event, every week until December" into the dates it falls
// on.
//
// This exists because hand-entering twelve weeks of a Tuesday lecture is not a
// feature, it is a reason the tool goes unused.
//
// Pure — strings in, strings out, no database and no notion of what a college does
// on those dates. Bank holidays and reading weeks are the CALLER's business, passed
// in through `skip`, because whether a college teaches on Easter Monday is a policy
// question and hardcoding one answer to somebody else's policy is the worse failure.

// A typo in the end date must not generate fifty thousand rows. The register
// generator in routes/hnd.js caps at 60 weeks for the same reason, and a college
// year is under 52.
const MAX_WEEKS = 60;

/**
 * Every date on the same weekday as `startDate`, from `startDate` to `endDate`
 * inclusive, minus anything in `skip`.
 *
 * All arithmetic is in UTC. Local-time arithmetic across the spring clock change
 * lands on 23:00 the previous day and slips the entire remaining series back by one
 * date — a term of Tuesday lectures silently becoming Monday lectures at the end of
 * March. recurrence.test.js pins that case.
 */
function weeklyDates(startDate, endDate, { skip = [], maxWeeks = MAX_WEEKS } = {}) {
  const out = [];
  if (!startDate || !endDate || endDate < startDate) return out;

  const skipSet = new Set(skip);
  const cursor = new Date(`${startDate}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime())) return out;

  for (let i = 0; i < maxWeeks; i++) {
    const iso = cursor.toISOString().slice(0, 10);
    if (iso > endDate) break;
    // A skipped week is a week with no class, not a class moved to the following
    // week — shifting would push the whole term along by seven days.
    if (!skipSet.has(iso)) out.push(iso);
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return out;
}

module.exports = { weeklyDates, MAX_WEEKS };
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd server && node --test src/timetabling/recurrence.test.js
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Prove the clock-change test can fail**

Temporarily change `new Date(\`${startDate}T00:00:00Z\`)` to `new Date(\`${startDate}T00:00:00\`)` and `setUTCDate`/`getUTCDate` to `setDate`/`getDate`, run with `TZ=Europe/London`, and confirm the clock-change test fails. Then revert.

```bash
cd server && TZ=Europe/London node --test src/timetabling/recurrence.test.js
```

Expected while broken: FAIL on "it survives the spring clock change". Then revert and confirm PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/timetabling/recurrence.js server/src/timetabling/recurrence.test.js
git commit -m "Weekly repeat, in UTC, because March would otherwise move every Tuesday to a Monday"
```

---

## Task 4: Settings defaults, merge and allowlists

**Files:**
- Create: `server/src/timetabling/settingsDefaults.js`
- Test: `server/src/timetabling/settingsDefaults.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `DEFAULTS: object` — the platform display defaults
  - `TENANT_FIELDS: string[]`, `USER_FIELDS: string[]`
  - `mergeSettings(tenantBlob: object|null, userBlob: object|null): object`
  - `cleanTenant(patch: object): object` — patch reduced to valid `TENANT_FIELDS`
  - `cleanUser(patch: object): object` — patch reduced to valid `USER_FIELDS`

- [ ] **Step 1: Write the failing test**

Create `server/src/timetabling/settingsDefaults.test.js`:

```js
// Tests for the three-layer settings merge: platform defaults, then what the college
// set for everyone, then what this member of staff set for themselves.
//
// No database. This file is pure.
//
// Run with: node --test src/timetabling/settingsDefaults.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const { DEFAULTS, mergeSettings, cleanTenant, cleanUser } = require("./settingsDefaults");

test("with nothing stored, the platform defaults come back whole", () => {
  const got = mergeSettings(null, null);
  assert.equal(got.view, DEFAULTS.view);
  assert.deepEqual(got.days, DEFAULTS.days);
  assert.equal(got.periods.length, DEFAULTS.periods.length);
});

test("the college's settings win over the platform defaults", () => {
  const got = mergeSettings({ view: "day" }, null);
  assert.equal(got.view, "day");
});

test("the staff member's settings win over the college's", () => {
  const got = mergeSettings({ view: "day" }, { view: "month" });
  assert.equal(got.view, "month");
});

test("a layer that sets one key does not blank the others", () => {
  // Merge, not replace. A lecturer who hides the weekend must not thereby lose the
  // college's notice banner and colour choice.
  const got = mergeSettings({ view: "day", colourBy: "room" }, { view: "month" });
  assert.equal(got.view, "month");
  assert.equal(got.colourBy, "room");
});

test("THE NOTICE BANNER IS THE COLLEGE'S, AND A USER CANNOT SET IT", () => {
  // The banner carries compliance wording — the reference institution's says what
  // students must do to stay eligible for a maintenance loan. It is an institutional
  // statement, and a member of staff editing their own copy of it would be editing
  // what every reader of their timetable is told.
  const got = mergeSettings({ notice: { enabled: true, text: "College says" } },
                            { notice: { enabled: true, text: "I say" } });
  assert.equal(got.notice.text, "College says");
});

test("cleanUser drops the notice entirely", () => {
  assert.equal("notice" in cleanUser({ notice: { enabled: true, text: "x" }, view: "day" }), false);
});

test("unknown keys are dropped rather than stored", () => {
  // An allowlist, not a blocklist. sAdmission is the standing example of what the
  // other way costs: it stripped a fixed list of secrets, so every column added
  // afterwards shipped to the browser by default.
  const cleaned = cleanTenant({ view: "day", isAdmin: true, __proto__: {}, nonsense: 1 });
  assert.deepEqual(Object.keys(cleaned), ["view"]);
});

test("an invalid view is dropped, not stored", () => {
  assert.deepEqual(cleanTenant({ view: "spiral" }), {});
});

test("days must be ISO weekdays 1-7 and are de-duplicated and sorted", () => {
  assert.deepEqual(cleanTenant({ days: [5, 1, 1, 9, 3, 0] }).days, [1, 3, 5]);
});

test("an empty day list is refused, because a timetable showing no days is a bug report", () => {
  assert.deepEqual(cleanTenant({ days: [] }), {});
});

test("periods must be HH:MM pairs with end after start", () => {
  const ok = cleanTenant({ periods: [{ start: "09:00", end: "10:00" }] });
  assert.deepEqual(ok.periods, [{ start: "09:00", end: "10:00" }]);
  assert.deepEqual(cleanTenant({ periods: [{ start: "10:00", end: "09:00" }] }), {});
  assert.deepEqual(cleanTenant({ periods: [{ start: "9:00", end: "10:00" }] }), {});
});

test("periods come back sorted, whatever order they were sent in", () => {
  const got = cleanTenant({ periods: [{ start: "14:00", end: "15:00" }, { start: "09:00", end: "10:00" }] });
  assert.deepEqual(got.periods.map((p) => p.start), ["09:00", "14:00"]);
});

test("highlightChangedDays is clamped, not rejected", () => {
  // A number field a person types into. 0 means "do not highlight"; a negative or
  // absurd value is a slip, and clamping keeps their other edits in the same save.
  assert.equal(cleanUser({ highlightChangedDays: -5 }).highlightChangedDays, 0);
  assert.equal(cleanUser({ highlightChangedDays: 9999 }).highlightChangedDays, 90);
});

test("annotations keep only known fields, in the order given", () => {
  // The order IS the setting — it is what prints first inside an event tile.
  const got = cleanUser({ annotations: ["room", "nonsense", "title"] });
  assert.deepEqual(got.annotations, ["room", "title"]);
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd server && node --test src/timetabling/settingsDefaults.test.js
```

Expected: FAIL — `Cannot find module './settingsDefaults'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/timetabling/settingsDefaults.js`:

```js
// What a timetable looks like: the platform's defaults, what one college sets for
// everybody, and what one member of staff sets for themselves.
//
// The pattern is the one attendanceBandConfig.js and branding.js established —
// platform defaults in code, a JSON column merged over them, an allowlist on the way
// out — with ONE LAYER ADDED. The source system's "My Settings" is per person, and
// these staff use both the website and the phone app, so localStorage would mean a
// lecturer's hidden weekend followed them on one device and not the other.
//
//   defaults (here)  ->  tenant blob (TENANT_FIELDS)  ->  user blob (USER_FIELDS)
//
// Pure. No database, no cache, no Prisma — settings.js does that part, and keeping
// the rules here is what makes them testable without one.

// The display shape. Every key here is what an unconfigured college sees, and those
// values are deliberately the plainest reading of a timetable rather than anyone's
// house style.
const DEFAULTS = {
  view: "week",              // day | week | month | timeline
  layout: "grid",            // grid | list
  // Mon-Fri. Not Mon-Sun: a college that teaches at weekends turns those on, and
  // starting with two permanently empty columns makes the grid harder to read for
  // everyone who does not.
  days: [1, 2, 3, 4, 5],     // ISO weekdays, 1 = Monday
  // Hour bands, as the source system shows them. An explicit list rather than a
  // start/end pair because a college running 50-minute periods, or a lunch gap, can
  // then say so — which a pair cannot express.
  periods: [
    { start: "09:00", end: "10:00" }, { start: "10:00", end: "11:00" },
    { start: "11:00", end: "12:00" }, { start: "12:00", end: "13:00" },
    { start: "13:00", end: "14:00" }, { start: "14:00", end: "15:00" },
    { start: "15:00", end: "16:00" }, { start: "16:00", end: "17:00" },
    { start: "17:00", end: "18:00" }, { start: "18:00", end: "19:00" },
    { start: "19:00", end: "20:00" }, { start: "20:00", end: "21:00" },
  ],
  // Colour is a CHOSEN DIMENSION, not a fixed palette — the source system's "Event
  // colour key" lets a reader ask what colour should mean.
  colourBy: "category",      // category | module | room | group | course
  colourVariant: "normal",   // normal | light
  showEventTimes: true,
  showEventId: false,
  showAvailability: false,
  swapAxes: false,
  // 0 = do not highlight. A day count, applied to the changedAt TIMESTAMP at render
  // time — never a day count stored against the event, which would be wrong by the
  // next morning with nothing to correct it.
  highlightChangedDays: 0,
  // What prints inside an event tile, in this order. The ORDER is the setting.
  annotations: ["title", "unit", "category", "room", "staff", "group"],
  // The college's own statement across the top of every timetable. Institutional,
  // and therefore not something an individual can edit — see USER_FIELDS.
  notice: { enabled: false, text: "" },
};

const VIEWS = new Set(["day", "week", "month", "timeline"]);
const LAYOUTS = new Set(["grid", "list"]);
const COLOUR_BY = new Set(["category", "module", "room", "group", "course"]);
const VARIANTS = new Set(["normal", "light"]);
const ANNOTATIONS = new Set(["title", "unit", "category", "room", "staff", "group", "department", "eventId"]);

// A college sets everything, including the banner.
const TENANT_FIELDS = [
  "view", "layout", "days", "periods", "colourBy", "colourVariant",
  "showEventTimes", "showEventId", "showAvailability", "swapAxes",
  "highlightChangedDays", "annotations", "notice",
];
// A person sets everything EXCEPT the banner. The banner carries compliance wording
// — at the reference institution, what a student must do to stay eligible for a
// maintenance loan — so it is an institutional statement, and a lecturer editing
// their copy would be editing what every reader of their timetable is told.
const USER_FIELDS = TENANT_FIELDS.filter((f) => f !== "notice");

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const isBool = (v) => typeof v === "boolean";
const str = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * One field, validated. Returns `undefined` when the value is unusable, and the
 * caller then leaves the key out entirely — so an unusable value falls through to
 * the layer beneath rather than blanking it.
 */
function cleanField(key, value) {
  switch (key) {
    case "view":          return VIEWS.has(value) ? value : undefined;
    case "layout":        return LAYOUTS.has(value) ? value : undefined;
    case "colourBy":      return COLOUR_BY.has(value) ? value : undefined;
    case "colourVariant": return VARIANTS.has(value) ? value : undefined;

    case "showEventTimes":
    case "showEventId":
    case "showAvailability":
    case "swapAxes":
      return isBool(value) ? value : undefined;

    case "highlightChangedDays": {
      // Clamped rather than refused: this is a number somebody types, and rejecting
      // the whole save over a stray keystroke would lose their other edits with it.
      const n = Number(value);
      if (!Number.isFinite(n)) return undefined;
      return Math.min(90, Math.max(0, Math.round(n)));
    }

    case "days": {
      if (!Array.isArray(value)) return undefined;
      const days = [...new Set(value.map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort((a, b) => a - b);
      // A timetable showing no days at all is a bug report, not a preference.
      return days.length ? days : undefined;
    }

    case "periods": {
      if (!Array.isArray(value)) return undefined;
      const out = [];
      for (const p of value) {
        const start = str(p?.start), end = str(p?.end);
        // HH:MM and zero-padded, because these compare as strings everywhere else
        // in this module and "9:00" < "10:00" is false.
        if (!TIME_RE.test(start) || !TIME_RE.test(end) || end <= start) return undefined;
        out.push({ start, end });
      }
      if (!out.length || out.length > 24) return undefined;
      return out.sort((a, b) => a.start.localeCompare(b.start));
    }

    case "annotations": {
      if (!Array.isArray(value)) return undefined;
      // Order preserved — it is what prints first inside a tile — but de-duplicated,
      // since the same field twice would print twice.
      const seen = new Set(), out = [];
      for (const a of value) if (ANNOTATIONS.has(a) && !seen.has(a)) { seen.add(a); out.push(a); }
      return out.length ? out : undefined;
    }

    case "notice": {
      if (!value || typeof value !== "object") return undefined;
      return { enabled: !!value.enabled, text: str(value.text).slice(0, 2000) };
    }

    default: return undefined;
  }
}

/** `patch` reduced to the fields `allowed` permits, each validated. */
function clean(patch, allowed) {
  const out = {};
  if (!patch || typeof patch !== "object") return out;
  for (const key of allowed) {
    // Own properties only — a payload carrying __proto__ or constructor must not
    // reach the switch above.
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const v = cleanField(key, patch[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

const cleanTenant = (patch) => clean(patch, TENANT_FIELDS);
const cleanUser = (patch) => clean(patch, USER_FIELDS);

/**
 * The settings this reader actually gets: defaults, then the college's, then their
 * own. Always complete — never null, never partial — so no caller needs a fallback.
 *
 * Both blobs are re-cleaned on the way OUT as well as in. A row can predate a rule
 * or be edited by hand in a console, and a stored `view: "spiral"` would otherwise
 * reach a client that has no such view and render nothing at all.
 */
function mergeSettings(tenantBlob, userBlob) {
  return {
    ...DEFAULTS,
    ...cleanTenant(tenantBlob),
    ...cleanUser(userBlob),
  };
}

module.exports = {
  DEFAULTS, TENANT_FIELDS, USER_FIELDS,
  mergeSettings, cleanTenant, cleanUser,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd server && node --test src/timetabling/settingsDefaults.test.js
```

Expected: PASS, 14 tests.

- [ ] **Step 5: Prove the notice-banner test can fail**

Temporarily add `"notice"` back into `USER_FIELDS`, re-run, and confirm both "THE NOTICE BANNER IS THE COLLEGE'S" and "cleanUser drops the notice entirely" fail. Then revert.

- [ ] **Step 6: Commit**

```bash
git add server/src/timetabling/settingsDefaults.js server/src/timetabling/settingsDefaults.test.js
git commit -m "Three layers of timetable settings, and one the individual cannot touch"
```

---

## Task 5: The settings resolver

**Files:**
- Create: `server/src/timetabling/settings.js`

**Interfaces:**
- Consumes: `settingsDefaults.js` (`mergeSettings`, `cleanTenant`, `cleanUser`, `DEFAULTS`); `../db` (`prisma`, `currentTenantId`).
- Produces:
  - `getTenant(): Promise<object>` — the college's stored blob, cleaned
  - `getEffective(staffId: string): Promise<object>` — the merged three layers
  - `saveTenant(patch: object, updatedBy: string): Promise<object>`
  - `saveUser(staffId: string, patch: object): Promise<object>`
  - `invalidate(tenantId?: string): void`

- [ ] **Step 1: Write the implementation**

There is no unit test for this task: it is database access and a cache, which is what the smoke suite in Task 13 covers. The rules it applies are already tested in Task 4.

Create `server/src/timetabling/settings.js`:

```js
// Reading and writing timetable display settings.
//
// The rules live next door in settingsDefaults.js and are tested without a database.
// This file is only the storage and the cache, in the shape attendanceBandConfig.js
// established.
const prisma = require("../db");
const { currentTenantId } = require("../db");
const { mergeSettings, cleanTenant, cleanUser, DEFAULTS } = require("./settingsDefaults");

// Short, matching branding.js and attendanceBandConfig.js. These are read on every
// timetable load, change about never, and an administrator who has just edited the
// notice banner should see it while still looking at the screen.
//
// IN-PROCESS. Correct for one Node process; a clustered deployment would need Redis,
// and until then a second instance can serve a stale banner for up to TTL_MS.
const TTL_MS = Number(process.env.TIMETABLE_SETTINGS_CACHE_MS ?? 30_000);
const tenantCache = new Map(); // tenantId -> { value, at }

function invalidate(tenantId) {
  if (tenantId) tenantCache.delete(tenantId);
  else tenantCache.clear();
}

/** This college's stored settings, cleaned. `{}` when it has never edited anything. */
async function getTenant() {
  const tenantId = currentTenantId();
  // Outside a request — a script, a one-off — there is no college to look up, and
  // the defaults are the honest answer.
  if (!tenantId) return {};

  const hit = tenantCache.get(tenantId);
  if (TTL_MS > 0 && hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let row = null;
  try {
    row = await prisma.timetableSettings.findFirst();
  } catch {
    // Table not migrated yet. The defaults are the correct answer, not an error —
    // the same fallback attendanceBandConfig.js makes, and what keeps a partially
    // deployed environment showing a timetable rather than a stack trace.
    row = null;
  }

  const value = cleanTenant(row?.display || {});
  tenantCache.set(tenantId, { value, at: Date.now() });
  return value;
}

/**
 * What this member of staff actually sees: platform defaults, the college's
 * settings, then their own. Always complete.
 *
 * The user row is NOT cached. There is one per person rather than one per college,
 * so the hit rate would be poor, and a lecturer who has just changed a setting is
 * the single reader most likely to reload immediately.
 */
async function getEffective(staffId) {
  const tenant = await getTenant();
  if (!staffId) return mergeSettings(tenant, null);

  let row = null;
  try {
    row = await prisma.timetableUserPref.findFirst({ where: { staffId } });
  } catch {
    row = null;
  }
  return mergeSettings(tenant, row?.display || {});
}

/**
 * Replace this college's settings. `patch` is merged over what is stored, so a
 * screen that sends only the field it changed does not blank the rest.
 *
 * Returns the college's new stored blob (not the merged view) — the admin screen
 * edits the college layer and must see the college layer, or an individual's
 * override would look like the college's own setting.
 */
async function saveTenant(patch, updatedBy = "") {
  const tenantId = currentTenantId();
  const existing = await prisma.timetableSettings.findFirst();
  const next = { ...cleanTenant(existing?.display || {}), ...cleanTenant(patch) };

  if (existing) {
    await prisma.timetableSettings.update({
      where: { id: existing.id },
      data: { display: next, updatedBy: String(updatedBy || "").slice(0, 200) },
    });
  } else {
    // No row until a college edits something — so "no row" and "a row holding the
    // defaults" cannot both mean the same thing, exactly as in branding.js.
    await prisma.timetableSettings.create({
      data: { display: next, updatedBy: String(updatedBy || "").slice(0, 200) },
    });
  }

  invalidate(tenantId);
  return next;
}

/** Replace one staff member's own overrides. Returns their new stored blob. */
async function saveUser(staffId, patch) {
  const existing = await prisma.timetableUserPref.findFirst({ where: { staffId } });
  const next = { ...cleanUser(existing?.display || {}), ...cleanUser(patch) };

  if (existing) await prisma.timetableUserPref.update({ where: { id: existing.id }, data: { display: next } });
  else await prisma.timetableUserPref.create({ data: { staffId, display: next } });

  return next;
}

module.exports = { getTenant, getEffective, saveTenant, saveUser, invalidate, DEFAULTS };
```

- [ ] **Step 2: Verify it loads and the rules are wired**

```bash
cd server && node -e "
const s = require('./src/timetabling/settings');
const ok = typeof s.getEffective === 'function' && typeof s.saveTenant === 'function' && s.DEFAULTS.view === 'week';
console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);"
```

Expected: `PASS`.

- [ ] **Step 3: Commit**

```bash
git add server/src/timetabling/settings.js
git commit -m "Store the settings; the rules stay next door where a test can reach them"
```

---

## Task 6: Serializers

**Files:**
- Create: `server/src/timetabling/serialize.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `sRoom(r): object` — `{ id, name, floor, campus, capacity, kind, active, label }`
  - `sCategory(c): object` — `{ id, name, colour, active }`
  - `sEvent(e): object` — `{ id, date, start, end, title, notes, published, changedAt, unitId, unitCode, courseId, courseName, roomId, room, categoryId, category, categoryColour, staff: [{id,name}], groups: [{id,name}] }`
  - `sResource(type, row): object` — `{ id, label, sub }`
  - `roomLabel(r): string`

- [ ] **Step 1: Write the implementation**

Create `server/src/timetabling/serialize.js`:

```js
// What leaves the building.
//
// ALLOWLISTS, NEVER BLOCKLISTS. sAdmission is the standing example of the other way:
// it stripped a fixed list of secrets, so every column added afterwards shipped to
// the browser by default. Here, a column added to Room tomorrow is private until
// somebody adds its name below on purpose.
//
// These live in the module rather than in the shared serializers.js because this
// module is self-contained by instruction, and serializers.js is imported by thirty
// files that have no business seeing these shapes.

/**
 * A room as a person reads it: "101 - First floor [Harrow]".
 *
 * Assembled here rather than stored, so that renaming a campus renames it
 * everywhere. Each part is dropped when empty, because "101 -  []" is worse than
 * "101".
 */
function roomLabel(r) {
  if (!r) return "";
  const head = [r.name, r.floor].filter(Boolean).join(" - ");
  return r.campus ? `${head} [${r.campus}]` : head;
}

const sRoom = (r) => ({
  id: r.id,
  name: r.name,
  floor: r.floor || "",
  campus: r.campus || "",
  // Passed through as null, never coerced to 0. Null is "we have not recorded how
  // many this room seats"; zero would be "this room seats nobody", and a future
  // capacity check would take the second at face value and retire a real room.
  capacity: r.capacity ?? null,
  kind: r.kind || "",
  active: !!r.active,
  label: roomLabel(r),
});

const sCategory = (c) => ({
  id: c.id, name: c.name, colour: c.colour || "#1a3a8f", active: !!c.active,
});

/**
 * One event, with the names of what it is joined to.
 *
 * `changedAt` goes out as a timestamp and the SCREEN subtracts to get "changed 2
 * days ago". Sending a day count would be wrong by the next morning, with nothing on
 * the server to correct it, because a day passing is not an event that fires.
 */
const sEvent = (e) => ({
  id: e.id,
  date: e.date,
  start: e.startTime,
  end: e.endTime,
  title: e.title,
  notes: e.notes || "",
  published: !!e.published,
  changedAt: e.changedAt,

  unitId: e.unitId ?? null,
  unitCode: e.unit?.code ?? null,
  unitName: e.unit?.name ?? null,
  courseId: e.courseId ?? null,
  courseName: e.course?.name ?? null,
  roomId: e.roomId ?? null,
  room: e.room ? roomLabel(e.room) : null,
  categoryId: e.categoryId ?? null,
  category: e.category?.name ?? null,
  categoryColour: e.category?.colour ?? null,

  // Names only. A timetable needs to say who is teaching; it does not need their
  // email address, their site, or anything else on Staff.
  staff: (e.staff || []).map((x) => ({ id: x.staffId, name: x.staff?.name || "" })),
  groups: (e.groups || []).map((x) => ({ id: x.cohortId, name: x.cohort?.name || "" })),
});

/**
 * One row in the "select timetables" picker, reduced to what a picker needs.
 *
 * A LABEL AND AN ID, AND NOTHING ELSE. This endpoint searches students and staff by
 * name, so anything extra returned here is a directory that every signed-in member
 * of staff can page through.
 */
function sResource(type, row) {
  switch (type) {
    case "room":    return { id: row.id, label: roomLabel(row), sub: row.kind || "" };
    case "staff":   return { id: row.id, label: row.name, sub: row.dept || "" };
    // Student has no `name` column — it is firstName + lastName + studentRef. The
    // REFERENCE is the label and the name is the subtitle, which is also how the
    // source system's picker reads ("FE00015", "FE00169"): a reference is unique and
    // a name is not, and a picker whose first line repeats for two people is a trap.
    case "student": return { id: row.id, label: row.studentRef || "", sub: `${row.firstName || ""} ${row.lastName || ""}`.trim() };
    case "group":   return { id: row.id, label: row.name, sub: row.course?.name || "" };
    case "module":  return { id: row.id, label: row.name, sub: row.code || "" };
    default:        return { id: row.id, label: String(row.name || row.id), sub: "" };
  }
}

module.exports = { sRoom, sCategory, sEvent, sResource, roomLabel };
```

- [ ] **Step 2: Verify the label assembly, which is the only logic here**

```bash
cd server && node -e "
const { roomLabel } = require('./src/timetabling/serialize');
const cases = [
  [{ name: '101', floor: 'First floor', campus: 'Great Titchfield Street' }, '101 - First floor [Great Titchfield Street]'],
  [{ name: '101', floor: '', campus: 'Harrow' }, '101 [Harrow]'],
  [{ name: '101', floor: '', campus: '' }, '101'],
];
let ok = true;
for (const [input, want] of cases) { const got = roomLabel(input); if (got !== want) { ok = false; console.log('FAIL', JSON.stringify(got), '!=', JSON.stringify(want)); } }
console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);"
```

Expected: `PASS`. The first two cases are the exact strings the reference institution displays.

- [ ] **Step 3: Commit**

```bash
git add server/src/timetabling/serialize.js
git commit -m "Allowlists on the way out, including for a picker that can search 9,000 students"
```

---

## Task 7: Rooms and categories, and the admin page key

**Files:**
- Create: `server/src/routes/timetabling.js`
- Modify: `server/src/index.js` (one `app.use`, beside the other tenant-scoped routers)
- Modify: `server/src/validate.js:61-64`
- Modify: `client/src/StaffHub.jsx:2194-2195`

**Interfaces:**
- Consumes: `../db`, `../auth` (`requireAuth`, `requirePage`), `../timetabling/serialize` (`sRoom`, `sCategory`).
- Produces: `GET|POST /api/timetabling/rooms`, `PUT|DELETE /api/timetabling/rooms/:id`, and the same five under `/categories`. Admin page key `"scheduling"`.

- [ ] **Step 1: Add `"scheduling"` to both copies of `ADMIN_PAGES`**

In `server/src/validate.js`, the array at line 61 — append `"scheduling"` after `"timetable"`:

```js
  "pat", "prediction", "mitigations", "staffreviews", "studentreviews", "studentqueries", "staff", "timesheets", "timetable", "scheduling", "admissions", "ism", "slc", "passwords", "settings",
```

In `client/src/StaffHub.jsx` line 2194, the same insertion; and at line 2195 add the label to `PAGE_LABELS`:

```js
timetable: "Timetable", scheduling: "Scheduling",
```

These two lists are hand-maintained copies and `CLAUDE.md` requires they stay in sync. A key in the server list but not the client's is a page nobody can grant; the reverse is a page that 403s after being granted.

- [ ] **Step 2: Verify the two lists match**

```bash
cd "c:/Users/Lenovo/Documents/Edtech" && node -e "
const { ADMIN_PAGES } = require('./server/src/validate');
const src = require('fs').readFileSync('client/src/StaffHub.jsx', 'utf8');
const m = src.match(/const ADMIN_PAGES = \[([^\]]*)\]/);
const client = m[1].split(',').map(s => s.trim().replace(/^[\"']|[\"']$/g, '')).filter(Boolean);
const same = JSON.stringify(ADMIN_PAGES) === JSON.stringify(client);
console.log(same ? 'PASS: in sync (' + ADMIN_PAGES.length + ' pages)' : 'FAIL\nserver: ' + ADMIN_PAGES.join(',') + '\nclient: ' + client.join(','));
process.exit(same ? 0 : 1);"
```

Expected: `PASS: in sync (32 pages)`.

- [ ] **Step 3: Create the router with rooms and categories**

Create `server/src/routes/timetabling.js`:

```js
// Timetabling — the planner half.
//
// This is where an administrator places an event and ASSIGNS a room, staff and
// groups to it, from real dropdowns backed by real foreign keys. The read-only half
// that staff use is routes/myTimetable.js.
//
// Gated on its own "scheduling" admin page, reads and writes both, because the whole
// section is administrative. It is deliberately a different page from "timetable",
// which still serves the older TimetableSlot screen and the student timetable.
const router = require("express").Router();
const prisma = require("../db");
const { requireAuth, requirePage } = require("../auth");
const { sRoom, sCategory } = require("../timetabling/serialize");

router.use(requireAuth, requirePage("scheduling"));

const str = (v) => (typeof v === "string" ? v.trim() : "");
const MAX = 200;

/* ------------------------------------------------------------------ rooms -- */

// Everything, including retired rooms: an administrator managing rooms is precisely
// the person who needs to see the retired ones. The staff-facing picker filters to
// active itself.
router.get("/rooms", async (_req, res) => {
  const rows = await prisma.room.findMany({ orderBy: [{ campus: "asc" }, { name: "asc" }] });
  res.json(rows.map(sRoom));
});

/** Validate a room body. `partial` allows omitted fields on update. */
function parseRoom(body, partial) {
  const data = {};
  const need = (k) => !partial || body?.[k] !== undefined;

  if (need("name")) {
    const name = str(body?.name);
    if (!name) return { error: "A room name is required" };
    data.name = name.slice(0, MAX);
  }
  if (body?.floor !== undefined) data.floor = str(body.floor).slice(0, MAX);
  if (body?.campus !== undefined) data.campus = str(body.campus).slice(0, MAX);
  if (body?.kind !== undefined) data.kind = str(body.kind).slice(0, MAX);
  if (body?.active !== undefined) data.active = !!body.active;

  if (body?.capacity !== undefined) {
    // Empty means "we have not recorded it" and is stored as NULL — NOT as 0. Zero
    // would say the room seats nobody, which a capacity check would later believe.
    if (body.capacity === null || body.capacity === "") data.capacity = null;
    else {
      const n = Number(body.capacity);
      if (!Number.isInteger(n) || n < 0 || n > 10000) return { error: "capacity must be a whole number of seats, or blank" };
      data.capacity = n;
    }
  }
  return { data };
}

router.post("/rooms", async (req, res) => {
  const { data, error } = parseRoom(req.body, false);
  if (error) return res.status(400).json({ error });
  try {
    const row = await prisma.room.create({ data });
    res.status(201).json(sRoom(row));
  } catch (e) {
    // The unique is (tenant, name, campus) — so this fires only for a genuine
    // duplicate on the same campus, not for room 101 existing at another site.
    if (e.code === "P2002") return res.status(409).json({ error: "That room already exists on that campus" });
    throw e;
  }
});

router.put("/rooms/:id", async (req, res) => {
  const { data, error } = parseRoom(req.body, true);
  if (error) return res.status(400).json({ error });
  try {
    const row = await prisma.room.update({ where: { id: req.params.id }, data });
    res.json(sRoom(row));
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ error: "That room already exists on that campus" });
    if (e.code === "P2025") return res.status(404).json({ error: "Room not found" });
    throw e;
  }
});

// Deleting a room does NOT delete the classes that were in it — the FK is SetNull.
// The events survive with no room, which is visibly wrong on the screen and
// therefore gets fixed; a silently vanished lecture does not.
//
// The count is returned so the screen can say so plainly rather than leaving an
// administrator to discover it.
router.delete("/rooms/:id", async (req, res) => {
  const affected = await prisma.timetableEvent.count({ where: { roomId: req.params.id } });
  try {
    await prisma.room.delete({ where: { id: req.params.id } });
    res.json({ ok: true, eventsLeftWithoutARoom: affected });
  } catch (e) {
    if (e.code === "P2025") return res.status(404).json({ error: "Room not found" });
    throw e;
  }
});

/* ------------------------------------------------------------- categories -- */

router.get("/categories", async (_req, res) => {
  const rows = await prisma.eventCategory.findMany({ orderBy: { name: "asc" } });
  res.json(rows.map(sCategory));
});

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function parseCategory(body, partial) {
  const data = {};
  const need = (k) => !partial || body?.[k] !== undefined;

  if (need("name")) {
    const name = str(body?.name);
    if (!name) return { error: "A category name is required" };
    data.name = name.slice(0, MAX);
  }
  if (body?.colour !== undefined) {
    const colour = str(body.colour);
    // Validated because it is written straight into a style attribute on the client.
    if (!HEX_RE.test(colour)) return { error: "colour must be a hex value like #1a3a8f" };
    data.colour = colour;
  }
  if (body?.active !== undefined) data.active = !!body.active;
  return { data };
}

router.post("/categories", async (req, res) => {
  const { data, error } = parseCategory(req.body, false);
  if (error) return res.status(400).json({ error });
  try {
    res.status(201).json(sCategory(await prisma.eventCategory.create({ data })));
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ error: "That category already exists" });
    throw e;
  }
});

router.put("/categories/:id", async (req, res) => {
  const { data, error } = parseCategory(req.body, true);
  if (error) return res.status(400).json({ error });
  try {
    res.json(sCategory(await prisma.eventCategory.update({ where: { id: req.params.id }, data })));
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ error: "That category already exists" });
    if (e.code === "P2025") return res.status(404).json({ error: "Category not found" });
    throw e;
  }
});

router.delete("/categories/:id", async (req, res) => {
  const affected = await prisma.timetableEvent.count({ where: { categoryId: req.params.id } });
  try {
    await prisma.eventCategory.delete({ where: { id: req.params.id } });
    res.json({ ok: true, eventsLeftWithoutACategory: affected });
  } catch (e) {
    if (e.code === "P2025") return res.status(404).json({ error: "Category not found" });
    throw e;
  }
});

module.exports = router;
```

- [ ] **Step 4: Mount it**

In `server/src/index.js`, immediately after line 112 (`app.use("/api/timetable", ...)`):

```js
app.use("/api/timetabling", wrapAsync(require("./routes/timetabling")));
```

It goes below `tenantMiddleware` with the rest — an administrator of a college is a college user, unlike `/api/platform` and `/api/registrations`.

- [ ] **Step 5: Verify the route is mounted and gated**

Start the API against the local database and probe. Per `CLAUDE.md`, **401 means mounted, 404 means not deployed** — with an existing route as the control.

```bash
cd server && DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" node src/index.js &
sleep 3
curl -s -o /dev/null -w "rooms=%{http_code} control=%{http_code}\n" http://localhost:4000/api/timetabling/rooms
curl -s -o /dev/null -w "timetabling/rooms -> %{http_code}\n" http://localhost:4000/api/timetabling/rooms
curl -s -o /dev/null -w "timetable (control) -> %{http_code}\n" http://localhost:4000/api/timetable/courses
kill %1
```

Expected: both `401`. A `404` on the first means the mount did not take.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/timetabling.js server/src/index.js server/src/validate.js client/src/StaffHub.jsx
git commit -m "Rooms become a table, and Scheduling becomes a page you can grant"
```

---

## Task 8: Events, with clash warnings

**Files:**
- Modify: `server/src/routes/timetabling.js` (append the events section)

**Interfaces:**
- Consumes: Task 7's router; `../timetabling/overlap` (`findClashes`); `../timetabling/serialize` (`sEvent`).
- Produces:
  - `GET /api/timetabling/events?from=&to=&roomId=&staffId=&cohortId=&unitId=&published=`
  - `POST /api/timetabling/events` → `201 { event, warnings }`
  - `PUT /api/timetabling/events/:id` → `200 { event, warnings }`
  - `DELETE /api/timetabling/events/:id`
  - Exported helper `EVENT_INCLUDE` and `checkClashes(candidate, { roomId, staffIds, cohortIds }): Promise<Array<{kind, resource, event}>>`

- [ ] **Step 1: Append the events section to `server/src/routes/timetabling.js`**

Insert before `module.exports = router;`:

```js
/* ----------------------------------------------------------------- events -- */

const { findClashes } = require("../timetabling/overlap");
const { sEvent } = require("../timetabling/serialize");

// Everything sEvent names. Kept in one constant because four handlers need the same
// shape and a query that forgets one of these returns an event whose room is null on
// the screen for no reason a reader could work out.
const EVENT_INCLUDE = {
  unit: { select: { code: true, name: true } },
  course: { select: { name: true } },
  room: { select: { id: true, name: true, floor: true, campus: true } },
  category: { select: { name: true, colour: true } },
  staff: { include: { staff: { select: { name: true } } } },
  groups: { include: { cohort: { select: { name: true } } } },
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const ids = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === "string" && x))] : []);

router.get("/events", async (req, res) => {
  const from = str(req.query.from), to = str(req.query.to);
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
  if (to < from) return res.status(400).json({ error: "to must not be before from" });

  const where = { date: { gte: from, lte: to } };
  if (str(req.query.roomId)) where.roomId = str(req.query.roomId);
  if (str(req.query.unitId)) where.unitId = str(req.query.unitId);
  if (str(req.query.staffId)) where.staff = { some: { staffId: str(req.query.staffId) } };
  if (str(req.query.cohortId)) where.groups = { some: { cohortId: str(req.query.cohortId) } };
  // Absent means BOTH. An administrator building next term needs to see the drafts
  // they are building; that is the difference between this router and the other one.
  if (req.query.published === "true") where.published = true;
  if (req.query.published === "false") where.published = false;

  const rows = await prisma.timetableEvent.findMany({
    where, include: EVENT_INCLUDE, orderBy: [{ date: "asc" }, { startTime: "asc" }],
  });
  res.json(rows.map(sEvent));
});

/** Validate an event body. `partial` allows omitted fields on update. */
function parseEvent(body, partial) {
  const data = {};
  const need = (k) => !partial || body?.[k] !== undefined;

  if (need("date")) {
    const date = str(body?.date);
    if (!DATE_RE.test(date)) return { error: "date must be YYYY-MM-DD" };
    data.date = date;
  }
  if (need("start")) {
    const s = str(body?.start);
    if (!TIME_RE.test(s)) return { error: "start must be HH:MM" };
    data.startTime = s;
  }
  if (need("end")) {
    const e = str(body?.end);
    if (!TIME_RE.test(e)) return { error: "end must be HH:MM" };
    data.endTime = e;
  }
  if (need("title")) {
    const t = str(body?.title);
    if (!t) return { error: "A title is required" };
    data.title = t.slice(0, MAX);
  }
  if (body?.notes !== undefined) data.notes = str(body.notes).slice(0, 4000);
  if (body?.published !== undefined) data.published = !!body.published;

  // Nullable relations. An empty string clears the link; that is how a screen says
  // "no room" without a separate verb.
  for (const [key, field] of [["unitId", "unitId"], ["courseId", "courseId"], ["roomId", "roomId"], ["categoryId", "categoryId"]]) {
    if (body?.[key] !== undefined) data[field] = str(body[key]) || null;
  }

  const start = data.startTime, end = data.endTime;
  if (start && end && end <= start) return { error: "The end time must be after the start time" };
  return { data };
}

/**
 * Who else is already using this room, these staff or these groups at this time.
 *
 * A WARNING, NOT A BLOCK, and the handlers below treat it as one. A college has
 * legitimate reasons to overlap — a room split between two half-groups, a lecturer
 * nominally on two registers — and a hard refusal gets worked around by saving the
 * event with the room left blank, which loses the information entirely. A visible
 * warning that somebody overrode is a record; a refusal is a data-entry workaround.
 */
async function checkClashes(candidate, { roomId, staffIds, cohortIds }) {
  const sameDay = await prisma.timetableEvent.findMany({
    where: {
      date: candidate.date,
      OR: [
        ...(roomId ? [{ roomId }] : []),
        ...(staffIds.length ? [{ staff: { some: { staffId: { in: staffIds } } } }] : []),
        ...(cohortIds.length ? [{ groups: { some: { cohortId: { in: cohortIds } } } }] : []),
      ],
    },
    include: EVENT_INCLUDE,
  });
  // OR with no branches matches everything in Prisma, so an event with no room, no
  // staff and no group would otherwise collect the entire day as a clash.
  if (!roomId && !staffIds.length && !cohortIds.length) return [];

  const out = [];
  for (const e of findClashes(candidate, sameDay)) {
    if (roomId && e.roomId === roomId) out.push({ kind: "room", resource: e.room ? e.room.name : "", event: sEvent(e) });
    for (const s of e.staff || []) if (staffIds.includes(s.staffId)) out.push({ kind: "staff", resource: s.staff?.name || "", event: sEvent(e) });
    for (const g of e.groups || []) if (cohortIds.includes(g.cohortId)) out.push({ kind: "group", resource: g.cohort?.name || "", event: sEvent(e) });
  }
  return out;
}

router.post("/events", async (req, res) => {
  const { data, error } = parseEvent(req.body, false);
  if (error) return res.status(400).json({ error });

  const staffIds = ids(req.body?.staffIds);
  const cohortIds = ids(req.body?.cohortIds);
  const warnings = await checkClashes({ ...data, id: null }, { roomId: data.roomId || null, staffIds, cohortIds });

  const row = await prisma.timetableEvent.create({
    data: {
      ...data,
      staff: staffIds.length ? { create: staffIds.map((staffId) => ({ staffId })) } : undefined,
      groups: cohortIds.length ? { create: cohortIds.map((cohortId) => ({ cohortId })) } : undefined,
    },
    include: EVENT_INCLUDE,
  });
  res.status(201).json({ event: sEvent(row), warnings });
});

router.put("/events/:id", async (req, res) => {
  const { data, error } = parseEvent(req.body, true);
  if (error) return res.status(400).json({ error });

  const existing = await prisma.timetableEvent.findUnique({ where: { id: req.params.id }, include: EVENT_INCLUDE });
  if (!existing) return res.status(404).json({ error: "Event not found" });

  // Assignments are replaced wholesale when sent, and untouched when omitted. A
  // screen that only moves the time must not silently drop the staff on the event.
  const staffIds = req.body?.staffIds === undefined ? (existing.staff || []).map((s) => s.staffId) : ids(req.body.staffIds);
  const cohortIds = req.body?.cohortIds === undefined ? (existing.groups || []).map((g) => g.cohortId) : ids(req.body.cohortIds);

  const candidate = {
    id: existing.id,
    date: data.date ?? existing.date,
    startTime: data.startTime ?? existing.startTime,
    endTime: data.endTime ?? existing.endTime,
  };
  if (candidate.endTime <= candidate.startTime) return res.status(400).json({ error: "The end time must be after the start time" });

  const roomId = data.roomId !== undefined ? data.roomId : existing.roomId;
  const warnings = await checkClashes(candidate, { roomId: roomId || null, staffIds, cohortIds });

  // changedAt tracks MOVEMENT — a retitled event has not moved, and highlighting it
  // as "recently changed" would train readers to ignore the highlight.
  const moved = (data.date && data.date !== existing.date) ||
                (data.startTime && data.startTime !== existing.startTime) ||
                (data.endTime && data.endTime !== existing.endTime) ||
                (data.roomId !== undefined && data.roomId !== existing.roomId);

  const row = await prisma.$transaction(async (tx) => {
    if (req.body?.staffIds !== undefined) {
      await tx.timetableEventStaff.deleteMany({ where: { eventId: existing.id } });
      if (staffIds.length) await tx.timetableEventStaff.createMany({ data: staffIds.map((staffId) => ({ eventId: existing.id, staffId })) });
    }
    if (req.body?.cohortIds !== undefined) {
      await tx.timetableEventGroup.deleteMany({ where: { eventId: existing.id } });
      if (cohortIds.length) await tx.timetableEventGroup.createMany({ data: cohortIds.map((cohortId) => ({ eventId: existing.id, cohortId })) });
    }
    return tx.timetableEvent.update({
      where: { id: existing.id },
      data: { ...data, ...(moved ? { changedAt: new Date() } : {}) },
      include: EVENT_INCLUDE,
    });
  });

  res.json({ event: sEvent(row), warnings });
});

router.delete("/events/:id", async (req, res) => {
  try {
    // The join rows go with it — those FKs are Cascade, unlike room and category,
    // because an assignment has no meaning without the event it assigns to.
    await prisma.timetableEvent.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === "P2025") return res.status(404).json({ error: "Event not found" });
    throw e;
  }
});
```

- [ ] **Step 2: Verify the routes answer**

```bash
cd server && DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" node src/index.js &
sleep 3
curl -s -o /dev/null -w "events -> %{http_code}\n" "http://localhost:4000/api/timetabling/events?from=2026-09-01&to=2026-09-30"
kill %1
```

Expected: `401` (mounted and gated). Task 13's smoke suite exercises the behaviour with a real token.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/timetabling.js
git commit -m "Events with real assignments, and the first clash check this codebase has ever had"
```

---

## Task 9: Weekly repeat and publish

**Files:**
- Modify: `server/src/routes/timetabling.js` (append)

**Interfaces:**
- Consumes: Task 8's `EVENT_INCLUDE`, `checkClashes`; `../timetabling/recurrence` (`weeklyDates`); `../bankHolidays`.
- Produces:
  - `POST /api/timetabling/events/:id/repeat` `{ until, skipBankHolidays?, skip? }` → `{ created, dates, warnings }`
  - `POST /api/timetabling/events/publish` `{ from, to, published }` → `{ updated }`

- [ ] **Step 1: Check the bank-holiday helper's export shape**

```bash
cd server && node -e "console.log(Object.keys(require('./src/bankHolidays')))"
```

Note the exported function name; the code below assumes a function returning an array of `YYYY-MM-DD` strings for a year. If the shape differs, adapt the one call site and say so in the commit message.

- [ ] **Step 2: Append the repeat and publish handlers**

Insert before `module.exports = router;` in `server/src/routes/timetabling.js`:

```js
/* ---------------------------------------------------- repeat and publish -- */

const { weeklyDates } = require("../timetabling/recurrence");
const bankHolidays = require("../bankHolidays");

/**
 * Copy one event forward, weekly, to `until`.
 *
 * This exists because hand-entering twelve weeks of a Tuesday lecture is not a
 * feature, it is a reason a tool goes unused.
 *
 * Bank holidays are skipped BY DEFAULT but the caller can say otherwise. The
 * register generator does not consult bankHolidays.js at all, which is why registers
 * get generated on Easter Monday; that is a known defect and this does not repeat
 * it. It stays a flag rather than a rule because whether a college teaches on a
 * given holiday is that college's policy, and hardcoding one answer to somebody
 * else's policy is the worse failure.
 */
router.post("/events/:id/repeat", async (req, res) => {
  const until = str(req.body?.until);
  if (!DATE_RE.test(until)) return res.status(400).json({ error: "until must be YYYY-MM-DD" });

  const source = await prisma.timetableEvent.findUnique({ where: { id: req.params.id }, include: EVENT_INCLUDE });
  if (!source) return res.status(404).json({ error: "Event not found" });
  if (until <= source.date) return res.status(400).json({ error: "until must be after the event's own date" });

  const skip = new Set(ids(req.body?.skip));
  if (req.body?.skipBankHolidays !== false) {
    const years = new Set([source.date.slice(0, 4), until.slice(0, 4)]);
    for (const y of years) for (const d of bankHolidays.forYear(Number(y)) || []) skip.add(d);
  }

  // The source date itself is dropped: the event already exists on it, and copying
  // it would double-book the room against itself on day one.
  const dates = weeklyDates(source.date, until, { skip: [...skip] }).filter((d) => d !== source.date);

  const staffIds = (source.staff || []).map((s) => s.staffId);
  const cohortIds = (source.groups || []).map((g) => g.cohortId);

  const warnings = [];
  let created = 0;
  for (const date of dates) {
    const candidate = { id: null, date, startTime: source.startTime, endTime: source.endTime };
    const found = await checkClashes(candidate, { roomId: source.roomId || null, staffIds, cohortIds });
    // Reported per date rather than as one lump, because "week 4 clashes" is
    // actionable and "there were clashes" is not.
    if (found.length) warnings.push({ date, clashes: found });

    await prisma.timetableEvent.create({
      data: {
        date, startTime: source.startTime, endTime: source.endTime,
        title: source.title, notes: source.notes,
        unitId: source.unitId, courseId: source.courseId,
        roomId: source.roomId, categoryId: source.categoryId,
        published: source.published,
        staff: staffIds.length ? { create: staffIds.map((staffId) => ({ staffId })) } : undefined,
        groups: cohortIds.length ? { create: cohortIds.map((cohortId) => ({ cohortId })) } : undefined,
      },
    });
    created++;
  }

  res.json({ created, dates, warnings });
});

/**
 * Flip `published` across a date range. This is the one switch that makes a term's
 * work visible to staff, exactly as TimetableSlot's publish flag governs what
 * students see.
 */
router.post("/events/publish", async (req, res) => {
  const from = str(req.body?.from), to = str(req.body?.to);
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
  if (to < from) return res.status(400).json({ error: "to must not be before from" });
  if (typeof req.body?.published !== "boolean") return res.status(400).json({ error: "published must be true or false" });

  const { count } = await prisma.timetableEvent.updateMany({
    where: { date: { gte: from, lte: to } },
    data: { published: req.body.published },
  });
  // NOT a changedAt bump. Publishing does not move anything; marking a whole term as
  // "recently changed" the moment it goes live would make the highlight meaningless
  // on the first day anybody used it.
  res.json({ updated: count });
});
```

- [ ] **Step 3: Verify the module still loads**

```bash
cd server && node -e "require('./src/routes/timetabling'); console.log('PASS: router loads')"
```

Expected: `PASS: router loads`.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/timetabling.js
git commit -m "Repeat weekly, skipping the bank holidays the register generator forgets"
```

---

## Task 10: The college's settings endpoint

**Files:**
- Modify: `server/src/routes/timetabling.js` (append)

**Interfaces:**
- Consumes: `../timetabling/settings` (`getTenant`, `saveTenant`), `../timetabling/settingsDefaults` (`DEFAULTS`).
- Produces: `GET /api/timetabling/settings` → `{ defaults, tenant }`; `PUT /api/timetabling/settings` → `{ tenant }`.

- [ ] **Step 1: Append the handlers**

Insert before `module.exports = router;`:

```js
/* --------------------------------------------------------------- settings -- */

const timetableSettings = require("../timetabling/settings");
const { DEFAULTS: SETTINGS_DEFAULTS } = require("../timetabling/settingsDefaults");

/**
 * What the college has set, and what it would be if it set nothing.
 *
 * Both, deliberately. The screen needs to show an administrator which values are
 * theirs and which are inherited — otherwise "reset to default" has nothing to reset
 * to, and every field looks equally deliberate.
 */
router.get("/settings", async (_req, res) => {
  res.json({ defaults: SETTINGS_DEFAULTS, tenant: await timetableSettings.getTenant() });
});

// A patch: the screen sends the field it changed. Unknown and invalid keys are
// dropped by cleanTenant rather than stored, so a client sending nonsense cannot
// park it in the column for a later reader to trip over.
router.put("/settings", async (req, res) => {
  const saved = await timetableSettings.saveTenant(req.body || {}, req.user?.name || req.user?.email || "");
  res.json({ tenant: saved });
});
```

- [ ] **Step 2: Verify the module loads and the settings module is wired**

```bash
cd server && node -e "
require('./src/routes/timetabling');
const s = require('./src/timetabling/settingsDefaults');
console.log(s.DEFAULTS.notice && !s.USER_FIELDS.includes('notice') ? 'PASS' : 'FAIL');"
```

Expected: `PASS`.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/timetabling.js
git commit -m "The college's timetable settings, with the defaults sent alongside so 'inherited' is visible"
```

---

## Task 11: The resource picker

**Files:**
- Create: `server/src/routes/myTimetable.js`
- Modify: `server/src/index.js` (one `app.use`)

**Interfaces:**
- Consumes: `../db`, `../auth` (`requireAuth`), `../timetabling/serialize` (`sResource`).
- Produces: `GET /api/my-timetable/resources?type=&q=&limit=` → `{ type, total, results: [{id,label,sub}] }`. Types: `module | room | staff | student | group`.

- [ ] **Step 1: Create the router**

Create `server/src/routes/myTimetable.js`:

```js
// The timetable a member of staff READS. The planner half is routes/timetabling.js.
//
// requireAuth ONLY — no requirePage. Every lecturer reads their own timetable, and
// gating that on an admin page would mean granting an admin page to the entire
// teaching staff, which is the opposite of what page grants are for.
//
// Student and applicant tokens cannot reach here at all: they are confined by the
// STUDENT_ROUTERS / APPLICANT_ROUTERS allowlists in auth.js, and this router is in
// neither. That is closed-by-default and is why there is no per-route check for it;
// smoke-timetabling.mjs asserts it rather than trusting the comment.
const router = require("express").Router();
const prisma = require("../db");
const { requireAuth } = require("../auth");
const { sResource } = require("../timetabling/serialize");

router.use(requireAuth);

const str = (v) => (typeof v === "string" ? v.trim() : "");

// A picker, not an export. The reference institution's list runs to 9,009 students,
// and a limit is what keeps this from becoming a way to page the whole directory
// into a file.
const MAX_LIMIT = 50;

/**
 * Search one resource type.
 *
 * ALL FIVE TYPES ARE OPEN TO ANY SIGNED-IN MEMBER OF STAFF, matching the system this
 * reproduces. That includes looking up a named student's week, which is a larger
 * disclosure than anything else in the staff app — a decision taken deliberately and
 * recorded in the design document, not an oversight. Narrowing it later means
 * removing types from this switch and nothing else.
 */
router.get("/resources", async (req, res) => {
  const type = str(req.query.type);
  const q = str(req.query.q).slice(0, 100);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || 25));
  const like = { contains: q, mode: "insensitive" };

  let rows = [], total = 0;
  switch (type) {
    case "room": {
      // Active only. The planner shows retired rooms because it manages them; a
      // reader looking for somewhere to be should not be offered one.
      const where = { active: true, ...(q ? { OR: [{ name: like }, { campus: like }] } : {}) };
      [rows, total] = await Promise.all([
        prisma.room.findMany({ where, orderBy: [{ campus: "asc" }, { name: "asc" }], take: limit }),
        prisma.room.count({ where }),
      ]);
      break;
    }
    case "staff": {
      const where = q ? { name: like } : {};
      [rows, total] = await Promise.all([
        prisma.staff.findMany({ where, orderBy: { name: "asc" }, take: limit, select: { id: true, name: true, dept: true } }),
        prisma.staff.count({ where }),
      ]);
      break;
    }
    case "student": {
      // Requiring a query for students is deliberate. Every other type is small
      // enough to browse; this one is thousands of named people, and an empty search
      // returning the first 25 of them makes the picker a directory you scroll.
      if (!q) return res.json({ type, total: 0, results: [], needsQuery: true });
      // There is no `name` column on Student — it is firstName, lastName and
      // studentRef. All three are searched, because a member of staff looking a
      // student up has whichever one they happen to be holding.
      const where = { OR: [{ firstName: like }, { lastName: like }, { studentRef: like }] };
      [rows, total] = await Promise.all([
        prisma.student.findMany({ where, orderBy: [{ lastName: "asc" }, { firstName: "asc" }], take: limit, select: { id: true, firstName: true, lastName: true, studentRef: true } }),
        prisma.student.count({ where }),
      ]);
      break;
    }
    case "group": {
      const where = q ? { name: like } : {};
      [rows, total] = await Promise.all([
        prisma.cohort.findMany({ where, orderBy: { name: "asc" }, take: limit, select: { id: true, name: true, course: { select: { name: true } } } }),
        prisma.cohort.count({ where }),
      ]);
      break;
    }
    case "module": {
      const where = q ? { OR: [{ name: like }, { code: like }] } : {};
      [rows, total] = await Promise.all([
        prisma.unit.findMany({ where, orderBy: { name: "asc" }, take: limit, select: { id: true, name: true, code: true } }),
        prisma.unit.count({ where }),
      ]);
      break;
    }
    default:
      return res.status(400).json({ error: "type must be one of: module, room, staff, student, group" });
  }

  res.json({ type, total, results: rows.map((r) => sResource(type, r)) });
});

module.exports = router;
```

- [ ] **Step 2: Mount it**

In `server/src/index.js`, immediately after the `/api/timetabling` line from Task 7:

```js
app.use("/api/my-timetable", wrapAsync(require("./routes/myTimetable")));
```

- [ ] **Step 3: Verify it is mounted**

```bash
cd server && DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" node src/index.js &
sleep 3
curl -s -o /dev/null -w "resources -> %{http_code}\n" "http://localhost:4000/api/my-timetable/resources?type=room"
kill %1
```

Expected: `401`.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/myTimetable.js server/src/index.js
git commit -m "The resource picker, with students behind a search box on purpose"
```

---

## Task 12: The staff timetable read, and My Settings

**Files:**
- Modify: `server/src/routes/myTimetable.js` (append)

**Interfaces:**
- Consumes: Task 11's router; `../timetabling/serialize` (`sEvent`); `../timetabling/settings` (`getEffective`, `saveUser`, `getTenant`).
- Produces:
  - `GET /api/my-timetable?from=&to=&type=&ids=` → `{ from, to, scope, events, settings }`
  - `GET /api/my-timetable/settings` → `{ settings, tenant }`
  - `PUT /api/my-timetable/settings` → `{ settings }`

- [ ] **Step 1: Append the handlers**

Insert before `module.exports = router;` in `server/src/routes/myTimetable.js`:

```js
/* ------------------------------------------------------- the timetable -- */

const { sEvent } = require("../timetabling/serialize");
const timetableSettings = require("../timetabling/settings");

// Repeated from routes/timetabling.js rather than shared, because the two routers
// must be able to diverge: this one will grow a "published only" constraint that the
// planner must never inherit.
const EVENT_INCLUDE = {
  unit: { select: { code: true, name: true } },
  course: { select: { name: true } },
  room: { select: { id: true, name: true, floor: true, campus: true } },
  category: { select: { name: true, colour: true } },
  staff: { include: { staff: { select: { name: true } } } },
  groups: { include: { cohort: { select: { name: true } } } },
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A window, not a firehose. Twelve months is more than any view asks for — the
// widest is a month — and it stops a hand-written request pulling every event the
// college has ever held.
const MAX_WINDOW_DAYS = 366;

const daysBetween = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

/**
 * The events this reader asked for, in a date window.
 *
 * With no `type`, the answer is THEIR OWN teaching — the equivalent of the source
 * system's "My Resources" checkbox, which is its entire answer to "my timetable".
 * That is one join on an id. It is not a match on their name, and the difference is
 * the whole point of the module: two lecturers sharing a surname would otherwise see
 * each other's classes with nothing reporting it.
 *
 * PUBLISHED ONLY, always. A draft term an administrator is still building must not
 * appear in a lecturer's app, where it would be indistinguishable from a real one.
 */
router.get("/", async (req, res) => {
  const from = str(req.query.from), to = str(req.query.to);
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
  if (to < from) return res.status(400).json({ error: "to must not be before from" });
  if (daysBetween(from, to) > MAX_WINDOW_DAYS) return res.status(400).json({ error: "That date range is too wide — ask for a year or less" });

  const type = str(req.query.type);
  const wanted = str(req.query.ids).split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20);

  let scope, where = { published: true, date: { gte: from, lte: to } };
  if (!type || !wanted.length) {
    scope = { type: "me", ids: [req.user.id] };
    where.staff = { some: { staffId: req.user.id } };
  } else {
    scope = { type, ids: wanted };
    switch (type) {
      case "room":    where.roomId = { in: wanted }; break;
      case "staff":   where.staff = { some: { staffId: { in: wanted } } }; break;
      case "group":   where.groups = { some: { cohortId: { in: wanted } } }; break;
      case "module":  where.unitId = { in: wanted }; break;
      case "student": {
        // A student's timetable is derived rather than stored: the groups they are
        // in, plus the units they are enrolled on. A third join table naming
        // individual students would earn its keep only for one-to-one tutorials,
        // which nothing has asked for.
        const students = await prisma.student.findMany({
          where: { id: { in: wanted } },
          select: { cohortId: true, enrolments: { select: { unitId: true } } },
        });
        const cohortIds = [...new Set(students.map((s) => s.cohortId).filter(Boolean))];
        const unitIds = [...new Set(students.flatMap((s) => s.enrolments.map((e) => e.unitId)))];
        // No cohort and no enrolments means no timetable — not "every event".
        if (!cohortIds.length && !unitIds.length) {
          return res.json({ from, to, scope, events: [], settings: await timetableSettings.getEffective(req.user.id) });
        }
        where.OR = [
          ...(cohortIds.length ? [{ groups: { some: { cohortId: { in: cohortIds } } } }] : []),
          ...(unitIds.length ? [{ unitId: { in: unitIds } }] : []),
        ];
        break;
      }
      default: return res.status(400).json({ error: "type must be one of: module, room, staff, student, group" });
    }
  }

  const [rows, settings] = await Promise.all([
    prisma.timetableEvent.findMany({ where, include: EVENT_INCLUDE, orderBy: [{ date: "asc" }, { startTime: "asc" }] }),
    // Sent WITH the events, in one round trip. The grid cannot draw a row until it
    // knows which periods and days to draw, so a second request would mean a visible
    // reflow on every load.
    timetableSettings.getEffective(req.user.id),
  ]);

  res.json({ from, to, scope, events: rows.map(sEvent), settings });
});

/* --------------------------------------------------------- my settings -- */

// The merged view is what the screen renders; the college's own layer is sent
// alongside so "reset to the college default" has something to reset to.
router.get("/settings", async (req, res) => {
  const [settings, tenant] = await Promise.all([
    timetableSettings.getEffective(req.user.id),
    timetableSettings.getTenant(),
  ]);
  res.json({ settings, tenant });
});

// A patch of this person's own overrides. `notice` is not in USER_FIELDS and is
// silently dropped: the banner is the college's statement about itself, and an
// individual editing their copy would be editing what every reader is told.
router.put("/settings", async (req, res) => {
  await timetableSettings.saveUser(req.user.id, req.body || {});
  res.json({ settings: await timetableSettings.getEffective(req.user.id) });
});
```

- [ ] **Step 2: Verify the module loads**

```bash
cd server && node -e "require('./src/routes/myTimetable'); console.log('PASS: router loads')"
```

Expected: `PASS: router loads`.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/myTimetable.js
git commit -m "My timetable, answered by a join on an id rather than a match on a name"
```

---

## Task 13: The smoke suite

**Files:**
- Create: `scripts/smoke-timetabling.mjs`

**Interfaces:**
- Consumes: every endpoint from Tasks 7–12.
- Produces: a suite `npm test` discovers by its `smoke-*.mjs` filename.

- [ ] **Step 1: Confirm how the runner discovers suites**

```bash
cd "c:/Users/Lenovo/Documents/Edtech" && grep -rn "smoke-" scripts/run-tests.mjs 2>/dev/null | head -5 || ls scripts/*.mjs | head
```

If discovery is by glob, no registration step is needed. If suites are listed explicitly, add `smoke-timetabling` to that list in the same commit.

- [ ] **Step 2: Write the suite**

Create `scripts/smoke-timetabling.mjs`:

```js
// CELCAT-style timetabling — the planner, the staff read, and the settings.
//
// Weighted toward NEGATIVE assertions like the other suites: who is refused, what
// never leaves the building, what a draft does not show.
//
// The assertion that matters most is "a lecturer's timetable is found by ID, not by
// name" — that is the entire reason this module exists rather than a screen over
// TimetableSlot.
//
// Prereq: API running on http://localhost:4000  (npm run dev)
// Usage:  DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" node scripts/smoke-timetabling.mjs
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
const require = createRequire(pathToFileURL(join(ROOT, "server", "package.json")));
const { PrismaClient } = require(`${ROOT}/server/node_modules/@prisma/client`);
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required — point it at a throwaway database."); process.exit(1); }
// A bare client, deliberately: it verifies what the API did, so nothing injects a
// tenant for it. Used only to clear mustChangePassword, which no endpoint exposes —
// smoke-account-deletion.mjs does the same for the same reason.
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const BASE = process.env.API_URL || "http://localhost:4000/api";
const SEED_PW = process.env.SEED_PASSWORD || "password123";
const TAG = `tt${Date.now()}`;
let pass = 0, fail = 0;
const check = (l, ok, d = "") => { console.log(`${ok ? "✓" : "✗"} ${l}${d ? "  — " + d : ""}`); ok ? pass++ : fail++; };

async function call(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

const admin = (await call("/auth/login", { method: "POST", body: { email: "admin@edtech.co.uk", password: SEED_PW } })).data;
if (!admin?.token) { console.error("Could not sign in as the seeded admin — run the seed first."); process.exit(1); }

console.log("\n--- guards ---");
check("anonymous cannot list rooms", (await call("/timetabling/rooms")).status === 401);
check("anonymous cannot read a timetable", (await call("/my-timetable?from=2026-09-01&to=2026-09-07")).status === 401);

// A lecturer with NO admin pages. This is the account the whole feature is for, and
// the one that must be refused by the planner.
const lecturerEmail = `${TAG}.lecturer@edtech.co.uk`;
const lecturer = (await call("/staff", { method: "POST", token: admin.token, body: { name: `Zed ${TAG}`, email: lecturerEmail, password: "LecturerPass123!" } })).data;
// No endpoint clears this — a newly created account is forced to change its password
// before it can do anything, which would block every assertion below.
await db.staff.update({ where: { id: lecturer.id }, data: { mustChangePassword: false } });
const lecturerToken = (await call("/auth/login", { method: "POST", body: { email: lecturerEmail, password: "LecturerPass123!" } })).data?.token;
check("the test lecturer could sign in", !!lecturerToken);

check("a lecturer with no pages is refused by the planner", (await call("/timetabling/rooms", { token: lecturerToken })).status === 403);
check("a lecturer CAN reach their own timetable", (await call("/my-timetable?from=2026-09-01&to=2026-09-07", { token: lecturerToken })).status === 200);

console.log("\n--- rooms ---");
const roomA = (await call("/timetabling/rooms", { method: "POST", token: admin.token, body: { name: `101-${TAG}`, floor: "First floor", campus: "Harrow" } })).data;
check("a room was created", !!roomA?.id);
check("its label reads as the source system's does", roomA?.label === `101-${TAG} - First floor [Harrow]`, roomA?.label);
check("capacity left blank is NULL, not 0", roomA?.capacity === null, String(roomA?.capacity));

const dupSame = await call("/timetabling/rooms", { method: "POST", token: admin.token, body: { name: `101-${TAG}`, campus: "Harrow" } });
check("the same room on the same campus is refused", dupSame.status === 409);
const dupOther = await call("/timetabling/rooms", { method: "POST", token: admin.token, body: { name: `101-${TAG}`, campus: "Great Titchfield Street" } });
check("the SAME room number on another campus is allowed", dupOther.status === 201);

console.log("\n--- events and clash detection ---");
const cat = (await call("/timetabling/categories", { method: "POST", token: admin.token, body: { name: `Lecture-${TAG}`, colour: "#1a3a8f" } })).data;
check("a category was created", !!cat?.id);
check("a non-hex colour is refused", (await call("/timetabling/categories", { method: "POST", token: admin.token, body: { name: `Bad-${TAG}`, colour: "red" } })).status === 400);

const D = "2026-09-01";
const mk = (body) => call("/timetabling/events", { method: "POST", token: admin.token, body });

const e1 = (await mk({ date: D, start: "09:00", end: "11:00", title: `First ${TAG}`, roomId: roomA.id, categoryId: cat.id, staffIds: [lecturer.id] })).data;
check("an event was created", !!e1?.event?.id);
check("the first event has no clashes", e1?.warnings?.length === 0);

const backToBack = await mk({ date: D, start: "11:00", end: "13:00", title: `Back to back ${TAG}`, roomId: roomA.id });
check("BACK-TO-BACK IN THE SAME ROOM IS NOT A CLASH", backToBack.data?.warnings?.length === 0, JSON.stringify(backToBack.data?.warnings));

const roomClash = await mk({ date: D, start: "10:00", end: "12:00", title: `Overlap ${TAG}`, roomId: roomA.id });
check("a genuine room double-booking IS reported", roomClash.data?.warnings?.some((w) => w.kind === "room"));
check("and it was still saved — a warning, not a block", !!roomClash.data?.event?.id);

const staffClash = await mk({ date: D, start: "10:00", end: "12:00", title: `Staff clash ${TAG}`, staffIds: [lecturer.id] });
check("a staff double-booking is reported", staffClash.data?.warnings?.some((w) => w.kind === "staff"));

const otherDay = await mk({ date: "2026-09-02", start: "09:00", end: "11:00", title: `Other day ${TAG}`, roomId: roomA.id });
check("the same room on a different date is not a clash", otherDay.data?.warnings?.length === 0);

const noResources = await mk({ date: D, start: "09:30", end: "10:30", title: `Unassigned ${TAG}` });
check("an event with no room, staff or group reports no clashes", noResources.data?.warnings?.length === 0, JSON.stringify(noResources.data?.warnings));

console.log("\n--- an unpublished event is invisible to staff ---");
const mine = await call(`/my-timetable?from=${D}&to=${D}`, { token: lecturerToken });
check("the lecturer sees no DRAFT events, though one names them", (mine.data?.events || []).length === 0, `saw ${(mine.data?.events || []).length}`);

await call("/timetabling/events/publish", { method: "POST", token: admin.token, body: { from: D, to: D, published: true } });
const minePub = await call(`/my-timetable?from=${D}&to=${D}`, { token: lecturerToken });
const titles = (minePub.data?.events || []).map((e) => e.title);
check("once published, the lecturer sees the events naming them", titles.includes(`First ${TAG}`), titles.join(" | "));
check("and NOT the ones that do not name them", !titles.includes(`Back to back ${TAG}`), titles.join(" | "));

console.log("\n--- my timetable is found by id, not by name ---");
// The whole point of the module. A second staff member whose name CONTAINS the
// first's would be swept up by any name match; an id join cannot confuse them.
const twinEmail = `${TAG}.twin@edtech.co.uk`;
const twin = (await call("/staff", { method: "POST", token: admin.token, body: { name: `Zed ${TAG} Junior`, email: twinEmail, password: "TwinPass123!" } })).data;
await db.staff.update({ where: { id: twin.id }, data: { mustChangePassword: false } });
const twinToken = (await call("/auth/login", { method: "POST", body: { email: twinEmail, password: "TwinPass123!" } })).data?.token;
const twinSees = await call(`/my-timetable?from=${D}&to=${D}`, { token: twinToken });
check("a colleague whose name CONTAINS the lecturer's sees none of their classes", (twinSees.data?.events || []).length === 0, `saw ${(twinSees.data?.events || []).length}`);

console.log("\n--- the resource picker ---");
const rooms = await call("/my-timetable/resources?type=room", { token: lecturerToken });
check("a lecturer can search rooms", rooms.status === 200 && Array.isArray(rooms.data?.results));
const students = await call("/my-timetable/resources?type=student", { token: lecturerToken });
check("students need a search term rather than listing everyone", students.data?.needsQuery === true && students.data?.results?.length === 0);
check("an unknown resource type is refused", (await call("/my-timetable/resources?type=wizards", { token: lecturerToken })).status === 400);

console.log("\n--- settings ---");
const badKey = await call("/timetabling/settings", { method: "PUT", token: admin.token, body: { view: "day", isSuperUser: true, view2: "spiral" } });
check("an unknown settings key is DROPPED, not stored", badKey.data?.tenant && !("isSuperUser" in badKey.data.tenant) && !("view2" in badKey.data.tenant), JSON.stringify(badKey.data?.tenant));
check("a valid key was kept", badKey.data?.tenant?.view === "day");
check("an invalid value for a known key is dropped", (await call("/timetabling/settings", { method: "PUT", token: admin.token, body: { view: "spiral" } })).data?.tenant?.view === "day");

await call("/timetabling/settings", { method: "PUT", token: admin.token, body: { notice: { enabled: true, text: "College says" } } });
await call("/my-timetable/settings", { method: "PUT", token: lecturerToken, body: { notice: { enabled: true, text: "I say" }, view: "month" } });
const eff = await call("/my-timetable/settings", { token: lecturerToken });
check("a lecturer's own view overrides the college's", eff.data?.settings?.view === "month", eff.data?.settings?.view);
check("A LECTURER CANNOT REWRITE THE COLLEGE'S NOTICE", eff.data?.settings?.notice?.text === "College says", eff.data?.settings?.notice?.text);

console.log("\n--- date windows ---");
check("a missing date range is refused", (await call("/my-timetable", { token: lecturerToken })).status === 400);
check("an inverted range is refused", (await call("/my-timetable?from=2026-09-30&to=2026-09-01", { token: lecturerToken })).status === 400);
check("an absurdly wide range is refused", (await call("/my-timetable?from=2020-01-01&to=2030-01-01", { token: lecturerToken })).status === 400);

console.log("\n--- deleting a room keeps its classes ---");
const del = await call(`/timetabling/rooms/${roomA.id}`, { method: "DELETE", token: admin.token });
check("the room was deleted", del.status === 200);
check("and it said how many events lost their room", typeof del.data?.eventsLeftWithoutARoom === "number" && del.data.eventsLeftWithoutARoom > 0, String(del.data?.eventsLeftWithoutARoom));
const survivor = await call(`/timetabling/events?from=${D}&to=${D}`, { token: admin.token });
check("the classes that were in it still exist, with no room", (survivor.data || []).some((e) => e.title === `First ${TAG}` && e.room === null));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 3: Run the suite against the local database**

```bash
cd "c:/Users/Lenovo/Documents/Edtech" && DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- smoke-timetabling
```

Expected: every check `✓`, exit 0. Any `✗` is a real defect — fix the route, not the assertion.

- [ ] **Step 4: Prove the two load-bearing tests can fail**

A test that passes while discriminating nothing is not coverage, and that has happened twice recently.

1. In `routes/myTimetable.js`, temporarily replace `where.staff = { some: { staffId: req.user.id } }` with a name match: `where.staff = { some: { staff: { name: { contains: req.user.name } } } }`. Re-run. **"a colleague whose name CONTAINS the lecturer's sees none of their classes" must fail.** Revert.
2. In `routes/myTimetable.js`, temporarily drop `published: true` from the `where`. Re-run. **"the lecturer sees no DRAFT events" must fail.** Revert.

```bash
cd "c:/Users/Lenovo/Documents/Edtech" && DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- smoke-timetabling
```

Expected while broken: the named check fails. After reverting: all pass.

- [ ] **Step 5: Run the whole suite, to prove nothing else moved**

```bash
cd "c:/Users/Lenovo/Documents/Edtech" && DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test
```

Expected: the previously passing suites still pass, plus `smoke-timetabling`. `SKIP` is not `PASS` — a skipped suite is a switched-off feature, not coverage.

- [ ] **Step 6: Commit**

```bash
git add scripts/smoke-timetabling.mjs
git commit -m "Prove the lecturer's timetable is theirs, and that a draft is nobody's"
```

---

## Done when

- [ ] `node --test "src/**/*.test.js"` passes from `server/`, including the four new files.
- [ ] `DATABASE_URL=…edtech_dev npm test` passes, including `smoke-timetabling`.
- [ ] `npm run --workspace client build` succeeds (the `ADMIN_PAGES` edit is the only client change in this plan, and the client has no test framework).
- [ ] `git status` is clean.

Then Plan 2 — the client — can be written against endpoints that exist.
