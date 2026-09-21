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
// the Staff App home, whose tiles include "Daily Check-In" by that exact name (confirmed
// against scripts/screenshots.mjs's APP_SCREENS list, which enumerates it). A header
// toggle that used to let you flip between the two views from either entry point was
// removed — client/src/App.jsx says so in a comment at the spot it used to sit — so
// picking the right tile up front is not optional stage-setting, it is the only way in.
//
// WHAT THIS SCRIPT CANNOT SET FOR YOU — THE THREE SWITCHES
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
// before running the section that needs them. Section by section:
//   A            — any config; only requires the staff account not to be checked in today.
//   B / C        — Online is never checked (see test plan §1), so any config works.
//   D / E        — staffTapEnabled=true. staffNetworkCheck/staffGeofenceCheck don't matter.
//   F            — staffTapEnabled=false, staffNetworkCheck=false, staffGeofenceCheck=false
//                  (today's pre-feature behaviour — the button just clocks you in).
//   G            — staffTapEnabled=false, staffNetworkCheck=true. This script deliberately
//                  drives the NETWORK refusal rather than the geofence one: off-network
//                  needs nothing from the browser, while off-campus needs a granted
//                  geolocation permission and a spoofed position (`context.setGeolocation`)
//                  to avoid tripping `position_missing` instead — a real refusal, but the
//                  WRONG one, since position_missing's copy does not end by offering
//                  Online (see test plan §5). Geofence is structurally the same banner and
//                  is left as a follow-up rather than guessed at here.
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
  return visible(page.getByText(/checked in/i), 2000);
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

  // MobileAuth.jsx labels its inputs via a `Labelled` wrapper, same association pattern
  // as the standalone Login.jsx form — `getByLabel` needs that association to exist.
  const email = page.getByLabel("Email");
  if (!(await visible(email, 8000))) {
    await shot(page, "no-email-field-after-tile-click");
    throw new Error(
      "Sign-in gate: clicked the 'Staff App' tile but no Email field appeared within 8s. " +
      "This is the exact failure mode the tile-click-first ordering exists to catch — see " +
      "the file header. Refusing to continue."
    );
  }
  await email.fill(STAFF_EMAIL);
  await page.getByLabel("Password").fill(STAFF_PASSWORD);
  await page.getByRole("button", { name: /^sign in$/i }).click();

  // The gate itself: proof we actually reached the Staff App home, not just that the
  // click landed somewhere. A wrong password fails silently into an error banner on the
  // SAME form — no exception, no navigation — so waiting for the home screen's own tile
  // is what actually catches that, rather than waiting for the login form to disappear
  // (which a stuck error state never does either way).
  const dailyCheckInTile = page.getByRole("button", { name: /daily check-in/i });
  if (!(await visible(dailyCheckInTile, 15000))) {
    await shot(page, "sign-in-did-not-reach-staff-home");
    throw new Error(
      "Sign-in gate: signed the form but never reached a Staff App home carrying a " +
      "'Daily Check-In' tile within 15s. Likely causes: wrong credentials (check " +
      "STAFF_EMAIL/STAFF_PASSWORD env vars against the seed — see docs/testing/…md §2.1), " +
      "the seed hasn't been run against this database, or a second factor (TOTP) is " +
      "configured on this account and this script doesn't handle it. Refusing to " +
      "continue rather than asserting against whatever screen this actually is."
    );
  }
  console.log("✓ signed in and reached the Staff App home");
  await dailyCheckInTile.click();
  await visible(page.getByRole("tablist"), 8000); // let the screen finish mounting
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

  const onlineTab = page.getByRole("tab", { name: /online/i });
  if (!(await visible(onlineTab))) {
    await check(page, "an 'Online' tab is present", false, "role=tab name=/online/i not found");
    return;
  }
  await onlineTab.click();
  await check(page, "Online is now the selected tab",
    (await onlineTab.getAttribute("aria-selected")) === "true");

  const btn = await currentCheckInButton(page);
  await check(page, "B: choosing Online enables the Check in button",
    await btn.isEnabled().catch(() => null) === true);

  await btn.click();
  // "Clocked in" is read from the card, not from a toast — a toast can fire and fade
  // before this line runs; the card's own state is what a person re-opening the screen
  // a minute later would actually see, which is the thing worth proving.
  await check(page, "C: the card shows a checked-in state after pressing Check in",
    await visible(page.getByText(/checked in/i), 8000));
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

  const onsiteTab = page.getByRole("tab", { name: /on site/i });
  if (!(await visible(onsiteTab))) {
    await check(page, "an 'On site' tab is present", false, "role=tab name=/on site/i not found");
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
    // D + H, collapsed into one branch. The plan's D row describes the popup saying
    // "tap the NFC sticker" and its H row describes the SAME popup, in a desktop browser,
    // saying to use the app instead — because a browser cannot read a sticker. This
    // script only ever drives a desktop Edge browser (see the launch call in main()), so
    // it can only ever observe H's wording: `Capacitor.isNativePlatform()` (or whatever
    // the real screen uses to tell native from web) is false here on purpose, the same
    // way it would be for a real person on a laptop. Producing D's literal "tap the
    // sticker" copy would need the Capacitor-wrapped app on a real handset — which
    // test plan §9 already lists as unproven, for the same underlying reason a physical
    // NFC tap is unproven there. That gap is inherited here rather than papered over with
    // a wording this script cannot actually make happen.
    console.log("--- D+H: On site opened the sticker dialog immediately ---");
    await check(page, "D: the dialog opens immediately on choosing On site (no extra click needed)",
      dialogOpened);
    await check(page, "H: in a desktop browser, the dialog says to use the app rather than tap here",
      await visible(dialog.getByText(/app/i), 2000));

    // E: dismiss it, then prove the button now reads the "reopen" state rather than
    // becoming a normal enabled button. There is no name given for a close control in the
    // plan, so this tries the common accessible patterns rather than guessing a testid
    // that doesn't exist yet.
    const closeBtn = dialog.getByRole("button", { name: /close|dismiss|got it|ok/i });
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
      await visible(page.getByText(/checked in/i), 8000));
  }
}

// ---------------------------------------------------------------------------------------

async function main() {
  console.log(`Staff check-in walkthrough — ${CLIENT_URL}, staff=${STAFF_EMAIL}, headless=${HEADLESS}`);
  const browser = await chromium.launch({ channel: "msedge", headless: HEADLESS });
  // 1440x900 — the same desktop size scripts/screenshots.mjs uses, and large enough that
  // this is unambiguously the "desktop browser" H is asking about rather than a viewport
  // narrow enough to trip a handset breakpoint and change which shell renders.
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    await signIn(page); // throws and stops the run on failure — see the file header

    // Onsite before Online — deliberately. See "STATE THIS SCRIPT CANNOT RESET" above:
    // running onsite first keeps Online's fresh-state assertions alive whenever onsite
    // lands on D/E or G, both of which write nothing.
    const fresh = await sectionFreshLoad(page);
    if (fresh) await walkOnsite(page);
    else skip("On site branch (D/E/F/G/H)", "screen was not in a fresh state at Section A");

    // Re-open the screen: walkOnsite may have navigated inside a dialog, and F may have
    // just changed the card's state. A fresh navigation is more honest than trusting
    // in-page state left over from whichever onsite branch ran.
    await page.reload({ waitUntil: "networkidle" });
    await visible(page.getByRole("tablist").or(page.getByText(/checked in/i)), 8000);
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
