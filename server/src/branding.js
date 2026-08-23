// What one institution looks and sounds like — resolved in a single place.
//
// WHY THIS IS ONE MODULE AND NOT A FIELD READ IN SIXTEEN
//
// Before this, an institution's identity was literals: "EdTech" in sixteen server
// files, "42 The Burroughs, Hendon, London NW4 4AP" at the foot of the offer letter,
// a signatory's actual name defaulted in offerLetter.js, and #1a3a8f in
// seventy-six places in the client. A second college on the platform would have sent
// its applicants letters branded for the first one — not a cosmetic problem, a letter
// from the wrong institution.
//
// So every one of those values now has exactly one resolver. A caller asks for the
// current tenant's branding and gets a COMPLETE object: whatever the college saved,
// falling back to the environment, falling back to the platform default. No caller
// has to handle a missing field, which is what stops the defaults drifting apart
// again.
//
// Cached per tenant for a short time, like integrationConfig.js and for the same
// reason: this is read on nearly every email and PDF, it changes about never, and a
// college that has just corrected its address should see the correction while it is
// still looking at the screen.
const prisma = require("./db");
const { currentTenantId } = require("./db");

// NEUTRAL fallbacks. Deliberately not EdTech's — nor any other institution's.
//
// The first version of this file used EdTech's real name, address and colours as the
// defaults, which only moved the hardcoding one level down: every new college would
// have started life branded as EdTech and sent EdTech-branded letters until someone
// noticed. That is the same defect this module exists to remove.
//
// So the fallbacks below belong to nobody. They are what an institution that has
// configured nothing looks like: a plain slate palette and its own name, taken from
// the Tenant record it was created with. EdTech's identity is DATA now, held in its
// own TenantBranding row like any other customer's — see the branding migration,
// which moves it out of the code and into that row.
//
// A college therefore never inherits another college's identity. The worst case is
// unstyled, which is honest, rather than wrongly attributed, which is not.
const DEFAULTS = {
  displayName: null,      // falls back to the Tenant's own `name` — see get()
  shortName: null,
  wordmarkTop: null,
  wordmarkSub: null,
  primaryColor: "#334155", // slate-700: neutral, legible, nobody's brand
  accentColor: "#475569",  // slate-600
  logoDataUri: null,
  addressLines: null,
  contactEmail: null,
  contactPhone: null,
  website: null,
  legalFooter: null,
  signatoryName: null,
  signatoryTitle: null,
};

// Environment overrides, so a single-institution deployment can still be configured
// the old way without touching a database.
const ENV = {
  displayName: "BRAND_NAME",
  primaryColor: "BRAND_PRIMARY_COLOR",
  accentColor: "BRAND_ACCENT_COLOR",
  contactEmail: "BRAND_CONTACT_EMAIL",
  contactPhone: "BRAND_CONTACT_PHONE",
  website: "BRAND_WEBSITE",
  addressLines: "BRAND_ADDRESS",
  legalFooter: "BRAND_LEGAL_FOOTER",
  signatoryName: "BRAND_SIGNATORY_NAME",
  signatoryTitle: "BRAND_SIGNATORY_TITLE",
};

const TTL_MS = Number(process.env.BRANDING_CACHE_MS ?? 30_000);
const cache = new Map(); // tenantId -> { value, at }

/** #abc or #aabbcc, nothing else. Rejected rather than sanitised — a colour that is
 *  not a colour is a mistake to report, and anything looser reaches a style attribute. */
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const isHex = (v) => typeof v === "string" && HEX.test(v.trim());

function fromEnv() {
  const out = {};
  for (const [field, name] of Object.entries(ENV)) {
    const v = process.env[name];
    if (v) out[field] = v;
  }
  return out;
}

/** Only the keys that are actually set, so a null column does not beat a default. */
function present(row) {
  if (!row) return {};
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    const v = row[k];
    if (v !== null && v !== undefined && v !== "") out[k] = v;
  }
  if (row.logoDataUri) out.logoDataUri = row.logoDataUri;
  // Colours that somehow got into the database malformed are ignored rather than
  // emitted — this value ends up inside a style attribute in the client.
  if (out.primaryColor && !isHex(out.primaryColor)) delete out.primaryColor;
  if (out.accentColor && !isHex(out.accentColor)) delete out.accentColor;
  return out;
}

/** Outbound mail identities, per team, resolved the same way. */
function mailFromFor(row, resolved) {
  let saved = {};
  try { saved = row && row.mailFrom ? JSON.parse(row.mailFrom) : {}; } catch { saved = {}; }
  const name = resolved.displayName;
  // No domain invented if the college has not given a contact address: falling back
  // to a platform domain would send their mail "from" somebody else entirely.
  const domain = String(resolved.contactEmail || "").split("@")[1] || null;
  const build = (label, box, envName) => {
    if (saved[label]) return saved[label];
    if (process.env[envName]) return process.env[envName];
    // Nothing configured and no domain to build from: return null and let email.js
    // use the server's own MAIL_FROM rather than fabricate an address.
    return domain ? `${name} ${box} <${box.toLowerCase()}@${domain}>` : null;
  };
  return {
    attendance: build("attendance", "Attendance", "MAIL_FROM_ATTENDANCE"),
    pat: build("pat", "PAT", "MAIL_FROM_PAT"),
    ask: build("ask", "ASK", "MAIL_FROM_ASK"),
    wellbeing: build("wellbeing", "Wellbeing", "MAIL_FROM_WELLBEING"),
  };
}

/**
 * The current institution's branding, complete. Never returns a partial object, so
 * no caller needs a fallback of its own.
 */
async function get() {
  const tenantId = currentTenantId();
  // Outside a request — a scheduler, a script — there is no institution to look up.
  if (!tenantId) {
    const resolved = { ...DEFAULTS, ...fromEnv() };
    return { ...resolved, mailFrom: mailFromFor(null, resolved) };
  }

  const hit = cache.get(tenantId);
  if (TTL_MS > 0 && hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let row = null;
  let tenantName = null;
  try {
    row = await prisma.tenantBranding.findFirst();
    // The institution's own name is the right fallback for displayName: it is what
    // the operator typed when creating the customer, so a college that never opens
    // the branding screen is still called by its own name in letters and emails —
    // never by the platform's, and never by another customer's.
    const { crossTenant } = require("./db");
    const t = await crossTenant(() => prisma.tenant.findUnique({ where: { id: tenantId } }));
    tenantName = t ? t.name : null;
  } catch {
    row = null; // table not migrated yet — neutral defaults are correct
  }

  const resolved = { ...DEFAULTS, ...fromEnv(), ...present(row) };
  if (!resolved.displayName) resolved.displayName = tenantName || "Staff Hub";
  if (!resolved.shortName) resolved.shortName = resolved.displayName;
  if (!resolved.wordmarkTop) resolved.wordmarkTop = String(resolved.shortName).toUpperCase();
  const value = { ...resolved, mailFrom: mailFromFor(row, resolved) };
  cache.set(tenantId, { value, at: Date.now() });
  return value;
}

/** Drop cached branding — call after saving. */
const invalidate = (tenantId) => (tenantId ? void cache.delete(tenantId) : cache.clear());

module.exports = { get, invalidate, DEFAULTS, isHex };
