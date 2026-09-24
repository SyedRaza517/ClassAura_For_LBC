// Staff presence check-in — a browser walkthrough of the two-tab Daily Check-In screen,
// written against docs/testing/2026-09-21-staff-check-in-e2e-test-plan.md sections 3 and
// 4 WHILE THE SCREEN ITSELF WAS STILL BEING BUILT. If you are reading this before that
// work has landed, every assertion below is a bet on the spec, not a description of
// something this script has watched pass. Treat a failure here first as "does the real
// markup match the plan" and only second as "did the feature regress" — the two look
// identical from outside but call for different fixes.
//
//   node _walk-staff-checkin.mjs
//   (needs the app running: API on :4000, client on :5173 — see docs/testing/…md §2.2)
//
// WHY THIS FILE LIVES AT THE REPO ROOT, NOT IN A TEMP DIRECTORY
// Playwright resolves its own package by walking UP from the script's directory looking
// for node_modules/playwright. A script dropped in an OS temp folder, or run with `node
// /tmp/whatever.mjs`, walks up through directories that were never `npm i`'d and the
// import fails with a module-not-found error that has nothing to do with the app under
// test. An earlier session lost time to exactly that before noticing the script's own
// location was the problem, not Playwright or the app — see the "Visual check with
// Playwright" note in project memory. Keeping this file beside package.json is what
// makes the walk-up land on THIS repo's node_modules, where `npm i --no-save playwright`
// (see docs/testing/…md §2.3) puts the package without touching package-lock.json.
//
// WHY THE SIGN-IN GATE THROWS INSTEAD OF LOGGING A FAILED CHECK AND CONTINUING
// A script that treats "did sign-in work" as just another assertion keeps running
// against whatever the browser happens to be showing when sign-in silently fails — an
// error toast, a half-rendered form, the landing page again because the click missed.
// Every assertion after that point still "runs" and mostly still finds SOMETHING absent
// on the wrong page, so it reports failures that look like feature bugs but are really
// "we were never signed in." A prior walkthrough in this repo only surfaced real product
// bugs once its sign-in step was changed to throw and stop the run rather than record one
// more red line and carry on; the same shape is used here on purpose. Every other
// assertion in this file uses the soft `check()` helper — only the sign-in gate throws.
//
// WHY THE LANDING-PAGE ROLE TILE IS CLICKED BEFORE TOUCHING ANY FORM FIELD
// The app's first screen (client/src/Landing.jsx) renders three role tiles — Staff App,
// Student Portal, Admin Dashboard — and NOTHING ELSE. The email/password inputs this
// script needs do not exist in the DOM until one tile is clicked; a script that calls
// `page.getByLabel("Email")` straight after `page.goto()` fails on an element that isn't
// missing so much as not born yet, which reads as a much scarier bug than it is. This
// script clicks "Staff App" (client/src/Landing.jsx → onStaffApp → entry="app"), not
// "Admin Dashboard": the admin tile opens client/src/Login.jsx and lands the signed-in
// admin on the sidebar Admin Dashboard view, which is a different screen from the one
// this plan describes; the staff tile opens client/src/MobileAuth.jsx and — because
// `initialView = entry === "app" ? "app" : …` in client/src/App.jsx — lands directly on
// the Staff App home. A header toggle that used to let you flip between the two views
// from either entry point was removed — client/src/App.jsx says so in a comment at the
// spot it used to sit — so picking the right tile up front is not optional stage-setting,
// it is the only way in.
//
// THIS COMMENT USED TO SAY the Staff App home's "tiles include 'Daily Check-In' by that
// exact name (confirmed against scripts/screenshots.mjs's APP_SCREENS list, which
// enumerates it)". That was wrong, and reading client/src/StaffHub.jsx is what found it:
// `APP_SCREENS` is a list of human-readable screen NAMES used for screenshot filenames —
// it was never an accessible name any element on the page actually carries. The screen's
// own header title IS "Daily Check-In" (`{ checkin: "Daily Check-In", … }[screen]` around
// line 627), but neither control that NAVIGATES to it is named that: the "All tools" grid
// tile and the bottom tab bar both use the shorter label **"Clock in"** (`{ key: "checkin",
// label: "Clock in", … }`, appearing twice — the grid at ~line 833, the tab bar at ~line
// 891 — and BOTH are on screen at once on the home screen, which is its own selector trap;
// see the comment on `clockInTab` in signIn() below for how that one is resolved.
//
// WHAT THIS SCRIPT CANNOT SET FOR YOU — THE THREE SWITCHES, AND ONE MORE THING
// The Daily Check-In screen's behaviour depends on three college-level settings
// (`staffTapEnabled`, `staffNetworkCheck`, `staffGeofenceCheck`, all under Check-in
// settings → Staff clock-in, same `/api/tags/settings` row the NFC feature already uses —
// see docs/testing/…md §4). This script does not flip them. Change them by hand in
// Settings, or:
//
//   curl -X PUT localhost:4000/api/tags/settings \
//     -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
//     -d '{"staffTapEnabled":false,"staffNetworkCheck":true,"staffGeofenceCheck":false,"allowedNetworks":["203.0.113.0/24"]}'
//
// The Geofence row below needs a fourth thing outside those three switches: an ACTIVE
// CAMPUS WITH SAVED COORDINATES. This script doesn't set that either — locate one by hand
// under Timetabling → Campuses, or:
//
//   curl -X PUT localhost:4000/api/timetabling/campuses/<id> \
//     -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
//     -d '{"latitude":51.5007,"longitude":-0.1246}'
//
// (the same coordinates scripts/smoke-nfc-tap.mjs pins for the identical assertion at the
// HTTP layer — see sectionGeofence() below for why reusing them matters). Set whichever
// combination the section you're running needs, then run it. Section by section:
//   A            — any config; only requires the staff account not to be checked in today.
//   B / C        — Online is never checked (see test plan §1), so any config works.
//   D / E        — staffTapEnabled=true. staffNetworkCheck/staffGeofenceCheck don't matter.
//   F            — staffTapEnabled=false, staffNetworkCheck=false, staffGeofenceCheck=false
//                  (today's pre-feature behaviour — the button just clocks you in).
//   G            — staffTapEnabled=false, staffNetworkCheck=true, staffGeofenceCheck=false.
//                  Drives the NETWORK refusal specifically — off-network needs nothing
//                  from the browser to reproduce. See "Geofence" below for the campus one.
//   Geofence     — staffTapEnabled=false, staffGeofenceCheck=true, staffNetworkCheck=false
//                  (so the network check can't produce a different refusal first), plus
//                  the campus coordinates above. THIS COMMENT USED TO SAY the geofence
//                  refusal was "left as a follow-up rather than guessed at here", with the
//                  off-network refusal driven instead because off_campus "needs a granted
//                  geolocation permission and a spoofed position (`context.setGeolocation`)
//                  to avoid tripping `position_missing` instead". That gap is closed now:
//                  `main()` grants the `geolocation` permission and starts the position far
//                  from campus when the browser context is created, so no permission prompt
//                  ever has to be clicked, and `sectionGeofence()` moves that spoofed
//                  position with `context.setGeolocation()` between a point far from the
//                  campus (expect `off_campus`) and the campus itself (expect acceptance).
//   H            — same config as D/E. Not a separate action — see the note in
//                  `walkOnsite()` about why this script cannot produce D's exact copy.
//
// Rather than fail loudly when the switches don't match what a section wants, most
// sections BRANCH on what the UI actually does (dialog vs. no dialog, refused vs.
// accepted) and either assert the matching scenario or SKIP with the switch to flip and
// re-run — mirroring how `npm test`'s smoke suites print SKIP rather than counting an
// untested path as a pass (see CLAUDE.md). A SKIP here means "this run's config didn't
// exercise that branch," never "the assertion doesn't hold."
//
// STATE THIS SCRIPT CANNOT RESET
// A successful check-in (Online or On-site) writes a real `CheckIn` row for today against
// whatever staff account signed in. Nothing in this script — and nothing it is allowed to
// touch, per its brief — clears that row, so a second run today against the same account
// will find it already checked in and SKIP every assertion that needs a fresh state.
// That is why the onsite branch runs BEFORE the Online branch below: the onsite branch
// only writes a row when it lands on F (all three switches off); the D/E branch (tap
// required) and the G branch (a refusal) write nothing, so running onsite first keeps the
// Online branch's fresh-state assertions alive for the config combinations most people
// will actually use this script to check. Use a staff account that has not clocked in
// today, or re-run tomorrow, or clear today's row via the admin correction route the test
// plan's §6.3 describes (`PUT /` — not called from here, since that route is one of the
// files this task was told not to touch and it was still being written elsewhere).
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
const STAFF_EMAIL = process.env.STAFF_EMAIL || "admin@edtech.co.uk";
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || "test-seed-password-2026";
// Headed by default — this is a WALKTHROUGH, meant to be watched, not a headless smoke
// suite. `HEADLESS=1 node _walk-staff-checkin.mjs` switches it off for CI-style runs.
const HEADLESS = process.env.HEADLESS === "1";

// The two positions sectionGeofence() spoofs via context.setGeolocation — never a real
// GPS fix (see the note on what this script cannot test, in walkOnsite()), but Playwright
// removing the flakiness of a real one rather than the script working around it by
// skipping the check entirely, which is what this file used to do — see the "Geofence"
// entry in the switches comment above for that history.
//
// AT_CAMPUS is the exact pair scripts/smoke-nfc-tap.mjs pins onto a real campus row for
// the identical assertion at the HTTP layer (Aldwych, London). Reused deliberately rather
// than picked afresh: this script and that suite then assert against the SAME ground
// truth, instead of two positions that happen to both be "somewhere in London" and could
// silently drift apart from each other over time. FAR_FROM_CAMPUS is the "another city"
// figure the smoke suite and the test plan's §4 curl example both already use — Piccadilly
// Gardens, Manchester, over 250km from AT_CAMPUS and nowhere near any radius a college
// could plausibly configure (presence.js clamps the radius between a 50m floor and a
// 5000m ceiling).
const FAR_FROM_CAMPUS = { latitude: 53.4808, longitude: -2.2426, accuracy: 20 };
const AT_CAMPUS = { latitude: 51.5007, longitude: -0.1246, accuracy: 15 };

// The status line every "did this actually clock in" assertion in this file reads, and
// NOT plain `/checked in/i` — found the same way the sign-in selectors above were:
// reading client/src/StaffHub.jsx rather than trusting a regex that had never run against
// the real markup. CheckInScreen's status paragraph (~line 1479) is one of THREE literal
// strings — `"✓ Checked Out"`, `"● Checked In"`, or, when nothing has happened yet,
// `"Not Checked In"`. That third string contains the substring "Checked In" too, so a bare
// `/checked in/i` matches the screen's DEFAULT, not-yet-checked-in state just as happily
// as its success state — every assertion built on it would report a pass whether or not
// the click actually worked, and `alreadyCheckedInToday()` would read as "already checked
// in" from the very first page load, before anything happens. That is precisely the "a
// test that passes while discriminating nothing" failure `testing.md` warns about, just
// never triggered yet because the sign-in gate above always threw first.
//
// Anchored on the glyph instead: both real success strings begin with a bullet (●) or a
// tick (✓) immediately followed by "Checked"; "Not Checked In" has neither. (A THIRD
// string carries a tick too — "✓ Your day is complete…", shown alongside "✓ Checked Out"
// once checked out — but it says "Your", not "Checked", right after the glyph, so
// requiring "checked" immediately after excludes it as well without needing `.first()` to
// paper over a double match.)
const CHECKED_STATE_RE = /[●✓]\s*checked/i;

const SHOT_DIR = path.join(__dirname, "_walk-staff-checkin-screenshots");
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

let shotIndex = 0;
async function shot(page, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  shotIndex += 1;
  const file = path.join(SHOT_DIR, `${String(shotIndex).padStart(2, "0")}-${slug(name)}.png`);
  // Screenshotting is diagnostic, never load-bearing — a screenshot that itself throws
  // (page already closed, navigation mid-flight) must not mask the real assertion result.
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  return file;
}

let pass = 0, fail = 0;
/**
 * The soft assertion. Mirrors scripts/smoke-nfc-tap.mjs's `check()` — same ✓/✗ line, same
 * pass/fail tally, same "detail only printed on demand" shape — with one addition: a
 * failure grabs a screenshot immediately, before the next action can change what's on
 * screen, and prints where it landed. `page` is threaded through every call so that
 * screenshot can happen at the point of failure rather than at the end of a run.
 */
async function check(page, name, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
  if (ok) { pass++; return; }
  fail++;
  const file = await shot(page, `fail-${name}`);
  console.log(`   screenshot: ${file}`);
}

/** Visible but deliberately outside the pass/fail tally — see the file header on why a
 * SKIP here means "this run's switches didn't exercise that branch," not "untested." */
function skip(name, detail = "") {
  console.log(`SKIP  ${name}${detail ? "  — " + detail : ""}`);
}

/** True once a locator is visible, false on timeout — never throws either way. Used for
 * branching on UI state (which config is live, whether today's check-in already happened)
 * rather than for assertions, which go through `check()` instead. */
async function visible(locator, timeout = 4000) {
  try { await locator.first().waitFor({ state: "visible", timeout }); return true; }
  catch { return false; }
}

/**
 * The primary call-to-action button. Given as exactly "Check in" in the plan, but
 * client/src/Landing.jsx shows this codebase sometimes folds icon text and captions into
 * a button's accessible name (its role tiles' names run "Staff App For college staff Sign
 * in or create an account…"), so an anchored `/^check in$/i` could plausibly miss a real,
 * correct button. Try the exact match first — it's the precise claim the plan makes and
 * the one that catches a genuinely-wrong label — and fall back to a loose match so a
 * decorative icon's alt text doesn't fail this script over something CSS-equivalent.
 */
function checkInButton(page) {
  const exact = page.getByRole("button", { name: /^check in$/i });
  return { exact, loose: page.getByRole("button", { name: /check in/i }) };
}
async function currentCheckInButton(page) {
  const { exact, loose } = checkInButton(page);
  return (await visible(exact, 1500)) ? exact : loose;
}

/** Whether today's card already shows a completed check-in — the state this script
 * cannot reset (see the file header). Checked before sections that need a fresh screen. */
async function alreadyCheckedInToday(page) {
  return visible(page.getByText(CHECKED_STATE_RE), 2000);
}

// ---------------------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------------------

async function signIn(page) {
  console.log("\n--- sign in ---");
  await page.goto(CLIENT_URL, { waitUntil: "networkidle" });

  // The gate this whole file is built around — see the file header. The landing page has
  // just three tiles and no form fields yet.
  const staffTile = page.getByRole("button", { name: /staff app/i });
  if (!(await visible(staffTile, 10000))) {
    await shot(page, "landing-page-missing-staff-tile");
    throw new Error(
      "Sign-in gate: the landing page never showed a 'Staff App' role tile within 10s. " +
      "Either the client isn't running at " + CLIENT_URL + ", or Landing.jsx's tile " +
      "labels have changed. Refusing to continue: every assertion below assumes we are " +
      "signed in as staff, and pressing on from an unknown page would just report " +
      "failures for the wrong reason."
    );
  }
  await staffTile.click();

  // MobileAuth.jsx labels its inputs via a `Labelled` wrapper, so `getByLabel` resolves —
  // but NOT plain `getByLabel("Email")`, which is where the first real run of this script
  // actually failed: strict mode, "resolved to 2 elements" — the Email input, AND the
  // "Remember my email and password" checkbox a few rows down, because Playwright's
  // string matching is substring-and-case-insensitive by default and that checkbox's own
  // label text contains the word "email". Confirmed by reading MobileAuth.jsx's SignIn
  // form directly rather than guessing at a fix: `getByRole("textbox", …)` sidesteps it
  // outright, because the checkbox's role is "checkbox", not "textbox" — no substring
  // match inside `name` can bridge two different roles. `exact: true` is added on top for
  // the same reason it's cheap everywhere: it costs nothing today and stops a FUTURE field
  // (an "Email domain" input, say) from reopening the same class of bug silently.
  const email = page.getByRole("textbox", { name: "Email", exact: true });
  if (!(await visible(email, 8000))) {
    await shot(page, "no-email-field-after-tile-click");
    throw new Error(
      "Sign-in gate: clicked the 'Staff App' tile but no Email field appeared within 8s. " +
      "This is the exact failure mode the tile-click-first ordering exists to catch — see " +
      "the file header. Refusing to continue."
    );
  }
  await email.fill(STAFF_EMAIL);
  // The SAME checkbox collides with a plain `getByLabel("Password")` too — its label text
  // is "Remember my email and PASSWORD" — and this one can't switch to `getByRole
  // ("textbox", …)` the way Email did: the field renders `type="password"` at this point
  // (useReveal()'s default, in client/src/RevealButton.jsx, is `shown: false` and this
  // script never presses the reveal toggle), and per the HTML accessibility mapping an
  // `<input type="password">` carries NO corresponding ARIA role at all — Chromium does
  // not expose it as `role="textbox"`, so `getByRole("textbox", …)` would silently match
  // NOTHING here, which is a worse failure than the one it would fix. `exact: true` is the
  // right tool instead: the checkbox's full label text is "Remember my email and
  // password", not "Password", so an EXACT match excludes it while an unanchored
  // substring match would not.
  await page.getByLabel("Password", { exact: true }).fill(STAFF_PASSWORD);
  await page.getByRole("button", { name: /^sign in$/i }).click();

  // The gate itself: proof we actually reached the Staff App home, not just that the
  // click landed somewhere. A wrong password fails silently into an error banner on the
  // SAME form — no exception, no navigation — so waiting for the home screen's own nav
  // control is what actually catches that, rather than waiting for the login form to
  // disappear (which a stuck error state never does either way).
  //
  // NOT "Daily Check-In" — see the correction in the file header above. The control that
  // navigates to the check-in screen is labelled "Clock in", and it exists TWICE at once
  // on the home screen: once in the "All tools" grid (client/src/StaffHub.jsx ~line 833)
  // and once in the persistent bottom tab bar (~line 891, `StaffTabBar`) that PhoneShell
  // renders as this screen's `footer` regardless of which screen is showing. Two buttons
  // sharing one accessible name is exactly the strict-mode trap the Email fix above heads
  // off — `exact: true` cannot save this one, because both names really are "Clock in",
  // not merely overlapping substrings. Scoped to the `<nav>` landmark instead: the tab bar
  // is a real `<nav>` element and the "All tools" grid tile is a plain `<div>`, so
  // `getByRole("navigation")` picks out only the tab bar's copy. (The admin console has
  // its own `<nav>`, at StaffHub.jsx ~line 3721 — irrelevant here, since this script only
  // ever signs in through the Staff App tile, never Admin Dashboard, so that sidebar is
  // never in the DOM to collide with.) The tab bar is also the more durable target of the
  // two: it is a fixed 4-item array (`STAFF_TABS`), while the "All tools" grid is
  // explicitly documented as reshuffling by role/gating.
  const clockInTab = page.getByRole("navigation").getByRole("button", { name: "Clock in", exact: true });
  if (!(await visible(clockInTab, 15000))) {
    await shot(page, "sign-in-did-not-reach-staff-home");
    throw new Error(
      "Sign-in gate: signed the form but never reached a Staff App home carrying a " +
      "'Clock in' tab within 15s. Likely causes: wrong credentials (check " +
      "STAFF_EMAIL/STAFF_PASSWORD env vars against the seed — see docs/testing/…md §2.1), " +
      "the seed hasn't been run against this database, or a second factor (TOTP) is " +
      "configured on this account and this script doesn't handle it. Refusing to " +
      "continue rather than asserting against whatever screen this actually is."
    );
  }
  console.log("✓ signed in and reached the Staff App home");
  await clockInTab.click();
  // role=radiogroup, NOT role=tablist — ruling R16, 21 Sep 2026, corrected on the screen
  // itself in client/src/StaffHub.jsx (search "A RADIO GROUP, NOT A TABLIST" there for the
  // full reasoning). The screen shipped as a tablist because tabs are what it looks like
  // and because THIS SCRIPT was originally written against those roles, before the screen
  // existed — a tablist promises tabpanels that swap, and there are none here, so a
  // screen-reader user told "tab" was being sent looking for a panel that does not exist.
  // Every role=tab / aria-selected selector below was corrected to role=radio /
  // aria-checked to match.
  await visible(page.getByRole("radiogroup"), 8000); // let the screen finish mounting
  console.log("✓ opened the Daily Check-In screen");
}

// ---------------------------------------------------------------------------------------
// Section A — nothing chosen yet
// ---------------------------------------------------------------------------------------

async function sectionFreshLoad(page) {
  console.log("\n--- A: screen loads, nothing chosen ---");
  if (await alreadyCheckedInToday(page)) {
    skip("the button is disabled before anything is chosen",
      "today's check-in already exists for this account — see the file header on why " +
      "this script can't clear it. Use a fresh staff account, or re-run tomorrow.");
    return false;
  }
  const btn = await currentCheckInButton(page);
  await check(page, "the button is disabled before anything is chosen",
    await btn.isDisabled().catch(() => null) === true);
  return true;
}

// ---------------------------------------------------------------------------------------
// Section B / C — Online
// ---------------------------------------------------------------------------------------

async function sectionOnline(page) {
  console.log("\n--- B/C: choosing Online ---");
  if (await alreadyCheckedInToday(page)) {
    skip("choosing Online enables the button, and pressing it clocks in",
      "today's check-in already exists for this account (most likely written by the " +
      "onsite branch above landing on F). See the file header.");
    return;
  }

  // role=radio, not role=tab — see the comment on the radiogroup wait in signIn().
  const onlineTab = page.getByRole("radio", { name: /online/i });
  if (!(await visible(onlineTab))) {
    await check(page, "an 'Online' radio option is present", false, "role=radio name=/online/i not found");
    return;
  }
  await onlineTab.click();
  await check(page, "Online is now the checked option",
    (await onlineTab.getAttribute("aria-checked")) === "true");

  const btn = await currentCheckInButton(page);
  await check(page, "B: choosing Online enables the Check in button",
    await btn.isEnabled().catch(() => null) === true);

  await btn.click();
  // "Clocked in" is read from the card, not from a toast — a toast can fire and fade
  // before this line runs; the card's own state is what a person re-opening the screen
  // a minute later would actually see, which is the thing worth proving.
  await check(page, "C: the card shows a checked-in state after pressing Check in",
    await visible(page.getByText(CHECKED_STATE_RE), 8000));
  await check(page, "C: the card shows a time",
    await visible(page.getByText(/\d{1,2}:\d{2}/), 2000));
  await check(page, "C: the card says Online",
    await visible(page.getByText(/online/i), 2000));
}

// ---------------------------------------------------------------------------------------
// Section D/E/F/G/H — On site, branching on what the current switches actually do
// ---------------------------------------------------------------------------------------

async function walkOnsite(page) {
  console.log("\n--- On site: branching on the live switches ---");
  if (await alreadyCheckedInToday(page)) {
    skip("the On site branch (D/E/F/G/H)",
      "today's check-in already exists for this account. See the file header.");
    return;
  }

  // role=radio, not role=tab — see the comment on the radiogroup wait in signIn().
  const onsiteTab = page.getByRole("radio", { name: /on site/i });
  if (!(await visible(onsiteTab))) {
    await check(page, "an 'On site' radio option is present", false, "role=radio name=/on site/i not found");
    return;
  }
  await onsiteTab.click();

  // The popup is a role="dialog" with aria-modal="true" and, per the plan, the exact
  // aria-label "Tap onsite" — matching client/src/student/screens/CheckIn.jsx's existing
  // dialog pattern (role="dialog" aria-modal="true" aria-label="Check-in result"), so this
  // is a house convention rather than a one-off guess.
  const dialog = page.getByRole("dialog", { name: "Tap onsite" });
  const dialogOpened = await visible(dialog, 3000);

  if (dialogOpened) {
    // D + H, collapsed into one branch — DELIBERATELY, and this is a hard boundary of what
    // a browser can prove, not a shortcut taken for convenience. Nobody should "fix" this
    // script later by trying to assert D's listening state directly; the fix below is why
    // that attempt cannot succeed and would only prove the app "broken" for a reason that
    // has nothing to do with the app.
    //
    // The plan's D row describes the popup saying "Please tap the NFC sticker" and its H
    // row describes the SAME popup, in a desktop browser, saying to use the app instead —
    // because a browser cannot read a sticker. Confirmed against client/src/nfc.js: `const
    // NATIVE = Capacitor?.isNativePlatform?.() === true;` and `nfcStatus()` returns `{ ok:
    // false, reason: "web" }` whenever `!NATIVE` — which is unconditionally true in any
    // browser, including this one, because `Capacitor.isNativePlatform()` only ever answers
    // true inside the Capacitor-wrapped native shell. There is no browser flag, user agent
    // spoof or Playwright option that changes that answer, because it isn't asking "does
    // this look like a phone" — it is asking whether the Capacitor native runtime bridge is
    // present at all, and in a browser it never is.
    //
    // This script only ever drives a desktop Edge browser (see the launch call in main()),
    // so it can only ever observe H's wording, never D's. Producing D's literal "tap the
    // sticker" copy needs the Capacitor-wrapped app running on a real handset — which test
    // plan §9 already lists as unproven, for the same underlying reason a physical NFC tap
    // is unproven there. That gap is inherited here rather than papered over with a wording
    // this script cannot actually make happen.
    console.log("--- D+H: On site opened the sticker dialog immediately ---");
    await check(page, "D: the dialog opens immediately on choosing On site (no extra click needed)",
      dialogOpened);
    await check(page, "H: in a desktop browser, the dialog says to use the app rather than tap here",
      await visible(dialog.getByText(/app/i), 2000));

    // E: dismiss it, then prove the button now reads the "reopen" state rather than
    // becoming a normal enabled button. The close control used to be a guess across the
    // common accessible patterns (close/dismiss/got it/ok) because the screen didn't exist
    // yet when this script was first written — see the file header. It is now the real,
    // verified one: client/src/StaffHub.jsx's TapOnsiteSheet renders
    // `<button onClick={onClose} aria-label="Close">` (there are actually two such buttons
    // in the file — one on the sheet itself, one on the generic Modal component — but only
    // TapOnsiteSheet's is inside THIS dialog, which is why the locator is scoped to
    // `dialog` rather than the page). The Escape fallback stays even so: it costs nothing,
    // and it means a future markup change that drops the aria-label leaves this section
    // reporting something useful rather than throwing.
    const closeBtn = dialog.getByRole("button", { name: /close/i });
    if (await visible(closeBtn, 1500)) await closeBtn.click();
    else await page.keyboard.press("Escape"); // dialogs conventionally answer Escape too
    await check(page, "E: the dialog closes", !(await visible(dialog, 2000)));

    const tapBtn = page.getByRole("button", { name: /tap the sticker/i });
    await check(page, "E: the Check in button now reads 'Tap the sticker'",
      await visible(tapBtn, 2000));

    if (await visible(tapBtn, 500)) {
      await tapBtn.click();
      await check(page, "E: pressing 'Tap the sticker' reopens the dialog — never a dead button",
        await visible(dialog, 3000));
    } else {
      skip("E: pressing 'Tap the sticker' reopens the dialog",
        "the button never showed that exact label, so pressing it wasn't attempted (see the check above)");
    }
    return;
  }

  // No dialog — either F (accepted outright) or G (refused). Both start the same way:
  // On site selected, button enabled, then pressed.
  const btn = await currentCheckInButton(page);
  await check(page, "F: with no sticker required, choosing On site enables the button",
    await btn.isEnabled().catch(() => null) === true);
  await btn.click();

  const refusalHeading = page.getByText(/not on the college network|network check|not at a campus|off.?campus/i);
  const refused = await visible(refusalHeading, 6000);

  if (refused) {
    // G. Exact copy from test plan §5: "You're not on the college network. Choose Online
    // if you're working remotely." (network_not_configured reads identically on purpose —
    // see the plan — so this assertion doesn't need to know which of the two fired.)
    console.log("--- G: On site was refused ---");
    await check(page, "G: a refusal banner names the problem", refused);
    await check(page, "G: the refusal ends by offering Online as the way out",
      await visible(page.getByText(/choose online/i), 2000));
  } else {
    // F. No refusal fired, so the switches this run has live are (or at least behave as)
    // all three off — the pre-feature button-just-clocks-you-in path.
    console.log("--- F: On site clocked in with no checks ---");
    await check(page, "F: pressing Check in (no sticker, no refusal) clocks in",
      await visible(page.getByText(CHECKED_STATE_RE), 8000));
  }
}

// ---------------------------------------------------------------------------------------
// Geofence — the coverage gap this file used to name and skip
// ---------------------------------------------------------------------------------------

/**
 * G above proves a refusal banner in general, driven off the network check because that
 * one needs nothing from the browser. This is the geofence's OWN banner, specifically: the
 * `off_campus` heading and advice, asserted by their own words rather than folded into G's
 * generic pattern — and, unlike every other section in this file, a config combination
 * this script CAN fully drive end to end, because context.setGeolocation removes the
 * flakiness a real GPS fix would have instead of making this script work around it.
 *
 * Needs staffTapEnabled=false, staffGeofenceCheck=true, staffNetworkCheck=false, and an
 * active campus with coordinates saved — see the "Geofence" entry in the switches comment
 * at the top of this file for how to set all four by hand; this function sets none of
 * them. Get any one wrong and this section SKIPs rather than false-passing or false-
 * failing, the same convention as every other branch in this file.
 */
async function sectionGeofence(page) {
  console.log("\n--- Geofence: refused far from campus, accepted at it ---");
  if (await alreadyCheckedInToday(page)) {
    skip("the geofence refusal and acceptance",
      "today's check-in already exists for this account. See the file header.");
    return;
  }

  // role=radio, not role=tab — see the comment on the radiogroup wait in signIn().
  const onsiteTab = page.getByRole("radio", { name: /on site/i });
  if (!(await visible(onsiteTab))) {
    await check(page, "an 'On site' radio option is present", false, "role=radio name=/on site/i not found");
    return;
  }
  await onsiteTab.click();

  // If a sticker is required, choosing On site opens the tap popup instead of leaving the
  // plain button this section needs — see walkOnsite()'s D/E branch. That is a config
  // mismatch, not a failure of this section, so it SKIPs rather than reporting red.
  const dialog = page.getByRole("dialog", { name: "Tap onsite" });
  if (await visible(dialog, 1500)) {
    skip("the geofence refusal and acceptance",
      "choosing On site opened the sticker popup instead of enabling the plain button — " +
      "staffTapEnabled is on for this run. Set it to false (staffGeofenceCheck stays true) " +
      "and re-run. The popup wrote nothing, so state is still fresh either way.");
    return;
  }

  // We are already spoofed far from the campus — main() grants the geolocation permission
  // and starts the position there when the page is created, specifically so this first
  // press needs no setGeolocation call of its own and nothing here has to wait on a
  // permission prompt appearing.
  const btn = await currentCheckInButton(page);
  await btn.click();

  // "not at a campus" rather than the full sentence with its apostrophe: matches the same
  // substring-without-punctuation convention G uses just above, so a curly vs. straight
  // apostrophe in the rendered HTML can never make this assertion fail over nothing.
  const offCampusHeading = page.getByText(/not at a campus/i);
  const refused = await visible(offCampusHeading, 6000);
  if (!refused) {
    // Branches rather than failing outright: with staffGeofenceCheck off for this run the
    // press either clocks straight in (F's path) or is refused for a DIFFERENT reason
    // (off-network, if that switch is the one live instead) — neither is a bug in the
    // screen, only a config that doesn't match what this section needs.
    const anyRefusal = await visible(page.getByText(/not on the college network|network check|off.?campus/i), 1500);
    skip("a position far from the campus produces the off_campus refusal banner",
      anyRefusal
        ? "a refusal appeared but not the off_campus one — staffNetworkCheck is probably " +
          "the switch that's live instead of staffGeofenceCheck for this run."
        : "no refusal appeared at all — staffGeofenceCheck is probably off for this run, " +
          "or no active campus has saved coordinates yet (that reads as campus_not_located, " +
          "not off_campus, and is worth checking for separately).");
    return;
  }
  await check(page, "a position far from the campus produces the off_campus refusal banner (heading)",
    refused);
  await check(page, "...and its advice offers Online as the way out",
    await visible(page.getByText(/choose online/i), 2000));

  // Move the spoofed position onto the campus and press again. Nothing was written by the
  // refusal above — checkPresence() in server/src/presence.js runs BEFORE the row is
  // touched — so the screen is still in the same fresh, not-checked-in state, same tab
  // still selected, same button still there.
  await page.context().setGeolocation(AT_CAMPUS);
  await btn.click();
  await check(page, "a position at the campus, with good accuracy, is accepted",
    await visible(page.getByText(CHECKED_STATE_RE), 8000));
}

// ---------------------------------------------------------------------------------------

async function main() {
  console.log(`Staff check-in walkthrough — ${CLIENT_URL}, staff=${STAFF_EMAIL}, headless=${HEADLESS}`);
  const browser = await chromium.launch({ channel: "msedge", headless: HEADLESS });
  // 1440x900 — the same desktop size scripts/screenshots.mjs uses, and large enough that
  // this is unambiguously the "desktop browser" H is asking about rather than a viewport
  // narrow enough to trip a handset breakpoint and change which shell renders.
  //
  // permissions/geolocation granted HERE, once, for the whole run — not only inside
  // sectionGeofence() — so that no section ever hits a live "grant location?" browser
  // prompt this headless-capable script has no way to click. It costs nothing for every
  // OTHER section: client/src/api.js's staffPositionIfNeeded() never touches the
  // geolocation API at all unless the college's geofence switch is on, so A, B/C and
  // D/E/F/G never read this value — only sectionGeofence() does, and it moves the spoofed
  // position onto the campus itself with context.setGeolocation() when it needs to.
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    permissions: ["geolocation"],
    geolocation: FAR_FROM_CAMPUS,
  });

  try {
    await signIn(page); // throws and stops the run on failure — see the file header

    // Onsite before Online — deliberately. See "STATE THIS SCRIPT CANNOT RESET" above:
    // running onsite first keeps Online's fresh-state assertions alive whenever onsite
    // lands on D/E or G, both of which write nothing.
    const fresh = await sectionFreshLoad(page);
    if (fresh) await walkOnsite(page);
    else skip("On site branch (D/E/F/G/H)", "screen was not in a fresh state at Section A");

    // Re-open the screen before the geofence section for the same reason as before Online
    // below: walkOnsite may have navigated inside a dialog or changed the card's state, and
    // a fresh navigation is more honest than trusting whatever it left behind.
    await page.reload({ waitUntil: "networkidle" });
    await visible(page.getByRole("radiogroup").or(page.getByText(CHECKED_STATE_RE)), 8000);
    await sectionGeofence(page);

    // Re-open the screen: the geofence section (or walkOnsite, if geofence SKIPped
    // straight through) may have written a check-in or left a dialog on screen.
    await page.reload({ waitUntil: "networkidle" });
    await visible(page.getByRole("radiogroup").or(page.getByText(CHECKED_STATE_RE)), 8000);
    await sectionOnline(page);
  } catch (e) {
    fail += 1;
    console.error("\n✗ FATAL:", e.message);
  } finally {
    await browser.close();
  }

  console.log(`\n${pass} passed, ${fail} failed${fail ? ` — screenshots in ${SHOT_DIR}` : ""}`);
  process.exit(fail ? 1 : 0);
}

main();
