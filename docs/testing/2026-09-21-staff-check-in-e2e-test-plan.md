# Staff check-in: end-to-end, edge-case and stress test plan

**Written for:** whoever tests this feature — the developer running it locally, or a QA
reader who has never opened this codebase. Every command is copy-pasteable and every
expected result is stated, so a failure is unambiguous.

**Covers:** the staff clock-in journey from sign-in to clock-out, under all eight
combinations of the three switches, plus the refusals, the races and the limits.

---

## 0. Before you start — the two things that bite

**The database.** `DATABASE_URL` in `server/.env` points at a **live** database. Every
command below passes it inline instead. Never omit it.

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev"
```

**The port.** The smoke runner boots its own API on **4010**. Two runs at once silently
corrupt each other. Run one at a time, and if you also want the app running for the
browser pass, give that a different port (the app uses 4000).

---

## 1. What this feature actually is

A member of staff clocking in chooses **On site** or **Online**.

- **Online** is one button and is **never** checked. Somebody working from home is by
  definition off the college network and away from every campus; a rule that caught them
  would make the honest answer the unrecordable one.
- **On site** is checked, in up to three independent ways, each switched on separately by
  the college:

| Switch | What it requires | Where it's set |
| --- | --- | --- |
| `staffTapEnabled` | An NFC sticker must be tapped | Check-in settings → Staff clock-in |
| `staffNetworkCheck` | The request must arrive from a college IP range | same card |
| `staffGeofenceCheck` | The phone must report a position near a campus | same card |

All three default **off**. With all three off, behaviour is exactly what it was before
this work — a plain button that records a claim.

---

## 2. Setup

### 2.1 Database and seed

```bash
cd /c/Users/Lenovo/Documents/Edtech
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- smoke-nfc-tap
```

Running any suite once seeds the fixtures. Local admin afterwards is
`admin@edtech.co.uk` / `test-seed-password-2026`.

### 2.2 Running the app for the browser pass

```bash
# terminal 1
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" PORT=4000 node server/src/index.js
# terminal 2
cd client && npx vite --port 5173
```

`client/.env` already points at `:4000`.

### 2.3 Driving a browser

```bash
npm i --no-save playwright     # package only; package-lock untouched
```

Launch with `chromium.launch({ channel: "msedge" })` — Edge is installed, so no browser
download is needed. **Put the driver script inside the repo** (e.g. `./_walk.mjs`), not in
a temp directory: module resolution walks up from the script's own directory.

**The app opens on a landing page with role tiles.** Click **Admin Dashboard** (or the
staff tile) first — the email and password inputs do not exist until then. This blocks
every naive script.

---

## 3. The journey, as a person experiences it

### 3.1 Sign in

| Step | What happens | What to check |
| --- | --- | --- |
| Open the app | Landing page, role tiles | Tiles render; no login fields yet |
| Click the staff/admin tile | Email + password appear | Fields focusable |
| Sign in | Staff Hub loads | No console errors; the lazy `StaffHub` chunk downloads |
| Go to **Daily Check-In** | The clock-in screen | The live clock ticks; today's date is right |

**Edge case — a slow first load.** The API is on Render's free plan in production and cold
starts. Locally this won't reproduce; note it rather than chase it.

### 3.2 The check-in screen *(exists only after Task 6 lands)*

```
        Where are you working today?
   ┌──────────────────┬──────────────────┐
   │    On site       │     Online       │
   └──────────────────┴──────────────────┘
            [      Check in      ]
```

| # | Action | Expected |
| --- | --- | --- |
| A | Screen loads, nothing chosen | Button is **grey and disabled** |
| B | Choose **Online** | Button turns **blue**, enabled |
| C | Press it | Clocked in; card shows "● Checked In", time, "Online" |
| D | Choose **On site**, sticker required | Popup opens **immediately** — "Please tap the NFC sticker" |
| E | Dismiss the popup | Button reads **"Tap the sticker"** and reopens it — never an inert selected tab |
| F | Choose **On site**, no sticker required | Button turns blue; pressing it clocks in |
| G | Any refusal | Banner with a heading **and** advice, and every network/campus refusal ends "…or choose Online if you're working remotely" |
| H | On a desktop browser, On site + sticker required | Popup says "Use the app to tap in" |

### 3.3 Clock out

| Action | Expected |
| --- | --- |
| Press **Check Out** | Time recorded; "✓ Checked Out" |
| Press again | First check-out is final — no second write |
| Clock out from off-network / off-campus | **Always allowed.** Deliberately ungated — gating it would strand anyone who had already left the building |

### 3.4 Running the automated walkthrough

`_walk-staff-checkin.mjs`, at the **repo root**, drives sections 3.1–3.2 above end to end
in a real browser rather than over HTTP — the smoke suites in section 8 prove the API's
refusals; this proves the screen actually wires them up. It needs the same package §2.3
already covers:

```bash
npm i --no-save playwright     # package only; package-lock untouched
```

Launched with `chromium.launch({ channel: "msedge" })`, the same call §2.3 gives — Edge is
already installed on a dev machine, so this never triggers Playwright's own Chromium
download, which is the slow, occasionally-blocked step a bare `npx playwright install`
would otherwise cost.

**It lives at the repo root, not in a scratch or temp directory, because Playwright
resolves its own package by walking UP from the script's own directory looking for
`node_modules/playwright`.** A copy dropped anywhere outside this tree walks up through
directories that were never `npm i`'d and fails on a module-not-found error that has
nothing to do with the app under test — the exact mistake §2.3's warning above exists to
head off, and the one an earlier session actually made before noticing the script's own
location, not Playwright, was the problem.

```bash
node _walk-staff-checkin.mjs
# or, for a CI-style run with no visible browser window:
HEADLESS=1 node _walk-staff-checkin.mjs
```

It needs the app running per §2.2 (API on `:4000`, client on `:5173`), and — because a
successful check-in writes a real row for today that nothing in the script clears — it
should be run against a staff account that has not already clocked in today, or its
fresh-state assertions SKIP rather than false-pass. The script's own header comment
explains, section by section, which of the three switches in §4 each part of the
walkthrough needs live, since the script does not set them itself.

---

## 4. The configuration matrix — all eight combinations

Set switches via **Check-in settings → Staff clock-in**, or over HTTP:

```bash
curl -X PUT localhost:4000/api/tags/settings \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"staffTapEnabled":false,"staffNetworkCheck":true,"staffGeofenceCheck":false,"allowedNetworks":["203.0.113.0/24"]}'
```

| # | tap | network | geofence | Onsite route | Online |
| --- | --- | --- | --- | --- | --- |
| 1 | off | off | off | Plain button, no checks — **today's behaviour** | ✅ |
| 2 | **on** | off | off | Must tap a sticker | ✅ |
| 3 | off | **on** | off | Button, must be on college IP | ✅ |
| 4 | off | off | **on** | Button, must be at a campus | ✅ |
| 5 | **on** | **on** | off | Tap **and** college IP | ✅ |
| 6 | **on** | off | **on** | Tap **and** at a campus | ✅ |
| 7 | off | **on** | **on** | Button, IP **and** campus | ✅ |
| 8 | **on** | **on** | **on** | All three | ✅ |

**The single most important assertion in the whole plan:** Online is accepted in **all
eight** rows. If any combination refuses an Online clock-in, that is a release blocker —
it makes honest remote work unrecordable.

**Row 1 is the second most important:** with all three off, every response must be
byte-identical to pre-feature behaviour. That is what makes this safe to deploy before a
college opts in.

---

## 5. Every refusal, with its exact expected answer

`POST /api/checkins/check-in` (button) and `POST /api/checkins/tap-check-in` (sticker).

| Condition | Status | `reason` | Staff sees |
| --- | --- | --- | --- |
| Off the college network | 403 | `off_network` | "You're not on the college network. Choose Online if you're working remotely." |
| Network check on, **no IP ranges saved** | 403 | `network_not_configured` | Same wording — staff can't tell, and couldn't act on it anyway |
| Too far from any campus | 403 | `off_campus` | "You're not at a campus. Choose Online…" |
| Geofence on, **no campus has coordinates** | 403 | `campus_not_located` | Same wording |
| No position sent / location refused | 403 | `position_missing` | "Turn on location…, then try again." |
| Position has no accuracy figure | 403 | `accuracy_unknown` | "We couldn't get an accurate location…" |
| Accuracy worse than 250 m or worse than the radius | 403 | `accuracy_too_poor` | Same |
| Onsite by button while a sticker is required | 409 | `tap_required` | "Onsite clock-in is by sticker here…" |
| No `site` in the body | 400 | — | — |
| Unknown / retired sticker | 404 | — | "That tag isn't recognised." |
| 11th tap inside a minute | 429 | — | "Too many attempts…" |

**Two server-log alarms** (invisible to staff, deliberately — they can't act on either):

```
[presence] the staff network check is ON but no usable IP range is saved — every staff clock-in is being refused
[presence] the staff geofence is ON but no active campus has coordinates — every staff clock-in is being refused
```

Both must fire when **both** are misconfigured at once — that's the case the review caught
being swallowed.

---

## 6. Edge cases

### 6.1 Ordering — which refusal wins

| Situation | Expected | Why |
| --- | --- | --- |
| Off-network **and** unknown tag | `off_network`, not "tag not recognised" | Tell them the thing they can act on; they were never getting past the network check |
| **Already clocked in**, re-tap from off-campus | **200 `alreadyCheckedIn`**, not a refusal | A re-tap writes nothing. Refusing a no-op teaches people the feature is flaky |
| Already clocked in, re-**press** Onsite off-network | **200 idempotent** | Same rule, both routes — symmetric since Ruling R7 |
| Already clocked in **and** unknown code | **404** | Preserves the pre-feature 404 byte-for-byte |
| Summary-first row (`timeIn === ""`) off-network | **403** | That branch *writes*, so it stays behind the gate |

### 6.2 Data integrity

| Check | How | Expected |
| --- | --- | --- |
| A re-tap never moves the arrival time | Tap, wait, tap again; read `CheckIn.timeIn` | Unchanged — falsifying it would falsify hours on site |
| A later register save can't overwrite `checkedInAt` | Tap, then save a correction | Arrival time survives |
| Arrival time is recorded **to the second** | Read `timeIn` | Seconds present, not truncated to the minute |
| The tag log keeps `tagId` on a re-tap | `TagTap` where `outcome = already_checked_in` | `tagId` is the sticker's id, not null |
| A refusal is logged with the right method | `TagTap.method` | `"nfc"` from the tap route, `"button"` from the plain one — **never null** (null means "row predates the column") |
| **Every** failure is logged, not just the first | Misconfigure both, one attempt | Two `TagTap` rows |

### 6.3 Identity and device

| Check | Expected |
| --- | --- |
| Staff and student sign in on the same handset | Each gets its own `needsLocation` answer — separate localStorage keys *(Task 4)* |
| Sign out | Both cached answers cleared — the next person isn't the last one |
| Two staff accounts clock in from one device | Both recorded; `X-Device-Id` on each; **nothing is refused** — it's a trail, not an identity |
| Admin fixes a missed clock-in (`PUT /`) | Still accepts a **null** site, still ungated — that's what the route is for |

### 6.4 Time

| Check | Expected |
| --- | --- |
| Clock in just before midnight | Lands on the right date — `src/clock.js` pins the timezone; never the host clock |
| Clock in, clock out next day | Handled or refused clearly, not silently mis-dated |

### 6.5 Boundary values for the geofence

| Position | Radius | Expected |
| --- | --- | --- |
| Exactly at the campus, accuracy 15 m | 250 m | ✅ accepted |
| 249 m away, accuracy 15 m | 250 m | ✅ accepted |
| 251 m away, accuracy 15 m | 250 m | ❌ `off_campus` |
| At the campus, accuracy 4000 m | 250 m | ❌ `accuracy_too_poor` — an error circle that large contains the campus from most of the city |
| At the campus, accuracy 300 m | 250 m | ❌ accuracy worse than the radius |
| Latitude 0, longitude 0 | any | ❌ refused — that's the Gulf of Guinea, not a missing value |
| Radius set to 5 m | — | Clamped to the 50 m floor; a 5 m geofence refuses the person standing in the room |

---

## 7. Stress and concurrency

| # | Test | How | Expected |
| --- | --- | --- | --- |
| S1 | Rate limiter | 11 taps in under a minute, one account | 11th → **429**; limiter sits **ahead** of the presence check so probing costs budget |
| S2 | Limiter is per-account | Account A exhausts it; account B taps | B unaffected |
| S3 | Double-submit race | Two simultaneous `check-in` calls, same staff, same day | Exactly **one** row — `@@unique([staffId, date])` plus `upsert`, not a check-then-create |
| S4 | Tap + button race | Both at once | One row; arrival time written once |
| S5 | Concurrent re-taps | Two taps against a `timeIn === ""` sentinel | `updateMany` with `timeIn: ""` in the WHERE — the database settles it; the second matches nothing |
| S6 | Many staff at 09:00 | 50 concurrent clock-ins, distinct accounts | All succeed; no cross-contamination |
| S7 | Settings changed mid-flight | Flip a switch while calls are in progress | Short settings cache; no 500s |
| S8 | Presence probing | Repeated refusals | Throttled by the same limiter; every refusal logged |

**S3–S5 are the ones worth writing carefully.** The guards they test are *structural* —
a unique constraint and a conditional update — rather than a check somebody could forget.
A test that passes because the two requests didn't actually overlap proves nothing, so
fire them with `Promise.all`, not in sequence.

### 7.1 Running the automated stress script

All eight rows above (S1–S8) are automated in `scripts/stress-staff-checkin.mjs`, which
fires its races with `Promise.all` and asserts the database state afterwards, not just
the HTTP status — see the file's own header for why that distinction matters for S3–S5
specifically.

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" \
API_URL="http://localhost:4000/api" node scripts/stress-staff-checkin.mjs
```

**Unlike `npm test`, this script does not boot an API of its own.** Start one first
(section 2.2 above — `PORT=4000 node server/src/index.js` against the same
`DATABASE_URL`), then point `API_URL` at it. It also expects the database to already be
seeded — run any suite once first (e.g. `npm test -- smoke-nfc-tap`) if `edtech_dev` is
fresh, so that `admin@edtech.co.uk` exists to sign in as.

**It must not run at the same time as a smoke suite, or a second copy of itself.** It
never binds a port, so that isn't the hazard here — the hazard is the same shared state
`npm test`'s own suites share: it flips the college-wide tap/geofence/network settings
through the real `PUT /tags/settings` and briefly pins real coordinates onto a real
campus (S8), reverting both in its `cleanup()`. A concurrent run, or a concurrent smoke
suite reading either of those, would see a setting or a coordinate that belongs to
whichever run's fixtures happen to be live at that instant, not to its own.

---

## 8. Running the automated suites

```bash
cd /c/Users/Lenovo/Documents/Edtech

# the staff check-in suite — refusal-weighted, this feature's main proof
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- smoke-nfc-tap

# the sibling suite, to prove the geofence fixture didn't leak
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- smoke-qr-checkin

# unit tests — use the GLOB, not a bare directory
cd server && node --test "src/**/*.test.js"

# everything
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test
```

> `node --test src/` walks into `src/index.js`, binds a port, starts the schedulers and
> **never terminates**. Always use the glob.

**Current baselines** (a different number means something moved — find out what):

| Suite | Checks |
| --- | --- |
| `smoke-nfc-tap` | **221** |
| `smoke-qr-checkin` | **168** |
| Server unit tests | **1750** |

### 8.1 The test that tests the tests

A suite that still passes with the rule deleted is not testing the rule. For each guard:
comment it out, re-run, confirm a **named** assertion goes red, restore it.

Guards worth breaking: the network translation, the geofence translation, the
`site`-required line, the Online exemption, and the `tagId` on the re-tap log row.

---

## 9. What this plan cannot prove

Stated plainly, because a college may be asked at a funding audit and because
`STATUS.md` is maintained as the honest map.

| Unproven | Why |
| --- | --- |
| **A physical NFC tap** | Has never been performed, on any handset, against any sticker. Everything above is the HTTP surface and pure logic |
| **A real GPS fix** | Every geofence assertion supplies a position in the request body. A cold indoor fix, a permission prompt, a refused permission — none executed |
| **A real college network** | Every network assertion spoofs `X-Forwarded-For`, which works in the suite only because there's no proxy in front. In production Render's proxy is the trusted hop |
| **The Android permission** | Added to the manifest, `cap sync`'d — but the merged manifest only regenerates on a real Gradle build, and no APK has been installed |
| **iOS** | Not built or run |

And what the feature itself can't prove even when working: the network check proves the
request reached us from an address the college says is theirs — not which room, and a VPN
defeats it. The geofence proves a *reported* position near a campus — indoor GPS is
10–50 m and worse through concrete, so it can never prove which room. The sticker proves
somebody was at that wall once with this account signed in; the code is static, so a
member of staff who notes it down can tap from home.

None of the three is proof. Together they are a good deal more than a login on a phone,
which is all that stood behind a staff clock-in before.
