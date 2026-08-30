# Assessment Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a two-screen assessment tracker — a setup grid for module leader and marking deadlines, and a dashboard of per-assessment submission and marking progress — showing every figure that is measurable today and rendering the rest as "not synced" rather than zero.

**Architecture:** Two nullable columns (`Unit.leaderStaffId`, `Assessment.markingDueDate`), a pure derivations module with tests beside it, one read-only router that computes the tracker from grouped counts, and two client page components imported into `StaffHub.jsx` the way `AdminLiveAttendance` already is. Setup-page writes reuse the unit and assessment endpoints that already exist, with their page guards widened; no second writer is created.

**Tech Stack:** Express + Prisma + PostgreSQL (`server/`), React 18 + Vite (`client/`), `node --test` for unit tests, `scripts/smoke-*.mjs` for HTTP suites.

**Spec:** [`docs/superpowers/specs/2026-08-30-assessment-tracker-design.md`](../specs/2026-08-30-assessment-tracker-design.md)

## Global Constraints

- **Run every test against the local database, never `server/.env`.** Always pass it on the command line: `DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev"`. `server/.env` points at a live Supabase project and the smoke suites create, mutate and delete real rows.
- **Unit tests use the glob, never a bare directory:** `node --test "src/**/*.test.js"` from `server/`. Given `src/` the runner walks into `index.js`, binds a port, starts the schedulers and never terminates.
- **Never rename a migration directory once applied anywhere.** Migration directories here are hand-named `YYYYMMDDTHHMMSS_name` (note the `T`), which is not the format `prisma migrate dev` generates — create the directory and `migration.sql` by hand.
- **Null means "not measurable"; zero means zero.** Every new numeric figure that could be unmeasurable is nullable in the schema and `null` in JSON. Never coerce to `0`.
- **Dates are strings**, `YYYY-MM-DD`, compared as strings. Never use the host clock for a user-facing date — use `localDate()` from `src/clock.js`.
- **Serialise through allowlists, never blocklists.** Add fields to the `s*` functions in `serializers.js` explicitly.
- **Comments explain WHY**, at length, including why an alternative was rejected. This is the house style and it is load-bearing.
- **New admin page key:** `assessment-tracker`, label `"Assessment Tracker"`. It must be added to four hand-maintained lists (Task 9).
- **Prove every regression test can fail** by reintroducing the bug before counting it as coverage.

## Decision recorded against the spec

**Spec §7 said the Moodle sync guard would widen to admit a tracker-only admin. Do not do that.** `SYNC_PAGES` in `routes/moodle.js` is `["registers", "students"]` and carries a comment explaining why it is narrow: a sync creates students, enrolments, courses and units, and gating it more loosely previously let an admin given only app configuration create student records and rewrite marks. Adding `assessment-tracker` would reopen exactly that hole. Instead the tracker's sync button is rendered only when the signed-in user can access `registers` or `students` (Task 8, Step 3). Everything else in §7 stands.

## File Structure

| File | Responsibility |
|---|---|
| `server/prisma/schema.prisma` | + `Unit.leaderStaff`/`leaderStaffId`, `Staff.unitsLed`, `Assessment.markingDueDate` |
| `server/prisma/migrations/20260830T160000_assessment_tracker/migration.sql` | the forward-only DDL |
| `server/src/assessmentTracker.js` | **new, pure** — rate and deadline-state derivations. No DB, no network. |
| `server/src/assessmentTracker.test.js` | **new** — tests for the above |
| `server/src/routes/assessmentTracker.js` | **new, read-only** — `GET /` and `GET /setup` |
| `server/src/serializers.js` | + leader fields on `sUnit`, + `markingDueDate` on `sAssessment` |
| `server/src/routes/hnd.js` | + `leaderStaffId` in `teachingFromBody`; widen `requireRegisters` on `PUT /units/:id` |
| `server/src/routes/assessments.js` | + `markingDueDate` in `validateAssessment`; widen guard on `PUT /:id`; + `submission` on `GET /:id/grades` |
| `server/src/validate.js` | + `assessment-tracker` to `ADMIN_PAGES` |
| `server/src/index.js` | mount `/api/assessment-tracker` |
| `client/src/AssessmentTrackerSetup.jsx` | **new** — the per-module setup grid |
| `client/src/AssessmentTracker.jsx` | **new** — the tracker dashboard |
| `client/src/StaffHub.jsx` | imports, `ADMIN_PAGES`, `PAGE_LABELS`, `allNav`, render switch, + submitted column on `AdminAssessments` |
| `scripts/smoke-assessment-tracker.mjs` | **new** — HTTP suite, weighted negative |

---

### Task 1: Schema — module leader and marking deadline

**Files:**
- Modify: `server/prisma/schema.prisma` (Unit ~line 949, Staff ~line 515, Assessment ~line 968)
- Create: `server/prisma/migrations/20260830T160000_assessment_tracker/migration.sql`
- Modify: `server/src/serializers.js` (`sUnit` ~line 80, `sAssessment`)

**Interfaces:**
- Consumes: nothing.
- Produces: `Unit.leaderStaffId: String?`, `Unit.leaderStaff: Staff?`, `Staff.unitsLed: Unit[]`, `Assessment.markingDueDate: String?`. `sUnit()` gains `leaderStaffId: string|null` and `leaderName: string|null`. `sAssessment()` gains `markingDueDate: string|null`.

- [ ] **Step 1: Add the columns to the schema**

In `server/prisma/schema.prisma`, inside `model Unit`, directly beneath the existing `tutorStaff` / `tutorStaffId` pair:

```prisma
  // The member of staff who LEADS this module, as distinct from tutorStaff above, who
  // TEACHES it. They are frequently different people and the assessment tracker exists
  // partly to make that visible: the lecturer is chased about a register, the module
  // leader is chased about a marking deadline.
  //
  // Nullable, and that is a measurement decision rather than laziness. A module whose
  // leader has not been named yet is NOT MEASURABLE, not "unassigned" — the tracker
  // renders "—" and excludes it from any count of modules missing a leader, so a
  // college part-way through configuring the page is never reported as having a
  // problem it does not have.
  //
  // SetNull mirrors tutorStaffId exactly: removing a staff account must never cascade
  // into deleting the modules that person led.
  leaderStaff   Staff?     @relation("UnitLeader", fields: [leaderStaffId], references: [id], onDelete: SetNull)
  leaderStaffId String?
```

Inside `model Staff`, directly beneath `unitsTaught`:

```prisma
  unitsLed         Unit[]          @relation("UnitLeader")
```

Inside `model Assessment`, directly beneath `dueDate`:

```prisma
  // The date by which this assessment's scripts are to be MARKED, as distinct from
  // dueDate above, which is when students hand the work in. Two different deadlines
  // owned by two different people, and the gap between them is what the assessment
  // tracker measures.
  //
  // Deliberately NOT called `deadline`: Unit.submissionDate already exists and means a
  // third thing (the unit's own hand-in window), so an unqualified name here would be
  // genuinely ambiguous to the next reader.
  //
  // Nullable — a college that does not set internal marking deadlines is not late, it
  // is unmeasured, and the tracker must say so rather than show every row as overdue.
  markingDueDate String?               // YYYY-MM-DD
```

- [ ] **Step 2: Write the migration by hand**

Create `server/prisma/migrations/20260830T160000_assessment_tracker/migration.sql`:

```sql
-- Module leader on a unit, and an internal marking deadline on an assessment.
-- Both nullable: an unnamed leader and an unset marking deadline are "not recorded",
-- which the tracker must be able to tell apart from "nobody" and "overdue".
ALTER TABLE "Unit" ADD COLUMN "leaderStaffId" TEXT;
ALTER TABLE "Assessment" ADD COLUMN "markingDueDate" TEXT;

CREATE INDEX "Unit_leaderStaffId_idx" ON "Unit"("leaderStaffId");

-- SetNull, matching tutorStaffId: removing a staff account must never delete the
-- modules they led.
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_leaderStaffId_fkey"
  FOREIGN KEY ("leaderStaffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

Add the matching `@@index([leaderStaffId])` to `model Unit` in the schema, beside the existing indexes, so `prisma migrate diff` stays clean.

- [ ] **Step 3: Apply it and regenerate the client**

Run from the repo root:

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npx --workspace server prisma migrate deploy
npm --workspace server run generate
```

Expected: `1 migration found` / applied, then `Generated Prisma Client`.

- [ ] **Step 4: Verify the schema and the database agree**

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npx --workspace server prisma migrate diff --from-schema-datamodel server/prisma/schema.prisma --to-schema-datasource server/prisma/schema.prisma --exit-code
```

Expected: exit code 0 and "No difference detected". A non-zero exit means the hand-written SQL and the schema have drifted — fix the SQL, never the migration's name.

- [ ] **Step 5: Publish the new fields through the allowlists**

In `server/src/serializers.js`, in `sUnit`, beneath the `tutorStaffId` / `tutorName` pair:

```js
  // The module leader, beside the lecturer above. Null when nobody has been named —
  // "not recorded", which the tracker renders as "—" rather than as a finding.
  leaderStaffId: m.leaderStaffId ?? null,
  leaderName: m.leaderStaff?.name ?? null,
```

In `sAssessment`, beside `dueDate`:

```js
  markingDueDate: a.markingDueDate ?? null,
```

- [ ] **Step 6: Confirm the existing suites still pass**

```bash
cd server && node --test "src/**/*.test.js"
```

Expected: all pass. `schema-contract.test.js` parses `schema.prisma`, so a malformed model shows up here.

- [ ] **Step 7: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations server/src/serializers.js
git commit -m "Module leader and marking deadline, both nullable because unnamed is not unassigned"
```

---

### Task 2: The derivations, as a pure module

**Files:**
- Create: `server/src/assessmentTracker.js`
- Create: `server/src/assessmentTracker.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `submissionRate(submitted: number|null, enrolled: number|null): number|null`
  - `markingRate(marked: number|null, submitted: number|null): number|null`
  - `coverageRate(marked: number|null, enrolled: number|null): number|null`
  - `deadlineState(dueDate: string|null, today: string): "none"|"upcoming"|"due"|"overdue"`
  - `markingState(markingDueDate: string|null, marked: number|null, submitted: number|null, today: string): "none"|"unknown"|"upcoming"|"due"|"overdue"|"complete"`

- [ ] **Step 1: Write the failing tests**

Create `server/src/assessmentTracker.test.js`:

```js
// The assessment tracker's derivations, which are the part of it that gets argued with.
//
// Every assertion below is about a DENOMINATOR, and every one of them is a decision
// somebody could reasonably make the other way — which is exactly why they are pinned
// here rather than left inline in the route.
const test = require("node:test");
const assert = require("node:assert/strict");
const t = require("./assessmentTracker");

test("submission rate is null, not zero, when the submission count is unknown", () => {
  // THE MOST IMPORTANT LINE IN THE FEATURE. AssessmentSubmission is empty until the
  // LMS sync exists, so a 0 here would put every module in the college on a watchlist
  // for something nobody has measured.
  assert.equal(t.submissionRate(null, 50), null);
});

test("submission rate is a real zero when submissions ARE recorded and none arrived", () => {
  // The earned zero must stay reachable, or the guard above has quietly disabled the
  // figure rather than protecting it.
  assert.equal(t.submissionRate(0, 50), 0);
});

test("submission rate is null when nobody is enrolled", () => {
  // Dividing by an empty cohort is not 0% and not 100%; it is unmeasurable.
  assert.equal(t.submissionRate(0, 0), null);
});

test("submission rate is a percentage to one decimal place", () => {
  assert.equal(t.submissionRate(21, 50), 42);
  assert.equal(t.submissionRate(1, 3), 33.3);
});

test("marking rate divides by SUBMITTED, not by enrolled", () => {
  // 20 of 50 students submitted and all 20 are marked. That is a finished marking job,
  // not 40% of one — you cannot mark a script nobody handed in.
  assert.equal(t.markingRate(20, 20), 100);
});

test("marking rate is null when the submission count is unknown", () => {
  assert.equal(t.markingRate(12, null), null);
});

test("coverage is marked over enrolled and is measurable without any submission data", () => {
  assert.equal(t.coverageRate(20, 50), 40);
  assert.equal(t.coverageRate(0, 50), 0);
});

test("coverage is never substituted for the marking rate", () => {
  // Both figures for the same assessment, and they must disagree. A single column that
  // silently switches denominator per row is how a figure stops being trustworthy.
  assert.equal(t.markingRate(20, 20), 100);
  assert.equal(t.coverageRate(20, 50), 40);
});

test("a deadline that is today is due, not overdue", () => {
  assert.equal(t.deadlineState("2026-08-30", "2026-08-30"), "due");
  assert.equal(t.deadlineState("2026-08-29", "2026-08-30"), "overdue");
  assert.equal(t.deadlineState("2026-08-31", "2026-08-30"), "upcoming");
});

test("no deadline set is 'none', never 'overdue'", () => {
  // A college that does not set internal marking deadlines is unmeasured, not late.
  assert.equal(t.deadlineState(null, "2026-08-30"), "none");
  assert.equal(t.deadlineState("", "2026-08-30"), "none");
});

test("marking is not overdue when everything submitted has been marked", () => {
  // Past the marking deadline, but there is nothing left to mark. Reporting this as
  // overdue fills the screen with rows nobody can act on, which is the same as an
  // empty screen.
  assert.equal(t.markingState("2026-08-20", 20, 20, "2026-08-30"), "complete");
});

test("marking IS overdue when scripts remain unmarked past the deadline", () => {
  assert.equal(t.markingState("2026-08-20", 12, 20, "2026-08-30"), "overdue");
});

test("marking state is 'unknown' while the submission count is unknown", () => {
  // With no denominator there is no way to know whether anything is outstanding, and
  // guessing "overdue" would accuse a marker on the strength of a missing integration.
  assert.equal(t.markingState("2026-08-20", 12, null, "2026-08-30"), "unknown");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd server && node --test src/assessmentTracker.test.js
```

Expected: FAIL — `Cannot find module './assessmentTracker'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/assessmentTracker.js`:

```js
// The assessment tracker's derivations. PURE: no database, no network, no clock.
//
// It is a separate file from routes/assessmentTracker.js — which does the querying and
// the HTTP — for the same reason vle/canvasNormalise.js is separate from vle/canvas.js:
// these are the judgements that get argued with, every one of them is about a real
// module's record, and every one of them fails SILENTLY if it is wrong. No exception,
// no log line, just a percentage that looks reasonable and is not true.
//
// `today` is a parameter and never read from a clock in here. Callers pass localDate()
// from clock.js, which is pinned to APP_TIMEZONE — the host clock would date a figure
// to the wrong day for a college in a different timezone, and an untestable one at that.

// One decimal place, matching pctOf() in routes/assessments.js so a rate on this screen
// never disagrees in the last digit with the same rate on the gradebook.
const pct = (n, d) => Math.round((n / d) * 1000) / 10;

// Is this a number we can actually divide by? Explicitly NOT `!denominator`, which
// would treat a legitimately-zero numerator as unmeasurable, and explicitly not a
// truthiness test on the numerator, which would turn a real 0 into null.
const known = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * What proportion of the enrolled cohort handed this assessment in?
 *
 * NULL, NEVER ZERO, WHEN `submitted` IS UNKNOWN. AssessmentSubmission is written by
 * nothing until the LMS sync lands, so every assessment in the college has an unknown
 * submission count today. A 0 here would report every module as having received no
 * work at all — a college-wide crisis manufactured out of a missing integration, and
 * the single failure this feature most has to avoid.
 *
 * Null also when nobody is enrolled: dividing by an empty cohort is not 0% and not
 * 100%, it is unmeasurable, and either answer would be a statement about students who
 * do not exist.
 */
function submissionRate(submitted, enrolled) {
  if (!known(submitted) || !known(enrolled) || enrolled <= 0) return null;
  return pct(submitted, enrolled);
}

/**
 * How far through marking is this assessment — marked over SUBMITTED.
 *
 * The denominator is submitted, not enrolled, because you cannot mark a script nobody
 * handed in. 20 of 50 students submitted and all 20 marked is a finished job at 100%,
 * not 40% of one; the marked-out-of-enrolled reading can never reach 100% while anyone
 * fails to submit, so a fully-marked module would read as incomplete for ever and the
 * figure would stop meaning anything to whoever is chasing markers.
 *
 * The cost of that choice is honest and accepted: with no submission data there is no
 * denominator, so this is null until the LMS sync exists. coverageRate() below is the
 * figure that IS measurable meanwhile, and it is deliberately a different name in a
 * different column rather than a fallback — see its comment.
 */
function markingRate(marked, submitted) {
  if (!known(marked) || !known(submitted) || submitted <= 0) return null;
  return pct(marked, submitted);
}

/**
 * What proportion of the enrolled cohort has a mark — marked over ENROLLED.
 *
 * A different question from markingRate(): "how far through the cohort is this module",
 * not "how much marking is outstanding". It is measurable today, from AssessmentGrade,
 * which the Moodle sync genuinely populates.
 *
 * IT IS NEVER SUBSTITUTED FOR markingRate() WHEN THAT IS NULL. A single column whose
 * denominator silently changes from row to row is worse than a blank one: the reader
 * cannot tell which question any given cell answered, so they stop trusting all of
 * them. Two names, two columns, two meanings.
 */
function coverageRate(marked, enrolled) {
  if (!known(marked) || !known(enrolled) || enrolled <= 0) return null;
  return pct(marked, enrolled);
}

/**
 * Where a date sits relative to today. Strings throughout, compared as strings, which
 * is safe for YYYY-MM-DD and is what the rest of the academic code does.
 *
 * A date of TODAY is "due", not "overdue". Work due today is not late until today is
 * over, and colouring it red at one minute past midnight trains people to ignore red.
 *
 * No date at all is "none" — a college that has not set this deadline is unmeasured,
 * not late, and must not be shown a screen of overdue rows it never opted into.
 */
function deadlineState(date, today) {
  if (!date) return "none";
  if (date < today) return "overdue";
  if (date === today) return "due";
  return "upcoming";
}

/**
 * The marking deadline's state, which is NOT simply deadlineState() of it.
 *
 * An assessment fully marked a week after its marking deadline is FINISHED, not late.
 * The deadline has passed and there is nothing anyone can do about it or needs to;
 * reporting it as overdue fills the tracker with rows nobody can act on, which is the
 * same as an empty tracker.
 *
 * And while `submitted` is unknown there is no way to tell whether anything is
 * outstanding at all, so the answer is "unknown" rather than a guess. Guessing
 * "overdue" here would accuse a named module leader of a marking backlog on the
 * strength of an integration that has not been built yet.
 */
function markingState(markingDueDate, marked, submitted, today) {
  if (!markingDueDate) return "none";
  if (!known(submitted)) return "unknown";
  const outstanding = submitted - (known(marked) ? marked : 0);
  if (outstanding <= 0) return "complete";
  return deadlineState(markingDueDate, today);
}

module.exports = { submissionRate, markingRate, coverageRate, deadlineState, markingState };
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd server && node --test src/assessmentTracker.test.js
```

Expected: PASS, 14 tests.

- [ ] **Step 5: Prove the null guard can fail**

Temporarily change `submissionRate`'s guard to `if (!known(enrolled) || enrolled <= 0) return null;` (dropping the `submitted` check) and re-run. Expected: the first test fails with `null !== 0`. **Restore the line.** A test that passes with the bug reintroduced is discriminating nothing, which has happened twice in recent work here.

- [ ] **Step 6: Commit**

```bash
git add server/src/assessmentTracker.js server/src/assessmentTracker.test.js
git commit -m "Tracker derivations: marked over submitted, and null wherever the denominator is unknown"
```

---

### Task 3: Let the setup page save, without a second writer

**Files:**
- Modify: `server/src/routes/hnd.js` (`teachingFromBody` ~line 213, `requireRegisters` ~line 67)
- Modify: `server/src/routes/assessments.js` (`validateAssessment`, `router.put("/:id")` ~line 139)
- Modify: `server/src/validate.js` (`ADMIN_PAGES` ~line 61)

**Interfaces:**
- Consumes: `Unit.leaderStaffId`, `Assessment.markingDueDate` from Task 1.
- Produces: `PUT /api/hnd/units/:id` accepts `{ leaderStaffId: string|"" }`. `PUT /api/assessments/:id` accepts `{ markingDueDate: "YYYY-MM-DD"|"" }`. Both reachable by a holder of `assessment-tracker`. `ADMIN_PAGES` (server) contains `"assessment-tracker"`.

- [ ] **Step 1: Add the page key to the server's allowlist**

In `server/src/validate.js`, add `"assessment-tracker"` to `ADMIN_PAGES`, directly after `"assessments"`:

```js
  "approvals", "signups", "summaries", "registers", "live-attendance", "attendance-tags", "students", "attendance-emails", "assessments", "assessment-tracker",
```

- [ ] **Step 2: Accept a module leader on the unit endpoint**

In `server/src/routes/hnd.js`, inside `teachingFromBody`, after the `tutorStaffId` block and before `return out;`:

```js
  // The module LEADER, which is a different person from the tutor above and is set on
  // the assessment tracker's setup grid rather than here. Handled in this helper anyway
  // so there is exactly one place that resolves a staff id on a unit — a second
  // implementation is a second place for the "unknown staff member" check to drift.
  //
  // No mirror into a free-text field, unlike tutorStaffId: `tutor` exists only because
  // units were assigned by name before accounts were linked, and there is no such
  // history to carry here.
  if (body?.leaderStaffId !== undefined) {
    const id = str(body.leaderStaffId);
    if (!id) { out.leaderStaffId = null; }
    else {
      // findUnique is tenant-scoped by db.js, so a staff id from another college
      // resolves to nothing and is refused as unknown rather than silently stored.
      const staff = await prisma.staff.findUnique({ where: { id }, select: { id: true } });
      if (!staff) return { error: "Unknown staff member" };
      out.leaderStaffId = staff.id;
    }
  }
```

Update the helper's doc comment above it from `Returns { submissionDate, tutorStaffId, tutor } or { error }.` to `Returns { submissionDate, tutorStaffId, tutor, leaderStaffId } or { error }.`

- [ ] **Step 3: Widen the two guards**

In `server/src/routes/hnd.js`, change line ~67:

```js
// The course structure and registers. "assessment-tracker" is admitted because its
// setup grid saves a module leader through PUT /units/:id — the alternative was a
// second endpoint writing the same column, and two writers means two places for the
// staff-id validation to drift. Precedent: /assessments/exec-summary already accepts
// either "executive" or "assessments" for exactly this reason.
const requireRegisters = requireAnyPage(["registers", "assessment-tracker"]);
```

In `server/src/routes/assessments.js`, the router-wide gate at line ~52 is `requirePage("assessments")` and must stay that way — the gradebook is admin-only and a tracker admin has no business reading student marks. So `PUT /:id` needs its own route-level admission ABOVE that gate, matching how `/exec-summary` is registered. Move nothing; instead register a narrow route before `router.use(...)`, immediately after the existing `/exec-summary` line:

```js
// The assessment tracker's setup grid sets a marking deadline, and only a marking
// deadline. Registered ABOVE the router-wide requirePage("assessments") gate, exactly
// as /exec-summary is, because that gate is deliberately strict: the gradebook is
// admin-only since it holds student marks, and a tracker admin must not be handed
// those just to type a date.
//
// So this is not a widening of the gradebook's permission — it is a separate, much
// narrower door: it accepts markingDueDate and nothing else, and it refuses any body
// carrying a field that would touch marks, weighting or the unit an assessment sits on.
router.put("/:id/marking-deadline", requireAuth, requireAnyPage(["assessments", "assessment-tracker"]), requireAdmin, async (req, res) => {
  const existing = await prisma.assessment.findUnique({ where: { id: req.params.id }, include: { unit: { select: { code: true } } } });
  if (!existing) return res.status(404).json({ error: "Assessment not found" });
  const raw = str(req.body?.markingDueDate);
  if (raw && !isRealDate(raw)) return res.status(400).json({ error: "Marking deadline must be a valid date (YYYY-MM-DD)" });
  const markingDueDate = raw || null;
  const a = await prisma.assessment.update({
    where: { id: existing.id }, data: { markingDueDate },
    include: { unit: { select: { code: true, name: true } }, _count: { select: { grades: true } } },
  });
  // No flagAssessmentChange() call, deliberately: a marking deadline is an internal
  // staffing date. It changes no mark, no denominator and no percentage, so nobody's
  // progression score moves and flagging the whole enrolment stale would be a large
  // pointless recompute on every save of this grid.
  audit.record(req, {
    action: "assessment.markingDeadlineSet", entity: "Assessment", entityId: a.id,
    summary: `Marking deadline for "${a.title}" on ${existing.unit?.code || "a unit"} set to ${markingDueDate || "none"}`,
    before: { markingDueDate: existing.markingDueDate ?? null },
    after: { markingDueDate },
  });
  res.json(sAssessment(a));
});
```

Also add `markingDueDate` to `validateAssessment` so the full editor on the Assessments page can set it too, directly after the `dueDate` block:

```js
  if (body?.markingDueDate !== undefined) {
    const d = str(body.markingDueDate);
    if (d && !isRealDate(d)) return { error: "Marking deadline must be a valid date (YYYY-MM-DD)" };
    data.markingDueDate = d || null;
  }
```

Confirm `requireAnyPage` is in the destructured `require("../auth")` at the top of `assessments.js` — it already is, used by `/exec-summary`.

- [ ] **Step 4: Check it boots and the unit tests still pass**

```bash
cd server && node --test "src/**/*.test.js"
node -e "require('./server/src/routes/assessments.js'); require('./server/src/routes/hnd.js'); console.log('routers load')"
```

Expected: tests pass; `routers load`. (Run the second command from the repo root.)

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/hnd.js server/src/routes/assessments.js server/src/validate.js
git commit -m "A narrow door for the marking deadline, rather than widening the gradebook's gate"
```

---

### Task 4: The tracker read-model

**Files:**
- Create: `server/src/routes/assessmentTracker.js`
- Modify: `server/src/index.js` (~line 101, beside the assessments mount)

**Interfaces:**
- Consumes: `assessmentTracker.js` from Task 2; the columns from Task 1.
- Produces: `GET /api/assessment-tracker` → `{ recordsSubmissions: boolean, rows: TrackerRow[] }`; `GET /api/assessment-tracker/setup` → `{ modules: SetupModule[], staff: {id,name}[] }`.
  - `TrackerRow`: `{ assessmentId, title, type, unitId, unitCode, unitName, cohortId, cohortName, courseName, leaderStaffId, leaderName, lecturerName, enrolled, dueDate, dueState, submitted, submissionRate, marked, coverageRate, markingRate, markingDueDate, markingState }`
  - `SetupModule`: `{ unitId, unitCode, unitName, cohortName, courseName, lecturerName, leaderStaffId, leaderName, enrolled, assessments: [{ id, title, dueDate, markingDueDate }] }`

- [ ] **Step 1: Write the router**

Create `server/src/routes/assessmentTracker.js`:

```js
// The assessment tracker — a management read-model over work that is already in the
// database. READ-ONLY, deliberately: the setup grid's two saves go to the unit and
// assessment endpoints that already own those columns (see routes/hnd.js and
// routes/assessments.js), because a second writer is a second place for the validation
// to drift out of step with the first.
//
// Nothing here is cached or materialised. A tracker row is three counts and some
// division; the prediction engine's cache exists because SCORING is expensive, and
// copying that pattern here would buy no measurable time while adding a whole class of
// staleness bug.
const router = require("express").Router();
const prisma = require("../db");
const { requireAuth, requirePage } = require("../auth");
const { localDate } = require("../clock");
const calc = require("../assessmentTracker");

router.use(requireAuth, requirePage("assessment-tracker"));

const str = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * Does this college record submission data AT ALL?
 *
 * One unfiltered count, evaluated ONCE per request and never inside a per-row loop.
 * This is the institution-wide question, and computing it from the rows on screen
 * answers a question about the view instead of about the college — the most repeated
 * bug in this codebase, got wrong three times in the prediction pipeline alone.
 *
 * It changes no figure. Every null in this file comes from the per-assessment rule
 * below. What this decides is the WORDING: with no rows anywhere the client says
 * "Not synced", because the honest explanation is that no integration is feeding it;
 * with rows elsewhere in the college an individual gap says "Awaiting sync".
 */
const recordsSubmissions = async () => (await prisma.assessmentSubmission.count()) > 0;

/**
 * How many students submitted this assessment — or null if we cannot say.
 *
 * A ROW MEANS "WE LOOKED". Presence of any AssessmentSubmission row for an assessment
 * is the evidence that the question was asked of it; with no rows at all, no count can
 * separate "the sync has not reached this assessment" from "fifty students ignored it",
 * and reporting the second when the first is true invents a crisis out of a gap in an
 * integration. This is the same rule vle/engagementNormalise.js already established.
 *
 * Given rows, the count of status="submitted" is a real, earned figure — and a zero
 * there is a real zero.
 */
function submittedFor(byAssessment, assessmentId) {
  const seen = byAssessment.get(assessmentId);
  if (!seen) return null;
  return seen.submitted;
}

// GET /  — one row per assessment. Filters are all optional and all narrowing.
router.get("/", async (req, res) => {
  const courseId = str(req.query?.courseId);
  const cohortId = str(req.query?.cohortId);
  const termId = str(req.query?.termId);
  const unitId = str(req.query?.unitId);

  const unitWhere = {};
  if (unitId) unitWhere.id = unitId;
  if (courseId) unitWhere.courseId = courseId;
  if (cohortId) unitWhere.cohortId = cohortId;
  if (termId) unitWhere.termId = termId;

  const units = await prisma.unit.findMany({
    where: unitWhere,
    select: {
      id: true, code: true, name: true, tutor: true,
      leaderStaffId: true,
      leaderStaff: { select: { name: true } },
      tutorStaff: { select: { name: true } },
      cohort: { select: { id: true, name: true } },
      course: { select: { name: true } },
    },
    orderBy: [{ code: "asc" }],
  });
  const unitIds = units.map((u) => u.id);
  if (!unitIds.length) return res.json({ recordsSubmissions: await recordsSubmissions(), rows: [] });

  const assessments = await prisma.assessment.findMany({
    where: { unitId: { in: unitIds } },
    select: { id: true, unitId: true, title: true, type: true, dueDate: true, markingDueDate: true },
    orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
  });
  const assessmentIds = assessments.map((a) => a.id);

  // Three grouped counts, not one query per row. At a college with 40 units and 200
  // assessments the per-row shape would be 600 round trips for one screen.
  const [enrolCounts, gradeCounts, submissionCounts, everRecorded] = await Promise.all([
    prisma.enrolment.groupBy({ by: ["unitId"], where: { unitId: { in: unitIds } }, _count: { _all: true } }),
    assessmentIds.length
      ? prisma.assessmentGrade.groupBy({ by: ["assessmentId"], where: { assessmentId: { in: assessmentIds } }, _count: { _all: true } })
      : [],
    assessmentIds.length
      ? prisma.assessmentSubmission.groupBy({ by: ["assessmentId", "status"], where: { assessmentId: { in: assessmentIds } }, _count: { _all: true } })
      : [],
    recordsSubmissions(),
  ]);

  const enrolled = new Map(enrolCounts.map((r) => [r.unitId, r._count._all]));
  const marked = new Map(gradeCounts.map((r) => [r.assessmentId, r._count._all]));
  // Only assessments that appear here have been looked at; see submittedFor above.
  const submissions = new Map();
  for (const r of submissionCounts) {
    const cur = submissions.get(r.assessmentId) || { submitted: 0 };
    if (r.status === "submitted") cur.submitted += r._count._all;
    submissions.set(r.assessmentId, cur);
  }

  const today = localDate();   // APP_TIMEZONE, never the host clock
  const unitById = new Map(units.map((u) => [u.id, u]));

  const rows = assessments.map((a) => {
    const u = unitById.get(a.unitId);
    const enrolledCount = enrolled.get(a.unitId) ?? 0;
    const markedCount = marked.get(a.id) ?? 0;
    const submittedCount = submittedFor(submissions, a.id);
    return {
      assessmentId: a.id, title: a.title, type: a.type,
      unitId: a.unitId, unitCode: u?.code ?? "", unitName: u?.name ?? "",
      cohortId: u?.cohort?.id ?? null, cohortName: u?.cohort?.name ?? null,
      courseName: u?.course?.name ?? null,
      leaderStaffId: u?.leaderStaffId ?? null,
      leaderName: u?.leaderStaff?.name ?? null,
      // Falls back to the free-text `tutor`, which is the only name a unit assigned
      // before staff accounts were linked to units has.
      lecturerName: u?.tutorStaff?.name ?? u?.tutor ?? null,
      enrolled: enrolledCount,
      dueDate: a.dueDate ?? null,
      dueState: calc.deadlineState(a.dueDate, today),
      submitted: submittedCount,
      submissionRate: calc.submissionRate(submittedCount, enrolledCount),
      marked: markedCount,
      coverageRate: calc.coverageRate(markedCount, enrolledCount),
      markingRate: calc.markingRate(markedCount, submittedCount),
      markingDueDate: a.markingDueDate ?? null,
      markingState: calc.markingState(a.markingDueDate, markedCount, submittedCount, today),
    };
  });

  res.json({ recordsSubmissions: everRecorded, rows });
});

// GET /setup  — the module grid, plus the staff list its leader picker needs.
router.get("/setup", async (_req, res) => {
  const [units, staff] = await Promise.all([
    prisma.unit.findMany({
      select: {
        id: true, code: true, name: true, tutor: true,
        leaderStaffId: true,
        leaderStaff: { select: { name: true } },
        tutorStaff: { select: { name: true } },
        cohort: { select: { name: true } },
        course: { select: { name: true } },
        _count: { select: { enrolments: true } },
        assessments: {
          select: { id: true, title: true, dueDate: true, markingDueDate: true },
          orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
        },
      },
      orderBy: [{ code: "asc" }],
    }),
    // Anyone with an account can lead a module; the picker does not filter on role,
    // because a module leader is not necessarily an ADMIN in this system. There is no
    // `active` flag on Staff to filter on either — verified against schema.prisma.
    prisma.staff.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  res.json({
    modules: units.map((u) => ({
      unitId: u.id, unitCode: u.code, unitName: u.name,
      cohortName: u.cohort?.name ?? null,
      courseName: u.course?.name ?? null,
      lecturerName: u.tutorStaff?.name ?? u.tutor ?? null,
      leaderStaffId: u.leaderStaffId ?? null,
      leaderName: u.leaderStaff?.name ?? null,
      enrolled: u._count.enrolments,
      assessments: u.assessments.map((a) => ({
        id: a.id, title: a.title,
        dueDate: a.dueDate ?? null, markingDueDate: a.markingDueDate ?? null,
      })),
    })),
    staff,
  });
});

module.exports = router;
```


- [ ] **Step 2: Mount it**

In `server/src/index.js`, immediately after the assessments mount at line ~101:

```js
app.use("/api/assessment-tracker", wrapAsync(require("./routes/assessmentTracker")));
```

- [ ] **Step 3: Verify it loads and is mounted**

```bash
node -e "require('./server/src/routes/assessmentTracker.js'); console.log('router loads')"
```

Expected: `router loads`.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/assessmentTracker.js server/src/index.js
git commit -m "The tracker read-model: three grouped counts, and a row means we looked"
```

---

### Task 5: A submitted column's data on the gradebook

**Files:**
- Modify: `server/src/routes/assessments.js` (`GET /:id/grades` ~line 249)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: each row of `GET /api/assessments/:id/grades` gains `submission: { status: string, submittedOn: string|null, onTime: boolean|null } | null`, and the response gains `recordsSubmissions: boolean`.

- [ ] **Step 1: Load the submissions and attach them**

In `server/src/routes/assessments.js`, inside `router.get("/:id/grades", ...)`, after the `enrolments` query and before `const byStudent = ...`:

```js
  // Did each student hand the work in? A separate table from AssessmentGrade, and a
  // separate question: a grade exists only once work has been MARKED, so a gradebook
  // alone cannot tell a student who submitted and is waiting from one who submitted
  // nothing. Written by the LMS sync; empty until that exists.
  const submissions = await prisma.assessmentSubmission.findMany({
    where: { assessmentId: a.id },
    select: { studentId: true, status: true, submittedOn: true },
  });
  const subByStudent = new Map(submissions.map((s) => [s.studentId, s]));
  // The institution-wide question, asked once and unfiltered by student — it decides
  // whether the column reads "Not synced" (no integration anywhere) or "Awaiting sync"
  // (this college records submissions; this assessment has not been covered).
  const collegeRecordsSubmissions = (await prisma.assessmentSubmission.count()) > 0;
```

Then inside the `students.map`, add to the returned object:

```js
        // NULL when this student has no submission row, and NEVER "not_submitted".
        //
        // The sync writes a row per enrolled student, so a missing row means the sync
        // did not cover this student — not that they handed nothing in. Rendering "not
        // submitted" against a named individual on the strength of a row nobody wrote
        // is the version of this bug that reaches a student, and "not_submitted" already
        // exists as an explicit status for when the LMS actually says so.
        //
        // onTime is not derived here: it is null for anything not submitted, because
        // you cannot be late for work you never handed in, and a false would report
        // every non-submitter as a late submitter.
        submission: (() => {
          const s = subByStudent.get(st.id);
          if (!s) return null;
          return { status: s.status, submittedOn: s.submittedOn ?? null, onTime: s.status === "submitted" && a.dueDate && s.submittedOn ? s.submittedOn <= a.dueDate : null };
        })(),
```

Rename the map callback parameter if it collides — the existing code uses `(s)`, so use `st` for the student inside this block, or attach the submission by reading `subByStudent.get(s.id)` and keep the existing parameter name. **Read the surrounding code and match it**; do not introduce a shadowed variable.

Finally add `recordsSubmissions: collegeRecordsSubmissions,` to the top level of the `res.json({...})` object, beside `assessment` and `unit`.

- [ ] **Step 2: Verify it loads**

```bash
node -e "require('./server/src/routes/assessments.js'); console.log('ok')"
```

Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/assessments.js
git commit -m "The gradebook can say who submitted — and an absent row is never a non-submission"
```

---

### Task 6: The smoke suite

**Files:**
- Create: `scripts/smoke-assessment-tracker.mjs`

**Interfaces:**
- Consumes: every endpoint from Tasks 3, 4 and 5.
- Produces: a suite auto-discovered by `scripts/test.mjs` (it globs `smoke-*.mjs`).

- [ ] **Step 1: Write the suite**

Create `scripts/smoke-assessment-tracker.mjs`, following `smoke-mitigations.mjs` for the harness (login, `call`, `check`, the direct `db.staff.update` grant because `/staff/:id/access` is Super Admin only):

```js
// The assessment tracker — and the empty table it must never read as a zero.
//
// The feature reports on work that is already in the database, but the one figure
// everybody asks for first — the submission rate — has NO DATA SOURCE YET.
// AssessmentSubmission is read by the prediction engine and written by nothing. So the
// assertions here are weighted toward what must NOT appear:
//
//   1. A submission rate of null, on the wire, when nothing has been synced. A 0 there
//      would put every module in the college on a watchlist for something nobody has
//      measured.
//   2. `marked` a real number in the SAME response — proving the null above is a
//      measurement decision and not a broken query.
//   3. A tracker-only admin can save a leader and a marking deadline, and CANNOT read
//      the gradebook. The guard arrangement in Task 3 is load-bearing and its absence
//      is silent.
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
const require = createRequire(pathToFileURL(join(ROOT, "server", "package.json")));
const { PrismaClient } = require(`${ROOT}/server/node_modules/@prisma/client`);
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required — point it at a throwaway database."); process.exit(1); }
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const BASE = process.env.API_URL || "http://localhost:4010/api";
const ADMIN = process.env.SEED_ADMIN_EMAIL || "admin@edtech.co.uk";
const PASSWORD = process.env.SEED_PASSWORD || "test-seed-password-2026";
const TRACKER_EMAIL = "tracker.officer@edtech.co.uk";
const TRACKER_PW = "tracker-officer-2026";

let passed = 0, failed = 0;
const ok = (label, detail) => { passed++; console.log(`✓ ${label}${detail ? "  — " + detail : ""}`); };
const bad = (label, e) => { failed++; console.log(`✗ ${label}\n    ${e && e.message ? e.message : e}`); };
async function check(label, fn) {
  try { const d = await fn(); ok(label, d); } catch (e) { bad(label, e); }
}
const call = async (path, { method = "GET", body, token, tenant } = {}) => {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  if (tenant) headers["X-Tenant"] = tenant;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
};

console.log("\n=== assessment tracker ===\n");

const admin = await call("/auth/login", { method: "POST", body: { email: ADMIN, password: PASSWORD } });
if (!admin.body.token) {
  console.log("✗ could not sign in as the seeded admin — is the API seeded?");
  process.exit(1);
}
const adminToken = admin.body.token;

// A tracker-only admin: the realistic case, and the one the guards are about.
const made = await call("/staff", { method: "POST", token: adminToken, body: { name: "Tracker Officer", email: TRACKER_EMAIL, password: TRACKER_PW } });
const officerId = made.body?.id || (await db.staff.findFirst({ where: { email: TRACKER_EMAIL }, select: { id: true } }))?.id;
if (!officerId) { console.log("✗ could not create the tracker officer fixture"); process.exit(1); }
await db.staff.update({
  where: { id: officerId },
  data: { accountRole: "ADMIN", adminPages: JSON.stringify(["assessment-tracker"]), mustChangePassword: false },
});
const officer = await call("/auth/login", { method: "POST", body: { email: TRACKER_EMAIL, password: TRACKER_PW } });
if (!officer.body.token) { console.log("✗ could not sign in as the tracker officer"); process.exit(1); }
const token = officer.body.token;

const tracker = await call("/assessment-tracker", { token });
if (tracker.status !== 200) { console.log(`✗ the tracker refused its own admin (${tracker.status})`); process.exit(1); }
const rows = tracker.body?.rows || [];
if (!rows.length) { console.log("SKIP — no seeded assessments, so there is nothing to track"); process.exit(0); }

// --- the null that matters ------------------------------------------------------
const submissionRows = await db.assessmentSubmission.count();

await check("submission rate is null, not 0, while nothing has been synced", () => {
  if (submissionRows > 0) return "skipped — this database has submission rows";
  const zeroed = rows.filter((r) => r.submissionRate === 0);
  assert.equal(zeroed.length, 0, `${zeroed.length} row(s) report a 0% submission rate with no submission data — that is a college-wide crisis manufactured from a missing integration`);
  assert.equal(rows.every((r) => r.submissionRate === null), true, "every row should report null");
  return `${rows.length} row(s), all null`;
});

await check("submitted is null and NOT 0 in the same rows", () => {
  if (submissionRows > 0) return "skipped — this database has submission rows";
  assert.equal(rows.every((r) => r.submitted === null), true);
  return "null throughout";
});

await check("marked is a real number in the same response", () => {
  // Proves the nulls above are a measurement decision and not a broken query.
  assert.equal(rows.every((r) => typeof r.marked === "number"), true, "marked should be a number on every row");
  return `e.g. ${rows[0].marked} marked of ${rows[0].enrolled} enrolled`;
});

await check("coverage is measurable even though the marking rate is not", () => {
  const withCohort = rows.filter((r) => r.enrolled > 0);
  if (!withCohort.length) return "skipped — no enrolled cohorts seeded";
  assert.equal(withCohort.every((r) => typeof r.coverageRate === "number"), true);
  if (submissionRows === 0) assert.equal(withCohort.every((r) => r.markingRate === null), true, "marking rate needs a submitted denominator and must be null without one");
  return "coverage real, marking rate null";
});

await check("recordsSubmissions reports the institution, not the page", () => {
  assert.equal(typeof tracker.body.recordsSubmissions, "boolean");
  assert.equal(tracker.body.recordsSubmissions, submissionRows > 0);
  return String(tracker.body.recordsSubmissions);
});

// --- refusals -------------------------------------------------------------------
await check("an admin without the page is refused the tracker", async () => {
  const other = await call("/staff", { method: "POST", token: adminToken, body: { name: "No Tracker", email: "no.tracker@edtech.co.uk", password: "no-tracker-2026" } });
  const id = other.body?.id || (await db.staff.findFirst({ where: { email: "no.tracker@edtech.co.uk" }, select: { id: true } }))?.id;
  await db.staff.update({ where: { id }, data: { accountRole: "ADMIN", adminPages: JSON.stringify(["timesheets"]), mustChangePassword: false } });
  const login = await call("/auth/login", { method: "POST", body: { email: "no.tracker@edtech.co.uk", password: "no-tracker-2026" } });
  const r = await call("/assessment-tracker", { token: login.body.token });
  assert.equal(r.status, 403, `expected 403, got ${r.status}`);
  const s = await call("/assessment-tracker/setup", { token: login.body.token });
  assert.equal(s.status, 403, `setup expected 403, got ${s.status}`);
  return "403 on both endpoints";
});

await check("no token at all is refused", async () => {
  const r = await call("/assessment-tracker");
  assert.equal(r.status, 401, `expected 401, got ${r.status}`);
  return "401";
});

await check("a tracker-only admin still cannot read the gradebook", async () => {
  // The narrow door in Task 3 must not have become a wide one: student marks are
  // sensitive and this admin was never granted them.
  const r = await call(`/assessments/${rows[0].assessmentId}/grades`, { token });
  assert.equal(r.status, 403, `expected 403, got ${r.status} — a tracker admin is reading student marks`);
  return "403";
});

// --- the two saves --------------------------------------------------------------
await check("a tracker-only admin can set a module leader", async () => {
  const r = await call(`/hnd/units/${rows[0].unitId}`, { method: "PUT", token, body: { leaderStaffId: officerId } });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body).slice(0, 160)}`);
  const after = await db.unit.findUnique({ where: { id: rows[0].unitId }, select: { leaderStaffId: true } });
  assert.equal(after.leaderStaffId, officerId);
  return "saved and read back";
});

await check("an unknown staff id is refused as a module leader", async () => {
  const r = await call(`/hnd/units/${rows[0].unitId}`, { method: "PUT", token, body: { leaderStaffId: "not-a-real-staff-id" } });
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  return "400";
});

await check("a tracker-only admin can set a marking deadline", async () => {
  const r = await call(`/assessments/${rows[0].assessmentId}/marking-deadline`, { method: "PUT", token, body: { markingDueDate: "2026-12-01" } });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body).slice(0, 160)}`);
  const after = await db.assessment.findUnique({ where: { id: rows[0].assessmentId }, select: { markingDueDate: true } });
  assert.equal(after.markingDueDate, "2026-12-01");
  return "saved and read back";
});

await check("a malformed marking deadline is refused", async () => {
  const r = await call(`/assessments/${rows[0].assessmentId}/marking-deadline`, { method: "PUT", token, body: { markingDueDate: "1st December" } });
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  return "400";
});

await check("the marking-deadline door cannot touch marks or weighting", async () => {
  // It accepts markingDueDate and nothing else. If a later edit widened it to a general
  // update, this is what catches it.
  const before = await db.assessment.findUnique({ where: { id: rows[0].assessmentId }, select: { maxMarks: true, weight: true, title: true } });
  await call(`/assessments/${rows[0].assessmentId}/marking-deadline`, { method: "PUT", token, body: { markingDueDate: "2026-12-02", maxMarks: 7, weight: 99, title: "Renamed by the tracker" } });
  const after = await db.assessment.findUnique({ where: { id: rows[0].assessmentId }, select: { maxMarks: true, weight: true, title: true } });
  assert.deepEqual(after, before, "the narrow door wrote a field it should not accept");
  return "maxMarks, weight and title unchanged";
});

// --- tenant isolation -----------------------------------------------------------
await check("a unit from another tenant never appears", async () => {
  const tenants = await db.tenant.findMany({ select: { id: true, slug: true } });
  if (tenants.length < 2) return "skipped — only one tenant seeded";
  const mine = new Set((await call("/assessment-tracker", { token })).body.rows.map((r) => r.unitId));
  const theirs = await db.unit.findMany({ where: { tenantId: { not: (await db.staff.findUnique({ where: { id: officerId }, select: { tenantId: true } })).tenantId } }, select: { id: true } });
  const leaked = theirs.filter((u) => mine.has(u.id));
  assert.equal(leaked.length, 0, `${leaked.length} unit(s) from another college appeared`);
  return `${theirs.length} foreign unit(s), none visible`;
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run the suite**

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- smoke-assessment-tracker
```

Expected: all checks pass or SKIP. Read every SKIP — a SKIP reads differently from a PASS on purpose, and a suite that skips everything is not coverage.

- [ ] **Step 3: Prove the headline assertion can fail**

In `server/src/assessmentTracker.js`, temporarily change `submissionRate` to `if (!known(enrolled) || enrolled <= 0) return null; return pct(submitted ?? 0, enrolled);` and re-run the suite. Expected: "submission rate is null, not 0, while nothing has been synced" **fails**, naming the number of offending rows. **Restore the file** and re-run to confirm green.

- [ ] **Step 4: Run the whole suite to check nothing else broke**

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test
```

Expected: no new failures versus the pre-change baseline. Record the baseline first if you have not.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-assessment-tracker.mjs
git commit -m "Smoke suite: the submission rate must be null on the wire, and marked must not be"
```

---

### Task 7: The setup page

**Files:**
- Create: `client/src/AssessmentTrackerSetup.jsx`

**Interfaces:**
- Consumes: `GET /api/assessment-tracker/setup`, `PUT /api/hnd/units/:id`, `PUT /api/assessments/:id/marking-deadline`.
- Produces: `export default function AssessmentTrackerSetup()` — takes no props, fetches its own data. Mirrors `AdminNfcTags`, which is also propless.

- [ ] **Step 1: Read the API helper and one existing page for house style**

```bash
sed -n '1,40p' client/src/api.js
sed -n '1,60p' client/src/AdminNfcTags.jsx
```

Match the import style, the loading/error handling and the Tailwind class vocabulary you find there. Do not invent a new one.

- [ ] **Step 2: Write the component**

Create `client/src/AssessmentTrackerSetup.jsx`. Requirements, all of which the reviewer will check:

- Fetches `/assessment-tracker/setup` on mount; shows a loading state, and an error state carrying the server's message.
- One card or table row per module, showing: unit code · unit name, class (cohort), course, lecturer (**read-only** — it is set on the Registers screen and a second editor would be a second writer), enrolled count.
- A **module leader** `<select>` per module, populated from the response's `staff` array, with an explicit `""` option labelled `— not set —`. Saving `PUT /hnd/units/:id` with `{ leaderStaffId }`; `""` clears it.
- Under each module, its assessments, each with a `<input type="date">` for **marking deadline**, saving `PUT /assessments/:id/marking-deadline`. The **submission deadline** is shown read-only beside it, because it belongs to the Assessments page.
- A module with no assessments says so, rather than rendering an empty area.
- A module with no leader shows `— not set —`, never a blank cell and never a warning colour: unnamed is not-recorded, not a finding.
- Saves are per-field and optimistic-free: set a per-row saving flag, await the response, then update local state from the response body. On failure, revert the field and show the server's message.
- No `window.confirm`; no unlabelled icon-only controls.

- [ ] **Step 3: Verify it compiles**

```bash
npm run --workspace client build
```

Expected: build succeeds. There is no client-side test framework in this repo — the build is the only automated check the client has, which is why it is a step of its own here.

- [ ] **Step 4: Commit**

```bash
git add client/src/AssessmentTrackerSetup.jsx
git commit -m "Setup grid: module leader and marking deadlines, across many modules at once"
```

---

### Task 8: The tracker page

**Files:**
- Create: `client/src/AssessmentTracker.jsx`

**Interfaces:**
- Consumes: `GET /api/assessment-tracker`, `POST /api/moodle/sync`, `GET /api/moodle/status`.
- Produces: `export default function AssessmentTracker({ me })` — `me` is the signed-in user object `StaffHub` already holds, used only to decide whether the sync button renders.

- [ ] **Step 1: Write the component**

Create `client/src/AssessmentTracker.jsx`. Requirements:

- Fetches `/assessment-tracker` on mount and on filter change. Filters: course, cohort, term — passed as query parameters, all optional.
- One row per assessment, grouped under its module heading. Columns: class · module · leader · lecturer · enrolled · submission deadline · submitted · submission rate · marked · coverage · marking % · marking deadline · state.
- **`null` renders as "Not synced" when `recordsSubmissions` is `false`, and "Awaiting sync" when it is `true`** — styled as muted text, visibly distinct from both a `0%` and an empty cell. This is the single most important rendering rule on the screen; a reader must never mistake a missing integration for a failing cohort.
- `coverageRate` and `markingRate` are **two separate columns with two different headings** — "Marked of cohort" and "Marked of submitted". Never one column, never a fallback between them.
- `dueState` / `markingState` drive a colour: `overdue` red, `due` amber, `upcoming` and `complete` neutral, `none` and `unknown` muted. `complete` is explicitly NOT red even when the date has passed.
- A column-header tooltip or a short legend explains the two marking columns, since the distinction is the whole point of them.
- Empty result renders an empty-state, not a bare table.

- [ ] **Step 2: Add the sync button, correctly gated**

```jsx
{/* The sync button runs the EXISTING Moodle sync, which refreshes enrolments and
    marks — so the enrolled and marked figures on this screen move. It does not fetch
    submissions and must not say that it does; that arrives with the LMS ingest.

    Gated on registers/students, NOT on assessment-tracker. POST /api/moodle/sync
    creates students, enrolments, courses and units, and routes/moodle.js keeps
    SYNC_PAGES deliberately narrow for that reason — an earlier looser gate let an
    admin with only app configuration create student records and rewrite marks.
    Rendering the button for a tracker-only admin would either reopen that hole or
    show them a button that 403s. */}
{canSync && (
  <button onClick={runSync} disabled={syncing}>
    {syncing ? "Syncing…" : "Sync from Moodle"}
  </button>
)}
<p className="text-xs text-slate-500">
  Refreshes enrolments and marks from Moodle. Submission data is not yet imported from
  any LMS — Canvas and Blackboard are not connected.
</p>
```

`canSync` is derived from `me` using the same rule `canAccessPage` applies in `StaffHub.jsx`: super admin, or `adminPages == null`, or `adminPages` includes `registers` or `students`. Pass `me` in from `StaffHub`.

- [ ] **Step 3: Verify it compiles**

```bash
npm run --workspace client build
```

Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add client/src/AssessmentTracker.jsx
git commit -m "Tracker screen: two marking columns, and a null that says which kind of unknown it is"
```

---

### Task 9: Wire both pages into StaffHub

**Files:**
- Modify: `client/src/StaffHub.jsx` — imports (~line 28), `ADMIN_PAGES` (line 2194), `PAGE_LABELS` (line 2195), `allNav` (~line 2675), render switch (~line 2777)

**Interfaces:**
- Consumes: both components from Tasks 7 and 8.
- Produces: two reachable nav entries behind the `assessment-tracker` key.

- [ ] **Step 1: Import the components**

Beside the existing `AdminLiveAttendance` import at line ~28:

```jsx
import AssessmentTracker from "./AssessmentTracker";
import AssessmentTrackerSetup from "./AssessmentTrackerSetup";
```

- [ ] **Step 2: Add the key to all three client lists**

In `ADMIN_PAGES` (line 2194), after `"assessments"`, add `"assessment-tracker"`.

In `PAGE_LABELS` (line 2195), after the `assessments` entry, add:

```js
"assessment-tracker": "Assessment Tracker",
```

In `allNav` (~line 2675), after the `assessments` entry, add **two** entries:

```jsx
    { key: "assessment-tracker", label: "Assessment Tracker", I: Gauge },
    { key: "assessment-tracker-setup", label: "Tracker Setup", I: SlidersHorizontal },
```

`activeKey` is `nav.some(n => n.key === tab) ? tab : nav[0].key` (line 2705) and every nav button calls `setTab(n.key)`, so **two entries sharing a key would be indistinguishable** — both would highlight and both would render the same screen. They need distinct keys.

But `assessment-tracker-setup` must NOT become a second grantable page: that would mean five hand-maintained lists instead of four, and a Super Admin able to grant the setup screen to someone without the tracker it configures.

**Use the pattern `audit` already establishes.** `nav` is built at line 2699 with an explicit exception for exactly this case — a nav key that is not itself grantable and derives its visibility from other pages. Extend that filter:

```jsx
  const nav = allNav.filter(n => n.key === "audit"
    ? AUDIT_READER_PAGES.some(p => canAccessPage(me, p))
    // The tracker's setup screen is a second SCREEN behind one permission, not a
    // second permission. Deriving its visibility here — rather than adding it to
    // ADMIN_PAGES — keeps the grantable list at four hand-maintained copies and makes
    // it impossible to hold the screen that configures the tracker without the
    // tracker itself. Same reasoning as "audit" directly above.
    : n.key === "assessment-tracker-setup" ? canAccessPage(me, "assessment-tracker")
    : canAccessPage(me, n.key));
```

`warnOnPageListDrift` will not complain: it deliberately does not check `allNav` in reverse, precisely because `audit` and `access` are meant to be absent from `ADMIN_PAGES`. Add a line to that function's comment naming `assessment-tracker-setup` as the third such key, so the next reader does not have to rediscover why it is exempt.

`Gauge` and `SlidersHorizontal` come from `lucide-react`; add them to the existing import statement at the top of the file if they are not already there.

- [ ] **Step 3: Render them**

In the render switch (~line 2777), after the `assessments` line:

```jsx
        {activeKey === "assessment-tracker" && <AssessmentTracker me={me} />}
        {activeKey === "assessment-tracker-setup" && <AssessmentTrackerSetup />}
```

`me` is the identifier this component already uses for the signed-in user — `canAccessPage(me, …)` at line 2699 confirms it is in scope here.

- [ ] **Step 4: Verify the drift check is quiet**

```bash
npm run --workspace client build
```

Expected: build succeeds. Then run the dev server and open the console:

```bash
npm run dev
```

Expected: **no** `[StaffHub] ADMIN_PAGES keys with no PAGE_LABELS entry` and **no** `...with no allNav entry` warnings. That check is dev-only and it is the cheapest verification that three of the four lists agree. The server's copy in `validate.js` it cannot see — confirm that by hand (Task 3, Step 1).

- [ ] **Step 5: Commit**

```bash
git add client/src/StaffHub.jsx
git commit -m "Assessment Tracker reaches the sidebar, in all four hand-maintained lists"
```

---

### Task 10: The submitted column on the Assessments page

**Files:**
- Modify: `client/src/StaffHub.jsx` — the `AdminAssessments` component's per-student grade table

**Interfaces:**
- Consumes: `submission` and `recordsSubmissions` from `GET /api/assessments/:id/grades` (Task 5).
- Produces: nothing later tasks rely on.

- [ ] **Step 1: Find the grade table**

```bash
grep -n "AdminAssessments\|/grades" client/src/StaffHub.jsx | head -20
```

Locate the component that renders one row per student with their mark.

- [ ] **Step 2: Add the column**

Add a "Submitted" column beside the mark. Rendering rules, in order:

- `row.submission === null` → **"Not synced"** when `recordsSubmissions` is `false`, **"Awaiting sync"** when it is `true`. Muted styling, never a warning colour.
- `row.submission.status === "submitted"` → "Submitted", with `submittedOn` beneath it, and a "late" marker only when `onTime === false`. **`onTime === null` is not late** — you cannot be late for work never handed in.
- `row.submission.status === "not_submitted"` → "Not submitted", warning colour. This is the only case that earns one.
- `row.submission.status === "unknown"` → "Unknown", muted.

Add a one-line note above the table while `recordsSubmissions` is `false`: *"Submission data is imported from the LMS and no import has run yet."*

- [ ] **Step 3: Verify it compiles**

```bash
npm run --workspace client build
```

Expected: build succeeds.

- [ ] **Step 4: Full verification before declaring done**

```bash
cd server && node --test "src/**/*.test.js"
cd .. && DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test
npm run --workspace client build
```

Expected: unit tests pass; smoke suites show no new failures against the baseline; client builds. **Paste the actual output before claiming completion** — no success claim without the command output that supports it.

- [ ] **Step 5: Commit**

```bash
git add client/src/StaffHub.jsx
git commit -m "The gradebook shows who submitted, and says when it simply does not know"
```

---

## Self-review notes

**Spec coverage.** §1 → Task 1. §2 derivations → Task 2; §2 router and the two-level unknown → Task 4. §3 writes and guard widening → Task 3 (with the recorded deviation: a narrow new route rather than widening the gradebook's gate, because that gate protects student marks). §4 pages → Tasks 7, 8; four lists → Task 9. §5 rendering rules → Tasks 8, 10. §6 submitted column → Tasks 5, 10. §7 sync button → Task 8 Step 2, with the `SYNC_PAGES` deviation recorded at the top of this plan. §8 testing → Tasks 2 and 6. §9, §10 → nothing to build.

**Two uncertainties resolved before this plan was finalised, rather than left to the implementer:**

- `Staff` has **no `active` column** (checked against `model Staff` in `schema.prisma`). Task 4's staff query filters on nothing.
- `activeKey` is `nav.some(n => n.key === tab) ? tab : nav[0].key` at `StaffHub.jsx:2705`, and buttons call `setTab(n.key)` — so two nav entries cannot share a key. Task 9 now uses the exception the `audit` key already established at line 2699: a distinct nav key whose visibility derives from a grantable one. Four hand-maintained lists, not five.

**Type consistency.** `submissionRate`/`markingRate`/`coverageRate`/`deadlineState`/`markingState` are named identically in Task 2's tests, Task 2's implementation and Task 4's router. `recordsSubmissions` is the response field name in both Task 4 and Task 5, and the client reads that name in Tasks 8 and 10. `leaderStaffId` and `markingDueDate` are spelled the same in the schema, the migration SQL, both serializers, both write routes and both client pages.
