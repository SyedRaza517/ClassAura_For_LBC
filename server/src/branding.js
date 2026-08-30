// What this institution looks and sounds like — resolved in a single place.
//
// WHY THIS IS ONE MODULE AND NOT A FIELD READ IN SIXTEEN
//
// Before this, the institution's identity was literals: "EdTech" in sixteen server
// files, "42 The Burroughs, Hendon, London NW4 4AP" at the foot of the offer letter,
// a signatory's actual name defaulted in offerLetter.js, and #1a3a8f in
// seventy-six places in the client. Changing any of it meant finding all of it, and
// the copies drifted — the address on the offer letter and the address on the
// attendance letter were different addresses for the same college.
//
// So every one of those values now has exactly one resolver. A caller asks for the
// branding and gets a COMPLETE object: whatever the college saved, falling back to
// the environment, falling back to a neutral default. No caller has to handle a
// missing field, which is what stops the defaults drifting apart again.
//
// The shape of this file was set when one deployment served many colleges, and the
// stakes were higher then: a resolver that returned the wrong row sent an applicant a
// letter from an institution they had never applied to. That cannot happen now — one
// deployment, one college, one branding row — but the single-resolver design is kept
// because it is also what fixed the drift above, which was never a tenancy problem.
//
// Cached for a short time, like integrationConfig.js and for the same reason: this is
// read on nearly every email and PDF, it changes about never, and a college that has
// just corrected its address should see the correction while it is still looking at
// the screen.
const prisma = require("./db");

// NEUTRAL fallbacks. Deliberately not EdTech's — nor any other institution's.
//
// The first version of this file used EdTech's real name, address and colours as the
// defaults, which only moved the hardcoding one level down: a deployment that had
// configured nothing would send letters signed by a college it has no connection to
// until someone noticed. That is the same defect this module exists to remove, and it
// survives the move to one-college-per-deployment unchanged — a default that names a
// real institution is wrong wherever it is read.
//
// So the fallbacks below belong to nobody. They are what an institution that has
// configured nothing looks like: a plain slate palette and its own name, taken from
// the Tenant record — which is now this deployment's single settings row rather than
// one customer among many. EdTech's identity is DATA, held in the TenantBranding
// row — see the branding migration, which moves it out of the code and into that row.
//
// The worst case is therefore unstyled, which is honest, rather than wrongly
// attributed, which is not.
const DEFAULTS = {
  displayName: null,      // falls back to the institution's own `name` — see get()
  shortName: null,
  wordmarkTop: null,
  wordmarkSub: null,
  primaryColor: "#334155", // slate-700: neutral, legible, nobody's brand
  accentColor: "#475569",  // slate-600
  buttonColor: null,       // falls back to primaryColor
  buttonTextColor: null,   // falls back to a luminance-chosen black or white
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

// One slot, not a Map. This was `Map<tenantId, {value, at}>` when a process served
// several colleges; with one institution per deployment there is exactly one thing to
// cache, and a Map keyed on nothing is a Map that hides that fact from the next reader.
let cached = null; // { value, at }

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
  for (const k of ["primaryColor", "accentColor", "buttonColor", "buttonTextColor"]) {
    if (out[k] && !isHex(out[k])) delete out[k];
  }
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
 * This institution's branding, complete. Never returns a partial object, so no caller
 * needs a fallback of its own.
 *
 * There used to be TWO paths through this function: one for a request, which read the
 * current tenant's row, and one for a scheduler or script, which had no tenant in
 * scope and could only return defaults. They had to be kept agreeing about whether
 * displayName can be null, because two shapes is how a caller ends up handling one and
 * crashing on the other. That split is gone — a scheduler and a request are now
 * looking at the same single institution — and with it the class of bug where an
 * emailed letter was branded differently from the same letter downloaded as a PDF.
 */
async function get() {
  if (TTL_MS > 0 && cached && Date.now() - cached.at < TTL_MS) return cached.value;

  let row = null;
  let institutionName = null;
  try {
    // findFirst rather than findUnique on the "singleton" id: this is a read, and a
    // read that insists on one literal primary key reports "no branding configured"
    // for a row that exists under some other id — which is a college silently losing
    // its own name in letters, the exact failure the DEFAULTS comment above is about.
    // findFirst returns whatever row is there, and the schema's singleton primary key
    // is what guarantees there is at most one.
    row = await prisma.tenantBranding.findFirst();
    // The institution's own name is the right fallback for displayName: it is what was
    // typed when the deployment was set up, so a college that never opens the branding
    // screen is still called by its own name in letters and emails rather than by the
    // software's.
    const t = await prisma.tenant.findFirst();
    institutionName = t ? t.name : null;
  } catch {
    row = null; // table not migrated yet — neutral defaults are correct
  }

  const resolved = { ...DEFAULTS, ...fromEnv(), ...present(row) };
  if (!resolved.displayName) resolved.displayName = institutionName || "Staff Hub";
  if (!resolved.shortName) resolved.shortName = resolved.displayName;
  if (!resolved.wordmarkTop) resolved.wordmarkTop = String(resolved.shortName).toUpperCase();
  const value = { ...resolved, mailFrom: mailFromFor(row, resolved) };
  cached = { value, at: Date.now() };
  return value;
}

/**
 * Drop cached branding — call after saving.
 *
 * Takes no argument. It used to take the tenant whose entry to evict, and callers
 * still pass one; anything passed is ignored, because there is only one entry and
 * dropping it is the whole operation. Kept argument-tolerant rather than argument-
 * checking, so a caller that has not been updated cannot break on it.
 */
const invalidate = () => { cached = null; };

module.exports = { get, invalidate, DEFAULTS, isHex };
