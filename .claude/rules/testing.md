---
paths:
  - "server/src/**/*.test.js"
  - "scripts/**"
---

## Testing approach

Pure logic lives in its own file with tests beside it and no database — see
`src/prediction/` and `src/vle/*Normalise.js`. Everything else is covered by HTTP smoke
suites in `scripts/`, which are deliberately weighted toward **negative** assertions:
who is refused, what never leaves the building, which decisions cannot be made twice.

There is **no client-side test framework at all**. `StaffHub.jsx` (~12k lines) is
verified only by building.

When adding a regression test, prove it can fail: reintroduce the bug and confirm the
test catches it. Twice in recent work a test passed while discriminating nothing.

