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

const router = express.Router();

const MIN_PASSWORD = 12;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
// Reserved because they appear as platform hostnames, and a customer subdomain that
// collided with one would be unreachable or would shadow the platform itself.
const RESERVED_SLUGS = new Set(["www", "api", "app", "admin", "staging", "platform", "default", "test"]);

const clean = (v) => (typeof v === "string" ? v.trim() : "");

/* ------------------------------------------------------------------ sign in --- */

router.post("/login", async (req, res) => {
  const email = clean(req.body?.email).toLowerCase();
  const password = String(req.body?.password || "");
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });

  const admin = await crossTenant(() => prisma.platformAdmin.findUnique({ where: { email } }));
  // One message for every failure — an unknown address must not be distinguishable
  // from a wrong password, or this becomes a way to enumerate platform operators.
  const ok = admin && admin.active !== false && bcrypt.compareSync(password, admin.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid email or password" });

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
  res.status(201).json({ id: created.id, email: created.email, name: created.name });
});

module.exports = router;
