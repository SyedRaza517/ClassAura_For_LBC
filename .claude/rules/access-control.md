---
paths:
  - "server/src/auth.js"
  - "server/src/validate.js"
  - "server/src/routes/**/*.js"
  - "client/src/StaffHub.jsx"
---

## Access control

- `requirePage("…")` gates admin pages. The grantable list is `ADMIN_PAGES` in
  `server/src/validate.js` and **must stay in sync with `ADMIN_PAGES` in
  `client/src/StaffHub.jsx`**. This said "two hand-maintained copies" until 16 Oct 2026 and
  now there is **one** on the server: `validate.js` DERIVES `ADMIN_PAGES` from the staff
  half of the function registry in `server/src/appFunctions.js`, which the Develop App
  screen reads too — otherwise a page would have been named in a third place and agreed
  with neither. The client's copy is still written by hand, and `adminPages-contract.test.js`
  is still the only thing holding the pair together (including their ORDER), because the
  client has no test framework of its own. Registry order therefore decides, and reordering
  it fails that test until the client is reordered to match.
- **`appFunctions.js` is a THIRD access question, not a fourth copy of the first.**
  `requirePage` answers "may this person use this page"; the registry answers "does this
  function exist in this deployment at all", which a college sets on the Develop App screen
  (Super Admin only, and deliberately not a grantable page — a key in `ADMIN_PAGES` is a key
  the Access tab offers as a checkbox). The two combine with AND inside `requireAnyPage`, so
  a switched-off page refuses a Super Admin and an `adminPages: null` account alike. It never
  mutates a grant: switching a page back on restores exactly the access that existed before,
  which stripping the grants on save would have destroyed.
  Refusals carry `code: "FUNCTION_DISABLED"`, distinct from a missing page (no code) and from
  `COLLEGE_WIDE_REQUIRED`. The student half is `requireEnabledScreen` on the student router,
  because student sessions are confined by the router allowlist below rather than by
  per-route guards and so had no existing hook to hang it on. Both guards **fail open** if
  the config row cannot be read — this decides what is OFFERED, never who is trusted, and
  failing closed would turn an unreadable settings row into a total lockout.
  `API.md` → *Develop App* is the reference; add to it there when you add a function here.
- Student and applicant tokens are confined by router allowlists (`STUDENT_ROUTERS`,
  `APPLICANT_ROUTERS` in `auth.js`), not by per-route checks.
- **`requireCollegeWide("…")` guards an action that is institution-wide BY ITS NATURE** —
  the monthly attendance letters, a Moodle or Teams run, the audit trail, editing the list
  of departments. A page grant answers "may you do this kind of thing"; this answers "may
  you do it to the whole college". It is a third question, and it needed a third guard: a
  job declares itself institution-wide with `withoutAcademicScope`, so the departmental
  filter is never asked, and a departmental admin pressing Run wrote to every student in
  the college. The refusal carries `code: "COLLEGE_WIDE_REQUIRED"` so a client can tell it
  apart from a missing page. `API.md` → *Whole-college actions* is the list; add to it
  there when you add a guard here.
- **Free text is outside the departmental boundary.** The audit trail and sync issue lists
  name students as prose, not as rows, so the guard has nothing to filter. Either the whole
  response is college-wide only (the audit trail) or the free-text field alone is withheld
  with a flag saying so (`issuesWithheld`) — never silently emptied, which reads on screen
  as "nothing to report".
- The `tid` claim is neither issued nor checked any more. It is **ignored, not
  rejected**: every session in the wild at the moment of the deploy carries one, and
  treating its presence as invalid would sign out every member of staff and every student
  at once, mid-term, for a change that is otherwise invisible to them.

