// Organisations applying to join the platform.
//
// Mounted ABOVE the tenant middleware, like the platform surface, because an applicant
// is not yet an institution and has no tenant to be resolved to. Two of these routes
// are PUBLIC — the form itself and the code redemption — so everything here assumes an
// unauthenticated stranger on the other end.
//
// THE SHAPE OF THE CONTROL
//
// Filling in a form grants nothing. An application becomes a live institution only
// when BOTH of these have happened:
//
//   1. an operator approved it and issued an access code, which is a decision by us
//   2. the applicant redeemed that code, which proves they are the person we sent it to
//
// Two different people agreeing, rather than one form being submitted. Either half
// alone is worthless: an approved application with no redeemed code has no tenant and
// no login, and a code with no approval cannot exist.
const express = require("express");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const prisma = require("./../db");
const { crossTenant, runInTenant } = require("./../db");
const { requirePlatformAdmin } = require("./../platformAuth");
const { forget } = require("./../tenant");

const router = express.Router();

const MIN_PASSWORD = 12;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
const RESERVED_SLUGS = new Set(["www", "api", "app", "admin", "staging", "platform", "default", "test"]);
const TYPES = ["fe", "he", "private", "training", "other"];

const clean = (v) => (typeof v === "string" ? v.trim() : "");
const intOrNull = (v) => {
  const n = Number(v);
  // Range-bound: an unbounded integer on a write is the exact class of the defect that
  // once killed this API outright by storing a value Prisma could never read back.
  return Number.isFinite(n) && n >= 0 && n <= 2147483647 ? Math.floor(n) : null;
};

/* ------------------------------------------------------------ rate limiting -- */
//
// A public write endpoint with no limiter is an invitation to fill the operator's
// review queue with junk. Same in-process shape as the limiters in routes/auth.js:
// correct for one Node process, and a clustered deployment would need a shared store.
const SUBMIT = new Map();
const SUBMIT_WINDOW_MS = 60 * 60 * 1000;
const SUBMIT_MAX = 5;

function submitLimited(ip) {
  const now = Date.now();
  const rec = SUBMIT.get(ip) || { count: 0, first: now };
  if (now - rec.first > SUBMIT_WINDOW_MS) { rec.count = 0; rec.first = now; }
  rec.count += 1;
  SUBMIT.set(ip, rec);
  // Sweep on size so an unbounded map cannot become a memory leak.
  if (SUBMIT.size > 5000) for (const [k, v] of SUBMIT) if (now - v.first > SUBMIT_WINDOW_MS) SUBMIT.delete(k);
  return rec.count > SUBMIT_MAX;
}

/* ------------------------------------------------------------------ public --- */

// POST /api/registrations — an organisation applies.
//
// Answers the same way whether or not this organisation has applied before. A form
// that says "you have already registered" is an oracle for who our customers are.
router.post("/", async (req, res) => {
  const b = req.body || {};

  // Honeypot: a field no human sees and every naive bot fills in. Accepted with the
  // same reply as a real submission, and stored nowhere.
  if (clean(b.website2)) return res.json({ received: true });

  if (submitLimited(req.ip)) {
    return res.status(429).json({ error: "Too many registrations from this connection. Please try again later." });
  }

  const legalName = clean(b.legalName);
  const contactName = clean(b.contactName);
  const contactEmail = clean(b.contactEmail).toLowerCase();

  if (!legalName) return res.status(400).json({ error: "The institution's legal name is required." });
  if (!contactName) return res.status(400).json({ error: "A contact name is required." });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail)) {
    return res.status(400).json({ error: "A valid contact email address is required." });
  }

  const requestedSlug = clean(b.requestedSlug).toLowerCase();
  if (requestedSlug && !SLUG_RE.test(requestedSlug)) {
    return res.status(400).json({ error: "The web address may use lower-case letters, numbers and hyphens only." });
  }

  const type = clean(b.institutionType).toLowerCase();

  await crossTenant(() => prisma.collegeRegistration.create({
    data: {
      legalName: legalName.slice(0, 200),
      tradingName: clean(b.tradingName).slice(0, 200) || null,
      institutionType: TYPES.includes(type) ? type : null,
      registrationNumber: clean(b.registrationNumber).slice(0, 80) || null,
      website: clean(b.website).slice(0, 200) || null,
      addressLines: clean(b.addressLines).slice(0, 500) || null,
      country: clean(b.country).slice(0, 80) || null,
      approxStaff: intOrNull(b.approxStaff),
      approxStudents: intOrNull(b.approxStudents),
      contactName: contactName.slice(0, 160),
      contactRole: clean(b.contactRole).slice(0, 120) || null,
      contactEmail: contactEmail.slice(0, 200),
      contactPhone: clean(b.contactPhone).slice(0, 60) || null,
      requestedSlug: requestedSlug || null,
      notes: clean(b.notes).slice(0, 2000) || null,
    },
  }));

  console.warn(`[registration] new application from "${legalName}" (${contactEmail}) ip=${req.ip || "?"}`);

  // Deliberately says nothing about what happens next beyond the truth: we will be in
  // touch. No id is returned — an id is something to enumerate.
  res.json({ received: true });
});

/* ------------------------------------------------- redeeming an access code -- */

const CODE_MAX_ATTEMPTS = 10;
const hashCode = (code) => crypto.createHash("sha256").update(String(code)).digest("hex");
const normaliseCode = (v) => String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// POST /api/registrations/activate — the applicant redeems the code we issued.
//
// This is the moment an application becomes an institution: it creates the Tenant and
// its first administrator, and it is the only path that does so from outside the
// platform surface. It therefore checks four things, and says the same thing when any
// of them fails, so a caller cannot learn which part they got right.
router.post("/activate", async (req, res) => {
  const email = clean(req.body?.email).toLowerCase();
  const code = normaliseCode(req.body?.code);
  const password = String(req.body?.password || "");

  if (!email || !code) return res.status(400).json({ error: "Your email address and access code are both required." });
  if (password.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `Choose a password of at least ${MIN_PASSWORD} characters.` });
  }

  const refuse = () => res.status(400).json({ error: "That email address and access code do not match an approved registration." });

  const reg = await crossTenant(() => prisma.collegeRegistration.findFirst({
    where: { contactEmail: email, status: "approved" },
    orderBy: { codeIssuedAt: "desc" },
  }));
  if (!reg || !reg.accessCodeHash) return refuse();

  // Guessing is bounded. Six characters of base32 is a lot for a person and very little
  // for a script, and this endpoint creates institutions.
  if (reg.codeAttempts >= CODE_MAX_ATTEMPTS) {
    return res.status(429).json({ error: "Too many incorrect codes for this registration. Contact us to have a new one issued." });
  }
  if (reg.codeExpiresAt && reg.codeExpiresAt < new Date()) {
    return res.status(400).json({ error: "That access code has expired. Contact us to have a new one issued." });
  }

  // Constant-time compare, so the failure cannot be timed character by character.
  const supplied = Buffer.from(hashCode(code));
  const stored = Buffer.from(reg.accessCodeHash);
  const ok = supplied.length === stored.length && crypto.timingSafeEqual(supplied, stored);
  if (!ok) {
    await crossTenant(() => prisma.collegeRegistration.update({
      where: { id: reg.id }, data: { codeAttempts: { increment: 1 } },
    }));
    console.warn(`[registration] wrong access code for "${reg.legalName}" (${email})`);
    return refuse();
  }

  // The slug is settled at ACTIVATION, not at approval: another institution may have
  // taken it in between, and an applicant should not be turned away for that.
  //
  // Every CANDIDATE is validated, not just the first. Appending a "-2" to a slug that
  // was already at the 32-character limit produced a 33-character one that SLUG_RE
  // rejects — and routes/platform.js applies that same expression when an operator
  // creates an institution by hand. So activation could mint a tenant whose slug the
  // platform's own create route would refuse: an invariant broken on a DNS-shaped,
  // customer-visible identifier. The suffix is made room for rather than added blindly.
  const acceptable = (v) => SLUG_RE.test(v) && !RESERVED_SLUGS.has(v);
  const withSuffix = (base, n) => {
    const suffix = "-" + n;
    // Trim the base so base+suffix still fits, and never end on a hyphen — SLUG_RE
    // requires the last character to be alphanumeric.
    return base.slice(0, 32 - suffix.length).replace(/-+$/, "") + suffix;
  };

  const fallback = "college-" + reg.id.slice(-6).toLowerCase();
  let base = reg.requestedSlug || reg.legalName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
  if (!acceptable(base)) base = fallback;

  let slug = base;
  for (let i = 2; i <= 50; i++) {
    const taken = await crossTenant(() => prisma.tenant.findUnique({ where: { slug } }));
    if (!taken && acceptable(slug)) break;
    slug = withSuffix(base, i);
    // If the base itself cannot be made to fit, fall back to the id-derived one, which
    // is short by construction.
    if (!acceptable(slug)) slug = withSuffix(fallback, i);
  }

  const tenant = await crossTenant(() => prisma.tenant.create({ data: { slug, name: reg.tradingName || reg.legalName } }));

  const initials = reg.contactName.split(/\s+/).map((w) => w[0] || "").join("").slice(0, 2).toUpperCase() || "A";
  await runInTenant(tenant.id, () => prisma.staff.create({
    data: {
      name: reg.contactName, jobTitle: reg.contactRole || "Administrator", dept: "Administration",
      email: reg.contactEmail, passwordHash: bcrypt.hashSync(password, 10),
      accountRole: "ADMIN", isSuperAdmin: true, adminPages: null,
      initials, colour: "#334155", allowance: 28, pendingActivation: false,
    },
  }));

  // The code is spent. Keeping the hash would leave a second, unlogged route into an
  // institution that now exists.
  await crossTenant(() => prisma.collegeRegistration.update({
    where: { id: reg.id },
    data: { status: "activated", tenantId: tenant.id, accessCodeHash: null, accessCodeHint: null },
  }));
  forget(slug);

  console.warn(`[registration] "${reg.legalName}" activated as tenant "${slug}"`);

  res.json({
    activated: true,
    slug,
    name: tenant.name,
    email: reg.contactEmail,
    note: "Your institution is set up. Sign in with your email address and the password you just chose, then configure your email, Moodle and SharePoint under Settings.",
  });
});

/* ------------------------------------------------------- the operator's view -- */

// What an operator may see. The code hash is never in it.
const present = (r) => ({
  id: r.id, submittedAt: r.submittedAt, status: r.status,
  legalName: r.legalName, tradingName: r.tradingName, institutionType: r.institutionType,
  registrationNumber: r.registrationNumber, website: r.website, addressLines: r.addressLines,
  country: r.country, approxStaff: r.approxStaff, approxStudents: r.approxStudents,
  contactName: r.contactName, contactRole: r.contactRole, contactEmail: r.contactEmail,
  contactPhone: r.contactPhone, requestedSlug: r.requestedSlug, notes: r.notes,
  accessCodeHint: r.accessCodeHint, codeIssuedAt: r.codeIssuedAt, codeExpiresAt: r.codeExpiresAt,
  codeAttempts: r.codeAttempts,
  reviewedAt: r.reviewedAt, reviewedBy: r.reviewedBy, decisionNote: r.decisionNote,
  tenantId: r.tenantId,
});

// GET /api/registrations — the review queue.
router.get("/", requirePlatformAdmin, async (req, res) => {
  const status = clean(req.query.status);
  const rows = await crossTenant(() => prisma.collegeRegistration.findMany({
    where: status ? { status } : undefined,
    orderBy: [{ submittedAt: "desc" }],
    take: 200,
  }));
  const counts = await crossTenant(() => prisma.collegeRegistration.groupBy({ by: ["status"], _count: { _all: true } }));
  res.json({
    registrations: rows.map(present),
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
  });
});

/** Base32-ish, without the characters people misread aloud on a phone: no O/0, I/1. */
function generateCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(12);
  let out = "";
  for (let i = 0; i < 12; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i % 4 === 3 && i < 11) out += "-";
  }
  return out; // XXXX-XXXX-XXXX
}

// POST /api/registrations/:id/approve — accept an application and issue its code.
//
// The code is returned to the operator ONCE, here, and never again: it is stored as a
// hash. An operator who loses it re-approves and issues a new one, which is a smaller
// problem than a readable code sitting in the database for the life of the account.
router.post("/:id/approve", requirePlatformAdmin, async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.body?.expiresInDays) || 14));
  const reg = await crossTenant(() => prisma.collegeRegistration.findUnique({ where: { id: req.params.id } }));
  if (!reg) return res.status(404).json({ error: "Unknown registration" });
  if (reg.status === "activated") return res.status(409).json({ error: "That institution has already been set up." });

  const code = generateCode();
  const updated = await crossTenant(() => prisma.collegeRegistration.update({
    where: { id: reg.id },
    data: {
      status: "approved",
      accessCodeHash: hashCode(normaliseCode(code)),
      accessCodeHint: code.slice(-4),
      codeIssuedAt: new Date(),
      codeExpiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
      // A reissued code starts its own budget; the previous code's failures are not
      // this code's problem.
      codeAttempts: 0,
      reviewedAt: new Date(),
      reviewedBy: req.platformAdmin.email,
      decisionNote: clean(req.body?.note) || null,
    },
  }));

  console.warn(`[registration] "${reg.legalName}" approved by ${req.platformAdmin.email}, code expires in ${days}d`);

  res.json({
    registration: present(updated),
    // Shown once. The operator passes it to the institution by whatever channel they
    // trust — this endpoint deliberately does not email it, because at this point we
    // have no verified address for them, only one somebody typed into a public form.
    code,
    note: "Give this code to the institution. It is not stored in readable form and cannot be shown again.",
  });
});

// POST /api/registrations/:id/reject
router.post("/:id/reject", requirePlatformAdmin, async (req, res) => {
  const reg = await crossTenant(() => prisma.collegeRegistration.findUnique({ where: { id: req.params.id } }));
  if (!reg) return res.status(404).json({ error: "Unknown registration" });
  if (reg.status === "activated") return res.status(409).json({ error: "That institution is already set up. Suspend it instead." });

  const updated = await crossTenant(() => prisma.collegeRegistration.update({
    where: { id: reg.id },
    data: {
      status: "rejected",
      // Any live code dies with the decision.
      accessCodeHash: null, accessCodeHint: null,
      reviewedAt: new Date(), reviewedBy: req.platformAdmin.email,
      decisionNote: clean(req.body?.note) || null,
    },
  }));
  console.warn(`[registration] "${reg.legalName}" rejected by ${req.platformAdmin.email}`);
  res.json({ registration: present(updated) });
});

module.exports = router;
