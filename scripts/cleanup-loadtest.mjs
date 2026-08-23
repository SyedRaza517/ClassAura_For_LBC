// Removes the load-test staff added by seed-100.mjs (emails: loadtest.*@edtech.co.uk).
// Leaves the original seeded accounts (admin + 5 staff) untouched.
// Usage: node scripts/cleanup-loadtest.mjs [--dry-run]
const BASE = process.env.API_BASE || "http://localhost:4000/api";
const ADMIN = { email: "admin@edtech.co.uk", password: "password123" };
const DRY_RUN = process.argv.includes("--dry-run");
const CONCURRENCY = 10;
const PREFIX = "loadtest.";

async function login() {
  const r = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  if (!r.ok) throw new Error(`Login failed: ${r.status} ${await r.text()}`);
  return (await r.json()).token;
}

async function main() {
  console.log(`Logging in as ${ADMIN.email}…`);
  const token = await login();
  const auth = { Authorization: `Bearer ${token}` };

  const r = await fetch(`${BASE}/staff`, { headers: auth });
  if (!r.ok) throw new Error(`Could not list staff: ${r.status}`);
  const all = await r.json();

  const targets = all.filter((s) => String(s.email).toLowerCase().startsWith(PREFIX));
  console.log(`Found ${targets.length} load-test staff out of ${all.length} total.`);
  if (!targets.length) { console.log("Nothing to clean up."); return; }

  if (DRY_RUN) {
    console.log("--dry-run: would delete these (showing up to 10):");
    targets.slice(0, 10).forEach((s) => console.log(`  ${s.id}  ${s.email}`));
    if (targets.length > 10) console.log(`  …and ${targets.length - 10} more`);
    return;
  }

  const queue = targets.slice();
  let deleted = 0, failed = 0;
  const failures = [];

  async function worker() {
    let s;
    while ((s = queue.shift()) !== undefined) {
      const d = await fetch(`${BASE}/staff/${s.id}`, { method: "DELETE", headers: auth });
      if (d.ok) deleted++;
      else { failed++; failures.push({ email: s.email, status: d.status, err: await d.text() }); }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\nDeleted ${deleted}, failed ${failed}.`);
  if (failures.length) {
    console.log("First few failures:");
    failures.slice(0, 5).forEach((f) => console.log(`  ${f.status} ${f.email} — ${f.err}`));
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
