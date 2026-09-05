// The audit trail — §1 of the readiness plan, "material record changes and
// privileged actions logged".
//
// Three properties have to hold, and the third is the one that makes it evidence
// rather than a feature: it must record the right things, it must never leak a
// secret into a log that is read by more people and kept for longer than the table
// it describes, and it must be impossible to edit or delete through the API.
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "..", "server");
const require = createRequire(pathToFileURL(join(server, "package.json")));

const BASE = process.env.API_URL || "http://localhost:4000/api";
const SEED_PW = process.env.SEED_PASSWORD || "password123";
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required — point it at a throwaway database.");
  process.exit(1);
}
const { PrismaClient } = require(join(server, "node_modules", "@prisma", "client"));
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

async function call(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

// The write is fire-and-forget, so a read immediately after the action can race it.
async function waitFor(predicate, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const rows = await db.auditLog.findMany({ orderBy: { at: "desc" }, take: 40 });
    const hit = rows.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

// Both fixtures this suite has to MUTATE, so the finally block can put them back.
// Every suite shares one seeded database in a single `npm test` run and the seed is
// not re-run between them: a promotion left behind here is a permission this suite
// silently granted to every suite that sorts after it.
let promotedAdmin = null;   // { id } — the seeded admin, if we made them a Super Admin
let accessTargetBefore = null; // { id, accountRole, adminPages } — the colleague we re-scoped

try {
  // PUT /staff/:id/access is Super-Admin-only, and the seed does not create one.
  // Promoting the fixture is the honest way to exercise the real route rather than
  // choosing a less privileged action just because it is easier to reach.
  const seeded = await db.staff.findFirst({ where: { email: "admin@edtech.co.uk" } });
  if (seeded && !seeded.isSuperAdmin) {
    await db.staff.update({ where: { id: seeded.id }, data: { isSuperAdmin: true } });
    promotedAdmin = { id: seeded.id };
  }

  const admin = (await call("/auth/login", { method: "POST", body: { email: "admin@edtech.co.uk", password: SEED_PW } })).data;
  check("signed in as an administrator", !!admin?.token);

  console.log("\n--- a privileged action is recorded ---");
  const staff = (await call("/staff", { token: admin.token })).data || [];
  const target = staff.find((s) => s.email && s.email !== "admin@edtech.co.uk");
  check("found a colleague to act on", !!target, target?.email);

  const before = await db.auditLog.count();
  // Granting a page also flips accountRole to ADMIN (see PUT /:id/access), so this
  // call turns a seeded lecturer into a Check-In administrator. Record what they were
  // BEFORE the write: left in place it hands "checkin" and "balances" to a fixture
  // that later suites assert is a plain member of staff.
  const targetRow = target?.id ? await db.staff.findUnique({ where: { id: target.id } }) : null;
  if (targetRow) accessTargetBefore = { id: targetRow.id, accountRole: targetRow.accountRole, adminPages: targetRow.adminPages };
  const r = await call(`/staff/${target.id}/access`, { method: "PUT", token: admin.token, body: { pages: ["checkin", "balances"] } });
  check("access change accepted", r.status === 200, `HTTP ${r.status}`);

  const entry = await waitFor((e) => e.action === "staff.access.changed" && e.entityId === target.id);
  check("an audit row was written", !!entry);
  check("it names the action", entry?.action === "staff.access.changed");
  check("it names the actor", entry?.actorEmail === "admin@edtech.co.uk", entry?.actorEmail);
  check("it records the actor's tier", entry?.actorType === "staff", entry?.actorType);
  check("it points at the record changed", entry?.entity === "Staff" && entry?.entityId === target.id);
  check("it has a readable summary", typeof entry?.summary === "string" && entry.summary.length > 10, entry?.summary?.slice(0, 60));
  check("it captured the address", !!entry?.ip);
  check("it recorded what changed", !!entry?.after);
  check("the log grew by exactly one", (await db.auditLog.count()) === before + 1);

  console.log("\n--- secrets never reach the log ---");
  const all = await db.auditLog.findMany();
  const blob = JSON.stringify(all);
  check("no bcrypt hash anywhere in the log", !/\$2[aby]\$\d{2}\$/.test(blob));
  check("no field literally named passwordHash carries a value", !/"passwordHash":"(?!\[redacted\])/.test(blob));
  // Prove the redactor, not just the current data.
  const audit = require(join(server, "src", "audit.js"));
  const red = audit.redact({ email: "a@b.c", passwordHash: "$2a$10$abcdefghijklmnop", totpSecret: "JBSWY3DPEHPK3PXP", nested: { clientSecret: "shhh", url: "https://ok" } });
  check("redactor hides passwordHash", red.passwordHash === "[redacted]");
  check("redactor hides totpSecret", red.totpSecret === "[redacted]");
  check("redactor hides nested clientSecret", red.nested.clientSecret === "[redacted]");
  check("redactor keeps non-secret fields", red.email === "a@b.c" && red.nested.url === "https://ok");

  console.log("\n--- reading it ---");
  const list = await call("/audit", { token: admin.token });
  check("GET /audit returns entries", list.status === 200 && Array.isArray(list.data?.entries), `HTTP ${list.status}`);
  check("newest first", (() => {
    const e = list.data?.entries || [];
    return e.length < 2 || new Date(e[0].at) >= new Date(e[1].at);
  })());
  // `(x || []).every(...)` IS VACUOUSLY TRUE. Both of these passed when the filter
  // returned nothing, when the endpoint 403'd, and if the filtering were removed
  // altogether — the two checks that exist to prove filtering works could not fail.
  // A filter is only demonstrated by a non-empty result whose every row matches.
  const filtered = await call("/audit?action=staff.access.changed", { token: admin.token });
  const fRows = filtered.data?.entries || [];
  check("filters by action",
    filtered.status === 200 && fRows.length > 0 && fRows.every((e) => e.action === "staff.access.changed"),
    `${fRows.length} row(s)`);
  const byEntity = await call(`/audit?entity=Staff&entityId=${target.id}`, { token: admin.token });
  const eRows = byEntity.data?.entries || [];
  check("filters to one record's history",
    byEntity.status === 200 && eRows.length > 0 && eRows.every((e) => e.entityId === target.id),
    `${eRows.length} row(s)`);
  const actions = await call("/audit/actions", { token: admin.token });
  check("lists the distinct actions present", actions.status === 200 && Array.isArray(actions.data));

  console.log("\n--- it cannot be tampered with through the API ---");
  const id = entry?.id;
  for (const [label, opts] of [
    ["POST /audit", { method: "POST", token: admin.token, body: { action: "forged" } }],
    ["PUT /audit/:id", { method: "PUT", token: admin.token, body: { summary: "rewritten" } }],
    ["DELETE /audit/:id", { method: "DELETE", token: admin.token }],
  ]) {
    const path = label.includes(":id") ? `/audit/${id}` : "/audit";
    const resp = await call(path, opts);
    check(`${label} is not a route`, resp.status === 404 || resp.status === 405, `HTTP ${resp.status}`);
  }
  const untouched = await db.auditLog.findUnique({ where: { id } });
  check("the entry is unchanged after those attempts", untouched?.summary === entry.summary);

  console.log("\n--- an ordinary staff account cannot read it ---");
  const plain = (await call("/auth/login", { method: "POST", body: { email: "j.whitfield@edtech.co.uk", password: SEED_PW } })).data;
  if (plain?.token) {
    const denied = await call("/audit", { token: plain.token });
    check("non-admin refused", denied.status === 403, `HTTP ${denied.status}`);
  } else {
    check("non-admin refused", true, "skipped — no staff fixture");
  }
  const anon = await call("/audit");
  check("anonymous refused", anon.status === 401, `HTTP ${anon.status}`);
} finally {
  // Put the seeded fixtures back exactly as the seed left them. Not tidiness: the
  // access grant above makes a lecturer an ADMIN holding the "checkin" page, and
  // smoke-timesheets later asserts that same lecturer is refused PUT /api/checkins.
  // Leaving it behind turns this suite's setup into that suite's failure.
  try {
    if (accessTargetBefore) {
      await db.staff.update({
        where: { id: accessTargetBefore.id },
        data: { accountRole: accessTargetBefore.accountRole, adminPages: accessTargetBefore.adminPages },
      });
    }
    if (promotedAdmin) await db.staff.update({ where: { id: promotedAdmin.id }, data: { isSuperAdmin: false } });
  } catch (e) {
    console.error("cleanup problem:", e?.message || e);
  }
  await db.$disconnect();
  console.log("\ncleanup: seeded admin demoted, colleague's access restored");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
