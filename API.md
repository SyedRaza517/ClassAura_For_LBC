# Staff Hub API reference

Base URL: `http://localhost:4000/api`
All protected routes require header: `Authorization: Bearer <token>`.

**One deployment serves one institution.** There is no tenant header: `X-Tenant` was
sent by the client until 30 Aug 2026 and is now neither sent nor read, and the `tid`
claim is no longer in the token (it is *ignored* rather than rejected, so sessions
issued before the change keep working). Two route trees went at the same time and are no
longer in the codebase:

| Gone | What it was |
|---|---|
| `/api/platform/*` | The supplier's operator tier — its own login, 2FA, operator management, per-college storage figures, server-configuration health, and a "restore access" password reset for a locked-out college |
| `/api/registrations/*` | A public apply/activate flow by which an organisation became a customer |

One response key was **renamed** in the same change. `GET` and `PUT
/api/timetabling/settings` and `GET /api/my-timetable/settings` return a JSON key named
**`institution`** where they previously returned `tenant` — the college's own settings
layer, sent alongside the merged view so "reset to the college default" has something to
reset to. Neither route is documented below; see §8 of `STATUS.md` on how much of the API
this file still omits.

## Health

| Method | Path | Auth | Answer |
|---|---|---|---|
| GET | `/api/health` | none | `{ ok: true, service: "edtech-hub-api", version }` |

`version` is the first seven characters of the commit the host built (Render's `RENDER_GIT_COMMIT`), or `null` where the host does not say. The client and the API deploy separately and a browser can be hours newer than the server it talks to; this is how to tell which build is answering without signing in. Nothing else is here on purpose: the endpoint is public and pinged by the keep-alive. In particular it does not say whether check-in codes are signed with a real secret: that secret is the session secret, so the answer would tell an anonymous caller whether every login token on a misconfigured deployment is forgeable. A production process refuses to start without a real secret, so `ok: true` from a production host already answers the question.

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
| POST   | `/checkins/tap-check-in` | auth | `{ tagCode }` — clock in by touching an NFC sticker; always `Onsite` |
| POST   | `/checkins/:id/check-out` | auth (owner/admin) | — |
| PUT    | `/checkins` | admin | `{ staffId, date, in, out? }` |
| PUT    | `/checkins/summary` | auth | `{ date?, summary }` |

`POST /checkins/tap-check-in` is documented in full under **NFC tap check-in** below,
including why it refuses to record any site but `Onsite`.

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
| GET    | `/hnd/units` | auth | — |
| POST   | `/hnd/units` | admin | `{ code, name, tutor? }` |
| PUT    | `/hnd/units/:id` | admin | any of `{ code, name, tutor }` |
| DELETE | `/hnd/units/:id` | admin | — (cascades to sessions + marks) |
| GET    | `/hnd/students` | auth | — |
| POST   | `/hnd/students` | admin | `{ firstName, lastName, studentRef, email?, unitIds? }` |
| PUT    | `/hnd/students/:id` | admin | any of `{ firstName, lastName, studentRef, email, active }` |
| DELETE | `/hnd/students/:id` | admin | — |
| PUT    | `/hnd/students/:id/enrolments` | admin | `{ unitIds: [] }` (replaces the set) |
| PUT    | `/hnd/units/:id/enrolments` | admin | `{ studentIds: [] }` (replaces the set) |
| GET    | `/hnd/sessions?unitId=` | auth | — |
| POST   | `/hnd/sessions` | admin | `{ unitId, date, start, end, description?, audience? }` |
| PUT    | `/hnd/sessions/:id` | admin | any of `{ date, start, end, description, audience }` |
| DELETE | `/hnd/sessions/:id` | admin | — |
| GET    | `/hnd/sessions/:id/register` | auth | — enrolled students + their marks |
| PUT    | `/hnd/sessions/:id/register` | admin | `{ marks: [{ studentId, status, remark? }] }` |
| GET    | `/hnd/attendance?semesterId=` | auth | — per-student/per-module + overall percentages |
| GET    | `/hnd/check-in-settings` | admin | — `{ tapEnabled, qrEnabled }`, for the Registers page's per-session QR action |
| GET    | `/hnd/my-sessions/today` | admin **or the tutor** | — the classes this lecturer is teaching today |
| GET    | `/hnd/sessions/:id/live` | admin **or the tutor** | — the register as it stands during the class |
| GET    | `/hnd/sessions/:id/qr-code` | admin **or the tutor** | — the rotating check-in code (see QR check-in) |
| POST   | `/hnd/sessions/:id/mark-remaining-absent` | `registers` **or the tutor** | `{ override? }` — marks the unmarked absent |
| POST   | `/hnd/sessions/:id/check-in-window` | `registers` **or the tutor** | `{ action: "close" }` or `{ action: "reopen", minutes? }` — end check-in early / hold it open |

**The resource is `units`, not `modules`.** Every path and body key above said
`module`/`moduleId`, and none of them has ever existed: the Prisma model is `Unit`, the
routes are `/hnd/units`, and the server hard-rejects the documented bodies —
`unitIds must be an array of unit ids` (400) and `Unit required` (400). Anyone following
this section verbatim got a 404 or a 400 on every call. Corrected 5 Sep 2026.

**Enrolment can be edited from either side, and the body key differs.**
`/hnd/students/:id/enrolments` takes `{ unitIds }` — which units this student is on;
`/hnd/units/:id/enrolments` takes `{ studentIds }` — who is on this unit. Both REPLACE
the set rather than adding to it, and both refuse a non-array outright: sending a string,
or omitting the field, once dropped the student off every register with a cheerful 200.

`email` is derived from the institution's own `contactEmail` in branding, and is left
EMPTY when the college has configured none. It used to default to
`<studentRef>@edtech.co.uk` — an address on a domain the college does not own — which is
why it no longer does.
A mark with `status: null` clears that student's mark. Partial `marks` arrays are
allowed, so a half-taken register can be saved and finished later.

The last five rows are the lecturer's live view, documented under **The lecturer's live
view** below. "Or the tutor" means an ordinary STAFF account that `Unit.tutorStaffId`
names, for sessions of that unit only — the one exception to the router's admin gate.

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

## NFC tap check-in

A student holds their phone against a sticker on the classroom wall and the app writes
their **own** attendance mark; a member of staff touches the same sticker and is clocked
in `Onsite`. Both write to records the college is asked to evidence at a funding audit, a
visa compliance check or a student's appeal, so the interesting half of this API is the
refusals.

**It ships off.** `enabled` defaults to `false` for every college, exactly like the
attendance emails and for the same reason: a feature that writes to the attendance record
must not switch itself on everywhere on the next deploy. Until an administrator turns it
on, `POST /student/me/tap-check-in` and `POST /checkins/tap-check-in` answer **403** and
`GET /student/me/tap-context` reports `enabled: false` without naming a single class.

### Settings (per college)

| Method | Path | Access | Body |
|--------|------|--------|------|
| GET | `/tags/settings` | `attendance-tags` | — |
| PUT | `/tags/settings` | `attendance-tags` | any of `{ enabled, lateAfterMins, earlyGraceMins, armSeconds, staffTapEnabled }` |

| Setting | Default | Means |
|---|---|---|
| `enabled` | `false` | Whether taps are accepted at all |
| `lateAfterMins` | `15` | Past this many minutes after the start, a tap records `L` rather than `P` |
| `earlyGraceMins` | `0` | Minutes **before** the start that taps begin to be accepted |
| `armSeconds` | `60` | How long a tag read keeps the app's check-in button live — a client-side arming window, not a server rule |
| `staffTapEnabled` | `true` | Whether the same stickers also clock staff in |

`PUT` **behaves as a PATCH**: only the keys sent are changed, so switching the feature on
does not silently reset a lateness threshold somebody tuned last term. It returns the
complete merged settings (200), never a partial object, so no client needs a fallback of
its own. A body that is not a plain object is the only 400 —
`{ error: "Settings must be an object" }`.

Values are filtered on the way out as well as in, because a stored blob can predate a
rule or have been edited by hand in a console:

- unknown keys are **dropped** by the allowlist, not stored;
- `enabled` and `staffTapEnabled` are compared identically against `true`/`false` — the
  string `"false"` and the number `0` are both mistakes somewhere in a chain of JSON, and
  reading either as consent to switch a college on is the wrong failure to pick;
- `lateAfterMins` and `earlyGraceMins` are whole minutes, clamped to **120**;
  `armSeconds` is clamped to **600**. Without a ceiling, a typo of `600` in
  `earlyGraceMins` accepts a tap ten hours before the class starts — which is not a
  setting, it is an outage in the attendance record;
- a value that survives none of that falls back to the **platform default** for that
  field. Note the consequence: sending an unusable value does not leave the college's own
  figure in place, it resets that one field to the default. The response says so — it is
  the merged object, so the caller can see what was actually stored.

Switching the feature on or off is audited on its own
(`attendance.tap.settings.updated`): it makes every register in the college writable by a
student holding a phone, and switching it off silently stops attendance being recorded.
Settings are cached for 30 seconds (`ATTENDANCE_TAP_CACHE_MS`) and the cache is
dropped on save, so an administrator who has just switched it on sees it work while they
are still looking at the screen.

### The stickers

| Method | Path | Access | Body |
|--------|------|--------|------|
| GET | `/tags` | `attendance-tags` | — every sticker this college has registered |
| POST | `/tags` | `attendance-tags` | `{ label, code? }` |
| PATCH | `/tags/:id` | `attendance-tags` | any of `{ label, active }` |
| GET | `/tags/:id/log` | `attendance-tags` | — this sticker's last 200 taps |

**The code is returned exactly once, by `POST /tags` (201), and no endpoint ever reads it
back.** That response is the only place it appears: `sTag` is an allowlist that omits it,
the tag list omits it, the tap log omits it, and the audit entry records only the label —
the audit log is read on Settings by admins who were never granted this page, and a code
in it is a check-in they could manufacture. A leaked code is a sticker anyone can simulate
from anywhere, so the remedy is `PATCH /tags/:id { active: false }` and a new sticker, not
a lookup.

`code` is optional and covers the second way of registering a sticker: an admin on a phone
taps a **blank** tag and the app sends its factory UID, which needs no NFC writing tool at
all — buy stickers, tap each one, name the room. Omitted, the server generates 16 random
bytes as base64url — not sequential and not derived from the label, because a code
guessable from the sticker in the next room is a check-in nobody attended. An empty
`code` counts as omitted, so it generates one rather than failing the length check.

| Refusal | Status | Body |
|---|---|---|
| No `label`, or blank | 400 | `A label is required — the room this sticker lives in` |
| `label` over 120 characters | 400 | `That label is too long (120 characters maximum)` |
| `code` present but not a string | 400 | `code must be text` |
| `code` present and shorter than 8 characters | 400 | `A tag's own code must be at least 8 characters — a short one would be guessable` |
| `code` over 200 characters | 400 | `That code is too long (200 characters maximum)` |
| That physical sticker is already registered **and live** | 409 | `That sticker is already registered here, as "<label>". Rename it from the list if it has moved.` — it is this college's own row, so naming it is the whole value of the message |
| That physical sticker is registered but **retired** | 200 | Not a refusal: the row is brought back into use under the label in *this* request, and the response carries `restored: true` and no `code`. Retiring must take a sticker out of service, not destroy it |
| Too many codes claimed from outside the system in a short time | 429 | `Too many new stickers in a short time. Wait a few minutes and carry on.` — only reached by a **supplied** code this college does not already hold |
| `PATCH` or log on an unknown id | 404 | `Tag not found` |
| `PATCH` with a blank `label` | 400 | `A label is required` |
| `PATCH` with `active` not a boolean | 400 | `active must be true or false` |
| `PATCH` with no recognised field | 400 | `Nothing to change` |

The 409 used to have a second form, and it is worth knowing why it went. `AttendanceTag.code`
is unique across the table, and when one database held every college a supplied code could
belong to *another institution* — so the create ran a deliberately blind cross-tenant probe
that answered "spoken for" and nothing else: never which college, never what they call it.
One database per college deletes the case rather than rephrasing it. A code either is in
this table or is not, and if it is, it is this college's own, which is why the message
above can name the sticker.

`PATCH` differs from `POST` on an over-long label: it **truncates** to 120 characters
rather than refusing.

`GET /tags/:id/log` returns `{ tag, taps }`, newest first, capped at 200:

```
{ id, at, who, kind: "student" | "staff" | null, outcome, status, site }
```

The refusals are the point — "I tapped and it didn't work" is answerable here and nowhere
else, and so is a pattern (one address checking in six students inside a minute) that is
invisible in `AttendanceMark`. `outcome` is one of `marked`, `already_marked`,
`no_session_now`, `term_locked`, `ambiguous` (student taps) or `checked_in`,
`already_checked_in` (staff taps); `status` is `"P"` or `"L"` only when a mark was
actually written, and `null` otherwise. `who` is `null` when the tap was refused before
anybody was identified, which is a real state rather than a missing name, and **no email
address is ever included**: `GET /staff` already withholds colleagues' addresses from
page-scoped admins, and a tag log carrying them would become a way to harvest the roster.

### The student's tap

| Method | Path | Access | Body |
|--------|------|--------|------|
| GET | `/student/me/tap-context` | **student session** | — |
| POST | `/student/me/tap-check-in` | **student session** | `{ tagCode, sessionId? }` |

Both live on `/api/student`, so a staff token is refused with **403**
`Student access required` and an applicant token with **403**
`Not available for applicant accounts`, before either handler runs. Neither route takes a
student id — `req.user.id` is the only student either can see, so there is nothing to
tamper with. In the other direction, a student token reaching `/api/tags` or `/api/hnd`
gets **403** `Not available for student accounts` from the router allowlist.

`tap-context` is what the check-in screen shows *before* a tap: this student's classes
today and whether taps are being accepted right now.

```
{ enabled: false, armSeconds, now: null, next: null }                // feature off
{ enabled: true, armSeconds, date, now: [Session…], reason, next }   // feature on
```

`now` is the class (or classes) a tap would land on: one entry normally, more than one
when two of the student's lectures genuinely overlap, and `[]` when nothing is running —
in which case `reason` is `no_session_now` or `term_locked`. `next` is the first class
still to come today, so the screen can say "your next class is at 13:00" rather than only
"nothing on now", which reads as a fault rather than as a timetable. Note that `now` is
`null` in the disabled shape and `[]` in the enabled one. A session here carries only
`{ id, unitCode, unitName, startTime, endTime }` — no other student's data, ever.

**Which register a tap lands on is decided by the timetable, not by a window anybody
opens.** There is nothing for a lecturer to arm and nothing to remember to switch off. A
tap is accepted from `startTime - earlyGraceMins` to `endTime`, both ends inclusive — a
student who tapped as the class ended did arrive — and only for sessions on units this
student is **enrolled** on, which is what stops a tap attaching a student to a unit they
were never on. The mark is `P` when the tap is at or before `startTime + lateAfterMins`
and `L` after it; arriving exactly on the threshold is not late. After an ambiguous
choice the verdict is recomputed for the class the student picked, because inheriting the
first candidate's answer would mark a punctual student late.

A successful tap writes an ordinary `AttendanceMark` with `takenBy` set to the stamp
`Self check-in (NFC)` and `checkedInAt` set to the local `HH:MM`. `checkedInAt` is
distinct from `takenAt`, which every register save resets — that is the whole reason the
column exists, and a later save correcting the status leaves the arrival time alone. The
student's progression score is flagged stale (never rescored inline: a check-in must not
wait on arithmetic) and the write is audited as `attendance.tap.marked`.

**Three things a tap can never do**, each of which would damage a record the college has
to evidence:

- **overwrite a mark a lecturer already set.** The human in the room wins — the same
  invariant the Moodle importer holds. A tap onto an existing mark answers **200** with
  `{ ok: true, alreadyMarked: true, status, checkedInAt, session }`, where `status` and
  `checkedInAt` are the *existing* mark's, and writes nothing. It follows that a second
  tap never creates a second mark and never moves the recorded arrival time.
- **write an `A`.** Absence is what an untaken register already means, and scoring "did
  not tap" as absent turns a flat battery into a permanent academic record. The only
  route from this feature to an absence is `POST /hnd/sessions/:id/mark-remaining-absent`
  below, with a named human on the end of it.
- **bypass the term lock.** A session whose unit's term is closed is refused, so a tap
  never becomes a back door around the lock that `PUT /hnd/sessions/:id/register` enforces
  with a **423**. The tap's own refusal is a **409** carrying `reason: "term_locked"` —
  the 423 belongs to the staff-facing register routes, which accept `override: true`;
  this refusal has no override at all.

| Refusal | Status | Body |
|---|---|---|
| Feature switched off | 403 | `Tap check-in isn't switched on for this college.` |
| Missing or blank `tagCode` | 400 | `A tag is required` |
| `sessionId` present but not a string | 400 | `sessionId must be text` |
| More than 10 taps in 60 seconds by the same student | 429 | `Too many attempts — wait a moment and try again.` |
| Tag unknown or retired | 404 | `That tag isn't recognised.` |
| No class of theirs running now | 409 | `No class of yours is running right now.` + `reason: "no_session_now"` |
| That class's term is closed | 409 | `That class is outside its teaching term, so the register is closed.` + `reason: "term_locked"` |
| Two of their classes are running at once | 409 | `{ reason: "ambiguous", sessions: [...] }` — **no `error` key**; the app re-posts with `sessionId` |
| `sessionId` names a class that is not the one running | 409 | `That class is no longer running. Try again.` |

Both 404s read **identically** — an unknown code and a retired sticker are one message,
because the lookup filters on `active` and does not distinguish them. (There used to be a
third case behind the same message, a tag belonging to another institution; one database
per college has removed it.) "Nothing is running" is reported *before* the
term is checked, so a student who tapped at the wrong time of day is not told their term
is closed: two different problems with two different remedies. The rate limit is an
in-process module-level `Map` keyed on the student — correct for one Node process, and
there to stop a runaway loop rather than to ration people standing in a doorway. Note
that the 403, the 429 and the 404 all answer *before* a tag has been resolved, so unlike
every other outcome they leave no row in the tap log.

Success is **201** with `{ ok: true, status, checkedInAt, session }`.

### The staff tap

| Method | Path | Access | Body |
|--------|------|--------|------|
| POST | `/checkins/tap-check-in` | auth (any signed-in staff member) | `{ tagCode }` |

No admin page is required: clocking yourself in is not an administrative act. It does need
**both** `enabled` and `staffTapEnabled`, and answers 403
`Tap check-in isn't switched on for this college.` when either is off — so a college can
run tap check-in for students only.

**`site` is not accepted and not asked for — the record always says `Onsite`, and any
`site` in the body is deliberately ignored.** Someone who touched a sticker in the
building cannot be working online: the tap is what proves they are here, so recording
anything else would store a claim the tap itself disproves. Working online remains
available through `POST /checkins/check-in`, which does take a site. This is also the
first time a staff clock-in has meant "was in the building" rather than "said so" — the
button records a clock-in from anywhere, bed included.

A successful tap answers **201** with `{ ok: true, ...CheckIn }`, the row carrying
`site: "Onsite"` and `tagId`. Re-tapping the same day answers **200** with
`{ ok: true, alreadyCheckedIn: true, ...CheckIn }` and **does not rewrite the arrival
time** — the same rule `POST /checkins/check-in` follows, and for the same reason: a
second tap on the way past the door would otherwise falsify how long somebody was on site.
A day whose row exists only because a summary was saved (`timeIn: ""`) is filled in rather
than left blank. The refusals are 400 `A tag is required` and 404
`That tag isn't recognised.`, worded exactly as on the student side.

Like `POST /checkins/check-in`, it is **not audited**: it records the present, in the
caller's own name, and cannot alter history. `PUT /checkins` — which writes anyone's hours
on any date — is the one that is audited.

### The lecturer's live view

| Method | Path | Access | Body |
|--------|------|--------|------|
| GET | `/hnd/my-sessions/today` | any staff account (`?scope=all` needs `registers` \| `students` \| `executive`) | — |
| GET | `/hnd/sessions/:id/live` | `live-attendance` \| `registers`, or the session's tutor | — |
| GET | `/hnd/sessions/:id/qr-code` | `live-attendance` \| `registers`, or the session's tutor | — |
| POST | `/hnd/sessions/:id/mark-remaining-absent` | `registers`, or the session's tutor | `{ override? }` |
| POST | `/hnd/sessions/:id/check-in-window` | `registers`, or the session's tutor | `{ action: "close" }` \| `{ action: "reopen", minutes? }` |

**The lecturer's door (3 Sep 2026).** These five paths are the one exception to the HND
router's blanket guard `requireAnyPage(["registers", "students", "executive"])`: the gate
steps aside for exactly them, and each applies its own guard — the pages named above, OR
the caller being `Unit.tutorStaffId` of the session's unit. An ordinary STAFF account that
tutors a unit can therefore watch its own registers fill, put the code on screen, close the
register and change the check-in window, and can reach nothing else on this router (the
directory, the matrix, the paper register all still answer 403 — `smoke-qr-checkin.mjs`
asserts it). Before this, an admin granted *only* `live-attendance` never passed the
blanket guard and the page opened nothing; that is fixed by the same change.

`GET /hnd/my-sessions/today` gains `teaches` (whether the caller tutors any unit at all —
the staff app's My Classes tile keys on it). `GET /hnd/sessions/:id/live` gains
`tapEnabled`, `canClose` (may this caller close the register / change its window),
`closesAt` (the minute check-in actually shuts, later than the end when held open),
`phase` (`before` \| `open` \| `over` \| `ended` \| `closed`) and `today`.

`POST /hnd/sessions/:id/check-in-window` is the lecturer's hand on the window, for today's
class only (400 otherwise; 423 inside a locked term). `close` sets
`HndSession.checkInClosedAt` and every surface stops accepting at once — the code leaves
the projector, the badge turns, the next scan answers `no_session_now`. `reopen` clears it
and sets `checkInOpenUntil` to the later of the timetabled end and now + `minutes`
(default 10, max 120), so a finished class can be held open for late arrivals; a scan then
lands, marked Present or Late against the original start. Both are audited
(`attendance.checkin.closed` / `attendance.checkin.reopened`). Sessions serialise both
fields (`checkInClosedAt`, `checkInOpenUntil`, null until pressed).

`GET /hnd/my-sessions/today` answers `{ date, tapEnabled, sessions: [...] }` — the classes
this lecturer is teaching today, matched on `Unit.tutorStaffId` so the dashboard opens on
the right register without hunting through a term's worth of sessions. The free-text
`tutor` field is deliberately **not** matched on: a name typed into a box is not an
identity, and matching on it would hand one lecturer another's register whenever two
people share a surname. Each session carries `{ id, unit, startTime, endTime, description,
kind, marked, acceptingTaps }`, where `marked` is how many marks exist and `acceptingTaps`
is derived at read time rather than stored — "is it running" changes every minute, and a
column holding it would be wrong within one with nothing to correct it. A lecturer
teaching nothing today gets an empty array, not an error.

`GET /hnd/sessions/:id/live` is the register as it stands during the class (404
`Session not found` otherwise), polled by the dashboard every few seconds; there is no
websocket layer in this codebase and one three-hour class does not justify introducing
one. It returns:

```
{ session, unit, acceptingTaps, termLocked, counts: { P, L, E, A, notMarked },
  rows: [{ student, status, remark, checkedInAt, selfMarked, takenBy, enrolled }] }
```

- `status` is `null` for a student with no mark, and they are counted in `notMarked`.
  **"Not tapped" is a display state, not a mark** — nothing is written for those students
  here; the roll simply has no row for them yet.
- `selfMarked` is `takenBy === "Self check-in (NFC)"`, so a row a lecturer has taken over
  stops reading as self-marked. `takenBy` carries provenance the same way for the Moodle
  importer.
- `enrolled` is `false` for a student since un-enrolled who still holds a mark on this
  register. They stay on the screen, matching `GET /hnd/sessions/:id/register`, because
  otherwise their mark would vanish from view while remaining in the database.
- `termLocked` is `null` — not `false` — when the unit has no term at all. That register
  is simply never term-locked, which is not the same statement as "the term is open".

`POST /hnd/sessions/:id/mark-remaining-absent` is the lecturer closing the register: it
writes `A` for every **enrolled** student with no mark on this session and answers 200
with `{ ok: true, marked }`. It exists precisely so that no automatic process ever takes
this step — a flat battery, a forgotten handset or a phone with no NFC must not become an
academic record without somebody deciding it should.

- 404 `Session not found` for an unknown id.
- **423** — `<Term> is over — reopen it to edit this register.` (or `is not open yet`)
  with `locked: true` — when the unit's term is closed, matching
  `PUT /hnd/sessions/:id/register` exactly, because a convenience button must not be a way
  around a closed term. `{ override: true }` passes the lock, stamps `takenBy` as
  `<name> (out-of-term correction)`, and is audited as `attendance.register.corrected`
  rather than `attendance.register.closed`. A unit with no term is never locked.
- Marks are written with `createMany` + `skipDuplicates`, never an upsert, so it is
  structurally impossible for this route to overwrite a mark — and a student who taps in
  between the read and the write keeps their `P`.
- Running it again answers 200 with `{ ok: true, marked: 0, message: "Everyone on this
  register already has a mark." }`.

## Teams auto-attendance

Reads each online class's Microsoft Teams attendance report once the class has ended and
writes Present, Late or Absent onto its register from how long a student was actually in
the meeting. Setup (the app registration, its three Graph permissions, and the two
Microsoft application access policies that scope them to the college's organizer
accounts) is `TEAMS_SETUP.md`. The credentials themselves (tenant ID, client ID, client
secret, organizer accounts) are entered like any other integration, through the generic
`GET /integrations`, `PUT`/`DELETE /integrations/teams` and `POST /integrations/teams/test`
routes (`routes/integrations.js`) rather than through anything below — this section
covers only the four endpoints specific to Teams attendance itself.

**It ships off, and off means NOTHING runs.** `enabled` defaults to `false` for every
college, the same reason NFC tap check-in and Attendance Emails do: a feature that writes
to the attendance record must not switch itself on at every college on the next deploy.
While it is off, `POST /sync` itself refuses with 409 (see below) — no calendars are
read, no meetings are matched to classes, and nothing is ever marked. This used to read
"discovery and matching still run in the background… but nothing is ever marked", which
described a real earlier design and a real bug at once: the setup guide (`TEAMS_SETUP.md`
Step 11) walks an administrator through saving credentials and pressing **Test
connection** *before* ever switching this on, and in that window `graph.isConfigured()`
already answers true — so a "Sync now" press in exactly that window ran a real sync and
wrote real marks while the college had, by its own choice, left the feature off.
Matching now begins on the **first sync after switch-on**, not before.

All four endpoints below sit behind `requireAuth` **and** `requirePage("attendance-settings")`
— the same grant as the NFC/QR/geofence controls on the same screen (`AdminNfcTags.jsx`),
because these endpoints back one section of that screen and whoever holds the grant that
opens it is who every button on it needs to work for. The Teams *credentials* (tenant
ID, client ID, client secret, organizer accounts) are a separate, broader act —
connecting the college's Microsoft tenant at all — and stay behind `requirePage("settings")`
on the generic `/integrations/teams` routes, alongside branding and document templates.

| Method | Path | Body | Returns |
|--------|------|------|---------|
| GET | `/teams-attendance/settings` | — | `{ settings: { enabled, minAttendancePct }, configured, running }` |
| PUT | `/teams-attendance/settings` | any of `{ enabled, minAttendancePct }` | `{ settings }` |
| POST | `/teams-attendance/sync` | — | `{ ok: true, summary, issues }` |
| GET | `/teams-attendance/runs` | — | `{ runs: [ {...row, summary, issues} ] }` (most recent 20) |

`configured` is whether Graph credentials and at least one organizer account are saved
(`teamsGraph.isConfigured()`) — a college can have `enabled: true` stored from before it
disconnected the integration, and the settings screen uses `configured` rather than
`enabled` to decide whether to offer the switch at all. `running` is whether a sync is
in progress right now, `isRunning()` read from the same in-process flag `POST /sync`
checks — see the note on clustering below.

`PUT` **behaves as a PATCH**, exactly like `/tags/settings`: only the keys sent are
changed, and a `minAttendancePct` that parses as a number is clamped to **1–100** — the
floor is 1, not 0, because a report row showing any attendance at all would otherwise
clear a 0% floor and mark every ghost row Present. A value that does not parse as a
number at all is **ignored**, not reset to the platform default: `save()` merges over the
college's *current* settings rather than the defaults, so one bad key in a PATCH cannot
silently revert a threshold somebody already tuned. The response is always the complete
merged object, never a partial one, so the caller can see exactly what was stored.

**`POST /sync`** runs a pass immediately rather than only starting one, unlike
`POST /moodle/sync` — a person pressing this is usually checking a class right after it
ended and wants the answer on this screen, and a run is bounded by the organizer
accounts' calendars plus the sessions in the retry window, not a whole VLE. Three ways to
fail before any Graph call is made, all **409** (not run, nothing to retry):

- Teams attendance is not configured — `{ error: "Teams attendance is not configured — enter the credentials under Connected systems first." }`.
- Teams attendance is switched off — `{ error: "Teams attendance is switched off — turn it on under Attendance settings first." }`.
  Checked *after* the configured check, deliberately: an administrator who has entered no
  credentials at all gets told that, rather than being told to flip a switch that cannot
  yet be flipped. This is the check that makes "it ships off" (above) actually true for
  the manual button, not only for the scheduler — see the WHY comment on this check in
  `routes/teamsAttendance.js`.
- A sync is already running — `{ error: "A sync is already running." }`. The lock is a
  module-level boolean (`teamsSync.js`'s `running`), in-process like every other lock in
  this codebase — correct for the one Node process a deployment is, and a clustered
  deployment would need this to be a database-backed lock instead (the `TeamsSync` row
  itself, `SELECT ... FOR UPDATE`), because two processes would each believe they held
  the only lock.

A failure partway through — a Graph call throwing after some meetings were already
discovered or some marks already written — answers **502** with
`{ error: "The sync failed: " + <message> }`. The `TeamsSync` row for that attempt is
still written, with `status: "failed"` and whatever `summary`/`issues` had accumulated
before the throw, which is why `GET /runs` is the more complete picture of a bad run than
the 502 body alone — the failing call is usually only one of several sessions the run
was in the middle of.

`summary` (on both the sync response and every run row) is the same six-then-one
counters object: `meetingsDiscovered`, `sessionsMatched`, `sessionsAmbiguous`,
`reportsFetched`, `marksCreated`, `marksSkippedExisting`, `participantsUnmatched`.
`issues` is a plain array of human-readable strings — an ambiguous meeting naming its
subject and organizer, an unmatched participant naming what showed up in the report, a
register whose term was closed, a calendar or attendance report that could not be read —
because "reported, never guessed" (the spec's own words for what happens to an unmatched
participant) needs somewhere a human actually reads it, and a code a person has to look
up defeats that. `GET /runs` returns the 20 most recent rows regardless of status, so a
scheduled run nobody was watching when it happened is exactly as visible as a manual one.

**Never overwrites a mark.** Marks are written with `createMany` + `skipDuplicates` on
`AttendanceMark`'s `@@unique([sessionId, studentId])`, the same invariant
`moodleAttendance.js` holds and NFC tap check-in's own register write holds — a mark a
lecturer already set, or one an earlier sync run already wrote, is a row that already
exists at that key, so the insert for it is silently skipped rather than colliding.
**Absent is only ever written after a successful report fetch** — a calendar or
attendance-report call that fails leaves that session eligible for the next run (bounded
by a 7-day retry window) rather than marking anybody, and a participant the report shows
but cannot match to a student gets no mark at all, counted in
`participantsUnmatched` and named in `issues`, never guessed as absent.

## Teams automation (auto-creating meetings, provisioning class Teams)

The opposite direction from the section above: instead of reading meetings a college
already created by hand, this **creates** them — one Teams meeting per timetabled online
class (Phase A, `teamsMeetings.js`), and, separately, one Microsoft Team per cohort with
a channel per unit and staff/students added as owners/members (Phase B,
`teamsProvisioning.js`). Setup — the `Calendars.Read` → `Calendars.ReadWrite` upgrade,
the four tenant-wide Phase B permissions, and the channel-email caveat — is
`TEAMS_SETUP.md`'s Step 13. The credentials are the *same* Teams app registration as
Teams auto-attendance above (`GET /integrations`, `PUT`/`DELETE /integrations/teams`),
plus one more field, **`creatorAccount`** — the organizer account that actually creates
meetings and owns new Teams, defaulting to the first organizer account when blank
(`teamsGraph.js`'s `creatorEmail()`). This section covers only the endpoints specific to
automation itself, mounted at `/api/teams-automation` (`routes/teamsAutomation.js`).

**Two independent switches, both shipped off, and off means no Graph call at all** —
`autoCreateMeetings` and `provisionTeams` on `TeamsAutomationConfig`, checked separately
because a college may legitimately want one without the other (constraints.md). Neither
switch being on is a prerequisite for the other; a college can run meeting creation for
years without ever turning provisioning on.

Every endpoint below sits behind `requireAuth` **and** `requirePage("attendance-settings")`
— the identical grant as Teams auto-attendance's own endpoints, for the identical reason:
these back a section on the same Attendance settings screen (`AdminNfcTags.jsx`), so
whoever holds the grant that opens the screen is who every button on it needs to work
for. The Teams *credentials* themselves (tenant ID, client ID, client secret, organizer
accounts, creator account) stay behind `requirePage("settings")` on the generic
`/integrations/teams` routes, same as attendance's own credentials.

| Method | Path | Body | Returns |
|--------|------|------|---------|
| GET | `/teams-automation/settings` | — | `{ settings: { autoCreateMeetings, provisionTeams }, configured, meetingsRunning, provisioningRunning }` |
| PUT | `/teams-automation/settings` | any of `{ autoCreateMeetings, provisionTeams }` | `{ settings }` |
| POST | `/teams-automation/run-meetings` | — | `{ ok: true, summary, issues }` |
| POST | `/teams-automation/run-provisioning` | — | `{ ok: true, summary, issues }` |
| GET | `/teams-automation/runs` | — | `{ runs: [ {...row, job, summary, issues} ] }` (most recent 20, **both jobs together**) |

`configured` is `teamsGraph.isConfigured()`, the same check Teams auto-attendance uses —
one Teams app registration, one "is it connected at all" answer for both features.
`meetingsRunning`/`provisioningRunning` are each engine's own in-process `isRunning()`
flag, read separately because the two jobs run independently and one can be mid-run while
the other sits idle. `GET /runs` returns **one shared list**, not one per job — the 20
most recent `TeamsProvisionSync` rows regardless of `job`, discriminated by the `job`
field on each row (`"meetings"` or `"provisioning"`) — so a college that runs one job far
more often than the other still sees a genuinely recent history rather than the busier
job crowding the other out of a per-job cap.

`PUT` behaves as a PATCH, same idiom as Teams auto-attendance's own settings route: only
the keys sent are changed, and the response is always the complete merged object.

**`POST /run-meetings` and `POST /run-provisioning`** each run their pass immediately,
same as `POST /teams-attendance/sync`. Three ways to fail before any Graph call is made,
all **409**, checked in this order so the message always names the thing actually wrong:

- Not configured — `{ error: "Teams automation is not configured — enter the credentials under Connected systems first." }`.
- **That job's own switch is off** — `{ error: "Meeting creation is switched off — turn it on first." }` or
  `{ error: "Team provisioning is switched off — turn it on first." }`. Checked *after* the
  configured check, for the same reason Teams auto-attendance's own switched-off check is
  — an administrator with nothing configured yet sees "not configured", the actionable
  message for where they actually are, rather than "switched off", which reads as one
  checkbox away from working. This is the proof that OFF means nothing runs even for a
  manual "Run now" press, not only for the scheduler.
- That job is already running — `{ error: "A meetings run is already running." }` or
  `{ error: "A provisioning run is already running." }`. Each job's own in-process
  boolean, same clustering caveat as every other lock in this codebase.

A failure partway through answers **502** with `{ error: "The run failed: " + <message> }`.
The `TeamsProvisionSync` row for that attempt is still written with `status: "failed"`
and whatever `summary`/`issues` had accumulated first — one broken timetable event or
cohort never stops the rest of the run (each is wrapped in its own `try`/`catch` and
reported via `issues`, never allowed to abort the loop).

`summary` differs by job: meetings runs carry `{ meetingsCreated, meetingsUpdated,
meetingsCancelled }`; provisioning runs carry `{ teamsCreated, channelsCreated,
ownersAdded, membersAdded, peopleUnmatched, channelEmailMissing }`. `issues` is the same
shape as Teams auto-attendance's own — a plain array of human-readable strings, one per
event or cohort that hit a problem, because "unmatched people are reported, never
guessed" (constraints.md) needs somewhere a human actually reads it.

**Meetings (Phase A) behaviour worth knowing from the API side:**

- **A human's pasted `teamsJoinUrl` always wins.** An event with `teamsAutoMeeting` on
  but a join link pasted by hand (no `teamsCalendarEventId`, meaning the machine did not
  create it) is skipped entirely — never a second meeting created beside it.
- **The machine only cancels a meeting it created.** Unpublishing an event, or clearing
  its `teamsAutoMeeting` checkbox, cancels the calendar event **only** when
  `teamsCalendarEventId` is set (this system's own mark of ownership) — a pasted link is
  never touched by a cancel.
- **Reconciliation is by a fingerprint, not `updatedAt`.** A meeting is only re-PATCHed
  when the subject, date, time or attendee list actually changed since the last
  successful create/update — a room or title-only edit that Graph was never told about
  produces no PATCH and no re-notification of every attendee.
- **The reconcile window is short on purpose:** yesterday through two weeks ahead, both
  for `run-meetings` and the hourly scheduler — far enough back to still cancel a class
  cancelled right after it ended, far enough ahead to be useful, no further because
  nothing past that is actionable today.

**Provisioning (Phase B) behaviour worth knowing from the API side:**

- **Additive-only, always** (constraints.md) — a run never removes a member, a channel or
  a Team, and never renames one after creation. Undoing any of that is a human's decision
  in the Teams admin center, not something this run infers.
- **Follows publication**, the same as the meetings engine: only cohorts that appear in a
  **published** event's group list get a Team, and only units taught by a **published**
  event get a channel.
- **An unmatched person is a counted, named issue, never a guess** — a staff member or
  student whose email does not resolve to a Microsoft account is skipped for that run,
  counted in `peopleUnmatched`, and named in `issues`; they are retried automatically on
  the next run once their Microsoft account exists.
- **`teamsCreated`/`channelsCreated`/`ownersAdded`/`membersAdded` count new creations
  only.** Re-adding the same roster on every run (required by additive-only) is not
  counted as "added" a second time — only a **brand-new** Team's owners/members are
  provably new, because Graph's own "add member" call cannot distinguish "just added"
  from "was already one".

### `teamsAutoMeeting` on timetable events

`POST /api/timetabling/events`, `PUT /api/timetabling/events/:id` and
`POST /api/timetabling/events/:id/repeat` accept a boolean `teamsAutoMeeting` — the
"create the Teams meeting automatically" checkbox — with the same "undefined leaves the
stored value alone" idiom every other optional field on these endpoints already follows.
Setting it only records the administrator's intent; `teamsMeetings.js` above is what
actually reads the column and calls Graph. It is serialised back on every event (`sEvent`
in `timetabling/serialize.js`) alongside `teamsJoinUrl`.

**`/repeat` propagates `teamsAutoMeeting` but deliberately *not* `teamsJoinUrl`.** The two
fields are opposite kinds of value: `teamsJoinUrl` names **one specific meeting** — a
link an administrator pasted for this one occurrence — and copying it onto every repeated
date would attach that single meeting to many classes, the same class of error as
double-booking a room. `teamsAutoMeeting` carries no meeting identity at all, only the
college's standing answer to "should this slot get its own meeting", so copying it is
what makes every repeated occurrence get **its own** meeting created for it, rather than
none.

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

## Referrals to support departments

Handing a student to Wellbeing, ASK or Student Support — and tracking what became of it.
The department list is **configuration the college edits at runtime**, not a constant, so
every path below names a department by its stored **key** rather than by an id.

### Departments

| Method | Path | Access | Body |
|--------|------|--------|------|
| GET | `/referrals/departments` | `referrals` **or** `settings` | — `{ departments: [{ key, name, active }], mine: [key] }` |
| PUT | `/referrals/departments` | `settings` | `{ departments: [{ key, name, active }] }` — replaces the whole list |

Reading takes either page because the sidebar cannot be built without it and the settings
editor cannot render an editor for a list it may not fetch. Writing takes `settings`
alone: retiring the ASK desk is an administrative act, and a wellbeing officer holds
`referrals` to work a queue.

`PUT` is a **replacement, not a patch** — the screen edits the whole list, and removing a
department has to be expressible. A `key` is a slug (`[a-z0-9-]{1,40}`) and is
**immutable once used**: it is stored as a plain string on every referral and travels in
a URL fragment, so editing one would orphan every referral holding the old value.
Retiring is `active: false`. A retired department **refuses new referrals but still
resolves for reading**, so last term's queue renders under its name rather than its slug.

With no row saved, the platform defaults apply: `wellbeing`, `ask`, `student-support`. An
**empty stored list is a real answer** ("this college runs no support desks") and does
not fall back to the defaults — only the absence of a row does.

### How somebody joins a department

`PUT /api/staff/:id/access` (**Super Admin only**), body
`{ pages: string[] | null, supportDepartments?: string[] | null }`. Membership rides in
the same request as the page grant because they are one decision — split in two, a save
could half-succeed and leave somebody on the wellbeing team without the page that shows
it to them. Keys are filtered against the college's own list, so a key naming no
department cannot sit dormant in the column and come to life if that desk is created
later. Omitting the field means "not being changed"; `null` or `[]` clears it.

**The Super Admin is not exempt from membership, and can therefore set their own.** A
request that names `supportDepartments` updates the membership of a Super Admin and
leaves their pages alone; one that does not is still refused with
`The Super Admin always has full access`. Holding every admin page is a claim about
administrative authority, while being on the wellbeing team is a claim about who reads
a student's disclosures — `canReadDepartment` refuses to conflate them, which only
works as a decision if the account that configures the college can put itself on a team
deliberately, in a column the audit log records.

### Queues and raising one

| Method | Path | Access | Body |
|--------|------|--------|------|
| GET | `/referrals?department=<key>&status=<open\|accepted\|closed>` | `referrals` + **membership** | — the department's view, case notes included |
| GET | `/referrals/mine` | `referrals` | — what the caller raised, through the referrer's allowlist |
| POST | `/referrals` | `referrals` | `{ studentId, department, reason, urgency?, notifyStudent?, interactionId? }` |
| PUT | `/referrals/:id/accept` | `referrals` + membership | — 409 if already picked up |
| PUT | `/referrals/:id/notes` | `referrals` + membership | `{ notes }` — the department's own record |
| PUT | `/referrals/:id/close` | `referrals` + membership | `{ outcome, outcomeDetail? }` — `outcome` required |

Asking for a department you are not on is **403, not an empty list**: an empty queue and
a queue you may not read are different answers, and the second dressed as the first
teaches staff that the wellbeing desk has no work. **A Super Admin is not exempted** —
holding every admin page says something about administrative authority, not about who
reads a student's disclosures.

`urgency` is `routine` | `urgent`. `notifyStudent` defaults **off** and is compared
`=== true`, so a truthy non-boolean cannot switch it on — a tutor raising a safeguarding
concern must not have to remember to suppress an email. `interactionId` is optional and
must belong to the same student; a referral raised from the student record or by the
department itself has no meeting behind it.

`outcome` is one of `supported`, `referred_on`, `no_response`, `not_appropriate`,
`other`, and is **required to close**. Null on that column means "not closed yet", so a
closure carrying no outcome would collapse two states into one.

Raising one writes an in-app `Notification` to every member of the receiving team. It
**names no student and carries no reason** — it says work has arrived, and the queue
says what. Its `link` is the queue's own fragment, `referrals-<key>`.

### Handing a case on

| Method | Path | Access | Body |
|--------|------|--------|------|
| PUT | `/referrals/:id/transfer` | `referrals` + membership of the **current** department | `{ department, reason }` |
| GET | `/referrals/:id/history` | `referrals` + party to the case | — the hand-off trail |

**The sending team's case notes do not travel.** They are archived onto the transfer row
under the department that wrote them and cleared from the referral, in one transaction —
`Referral.notes` is read by whoever holds the case, so leaving them would hand the next
team a disclosure made to the last one. Deleting them was rejected: an officer who
mis-clicked would have destroyed their own record.

The status resets to `open` and `acceptedBy` / `acceptedOn` clear, because a case
arriving already marked accepted under another team's name is a case nobody picks up. The
receiving team is notified exactly as for a new referral, urgency carried across.

Refusals: a **closed** referral (409 — moving it would erase an outcome the referrer has
already been shown), the department already holding it (400), a retired or unknown target
(400), an empty `reason` (400).

`/history` is readable by the current department, the referrer, **or any department the
case previously sat with** — a wellbeing officer who transferred a case last week is no
longer on its current department and must still reach the record of their own hand-off.
Each entry carries `notesAtTransfer` **only** for a caller on that entry's
`fromDepartment`; for everybody else the key is **absent, not empty**.

### The conversation

| Method | Path | Access | Body |
|--------|------|--------|------|
| GET | `/referrals/:id/messages` | `referrals` + party to the case | — scoped by department, see below |
| POST | `/referrals/:id/messages` | the **referrer** or the **current** department | `{ body }` |

A third visibility, and neither of the first two. The referrer's `reason` is them talking
once; `notes` is the department talking to itself. "Which unit is this about?" had
nowhere to go, so it went into the case notes where the person who asked could not read
the answer, or into email, where the college has no record at all.

Messages are scoped to the department they were written **under**, not to the referral. So
after a hand-off the receiving team reads its own thread and not the previous team's — the
same line the transfer draws through the case notes. The **referrer reads every message**,
because every message was written to or by them.

**Reading is wider than writing.** A department that has handed a case on keeps its thread
to read and gets 403 posting to it: a case answered by two teams at once is how a student
gets two different answers.

### What the student is told

| Method | Path | Access | Body |
|--------|------|--------|------|
| GET | `/student/me/referrals` | student token | — only referrals where `studentNotified` is true |

Inside the student router allowlist and keyed on `req.user.id`; there is no id parameter.
The filter is a **WHERE clause, not a serialiser omission**: `notifyStudent` defaults off
so a tutor raising a safeguarding concern does not have to remember to suppress anything,
and an endpoint listing every referral would surface that concern to the student the same
evening. A serialiser could be trusted to omit a field; only a query can be trusted not to
load the row.

Each row is exactly `{ id, department, departmentName, status, outcome, raisedOn,
acceptedOn, closedOn }`. Never the reason — that is the tutor's account of the student,
written for somebody else — and never the case notes or the closing detail, which even the
referrer cannot read. `departmentName` is resolved server-side, retired departments
included, because a student must not be shown a slug about themselves.

### What the audit log records

Six verbs — `referral.raised`, `.accepted`, `.noted`, `.closed`, `.transferred`,
`.messaged` — each naming **who and where, never why**. The reason, the case notes, the
closing detail, the hand-off reason and every message body stay out, because the audit log
is read on Settings by administrators who were never granted this page.

## Admission tracker (funnel analytics)

`GET /api/admission-stats` · `GET|PUT /api/admission-stats/settings`

Gated `requireAnyPage(["admissions-tracker", "admissions"])` — the pattern
`/assessments/exec-summary` uses for `executive`. The new page ADDS an audience without
taking one away: an admissions officer keeps access to their own funnel.

**This endpoint emits aggregates only.** No applicant id, name, email, address, date of
birth or document number is selected or returned, ever. That is the whole reason the
page grant exists: `admissions` opens the full application record — passport and ID
numbers, National Insurance numbers, criminal-record and medical declarations — and a
principal who wants a conversion rate should not be handed those. `postCode` and
`countryOfCitizenship` **are** read, to bucket an applicant into a region or a
citizenship group, and are dropped before serialisation. Three guards hold the rule: the
named `SELECT` allowlist, a contract test that reads the route as text
(`src/admissions/aggregates-contract.test.js`), and a smoke assertion over the whole
response body. **If you add a field here, expect all three to object.**

Query: `intake`, `course`, `from`, `to` (both `YYYY-MM-DD`, on `createdAt`), `compare`
(an intake label, or `none`; omitted means automatic).

### The funnel

| Stage | Rule |
|---|---|
| `enquiries` | every `Admission` in scope |
| `applications` | `applicationSubmittedAt` set, or `source === "apply"` |
| `documentsComplete` | every type in the configured `requiredDocTypes` present |
| `interviewed` | a linked `Ism` with `interviewDate` set |
| `offersSent` | `offerSentAt` set, or `offerStatus` ∈ (`sent`, `accepted`) |
| `offersAccepted` | `offerStatus === "accepted"` |
| `enrolled` | `enrollStatus === "Enroll"` |

**Every stage is implied by each later one.** A student enrolled with no recorded ISM and
no offer letter is ordinary — staff enrol from a decision taken in a room and tidy the
record later, or never — and counting stages independently makes the funnel *widen* as it
descends, which reads as a broken chart rather than as missing paperwork.

`admitRate` is `offersSent / applications`; `yieldRate` is `enrolled / offersSent`.

### Null is not zero

Any rate whose denominator is zero comes back `null`, not `0` — "not measurable", not
"nobody converted" — and renders as an em dash. The same applies to the comparison:
**no comparable earlier period produces no chip at all**, never a fabricated +100%.
Changes in a COUNT are percentages (`changePct`); changes in a RATE are percentage
POINTS (`changePp`), because 20% → 30% is +10pp and not +50%.

`revenue` is `{ pence, coveredEnrolments, totalEnrolments, previousPence, changePct }`.
`pence` is `0` when nobody has enrolled (measurably nothing) but `null` when people have
enrolled and no course of theirs has a fee recorded (unmeasurable). It is an **estimate**
— enrolments × a per-course fee an administrator types — computed in one function,
`estimateRevenue`, so it can be swapped for real funding data when SLC is developed.

### Settings

One row, primary key the literal `"singleton"`, written by **upsert on that constant**
(two administrators saving at once must collide, not each insert a row). `GET` returns
the merged config plus `allDocTypes`, `courses` (with `feeAmountPence`) and `intakes`.

`requiredDocTypes` is configurable because `ADMISSION_DOC_TYPES` has ten entries and
none is marked optional: "all ten" reads artificially low, since an immigration share
code does not apply to a UK national. An empty stored list falls back to all ten — a bad
save writing `[]` would otherwise make every applicant documents-complete.

## Data shapes (client-facing)
```
Staff    { id, name, role, dept, email, allowance, initials, colour, accountRole,
           mustChangePassword, totpEnabled, totpRequired }
         // non-admins see a reduced shape for OTHER staff: { id, name, role, dept, initials, colour }
         // totpSecret is NEVER serialised here
Signup   { id, name, email, role, dept, status, note, decidedBy, decidedAt, requestedAt }
Notification { id, type, message, link, read, at }   // type: info | success | error
CheckIn  { id, staffId, date, in, out, summary, site, tagId }   // tagId: the sticker tapped, null otherwise
Leave    { id, staffId, type, start, end, reason, status, requestedAt, decidedBy, decidedAt, note }
Adjustment { id, staffId, days, note, date }
Document { id, name, type, date, scope, assignedTo }
Semester { id, name, start, end, sessionCount? }
Unit     { id, code, name, tutor, sessionCount?, studentCount? }   // model is Unit; there is no HndModule
Student  { id, firstName, lastName, name, studentRef, email, initials, colour, active, unitIds? }
Session  { id, unitId, date, start, end, description, audience, markedCount? }
Mark     { id, sessionId, studentId, status, remark, takenBy, takenAt, checkedInAt }
         // checkedInAt: HH:MM the student tapped in; takenAt is reset by every register save
AttendanceTag { id, label, active, lastTapAt, createdAt, createdBy }   // `code` ONLY on POST /tags
TagTap   { id, at, who, kind, outcome, status, site }   // who/kind null on a refusal before identification
TapSettings { enabled, lateAfterMins, earlyGraceMins, armSeconds, staffTapEnabled }
Summary  { P, L, E, A, marked, earned, possible, pct }   // pct: null until marked
```
