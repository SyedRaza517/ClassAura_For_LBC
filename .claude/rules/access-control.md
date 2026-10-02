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
  `client/src/StaffHub.jsx`** — two hand-maintained copies.
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

