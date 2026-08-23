// How an organisation becomes a customer — the only route that creates an institution
// from OUTSIDE the platform.
//
// Everything else in this repo assumes a tenant already exists. This flow is the one
// that manufactures one, from a form filled in by a stranger, so it is the single
// endpoint where a mistake does not leak a college's data — it hands somebody a whole
// college of their own, on our platform, with a super-admin account in it.
//
// THE CONTROL BEING TESTED
//
// A live institution requires TWO independent decisions:
//   1. an operator approved the application and issued a one-time access code
//   2. the applicant redeemed that code with the address they applied from
// Either half alone must be worth nothing. Most of what follows is therefore
// negative: proving that a form submission, a guessed code, a stolen code, a spent
// code, a rejected code and a locked-out code all fail to produce an institution.
//
//   node scripts/smoke-registrations.mjs
//   (needs API_URL + DATABASE_URL; the runner supplies both)
//
// NEVER run this against a database you care about. It creates and deletes tenants,
// registrations and platform operators. server/.env points at live staging — pass
// DATABASE_URL explicitly:
//
//   DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/edtech_test_reg2" \
//   TEST_PORT=4130 JWT_SECRET="suite-secret" SEED_PASSWORD="test-seed-password-2026" \
//   npm test -- smoke-registrations
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "..", "server");
const require = createRequire(pathToFileURL(join(server, "package.json")));

// API_URL, not API_BASE — API_URL is what scripts/test.mjs exports to a suite. Reading
// the wrong name means the suite silently talks to a default port, finds nothing there,
// and reports whatever the connection error happens to look like.
const BASE = process.env.API_URL || "http://localhost:4010/api";
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required — point it at a throwaway database.");
  process.exit(1);
}

const { PrismaClient } = require(join(server, "node_modules", "@prisma", "client"));
const bcrypt = require(join(server, "node_modules", "bcryptjs"));

// A BARE client on purpose, for two reasons. Nothing seeds PlatformAdmin, so the
// operator this suite reviews applications as has to be created here; and half the
// assertions below are about what is in the DATABASE rather than what the API said it
// did — a stored code hash, a tenant that must not exist, an attempt counter. Trusting
// the 200 would test the response body, not the control.
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

/* --------------------------------------------------------------- reporting --- */

let passed = 0, failed = 0, known = 0;
const tick = (label, detail) => { passed++; console.log(`✓ ${label}${detail ? "  — " + detail : ""}`); };

async function check(label, fn) {
  try { tick(label, await fn()); }
  catch (e) { failed++; console.log(`✗ ${label}\n    ${e && e.message ? e.message : e}`); }
}

// A DOCUMENTED DEFECT. The assertion states what the code should do; if it currently
// does not, it is reported loudly but does not fail the run, so a real regression
// elsewhere stays visible instead of being buried under a known gap. If one of these
// starts passing, the bug is fixed and the call should become a plain check().
async function bug(label, fn) {
  try { tick(label, await fn()); }
  catch (e) { known++; console.log(`! KNOWN BUG — ${label}\n    ${e && e.message ? e.message : e}`); }
}

/* ------------------------------------------------------------------- setup --- */

async function call(path, { method = "GET", body, token, tenant, ip } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (tenant) headers["X-Tenant"] = tenant;
  // The API runs behind a reverse proxy (`app.set("trust proxy", 1)`), so the caller's
  // address comes from X-Forwarded-For. Giving each part of this suite its own address
  // is what a real deployment sees — many applicants, not one — and it keeps the
  // per-IP submission limiter from turning an unrelated assertion red. The limiter
  // itself is tested at the end, on an address used for nothing else.
  if (ip) headers["X-Forwarded-For"] = ip;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}

// Unique per run so a run that died half way cannot poison the next one.
const RUN = Date.now().toString(36);
const DOMAIN = "@regsuite.test";      // this suite's own namespace — nothing else uses it
const SLUG_PREFIX = "regsuite-";      // every tenant this suite can cause to exist
const OP_PW = "registration-operator-2026";
const PW = "regsuite-strong-password-2026";
const WEAK_PW = "short";              // under the 12-character minimum
const opEmail = `op-${RUN}${DOMAIN}`;

// A private address range, derived from the run marker, so two runs against the same
// long-lived API process do not share a submission budget.
const h = [...RUN].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const ip = (n) => `10.${(h % 251) + 1}.${((h >> 8) % 251) + 1}.${n}`;

// The server's own rules, restated here on purpose: if routes/registrations.js relaxes
// them, this suite should notice rather than follow along.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
const RESERVED_SLUGS = new Set(["www", "api", "app", "admin", "staging", "platform", "default", "test"]);
const CODE_RE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const REFUSAL = "That email address and access code do not match an approved registration.";

const hashCode = (code) => createHash("sha256").update(String(code).toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");

async function cleanup() {
  // By NAMESPACE, not by this run's marker: a run killed half way leaves a tenant and a
  // platform operator behind, and nothing reseeds either table.
  const regs = await db.collegeRegistration.findMany({ where: { contactEmail: { endsWith: DOMAIN } } });
  const ids = regs.map((r) => r.tenantId).filter(Boolean);
  if (ids.length) await db.tenant.deleteMany({ where: { id: { in: ids } } }); // cascades
  await db.tenant.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
  await db.collegeRegistration.deleteMany({ where: { contactEmail: { endsWith: DOMAIN } } });
  await db.platformAdmin.deleteMany({ where: { email: { endsWith: DOMAIN } } });
}

/** Apply through the real public form, as an applicant would. */
const apply = (fields, from) => call("/registrations", { method: "POST", ip: from, body: fields });

/** The application an operator sees for this address. Read through the queue, not the
 *  database, so the id used for approval is the one the operator actually has. */
async function fromQueue(token, email) {
  const r = await call("/registrations", { token });
  assert.equal(r.status, 200, `queue returned HTTP ${r.status}`);
  const rows = r.data.registrations.filter((x) => x.contactEmail === email);
  assert.equal(rows.length, 1, `expected exactly one application for ${email}, found ${rows.length}`);
  return rows[0];
}

console.log("\n=== college registrations ===\n");

try {
  await cleanup();

  await db.platformAdmin.create({
    data: { email: opEmail, name: "Registrations Operator", passwordHash: bcrypt.hashSync(OP_PW, 10) },
  });
  const opLogin = await call("/platform/login", { method: "POST", body: { email: opEmail, password: OP_PW } });
  // Thrown rather than exited, so the finally block still clears up after us.
  if (!opLogin.data?.token) throw new Error("could not sign in as the platform operator: " + JSON.stringify(opLogin.data).slice(0, 200));
  const OP = opLogin.data.token;

  // Every applicant this suite invents. Distinct addresses, one namespace.
  const email = (who) => `${who}-${RUN}${DOMAIN}`;
  const MERIDIAN = email("meridian");   // the happy path, end to end
  const NORTHGATE = email("northgate");  // applies and is never approved
  const KESTREL = email("kestrel");    // guessed at until it locks
  const HARBOUR = email("harbour");    // approved, then rejected
  const BEACON = email("beacon");     // its slug is taken by somebody else
  const LONGSLUG = email("longslug");   // its slug is taken AND nearly too long

  /* ================================================================ the form === */

  await check("the honeypot is accepted and stores nothing", async () => {
    // A form that rejects the honeypot tells the bot which field to leave alone next
    // time. It has to look exactly like success and write nothing at all — a review
    // queue full of machine submissions is a denial of service against the operator.
    const r = await apply({
      legalName: "Regsuite Bot College", contactName: "Bot", contactEmail: email("bot"),
      website2: "http://spam.example",
    }, ip(1));
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
    assert.deepEqual(r.data, { received: true }, "a bot must not be able to tell it was caught");
    const row = await db.collegeRegistration.findFirst({ where: { contactEmail: email("bot") } });
    assert.equal(row, null, "the honeypot submission was STORED — the queue can be flooded");
    return "same reply, no row";
  });

  await check("an application without a legal name is refused", async () => {
    const r = await apply({ contactName: "A Person", contactEmail: email("nameless") }, ip(2));
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    return r.data.error;
  });

  await check("an address that is not an address is refused", async () => {
    // The contact address is the only thing tying the code we issue to a human being;
    // an unusable one means the institution can never be activated.
    const r = await apply({ legalName: "Regsuite Nowhere", contactName: "A Person", contactEmail: "not-an-email" }, ip(2));
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    return r.data.error;
  });

  await check("a web address that is not a slug is refused", async () => {
    const r = await apply({
      legalName: "Regsuite Slugless", contactName: "A Person", contactEmail: email("slugless"),
      requestedSlug: "Not A Slug!",
    }, ip(2));
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    return r.data.error;
  });

  await check("a real application is accepted, and returns no id", async () => {
    const r = await apply({
      legalName: `Regsuite Meridian ${RUN}`, tradingName: "Meridian College",
      institutionType: "fe", registrationNumber: "12345678", country: "United Kingdom",
      approxStaff: 120, approxStudents: 2400,
      contactName: "Ada Lovelace", contactRole: "Principal", contactEmail: MERIDIAN,
      contactPhone: "+44 20 7946 0000", notes: "Two campuses.",
    }, ip(3));
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
    assert.deepEqual(r.data, { received: true });
    // An id in the reply is a handle to enumerate and a handle to attack: the approve
    // and reject routes are addressed by it.
    assert.ok(!("id" in r.data), "the applicant must not be handed the registration id");
    return "received";
  });

  await check("applying twice says exactly the same thing", async () => {
    // "You have already registered" would confirm, to anyone who can type an address,
    // which organisations are talking to us. That is a customer list.
    const r = await apply({
      legalName: `Regsuite Meridian ${RUN}`, contactName: "Ada Lovelace", contactEmail: MERIDIAN,
    }, ip(4));
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
    assert.deepEqual(r.data, { received: true }, "the second reply differs from the first");
    // Clean the duplicate away again — fromQueue() asserts one row per address, and a
    // second row here would make every later assertion ambiguous.
    const dupes = await db.collegeRegistration.findMany({ where: { contactEmail: MERIDIAN } });
    assert.equal(dupes.length, 2, "the duplicate application was not stored at all");
    // Identified by content, not by timestamp: both were submitted in the same
    // millisecond, so ordering by submittedAt would pick one at random.
    const spare = dupes.find((d) => d.approxStaff === null);
    assert.ok(spare, "could not tell the two applications apart");
    await db.collegeRegistration.delete({ where: { id: spare.id } });
    return "no oracle";
  });

  await check("an application grants nothing on its own", async () => {
    // The row exists, and it is inert: no code, no tenant, nobody has looked at it.
    const row = await db.collegeRegistration.findFirst({ where: { contactEmail: MERIDIAN } });
    assert.ok(row, "the application was not stored");
    assert.equal(row.status, "pending");
    assert.equal(row.accessCodeHash, null, "an unreviewed application already has a code");
    assert.equal(row.tenantId, null, "an unreviewed application already has an institution");
    assert.equal(row.approxStaff, 120, "the numbers on the form were not stored");
    return "pending, no code, no tenant";
  });

  /* ======================================================== who may review === */

  for (const [what, path, method] of [
    ["the queue", "/registrations", "GET"],
    ["approval", "/registrations/anything/approve", "POST"],
    ["rejection", "/registrations/anything/reject", "POST"],
  ]) {
    await check(`${what} is refused without a token`, async () => {
      // The queue is the list of every organisation in discussion with us, with names,
      // phone numbers and staff counts. Approval mints an institution. Neither is
      // public, and both sit ABOVE the tenant middleware where no college guard runs.
      const r = await call(path, { method });
      assert.equal(r.status, 401, `expected 401, got ${r.status}`);
      assert.ok(!JSON.stringify(r.data || {}).includes("legalName"), "it answered with data anyway");
      return `HTTP 401 ${r.data?.error || ""}`;
    });
  }

  const college = await call("/auth/login", { method: "POST", body: { email: "admin@edtech.co.uk", password: process.env.SEED_PASSWORD || "test-seed-password-2026" } });
  if (college.data?.token) {
    await check("a college's own super-admin cannot read the queue", async () => {
      // The tier boundary. A customer's administrator holds a perfectly valid token —
      // it is simply not a platform token, and the pipeline of other prospective
      // colleges is none of their business.
      const r = await call("/registrations", { token: college.data.token });
      assert.equal(r.status, 403, `expected 403, got ${r.status}`);
      return r.data?.error;
    });
  } else {
    console.log("  (skipped the college-admin boundary check — the seeded admin could not sign in)");
  }

  await check("an operator sees the application in the queue", async () => {
    const r = await call("/registrations", { token: OP });
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
    const mine = r.data.registrations.find((x) => x.contactEmail === MERIDIAN);
    assert.ok(mine, "the application submitted through the public form is not in the queue");
    assert.equal(mine.status, "pending");
    assert.equal(mine.contactName, "Ada Lovelace");
    assert.ok(r.data.counts.pending >= 1, "the status counts are wrong");
    return `${r.data.registrations.length} rows, ${r.data.counts.pending} pending`;
  });

  await check("the queue can be filtered by status", async () => {
    const pending = await call("/registrations?status=pending", { token: OP });
    assert.ok(pending.data.registrations.every((x) => x.status === "pending"), "a filtered queue returned other statuses");
    assert.ok(pending.data.registrations.some((x) => x.contactEmail === MERIDIAN));
    const rejected = await call("/registrations?status=rejected", { token: OP });
    assert.ok(!rejected.data.registrations.some((x) => x.contactEmail === MERIDIAN), "a pending application appeared under 'rejected'");
    return "pending / rejected are disjoint";
  });

  /* ============================== applying is not being approved ============ */

  await apply({
    legalName: `Regsuite Northgate ${RUN}`, contactName: "Grace Hopper", contactEmail: NORTHGATE,
    requestedSlug: `${SLUG_PREFIX}northgate-${RUN}`.slice(0, 32),
  }, ip(5));

  await check("a code cannot be redeemed before anyone has approved anything", async () => {
    // The whole control in one assertion: filling in a form must not be enough, no
    // matter what the applicant sends to /activate. If this ever passes, anyone who
    // can POST a form can mint themselves an institution.
    const r = await call("/registrations/activate", {
      method: "POST", body: { email: NORTHGATE, code: "ZZZZ-ZZZZ-ZZZZ", password: PW },
    });
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    assert.equal(r.data.error, REFUSAL);
    const row = await db.collegeRegistration.findFirst({ where: { contactEmail: NORTHGATE } });
    assert.equal(row.status, "pending", "an unapproved application changed state");
    assert.equal(row.tenantId, null, "AN INSTITUTION WAS CREATED FROM AN UNAPPROVED APPLICATION");
    assert.equal(row.codeAttempts, 0, "an application with no code spent an attempt");
    return REFUSAL;
  });

  /* ============================================ approval issues one code === */

  const reg1 = await fromQueue(OP, MERIDIAN);
  let code1 = null;

  await check("approval issues a code, and shows it once", async () => {
    const r = await call(`/registrations/${reg1.id}/approve`, {
      method: "POST", token: OP, body: { expiresInDays: 14, note: "Verified by phone." },
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
    code1 = r.data.code;
    assert.ok(CODE_RE.test(code1), `the code is not in the expected shape: ${code1}`);
    assert.equal(r.data.registration.status, "approved");
    assert.equal(r.data.registration.reviewedBy, opEmail, "the decision was not attributed to the operator who made it");
    assert.equal(r.data.registration.decisionNote, "Verified by phone.");
    assert.ok(new Date(r.data.registration.codeExpiresAt) > new Date(), "the code is issued already expired");
    return code1.slice(0, 4) + "-…";
  });

  await check("only the last four characters are ever readable", async () => {
    // An operator has to be able to say "the code ending 7K2P" on the phone without
    // being able to read the code itself — out of the API, out of a screenshot, or out
    // of a database backup.
    const r = await call("/registrations", { token: OP });
    const mine = r.data.registrations.find((x) => x.contactEmail === MERIDIAN);
    assert.equal(mine.accessCodeHint, code1.slice(-4), "the hint is not the last four characters");
    const queue = JSON.stringify(r.data);
    assert.ok(!queue.includes(code1), "THE FULL CODE IS READABLE FROM THE QUEUE");
    assert.ok(!queue.includes(code1.replace(/-/g, "")), "the full code is readable, unpunctuated");
    return `…${mine.accessCodeHint}`;
  });

  await check("the code hash is never in any response", async () => {
    // Stored hashed like a password reset token, and the hash is as good as the code
    // to anyone who can replay it into the comparison. It must not appear in the
    // approval reply, the queue, or as a field name a future serialiser might copy.
    const stored = await db.collegeRegistration.findUnique({ where: { id: reg1.id } });
    assert.equal(stored.accessCodeHash, hashCode(code1), "the stored value is not the sha256 of the code");
    assert.notEqual(stored.accessCodeHash, code1, "THE CODE IS STORED IN READABLE FORM");
    const queue = await call("/registrations", { token: OP });
    const body = JSON.stringify(queue.data);
    assert.ok(!body.includes(stored.accessCodeHash), "the code hash was returned to the caller");
    assert.ok(!/accessCodeHash/.test(body), "the response carries an accessCodeHash field");
    return "hashed, and absent from every response";
  });

  await check("the code cannot be read back after it is issued", async () => {
    // The operator gets one sight of it. Anything that could show it again — a second
    // GET, a re-read of the row — would leave a readable credential lying about for
    // the life of the account.
    const again = await call("/registrations", { token: OP });
    assert.ok(!JSON.stringify(again.data).includes(code1.replace(/-/g, "")), "the code came back on a second read");
    const row = await db.collegeRegistration.findUnique({ where: { id: reg1.id } });
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === "string") assert.ok(!v.includes(code1.replace(/-/g, "")), `the code is readable in column ${k}`);
    }
    return "gone from the database too";
  });

  /* ================================================== redeeming the code === */

  await check("a weak password is refused, and costs the applicant nothing", async () => {
    // Checked BEFORE the code, which matters: a person who typed the right code and a
    // short password must not burn one of their ten attempts on it. This account is a
    // super-admin over a whole institution.
    const r = await call("/registrations/activate", { method: "POST", body: { email: MERIDIAN, code: code1, password: WEAK_PW } });
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    assert.ok(/at least 12 characters/i.test(r.data.error), r.data.error);
    const row = await db.collegeRegistration.findUnique({ where: { id: reg1.id } });
    assert.equal(row.status, "approved", "a rejected password activated the institution anyway");
    assert.equal(row.codeAttempts, 0, "a correct code with a short password spent an attempt");
    return r.data.error;
  });

  let wrongCodeMsg = null, wrongEmailMsg = null;

  await check("the wrong code fails", async () => {
    const r = await call("/registrations/activate", { method: "POST", body: { email: MERIDIAN, code: "ZZZZ-ZZZZ-ZZZZ", password: PW } });
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    wrongCodeMsg = r.data.error;
    const row = await db.collegeRegistration.findUnique({ where: { id: reg1.id } });
    assert.equal(row.tenantId, null, "a wrong code created an institution");
    assert.equal(row.codeAttempts, 1, "a wrong code was not counted");
    return wrongCodeMsg;
  });

  await check("the right code with the wrong address fails", async () => {
    // The code alone is not a credential. If it were, an approval email forwarded to
    // the wrong person, or read off a screen, would be enough to take the institution.
    const r = await call("/registrations/activate", { method: "POST", body: { email: email("stranger"), code: code1, password: PW } });
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    wrongEmailMsg = r.data.error;
    const stolen = await db.collegeRegistration.findUnique({ where: { id: reg1.id } });
    assert.equal(stolen.status, "approved", "someone else's address redeemed the code");
    return wrongEmailMsg;
  });

  await check("both failures say exactly the same thing", async () => {
    // Two different messages would let a caller separate "this address has an approved
    // application" from "this code is wrong" — which turns the pair into a way to
    // enumerate approved institutions, and a way to confirm a code against any address.
    assert.equal(wrongCodeMsg, wrongEmailMsg, `"${wrongCodeMsg}" vs "${wrongEmailMsg}"`);
    assert.equal(wrongCodeMsg, REFUSAL);
    // …and neither repeats back anything it was told.
    assert.ok(!wrongCodeMsg.includes(MERIDIAN) && !wrongEmailMsg.includes(code1), "the refusal echoes the input");
    return REFUSAL;
  });

  await check("the right code with a DIFFERENT approved registration's address fails", async () => {
    // The strongest form of the previous test: the address is real, the application is
    // real and approved — only the pairing is wrong. Codes must be bound to their own
    // registration, not merely to "some approved registration".
    await apply({ legalName: `Regsuite Harbour ${RUN}`, contactName: "Alan Turing", contactEmail: HARBOUR }, ip(6));
    const harbour = await fromQueue(OP, HARBOUR);
    const app = await call(`/registrations/${harbour.id}/approve`, { method: "POST", token: OP });
    assert.equal(app.status, 200);
    const r = await call("/registrations/activate", { method: "POST", body: { email: HARBOUR, code: code1, password: PW } });
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    assert.equal(r.data.error, REFUSAL, "a cross-registration attempt is distinguishable");
    const row = await db.collegeRegistration.findFirst({ where: { contactEmail: HARBOUR } });
    assert.equal(row.tenantId, null, "ANOTHER REGISTRATION'S CODE CREATED THIS INSTITUTION");
    return "codes are bound to one application";
  });

  let slug1 = null;

  await check("the right code and address create the institution", async () => {
    // Typed the way a person actually retypes a code read to them over the phone:
    // lower case, spaces instead of hyphens. Refusing that is refusing the customer.
    const typed = code1.toLowerCase().replace(/-/g, " ");
    const r = await call("/registrations/activate", { method: "POST", body: { email: MERIDIAN.toUpperCase(), code: typed, password: PW } });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
    assert.equal(r.data.activated, true);
    slug1 = r.data.slug;
    // No requestedSlug was given, so the slug is derived from the legal name.
    assert.equal(slug1, `${SLUG_PREFIX}meridian-${RUN}`, `unexpected slug: ${slug1}`);
    assert.ok(SLUG_RE.test(slug1), `the slug is not a valid slug: ${slug1}`);
    assert.equal(r.data.name, "Meridian College", "the trading name should name the institution");
    assert.ok(!JSON.stringify(r.data).includes(code1.replace(/-/g, "")), "the activation reply echoes the code back");
    return slug1;
  });

  await check("the institution exists, with one super-admin", async () => {
    const tenant = await db.tenant.findUnique({ where: { slug: slug1 } });
    assert.ok(tenant, "no tenant was created");
    assert.equal(tenant.active, true);
    const staff = await db.staff.findMany({ where: { tenantId: tenant.id } });
    assert.equal(staff.length, 1, `expected exactly one account, found ${staff.length}`);
    const admin = staff[0];
    assert.equal(admin.email, MERIDIAN, "the admin account is not the person who applied");
    assert.equal(admin.accountRole, "ADMIN");
    assert.equal(admin.isSuperAdmin, true, "the first account cannot administer its own institution");
    // pendingActivation true would make the account unloginable — auth.js treats such a
    // row as a non-match, so the applicant would be locked out of what they just paid for.
    assert.equal(admin.pendingActivation, false, "the first admin is stuck pending activation");
    assert.notEqual(admin.passwordHash, PW, "THE PASSWORD IS STORED IN PLAIN TEXT");
    assert.ok(bcrypt.compareSync(PW, admin.passwordHash), "the chosen password does not match the stored hash");
    return `${admin.name} (${admin.initials}) at ${slug1}`;
  });

  await check("the new admin can sign in against their own institution", async () => {
    // The end of the journey. Everything above is worthless if the person who redeemed
    // the code cannot then get in.
    const r = await call("/auth/login", { method: "POST", tenant: slug1, body: { email: MERIDIAN, password: PW } });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.data).slice(0, 160)}`);
    assert.ok(r.data.token, "no session was issued");
    assert.equal(r.data.user.isSuperAdmin, true);
    // And the token works — a login that returns a token no route accepts is not a login.
    const me = await call("/staff", { token: r.data.token, tenant: slug1 });
    assert.equal(me.status, 200, `the new admin's token was refused by /staff (HTTP ${me.status})`);
    assert.equal(me.data.length, 1);
    return "signed in and read their own staff list";
  });

  await check("those credentials are worth nothing at any other institution", async () => {
    // The account was created inside one tenant. Presenting it against another must
    // fail even though the password is right — this is the isolation guarantee that
    // the whole product rests on, arriving here through a brand-new code path.
    const r = await call("/auth/login", { method: "POST", tenant: "default", body: { email: MERIDIAN, password: PW } });
    assert.equal(r.status, 401, `expected 401, got ${r.status}`);
    return "refused at 'default'";
  });

  await check("the code is spent: a replay fails", async () => {
    // The code's job is done the moment the institution exists. Keeping it live would
    // leave a second, unlogged way in — one that creates ANOTHER institution, or worse,
    // another super-admin — for anyone who kept a copy of the approval email.
    const row = await db.collegeRegistration.findUnique({ where: { id: reg1.id } });
    assert.equal(row.status, "activated");
    assert.ok(row.tenantId, "the registration was not linked to the institution it created");
    assert.equal(row.accessCodeHash, null, "THE SPENT CODE IS STILL LIVE IN THE DATABASE");
    assert.equal(row.accessCodeHint, null, "the hint outlived the code");
    const replay = await call("/registrations/activate", { method: "POST", body: { email: MERIDIAN, code: code1, password: "a-completely-different-password" } });
    assert.equal(replay.status, 400, `expected 400, got ${replay.status}`);
    assert.equal(replay.data.error, REFUSAL);
    const tenants = await db.tenant.count({ where: { slug: { startsWith: `${SLUG_PREFIX}meridian` } } });
    assert.equal(tenants, 1, "the replay created a SECOND institution");
    const staff = await db.staff.count({ where: { tenantId: row.tenantId } });
    assert.equal(staff, 1, "the replay added a second super-admin to a live institution");
    return "one institution, one admin, code dead";
  });

  await check("an activated registration cannot be approved or rejected again", async () => {
    // Re-approving would mint a fresh code for an institution that already exists and
    // already has an owner. Rejecting would be a silent no-op on a paying customer.
    const a = await call(`/registrations/${reg1.id}/approve`, { method: "POST", token: OP });
    assert.equal(a.status, 409, `approve returned ${a.status}`);
    const j = await call(`/registrations/${reg1.id}/reject`, { method: "POST", token: OP });
    assert.equal(j.status, 409, `reject returned ${j.status}`);
    const row = await db.collegeRegistration.findUnique({ where: { id: reg1.id } });
    assert.equal(row.status, "activated", "the live institution's registration was reopened");
    assert.equal(row.accessCodeHash, null, "a second code was issued for a live institution");
    return "HTTP 409 both ways";
  });

  await check("an unknown registration is a 404, not a 500", async () => {
    const r = await call("/registrations/does-not-exist/approve", { method: "POST", token: OP });
    assert.equal(r.status, 404, `expected 404, got ${r.status}`);
    return r.data.error;
  });

  /* ============================================ guessing is bounded ======== */

  await apply({ legalName: `Regsuite Kestrel ${RUN}`, contactName: "Karen Sparck Jones", contactEmail: KESTREL }, ip(7));
  const kestrel = await fromQueue(OP, KESTREL);
  const kestrelApproval = await call(`/registrations/${kestrel.id}/approve`, { method: "POST", token: OP });
  const code3 = kestrelApproval.data.code;

  await check("every wrong code is counted", async () => {
    // Twelve characters of a 32-letter alphabet is unguessable by a person and cheap
    // for a script. Without a counter, this endpoint is an offline-speed oracle that
    // hands out institutions.
    for (let i = 1; i <= 10; i++) {
      const r = await call("/registrations/activate", { method: "POST", body: { email: KESTREL, code: `ZZZZ-ZZZZ-ZZZ${i === 10 ? 2 : i + 1}`, password: PW } });
      assert.equal(r.status, 400, `attempt ${i} returned ${r.status}`);
      const row = await db.collegeRegistration.findUnique({ where: { id: kestrel.id } });
      assert.equal(row.codeAttempts, i, `after ${i} wrong codes the counter reads ${row.codeAttempts}`);
    }
    return "10 attempts, 10 counted";
  });

  await check("the eleventh attempt is locked out", async () => {
    const r = await call("/registrations/activate", { method: "POST", body: { email: KESTREL, code: "ZZZZ-ZZZZ-ZZZ3", password: PW } });
    assert.equal(r.status, 429, `expected 429, got ${r.status}`);
    return r.data.error;
  });

  await check("even the CORRECT code is refused once locked out", async () => {
    // The point of the lock. A guesser who happens to land on the right code at attempt
    // eleven must still get nothing; otherwise the counter only slows the attack down.
    const r = await call("/registrations/activate", { method: "POST", body: { email: KESTREL, code: code3, password: PW } });
    assert.equal(r.status, 429, `expected 429, got ${r.status}`);
    const row = await db.collegeRegistration.findUnique({ where: { id: kestrel.id } });
    assert.equal(row.tenantId, null, "A LOCKED-OUT REGISTRATION STILL CREATED AN INSTITUTION");
    assert.equal(row.status, "approved");
    return "locked";
  });

  await check("re-approving gives the applicant a fresh budget and a new code", async () => {
    // The escape hatch for a real customer who mistyped ten times: the operator issues
    // a new code. The old one must die with it, or the lockout could be cleared by the
    // very person who triggered it.
    const r = await call(`/registrations/${kestrel.id}/approve`, { method: "POST", token: OP });
    assert.equal(r.status, 200);
    const newCode = r.data.code;
    assert.notEqual(newCode, code3, "re-approval reissued the same code");
    const row = await db.collegeRegistration.findUnique({ where: { id: kestrel.id } });
    assert.equal(row.codeAttempts, 0, "the previous code's failures still count against the new one");
    assert.equal(row.accessCodeHash, hashCode(newCode), "the old code is still the live one");
    // No longer locked — and the OLD code is now worthless.
    const old = await call("/registrations/activate", { method: "POST", body: { email: KESTREL, code: code3, password: PW } });
    assert.equal(old.status, 400, `the superseded code returned ${old.status}, not a plain refusal`);
    assert.equal(old.data.error, REFUSAL);
    const after = await db.collegeRegistration.findUnique({ where: { id: kestrel.id } });
    assert.equal(after.tenantId, null, "the superseded code created an institution");
    return "budget reset, old code dead";
  });

  await check("an expired code creates nothing", async () => {
    // An approval that sat unused for months is not evidence that the person still
    // works there. Expiry is set at approval; forced here rather than waited for.
    await db.collegeRegistration.update({ where: { id: kestrel.id }, data: { codeExpiresAt: new Date(Date.now() - 60_000) } });
    const live = await db.collegeRegistration.findUnique({ where: { id: kestrel.id } });
    const r = await call("/registrations/activate", { method: "POST", body: { email: KESTREL, code: "ZZZZ-ZZZZ-ZZZ4", password: PW } });
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    assert.ok(/expired/i.test(r.data.error), r.data.error);
    assert.ok(live.accessCodeHash, "fixture problem: there was no live code to expire");
    const row = await db.collegeRegistration.findUnique({ where: { id: kestrel.id } });
    assert.equal(row.tenantId, null, "an expired code created an institution");
    return r.data.error;
  });

  /* ============================================ rejection kills the code === */

  await check("rejecting an approved application kills its live code", async () => {
    // The operator's undo. Between approval and redemption we may learn the applicant
    // is not who they said they were — and at that moment a live code is a live way in.
    const harbour = await fromQueue(OP, HARBOUR);
    assert.equal(harbour.status, "approved", "fixture problem: Harbour should be approved by now");
    assert.ok(harbour.accessCodeHint, "fixture problem: Harbour has no live code");
    const before = await db.collegeRegistration.findUnique({ where: { id: harbour.id } });
    assert.ok(before.accessCodeHash, "fixture problem: no code hash to kill");

    const r = await call(`/registrations/${harbour.id}/reject`, { method: "POST", token: OP, body: { note: "Could not verify." } });
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
    assert.equal(r.data.registration.status, "rejected");
    assert.equal(r.data.registration.accessCodeHint, null, "the rejected application still advertises a code");
    assert.equal(r.data.registration.decisionNote, "Could not verify.");
    const after = await db.collegeRegistration.findUnique({ where: { id: harbour.id } });
    assert.equal(after.accessCodeHash, null, "A REJECTED APPLICATION KEPT A WORKING CODE");
    return "code destroyed with the decision";
  });

  await check("the code we issued before the rejection no longer works", async () => {
    // Proving it on the wire, not just in the column: the applicant holds a code that
    // was live ten seconds ago.
    const harbour = await db.collegeRegistration.findFirst({ where: { contactEmail: HARBOUR } });
    const approval = await call(`/registrations/${harbour.id}/approve`, { method: "POST", token: OP });
    const liveCode = approval.data.code;
    // It really is live at this point — reject it, then try it.
    await call(`/registrations/${harbour.id}/reject`, { method: "POST", token: OP });
    const r = await call("/registrations/activate", { method: "POST", body: { email: HARBOUR, code: liveCode, password: PW } });
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    assert.equal(r.data.error, REFUSAL, "a rejected applicant is told they were rejected");
    const row = await db.collegeRegistration.findFirst({ where: { contactEmail: HARBOUR } });
    assert.equal(row.status, "rejected");
    assert.equal(row.tenantId, null, "A REJECTED APPLICATION CREATED AN INSTITUTION");
    const t = await db.tenant.count({ where: { slug: { startsWith: `${SLUG_PREFIX}harbour` } } });
    assert.equal(t, 0, "a tenant exists for a rejected application");
    return "refused, and indistinguishable from any other refusal";
  });

  /* ================================================== the slug collision === */

  const takenSlug = `${SLUG_PREFIX}beacon-${RUN}`;

  await check("a taken web address does not turn an applicant away", async () => {
    // The slug is settled at ACTIVATION, not at approval, because somebody else may
    // have taken it in between. The applicant has a valid code and must not be blocked
    // by a name clash they cannot see — and, far worse, must not be dropped INTO the
    // institution that already holds the name.
    const squatter = await db.tenant.create({ data: { slug: takenSlug, name: "Someone Else's College" } });
    await db.staff.create({
      data: {
        tenantId: squatter.id, name: "Existing Principal", jobTitle: "Principal", dept: "Leadership",
        email: `existing-${RUN}${DOMAIN}`, passwordHash: bcrypt.hashSync(PW, 10),
        accountRole: "ADMIN", isSuperAdmin: true, initials: "EP", colour: "#334155",
      },
    });

    await apply({
      legalName: `Regsuite Beacon ${RUN}`, tradingName: "Beacon College",
      contactName: "Beatrice Bell", contactEmail: BEACON, requestedSlug: takenSlug,
    }, ip(8));
    const beacon = await fromQueue(OP, BEACON);
    const approval = await call(`/registrations/${beacon.id}/approve`, { method: "POST", token: OP });
    const r = await call("/registrations/activate", { method: "POST", body: { email: BEACON, code: approval.data.code, password: PW } });

    assert.equal(r.status, 200, `activation failed on a taken slug: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
    assert.notEqual(r.data.slug, takenSlug, "THE NEW INSTITUTION TOOK OVER AN EXISTING SLUG");
    assert.ok(SLUG_RE.test(r.data.slug), `it landed on an invalid slug: "${r.data.slug}"`);
    assert.ok(!RESERVED_SLUGS.has(r.data.slug), `it landed on a reserved slug: "${r.data.slug}"`);

    // The existing college is untouched: same name, same single member of staff, and
    // no account belonging to the applicant.
    const before = await db.tenant.findUnique({ where: { id: squatter.id } });
    assert.equal(before.name, "Someone Else's College", "the existing institution was renamed");
    const intruders = await db.staff.findMany({ where: { tenantId: squatter.id } });
    assert.equal(intruders.length, 1, `the applicant's admin landed inside the existing college (${intruders.length} accounts)`);
    assert.ok(!intruders.some((s) => s.email === BEACON), "AN OUTSIDER WAS GIVEN AN ACCOUNT IN AN EXISTING COLLEGE");

    // And the institution that was actually created works.
    const login = await call("/auth/login", { method: "POST", tenant: r.data.slug, body: { email: BEACON, password: PW } });
    assert.equal(login.status, 200, `the new admin cannot sign in at ${r.data.slug} (HTTP ${login.status})`);
    return r.data.slug;
  });

  // Was a known bug when this suite was written: the collision retry appended a
  // suffix without re-validating, so a 31-character requested slug produced a
  // 33-character one that SLUG_RE rejects — and routes/platform.js applies the same
  // expression, so activation could mint a tenant the platform could not have
  // created itself. Fixed in registrations.js by making room for the suffix and
  // validating every candidate, so this is a real assertion now.
  await check("a near-maximum-length slug that collides still lands on a valid slug", async () => {
    // Slugs are capped at 32 characters everywhere else in the product (SLUG_RE, and
    // the submission form enforces it). The collision path appends "-2" to the
    // REQUESTED slug without re-checking the result, so a 31-character request that
    // collides produces a 33-character slug that the same regex would reject.
    //
    // Impact is limited — the tenant middleware resolves by exact string, so the
    // institution works — but it puts a value in Tenant.slug that no other code path
    // would accept, and a slug is a DNS label and a customer-visible address.
    const long = (`${SLUG_PREFIX}longslug-${RUN}` + "x".repeat(20)).slice(0, 31);
    assert.ok(SLUG_RE.test(long) && long.length === 31, `fixture problem: ${long} (${long.length})`);
    await db.tenant.create({ data: { slug: long, name: "Long Slug Holder" } });
    await apply({
      legalName: `Regsuite Longslug ${RUN}`, contactName: "Len Long", contactEmail: LONGSLUG, requestedSlug: long,
    }, ip(9));
    const reg = await fromQueue(OP, LONGSLUG);
    const approval = await call(`/registrations/${reg.id}/approve`, { method: "POST", token: OP });
    const r = await call("/registrations/activate", { method: "POST", body: { email: LONGSLUG, code: approval.data.code, password: PW } });
    assert.equal(r.status, 200, `activation failed: HTTP ${r.status}`);
    assert.notEqual(r.data.slug, long);
    assert.ok(SLUG_RE.test(r.data.slug), `landed on a slug the product's own rule rejects: "${r.data.slug}" (${r.data.slug.length} chars)`);
    return r.data.slug;
  });

  /* ======================================================= the front door === */

  await check("a public form cannot be used to flood the review queue", async () => {
    // Five an hour from one connection. Without it the operator's queue — the thing a
    // human being reads — is a free-form write endpoint open to the internet.
    const flood = ip(200);
    let limited = null;
    for (let i = 1; i <= 8 && !limited; i++) {
      const r = await apply({ legalName: `Regsuite Flood ${i}`, contactName: "Flooder", contactEmail: email(`flood-${i}`) }, flood);
      if (r.status === 429) limited = i;
    }
    assert.ok(limited, "eight submissions from one address were all accepted");
    assert.ok(limited <= 6, `the limiter only bit on submission ${limited}`);
    const stored = await db.collegeRegistration.count({ where: { contactEmail: { startsWith: "flood-" } } });
    assert.ok(stored < 8, "every flooded submission was stored anyway");
    return `blocked at submission ${limited}`;
  });

  await check("another applicant is unaffected by that flood", async () => {
    // Per-connection, not global. A limiter that locks the form for everybody is a
    // denial of service any bot can trigger on our behalf.
    const r = await apply({ legalName: `Regsuite Innocent ${RUN}`, contactName: "Innocent", contactEmail: email("innocent") }, ip(201));
    assert.equal(r.status, 200, `a different address was refused too (HTTP ${r.status})`);
    return "still open";
  });
} catch (e) {
  failed++;
  console.log(`✗ the suite itself threw\n    ${e && e.stack ? e.stack : e}`);
} finally {
  await cleanup();
  await db.$disconnect();
  console.log("\ncleanup: test institutions, applications and operators removed");
}

console.log(`\n${passed} passed, ${failed} failed${known ? `, ${known} known bug${known === 1 ? "" : "s"} documented` : ""}\n`);
process.exit(failed ? 1 : 0);
