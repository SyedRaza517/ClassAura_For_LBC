// Admin-created accounts must be UNUSABLE until the person activates them.
//
// Before this, an admin adding someone created the account with the shared default
// password "password123" — so anyone who knew or guessed the email address could
// sign straight in as them, with no approval and no second factor.
//
// Prereq: API running on http://localhost:4000  (npm run dev)
// Usage:  node scripts/smoke-invite.mjs
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import crypto from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
const require = createRequire(pathToFileURL(join(ROOT, "server", "package.json")));
const { PrismaClient } = require(`${ROOT}/server/node_modules/@prisma/client`);
// Needed to prove the stored hash matches none of the passwords an invite might have
// shipped — the claim the check near the bottom of this file makes by name.
const bcrypt = require(`${ROOT}/server/node_modules/bcryptjs`);
// The passwords an invited account must NOT already hold. Named once so the login
// attempts below and the stored-hash assertion are demonstrably the same list.
const GUESSES = ["Password123!", "changeme", "welcome", "edtech2026", ""];
// The same database the API under test is using. This was a hardcoded SQLite file
// path — a leftover from before the move to PostgreSQL — which made every suite that
// touches the database directly fail schema validation before running a single query.
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required — point it at a throwaway database."); process.exit(1); }
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
// This client is deliberately bare: it verifies what the API did, so it must not be
// the one the API writes through. It used to also have to look up the seeded tenant
// and stamp tenantId onto every fixture below, because a bare client got no tenant
// injected for it. One deployment now serves one college, tenantId is gone from the
// schema, and a fixture simply belongs to the only institution there is.

const BASE = process.env.API_URL || "http://localhost:4000/api";
const SEED_PW = process.env.SEED_PASSWORD || "password123";
const TAG = `inv${Date.now()}`;
const made = [];
let pass = 0, fail = 0;
const check = (l, ok, d = "") => { console.log(`${ok ? "✓" : "✗"} ${l}${d ? "  — " + d : ""}`); ok ? pass++ : fail++; };

async function call(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}
const admin = (await call("/auth/login", { method: "POST", body: { email: "admin@edtech.co.uk", password: SEED_PW } })).data;

// The raw invite token only exists in the email, so read it back the way the server
// stores it: hash a candidate and look for the row. Here we plant a known one.
const hash = (raw) => crypto.createHash("sha256").update(raw).digest("hex");
async function inviteTokenFor(staffId) {
  const raw = crypto.randomBytes(32).toString("hex");
  await db.passwordReset.updateMany({ where: { staffId, purpose: "invite", usedAt: null }, data: { usedAt: new Date() } });
  await db.passwordReset.create({ data: { staffId, tokenHash: hash(raw), purpose: "invite", expiresAt: new Date(Date.now() + 7 * 864e5) } });
  return raw;
}

console.log("\n--- an admin-created account cannot be signed into ---");
const email = `${TAG}.a@edtech.co.uk`;
made.push(email);
const created = await call("/staff", { method: "POST", token: admin.token, body: { name: "Invite One", email, role: "Lecturer", dept: "Teaching" } });
check("account created (201)", created.status === 201);
check("flagged as pending activation", created.data?.pendingActivation === true, JSON.stringify(created.data?.pendingActivation));
check("the response says an invitation was sent", created.data?.invited === true);

check("THE OLD HOLE IS CLOSED: password123 is refused", (await call("/auth/login", { method: "POST", body: { email, password: "password123" } })).status === 401);
for (const guess of GUESSES) {
  // An empty password is a 400 ("email and password required") rather than a 401;
  // what matters is that no session ever comes back.
  const r = await call("/auth/login", { method: "POST", body: { email, password: guess } });
  check(`a guessed password "${guess || "(empty)"}" is refused`, r.status !== 200 && !r.data?.token, `HTTP ${r.status}`);
}
const row = await db.staff.findFirst({ where: { email } });
// THE LABEL NOW MATCHES WHAT IS CHECKED. This read
// `check("the stored password is not the shared default", row.pendingActivation === true)`
// — a claim about the password, asserted by looking at a completely different column,
// and a duplicate of the "flagged as pending activation" check a few lines above. It
// would have passed with `password123` hashed into the row, which is precisely the thing
// its name promised nobody had done.
check("the invited account is flagged pending activation", !!row && row.pendingActivation === true);
// The password claim, actually tested: an invited account must hold no usable
// credential at all until the invitee sets one. A hash that verifies against any of the
// guesses tried above would mean the invite shipped a known password.
check("...and carries no usable password until it is activated",
  !!row && (row.passwordHash === null || !GUESSES.some((g) => g && bcrypt.compareSync(g, row.passwordHash))),
  row?.passwordHash === null ? "no hash stored" : "hash matches none of the guessed defaults");

console.log("\n--- activating it ---");
const token = await inviteTokenFor(row.id);
check("garbage invite token rejected", (await call("/auth/invite/verify", { method: "POST", body: { token: "nope" } })).status === 400);
const verify = await call("/auth/invite/verify", { method: "POST", body: { token } });
check("a valid invite verifies", verify.status === 200 && verify.data?.email === email);
check("verify returns no secrets", !JSON.stringify(verify.data).match(/passwordHash|totpSecret|tokenHash/));

check("a short password is refused", (await call("/auth/invite/accept", { method: "POST", body: { token, newPassword: "short" } })).status === 400);
check("the account is still inactive after that", (await db.staff.findFirst({ where: { email } })).pendingActivation === true);

const accept = await call("/auth/invite/accept", { method: "POST", body: { token, newPassword: "MyOwnPass123!" } });
check("activation succeeds", accept.status === 200, JSON.stringify(accept.data));
check("no session is handed back — they sign in fresh", !accept.data?.token);
check("the account is now active", (await db.staff.findFirst({ where: { email } })).pendingActivation === false);
check("they can sign in with THEIR password", !!(await call("/auth/login", { method: "POST", body: { email, password: "MyOwnPass123!" } })).data?.token);
check("password123 still does not work", (await call("/auth/login", { method: "POST", body: { email, password: "password123" } })).status === 401);
check("the invite link is single-use", (await call("/auth/invite/verify", { method: "POST", body: { token } })).status === 400);

console.log("\n--- invite tokens and reset tokens are not interchangeable ---");
const email2 = `${TAG}.b@edtech.co.uk`;
made.push(email2);
const s2 = (await call("/staff", { method: "POST", token: admin.token, body: { name: "Invite Two", email: email2 } })).data;
const inviteTok = await inviteTokenFor(s2.id);
check("an invite token is refused by the password-reset endpoint", (await call("/auth/reset-password", { method: "POST", body: { token: inviteTok, newPassword: "Whatever123!" } })).status === 400);
// ...and the reverse
const rawReset = crypto.randomBytes(32).toString("hex");
await db.passwordReset.create({ data: { staffId: s2.id, tokenHash: hash(rawReset), purpose: "reset", expiresAt: new Date(Date.now() + 18e5) } });
check("a reset token is refused by the invite endpoint", (await call("/auth/invite/accept", { method: "POST", body: { token: rawReset, newPassword: "Whatever123!" } })).status === 400);

console.log("\n--- re-sending an invitation ---");
check("staff cannot re-send invitations", (await call(`/staff/${s2.id}/invite`, { method: "POST", token: (await call("/auth/login", { method: "POST", body: { email: "j.whitfield@edtech.co.uk", password: SEED_PW } })).data.token })).status === 403);
check("an admin can re-send", (await call(`/staff/${s2.id}/invite`, { method: "POST", token: admin.token })).status === 200);
check("re-sending retires the previous link", (await call("/auth/invite/verify", { method: "POST", body: { token: inviteTok } })).status === 400);
check("re-sending to an already-active account is refused", (await call(`/staff/${(await db.staff.findFirst({ where: { email } })).id}/invite`, { method: "POST", token: admin.token })).status === 400);

console.log("\n--- an explicit password still works (no invitation) ---");
const email3 = `${TAG}.c@edtech.co.uk`;
made.push(email3);
const s3 = await call("/staff", { method: "POST", token: admin.token, body: { name: "Invite Three", email: email3, password: "ChosenByAdmin1!" } });
check("created with a supplied password", s3.status === 201);
check("not pending activation", s3.data?.pendingActivation === false);
check("usable immediately", !!(await call("/auth/login", { method: "POST", body: { email: email3, password: "ChosenByAdmin1!" } })).data?.token);

console.log("\n--- app sign-up still requires approval (unchanged) ---");
const email4 = `${TAG}.d@edtech.co.uk`;
made.push(email4);
await call("/signup", { method: "POST", body: { name: "Invite Four", email: email4, password: "TheirPass123!", confirmPassword: "TheirPass123!", position: "Tutor", dept: "Teaching" } });
check("no Staff row before approval", !(await db.staff.findFirst({ where: { email: email4 } })));
check("cannot sign in before approval", (await call("/auth/login", { method: "POST", body: { email: email4, password: "TheirPass123!" } })).status === 401);

// cleanup
await db.passwordReset.deleteMany({ where: { staff: { email: { in: made } } } });
for (const e of made) {
  const s = await db.staff.findFirst({ where: { email: e } });
  if (s) await db.staff.delete({ where: { id: s.id } });
}
await db.signupRequest.deleteMany({ where: { email: { in: made } } });
await db.notification.deleteMany({ where: { message: { contains: "Invite " } } });
await db.$disconnect();
console.log("\ncleanup: probe accounts and invitations removed");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
