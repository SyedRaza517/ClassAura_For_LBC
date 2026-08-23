// The platform-admin API — one tier above every institution.
//
// Mounted BEFORE the tenant middleware in index.js, so nothing here runs inside a
// tenant scope by accident. Every query that must span institutions says crossTenant()
// out loud, which is the convention db.js relies on to keep such reads visible.
const express = require("express");
const bcrypt = require("bcryptjs");
const prisma = require("./../db");
const { crossTenant, runInTenant } = require("./../db");
const { signPlatformToken, requirePlatformAdmin } = require("./../platformAuth");
const { forget } = require("./../tenant");
const audit = require("./../audit");

const router = express.Router();

const MIN_PASSWORD = 12;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
// Reserved because they appear as platform hostnames, and a customer subdomain that
// collided with one would be unreachable or would shadow the platform itself.
const RESERVED_SLUGS = new Set(["www", "api", "app", "admin", "staging", "platform", "default", "test"]);

const clean = (v) => (typeof v === "string" ? v.trim() : "");

/* ------------------------------------------------------ platform-tier audit --- */
//
// Some events on this router have no institution to belong to: an operator signing
// in, an operator account being created, an institution being deleted. AuditLog rows
// are tenant-scoped and cascade-delete with their tenant, so those three cannot live
// there — the first two have no tenantId at all, and the third would be destroyed by
// the very action it records.
//
// They go to the process log instead, in one greppable shape, so a deployment that
// ships logs somewhere central (which the readiness plan requires) captures them.
// Anything that DOES concern one institution still uses audit.record with an explicit
// tenantId — see tenant.created and tenant.suspended below.
function platformEvent(req, action, detail) {
  console.warn(
    "[platform-audit] " + action +
    " by=" + ((req.platformAdmin && req.platformAdmin.email) || detail.actorEmail || "anonymous") +
    " ip=" + (req.ip || "?") +
    " at=" + new Date().toISOString() +
    " " + Object.entries(detail).filter(([k]) => k !== "actorEmail").map(([k, v]) => k + "=" + v).join(" ")
  );
}

/* ---------------------------------------------------------- rate limiting ----- */
//
// This is the highest-privilege login in the product: a platform operator can read,
// suspend and delete every customer. The staff login has had a limiter since July;
// this one shipped without and was the softest target on the platform.
//
// Tighter than the staff limiter deliberately. There are a handful of operator
// accounts, all created from a command line by someone with server access, so a
// genuine person fumbling five times is already unusual — and the cost of a wrong
// lockout here is one operator waiting, against an attacker grinding the account that
// owns every customer's data.
//
// In-process, matching the staff limiter: correct for one instance, and a
// multi-instance deployment needs a shared store (Redis) for either of them.
const PLATFORM_ATTEMPTS = new Map();
const PL_WINDOW_MS = 15 * 60 * 1000;
const PL_MAX = 5;
const PL_LOCK_MS = 30 * 60 * 1000;

const plKey = (req, email) => `${req.ip}|${String(email || "").toLowerCase()}`;
// Address-independent floor, so spraying one guess from many addresses is still
// capped. Higher than the per-address limit for the same reason the staff limiter's
// account key is: a real operator on several devices should not lock out sooner.
const plAccountKey = (email) => `account|${String(email || "").toLowerCase()}`;

function plLockedFor(key) {
  const rec = PLATFORM_ATTEMPTS.get(key);
  if (!rec || !rec.lockedUntil) return 0;
  if (Date.now() >= rec.lockedUntil) { PLATFORM_ATTEMPTS.delete(key); return 0; }
  return Math.ceil((rec.lockedUntil - Date.now()) / 60000);
}

function plRecordFailure(key, max) {
  const now = Date.now();
  const rec = PLATFORM_ATTEMPTS.get(key) || { count: 0, first: now, lockedUntil: 0 };
  if (now - rec.first > PL_WINDOW_MS) { rec.count = 0; rec.first = now; }
  rec.count += 1;
  if (rec.count >= max) rec.lockedUntil = now + PL_LOCK_MS;
  PLATFORM_ATTEMPTS.set(key, rec);
  return Math.max(0, max - rec.count);
}

const plClear = (req, email) => {
  PLATFORM_ATTEMPTS.delete(plKey(req, email));
  PLATFORM_ATTEMPTS.delete(plAccountKey(email));
};

/* ------------------------------------------------------------------ sign in --- */

router.post("/login", async (req, res) => {
  const email = clean(req.body?.email).toLowerCase();
  const password = String(req.body?.password || "");
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });

  // Checked BEFORE the password, so a locked account costs an attacker a bcrypt
  // comparison of nothing and cannot be used to time-probe which addresses exist.
  const k = plKey(req, email), ak = plAccountKey(email);
  const mins = plLockedFor(k) || plLockedFor(ak);
  if (mins) {
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.` });
  }

  const admin = await crossTenant(() => prisma.platformAdmin.findUnique({ where: { email } }));
  // One message for every failure — an unknown address must not be distinguishable
  // from a wrong password, or this becomes a way to enumerate platform operators.
  const ok = admin && admin.active !== false && bcrypt.compareSync(password, admin.passwordHash);
  if (!ok) {
    const left = plRecordFailure(k, PL_MAX);
    plRecordFailure(ak, PL_MAX * 3);
    // Failed attempts against the account that owns every customer's data are the
    // single most important thing on this router to be able to count afterwards.
    platformEvent(req, "platform.signin.failed", { actorEmail: email, attemptsLeft: left });
    // The count is returned but the reason is not — still one message for unknown
    // address and wrong password alike.
    return res.status(401).json({ error: "Invalid email or password" + (left > 0 && left <= 2 ? ` (${left} attempt${left === 1 ? "" : "s"} left)` : "") });
  }
  plClear(req, email);

  platformEvent(req, "platform.signin", { actorEmail: admin.email, adminId: admin.id });
  await crossTenant(() => prisma.platformAdmin.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } }));
  res.json({ token: signPlatformToken(admin), admin: { id: admin.id, email: admin.email, name: admin.name } });
});

router.get("/me", requirePlatformAdmin, (req, res) => res.json({ admin: req.platformAdmin }));

/* --------------------------------------------------------------- overview ----- */

// The whole estate at a glance. One query per collection across all institutions,
// grouped by tenant — which is the shape a shared database makes cheap and a
// database-per-customer would make painful.
router.get("/overview", requirePlatformAdmin, async (_req, res) => {
  const data = await crossTenant(async () => {
    const tenants = await prisma.tenant.findMany({ orderBy: { name: "asc" } });
    const [staff, students, admissions, checkins, integrations] = await Promise.all([
      prisma.staff.groupBy({ by: ["tenantId"], _count: { _all: true } }),
      prisma.student.groupBy({ by: ["tenantId"], _count: { _all: true } }),
      prisma.admission.groupBy({ by: ["tenantId"], _count: { _all: true } }),
      prisma.checkIn.groupBy({ by: ["tenantId"], _count: { _all: true } }),
      prisma.tenantIntegration.findMany({ select: { tenantId: true, provider: true, enabled: true, lastTestOk: true } }),
    ]);
    const countBy = (rows) => Object.fromEntries(rows.map((r) => [r.tenantId, r._count._all]));
    const s = countBy(staff), st = countBy(students), ad = countBy(admissions), ci = countBy(checkins);
    return tenants.map((t) => ({
      id: t.id,
      slug: t.slug,
      name: t.name,
      active: t.active,
      createdAt: t.createdAt,
      counts: { staff: s[t.id] || 0, students: st[t.id] || 0, admissions: ad[t.id] || 0, checkins: ci[t.id] || 0 },
      integrations: integrations
        .filter((i) => i.tenantId === t.id)
        .map((i) => ({ provider: i.provider, enabled: i.enabled, lastTestOk: i.lastTestOk })),
    }));
  });

  res.json({
    tenants: data,
    totals: {
      institutions: data.length,
      active: data.filter((t) => t.active).length,
      staff: data.reduce((n, t) => n + t.counts.staff, 0),
      students: data.reduce((n, t) => n + t.counts.students, 0),
      admissions: data.reduce((n, t) => n + t.counts.admissions, 0),
    },
  });
});

/* ------------------------------------------------------------ provisioning ---- */

// Create a customer without a code change or a manual database edit — the readiness
// plan's "a new college can be provisioned without code forks".
router.post("/tenants", requirePlatformAdmin, async (req, res) => {
  const slug = clean(req.body?.slug).toLowerCase();
  const name = clean(req.body?.name);
  const adminEmail = clean(req.body?.adminEmail).toLowerCase();
  const adminName = clean(req.body?.adminName) || "Administrator";
  const adminPassword = String(req.body?.adminPassword || "");

  if (!SLUG_RE.test(slug)) {
    return res.status(400).json({ error: "Slug must be 3-32 characters, lowercase letters, numbers and hyphens, not starting or ending with a hyphen" });
  }
  if (RESERVED_SLUGS.has(slug)) return res.status(400).json({ error: "That slug is reserved" });
  if (!name) return res.status(400).json({ error: "Name is required" });
  if (!adminEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) return res.status(400).json({ error: "A valid administrator email is required" });
  if (adminPassword.length < MIN_PASSWORD) return res.status(400).json({ error: `The administrator password must be at least ${MIN_PASSWORD} characters` });

  const clash = await crossTenant(() => prisma.tenant.findUnique({ where: { slug } }));
  if (clash) return res.status(409).json({ error: "An institution with that slug already exists" });

  const tenant = await crossTenant(() => prisma.tenant.create({ data: { slug, name } }));

  // The first administrator is created INSIDE the new tenant, so the isolation
  // extension stamps it — the same path every other row takes.
  const admin = await runInTenant(tenant.id, () => prisma.staff.create({
    data: {
      name: adminName, jobTitle: "Administrator", dept: "Administration", email: adminEmail,
      passwordHash: bcrypt.hashSync(adminPassword, 10), accountRole: "ADMIN", isSuperAdmin: true,
      // adminPages null = unrestricted within their own institution.
      adminPages: null, initials: adminName.split(/\s+/).map((w) => w[0] || "").join("").slice(0, 2).toUpperCase() || "AD",
      colour: "#1a3a8f", allowance: 28, pendingActivation: false,
    },
  }));

  forget(slug); // so a previously-cached 404 for this slug does not linger
  audit.record(req, {
    tenantId: tenant.id, action: "tenant.created", entity: "Tenant", entityId: tenant.id,
    summary: `Institution "${name}" (${slug}) created, with ${adminEmail} as its first administrator`,
    after: { slug, name, adminEmail },
  });
  res.status(201).json({ tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, active: tenant.active }, admin: { id: admin.id, email: admin.email } });
});

// Suspend or restore. Not a delete: an unpaid invoice should stop access, not destroy
// a college's records.
router.put("/tenants/:id/active", requirePlatformAdmin, async (req, res) => {
  const active = req.body?.active;
  if (typeof active !== "boolean") return res.status(400).json({ error: "active must be true or false" });
  const tenant = await crossTenant(() => prisma.tenant.findUnique({ where: { id: req.params.id } }));
  if (!tenant) return res.status(404).json({ error: "Unknown institution" });
  const updated = await crossTenant(() => prisma.tenant.update({ where: { id: tenant.id }, data: { active } }));
  forget(tenant.slug); // otherwise the change waits for the cache to expire
  audit.record(req, {
    tenantId: tenant.id, action: active ? "tenant.restored" : "tenant.suspended",
    entity: "Tenant", entityId: tenant.id,
    summary: `Institution "${tenant.name}" ${active ? "restored" : "suspended"} by a platform operator`,
    before: { active: tenant.active }, after: { active },
  });
  res.json({ tenant: { id: updated.id, slug: updated.slug, name: updated.name, active: updated.active } });
});

// Permanent, and it takes every row with it (the foreign keys cascade). Guarded by a
// typed confirmation because there is no undo and no separate backup of one tenant.
router.delete("/tenants/:id", requirePlatformAdmin, async (req, res) => {
  const tenant = await crossTenant(() => prisma.tenant.findUnique({ where: { id: req.params.id } }));
  if (!tenant) return res.status(404).json({ error: "Unknown institution" });
  if (clean(req.body?.confirm) !== tenant.slug) {
    return res.status(400).json({ error: `Type the institution's slug (${tenant.slug}) to confirm deletion` });
  }
  // Recorded BEFORE the delete: the cascade removes this institution's audit rows
  // along with everything else, so a row written to AuditLog here would be destroyed
  // by the very action it describes. This is the one event the database cannot keep
  // for us, which is what platformEvent is for.
  platformEvent(req, "tenant.deleted", { slug: tenant.slug, tenantId: tenant.id });
  await crossTenant(() => prisma.tenant.delete({ where: { id: tenant.id } }));
  forget(tenant.slug);
  res.json({ deleted: true, slug: tenant.slug });
});

/* ------------------------------------------------------- platform operators --- */

router.get("/admins", requirePlatformAdmin, async (_req, res) => {
  const rows = await crossTenant(() => prisma.platformAdmin.findMany({
    orderBy: { email: "asc" },
    select: { id: true, email: true, name: true, active: true, lastLoginAt: true, createdAt: true },
  }));
  res.json(rows);
});

router.post("/admins", requirePlatformAdmin, async (req, res) => {
  const email = clean(req.body?.email).toLowerCase();
  const name = clean(req.body?.name) || "Operator";
  const password = String(req.body?.password || "");
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "A valid email is required" });
  if (password.length < MIN_PASSWORD) return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` });
  const exists = await crossTenant(() => prisma.platformAdmin.findUnique({ where: { email } }));
  if (exists) return res.status(409).json({ error: "That operator already exists" });
  const created = await crossTenant(() => prisma.platformAdmin.create({
    data: { email, name, passwordHash: bcrypt.hashSync(password, 10) },
  }));
  // The most privileged account the product can issue: it reads, suspends and
  // deletes every customer. No tenant owns it, so it cannot be an AuditLog row.
  platformEvent(req, "platform.operator.created", { newOperator: created.email, newOperatorId: created.id });
  res.status(201).json({ id: created.id, email: created.email, name: created.name });
});


/* ----------------------------------------------------------------- usage ------ */

// GET /api/platform/usage — how much each institution is holding.
//
// Separate from /overview because it is materially more expensive: it reads
// pg_class, counts every tenanted table, and sums document sizes. /overview is what
// the dashboard loads on open and should stay cheap; this is asked for deliberately.
//
// The database figure is an ESTIMATE and is named as one in the payload — see the
// comment at the top of usage.js for why an exact per-tenant byte count is not
// available in a shared-table design. File storage IS exact and is reported apart
// from it, because a college with 4GB of scanned documents has a small database and
// a large footprint, and averaging those together would hide both.
router.get("/usage", requirePlatformAdmin, async (_req, res) => {
  const usage = require("./../usage");
  const { byTenant, databaseBytes, measuredAt } = await usage.usageByTenant();
  const tenants = await crossTenant(() => prisma.tenant.findMany({ orderBy: { name: "asc" } }));

  const rows = tenants.map((t) => {
    const u = byTenant.get(t.id) || { rows: 0, estimatedBytes: 0, topTables: [], files: 0, fileBytes: 0 };
    return {
      id: t.id, slug: t.slug, name: t.name, active: t.active,
      rows: u.rows,
      estimatedBytes: u.estimatedBytes,
      estimatedSize: usage.formatBytes(u.estimatedBytes),
      files: u.files,
      fileBytes: u.fileBytes,
      fileSize: usage.formatBytes(u.fileBytes),
      topTables: (u.topTables || []).map((x) => ({ ...x, size: usage.formatBytes(x.estimatedBytes) })),
    };
  });

  const accounted = rows.reduce((n, r) => n + r.estimatedBytes, 0);
  res.json({
    measuredAt,
    tenants: rows.sort((a, b) => b.estimatedBytes - a.estimatedBytes),
    database: {
      totalBytes: databaseBytes,
      totalSize: usage.formatBytes(databaseBytes),
      // What the tenanted tables account for. The remainder is shared overhead —
      // system catalogues, the migration table, indexes on unscoped tables — and is
      // shown rather than silently folded into somebody's bill.
      accountedBytes: accounted,
      accountedSize: usage.formatBytes(accounted),
      overheadBytes: Math.max(0, databaseBytes - accounted),
      overheadSize: usage.formatBytes(Math.max(0, databaseBytes - accounted)),
    },
    note: "Database figures are estimated by apportioning each table's real size across the rows in it. File storage is exact.",
  });
});


/* ------------------------------------------------------------ server health -- */

// GET /api/platform/health — is this SERVER configured correctly?
//
// A platform operator sets CREDENTIALS_KEY, SMTP and the rest, and until now was the
// one tier that could not see whether any of it had taken effect: the only report of
// credential storage being configured lives on GET /api/integrations, which requires a
// COLLEGE admin session. So the person responsible for the setting had to borrow a
// customer's login to check their own work.
//
// Reports only whether something is configured, never the value. A key that is set is
// a fact an operator needs; the key itself is not something any endpoint should return.
router.get("/health", requirePlatformAdmin, async (_req, res) => {
  const secrets = require("./../secrets");

  // A round trip proves the key actually WORKS rather than merely being present —
  // a truncated paste is the likely mistake, and it parses as "set" right up until
  // the first college tries to save a credential.
  let credentials = { configured: false, working: false, note: "CREDENTIALS_KEY is not set — colleges cannot save Moodle or SharePoint credentials." };
  if (secrets.isConfigured()) {
    try {
      const probe = "platform-health-probe";
      const ok = secrets.decrypt(secrets.encrypt(probe)) === probe;
      credentials = ok
        ? { configured: true, working: true, note: "Credential storage is configured and working." }
        : { configured: true, working: false, note: "CREDENTIALS_KEY is set but did not round-trip. Colleges cannot save credentials." };
    } catch (e) {
      credentials = { configured: true, working: false, note: "CREDENTIALS_KEY is set but unusable: " + e.message };
    }
  }

  res.json({
    credentials,
    email: { configured: require("./../email").describeEmail() },
    files: { configured: require("./../storage").describeStorage() },
    sharePoint: { configured: require("./../sharepoint").describe() },
    tenantResolution: {
      defaultSlug: process.env.DEFAULT_TENANT_SLUG || "default",
      baseDomain: process.env.TENANT_BASE_DOMAIN || null,
    },
  });
});

module.exports = router;
