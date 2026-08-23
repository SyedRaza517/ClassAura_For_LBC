// The PLATFORM tier — the one account type that can read, suspend and delete every
// customer we have.
//
// Everything else in this repo is tested from inside one college. This suite tests the
// surface ABOVE them all: /api/platform/*, which is mounted before the tenant
// middleware and guarded only by requirePlatformAdmin. A mistake here is not "a
// teacher saw the wrong register"; it is a customer's entire estate.
//
// So the assertions are deliberately lopsided towards the things that must be REFUSED:
// a college admin reaching the platform tier, a password alone being enough once a
// second factor is enrolled, a challenge token passing as a session, a revoked
// operator's browser tab still working, an institution being deleted without the typed
// confirmation, the platform locking itself out of its own last account.
//
//   node scripts/smoke-platform.mjs
//   (needs API_URL + DATABASE_URL; the runner supplies both)
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "..", "server");
const require = createRequire(pathToFileURL(join(server, "package.json")));

// smoke-branding reads API_BASE and falls back to a hard-coded 4010. Do NOT copy that:
// on any other TEST_PORT the suite talks to nothing and reports a silent green.
const BASE = process.env.API_URL || "http://localhost:4000/api";
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required — point it at a throwaway database.");
  process.exit(1);
}

const { PrismaClient } = require(join(server, "node_modules", "@prisma", "client"));
const bcrypt = require(join(server, "node_modules", "bcryptjs"));
const totp = require(join(server, "src", "totp.js"));

// BARE client on purpose. PlatformAdmin is the one table with no tenantId at all —
// nothing seeds it, so the operators this suite signs in as have to be created here.
// It also lets us read back what the API claims it did rather than trusting the 200.
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

// Unique per run so a run that died half way cannot poison the next one, and so the
// per-(ip+email) login limiter in platform.js starts from zero every time.
const RUN = Date.now().toString(36);
const OP_PW = "platform-operator-password-2026";
const opEmail = (who) => `op-${who}-${RUN}@platform.test`;
const COLLEGE_SLUG = `plat-${RUN}`;
const COLLEGE_PW = "new-college-admin-2026";

const makeOperator = (who, name) => db.platformAdmin.create({
  data: { email: opEmail(who), name, passwordHash: bcrypt.hashSync(OP_PW, 10) },
});

async function cleanup() {
  // By DOMAIN, not by this run's marker. Nothing reseeds PlatformAdmin — the seed does
  // not touch that table — so an operator left behind by a run that was killed half way
  // would still be active on the next one and quietly break the "last active operator"
  // count below. @platform.test is this suite's own namespace and nothing else uses it.
  await db.platformAdmin.deleteMany({ where: { email: { endsWith: "@platform.test" } } });
  const t = await db.tenant.findUnique({ where: { slug: COLLEGE_SLUG } });
  if (t) await db.tenant.delete({ where: { id: t.id } }); // cascades to every table
}

try {
  await cleanup();
  const opA = await makeOperator("a", "Operator A");
  const opB = await makeOperator("b", "Operator B");
  const opC = await makeOperator("c", "Operator C");
  const opLock = await makeOperator("lock", "Operator Lock");

  /* =========================================================== the boundary === */
  // The single most valuable pair of assertions on this router: the platform tier and
  // the college tier must not be reachable from one another's tokens. They are two
  // different populations of people — our support engineers and our customers' staff —
  // and "one boolean apart" is exactly how that goes wrong.
  console.log("\n--- who may reach the platform tier ---");

  const anon = await call("/platform/overview");
  check("no token is refused", anon.status === 401, `HTTP ${anon.status}`);

  const seededAdmin = await call("/auth/login", {
    method: "POST", tenant: "default",
    body: { email: "admin@edtech.co.uk", password: process.env.SEED_PASSWORD || "test-seed-password-2026" },
  });
  const staffToken = seededAdmin.data?.token;
  check("the seeded college administrator signs in", seededAdmin.status === 200 && !!staffToken, `HTTP ${seededAdmin.status}`);

  // A college ADMIN — unrestricted inside their own institution — must get nowhere near
  // the estate. 403 and not 401: the token is perfectly valid, it is the wrong tier.
  const asStaff = await call("/platform/overview", { token: staffToken });
  check("a college admin token is refused by the platform tier",
    asStaff.status === 403 && /Platform access required/i.test(asStaff.data?.error || ""),
    `HTTP ${asStaff.status} ${asStaff.data?.error || ""}`);

  console.log("\n--- signing in as an operator ---");

  // Unknown address and wrong password must be INDISTINGUISHABLE, or this endpoint
  // becomes a way to enumerate the handful of accounts that own every customer.
  const unknown = await call("/platform/login", { method: "POST", body: { email: `nobody-${RUN}@platform.test`, password: OP_PW } });
  const wrongPw = await call("/platform/login", { method: "POST", body: { email: opA.email, password: "not-the-password-at-all" } });
  check("an unknown operator address is refused", unknown.status === 401, `HTTP ${unknown.status}`);
  check("a wrong password gives the SAME 401 and the SAME message",
    wrongPw.status === 401 && wrongPw.data?.error === unknown.data?.error,
    JSON.stringify(unknown.data?.error));

  const loginA = await call("/platform/login", { method: "POST", body: { email: opA.email, password: OP_PW } });
  const tokenA = loginA.data?.token;
  check("correct credentials issue a session", loginA.status === 200 && !!tokenA, `HTTP ${loginA.status}`);
  // Nothing that could reconstruct the account may leave the server. A password hash is
  // offline-crackable and a TOTP secret IS the second factor.
  check("the sign-in response leaks neither the hash nor a TOTP secret",
    !/passwordHash|totpSecret/.test(JSON.stringify(loginA.data || {})));

  // The mirror image of the college-admin assertion above. A platform token carries
  // kind:"platform" and no tenantId; requireAuth in auth.js must not honour it, or a
  // support engineer would be silently acting as staff inside a customer's data.
  const crossways = await call("/staff", { token: tokenA, tenant: "default" });
  check("a platform token is refused by a college router", crossways.status === 401, `HTTP ${crossways.status}`);

  console.log("\n--- minting another operator ---");

  // The most privileged account the product can issue. A twelve-character floor is not
  // security theatre here: this password is the only thing in front of every customer's
  // data until somebody voluntarily enrols an authenticator.
  const weakOp = await call("/platform/admins", { method: "POST", token: tokenA, body: { email: opEmail("d"), name: "Operator D", password: "hunter2" } });
  check("an operator cannot be minted with a short password", weakOp.status === 400, `HTTP ${weakOp.status}`);

  const madeOp = await call("/platform/admins", { method: "POST", token: tokenA, body: { email: opEmail("d"), name: "Operator D", password: OP_PW } });
  const opD = madeOp.data;
  const opDLogin = await call("/platform/login", { method: "POST", body: { email: opEmail("d"), password: OP_PW } });
  check("a new operator is created and can sign in",
    madeOp.status === 201 && !!opD?.id && opDLogin.status === 200 && !!opDLogin.data?.token,
    `create ${madeOp.status}, login ${opDLogin.status}`);

  // PlatformAdmin.email is globally unique — a silent second row on the same address
  // would mean two different passwords opening the same operator identity, and the
  // platform log lines that name people by email would stop identifying anyone.
  const dupeOp = await call("/platform/admins", { method: "POST", token: tokenA, body: { email: opEmail("d"), name: "Impostor D", password: OP_PW } });
  check("the same operator address cannot be minted twice", dupeOp.status === 409, `HTTP ${dupeOp.status}`);

  // The operator list is a directory, not a credential store: it drives a screen, and
  // the columns it selects are the ones deliberately safe to render.
  const opList = await call("/platform/admins", { token: tokenA });
  check("the operator list carries no hashes and no TOTP secrets",
    opList.status === 200 && Array.isArray(opList.data) &&
    opList.data.some((o) => o.email === opEmail("d")) &&
    !/passwordHash|totpSecret/.test(JSON.stringify(opList.data)),
    `HTTP ${opList.status}, ${(opList.data || []).length} operators`);

  /* ============================================== the second factor (2FA) ===== */
  //
  // This login is the highest-privilege one in the product and until recently a
  // password was the only thing in front of it. Each assertion below is one way the
  // factor could quietly become decoration.
  console.log("\n--- enrolling a second factor ---");

  const loginC = await call("/platform/login", { method: "POST", body: { email: opC.email, password: OP_PW } });
  const tokenC = loginC.data?.token;
  check("operator C signs in with no second factor yet", loginC.status === 200 && !!tokenC, `HTTP ${loginC.status}`);

  // Re-asking for the password is what stops an unattended open laptop binding an
  // attacker's authenticator to the account — which then locks the real operator out of
  // the only tier that could undo it.
  const setupNoPw = await call("/platform/2fa/setup", { method: "POST", token: tokenC, body: { password: "wrong-password-entirely" } });
  check("setup demands the password again, even holding a session", setupNoPw.status === 401, `HTTP ${setupNoPw.status}`);

  const setup = await call("/platform/2fa/setup", { method: "POST", token: tokenC, body: { password: OP_PW } });
  const secret = setup.data?.secret;
  check("setup issues a secret and an otpauth URL",
    setup.status === 200 && !!secret && /^otpauth:\/\/totp\//.test(setup.data?.otpauthUrl || ""),
    `HTTP ${setup.status}`);

  // Stored but NOT enabled. An operator who scans the QR code and then loses their
  // phone before confirming must still be able to sign in tomorrow.
  const afterSetup = await db.platformAdmin.findUnique({ where: { id: opC.id } });
  check("an abandoned enrolment does not switch the factor on",
    afterSetup.totpSecret !== null && afterSetup.totpEnabled === false,
    `secret=${afterSetup.totpSecret ? "stored" : "none"} enabled=${afterSetup.totpEnabled}`);

  // Enabling against an unverified secret is the lock-out scenario in full: the flag is
  // on, the codes match nothing the operator holds, and no tier exists above to rescue
  // them.
  const enableBad = await call("/platform/2fa/enable", { method: "POST", token: tokenC, body: { code: "000000" } });
  const stillOff = await db.platformAdmin.findUnique({ where: { id: opC.id } });
  check("a wrong code cannot switch the factor on",
    enableBad.status === 400 && stillOff.totpEnabled === false, `HTTP ${enableBad.status}`);

  const enable = await call("/platform/2fa/enable", { method: "POST", token: tokenC, body: { code: totp.generateCode(secret) } });
  check("a working code switches it on", enable.status === 200 && enable.data?.totpEnabled === true, `HTTP ${enable.status}`);

  // Re-running setup once enrolled would issue a NEW secret over the working one — i.e.
  // rebind the account to whichever authenticator asked last.
  const setupAgain = await call("/platform/2fa/setup", { method: "POST", token: tokenC, body: { password: OP_PW } });
  check("setup cannot silently rebind an authenticator once enrolled", setupAgain.status === 400, `HTTP ${setupAgain.status}`);

  console.log("\n--- the password is now only the first factor ---");

  const half = await call("/platform/login", { method: "POST", body: { email: opC.email, password: OP_PW } });
  // If a `token` ever appears in this response the second factor has become optional.
  check("a correct password alone yields a challenge and NO session token",
    half.status === 200 && half.data?.mfaRequired === true && !half.data?.token,
    `HTTP ${half.status} keys=${Object.keys(half.data || {}).join(",")}`);
  const challenge = half.data?.challengeToken;

  // The challenge is signed with the same secret as a session, so only its `purpose`
  // separates them. Without that check a correct password would reach every endpoint on
  // this router and the whole flow above would be theatre.
  const challengeAsSession = await call("/platform/me", { token: challenge });
  check("the challenge token is not accepted as a session", challengeAsSession.status === 401, `HTTP ${challengeAsSession.status}`);

  const verifyBad = await call("/platform/login/verify", { method: "POST", body: { challengeToken: challenge, code: "111111" } });
  check("a wrong authenticator code is refused", verifyBad.status === 401, `HTTP ${verifyBad.status}`);

  const verify = await call("/platform/login/verify", { method: "POST", body: { challengeToken: challenge, code: totp.generateCode(secret) } });
  const tokenC2 = verify.data?.token;
  const meC = await call("/platform/me", { token: tokenC2 });
  check("the right code completes the sign-in and the session works",
    verify.status === 200 && !!tokenC2 && meC.status === 200 && meC.data?.admin?.totpEnabled === true,
    `verify HTTP ${verify.status}, me HTTP ${meC.status}`);

  console.log("\n--- removing the factor takes BOTH proofs ---");

  // A stolen session must not be able to strip the factor, and neither should a stolen
  // password on its own — so a correct password with a wrong code has to fail.
  const disableBadCode = await call("/platform/2fa/disable", { method: "POST", token: tokenC2, body: { password: OP_PW, code: "222222" } });
  const stillOn = await db.platformAdmin.findUnique({ where: { id: opC.id } });
  check("password + wrong code cannot remove the factor",
    disableBadCode.status === 400 && stillOn.totpEnabled === true, `HTTP ${disableBadCode.status}`);

  const disable = await call("/platform/2fa/disable", { method: "POST", token: tokenC2, body: { password: OP_PW, code: totp.generateCode(secret) } });
  const afterDisable = await db.platformAdmin.findUnique({ where: { id: opC.id } });
  check("password + code removes it, and the secret is destroyed with it",
    disable.status === 200 && afterDisable.totpEnabled === false && afterDisable.totpSecret === null,
    `HTTP ${disable.status}`);

  // Removing a second factor is exactly when you might be undoing someone else's
  // access, so every session outstanding — including the one that asked — must die.
  const afterRevoke = await call("/platform/me", { token: tokenC2 });
  check("removing the factor signs every existing session out", afterRevoke.status === 401, `HTTP ${afterRevoke.status}`);

  /* ================================================= provisioning a college === */
  console.log("\n--- provisioning and de-provisioning an institution ---");

  // A slug that collides with a platform hostname makes the customer unreachable, or
  // shadows the platform itself.
  const reserved = await call("/platform/tenants", {
    method: "POST", token: tokenA,
    body: { slug: "default", name: "Impostor", adminEmail: `x-${RUN}@t.test`, adminPassword: COLLEGE_PW },
  });
  check("a reserved slug is refused", reserved.status === 400 && /reserved/i.test(reserved.data?.error || ""), `HTTP ${reserved.status}`);

  const badSlug = await call("/platform/tenants", {
    method: "POST", token: tokenA,
    body: { slug: "-Bad_Slug-", name: "Impostor", adminEmail: `x-${RUN}@t.test`, adminPassword: COLLEGE_PW },
  });
  check("a malformed slug is refused", badSlug.status === 400, `HTTP ${badSlug.status}`);

  // The very first account at a new college is an unrestricted super admin. Letting it
  // be created with a five-character password is handing that over.
  const weak = await call("/platform/tenants", {
    method: "POST", token: tokenA,
    body: { slug: COLLEGE_SLUG, name: "Weak College", adminEmail: `x-${RUN}@t.test`, adminPassword: "short" },
  });
  check("a weak first-administrator password is refused", weak.status === 400, `HTTP ${weak.status}`);

  const adminEmail = `principal-${RUN}@t.test`;
  const created = await call("/platform/tenants", {
    method: "POST", token: tokenA,
    body: { slug: COLLEGE_SLUG, name: "Platform Test College", adminName: "Pat Principal", adminEmail, adminPassword: COLLEGE_PW },
  });
  const newTenantId = created.data?.tenant?.id;
  const firstAdmin = newTenantId ? await db.staff.findFirst({ where: { tenantId: newTenantId } }) : null;
  // Stamped with the NEW tenant, not the caller's and not the default one — this is the
  // isolation extension doing its job on the one write that creates a tenant's first row.
  check("a college is provisioned with an unrestricted first administrator inside it",
    created.status === 201 && !!firstAdmin && firstAdmin.tenantId === newTenantId &&
    firstAdmin.isSuperAdmin === true && firstAdmin.adminPages === null,
    `HTTP ${created.status}`);

  const dupe = await call("/platform/tenants", {
    method: "POST", token: tokenA,
    body: { slug: COLLEGE_SLUG, name: "Second College", adminEmail: `y-${RUN}@t.test`, adminPassword: COLLEGE_PW },
  });
  check("the same slug cannot be provisioned twice", dupe.status === 409, `HTTP ${dupe.status}`);

  // Suspension is the billing lever, and it has to bite on the NEXT request — not when
  // a cache happens to expire. TENANT_CACHE_MS=0 under test; forget() is what makes it
  // true in production.
  const suspend = await call(`/platform/tenants/${newTenantId}/active`, { method: "PUT", token: tokenA, body: { active: false } });
  const lockedOut = await call("/auth/login", { method: "POST", tenant: COLLEGE_SLUG, body: { email: adminEmail, password: COLLEGE_PW } });
  check("suspending an institution locks its staff out immediately",
    suspend.status === 200 && lockedOut.status === 403, `suspend ${suspend.status}, login ${lockedOut.status}`);

  const restore = await call(`/platform/tenants/${newTenantId}/active`, { method: "PUT", token: tokenA, body: { active: true } });
  const backIn = await call("/auth/login", { method: "POST", tenant: COLLEGE_SLUG, body: { email: adminEmail, password: COLLEGE_PW } });
  check("restoring lets them back in — suspension is not a delete",
    restore.status === 200 && backIn.status === 200, `restore ${restore.status}, login ${backIn.status}`);

  const badActive = await call(`/platform/tenants/${newTenantId}/active`, { method: "PUT", token: tokenA, body: { active: "false" } });
  check('the string "false" is not accepted as a boolean', badActive.status === 400, `HTTP ${badActive.status}`);

  /* ===================================================== usage and health ===== */
  // Both are operator-facing reads that span institutions, which is also why an
  // unauthenticated one would be a leak of the customer list itself.
  console.log("\n--- usage and server health ---");

  const usageAnon = await call("/platform/usage");
  const healthAnon = await call("/platform/health");
  check("usage and server health both require an operator",
    usageAnon.status === 401 && healthAnon.status === 401, `usage ${usageAnon.status}, health ${healthAnon.status}`);

  const usage = await call("/platform/usage", { token: tokenA });
  const mine = (usage.data?.tenants || []).find((t) => t.id === newTenantId);
  const dflt = (usage.data?.tenants || []).find((t) => t.slug === "default");
  // Row counts are exact count(*) per tenant, unlike the byte figures — so they are the
  // half of this payload worth asserting on. The new college was provisioned with
  // exactly ONE staff row while the seeded one has six plus ten students and 194
  // attendance marks; if those two lines ever match, the grouping has collapsed into a
  // database-wide total repeated on every institution, and every invoice is wrong.
  const mineStaff = (mine?.topTables || []).find((t) => t.name === "Staff");
  check("usage is attributed per institution, not shared out",
    usage.status === 200 && !!mine && mineStaff?.rows === 1 && !!dflt && dflt.rows > mine.rows,
    mine ? `new=${mine.rows} rows (Staff ${mineStaff?.rows}), default=${dflt?.rows} rows` : "new tenant missing from usage");
  // A number that ends up on an invoice must not claim a precision it does not have,
  // and unattributed shared overhead must be shown rather than billed to somebody.
  const dbFig = usage.data?.database || {};
  check("database figures are labelled estimates, with overhead shown separately",
    dbFig.totalBytes > 0 &&
    dbFig.overheadBytes === Math.max(0, dbFig.totalBytes - dbFig.accountedBytes) &&
    /estimated/i.test(usage.data?.note || ""),
    `total=${dbFig.totalSize} accounted=${dbFig.accountedSize} overhead=${dbFig.overheadSize}`);
  // File storage lives outside Postgres and IS exact, so it is reported apart — a
  // college with 4GB of scanned passports has a tiny database and a large footprint,
  // and averaging those together would hide both.
  check("file storage is reported separately from the database estimate",
    typeof mine?.fileBytes === "number" && mine.files === 0 && typeof mine.fileSize === "string",
    `files=${mine?.files} ${mine?.fileSize}`);

  const health = await call("/platform/health", { token: tokenA });
  check("server health proves the credential key round-trips, not merely that it is set",
    health.status === 200 && health.data?.credentials?.configured === true && health.data?.credentials?.working === true,
    JSON.stringify(health.data?.credentials || {}));
  // The point of this endpoint is that an operator no longer has to borrow a customer's
  // login to check their own configuration. It must report the FACT of a setting, never
  // the value — a health screen is not a place to read secrets out of.
  const key = process.env.CREDENTIALS_KEY || "";
  check("server health never echoes the credential key itself",
    key.length > 0 && !JSON.stringify(health.data).includes(key),
    key ? "key withheld" : "CREDENTIALS_KEY not set — nothing to withhold");

  // Mounted BEFORE the tenant middleware. If this ever 404s on an unknown slug the
  // platform tier has become dependent on a customer existing, and an operator would
  // lose the dashboard at exactly the moment a tenant lookup is what is broken.
  const healthNoTenant = await call("/platform/health", { token: tokenA, tenant: `no-such-college-${RUN}` });
  const publicHealth = await call("/health", { tenant: `no-such-college-${RUN}` });
  check("platform routes and /health bypass tenant resolution entirely",
    healthNoTenant.status === 200 && publicHealth.status === 200 && publicHealth.data?.ok === true,
    `platform ${healthNoTenant.status}, public ${publicHealth.status}`);

  /* ============================================ the login rate limiter ======== */
  // This login shipped without one and was the softest target on the platform: a
  // handful of accounts, each owning every customer's data, behind an unlimited
  // password endpoint.
  console.log("\n--- brute force against an operator account ---");

  for (let i = 0; i < 5; i++) {
    await call("/platform/login", { method: "POST", body: { email: opLock.email, password: `guess-${i}` } });
  }
  const afterFive = await call("/platform/login", { method: "POST", body: { email: opLock.email, password: "guess-final" } });
  check("repeated guesses lock the account rather than being answered forever",
    afterFive.status === 429 && /minute/i.test(afterFive.data?.error || ""),
    `HTTP ${afterFive.status} ${afterFive.data?.error || ""}`);
  // Checked BEFORE the password comparison, deliberately: otherwise a locked account
  // still tells an attacker when they have guessed right, and the lock is only a delay.
  const rightWhileLocked = await call("/platform/login", { method: "POST", body: { email: opLock.email, password: OP_PW } });
  check("even the CORRECT password is refused while locked",
    rightWhileLocked.status === 429 && !rightWhileLocked.data?.token, `HTTP ${rightWhileLocked.status}`);

  /* ================================================= operator lifecycle ======= */
  console.log("\n--- removing an operator's access ---");

  const loginB = await call("/platform/login", { method: "POST", body: { email: opB.email, password: OP_PW } });
  const tokenB = loginB.data?.token;
  const meB = await call("/platform/me", { token: tokenB });
  check("operator B holds a live session", loginB.status === 200 && meB.status === 200, `HTTP ${loginB.status}/${meB.status}`);

  // The likeliest misclick is your own row, and it succeeds and then locks you out of
  // the screen you would use to undo it.
  const self = await call(`/platform/admins/${opA.id}/active`, { method: "PUT", token: tokenA, body: { active: false } });
  check("an operator cannot deactivate their own account", self.status === 400, `HTTP ${self.status}`);

  const nonBool = await call(`/platform/admins/${opB.id}/active`, { method: "PUT", token: tokenA, body: { active: "no" } });
  const missing = await call(`/platform/admins/nope-${RUN}/active`, { method: "PUT", token: tokenA, body: { active: false } });
  check("a non-boolean is 400 and an unknown operator is 404",
    nonBool.status === 400 && missing.status === 404, `${nonBool.status}/${missing.status}`);

  const kill = await call(`/platform/admins/${opB.id}/active`, { method: "PUT", token: tokenA, body: { active: false } });
  const bDead = await call("/platform/me", { token: tokenB });
  const bRow = await db.platformAdmin.findUnique({ where: { id: opB.id } });
  // `active:false` alone would be enough for the NEXT sign-in, but a session already in
  // a browser tab has 8 hours left on it. Someone whose access has just been removed
  // must stop being able to act now, not when their token expires.
  check("deactivating an operator kills the session already in their browser",
    kill.status === 200 && bDead.status === 401 && bRow.active === false && bRow.tokenVersion > 0,
    `revoke ${kill.status}, old session ${bDead.status}, ver=${bRow.tokenVersion}`);

  const bLogin = await call("/platform/login", { method: "POST", body: { email: opB.email, password: OP_PW } });
  check("a deactivated operator cannot sign back in", bLogin.status === 401, `HTTP ${bLogin.status}`);

  // Reach the "last one standing" guard: with the self-check above in place it is only
  // reachable when every other operator is already inactive. A platform with no
  // operator has nothing above it — no reset email, no rescue tier, only a psql session
  // on production.
  await db.platformAdmin.updateMany({ where: { id: { in: [opC.id, opLock.id, opD.id] } }, data: { active: false } });
  const activeNow = await db.platformAdmin.count({ where: { active: true } });
  const lastOne = await call(`/platform/admins/${opB.id}/active`, { method: "PUT", token: tokenA, body: { active: false } });
  check("the last active operator cannot be deactivated",
    activeNow === 1 && lastOne.status === 400 && /last active/i.test(lastOne.data?.error || ""),
    `${activeNow} active, HTTP ${lastOne.status}`);

  const back = await call(`/platform/admins/${opB.id}/active`, { method: "PUT", token: tokenA, body: { active: true } });
  const bLogin2 = await call("/platform/login", { method: "POST", body: { email: opB.email, password: OP_PW } });
  const bOldToken = await call("/platform/me", { token: tokenB });
  // Restoring gives back the ACCOUNT, not the sessions. A token revoked while the
  // account was off must stay dead — otherwise a removal that was later reversed
  // silently re-arms whatever was holding that token in the meantime.
  check("restoring an operator does not resurrect their revoked session",
    back.status === 200 && bLogin2.status === 200 && bOldToken.status === 401,
    `restore ${back.status}, fresh login ${bLogin2.status}, old token ${bOldToken.status}`);

  /* ========================================== deleting an institution ========= */
  console.log("\n--- deleting an institution (there is no undo) ---");

  const noConfirm = await call(`/platform/tenants/${newTenantId}`, { method: "DELETE", token: tokenA, body: { confirm: "wrong-slug" } });
  const survives = await db.tenant.findUnique({ where: { id: newTenantId } });
  // Nothing else in the product destroys a customer. The typed confirmation is the only
  // thing between a misrouted DELETE and a college's entire history.
  check("deletion without the typed slug is refused and the college survives",
    noConfirm.status === 400 && !!survives, `HTTP ${noConfirm.status}`);

  const staffBefore = await db.staff.count({ where: { tenantId: newTenantId } });
  const gone = await call(`/platform/tenants/${newTenantId}`, { method: "DELETE", token: tokenA, body: { confirm: COLLEGE_SLUG } });
  const staffAfter = await db.staff.count({ where: { tenantId: newTenantId } });
  const tenantAfter = await db.tenant.findUnique({ where: { id: newTenantId } });
  check("deletion with the typed slug removes the tenant and everything under it",
    gone.status === 200 && staffBefore > 0 && staffAfter === 0 && tenantAfter === null,
    `${staffBefore} -> ${staffAfter} staff rows`);

  // And it took nothing else with it. A cascade that reached across tenants would be
  // the worst incident this codebase could have.
  const seededStaff = await db.staff.count({ where: { tenant: { slug: "default" } } });
  check("the seeded institution is untouched by that cascade", seededStaff >= 6, `${seededStaff} staff rows remain`);
} finally {
  await cleanup();
  await db.$disconnect();
  console.log("\ncleanup: test operators and the test institution removed");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
