// Resolves this institution's integration configuration — Moodle, SharePoint, email —
// preferring what the college has saved over the server-wide environment.
//
// moodle.js and sharepoint.js read their settings through small synchronous
// accessors (BASE(), TOKEN(), CLIENT_SECRET(), ...) called deep inside request
// handling. Making those async would mean rewriting both files end to end. Instead
// the resolved config is primed ONCE at each module's choke point — moodle.call(),
// sharepoint.getAccessToken()/graphFetch() — and the accessors then read it
// synchronously from the cache below.
//
// Precedence, deliberately in this order:
//   1. what the college saved through Settings (secret encrypted at rest)
//   2. process.env — so a deployment configured entirely by environment keeps working
//      unchanged, and so a self-hosted customer can still configure that way
//
// A deployment that has saved nothing therefore behaves exactly as before this existed.
//
// WHY THE FALLBACK USED TO BE FENCED, AND WHY IT NO LONGER IS
//
// When one process served many colleges, step 2 was the dangerous step: MOODLE_*,
// SMTP_* and SP_* describe ONE institution's systems, and handing them to a college
// that had not configured its own is how a student receives an offer letter "from"
// another institution and has their passport scan filed in that institution's
// SharePoint library. That was not hypothetical — this platform ran for a period
// sending one college's mail under a DIFFERENT college's name, because the process
// inherited SMTP_* from the host and the host described somebody else. So the
// environment was fenced off to a single tenant, the one named by DEFAULT_TENANT_SLUG,
// and every other college resolved to "not configured" instead.
//
// One deployment per college removes the ambiguity the fence existed to resolve: the
// host's environment describes the only institution there is, so inheriting it is
// correct rather than a leak, and the fence would now only stop a college from using
// its own settings. DEFAULT_TENANT_SLUG is therefore no longer consulted here.
const prisma = require("./db");
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
  // Blackboard Learn. The secret is the Application Secret from the developer
  // registration; applicationKey and applicationId sit beside it as settings because
  // neither is secret on its own — the college's Learn administrator has to be TOLD
  // the Application ID in order to create the REST API Integration that makes any of
  // this work, so hiding it would be actively unhelpful.
  blackboard: {
    label: "Blackboard",
    secretField: "secret",
    settingFields: ["url", "applicationKey", "applicationId", "autoSync"],
    env: { secret: "BB_APP_SECRET", url: "BB_URL", applicationKey: "BB_APP_KEY", applicationId: "BB_APP_ID", autoSync: "BB_AUTO_SYNC" },
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
  // NOTE for anyone grepping `tenantId` out of this codebase: the one below is Microsoft
  // Entra's DIRECTORY id, the GUID identifying the customer's Microsoft 365 tenancy. It
  // has nothing to do with this platform's former multi-tenancy, it is the name the Graph
  // API uses, and renaming it would only make the SharePoint setup instructions wrong.
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
  // Microsoft Teams attendance. A SEPARATE app registration from SharePoint even
  // though both talk to Graph, because the two need different application permissions
  // (Sites.* vs Calendars.Read + OnlineMeetings.Read.All + OnlineMeetingArtifact.
  // Read.All) and a college may legitimately grant one and not the other — one Test
  // button must not vouch for two unrelated capabilities. The "tenant" note above
  // sharepoint applies here unchanged: it is Microsoft's directory id.
  //
  // organizerAccounts is a comma-separated list of the dedicated scheduling accounts
  // that CREATE every online class meeting (teachers are co-organizers and are never
  // read). Graph exposes a meeting's attendance only through its organizer, which is
  // why these accounts, and only these, are what the sync reads.
  //
  // creatorAccount (Teams automation) is the ONE account among those that actually
  // creates class meetings and owns new class Teams, when automation is switched on.
  // A separate field rather than always "the first organizerAccounts entry" because a
  // college may want the account doing the CREATING (mailbox space, licensing) to
  // differ from the set the attendance sync reads calendars for — but see
  // teamsGraph.js's creatorEmail(): left blank, it falls back to the first organizer
  // account, so a college that configured this before automation existed needs to
  // change nothing.
  teams: {
    label: "Teams attendance",
    secretField: "clientSecret",
    settingFields: ["tenantId", "clientId", "organizerAccounts", "creatorAccount"],
    env: {
      clientSecret: "TEAMS_CLIENT_SECRET", tenantId: "TEAMS_TENANT_ID",
      clientId: "TEAMS_CLIENT_ID", organizerAccounts: "TEAMS_ORGANIZER_ACCOUNTS",
      creatorAccount: "TEAMS_CREATOR_ACCOUNT",
    },
    describe: (s) => {
      const n = String(s.organizerAccounts || "").split(",").map((x) => x.trim()).filter(Boolean).length;
      return n ? `${n} organizer account${n === 1 ? "" : "s"}` : "no organizer accounts set";
    },
  },
};

// Short, because a credential that was just corrected should take effect while the
// person who corrected it is still watching. Decryption is cheap; the round trip is
// what this avoids.
const TTL_MS = Number(process.env.INTEGRATION_CACHE_MS ?? 30_000);
// Keyed on the provider alone. The key used to be "<tenantId>:<provider>" — with one
// institution the tenant half is a constant, and a constant in a cache key is a
// reader's invitation to believe something varies that does not.
const cache = new Map(); // provider -> { config, at }

function fromEnv(provider) {
  const spec = PROVIDERS[provider];
  const out = {};
  for (const [field, name] of Object.entries(spec.env)) {
    const v = process.env[name];
    if (v) out[field] = v;
  }
  return out;
}

/** Read the stored row for this provider and decrypt it. Null when unusable. */
async function stored(provider) {
  const spec = PROVIDERS[provider];
  let row;
  try {
    row = await prisma.tenantIntegration.findFirst({ where: { provider } });
  } catch {
    return null; // the table is not there yet
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
 * Prime and return the configuration for one provider. Await this at a module's entry
 * point; the synchronous accessors then use peek().
 */
async function load(provider) {
  if (!PROVIDERS[provider]) return {};

  const hit = cache.get(provider);
  if (TTL_MS > 0 && hit && Date.now() - hit.at < TTL_MS) return hit.config;

  // What the college saved wins; the host environment is the fallback, because it
  // describes this college's systems and nobody else's — see the note at the top of
  // the file about the fence that used to stand here.
  const config = (await stored(provider)) || fromEnv(provider);
  cache.set(provider, { config, at: Date.now() });
  return config;
}

/**
 * The configuration resolved by the last load(). Synchronous, for the accessors inside
 * moodle.js / sharepoint.js.
 *
 * An unprimed read falls back to the environment. That is a REVERSAL of what this
 * function did while the platform was multi-tenant, and the reasoning has genuinely
 * flipped rather than merely relaxed: back then, a caller that forgot to prime would
 * have been handed the host's credentials, which belonged to whichever college the
 * server was configured for, and serving those to a different institution was the leak
 * load() existed to prevent — so an unprimed read reported "not configured" instead,
 * failing visibly as a feature that does nothing. Now the host's credentials belong to
 * the only institution there is, so returning them is the correct answer rather than a
 * leak, and refusing would break a caller for no benefit at all.
 */
function peek(provider) {
  if (!PROVIDERS[provider]) return {};
  const hit = cache.get(provider);
  if (hit) return hit.config;
  return fromEnv(provider);
}

/**
 * Drop cached config — call after saving or removing credentials.
 *
 * Takes the provider alone. It used to take (tenantId, provider), and the ordering
 * mattered: passing the provider first cleared the entire cache instead of one entry,
 * which over-invalidates rather than serving a stale credential — safe, but wrong.
 * Both call sites in routes/integrations.js pass the provider alone now.
 */
function invalidate(provider) {
  if (!provider) return cache.clear();
  cache.delete(provider);
}

module.exports = { PROVIDERS, load, peek, invalidate, fromEnv };
