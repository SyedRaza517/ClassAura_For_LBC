// Regression suite for the 8 security defects found by the multi-agent sweep on
// 21 Jul 2026. Every section reproduces the ORIGINAL attack; each must now fail.
// "CONFIRMED" here means the vulnerability is BACK — that is a failure.
//
//   #1+5 revoked session token accepted at /totp/setup, traded for a live session
//   #2+6 pre-reset MFA challenge still mints a session after a password reset
//   #3   password reset left the login lockout in place
//   #4   single-use reset link consumable twice concurrently
//   #7   no rate limiting on second-factor verification
//   #8   a borrowed session could enable 2FA with no password re-check
//   #10  allowance cap beaten by concurrent approvals (TOCTOU)
//   #11  non-string `note` crashed the API process
//
// Prereq: API running on http://localhost:4000  (npm run dev)
// Usage:  node scripts/smoke-security-regressions.mjs
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import crypto from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
const require = createRequire(pathToFileURL(join(ROOT, "server", "package.json")));
const totp = require(`${ROOT}/server/src/totp.js`);
const { PrismaClient } = require(`${ROOT}/server/node_modules/@prisma/client`);
// The same database the API under test is using. This was a hardcoded SQLite file
// path — a leftover from before the move to PostgreSQL — which made every suite that
// touches the database directly fail schema validation before running a single query.
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required — point it at a throwaway database."); process.exit(1); }
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
// Every row belongs to an institution now. This client is deliberately bare — it
// verifies what the API did, so nothing injects a tenant for it — which means the
// fixtures below have to name one themselves. They target the seeded institution,
// the same one the API resolves to when no X-Tenant header is sent.
const TENANT = await db.tenant.findFirst({ where: { slug: process.env.SEED_TENANT_SLUG || process.env.DEFAULT_TENANT_SLUG || "default" } });
if (!TENANT) { console.error("No seeded tenant found — run the seed before this suite."); process.exit(1); }

const BASE = process.env.API_URL || "http://localhost:4000/api";
const SEED_PW = process.env.SEED_PASSWORD || "password123";
const TAG = `vf${Date.now()}`;
const made = [];

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
if (!admin?.token) { console.error("admin login failed — is the API up?"); process.exit(1); }

// Create a staff account directly (admin route), returns {id, email, password, token}
async function mkStaff(suffix, allowance = 28) {
  const email = `${TAG}.${suffix}@edtech.co.uk`;
  const r = await call("/staff", { method: "POST", token: admin.token, body: { name: `VF ${suffix}`, email, allowance, password: "InitPass123!" } });
  made.push(email);
  // admin-created accounts carry mustChangePassword; clear it so login returns a session
  await db.staff.update({ where: { id: r.data.id }, data: { mustChangePassword: false } });
  const lg = await call("/auth/login", { method: "POST", body: { email, password: "InitPass123!" } });
  return { id: r.data.id, email, password: "InitPass123!", token: lg.data.token };
}
// Plant a live reset token and use it
async function resetPasswordOf(staffId, newPassword) {
  const raw = crypto.randomBytes(32).toString("hex");
  await db.passwordReset.create({ data: { tenantId: TENANT.id, staffId, tokenHash: crypto.createHash("sha256").update(raw).digest("hex"), expiresAt: new Date(Date.now() + 30 * 60000) } });
  return call("/auth/reset-password", { method: "POST", body: { token: raw, newPassword } });
}

/* ============ 1+5: revoked Bearer token accepted by /totp/setup ============ */
{
  const u = await mkStaff("revoked");
  await resetPasswordOf(u.id, "NewPass456!");
  const dead = await call("/auth/me", { token: u.token });
  const setup = await call("/auth/totp/setup", { method: "POST", token: u.token });
  let escalated = { status: 0 }, reuse = { status: 0 };
  if (setup.status === 200) {
    const enable = await call("/auth/totp/enable", { method: "POST", token: u.token, body: { code: totp.generateCode(setup.data.secret) } });
    escalated = enable;
    if (enable.data?.token) reuse = await call("/auth/me", { token: enable.data.token });
  }
  verdict("1+5", "Revoked session token accepted at /totp/setup and traded for a live session",
    dead.status === 401 && setup.status === 200 && escalated.status === 200 && reuse.status === 200,
    `/auth/me=${dead.status} (revoked ok) | /totp/setup=${setup.status} | /totp/enable=${escalated.status} | /auth/me with minted token=${reuse.status}`);
}

/* ============ 2+6: stale MFA challenge survives a password reset ============ */
{
  const u = await mkStaff("challenge");
  await db.staff.update({ where: { id: u.id }, data: { mustSetupTotp: true } });
  const lg = await call("/auth/login", { method: "POST", body: { email: u.email, password: u.password } });
  const challenge = lg.data?.challengeToken;
  await resetPasswordOf(u.id, "AfterReset789!");
  const oldPw = await call("/auth/login", { method: "POST", body: { email: u.email, password: u.password } });
  const setup = await call("/auth/totp/setup", { method: "POST", body: { challengeToken: challenge } });
  let enable = { status: 0 }, me = { status: 0 };
  if (setup.status === 200) {
    enable = await call("/auth/totp/enable", { method: "POST", body: { challengeToken: challenge, code: totp.generateCode(setup.data.secret) } });
    if (enable.data?.token) me = await call("/auth/me", { token: enable.data.token });
  }
  verdict("2+6", "Pre-reset MFA challenge token still mints a full session after the reset",
    !!challenge && oldPw.status === 401 && setup.status === 200 && enable.status === 200 && me.status === 200,
    `old password now=${oldPw.status} | stale challenge -> /totp/setup=${setup.status} | /totp/enable=${enable.status} | /auth/me=${me.status}`);
}

/* ============ 3: reset does not clear the login lockout ============ */
{
  const u = await mkStaff("locked");
  for (let i = 0; i < 8; i++) await call("/auth/login", { method: "POST", body: { email: u.email, password: "WrongOnPurpose1!" } });
  const locked = await call("/auth/login", { method: "POST", body: { email: u.email, password: u.password } });
  const reset = await resetPasswordOf(u.id, "FreshPass321!");
  const after = await call("/auth/login", { method: "POST", body: { email: u.email, password: "FreshPass321!" } });
  verdict(3, "A successful password reset does not clear the login lockout",
    locked.status === 429 && reset.status === 200 && after.status === 429,
    `locked=${locked.status} | reset=${reset.status} | login with the NEW password=${after.status} ${JSON.stringify(after.data)}`);
}

/* ============ 4: single-use reset token consumed twice concurrently ============ */
{
  const u = await mkStaff("race");
  const raw = crypto.randomBytes(32).toString("hex");
  await db.passwordReset.create({ data: { tenantId: TENANT.id, staffId: u.id, tokenHash: crypto.createHash("sha256").update(raw).digest("hex"), expiresAt: new Date(Date.now() + 30 * 60000) } });
  const [a, b] = await Promise.all([
    call("/auth/reset-password", { method: "POST", body: { token: raw, newPassword: "RaceOne111!" } }),
    call("/auth/reset-password", { method: "POST", body: { token: raw, newPassword: "RaceTwo222!" } }),
  ]);
  const row = await db.staff.findUnique({ where: { id: u.id } });
  verdict(4, "A single-use reset token can be consumed twice concurrently",
    a.status === 200 && b.status === 200,
    `responses=[${a.status},${b.status}] | tokenVersion=${row.tokenVersion} (2 means both writes landed)`);
}

/* ============ 7: no rate limiting on TOTP verification ============ */
{
  const u = await mkStaff("brute");
  const s1 = await call("/auth/totp/setup", { method: "POST", token: u.token });
  await call("/auth/totp/enable", { method: "POST", token: u.token, body: { code: totp.generateCode(s1.data.secret) } });
  const lg = await call("/auth/login", { method: "POST", body: { email: u.email, password: u.password } });
  const ch = lg.data.challengeToken;
  const codes = [];
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) codes.push((await call("/auth/totp/verify", { method: "POST", body: { challengeToken: ch, code: String(100000 + i) } })).status);
  const ms = Date.now() - t0;
  const throttled = codes.filter((c) => c === 429).length;
  const stillAlive = await call("/auth/totp/verify", { method: "POST", body: { challengeToken: ch, code: "000000" } });
  verdict(7, "No rate limiting on second-factor verification",
    throttled === 0 && stillAlive.status === 400,
    `60 wrong codes in ${ms}ms, 429s=${throttled}, challenge still accepted afterwards (${stillAlive.status}). Statuses: ${[...new Set(codes)].join(",")}`);
}

/* ============ 8: live session can enable 2FA with no password re-check ============ */
{
  const u = await mkStaff("borrow");
  const s = await call("/auth/totp/setup", { method: "POST", token: u.token });
  const e = await call("/auth/totp/enable", { method: "POST", token: u.token, body: { code: totp.generateCode(s.data.secret) } });
  const ownerLogin = await call("/auth/login", { method: "POST", body: { email: u.email, password: u.password } });
  const removal = await call("/auth/totp", { method: "DELETE", token: e.data?.token, body: { password: "not-the-password" } });
  verdict(8, "A borrowed session can enable 2FA with no password confirmation (owner locked out)",
    s.status === 200 && e.status === 200 && ownerLogin.data?.mfaRequired === true,
    `setup=${s.status} enable=${e.status} with NO password | owner login now needs a code the attacker holds (mfaRequired=${ownerLogin.data?.mfaRequired}) | removal correctly demands the password (${removal.status})`);
}

/* ============ 10: allowance cap beaten by concurrent approvals ============ */
{
  const u = await mkStaff("cap", 10);
  const mk = async (start, end) => (await call("/leave", { method: "POST", token: admin.token, body: { staffId: u.id, type: "annual", start, end, reason: "race" } })).data.id;
  const l1 = await mk("2026-04-01", "2026-04-06");
  const l2 = await mk("2026-05-01", "2026-05-06");
  const [r1, r2] = await Promise.all([
    call(`/leave/${l1}/decision`, { method: "PUT", token: admin.token, body: { status: "approved" } }),
    call(`/leave/${l2}/decision`, { method: "PUT", token: admin.token, body: { status: "approved" } }),
  ]);
  const approved = (await db.leave.findMany({ where: { staffId: u.id, status: "approved" } })).reduce((n, l) => n + l.days, 0);
  verdict(10, "Allowance cap can be exceeded by approving two requests concurrently (TOCTOU)",
    approved > 10,
    `responses=[${r1.status},${r2.status}] | approved ${approved} days against an allowance of 10`);
}

/* ============ 11: non-string note on a leave decision ============ */
{
  const u = await mkStaff("note");
  const id = (await call("/leave", { method: "POST", token: admin.token, body: { staffId: u.id, type: "annual", start: "2026-04-01", end: "2026-04-02", reason: "note probe" } })).data.id;
  const r = await call(`/leave/${id}/decision`, { method: "PUT", token: admin.token, body: { status: "rejected", note: { a: 1 } } });
  await new Promise((x) => setTimeout(x, 600));
  const up = await alive();
  verdict(11, "Non-string `note` on a leave decision (was: crashes the API)",
    r.status === 500 || r.status === 0,
    `response=${r.status}${r.netError ? " netError=" + r.netError : ""} | API still alive afterwards=${up}  ${up ? "(wrapAsync fix holding — 500 instead of a crash)" : "(SERVER DIED)"}`);
}

/* ============ cleanup ============ */
for (const email of made) {
  const s = await db.staff.findFirst({ where: { email } });
  if (s) { await db.passwordReset.deleteMany({ where: { staffId: s.id } }); await db.staff.delete({ where: { id: s.id } }); }
}
await db.notification.deleteMany({ where: { message: { contains: "VF " } } });
await db.$disconnect();

console.log(`\n\n${"=".repeat(70)}\nSUMMARY`);
for (const r of out) console.log(`  ${r.confirmed ? "*** VULNERABLE ***" : "fixed             "}  #${String(r.n).padEnd(4)} ${r.title}`);
const back = out.filter((r) => r.confirmed).length;
const up = await alive();
console.log(`\n${out.length - back} of ${out.length} still fixed. API alive: ${up}`);
if (back > 0) console.log(`\nREGRESSION: ${back} vulnerabilit${back === 1 ? "y has" : "ies have"} returned.`);
process.exit(back > 0 || !up ? 1 : 0);
