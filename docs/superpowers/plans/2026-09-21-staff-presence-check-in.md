# Staff presence check-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A member of staff picks On site or Online from two tabs; On site reads an NFC sticker and proves the phone is on the college network and at a campus before the clock-in is written.

**Architecture:** `presence.js` is a pure, tested module that already answers "is this device plausibly in the building" and is called today only from `routes/student.js`. Nothing in it changes. Two new per-college switches (`staffNetworkCheck`, `staffGeofenceCheck`) are translated into the shape `checkPresence` expects and the two staff clock-in routes call it. The client gains a staff-side `needsLocation` resolver, and Android gains the location permission it has never had.

**Tech Stack:** Express + Prisma (server), React 18 + Vite (client), Capacitor (Android/iOS), `node:test` for unit tests, `scripts/smoke-*.mjs` for HTTP suites.

**Spec:** `docs/superpowers/specs/2026-09-21-staff-presence-check-in-design.md`

## Global Constraints

- **Branch:** `feature/staff-presence-check-in`, already created off `main` at `6486de0`. Do not commit to `main`.
- **Database:** every test command passes `DATABASE_URL` inline. Never let it fall through to `server/.env`, which points at a live database. Use `postgresql://postgres:postgres@localhost:5432/edtech_dev`.
- **Both new settings default `false`.** With both off, every behaviour in this plan must be byte-for-byte identical to today. This is what makes the change safe to deploy before a college opts in.
- **Online is never presence-checked, under any setting.** Gate on `site === "Onsite"`, never on the route.
- **Nulls are not zeroes.** A check that is ON but cannot be evaluated FAILS. Never treat "no position" or "no ranges saved" as a pass.
- **Comments explain WHY, at length, including why an alternative was rejected.** This is the house style and it is load-bearing. Match the density of the surrounding code — it is unusually high.
- **Dates are strings** (`YYYY-MM-DD`); `src/clock.js` pins the timezone. Never use the host clock for a user-facing date.
- **Serialise through allowlists, never blocklists.**
- **Do not modify `server/src/presence.js`.** It is pure, tested, and already takes exactly the arguments a staff clock-in has.

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `server/src/attendanceTapSettings.js` | The two new switches, their merge rules, and the pure guard that refuses an unusable save | 1 |
| `server/src/attendanceTapSettings.test.js` | Unit tests for the above | 1 |
| `server/src/campuses.js` | **New.** `campusesFor(sessionId)`, lifted out of `routes/student.js` so both routers share one answer | 2 |
| `server/src/routes/student.js` | Imports `campusesFor` instead of defining it | 2 |
| `server/src/routes/tags.js` | Refuses a save that would lock every member of staff out | 1 |
| `server/src/routes/checkins.js` | The presence gate on both staff routes; the site-required fix; `needsLocation` | 3, 4 |
| `scripts/smoke-nfc-tap.mjs` | Refusal-weighted HTTP assertions for all of the above | 3, 4 |
| `client/android/app/src/main/AndroidManifest.xml` | `ACCESS_FINE_LOCATION`, without which the geofence can only ever refuse | 5 |
| `client/src/staffCheckInView.js` | **New.** Pure: the button's state and the words for each refusal | 6 |
| `client/src/staffCheckInView.test.js` | **New.** Unit tests for the above | 6 |
| `client/src/api.js` | The staff `needsLocation` resolver and its own cache key | 4 |
| `client/src/StaffHub.jsx` | The two tabs, the grey-to-blue button, the popup's new phase | 6 |
| `client/src/AdminNfcTags.jsx` | The two checkboxes | 7 |
| `STATUS.md` | The honest map | 8 |

---

### Task 1: The two switches, and a save that cannot lock everybody out

**Files:**
- Modify: `server/src/attendanceTapSettings.js` (DEFAULTS ~line 167, `merge` ~line 260, exports ~line 318)
- Modify: `server/src/routes/tags.js:48-89` (`PUT /settings`)
- Test: `server/src/attendanceTapSettings.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `DEFAULTS.staffNetworkCheck: boolean`, `DEFAULTS.staffGeofenceCheck: boolean`, and `staffNetworkGuard(settings) -> string | null` (a refusal message, or null when the save is safe). Tasks 3, 6 and 7 read the two booleans; nothing else calls the guard.

- [ ] **Step 1: Write the failing tests**

Append to `server/src/attendanceTapSettings.test.js`:

```js
test("staff presence checks ship OFF, so a deploy changes no college's clock-in", () => {
  // The same rule every capture-affecting switch here follows. Shipping either ON would
  // start refusing clock-ins at every college on the next deploy, for a decision nobody
  // took — and the person refused would be standing at a door at 08:45.
  const s = merge(null);
  assert.equal(s.staffNetworkCheck, false);
  assert.equal(s.staffGeofenceCheck, false);
});

test("the staff switches are separate from the student ones", () => {
  // NOT the same field widened. The student pair is labelled on the settings screen as
  // student-only ("It does not affect a lecturer taking the register"), so reusing it
  // would make any college that ticked it for students start refusing staff on the next
  // deploy — a change nobody made and nothing on screen announces.
  const s = merge({ networkCheck: true, geofenceCheck: true });
  assert.equal(s.networkCheck, true);
  assert.equal(s.geofenceCheck, true);
  assert.equal(s.staffNetworkCheck, false);
  assert.equal(s.staffGeofenceCheck, false);
});

test("a non-boolean does not switch a staff check on", () => {
  // "false" and 0 are both mistakes somewhere in a chain of JSON; so is "true".
  const s = merge({ staffNetworkCheck: "true", staffGeofenceCheck: 1 });
  assert.equal(s.staffNetworkCheck, false);
  assert.equal(s.staffGeofenceCheck, false);
});

test("both staff switches are in the allowlist", () => {
  assert.ok(SETTING_FIELDS.includes("staffNetworkCheck"));
  assert.ok(SETTING_FIELDS.includes("staffGeofenceCheck"));
});

test("requiring the college network with no ranges saved is refused, not saved", () => {
  // EMPTY WHILE ON MEANS REFUSE EVERYBODY (presence.js). Left to save, an administrator
  // ticks the box, sees no error, and every member of staff is locked out while the
  // screen reports the network is enforced. A rule that silently stops applying is worse
  // than one that was never switched on, so this is refused at the API rather than
  // warned about on screen.
  const refusal = staffNetworkGuard({ staffNetworkCheck: true, allowedNetworks: [] });
  assert.ok(refusal, "expected a refusal message");
  assert.match(refusal, /IP range/i);
});

test("the guard permits every safe shape", () => {
  // On with ranges; off with none; off with some. Only the first combination is fatal,
  // and a guard that refused any of these would block an administrator from switching
  // the check back OFF after they had cleared the list — which is the exact sequence
  // somebody digging themselves out of a misconfiguration would perform.
  assert.equal(staffNetworkGuard({ staffNetworkCheck: true, allowedNetworks: ["203.0.113.0/24"] }), null);
  assert.equal(staffNetworkGuard({ staffNetworkCheck: false, allowedNetworks: [] }), null);
  assert.equal(staffNetworkGuard({ staffNetworkCheck: false, allowedNetworks: ["203.0.113.0/24"] }), null);
});

test("the geofence has no equivalent guard, deliberately", () => {
  // A campus with no coordinates is a row somebody must go and fix on a DIFFERENT screen,
  // so refusing the save would leave an administrator unable to express the intent at
  // all. presence.js refuses under `campus_not_located` and routes/checkins.js raises the
  // alarm in the log — the same treatment the student path already gets.
  assert.equal(staffNetworkGuard({ staffGeofenceCheck: true, allowedNetworks: [] }), null);
});
```

Add `staffNetworkGuard` to the existing destructured `require` at the top of the test file.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd server && node --test src/attendanceTapSettings.test.js
```

Expected: FAIL — `staffNetworkGuard is not a function`, and the default assertions report `undefined` rather than `false`.

- [ ] **Step 3: Add the two switches to DEFAULTS**

In `server/src/attendanceTapSettings.js`, inside the `IS THE PHONE ACTUALLY IN THE BUILDING?` block, immediately after `geofenceRadiusM: 250,`:

```js
  /* ------------------------------------------------------------------ *
   * THE SAME TWO QUESTIONS, ASKED OF STAFF
   *
   * SEPARATE FIELDS, NOT THE PAIR ABOVE WIDENED, and this is the whole decision.
   *
   * `networkCheck` and `geofenceCheck` are described to an administrator on the settings
   * screen as applying to the three STUDENT methods — the copy says so in as many words:
   * "It does not affect a lecturer taking the register." Teaching them to govern staff as
   * well would mean that every college which ticked one for students begins refusing
   * staff clock-ins on the next deploy, for a decision nobody took and nothing on screen
   * announces. That is the exact failure this file legislates against everywhere else.
   *
   * BUT THEY SHARE `allowedNetworks` AND `geofenceRadiusM`, because those describe the
   * COLLEGE, not the audience: one network, one set of campuses. Two lists that had to be
   * kept in sync would drift, and the drift would present as "check-in stopped working
   * for staff only" — which nobody connects to a settings screen edited a month earlier.
   *
   * Both OFF, like every other switch here that writes to a record the college is asked
   * to evidence.
   * ------------------------------------------------------------------ */

  // Whether a member of staff clocking in ONSITE must be on the college network.
  //
  // Never applied to Online. Somebody working from home is BY DEFINITION off the college
  // network, so checking it would refuse every honest remote clock-in and leave the
  // truthful answer unrecordable — the same reasoning that makes `staffTapEnabled` gate
  // on `site` rather than on the route.
  staffNetworkCheck: false,
  // Whether a member of staff clocking in ONSITE must be at a campus.
  //
  // A CAMPUS BOUNDARY, NEVER A ROOM ONE — see geofenceCheck above, which says why at
  // length. For staff the honest claim is smaller still: this says somebody was at the
  // college, not that they were at their desk.
  staffGeofenceCheck: false,
```

- [ ] **Step 4: Merge them strictly**

In `merge`, immediately after the existing `geofenceCheck` line:

```js
  // Compared identically, exactly like the student pair above. A college's staff being
  // locked out of clocking in is not a failure that announces itself — it presents as
  // "the app is broken" at 08:45 on a Monday — so no coerced value is read as consent.
  if (stored.staffNetworkCheck === true || stored.staffNetworkCheck === false) out.staffNetworkCheck = stored.staffNetworkCheck;
  if (stored.staffGeofenceCheck === true || stored.staffGeofenceCheck === false) out.staffGeofenceCheck = stored.staffGeofenceCheck;
```

- [ ] **Step 5: Add the guard and export it**

At the end of `server/src/attendanceTapSettings.js`, before `module.exports`:

```js
/**
 * Would this settings object refuse every member of staff? A message if so, else null.
 *
 * PURE, and applied to the MERGED result rather than to the patch, because a PATCH that
 * sends only `{ staffNetworkCheck: true }` is exactly the dangerous one: the ranges it
 * would be judged against are the ones already stored, which the patch never mentions.
 *
 * ONLY THE NETWORK CHECK HAS ONE. The geofence reaches the same dead end — switched on
 * with no campus located — but the fix for that lives on a different screen (a campus's
 * coordinates), so refusing the save would leave an administrator unable to express the
 * intent at all. That one is caught at the point of use and shouted about in the log
 * instead, which is what the student path already does.
 *
 * Why refuse rather than warn: `allowedNetworks: []` with the check ON refuses everybody
 * by name, and presence.js is right to do that — "no ranges" must never read as "any
 * range". But it means an administrator can tick a box, see a successful save, and lock
 * out a whole college while the screen reports the network is enforced. The save is the
 * last moment anybody is looking.
 */
function staffNetworkGuard(settings) {
  if (!settings || settings.staffNetworkCheck !== true) return null;
  const list = settings.allowedNetworks;
  if (Array.isArray(list) && list.length > 0) return null;
  return "Add at least one college IP range before requiring staff to clock in from the college network — with none saved, every clock-in would be refused.";
}
```

Add `staffNetworkGuard` to `module.exports`.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd server && node --test src/attendanceTapSettings.test.js
```

Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 7: Wire the guard into the save route**

In `server/src/routes/tags.js`, add `merge` and `staffNetworkGuard` to the existing require of `../attendanceTapSettings` (add the require if the module is not already imported there), then insert into `PUT /settings` immediately after `const before = await tapConfig.get();`:

```js
  // REFUSED BEFORE THE WRITE, not reported after it. `allowedNetworks: []` with the staff
  // network check ON refuses every clock-in by name (presence.js), so letting this save
  // means an administrator ticks a box, sees success, and discovers on Monday morning
  // that nobody can clock in — while the screen still says the network is enforced.
  //
  // Judged on what the settings WOULD BECOME, because a patch of `{staffNetworkCheck:
  // true}` alone is the dangerous shape: the list it will be judged against is the stored
  // one, which the patch never mentions.
  const preview = merge(patch, before);
  const networkRefusal = staffNetworkGuard(preview);
  if (networkRefusal) return res.status(400).json({ error: networkRefusal, reason: "networks_required" });
```

- [ ] **Step 8: Run the full server unit suite and commit**

```bash
cd server && node --test "src/**/*.test.js"
```

Expected: PASS. (**Use the glob, not a bare directory** — given `src/` the runner walks into `src/index.js`, binds a port, starts the schedulers and never terminates.)

```bash
git add server/src/attendanceTapSettings.js server/src/attendanceTapSettings.test.js server/src/routes/tags.js
git commit -m "Staff presence: two switches of their own, and a save that cannot lock a college out"
```

---

### Task 2: One place that answers "which campuses"

**Files:**
- Create: `server/src/campuses.js`
- Modify: `server/src/routes/student.js` (remove `campusesFor` ~lines 188-219, import it instead)

**Interfaces:**
- Consumes: nothing.
- Produces: `campusesFor(sessionId: string | null) -> Promise<Array<{latitude: number, longitude: number}>>`. Task 3 calls it with `null`.

**Why this is its own task:** `routes/student.js` defines `campusesFor` privately, and Task 3 needs it. Copying it would make two answers to one question. That is not hypothetical here — six handlers in this codebase independently grew an answer to "who is on this register", disagreed, and were fixed six separate times, once in a handler that marked students absent, where the wrong answer wrote wrong data rather than merely showing it.

- [ ] **Step 1: Create the module**

`server/src/campuses.js` — move the function verbatim, keeping every comment, and add a header:

```js
// Which campuses could a check-in legitimately be at?
//
// ONE PLACE, because two routers need it: the student's three check-in methods and the
// staff clock-in. It lived privately inside routes/student.js until the staff routes
// needed the same answer, and it was LIFTED rather than copied for the reason this
// codebase has already paid for once — six handlers independently grew an answer to "who
// is on this register", disagreed with the roster rule, and were fixed six separate
// times. One of them marked students ABSENT, so the wrong answer wrote wrong data rather
// than merely showing it.
//
// The two callers ask different questions of it and that is the point of the argument:
// a student's check-in is for a class, which may have a room, which is on a campus. A
// staff clock-in is for a day, not a class, so it passes null and gets every located
// campus — which is the honest question anyway ("is this person at the college").
const { prisma } = require("./db");

/**
 * The campuses a check-in could legitimately be at.
 *
 * A class held in a room is at that room's campus, and that is the tightest answer
 * available. When there is no room, or the room predates campuses, or the caller has no
 * class at all, EVERY located campus is returned instead — because "which campus" is
 * frequently unknowable and refusing all of those would make the geofence unusable at
 * exactly the colleges that want it. What it still refuses is a phone at none of them,
 * which is what the college asked for.
 *
 * Only called when a geofence is switched on: this is up to two queries on the check-in
 * path, and a college that has not opted in should not pay for them.
 */
async function campusesFor(sessionId) {
  if (sessionId) {
    // Reached from the id rather than a loaded row, because the check runs BEFORE each
    // route resolves its session — and it has to. A student off the college network must
    // be told that, not handed "tag not recognised" or "wrong code" from a check they were
    // never going to get past. One query, and only when the geofence is switched on.
    const room = await prisma.hndSession.findUnique({
      where: { id: sessionId },
      select: { room: { select: { campusRef: { select: { latitude: true, longitude: true } } } } },
    }).then((s) => s?.room).catch(() => null);
    // Only when it actually has coordinates. A room on an unlocated campus falls through
    // to the college-wide list rather than refusing — the class is somewhere, and the
    // college's other campuses are a better guess than none. If NOTHING is located, the
    // list comes back empty and presence.js refuses under `campus_not_located`, which is
    // the loud failure a misconfiguration deserves.
    if (room?.campusRef?.latitude != null && room?.campusRef?.longitude != null) return [room.campusRef];
  }
  return prisma.campus.findMany({
    where: { active: true, latitude: { not: null }, longitude: { not: null } },
    select: { latitude: true, longitude: true },
  });
}

module.exports = { campusesFor };
```

Confirm the import path for `prisma` matches what `routes/student.js` uses (it requires from `../db`; from `src/` it is `./db`).

- [ ] **Step 2: Delete the copy in the student router and import instead**

Remove the `campusesFor` function body from `server/src/routes/student.js` and add to its requires:

```js
const { campusesFor } = require("../campuses");
```

- [ ] **Step 3: Prove the student geofence still behaves**

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- smoke-nfc-tap
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- smoke-qr-checkin
```

Expected: both PASS with the same check counts as before the change. This is a mechanical move; a changed count means something else moved with it.

- [ ] **Step 4: Commit**

```bash
git add server/src/campuses.js server/src/routes/student.js
git commit -m "One place answers which campuses a check-in could be at"
```

---

### Task 3: The staff routes ask whether the phone is in the building

**Files:**
- Modify: `server/src/routes/checkins.js` (`POST /check-in` ~line 136, `POST /tap-check-in` ~line 238)
- Test: `scripts/smoke-nfc-tap.mjs`

**Interfaces:**
- Consumes: `DEFAULTS.staffNetworkCheck` / `staffGeofenceCheck` (Task 1); `campusesFor(null)` (Task 2).
- Produces: HTTP 403 with `{ error, reason }` where `reason` is one of `off_network`, `network_not_configured`, `off_campus`, `campus_not_located`, `position_missing`, `accuracy_unknown`, `accuracy_too_poor`. Task 6 renders these.

- [ ] **Step 1: Write the failing smoke assertions**

In `scripts/smoke-nfc-tap.mjs`, in the staff section (near the existing `/checkins/tap-check-in` assertions around line 862). Note the suite's `call()` already supports `from` (an `X-Forwarded-For` spoof — legitimate here because the suite runs with no proxy in front, so the header IS the first hop) and that settings are set through `PUT /tags/settings`:

```js
// ---------------------------------------------------------------------------
// THE PHONE HAS TO BE IN THE BUILDING — staff clock-in
//
// Weighted entirely towards refusals. The single most important assertion in this block
// is that ONLINE IS NEVER REFUSED: a member of staff working from home is by definition
// off the college network and away from every campus, so a rule that caught them would
// make the honest answer the unrecordable one.
// ---------------------------------------------------------------------------
{
  await call("/tags/settings", {
    method: "PUT", token: adminToken,
    body: { staffTapEnabled: true, staffNetworkCheck: true, allowedNetworks: ["203.0.113.0/24"] },
  });

  // Clear today's clock-in between attempts: a row that already has a timeIn short-
  // circuits to "already clocked in" BEFORE presence is consulted, which would make
  // every assertion below pass vacuously.
  const clearDay = () => db.checkIn.deleteMany({ where: { staffId: adminId } });

  await clearDay();
  const offNet = await call("/checkins/tap-check-in", {
    method: "POST", token: adminToken, from: "198.51.100.7", body: { tagCode },
  });
  check("a staff tap from off the college network is refused", offNet.status === 403 && offNet.body?.reason === "off_network", `${offNet.status} ${offNet.body?.reason}`);
  check("and nothing was written", (await db.checkIn.count({ where: { staffId: adminId } })) === 0);

  await clearDay();
  const onNet = await call("/checkins/tap-check-in", {
    method: "POST", token: adminToken, from: "203.0.113.9", body: { tagCode },
  });
  check("a staff tap from the college network is accepted", onNet.status === 200, `${onNet.status}`);

  // THE ONE THAT MATTERS MOST.
  await clearDay();
  const onlineOffNet = await call("/checkins/check-in", {
    method: "POST", token: adminToken, from: "198.51.100.7", body: { site: "Online" },
  });
  check("Online is never refused by the network check", onlineOffNet.status === 201 || onlineOffNet.status === 200, `${onlineOffNet.status}`);

  // An empty list while the check is ON must refuse everybody — but the save route now
  // refuses to reach that state at all, which is the assertion.
  const emptied = await call("/tags/settings", {
    method: "PUT", token: adminToken, body: { staffNetworkCheck: true, allowedNetworks: [] },
  });
  check("requiring the college network with no ranges is refused at the API", emptied.status === 400 && emptied.body?.reason === "networks_required", `${emptied.status} ${emptied.body?.reason}`);

  // --- the geofence ---
  await call("/tags/settings", {
    method: "PUT", token: adminToken,
    body: { staffNetworkCheck: false, staffGeofenceCheck: true, geofenceRadiusM: 250 },
  });

  const campus = await db.campus.findFirst({ where: { active: true } });
  await db.campus.update({ where: { id: campus.id }, data: { latitude: 51.5007, longitude: -0.1246, locatedAt: new Date(), locatedBy: "smoke" } });

  await clearDay();
  const noPos = await call("/checkins/tap-check-in", { method: "POST", token: adminToken, body: { tagCode } });
  check("a staff tap with no position is refused, not waved through", noPos.status === 403 && noPos.body?.reason === "position_missing", `${noPos.status} ${noPos.body?.reason}`);

  await clearDay();
  const farAway = await call("/checkins/tap-check-in", {
    method: "POST", token: adminToken,
    body: { tagCode, position: { latitude: 53.4808, longitude: -2.2426, accuracy: 20 } },
  });
  check("a staff tap from another city is refused", farAway.status === 403 && farAway.body?.reason === "off_campus", `${farAway.status} ${farAway.body?.reason}`);

  await clearDay();
  const vague = await call("/checkins/tap-check-in", {
    method: "POST", token: adminToken,
    body: { tagCode, position: { latitude: 51.5007, longitude: -0.1246, accuracy: 4000 } },
  });
  check("a position too vague to mean anything is refused even though it contains the campus",
    vague.status === 403 && vague.body?.reason === "accuracy_too_poor", `${vague.status} ${vague.body?.reason}`);

  await clearDay();
  const atCampus = await call("/checkins/tap-check-in", {
    method: "POST", token: adminToken,
    body: { tagCode, position: { latitude: 51.5007, longitude: -0.1246, accuracy: 15 } },
  });
  check("a staff tap at the campus is accepted", atCampus.status === 200, `${atCampus.status}`);

  // Already clocked in WINS over presence — deliberately, and differently from students.
  // A re-tap writes nothing, so there is nothing to protect, and refusing a no-op teaches
  // people the feature is flaky.
  const reTap = await call("/checkins/tap-check-in", {
    method: "POST", token: adminToken,
    body: { tagCode, position: { latitude: 53.4808, longitude: -2.2426, accuracy: 20 } },
  });
  check("an already-clocked-in re-tap from off campus says so rather than refusing",
    reTap.status === 200 && reTap.body?.alreadyCheckedIn === true, `${reTap.status}`);

  // THE HOLE THAT EXISTED BEFORE THIS WORK: no site at all skipped every gate.
  await clearDay();
  const noSite = await call("/checkins/check-in", { method: "POST", token: adminToken, body: {} });
  check("a self check-in with no site is refused", noSite.status === 400, `${noSite.status}`);

  // CHECK-OUT IS NOT GATED, and this asserts a DELIBERATE non-change so that nobody
  // "completes" the feature later by adding one. Requiring proof of presence to clock OUT
  // strands anyone who has already left the building, with no way to fix it from the app.
  const row = await db.checkIn.findFirst({ where: { staffId: adminId } });
  const outFromAnywhere = await call(`/checkins/${row.id}/check-out`, {
    method: "POST", token: adminToken, from: "198.51.100.7",
  });
  check("clocking out from off campus is never refused", outFromAnywhere.status === 200, `${outFromAnywhere.status}`);

  // Both off restores today's behaviour exactly.
  await call("/tags/settings", { method: "PUT", token: adminToken, body: { staffNetworkCheck: false, staffGeofenceCheck: false } });
  await clearDay();
  const plain = await call("/checkins/tap-check-in", { method: "POST", token: adminToken, from: "198.51.100.7", body: { tagCode } });
  check("with both checks off, a staff tap from anywhere is accepted as before", plain.status === 200, `${plain.status}`);
}
```

Confirm the names `adminToken`, `adminId` and `tagCode` match the identifiers in scope at that point in the suite; rename to whatever the surrounding code uses.

- [ ] **Step 2: Run the suite to verify the new assertions fail**

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- smoke-nfc-tap
```

Expected: FAIL — the refusal assertions report `200` because no check exists yet.

- [ ] **Step 3: Add the gate to `routes/checkins.js`**

Add to the requires:

```js
const { checkPresence } = require("../presence");
const { campusesFor } = require("../campuses");
```

Then, above `POST /check-in`:

```js
// A member of staff's half of a presence refusal, in words they can act on.
//
// ITS OWN MAP, not the student one from routes/student.js, and the difference is the last
// clause of every line: a member of staff always has an honest alternative — Online —
// and a student does not. Telling somebody what to do instead is the difference between
// a refusal they can resolve standing there and one that sends them to a manager.
//
// The two CONFIGURATION failures deliberately read identically to the ordinary ones. A
// member of staff cannot tell the difference and there is nothing for them to do about
// it; the distinct `reason` beside it is for the log and the settings screen.
const STAFF_PLACE_REFUSALS = {
  off_network: "You're not on the college network. Choose Online if you're working remotely.",
  network_not_configured: "You're not on the college network. Choose Online if you're working remotely.",
  off_campus: "You're not at a campus. Choose Online if you're working remotely.",
  campus_not_located: "You're not at a campus. Choose Online if you're working remotely.",
  position_missing: "Turn on location so we can check you're at the college, then try again.",
  accuracy_unknown: "We couldn't get an accurate location. Try again near a window, or choose Online.",
  accuracy_too_poor: "We couldn't get an accurate location. Try again near a window, or choose Online.",
  default: "We couldn't check you're at the college. Choose Online if you're working remotely.",
};

/**
 * Is this staff clock-in allowed to happen where it is happening? Answers `true` when it
 * has ALREADY refused the request.
 *
 * ONLY EVER CALLED FOR ONSITE. Online is never checked under any setting: somebody
 * working from home is by definition off the college network and away from every campus,
 * so a rule that caught them would leave the truthful answer unrecordable. That is why
 * the caller gates on `site`, not on the route.
 *
 * TRANSLATES the staff switches into the shape presence.js expects rather than teaching
 * presence.js about staff. The engine asks "is this device in the building" and has no
 * business knowing who is holding it — and keeping it that way is what lets it stay pure,
 * database-free and tested without either audience.
 *
 * `campusesFor(null)` — every located campus — because a clock-in is for a DAY, not a
 * class. There is no room to narrow to, and "is this person at the college" is the honest
 * question anyway.
 *
 * @param {string} method  "nfc" when a sticker was involved, "button" when not. NEVER
 *   null: the schema defines a null `method` as "row written before the column existed",
 *   so a fresh refusal writing null would read back as pre-feature history.
 */
async function refusedForStaffPlace(req, res, settings, method) {
  if (settings.staffNetworkCheck !== true && settings.staffGeofenceCheck !== true) return false;

  const verdict = checkPresence({
    ip: req.ip,
    // The phone's READING, never its opinion of whether that is close enough. A client
    // that sent "I am in range" would be sending a value anybody can send.
    position: req.body?.position,
    campuses: settings.staffGeofenceCheck === true ? await campusesFor(null) : [],
    settings: {
      networkCheck: settings.staffNetworkCheck,
      geofenceCheck: settings.staffGeofenceCheck,
      allowedNetworks: settings.allowedNetworks,
      geofenceRadiusM: settings.geofenceRadiusM,
    },
  });
  if (verdict.ok) return false;

  // EVERY failure is logged, not only the one reported. A college switching this on for
  // the first time wants to see that its IP list is wrong AND its coordinates are, rather
  // than discovering the second a week after fixing the first.
  for (const f of verdict.failures) {
    try {
      await prisma.tagTap.create({
        data: { staffId: req.user.id, method, outcome: f.reason, site: "Onsite", ip: req.ip ? String(req.ip).slice(0, 60) : null },
      });
    } catch (e) { console.error("[tap] could not log a staff presence refusal:", e.message); }
  }

  const first = verdict.failures[0];
  // A misconfiguration is the operator's problem and it is INVISIBLE from the outside:
  // every member of staff is refused while the settings screen says the rule is enforced.
  // So it is said out loud where somebody reading the service's output will meet it.
  if (first.reason === "network_not_configured") {
    console.error("[presence] the staff network check is ON but no usable IP range is saved — every staff clock-in is being refused");
  }
  if (first.reason === "campus_not_located") {
    console.error("[presence] the staff geofence is ON but no active campus has coordinates — every staff clock-in is being refused");
  }

  // 403, not 409. Nothing is wrong with the clock-in itself; what is wrong is WHERE it
  // is being made, and the app shows a different thing for "not here" than for "not now".
  res.status(403).json({
    error: STAFF_PLACE_REFUSALS[first.reason] || STAFF_PLACE_REFUSALS.default,
    reason: first.reason,
  });
  return true;
}
```

- [ ] **Step 4: Require a site, and gate Onsite, in `POST /check-in`**

Replace the validation line in `POST /check-in`:

```js
  const site = req.body?.site;
  // A SITE IS REQUIRED HERE, even though `isSite` permits null — and that gap was a real
  // hole, not a theoretical one. `isSite` is `(v) => v == null || SITES.includes(v)`, so
  // an empty body passed validation, `site === "Onsite"` was false, the tap requirement
  // never fired, and a row was written with no site at all. This route's own comment
  // holds it to a higher standard: "anything that can be worked around by knowing the URL
  // is a convention, and a timesheet is not a good place for one."
  //
  // The ADMINISTRATOR's PUT / is untouched and still accepts null — filling in a missed
  // clock-in for somebody else is exactly what that route is for, and an administrator
  // often does not know where the person was.
  if (!isString(site) || !isSite(site)) return res.status(400).json({ error: "site must be Onsite or Online" });
```

Then, after the existing `tap_required` block:

```js
  // ONSITE ONLY. See refusedForStaffPlace: Online is never checked under any setting.
  // "button" rather than "nfc" — no sticker was involved in this route, and a log an
  // administrator reads to answer "why couldn't I clock in" must not describe a button
  // press as a tap.
  if (site === "Onsite" && await refusedForStaffPlace(req, res, tap, "button")) return;
```

Confirm `isString` is already imported in this file from `../validate`; add it if not.

- [ ] **Step 5: Gate the tap route**

In `POST /tap-check-in`, insert the presence check **after** the rate limit and **before** the tag lookup:

```js
  // AFTER the rate limit and BEFORE the tag lookup.
  //
  // After the rate limit, because probing these checks must be throttled exactly like
  // probing tag codes is — otherwise the cheapest thing on this route is the one with no
  // budget attached to it.
  //
  // Before the tag lookup, matching routes/student.js and for its stated reason: somebody
  // off the college network should be told THAT, not handed "tag not recognised" from a
  // check they were never going to get past.
  //
  // Always, with no `site` test, because a tap IS an onsite claim by construction — this
  // route does not accept a site and never has.
  if (await refusedForStaffPlace(req, res, settings, "nfc")) return;
```

**Then move the already-clocked-in short circuit ahead of it.** Load the row and return early before the presence call:

```js
  // ALREADY CLOCKED IN WINS OVER PRESENCE, and this ordering is deliberate rather than
  // accidental — it differs from the student path, where every method writes.
  //
  // A second tap on the way past the door writes NOTHING: the arrival time is already
  // recorded and re-tapping must never move it. There is therefore nothing to protect,
  // and answering "you're not at a campus" to a no-op teaches somebody the feature is
  // flaky — on the one screen they use every single morning.
  const existingToday = await prisma.checkIn.findUnique({ where: { staffId_date: { staffId: req.user.id, date: today() } } });
  if (existingToday && existingToday.timeIn) {
    return res.json({ ok: true, alreadyCheckedIn: true, ...sCheckin(existingToday) });
  }
```

Place this immediately after the rate-limit block and before the presence call. Remove the later duplicate `existing`/`already_checked_in` branch, or keep it reading from `existingToday` — but **do not leave two reads of the same row**, and keep the `logTap("already_checked_in", …)` call by moving it into the new branch (it needs `tag.id`, so if the tag is not yet resolved, log with `method: "nfc"` and no `tagId`, and say why in a comment).

- [ ] **Step 6: Run the suite to verify it passes**

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- smoke-nfc-tap
```

Expected: PASS, with a higher check count than before.

- [ ] **Step 7: Break each guard once to prove the suite catches it**

For each of `staffNetworkCheck`, `staffGeofenceCheck` and the site-required line: comment the guard out, re-run, confirm a specific assertion fails, restore it. A suite that passes with the rule deleted is not testing the rule.

- [ ] **Step 8: Commit**

```bash
git add server/src/routes/checkins.js scripts/smoke-nfc-tap.mjs
git commit -m "A staff clock-in has to happen where it says it happened"
```

---

### Task 4: The client can find out that it needs a position

**Files:**
- Modify: `server/src/routes/checkins.js:196-199` (`GET /tap-settings`)
- Modify: `client/src/api.js:209-213` (`positionIfNeeded`), `:681` (`checkIn`), `:684` (`tapCheckIn`)
- Test: `scripts/smoke-nfc-tap.mjs`

**Interfaces:**
- Consumes: `staffGeofenceCheck` (Task 1).
- Produces: `GET /api/checkins/tap-settings` gains `needsLocation: boolean`. `api.checkIn(site)` and `api.tapCheckIn(tagCode)` both send `position` when it is needed. `api.warmStaffPosition() -> Promise<void>` starts the lookup early without using its result. Task 6 relies on all three.

**Why this task exists at all:** without it every onsite clock-in is refused, 100% of the time. `positionIfNeeded()` resolves `needsLocation` from `GET /student/me/tap-context` — a student-only route. A staff caller gets 403, the `.catch(() => false)` answers `false`, no position is sent, and the server answers `position_missing`.

- [ ] **Step 1: Write the failing smoke assertion**

```js
  await call("/tags/settings", { method: "PUT", token: adminToken, body: { staffGeofenceCheck: true } });
  const ctx = await call("/checkins/tap-settings", { token: adminToken });
  check("staff are told when a position is needed", ctx.body?.needsLocation === true, JSON.stringify(ctx.body));

  await call("/tags/settings", { method: "PUT", token: adminToken, body: { staffGeofenceCheck: false } });
  const ctxOff = await call("/checkins/tap-settings", { token: adminToken });
  check("and told when it is not, so no permission is prompted for nothing", ctxOff.body?.needsLocation === false, JSON.stringify(ctxOff.body));
```

- [ ] **Step 2: Run to verify it fails**

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- smoke-nfc-tap
```

Expected: FAIL — `needsLocation` is `undefined`.

- [ ] **Step 3: Answer it from the staff-reachable route**

```js
router.get("/tap-settings", requireAuth, async (_req, res) => {
  const s = await tapConfig.get();
  // needsLocation IS ON THIS ROUTE because it is the only one an ordinary member of staff
  // can reach. The student app resolves the same question from /student/me/tap-context,
  // which is inside the student router's allowlist and 403s for a lecturer — so a staff
  // client asking there got `false`, sent no position, and was refused `position_missing`
  // on every single onsite clock-in. The feature would have appeared completely broken.
  //
  // Only the GEOFENCE needs it. The network check is observed from the far end of the
  // connection and asks nothing of the phone, so a college running that alone must never
  // trigger a location prompt — a permission request with no honest answer to "why does
  // this app want that" is the one thing this flag exists to avoid.
  res.json({ enabled: s.enabled, staffTapEnabled: s.staffTapEnabled, armSeconds: s.armSeconds, needsLocation: s.staffGeofenceCheck === true });
});
```

- [ ] **Step 4: Give the staff path its own resolver and cache key**

In `client/src/api.js`, beside the existing student resolver:

```js
// THE STAFF ANSWER, AND ITS OWN KEY. Deliberately not shared with the student flag above.
//
// A handset is not a person. A lecturer who is also studying, a shared demo phone, a
// parent and child on one device — in every case a cached "0" written by a student
// session would mean a member of staff silently never sends a position and is refused
// for ever, with nothing on any screen to explain why. Two questions, two answers, two
// keys.
//
// Cleared on sign-out (see clearSession below) for the same reason: the next person to
// sign in on this handset is not necessarily the last one.
const STAFF_NEEDS_LOCATION_KEY = "edtech.staffNeedsLocation";
let staffNeedsLocation = (() => {
  try {
    const v = localStorage.getItem(STAFF_NEEDS_LOCATION_KEY);
    return v === "1" ? true : v === "0" ? false : null;
  } catch (_) {
    return null;
  }
})();
let staffContextInFlight = null;

export function forgetNeedsLocation() {
  staffNeedsLocation = null;
  needsLocation = null;
  try {
    localStorage.removeItem(STAFF_NEEDS_LOCATION_KEY);
    localStorage.removeItem(NEEDS_LOCATION_KEY);
  } catch (_) { /* nothing to clear */ }
}

/**
 * `{ position }` to spread into a staff clock-in body, or `{}`.
 *
 * A FAILED LOOKUP ANSWERS FALSE, exactly as the student one does: if the settings route
 * cannot be reached the clock-in is about to fail for a larger reason, and prompting for
 * location because we could not find out whether it was needed is the permission request
 * with no honest explanation that this flag exists to avoid.
 */
async function staffPositionIfNeeded() {
  if (staffNeedsLocation === null) {
    if (!staffContextInFlight) {
      staffContextInFlight = request("/checkins/tap-settings")
        .then((s) => {
          staffNeedsLocation = s?.needsLocation === true;
          try { localStorage.setItem(STAFF_NEEDS_LOCATION_KEY, staffNeedsLocation ? "1" : "0"); } catch (_) { /* nothing to keep */ }
          return staffNeedsLocation;
        })
        .catch(() => false)
        .finally(() => { staffContextInFlight = null; });
    }
    await staffContextInFlight;
  }
  if (!staffNeedsLocation) return {};
  const position = await wherePhoneIs();
  return position ? { position } : {};
}
```

Change the `let needsLocation` declaration so it can be reassigned by `forgetNeedsLocation` (it already is a `let`).

Then add the warm-up that Task 6 calls when the popup opens:

```js
/**
 * Start the location lookup without waiting for it. Returns nothing useful on purpose.
 *
 * `wherePhoneIs()` accepts a fix up to a minute old (`maximumAge`), so a lookup started
 * when a popup opens is still valid by the time somebody has held their phone to a
 * sticker — and the second call resolves from the cached fix rather than acquiring a new
 * one. That is the whole trick: a cold indoor fix can take the full 15-second timeout
 * plus the 2-second backstop, and paying it BEFORE the tap is the difference between a
 * popup that feels instant and one that hangs at the worst possible moment.
 *
 * Silent when the geofence is off: staffPositionIfNeeded() returns {} without touching
 * the geolocation API, so nothing is prompted for a value the server will not look at.
 */
export function warmStaffPosition() {
  // Errors are swallowed because there is nothing to do with one — the real call makes
  // the same request again and the server decides what a missing position means.
  staffPositionIfNeeded().catch(() => {});
}
```

Expose it on the `api` object as `warmStaffPosition`.

- [ ] **Step 5: Send it from both staff calls**

```js
  // ONSITE ONLY. Asking the phone where it is in order to record "working from home" is
  // a permission prompt for a value the server will never look at.
  checkIn: async (site) => request("/checkins/check-in", {
    method: "POST",
    body: { site, ...(site === "Onsite" ? await staffPositionIfNeeded() : {}) },
  }),
  tapCheckIn: async (tagCode) => request("/checkins/tap-check-in", {
    method: "POST",
    body: { tagCode, ...(await staffPositionIfNeeded()) },
  }),
```

Note that `checkIn` no longer sends `{}` for a missing site — the server now requires one, and a client that could omit it was the route round the tap requirement.

- [ ] **Step 6: Clear both keys on sign-out**

Find where the client discards its session (the `logout` path reached from `App.jsx`) and call `forgetNeedsLocation()` there, with a one-line comment saying why: the next person to sign in on this handset is not necessarily the last one.

- [ ] **Step 7: Run the suite and the client build**

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- smoke-nfc-tap
npm run --workspace client build
```

Expected: suite PASSES; build succeeds.

- [ ] **Step 8: Commit**

```bash
git add server/src/routes/checkins.js client/src/api.js
git commit -m "Staff learn from their own route whether a clock-in needs a position"
```

---

### Task 5: Android is allowed to know where it is

**Files:**
- Modify: `client/android/app/src/main/AndroidManifest.xml` (beside the existing `uses-permission` block, ~line 74)

**Interfaces:** none. This is a native-configuration task.

**Why:** the manifest declares INTERNET, POST_NOTIFICATIONS, USE_BIOMETRIC, NFC and CAMERA — and no location permission. `wherePhoneIs()` calls `navigator.geolocation` inside the Capacitor WebView, which the OS refuses without one, so it resolves `null` and the server answers `position_missing`. **This is a pre-existing student bug, not a staff requirement:** the student geofence shipped in a state where, on Android, it can only ever refuse. It went unnoticed because the check defaults off and no college has switched it on.

- [ ] **Step 1: Declare the permission**

```xml
    <!-- WHERE THE PHONE IS, for the check-in geofence (student and staff alike).
         navigator.geolocation inside the Capacitor WebView is refused by the OS without
         this, silently: no error, no prompt, just a null position — which the server
         correctly reads as "we cannot tell" and refuses. The geofence has shipped since
         10 Sep 2026 in exactly that state on Android, invisible only because it defaults
         off and no college had switched it on.

         FINE, NOT COARSE, and this is the load-bearing half. With coarse alone, Android
         12 and later offer the user an "Approximate" toggle that returns roughly 1-3 km
         of accuracy — which presence.js refuses as `accuracy_too_poor`, correctly, since
         an error circle that large contains the campus from most of the city. The feature
         would ask for a permission, be granted it, and still refuse everybody: the worst
         of the three possible outcomes, because it looks configured.

         No <uses-feature> line accompanies it, DELIBERATELY. Declaring the NFC permission
         makes Google Play INFER a hardware requirement that defaults to REQUIRED, which
         is why the NFC block next door carries an explicit android:required="false".
         Location has no such inference, and adding a feature line would start excluding
         handsets from the store listing for a capability the app degrades gracefully
         without — with the geofence off, no position is ever requested. -->
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
```

- [ ] **Step 2: Sync the native project**

```bash
npm run --workspace client build
cd client && npx cap sync android
```

- [ ] **Step 3: Verify the permission reached the merged manifest**

```bash
grep -r "ACCESS_FINE_LOCATION" client/android/app/src/main/AndroidManifest.xml
```

Expected: the line is present. If a built/merged manifest exists under `client/android/app/build/`, check there too — that is what actually ships.

- [ ] **Step 4: Confirm iOS still needs nothing**

```bash
grep -n "NSLocation" client/ios/App/App/Info.plist
```

Expected: `NSLocationWhenInUseUsageDescription` is present. If it is, iOS is already correct and needs no change; record that in the commit message rather than adding a duplicate key.

- [ ] **Step 5: Commit**

```bash
git add client/android/app/src/main/AndroidManifest.xml client/android
git commit -m "Android is allowed to know where it is — the geofence could only ever refuse without it"
```

---

### Task 6: Two tabs, a grey button that turns blue, and a popup that checks

**Files:**
- Create: `client/src/staffCheckInView.js`, `client/src/staffCheckInView.test.js`
- Modify: `client/src/StaffHub.jsx` — `TapOnsiteSheet` (~line 1228) and `CheckInScreen` (~line 1324)

**Interfaces:**
- Consumes: `api.checkIn(site)`, `api.tapCheckIn(tagCode)` (Task 4); the refusal `reason` codes (Task 3).
- Produces: `checkInButton({ site, tapRequired, busy }) -> { label, enabled }` and `staffPlaceRefusal(reason) -> { heading, advice }`.

**Why a pure module:** the house convention is pure logic beside its tests, and `StaffHub.jsx` is over 14,000 lines — logic added inline there is untestable in practice. `qrResultView.js` and `checkInAction.js` are the precedents.

- [ ] **Step 1: Write the failing tests**

`client/src/staffCheckInView.test.js`:

```js
// The staff check-in screen's two decisions, without a browser: what the button says and
// whether it is live, and what a refused clock-in is told.
//
// Run with: node --test src/staffCheckInView.test.js   (from client/)
import test from "node:test";
import assert from "node:assert/strict";
import { checkInButton, staffPlaceRefusal } from "./staffCheckInView.js";

test("nothing chosen means a dead button", () => {
  // The whole point of the two-tab layout: the button is visibly not ready until a
  // decision has been made, rather than defaulting to one of the two answers.
  const b = checkInButton({ site: null, tapRequired: false, busy: false });
  assert.equal(b.enabled, false);
});

test("choosing Online arms the button", () => {
  const b = checkInButton({ site: "Online", tapRequired: false, busy: false });
  assert.equal(b.enabled, true);
  assert.equal(b.label, "Check in");
});

test("Onsite at a college with no stickers is an ordinary button", () => {
  // staffTapEnabled ships OFF and a college may never switch it on. There is then no
  // sticker to tap, so Onsite is a plain press — which still runs the network and
  // geofence checks server-side. A college can require proof of presence without buying
  // a single sticker.
  const b = checkInButton({ site: "Onsite", tapRequired: false, busy: false });
  assert.equal(b.enabled, true);
  assert.equal(b.label, "Check in");
});

test("Onsite where a sticker is required says so, and reopens the popup", () => {
  // Dismissing the popup must never strand somebody on a selected tab with an inert
  // button. The button becomes the way back in.
  const b = checkInButton({ site: "Onsite", tapRequired: true, busy: false });
  assert.equal(b.enabled, true);
  assert.equal(b.label, "Tap the sticker");
});

test("a clock-in in flight cannot be pressed twice", () => {
  const b = checkInButton({ site: "Online", tapRequired: false, busy: true });
  assert.equal(b.enabled, false);
});

test("every refusal a member of staff can be given offers them Online", () => {
  // The difference from the student vocabulary, and the reason the two cannot be shared:
  // a member of staff always has an honest alternative and a student does not.
  for (const reason of ["off_network", "network_not_configured", "off_campus", "campus_not_located"]) {
    const r = staffPlaceRefusal(reason);
    assert.match(`${r.heading} ${r.advice}`, /Online/, `${reason} should point at Online`);
  }
});

test("a location refusal tells them to fix the phone, not to give up", () => {
  const r = staffPlaceRefusal("position_missing");
  assert.match(r.advice, /location/i);
});

test("a reason this build has never heard of still says something true", () => {
  // A newer server, an older app. Silence here renders an empty red box.
  const r = staffPlaceRefusal("something_new_entirely");
  assert.ok(r.heading);
  assert.ok(r.advice);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd client && node --test src/staffCheckInView.test.js
```

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the module**

`client/src/staffCheckInView.js`:

```js
// The staff check-in screen's two decisions, pure.
//
// StaffHub.jsx is over fourteen thousand lines, and logic added inline there is
// untestable in practice — which is how a screen ends up with a button whose enabled
// state nobody can reason about. Same split as qrResultView.js and checkInAction.js.

/**
 * What the Check in button says, and whether it is live.
 *
 * THREE STATES, and the middle one is the one worth explaining. With no site chosen the
 * button is deliberately dead: the two-tab layout exists so that a clock-in is a decision
 * somebody made rather than whichever button their thumb landed on, and a button that
 * worked before a choice was made would undo that.
 *
 * When a sticker is required the button does NOT submit — it reopens the popup. Without
 * that, dismissing the popup left a selected tab and an inert button, with no way forward
 * and nothing on screen saying so.
 */
export function checkInButton({ site, tapRequired, busy }) {
  if (busy) return { label: "Checking you in…", enabled: false };
  if (site !== "Onsite" && site !== "Online") return { label: "Check in", enabled: false };
  if (site === "Onsite" && tapRequired) return { label: "Tap the sticker", enabled: true };
  return { label: "Check in", enabled: true };
}

// Keyed on the server's `reason`, never on its prose. The message is wording that changes
// for product reasons; the reason is an identifier that does not.
//
// EVERY ENTRY ENDS AT ONLINE except the location ones, and that is the difference from
// the student vocabulary in qrResultView.js: a member of staff refused for being off the
// network has an honest thing to record instead, and a student does not. Sharing one map
// would mean either telling students about an option they do not have, or leaving staff
// with a dead end they could have walked out of.
//
// The two CONFIGURATION failures read identically to the ordinary ones on purpose. A
// member of staff cannot tell "the college has not saved its IP ranges" from "you are not
// on the college network", and there is nothing they could do differently if they could.
const REFUSALS = {
  off_network: { heading: "You're not on the college network", advice: "Connect to the college WiFi and try again, or choose Online if you're working remotely." },
  network_not_configured: { heading: "You're not on the college network", advice: "Connect to the college WiFi and try again, or choose Online if you're working remotely." },
  off_campus: { heading: "You're not at a campus", advice: "Try again once you're on site, or choose Online if you're working remotely." },
  campus_not_located: { heading: "You're not at a campus", advice: "Try again once you're on site, or choose Online if you're working remotely." },
  position_missing: { heading: "Location is switched off", advice: "Turn location on for this app, then try again." },
  accuracy_unknown: { heading: "We couldn't pin down your location", advice: "Try again near a window, or choose Online if you're working remotely." },
  accuracy_too_poor: { heading: "We couldn't pin down your location", advice: "Try again near a window, or choose Online if you're working remotely." },
  tap_required: { heading: "Onsite clock-in is by sticker here", advice: "Tap the sticker in your building, or choose Online if you're working remotely." },
};

/**
 * A refused clock-in, in words.
 *
 * An unknown reason still answers something TRUE rather than nothing: a newer server and
 * an older app is an ordinary state of affairs for a packaged app that updates through a
 * store, and the alternative renders an empty red box.
 */
export function staffPlaceRefusal(reason) {
  return REFUSALS[reason] || {
    heading: "We couldn't check you're at the college",
    advice: "Try again, or choose Online if you're working remotely.",
  };
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd client && node --test src/staffCheckInView.test.js
```

Expected: PASS.

- [ ] **Step 5: Rewrite the check-in screen**

In `CheckInScreen` (`StaffHub.jsx`), replace the whole `{!checkedIn && (…)}` block. **Rewrite the 14 Sep "ONE TAP, EITHER WAY" comment rather than deleting it** — it must say what it used to say:

```jsx
        {/* TWO TABS, THEN A BUTTON — the ruling of 21 Sep 2026.
            
            THIS COMMENT USED TO SAY THE OPPOSITE, and that matters more than the markup
            below it. On 14 Sep the flow was deliberately collapsed to one tap on the
            instruction "on campus should be taken by NFC and online should be straight",
            because choose-then-confirm made the commonest action on this screen a
            two-step form. On 21 Sep the two steps were asked for back, in these words:
            "there will be two tabs on site and online, once user will choose online you
            need make the check in button blue as before it should be grey."
            
            Both were product decisions by the same person a week apart. Written down so
            that the next reader does not find the earlier reasoning, conclude the tabs
            were an accident, and tidy them away.
            
            The button is DEAD until a tab is chosen. That is the point of the layout: a
            clock-in should be a decision somebody made, not whichever button their thumb
            found. Its state comes from checkInButton(), which is pure and tested —
            StaffHub.jsx is too large for anything here to be reasoned about in place. */}
        {!checkedIn && (
          <div className="mt-5 text-left">
            <p className="mb-2 text-center text-xs font-bold uppercase tracking-wide text-slate-500">Where are you working today?</p>
            <div className="grid grid-cols-2 gap-2" role="tablist">
              {[
                { key: "Onsite", label: "On site", sub: "In the building", I: Building2 },
                { key: "Online", label: "Online", sub: "Working remotely", I: Wifi },
              ].map(({ key, label, sub, I }) => {
                const on = site === key;
                return (
                  <button key={key} role="tab" aria-selected={on}
                    onClick={() => { setSite(key); setPlaceError(null); if (key === "Onsite" && tapRequired) setTapOpen(true); }}
                    className={`press flex flex-col items-center gap-1.5 rounded-2xl py-4 ring-1 transition ${on ? "text-white shadow-md ring-transparent" : "bg-white text-slate-700 ring-slate-200 hover:shadow-md"}`}
                    style={on ? { background: NAVY } : undefined}>
                    <I size={20} />
                    <span className="text-sm font-extrabold">{label}</span>
                    <span className={`text-[10px] ${on ? "text-white/70" : "text-slate-500"}`}>{sub}</span>
                  </button>
                );
              })}
            </div>

            {placeError && (
              <div className="mt-3 rounded-xl bg-rose-50 p-3 text-center ring-1 ring-rose-100">
                <p className="text-[13px] font-bold text-rose-700">{placeError.heading}</p>
                <p className="mt-0.5 text-[11.5px] leading-snug text-rose-600">{placeError.advice}</p>
              </div>
            )}

            <button onClick={onCheckIn} disabled={!btn.enabled}
              className="press mt-3 flex w-full items-center justify-center gap-2 rounded-2xl py-4 text-[15px] font-extrabold text-white transition disabled:cursor-not-allowed"
              style={{ background: btn.enabled ? NAVY : "#cbd5e1" }}>
              {btn.label}
            </button>

            {tapOpen && <TapOnsiteSheet onClose={() => setTapOpen(false)} onDone={() => store.refresh()} />}
          </div>
        )}
```

With this state and handler above the `return`:

```jsx
  const [site, setSite] = useState(null);
  const [placeError, setPlaceError] = useState(null);
  const [busy, setBusy] = useState(false);
  const btn = checkInButton({ site, tapRequired, busy });

  // The button does three different things depending on where the person said they are,
  // and the third one is not a submit at all: where a sticker is required it REOPENS the
  // popup. Dismissing that popup previously left a selected tab and a button that did
  // nothing, with nothing on screen to say why.
  const onCheckIn = async () => {
    if (!btn.enabled) return;
    if (site === "Onsite" && tapRequired) { setTapOpen(true); return; }
    setBusy(true); setPlaceError(null);
    try {
      await api.checkIn(site);
      await store.refresh();
    } catch (e) {
      // A presence refusal is not a failure of the app and must not be shown as one —
      // it is a thing the person can act on, and the words come from the pure map.
      if (e?.reason) setPlaceError(staffPlaceRefusal(e.reason));
      else setPlaceError({ heading: "That didn't work", advice: e?.message || "Try again in a moment." });
    } finally {
      setBusy(false);
    }
  };
```

Import `checkInButton` and `staffPlaceRefusal` from `./staffCheckInView`. **Confirm that the client's `request()` helper puts the server's `reason` on the thrown error** — if it does not, add it there, because every refusal in this screen depends on it.

- [ ] **Step 6: Give the popup its checking phase, and start location early**

In `TapOnsiteSheet`, add a `position` request that begins when the sheet opens:

```jsx
  // THE LOCATION REQUEST STARTS NOW, in parallel with arming the reader — not after the
  // sticker is read.
  //
  // A cold fix indoors can take the full 15-second timeout plus the 2-second backstop
  // (wherePhoneIs.js). Asking for it AFTER the tap leaves somebody holding a phone flat
  // against a wall watching a spinner, at the exact moment they are most likely to
  // conclude the feature does not work — and a feature people believe is broken gets
  // switched off whether or not it is.
  //
  // Starting it here costs nothing when the geofence is off: staffPositionIfNeeded()
  // resolves to {} without ever touching the geolocation API, so no permission is
  // prompted for a value the server will not look at.
  useEffect(() => { api.warmStaffPosition(); }, []);
```

Add a `"checking"` phase between the read and the answer, rendered as:

```jsx
          <div className="py-4 text-center">
            <span className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full ring-4 ring-blue-100" style={{ background: alpha(NAVY, 10) }}><Loader2 size={30} className="animate-spin" style={{ color: NAVY }} /></span>
            <p className="text-lg font-extrabold text-slate-800">Checking you're at the college…</p>
            <p className="mt-1 text-sm text-slate-500">This can take a few seconds indoors.</p>
          </div>
```

Set `setPhase("checking")` immediately after `scanOnce` resolves and before `api.tapCheckIn(code)`. On success the existing `done` phase already reads **"You're clocked in"** — change it to **"Checked in successfully"** to match the wording used elsewhere in the app (`Check-in card: every accepted P/L scan reads "Checked in successfully"`, commit `41e064e`). On a refusal carrying a `reason`, render `staffPlaceRefusal(reason)` in the error phase instead of the raw message.

**Do not call `wherePhoneIs()` directly from this component.** The "only ask when the geofence is on" rule lives in `staffPositionIfNeeded`, and a screen that reached past it would prompt for a permission the server is not going to use — the exact thing both app stores ask about at review.

**The desktop case needs no new branch.** Where a sticker is required, `nfcStatus()` already answers `reason: "web"` and this sheet already renders "Use the app to tap in". Where one is not, a desktop press of the blue button sends a WiFi-derived position, the server refuses it as `accuracy_too_poor`, and `staffPlaceRefusal` tells them to try near a window or choose Online. Both paths are honest and neither needs code here.

- [ ] **Step 7: Run the client tests and build**

```bash
cd client && node --test "src/**/*.test.js"
npm run --workspace client build
```

Expected: PASS, and the build succeeds.

- [ ] **Step 8: Commit**

```bash
git add client/src/staffCheckInView.js client/src/staffCheckInView.test.js client/src/StaffHub.jsx
git commit -m "Staff check-in: two tabs, a button that waits to be told, and a popup that checks"
```

---

### Task 7: The two checkboxes an administrator ticks

**Files:**
- Modify: `client/src/AdminNfcTags.jsx` — the "Staff clock-in" card (~line 283-299)

**Interfaces:**
- Consumes: `staffNetworkCheck` / `staffGeofenceCheck` (Task 1), and the `400 networks_required` refusal (Task 1).
- Produces: nothing other tasks read.

- [ ] **Step 1: Add the checkboxes beneath the staff NFC switch**

Inside the existing `Staff clock-in` block, after the `staffTapEnabled` label:

```jsx
        {/* THE SAME TWO QUESTIONS AS THE STUDENT SECTION ABOVE, ASKED OF STAFF — and
            separate switches, not that pair widened. The student ones are described on
            this very screen as not affecting staff, so teaching them to govern staff too
            would start refusing clock-ins at any college that ticked one for students,
            on a deploy nobody connected to the change.

            They SHARE the IP ranges and the radius above, which is why those are not
            repeated here: one college, one network, one set of campuses. Said out loud in
            the copy, because two identical-looking checkboxes that read a list defined
            somewhere else on the page is exactly the arrangement somebody misreads. */}
        <label className="mt-2 flex items-start gap-3 rounded-xl bg-slate-50 p-3.5">
          <input type="checkbox" checked={draft.staffNetworkCheck} disabled={saving}
            onChange={(e) => save({ staffNetworkCheck: e.target.checked })} className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <span className="block text-[13px] font-semibold text-slate-800">Onsite clock-in must come from the college network — {draft.staffNetworkCheck ? "ON" : "OFF"}</span>
            <span className="mt-0.5 block text-[11px] leading-snug text-slate-500">
              Uses the same IP ranges as the student check above. <strong>Online is never affected</strong> —
              somebody working from home cannot be on the college network, so checking it would make the
              honest answer unrecordable. A member of staff in the building on mobile data <em>is</em> refused,
              and their only route is Online, which records the wrong site: that is the cost of a rule with no
              exceptions, and it is worth knowing before you switch it on.
            </span>
          </span>
        </label>

        <label className="mt-2 flex items-start gap-3 rounded-xl bg-slate-50 p-3.5">
          <input type="checkbox" checked={draft.staffGeofenceCheck} disabled={saving}
            onChange={(e) => save({ staffGeofenceCheck: e.target.checked })} className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <span className="block text-[13px] font-semibold text-slate-800">Onsite clock-in must happen at a campus — {draft.staffGeofenceCheck ? "ON" : "OFF"}</span>
            <span className="mt-0.5 block text-[11px] leading-snug text-slate-500">
              Uses the same campus coordinates and radius as the student check above. Proves somebody was
              <strong> at the college</strong>, never which room or which desk. Staff clock in from the phone app —
              a desktop browser cannot give a location accurate enough to mean anything, so it is not offered one.
              Anyone who won't share their location is refused and told to choose Online.
            </span>
          </span>
        </label>
```

- [ ] **Step 2: Surface the save refusal**

Confirm the screen's `save()` shows a server error rather than swallowing it. If it does not, add a line so the `networks_required` message from Task 1 is rendered beside the checkbox — an administrator who ticks a box and sees the tick silently revert learns nothing.

- [ ] **Step 3: Build and check by eye**

```bash
npm run --workspace client build
```

Then open the Check-in settings page and confirm: both boxes render, both toggle, and ticking the network box with an empty IP list shows the refusal instead of appearing to save.

- [ ] **Step 4: Commit**

```bash
git add client/src/AdminNfcTags.jsx
git commit -m "Two checkboxes, and the cost of each said where the decision is made"
```

---

### Task 8: Say what is true, and what is still unproven

**Files:**
- Modify: `STATUS.md` (§3.9 area, the test-evidence table, and the known-gaps list)
- Modify: `client/src/AdminNfcTags.jsx` — the `staffTapEnabled` copy (~line 289-296)

- [ ] **Step 1: Correct the settings copy that describes the old flow**

The current `staffTapEnabled` description already says *"the button stays greyed until they choose Onsite or Online"* — written before 14 Sep collapsed the flow, and wrong for the screen as it has shipped since. Tasks 6 makes it true again. Re-read it and adjust only what is still inaccurate; do not rewrite text that has become correct.

- [ ] **Step 2: Add a STATUS section**

Record, in the file's own honest-map register:

- The staff presence checks: built, both defaulting off, proved by the smoke-suite check count this run actually printed (paste the figure, do not estimate it).
- **Never run against real NFC hardware.** §3.9 already says no physical tap has ever been performed, on any handset, against any sticker. That is still true, and this work does not change it.
- **Never run against a real GPS fix or a real college network.** Every geofence and network assertion in the suite is driven by a spoofed `X-Forwarded-For` and a position supplied in the request body. The device half — a permission prompt, a cold indoor fix, a phone on the college WiFi — has been reasoned about and never executed.
- The Android location permission: newly added, and the note that **the student geofence could never have worked on Android before it**.

- [ ] **Step 3: Run everything**

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test
cd server && node --test "src/**/*.test.js"
cd client && node --test "src/**/*.test.js"
```

Expected: all pass. Record the actual counts in STATUS — not estimates, and not a claim of passing without the output in front of you.

- [ ] **Step 4: Commit**

```bash
git add STATUS.md client/src/AdminNfcTags.jsx
git commit -m "What the staff presence work proves, and the two halves it does not"
```

---

## After the plan

**Not covered here, deliberately:**

- **A physical tap, a real GPS fix, and a phone on the college WiFi.** Everything above is the HTTP surface and pure logic. Proving the device half needs a handset, a written sticker, and standing inside a building — and it is the largest unproven claim in this feature either way.
- **The student side.** Students already have all three methods with presence applied. The only student-affecting change here is the Android permission, which their geofence has always needed.
- **Deploying.** `main` → staging and `production` → production both auto-deploy on push. This branch is neither. Merging is a separate decision.
