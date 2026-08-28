# NFC Tap Check-In — Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A student taps a classroom sticker in the app and their attendance mark is saved with the minute they arrived; a staff member taps the same sticker and is clocked in Onsite.

**Architecture:** One pure resolver decides which register a tap belongs to and whether it is `P` or `L`, with tests beside it and no database. Two thin endpoints sit on top — one under `/api/student` (already inside `STUDENT_ROUTERS`, so the student portal's isolation is untouched) and one under `/api/checkins`, reusing the existing `CheckIn` model unchanged. Both write a `TagTap` log row on every outcome, accepted or refused. A per-tenant config module following `attendanceBandConfig.js` keeps the feature switched off until a college turns it on.

**Tech Stack:** Node 20, Express, Prisma 6 / PostgreSQL, `node:test` for unit tests, `scripts/smoke-*.mjs` for HTTP suites.

**Spec:** `docs/superpowers/specs/2026-08-28-nfc-attendance-design.md`

## Scope

This plan is the **server half only**, which is what makes both check-ins work and testable end to end. Deliberately out of this plan, each needing its own:

- The Capacitor client — NFC reading, the student check-in screen, the staff Onsite prompt.
- The lecturer's live dashboard (spec §7).
- The tag admin screen in `StaffHub.jsx` (the API for it **is** in this plan, Task 6).

## Global Constraints

Copied verbatim from the spec and `CLAUDE.md`. Every task's requirements implicitly include these.

- **`DATABASE_URL` in `server/.env` points at a live database.** Do not run `npm test`, `prisma migrate dev`, `prisma db push`, or any seed script against it. Unit tests (`node --test`) touch no database and are safe. The smoke suite in Task 7 is written to run **in CI**, not locally.
- **Use the glob, never a bare directory:** `node --test "src/**/*.test.js"`. Given `src/`, the runner walks into `src/index.js`, binds a port, starts the schedulers and never terminates.
- **Never rename a migration directory once created.** Prisma identifies a migration by directory name; a rename makes it re-run, hit "already exists", and record as failed, after which P3009 blocks every later deploy. This has cost the project two outages.
- **Migration directory name:** `20260829T090000_nfc_tap_check_in`. Format matches the existing `YYYYMMDDTHHMMSS_snake_case` convention (latest is `20260829T070000_cohort_and_coverage`).
- **Null means "not measurable", zero means zero.** Every new column that can be absent is nullable. Never a sentinel, never `0`, never `""`.
- **Dates are `YYYY-MM-DD` strings, times are `HH:MM` 24-hour strings**, compared as strings. Every user-facing date or time comes from `clock.localDate()` / `clock.localTime()` — never the host clock, never `new Date()` for a displayed time.
- **Serialise through allowlists.** A new column is invisible to clients until named explicitly in the serialiser.
- **Rate limiters are in-process module-level `Map`s**, each carrying a comment saying it needs Redis under clustering.
- **`ADMIN_PAGES` exists twice** — `server/src/validate.js` and `client/src/StaffHub.jsx` — and both are changed in the same commit.
- **A tap never writes `A`.** There is no path from this feature to an absence.
- **A tap never overwrites an existing mark**, whatever its status.
- **Prove every regression test can fail** by reintroducing the bug before trusting it.

---

### Task 1: Schema and migration

**Files:**
- Modify: `server/prisma/schema.prisma`
- Create: `server/prisma/migrations/20260829T090000_nfc_tap_check_in/migration.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma models `AttendanceTag` and `TagTap`; new nullable columns `AttendanceMark.checkedInAt` (String?) and `CheckIn.tagId` (String?). Every later task reads these.

- [ ] **Step 1: Snapshot the current schema so the migration can be generated offline**

There is no local PostgreSQL on this machine, so `prisma migrate dev` (which needs a shadow database) is unavailable — and it would target the live database anyway. Diffing two schema *files* needs no database at all.

```bash
cd server
cp prisma/schema.prisma /tmp/schema-before.prisma
```

- [ ] **Step 2: Add the two new models to `server/prisma/schema.prisma`**

Append after the `AttendanceMark` model:

```prisma
// A registered NFC sticker. One per room, and the SAME sticker serves students and
// staff — the server branches on who is signed in, not on which tag was touched, so a
// college prints one sticker per room rather than two.
model AttendanceTag {
  id        String    @id @default(cuid())
  // The secret written onto the sticker. Opaque and random — deliberately NOT a URL.
  // Our own app reads it, so there is nothing to gain from it being clickable and a lot
  // to lose: a readable link is one a student can save off the wall and replay from
  // home. Globally unique rather than unique-per-tenant so a code is never ambiguous.
  code      String    @unique
  label     String                       // "Room 101", "Reception"
  active    Boolean   @default(true)     // deactivate a peeled-off or lost sticker
  // NULL until the first tap — "never used", which is not the same as a zero date.
  lastTapAt DateTime?
  createdAt DateTime  @default(now())
  createdBy String?
  taps      TagTap[]

  // Which institution this row belongs to. Enforced centrally — see db.js.
  tenantId String
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  @@index([tenantId])
}

// Every tap, accepted or refused. The refusals are the valuable half: "I did tap, it
// didn't work" is a question this system must be able to answer, and one address
// checking in six students inside a minute is invisible in AttendanceMark and obvious
// here.
model TagTap {
  id        String        @id @default(cuid())
  tag       AttendanceTag @relation(fields: [tagId], references: [id], onDelete: Cascade)
  tagId     String
  // Exactly one of these is set on an accepted tap; BOTH are null when the tap was
  // refused before anyone was identified. Not measurable — never a blank string
  // standing in for a person.
  studentId String?
  staffId   String?
  sessionId String?       // the register a student tap landed on
  outcome   String        // marked | checked_in | already_marked | already_checked_in |
                          // no_session_now | ambiguous | term_locked | tag_unknown |
                          // rate_limited | disabled
  status    String?       // "P" | "L" when a mark was actually written
  site      String?       // "Onsite" for a staff tap — a tap proves they are here
  at        DateTime      @default(now())
  ip        String?

  @@index([tagId, at])
  @@index([studentId])
  @@index([staffId])

  // Which institution this row belongs to. Enforced centrally — see db.js.
  tenantId String
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  @@index([tenantId])
}

// Per-college settings for tap check-in. Same shape as AttendanceBandConfig: platform
// defaults in code, one JSON column merged over them, no row until a college edits
// something, an allowlist on the way out, a short cache invalidated on save.
model AttendanceTapConfig {
  id        String   @id @default(cuid())
  settings  Json     @default("{}")
  updatedBy String?
  updatedAt DateTime @updatedAt

  tenantId String @unique
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
}
```

- [ ] **Step 3: Add the two new columns**

In `model AttendanceMark`, immediately after the `takenAt` line:

```prisma
  // When the student actually tapped in. NULL when nobody self-checked-in — the
  // lecturer marked them by hand — which is "not measurable", not an early arrival.
  //
  // Written ONCE and never again. A later register save must not overwrite it: takenAt
  // is already reset on every update (hnd.js writes `takenAt: new Date()`), so it means
  // "when this mark was last edited", and a lecturer correcting the register at four
  // o'clock would otherwise destroy the only record of the 09:07 arrival.
  //
  // A string, not a DateTime, matching CheckIn.timeIn: the session carries the date, so
  // the two reconstruct the instant, and a time written through clock.localTime() is
  // right when stored and stays right. STATUS.md records D8 — the 08:00 notifications
  // firing at 09:00 through BST because something read the host clock — which is the bug
  // a stored instant re-zoned at every render invites back.
  checkedInAt String?   // "HH:MM", London
```

In `model CheckIn`, immediately after the `site` line:

```prisma
  // The sticker this clock-in was made at. NULL for one made by pressing the button in
  // the app, which stays available. Distinguishes "was in the building" from "said they
  // were", without a second boolean that could disagree with it.
  tagId     String?
```

In `model Tenant`, add the three back-relations alongside the existing ones:

```prisma
  attendanceTags      AttendanceTag[]
  tagTaps             TagTap[]
  attendanceTapConfig AttendanceTapConfig?
```

- [ ] **Step 4: Generate the migration SQL offline, without touching any database**

```bash
cd server
mkdir -p prisma/migrations/20260829T090000_nfc_tap_check_in
npx prisma migrate diff \
  --from-schema-datamodel /tmp/schema-before.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/20260829T090000_nfc_tap_check_in/migration.sql
```

- [ ] **Step 5: Read the generated SQL and confirm it is additive only**

```bash
cat prisma/migrations/20260829T090000_nfc_tap_check_in/migration.sql
```

Expected: only `CREATE TABLE`, `CREATE INDEX`, `CREATE UNIQUE INDEX`, `ALTER TABLE ... ADD COLUMN`, and `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY`.

**Stop and do not proceed** if you see any `DROP`, any `ALTER COLUMN`, or any `ADD COLUMN` without a nullable type and no default. Both new columns must be plain nullable adds — a `NOT NULL` add against a populated table fails on deploy.

- [ ] **Step 6: Regenerate the Prisma client**

```bash
cd server && npm run generate
```
Expected: "Generated Prisma Client" with no errors.

- [ ] **Step 7: Confirm the existing unit tests still pass**

```bash
cd server && node --test "src/**/*.test.js"
```
Expected: all pass. `schema-contract.test.js` parses `schema.prisma`, so a syntax error surfaces here.

- [ ] **Step 8: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations/20260829T090000_nfc_tap_check_in/
git commit -m "Tags, a tap log, and the arrival time that survives a correction

AttendanceMark.takenAt is reset on every update, so it means 'when this mark
was last edited', not 'when the student arrived' — a lecturer correcting the
register at four o'clock would destroy the 09:07 tap. checkedInAt is written
once and never again, as HH:MM through clock.localTime(), matching CheckIn.timeIn
and avoiding the re-zoning that gave us D8.

TagTap records refused taps as well as accepted ones. 'I did tap and it didn't
work' is a question attendance evidence has to answer, and one handset checking
in six students is invisible in AttendanceMark and obvious here."
```

---

### Task 2: The settings module (pure half)

**Files:**
- Create: `server/src/attendanceTapSettings.js`
- Test: `server/src/attendanceTapSettings.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `DEFAULTS` (object), `SETTING_FIELDS` (string[]), `merge(stored) → settings` — the pure merge-and-clamp used by Task 3's config resolver and both endpoints.

- [ ] **Step 1: Write the failing test**

Create `server/src/attendanceTapSettings.test.js`:

```js
// The pure half of tap check-in's per-college settings: what the defaults are, and
// what a stored blob is allowed to change them to.
//
// No database. The DB-backed half lives in attendanceTapConfig.js.
//
// Run with: node --test src/attendanceTapSettings.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const { DEFAULTS, SETTING_FIELDS, merge } = require("./attendanceTapSettings");

test("an unconfigured college gets the defaults, and the feature is OFF", () => {
  // Shipping enabled would switch this on at every college on the next deploy.
  // Attendance emails ship off for the same reason.
  const s = merge(null);
  assert.equal(s.enabled, false);
  assert.equal(s.lateAfterMins, 15);
  assert.equal(s.earlyGraceMins, 0);
  assert.equal(s.armSeconds, 60);
  assert.equal(s.staffTapEnabled, true);
});

test("a stored value overrides just that key, leaving the rest at the defaults", () => {
  const s = merge({ lateAfterMins: 5 });
  assert.equal(s.lateAfterMins, 5);
  assert.equal(s.earlyGraceMins, DEFAULTS.earlyGraceMins);
  assert.equal(s.enabled, false);
});

test("a key nobody defined is dropped, not carried through", () => {
  // The allowlist is on the way OUT, so a column or key added tomorrow is private
  // until someone publishes it deliberately.
  const s = merge({ enabled: true, secretInternalNote: "do not ship" });
  assert.equal(s.enabled, true);
  assert.equal("secretInternalNote" in s, false);
  assert.deepEqual(Object.keys(s).sort(), [...SETTING_FIELDS].sort());
});

test("a nonsense value falls back to the default rather than poisoning the maths", () => {
  // A negative grace would accept taps AFTER a lecture ended; a string would make
  // every comparison NaN and silently mark nobody. Both are recoverable only if the
  // resolver never sees them.
  assert.equal(merge({ lateAfterMins: -5 }).lateAfterMins, DEFAULTS.lateAfterMins);
  assert.equal(merge({ earlyGraceMins: "soon" }).earlyGraceMins, DEFAULTS.earlyGraceMins);
  assert.equal(merge({ armSeconds: null }).armSeconds, DEFAULTS.armSeconds);
});

test("minutes are capped, so one typo cannot open a register all day", () => {
  // 600 in earlyGraceMins would accept a tap ten hours before the class.
  assert.equal(merge({ earlyGraceMins: 600 }).earlyGraceMins, 120);
  assert.equal(merge({ lateAfterMins: 9999 }).lateAfterMins, 120);
});

test("enabled must be a real boolean — a truthy string is a mistake, not consent", () => {
  assert.equal(merge({ enabled: "false" }).enabled, false);
  assert.equal(merge({ enabled: 1 }).enabled, false);
  assert.equal(merge({ enabled: true }).enabled, true);
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd server && node --test src/attendanceTapSettings.test.js
```
Expected: FAIL — `Cannot find module './attendanceTapSettings'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/attendanceTapSettings.js`:

```js
// Per-college settings for NFC tap check-in — the pure half.
//
// Split from attendanceTapConfig.js on purpose: everything here is a function of its
// arguments, so the rules a college's attendance depends on are testable without a
// database. The DB-backed resolver next door does the caching and the writing.
//
// Shape follows attendanceBandConfig.js, which is the reference implementation:
// platform defaults in code, one JSON column merged over them, an allowlist on the way
// out, a short cache invalidated on save.

const DEFAULTS = Object.freeze({
  // Ships OFF. Attendance emails do the same, and for the same reason: a feature that
  // writes to the attendance record must not switch itself on at every college on the
  // next deploy.
  enabled: false,
  // Past this many minutes after the start, a tap records L rather than P.
  lateAfterMins: 15,
  // Minutes BEFORE the start that taps begin to be accepted. Zero is the rule as
  // specified — not before the lecture. It is a setting because a student outside the
  // door at 08:58 for a 09:00 class is a normal thing that will be reported as a bug,
  // and a college that decides five minutes is fine should not need a deploy to say so.
  earlyGraceMins: 0,
  // How long a tag read keeps the check-in button live in the app. Long enough to
  // press, too short to walk to another room.
  armSeconds: 60,
  // Whether the same stickers also clock staff in.
  staffTapEnabled: true,
});

const SETTING_FIELDS = Object.freeze(Object.keys(DEFAULTS));

// A ceiling on every minute field. Without one, a typo of 600 in earlyGraceMins accepts
// a tap ten hours before the class starts — which is not a setting, it is an outage in
// the attendance record. Two hours is past any plausible intent.
const MAX_MINS = 120;
const MAX_ARM_SECONDS = 600;

/** A whole number of minutes within range, or null when the value is unusable. */
function minutes(v, max) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  if (n < 0) return null;
  return Math.min(n, max);
}

/**
 * The settings this college actually runs on: the defaults, with any stored value
 * merged over them.
 *
 * Always complete and always valid, so no caller needs a fallback of its own and no
 * caller can be handed a half-configured object. A stored blob can predate a rule or be
 * edited by hand in a console; an unusable value falls back to the platform default
 * rather than reaching the resolver, where a NaN comparison would silently mark nobody
 * and look exactly like a quiet day.
 */
function merge(stored) {
  const out = { ...DEFAULTS };
  if (!stored || typeof stored !== "object") return out;

  // Booleans are compared identically, not coerced. "false" and 0 are both truthy-ish
  // mistakes somewhere in a chain of JSON, and reading either as consent to switch a
  // college on is the wrong failure.
  if (stored.enabled === true || stored.enabled === false) out.enabled = stored.enabled;
  if (stored.staffTapEnabled === true || stored.staffTapEnabled === false) out.staffTapEnabled = stored.staffTapEnabled;

  const late = minutes(stored.lateAfterMins, MAX_MINS);
  if (late !== null) out.lateAfterMins = late;

  const grace = minutes(stored.earlyGraceMins, MAX_MINS);
  if (grace !== null) out.earlyGraceMins = grace;

  const arm = minutes(stored.armSeconds, MAX_ARM_SECONDS);
  if (arm !== null) out.armSeconds = arm;

  return out;
}

module.exports = { DEFAULTS, SETTING_FIELDS, MAX_MINS, MAX_ARM_SECONDS, merge };
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
cd server && node --test src/attendanceTapSettings.test.js
```
Expected: PASS, 6 tests.

- [ ] **Step 5: Prove the allowlist test can fail**

Temporarily change `merge` to `const out = { ...DEFAULTS, ...stored };` and re-run. Expected: the "a key nobody defined is dropped" test FAILS. Restore the original line and re-run to confirm PASS. A test that passes against a blocklist is discriminating nothing.

- [ ] **Step 6: Commit**

```bash
git add server/src/attendanceTapSettings.js server/src/attendanceTapSettings.test.js
git commit -m "Tap settings, with the allowlist and the cap that make them safe to store

Ships enabled:false, like attendance emails — a feature that writes to the
attendance record must not switch itself on at every college on a deploy.

Two guards earn their place. The allowlist is on the way OUT, so a key added
tomorrow is private until published deliberately. And every minute field is
capped: a typo of 600 in earlyGraceMins is not a setting, it accepts a tap ten
hours before the class. An unusable value falls back to the default rather than
reaching the resolver, where a NaN comparison marks nobody and looks like a
quiet day."
```

---

### Task 3: The session resolver

**Files:**
- Create: `server/src/attendanceTap.js`
- Test: `server/src/attendanceTap.test.js`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `addMinutes(hhmm: string, mins: number) → string`
  - `subMinutes(hhmm: string, mins: number) → string`
  - `resolveTapSession(candidates, now, settings) → Result`
    - `candidates`: `[{ id, unitId, unitCode, unitName, date, startTime, endTime, term }]` where `term` is `{ name, start, end } | null`
    - `now`: `{ date: "YYYY-MM-DD", time: "HH:MM" }`
    - `settings`: `{ lateAfterMins, earlyGraceMins }`
    - `Result`: `{ kind: "one", session, status: "P"|"L" }` | `{ kind: "ambiguous", sessions }` | `{ kind: "none", reason: "no_session_now"|"term_locked" }`

- [ ] **Step 1: Write the failing test**

Create `server/src/attendanceTap.test.js`:

```js
// Which register a tap belongs to, and whether it is Present or Late.
//
// No database. The route layer hands over the sessions it has already read; every
// interesting case is therefore a plain object and a call, which is the same reason
// src/prediction/ and src/vle/*Normalise.js are shaped this way.
//
// Run with: node --test src/attendanceTap.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const { addMinutes, subMinutes, resolveTapSession } = require("./attendanceTap");

const TODAY = "2026-09-01";

/** One candidate session. Times are HH:MM; term null means "not term-locked". */
const session = (over = {}) => ({
  id: "s1",
  unitId: "u1",
  unitCode: "LM",
  unitName: "Leadership and Management",
  date: TODAY,
  startTime: "09:00",
  endTime: "12:00",
  term: null,
  ...over,
});

const at = (time, date = TODAY) => ({ date, time });
const settings = (over = {}) => ({ lateAfterMins: 15, earlyGraceMins: 0, ...over });

/* -------------------------------------------------------------------------- */
/* Clock arithmetic                                                            */
/* -------------------------------------------------------------------------- */

test("adding and subtracting minutes rolls the hour correctly", () => {
  assert.equal(addMinutes("09:00", 15), "09:15");
  assert.equal(addMinutes("09:50", 15), "10:05");
  assert.equal(subMinutes("09:00", 15), "08:45");
  assert.equal(subMinutes("09:05", 15), "08:50");
});

test("arithmetic clamps at the ends of the day rather than wrapping", () => {
  // A lecture does not cross midnight. Wrapping would turn "15 minutes before 00:05"
  // into 23:50 — a time LATER in the string ordering than everything else, which
  // would accept taps all day.
  assert.equal(subMinutes("00:05", 15), "00:00");
  assert.equal(addMinutes("23:55", 15), "23:59");
});

/* -------------------------------------------------------------------------- */
/* Choosing the session                                                        */
/* -------------------------------------------------------------------------- */

test("no sessions at all is a refusal, not a crash", () => {
  const r = resolveTapSession([], at("09:07"), settings());
  assert.equal(r.kind, "none");
  assert.equal(r.reason, "no_session_now");
});

test("one lecture running now is marked present", () => {
  const r = resolveTapSession([session()], at("09:07"), settings());
  assert.equal(r.kind, "one");
  assert.equal(r.session.id, "s1");
  assert.equal(r.status, "P");
});

test("a tap BEFORE the lecture starts is refused when grace is zero", () => {
  // This is the rule as specified: not before the lecture.
  const r = resolveTapSession([session()], at("08:58"), settings({ earlyGraceMins: 0 }));
  assert.equal(r.kind, "none");
  assert.equal(r.reason, "no_session_now");
});

test("the same tap is accepted once the college allows five minutes of grace", () => {
  const r = resolveTapSession([session()], at("08:58"), settings({ earlyGraceMins: 5 }));
  assert.equal(r.kind, "one");
  assert.equal(r.status, "P");
});

test("a tap AFTER the lecture ends is refused", () => {
  const r = resolveTapSession([session()], at("12:01"), settings());
  assert.equal(r.kind, "none");
  assert.equal(r.reason, "no_session_now");
});

test("a tap on the closing minute still counts", () => {
  // The lecture is running at 12:00. Excluding the boundary would refuse a student
  // who tapped as the class ended, which is a real arrival.
  const r = resolveTapSession([session()], at("12:00"), settings());
  assert.equal(r.kind, "one");
});

test("yesterday's session is not a candidate today", () => {
  const r = resolveTapSession([session({ date: "2026-08-31" })], at("09:07"), settings());
  assert.equal(r.kind, "none");
  assert.equal(r.reason, "no_session_now");
});

/* -------------------------------------------------------------------------- */
/* Present or Late                                                             */
/* -------------------------------------------------------------------------- */

test("exactly on the late threshold is still Present", () => {
  // 09:00 + 15 = 09:15. A student who made it inside the window was not late, and an
  // off-by-one here decides a real student's mark.
  const r = resolveTapSession([session()], at("09:15"), settings({ lateAfterMins: 15 }));
  assert.equal(r.status, "P");
});

test("one minute past the threshold is Late", () => {
  const r = resolveTapSession([session()], at("09:16"), settings({ lateAfterMins: 15 }));
  assert.equal(r.status, "L");
});

test("a tap inside the early grace is Present, never Late", () => {
  const r = resolveTapSession([session()], at("08:57"), settings({ earlyGraceMins: 5 }));
  assert.equal(r.status, "P");
});

/* -------------------------------------------------------------------------- */
/* Term lock                                                                   */
/* -------------------------------------------------------------------------- */

test("a session whose term has ended is refused, and says so", () => {
  // The register save returns 423 outside the term window. A tap must not become a
  // back door around it, and the reason has to be distinguishable from "no class on"
  // or nobody can tell a locked term from an empty timetable.
  const r = resolveTapSession(
    [session({ term: { name: "Term 3", start: "2026-01-05", end: "2026-06-30" } })],
    at("09:07"), settings(),
  );
  assert.equal(r.kind, "none");
  assert.equal(r.reason, "term_locked");
});

test("a session inside its term window is marked normally", () => {
  const r = resolveTapSession(
    [session({ term: { name: "Term 4", start: "2026-08-01", end: "2026-12-20" } })],
    at("09:07"), settings(),
  );
  assert.equal(r.kind, "one");
  assert.equal(r.status, "P");
});

test("term_locked is only reported when a lecture was actually running", () => {
  // A locked term AND no class on is "no class on". Reporting the lock would tell a
  // student their term is closed when in fact they tapped at the wrong time of day.
  const r = resolveTapSession(
    [session({ endTime: "10:00", term: { name: "Term 3", start: "2026-01-05", end: "2026-06-30" } })],
    at("14:00"), settings(),
  );
  assert.equal(r.reason, "no_session_now");
});

/* -------------------------------------------------------------------------- */
/* More than one                                                               */
/* -------------------------------------------------------------------------- */

test("two lectures running at once asks the student which", () => {
  const r = resolveTapSession(
    [session(), session({ id: "s2", unitId: "u2", unitCode: "OBM", unitName: "Organisational Behaviour" })],
    at("09:07"), settings(),
  );
  assert.equal(r.kind, "ambiguous");
  assert.equal(r.sessions.length, 2);
});

test("a term-locked overlap does not make the open one ambiguous", () => {
  // Only one of these can be marked, so there is nothing to ask about.
  const r = resolveTapSession(
    [
      session(),
      session({ id: "s2", unitId: "u2", term: { name: "Term 3", start: "2026-01-05", end: "2026-06-30" } }),
    ],
    at("09:07"), settings(),
  );
  assert.equal(r.kind, "one");
  assert.equal(r.session.id, "s1");
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd server && node --test src/attendanceTap.test.js
```
Expected: FAIL — `Cannot find module './attendanceTap'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/attendanceTap.js`:

```js
// Which register an NFC tap belongs to, and whether it is Present or Late.
//
// Pure: it takes the candidate sessions the route has already read, plus the current
// local date and time, and returns a decision. No database, no clock — the caller reads
// the clock through clock.js and passes it in, so every boundary case in here is an
// ordinary unit test rather than something that only reproduces at 09:15.
//
// The rule, in one line: taps are accepted while the lecture is running and at no other
// time. There is no window for a lecturer to open and nothing to remember to switch off
// — the timetable already knows when the class is.

/** "HH:MM" → minutes since midnight. NaN-safe: an unparseable time sorts nowhere. */
function toMins(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ""));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** minutes since midnight → "HH:MM", clamped to the day. */
function toHHMM(mins) {
  const n = Math.max(0, Math.min(23 * 60 + 59, Math.round(mins)));
  return String(Math.floor(n / 60)).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0");
}

// Clamped rather than wrapped, deliberately. A lecture does not cross midnight, and
// wrapping would turn "fifteen minutes before 00:05" into 23:50 — a string that sorts
// LATER than every other time of day, which would accept taps around the clock.
const addMinutes = (hhmm, mins) => { const b = toMins(hhmm); return b === null ? hhmm : toHHMM(b + mins); };
const subMinutes = (hhmm, mins) => { const b = toMins(hhmm); return b === null ? hhmm : toHHMM(b - mins); };

/**
 * Decide which of a student's sessions a tap lands on.
 *
 * @param candidates today's sessions on units this student is enrolled on. Enrolment is
 *   what makes a student eligible for a register at all, so the caller builds this list
 *   from Enrolment — the same reason the register save checks enrolment rather than mere
 *   existence, and what stops a tap attaching a student to a unit they were never on.
 * @param now { date: "YYYY-MM-DD", time: "HH:MM" } in the college's zone, from clock.js
 * @param settings { lateAfterMins, earlyGraceMins }
 */
function resolveTapSession(candidates, now, settings) {
  const list = Array.isArray(candidates) ? candidates : [];
  const grace = Number(settings?.earlyGraceMins) || 0;
  const late = Number(settings?.lateAfterMins) || 0;

  // Running right now. Both ends inclusive: a student who tapped as the class ended
  // did arrive, and excluding the closing minute would refuse a real attendance.
  const running = list.filter((s) => {
    if (s.date !== now.date) return false;
    const from = toMins(subMinutes(s.startTime, grace));
    const to = toMins(s.endTime);
    const t = toMins(now.time);
    if (from === null || to === null || t === null) return false;
    return t >= from && t <= to;
  });

  // Nothing running is "no class on", whatever the terms say. Reported before the term
  // check so a student who tapped at the wrong time of day is not told their term is
  // closed — two different problems with two different remedies.
  if (running.length === 0) return { kind: "none", reason: "no_session_now" };

  // The term gate, matching PUT /sessions/:id/register, which returns 423 outside the
  // window. A tap must not become a back door around a locked term.
  const open = running.filter((s) => !s.term || (now.date >= s.term.start && now.date <= s.term.end));
  if (open.length === 0) return { kind: "none", reason: "term_locked" };

  // Two lectures genuinely running at once is a question only the student can answer.
  if (open.length > 1) return { kind: "ambiguous", sessions: open };

  const s = open[0];
  // Zero-padded HH:MM sorts chronologically, so a plain string compare is enough — the
  // convention already used throughout checkins.js and hnd.js. Inclusive: arriving
  // exactly on the threshold is not late, and an off-by-one here decides a real mark.
  const status = now.time <= addMinutes(s.startTime, late) ? "P" : "L";
  return { kind: "one", session: s, status };
}

module.exports = { addMinutes, subMinutes, resolveTapSession };
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
cd server && node --test src/attendanceTap.test.js
```
Expected: PASS, 16 tests.

- [ ] **Step 5: Prove the two tests that matter most can fail**

Each of these guards a rule a student's mark depends on, so each must be shown to discriminate:

1. Change `t <= to` to `t < to` and re-run. Expected: "a tap on the closing minute still counts" FAILS. Restore.
2. Change `now.time <= addMinutes(...)` to `now.time < addMinutes(...)` and re-run. Expected: "exactly on the late threshold is still Present" FAILS. Restore.
3. Move the `open.length === 0` check above the `running.length === 0` check and re-run. Expected: "term_locked is only reported when a lecture was actually running" FAILS. Restore.

Re-run after restoring and confirm all 16 pass again.

- [ ] **Step 6: Commit**

```bash
git add server/src/attendanceTap.js server/src/attendanceTap.test.js
git commit -m "The lecture's own hours are the window, and both ends are inclusive

Pure, so every boundary is an ordinary unit test rather than something that
only reproduces at 09:15. Three decisions in here each decide a real mark.

Both ends of the window are inclusive: a student who tapped as the class ended
did arrive. Exactly on the late threshold is Present, not Late — an off-by-one
is somebody's attendance record.

'No class on' is reported BEFORE the term check, so a student who tapped at two
in the afternoon is not told their term is closed. Two different problems with
two different remedies.

Minute arithmetic clamps rather than wraps. A lecture does not cross midnight,
and wrapping 'fifteen minutes before 00:05' to 23:50 produces a string that
sorts later than every other time of day, which would accept taps around the
clock."
```

---

### Task 4: The config resolver (database half)

**Files:**
- Create: `server/src/attendanceTapConfig.js`

**Interfaces:**
- Consumes: `attendanceTapSettings.merge`, `DEFAULTS`.
- Produces: `get() → Promise<settings>`, `save(patch, updatedBy) → Promise<{ ok, settings }>`, `invalidate(tenantId)`.

- [ ] **Step 1: Write the implementation**

There is no unit test for this file: every line of it is a Prisma call or a cache read, and the logic worth testing was deliberately split into `attendanceTapSettings.js` in Task 2. Its behaviour is covered by the smoke suite in Task 7.

Create `server/src/attendanceTapConfig.js`:

```js
// This college's tap check-in settings, resolved and cached.
//
// The DB-backed half of attendanceTapSettings.js, in the shape branding.js and
// attendanceBandConfig.js established: a per-tenant row, defaults that make an
// unconfigured college behave exactly as it did before, an allowlist on the way out
// (in the settings module), and a short cache invalidated on save.
const prisma = require("./db");
const { currentTenantId } = require("./db");
const { DEFAULTS, merge } = require("./attendanceTapSettings");

// Short, matching branding.js and attendanceBandConfig.js. This is read on every tap,
// it changes about never, and an administrator who has just switched the feature on
// should see it work while they are still looking at the screen.
const TTL_MS = Number(process.env.ATTENDANCE_TAP_CACHE_MS ?? 30_000);
const cache = new Map(); // tenantId -> { value, at }

function invalidate(tenantId) {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

/**
 * The settings in force for the current institution. Always complete and always valid.
 */
async function get() {
  const tenantId = currentTenantId();
  // Outside a request — a script, a one-off — there is no institution to look up, and
  // the defaults are the honest answer. They have `enabled: false`, so nothing outside
  // a request can accidentally mark anybody.
  if (!tenantId) return { ...DEFAULTS };

  const hit = cache.get(tenantId);
  if (TTL_MS > 0 && hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let row = null;
  try {
    row = await prisma.attendanceTapConfig.findFirst();
  } catch {
    row = null; // table not migrated yet — the defaults are correct, not an error
  }

  const value = merge(row?.settings);
  cache.set(tenantId, { value, at: Date.now() });
  return value;
}

/**
 * Merge a patch into this college's settings.
 *
 * A PATCH, not a replacement: an administrator switching the feature on should not
 * silently reset the lateness threshold somebody tuned last term. The allowlist and the
 * caps live in merge(), so nothing written here can be read back as unusable.
 */
async function save(patch, updatedBy) {
  const tenantId = currentTenantId();
  const existing = await prisma.attendanceTapConfig.findFirst();
  const next = merge({ ...(existing?.settings || {}), ...(patch || {}) });

  if (existing) await prisma.attendanceTapConfig.update({ where: { id: existing.id }, data: { settings: next, updatedBy: updatedBy || null } });
  else await prisma.attendanceTapConfig.create({ data: { settings: next, updatedBy: updatedBy || null } });

  invalidate(tenantId);
  return { ok: true, settings: next };
}

module.exports = { get, save, invalidate };
```

- [ ] **Step 2: Confirm the file loads and the unit suite still passes**

```bash
cd server && node -e "require('./src/attendanceTapConfig'); console.log('loads')" && node --test "src/**/*.test.js"
```
Expected: `loads`, then all unit tests pass.

- [ ] **Step 3: Commit**

```bash
git add server/src/attendanceTapConfig.js
git commit -m "Tap settings resolver: a patch, not a replacement

Switching the feature on must not silently reset a lateness threshold somebody
tuned last term, so save() merges rather than overwrites. The allowlist and the
caps stay in the pure module, so nothing written here reads back as unusable.

No tests on this file, deliberately: every line is a Prisma call or a cache
read, and the logic worth testing was split into attendanceTapSettings.js so it
could be tested without a database at all."
```

---

### Task 5: The student tap endpoint

**Files:**
- Modify: `server/src/routes/student.js`
- Modify: `server/src/serializers.js` (the `sMark` line)

**Interfaces:**
- Consumes: `resolveTapSession` (Task 3), `attendanceTapConfig.get` (Task 4), the `AttendanceTag` / `TagTap` models (Task 1).
- Produces: `POST /api/student/me/tap-check-in` and `GET /api/student/me/tap-context`.

- [ ] **Step 1: Publish `checkedInAt` through the mark serialiser**

In `server/src/serializers.js`, replace the `sMark` line with:

```js
// checkedInAt is named explicitly because this is an allowlist: a column added to
// AttendanceMark tomorrow stays private until somebody publishes it deliberately.
const sMark = (m) => ({ id: m.id, sessionId: m.sessionId, studentId: m.studentId, status: m.status, remark: m.remark, takenBy: m.takenBy, takenAt: m.takenAt, checkedInAt: m.checkedInAt ?? null });
```

- [ ] **Step 2: Add the imports to `server/src/routes/student.js`**

At the top, after the existing requires:

```js
const audit = require("../audit");
const tapConfig = require("../attendanceTapConfig");
const predictionRunner = require("../prediction/runner");
const { resolveTapSession } = require("../attendanceTap");
const { localDate, localTime } = require("../clock");
const { isString } = require("../validate");
```

- [ ] **Step 3: Add the shared helpers, above the route definitions**

```js
// The stamp that marks a mark as the student's own. takenBy already carries provenance
// this way for the Moodle importer, so a self check-in is distinguishable in the
// register UI and in the audit trail without a new column.
const SELF_STAMP = "Self check-in (NFC)";

// In-process, module-level, and therefore correct for ONE Node process — a clustered
// deployment needs Redis. Keyed on the student because the caller is authenticated:
// this is not a login endpoint, so the point is to stop a loop, not to ration people.
const taps = new Map(); // studentId -> number[] of timestamps
const TAP_WINDOW_MS = 60_000;
const TAP_MAX = 10;
function tapAllowed(studentId) {
  const now = Date.now();
  const recent = (taps.get(studentId) || []).filter((t) => now - t < TAP_WINDOW_MS);
  if (recent.length >= TAP_MAX) { taps.set(studentId, recent); return false; }
  recent.push(now);
  taps.set(studentId, recent);
  return true;
}

/**
 * Record what happened, whatever happened.
 *
 * Never throws into the request. A tap that WAS marked must not report a failure
 * because the log write did — the register is the record, this is the account of it.
 */
async function logTap(req, fields) {
  try {
    await prisma.tagTap.create({ data: { ip: req.ip ? String(req.ip).slice(0, 60) : null, ...fields } });
  } catch (e) {
    console.error("[tap] could not log a tap:", e.message);
  }
}

/** Today's sessions on units this student is enrolled on, shaped for the resolver. */
async function candidateSessions(studentId, date) {
  const enrolments = await prisma.enrolment.findMany({ where: { studentId }, select: { unitId: true } });
  const unitIds = enrolments.map((e) => e.unitId);
  if (!unitIds.length) return [];
  const sessions = await prisma.hndSession.findMany({
    where: { date, unitId: { in: unitIds } },
    include: { unit: { select: { code: true, name: true, term: { select: { name: true, start: true, end: true } } } } },
  });
  return sessions.map((s) => ({
    id: s.id,
    unitId: s.unitId,
    unitCode: s.unit?.code || "",
    unitName: s.unit?.name || "",
    date: s.date,
    startTime: s.startTime,
    endTime: s.endTime,
    term: s.unit?.term ? { name: s.unit.term.name, start: s.unit.term.start, end: s.unit.term.end } : null,
  }));
}

/** What a session looks like on the check-in screen. No other student's data, ever. */
const sTapSession = (s) => ({ id: s.id, unitCode: s.unitCode, unitName: s.unitName, startTime: s.startTime, endTime: s.endTime });
```

- [ ] **Step 4: Add `GET /api/student/me/tap-context`**

```js
// What the check-in screen shows before a tap: this student's sessions today and
// whether taps are being accepted right now. Keyed on req.user.id like every other
// route in this file — no id parameter exists, so there is nothing to tamper with.
router.get("/me/tap-context", async (req, res) => {
  const settings = await tapConfig.get();
  if (!settings.enabled) return res.json({ enabled: false, armSeconds: settings.armSeconds, now: null, next: null });

  const date = localDate();
  const time = localTime();
  const candidates = await candidateSessions(req.user.id, date);
  const decision = resolveTapSession(candidates, { date, time }, settings);

  // The sessions still to come today, so the screen can say "your next class is at
  // 13:00" rather than only "nothing on now" — which reads as a fault.
  const later = candidates
    .filter((s) => s.startTime > time)
    .sort((a, b) => a.startTime.localeCompare(b.startTime));

  res.json({
    enabled: true,
    armSeconds: settings.armSeconds,
    date,
    now: decision.kind === "one" ? sTapSession(decision.session)
       : decision.kind === "ambiguous" ? decision.sessions.map(sTapSession)
       : null,
    next: later.length ? sTapSession(later[0]) : null,
  });
});
```

- [ ] **Step 5: Add `POST /api/student/me/tap-check-in`**

```js
// Mark this student present at the session running right now.
//
// Writes an ordinary P or L into the existing register. Three things it must never do,
// each of which would damage a record the college is asked to evidence:
//   * overwrite a mark a lecturer already set — the human in the room wins, the same
//     invariant the Moodle importer holds;
//   * write an A — absence is what an untaken register already means, and scoring "did
//     not tap" as absent turns a flat battery into a permanent academic record;
//   * bypass the term lock, which PUT /sessions/:id/register enforces with a 423.
router.post("/me/tap-check-in", async (req, res) => {
  const settings = await tapConfig.get();
  if (!settings.enabled) return res.status(403).json({ error: "Tap check-in isn't switched on for this college." });

  const code = req.body?.tagCode;
  if (!isString(code) || !code.trim()) return res.status(400).json({ error: "A tag is required" });
  const chosenId = req.body?.sessionId;
  if (chosenId != null && !isString(chosenId)) return res.status(400).json({ error: "sessionId must be text" });

  if (!tapAllowed(req.user.id)) return res.status(429).json({ error: "Too many attempts — wait a moment and try again." });

  // Tenant-scoped by db.js, so a tag belonging to another college is simply not found.
  // That is the isolation working, and it needs no special case here.
  const tag = await prisma.attendanceTag.findFirst({ where: { code: code.trim(), active: true } });
  if (!tag) return res.status(404).json({ error: "That tag isn't recognised." });

  const date = localDate();
  const time = localTime();
  const candidates = await candidateSessions(req.user.id, date);
  const decision = resolveTapSession(candidates, { date, time }, settings);

  const base = { tagId: tag.id, studentId: req.user.id };

  if (decision.kind === "none") {
    await logTap(req, { ...base, outcome: decision.reason });
    return res.status(409).json({
      error: decision.reason === "term_locked"
        ? "That class is outside its teaching term, so the register is closed."
        : "No class of yours is running right now.",
      reason: decision.reason,
    });
  }

  let chosen;
  if (decision.kind === "ambiguous") {
    chosen = chosenId ? decision.sessions.find((s) => s.id === chosenId) : null;
    if (!chosen) {
      await logTap(req, { ...base, outcome: "ambiguous" });
      return res.status(300).json({ reason: "ambiguous", sessions: decision.sessions.map(sTapSession) });
    }
  } else {
    chosen = decision.session;
    // A sessionId that names something else is a stale screen or a tampered body. It
    // must not silently mark a different class than the one the student was shown.
    if (chosenId && chosenId !== chosen.id) return res.status(409).json({ error: "That class is no longer running. Try again." });
  }

  // Recomputed for the chosen session rather than reusing the single-session result,
  // so an ambiguous pick gets its own lateness verdict rather than the first one's.
  const status = time <= require("../attendanceTap").addMinutes(chosen.startTime, settings.lateAfterMins) ? "P" : "L";

  const existing = await prisma.attendanceMark.findUnique({
    where: { sessionId_studentId: { sessionId: chosen.id, studentId: req.user.id } },
  });
  if (existing) {
    await logTap(req, { ...base, sessionId: chosen.id, outcome: "already_marked" });
    return res.json({ ok: true, alreadyMarked: true, status: existing.status, checkedInAt: existing.checkedInAt ?? null, session: sTapSession(chosen) });
  }

  const mark = await prisma.attendanceMark.create({
    data: { sessionId: chosen.id, studentId: req.user.id, status, remark: "", takenBy: SELF_STAMP, checkedInAt: time },
  });

  await prisma.attendanceTag.update({ where: { id: tag.id }, data: { lastTapAt: new Date() } });
  await logTap(req, { ...base, sessionId: chosen.id, outcome: "marked", status });

  // Attendance feeds the progression score, and none of that is written by the
  // prediction feature itself — so anything that touches a mark has to say so. Cheap,
  // and deliberately does not rescore: a check-in must not wait on arithmetic.
  try { await predictionRunner.markStale([req.user.id]); }
  catch (e) { console.error("[prediction] could not flag a score after a tap check-in:", e.message); }

  audit.record(req, {
    action: "attendance.tap.marked",
    entity: "AttendanceMark", entityId: mark.id,
    summary: `${req.user.firstName} ${req.user.lastName} checked themselves in at ${time} on the ${chosen.date} register for ${chosen.unitCode} — recorded ${status} via tag "${tag.label}"`,
    before: null,
    after: { sessionId: chosen.id, status, checkedInAt: time, tag: tag.label },
  });

  res.status(201).json({ ok: true, status, checkedInAt: time, session: sTapSession(chosen) });
});
```

- [ ] **Step 6: Confirm the server still boots and the unit suite passes**

```bash
cd server && node -e "require('./src/routes/student'); require('./src/serializers'); console.log('loads')" && node --test "src/**/*.test.js"
```
Expected: `loads`, then all unit tests pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/student.js server/src/serializers.js
git commit -m "A student marks themselves present, and cannot mark themselves absent

Three refusals define this endpoint more than the write does. It never
overwrites a mark a lecturer set — the human in the room wins, the same
invariant the Moodle importer holds. It never writes A: absence is what an
untaken register already means, and scoring 'did not tap' as absent turns a
flat battery into a permanent academic record. And it re-runs the term check
rather than trusting that a session in the timetable is one a register accepts.

Lives under /api/student, already inside STUDENT_ROUTERS, so the portal's
isolation is untouched and no new public router exists. Candidates come from
Enrolment, so a tap can never attach a student to a unit they were never on.

An ambiguous pick recomputes its own lateness rather than inheriting the first
candidate's — the student chose a different class, and it may have started at a
different time."
```

---

### Task 6: The staff tap endpoint and the tag API

**Files:**
- Modify: `server/src/routes/checkins.js`
- Create: `server/src/routes/tags.js`
- Modify: `server/src/index.js` (mount the new router)
- Modify: `server/src/validate.js` (`ADMIN_PAGES`)
- Modify: `client/src/StaffHub.jsx` (`ADMIN_PAGES` — the second hand-maintained copy)

**Interfaces:**
- Consumes: `AttendanceTag`, `TagTap` (Task 1); `attendanceTapConfig.get` (Task 4).
- Produces: `POST /api/checkins/tap-check-in`; `GET|POST|PATCH /api/tags`; `GET /api/tags/:id/log`; the grantable page key `"attendance-tags"`.

- [ ] **Step 1: Add the staff tap to `server/src/routes/checkins.js`**

Add the imports at the top:

```js
const tapConfig = require("../attendanceTapConfig");
```

Then add the route after `POST /check-in`:

```js
// POST /api/checkins/tap-check-in — clock in by touching a tag.
//
// site is NOT asked for and NOT accepted: the tap proves they are in the building, so
// recording anything but "Onsite" would store something the tap itself disproves.
// Working online remains available through POST /check-in, which does take a site.
router.post("/tap-check-in", requireAuth, async (req, res) => {
  const settings = await tapConfig.get();
  if (!settings.enabled || !settings.staffTapEnabled) return res.status(403).json({ error: "Tap check-in isn't switched on for this college." });

  const code = req.body?.tagCode;
  if (!isString(code) || !code.trim()) return res.status(400).json({ error: "A tag is required" });

  // Tenant-scoped by db.js, so another college's tag is simply not found.
  const tag = await prisma.attendanceTag.findFirst({ where: { code: code.trim(), active: true } });
  if (!tag) return res.status(404).json({ error: "That tag isn't recognised." });

  const date = today();
  const logTap = async (outcome, extra = {}) => {
    try { await prisma.tagTap.create({ data: { tagId: tag.id, staffId: req.user.id, outcome, ip: req.ip ? String(req.ip).slice(0, 60) : null, ...extra } }); }
    catch (e) { console.error("[tap] could not log a staff tap:", e.message); }
  };

  const existing = await prisma.checkIn.findUnique({ where: { staffId_date: { staffId: req.user.id, date } } });

  // A summary-first row has timeIn "" — the sentinel for "wrote a summary, never checked
  // in". Fill in the real clock time rather than leaving the day blank, exactly as
  // POST /check-in does.
  if (existing && existing.timeIn) {
    await logTap("already_checked_in", { site: "Onsite" });
    return res.json({ ok: true, alreadyCheckedIn: true, ...sCheckin(existing) });
  }

  const rec = await prisma.checkIn.upsert({
    where: { staffId_date: { staffId: req.user.id, date } },
    update: { timeIn: nowTime(), site: "Onsite", tagId: tag.id },
    create: { staffId: req.user.id, date, timeIn: nowTime(), site: "Onsite", tagId: tag.id },
  });

  await prisma.attendanceTag.update({ where: { id: tag.id }, data: { lastTapAt: new Date() } });
  await logTap("checked_in", { site: "Onsite" });

  res.status(201).json({ ok: true, ...sCheckin(rec) });
});
```

- [ ] **Step 2: Publish `tagId` through `sCheckin`**

In `server/src/serializers.js`, find `sCheckin` and add `tagId` to the returned object:

```js
  // Named explicitly — sCheckin is an allowlist, so a column added tomorrow stays
  // private until published deliberately.
  tagId: c.tagId ?? null,
```

- [ ] **Step 3: Create `server/src/routes/tags.js`**

```js
// NFC tag administration — register a sticker, retire one, read its taps.
//
// The tag's `code` is the secret written onto the sticker. It is returned to the admin
// who creates it (they have to write it onto the tag) and never again, which is why
// there is no "show me the code" endpoint: a leaked code is a sticker anyone can
// simulate, and the remedy is to deactivate it and write a new one.
const crypto = require("crypto");
const router = require("express").Router();
const prisma = require("../db");
const audit = require("../audit");
const { requireAuth, requirePage } = require("../auth");
const { isString } = require("../validate");

router.use(requireAuth, requirePage("attendance-tags"));

// 26 characters of base32 — about 130 bits. Not sequential and not derived from
// anything: a code guessed from a neighbouring room's sticker would be a check-in
// nobody attended.
const newCode = () => crypto.randomBytes(16).toString("base64url").slice(0, 26);

const sTag = (t) => ({ id: t.id, label: t.label, active: t.active, lastTapAt: t.lastTapAt, createdAt: t.createdAt, createdBy: t.createdBy });

// GET /api/tags — every sticker this college has registered. No codes.
router.get("/", async (_req, res) => {
  const rows = await prisma.attendanceTag.findMany({ orderBy: { label: "asc" } });
  res.json(rows.map(sTag));
});

// POST /api/tags — register a sticker. The code comes back ONCE, to be written onto it.
router.post("/", async (req, res) => {
  const label = req.body?.label;
  if (!isString(label) || !label.trim()) return res.status(400).json({ error: "A label is required — the room this sticker lives in" });
  if (label.length > 120) return res.status(400).json({ error: "That label is too long (120 characters maximum)" });

  const tag = await prisma.attendanceTag.create({
    data: { code: newCode(), label: label.trim(), createdBy: req.user?.name || null },
  });

  audit.record(req, {
    action: "attendance.tag.created", entity: "AttendanceTag", entityId: tag.id,
    summary: `NFC tag "${tag.label}" registered by ${req.user?.name || "an administrator"}`,
    before: null, after: { label: tag.label },   // never the code
  });

  res.status(201).json({ ...sTag(tag), code: tag.code });
});

// PATCH /api/tags/:id — rename, or retire a sticker that has been lost or peeled off.
router.patch("/:id", async (req, res) => {
  const tag = await prisma.attendanceTag.findUnique({ where: { id: req.params.id } });
  if (!tag) return res.status(404).json({ error: "Tag not found" });

  const data = {};
  if (req.body?.label != null) {
    if (!isString(req.body.label) || !req.body.label.trim()) return res.status(400).json({ error: "A label is required" });
    data.label = req.body.label.trim().slice(0, 120);
  }
  if (req.body?.active != null) {
    if (typeof req.body.active !== "boolean") return res.status(400).json({ error: "active must be true or false" });
    data.active = req.body.active;
  }
  if (!Object.keys(data).length) return res.status(400).json({ error: "Nothing to change" });

  const updated = await prisma.attendanceTag.update({ where: { id: tag.id }, data });

  audit.record(req, {
    action: data.active === false ? "attendance.tag.retired" : "attendance.tag.updated",
    entity: "AttendanceTag", entityId: tag.id,
    summary: `NFC tag "${updated.label}" ${data.active === false ? "retired" : "updated"} by ${req.user?.name || "an administrator"}`,
    before: { label: tag.label, active: tag.active },
    after: { label: updated.label, active: updated.active },
  });

  res.json(sTag(updated));
});

// GET /api/tags/:id/log — this sticker's recent taps, refusals included.
//
// The refusals are the point: "I tapped and it didn't work" is answerable here, and a
// pattern — one address checking in six people inside a minute — shows up here and
// nowhere else.
router.get("/:id/log", async (req, res) => {
  const tag = await prisma.attendanceTag.findUnique({ where: { id: req.params.id } });
  if (!tag) return res.status(404).json({ error: "Tag not found" });

  const rows = await prisma.tagTap.findMany({
    where: { tagId: tag.id },
    orderBy: { at: "desc" },
    take: 200,
    include: {
      // A name, so the log is readable. No email — this page is not the staff
      // directory, and a page-scoped admin should not harvest addresses from it.
      tag: { select: { label: true } },
    },
  });

  const studentIds = [...new Set(rows.map((r) => r.studentId).filter(Boolean))];
  const staffIds = [...new Set(rows.map((r) => r.staffId).filter(Boolean))];
  const [students, staff] = await Promise.all([
    studentIds.length ? prisma.student.findMany({ where: { id: { in: studentIds } }, select: { id: true, firstName: true, lastName: true } }) : [],
    staffIds.length ? prisma.staff.findMany({ where: { id: { in: staffIds } }, select: { id: true, name: true } }) : [],
  ]);
  const nameOf = new Map([
    ...students.map((s) => [s.id, `${s.firstName} ${s.lastName}`.trim()]),
    ...staff.map((s) => [s.id, s.name]),
  ]);

  res.json({
    tag: sTag(tag),
    taps: rows.map((r) => ({
      id: r.id,
      at: r.at,
      who: nameOf.get(r.studentId || r.staffId) || null,
      kind: r.studentId ? "student" : r.staffId ? "staff" : null,
      outcome: r.outcome,
      status: r.status,
      site: r.site,
    })),
  });
});

module.exports = router;
```

- [ ] **Step 4: Mount the router in `server/src/index.js`**

Below the tenant middleware, beside the other authenticated routers:

```js
app.use("/api/tags", wrapAsync(require("./routes/tags")));
```

- [ ] **Step 5: Add the page key to BOTH copies of `ADMIN_PAGES`**

In `server/src/validate.js`, add `"attendance-tags"` to the `ADMIN_PAGES` array, after `"registers"`.

In `client/src/StaffHub.jsx`, find its `ADMIN_PAGES` and add the matching entry in the same position. **These two lists are hand-maintained copies and must not drift** — a key in one and not the other is a page that can be granted and never reached, or reached and never granted.

- [ ] **Step 6: Confirm everything loads and the client builds**

```bash
cd server && node -e "require('./src/routes/tags'); require('./src/routes/checkins'); console.log('loads')" && node --test "src/**/*.test.js"
cd .. && npm run --workspace client build
```
Expected: `loads`, unit tests pass, client build succeeds.

- [ ] **Step 7: Confirm the two `ADMIN_PAGES` lists match**

```bash
cd "$(git rev-parse --show-toplevel)"
grep -o '"[a-z-]*"' server/src/validate.js | sed -n '/executive/,/settings/p' | sort > /tmp/server-pages.txt
grep -n "attendance-tags" server/src/validate.js client/src/StaffHub.jsx
```
Expected: `attendance-tags` appears in both files.

- [ ] **Step 8: Commit**

```bash
git add server/src/routes/tags.js server/src/routes/checkins.js server/src/serializers.js server/src/index.js server/src/validate.js client/src/StaffHub.jsx
git commit -m "Staff tap in Onsite, because the tap already proved it

The staff endpoint does not accept a site and does not ask for one. Someone who
touched a sticker in the building cannot be working online, and offering the
choice would record something the tap itself disproves. Online stays available
through the existing button, which does take a site.

Tag codes come back exactly once, when the sticker is registered, because that
is when somebody writes them onto it. There is no endpoint that reads one back:
a leaked code is a sticker anyone can simulate, and the remedy is to retire it
and write a new one. The audit entry names the tag and never the code.

The tap log endpoint returns names but never email addresses. This page is not
the staff directory, and GET /staff already denies colleagues' addresses to
page-scoped admins for the same reason.

attendance-tags added to BOTH copies of ADMIN_PAGES. A key in one and not the
other is a page that can be granted and never reached."
```

---

### Task 7: The smoke suite

**Files:**
- Create: `scripts/smoke-nfc-tap.mjs`

**Interfaces:**
- Consumes: every endpoint from Tasks 5 and 6.
- Produces: a suite the runner picks up automatically from `scripts/smoke-*.mjs`.

- [ ] **Step 1: Write the suite**

Create `scripts/smoke-nfc-tap.mjs`, following the structure of `scripts/smoke-studentportal.mjs` — the same bootstrap, the same bare `PrismaClient` for planting fixtures the API would refuse to create, the same `PASS`/`FAIL`/`SKIP` reporting.

The assertions this suite exists for, weighted toward refusals as the house style requires:

```
1.  The feature refuses everything while `enabled` is false.
2.  An unknown tag code is refused, and a deactivated one is refused the same way —
    no reply distinguishes "never existed" from "retired".
3.  A tag belonging to college A cannot be used by a student of college B.
4.  A tap before the lecture's start time is refused (reason: no_session_now).
5.  A tap after the lecture's end time is refused (reason: no_session_now).
6.  A tap during the lecture writes P, and checkedInAt matches the clock to the minute.
7.  A tap past the lateness threshold writes L, not P.
8.  A second tap does NOT create a second mark and does NOT move checkedInAt.
9.  A tap CANNOT overwrite a mark the lecturer already set — plant an A, tap, assert
    the A survives and checkedInAt is still null.
10. A later register save does NOT overwrite checkedInAt — tap, then PUT the register
    with a corrected status, then assert checkedInAt is unchanged.
11. A tap on a session whose term has ended is refused (reason: term_locked).
12. A student session still reaches nothing but /api/student — POST /api/tags with a
    student token is 403.
13. A staff tap creates a CheckIn with site "Onsite" and tagId set.
14. A second staff tap the same day does not create a second CheckIn row.
15. POST /api/tags returns the code exactly once; GET /api/tags never includes it.
16. GET /api/tags/:id/log returns names and never an email address.
```

Assertion 10 is the one that would otherwise be missed and matters most: `takenAt` is
overwritten on every register save, and the whole reason `checkedInAt` exists is that it
must not be.

- [ ] **Step 2: Confirm the runner discovers it**

```bash
ls scripts/smoke-nfc-tap.mjs
```

**Do not run `npm test` on this machine.** `DATABASE_URL` in `server/.env` points at a
live database and the suites create, mutate and delete real rows. This suite runs in CI,
or against an isolated schema:

```bash
DATABASE_URL="postgresql://…/postgres?schema=smoketest" npm test -- smoke-nfc-tap
```

Snapshot row counts in `public` before and after, and drop the schema afterwards.

- [ ] **Step 3: Prove assertions 9 and 10 can fail**

These two guard the invariants the whole feature rests on, so neither may be trusted
until it has been seen to fail:

1. Remove the `if (existing)` early return from `POST /me/tap-check-in` and change the
   `create` to an `upsert`. Expected: assertion 9 FAILS. Restore.
2. In `hnd.js`, add `checkedInAt: null` to the register save's `update` clause. Expected:
   assertion 10 FAILS. Restore.

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-nfc-tap.mjs
git commit -m "Smoke suite: what a tap must never be able to do

Weighted to refusals, as the suites here are. The two that matter most are the
two that would otherwise be missed.

A tap cannot overwrite a lecturer's mark — the suite plants an A, taps, and
asserts the A survived with checkedInAt still null. And a later register save
cannot overwrite checkedInAt: takenAt IS reset on every save, which is the whole
reason the column exists, so the suite taps, saves a correction over it, and
asserts the arrival time is unchanged.

Both were proved able to fail by reintroducing the bug before being trusted."
```

---

## Self-Review

**Spec coverage.** Walked each section:

| Spec section | Task |
|---|---|
| §1 rules, coverage & MC interaction | Global Constraints; no code change needed — a tap writes an ordinary mark and the cover logic acts downstream |
| §2 student flow | 5 |
| §3 when a tap is accepted, P/L, no `A` | 3 (logic), 5 (route) |
| §4 schema — tags, log, config, both columns | 1, 2, 4 |
| §5 student API | 5 |
| §6 staff flow, Onsite decision | 6 |
| §7 lecturer dashboard | **Not in this plan** — stated in Scope, needs its own |
| §8 testing | 2, 3, 7 |
| §9 not in scope | honoured throughout |
| §10 rollout | client work, not this plan |

**Placeholder scan.** No `TBD`, no "add validation", no "similar to Task N". Task 7's suite is specified as an enumerated assertion list rather than 400 lines of transcribed fixture bootstrap — the file it copies is named, and each assertion states its own expected outcome.

**Type consistency.** `resolveTapSession` returns `{ kind, session, status }` / `{ kind, sessions }` / `{ kind, reason }` in Task 3 and is consumed with exactly those shapes in Task 5. `merge` is used by name in Tasks 2 and 4. `sTapSession` is defined once in Task 5 and used four times there. `logTap` is defined per-file rather than shared — the student and staff versions write different columns, and one helper taking both would be a parameter nobody reads.

**One gap found and closed during review:** Task 5's ambiguous branch originally reused `decision.status`, which does not exist on an ambiguous result. It now recomputes lateness for the chosen session, which is also more correct — a student picking the second of two overlapping classes should be judged against *that* class's start time.
