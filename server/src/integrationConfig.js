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
const { currentTenantId, crossTenant } = require("./db");
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
  // Canvas LMS. Same job as Moodle for a college that runs Canvas instead — and some
  // run both during a migration, which is why these are separate providers rather
  // than one "VLE" row with a type field: a college mid-migration needs both sets of
  // credentials live at once, and a type field would force it to choose.
  //
  // The secret is a manual access token (Bearer). `accountId` and `termId` are
  // optional filters: most institutions park sandbox and training courses under a
  // sub-account, and without a filter the first sync pulls every shell on the
  // instance. Blank means "everything the token can see".
  canvas: {
    label: "Canvas",
    secretField: "token",
    settingFields: ["url", "accountId", "termId", "autoSync"],
    env: { token: "CANVAS_TOKEN", url: "CANVAS_URL", autoSync: "CANVAS_AUTO_SYNC" },
    describe: (s) => (s.url ? s.url : "no site address set"),
  },
  // Outbound email. The one that made this whole exercise urgent: it lived as
  // process-wide SMTP_* and MAIL_FROM, so every institution on the platform sent its
  // applicants mail from whichever college the server happened to be configured for.
  // A student receiving an offer "from" another institution is not a branding problem.
  //
  // The secret is the SMTP password (or the Resend API key, which is stored in the
  // same slot — a provider chooses one or the other and never both).
  email: {
    label: "Email",
    secretField: "password",
    settingFields: ["provider", "host", "port", "secure", "user", "fromName", "fromEmail"],
    env: {
      password: "SMTP_PASS", host: "SMTP_HOST", port: "SMTP_PORT",
      secure: "SMTP_SECURE", user: "SMTP_USER", fromEmail: "MAIL_FROM",
    },
    describe: (s) => (s.host ? s.host + (s.user ? " as " + s.user : "") : s.provider === "resend" ? "Resend API" : "no server set"),
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
// WHICH institution, if any, may fall back to the environment.
//
// The env vars describe ONE institution's systems — one Moodle, one mailbox, one
// SharePoint library. Handing them to any tenant that has not configured its own is
// how a college ends up sending mail as another college and filing its applicants'
// documents in that college's library. It is not hypothetical: this platform ran for
// a period with EdTech emailing as "London Brookes College" and uploading into LBC's
// Admissions library, purely because those were the values on the host.
//
// So the environment now serves exactly one tenant: the one named by
// DEFAULT_TENANT_SLUG, which is what a single-institution deployment sets to mean
// "this server is that college's server". Every other institution gets nothing until
// it enters its own, and "nothing" is a safe failure — mail is not sent, a sync does
// not run — where inheriting is not.
//
// A blank DEFAULT_TENANT_SLUG disables the fallback entirely, which is the right
// setting for a genuine multi-tenant deployment.
const ENV_TENANT_SLUG = (process.env.DEFAULT_TENANT_SLUG || "").trim().toLowerCase();

// Resolved once and cached: the slug is fixed for the life of the process, and this
// runs on the hot path of every integration read.
let envTenantId;
async function envTenantIdFor() {
  if (envTenantId !== undefined) return envTenantId;
  if (!ENV_TENANT_SLUG) { envTenantId = null; return null; }
  try {
    const t = await crossTenant(() => prisma.tenant.findUnique({ where: { slug: ENV_TENANT_SLUG } }));
    envTenantId = t ? t.id : null;
  } catch {
    envTenantId = null;
  }
  return envTenantId;
}

async function load(provider) {
  if (!PROVIDERS[provider]) return {};
  const tenantId = currentTenantId();
  // Outside a tenant (a script, a boot task) there is no row to read, so the
  // environment is all there is.
  if (!tenantId) return fromEnv(provider);

  const key = keyFor(tenantId, provider);
  const hit = cache.get(key);
  if (TTL_MS > 0 && hit && Date.now() - hit.at < TTL_MS) return hit.config;

  const saved = await stored(provider);
  let config = saved;
  if (!config) {
    // Only the deployment's OWN institution may inherit the host's settings. Any other
    // college resolves to {} — not configured — rather than to somebody else's system.
    config = (tenantId === await envTenantIdFor()) ? fromEnv(provider) : {};
  }
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
  if (hit) return hit.config;
  // Nothing primed. Falling back to the environment HERE would reintroduce exactly the
  // leak load() now prevents — a caller that forgot to prime would silently serve one
  // institution's credentials to another. An unprimed read reports "not configured",
  // which is the safe answer and shows up immediately as a feature that does nothing
  // rather than as a letter from the wrong college.
  return tenantId === envTenantId ? fromEnv(provider) : {};
}

/** Drop cached config — call after saving or removing credentials. */
function invalidate(tenantId, provider) {
  // A tenant may have been created, renamed or deleted since the slug was resolved.
  envTenantId = undefined;
  if (!tenantId) return cache.clear();
  if (provider) return void cache.delete(keyFor(tenantId, provider));
  for (const k of cache.keys()) if (k.startsWith(tenantId + ":")) cache.delete(k);
}

module.exports = { PROVIDERS, load, peek, invalidate, fromEnv };
