// Staff check-in under load — what happens when two requests are actually at the same
// instant, which no sequential HTTP test can ever exercise no matter how many
// assertions it carries.
//
// smoke-nfc-tap.mjs proves BEHAVIOUR: given a request, is the right thing refused or
// written. This script proves something orthogonal — that three guards in
// routes/checkins.js are STRUCTURAL rather than a single `if` a reviewer could spot
// missing, and that they hold when two callers genuinely collide rather than merely
// arrive close together:
//
//   * `@@unique([staffId, date])` + `prisma.checkIn.upsert(...)` in POST /check-in —
//     "upsert (not create) closes the race where two concurrent check-ins both pass
//     the existence check and the second create() violates the unique constraint",
//     in the route's own words.
//   * the SAME unique constraint, guarded a second way in POST /tap-check-in: a plain
//     `create()` wrapped in a catch for Postgres error P2002, which reads back
//     whoever won and reports their row rather than a 500.
//   * `prisma.checkIn.updateMany({ where: { ..., timeIn: "" }, data: {...} })` — the
//     WHERE clause, not merely the read beforehand, is what stops a second tap
//     against a `timeIn === ""` summary-first row from moving the arrival time a
//     first tap already wrote.
//
// A test that fires these sequentially proves nothing: two requests that never
// actually overlap can't race, so the assertion would pass identically with the
// guard deleted. Every block below that tests one of these THREE guards fires its
// calls with `Promise.all`, never `await`ed one after another, and asserts what the
// DATABASE actually holds afterwards — not just the HTTP status, because two calls
// can both answer 200 while two rows exist underneath them.
//
// THE RATE LIMITER (S1/S2/S8) is a different kind of concurrency question and is
// handled without any of that hedging, because it doesn't need it: `staffTapAllowed()`
// in checkins.js is a plain synchronous function with no `await` inside it, and
// Node's event loop cannot interleave two synchronous calls — whichever concurrent
// request's turn it is, that call runs start-to-finish, reads and mutates the
// in-process Map, and only then yields back. So the budget accounting is exactly
// correct under real concurrency; what this script actually tests is whether the
// ROUTE consults the limiter at the right point (ahead of the presence check, ahead
// of "already checked in") — see checkins.js's own comment on `staffTapHits`, which
// says this is a per-process Map and would need Redis behind a load balancer. One
// process is what both this script and the dev server are.
//
// WHAT A FAILURE IN ANY OF S3/S4/S5 MEANS FOR A REAL COLLEGE: these three write the
// row a payroll or an attendance audit reads back as "when did this person arrive".
// A second row is a duplicate clock-in nobody asked for; a moved arrival time is a
// falsified one — not obviously wrong, just quietly wrong, in whichever direction the
// losing request's clock happened to read.
//
// RUNS AGAINST AN ALREADY-RUNNING API, unlike `npm test`, which boots its own on
// port 4010 and tears it down again. This script does neither: it expects
// `API_URL` (default http://localhost:4000/api) to already be answering, and expects
// the database it points at to already be seeded — specifically that
// admin@edtech.co.uk exists, which `npm test -- smoke-nfc-tap` (or any suite) leaves
// behind. See docs/testing/2026-09-21-staff-check-in-e2e-test-plan.md section 8 for
// how to bring the app up first.
//
// MUST NOT RUN AT THE SAME TIME AS A SMOKE SUITE, OR A SECOND COPY OF ITSELF. This
// isn't a port issue — this script never binds one — it's a shared-state issue: every
// block below flips the college-wide `AttendanceTapConfig` row through the real
// `PUT /tags/settings` (never written directly, because attendanceTapConfig.js caches
// it for 30 seconds and a direct write would leave the running API serving a stale
// answer for half a minute — the same reasoning smoke-nfc-tap.mjs's header gives),
// and S8 pins real coordinates onto a real Campus row. Two runs' settings flips
// interleaving would leave the feature in whatever state the losing run's cleanup
// last wrote, and a campus left located by one run corrupts the geofence assertions
// of whichever suite runs next — smoke-nfc-tap.mjs's cleanup() explains the same
// hazard at length for exactly the same fixture.
//
//   DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" \
//   API_URL="http://localhost:4000/api" node scripts/stress-staff-checkin.mjs
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "..", "server");
const require = createRequire(pathToFileURL(join(server, "package.json")));

const BASE = process.env.API_URL || "http://localhost:4000/api";
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required — point it at the same database the API you are stress-testing is running against.");
  process.exit(1);
}

const { PrismaClient } = require(join(server, "node_modules", "@prisma", "client"));
const bcrypt = require(join(server, "node_modules", "bcryptjs"));
// A BARE client, not the one the API writes through, so this script can read back what
// the API actually committed to the database rather than what its HTTP response
// claims — the entire point of S3/S4/S5 is that those can disagree under a race.
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const SEED_PASSWORD = process.env.SEED_PASSWORD || "test-seed-password-2026";
// One password, one hash, reused across every fixture staff account this script
// creates — there is nothing account-specific about it and hashing it 65 times would
// only slow the run down for no safety gained.
const STRESS_PASSWORD = "stress-checkin-suite-2026";
const STRESS_HASH = bcrypt.hashSync(STRESS_PASSWORD, 10);
const RUN = Date.now().toString(36);

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

async function call(path, { method = "GET", body, token, from, device } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  // See smoke-nfc-tap.mjs for why this works here and could not in production: the API
  // runs under `trust proxy: 1`, trusting exactly one hop. This script IS that one hop
  // (there is no real proxy in front of a locally-run dev server), so the header lands
  // where Express reads the caller's address from.
  if (from) headers["X-Forwarded-For"] = from;
  if (device) headers["X-Device-Id"] = device;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch (_) { /* empty body */ }
  return { status: res.status, data };
}

const login = (email, password) => call("/auth/login", { method: "POST", body: { email, password } });
const setSettings = (patch) => call("/tags/settings", { method: "PUT", token: adminTokenRef.token, body: patch });

// today() in the college's own zone — src/clock.js pins APP_TIMEZONE, never the host
// clock, and this has to agree with it or every date comparison below is off by one
// near midnight.
const todayLocal = () => new Date().toLocaleDateString("en-CA", { timeZone: process.env.APP_TIMEZONE || "Europe/London" });

// TEST-NET-2 and TEST-NET-3 — the same two addresses smoke-nfc-tap.mjs's staff-presence
// block uses for "at home" and "on the college network", reused deliberately so a stray
// row left by either script reads identically to a human triaging the tap log.
const AT_HOME = "198.51.100.9";
const ON_COLLEGE_NET_RANGE = "203.0.113.0/24";
// London and Manchester, matching smoke-nfc-tap.mjs's own geofence fixtures exactly —
// this is the campus coordinate that suite also pins, and reusing the same value means
// a located-campus leak from either script is caught by the other's assertions rather
// than silently changing what "at campus" means.
const AT_CAMPUS_COORDS = { latitude: 51.5007, longitude: -0.1246 };
const FAR_AWAY = { latitude: 53.4808, longitude: -2.2426, accuracy: 20 };

// Everything this run creates. Staff accounts are tracked by id alone — CheckIn and
// TagTap carry no relation back to Staff worth walking (TagTap.staffId isn't even a
// foreign key, deliberately, per its schema comment: a tap can be refused before
// anybody is identified) — so cleanup deletes by staffId membership, not by id list
// per table.
const made = { staffIds: [], tagIds: [] };
let locatedCampusId = null;
let configExisted = false, priorConfig = null;
// A single mutable ref so `setSettings` above can close over the admin token before it
// exists yet — the alternative, threading `adminToken` through every call site, buys
// nothing here since this script (unlike smoke-nfc-tap.mjs) has exactly one admin
// identity for its whole run.
const adminTokenRef = { token: null };

/** Put a campus back to having no coordinates. Safe to call twice; never throws. */
async function unpinLocatedCampus() {
  if (!locatedCampusId) return;
  const id = locatedCampusId;
  locatedCampusId = null;
  await db.campus.update({ where: { id }, data: { latitude: null, longitude: null, locatedAt: null, locatedBy: null } })
    .catch(() => {});
}

/** Create `n` staff fixtures in ONE round trip and remember their ids for cleanup. */
async function makeStaff(entries) {
  await db.staff.createMany({
    data: entries.map((e) => ({
      id: e.id, name: e.name, jobTitle: "Lecturer", dept: "Stress Test",
      email: e.email, passwordHash: STRESS_HASH, initials: e.initials || "SS", colour: "#888888",
    })),
  });
  made.staffIds.push(...entries.map((e) => e.id));
}

/** One staff fixture, created and signed in — the common case for a dedicated account. */
async function freshStaff(label) {
  const id = `stress-${label}-${RUN}`;
  const email = `${id}@edtech.co.uk`;
  await makeStaff([{ id, email, name: `Stress ${label}`, initials: label.slice(0, 2).toUpperCase() }]);
  const { data } = await login(email, STRESS_PASSWORD);
  return { id, email, token: data?.token };
}

async function cleanup() {
  try {
    // The staff-presence fixture, first and unconditionally — matching
    // smoke-nfc-tap.mjs's ordering and its stated reason: a campus left with
    // coordinates on it doesn't just add a stray row, it changes what the NEXT
    // suite's geofence assertions mean.
    await unpinLocatedCampus();
    if (made.staffIds.length) {
      await db.tagTap.deleteMany({ where: { staffId: { in: made.staffIds } } }).catch(() => {});
      await db.checkIn.deleteMany({ where: { staffId: { in: made.staffIds } } }).catch(() => {});
    }
    // Tags after the taps that reference them (TagTap.tagId cascades, but deleting the
    // referencing rows explicitly first means this step never depends on the cascade
    // actually being configured the way the schema comment says it is).
    for (const id of made.tagIds) await db.attendanceTag.delete({ where: { id } }).catch(() => {});
    if (made.staffIds.length) {
      await db.staff.deleteMany({ where: { id: { in: made.staffIds } } }).catch(() => {});
    }
    // Put the tap config back exactly as it was. AttendanceTapConfig is this
    // deployment's ONE row (the "singleton" primary key — see configuration.md), so
    // there is nothing to filter on. Written directly here, unlike every settings
    // change during the run itself: the run is over, nothing is left to serve a
    // stale cached answer to, and this is the same trade-off smoke-nfc-tap.mjs's own
    // cleanup() makes for the identical reason.
    if (configExisted) {
      await db.attendanceTapConfig.updateMany({ data: { settings: priorConfig } }).catch(() => {});
    } else {
      await db.attendanceTapConfig.deleteMany({}).catch(() => {});
    }
  } catch (e) {
    console.error("cleanup problem:", e.message);
  }
}

try {
  const existingConfig = await db.attendanceTapConfig.findFirst({});
  configExisted = Boolean(existingConfig);
  priorConfig = existingConfig?.settings ?? {};

  const adminLogin = await login("admin@edtech.co.uk", SEED_PASSWORD);
  const adminToken = adminLogin.data?.token;
  if (!adminToken) {
    throw new Error(`admin sign-in failed (HTTP ${adminLogin.status}) — has this database been seeded? Run any suite once first (e.g. "npm test -- smoke-nfc-tap") to seed it.`);
  }
  adminTokenRef.token = adminToken;

  const today = todayLocal();

  // Two stickers, not one — S5 wants two distinguishable requests racing the same
  // sentinel row, and a shared tagCode would make the two calls indistinguishable in
  // the tap log if this script ever needs to debug a real failure here.
  const tagA = await call("/tags", { method: "POST", token: adminToken, body: { label: `Stress Tag A ${RUN}` } });
  const tagACode = tagA.data?.code;
  if (tagA.data?.id) made.tagIds.push(tagA.data.id);
  const tagB = await call("/tags", { method: "POST", token: adminToken, body: { label: `Stress Tag B ${RUN}` } });
  const tagBCode = tagB.data?.code;
  if (tagB.data?.id) made.tagIds.push(tagB.data.id);
  check("two stickers exist to test against",
    tagA.status === 201 && tagB.status === 201 && typeof tagACode === "string" && typeof tagBCode === "string",
    `HTTP ${tagA.status} / ${tagB.status}`);

  // Baseline: every check off. Row 1 of the configuration matrix — plain button, no
  // gates — is the state every block below returns to before moving on, so a test
  // earlier in this file can never leak a switch into one that runs after it.
  await setSettings({ staffTapEnabled: false, staffNetworkCheck: false, staffGeofenceCheck: false });

  /* ====================================================================== */
  console.log("\n--- S1: the rate limiter sits AHEAD of the presence check ---");
  /* ====================================================================== */
  //
  // If the presence check ran first, an off-network account could hammer this route
  // forever: every attempt would be a fresh 403 with a full budget behind it, and the
  // limiter — the thing meant to cap how fast tag codes can be tried — would never
  // once fire. Firing all eleven with Promise.all is what makes this a test of
  // ORDERING rather than of arithmetic: eleven awaited one after another would also
  // land on ten-and-one, but would do so whether the limiter runs first or last,
  // because a slow sequential loop gives the presence check no chance to matter
  // either way.
  {
    const s1 = await freshStaff("s1");
    check("S1 account signed in with an untouched tap budget", !!s1.token, s1.token ? "" : "login did not return a token");

    // No usable network for this account: staffNetworkCheck on, the range is real, and
    // every attempt below arrives from an address outside it.
    await setSettings({ staffTapEnabled: true, staffNetworkCheck: true, allowedNetworks: [ON_COLLEGE_NET_RANGE] });

    const s1Results = await Promise.all(
      Array.from({ length: 11 }, () =>
        call("/checkins/tap-check-in", { method: "POST", token: s1.token, from: AT_HOME, body: { tagCode: tagACode } })),
    );
    const s1Statuses = s1Results.map((r) => r.status);
    check("eleven concurrent taps from off the network: exactly one is rate-limited, ten are refused for presence",
      s1Statuses.filter((s) => s === 429).length === 1 && s1Statuses.filter((s) => s === 403).length === 10,
      `statuses: ${s1Statuses.join(",")}`);

    const offNetRows = await db.tagTap.count({ where: { staffId: s1.id, outcome: "off_network" } });
    const limitedRows = await db.tagTap.count({ where: { staffId: s1.id, outcome: "rate_limited" } });
    check("...and every one of the ten presence refusals is logged — the limiter cost them budget, it did not exempt them",
      offNetRows === 10 && limitedRows === 1,
      `off_network=${offNetRows} rate_limited=${limitedRows}`);
  }

  /* ====================================================================== */
  console.log("\n--- S2: the limiter is PER ACCOUNT, not a shared bucket ---");
  /* ====================================================================== */
  await setSettings({ staffTapEnabled: true, staffNetworkCheck: false, staffGeofenceCheck: false });
  {
    const s2a = await freshStaff("s2a");
    const s2b = await freshStaff("s2b");

    const s2aResults = await Promise.all(
      Array.from({ length: 10 }, () =>
        call("/checkins/tap-check-in", { method: "POST", token: s2a.token, body: { tagCode: tagACode } })),
    );
    check("account A's own ten taps all land — the first accepted, the rest 'already checked in', none rate-limited",
      s2aResults.every((r) => r.status === 200 || r.status === 201),
      `statuses: ${s2aResults.map((r) => r.status).join(",")}`);

    // If the Map above were keyed by IP, or by nothing at all, this would be the
    // eleventh request against the SAME budget and would come back 429 — the whole
    // point of firing it from a SECOND account.
    const s2b1 = await call("/checkins/tap-check-in", { method: "POST", token: s2b.token, body: { tagCode: tagACode } });
    check("account B, whose budget nothing above touched, succeeds immediately after A's is spent",
      s2b1.status === 201, `HTTP ${s2b1.status}`);
  }

  /* ====================================================================== */
  console.log("\n--- S3: two simultaneous check-in presses — the double-submit race ---");
  /* ====================================================================== */
  //
  // THE GUARD: `@@unique([staffId, date])`, closed by upsert rather than a
  // find-then-create. A FAILURE HERE LOOKS LIKE: two CheckIn rows for one person on
  // one day — a phone that double-tapped the button, or a flaky connection that
  // retried a request the server had already accepted — and a payroll or attendance
  // export built on "one row per staff per day" either double-counts the day or picks
  // one row arbitrarily and silently drops the other's timestamp.
  //
  // staffTapEnabled is OFF for this block specifically: while it's on, POST /check-in
  // answers every Onsite press with 409 `tap_required` before it ever reaches the
  // upsert, deterministically — not racily — so there would be no write for either
  // request to race over.
  await setSettings({ staffTapEnabled: false });
  {
    const s3 = await freshStaff("s3");
    const [s3a, s3b] = await Promise.all([
      call("/checkins/check-in", { method: "POST", token: s3.token, body: { site: "Onsite" } }),
      call("/checkins/check-in", { method: "POST", token: s3.token, body: { site: "Onsite" } }),
    ]);
    check("neither concurrent press errors", s3a.status < 500 && s3b.status < 500, `${s3a.status} / ${s3b.status}`);

    const s3Rows = await db.checkIn.findMany({ where: { staffId: s3.id, date: today } });
    check("THE GUARD: exactly one CheckIn row exists for this staff member today, never two",
      s3Rows.length === 1, `${s3Rows.length} row(s)`);
    check("...and both responses agree with the database on the single arrival time that was actually written",
      s3Rows[0] && s3a.data?.in === s3Rows[0].timeIn && s3b.data?.in === s3Rows[0].timeIn,
      `a=${s3a.data?.in} b=${s3b.data?.in} db=${s3Rows[0]?.timeIn}`);
  }

  /* ====================================================================== */
  console.log("\n--- S4: a tap and a button press fired at the same instant ---");
  /* ====================================================================== */
  //
  // THE GUARD: the SAME unique constraint as S3, but exercised from the OTHER route —
  // POST /tap-check-in's `create()` wrapped in a catch for Postgres error P2002,
  // racing POST /check-in's upsert for the same (staffId, date) row.
  //
  // Onsite-vs-Onsite cannot race here: with staffTapEnabled on, a button press for
  // Onsite is REFUSED — 409 `tap_required` — every time, not sometimes, so there is no
  // timing window to exploit and firing both concurrently would prove nothing but that
  // predicate. The genuinely concurrent write race reachable at this settings state is
  // the tap (Onsite, by construction) against a button press for Online, which is
  // never gated on staffTapEnabled. Both target the identical (staffId, date) row.
  //
  // A FAILURE HERE LOOKS LIKE: a member of staff who tapped the sticker in the
  // building, at almost the same moment their phone's stale tab also fires the button
  // for "Online" — not a contrived sequence, just an app that hasn't refreshed yet —
  // ending up with two rows, or with the tap's true Onsite arrival silently replaced
  // by the button's Online claim.
  await setSettings({ staffTapEnabled: true });
  {
    const s4 = await freshStaff("s4");
    const [s4Tap, s4Button] = await Promise.all([
      call("/checkins/tap-check-in", { method: "POST", token: s4.token, body: { tagCode: tagACode } }),
      call("/checkins/check-in", { method: "POST", token: s4.token, body: { site: "Online" } }),
    ]);
    check("neither concurrent request errors", s4Tap.status < 500 && s4Button.status < 500, `${s4Tap.status} / ${s4Button.status}`);

    const s4Rows = await db.checkIn.findMany({ where: { staffId: s4.id, date: today } });
    check("THE GUARD: exactly one CheckIn row, whichever of the two writes actually landed first",
      s4Rows.length === 1, `${s4Rows.length} row(s)`);
    check("...and the arrival time was written once — both responses report the SAME time the row actually holds",
      s4Rows[0] && s4Tap.data?.in === s4Rows[0].timeIn && s4Button.data?.in === s4Rows[0].timeIn,
      `tap=${s4Tap.data?.in} button=${s4Button.data?.in} db=${s4Rows[0]?.timeIn}`);
  }

  /* ====================================================================== */
  console.log("\n--- S5: two taps racing to fill a summary-first sentinel ---");
  /* ====================================================================== */
  //
  // THE GUARD: `updateMany({ where: { ..., timeIn: "" }, data: {...} })` — the
  // condition is part of the STATEMENT, not a read the route checks beforehand and
  // trusts. Two concurrent taps can both pass the earlier `existingToday.timeIn`
  // guard (both see the SAME pre-write row, which has timeIn === ""), so what stops
  // the second one from re-filling it is Postgres evaluating `timeIn = ''` against
  // whatever the row holds AT THE MOMENT its own UPDATE runs, after the first tap's
  // UPDATE has already committed and moved it off that value.
  //
  // A FAILURE HERE LOOKS LIKE: replace the guarded `updateMany` with a bare
  // `checkIn.update()` (no WHERE re-check) and BOTH concurrent taps write
  // unconditionally — whichever one's UPDATE statement commits SECOND silently
  // overwrites the first one's timeIn and tagId, with no error and no 500, because the
  // route's own logic never learns it wasn't the only writer. The payroll record ends
  // up holding the LATER of two genuine arrival times, understating hours on site —
  // and the sticker actually touched first would read from the log as the one that
  // "didn't work", because the log's tagId belongs to whichever tap won the overwrite,
  // not whichever tap the person on site actually pressed.
  {
    const s5 = await freshStaff("s5");
    const sentinel = await db.checkIn.create({ data: { staffId: s5.id, date: today, timeIn: "", summary: `stress fixture ${RUN}` } });

    const [s5a, s5b] = await Promise.all([
      call("/checkins/tap-check-in", { method: "POST", token: s5.token, body: { tagCode: tagACode } }),
      call("/checkins/tap-check-in", { method: "POST", token: s5.token, body: { tagCode: tagBCode } }),
    ]);
    check("neither concurrent tap errors", s5a.status < 500 && s5b.status < 500, `${s5a.status} / ${s5b.status}`);

    const s5Row = await db.checkIn.findUnique({ where: { id: sentinel.id } });
    check("THE GUARD: the sentinel is filled exactly once — a real time, not the blank it started as",
      !!s5Row && s5Row.timeIn !== "" && /^\d{2}:\d{2}$/.test(s5Row.timeIn),
      `timeIn=${JSON.stringify(s5Row?.timeIn)}`);
    check("...and the second tap never rewrote it — the tag on the row is one of the two used, and both responses agree with the database",
      !!s5Row && [tagA.data?.id, tagB.data?.id].includes(s5Row.tagId)
        && s5a.data?.in === s5Row.timeIn && s5b.data?.in === s5Row.timeIn,
      `tagId=${s5Row?.tagId} a=${s5a.data?.in} b=${s5b.data?.in} db=${s5Row?.timeIn}`);
  }

  /* ====================================================================== */
  console.log("\n--- S6: fifty staff clocking in at once ---");
  /* ====================================================================== */
  await setSettings({ staffTapEnabled: false, staffNetworkCheck: false, staffGeofenceCheck: false });
  {
    const S6_COUNT = 50;
    // ONE createMany, not fifty round trips — the instruction this block exists to
    // follow, and the reason is more than tidiness: fifty sequential creates would
    // spread this block's actual concurrent moment (the check-ins themselves) across
    // however long fifty awaited inserts take, which is exactly the sequential-test
    // trap this whole script otherwise avoids.
    const entries = Array.from({ length: S6_COUNT }, (_, i) => ({
      id: `stress-s6-${i}-${RUN}`, email: `stress-s6-${i}-${RUN}@edtech.co.uk`, name: `Stress S6 ${i}`, initials: "S6",
    }));
    await makeStaff(entries);

    const logins = await Promise.all(entries.map((e) => login(e.email, STRESS_PASSWORD)));
    const tokens = logins.map((r) => r.data?.token);
    check("all fifty stress accounts signed in", tokens.every(Boolean), `${tokens.filter(Boolean).length}/${S6_COUNT}`);

    const results = await Promise.all(
      entries.map((e, i) => call("/checkins/check-in", { method: "POST", token: tokens[i], body: { site: "Onsite" } })),
    );
    check("every one of the fifty concurrent clock-ins succeeds",
      results.every((r) => r.status === 200 || r.status === 201),
      `statuses seen: ${[...new Set(results.map((r) => r.status))].join(",")}`);

    const rows = await db.checkIn.findMany({ where: { staffId: { in: entries.map((e) => e.id) }, date: today }, select: { staffId: true } });
    const distinctStaff = new Set(rows.map((r) => r.staffId));
    check("...and each of the fifty gets EXACTLY their own row — no cross-contamination of staffId under load",
      rows.length === S6_COUNT && distinctStaff.size === S6_COUNT,
      `${rows.length} row(s), ${distinctStaff.size} distinct staffId(s)`);
  }

  /* ====================================================================== */
  console.log("\n--- S7: an administrator flips a switch while clock-ins are in flight ---");
  /* ====================================================================== */
  //
  // Not a structural-guard test like S3-S5 — there is no invariant on the SETTINGS row
  // to defend the way there is on CheckIn. What this proves is narrower and still
  // worth proving: attendanceTapConfig.js's 30-second cache and its invalidate-on-save
  // must not turn a mid-flight settings change into a 500 for whoever's request is
  // caught reading the config at the wrong moment. The settings PUT is fired IN THE
  // SAME Promise.all as the clock-ins, not before them, so the flip genuinely races
  // the reads instead of merely preceding them.
  await setSettings({ staffTapEnabled: false, staffNetworkCheck: false, staffGeofenceCheck: false });
  {
    const S7_COUNT = 8;
    const entries = Array.from({ length: S7_COUNT }, (_, i) => ({
      id: `stress-s7-${i}-${RUN}`, email: `stress-s7-${i}-${RUN}@edtech.co.uk`, name: `Stress S7 ${i}`, initials: "S7",
    }));
    await makeStaff(entries);
    const tokens = (await Promise.all(entries.map((e) => login(e.email, STRESS_PASSWORD)))).map((r) => r.data?.token);

    // Half press the button, half tap — both code paths are live no matter which way
    // staffTapEnabled lands, so this exercises the read race on both routes at once.
    const calls = [
      ...entries.slice(0, 4).map((e, i) => call("/checkins/check-in", { method: "POST", token: tokens[i], body: { site: "Onsite" } })),
      ...entries.slice(4).map((e, i) => call("/checkins/tap-check-in", { method: "POST", token: tokens[i + 4], body: { tagCode: tagACode } })),
      setSettings({ staffTapEnabled: true }),
    ];
    const results = await Promise.all(calls);
    const statuses = results.map((r) => r.status);
    check("nothing 500s while the switch is flipped mid-flight",
      statuses.every((s) => s < 500), `statuses: ${statuses.join(",")}`);
    check("every response is a well-formed 2xx or 4xx — nothing the client can't render a banner for",
      statuses.every((s) => (s >= 200 && s < 300) || (s >= 400 && s < 500)),
      `statuses: ${statuses.join(",")}`);

    const settingsAfter = await call("/tags/settings", { token: adminToken });
    check("the settings row itself survives the race, still shaped like a settings object",
      settingsAfter.status === 200
        && typeof settingsAfter.data?.staffTapEnabled === "boolean"
        && typeof settingsAfter.data?.enabled === "boolean",
      JSON.stringify(settingsAfter.data));
  }

  /* ====================================================================== */
  console.log("\n--- S8: repeated presence refusals are still capped, and every one is logged ---");
  /* ====================================================================== */
  //
  // Distinct from S1: S1 proves ORDERING (the limiter runs before the presence check).
  // This proves COMPLETENESS under the same load — that heavy probing against a
  // presence rule is capped exactly like probing tag codes is, AND that every single
  // attempt, refused or rate-limited, leaves a TagTap row. An administrator reading
  // the tap log to answer "why can't this person clock in" needs the full count, not
  // a sample — a silently-dropped refusal row is indistinguishable from a person who
  // never tried at all.
  await setSettings({ staffTapEnabled: true, staffNetworkCheck: false, staffGeofenceCheck: true, geofenceRadiusM: 250 });
  {
    const campus = await db.campus.findFirst({ where: { active: true }, select: { id: true, name: true } });
    check("a campus exists to locate for this block", !!campus, JSON.stringify(campus));

    if (campus) {
      await db.campus.update({
        where: { id: campus.id },
        data: { ...AT_CAMPUS_COORDS, locatedAt: new Date(), locatedBy: "stress-staff-checkin" },
      });
      // Remembered so cleanup() can unpin it even if this block throws half way
      // through — the same reasoning smoke-nfc-tap.mjs gives for the identical fixture.
      locatedCampusId = campus.id;

      const s8 = await freshStaff("s8");
      const S8_ATTEMPTS = 15;
      const s8Results = await Promise.all(
        Array.from({ length: S8_ATTEMPTS }, () =>
          call("/checkins/tap-check-in", { method: "POST", token: s8.token, body: { tagCode: tagACode, position: FAR_AWAY } })),
      );
      const s8Statuses = s8Results.map((r) => r.status);
      check("fifteen attempts from off campus: ten refused for presence, five capped by the limiter",
        s8Statuses.filter((s) => s === 403).length === 10 && s8Statuses.filter((s) => s === 429).length === 5,
        `statuses: ${s8Statuses.join(",")}`);

      const s8LogCount = await db.tagTap.count({ where: { staffId: s8.id } });
      check("EVERY attempt appears in TagTap — the refusals and the rate-limited ones alike, none silently dropped",
        s8LogCount === S8_ATTEMPTS, `${s8LogCount} row(s) logged, ${S8_ATTEMPTS} attempt(s) made`);

      await unpinLocatedCampus();
    } else {
      console.log("SKIP  no active campus in this database — the geofence half of S8 is not exercised");
    }
    await setSettings({ staffGeofenceCheck: false });
  }
} catch (e) {
  console.error("\nscript error:", e.message);
  fail++;
} finally {
  await cleanup();
  await db.$disconnect();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
