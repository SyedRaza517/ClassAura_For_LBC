# Academic Departments — Foundation (Spec 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the `AcademicDepartment` model, a central scope guard that cannot be forgotten, and the screens to configure it — while changing what every existing user sees by exactly nothing.

**Architecture:** A real `AcademicDepartment` table sits above `Course`. Scope for a request is resolved inside `requireAuth` (the only place every authenticated request passes through, because 41 of 43 routers apply auth per-handler rather than per-router) and bound with `AsyncLocalStorage`. A Prisma client extension consults a per-model declaration and injects the predicate; a model absent from the declaration throws, and so does a scoped query with no bound scope. Raw SQL cannot be reached by the extension, so the six existing `$queryRawUnsafe` calls take an explicit predicate from a helper that throws. Nothing is filtered in this spec: the migration marks every existing staff account college-wide, so the injected predicate is empty.

**Tech Stack:** Node 20 + Express, Prisma 5 + PostgreSQL, `node:test` for unit tests, `scripts/smoke-*.mjs` for HTTP suites, React 18 + Vite for the client.

**Spec:** [docs/superpowers/specs/2026-09-04-academic-departments-design.md](../specs/2026-09-04-academic-departments-design.md)

## Global Constraints

- **Naming: `academicDepartment`, never bare `department`.** `Referral.department`, `Staff.supportDepartments` and `SupportDepartmentConfig` already mean Wellbeing/ASK/Student Support. No bare `department` identifier — column, variable, parameter or route segment — is introduced by this work. (Spec §4)
- **`ADMIN_PAGES` gains no keys.** The Departments screen lives under the existing `settings` page. Membership is a column, not a grantable page. This avoids touching the two hand-maintained `ADMIN_PAGES` copies. (Spec §8)
- **Never rename a migration directory once applied anywhere.** A rename makes an applied migration look new, it re-runs, fails, and Prisma then refuses every later migration with P3009. This has happened twice on this project. The directory is `20260904T120000_academic_departments`. (CLAUDE.md)
- **Always pass `DATABASE_URL` on the command line.** Never let it fall through to `server/.env`, which points at live Supabase. Every command in this plan uses `postgresql://postgres:postgres@localhost:5432/edtech_dev`.
- **Never use `node --test src/`** — a bare directory makes the runner walk into `src/index.js`, which binds a port and starts the schedulers, and the run never terminates. Always use the glob `"src/**/*.test.js"` or a named file.
- **Null means "not measurable", never zero.** A student with no department is excluded from per-department denominators, never counted as zero.
- **Serialise through allowlists, never blocklists.** (The `sAdmission` lesson.)
- **Prove every new test can fail** by reintroducing the bug it guards, and say so in the commit. Twice in recent work a test passed while discriminating nothing.
- **Comments explain WHY, at length, including why an alternative was rejected.** This is the house style and it is load-bearing.
- **What this plan deliberately does NOT do.** Spec §8 says `sStudent` and `sCourse` gain an `academicDepartment` field — that is **spec 2**, where a row's department is first displayed. Adding it here would ship a field nothing reads and nothing tests. Likewise `Cohort` and `Unit` get their own `academicDepartmentId` column in spec 2, not here. This plan touches `sStaff` (Task 5) and adds `sAcademicDepartment` (Task 7), and no other serialiser.
- **Task 10 is the one task without literal code**, and that is deliberate: `StaffHub.jsx` is ~12k lines with no test framework, so its conventions have to be matched in situ by reading the surrounding panel rather than pasted from a plan. Every behaviour it must exhibit is specified; the JSX is not.

---

### Task 1: The `academicDepartments.js` validator

Pure logic, no database, tests beside it. Mirrors `server/src/supportDepartments.js`, which is the reference implementation for runtime-editable college configuration.

**Files:**
- Create: `server/src/academicDepartments.js`
- Create: `server/src/academicDepartments.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `KEY_RE: RegExp`, `cleanOne(d) -> {key,name,colour,active}|null`, `cleanList(list) -> Array|null`, `all() -> Promise<Array>`, `active() -> Promise<Array>`, `byKey(key) -> Promise<Object|null>`, `invalidate() -> void`. Task 7 consumes `cleanList` and `invalidate`; Task 9 consumes `all`.

- [ ] **Step 1: Write the failing test**

Create `server/src/academicDepartments.test.js`:

```js
// The pure half of academicDepartments.js: what a college may store as its academic
// organisation chart.
//
// No database. Requiring the module constructs the shared Prisma client but issues no
// query, and nothing below reaches all(), active(), byKey() or save().
//
// Run with: node --test src/academicDepartments.test.js   (from server/)
//
// WHY THE KEY RULES ARE LOAD-BEARING. Unlike a support-department key, this key is not
// stored on every row — Course and Student carry the department's cuid id. But the key
// IS what a saved filter, a URL fragment and the VLE mapping screen carry, and it can
// never be edited afterwards without orphaning them. So this function is the only place
// a bad key can be stopped.
const test = require("node:test");
const assert = require("node:assert/strict");

const { cleanOne, cleanList, KEY_RE } = require("./academicDepartments");

test("KEY_RE accepts lower case, digits and hyphens, and nothing else", () => {
  for (const good of ["business", "computing", "health-social-care", "a", "law2", "a".repeat(40)]) {
    assert.equal(KEY_RE.test(good), true, `${good} should be a valid key`);
  }
});

test("KEY_RE rejects a key with a space, capitals, or over 40 characters", () => {
  // The key travels in a URL fragment and a query string. One that needs escaping
  // would work in the browser that created it and break in the next one to read it.
  for (const bad of ["health social care", "Business", "", "a".repeat(41), "law!"]) {
    assert.equal(KEY_RE.test(bad), false, `${bad} should be rejected`);
  }
});

test("cleanOne is an allowlist — an unknown field is dropped, not stored", () => {
  // A blocklist ships every column added afterwards to the browser by default. This is
  // the sAdmission lesson, applied before there is anything to leak.
  const out = cleanOne({ key: "business", name: "Business", colour: "#112233", active: true, secret: "x", id: "y" });
  assert.deepEqual(Object.keys(out).sort(), ["active", "colour", "key", "name"]);
});

test("cleanOne defaults active to true and only false switches it off", () => {
  assert.equal(cleanOne({ key: "law", name: "Law" }).active, true);
  assert.equal(cleanOne({ key: "law", name: "Law", active: false }).active, false);
  // A truthy non-boolean must not be read as "retired".
  assert.equal(cleanOne({ key: "law", name: "Law", active: 0 }).active, true);
});

test("cleanOne rejects a row with no usable key or no name", () => {
  assert.equal(cleanOne({ key: "Business", name: "Business" }), null);
  assert.equal(cleanOne({ key: "business", name: "   " }), null);
  assert.equal(cleanOne(null), null);
});

test("cleanOne lowercases the key and trims and caps the name", () => {
  assert.equal(cleanOne({ key: "  BUSINESS  ", name: "  Business  " }).key, "business");
  assert.equal(cleanOne({ key: "business", name: "x".repeat(200) }).name.length, 60);
});

test("cleanOne falls back to the platform colour when none is given or it is malformed", () => {
  // The colour is rendered straight into a style attribute. Anything that is not a
  // six-digit hex is replaced rather than escaped, because a value that needs escaping
  // is a value that will eventually be rendered somewhere that forgets to.
  assert.equal(cleanOne({ key: "law", name: "Law" }).colour, "#1a3a8f");
  assert.equal(cleanOne({ key: "law", name: "Law", colour: "red" }).colour, "#1a3a8f");
  assert.equal(cleanOne({ key: "law", name: "Law", colour: "#ABCDEF" }).colour, "#abcdef");
});

test("cleanList collapses duplicate keys to the FIRST occurrence", () => {
  // Two departments sharing a key make one unreachable: the mapping screen, the saved
  // filter and the membership check all match on the key alone.
  const out = cleanList([
    { key: "business", name: "Business" },
    { key: "business", name: "Business Studies" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "Business");
});

test("cleanList drops invalid rows rather than rejecting the whole submission", () => {
  const out = cleanList([{ key: "business", name: "Business" }, { key: "BAD KEY", name: "x" }]);
  assert.deepEqual(out.map((d) => d.key), ["business"]);
});

test("cleanList returns null for a non-array, and caps the list at 50", () => {
  assert.equal(cleanList("business"), null);
  assert.equal(cleanList(null), null);
  const many = Array.from({ length: 80 }, (_, i) => ({ key: `d${i}`, name: `D${i}` }));
  assert.equal(cleanList(many).length, 50);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && node --test src/academicDepartments.test.js
```

Expected: FAIL — `Cannot find module './academicDepartments'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/academicDepartments.js`:

```js
// The college's own list of ACADEMIC departments — Business, Computing, Law, Health &
// Social Care — resolved and cached.
//
// NOT THE SAME THING AS supportDepartments.js, and the difference is the whole reason
// this file exists separately. That file lists WELLBEING TEAMS: who reads a student's
// disclosure. This one lists TEACHING DEPARTMENTS: which courses and students a member
// of staff may see at all. Two access boundaries with one English word between them, so
// every identifier here is `academicDepartment` and never a bare `department`. CLAUDE.md
// records that the `outcome` collision caused three bugs by a fix landing on the wrong
// vocabulary; this collision would grant the wrong people the wrong records.
//
// A REAL TABLE, NOT A JSON CONFIG COLUMN, which is the other difference from
// supportDepartments.js. A support department is deliberately keyless of foreign keys so
// a referral outlives its team. An academic department is joined to from Course and
// Student on the hottest query path in the application, and a JSON blob cannot be
// indexed. Deletion safety comes from onDelete: SetNull instead — the same choice
// Unit.courseId already makes so that registers never vanish with a deleted course.
//
// Everything else follows supportDepartments.js exactly: platform defaults in code, an
// allowlist on the way out, and a short cache invalidated on save.
const prisma = require("./db");

const TTL_MS = Number(process.env.ACADEMIC_DEPARTMENTS_CACHE_MS ?? 30_000);
let cached = null; // { value, at } | null

function invalidate() {
  cached = null;
}

// A key is a slug: lower case, digits and hyphens. Narrow on purpose. Course and Student
// carry the department's cuid id rather than this key, so the key is not on every row —
// but it IS what a saved filter, a URL fragment and the VLE mapping screen carry, and it
// can never be edited afterwards without orphaning them.
const KEY_RE = /^[a-z0-9-]{1,40}$/;
// Six-digit hex only. The colour is rendered into a style attribute; anything else is
// replaced rather than escaped, because a value that needs escaping is one that will
// eventually reach somewhere that forgets to.
const COLOUR_RE = /^#[0-9a-f]{6}$/;
const DEFAULT_COLOUR = "#1a3a8f";

const str = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * Clean one submitted department. Returns null if it cannot be made valid.
 *
 * An ALLOWLIST, not a blocklist: exactly four fields are read and everything else a
 * client sends is dropped rather than stored. sAdmission is the cautionary tale — it
 * stripped a fixed list of secrets, so every column added afterwards shipped to the
 * browser by default.
 */
function cleanOne(d) {
  const key = str(d?.key).toLowerCase();
  const name = str(d?.name);
  if (!KEY_RE.test(key)) return null;
  if (!name) return null;
  const colour = str(d?.colour).toLowerCase();
  return {
    key,
    name: name.slice(0, 60),
    colour: COLOUR_RE.test(colour) ? colour : DEFAULT_COLOUR,
    // `!== false` rather than Boolean(): a college that omits the field means "active",
    // and a truthy non-boolean must not be read as "retired".
    active: d?.active !== false,
  };
}

/**
 * Clean a whole submitted list. Duplicate keys collapse to the FIRST occurrence — two
 * departments sharing a key would make one of them unreachable, because the mapping
 * screen, a saved filter and every membership check match on the key alone.
 *
 * An invalid row is DROPPED rather than failing the whole submission, matching
 * supportDepartments.cleanList: an administrator editing eight departments should not
 * lose seven edits to one typo.
 */
function cleanList(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  const seen = new Set();
  for (const d of list.slice(0, 50)) {
    const c = cleanOne(d);
    if (!c || seen.has(c.key)) continue;
    seen.add(c.key);
    out.push(c);
  }
  return out;
}

/**
 * Every department this college has, retired ones included.
 *
 * NO DEFAULTS. supportDepartments.js ships three, because a college with no wellbeing
 * team configured still has students to refer. There is no equivalent here: inventing a
 * "General" department and letting courses fall into it is exactly the silent fail-open
 * the migration was written to avoid (spec §6.6). An empty list is the correct answer
 * for a college that has not set its departments up, and the Settings screen says so.
 */
async function all() {
  if (TTL_MS > 0 && cached && Date.now() - cached.at < TTL_MS) return cached.value;

  let rows = [];
  try {
    rows = await prisma.academicDepartment.findMany({ orderBy: { name: "asc" } });
  } catch {
    // Table not migrated yet. An empty list is the correct answer rather than an error —
    // the same fallback attendanceBandConfig.js and supportDepartments.js make, and what
    // keeps a half-deployed environment showing a working screen instead of a stack trace.
    rows = [];
  }
  const value = rows.map((r) => ({
    id: r.id, key: r.key, name: r.name, colour: r.colour, active: r.active,
  }));
  cached = { value, at: Date.now() };
  return value;
}

/** Only the departments a college is currently running. */
async function active() {
  return (await all()).filter((d) => d.active);
}

/** One department by its slug, retired ones included. Null when there is no such key. */
async function byKey(key) {
  const k = str(key).toLowerCase();
  if (!KEY_RE.test(k)) return null;
  return (await all()).find((d) => d.key === k) || null;
}

module.exports = {
  KEY_RE, COLOUR_RE, DEFAULT_COLOUR,
  cleanOne, cleanList, invalidate,
  all, active, byKey,
};
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd server && node --test src/academicDepartments.test.js
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/academicDepartments.js server/src/academicDepartments.test.js
git commit -m "Academic departments: the validator that decides what a college may store

Mirrors supportDepartments.js, and is deliberately a separate file: that one
lists wellbeing teams, this one lists teaching departments, and one English
word sits between two access boundaries.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Schema, migration, and the naming contract test

**Files:**
- Modify: `server/prisma/schema.prisma` (add two models; add columns to `Course`, `Student`, `Staff`)
- Create: `server/prisma/migrations/20260904T120000_academic_departments/migration.sql`
- Create: `server/src/academicDepartmentNaming.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma models `AcademicDepartment` and `StaffAcademicDepartment`; fields `Course.academicDepartmentId`, `Student.academicDepartmentId`, `Staff.collegeWide`, `Course.vleCategoryExternalId`, `Course.vleCategoryName`. Tasks 4, 7, 9 and 10 all depend on these exact names.

- [ ] **Step 1: Write the failing test**

Create `server/src/academicDepartmentNaming.test.js`:

```js
// The two department vocabularies must stay disjoint, and the schema is where that is
// enforced.
//
// WHY THIS TEST EXISTS. `Referral.department`, `ReferralTransfer.fromDepartment` and
// `Staff.supportDepartments` mean Wellbeing / ASK / Student Support — who may read a
// student's disclosure. `Course.academicDepartmentId` and `Student.academicDepartmentId`
// mean Business / Computing / Law — which students a member of staff may see at all.
// Both are access boundaries. CLAUDE.md records that the `outcome` collision (an
// intervention's outcome versus a StudentOutcome) caused three bugs, twice landing a fix
// on the wrong vocabulary. A mix-up here grants the wrong people the wrong records, so
// the rule is mechanical: an academic-department field is spelled `academicDepartment…`
// and nothing else in the schema may be.
//
// Run with: node --test src/academicDepartmentNaming.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const SCHEMA = readFileSync(join(__dirname, "..", "prisma", "schema.prisma"), "utf8");

test("the academic department model and join table exist", () => {
  assert.match(SCHEMA, /model AcademicDepartment \{/);
  assert.match(SCHEMA, /model StaffAcademicDepartment \{/);
});

test("Course, Student and Staff carry the new columns, spelled exactly", () => {
  assert.match(SCHEMA, /academicDepartmentId\s+String\?/);
  assert.match(SCHEMA, /collegeWide\s+Boolean\s+@default\(false\)/);
  assert.match(SCHEMA, /vleCategoryExternalId\s+String\?/);
  assert.match(SCHEMA, /vleCategoryName\s+String\?/);
});

test("no schema field is named a bare `department` outside the support-referral models", () => {
  // The support-referral models legitimately own the bare word. Everything else must
  // qualify it. This is the assertion that stops a later reader adding
  // `Course.department` beside `Course.academicDepartmentId` and creating exactly the
  // ambiguity the prefix exists to prevent.
  const SUPPORT_MODELS = ["SupportDepartmentConfig", "Referral", "ReferralTransfer", "ReferralMessage"];
  const blocks = SCHEMA.split(/^model /m).slice(1);
  for (const block of blocks) {
    const name = block.split(/\s/)[0];
    if (SUPPORT_MODELS.includes(name)) continue;
    const offenders = [...block.matchAll(/^\s{2}(department\w*)\s/gm)].map((m) => m[1]);
    assert.deepEqual(offenders, [], `model ${name} declares a bare department field: ${offenders.join(", ")}`);
  }
});

test("the academic department relations set null on delete, never cascade", () => {
  // Deleting a department must never delete courses, students or the registers hanging
  // off them. This is the choice Unit.courseId already makes for the same reason.
  const academicRefs = [...SCHEMA.matchAll(/academicDepartment\s+AcademicDepartment\?[^\n]*\n/g)].map((m) => m[0]);
  assert.ok(academicRefs.length >= 2, "expected Course and Student to reference AcademicDepartment");
  for (const ref of academicRefs) {
    assert.match(ref, /onDelete: SetNull/, `relation must SetNull, got: ${ref.trim()}`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && node --test src/academicDepartmentNaming.test.js
```

Expected: FAIL — `model AcademicDepartment` not found in the schema.

- [ ] **Step 3: Add the models and columns to the schema**

Append to `server/prisma/schema.prisma`:

```prisma
/// The college's own list of ACADEMIC departments — Business, Computing, Law.
///
/// NOT SupportDepartmentConfig, which lists wellbeing teams. See academicDepartments.js
/// for why the two are kept apart down to the spelling of every identifier.
///
/// A REAL TABLE with real foreign keys, unlike SupportDepartmentConfig's JSON column.
/// Course and Student join to it on the hottest query path in the application and a JSON
/// blob cannot be indexed. Deletion safety is onDelete: SetNull on the referencing side.
model AcademicDepartment {
  id     String  @id @default(cuid())
  /// Slug, [a-z0-9-]{1,40}. IMMUTABLE once created: a saved filter, a URL fragment and
  /// the VLE mapping screen all carry it, and none of them re-resolves it afterwards.
  key    String  @unique
  name   String
  colour String  @default("#1a3a8f")
  /// A retired department keeps its courses and students — it simply stops being
  /// offered as a destination. Deleting is the destructive option and is guarded in
  /// the route layer; this is the reversible one.
  active Boolean @default(true)

  createdAt DateTime @default(now())

  courses  Course[]
  students Student[]
  staff    StaffAcademicDepartment[]

  @@index([active])
}

/// Which academic departments a member of staff may see.
///
/// A JOIN TABLE, NOT A JSON ARRAY, and that is the one place this deliberately diverges
/// from Staff.supportDepartments. That column is a JSON string array because a support
/// department has no row to point at. This does have a row, and the membership is a
/// SECURITY boundary: a JSON array can hold a key that was typo'd (granting nothing,
/// silently) or renamed (granting something else, silently). A foreign key cannot.
model StaffAcademicDepartment {
  id                   String             @id @default(cuid())
  staff                Staff              @relation(fields: [staffId], references: [id], onDelete: Cascade)
  staffId              String
  academicDepartment   AcademicDepartment @relation(fields: [academicDepartmentId], references: [id], onDelete: Cascade)
  academicDepartmentId String
  createdAt            DateTime           @default(now())

  @@unique([staffId, academicDepartmentId])
  @@index([academicDepartmentId])
}
```

In `model Course`, add:

```prisma
  /// Which academic department owns this course. NULL means "not assigned", which is
  /// visible only to college-wide accounts — see the migration for why nothing is
  /// backfilled into a default department.
  academicDepartment   AcademicDepartment? @relation(fields: [academicDepartmentId], references: [id], onDelete: SetNull)
  academicDepartmentId String?
  /// The VLE's OWN grouping for this course, captured verbatim so the college can map
  /// it to a department once. Moodle's categoryid, Canvas's account_id, Blackboard's
  /// category. Captured even before any mapping exists, because it is free — the sync
  /// already has it — and it is the evidence the mapping screen is built from.
  ///
  /// A plain string, not a foreign key: it identifies a row in somebody else's
  /// database, which may be renumbered or deleted without telling us.
  vleCategoryExternalId String?
  /// The grouping's display name, where the token is permitted to read it. NULL means
  /// "we could not see it", NOT "it has no name" — a Moodle whose token lacks
  /// core_course_get_categories still yields ids, and the mapping screen shows those
  /// with their course counts so an admin can name them by looking inside.
  vleCategoryName       String?
```

...and add `@@index([academicDepartmentId])` plus `@@index([vleCategoryExternalId])` to the `Course` model.

In `model Student`, add:

```prisma
  /// Which academic department this student belongs to.
  ///
  /// A STORED COLUMN, NOT DERIVED THROUGH THE COHORT, and that is forced rather than
  /// chosen. Student.cohortId is itself nullable, so deriving
  /// Student -> Cohort -> Course -> AcademicDepartment leaves every cohortless student
  /// belonging to no department and therefore invisible to every scoped account. It is
  /// also a two-hop join on the most frequent query in the application.
  ///
  /// The cost is denormalisation drift, and it is paid where the cohort is written:
  /// assigning or changing a cohort writes this column in the same transaction, and
  /// smoke-academic-departments.mjs asserts it.
  academicDepartment   AcademicDepartment? @relation(fields: [academicDepartmentId], references: [id], onDelete: SetNull)
  academicDepartmentId String?
```

...and add `@@index([academicDepartmentId])` to the `Student` model.

In `model Staff`, add:

```prisma
  /// Lifts the departmental boundary entirely — Principal, Registrar, Super Admin.
  ///
  /// Deliberately a separate flag from isSuperAdmin. Holding every admin page is a
  /// statement about administrative authority; seeing every department's students is a
  /// statement about academic reach, and the two are not the same person at every
  /// college. This is the same reasoning that keeps supportDepartments un-ignored for a
  /// Super Admin.
  collegeWide Boolean @default(false)

  academicDepartments StaffAcademicDepartment[]
```

- [ ] **Step 4: Generate the migration and hand-edit the backfill**

```bash
cd server
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npx prisma migrate dev --name academic_departments --create-only
```

Rename the generated directory to exactly `20260904T120000_academic_departments` **now, before it is applied anywhere** — after that it must never be renamed again (P3009, twice on this project).

Append to the generated `migration.sql`:

```sql
-- Every existing staff account becomes college-wide.
--
-- THE DEPLOY FAILS OPEN, LOUDLY, AND THAT IS THE DELIBERATE CHOICE. The alternative
-- locks the entire college out of every student mid-term for a change that is otherwise
-- invisible to them — the same reasoning CLAUDE.md gives for IGNORING rather than
-- rejecting the stale `tid` claim. Mitigation is visibility, not tightening: the
-- Departments screen carries a permanent "N staff have college-wide access" line.
UPDATE "Staff" SET "collegeWide" = true;

-- NOTHING ELSE IS BACKFILLED. No default department is created and no Course or Student
-- is assigned one.
--
-- Seeding a "General" department and putting every course in it looks tidier and is a
-- silent fail-open: the first time the college narrows somebody off college-wide, that
-- person is scoped to a department containing the entire institution and the screen
-- tells them nothing is wrong. Leaving everything unassigned inverts it — a newly
-- scoped account sees NOTHING until departments are genuinely set up, which is loud and
-- safe. serializers.js already states this rule for parseAdminPages: "An admin who
-- suddenly has no pages is a loud, safe failure; an admin who suddenly has all of them
-- is a silent, dangerous one."
--
-- It also avoids minting a department whose key is immutable and immediately wrong the
-- moment the college renames it to "Business".
```

- [ ] **Step 5: Apply the migration and regenerate the client**

```bash
cd server
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npx prisma migrate deploy
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npx prisma generate
```

Expected: migration applied, client regenerated. If `edtech_dev` does not exist, create it first with `CREATE DATABASE edtech_dev` and re-run.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd server && node --test src/academicDepartmentNaming.test.js && node --test src/academicDepartments.test.js
```

Expected: PASS.

- [ ] **Step 7: Prove the naming test can fail**

Temporarily add `department String?` to `model Course`, re-run `node --test src/academicDepartmentNaming.test.js`, and confirm it FAILS with `model Course declares a bare department field`. Remove it and confirm PASS again.

- [ ] **Step 8: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations/20260904T120000_academic_departments server/src/academicDepartmentNaming.test.js
git commit -m "AcademicDepartment, its join table, and the columns that hang off it

The migration marks every existing staff account college-wide and backfills
NOTHING ELSE. A seeded default department would put the whole institution in
one bucket, so the first account narrowed off college-wide would be scoped to
everything and told nothing was wrong.

The naming test was proved able to fail by adding a bare Course.department.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The scope holder (`academicScope.js`)

**Files:**
- Create: `server/src/academicScope.js`
- Create: `server/src/academicScope.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `runWithAcademicScope(scope, fn)`, `withoutAcademicScope(reason, fn)`, `currentScope() -> {academicDepartmentIds, collegeWide}|null`, `AcademicScopeError`. Tasks 4, 5 and 6 all consume these.

- [ ] **Step 1: Write the failing test**

Create `server/src/academicScope.test.js`:

```js
// The request-scoped holder for "which academic departments may this caller see".
//
// No database, no Express. Run with: node --test src/academicScope.test.js (from server/)
//
// WHY ASYNCLOCALSTORAGE AND NOT A PARAMETER. 41 of the 43 routers apply requireAuth per
// HANDLER rather than per router, so there is no single middleware seam to thread a
// scope argument through, and ~275 handlers would each have to remember to pass it. A
// handler that forgets fails OPEN and silently. db.js records this exact reasoning for
// the tenant era: "Rather than ask ~200 endpoints to remember a filter, the client
// itself refused."
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  runWithAcademicScope, withoutAcademicScope, currentScope, AcademicScopeError,
} = require("./academicScope");

test("currentScope is null outside any scope", () => {
  assert.equal(currentScope(), null);
});

test("runWithAcademicScope makes the scope readable inside, and only inside", () => {
  const scope = { academicDepartmentIds: ["a", "b"], collegeWide: false };
  runWithAcademicScope(scope, () => {
    assert.deepEqual(currentScope(), scope);
  });
  assert.equal(currentScope(), null);
});

test("the scope survives an await", async () => {
  // The whole point: a handler that awaits a Prisma call must still be inside its scope
  // when the query is issued.
  await runWithAcademicScope({ academicDepartmentIds: ["a"], collegeWide: false }, async () => {
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(currentScope().academicDepartmentIds, ["a"]);
  });
});

test("nested scopes do not leak outward", async () => {
  await runWithAcademicScope({ academicDepartmentIds: ["outer"], collegeWide: false }, async () => {
    await runWithAcademicScope({ academicDepartmentIds: ["inner"], collegeWide: false }, async () => {
      assert.deepEqual(currentScope().academicDepartmentIds, ["inner"]);
    });
    assert.deepEqual(currentScope().academicDepartmentIds, ["outer"]);
  });
});

test("withoutAcademicScope grants college-wide and records why", async () => {
  await withoutAcademicScope("prediction: institution-wide probes", async () => {
    assert.equal(currentScope().collegeWide, true);
    assert.deepEqual(currentScope().academicDepartmentIds, []);
    assert.equal(currentScope().reason, "prediction: institution-wide probes");
  });
});

test("withoutAcademicScope refuses to run without a reason", async () => {
  // The reason is the entire audit trail for a deliberate widening. An unnamed one is
  // indistinguishable from a forgotten one, and greppability is the only thing keeping
  // this from becoming the silent default it replaced.
  await assert.rejects(
    () => withoutAcademicScope("", async () => {}),
    (e) => e instanceof AcademicScopeError && /reason/i.test(e.message),
  );
});

test("runWithAcademicScope rejects a malformed scope rather than coercing it", async () => {
  // A scope object that is wrong in shape must not silently become "see nothing" or
  // "see everything". Both are wrong answers and only one of them is safe.
  for (const bad of [null, undefined, {}, { collegeWide: false }, { academicDepartmentIds: "a", collegeWide: false }]) {
    assert.throws(() => runWithAcademicScope(bad, () => {}), AcademicScopeError);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && node --test src/academicScope.test.js
```

Expected: FAIL — `Cannot find module './academicScope'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/academicScope.js`:

```js
// WHICH ACADEMIC DEPARTMENTS THE CURRENT CALLER MAY SEE, held for the life of a request.
//
// WHY THIS EXISTS AT ALL, given that this project deleted machinery of exactly this
// shape. Until 30 Aug 2026 db.js scoped every query by tenantId and threw when a query
// had no tenant. That went because the product became one deployment per college, so
// isolation moved into the infrastructure. This is NOT that coming back:
//
//   * It is one institution, not many. Nothing here spans customers.
//   * It is PARTIAL. A Semester belongs to no department, and declaring that is the
//     point of the model list in db.js — a blanket extension would be wrong.
//   * It has a designed all-access role (Staff.collegeWide). Tenancy deliberately had
//     none, which is why crossTenant() had to exist as an escape hatch.
//
// WHY AsyncLocalStorage RATHER THAN A PARAMETER. 41 of the 43 routers apply requireAuth
// per HANDLER, not per router, so there is no single seam to thread an argument through.
// Passing it explicitly means ~275 handlers each remembering, and the one that forgets
// fails OPEN and silently. db.js states the same conclusion for the same reason.
//
// WHY THERE IS NO runInAcademicDepartment(). The tax db.js names for the old design was
// that "every scheduler, script and tool had to name the institution it meant". Work
// outside a request does not name a department here — it declares that it is
// institution-wide, once, with a reason, via withoutAcademicScope(). That keeps the
// widening loud and greppable without making ordinary background code carry an id.
const { AsyncLocalStorage } = require("node:async_hooks");

class AcademicScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = "AcademicScopeError";
  }
}

const storage = new AsyncLocalStorage();

/** The scope bound to the current async context, or null if there is none. */
function currentScope() {
  return storage.getStore() || null;
}

function assertScopeShape(scope) {
  if (!scope || typeof scope !== "object") {
    throw new AcademicScopeError("An academic scope must be an object");
  }
  if (!Array.isArray(scope.academicDepartmentIds)) {
    throw new AcademicScopeError("academicDepartmentIds must be an array");
  }
  if (typeof scope.collegeWide !== "boolean") {
    throw new AcademicScopeError("collegeWide must be a boolean");
  }
}

/**
 * Run `fn` with `scope` bound. The scope survives every await inside `fn`.
 *
 * The shape is asserted rather than coerced. A malformed scope silently becoming "see
 * nothing" or "see everything" are both wrong, and only one of them is safe — so
 * neither is guessed at.
 */
function runWithAcademicScope(scope, fn) {
  assertScopeShape(scope);
  return storage.run(scope, fn);
}

/**
 * Run `fn` as institution-wide, saying why.
 *
 * For schedulers, the prediction runner, the VLE sync and any other work that has no
 * caller and legitimately spans every department. The prediction pipeline in particular
 * MUST run this way: CLAUDE.md records that computing its institution-wide probes from
 * a subset is the most repeated bug in that area, and departmental scoping must not
 * narrow them.
 *
 * `reason` is mandatory. It is the entire audit trail for a deliberate widening, and an
 * unnamed widening is indistinguishable from a forgotten one. It also makes every such
 * site greppable, which is what keeps this from quietly becoming the default it replaced.
 */
function withoutAcademicScope(reason, fn) {
  const why = typeof reason === "string" ? reason.trim() : "";
  if (!why) {
    return Promise.reject(new AcademicScopeError("withoutAcademicScope requires a reason saying why this work is institution-wide"));
  }
  return storage.run({ academicDepartmentIds: [], collegeWide: true, reason: why }, fn);
}

module.exports = {
  AcademicScopeError, runWithAcademicScope, withoutAcademicScope, currentScope,
};
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd server && node --test src/academicScope.test.js
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/academicScope.js server/src/academicScope.test.js
git commit -m "The request-scoped holder for academic department scope

AsyncLocalStorage rather than a parameter, for the reason db.js gives: 41 of 43
routers apply auth per handler, so a threaded argument means ~275 handlers each
remembering, and the one that forgets fails open and silently.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The model declaration and the Prisma extension

**Files:**
- Create: `server/src/academicScopeModels.js`
- Modify: `server/src/db.js`
- Create: `server/src/academicScopeModels.test.js`

**Interfaces:**
- Consumes: `currentScope`, `AcademicScopeError` from Task 3; the Prisma model names from Task 2.
- Produces: `MODEL_SCOPE` (a map of model name → `"UNSCOPED" | {column} | {via}`), `scopePredicateFor(model, scope)`. Task 8's smoke suite asserts the behaviour this creates.

- [ ] **Step 1: Write the failing test**

Create `server/src/academicScopeModels.test.js`:

```js
// The declaration that says, for every Prisma model, how it is scoped to an academic
// department — and the predicate builder that turns it into a `where` clause.
//
// No database. Run with: node --test src/academicScopeModels.test.js (from server/)
//
// WHY A DECLARATION AND NOT AN INFERENCE. The tenant extension this replaces could
// assume every model had a tenantId. This one cannot: a Semester belongs to no
// department, a Course belongs to one directly, and an AttendanceMark belongs to one
// only through its student. Guessing from the presence of a column would silently leave
// every new model unscoped, which is the fail-open db.js records as lost when the
// old guard went.
const test = require("node:test");
const assert = require("node:assert/strict");

const { MODEL_SCOPE, scopePredicateFor } = require("./academicScopeModels");
const { AcademicScopeError } = require("./academicScope");

const SCOPED = { academicDepartmentIds: ["d1", "d2"], collegeWide: false };
const WIDE = { academicDepartmentIds: [], collegeWide: true };

test("every model in the Prisma schema is declared exactly once", () => {
  // The assertion that makes adding a model a DECISION. A new model absent from the map
  // must not default to unscoped.
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const schema = readFileSync(join(__dirname, "..", "prisma", "schema.prisma"), "utf8");
  const declared = [...schema.matchAll(/^model (\w+) \{/gm)].map((m) => m[1]);
  const missing = declared.filter((m) => !(m in MODEL_SCOPE));
  assert.deepEqual(missing, [], `undeclared models: ${missing.join(", ")}`);
  const extra = Object.keys(MODEL_SCOPE).filter((m) => !declared.includes(m));
  assert.deepEqual(extra, [], `declared but not in schema: ${extra.join(", ")}`);
});

test("an unscoped model gets no predicate at all", () => {
  assert.equal(scopePredicateFor("Semester", SCOPED), null);
  assert.equal(scopePredicateFor("AcademicDepartment", SCOPED), null);
});

test("a column-scoped model filters on its own id list", () => {
  assert.deepEqual(scopePredicateFor("Course", SCOPED), {
    academicDepartmentId: { in: ["d1", "d2"] },
  });
  assert.deepEqual(scopePredicateFor("Student", SCOPED), {
    academicDepartmentId: { in: ["d1", "d2"] },
  });
});

test("a relation-scoped model filters through its owner", () => {
  assert.deepEqual(scopePredicateFor("AttendanceMark", SCOPED), {
    student: { academicDepartmentId: { in: ["d1", "d2"] } },
  });
  assert.deepEqual(scopePredicateFor("Enrolment", SCOPED), {
    student: { academicDepartmentId: { in: ["d1", "d2"] } },
  });
});

test("a college-wide scope produces no predicate for any model", () => {
  // This is what makes spec 1 inert: the migration marks every account college-wide, so
  // the guard is live and filters nothing.
  assert.equal(scopePredicateFor("Course", WIDE), null);
  assert.equal(scopePredicateFor("AttendanceMark", WIDE), null);
});

test("a scoped model with an EMPTY department list matches nothing, never everything", () => {
  // The single most dangerous case. A member of staff who has been narrowed off
  // college-wide but not yet given any department must see nothing. `{ in: [] }` is
  // Prisma's "matches nothing", and it is deliberately not shortcut to `null`.
  assert.deepEqual(scopePredicateFor("Course", { academicDepartmentIds: [], collegeWide: false }), {
    academicDepartmentId: { in: [] },
  });
});

test("an undeclared model throws rather than passing unscoped", () => {
  assert.throws(() => scopePredicateFor("SomeModelAddedTomorrow", SCOPED), AcademicScopeError);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && node --test src/academicScopeModels.test.js
```

Expected: FAIL — `Cannot find module './academicScopeModels'`.

- [ ] **Step 3: Write the declaration**

Create `server/src/academicScopeModels.js`. Build `MODEL_SCOPE` by listing **every** model in `schema.prisma` — the first test enforces completeness, so run it and let it tell you which names are missing rather than transcribing by eye.

```js
// HOW EACH PRISMA MODEL IS SCOPED TO AN ACADEMIC DEPARTMENT.
//
// Three kinds, and every model in schema.prisma is exactly one of them:
//
//   "UNSCOPED"          — belongs to no department. A Semester, every config table,
//                         every HR and audit table until spec 4 moves them.
//   { column: "…" }     — carries academicDepartmentId itself.
//   { via: "relation" } — reachable through an owner that carries it.
//
// A MODEL ABSENT FROM THIS MAP THROWS. That is the whole design. db.js records that the
// tenant guard's "fail-closed guard on unrecognised operations" was lost when it went,
// and that a Prisma upgrade adding an operation could then slip past unscoped. The same
// hazard applies to a MODEL added by a later migration: defaulting it to unscoped is a
// silent leak, so adding one is forced to be a decision. academicScopeModels.test.js
// diffs this map against the schema and fails on either direction.
//
// SPEC 1 SCOPES NOTHING IN PRACTICE. Every account is college-wide after the migration,
// so scopePredicateFor returns null for everything. The map is complete now anyway,
// because discovering ~60 models' worth of decisions during spec 2 — the highest-risk
// slice — is exactly the wrong time to be making them.
const { AcademicScopeError } = require("./academicScope");

const MODEL_SCOPE = {
  // --- Carries the column itself -------------------------------------------------
  Course: { column: "academicDepartmentId" },
  Student: { column: "academicDepartmentId" },

  // --- Reachable through an owner ------------------------------------------------
  // Only the models spec 2 will actually filter are given a path now. Everything else
  // is UNSCOPED until the slice that scopes it says otherwise, because a path declared
  // here and never exercised is a claim nothing tests.
  Enrolment: { via: "student" },
  AttendanceMark: { via: "student" },

  // --- Explicitly institution-wide -----------------------------------------------
  // Add EVERY remaining model name from schema.prisma here as "UNSCOPED". The
  // completeness test lists the ones you have missed; paste them in rather than
  // guessing, and move a model out of this block only in the spec that scopes it.
  AcademicDepartment: "UNSCOPED",
  StaffAcademicDepartment: "UNSCOPED",
  Semester: "UNSCOPED",
  // …every other model in schema.prisma, per the completeness test.
};

/**
 * The `where` fragment for one model under one scope, or null when nothing should be
 * added.
 *
 * Returns null — meaning "do not filter" — in exactly two cases: the caller is
 * college-wide, or the model is declared UNSCOPED. It NEVER returns null because the
 * caller has no departments: that case returns `{ in: [] }`, which matches nothing.
 * Collapsing those two into one answer is how a narrowed account would silently see
 * everything.
 */
function scopePredicateFor(model, scope) {
  const rule = MODEL_SCOPE[model];
  if (rule === undefined) {
    throw new AcademicScopeError(
      `Model "${model}" is not declared in academicScopeModels.js. Add it as "UNSCOPED", ` +
      `{ column: "academicDepartmentId" } or { via: "<relation>" } — a model must not default to unscoped.`,
    );
  }
  if (rule === "UNSCOPED") return null;
  if (scope && scope.collegeWide) return null;

  const ids = (scope && scope.academicDepartmentIds) || [];
  const match = { in: ids };

  if (rule.column) return { [rule.column]: match };
  return { [rule.via]: { academicDepartmentId: match } };
}

module.exports = { MODEL_SCOPE, scopePredicateFor };
```

- [ ] **Step 4: Run the test, and use its failure to complete the map**

```bash
cd server && node --test src/academicScopeModels.test.js
```

Expected: the completeness test FAILS listing every undeclared model. Paste each name into the `UNSCOPED` block, re-run until PASS. Do not mark anything scoped that this plan has not named.

- [ ] **Step 5: Wire the extension into `db.js`**

Replace the export block of `server/src/db.js` (keep the entire existing comment — it is the record of why the tenant version went, and it now needs a paragraph saying what came back and how this differs):

```js
const { PrismaClient } = require("@prisma/client");
const { currentScope, AcademicScopeError } = require("./academicScope");
const { scopePredicateFor } = require("./academicScopeModels");

// Operations that read or write existing rows and therefore take a `where`. A create
// has no rows to filter; the department it lands in is set by the route.
const FILTERED_OPS = new Set([
  "findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany",
  "count", "aggregate", "groupBy",
  "update", "updateMany", "delete", "deleteMany",
]);

const base = new PrismaClient();

const prisma = base.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!FILTERED_OPS.has(operation)) return query(args);

        const scope = currentScope();
        // No scope bound at all. This is NOT "see everything" — it is a query issued
        // from somewhere that never said who it was for. In a request that means the
        // scope middleware did not run; outside one it means background work that
        // forgot withoutAcademicScope(). Both are bugs, and both used to be invisible.
        if (!scope) {
          throw new AcademicScopeError(
            `${model}.${operation} was issued with no academic scope bound. A request must ` +
            `pass through requireAuth; background work must declare itself with ` +
            `withoutAcademicScope("<why>").`,
          );
        }

        // Throws for a model nobody has classified. See academicScopeModels.js.
        const predicate = scopePredicateFor(model, scope);
        if (!predicate) return query(args);

        // findUnique cannot take an arbitrary where, so it is widened to findFirst. The
        // cost is losing Prisma's unique-index fast path; the gain is that fetching a
        // row by id cannot cross the boundary, which is the single most likely way a
        // scoped account reaches another department's student.
        if (operation === "findUnique" || operation === "findUniqueOrThrow") {
          const next = { ...args, where: { AND: [args.where, predicate] } };
          return base[model[0].toLowerCase() + model.slice(1)][
            operation === "findUnique" ? "findFirst" : "findFirstOrThrow"
          ](next);
        }

        return query({ ...args, where: args.where ? { AND: [args.where, predicate] } : predicate });
      },
    },
  },
});

module.exports = prisma;
module.exports.prisma = prisma;
```

- [ ] **Step 6: Verify the whole unit suite still passes**

```bash
cd server && DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" node --test "src/**/*.test.js"
```

Expected: PASS. Any test that constructs the client and issues a query without a scope will now throw — that is the guard working. Wrap those tests' queries in `withoutAcademicScope("unit test")`.

- [ ] **Step 7: Commit**

```bash
git add server/src/academicScopeModels.js server/src/academicScopeModels.test.js server/src/db.js
git commit -m "The scope declaration, and the extension that enforces it

Every Prisma model is classified exactly once and an undeclared one throws, so
adding a model is a decision rather than a silent unscoped default. findUnique
is widened to findFirst so fetching a row by id cannot cross the boundary.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Bind the scope in `requireAuth`, and wrap all background work

This is the task that turns the guard on. Until it lands, every query throws.

**Files:**
- Modify: `server/src/auth.js:103-109` (staff branch of `requireAuth`)
- Modify: `server/src/auth.js:83-99` (student and applicant branches)
- Modify: `server/src/serializers.js` (`sStaff`)
- Modify: every scheduler and background entry point in `server/src/index.js`
- Modify: `server/src/prediction/runner.js`, `server/src/moodle.js`

**Interfaces:**
- Consumes: `runWithAcademicScope`, `withoutAcademicScope` from Task 3.
- Produces: `req.user.collegeWide` and `req.user.academicDepartmentIds` on every authenticated request. Tasks 7, 8 and 10 read these.

- [ ] **Step 1: Load the memberships in `requireAuth` and bind the scope**

In `server/src/auth.js`, the staff branch currently reads:

```js
const staff = await prisma.staff.findUnique({ where: { id: payload.sub } });
```

Change it to include the join rows, and wrap `next()`:

```js
// The membership rows are loaded here rather than in each route because this is the
// only place every authenticated request passes through: 41 of the 43 routers apply
// requireAuth per HANDLER, not per router, so there is no later seam that is
// guaranteed to run.
const staff = await prisma.staff.findUnique({
  where: { id: payload.sub },
  include: { academicDepartments: { select: { academicDepartmentId: true } } },
});
```

...and replace the branch's `next()` with:

```js
req.user = { id: staff.id, kind: "staff", accountRole: staff.accountRole, ...sStaff(staff) };
// Bind the scope for the REST OF THE REQUEST. Everything downstream of next() runs
// inside this context, including async handlers and the Prisma calls they await.
return runWithAcademicScope(
  {
    academicDepartmentIds: staff.academicDepartments.map((m) => m.academicDepartmentId),
    collegeWide: staff.collegeWide === true,
  },
  () => next(),
);
```

**This `findUnique` runs before any scope exists.** It must not be filtered. Leave `Staff` declared `"UNSCOPED"` in `academicScopeModels.js` — spec 4 is what scopes HR, and it will need a bootstrap read that bypasses the extension. Note that in a comment now.

- [ ] **Step 2: Do the same for the student and applicant branches**

Both are scoped to their own record already, and both must still bind a scope or every query they make will throw. A student is college-wide **within their own data**, because the router allowlist is what confines them:

```js
// A student's token reaches only STUDENT_ROUTERS, and every query in those routers is
// already narrowed to their own id. Binding college-wide here is therefore not a
// widening — it says "the departmental boundary is not the thing confining this
// caller", which is true, and it keeps the guard's "no scope bound" error meaning
// exactly one thing: a bug.
return runWithAcademicScope({ academicDepartmentIds: [], collegeWide: true }, () => next());
```

Apply the identical change to the applicant branch, with the same comment adjusted to `APPLICANT_ROUTERS`.

- [ ] **Step 3: Add the two fields to `sStaff`**

In `server/src/serializers.js`, inside `sStaff`, after the `supportDepartments` block:

```js
  // --- Academic departments ---
  // Which TEACHING departments this person may see. Not supportDepartments above,
  // which is who reads a student's wellbeing disclosure. See academicDepartments.js.
  //
  // Present only when the query included the join rows; absent otherwise rather than
  // defaulted to [], because "nobody asked" and "belongs to none" are different facts
  // and the second is a real answer the Access screen must be able to show.
  ...(s.academicDepartments
    ? { academicDepartmentIds: s.academicDepartments.map((m) => m.academicDepartmentId) }
    : {}),
  // Lifts the departmental boundary entirely. Defaults to false on read for the same
  // reason parseAdminPages fails closed: an account that suddenly sees everything is a
  // silent, dangerous failure.
  collegeWide: s.collegeWide === true,
```

- [ ] **Step 4: Wrap every background entry point**

Find them:

```bash
cd server && grep -rnE "setInterval|setTimeout|cron|scheduler|startSchedul" src/index.js src/*.js | grep -v test
```

Wrap each scheduler body, the prediction runner's entry, and `syncFromMoodle`. For the prediction runner in `server/src/prediction/runner.js`:

```js
// THE PREDICTION PIPELINE IS INSTITUTION-WIDE AND MUST STAY THAT WAY. Cohort standing,
// the timetable probe and the five "does this college record this at all" probes are
// questions about the INSTITUTION, and CLAUDE.md records that computing them from a
// subset is the most repeated bug in this area — got wrong three times. Departmental
// scoping must not narrow them, so the whole run declares itself wide.
return withoutAcademicScope("prediction: institution-wide probes and cohort standing", async () => {
  /* existing body */
});
```

For `syncFromMoodle` in `server/src/moodle.js`:

```js
// The sync reads and writes every course the VLE offers, before anybody has decided
// which department they belong to. It cannot be scoped by definition.
return withoutAcademicScope("moodle sync: imports every course the VLE offers", async () => {
  /* existing body */
});
```

- [ ] **Step 5: Boot the server and confirm nothing throws**

```bash
cd server && DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" node src/index.js
```

Expected: starts cleanly, schedulers run, **no `AcademicScopeError` in the log**. Any that appears names an unwrapped background entry point — wrap it and restart. Stop the server when clean.

- [ ] **Step 6: Prove no background entry point is unwrapped**

```bash
cd server && grep -rn "withoutAcademicScope" src/ --include=*.js | grep -v test | grep -v academicScope.js
```

Expected: one line per scheduler, plus the prediction runner and the Moodle sync. Record the count in the commit message.

- [ ] **Step 7: Run the full unit suite**

```bash
cd server && DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" node --test "src/**/*.test.js"
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src/auth.js server/src/serializers.js server/src/index.js server/src/prediction/runner.js server/src/moodle.js
git commit -m "Bind academic scope in requireAuth, and declare every background widening

requireAuth is the only place every authenticated request passes through, since
41 of 43 routers apply auth per handler. Background work names itself with
withoutAcademicScope(reason) rather than carrying a department id.

The prediction runner is wide by declaration: its institution-wide probes are
the most repeated bug in that area and scoping must not narrow them.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Scope the raw SQL by hand

The extension hooks `$allModels`; `$queryRawUnsafe` is a client-level method that never reaches it. `server/src/routes/hnd.js:6-21` already documents this exact hazard from the tenant era.

**Files:**
- Create: `server/src/academicScopeSql.js`
- Modify: `server/src/routes/hnd.js:1559`, `:1576`, `:1614`, `:1624` and the file header comment at `:6-21`
- Modify: `server/src/attendanceEmailService.js:256`
- Create: `server/src/academicScopeSql.test.js`

**Interfaces:**
- Consumes: `currentScope`, `AcademicScopeError` from Task 3.
- Produces: `academicSqlPredicate(alias) -> { sql: string, params: string[] }`.

- [ ] **Step 1: Write the failing test**

Create `server/src/academicScopeSql.test.js`:

```js
// The hand-written predicate for raw SQL, which no client extension can reach.
//
// Run with: node --test src/academicScopeSql.test.js  (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const { academicSqlPredicate } = require("./academicScopeSql");
const { runWithAcademicScope, withoutAcademicScope, AcademicScopeError } = require("./academicScope");

test("throws when no scope is bound, rather than returning an empty predicate", async () => {
  // An always-true predicate "reads as a working guard to the next person and would be
  // the thing they trusted" — hnd.js:15-17, on why the tenant predicates were deleted
  // rather than defaulted.
  assert.throws(() => academicSqlPredicate("st"), AcademicScopeError);
});

test("a college-wide caller gets an empty predicate and no parameters", async () => {
  await withoutAcademicScope("test", async () => {
    assert.deepEqual(academicSqlPredicate("st"), { sql: "", params: [] });
  });
});

test("a scoped caller gets a parameterised IN clause on the given alias", async () => {
  await runWithAcademicScope({ academicDepartmentIds: ["d1", "d2"], collegeWide: false }, async () => {
    const { sql, params } = academicSqlPredicate("st");
    assert.equal(sql, ` AND st."academicDepartmentId" IN ($1,$2)`);
    assert.deepEqual(params, ["d1", "d2"]);
  });
});

test("a scoped caller with NO departments gets a predicate that matches nothing", async () => {
  await runWithAcademicScope({ academicDepartmentIds: [], collegeWide: false }, async () => {
    const { sql, params } = academicSqlPredicate("st");
    assert.equal(sql, " AND false");
    assert.deepEqual(params, []);
  });
});

test("the alias is validated, because it is interpolated and cannot be parameterised", () => {
  runWithAcademicScope({ academicDepartmentIds: ["d1"], collegeWide: false }, () => {
    for (const bad of ['st"; DROP TABLE "Student', "st st", "", "1st"]) {
      assert.throws(() => academicSqlPredicate(bad), AcademicScopeError);
    }
  });
});

test("the parameter offset can be shifted so the clause composes with existing params", () => {
  runWithAcademicScope({ academicDepartmentIds: ["d1"], collegeWide: false }, () => {
    assert.equal(academicSqlPredicate("st", 3).sql, ` AND st."academicDepartmentId" IN ($4)`);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && node --test src/academicScopeSql.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `server/src/academicScopeSql.js`:

```js
// THE PREDICATE FOR RAW SQL, WHICH THE CLIENT EXTENSION CANNOT REACH.
//
// db.js extends $allModels. $queryRaw and $queryRawUnsafe are CLIENT-level methods and
// never pass through it. routes/hnd.js:6-21 already records this from the tenant era —
// every raw query there scoped itself by hand through a requireTenant() that threw, and
// this is that helper's replacement.
//
// IT THROWS RATHER THAN RETURNING AN EMPTY STRING when no scope is bound. hnd.js:15-17
// gives the reason the tenant predicates were deleted rather than defaulted to a
// resolved id: "a predicate that is always true reads as a working guard to the next
// person and would be the thing they trusted."
const { currentScope, AcademicScopeError } = require("./academicScope");

// A table alias is INTERPOLATED, not parameterised — SQL has no placeholder for an
// identifier. So it is validated to a short bare word. Everything else about this
// helper is parameterised.
const ALIAS_RE = /^[a-z][a-z0-9_]{0,29}$/i;

/**
 * A ` AND …` fragment confining a raw query to the caller's departments.
 *
 * @param {string} alias  the SQL alias of a table carrying academicDepartmentId
 * @param {number} offset how many $n placeholders the query already uses
 * @returns {{sql: string, params: string[]}}
 */
function academicSqlPredicate(alias, offset = 0) {
  if (!ALIAS_RE.test(String(alias || ""))) {
    throw new AcademicScopeError(`Unsafe SQL alias: ${JSON.stringify(alias)}`);
  }
  const scope = currentScope();
  if (!scope) {
    throw new AcademicScopeError(
      "A raw SQL aggregate was issued with no academic scope bound. Background work must " +
      'declare itself with withoutAcademicScope("<why>").',
    );
  }
  if (scope.collegeWide) return { sql: "", params: [] };

  const ids = scope.academicDepartmentIds || [];
  // No departments means NOTHING, not everything. `AND false` rather than an empty
  // string, for the same reason scopePredicateFor returns `{ in: [] }`.
  if (!ids.length) return { sql: " AND false", params: [] };

  const holders = ids.map((_, i) => `$${offset + i + 1}`).join(",");
  return { sql: ` AND ${alias}."academicDepartmentId" IN (${holders})`, params: ids };
}

module.exports = { academicSqlPredicate };
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd server && node --test src/academicScopeSql.test.js
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Apply it to the six raw queries**

For each of `server/src/routes/hnd.js:1559`, `:1576`, `:1614`, `:1624` and `server/src/attendanceEmailService.js:256`: the queries join `AttendanceMark` to `Student`. Add the predicate against the **student** alias, appending its params after the existing ones. Example shape for `:1559`:

```js
const dept = academicSqlPredicate("st", params.length);
const rows = await prisma.$queryRawUnsafe(
  `${base}${where}${dept.sql} GROUP BY 1 ORDER BY 1`,
  ...params, ...dept.params,
);
```

If a query does not already join `Student`, add the join rather than skipping the predicate.

- [ ] **Step 6: Update the `hnd.js` header comment**

The comment at `hnd.js:6-21` describes a world that has just changed back. Rewrite it to say the raw queries are scoped again, that the reason is departmental rather than tenant, and keep the sentence about why an always-true predicate is forbidden — it is the load-bearing part.

- [ ] **Step 7: Run the unit suite and boot the server**

```bash
cd server && DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" node --test "src/**/*.test.js"
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src/academicScopeSql.js server/src/academicScopeSql.test.js server/src/routes/hnd.js server/src/attendanceEmailService.js
git commit -m "Scope the six raw SQL aggregates by hand

$queryRaw is a client-level method and never reaches the $allModels extension;
hnd.js:6-21 already recorded this hazard from the tenant era. The helper throws
rather than returning an empty predicate, because an always-true guard reads as
a working one to the next person.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The departments API

**Files:**
- Create: `server/src/routes/academicDepartments.js`
- Modify: `server/src/index.js` (mount, beside the other settings-shaped routers)
- Modify: `server/src/serializers.js` (add `sAcademicDepartment`)

**Interfaces:**
- Consumes: `cleanList`, `invalidate`, `all` from Task 1; `requirePage` from `auth.js`.
- Produces: `GET /api/academic-departments`, `PUT /api/academic-departments`, `GET /api/academic-departments/summary`, `PUT /api/academic-departments/staff/:staffId`. Task 10's client consumes all four.

- [ ] **Step 1: Write the serialiser**

In `server/src/serializers.js`:

```js
// An ALLOWLIST, like every serialiser here. Four fields out, and a column added to
// AcademicDepartment tomorrow does not ship to the browser because somebody forgot.
const sAcademicDepartment = (d) => ({
  id: d.id, key: d.key, name: d.name, colour: d.colour, active: d.active,
  ...(d._count ? { courseCount: d._count.courses, studentCount: d._count.students } : {}),
});
```

Add it to the module's exports.

- [ ] **Step 2: Write the router**

Create `server/src/routes/academicDepartments.js`:

```js
// The college's academic departments, and who belongs to them.
//
// Gated on the EXISTING "settings" page rather than a new ADMIN_PAGES key. CLAUDE.md
// records that ADMIN_PAGES is two hand-maintained copies (validate.js and
// StaffHub.jsx), and supportDepartments.js gives the reason not to add to it: a college
// adding "Law" at four in the afternoon cannot also add a permission key to both. The
// page grants the FEATURE; membership decides the rows.
const router = require("express").Router();
const prisma = require("../db");
const { requireAuth, requirePage } = require("../auth");
const { sAcademicDepartment } = require("../serializers");
const departments = require("../academicDepartments");
const { withoutAcademicScope } = require("../academicScope");
const audit = require("../audit");

/** Every department, with the counts the Settings screen shows. */
router.get("/", requireAuth, requirePage("settings"), async (_req, res) => {
  const rows = await prisma.academicDepartment.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { courses: true, students: true } } },
  });
  res.json({ departments: rows.map(sAcademicDepartment) });
});

/**
 * What the college has NOT finished configuring.
 *
 * Both counts are the visible half of a fail direction. `collegeWideStaff` is the
 * deploy's deliberate fail-OPEN made permanently visible; `unassignedCourses` and
 * `unassignedStudents` are the fail-CLOSED made into a to-do list rather than a black
 * hole. Neither number is allowed to be silent.
 */
router.get("/summary", requireAuth, requirePage("settings"), async (_req, res) => {
  // Counted institution-wide on purpose: this is a question about the whole college's
  // configuration, and a scoped answer would tell an admin their department is tidy
  // while the college is not.
  const summary = await withoutAcademicScope("departments summary: a college-wide configuration question", async () => ({
    collegeWideStaff: await prisma.staff.count({ where: { collegeWide: true } }),
    totalStaff: await prisma.staff.count(),
    unassignedCourses: await prisma.course.count({ where: { academicDepartmentId: null } }),
    unassignedStudents: await prisma.student.count({ where: { academicDepartmentId: null } }),
  }));
  res.json(summary);
});

/**
 * Replace the whole list. Upserts by key; a department the college removed from the
 * list is RETIRED (active = false), never deleted.
 *
 * Retire rather than delete, because deleting sets academicDepartmentId to null on
 * every course and student that pointed at it — silently un-assigning a whole
 * department's worth of records, which under scoping means hiding them from everyone
 * but college-wide accounts. Retiring keeps the rows attached and simply stops offering
 * the department as a destination.
 */
router.put("/", requireAuth, requirePage("settings"), async (req, res) => {
  const cleaned = departments.cleanList(req.body?.departments);
  if (!cleaned) return res.status(400).json({ error: "departments must be an array" });

  const before = await prisma.academicDepartment.findMany({ orderBy: { name: "asc" } });
  const keptKeys = new Set(cleaned.map((d) => d.key));

  await prisma.$transaction([
    ...cleaned.map((d) => prisma.academicDepartment.upsert({
      where: { key: d.key },
      update: { name: d.name, colour: d.colour, active: d.active },
      create: d,
    })),
    prisma.academicDepartment.updateMany({
      where: { key: { notIn: [...keptKeys] } },
      data: { active: false },
    }),
  ]);
  departments.invalidate();

  const after = await prisma.academicDepartment.findMany({ orderBy: { name: "asc" } });
  audit.record(req, {
    action: "academicDepartments.saved", entity: "AcademicDepartment",
    summary: "Academic departments updated by " + (req.user?.name || "an administrator") +
      " — " + after.filter((d) => d.active).map((d) => d.name).join(", "),
    before: before.map((d) => ({ key: d.key, name: d.name, active: d.active })),
    after: after.map((d) => ({ key: d.key, name: d.name, active: d.active })),
  });

  res.json({ departments: after.map(sAcademicDepartment) });
});

/**
 * Set one member of staff's departments and their college-wide flag.
 *
 * Super-admin only, unlike the list above. Editing the department LIST is
 * configuration; editing who may SEE a department is granting access, and this is the
 * endpoint that can hand somebody the whole college.
 */
router.put("/staff/:staffId", requireAuth, requirePage("settings"), async (req, res) => {
  if (!req.user.isSuperAdmin) return res.status(403).json({ error: "Only the Super Admin can change academic department access" });

  const ids = Array.isArray(req.body?.academicDepartmentIds) ? req.body.academicDepartmentIds.filter((v) => typeof v === "string") : null;
  if (!ids) return res.status(400).json({ error: "academicDepartmentIds must be an array" });
  const collegeWide = req.body?.collegeWide === true;

  const staff = await prisma.staff.findUnique({
    where: { id: req.params.staffId },
    include: { academicDepartments: { select: { academicDepartmentId: true } } },
  });
  if (!staff) return res.status(404).json({ error: "No such staff member" });

  // Every id must be a real department. An unknown id is rejected rather than dropped:
  // silently ignoring one means the Access screen shows a grant that was never made.
  const known = await prisma.academicDepartment.findMany({ where: { id: { in: ids } }, select: { id: true } });
  if (known.length !== new Set(ids).size) return res.status(400).json({ error: "One or more departments do not exist" });

  const beforeIds = staff.academicDepartments.map((m) => m.academicDepartmentId);
  await prisma.$transaction([
    prisma.staffAcademicDepartment.deleteMany({ where: { staffId: staff.id } }),
    ...[...new Set(ids)].map((academicDepartmentId) => prisma.staffAcademicDepartment.create({ data: { staffId: staff.id, academicDepartmentId } })),
    prisma.staff.update({ where: { id: staff.id }, data: { collegeWide } }),
  ]);

  // The summary names the person and the DECISION, never a student. This audit log is
  // read on Settings by admins who were never granted the pastoral pages, which is the
  // same reason the mitigating-circumstances audit records the fact of a decision and
  // never its category.
  audit.record(req, {
    action: "academicDepartments.staffAccessChanged", entity: "Staff", entityId: staff.id,
    summary: staff.name + (collegeWide ? " was granted college-wide access" : ` was scoped to ${ids.length} department(s)`) +
      " by " + (req.user?.name || "an administrator"),
    before: { academicDepartmentIds: beforeIds, collegeWide: staff.collegeWide },
    after: { academicDepartmentIds: [...new Set(ids)], collegeWide },
  });

  res.json({ ok: true });
});

module.exports = router;
```

- [ ] **Step 3: Mount it**

In `server/src/index.js`, beside the other settings-shaped routers (after the `/api/branding` line):

```js
app.use("/api/academic-departments", wrapAsync(require("./routes/academicDepartments")));
```

- [ ] **Step 4: Verify by hand**

```bash
cd server && DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" node src/index.js
```

In another shell: `curl -i http://localhost:4000/api/academic-departments`

Expected: **401**, not 404 — 401 proves the router is mounted and the guard is in front of it. (CLAUDE.md: 401 means mounted, 404 means not deployed.)

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/academicDepartments.js server/src/index.js server/src/serializers.js
git commit -m "The academic departments API

Gated on the existing settings page rather than a new ADMIN_PAGES key, for the
reason supportDepartments.js gives. Removing a department RETIRES it: deleting
would null every course and student pointing at it, hiding a department's worth
of records from everyone but college-wide accounts.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: The smoke suite

**Files:**
- Create: `scripts/smoke-academic-departments.mjs`

**Interfaces:**
- Consumes: the endpoints from Task 7, the guard from Tasks 4–6.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the suite**

Create `scripts/smoke-academic-departments.mjs`, following the structure of `scripts/smoke-referrals.mjs` (same `ROOT`/`createRequire`/`PrismaClient` header, same `ok`/`bad`/`check` helpers, same `DATABASE_URL` guard and exit code).

The assertions, each of which must be proved able to fail:

```js
// 1. THE GUARD FIRES WHEN NOTHING BOUND A SCOPE.
//    Not "returns everything" and not "returns nothing" — throws. This is the property
//    db.js records as lost when the tenant guard went, and the only one that catches a
//    background job somebody forgot to declare.
await check("a departmental query with no bound scope throws", async () => {
  const { runWithAcademicScope } = require(`${ROOT}/server/src/academicScope`);
  const scoped = require(`${ROOT}/server/src/db`);
  await assert.rejects(() => scoped.course.findMany(), /no academic scope bound/);
  // …and succeeds inside one, so the rejection above is the guard and not a broken client.
  await runWithAcademicScope({ academicDepartmentIds: [], collegeWide: true }, () => scoped.course.findMany());
});

// 2. A SCOPED ACCOUNT IS REFUSED ANOTHER DEPARTMENT'S STUDENT BY DIRECT ID.
//    By ID, not by list. A list that filters correctly while findUnique does not is the
//    exact hole the findUnique -> findFirst widening in db.js exists to close, and a
//    test that only reads lists would pass through it.
await check("a Business-scoped admin gets 404 for a Computing student by id", async () => {
  const res = await api(`/hnd/students/${computingStudent.id}`, { token: businessAdminToken });
  assert.equal(res.status, 404, `expected 404, got ${res.status}`);
});

// 3. A SCOPED ACCOUNT WITH NO DEPARTMENTS SEES NOTHING, NOT EVERYTHING.
//    The single most dangerous case: narrowed off college-wide, not yet given a
//    department. `{ in: [] }` must not collapse to "no predicate".
await check("an account with no departments and no college-wide flag sees no students", async () => {
  const res = await api("/hnd/students", { token: unassignedAdminToken });
  assert.equal(res.status, 200);
  assert.equal(res.data.students.length, 0, "an unassigned account must see nothing");
});

// 4. A COLLEGE-WIDE ACCOUNT IS ALLOWED.
//    The control. Without it, assertions 2 and 3 pass just as happily against a server
//    that is simply broken.
await check("a college-wide admin sees students from every department", async () => {
  const res = await api("/hnd/students", { token: superAdminToken });
  assert.equal(res.status, 200);
  assert.ok(res.data.students.length >= 2, "expected students from both departments");
});

// 5. A RAW SQL AGGREGATE REFUSES WITHOUT A SCOPE.
//    Separate from assertion 1 because $queryRaw never reaches the extension, so
//    assertion 1 passing tells us nothing about this path. hnd.js:6-21 is the record of
//    that gap being real.
await check("a raw attendance aggregate with no bound scope throws", async () => {
  const { academicSqlPredicate } = require(`${ROOT}/server/src/academicScopeSql`);
  assert.throws(() => academicSqlPredicate("st"), /no academic scope bound/);
});

// 6. MOVING A STUDENT'S COHORT MOVES THEIR STORED DEPARTMENT.
//    The drift guard for the denormalised column. Without this, the column is right on
//    the day it is written and wrong from the first re-organisation onward.
await check("moving a student to another department's cohort moves their department", async () => {
  await api(`/hnd/students/${student.id}`, { method: "PUT", token: superAdminToken, body: { cohortId: computingCohort.id } });
  const row = await db.student.findUnique({ where: { id: student.id } });
  assert.equal(row.academicDepartmentId, computingDept.id);
});

// 7. THE SERIALISER IS AN EXACT KEY SET.
//    Asserting that `key` and `colour` are present passes just as happily when a
//    seventh field leaks. The whole point of an allowlist is that a column added
//    tomorrow does not appear without somebody deciding it should.
await check("sAcademicDepartment ships exactly the allowed keys", async () => {
  const res = await api("/academic-departments", { token: superAdminToken });
  assert.deepEqual(Object.keys(res.data.departments[0]).sort(), ["active", "colour", "courseCount", "id", "key", "name", "studentCount"]);
});
```

- [ ] **Step 2: Run the whole suite**

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- smoke-academic-departments
```

Expected: all assertions PASS.

- [ ] **Step 3: Prove every assertion can fail**

One at a time, reintroduce the bug and confirm the assertion catches it. Restore after each:

| Assertion | Break it by | Must fail with |
|---|---|---|
| 1 | Returning `query(args)` instead of throwing when `!scope` in `db.js` | no rejection |
| 2 | Removing the `findUnique` → `findFirst` widening in `db.js` | 200 instead of 404 |
| 3 | Returning `null` from `scopePredicateFor` when `ids.length === 0` | non-empty list |
| 4 | Making `scopePredicateFor` ignore `collegeWide` | empty list |
| 5 | Returning `{sql:"",params:[]}` instead of throwing when `!scope` | no throw |
| 6 | Not writing `academicDepartmentId` on the cohort change | stale department id |
| 7 | Adding `createdAt: d.createdAt` to `sAcademicDepartment` | extra key |

**If any assertion still passes with its bug reintroduced, it is discriminating nothing and must be rewritten.** CLAUDE.md records this happening twice in recent work.

- [ ] **Step 4: Run the entire test suite**

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test
```

Expected: every existing suite still passes. Any suite that now fails with `AcademicScopeError` is calling the API from a context with no scope — fix the suite, not the guard.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-academic-departments.mjs
git commit -m "Smoke suite for academic department scoping, weighted to refusals

Seven assertions, each demonstrated able to fail by reintroducing the bug it
guards — the table is in the plan. smoke-tenant-isolation.mjs was deleted rather
than adapted because it would have passed while discriminating nothing.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Capture the Moodle category, and the mapping screen's API

**Files:**
- Modify: `server/src/moodle.js:156` (`readMoodle`) and `:245`/`:258` (the course create/update branches)
- Create: `server/src/routes/vleDepartmentMapping.js`
- Modify: `server/src/index.js` (mount)
- Create: `scripts/moodle-category-probe.mjs`

**Interfaces:**
- Consumes: `Course.vleCategoryExternalId` / `vleCategoryName` from Task 2; `all` from Task 1.
- Produces: `GET /api/vle-department-mapping/categories`, `PUT /api/vle-department-mapping`. Task 10's client consumes both.

- [ ] **Step 1: Land the probe as a repo tool**

Move the probe written during design into `scripts/moodle-category-probe.mjs` — read-only, two calls, writes nothing. It reports how many courses carry `categoryid`, the distinct categories with their course counts, and whether `core_course_get_categories` is permitted.

Run it once a working token is available:

```bash
node scripts/moodle-category-probe.mjs
```

**The probe is currently blocked** — the `MOODLE_TOKEN` in `server/.env` returns `invalidtoken`, and the live token is encrypted in `TenantIntegration` with a `CREDENTIALS_KEY` that is not set on the development machine. Build the rest of this task against bare category **ids**, which spec §7.4 establishes works either way; category **names** are the enhancement the probe unlocks.

- [ ] **Step 2: Capture the category on sync**

In `readMoodle`, keep `categoryid` (it is already in the response — no extra call). In the course **create** branch at `moodle.js:245`, add:

```js
data: {
  name: courseName, colour: colourFor(courseName), moodleCourseId: course.id,
  // Captured on CREATE only. See the update branch for why a later run does not
  // rewrite it.
  vleCategoryExternalId: course.categoryid != null ? String(course.categoryid) : null,
},
```

In the **update** branch, do **not** overwrite it. Add the comment:

```js
// THE CATEGORY IS NEVER REWRITTEN BY A LATER SYNC, and that is a security decision
// rather than laziness. Once departments are mapped, a course's category determines
// which staff can see its students. Somebody reorganising Moodle's categories at
// 11pm would otherwise migrate whole cohorts across an access boundary overnight,
// with nobody watching and no record. A changed category is surfaced as a PROPOSED
// change for an admin to approve — which is what the mapping screen's "changed since
// import" list is for — never applied.
```

- [ ] **Step 3: Write the mapping router**

Create `server/src/routes/vleDepartmentMapping.js`:

```js
// Mapping the VLE's own course grouping onto an academic department, once, by hand.
//
// CAPTURE, THEN MAP, NEVER GUESS. The sync records the category it found and stops
// there. A human decides what it means. The rejected alternative was inferring the
// department from the course NAME — "contains the word Business" — which is the class
// of error CLAUDE.md calls a data-protection incident rather than a bug, for the same
// reason matching SlcApplication.studentName to Student by string is forbidden. Under
// scoping, a wrong mapping is a Law tutor reading Health & Social Care pastoral records.
const router = require("express").Router();
const prisma = require("../db");
const { requireAuth, requirePage } = require("../auth");
const { withoutAcademicScope } = require("../academicScope");
const audit = require("../audit");

/**
 * Every VLE category we have seen, with what is inside it.
 *
 * Institution-wide on purpose: this is a question about the college's configuration,
 * and a scoped answer would show an admin a tidy mapping while most of the college was
 * unmapped.
 */
router.get("/categories", requireAuth, requirePage("settings"), async (_req, res) => {
  const courses = await withoutAcademicScope("vle mapping: a college-wide configuration question", () =>
    prisma.course.findMany({
      select: {
        id: true, name: true, vleCategoryExternalId: true, vleCategoryName: true,
        academicDepartmentId: true,
      },
      orderBy: { name: "asc" },
    }));

  const byCategory = new Map();
  for (const c of courses) {
    // Courses with no captured category are their own bucket. They are NOT hidden:
    // a college whose Moodle predates the capture has every course here, and a screen
    // that silently omitted them would report the mapping as finished.
    const key = c.vleCategoryExternalId || "";
    if (!byCategory.has(key)) {
      byCategory.set(key, { externalId: c.vleCategoryExternalId, name: c.vleCategoryName || null, courses: [] });
    }
    byCategory.get(key).courses.push(c);
  }

  const categories = [...byCategory.values()].map((cat) => {
    const assigned = [...new Set(cat.courses.map((c) => c.academicDepartmentId).filter(Boolean))];
    return {
      externalId: cat.externalId,
      // NULL means "we could not read the name", not "it has no name" — a token without
      // core_course_get_categories still yields ids, and the screen names them by what
      // is inside. Null-is-not-zero, applied to a permission we may not have.
      name: cat.name,
      courseCount: cat.courses.length,
      sampleCourses: cat.courses.slice(0, 5).map((c) => c.name),
      // One id when the whole category maps to one department, null when none of it
      // does, and the full list when it is SPLIT — which is a real state worth showing
      // rather than flattening, because it means somebody assigned courses by hand.
      academicDepartmentId: assigned.length === 1 ? assigned[0] : null,
      splitAcross: assigned.length > 1 ? assigned : null,
    };
  }).sort((a, b) => b.courseCount - a.courseCount);

  res.json({ categories });
});

/**
 * Assign every course in one VLE category to one department — and their students with
 * them.
 *
 * THE STUDENTS MOVE IN THE SAME TRANSACTION, and that is the whole reason this is one
 * endpoint rather than two. Student.academicDepartmentId is denormalised from the
 * course through the cohort; a mapping that moved courses and left students behind
 * would leave a department's students invisible to the very staff just given the
 * department, with nothing on the screen saying so.
 */
router.put("/", requireAuth, requirePage("settings"), async (req, res) => {
  const externalId = typeof req.body?.externalId === "string" ? req.body.externalId : null;
  const academicDepartmentId = typeof req.body?.academicDepartmentId === "string" ? req.body.academicDepartmentId : null;
  if (!externalId) return res.status(400).json({ error: "externalId is required" });

  // An unknown department is REJECTED, not dropped. Silently ignoring it would leave
  // the screen showing a mapping that was never made.
  if (academicDepartmentId) {
    const dept = await prisma.academicDepartment.findUnique({ where: { id: academicDepartmentId } });
    if (!dept) return res.status(400).json({ error: "No such academic department" });
  }

  const result = await withoutAcademicScope("vle mapping: assigns courses across every department", async () => {
    const courses = await prisma.course.findMany({
      where: { vleCategoryExternalId: externalId },
      select: { id: true, name: true },
    });
    if (!courses.length) return null;

    const courseIds = courses.map((c) => c.id);
    const [, students] = await prisma.$transaction([
      prisma.course.updateMany({ where: { id: { in: courseIds } }, data: { academicDepartmentId } }),
      // Students reach their course through a cohort. Written here rather than derived
      // on read for the reason the schema comment gives: cohortId is nullable, and a
      // two-hop join sits on the hottest query in the application.
      prisma.student.updateMany({
        where: { cohort: { courseId: { in: courseIds } } },
        data: { academicDepartmentId },
      }),
    ]);
    return { courses, studentCount: students.count };
  });

  if (!result) return res.status(404).json({ error: "No courses carry that VLE category" });

  const dept = academicDepartmentId
    ? await prisma.academicDepartment.findUnique({ where: { id: academicDepartmentId } })
    : null;
  audit.record(req, {
    action: "academicDepartments.vleCategoryMapped", entity: "AcademicDepartment", entityId: academicDepartmentId,
    summary: `VLE category ${externalId} (${result.courses.length} course(s), ${result.studentCount} student(s)) ` +
      (dept ? `mapped to ${dept.name}` : "unassigned") + " by " + (req.user?.name || "an administrator"),
    after: { externalId, academicDepartmentId, courseIds: result.courses.map((c) => c.id), studentCount: result.studentCount },
  });

  res.json({ courseCount: result.courses.length, studentCount: result.studentCount });
});

module.exports = router;
```

- [ ] **Step 4: Mount and verify**

```js
app.use("/api/vle-department-mapping", wrapAsync(require("./routes/vleDepartmentMapping")));
```

`curl -i http://localhost:4000/api/vle-department-mapping/categories` → expect **401**.

- [ ] **Step 5: Commit**

```bash
git add server/src/moodle.js server/src/routes/vleDepartmentMapping.js server/src/index.js scripts/moodle-category-probe.mjs
git commit -m "Capture Moodle's course category, and the screen that maps it to a department

categoryid is already in the core_course_get_courses response the sync makes, so
capture costs zero extra calls. It is written on CREATE only: a later sync must
never move a course between departments, because that would migrate whole
cohorts across an access boundary overnight with nobody watching.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: The client — Departments settings and staff access

**Files:**
- Modify: `client/src/StaffHub.jsx` (a new Settings sub-tab; the Access grid gains department columns)
- Modify: `client/src/api.js` (four calls)

**Interfaces:**
- Consumes: all four endpoints from Task 7 and both from Task 9.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the API calls**

In `client/src/api.js`, following the existing helper style:

```js
export const getAcademicDepartments = () => req("/academic-departments");
export const saveAcademicDepartments = (departments) => req("/academic-departments", { method: "PUT", body: { departments } });
export const getAcademicDepartmentSummary = () => req("/academic-departments/summary");
export const saveStaffAcademicAccess = (staffId, academicDepartmentIds, collegeWide) =>
  req(`/academic-departments/staff/${staffId}`, { method: "PUT", body: { academicDepartmentIds, collegeWide } });
export const getVleCategories = () => req("/vle-department-mapping/categories");
export const saveVleCategoryMapping = (externalId, academicDepartmentId) =>
  req("/vle-department-mapping", { method: "PUT", body: { externalId, academicDepartmentId } });
```

- [ ] **Step 2: Build the Departments panel**

A new sub-tab under the existing **Settings** page — **not** a new `ADMIN_PAGES` key, so neither hand-maintained copy of that list changes. Model it on the existing support-departments editor.

It shows, in this order:

1. **The department list** — name, colour, active toggle, course count, student count. Add/rename/retire. The key field is editable only while adding, and disabled with the tooltip *"A department's key cannot be changed once it exists — saved filters and VLE mappings carry it."*
2. **A permanent status line** rendering the `/summary` response, and it must never be hidden when the numbers are inconvenient:
   - *"N of M staff have college-wide access"* — the deploy's fail-open, made visible.
   - *"N courses and M students are not assigned to a department"* — the fail-closed, as a to-do.
3. **The VLE category mapping table** from Task 9 — external id, name if captured, course count, sample courses, and a department picker per row.

- [ ] **Step 3: Extend the Access grid**

The Super Admin's Access screen gains, per staff member: a **college-wide** toggle and a multi-select of departments. The toggle carries the warning *"A college-wide account sees every department's students, registers and pastoral records."* When college-wide is on, the department multi-select is disabled and greyed, because the flag already grants everything and a grid showing both invites the reader to think the list still constrains it.

- [ ] **Step 4: Build the client**

```bash
npm --workspace client run build
```

Expected: build succeeds. This is the only automated verification the client has — there is no test framework, so the server assertions from Task 8 carry the actual guarantee. **The client must never be the only thing enforcing a boundary.**

- [ ] **Step 5: See it working**

Follow the Playwright recipe in the project memory (`--no-save playwright` with installed Edge, script inside the repo, click the role tile before login). Confirm: the Departments panel lists departments, the summary line shows real counts, and the Access grid disables the multi-select when college-wide is on.

- [ ] **Step 6: Commit**

```bash
git add client/src/StaffHub.jsx client/src/api.js
git commit -m "Departments settings panel, and department access in the Access grid

A Settings sub-tab rather than a new ADMIN_PAGES key, so neither hand-maintained
copy of that list changes. The summary line makes both fail directions visible:
how many accounts are college-wide, and how much is still unassigned.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Definition of done

- [ ] Migration `20260904T120000_academic_departments` applied to local, staging and production; both remote databases checked for drift.
- [ ] `DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test` — every suite green, including `smoke-academic-departments`.
- [ ] `node --test "src/**/*.test.js"` green, including the four new unit files.
- [ ] Every one of the seven smoke assertions demonstrated able to fail.
- [ ] `npm --workspace client run build` succeeds.
- [ ] `grep -rn "withoutAcademicScope" server/src --include=*.js | grep -v test` lists every scheduler, the prediction runner and the Moodle sync — and nothing is missing.
- [ ] The Departments screen shows the list, the college-wide staff count and the unassigned counts.
- [ ] A Moodle sync captures `vleCategoryExternalId`, and the mapping screen lists the categories with their course counts.
- [ ] **No behaviour change for any existing user.** Verified by signing in as an ordinary admin and confirming every list is exactly as before.

## Still blocked

- **The Moodle probe** needs a working web-service token, or `CREDENTIALS_KEY` for the environment holding one. Task 9 is built against bare category ids until then; category names are an enhancement, not a dependency.
