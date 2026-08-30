# Referrals to support departments — design

**Date:** 2026-08-30
**Status:** approved to implement
**Depends on:** `2026-08-30-remove-multi-tenancy-design.md`, which landed first so this
feature's new table is not built with a `tenantId` that is removed a week later.

## The problem

A PAT meeting surfaces things the tutor cannot act on — a wellbeing concern, a
coursework question for ASK, a student-support need. There is nowhere to send them.
The only existing gesture in this direction is `routes/interactions.js`, which sends
the meeting-record email FROM the wellbeing mailbox when the free-text `queryType`
matches `/wellbeing/`. That routes an email. It creates no work anyone can pick up,
and nothing records what happened next.

## Decisions taken with the owner

1. **The department list is configuration, not a constant.** Platform defaults
   Wellbeing / ASK / Student Support; the college may add, rename or retire.
2. **You see the queues for departments you belong to.** The tutor who raised a
   referral always learns its status and outcome, and NEVER the case notes.
3. **The student is emailed only if the referrer ticks the box, which defaults off.**
4. **A referral can be raised from a PAT meeting, a department page, or a student
   record** — the meeting link is optional.

## Why a new table, and not the two obvious alternatives

**Not columns on `Interaction`.** The PAT log sits behind one grant: everyone with
`pat` reads every row. A wellbeing case note there is readable by every tutor in the
college, which is decision 2 inverted. It also has nowhere to put a referral with no
meeting behind it, and PAT emails the student a record of every row it writes, which
collides with decision 3.

**Not `Intervention`.** It looks like a fit — it even has a `welfare_referral` type —
but every row carries a frozen snapshot of the student's risk band, attendance and
submission rate, because its question is "were they worse when we stepped in?". A
tutor referring somebody to ASK about an extension has no business writing a risk
snapshot, and the two features fail differently.

## Data model

### `SupportDepartmentConfig` — a singleton, in the house pattern

Platform defaults in code, one JSON column merged over them, no row until the college
edits something, an allowlist on the way out, a short cache invalidated on save. The
shape `attendanceBandConfig.js` and `prediction/settings.js` established.

`id String @id @default("singleton")` — this codebase's singleton guarantee since the
de-tenanting — and the save path upserts on that literal, never find-then-create.

A department is `{ key, name, active }`. `key` is a slug and is immutable once used.

### `Referral`

Fields the department sees and the referrer does not are marked **(D)**.

- `student`, `studentId`
- `department` — the department KEY, **a string, not a foreign key**. A college that
  merges two teams must not cascade its case records away with the department row, and
  a referral for a team that no longer exists still has to render under its stored key.
  Same reasoning that keeps `loggedBy` a plain string on `Interaction`.
- `reason` — the referrer's own words. Visible to both: they wrote it.
- `urgency` — `routine` | `urgent`.
- `status` — `open` | `accepted` | `closed`.
- `outcome` — a CODE, nullable until closed. Null means "not closed yet", never "no
  outcome" — the null-is-not-zero rule.
- `notes` **(D)** — the receiving team's case notes.
- `outcomeDetail` **(D)** — free text written at closure.
- `raisedBy` / `raisedOn`, `acceptedBy` / `acceptedOn`, `closedBy` / `closedOn` — names
  as plain strings, dates as `YYYY-MM-DD`, matching `Interaction`. A referral must
  still say who acted on it after that person has left the college.
- `studentNotified` — whether the tickbox was ticked. "Did we tell them" is a question
  the college will be asked.
- `interaction`, `interactionId` — optional, `onDelete: SetNull`. Reorganising pastoral
  records must never destroy a referral, and a referral raised from the student record
  has no meeting behind it. Mirrors `Intervention.studentReviewId`.

### `Staff.supportDepartments`

A JSON array of department keys, exactly as `Staff.adminPages` already stores granted
pages. Membership decides which queues a person sees.

## Access control, and why it is shaped this way

**One grantable page, `referrals`**, added to the four hand-maintained copies of
`ADMIN_PAGES`.

A permission per department is not possible, and that is forced rather than chosen: the
list is editable by the college at runtime, and a college adding "Careers" at 4pm
cannot add a permission key to four source files. The page grants the feature;
`Staff.supportDepartments` decides which queues.

**Two serialisers, and the split is structural.** `sReferralForDepartment` carries
everything. `sReferralForReferrer` is an allowlist that never names `notes` or
`outcomeDetail`, so a column added later cannot leak through it — the `sAdmission`
lesson, where a blocklist meant every column added afterwards shipped to the browser
by default. A contract test asserts the referrer serialiser's exact key set, the way
`schema-contract.test.js` pins the `category`/`detail` rule for mitigating
circumstances.

## Screens

A **Referrals** parent in the sidebar — named for what it holds, not "Student Support",
which would collide with a department of that name. Children:

- one queue per department the signed-in person belongs to, generated from the config
  and their membership rather than from `allNav`;
- **Sent by me**, always present for anyone holding the page. This is where a tutor
  learns what became of a referral, rendered through the referrer serialiser.

A group whose children are all filtered out must not render at all — the invariant
`navGroups.js` carries and `navGroups.test.js` pins.

## Notification

An in-app `Notification` row per member of the receiving department, not an email to a
shared inbox. That table and its routes already exist. A queue nobody is told about is
a queue nobody works — but emailing the reason to a shared mailbox widens the
confidentiality surface for nothing, so the notification says a referral is waiting and
names no student.

The optional student email goes from the department's own mailbox where one is
configured, via the existing `mailFrom` categories.

## Testing

`scripts/smoke-referrals.mjs`, weighted toward the negative assertions this repo
prefers:

- a member of ASK cannot read a Wellbeing referral;
- the referrer's view of their own referral contains no `notes` and no `outcomeDetail`,
  asserted as an exact key set rather than a denylist;
- a referral cannot be accepted twice, nor closed without an outcome;
- a referral to an unknown department key is refused;
- the student is emailed only when the tickbox was ticked.

Plus a contract assertion that `notes` and `outcomeDetail` never appear in the referrer
serialiser's source text.

## Deliberately not in this change

Reassigning a referral between departments, threaded replies, and any student-facing
view of their own referrals. Each is a real request; none is needed for the queue to
work, and every one widens the confidentiality surface.
