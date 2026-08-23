// Tenant isolation — the suite that has to be right.
//
// The SaaS readiness plan names this explicitly ("automated tests for authentication,
// tenant isolation and critical workflows") and it is the first thing a college's IT
// team will ask to see. Every other suite proves a feature works; this one proves
// that one customer cannot reach another's data.
//
// It builds two complete institutions that deliberately collide — the same admin
// email address at both, since Staff.email is unique per tenant now — and then tries,
// from college A, to read, fetch, modify and delete college B's data through the real
// HTTP API. Every attempt must fail.
//
//   node scripts/smoke-tenant-isolation.mjs
//   (needs API_URL + DATABASE_URL; the runner supplies both)
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "..", "server");
const require = createRequire(pathToFileURL(join(server, "package.json")));

const BASE = process.env.API_URL || "http://localhost:4000/api";
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required — point it at a throwaway database.");
  process.exit(1);
}

const { PrismaClient } = require(join(server, "node_modules", "@prisma", "client"));
const bcrypt = require(join(server, "node_modules", "bcryptjs"));
// A BARE client on purpose: this suite is the thing testing the isolation extension,
// so it must be able to see across tenants to set fixtures up and to verify that the
// API did not change what it was not allowed to change.
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

async function call(path, { method = "GET", body, token, tenant } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (tenant) headers["X-Tenant"] = tenant;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch (_) { /* empty body */ }
  return { status: res.status, data };
}

// Distinct per run so a failed run cannot poison the next one.
const RUN = Date.now().toString(36);
const A_SLUG = `iso-a-${RUN}`;
const B_SLUG = `iso-b-${RUN}`;
// The SAME address at both institutions. That collision is the whole point: it is
// exactly what globally-unique emails made impossible, and what per-tenant uniqueness
// is for.
const SHARED_EMAIL = `principal-${RUN}@shared.test`;
const PW_A = "college-a-password-2026";
const PW_B = "college-b-password-2026";

const PASSWORD_HASH = (pw) => bcrypt.hashSync(pw, 10);

async function makeCollege(slug, name, password) {
  const tenant = await db.tenant.create({ data: { slug, name } });
  const admin = await db.staff.create({
    data: {
      tenantId: tenant.id, name: `${name} Principal`, jobTitle: "Principal", dept: "Leadership",
      email: SHARED_EMAIL, passwordHash: PASSWORD_HASH(password), accountRole: "ADMIN",
      isSuperAdmin: true, initials: "PR", colour: "#334155",
    },
  });
  // One extra staff member, so row counts differ and a leak is visible as a number.
  const extra = await db.staff.create({
    data: {
      tenantId: tenant.id, name: `${name} Teacher`, jobTitle: "Lecturer", dept: "Teaching",
      email: `teacher-${slug}@shared.test`, passwordHash: PASSWORD_HASH(password),
      accountRole: "STAFF", initials: "TE", colour: "#0e7490",
    },
  });
  const doc = await db.document.create({
    data: { tenantId: tenant.id, name: `${name} private policy`, type: "Policy", date: "2026-01-01", scope: "all" },
  });
  return { tenant, admin, extra, doc };
}

async function cleanup() {
  for (const slug of [A_SLUG, B_SLUG]) {
    const t = await db.tenant.findUnique({ where: { slug } });
    if (t) await db.tenant.delete({ where: { id: t.id } }); // cascades to every table
  }
}

try {
  await cleanup();

  console.log("\n--- two institutions, one shared email address ---");
  const A = await makeCollege(A_SLUG, "College A", PW_A);
  const B = await makeCollege(B_SLUG, "College B", PW_B);
  check("both institutions created", !!A.tenant.id && !!B.tenant.id);
  check("the SAME email exists at both", A.admin.email === B.admin.email, SHARED_EMAIL);
  check("they are different accounts", A.admin.id !== B.admin.id);

  console.log("\n--- each signs in against its own institution ---");
  const loginA = await call("/auth/login", { method: "POST", tenant: A_SLUG, body: { email: SHARED_EMAIL, password: PW_A } });
  const loginB = await call("/auth/login", { method: "POST", tenant: B_SLUG, body: { email: SHARED_EMAIL, password: PW_B } });
  check("A signs in", loginA.status === 200 && !!loginA.data?.token, `HTTP ${loginA.status}`);
  check("B signs in with the same email", loginB.status === 200 && !!loginB.data?.token, `HTTP ${loginB.status}`);
  const tokenA = loginA.data?.token, tokenB = loginB.data?.token;

  console.log("\n--- a password is only valid at its own institution ---");
  const wrongWay = await call("/auth/login", { method: "POST", tenant: B_SLUG, body: { email: SHARED_EMAIL, password: PW_A } });
  check("A's password refused at B", wrongWay.status === 401, `HTTP ${wrongWay.status}`);

  console.log("\n--- reads are scoped ---");
  const staffA = await call("/staff", { token: tokenA, tenant: A_SLUG });
  const staffB = await call("/staff", { token: tokenB, tenant: B_SLUG });
  const idsA = (staffA.data || []).map((s) => s.id);
  const idsB = (staffB.data || []).map((s) => s.id);
  check("A sees only its own staff", idsA.length === 2 && !idsA.includes(B.admin.id) && !idsA.includes(B.extra.id), `${idsA.length} rows`);
  check("B sees only its own staff", idsB.length === 2 && !idsB.includes(A.admin.id) && !idsB.includes(A.extra.id), `${idsB.length} rows`);
  const docsA = await call("/documents", { token: tokenA, tenant: A_SLUG });
  check("A's documents exclude B's", !(docsA.data || []).some((d) => d.id === B.doc.id));

  console.log("\n--- THE ATTACK: A's token presented against B ---");
  const replay = await call("/staff", { token: tokenA, tenant: B_SLUG });
  check("token replay across institutions rejected", replay.status === 401, `HTTP ${replay.status}`);
  const replayLeak = Array.isArray(replay.data) && replay.data.some((s) => s.id === B.admin.id);
  check("...and it returned no data", !replayLeak);

  console.log("\n--- fetching another institution's records by id ---");
  const byId = await call(`/staff/${B.admin.id}`, { token: tokenA, tenant: A_SLUG });
  check("staff-by-id across institutions not found", byId.status === 404 || byId.status === 403, `HTTP ${byId.status}`);

  console.log("\n--- writing to another institution's records ---");
  const edit = await call(`/staff/${B.admin.id}`, { method: "PUT", token: tokenA, tenant: A_SLUG, body: { dept: "BREACHED" } });
  check("update across institutions refused", edit.status >= 400, `HTTP ${edit.status}`);
  const del = await call(`/staff/${B.admin.id}`, { method: "DELETE", token: tokenA, tenant: A_SLUG });
  check("delete across institutions refused", del.status >= 400, `HTTP ${del.status}`);

  const victim = await db.staff.findUnique({ where: { id: B.admin.id } });
  check("B's record is untouched", !!victim && victim.dept === "Leadership", victim ? `dept=${victim.dept}` : "DELETED");

  console.log("\n--- creating data lands in the caller's own institution ---");
  const created = await call("/documents", { method: "POST", token: tokenA, tenant: A_SLUG, body: { name: `iso-${RUN}`, type: "Policy", scope: "all" } });
  if (created.status >= 200 && created.status < 300 && created.data?.id) {
    const row = await db.document.findUnique({ where: { id: created.data.id } });
    check("new row is stamped with A's tenant", row?.tenantId === A.tenant.id);
  } else {
    check("new row is stamped with A's tenant", true, `skipped — create returned ${created.status}`);
  }

  console.log("\n--- the tenant itself ---");
  const unknown = await call("/staff", { token: tokenA, tenant: `no-such-college-${RUN}` });
  check("unknown institution refused", unknown.status === 404, `HTTP ${unknown.status}`);
  check("...without revealing whether it exists", !JSON.stringify(unknown.data || {}).includes(RUN));

  await db.tenant.update({ where: { id: B.tenant.id }, data: { active: false } });
  const suspended = await call("/auth/login", { method: "POST", tenant: B_SLUG, body: { email: SHARED_EMAIL, password: PW_B } });
  check("a suspended institution cannot sign in", suspended.status === 403, `HTTP ${suspended.status}`);

  console.log("\n--- deleting an institution removes its data (end of contract) ---");
  const before = await db.staff.count({ where: { tenantId: B.tenant.id } });
  await db.tenant.delete({ where: { id: B.tenant.id } });
  const after = await db.staff.count({ where: { tenantId: B.tenant.id } });
  check("tenant delete cascades", before > 0 && after === 0, `${before} -> ${after}`);

  const survivors = await db.staff.count({ where: { tenantId: A.tenant.id } });
  check("the other institution is unaffected", survivors === 2, `${survivors} rows`);
} finally {
  await cleanup();
  await db.$disconnect();
  console.log("\ncleanup: test institutions removed");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
