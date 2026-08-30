# QR check-in — design

**Date:** 29 August 2026
**Status:** approved, in implementation
**Phase:** 1 of the SEAtS capability programme (see `docs/superpowers/specs/` and the
comparison artifact). Phase 0 is a Moodle sync, which is a run rather than a build.

---

## Why this, and why before the NFC hardware proof

The competitive gap analysis put attendance capture first: it is the question every demo
opens with, and today the honest answer is "a lecturer types it in". We have exactly one
automated capture path — NFC — and it ships switched off and has never been run against
a physical sticker.

QR goes first anyway, ahead of proving NFC on hardware, for three reasons:

1. **It needs no purchase and no delivery.** The NFC proof is blocked on stickers and a
   handset arriving. QR is blocked on nothing.
2. **It works on every phone.** Including every handset with no NFC chip, which is a
   large fraction of the devices a further-education cohort actually owns. A capture
   method that excludes the poorest students is not a capture method.
3. **It demonstrates in a browser.** No native build, no Xcode capability, no Android
   toolchain — none of which exist on the development machine today.

The NFC hardware proof is not cancelled. It runs in parallel the day the stickers arrive.

---

## The problem QR creates that NFC did not have

`AttendanceTag.code` carries this comment in `schema.prisma`:

> Opaque and random, and deliberately NOT a URL. Our own app reads it, so there is
> nothing to gain from it being clickable and a lot to lose: a readable link is one a
> student can read off the wall with any phone and replay from home.

That reasoning is correct and it is specifically about a **permanent** code. NFC needs
physical proximity to read; a printed square does not. Printing the existing tag code as
a QR would silently undo a documented decision: one student photographs the wall once and
checks in from the bus for the rest of the term. That would make our attendance evidence
*worse than not having the feature*, because a register full of fabricated presents is
harder to challenge than an empty one.

So the code must rotate.

---

## Mechanism

### The code is derived, not stored

An HMAC over `(sessionId, windowIndex)`, where `windowIndex` is the local clock rounded
down to the rotation period. No new table, no rows to clean up, nothing that can go stale
in a database.

Verification recomputes the code for the **current window and the one immediately
before**. That two-window tolerance exists because a student who scanned at 29.8 seconds
into a 30-second window would otherwise be refused by their own network latency, and
"scan again" is the failure mode that makes people give up on a feature.

The trailing window is the only tolerance. There is no forward tolerance: accepting a
future window would mean a code is valid before it is displayed, which is a replay
window with extra steps.

### The key is derived, not reused

`secrets.js` exports `encrypt` / `decrypt` / `hint` / `isConfigured`, and its key is for
AES-256-GCM. Signing with an encryption key is a key-separation failure, so this derives
a distinct HMAC key from the same `CREDENTIALS_KEY` via HKDF under a fixed label.

Deriving rather than adding `QR_SIGNING_KEY` is deliberate: `CREDENTIALS_KEY` already has
to be set per environment, there are two environments that drift, and a second secret is
a second thing to forget on exactly one of them. A missing signing key would not fail
loudly — it would fail at the first scan of the first lecture.

### The code names the session

This deletes a whole branch. The NFC path resolves candidate sessions from `Enrolment`
plus the clock and then has to ask the student which of two overlapping classes they
meant. A session-derived code has no ambiguity to resolve: it says which register it is.

What verification must **not** skip, because naming the session proves only which room
the screen is in and nothing about who scanned it:

- the student is enrolled on that unit (`Enrolment`, exactly as the NFC path);
- the session's own window, including `earlyGraceMins`;
- the term lock (423 on a locked term, matching `PUT /sessions/:id/register`);
- the four invariants below.

It therefore reuses `statusFor` from `attendanceTap.js` and does not use
`resolveTapSession`.

### Nothing is opened and nothing can be left open

This preserves the invariant the NFC design rests on: *the lecture's own hours are the
window; there is nothing for a lecturer to open and nothing to forget to switch off.*

A rotating code is valid only inside its session's timetabled window. Displaying it opens
nothing; hiding it closes nothing. A lecturer who forgets to put it on screen has not
corrupted a register — they have declined to offer a shortcut, and the register is taken
by hand as it is today.

### The QR *is* a URL, and that is a deliberate reversal

The schema's "not a URL" rule does not survive rotation: a thirty-second link is not
worth reading off a wall. The UX difference is large and falls hardest on the least
confident users — OS camera, "Open in EdTech", done, versus find the app, find the
scanner, then scan.

**The permanent NFC tag code stays non-URL and is unchanged by this work.** The reversal
applies only to codes that expire.

---

## What this does not fix

A student can photograph the screen and send it to someone who scans within the rotation
window. Rotation converts proxy attendance from *permanent and free* into *real-time and
effortful*. That is a large reduction and it is not elimination. No QR-based system
solves this, including the ones we are being compared against.

The compensating control already exists and is one of the better things in the codebase:
`TagTap` records every scan, accepted or refused, with its address. "One address checking
in six students inside a minute" is invisible in `AttendanceMark` and obvious in the tap
log.

Shorter rotation trades against slow phones and poor signal. The default is 30 seconds
and it is a per-college setting, because this is exactly the kind of threshold a college
will want to argue about and should not need a deploy to change.

**This limitation belongs in the sales conversation, stated by us first.**

---

## The `selfMarked` hazard

`routes/hnd.js:1346` computes the lecturer's live view with an exact equality:

```js
selfMarked: mark?.takenBy === SELF_CHECKIN_STAMP
```

A second stamp string — `"Self check-in (QR)"` — would make `selfMarked` **false** for
every QR check-in. The lecturer's live view would then show a self-marked student as
though a human had marked them, which is the precise opposite of what that column exists
to say, on the one screen built to say it.

The fix, and its constraint:

- `SELF_CHECKIN_STAMP` keeps its exact current value, `"Self check-in (NFC)"`. Rows in
  both databases already carry that string; changing it would rewrite history.
- A new `SELF_CHECKIN_STAMPS` set and an `isSelfCheckIn(takenBy)` predicate live beside
  it in `attendanceTap.js`, the module both halves already import.
- `hnd.js` uses the predicate. A test asserts that every member of the set is recognised,
  so a third capture method added later cannot reintroduce this by being forgotten.

This is the `ADMIN_PAGES` failure shape — a value two places must agree on — and it is
survivable only with a test, so it gets one.

---

## The four invariants, unchanged

Inherited from the NFC path and re-asserted by the QR suite rather than assumed:

1. **A scan never overwrites a mark a lecturer already set.** The human in the room wins.
2. **A scan never writes an `A`.** Absence is what an untaken register already means.
   Scoring "did not scan" as absent turns a flat battery into a permanent academic record,
   most often for the students least able to argue about it.
3. **`checkedInAt` is its own column, not `takenAt`.** `takenAt` is reset on every
   register save, so a lecturer correcting one row an hour later would otherwise rewrite
   everybody's arrival time.
4. **Nothing runs on a schedule.** No sweep closes a register, nothing marks anybody, no
   student is emailed at any point.

---

## Schema

One migration, two nullable columns on `TagTap`:

- `method` — `"nfc"` | `"qr"`. `tagId` is already nullable, but there is currently no way
  to tell an NFC tap from a QR scan in the log, and an administrator answering "I scanned
  and it did not work" needs to know which. Nullable so existing rows stay truthful:
  a row written before this column existed is not evidence that it was NFC, it is
  evidence that we were not recording the method. Backfilling it to `"nfc"` would invent
  a fact.
- `sessionId` — nullable, no foreign key requirement beyond the tenant. A QR scan names a
  session even when it is refused, and that is the half of the log worth having.

Both `StudentPredictionCurrent` and `StudentPredictionHistory` are untouched: this
feature emits no figure into the prediction pipeline. It flags a student stale, exactly
as the NFC path does, and does not rescore — a check-in must not wait on arithmetic.

---

## Settings

Two fields join the existing five in `attendanceTapSettings.js`, same shape, same patch
semantics, same audit line, same allowlist on the way out:

- `qrEnabled` — ships `false`. Same reasoning as `enabled` and the attendance emails: a
  feature that writes to the attendance record must not switch itself on at every college
  on the next deploy.
- `qrRotateSeconds` — default 30, floor 10, ceiling 300. The floor matters as much as the
  ceiling: a rotation shorter than the time it takes to raise a phone and focus is an
  outage that presents as "the QR never works".

`qrEnabled` is separate from `enabled` rather than implied by it. A college may want the
stickers and not the projector, or the projector and not the stickers, and inferring one
from the other would switch on a capture method nobody asked for.

---

## Surfaces

- **Lecturer display** — `client/src/AdminLiveAttendance.jsx`, which already shows who is
  in, who is late, and who has not appeared. The rotating code goes on that screen, plus
  a full-screen "present" mode for a projector. Not a new screen: the lecturer watching
  the register fill is already the person holding the code.
- **Student scanner** — `client/src/CheckInCard.jsx`, which already serves both apps and
  already handles "dead until a code is read, dead again after `armSeconds`". A scan is
  another way to acquire a code; the card below it does not change.
- **Deep link** — scanning with the OS camera opens the app at the check-in card with the
  code already in hand. On web it opens the SPA route directly.

---

## Testing

- **Pure core** — `attendanceQr.js` with `attendanceQr.test.js` beside it, matching
  `attendanceTap.js` / `attendanceTap.test.js`. Window arithmetic, HMAC derivation and
  verification, the trailing-window tolerance, the absence of a forward tolerance, and
  every boundary. No database, no clock — the caller reads the clock through `clock.js`
  and passes it in.
- **Settings merge** — extends `attendanceTapSettings.test.js`, including that an
  unusable `qrRotateSeconds` is *ignored* rather than reset, which is what the PATCH
  contract promises.
- **HTTP** — `scripts/smoke-qr-checkin.mjs`, weighted to refusals as the house style
  requires: a scan while QR is off, an expired code, a code from a window two rotations
  ago, a forward-dated code, a code for a session the student is not enrolled on, a code
  from another college, a scan outside the session window, a scan against a locked term, a
  second scan not creating a second mark or moving the arrival time, a scan not
  overwriting a lecturer's mark, and a student reaching the lecturer's display.
- **Regression proof** — per `CLAUDE.md`, each new guard is broken deliberately and the
  test confirmed to catch it. Twice in recent work a test passed while discriminating
  nothing.
- **Client** — builds. There is no client-side test framework, so that is the whole claim
  and it will not be written up as more than that.

---

## Out of scope

- Offline scanning and a queued upload. Real, and a different design; not v1.
- Any student-facing notification. Unchanged from the NFC path.
- BLE beacons, geofencing and card readers. Later phases, separately specified.
- Replacing or altering the NFC path in any way beyond the `isSelfCheckIn` predicate.
