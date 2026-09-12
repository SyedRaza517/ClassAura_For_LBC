# Student App Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Student notifications (push + inbox), mitigating-circumstances self-service,
attendance streaks & badges, a Due-next agenda with weighted averages and the Teams
join-link fix, and a design-system refresh of the student app (kit, dark mode, brand
font, one band scale, status-bar fix, code-split).

**Architecture:** One widened notification/device table serves both audiences (exactly
one of staffId/studentId, CHECK-enforced). New student endpoints stay inside
`routes/student.js` + the student router allowlist. The client work lands in three
strictly ordered passes: mechanical split of StudentApp.jsx (behaviour-frozen), visual
kit applied over the split files, then the new screens built on the kit.

**Tech Stack:** unchanged (Express/Prisma server, React 18 + Vite + Tailwind client,
Capacitor shell).

**Spec:** `docs/superpowers/specs/2026-09-12-student-app-refresh-design.md` — binding.
The 12 Sep student-surface survey's facts are restated in each task as needed.

## Global Constraints

Same as `docs/superpowers/plans/2026-09-12-teams-auto-attendance.md` §Global
Constraints (inline local DATABASE_URL; raw-SQL forward-only migrations named
`YYYYMMDDTHHMMSS_x`; London string dates; WHY comments; unit tests by glob; commit
trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; never push; branch
`feature/student-app-refresh`). Plus, from this spec:

- **Exactly one of `staffId`/`studentId`** on Notification and DeviceToken — routes
  enforce it and the migration adds CHECK constraints; existing staff rows untouched.
- **Predictions never reach students.** No task may add a student route that reads
  prediction, intervention, or risk data.
- **MC: `decisionNote`, staff identities and adjustments never serialise to students**
  (the model's own comment says decisionNote is "shown to staff").
- **Streaks/badges are per-student only** — no cross-student reads, no leaderboards.
- **Every new Prisma model** gets an academicScopeModels.js entry (none are planned;
  the rule guards drift).
- **The mechanical split (Task 3) changes NO markup** — file moves + imports only; the
  build must produce identical screens before any token work starts.
- Semantic-colour rule from branding.js stands: danger stays red whatever the brand;
  attendance-band colours come from the college's band settings.
- All client screens must hold up in BOTH light and dark (WCAG AA on token pairs).

---

### Task 1: Schema — studentId on Notification and DeviceToken

**Files:** `server/prisma/schema.prisma`;
`server/prisma/migrations/20260912T190000_student_notifications/migration.sql`.

**Interfaces (produces):** `Notification.staffId String?` + `studentId String?` (+
`student Student? @relation("StudentNotifications"…, onDelete: Cascade)`), index
`@@index([studentId, read])`; `DeviceToken` same widening + `@@index([studentId])`;
back-relations on `Student` (`notifications`, `deviceTokens`) and the existing ones on
`Staff` kept. Migration: `ALTER … ALTER COLUMN "staffId" DROP NOT NULL`, `ADD COLUMN
"studentId" TEXT`, the two FKs (ON DELETE CASCADE), the two indexes, and on EACH table
`ADD CONSTRAINT "<T>_one_owner_check" CHECK (("staffId" IS NULL) <> ("studentId" IS
NULL))` — with a comment in both schema and SQL explaining exactly-one (a row owned by
nobody is unreadable; owned by both is a leak between audiences).

- [ ] Steps: schema edits with house comments (record what staffId used to be and why
  it widened) → migration SQL → `npx prisma migrate deploy` + `generate` (inline local
  URL) → `node --test src/academicScopeModels.test.js` and the full glob pass →
  commit.

---

### Task 2: The student notification channel (server)

**Files:** `server/src/notify.js`, `server/src/routes/devices.js`,
`server/src/auth.js` (STUDENT_ROUTERS), `server/src/routes/student.js`.

**Interfaces (produces):**
- `notify.notifyStudent(studentId, { type, message, link }) -> Promise<void>` — writes
  the Notification row, then best-effort pushes to that student's DeviceTokens; mirrors
  `notifyStaff`'s shape exactly (read it first). Push title: the college's display name
  resolved the same way branding does server-side (find what `GET /api/branding` serves
  and reuse its name source; fall back "ClassAura"). While in the file, fix the
  hard-coded `"Staff Hub"` title for staff pushes to the same branded name — the spec
  calls this out.
- `routes/devices.js`: when `req.user.kind === "student"` (inspect how the auth layer
  marks student tokens — read auth.js; staff requests keep writing staffId), upsert the
  token with `studentId` and null staffId. Add `"/api/devices"` to `STUDENT_ROUTERS`
  in auth.js with a WHY comment (the survey's finding: students were prompted for a
  permission whose token the server then rejected).
- In `routes/student.js`: `GET /me/notifications` → `{ notifications: [{ id, type,
  message, link, read, createdAt }], unread }` (latest 50, allowlist serialiser);
  `PUT /me/notifications/read` body `{ ids?: string[] }` — omitted ids = mark all read.
  Both scoped `studentId: req.user.id`, never an id parameter.

- [ ] Steps: read notify.js/devices.js/auth.js first → implement → unit-test the pure
  fan-out choice if extracted (optional) → load checks → commit.

---

### Task 3: Mechanical split of StudentApp.jsx (behaviour-frozen)

**Files:** Create `client/src/student/ui/*.jsx` (primitives listed below),
`client/src/student/screens/*.jsx` (one per screen), `client/src/student/StudentApp.jsx`
(shell: state, tabs, header, data loading), `client/src/student/BiometricSetting.jsx`;
Modify `client/src/App.jsx` (lazy route), `client/src/StaffHub.jsx` (import
BiometricSetting from the new module), delete the old top-level StudentApp.jsx.

**Rules:** MARKUP UNCHANGED — this task only moves code. Primitives to extract (they
already exist inline at the top of the old file): Screen, Card, ErrBox, Skeleton,
LoadingScreen, SectionTitle, Ring, StatusBar, Empty, Row, Stat, Action, HeroTile, the
useCountUp hook, and the ACCENT/tone tables (moved verbatim into
`client/src/student/ui/tokens.js` — Task 6 rewrites their VALUES, not their call
sites). Screens: Home, CheckIn (with its sub-components), Attendance, Results,
Reviews, Timetable, Query, Support, More. `BiometricSetting` moves OUT of StaffHub.jsx
into the shared module and both apps import it (the survey: the student bundle
currently ships all 16k lines of StaffHub through this one import).
`App.jsx`: `const StudentApp = React.lazy(...)` with a Suspense fallback matching
LoadingScreen, so the staff chunk leaves the student path entirely.

- [ ] Steps: move file-by-file, `npm run --workspace client build` after each group →
  existing client pure tests still pass (`npx vitest run` if configured; otherwise the
  node-based `*.test.js` files — read how they run in package.json) → verify the built
  bundle no longer contains StaffHub in the student entry (inspect the chunk graph
  `vite build --mode production` output) → commit.

---

### Task 4: Bands endpoint + Teams join link (server)

**Files:** `server/src/routes/student.js`.

**Interfaces (produces):**
- `GET /me/attendance-bands` → `{ bands: [{ key, label, min, colour }] }` — served
  from the college's resolved band config (read
  `server/src/attendanceBands.js` + `attendanceBandConfig.js` and serve the resolved
  ladder; allowlist only what the client needs; never emailTrigger internals).
- The student timetable (`GET /me/timetable`, select at ~student.js:1003-1028) starts
  carrying `teamsJoinUrl` per event/session where set (nullable passthrough; a class
  with none serialises null). Comment: this closes the STATUS.md:851 claim-vs-code gap
  the 12 Sep survey found.

- [ ] Steps: implement → extend an existing student smoke or unit test asserting a
  session's joinUrl round-trips and bands serve the defaults → commit.

---

### Task 5: Streaks + weighted average + due-next (server halves)

**Files:** Create `server/src/studentStreaks.js` + `studentStreaks.test.js`; Modify
`server/src/routes/student.js` (`GET /me/streaks`), `GET /me/assessments`'s average.

**Interfaces (produces):**
- `computeStreaks({ days }) -> { current, best, badges: [{ key, earnedOn }] }` — PURE.
  Input: ordered `[{ date: "YYYY-MM-DD", attended: bool|null }]` where null = an
  E-only/no-evidence day (neutral: skipped, breaks nothing). Badge keys:
  `streak5|streak10|streak25|perfectWeek|perfectMonth|perfectUnit` (perfectUnit is
  computed by the route from per-unit summaries, not by this function). TDD with
  boundary tests: gap breaks, neutral day bridges, single-day data, badge earnedOn =
  the day the threshold was crossed.
- `GET /me/streaks` → `{ current, best, badges }` — builds `days` from the student's
  AttendanceMark+HndSession rows (attended = every marked session that day P or L; any
  A = false; only E = null; no sessions = day absent from the list), plus perfectUnit
  from the same summarise() the attendance endpoint uses.
- `GET /me/assessments`: `averagePct` becomes weight-aware (missing/invalid weight
  counts 1) and the response gains `averageIsWeighted: true`; per-assessment `weight`
  already serialises. A college with no weights set must produce byte-identical
  averages to today — assert that in the unit test for the extracted average helper
  (extract it pure beside the route if it is inline).

- [ ] Steps: TDD the pure module → wire routes → full glob → commit.

---

### Task 6: The visual kit (tokens + dark mode + font + status bar)

**Files:** `client/src/student/ui/tokens.js` (real values), the `ui/*` primitives,
`client/src/index.css`, `client/tailwind.config.js` (`darkMode: "media"`),
`client/src/App.jsx` (font-family actually applied on the student branch),
`client/capacitor.config.json` + the student Header (status bar).

**Rules (from the spec — each is a checkable outcome):**
1. `darkMode: "media"`; every primitive and screen renders correctly in both schemes;
   token pairs chosen at WCAG AA (spot-check the worst: slate-on-navy header text,
   band colours on dark cards).
2. Band colours in tokens come from `GET /me/attendance-bands` (fetched in the shell's
   initial load, defaulted before it lands); the FOUR inconsistent scales the survey
   catalogued (`pctTone` 90/75/60, `gradeTone` 70/60/50, `progressTone`, the inline
   85/70 in Home) are replaced by the one ladder + the grade scale kept for RESULTS
   only (grades are not attendance bands; label the distinction in a comment).
3. Plus Jakarta Sans applied as the actual body font of the student branch (the
   GLOBAL_STYLE already loads it; set the family on the student root, keep system
   fallback).
4. Status bar: `overlaysWebView: true` + StatusBar style following the scheme; the
   student Header gains `paddingTop: env(safe-area-inset-top)`; verify the staff web
   app is unaffected (it renders in a browser, no native bar).
5. Pull-to-refresh on the student scrollport (PhoneShell) — a small touch-driven
   implementation consistent with `overscroll-behavior-y: none` (read index.css:136+
   first; native pull-to-refresh is disabled there on purpose, so this is a custom
   gesture on the scrollport top).
6. Motion language kept and made uniform (fade-up stagger, press, count-up), durations
   as tokens.

- [ ] Steps: tokens first → primitives → screen-by-screen sweep applying tokens (no
  layout changes) → client build clean → a Playwright light/dark screenshot pass
  (follow the `_e2e-teams.mjs` pattern: local API 4000, vite 5173, msedge channel,
  student login — the seeded test student from `server/tools/seed-test-student.js`, or
  create one; screenshots to a scratch dir) → commit (may be several).

---

### Task 7: MC self-service (server + screen)

**Files:** `server/src/routes/student.js` (+ the staff mitigations decide path in
`server/src/routes/mitigations.js` for the notification hook); Create
`client/src/student/screens/Mitigations.jsx`; Modify the More screen (nav row) and the
shell (screen key `mitigations`).

**Interfaces:**
- `GET /me/mitigations` → `{ claims: [{ id, status, coversFrom, coversTo,
  coversAttendance, category, raisedOn, decidedOn, createdAt }] }` — allowlist; NEVER
  decisionNote/decidedBy/adjustments (constraint above).
- `POST /me/mitigations` body `{ coversFrom, coversTo, category?, detail,
  coversAttendance? }` → creates with `status: "open"`, `raisedOn: localDate()`,
  `createdBy: "student"`. Validation mirrors the STAFF route's — read
  `routes/mitigations.js` first and reuse its window-cap check (the cap is a college
  setting; call the same helper, never re-implement) and its date validation; 400s
  with the same message shapes. Rate-limit: refuse a second OPEN claim overlapping the
  same window (409 naming the existing claim's dates).
- In the staff decide handler: after a decision writes, `notifyStudent(studentId,
  { type: decision === "approved" ? "success" : "info", message: …, link:
  "mitigations" })` — one notification per decision, wording that states the outcome
  without the note.
- Screen: list of claims (status chip, window, category) + submit form (dates,
  category select — read the category vocabulary staff use, if a fixed list exists in
  the staff client, else free text —, detail textarea, coversAttendance checkbox with
  the spec's plain-words explanation) + the "college may request evidence separately"
  line. Built on the Task 6 kit.

- [ ] Steps: server first with unit/smoke coverage (Task 9 carries the suite; here at
  least the refusal paths by direct call) → screen → build → commit.

---

### Task 8: New student surfaces (inbox, streaks, due-next, join buttons, triggers)

**Files:** client — `client/src/student/screens/Inbox.jsx`, Header bell + unread badge
(replacing the localStorage query-badge for queries once notifications carry it),
Home: Due-next card + streaks card, Attendance: streaks/badges section, CheckIn/
Timetable: **Join online class** button when `teamsJoinUrl` present (opens in new
tab/native browser), Results: weight chips + "weighted average" label. Create
`client/src/student/dueNext.js` + `dueNext.test.js` (pure interleave: assessments
due + next-48h classes, soonest first, overdue-unmarked flagged). Server —
the remaining notification triggers wired where the events happen: query answered
(`routes/studentQueries.js` reply), review published (where StudentReview rows are
created for students — find it), marks released (`AssessmentGrade` write path — notify
once per grade save, not per keystroke: read how grading saves batch), timetable
change touching a class within 48h (the timetabling update handler where date/time/
room change), referral update (existing referral message/status writes to a
`studentNotified` referral).

- [ ] Steps: pure dueNext TDD → server triggers (each: read the handler, add ONE
  notifyStudent call with a WHY comment; never inside loops without dedupe) → client
  surfaces on the kit → build + Playwright light/dark pass extended to the new
  screens → commit (may be several).

---

### Task 9: Smoke suites

**Files:** Create `scripts/smoke-student-notifications.mjs`,
`scripts/smoke-mitigations-student.mjs`; extend `scripts/smoke-studentportal.mjs` (or
the closest existing student suite — read it first) for bands/joinUrl/weighted-average
round-trips.

Follow `smoke-teams-attendance.mjs`'s infrastructure (own API+port, RUN-suffix seeds,
scoped cleanup, SKIP discipline). Refusal-weighted assertions:
- notifications: a student's device token is ACCEPTED and stored with studentId (and
  no staffId); a staff token keeps working; a student cannot read another student's
  notifications (scoped query proves it); each trigger writes EXACTLY one row (query
  answer, MC decision at minimum — drive them through the real endpoints); unread
  count; mark-read; mark-all.
- mitigations: submit → visible in list WITHOUT decisionNote even after a staff
  decision writes one; window-cap refusal; overlapping-open-claim 409; decision
  notifies exactly once; the EXISTING staff mitigations smoke stays green.

- [ ] Steps: write → run each green twice → full `npm test` sweep green → commit.

---

### Task 10: Docs

**Files:** `STATUS.md` (student app gets its own subsection at last: what is
demonstrated by which suite vs code-read; correct the §851 join-link claim to "now
true"; the notification channel; MC self-service; the split/bundle change), `API.md`
(every new endpoint in its format), `MOBILE.md` if the status-bar/push behaviour
changes what it documents (read it first).

- [ ] Steps: write against the code → full sweep + client build one last time → commit.

---

## Self-Review (planning time)

Spec coverage: one-table widening + CHECK (T1), channel + inbox + branded titles
(T2), triggers incl. MC decision (T2/T7/T8), MC form/status with staff-note
withholding and cap reuse (T7), streaks pure+private (T5/T8), due-next + weights +
weighted average with no-weights-identical guarantee (T5/T8), join-link defect (T4/T8),
kit/dark/font/statusbar/bands/pull-to-refresh/code-split (T3/T6), predictions untouched
(constraint), suites refusal-weighted (T9), docs honesty (T10). Order: T3 before T6
before the new screens (T7/T8 client halves) is the three-pass client rule from the
spec. Type consistency: notifyStudent signature used by T7/T8 matches T2; tokens.js
introduced in T3 (values moved verbatim) and rewritten in T6 — call sites stable.
