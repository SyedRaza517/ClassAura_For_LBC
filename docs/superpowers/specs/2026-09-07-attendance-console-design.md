# The attendance console — design

**Date:** 7 September 2026
**Status:** awaiting review
**Owner's decisions recorded here:** three child screens under one parent; **full**
auto-absent; capture method chosen on a settings screen; check-in restricted to the
college network.

---

## 1. What this is

One parent nav group, `Attendance`, with three children:

```
Attendance                    ← group: presentation only, holds no permission
├── Attendance                ← every register: the sessions, who came, their names
├── Dashboard                 ← the staff view, modelled on SEAtS' student list
└── Attendance Settings       ← QR / NFC / both, and the network requirement
```

Plus three changes to how a mark can be made at all, driven by two proxy-attendance
holes the owner identified in SEAtS and does not want here.

`groupNav` already exists and is unit-tested; a group is presentation only and exists
only if at least one child survives permission filtering. Nothing here changes that.
The two existing page keys (`registers`, `live-attendance`) are reused and a third,
`attendance-settings`, replaces `attendance-tags`. **`ADMIN_PAGES` is a hand-maintained
pair** — `server/src/validate.js` and `client/src/StaffHub.jsx` — and a contract test
already pins them together, so the rename lands in both or the build goes red.

---

## 2. The two holes, and where we already stand

Checked against the code on 7 September, not from memory.

| Hole | Status here |
|---|---|
| Student changes phone clock, marks themselves present | **Already impossible.** Every decision uses `localDate()`/`localTime()` from `clock.js`, pinned to `Europe/London`. The request body carries `sessionId` and `code` and nothing else. The phone never supplies a time. |
| Marking outside the class | **Already refused.** One shared predicate (`withinSessionWindow` + `termOpenOn`) gates the mint *and* the scan, so the screen cannot advertise what the server will refuse. |
| Student signs in as a peer and marks them | **Open.** `deviceId` is captured on every tap (`routes/student.js`) and **never read**. Nothing stops one handset marking five students. |
| Scanning a photographed code from off campus | **Open.** No network restriction exists anywhere in the codebase. |

So two of the four are already closed, and the two that are open are the two this
design fixes.

### 2.1 One device, one student

The data is already being collected. Nothing reads it.

**The rule:** within one session, a `deviceId` that has already produced a mark for one
student is refused for a second. The refusal is logged like every other, with its
`method`, so "I tapped and it didn't work" stays answerable.

Refusing rather than silently allowing is the whole point, but the message must not
accuse: a shared family handset and a lent phone are real, and a student told "you are
cheating" when they borrowed a charger is a complaint the college has to handle. The
refusal says the handset has already been used for this class and to see the lecturer.

**Rejected: binding a device to a student permanently.** Students replace phones,
reinstall, clear storage, and borrow. A permanent binding turns a new phone into a
support ticket before every lecture. Per-session is the smallest scope that closes the
hole.

### 2.2 The network requirement

**A browser cannot read the WiFi SSID.** It is not exposed to web pages at all — this is
not a permission that can be requested. What is actually enforceable is the source IP of
the request, so the setting is honestly named: *check-in must come from the college
network*, configured as a list of public IP ranges (CIDR).

For a student on campus WiFi this is the same thing in practice. On 4G they are refused,
which is the point: it closes the photographed-code hole that the 30-second rotation
narrows but does not shut.

Two things this must get right or it becomes an outage:

- **It ships OFF.** A college that has not entered its ranges must not have check-in
  silently stop working. Empty list means no restriction, and the settings screen says
  so plainly rather than leaving it ambiguous.
- **The refusal names the reason** (`reason: "off_network"`) and the copy says "you need
  to be on the college WiFi", because the alternative is a lecture hall of students
  seeing a generic failure while the lecturer has no idea why.

`req.ip` behind Render's proxy requires `trust proxy` to be set correctly or every
request appears to come from the load balancer. **This must be verified against the real
deployment before the feature is switched on**, and the settings screen shows the IP the
server currently sees so an administrator can check it rather than guess.

---

## 3. Auto-absent — the owner's decision, and what it costs

**Decision: full auto-absent.** When a class ends, every enrolled student with no mark
becomes `A`.

This **reverses a deliberate decision** recorded in `routes/hnd.js`, which states that
`mark-remaining-absent` is the only path from check-in to an absence and exists
"precisely so that no automatic process ever takes it: a phone with a flat battery, a
forgotten handset or a device with no NFC must not become an academic record without
somebody deciding it should."

The concern was raised twice and the owner has decided. It is recorded here rather than
argued again, because a future reader finding an automatic absence writer needs to know
it was chosen, not overlooked.

### 3.1 The consequence nobody asked about, which must be handled

**Full auto-absent destroys register coverage**, and register coverage is one of the four
evidence-quality properties this product's competitive position rests on.

`registerCoverage` measures how much of the scheduled timetable was actually registered,
by counting sessions with **no marks**. If an automatic process writes a full set of `A`s
to every session that ends, then every session has marks, coverage reads ~100% for every
college for ever, and the figure that exists to catch a tutor who never takes the
register instead reports that everybody takes it.

That is the "manufactured reassurance" failure the codebase already names in this exact
area, arrived at from the other direction.

**So the marks must be distinguishable.** An auto-written absence carries
`takenBy: "System"`, and `registerCoverage` counts a session as **not taken** when every
mark on it is a System mark. A register nobody touched still reads as untaken, which is
true, while the student's record still shows the absence the owner asked for.

This is not optional garnish. Without it, this feature silently disables the measurement
the whole "we check whether anyone measured" argument is built on.

### 3.2 What fires it

An in-process scheduler, matching the three that already exist and are started from
`index.js`. Hourly is too coarse — classes end at :15, :30, :45 — so it runs every five
minutes, and like `scheduler.js` it is written to be safe to run repeatedly and to
survive a restart:

- A session is due when `checkInClosesAt(session)` has passed. That helper already
  exists and already accounts for the lecturer having ended check-in early or held it
  open, so the automatic close cannot contradict the lecturer's own hand on the window.
- **Today only.** It does not reach back and mark historic sessions absent, because
  switching this feature on must not retro-write months of academic records in one
  sweep. A college that wants history filled in can still use the lecturer's button.
- **A closed term is skipped**, matching the 423 that the register save and every scan
  already return.
- **It never overwrites.** Only enrolled students with no mark at all are written.
- Idempotent: re-running writes nothing, so a restart mid-sweep is harmless.

### 3.3 What stays editable

Every auto-written mark is an ordinary `AttendanceMark` and a lecturer can change it on
the register screen exactly as they change any other. `takenBy: "System"` is what tells a
disputed register how the `A` arrived — which is the same reason `TagTap.method` exists.

---

## 4. Screen 1 — Attendance (the registers)

The existing `registers` screen, reused, and the smallest change of the three: it already
lists sessions and opens a register showing every enrolled student with their mark.

What changes:

- It gains the **room**, once registers come from the timetable (see §7). Until then the
  column is present and empty rather than absent, so the screen does not change shape
  later.
- The lecturer's "Mark the N remaining absent" button stays. With auto-absent on it
  becomes the way to close a register *early*, which is still a real thing to want.

---

## 5. Screen 2 — Dashboard

Modelled on the SEAtS student list in the owner's screenshots: a filter bar, a student
table, a configurable column chooser, and slide-out filter panels.

**Filters:** date range, campus, course, cohort, unit, academic department.
**Columns:** name, student number, course, school/department, attendance %, last
attended, risk band, coverage.
**Panels:** Student Info, Engagement, Wellbeing — matching the shape of the screenshots.

Nearly all of this data already exists: `attendance.js` computes the percentage,
`coverage.js` the coverage, the prediction engine the band, and the academic-department
work of 4–5 September supplies the scoping.

### 5.1 The one place this must not copy SEAtS

SEAtS shows a bare **Attendance %**. Ours shows the percentage **and what it rests on**:

> `92%` — *from 3 of 40 registers*

A figure below the coverage floor is **withheld**, not printed, exactly as the engine
already withholds it. This is the product position stated in the competitive brief, and
the dashboard is the first screen where a customer can actually see it. A column that
prints 92% from three registers is the thing we say we do not do.

### 5.2 Scoping

Every query goes through the guarded Prisma client, so a department-scoped account sees
its own students without any per-route filtering. That boundary is already enforced
centrally in `db.js` and throws on an undeclared model, so a new screen inherits it
rather than re-implementing it.

---

## 6. Screen 3 — Attendance Settings

Replaces `attendance-tags`. Per-college configuration, following the pattern this
codebase uses five times over — defaults in code, one JSON column merged over them, no
row until the college edits something, an allowlist on the way out, a short cache
invalidated on save, and an upsert on the constant primary key so two administrators
saving at once collide rather than both insert.

The settings, all of which already exist except the last two:

| Setting | Today |
|---|---|
| `enabled` — sticker/NFC check-in | exists, default off |
| `qrEnabled` — QR check-in | exists, default **on** |
| `lateAfterMins` | exists, default 15 |
| `earlyGraceMins` | exists, default 0 |
| `qrRotateSeconds` | exists, default 30, floor 10 |
| `staffTapEnabled` | exists, default true |
| `autoAbsentEnabled` | **new**, default off |
| `networkRanges` | **new**, empty = no restriction |

"QR / NFC / both" is not a new tri-state: the two switches are already independent, and
"both" is both on. The screen presents them as a clear choice rather than two unrelated
toggles, which is the actual gap.

`PUT /tags/settings` is a **patch**, so switching one thing on does not reset a threshold
somebody tuned last term. That stays.

---

## 7. What this does not include

- **Registers from the timetable.** Still the biggest gap, still Phase 1 of the other
  plan. The dashboard's coverage column is honest but measures against a scheduled set
  that is currently produced by a 7-day stepper. This design does not fix that, and the
  two should not be entangled.
- **A constraint-solving scheduler.** Out of scope, permanently.

---

## 8. Testing

- **Pure logic, unit tested with no database:** the device rule, the CIDR match, the
  auto-absent due-session predicate. These are the three places a mistake writes a wrong
  academic record, and all three are pure functions of their inputs.
- **HTTP smoke suites, weighted to the negatives:** a second student refused on the same
  handset; an off-network scan refused with its reason; a scan after the class refused;
  auto-absent writing `A` only for the unmarked, only today, never in a closed term,
  never over an existing mark, and idempotent across two runs.
- **The coverage interaction gets its own assertion**, because it is the one that would
  otherwise pass silently: a session whose only marks are System marks must still count
  as *not taken*. Without that test this design's most important safeguard is
  unverified.
- Every new suite must run under `SMOKE_SCOPED_DEPARTMENT=1` as well, stamping its
  fixtures with the signing-in admin's department. Two suites were exempted from that
  pass in the past for want of this and it hid a real gap.
- Each new assertion is **proved able to fail** before it is trusted.

---

## 9. Phasing

Ordered so that each phase is independently shippable and the riskiest thing lands last.

1. **Nav restructure** — the group and the three children, `attendance-tags` renamed to
   `attendance-settings`, both `ADMIN_PAGES` copies in step. Smallest, and unblocks the
   other two screens.
2. **Attendance Settings** — the screen, plus `autoAbsentEnabled` and `networkRanges` as
   stored settings that nothing reads yet. Safe: adding a setting changes no behaviour.
3. **The two capture guards** — one device per student per session, and the network
   restriction. Both ship **off** and are switched on from screen 3.
4. **Auto-absent** — the scheduler, and the `registerCoverage` change that keeps the
   coverage signal alive. Last, because it is the only one that writes academic records
   on its own.
5. **Dashboard** — the largest screen, and the one that benefits from every phase above
   being in place.
