// Resolves an institution's integration configuration — Moodle, SharePoint —
// preferring what that institution has saved over the server-wide environment.
//
// moodle.js and sharepoint.js read their settings through small synchronous
// accessors (BASE(), TOKEN(), CLIENT_SECRET(), ...) called deep inside request
// handling. Making those async would mean rewriting both files end to end. Instead
// the resolved config is primed ONCE per request at each module's choke point —
// moodle.call(), sharepoint.getAccessToken()/graphFetch() — and the accessors then
// read it synchronously from a cache keyed by the current tenant.
//
// Precedence, deliberately in this order:
//   1. what the institution saved (encrypted, per tenant)
//   2. process.env — so the existing single-institution deployments keep working
//      unchanged, and so a self-hosted customer can still configure by environment
//
// A tenant that has saved nothing therefore behaves exactly as before this existed.
const prisma = require("./db");
const { currentTenantId } = require("./db");
const secrets = require("./secrets");

// What each provider stores. `secret` is encrypted at rest; `settings` are shown
// back in the UI. `env` maps each field to the variable it falls back to.
const PROVIDERS = {
  moodle: {
    label: "Moodle",
    secretField: "token",
    settingFields: ["url", "autoSync"],
    env: { token: "MOODLE_TOKEN", url: "MOODLE_URL", autoSync: "MOODLE_AUTO_SYNC" },
    describe: (s) => (s.url ? s.url : "no URL set"),
  },
  sharepoint: {
    label: "SharePoint",
    secretField: "clientSecret",
    settingFields: ["tenantId", "clientId", "siteHost", "sitePath", "siteId", "siteUrl", "driveId", "driveName", "rootFolder"],
    env: {
      clientSecret: "SP_CLIENT_SECRET", tenantId: "SP_TENANT_ID", clientId: "SP_CLIENT_ID",
      siteHost: "SP_SITE_HOST", sitePath: "SP_SITE_PATH", siteId: "SP_SITE_ID", siteUrl: "SP_SITE_URL",
      driveId: "SP_DRIVE_ID", driveName: "SP_DRIVE_NAME", rootFolder: "SP_ROOT_FOLDER",
    },
    describe: (s) => (s.siteHost ? s.siteHost + (s.sitePath || "") : "no site set"),
  },
};

// Short, because a credential that was just corrected should take effect while the
// person who corrected it is still watching. Decryption is cheap; the round trip is
// what this avoids.
const TTL_MS = Number(process.env.INTEGRATION_CACHE_MS ?? 30_000);
const cache = new Map(); // "<tenantId>:<provider>" -> { config, at }

const keyFor = (tenantId, provider) => tenantId + ":" + provider;

function fromEnv(provider) {
  const spec = PROVIDERS[provider];
  const out = {};
  for (const [field, name] of Object.entries(spec.env)) {
    const v = process.env[name];
    if (v) out[field] = v;
  }
  return out;
}

/** Read the stored row for the CURRENT tenant and decrypt it. Null when unusable. */
async function stored(provider) {
  const spec = PROVIDERS[provider];
  let row;
  try {
    row = await prisma.tenantIntegration.findFirst({ where: { provider } });
  } catch {
    return null; // no tenant context, or the table is not there yet
  }
  if (!row || !row.enabled) return null;
  let settings = {};
  try { settings = row.settings ? JSON.parse(row.settings) : {}; } catch { settings = {}; }
  try {
    return { ...settings, [spec.secretField]: secrets.decrypt(row.secretEnc) };
  } catch {
    // Wrong CREDENTIALS_KEY, or a tampered row. Behave as "not configured" rather
    // than half-configured, so the caller's existing "not set up" path runs.
    return null;
  }
}

/**
 * Prime and return the configuration for the current institution. Await this at a
 * module's entry point; the synchronous accessors then use peek().
 */
async function load(provider) {
  if (!PROVIDERS[provider]) return {};
  const tenantId = currentTenantId();
  // Outside a tenant (a script, a boot task) there is nothing to look up.
  if (!tenantId) return fromEnv(provider);

  const key = keyFor(tenantId, provider);
  const hit = cache.get(key);
  if (TTL_MS > 0 && hit && Date.now() - hit.at < TTL_MS) return hit.config;

  const saved = await stored(provider);
  const config = saved || fromEnv(provider);
  cache.set(key, { config, at: Date.now() });
  return config;
}

/**
 * The configuration resolved by the last load() in this request. Synchronous, for
 * the accessors inside moodle.js / sharepoint.js. Falls back to the environment if
 * nothing has been primed, so a caller that forgets to prime degrades to the old
 * behaviour rather than to nothing.
 */
function peek(provider) {
  if (!PROVIDERS[provider]) return {};
  const tenantId = currentTenantId();
  if (!tenantId) return fromEnv(provider);
  const hit = cache.get(keyFor(tenantId, provider));
  return hit ? hit.config : fromEnv(provider);
}

/** Drop cached config — call after saving or removing credentials. */
function invalidate(tenantId, provider) {
  if (!tenantId) return cache.clear();
  if (provider) return void cache.delete(keyFor(tenantId, provider));
  for (const k of cache.keys()) if (k.startsWith(tenantId + ":")) cache.delete(k);
}

module.exports = { PROVIDERS, load, peek, invalidate, fromEnv };
