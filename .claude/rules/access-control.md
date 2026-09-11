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
- The `tid` claim is neither issued nor checked any more. It is **ignored, not
  rejected**: every session in the wild at the moment of the deploy carries one, and
  treating its presence as invalid would sign out every member of staff and every student
  at once, mid-term, for a change that is otherwise invisible to them.

