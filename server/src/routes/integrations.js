// Each institution's own Moodle and SharePoint credentials.
//
// These were process-level environment variables, which cannot survive more than one
// customer: every college would have synced from, and uploaded into, whichever
// institution's systems the server happened to be configured for. They now live per
// tenant, encrypted at rest.
//
// This router is mounted INSIDE the tenant middleware, so an institution's admin can
// only ever read or write their own row — no code here checks a tenantId, and none
// needs to.
//
// The secret half is never returned. A GET reports whether something is configured,
// the last four characters so a person can recognise which credential is in place,
// and when it changed. That is enough to administer and not enough to exfiltrate.
const express = require("express");
const prisma = require("./../db");
const { requireAuth, requirePage } = require("./../auth");
const secrets = require("./../secrets");
const audit = require("./../audit");

const router = express.Router();

// The provider spec and the env fallback live in one place — integrationConfig.js —
// because moodle.js and sharepoint.js read from it too, and two copies of "what
// fields does SharePoint need" would drift.
const cfg = require("./../integrationConfig");
const PROVIDERS = cfg.PROVIDERS;

const clean = (v) => (typeof v === "string" ? v.trim() : "");
const parseSettings = (row) => { try { return row.settings ? JSON.parse(row.settings) : {}; } catch { return {}; } };

// The shape a client is allowed to see.
function present(provider, row) {
  const spec = PROVIDERS[provider];
  if (!row) return { provider, label: spec.label, configured: false, enabled: false, settings: {} };
  const settings = parseSettings(row);
  let hint = null;
  try { hint = secrets.hint(secrets.decrypt(row.secretEnc)); } catch { hint = "unreadable"; }
  return {
    provider,
    label: spec.label,
    configured: true,
    enabled: row.enabled,
    settings,
    summary: spec.describe(settings),
    secretHint: hint,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
    lastTestedAt: row.lastTestedAt,
    lastTestOk: row.lastTestOk,
    lastTestNote: row.lastTestNote,
  };
}

// GET /api/integrations — everything this institution has configured.
router.get("/", requireAuth, requirePage("settings"), async (_req, res) => {
  const rows = await prisma.tenantIntegration.findMany();
  const byProvider = Object.fromEntries(rows.map((r) => [r.provider, r]));
  res.json({
    keyConfigured: secrets.isConfigured(),
    integrations: Object.keys(PROVIDERS).map((p) => present(p, byProvider[p])),
  });
});

// PUT /api/integrations/:provider — save credentials for this institution.
router.put("/:provider", requireAuth, requirePage("settings"), async (req, res) => {
  const provider = String(req.params.provider || "").toLowerCase();
  const spec = PROVIDERS[provider];
  if (!spec) return res.status(404).json({ error: "Unknown integration" });
  if (!secrets.isConfigured()) return res.status(503).json({ error: "Credential storage is not configured on this server (CREDENTIALS_KEY is unset)." });

  const body = req.body || {};
  const incomingSecret = clean(body[spec.secretField]);

  const existing = await prisma.tenantIntegration.findFirst({ where: { provider } });
  // An empty secret means "leave the stored one alone" — otherwise every save from a
  // form that (correctly) never received the secret would wipe it.
  if (!incomingSecret && !existing) {
    return res.status(400).json({ error: `A ${spec.label} ${spec.secretField} is required the first time.` });
  }

  const settings = {};
  for (const f of spec.settingFields) if (body[f] !== undefined) settings[f] = clean(body[f]) || (typeof body[f] === "boolean" ? body[f] : "");
  const merged = existing ? { ...parseSettings(existing), ...settings } : settings;

  const data = {
    provider,
    settings: JSON.stringify(merged),
    enabled: typeof body.enabled === "boolean" ? body.enabled : existing ? existing.enabled : false,
    updatedBy: req.user?.email || null,
  };
  if (incomingSecret) data.secretEnc = secrets.encrypt(incomingSecret);

  const saved = existing
    ? await prisma.tenantIntegration.update({ where: { id: existing.id }, data })
    : await prisma.tenantIntegration.create({ data: { ...data, secretEnc: secrets.encrypt(incomingSecret) } });

  cfg.invalidate(req.tenant?.id, provider);
  // WHAT changed, never the credential itself — audit.js redacts secret fields, and
  // this deliberately passes only the non-secret settings anyway.
  audit.record(req, {
    action: "integration.saved", entity: "TenantIntegration", entityId: saved.id,
    summary: `${spec.label} credentials ${existing ? "updated" : "configured"}` + (incomingSecret ? " (new secret)" : " (settings only)") + `, ${data.enabled ? "enabled" : "disabled"}`,
    before: existing ? { enabled: existing.enabled, settings: parseSettings(existing) } : null,
    after: { enabled: saved.enabled, settings: merged },
  });
  res.json(present(provider, saved));
});

// DELETE /api/integrations/:provider — disconnect.
//
// The readiness plan asks for exactly this: a documented way to revoke an
// integration's access WITHOUT damaging the records already imported. Removing the
// credential stops all future syncing and leaves every imported row untouched.
router.delete("/:provider", requireAuth, requirePage("settings"), async (req, res) => {
  const provider = String(req.params.provider || "").toLowerCase();
  if (!PROVIDERS[provider]) return res.status(404).json({ error: "Unknown integration" });
  const existing = await prisma.tenantIntegration.findFirst({ where: { provider } });
  if (!existing) return res.json({ removed: false });
  await prisma.tenantIntegration.delete({ where: { id: existing.id } });
  cfg.invalidate(req.tenant?.id, provider);
  audit.record(req, {
    action: "integration.removed", entity: "TenantIntegration", entityId: existing.id,
    summary: `${PROVIDERS[provider].label} credentials removed — future syncing stopped, imported records kept`,
    before: { enabled: existing.enabled },
  });
  res.json({ removed: true, note: "Credentials removed. Data already imported is unaffected." });
});

module.exports = router;
module.exports.PROVIDERS = PROVIDERS;
