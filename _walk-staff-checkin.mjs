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
// STATE THIS SCRIPT USED TO BE UNABLE TO RESET — AND WHY IT NOW CAN
// THIS COMMENT USED TO SAY that a successful check-in (Online or On-site) writes a real
// `CheckIn` row for today, that nothing in this script clears it, and that a second run
// against the same account would therefore find it already checked in and SKIP every
// assertion needing a fresh state. That was true right up until the first real run against
// a genuinely fresh account proved the actual cost of it: Section F clocks the account in,
// and every section after F found `CheckInScreen` already rendered its checked-in state —
// no radio group on the page at all — and failed on "role=radio ... not found" rather than
// on anything the product did wrong. Skipping was the honest answer for a SECOND run today;
// it was never the honest answer for the FIRST section to write a row on the SAME run.
//
// The gap is closed by reaching past the API into the same database the smoke suites
// already use — see "Database access" below for `clearTodayRow()` and
// `resetToFreshScreen()`, and for why an "un-clock-in" API route was deliberately not
// invented to serve this instead. `main()` now calls `resetToFreshScreen()` before the
// first section that needs a clean slate and after every section that might have written
// a row, plus once more in a `finally`, so an aborted run cannot leave the account
// clocked in and poison whatever runs against it next.
//
// The onsite-before-Online ORDERING kept below is no longer load-bearing the way it used
// to be (each section now gets its own guaranteed-fresh start), but it is kept anyway: it
// still matches the order a person reading the test plan's §3.2 table would work through
// by hand, and reordering it would be change for its own sake.
//
// `alreadyCheckedInToday()` (below) still exists too, as a second, cheaper check each
// section makes for itself before asserting — defence in depth against a DATABASE_URL
// that turns out to point somewhere the delete didn't reach, not the primary mechanism
// any more.
import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
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
 * The Staff App home's "Clock in" nav control, scoped to the bottom tab bar's `<nav>`
 * landmark. Shared by signIn() (which clicks it once, from a fresh sign-in) and
 * goToCheckIn() (which clicks it again after every page.reload(), for a reason explained
 * on that function) so there is exactly one place this selector is written rather than two
 * copies that can quietly drift apart — see access-control.md's ADMIN_PAGES for what that
 * drift costs elsewhere in this codebase. See the long comment inside signIn() (kept
 * there, where it's first used) for why this is scoped to `<nav>` rather than matched on
 * name alone.
 */
function clockInTabLocator(page) {
  return page.getByRole("navigation").getByRole("button", { name: "Clock in", exact: true });
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

/** Whether today's card already shows a completed check-in. Checked before sections that
 * need a fresh screen — belt-and-braces alongside `resetToFreshScreen()` below, which is
 * what actually GUARANTEES a fresh screen now; see the file header for the history. */
async function alreadyCheckedInToday(page) {
  return visible(page.getByText(CHECKED_STATE_RE), 2000);
}

// ---------------------------------------------------------------------------------------
// Database access — clearing today's CheckIn row between sections
// ---------------------------------------------------------------------------------------
//
// The bridge is IDENTICAL to the one scripts/smoke-nfc-tap.mjs uses (read that file's own
// header for the fuller version of this reasoning): `createRequire`, anchored at
// server/package.json so Node resolves `require()` calls as if this code lived inside
// server/, walked up to server/'s OWN node_modules for `@prisma/client` rather than this
// script needing its own separate `npm install` at the repo root just to hold one package.
//
// DATABASE_URL IS REQUIRED, exactly as database-safety.md requires for every other command
// in this repo that touches a database, and for the identical reason: never let a database
// connection fall through to whatever server/.env happens to point at, which — per that
// rule — has historically been a LIVE database. Passing it on the command line is the only
// route in; there is no fallback here on purpose.
if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL is required — this script now clears today's CheckIn row for the " +
    "signed-in staff member between sections (see \"Database access\" above), the same " +
    "way scripts/smoke-nfc-tap.mjs's clearDay() does. Point it at the local Postgres — " +
    "see database-safety.md — and pass it on the command line, never let it fall through " +
    "to server/.env:\n\n" +
    '  DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" node _walk-staff-checkin.mjs\n'
  );
  process.exit(1);
}

const require = createRequire(pathToFileURL(path.join(__dirname, "server", "package.json")));
// A BARE client, not the one the API writes through — this script only ever DELETES its
// own fixture's row with it, never plants or reads application state the way
// smoke-nfc-tap.mjs's bare client does, but the reasoning for using one is the same: this
// is test infrastructure reaching directly into storage, not a second implementation of
// the API.
const { PrismaClient } = require(path.join(__dirname, "server", "node_modules", "@prisma", "client"));
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

// Dates are strings, `YYYY-MM-DD`, in APP_TIMEZONE — never the host clock — per
// conventions.md, and copied verbatim from scripts/smoke-nfc-tap.mjs's own `todayLocal()`
// rather than re-derived: a walkthrough run near midnight computing "today" one way while
// the server computes it another is exactly the kind of one-off drift that rule exists to
// prevent, and there is no reason this script's answer should risk disagreeing with the
// smoke suite's.
const todayLocal = () => new Date().toLocaleDateString("en-CA", { timeZone: process.env.APP_TIMEZONE || "Europe/London" });

// Resolved once and cached: the signed-in STAFF_EMAIL never changes mid-run, and looking
// it up again before every clear would be a database round trip this script has no reason
// to pay for eight times over.
let staffRowId = null;
async function currentStaffId() {
  if (staffRowId) return staffRowId;
  // findUnique, not findFirst: Staff.email carries `@@unique([email])` in schema.prisma —
  // single-tenant now, so unlike the tenant-scoped uniqueness single-tenant-history.md
  // describes as removed, this one really does mean "at most one row can match".
  const row = await db.staff.findUnique({ where: { email: STAFF_EMAIL }, select: { id: true } });
  if (!row) {
    throw new Error(
      `clearTodayRow(): no Staff row for ${STAFF_EMAIL} against this DATABASE_URL — is ` +
      "the seed loaded against the same database the app is running on? (see " +
      "docs/testing/…md §2.1)"
    );
  }
  staffRowId = row.id;
  return staffRowId;
}

/**
 * Deletes TODAY's CheckIn row for the signed-in staff member — nobody else's, and no
 * other date. SCOPED ON PURPOSE to `{ staffId, date: todayLocal() }`, matching
 * smoke-nfc-tap.mjs's own `clearDay()` exactly: the seeded fixtures carry historical
 * check-ins for OTHER staff that other suites read, and a broader `deleteMany` — by date
 * alone, or with no staffId filter at all — would silently destroy test data this script
 * has no business touching. DB only; does not touch the open page. Safe to call when no
 * row exists (deleteMany matching nothing is a no-op, not an error).
 */
async function clearTodayRow() {
  const id = await currentStaffId();
  await db.checkIn.deleteMany({ where: { staffId: id, date: todayLocal() } });
}

/**
 * Gets from wherever the app currently is back to the Daily Check-In screen, and waits
 * for it to mount. NEEDED AFTER EVERY page.reload() IN THIS FILE, and this is the second
 * real bug the coordinator's second run surfaced (not just the one it was diagnosed as):
 * `screen` in client/src/StaffHub.jsx is plain in-memory React state
 * (`const [screen, setScreen] = useState("home")`, ~line 522) — never a URL, a query
 * param or anything else a reload would restore. A reload does NOT return to whatever
 * screen was open; it always remounts the Staff App on "home". The signed-in SESSION does
 * survive — the auth token lives in storage (client/src/auth.jsx), not component state —
 * so a reloaded page is still signed in, just on the wrong screen.
 *
 * This is what the coordinator's second run actually hit. Their summary read the failure
 * as "F clocks the admin in, so the radios aren't rendered" — true as far as it goes, but
 * the log itself says otherwise about WHERE: `sectionGeofence()` checks
 * `alreadyCheckedInToday()` BEFORE it ever looks for a radio, and that check was already
 * confirmed working (CHECKED_STATE_RE, fixed last pass) — if the page had genuinely
 * reloaded back onto a checked-in Daily Check-In screen, that would have printed SKIP, not
 * the "✗ ... role=radio ... not found" the log actually shows. A checked-in-but-still-
 * checkin-screen and a HOME screen look identical to that one symptom (neither has a
 * radio), which is exactly why this needed reading `useState("home")` in the real file
 * rather than accepting the first explanation that fit the symptom.
 *
 * Both bugs were real and both needed fixing: the row genuinely needed clearing (a
 * checked-in Daily Check-In screen has no radios either), and the navigation genuinely
 * needed restoring (home has no radios full stop, cleared row or not).
 *
 * A THIRD layer sat under those two, and run 3 is what found it: even with a cleared row
 * and a re-click of the "Clock in" tab, this function still timed out — 30 real seconds,
 * on `clockInTab.click()` — because at a DESKTOP viewport, reloading as an ADMIN account
 * (client/src/App.jsx:509-518: `(isAdmin && !handset) ? "admin" : "app"`) lands on the
 * Executive Dashboard console instead of the staff app, where no "Clock in" tab exists to
 * click AT ALL. Fixed in main(), not here: the whole browser context now runs at a
 * HANDSET viewport, so `handset` reads true and an admin reload routes back into the
 * staff app like everyone else — see the long comment on `browser.newContext(...)` there
 * for the full reasoning. What belongs HERE is the guard just below: if a future
 * regression (a viewport change, a routing change, a different fixture account) ever
 * reintroduces a reload that lands somewhere without a "Clock in" tab, this should fail
 * in ~10 seconds with a message naming the cause, not in 30 with a bare Playwright
 * timeout that sends the next person to write their own throwaway probe script to find
 * out why — which is exactly what run 3 cost, and exactly what this guard is for.
 */
async function goToCheckIn(page) {
  const clockInTab = clockInTabLocator(page);
  if (!(await visible(clockInTab, 10000))) {
    const file = await shot(page, "not-on-staff-app");
    throw new Error(
      "goToCheckIn(): no 'Clock in' nav tab appeared within 10s — this page is not on " +
      "the Staff App. The most likely cause, and the one that has actually happened: " +
      "this browser is not running at a HANDSET viewport. client/src/App.jsx:509-518 " +
      "routes a signed-in ADMIN straight to the Executive Dashboard console instead " +
      "(`(isAdmin && !handset) ? \"admin\" : \"app\"`), which has no way back to the " +
      "staff app — probed directly: none of its buttons match " +
      "/staff app|my day|staff hub|back to staff|switch/i. main() must launch the " +
      "browser context at a handset-sized viewport (viewport, isMobile, hasTouch) for " +
      "exactly this reason; check that block hasn't reverted to a desktop size. " +
      `Screenshot: ${file}`
    );
  }
  await clockInTab.click();
  await visible(page.getByRole("radiogroup").or(page.getByText(CHECKED_STATE_RE)), 8000);
}

/**
 * `clearTodayRow()`, then a page reload, then back to the Daily Check-In screen — and
 * neither half is optional. `CheckInScreen` reads today's check-in out of
 * `store.checkins`, React state the page loaded once and keeps in memory, so deleting the
 * row in the database is invisible to a page that already rendered from a stale read
 * without a reload; and the reload itself lands on the Staff App HOME, not back on the
 * check-in screen, for the reason `goToCheckIn()` above explains — so a reload with
 * nothing after it is just as broken as no reload at all, in a different way.
 */
async function resetToFreshScreen(page) {
  await clearTodayRow();
  await page.reload({ waitUntil: "networkidle" });
  await goToCheckIn(page);
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
  const clockInTab = clockInTabLocator(page);
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
    // row describes the SAME popup, IN ANY BROWSER — including one sized and touch-enabled
    // like a phone, which this script now is (see main()'s viewport comment) — saying to
    // use the app instead, because a browser cannot read a sticker. Confirmed against
    // client/src/nfc.js: `const NATIVE = Capacitor?.isNativePlatform?.() === true;` and
    // `nfcStatus()` returns `{ ok: false, reason: "web" }` whenever `!NATIVE` — which is
    // unconditionally true in any browser, including this one, because
    // `Capacitor.isNativePlatform()` only ever answers true inside the Capacitor-wrapped
    // native shell. There is no browser flag, viewport size, user agent spoof or
    // Playwright option that changes that answer, because it isn't asking "does this look
    // like a phone" — it is asking whether the Capacitor native runtime bridge is present
    // at all, and in a browser it never is, handset-shaped or not.
    //
    // This script drives a real Edge browser (see the launch call in main()) — never the
    // packaged native app — so it can only ever observe H's wording, never D's. Producing
    // D's literal "tap the sticker" copy needs the Capacitor-wrapped app running on a real
    // handset — which test plan §9 already lists as unproven, for the same underlying
    // reason a physical NFC tap is unproven there. That gap is inherited here rather than
    // papered over with a wording this script cannot actually make happen.
    console.log("--- D+H: On site opened the sticker dialog immediately ---");
    await check(page, "D: the dialog opens immediately on choosing On site (no extra click needed)",
      dialogOpened);
    await check(page, "H: in a browser — not the packaged app — the dialog says to use the app rather than tap here",
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

  // A HANDSET viewport, not a desktop one — THIS COMMENT USED TO SAY the opposite, and
  // getting it wrong is what run 3 actually hit, two layers under the DB-clearing fix
  // above: client/src/App.jsx:509-518 routes a signed-in ADMIN straight to the Executive
  // Dashboard console at a desktop viewport — `(isAdmin && !handset) ? "admin" : "app"` —
  // a completely different UI with no way back to the staff app (probed for one: none of
  // its buttons match /staff app|my day|staff hub|back to staff|switch/i). The FIRST
  // navigation after sign-in survives this — client/src/App.jsx's `entry === "app"` path
  // from the Staff App landing tile overrides it, which is why signIn() above always
  // worked — but every `page.reload()` in this file re-evaluates `initialView` from
  // scratch with no `entry` to override it, so a desktop-viewport reload was routing the
  // (admin) fixture account straight past the screen this whole file is about, and
  // `goToCheckIn()` would then spend 30 real seconds hunting for a "Clock in" tab that
  // could never appear (see the guard it now raises instead, below).
  //
  // This is not a workaround for that bug — it is what the feature actually is. The spec
  // says plainly: "Onsite is phone-only. Staff clock in from the Android or iOS app." A
  // desktop-viewport walkthrough was testing a shape the feature was never built for; at
  // a handset viewport `useIsHandset()` (client/src/PhoneShell.jsx) reads true from its
  // `max-width: 640px` media query, `App.jsx` routes an admin reload back into the staff
  // app exactly like everyone else, and the routing this script needs to prove is the
  // one the product actually ships.
  //
  // D/H's own assertions below are UNAFFECTED by this change, and stay written the way
  // they were: `nfcStatus()` (client/src/nfc.js) keys on `Capacitor.isNativePlatform()`,
  // never on viewport size, so a handset-shaped browser still answers `reason: "web"` and
  // still renders "Use the app to tap in" — a real handset viewport proves nothing new
  // about the sticker's live listening state, and the hard boundary walkOnsite()
  // describes for that (browser vs. packaged app) is untouched.
  //
  // permissions/geolocation on the SAME context as the viewport, not a second
  // `browser.newPage()` call with its own options — one context, one set of grants, for
  // the life of the run. Granted here rather than only inside sectionGeofence() so no
  // section ever hits a live "grant location?" prompt this script has no way to click; it
  // costs nothing for every OTHER section, since client/src/api.js's
  // staffPositionIfNeeded() never touches the geolocation API unless the college's
  // geofence switch is on.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },   // iPhone 14-ish
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    permissions: ["geolocation"],
    geolocation: FAR_FROM_CAMPUS,
  });
  const page = await context.newPage();

  try {
    await signIn(page); // throws and stops the run on failure — see the file header

    // GUARANTEED fresh before the first section that needs it — not "probably fresh
    // because nothing has run yet". A previous manual run, a previous automated run that
    // died mid-way, or simply this same account having clocked in earlier today for real
    // reasons would otherwise reach Section A already checked in. See
    // "STATE THIS SCRIPT USED TO BE UNABLE TO RESET" and resetToFreshScreen() above.
    await resetToFreshScreen(page);

    // Onsite before Online — kept for readability (it matches the test plan's own
    // section order); no longer load-bearing for state the way the file header used to
    // describe, since every section below now gets its own guaranteed-fresh start.
    const fresh = await sectionFreshLoad(page);
    if (fresh) await walkOnsite(page);
    else skip("On site branch (D/E/F/G/H)", "screen was not in a fresh state at Section A");

    // walkOnsite's F branch may have just clocked the account in for real — clear it
    // before the geofence section, which needs its OWN fresh start (and its acceptance
    // case writes a row of its own before this run reaches Online).
    await resetToFreshScreen(page);
    await sectionGeofence(page);

    // sectionGeofence's acceptance case may have just clocked the account in too.
    await resetToFreshScreen(page);
    await sectionOnline(page);
  } catch (e) {
    fail += 1;
    // A screenshot HERE, not just at the specific throw sites that already take one of
    // their own (the sign-in gate's three, goToCheckIn()'s new one). THIS COMMENT USED TO
    // NOT EXIST, and the gap it fills is exactly what run 3 cost: a bare Playwright
    // timeout (`locator.click: Timeout 30000ms exceeded`) has no shot() call anywhere
    // upstream of it, so the FATAL line alone said nothing about what was actually on
    // screen when it happened — finding out took a separate, throwaway probe script and
    // two rounds of back-and-forth. One screenshot, unconditionally, on every path into
    // this catch, answers "what did the page actually show" immediately instead. Never
    // itself allowed to throw — shot() already swallows its own screenshot failure — so
    // there is nothing here that could mask the real error being reported below it.
    const file = await shot(page, "FATAL");
    console.error("\n✗ FATAL:", e.message);
    console.error("   screenshot:", file);
  } finally {
    // HOWEVER the run ended — a clean pass, a caught FATAL above, or an exception this
    // try/catch didn't anticipate — leave nothing behind. Skipping this would clock the
    // account in for the rest of the day and poison every fresh-state assertion on the
    // NEXT run, silently: alreadyCheckedInToday() would just start reading true and every
    // guarded section would SKIP with no clue that this run, not the product, caused it.
    // Caught rather than awaited-and-left-to-throw: a cleanup failure must not mask
    // whatever this run already found, and there is nothing more useful to do with it
    // than tell the person running the script.
    await clearTodayRow().catch((cleanupErr) => console.error("cleanup: could not clear today's CheckIn row —", cleanupErr.message));
    await db.$disconnect().catch(() => {});
    await browser.close();
  }

  console.log(`\n${pass} passed, ${fail} failed${fail ? ` — screenshots in ${SHOT_DIR}` : ""}`);
  process.exit(fail ? 1 : 0);
}

main();
