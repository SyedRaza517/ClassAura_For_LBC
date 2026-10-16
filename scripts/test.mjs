// The whole test suite, as one command:  npm test
//
// Until now the smoke suites could only be run by hand, one at a time, against a
// server someone had already started — which meant in practice they were run
// rarely, and never on a change that "obviously" didn't need them. This boots its
// own API against its own database, runs every suite, and returns a single
// pass/fail. That is what makes them usable from CI.
//
//   npm test                     # start an API, seed, run everything
//   SMOKE_SCOPED_DEPARTMENT=1 npm test
//                                # the same, but with every seeded account narrowed to one
//                                # academic department that owns every seeded course. Every
//                                # assertion should still pass; the point is that the
//                                # guard's FILTERED branch actually executes, which it
//                                # otherwise never does.
//   npm test -- smoke-invite     # only suites matching a name
//   API_URL=https://… npm test   # run against an ALREADY-RUNNING API (skips boot)
//
// Exit code is 0 only if every suite passed, so CI can gate on it.
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = join(root, "server");

// A suite that talks to no API and needs no database. It stands in for Google's
// endpoints itself, so it runs anywhere — including before a database exists.
const STANDALONE = new Set(["smoke-push-transport.mjs"]);

const filter = process.argv.slice(2).filter((a) => !a.startsWith("-"));
// SUITES THAT CANNOT RUN UNDER SMOKE_SCOPED_DEPARTMENT=1, and exactly why.
//
// This list is deliberately short and deliberately annotated. "The suite fails under the
// flag" is not a reason to be on it — every suite that failed for a PRODUCT reason was fixed
// instead, and that is the whole value of the flag. These two cannot pass by construction:
//
//   smoke-academic-departments  Builds Business AND Computing fixtures and asserts the
//   smoke-academic-scope        boundary between them. Setting that up requires a
//                               college-wide admin — an admin narrowed to one department
//                               cannot create the other department's data to be refused
//                               from. They test scoping; they cannot be run scoped.
//
// smoke-nfc-tap and smoke-qr-checkin USED TO BE HERE. Both build their units through their
// own bare Prisma client, so their fixtures carried no department and were invisible to
// the narrowed admin they then signed in as — a fixture problem, never a product one. Since
// 5 Sep 2026 both stamp their fixtures with whatever department the signing-in admin is
// narrowed to (scripts/lib/fixture-department.mjs), so they run in both passes, and the QR
// suite additionally asserts the boundary itself: a narrowed admin cannot mint a code for
// another department's class and can for their own.
//   smoke-department-gaps       Same construction, and one step further: its whole subject
//                               is what a NARROWED admin is refused, so it creates its own
//                               narrowed account and needs a college-wide one to build the
//                               other department it is refused from. It also asserts the
//                               college-wide half of each pair (the audit trail served, a
//                               school retired rather than deleted), which no narrowed
//                               caller can reach by design.
const NOT_SCOPEABLE = new Set([
  "smoke-academic-departments.mjs",
  "smoke-academic-scope.mjs",
  "smoke-department-gaps.mjs",
]);
const scopedRun = process.env.SMOKE_SCOPED_DEPARTMENT === "1";

const suites = readdirSync(join(root, "scripts"))
  .filter((f) => f.startsWith("smoke-") && f.endsWith(".mjs"))
  .filter((f) => !filter.length || filter.some((q) => f.includes(q)))
  .filter((f) => !(scopedRun && NOT_SCOPEABLE.has(f)))
  .sort();

// Whether the unit-test blocks below will run. Hoisted above the bail deliberately:
// the filter is matched against smoke-suite FILENAMES, so `npm test -- unit` exited
// here with "No suite matches" and never reached the unit tests it named. The unit
// blocks were only reachable by a bare `npm test`, or by a filter that happened to
// drag in a smoke suite as well.
const runUnit = !filter.length || filter.some((q) => "unit".includes(q));

if (!suites.length && !runUnit) {
  console.error(filter.length ? `No suite matches: ${filter.join(", ")}` : "No suites found.");
  process.exit(1);
}

// An API URL supplied from outside means "test that deployment" — don't start one.
const external = Boolean(process.env.API_URL);
// The seed refuses anything under 12 characters, and the suites sign in as the
// accounts it creates — so one value has to reach both. Fixed (not random) so a
// failing run can be reproduced by hand against the same database.
const SEED_PASSWORD = process.env.SEED_PASSWORD || "test-seed-password-2026";
// Credential storage must be ON for the suites, or every assertion about per-college
// Moodle/SharePoint/email settings quietly tests the refusal path instead of the
// feature. Passed to BOTH the API and the suites: a suite that checks the key is never
// echoed back has to know what the key is.
const CREDENTIALS_KEY = process.env.CREDENTIALS_KEY || "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
// The API and the suites must agree on this one. smoke-qr-checkin derives codes locally
// through the server's own modules and checks them against the running API, and the QR
// signing key derives from the SESSION secret — so a suite left to fall back to the
// dev-only default while the API runs on the value below would fail every code it minted,
// for a reason that reads like a broken feature rather than a mismatched fixture.
const JWT_SECRET = process.env.JWT_SECRET || "test-secret-not-for-production";
const PORT = process.env.TEST_PORT || 4010;
const apiUrl = process.env.API_URL || `http://localhost:${PORT}/api`;

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd: server, stdio: "inherit", shell: process.platform === "win32", ...opts });

// Wait for the API to answer rather than sleeping a fixed time — a cold Prisma
// client and a first connection to a remote database vary by seconds.
async function waitForApi(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url.replace(/\/api$/, "") + "/api/health", { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

let child = null;
const stopApi = () => { if (child && !child.killed) { try { process.platform === "win32" ? spawnSync("taskkill", ["/pid", child.pid, "/f", "/t"]) : child.kill("SIGTERM"); } catch { /* already gone */ } } };
process.on("exit", stopApi);
process.on("SIGINT", () => { stopApi(); process.exit(130); });

if (!external) {
  if (!process.env.DATABASE_URL) {
    console.error("\n✗ DATABASE_URL is not set.\n" +
      "  These suites write real rows — point them at a THROWAWAY database, never production.\n" +
      "  In CI that is the Postgres service container; locally, a scratch database.\n");
    process.exit(1);
  }
  // Checked HERE as well as inside the seed, so the refusal arrives BEFORE migrations
  // are applied rather than after. migrate:deploy against the wrong database is not
  // destructive on its own, but it is still a schema change somewhere you did not mean
  // to make one, and failing early gives a clearer message than failing mid-run.
  createRequire(import.meta.url)(join(server, "prisma", "assertDisposable.js"))
    .assertDisposable("npm test applies migrations and seeds fixtures, deleting existing rows");
  if (!existsSync(join(server, "node_modules"))) {
    console.error("\n✗ server/node_modules missing — run `npm install` first.\n");
    process.exit(1);
  }

  console.log("→ applying migrations");
  if (run("npm", ["run", "migrate:deploy"]).status !== 0) { console.error("\n✗ migrations failed\n"); process.exit(1); }

  // The suites assert against the seeded fixtures by name and id (s1, s3,
  // admin@…, password123), so seeding is part of the setup, not optional.
  console.log("→ seeding fixtures");
  if (run("node", ["prisma/seed.js"], { env: { ...process.env, SEED_PASSWORD } }).status !== 0) { console.error("\n✗ seed failed\n"); process.exit(1); }

  // ---- Optionally narrow every seeded account to one academic department -------------
  //
  // THE GAP THAT LET SPEC 1 SHIP GREEN. Every suite signs in as an admin who is
  // college-wide, so scopePredicateFor returns null and the FILTERED path is never executed
  // once — 30 suites passed while the boundary leaked 194 attendance marks through a nested
  // include. Passing accounts through the guard's other branch is the only way that gets
  // caught by the tests rather than by an audit.
  //
  // The department is given EVERY seeded course, so every existing assertion should still
  // hold exactly as written. Any suite that fails under this flag has found a query the
  // scoping changed — a real finding, and the route is what gets fixed, never the guard.
  if (process.env.SMOKE_SCOPED_DEPARTMENT === "1") {
    console.log("→ narrowing every seeded account to one academic department");
    console.log(`  (skipping ${[...NOT_SCOPEABLE].join(", ")} — see NOT_SCOPEABLE for why)`);
    const r = run("node", ["prisma/scope-all-staff.js"], { env: { ...process.env } });
    if (r.status !== 0) { console.error("\n✗ could not narrow the seeded accounts\n"); process.exit(1); }
  }

  console.log(`→ starting API on port ${PORT}`);
  child = spawn("node", ["src/index.js"], {
    cwd: server,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: "test",
      JWT_SECRET,
      // No settings cache under test. attendanceTapConfig caches for 30s and invalidates
      // on save, which is correct in production — but the suites also write the settings
      // row DIRECTLY, and a direct write is exactly what an invalidate-on-save cache
      // cannot see. smoke-nfc-tap deletes the row to assert the never-configured college,
      // and read back a stale "switched on" for up to half a minute. That was invisible
      // while the seed left no row to cache, and surfaced the moment the seed started
      // creating one. Zero disables the cache outright; the variable exists for this.
      ATTENDANCE_TAP_CACHE_MS: "0",
      CREDENTIALS_KEY,
      // TENANT_CACHE_MS: "0" used to be set here. It existed for one suite:
      // smoke-tenant-isolation suspended an institution through the platform tier and
      // immediately checked it was locked out, and with the production 60s tenant cache
      // that assertion passed or failed on timing. Multi-tenancy is gone, that suite is
      // deleted, and the API reads no such variable — leaving it set would be a knob
      // nothing turns, which is how somebody later concludes caching is disabled here.
    },
  });
  let bootLog = "";
  child.stdout.on("data", (d) => { bootLog += d; });
  child.stderr.on("data", (d) => { bootLog += d; });
  child.on("exit", (code) => { if (code) { console.error("\n✗ API exited during tests (code " + code + "):\n" + bootLog.slice(-2000)); } });

  if (!(await waitForApi(apiUrl))) {
    console.error("\n✗ API did not become healthy within 60s. Startup output:\n" + bootLog.slice(-2000) + "\n");
    process.exit(1);
  }
  console.log("  API healthy\n");
} else {
  console.log(`→ using the API already running at ${apiUrl}\n`);
}

const results = [];

// UNIT TESTS FIRST, and before anything that needs the API.
//
// `node --test` over server/src picks up every *.test.js beside the code it covers.
// These need no database, no server and no fixtures — they are the pure arithmetic
// (progression scoring, settings validation, attendance models), which is exactly the
// part a college would be asked to defend at an appeal. Running them here rather than
// leaving them to be run by hand is the difference between coverage and decoration:
// until this ran in CI, 71 assertions existed that no push ever executed.
//
// They run first because they are the fastest thing in the suite and they fail on the
// kind of mistake that would otherwise take the whole HTTP run to surface.
if (runUnit) {
  console.log(`${"─".repeat(64)}\n▶ unit tests (server/src)\n${"─".repeat(64)}`);
  // An explicit glob, NOT `node --test src/`. Given a bare directory the runner walks
  // into every file under it, including src/index.js — which binds a port and starts
  // the schedulers, so the run never terminates.
  const r = spawnSync("node", ["--test", "src/**/*.test.js"], { cwd: server, stdio: "inherit", shell: false, env: { ...process.env } });
  results.push({ suite: "unit tests (node --test)", status: r.status === 0 ? "passed" : "failed", code: r.status });
  console.log("");

  // The client has no test framework, and this is not one. These are the pure modules
  // in client/src, tested because each holds a rule that fails silently:
  //   timetableView — the timetable's date arithmetic, because the server half produced
  //     a clock-change bug in exactly this shape and the client repeats it.
  //   navGroups     — the sidebar's collapsible parents, because the one way grouping
  //     can go wrong is a parent surviving after permissions emptied it, which shows an
  //     admin a tab that expands to nothing and advertises screens they were not granted.
  //   qrResultView  — what a student is shown after scanning. Two rules here failed
  //     silently in review: an absent mark rendering as a green tick, and an unmapped
  //     refusal printing the server's own message, one of which is a configuration key's
  //     setup instructions. Both look exactly like a working card.
  //   checkInAction — which action a session row offers for the live view, if any.
  //   scanText      — what the in-app scanner accepts as one of our codes.
  //   scanLink      — whether this screen may draw a code at all. Inside the packaged
  //     app the page's own address is the device, so a lecturer presenting from it
  //     would fill a projector with a code the whole room fails to open.
  //   dueNext       — the Home screen's interleave of unmarked assessments and
  //     next-48h classes into one soonest-first list; the rule that fails silently is
  //     an overdue item not sorting ahead of everything still in the future.
  //   appFunctions  — which functions the college offers, as both shells read it. The
  //     two rules that fail silently are failing CLOSED on a missing payload (an app
  //     build older than the server renders no navigation at all) and keeping the
  //     client's own nav order instead of the college's (which looks right in every
  //     default configuration, because the default order IS the client's).
  // client/package.json is "type": "module", so node runs them directly.
  // EXPLICIT FILES, not a glob: a glob invites somebody to point it at src/, where
  // every .jsx would be dragged in and none of them can run under plain node.
  console.log(`${"─".repeat(64)}\n▶ unit tests (client/src, pure)\n${"─".repeat(64)}`);
  const rc = spawnSync("node", ["--test", "src/timetableView.test.js", "src/navGroups.test.js", "src/qrResultView.test.js", "src/scanLink.test.js", "src/checkInAction.test.js", "src/scanText.test.js", "src/pendingQr.test.js", "src/student/dueNext.test.js", "src/appFunctions.test.js"], { cwd: join(root, "client"), stdio: "inherit", shell: false, env: { ...process.env } });
  results.push({ suite: "unit tests (client, pure)", status: rc.status === 0 ? "passed" : "failed", code: rc.status });
  console.log("");
}

for (const suite of suites) {
  const standalone = STANDALONE.has(suite);
  if (standalone && external) { results.push({ suite, status: "skipped", note: "needs no API" }); continue; }
  console.log(`${"─".repeat(64)}\n▶ ${suite}\n${"─".repeat(64)}`);
  const r = spawnSync("node", [join(root, "scripts", suite)], {
    cwd: root, stdio: "inherit", shell: false,
    env: { ...process.env, API_URL: apiUrl, SEED_PASSWORD, CREDENTIALS_KEY, JWT_SECRET },
  });
  // Exit 2 is a suite reporting itself SKIPPED — it found the feature it covers
  // switched off in this build, so its assertions cannot apply. Distinct from a
  // pass, so the gap stays visible rather than reading as coverage we have.
  const status = r.status === 0 ? "passed" : r.status === 2 ? "skipped" : "failed";
  results.push({ suite, status, code: r.status, note: status === "skipped" ? "feature disabled in this build" : undefined });
  console.log("");
}

stopApi();

const failed = results.filter((r) => r.status === "failed");
console.log("=".repeat(64));
console.log("SUMMARY");
console.log("=".repeat(64));
for (const r of results) {
  const mark = r.status === "passed" ? "PASS" : r.status === "skipped" ? "SKIP" : "FAIL";
  console.log(`  ${mark}  ${r.suite}${r.note ? "  (" + r.note + ")" : ""}`);
}
console.log(`\n${results.filter((r) => r.status === "passed").length} passed, ${failed.length} failed, ${results.filter((r) => r.status === "skipped").length} skipped`);
process.exit(failed.length ? 1 : 0);
