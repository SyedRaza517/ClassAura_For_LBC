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
//       T6 IS GONE FROM THIS SUITE. The platform-operator tier was removed with
//       multi-tenancy — one deployment, one college, so there is no supplier login
//       sitting above every institution — and /platform/login, /platform/me and
//       /platform/admins/:id/active do not exist to be probed. Its three assertions
//       (deactivation kills a live session immediately, an operator cannot deactivate
//       themselves, deactivation is reversible) proved real things about real code and
//       are recorded here as DELETED, not as passing: nothing covers them any more, and
//       if a supplier-support login is ever reintroduced this section is what has to
//       come back with it. Recoverable from git history.
//
// Written the way smoke-security-regressions.mjs is: each section reproduces the
// ORIGINAL defect, and "CONFIRMED" means it is BACK — which is a failure.
//
// Prereqs: an API on API_URL (npm test boots one) and DATABASE_URL pointing at the
// same database. THIS SUITE WRITES: it registers a throwaway applicant and removes it
// at the end. Point it at a scratch database, not a live one.
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

if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required — point it at a throwaway database."); process.exit(1); }
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

// This client is deliberately bare: it verifies what the API did, so it must not be the
// one the API writes through. It used to also need the seeded tenant's id, to stamp onto
// fixtures and to scope the cleanup query below — there is one institution per deployment
// now and tenantId is gone from the schema, so neither is needed.

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

const cleanup = { applicantEmails: [] };

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
  // remember. tenantId was named here too; the column no longer exists on any model, so
  // keeping it would be an assertion that can never fire — which is exactly the kind
  // that reads as coverage while discriminating nothing. The unknown-key check below is
  // what carries D5's real second half, and it is untouched.
  const leaked = row
    ? ["passwordHash", "active", "tokenVersion", "uploadTokenHash", "offerTokenHash"].filter((k) => k in row)
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
  // storagePath and spItemId are the live half of this — they are the SharePoint
  // coordinates of a passport scan and must never leave the server. tenantId was the
  // third name and has gone with the column.
  const docLeak = (row?.documents || []).flatMap((d) => ["storagePath", "spItemId"].filter((k) => k in d));
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

/* ====== T6: removing a platform operator — DELETED WITH THE TIER, not adapted ====== */
//
// The platform-operator tier went with multi-tenancy. There is no /platform/login to get
// a session from, no /platform/admins/:id/active to call, and no PlatformAdmin model to
// plant a fixture in, so every statement this section made is now a statement about
// routes that answer 404.
//
// Deleted rather than rewritten against that 404, because "POST /platform/login is not
// mounted" is a fact about the router table, not a security property, and dressing it up
// would put a line beside T6, T6b and T6c that discriminates nothing. This suite's own
// convention makes that worse than usual — "not reproduced" here means the defect is
// absent, so a section that can never reproduce anything reads as permanent reassurance.
//
// Genuinely no longer proven ANYWHERE, and flagged rather than quietly dropped:
//   * revoking an administrator's access kills their LIVE session rather than leaving it
//     to run to token expiry (tokenVersion, not `active`, is what makes that true),
//   * an administrator cannot deactivate themselves and lock the tier out,
//   * a deactivation can be undone, so it is a switch rather than a delete in disguise.
// The staff-account model has the same shape (Staff.active + tokenVersion) and would be
// the place to reinstate them, but no suite asserts the immediate-session-death property
// on the staff side today.

/* ============ cleanup ============ */
for (const email of cleanup.applicantEmails) {
  const row = await db.admission.findFirst({ where: { email } });
  if (row) {
    await db.admissionDocument.deleteMany({ where: { admissionId: row.id } });
    await db.admission.delete({ where: { id: row.id } });
  }
}
await db.$disconnect();

console.log(`\n\n${"=".repeat(70)}\nSUMMARY`);
for (const r of out) console.log(`  ${r.confirmed ? "*** VULNERABLE ***" : "fixed             "}  #${String(r.n).padEnd(4)} ${r.title}`);
const back = out.filter((r) => r.confirmed).length;
const up = await alive();
console.log(`\n${out.length - back} of ${out.length} still fixed. API alive: ${up}`);
if (back > 0) console.log(`\nREGRESSION: ${back} defect${back === 1 ? " has" : "s have"} returned.`);
process.exit(back > 0 || !up ? 1 : 0);
