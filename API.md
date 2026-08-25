# Staff Hub API reference

Base URL: `http://localhost:4000/api`
All protected routes require header: `Authorization: Bearer <token>`.

## Auth
| Method | Path | Access | Body | Returns |
|--------|------|--------|------|---------|
| POST | `/auth/login` | public | `{ email, password }` | `{ token, user }` **or** a 2FA challenge |
| GET  | `/auth/me` | auth | — | current user |
| PUT  | `/auth/change-password` | auth | `{ currentPassword, newPassword }` | `{ ok, user, token }` |
| DELETE | `/auth/account` | auth | `{ password, confirm: "DELETE", code? }` | `{ ok, message }` |

`DELETE /auth/account` is self-service account deletion — required by the App Store
for any app offering account creation, and expected by Google Play. It is guarded
like the other destructive actions:

- the password must be re-entered, and `confirm` must be the word `DELETE`;
- an account with 2FA must also supply a current `code` (rate limited like every
  other code check);
- **the only remaining administrator is refused** (400) — otherwise nobody could
  approve leave, take registers or appoint a replacement;
- deleting cascades to check-ins, leave, adjustments, notifications and reset
  tokens; assigned documents are **detached, not destroyed**; the applicant's
  `SignupRequest` row goes too, since it holds their email and a password hash;
- the remaining admins are notified, and the email becomes free for a new sign-up.

`POST /auth/login` is rate limited: 8 failed attempts for the same IP + email within
15 minutes locks that pair for 15 minutes and returns **429**. A successful login
clears the counter.

### Login responses

A correct password does not always produce a session. `POST /auth/login` returns one
of three shapes:

| When | Response |
|---|---|
| Account has no second factor (seeded staff, admins) | `{ token, user }` — signed in |
| `totpEnabled` | `{ mfaRequired: true, challengeToken, email, name }` |
| `mustSetupTotp` and not yet enrolled | `{ totpSetupRequired: true, challengeToken, email, name }` |

The **challenge token** is not a session token: it is signed with `purpose: "mfa"`,
expires in 10 minutes, and is rejected by every authenticated route. Only the
`/auth/totp/*` endpoints accept it. This is what stops a correct password alone from
being enough to reach the API.

## Forgotten password

| Method | Path | Access | Body | Returns |
|--------|------|--------|------|---------|
| POST | `/auth/forgot-password` | public | `{ email }` | `{ ok, message }` — always the same |
| POST | `/auth/reset-password/verify` | public | `{ token }` | `{ ok, name, email, requiresCode }` |
| POST | `/auth/reset-password` | public | `{ token, newPassword, code? }` | `{ ok, message }` |

The link emailed to the user is `<CLIENT_URL>/?reset=<token>` (set `CLIENT_URL` in
`server/.env`; defaults to `http://localhost:5173`). Mail goes out via **nodemailer**
using the `SMTP_*` settings; with none configured the message is printed to the
**server console** instead. Verify a configuration with `node scripts/check-email.mjs`.

Design decisions worth knowing:

- **No user enumeration.** `forgot-password` returns 200 with an identical message for
  a known address, an unknown address, and a rate-limited caller. Only a missing email
  field is a 400.
- **Only a SHA-256 hash of the token is stored.** The raw value exists solely in the
  email, so reading the database does not let anyone reset an account.
- **Tokens are single-use and expire in 30 minutes.** Requesting a new link, completing
  a reset, or changing a password retires every outstanding link for that account.
- **An authenticator code is also required** when the account has 2FA enabled
  (`requiresCode` tells the UI up front). Without this, anyone who reached the mailbox
  would bypass two-step verification entirely — the reset link would become a way
  around the second factor rather than a route through it.
- **A reset revokes every existing session** by bumping `tokenVersion`, since a reset
  is often prompted by a suspected compromise. It also invalidates any **in-flight
  two-factor challenge**, so someone holding the old password cannot complete a
  sign-in that started before the reset.
- **A reset clears the login lockout** for that address. Being locked out after a few
  wrong guesses is the usual reason someone reaches this flow, so leaving it in place
  made a successful reset look like it had failed.
- **The link is claimed atomically**, so two simultaneous submissions of the same link
  cannot both succeed.
- **No session is returned** by a successful reset — the user signs in fresh, which
  also puts them back through 2FA.
- Rate limited to 5 requests per IP + email per hour.

### Session revocation

`Staff.tokenVersion` is signed into every JWT as `ver` and compared on each request.
A password **reset** bumps it (signing out everywhere); a password **change** bumps it
too but returns a freshly signed token, so the device making the change stays signed in
while all others are logged out.

## Account activation (invited accounts)

| Method | Path | Access | Body | Returns |
|--------|------|--------|------|---------|
| POST | `/auth/invite/verify` | public | `{ token }` | `{ ok, name, email, role, dept }` |
| POST | `/auth/invite/accept` | public | `{ token, newPassword }` | `{ ok, email, message }` |

The link is `<CLIENT_URL>/?invite=<token>`. Invitations share the `PasswordReset`
table with the forgotten-password flow — same hashed, single-use, expiring token —
distinguished by `purpose`, so the two cannot drift apart. Differences:

- invitations last **7 days** (a reset lasts 30 minutes), since someone added on a
  Friday should still be able to activate on Monday;
- **the two token types are not interchangeable** — an invite token is refused by
  `/auth/reset-password` and vice versa, so a 7-day token can never be used where a
  30-minute one was intended;
- accepting sets the password, clears `pendingActivation`, bumps `tokenVersion`, and
  retires every other outstanding invitation for that person;
- **no session is returned** — they sign in fresh, exactly like a reset.

## Two-factor authentication (authenticator app)

TOTP, RFC 6238 — SHA1, 6 digits, 30-second period, ±1 step tolerance. Works with
Google Authenticator, Microsoft Authenticator, Authy and 1Password. No third-party
service is involved: codes are computed locally from a shared secret.

| Method | Path | Access | Body | Returns |
|--------|------|--------|------|---------|
| POST | `/auth/totp/setup` | challenge token **or** session | `{ challengeToken? }` / `{ password }` | `{ secret, formattedSecret, otpauthUrl, account, issuer }` |
| POST | `/auth/totp/enable` | challenge token **or** session | `{ challengeToken?, code }` / `{ password, code }` | `{ token, user }` |
| POST | `/auth/totp/verify` | challenge token | `{ challengeToken, code }` | `{ token, user }` |
| DELETE | `/auth/totp` | auth | `{ password }` | `{ ok, user }` |

- `setup` generates and stores a secret but does **not** turn 2FA on — `enable` does,
  and only after a generated code proves the authenticator holds the same secret.
- **Enrolling from a signed-in session requires `password`.** Mid-login enrolment (with
  a `challengeToken`) does not, because the password was just proven. Without this,
  a borrowed session could add an authenticator the real owner doesn't hold and lock
  them out permanently — the mirror image of the removal rule below.
- `DELETE /auth/totp` requires the account password, and is refused (400) for accounts
  where 2FA is mandatory (those created by approving a sign-up).
- **Code attempts are rate limited per account**: 10 wrong codes inside 15 minutes locks
  code entry for 15 minutes (**429**), across `enable`, `verify` and the `reset-password`
  code gate. The limit is per account, not per challenge, so re-requesting a challenge
  does not reset it. A correct code is also refused while locked.
- **Challenge tokens carry `ver`** and are rejected once a password change or reset has
  bumped it, exactly like session tokens.
- `totpSecret` is never included in any staff payload; only `setup` ever returns it,
  and only to the person enrolling.

## Sign-up (self-service, admin approved)

| Method | Path | Access | Body |
|--------|------|--------|------|
| POST | `/signup` | **public** | `{ name, email, password, confirmPassword?, position, dept }` |
| GET  | `/signup?status=` | admin | — optional `pending` \| `approved` \| `rejected` |
| PUT  | `/signup/:id/decision` | admin | `{ status: "approved"\|"rejected", note?, allowance? }` |

An applicant is **not** a staff member. Their details sit in `SignupRequest` until an
admin approves, so they never appear in the staff list, calendars or registers, and
they cannot sign in.

- `POST /signup` always answers **202** with the same message, whether or not the email
  is already known — otherwise it would be a public "does this person work here?" oracle.
  Validation failures (bad email, password under 8 characters, mismatched confirmation,
  missing position/department) still return 400.
- A **rejected** applicant may apply again; their old row is overwritten.
- Approving runs in a transaction: it creates the `Staff` row **and** closes the request,
  or neither. The applicant keeps the password they chose (`passwordHash` is copied),
  gets `allowance` (default 28) and `mustSetupTotp: true`.
- A request can only be decided once — a second decision returns **409**.
- `POST /signup` notifies every admin; approval notifies the new staff member.

`PUT /auth/change-password` requires the new password to be at least 8 characters and
different from the current one (400 otherwise). Success also clears the user's
`mustChangePassword` flag — the flag is set on every admin-created account, and while
it is true the client blocks access to the app until a new password is chosen.

## Notifications
| Method | Path | Access | Body |
|--------|------|--------|------|
| GET    | `/notifications` | auth | — own notifications, newest first (max 50) |
| PUT    | `/notifications/read` | auth | — marks all of the caller's as read |
| PUT    | `/notifications/:id/read` | auth (owner) | — marks one as read (404 if not yours) |
| DELETE | `/notifications` | auth | — clears all of the caller's |

## Push devices

| Method | Path | Access | Body |
|--------|------|--------|------|
| POST | `/devices` | auth | `{ token, platform: "ios"\|"android"\|"web" }` |
| DELETE | `/devices` | auth | `{ token }` |
| GET | `/devices` | auth | — the caller's devices, **never the raw tokens** |

The app registers its FCM token after sign-in and removes it on sign-out. `POST` is
an upsert **on the token**, not on (staff, token): if the handset was previously
signed in as somebody else the row *moves* to the current user, so a shared phone
never delivers the previous person's notifications. `DELETE` is scoped to the caller,
so one user cannot unregister another's device. Tokens that FCM reports as dead are
removed automatically on the next send, and deleting an account removes its devices.

Delivery uses **FCM HTTP v1**; unconfigured, sends are logged instead. See `MOBILE.md`.

Notifications are created by the server, not by clients: `POST /leave` notifies every
admin, and `PUT /leave/:id/decision` notifies the requester. Each one also triggers a
best-effort email through nodemailer (console output until `SMTP_*` is configured — see
`server/src/email.js`). Notification and email failures are swallowed so they can never
fail the originating request: an unreachable mail server logs `[email] FAILED` and the
API still returns success.

## Staff
| Method | Path | Access | Body |
|--------|------|--------|------|
| GET    | `/staff` | auth | — |
| POST   | `/staff` | admin | `{ name, role, dept, email, allowance, password? }` |
| POST   | `/staff/:id/invite` | admin | — re-sends the activation email |

**Omitting `password` creates an INVITED account**: `pendingActivation: true`, a
random unguessable password, and an activation email. It **cannot be signed into**
until the person sets their own password. Supplying `password` keeps the old
behaviour — usable immediately, no invitation.

This replaced a real hole: admin-created accounts were previously given the shared
default `password123`, so anyone who guessed a colleague's email had full access.
| PUT    | `/staff/:id` | admin | any of `{ name, role, dept, email, allowance }` |
| DELETE | `/staff/:id` | admin | — |
| DELETE | `/staff/:id/totp` | admin | — resets that person's two-step verification |

`DELETE /staff/:id/totp` is the recovery path for a lost or replaced phone. It clears
the stored secret and sets `totpEnabled: false`, so the old authenticator stops working
at once. It leaves `mustSetupTotp` alone: where 2FA is mandatory the next sign-in goes
straight back into enrolment, and where it was voluntary the account returns to
password-only. The password is untouched, so a reset alone never grants access. The
affected user is notified. Returns 400 if the account has no 2FA set up, 404 if unknown.

## Check-ins
| Method | Path | Access | Body |
|--------|------|--------|------|
| GET    | `/checkins?date=YYYY-MM-DD` | auth (staff: own; admin: all) | — |
| POST   | `/checkins/check-in` | auth | — (self, today) |
| POST   | `/checkins/:id/check-out` | auth (owner/admin) | — |
| PUT    | `/checkins` | admin | `{ staffId, date, in, out? }` |
| PUT    | `/checkins/summary` | auth | `{ date?, summary }` |

## Leave
| Method | Path | Access | Body |
|--------|------|--------|------|
| GET    | `/leave` | auth (staff: own; admin: all) | — |
| POST   | `/leave` | auth (admin may add `staffId`) | `{ type, start, end, reason }` |
| PUT    | `/leave/:id/decision` | admin | `{ status: "approved"\|"rejected", note? }` — `note` must be text, max 2000 chars |

Decisions are **serialised per staff member**. The allowance check is a read followed
by a write, so two approvals fired at once both used to read the pre-approval total
and both succeed — 12 days approved against a 10-day allowance. Each decision now
waits for the previous one for that person and re-checks inside the lock, and the
write is a conditional update on `status: "pending"` so a decision can never be
applied twice. (Single-process; a multi-process deployment needs a database-level lock.)

## Adjustments (holiday balance +/-)
| Method | Path | Access | Body |
|--------|------|--------|------|
| GET    | `/adjustments` | auth (staff: own; admin: all) | — |
| POST   | `/adjustments` | admin | `{ staffId, days, note }` |

## Documents
| Method | Path | Access | Body |
|--------|------|--------|------|
| GET    | `/documents` | auth (filtered by visibility) | — |
| POST   | `/documents` | admin | `{ name, type, scope: "all"\|"personal", assignedTo? }` |
| DELETE | `/documents/:id` | admin | — |

## HND attendance registers
| Method | Path | Access | Body |
|--------|------|--------|------|
| GET    | `/hnd/semesters` | auth | — `{ semesters: [...], unassignedSessions }` |
| POST   | `/hnd/semesters` | admin | `{ name, start, end }` |
| PUT    | `/hnd/semesters/:id` | admin | any of `{ name, start, end }` |
| DELETE | `/hnd/semesters/:id` | admin | — (sessions and marks are untouched) |
| GET    | `/hnd/modules` | auth | — |
| POST   | `/hnd/modules` | admin | `{ code, name, tutor? }` |
| PUT    | `/hnd/modules/:id` | admin | any of `{ code, name, tutor }` |
| DELETE | `/hnd/modules/:id` | admin | — (cascades to sessions + marks) |
| GET    | `/hnd/students` | auth | — |
| POST   | `/hnd/students` | admin | `{ firstName, lastName, studentRef, email?, moduleIds? }` |
| PUT    | `/hnd/students/:id` | admin | any of `{ firstName, lastName, studentRef, email, active }` |
| DELETE | `/hnd/students/:id` | admin | — |
| PUT    | `/hnd/students/:id/enrolments` | admin | `{ moduleIds: [] }` (replaces the set) |
| GET    | `/hnd/sessions?moduleId=` | auth | — |
| POST   | `/hnd/sessions` | admin | `{ moduleId, date, start, end, description?, audience? }` |
| PUT    | `/hnd/sessions/:id` | admin | any of `{ date, start, end, description, audience }` |
| DELETE | `/hnd/sessions/:id` | admin | — |
| GET    | `/hnd/sessions/:id/register` | auth | — enrolled students + their marks |
| PUT    | `/hnd/sessions/:id/register` | admin | `{ marks: [{ studentId, status, remark? }] }` |
| GET    | `/hnd/attendance?semesterId=` | auth | — per-student/per-module + overall percentages |

`email` defaults to `<studentRef>@edtech.co.uk` when omitted.
A mark with `status: null` clears that student's mark. Partial `marks` arrays are
allowed, so a half-taken register can be saved and finished later.

### Attendance statuses & percentage
`status` is one of `P` (Present), `L` (Late), `E` (Excused), `A` (Absent).
Points: **P=2, L=1, E=1, A=0** — matching the college's Moodle register.

```
pct = points earned / (2 × sessions the student was marked for)
```

Sessions with no mark are excluded, so an untaken register never drags a
student's figure down. `pct` is `null` when nothing has been marked yet.

### Semesters
A semester is a **date range**, not a tag: a session belongs to whichever
semester its date falls inside. Ranges may not overlap (a `POST`/`PUT` that
would overlap another semester is rejected with 400), so the mapping is always
unambiguous. Semesters are purely a grouping — deleting one never touches a
session or a mark.

`GET /hnd/attendance` scopes every figure it returns:

| `semesterId` | Counts |
|---|---|
| *(omitted)* | every session on record |
| `<id>` | only sessions dated inside that semester (404 if unknown) |
| `unassigned` | only sessions outside **every** semester |

The response's `scope: { semesterId, sessionCount }` echoes what was counted, and
`moduleTotals[id].sessionCount` is scoped the same way. `unassignedSessions` on
`GET /hnd/semesters` flags sessions no semester covers — otherwise they'd be
invisible in every scoped view.

## Predictive analysis (progression risk)

All of these sit behind `requireAuth` + `requirePage("prediction")`. A college that has
granted that page to nobody has an inert feature: no score exists until somebody calls
`POST /prediction/recalculate`, nothing runs on a schedule, and no student is ever
emailed. The student and applicant apps cannot reach this router at all.

| Method | Path | Notes |
|---|---|---|
| GET | `/prediction/settings` | This college's model, the platform defaults beside it, `customised`, and the code vocabulary the screen renders (so adding a red indicator needs no client edit) |
| PUT | `/prediction/settings` | Replace the model. Body `{ config }`. **A missing or non-object `config` is a 400**, not a reset — see below. Marks every score in the college stale and returns `staleCount` |
| DELETE | `/prediction/settings` | Back to the platform defaults. This is the *only* way to reset |
| GET | `/prediction/summary` | Headcount per band (including empty bands), `scored`, `notScored`, `interventionRequired`, `staleCount`, `lastCalculated` |
| GET | `/prediction/students` | The register, worst first. `?riskLevel=&cohortId=&q=&interventionRequired=true`. Capped at 500 with `truncated` |
| GET | `/prediction/students/:id` | One student: current score, up to 60 history rows, every intervention. A student who exists but has no score returns `prediction: null` with a `reason`, **not** a 404 |
| POST | `/prediction/recalculate` | Body `{ all?, limit? }`. Bounded (default 500, max 2000) and synchronous within that bound; the response carries `remaining` so the caller can go again |
| GET | `/prediction/interventions` | `?status=&studentId=&due=true` |
| POST | `/prediction/interventions` | Records that somebody stepped in. Snapshots the student's current figures onto the row |
| PUT | `/prediction/interventions/:id` | Review one. **Never rewrites the snapshot** |

### The score

Seven components, each 0–100, weighted (defaults: overall attendance 0.20, recent
attendance 0.15, submission rate 0.15, on-time rate 0.10, average grade 0.25, grade
trend 0.10, intervention response 0.05 — they must total 1). The weighted mean is taken
over **only the components that could be measured**, so both the numerator and the
denominator skip an unmeasurable one:

```
progressionScore = Σ(weight × score) / Σ(weight)     over available components only
```

`null` in any of `overallAttendance`, `recentAttendance`, `submissionRate`,
`onTimeRate`, `averageGrade` means *not measurable*, never zero — the columns are
nullable for exactly this reason. A student with **nothing** measurable is not scored
and has no row at all. `availableWeight` below 0.5 adds `LIMITED_EVIDENCE` to
`riskDriverCodes`.

### The overrides

Applied to the *band*, in order, and they can only ever move a student to a worse one.
Which band each caps at is configurable **by key** and validated against the college's
own ladder at save time.

| Code | Fires when | Effect |
|---|---|---|
| `OVR-001` | `missingAssessmentCount >= missingOverrideCount` (2) | Cannot be better than `missingOverrideBand` (R3) |
| `OVR-002` | `recentAttendance < criticalRecentAttendance` (50) | Cannot be better than `criticalAttendanceBand` (R4) |
| `OVR-003` | `averageGrade < passThreshold` (40) | Cannot be better than `lowGradeBand` (R3) |
| `OVR-004` | `redIndicatorCount >= redIndicatorThreshold` (3) | Worsens the band by one, clamped at the worst |

A code is recorded whenever its **condition** is met, not only when it moved the
student — otherwise the reason a student is where they are disappears the moment a
second rule agrees with the first. `overrideApplied` says whether the band actually
changed. When it did, `progressionScore` is pulled down to the capped band's ceiling
(floored to one decimal, so an R3 cap of 69.99 does not round up into R2) while
`baseProgressionScore` / `baseRiskLevel` keep the untouched arithmetic.

There are exactly **six** red indicators, which is why `redIndicatorThreshold` is capped
at 6: a threshold above six could never fire and the override would be silently dead.

### Why a bad configuration is a 400 rather than a stored row

Each of these fails *silently* and *for a whole cohort at once*, which is why
`PUT /prediction/settings` refuses rather than tidies:

- **Weights that do not total 1** deflate (or inflate) every student in the college by
  the same amount, invisibly. At 0.9 the whole cohort walks one rung down the ladder and
  staff see a wave of "High Risk" that nothing in the students' behaviour explains.
- **A gap in the bands** means a student whose score lands in it is classified against
  nothing — no band, no flag, silently skipped by everything the score should trigger.
- **An overlap** means which band a student lands in depends on the order of an array,
  so dragging a row changes somebody's risk level.
- **An unknown key** stored verbatim is a setting somebody believes they changed and
  nothing reads.
- **An override naming a band that does not exist** is a rule that appears on the
  settings screen, reads as protection, and never fires for anybody.
- **A `config` that is missing entirely** would otherwise resolve to "the platform
  defaults" and silently discard the college's own model. Resetting is `DELETE`.

## Data shapes (client-facing)
```
Staff    { id, name, role, dept, email, allowance, initials, colour, accountRole,
           mustChangePassword, totpEnabled, totpRequired }
         // non-admins see a reduced shape for OTHER staff: { id, name, role, dept, initials, colour }
         // totpSecret is NEVER serialised here
Signup   { id, name, email, role, dept, status, note, decidedBy, decidedAt, requestedAt }
Notification { id, type, message, link, read, at }   // type: info | success | error
CheckIn  { id, staffId, date, in, out, summary }
Leave    { id, staffId, type, start, end, reason, status, requestedAt, decidedBy, decidedAt, note }
Adjustment { id, staffId, days, note, date }
Document { id, name, type, date, scope, assignedTo }
Semester { id, name, start, end, sessionCount? }
HndModule { id, code, name, tutor, sessionCount?, studentCount? }
Student  { id, firstName, lastName, name, studentRef, email, initials, colour, active, moduleIds? }
Session  { id, moduleId, date, start, end, description, audience, markedCount? }
Mark     { id, sessionId, studentId, status, remark, takenBy, takenAt }
Summary  { P, L, E, A, marked, earned, possible, pct }   // pct: null until marked
```
