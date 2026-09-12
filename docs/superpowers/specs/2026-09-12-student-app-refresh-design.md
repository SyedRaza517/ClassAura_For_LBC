# The student app, round two — notified, self-served, and worth looking at

**Date:** 12 September 2026
**Status:** approved in conversation 12 Sep 2026; implementation plan to follow.
**Grounding:** the 12 Sep student-surface survey (StudentApp.jsx is 2,411 lines in one
file; sixteen `/api/student/*` endpoints; two defects found — the Teams join link never
shipped to students despite STATUS.md's claim, and students are prompted for push
permission whose token the server then rejects).

## What this is

Five pieces, chosen by the user from a researched menu, one spec because they share the
same two foundations (a student notification channel, and a student UI kit):

1. **Student notifications** — a real channel, push + in-app inbox. Today the app asks
   for notification permission and the server discards the token (`DeviceToken.staffId`
   is required, `/api/devices` is not on the student router allowlist); and the moments
   that most deserve a notification — the college answered your query, your marks are
   out — have no channel at all, not even email.
2. **Mitigating circumstances self-service** — submit and track a claim from the app.
   The model is already student-owned; only the routes and screens are missing.
3. **Streaks & badges** — private, tasteful attendance gamification.
4. **Due next** — assessments due and imminent classes in one agenda; weights finally
   shown; the average weighted. Includes the **join-online-class defect fix**: the
   student timetable starts carrying `teamsJoinUrl` and today's online class shows a
   Join button — the thing STATUS.md already promises.
5. **Design-system refresh** — a student UI kit, dark mode, the brand font actually
   applied, one attendance-band scale fed from the college's own settings, the
   status-bar band fixed, and the staff app code-split out of the student bundle.

## Decisions taken

**One notification table for both audiences, not a parallel student table.**
`Notification` and `DeviceToken` each gain a nullable `studentId`; `staffId` relaxes to
nullable with the rule *exactly one of the two is set*, enforced in the routes and by a
CHECK constraint in the migration. A second `StudentNotification` model was rejected:
every consumer (the push transport, the unread count, the delete-account cascade) would
exist twice and drift. Existing staff rows are untouched — the migration only widens.

**v1 notification triggers, and no more:** query answered; review published; marks
released; a timetable change touching a class within 48 hours; referral/support update;
MC decision (piece 2). Each writes the inbox row and best-effort pushes to the
student's devices. Push titles use the college's branding name — the hard-coded
"Staff Hub" title staff pushes carry today is corrected on the way past, because a
student push saying "Staff Hub" would be wrong twice.

**Predictions stay out.** The student app will not surface progression risk; the
prediction router's own reasoning stands (a machine telling somebody they are likely to
fail is a conversation, not a notification), and nothing in this spec weakens it.

**MC v1 is a form and a status, not a document pipeline.** Submit: category, affected
period, affected units/assessments, description. Track: the same states staff already
manage, plus a notification on decision. **No attachments in v1** — evidence upload
drags in storage integration and a review surface; the form says the college may
request evidence separately. Students see their own claims and statuses; staff notes
and internal fields never serialise to them (the referral allowlist precedent).

**Streaks are private and additive.** Computed on read from the student's own marks —
no new tables, no leaderboards, no comparison with anyone. Current streak (consecutive
teaching days with P/L on every session that day, E days neutral), best streak, and
badges: 5/10/25-day streaks, 100% week, 100% month, perfect unit. A card on Home, a
full view inside Attendance. Rejected: points economies and rankings — attendance is a
funding-audit record; celebrating your own consistency is the line.

**Due next merges two lists the app already fetches.** Assessments (due date, unit,
weight — weight is fetched today and never rendered) interleaved with the next ~48h of
classes, soonest first; past-due-unmarked flagged, not hidden. The average becomes
weight-aware and is labelled "weighted average"; unweighted assessments count at weight
1, and a college that never sets weights sees numbers identical to today's.

**The UI kit lives in `client/src/student/`, and StudentApp.jsx is split.** Tokens
(type scale, spacing, radius, semantic tones, motion durations) plus the primitives the
file already half-contains (Card, Button, Chip, Ring, StatusBar, Sheet, Row, Stat,
Empty, Skeleton, SectionTitle) move to `client/src/student/ui/`; each screen moves to
`client/src/student/screens/`. Same layouts, same navigation — this is the refresh
path, not the redesign.

**One band scale, the college's own.** The app's four inconsistent hard-coded
attendance scales are replaced by the bands the college configures (the same ones its
attendance letters use), served on a new student-safe endpoint and cached with the
initial load. Semantic rule kept from branding.js: dangerous states stay red whatever
the brand.

**Dark mode follows the system.** Tailwind `darkMode: "media"`; the tokens file carries
both palettes; the native status bar and theme-color follow. No in-app toggle in v1 —
the OS setting is the toggle.

**The status-bar band goes.** `overlaysWebView: true` + `env(safe-area-inset-top)`
padding on the student header, so the branded gradient reaches the physical top of the
phone. The staff web app is untouched (it never renders under the native bar).

**The brand font is applied, not just downloaded.** Plus Jakarta Sans becomes the
actual body/display font of the student branch via the global style that already loads
it; system-stack fallback stays.

**Students stop downloading the staff app.** `StudentApp` becomes a `React.lazy` route
split; the one shared piece (`BiometricSetting`, currently imported FROM StaffHub.jsx)
moves to its own module so the dependency edge reverses. Pull-to-refresh added to the
scrollport; per-screen refetch replaces the single load-everything-once effect where a
screen's data can go stale (inbox, attendance).

## What can go wrong, and what happens

- A student on the web (not the native app) gets the inbox but no push — by design;
  push registration remains native-only and silent elsewhere.
- FCM unconfigured → pushes no-op exactly as staff pushes already do; the inbox still
  works, so no trigger is lost.
- A college with no attendance bands configured → the shipped defaults render, which
  match today's letters' defaults.
- Dark-mode contrast is part of the kit's definition of done, not an afterthought:
  every token pair is checked at WCAG AA.
- The StudentApp split is behaviour-preserving by construction: screens move file-by-
  file with their markup unchanged before any visual token is applied, so a regression
  bisects to a move or to a token, never to both at once.

## Testing

Pure logic beside its code: streak/badge computation (term boundaries, E-day
neutrality, single-day cohorts), weighted-average maths, due-next interleaving, the
notification fan-out chooser (who gets what, exactly one of staffId/studentId). Smoke:
`smoke-student-notifications.mjs` (device token accepted for a student and refused
cross-kind; each trigger writes exactly one row; unread count; a student can read only
their own), `smoke-mitigations-student.mjs` (submit, track, decision notifies; staff
notes never serialise; the existing staff smoke stays green), and extensions to the
existing suites where a trigger fires from their flows (query answer, marks release).
Client: the split is verified by build + the existing pure-module tests moving intact;
a Playwright pass covers dark mode rendering and the new screens, following the
`_e2e-teams` pattern from 12 Sep.

## Not in scope, kept open

MC evidence attachments; documents-for-students; a full Today-feed home redesign;
per-college app builds theming the OS shell; web push (PWA) for browser users;
prediction visibility (deliberately never).
