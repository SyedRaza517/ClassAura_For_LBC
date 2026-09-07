# Attendance Console — Phase 1: the nav restructure

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the three attendance screens under one `Attendance` parent, and rename `attendance-tags` to `attendance-settings` without revoking it from anybody who holds it.

**Architecture:** A nav group is presentation only — it holds no permission and exists only if at least one child survives permission filtering (`client/src/navGroups.js`, already unit-tested). So this phase is: two `ADMIN_PAGES` edits that must stay identical, three nav entries gaining a `group`, new labels, and one forward-only SQL migration that rewrites stored grants.

**Tech Stack:** Express + Prisma + PostgreSQL (`server/`), React 18 + Vite (`client/`), `node --test` for unit tests, `scripts/smoke-*.mjs` for HTTP suites.

**Spec:** `docs/superpowers/specs/2026-09-07-attendance-console-design.md`

## Global Constraints

- **`ADMIN_PAGES` is two hand-maintained copies** — `server/src/validate.js` and `client/src/StaffHub.jsx` — and they must contain the same keys **in the same order**. `server/src/adminPages-contract.test.js` pins them and fails the build otherwise.
- **`Staff.adminPages` is a nullable JSON string.** `NULL` means "never configured → full access". A non-null value is a JSON array of page keys. Renaming a key without migrating stored values silently revokes the page.
- **Dates are strings** (`YYYY-MM-DD`), compared as strings. Never use the host clock for a user-facing date — `src/clock.js` pins `APP_TIMEZONE`.
- **Never rename a migration directory once applied anywhere.** Prisma identifies a migration by directory name; a rename makes it re-run, fail, and then block every later migration with P3009.
- **Run tests against the local database only**, passing `DATABASE_URL` on the command line and never letting it fall through to `server/.env` (which points at live staging):
  `DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test`
- **Pass `TEST_PORT`** when another session may be testing — two concurrent runs collide on port 4010 and the second silently talks to the first one's database.
- **Comments explain WHY**, at length, including why an alternative was rejected. Match that density; it is the house style.

---

### Task 1: Migrate stored grants before the key changes

The rename is only safe if every stored `adminPages` array is rewritten first. Doing this in the same deploy as the code change means a staff member who held **Check-in: QR & NFC** still holds **Settings** afterwards.

**Files:**
- Create: `server/prisma/migrations/20260907T120000_attendance_settings_page/migration.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: every `Staff.adminPages` JSON array containing `"attendance-tags"` now contains `"attendance-settings"` instead. Task 2 renames the key in code and depends on this having run.

- [ ] **Step 1: Write the migration**

```sql
-- Rename the attendance-tags page key to attendance-settings.
--
-- WHY A DATA MIGRATION AND NOT JUST A CODE RENAME. Staff.adminPages is a JSON array of
-- page keys, and NULL there means "never configured -> full access". A non-null array is
-- an EXPLICIT grant list. Renaming the key in ADMIN_PAGES alone would leave every
-- explicitly-granted account holding a key that no longer exists, which requirePage reads
-- as "not granted" -- so the screen would silently disappear for exactly the
-- administrators who had been given it on purpose, and stay visible only for the
-- unconfigured accounts that see everything anyway. Precisely backwards.
--
-- A string replace on the quoted key is safe: page keys are lower-case, hyphenated and
-- never substrings of one another, and the quotes pin the match to a whole JSON element.
-- "attendance-tags" appears in no other column.
--
-- Idempotent by construction: after this runs the old key is gone, so a second run
-- matches nothing.
UPDATE "Staff"
SET "adminPages" = replace("adminPages", '"attendance-tags"', '"attendance-settings"')
WHERE "adminPages" LIKE '%"attendance-tags"%';
```

- [ ] **Step 2: Prove the migration does what it claims, on a scratch database**

The migration is forward-only SQL and cannot be unit tested, so verify it directly.

```bash
export PGPASSWORD=postgres
PSQL="/c/Program Files/PostgreSQL/16/bin/psql.exe"
"$PSQL" -h 127.0.0.1 -U postgres -tAc "DROP DATABASE IF EXISTS edtech_p1;"
"$PSQL" -h 127.0.0.1 -U postgres -tAc "CREATE DATABASE edtech_p1;"
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_p1" \
  npm --workspace server run migrate:deploy
```

Now plant the three cases that matter and apply the statement by hand:

```bash
"$PSQL" -h 127.0.0.1 -U postgres -d edtech_p1 -c "
INSERT INTO \"Staff\" (id, name, email, \"adminPages\") VALUES
  ('p1-granted', 'Granted',   'p1a@x.test', '[\"registers\",\"attendance-tags\"]'),
  ('p1-null',    'Full',      'p1b@x.test', NULL),
  ('p1-other',   'Unrelated', 'p1c@x.test', '[\"students\"]');
UPDATE \"Staff\" SET \"adminPages\" = replace(\"adminPages\", '\"attendance-tags\"', '\"attendance-settings\"')
  WHERE \"adminPages\" LIKE '%\"attendance-tags\"%';
SELECT id, \"adminPages\" FROM \"Staff\" WHERE id LIKE 'p1-%' ORDER BY id;"
```

Expected exactly:

```
 p1-granted | ["registers","attendance-settings"]
 p1-null    |
 p1-other   | ["students"]
```

The granted account keeps its other page and gains the new key; `NULL` is untouched (still full access); an unrelated list is untouched.

- [ ] **Step 3: Commit**

```bash
git add server/prisma/migrations/20260907T120000_attendance_settings_page/migration.sql
git commit -m "Rename the attendance-tags page key, and carry its grants across

Staff.adminPages is an explicit grant list where NULL means full access, so a
code-only rename would have revoked the screen from exactly the administrators
given it deliberately and left it visible only to unconfigured accounts."
```

---

### Task 2: Rename the key in both ADMIN_PAGES copies

**Files:**
- Modify: `server/src/validate.js:63`
- Modify: `client/src/StaffHub.jsx:2238`
- Test: `server/src/adminPages-contract.test.js` (existing — must stay green)

**Interfaces:**
- Consumes: Task 1's migration.
- Produces: the page key `"attendance-settings"`, in the same list position `"attendance-tags"` occupied. Task 3 renders it.

- [ ] **Step 1: Run the contract test first, to see it green before you touch anything**

Run: `cd server && node --test src/adminPages-contract.test.js`
Expected: PASS. This is the test that will catch you editing one copy and not the other.

- [ ] **Step 2: Rename in the server copy**

In `server/src/validate.js`, inside `ADMIN_PAGES`, change `"attendance-tags"` to `"attendance-settings"`. Keep its position in the array — the contract test asserts identical **order**, not just identical membership.

- [ ] **Step 3: Run the contract test to verify it now FAILS**

Run: `cd server && node --test src/adminPages-contract.test.js`
Expected: FAIL — the client copy still says `attendance-tags`, so the two lists differ. This is the test proving it can fail; if it passes here, the test is not reading the client file and that is a bug to fix before going further.

- [ ] **Step 4: Rename in the client copy**

In `client/src/StaffHub.jsx:2238`, make the same single-token change in the same position.

- [ ] **Step 5: Run the contract test to verify it passes**

Run: `cd server && node --test src/adminPages-contract.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/validate.js client/src/StaffHub.jsx
git commit -m "attendance-tags becomes attendance-settings in both ADMIN_PAGES copies"
```

---

### Task 3: The Attendance group and its three children

**Files:**
- Modify: `client/src/StaffHub.jsx:2239` (`PAGE_LABELS`)
- Modify: `client/src/StaffHub.jsx:2257` (`NAV_GROUPS`)
- Modify: `client/src/StaffHub.jsx:2885-2887` (the three nav entries)
- Test: `client/src/navGroups.test.js` (existing, extended)

**Interfaces:**
- Consumes: the `attendance-settings` key from Task 2.
- Produces: a nav group with id `"attendance"` whose children are, in order, `registers`, `live-attendance`, `attendance-settings`.

- [ ] **Step 1: Write the failing test**

Append to `client/src/navGroups.test.js`:

```js
test("the three attendance screens collapse under one parent, in order", () => {
  const items = [
    { key: "summaries", label: "Daily Summaries" },
    { key: "registers", label: "Registers", group: "attendance" },
    { key: "live-attendance", label: "Dashboard", group: "attendance" },
    { key: "attendance-settings", label: "Settings", group: "attendance" },
    { key: "students", label: "All Students" },
  ];
  const tree = groupNav(items, { attendance: { label: "Attendance" } });

  // The group sits where its FIRST child sat, so the rest of the sidebar does not shuffle.
  assert.equal(tree[0].kind, "item");
  assert.equal(tree[0].item.key, "summaries");
  assert.equal(tree[1].kind, "group");
  assert.equal(tree[1].id, "attendance");
  assert.equal(tree[1].label, "Attendance");
  assert.deepEqual(tree[1].children.map((c) => c.key),
    ["registers", "live-attendance", "attendance-settings"]);
  assert.equal(tree[2].item.key, "students");
});

test("the attendance parent disappears when permission removes every child", () => {
  // A group that outlives its children advertises screens the account was never granted.
  const tree = groupNav([{ key: "students", label: "All Students" }],
    { attendance: { label: "Attendance" } });
  assert.ok(!tree.some((n) => n.kind === "group"));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && node --test src/navGroups.test.js`
Expected: FAIL — no nav entry carries `group: "attendance"` yet, so `tree[1]` is an item, not a group.

Note: this test exercises `groupNav` directly with its own inputs, so it fails on the assertion rather than on a missing import.

- [ ] **Step 3: Add the group metadata**

In `NAV_GROUPS` (`client/src/StaffHub.jsx:2257`), add:

```js
  // Taking a register, watching one fill, and choosing how students check in are three
  // jobs on one subject, and a member of staff moves between them in the same hour. They
  // collapse under one parent for the same reason the assessment screens do.
  //
  // Child labels drop the parent's word — "Registers / Dashboard / Settings" rather than
  // three rows all starting "Attendance" — matching the convention the student-records
  // and admissions groups already set. Permission still sits on each child; the parent
  // grants nothing and vanishes if permission removes all three.
  "attendance": { label: "Attendance", I: ClipboardList },
```

- [ ] **Step 4: Put the three children in the group**

Replace lines 2885–2887 of `client/src/StaffHub.jsx`:

```js
    { key: "registers", label: "Registers", I: ClipboardList, group: "attendance" },
    { key: "live-attendance", label: "Dashboard", I: Radio, group: "attendance" },
    { key: "attendance-settings", label: "Settings", I: Nfc, group: "attendance" },
```

- [ ] **Step 5: Update the labels map**

In `PAGE_LABELS` (`client/src/StaffHub.jsx:2239`), change the three entries so the page title matches the nav and the key that replaced `attendance-tags` has a label at all:

```js
registers: "Attendance — Registers",
"live-attendance": "Attendance — Dashboard",
"attendance-settings": "Attendance — Settings",
```

These keep the parent's word because `PAGE_LABELS` is used where there is no parent above it to supply context — page titles, the access grid, and audit lines — and "Settings" alone in an audit row would be ambiguous against the college's other Settings screen.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd client && node --test src/navGroups.test.js`
Expected: PASS, both new tests.

- [ ] **Step 7: Commit**

```bash
git add client/src/StaffHub.jsx client/src/navGroups.test.js
git commit -m "The three attendance screens collapse under one Attendance parent"
```

---

### Task 4: Prove it end to end

**Files:**
- No production changes. This task is verification only.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: evidence the phase is shippable.

- [ ] **Step 1: Run every unit test**

Run, from `server/`:

```bash
node --test "src/**/*.test.js"
```

Expected: PASS. **Use the glob, not `node --test src/`** — given a bare directory the runner walks into `src/index.js`, binds a port, starts the schedulers, and never terminates.

Then, from `client/`:

```bash
node --test src/navGroups.test.js src/timetableView.test.js src/pendingQr.test.js
```

Expected: PASS.

- [ ] **Step 2: Run the full suite in both modes, on a throwaway database**

```bash
export PGPASSWORD=postgres
PSQL="/c/Program Files/PostgreSQL/16/bin/psql.exe"
"$PSQL" -h 127.0.0.1 -U postgres -tAc "DROP DATABASE IF EXISTS edtech_p1;"
"$PSQL" -h 127.0.0.1 -U postgres -tAc "CREATE DATABASE edtech_p1;"

DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_p1" TEST_PORT=4061 npm test
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_p1" TEST_PORT=4062 \
  SMOKE_SCOPED_DEPARTMENT=1 npm test
```

Expected: 0 failed in both. The scoped pass currently runs 30 suites and the ordinary pass 32.

If a suite fails, re-run it alone before believing it — `smoke-security-regressions` and `smoke-account-deletion` both abort silently under load when their `mkStaff` helper gets no id back, and `smoke-branding` has been seen to crash on exit with a libuv `UV_HANDLE_CLOSING` assertion after passing every assertion.

- [ ] **Step 3: Build the client**

Run: `npm run --workspace client build`
Expected: exit 0. `StaffHub.jsx` has no test framework at all, so **the build is the only thing that verifies it compiles** — a typo in the nav array is caught here or in production.

- [ ] **Step 4: Look at the screen**

The build proves it compiles, not that it renders. Drive it:

```bash
# server
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_p1" \
  JWT_SECRET="test-secret-not-for-production" PORT=4041 node server/src/index.js
# client, in another shell
cd client && VITE_API_URL="http://localhost:4041/api" npx vite --port 5183
```

Sign in at `http://localhost:5183` as `admin@edtech.co.uk` / `test-seed-password-2026` (click the **Admin Dashboard** role tile first — the email and password inputs do not exist until then). If the client origin is not in the API's `CORS_ORIGINS`, start the server with `CORS_ORIGINS="http://localhost:5183"` or every request is blocked before it is sent.

Confirm: one **Attendance** parent in the sidebar; expanding it shows **Registers**, **Dashboard**, **Settings** in that order; each opens its screen; no other nav item moved.

- [ ] **Step 5: Commit any fixes, then stop**

Phase 1 is complete when both suites are green, the client builds, and the three children render under one parent. **Do not start Phase 2** — the settings screen gets its own plan.

---

## What this phase deliberately does not do

- **No new settings.** `autoAbsentEnabled` and `networkRanges` arrive in Phase 2, stored and read by nothing.
- **No behaviour change to check-in.** The device rule and the network restriction are Phase 3, and both ship off.
- **No auto-absent.** Phase 4, and it is last because it is the only part that writes academic records on its own.
- **No dashboard rebuild.** `live-attendance` keeps its current screen under its new label; Phase 5 replaces the contents.

Each later phase gets its own plan, written against the same spec.
