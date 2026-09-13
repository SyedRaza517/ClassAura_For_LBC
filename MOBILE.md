# Staff Hub — mobile app (iOS & Android)

The staff app is packaged for the stores with **Capacitor**: the same React code you
already have runs inside a native iOS/Android shell, so there is one codebase, not
three. This file covers what's done, how to run it, and what still has to happen
before either store will accept it.

---

## What changed to make it a real mobile app

| Before | Now |
|---|---|
| A drawn phone (frame, notch, fake clock and battery) shown *inside* the real phone | Full-screen app on a handset; the decorative phone is kept **only** on desktop, where it's a useful demo |
| Fixed 390×820px — clipped on an iPhone SE, 201px of stray scrolling | Fills the device, no page scrolling, no horizontal overflow on any size tested |
| No notch/home-indicator handling | `viewport-fit=cover` + `env(safe-area-inset-*)` on the header and footer |
| Tailwind from the Play CDN (needs internet on every launch) | Compiled at build time into a 39 kB stylesheet — works offline |
| No manifest, icons, or theme colour | `manifest.webmanifest`, SVG + PNG icons (incl. Android maskable), theme colour, Apple touch icon |
| API fixed to `localhost:4000` | Follows the host the app was opened from; `VITE_API_URL` overrides |

Verified at 375×667 (iPhone SE), 393×852 (iPhone 14 Pro), 412×915 (Pixel 7) and
360×740 (Galaxy S8): **fits exactly, no scrolling, no horizontal overflow.**

---

## Running it

### On this machine (web, as before)
```bash
npm run dev            # from the project root
```

### On a real phone over your wifi — no packaging needed
1. Find this machine's IP: `ipconfig` → the IPv4 address, e.g. `192.168.1.5`
2. Start the client so it listens on the network:
   ```bash
   npm --workspace client run dev:lan
   ```
3. On the phone, open `http://192.168.1.5:5173`

The client works out that the API is on `http://192.168.1.5:4000` automatically —
that's what the host-following logic in `client/src/api.js` is for. Your laptop and
phone must be on the same network, and Windows Firewall may prompt to allow Node.

### Android (a real app)
Needs **Android Studio** (with the Android SDK) — free, and it runs on Windows.
```bash
npm --workspace client run android
```
That builds the web assets, syncs them into the native project, and opens Android
Studio. Press ▶ to run on an emulator or a plugged-in phone.

> **Set the API URL first.** A packaged app cannot use `localhost` — that means the
> phone itself. Create `client/.env.production`:
> ```
> VITE_API_URL="http://192.168.1.5:4000/api"
> ```
> (Your machine's LAN IP while testing; your real HTTPS domain once hosted.)
> Android also blocks plain HTTP by default — for local testing only, allow it for
> your IP via a network-security config, or use HTTPS.

### iOS
```bash
npm --workspace client run ios
```
⚠️ **This cannot be built on Windows.** Xcode is macOS-only. The `client/ios`
project is generated and ready, but to build, run on a device, or submit to the App
Store you need either a Mac, or a cloud Mac service (Codemagic, Ionic Appflow,
Bitrise — roughly £30–90/month).

---

## Before the stores will accept it

### Both stores
- [ ] **Host the backend** with a real domain and HTTPS. Both platforms block plain
      HTTP by default (iOS App Transport Security, Android cleartext policy).
- [ ] **Move off SQLite** to PostgreSQL — one line in `server/prisma/schema.prisma`.
- [ ] **Privacy policy** at a public URL. Required by both.
- [ ] **App icons and splash screens** — the PNGs here are placeholders generated
      from `client/public/icon.svg`. Re-run `node scripts/make-icons.mjs` after
      replacing the SVG with the college's real logo.
- [x] ~~**Account deletion inside the app.**~~ **Done.** Staff App → **More** →
      *Delete my account*. Requires the password, an authenticator code where 2FA is
      on, and the word DELETE typed out. Removes the profile, check-ins, leave,
      adjustments, notifications, reset tokens and the sign-up record; shared
      documents survive and assigned ones are detached. The last remaining
      administrator is refused, so the college cannot be locked out of its own
      admin console. Covered by `scripts/smoke-account-deletion.mjs` (26 checks).

### Apple specifically
- [ ] **Guideline 4.2 (Minimum Functionality)** — Apple rejects apps that are just a
      website in a wrapper. **Push notifications are built** (see below); adding
      **biometric unlock** (Face ID / Touch ID) and **offline access** to balances
      and documents would make the case comfortably.
- [ ] Apple Developer Program — £79/year.
- [ ] A Mac (or cloud Mac) for building and submitting.

### Google specifically
- [ ] Play Console account — $25 one-off.
- [ ] Data safety form declaring what you collect (names, emails, attendance).
- [ ] Target API level requirements (Play enforces a recent one).

### Security hardening for a packaged app
- [ ] Move the JWT from `localStorage` to secure storage (`@capacitor/preferences`
      is installed; for real secrecy use a Keychain/Keystore plugin). WebView
      localStorage is app-private but is not the Keychain.
- [ ] Certificate pinning if the college requires it.
- [ ] Shorter token lifetime — 7 days is generous for a mobile app on a lost phone.

---

---

## Push notifications

Built and tested end to end **except the final hop to Google**, which needs your own
Firebase project. Until you configure it the app behaves exactly as before — the
in-app bell and email still work, and the server logs what it *would* have pushed.
That's the same pattern as email, so nothing breaks in development.

**What triggers a push:** every existing notification. A staff member gets one when
their leave is approved or declined, when their password is reset, and when an admin
resets their two-step verification. Admins get one when a leave request or a sign-up
arrives. Tapping the notification opens the relevant screen.

**Students got the same channel on 12 Sep 2026.** Before that date a student push was
not merely unconfigured, it was impossible: `Notification`/`DeviceToken` had no student
owner column, so nothing a student did could ever write a row a push could be sent
from. Both tables now carry a nullable `studentId` beside the existing `staffId`
(exactly one set, enforced by a database `CHECK` — see `API.md`'s Student portal
section), and a student gets a push when their query is answered, a review is filed
about them, a grade is released or corrected, their timetable moves inside 48 hours, or
a referral they were told about changes status. **The lock-screen title now differs by
audience** (`server/src/notify.js#titleFor`): the college's own display name where
branded, else `"Staff Hub"` for a staff recipient and `"ClassAura"` for a student one —
never the other product's name, since a student has never opened the staff app and
should not see it named on their own lock screen.

### Turning it on

This is the one step nobody can do for you: a Firebase project is tied to a Google
account. Everything either side of it is already built and tested — see
*"What's already proven"* below.

**1 — Create the project** (2 minutes, free)
   - Go to <https://console.firebase.google.com> → **Add project**
   - Name it e.g. `edtech-hub`. Google Analytics is not needed — turn it off.

**2 — Add the Android app** (this is all Android needs)
   - Project overview → the **Android** icon
   - Package name — must match exactly: `uk.co.edtech.hub`
   - Download **`google-services.json`** and put it at:
     ```
     client/android/app/google-services.json
     ```
   - Nothing else to configure: the Gradle plugin is already on the classpath and
     applies itself as soon as that file exists.

**3 — Add the iOS app** (only when you have a Mac and a paid Apple account)
   - Project overview → the **iOS** icon, bundle ID `uk.co.edtech.hub`
   - Download **`GoogleService-Info.plist`** → `client/ios/App/App/`
   - Apple Developer portal → **Keys** → create an *Apple Push Notifications service
     (APNs)* key → download the `.p8`
   - Firebase → *Project settings → Cloud Messaging → APNs Authentication Key* →
     upload the `.p8` with your Key ID and Team ID

**4 — Give the server permission to send**
   - Firebase → *Project settings → **Service accounts*** → **Generate new private key**
   - A JSON file downloads. **Keep it out of the repository** — it can send
     notifications to every one of your users.
   - In `server/.env`:
     ```env
     FCM_PROJECT_ID="edtech-hub"
     FCM_SERVICE_ACCOUNT="C:/secure/path/edtech-hub-firebase-adminsdk.json"
     ```

**5 — Check it**
   ```bash
   node scripts/check-push.mjs                 # validates the credentials
   node scripts/check-push.mjs <device-token>  # sends a real test notification
   ```
   The server banner should change from `console stub` to
   `Firebase project "edtech-hub" as …`.

   To get a device token: run the app on a real device, sign in, then read it from
   the `DeviceToken` table (`npm run studio`).

### What's already proven

`scripts/smoke-push-transport.mjs` (28 checks) verifies the whole Firebase transport
against a generated key and a stand-in for Google, so the only untested link is the
final hop to Google's servers:

- the OAuth assertion is a valid RS256 signature with the right issuer, audience,
  scope and expiry;
- the message body is exactly the shape FCM v1 expects, including all-string `data`
  values and the Android channel / APNs blocks;
- access tokens are cached across sends and re-exchanged when they expire;
- `UNREGISTERED` and `INVALID_ARGUMENT` are recognised as dead tokens (and the row
  deleted), while an outage is **not** — a temporary 503 must not wipe everyone's
  registrations;
- a network failure returns cleanly instead of throwing into leave approval.

`scripts/smoke-push.mjs` (24 checks) covers the device-registration side.

> Uses FCM **HTTP v1**. The old "server key" API was switched off by Google in 2024,
> so anything you read online referring to a `FCM_SERVER_KEY` is out of date.

### How it behaves

- The token is registered **after sign-in** and removed **on sign-out**, so a shared
  or handed-on phone never keeps delivering the previous user's notifications.
- Registering a token that belongs to another account **moves** it rather than
  duplicating it — one device, one owner.
- Tokens FCM reports as dead (app uninstalled) are deleted automatically.
- Deleting your account removes its device tokens with it.
- On the web, all of this is a no-op — browsers get no FCM token.

Covered by `scripts/smoke-push.mjs` (24 checks).

---

## Student app native chrome (status bar, pull-to-refresh)

Added 12 Sep 2026, and scoped to `client/src/student/StudentApp.jsx` only — `PhoneShell.jsx`
is shared with the staff app, so neither change reaches it.

- **Status bar overlay.** `capacitor.config.json` sets `StatusBar.overlaysWebView: true`
  (the `backgroundColor` key was dropped alongside it — the plugin does nothing with it
  once overlay is on). A native-only effect, gated on `isNativeApp()` (always false in a
  browser, staff app included), calls `setOverlaysWebView`/`setStyle` on mount and again
  on every `prefers-color-scheme` change. It sets `Style.Dark` **unconditionally**, in
  both colour schemes — not a missed case: the surface the status bar sits over is the
  student Header's own navy→maroon gradient, which stays dark in both schemes by design,
  and `Style.Light` there would print black icons on a navy bar always. `Header` gets
  `paddingTop: calc(env(safe-area-inset-top) + 0.5rem)` so its content clears the
  overlaid bar.
- **Pull-to-refresh.** `PhoneShell` grows an optional `onRefresh`/`refreshing` prop pair,
  implemented with non-passive `touchmove` listeners on the scrollport (needed because
  `preventDefault()` has to actually stop the native overscroll `overscroll-behavior-y:
  none` already suppresses at the `<body>` level). Only `StudentApp.jsx` passes them;
  every existing `PhoneShell` caller, staff app included, is unaffected by the new props
  being optional. Verified by a clean build and 18 screenshots with no console errors;
  **not verified with a live touch gesture** — Playwright's Chromium does not dispatch
  real touch sequences from a mouse-driven script without extra harness work judged out
  of scope. Worth a manual check on a real device or emulator before shipping.

## Project layout

```
client/
├── brand.properties        THE white-label file: app name, bundle id, chrome colours
├── capacitor.config.json   app id, name, splash, status bar — written from brand.properties
├── scripts/apply-brand.mjs pushes brand.properties into the iOS project and the web shell
├── android/                generated Android project — buildable on Windows
├── ios/                    generated iOS project  — needs a Mac
├── public/                 manifest, icons
├── tailwind.config.js      real Tailwind build (replaced the CDN)
└── src/PhoneShell.jsx      decides: decorative phone (desktop) vs full screen (device)
```

`useIsHandset()` in `PhoneShell.jsx` is the single switch — it returns true on a
screen ≤640px wide **or** whenever the app is running inside Capacitor.

## Useful commands

| Command | What it does |
|---|---|
| `npm --workspace client run dev:lan` | Dev server reachable from your phone over wifi |
| `npm --workspace client run brand` | Apply `client/brand.properties` to the native projects and the web shell |
| `npm --workspace client run sync` | Rebuild web assets and copy them into both native projects |
| `npm --workspace client run android` | Build, sync and open Android Studio |
| `npm --workspace client run ios` | Build, sync and open Xcode *(macOS only)* |
| `node scripts/make-icons.mjs` | Regenerate the PNG icons from `client/public/icon.svg` |
| `node scripts/check-push.mjs [token]` | Validate Firebase settings, optionally send a test push |
| `node scripts/smoke-push.mjs` | 24 checks over device registration and notification fan-out |
| `node scripts/smoke-push-transport.mjs` | 28 checks over the Firebase transport — needs no credentials or network |

---

## White-labelling a build for one institution

The app already brands itself at **runtime**: colours, logo and institution name all
come from `GET /api/branding`, and the native shells load that same React bundle. So a
build already *looks* right for the college whose backend it points at, without a line
of its branding being compiled in.

Four things cannot work that way, because the operating system reads them before a
single line of our JavaScript runs:

| Baked in at build time | Why it can't follow `/api/branding` |
|---|---|
| Home-screen app name | Drawn by the launcher before the app is even started |
| Bundle id / applicationId | The store listing's primary key; the OS installs by it |
| Launcher icon | Ditto — an image in the package, not a URL |
| Splash screen | Shown *while* the WebView is still loading |

⚠️ **So a per-college app is a separate build, and a separate listing in the App
Store and Play.** There is no arrangement of config that makes one installed binary
show two different names on two different home screens. What follows is how to make
that separate build cheap.

### The one file

Everything that varies lives in **`client/brand.properties`**:

| Key | What it sets |
|---|---|
| `app.name` | Home-screen label — Android `app_name`, iOS `CFBundleDisplayName`, the web manifest |
| `app.id` | Android `applicationId` and iOS `PRODUCT_BUNDLE_IDENTIFIER` |
| `app.description` | Web manifest and the `<meta name="description">` of the shell |
| `color.background` | Splash and WebView background, PWA `theme_color` |
| `color.statusBar`, `color.statusBarStyle` | Android status bar and whether its icons are drawn light or dark |
| `color.primary`, `color.primaryDark`, `color.accent` | AppCompat theme; `colorPrimary` is also the tint Android puts on our push notifications |

Two different mechanisms read it, for a reason worth knowing:

- **Android reads it live.** `client/android/app/build.gradle` loads it with
  `java.util.Properties` — the same way it already loads `keystore.properties` — and
  emits `app_name`, the package strings and the theme colours as `resValue` entries.
  Nothing is generated into the repo, so the Android side cannot drift out of step
  with the file. `values/strings.xml` and `values/colors.xml` are consequently empty:
  re-adding those names there is a hard build failure (*duplicate value for resource*).
- **iOS has it written in.** An `Info.plist` and a `.pbxproj` are static data. The one
  mechanism that would let them read a variable — an `.xcconfig` holding
  `$(BUNDLE_ID)` — breaks Codemagic's `xcode-project use-profiles`, which matches
  provisioning profiles by *literal* bundle id. So `client/scripts/apply-brand.mjs`
  writes the values in instead. It is idempotent, and it runs automatically before
  `run sync`, `run android`, `run ios` and in `codemagic.yaml`.

### Everything a white-label build must override

| Value | File | Notes |
|---|---|---|
| App name | `client/brand.properties` → `app.name` | |
| Bundle id | `client/brand.properties` → `app.id` | Reverse-DNS, e.g. `uk.ac.<college>.staffhub`. Permanent once published. |
| Native chrome colours | `client/brand.properties` → `color.*` | Only if the college's splash artwork needs a coloured field; the neutral default suits most |
| Launcher icon + splash artwork | `client/public/icon.svg`, then regenerate | Images, not config — see *App icons and splash screens* above |
| iOS signing bundle id | `codemagic.yaml` → `ios_signing.bundle_identifier` **and** `BUNDLE_ID` | Codemagic fetches signing assets *before* any script runs, so these cannot read `brand.properties`. The build fails fast if they disagree with it. |
| App Store Connect app | `codemagic.yaml` → `APP_STORE_APPLE_ID` | The numeric id of *that college's* app record |
| Android upload key | `client/android/keystore.properties` | Per listing. Never committed; losing it means Google has to intervene |
| API URL | `codemagic.yaml` → `VITE_API_URL`, or `client/.env.production` | Always. Each college has its own deployment and its own database, so a build points at exactly one API and pointing two colleges' builds at one URL signs everybody into the same institution |
| Play `versionCode` / iOS build number | `client/android/app/build.gradle` | Per listing, and only ever upwards |

The Java package `namespace` in `build.gradle` deliberately does **not** follow
`app.id`: it is the package `MainActivity` and the generated `R` class live in,
invisible to users, and changing it means moving the source file. Android allows the
two to differ, and only `applicationId` reaches the store.

### Rebuilding after a change

```bash
npm --workspace client run brand      # apply brand.properties (prints what it wrote)
npm --workspace client run sync       # apply + build web assets + copy into both native projects
npm --workspace client run android    # ...and open Android Studio
npm --workspace client run ios        # ...and open Xcode (macOS only)
```
`brand` is already the first step of the other three, so it is only worth running on
its own to see the diff before committing. Push to trigger the Codemagic `ios-release`
workflow for the iOS side.

### ClassAura, and the app that came before it

**`uk.co.classaura.app` is the app this repo now builds.** Named ClassAura, starting at
`1.0.0` / build `1` on 11 Sep 2026 — a NEW listing in both stores, not a rename.

That distinction is the whole reason the version numbers restart. A published app's
`versionCode` only ever goes up, on any track, and Play rejects a repeat *after* the
upload rather than before it. Version 1 is therefore only correct under an id no store
has seen, and the two decisions — new id, restart at 1 — stand or fall together. Keeping
the old id and restarting at 1 is the combination that fails, and it fails late.

Two things still carry the old app's identity and are correct to:

* `namespace` in `build.gradle` — the Java package `MainActivity` and the generated `R`
  class live in. Internal, invisible, and changing it means moving source files.
* `APP_STORE_APPLE_ID` in `codemagic.yaml` — **now `6811078668`**, ClassAura's own
  record (created 11 Sep 2026). It is both the upload target and what the build-number
  step reads to find the latest TestFlight build, so the old `6795300712` would have
  uploaded to the Staff Hub listing *and* numbered the build from that listing's
  history.

### What is fixed for the app that already exists

`uk.co.edtech.hub` is live — App Store Connect app `6795300712`, Play `versionCode 26`.
It is a SEPARATE listing and nothing above affects it. **It stays.** Changing a published app's bundle id does not update that app; it
publishes a *different* one, and every existing install is orphaned on the old version
with no upgrade path. `brand.properties` therefore ships with `app.id=uk.co.edtech.hub`
as the default, and a new institution gets a new id in its own copy of the file — never
by editing this one in place.

The app *name*, by contrast, is safe to change: the default is now the neutral,
product-level **Staff Hub** rather than "EdTech Hub". Existing installs simply pick up
the new label on their next update — but the store listing name should be changed to
match, or the home screen and the App Store will disagree.
