// The whole test suite, as one command:  npm test
//
// Until now the smoke suites could only be run by hand, one at a time, against a
// server someone had already started — which meant in practice they were run
// rarely, and never on a change that "obviously" didn't need them. This boots its
// own API against its own database, runs every suite, and returns a single
// pass/fail. That is what makes them usable from CI.
//
//   npm test                     # start an API, seed, run everything
//   npm test -- smoke-invite     # only suites matching a name
//   API_URL=https://… npm test   # run against an ALREADY-RUNNING API (skips boot)
//
// Exit code is 0 only if every suite passed, so CI can gate on it.
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = join(root, "server");

// A suite that talks to no API and needs no database. It stands in for Google's
// endpoints itself, so it runs anywhere — including before a database exists.
const STANDALONE = new Set(["smoke-push-transport.mjs"]);

const filter = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const suites = readdirSync(join(root, "scripts"))
  .filter((f) => f.startsWith("smoke-") && f.endsWith(".mjs"))
  .filter((f) => !filter.length || filter.some((q) => f.includes(q)))
  .sort();

if (!suites.length) {
  console.error(filter.length ? `No suite matches: ${filter.join(", ")}` : "No suites found.");
  process.exit(1);
}

// An API URL supplied from outside means "test that deployment" — don't start one.
const external = Boolean(process.env.API_URL);
// The seed refuses anything under 12 characters, and the suites sign in as the
// accounts it creates — so one value has to reach both. Fixed (not random) so a
// failing run can be reproduced by hand against the same database.
const SEED_PASSWORD = process.env.SEED_PASSWORD || "test-seed-password-2026";
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

  console.log(`→ starting API on port ${PORT}`);
  child = spawn("node", ["src/index.js"], {
    cwd: server,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(PORT), NODE_ENV: "test", JWT_SECRET: process.env.JWT_SECRET || "test-secret-not-for-production" },
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
for (const suite of suites) {
  const standalone = STANDALONE.has(suite);
  if (standalone && external) { results.push({ suite, status: "skipped", note: "needs no API" }); continue; }
  console.log(`${"─".repeat(64)}\n▶ ${suite}\n${"─".repeat(64)}`);
  const r = spawnSync("node", [join(root, "scripts", suite)], {
    cwd: root, stdio: "inherit", shell: false,
    env: { ...process.env, API_URL: apiUrl, SEED_PASSWORD },
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
