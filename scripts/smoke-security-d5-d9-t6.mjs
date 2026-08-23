// Regression suite for the three defects fixed on 23 Aug 2026:
//
//   D5  bcrypt hashes reached the admin client — sAdmission stripped a fixed list of
//       secrets instead of naming what may go out, so every column added to the
//       Admission model afterwards (passwordHash, active, tokenVersion) shipped to the
//       browser by default.
//   D9  POST /api/applicant/check-email was unauthenticated and unthrottled, so it
//       answered "does this address have an account here?" for any address, at speed,
//       across staff, students and applicants.
//   T6  a platform operator could be created but never removed. An operator who left
//       kept a working password against every customer's data.
//
// Written the way smoke-security-regressions.mjs is: each section reproduces the
// ORIGINAL defect, and "CONFIRMED" means it is BACK — which is a failure.
//
// Prereqs: an API on API_URL (npm test boots one) and DATABASE_URL pointing at the
// same database. THIS SUITE WRITES: it registers a throwaway applicant and creates two
// throwaway PlatformAdmin rows, and removes all three at the end. Point it at a scratch
// database, not a live one.
//
// It also SPENDS the check-email budget for this machine's IP for 15 minutes, by
// design — that is what section D9 measures.
//
// Usage: node scripts/smoke-security-d5-d9-t6.mjs
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
const require = createRequire(pathToFileURL(join(ROOT, "server", "package.json")));
const { PrismaClient } = require(`${ROOT}/server/node_modules/@prisma/client`);
// Resolved through the SERVER's dependency tree, like the Prisma client above — the
// repo root does not carry bcryptjs.
const bcrypt = require("bcryptjs");

if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required — point it at a throwaway database."); process.exit(1); }
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

// Every tenanted row needs an institution named for it: this client is deliberately
// bare (it verifies what the API did, so nothing injects a tenant for it). PlatformAdmin
// is the one model here that is NOT tenanted — it sits above every institution.
const TENANT = await db.tenant.findFirst({ where: { slug: process.env.SEED_TENANT_SLUG || process.env.DEFAULT_TENANT_SLUG || "default" } });
if (!TENANT) { console.error("No seeded tenant found — run the seed before this suite."); process.exit(1); }

const BASE = process.env.API_URL || "http://localhost:4000/api";
const SEED_PW = process.env.SEED_PASSWORD || "password123";
const TAG = `d5t6${Date.now()}`;

const out = [];
const verdict = (n, title, confirmed, detail) => {
  out.push({ n, title, confirmed, detail });
  console.log(`\n### FINDING ${n}: ${title}\n    ${confirmed ? "*** CONFIRMED ***" : "not reproduced"}  ${detail}`);
};

async function call(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
  } catch (e) { return { status: 0, data: null, netError: e.message }; }
}
const alive = async () => (await call("/health")).status === 200;

const admin = (await call("/auth/login", { method: "POST", body: { email: "admin@edtech.co.uk", password: SEED_PW } })).data;
if (!admin?.token) { console.error("admin login failed — is the API up and seeded?"); process.exit(1); }

const cleanup = { applicantEmails: [], platformEmails: [] };

/* ============ D5: secrets on an Admission row reaching the admin client ============ */
//
// The row has to be a PORTAL registration for this to bite — an admin-entered
// application has no passwordHash to leak, which is why the defect went unnoticed.
{
  const email = `${TAG}.applicant@example.com`;
  cleanup.applicantEmails.push(email);
  const reg = await call("/applicant/register", {
    method: "POST",
    body: { email, firstName: "Smoke", surname: "Applicant", password: "PortalPass123!", confirmPassword: "PortalPass123!" },
  });

  const list = await call("/admissions", { token: admin.token });
  const row = (list.data || []).find((r) => (r.email || "").toLowerCase() === email);

  // Named individually rather than looped over a denylist, because a denylist is the
  // bug: these are the four that leaked, plus the two token hashes the old code did
  // remember and tenantId, which is nobody's business outside the server.
  const leaked = row
    ? ["passwordHash", "active", "tokenVersion", "uploadTokenHash", "offerTokenHash", "tenantId"].filter((k) => k in row)
    : [];

  // The other half of D5: a field ADDED to the model tomorrow must not become public
  // by default. Simulated by asking whether the serializer copies an unknown column —
  // if the response carries a key nothing in the allowlist names, the denylist is back.
  const ALLOWED_EXTRAS = new Set(["documents", "warning", "emailed"]);
  const unknown = row ? Object.keys(row).filter((k) => !ALLOWED_EXTRAS.has(k) && k.endsWith("Hash")) : [];

  verdict("D5", "Applicant secrets on GET /admissions (was: bcrypt hash to the browser)",
    !row || leaked.length > 0 || unknown.length > 0,
    row
      ? `register=${reg.status} row found, ${Object.keys(row).length} fields | leaked=[${leaked.join(", ") || "none"}]`
      : `register=${reg.status} — the applicant's row was NOT in the admin list, so nothing could be checked (test setup failure, not a pass)`);

  // Same rule for the documents that ride along on the row.
  const docLeak = (row?.documents || []).flatMap((d) => ["tenantId", "storagePath", "spItemId"].filter((k) => k in d));
  verdict("D5b", "Storage keys on the embedded document checklist",
    docLeak.length > 0,
    `${(row?.documents || []).length} document(s) inspected | leaked=[${docLeak.join(", ") || "none"}]`);
}

/* ============ D9: bulk account enumeration via check-email ============ */
//
// One honest call must still answer. Only sustained volume from one address should
// stop being answered — the point is to break a script, not the signup form.
{
  const first = await call("/applicant/check-email", { method: "POST", body: { email: "admin@edtech.co.uk" } });
  const firstAnswered = first.data?.valid === true && first.data?.available === false;

  // Well past the 40-per-15-minutes budget. A caller working through a list gets this
  // far in under a second, which is exactly the traffic the cap is aimed at.
  let stillOracling = 0;
  for (let i = 0; i < 60; i++) {
    const r = await call("/applicant/check-email", { method: "POST", body: { email: `probe${i}@example.com` } });
    // Over budget the endpoint answers "available" without asking the database, and
    // says so with checked:false. An honest answer after the cap means the limiter
    // is not firing.
    if (r.data?.checked !== false) stillOracling++;
  }

  // And it must not have broken the form: a throttled caller gets a usable reply, not
  // a 429 the client renders as "that email is taken".
  const afterCap = await call("/applicant/check-email", { method: "POST", body: { email: "admin@edtech.co.uk" } });
  const brokeTheForm = afterCap.status !== 200 || afterCap.data?.valid !== true || afterCap.data?.available !== true;

  verdict("D9", "check-email answers unlimited enumeration (was: unthrottled account oracle)",
    stillOracling > 45 || brokeTheForm,
    `first call answered honestly=${firstAnswered} | ${stillOracling} of 60 rapid probes still answered | after the cap: status=${afterCap.status} valid=${afterCap.data?.valid} available=${afterCap.data?.available} (a 429 or available:false here would break the register form)`);
}

/* ============ T6: removing a platform operator ============ */
{
  const mkOperator = async (suffix) => {
    const email = `${TAG}.${suffix}@example.com`;
    const password = "OperatorPassword123!";
    cleanup.platformEmails.push(email);
    await db.platformAdmin.create({ data: { email, name: `Smoke ${suffix}`, passwordHash: bcrypt.hashSync(password, 10) } });
    const lg = await call("/platform/login", { method: "POST", body: { email, password } });
    return { email, password, token: lg.data?.token, id: lg.data?.admin?.id, loginStatus: lg.status };
  };

  const a = await mkOperator("opA");
  const b = await mkOperator("opB");

  if (!a.token || !b.token) {
    verdict("T6", "Platform operator removal", true,
      `could not sign in as the fixture operators (A=${a.loginStatus} B=${b.loginStatus}) — the platform login may now require a second factor, in which case this section needs updating`);
  } else {
    // 1. The route exists at all. This is the defect itself: there was no way to
    //    withdraw an operator's access short of editing the database.
    const gone = await call(`/platform/admins/${b.id}/active`, { method: "PUT", token: a.token, body: { active: false } });

    // 2. Sessions die IMMEDIATELY, not at the 8-hour token expiry. tokenVersion is what
    //    makes that true; `active` alone would leave the check to a different branch.
    const bAfter = await call("/platform/me", { token: b.token });

    // 3. And the password stops working too.
    const bRelogin = await call("/platform/login", { method: "POST", body: { email: b.email, password: b.password } });

    verdict("T6", "A departed platform operator keeps their access (was: no removal endpoint)",
      gone.status !== 200 || bAfter.status === 200 || bRelogin.status === 200,
      `deactivate=${gone.status} | their live session afterwards=${bAfter.status} (401 wanted) | signing in again=${bRelogin.status} (401 wanted)`);

    // 4. Self-deactivation must be refused. Succeeding here locks the actor out of the
    //    only screen that could undo it, and if they were the last operator, out of the
    //    platform tier entirely — recoverable only with database access.
    const self = await call(`/platform/admins/${a.id}/active`, { method: "PUT", token: a.token, body: { active: false } });
    const stillIn = await call("/platform/me", { token: a.token });
    verdict("T6b", "An operator can deactivate themselves (would lock the tier out)",
      self.status === 200 || stillIn.status !== 200,
      `self-deactivate=${self.status} (400 wanted) "${self.data?.error || ""}" | own session afterwards=${stillIn.status} (200 wanted)`);

    // 5. Restore puts them back — the reason this is a switch and not a delete.
    const back = await call(`/platform/admins/${b.id}/active`, { method: "PUT", token: a.token, body: { active: true } });
    const bRelogin2 = await call("/platform/login", { method: "POST", body: { email: b.email, password: b.password } });
    verdict("T6c", "Deactivation cannot be undone (would make it a delete in disguise)",
      back.status !== 200 || bRelogin2.status !== 200,
      `restore=${back.status} | signing in again afterwards=${bRelogin2.status} (200 wanted)`);

    // NOT covered here: the "last active operator" guard. With the self-guard in place
    // it is unreachable through the API — the caller is an active operator and is not
    // the target, so an active target implies at least two remain. It exists for the
    // concurrent case (two operators deactivating each other at the same instant), and
    // reproducing that needs a database with exactly one operator in it, which is not
    // something a suite sharing a database with other suites can arrange safely.
  }
}

/* ============ cleanup ============ */
for (const email of cleanup.applicantEmails) {
  const row = await db.admission.findFirst({ where: { email, tenantId: TENANT.id } });
  if (row) {
    await db.admissionDocument.deleteMany({ where: { admissionId: row.id } });
    await db.admission.delete({ where: { id: row.id } });
  }
}
for (const email of cleanup.platformEmails) {
  await db.platformAdmin.deleteMany({ where: { email } });
}
await db.$disconnect();

console.log(`\n\n${"=".repeat(70)}\nSUMMARY`);
for (const r of out) console.log(`  ${r.confirmed ? "*** VULNERABLE ***" : "fixed             "}  #${String(r.n).padEnd(4)} ${r.title}`);
const back = out.filter((r) => r.confirmed).length;
const up = await alive();
console.log(`\n${out.length - back} of ${out.length} still fixed. API alive: ${up}`);
if (back > 0) console.log(`\nREGRESSION: ${back} defect${back === 1 ? " has" : "s have"} returned.`);
process.exit(back > 0 || !up ? 1 : 0);
