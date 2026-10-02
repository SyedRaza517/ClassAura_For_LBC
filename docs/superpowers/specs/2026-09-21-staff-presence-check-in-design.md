# Staff check-in: two tabs, a sticker, and proof the phone is in the building — design

**Date:** 21 September 2026
**Supersedes, in part:** the "ONE TAP, EITHER WAY" ruling of 14 Sep 2026 (`StaffHub.jsx`,
commits `addf9be` and `e1a6761`). See "A reversal, recorded" below — that ruling is being
deliberately undone, and the comment in the code that states it must be rewritten rather
than left to contradict the screen.
**Builds on:** `2026-09-10-presence-verification-design.md`, which built the engine this
design finally points at staff.

## What this is

A member of staff clocking in picks **On site** or **Online** from two tabs. Online is one
button and no checks. On site opens a popup, reads an NFC sticker, and — before the
clock-in is written — establishes that the phone is on the college network and at a
campus. All three have to hold, or nothing is written.

## What was already built, because this spec exists to correct a premise

The work began as "develop the NFC functionality for staff". Almost all of it was already
there, and recording that here is the point of this section: a plan written without it
would have rebuilt a working feature and reported it as new.

| Piece | Where | State |
| --- | --- | --- |
| Staff On site → tap popup → automatic clock-in | `TapOnsiteSheet`, `StaffHub.jsx` | Built 14 Sep |
| Staff Online → one button | `StaffHub.jsx` | Built |
| Server refuses an Onsite clock-in without a tap | `routes/checkins.js`, `reason: "tap_required"` | Built |
| Staff sticker route, rate-limited, logged | `POST /api/checkins/tap-check-in` | Built |
| The network and geofence engine | `presence.js` — pure, tested | Built 10 Sep |
| Both checkboxes, the CIDR list, the radius | `AdminNfcTags.jsx` | Built |
| **Any of it applied to a staff clock-in** | — | **Never. `checkPresence` is called from `routes/student.js` and nowhere else** |

So the engine exists and the screen exists; the staff routes simply never ask. That is the
gap this design fills, plus the flow change described next.

## A reversal, recorded

On 14 Sep the two-step "choose a site, then confirm" was deliberately collapsed into one
tap, on the instruction *"on campus should be taken by NFC and online should be
straight."* The comment in `StaffHub.jsx` says so in those words.

On 21 Sep the opposite was asked for: two tabs, then a Check in button. That is a product
decision reversing a product decision, and both were made by the same person a week apart.
It is written down here so that the next reader does not find the 14 Sep comment, conclude
the tabs were an accident, and "tidy" them away — which is exactly the failure mode this
codebase's convention about correcting rules in place exists to prevent.

The 14 Sep comment must be **rewritten**, not deleted, and must say what it used to say.

## The flow

```
        Where are you working today?
   +------------------+------------------+
   |    On site       |     Online       |
   +------------------+------------------+
            [      Check in      ]
```

- **Nothing chosen** — the button is grey and disabled.
- **Online** — the button turns blue. Pressing it clocks the person in. No network check,
  no geofence, ever.
- **On site** — the popup opens immediately on selection. It arms the NFC reader and, in
  parallel, asks the phone where it is. The sticker read submits; the server checks the
  network and the campus; the popup reports **"Checked in successfully"** or says which
  check failed and offers Online as the way out.
- If the popup is dismissed, the blue button reads **"Tap the sticker"** and reopens it.
  There is never a selected tab with an inert button.

### On site at a college with no stickers

`staffTapEnabled` defaults **off**, and a college may never switch it on. There is then no
sticker to tap, so On site does not open the popup: the button turns blue, and pressing it
sends `POST /check-in` with `site: "Onsite"` — which still runs the network and geofence
checks if they are on.

This is the case `method: "button"` exists for in the tap log, and it is worth stating
plainly because it is the configuration most colleges will be in on day one: **a college
can require proof of presence without buying a single sticker.** The three checks are
independent, and any combination of the three switches is a valid college.

All three off is today's behaviour exactly — a plain button that records a claim — which
is what makes this safe to deploy before anybody switches anything on.

## Decisions taken

**Online is never checked, under any setting.** A person working from home is by
definition off the college network and away from every campus. Checking Online would refuse
every honest remote clock-in and leave the truthful answer unrecordable — the same
reasoning already written above the `tap_required` gate, which is why that gate keys on
`site` rather than on the route. This is the single most important rule here and the smoke
suite asserts it under every combination of settings.

**Two new switches, not the student pair widened.** `staffNetworkCheck` and
`staffGeofenceCheck`, both defaulting `false`.

Reusing `networkCheck` / `geofenceCheck` was rejected. They are labelled on the settings
screen as applying to students — *"It does not affect a lecturer taking the register"* —
so widening them would mean any college that ticked one for students starts refusing staff
clock-ins on the next deploy, a change nobody made and nothing on screen announces. That is
the precise failure this codebase keeps legislating against.

**But they share `allowedNetworks` and `geofenceRadiusM`.** One college, one network, one
set of campuses. Two lists that had to be kept in sync would drift, and the drift would
present as "check-in stopped working for staff only", which nobody would connect to a
settings screen they edited a month earlier.

**Onsite is phone-only.** Staff clock in from the Android or iOS app. A desktop browser
cannot read a sticker (`nfcStatus()` answers `reason: "web"`) and its WiFi-derived position
is routinely accurate to kilometres, which `presence.js` correctly refuses. So the popup on
desktop says to use the app, and there is no desktop On site route.

Rejected: letting desktop clock in unverified, which would be a documented way round the
whole feature — open a browser instead of the app and the checks disappear. Also rejected:
a looser accuracy ceiling for desktop, because a fix good to 20 km that happens to contain
the campus is not evidence, and accepting it would leave the college believing it has a
boundary it does not have.

**Presence is checked before the tag is resolved.** Matching `routes/student.js` and for
its stated reason: somebody off the college network should be told that, not handed "tag
not recognised" from a check they were never going to get past.

**Except that "already clocked in" wins over presence.** A second tap on the way past the
door writes nothing, so there is nothing to protect, and answering "you're off campus" to a
no-op teaches people the feature is flaky. This deliberately differs from the student path,
where every method writes. Recorded because the difference looks like an oversight.

**Check-out stays ungated, on purpose.** Requiring proof of presence to clock *out* strands
anyone who has already left the building, and the failure is unrecoverable from the app.
The cost is accepted: hours-on-site is provable at one end, not both.

**A self check-in must name a site.** `isSite` accepts `null` (`v == null || ...`), so
`POST /check-in` with an empty body passes validation today, skips the `tap_required` gate
entirely, and writes a row with `site: null`. Gating presence on `site === "Onsite"` would
inherit that hole exactly. The route's own comment holds it to a higher standard —
*"anything that can be worked around by knowing the URL is a convention, and a timesheet is
not a good place for one"* — so the self route requires a site. The administrator's
`PUT /` keeps accepting null: fixing a missed clock-in is what it is for.

**Staff in the building on mobile data are refused.** A phone tethered or on 4G inside the
college is off the college network as the server observes it, and its only honest route is
Online, which records the wrong site. Accepted rather than worked around: a network check
with a documented exception is not a network check. The settings copy has to say it, so the
college chooses it knowingly.

## What has to be fixed for this to work at all

**Android has no location permission.** The manifest declares INTERNET,
POST_NOTIFICATIONS, USE_BIOMETRIC, NFC and CAMERA. `wherePhoneIs()` calls
`navigator.geolocation` inside the Capacitor WebView, which the OS refuses without one, so
it resolves `null` and the server answers `position_missing`.

This is not a new problem introduced by staff work. **The student geofence shipped in a
state where, on Android, it can only ever refuse** — and nobody noticed because the check
defaults off and no college has switched it on. It needs `ACCESS_FINE_LOCATION`, a
`cap sync`, and a new native build.

`ACCESS_FINE_LOCATION` specifically, not coarse: with coarse alone, Android 12 and later
offer the user an "approximate" toggle that returns roughly 1–3 km accuracy, which
`presence.js` refuses as `accuracy_too_poor`. The feature would appear to work, ask for a
permission, receive it, and still refuse everybody.

iOS is already correct — `NSLocationWhenInUseUsageDescription` is present.

**The client asks a student-only route whether it needs a position.** `positionIfNeeded()`
resolves `needsLocation` from `GET /student/me/tap-context`. A staff caller gets 403, the
catch answers `false`, no position is sent, and every onsite clock-in is refused with
`position_missing`. `GET /api/checkins/tap-settings` — already `requireAuth`-only and
already read by the staff screen — answers `needsLocation` instead, and the staff path gets
its own resolver.

**Its cache needs its own key, cleared on sign-out.** The answer lives in `localStorage`
under `edtech.needsLocation`. Staff and students share handsets; a cached `"0"` from a
student session would mean a staff member silently never sends a position and is refused
for ever, with nothing on any screen to explain it.

## The pieces

**`presence.js` is not changed.** It is pure, it is tested, and it already takes exactly
the arguments a staff clock-in has. It gets called, not modified.

**`campusesFor` is lifted out of `routes/student.js`** into a module both routers import.
Staff pass no session, so they need its "every located campus" branch. Copying it was
rejected on this codebase's own evidence: six handlers independently grew an answer to "who
is on this register", disagreed, and were fixed six separate times — once in a handler that
marked students absent, where the wrong answer wrote wrong data.

**`routes/checkins.js`** gains the gate on both routes: `POST /check-in` when
`site === "Onsite"`, and `POST /tap-check-in` always, because a tap is an onsite claim by
construction. Order on the tap route: feature switch, tag code present, rate limit,
**already-clocked-in** (which still resolves the tag, purely so the log can carry it),
**presence**, tag lookup, write. Already-clocked-in sits ahead of presence on purpose — see
"Except that already clocked in wins over presence" below, which this line has to agree
with rather than restate a different order — and the rate limit stays ahead of both so that
probing the checks is throttled like everything else.

**Every refusal is logged to `TagTap`** with `staffId` and the failing reason, as the
existing staff refusals already are — and `method: "button"`, a new token, for a refusal on
the plain On site button where no sticker was involved. `null` cannot be reused: the schema
defines it as "row from before the column existed", so a fresh refusal writing null would
read as pre-feature history.

**`attendanceTapSettings.js`** gains the two booleans in `DEFAULTS`, merged with the same
strict `=== true || === false` comparison the other switches use, and allowlisted out.
Saving `staffNetworkCheck: true` with an empty `allowedNetworks` is refused at the API, not
merely warned about on screen — the alternative is an administrator who ticks a box, sees
no error, and locks out every member of staff while the screen says the network is
enforced.

**`AdminNfcTags.jsx`** grows the two checkboxes beside the existing staff NFC switch, with
the shared IP list and radius shown under them so it is visible that they are shared.

**`StaffHub.jsx`** gets the tabs, the grey-to-blue button, and a `TapOnsiteSheet` extended
with a "checking you're at the college" phase. The location request starts when the popup
opens, in parallel with arming the reader — a cold indoor fix can take the full 15-second
timeout plus the 2-second backstop, and asking for it *after* the sticker is read leaves
somebody holding a phone against a wall watching a spinner, which is how a feature gets
called broken and switched off.

**Staff refusal wording is its own map**, not shared with `qrResultView.js`. Every staff
refusal ends with the escape hatch — *"Choose Online if you are working remotely"* — which
is a route students do not have, so the two vocabularies cannot be one.

## Testing

Refusal-weighted, per the house convention: the valuable assertions are the ones that show
what is turned away.

- **Online is never refused**, under every combination of the two switches. The most
  important assertion in the suite.
- Staff tap off-network refused; off-campus refused; no position refused; accuracy too poor
  refused; campus not located refused — each with its own reason, each logged.
- Both switches off → behaviour byte-for-byte as today. This is what makes the change safe
  to deploy before any college switches it on.
- `POST /check-in` with no `site` is refused, and the administrator's `PUT /` with a null
  site still succeeds.
- An already-clocked-in re-tap from off-campus answers "already clocked in", not a refusal.
- The settings pair: merge, validate, allowlist, and the empty-list save guard.

`presence.test.js` is untouched — the engine's own behaviour is already covered.

## What this can and cannot prove

Unchanged from the 10 September design, and it has to stay said out loud because a college
will be asked at a funding audit:

The network check proves the request reached the server from an address the college says is
theirs. It does not prove which room, and a VPN defeats it. The geofence proves the device
reported a position within a radius of a campus; indoor GPS is 10–50 metres and worse
through concrete, so it can never prove which room. The sticker proves somebody was at that
wall once, with this account signed in — the code is static, so a member of staff who notes
it down can tap from home.

None of the three is proof. Together they are a good deal more than a login on a phone,
which is all that stood behind a staff clock-in before.

## Not in scope

The student side. Students already have all three methods with presence applied; the only
student-affecting change here is the Android location permission, which their geofence
needs too and has never had. A separate piece of work if anything more is wanted there.
