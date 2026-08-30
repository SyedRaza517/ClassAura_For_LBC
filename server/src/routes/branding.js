// An institution's own name, colours, logo and letterhead.
//
// One deployment serves one institution, so this is a single settings row: the
// handlers below findFirst() rather than looking anything up by id, and there is no
// identity for a caller to pass in and get wrong.
//
// GET is deliberately UNAUTHENTICATED. The sign-in screen has to be branded, and at
// that point nobody has signed in: an app that shows a college's own colours only
// after login is an app that greets every one of its users as somebody else first.
// Nothing here is confidential — it is the name, colours and logo the institution
// puts on its own letters and website — but the split is enforced rather than
// assumed: PUBLIC_FIELDS is an allowlist, so a field added to this model tomorrow is
// private until someone deliberately publishes it.
const express = require("express");
const prisma = require("./../db");
const { requireAuth, requirePage } = require("./../auth");
const branding = require("./../branding");
const audit = require("./../audit");

const router = express.Router();

// What an anonymous caller may see: enough to render a branded sign-in page.
// Correspondence details (signatory, legal footer, mail-from) are NOT here — they
// belong on letters, not on a public endpoint.
const PUBLIC_FIELDS = [
  "displayName", "shortName", "wordmarkTop", "wordmarkSub",
  "primaryColor", "accentColor", "buttonColor", "buttonTextColor", "logoDataUri",
];

// Free-text fields an administrator may set, with the cap each is stored under.
const TEXT_FIELDS = {
  displayName: 120, shortName: 40, wordmarkTop: 24, wordmarkSub: 24,
  addressLines: 400, contactEmail: 160, contactPhone: 40, website: 160,
  legalFooter: 600, signatoryName: 120, signatoryTitle: 120,
};
const COLOUR_FIELDS = ["primaryColor", "accentColor", "buttonColor", "buttonTextColor"];

// A logo is inlined into every page load, so it has to stay small. 256KB of base64 is
// roughly a 190KB image — ample for a crest or wordmark, and small enough that it
// costs nothing on a phone. Bigger is refused with the actual number, so "too large"
// is actionable rather than mysterious.
const MAX_LOGO_BYTES = 256 * 1024;
const ALLOWED_LOGO = ["image/png", "image/jpeg", "image/svg+xml", "image/webp", "image/gif"];

const clean = (v) => (typeof v === "string" ? v.trim() : "");

/* --------------------------------------------------------------- read ------- */

// GET /api/branding — what this institution looks like. Public, see above.
router.get("/", async (_req, res) => {
  const b = await branding.get();
  const out = {};
  for (const f of PUBLIC_FIELDS) out[f] = b[f] ?? null;
  res.json(out);
});

// GET /api/branding/all — everything, including correspondence details.
router.get("/all", requireAuth, requirePage("settings"), async (_req, res) => {
  const b = await branding.get();
  const row = await prisma.tenantBranding.findFirst();
  res.json({
    // The RESOLVED values, i.e. what letters and screens will actually use.
    resolved: b,
    // What this institution has explicitly SAVED, so the form can show which fields
    // are genuinely theirs and which are merely inherited defaults. A form that
    // cannot tell those apart makes "clear this field" impossible to express.
    saved: row || null,
    limits: { maxLogoBytes: MAX_LOGO_BYTES, allowedLogoTypes: ALLOWED_LOGO },
  });
});

/* -------------------------------------------------------------- write ------- */

// PUT /api/branding — save this institution's own branding.
//
// Every field is optional and only the ones PRESENT in the body are touched, so a
// screen that edits colours cannot blank an address it never showed. An explicit
// empty string clears a field back to the default — which is why "absent" and "empty"
// have to mean different things here.
router.put("/", requireAuth, requirePage("settings"), async (req, res) => {
  const body = req.body || {};
  const data = {};

  for (const [field, max] of Object.entries(TEXT_FIELDS)) {
    if (body[field] === undefined) continue;
    const v = clean(body[field]);
    if (v.length > max) {
      return res.status(400).json({ error: `${field} must be ${max} characters or fewer.` });
    }
    data[field] = v || null;
  }

  for (const field of COLOUR_FIELDS) {
    if (body[field] === undefined) continue;
    const v = clean(body[field]);
    if (v && !branding.isHex(v)) {
      return res.status(400).json({ error: `${field} must be a hex colour such as #1a3a8f.` });
    }
    data[field] = v || null;
  }

  // The logo arrives as a data: URI from the browser's FileReader — no upload
  // endpoint, no object storage, no bucket to configure for a college that simply
  // wants its crest on the sign-in page.
  if (body.logoDataUri !== undefined) {
    const uri = clean(body.logoDataUri);
    if (!uri) {
      data.logoDataUri = null;
      data.logoType = null;
    } else {
      const m = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(uri);
      if (!m) return res.status(400).json({ error: "The logo must be a base64 data URI." });
      const [, type, b64] = m;
      if (!ALLOWED_LOGO.includes(type.toLowerCase())) {
        return res.status(400).json({ error: `Logo type ${type} is not supported. Use PNG, JPEG, SVG, WEBP or GIF.` });
      }
      // Length of the decoded image, computed from the base64 without decoding it.
      const bytes = Math.floor(b64.length * 3 / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
      if (bytes > MAX_LOGO_BYTES) {
        return res.status(400).json({
          error: `That logo is ${Math.round(bytes / 1024)}KB. The limit is ${MAX_LOGO_BYTES / 1024}KB — it is embedded in every page load.`,
        });
      }
      data.logoDataUri = uri;
      data.logoType = type.toLowerCase();
    }
  }

  if (body.mailFrom !== undefined) {
    const mf = body.mailFrom;
    if (mf && typeof mf === "object") {
      const keep = {};
      for (const k of ["attendance", "pat", "ask", "wellbeing"]) {
        const v = clean(mf[k]);
        if (v) keep[k] = v.slice(0, 200);
      }
      data.mailFrom = Object.keys(keep).length ? JSON.stringify(keep) : null;
    } else {
      data.mailFrom = null;
    }
  }

  if (!Object.keys(data).length) return res.status(400).json({ error: "Nothing to update." });
  data.updatedBy = req.user?.email || null;

  // UPSERT ON THE CONSTANT ID, like every other config singleton here.
  //
  // `existing` is still read, because the audit entry below needs the before-image
  // and needs to say "configured" versus "updated". But the WRITE no longer depends
  // on it: find-then-create is not atomic, and two administrators pressing Save
  // within a few hundred milliseconds on a college that has never set branding both
  // saw null and both called create. The constant primary key stopped that becoming
  // two rows — it became a P2002 instead, uncaught, so one of them got a 500 and lost
  // their save. An upsert on a known id cannot do either.
  const existing = await prisma.tenantBranding.findFirst();
  const saved = await prisma.tenantBranding.upsert({
    where: { id: existing?.id || "singleton" },
    update: data,
    create: data,
  });

  branding.invalidate();

  // The logo is a quarter-megabyte string; recording it in the audit log would put a
  // copy of every version of it in a table meant to be small and read often. That it
  // CHANGED is the fact worth keeping.
  const forLog = (o) => {
    if (!o) return null;
    const { logoDataUri, ...rest } = o;
    return { ...rest, logo: logoDataUri ? "[image, " + Math.round(logoDataUri.length / 1024) + "KB]" : null };
  };
  audit.record(req, {
    action: "branding.saved", entity: "TenantBranding", entityId: saved.id,
    summary: `Branding ${existing ? "updated" : "configured"} by ${req.user?.name || "an administrator"}` +
      (data.logoDataUri !== undefined ? (data.logoDataUri ? " (new logo)" : " (logo removed)") : ""),
    before: forLog(existing), after: forLog(saved),
  });

  const resolved = await branding.get();
  res.json({ saved, resolved });
});

// DELETE /api/branding — back to the neutral defaults.
router.delete("/", requireAuth, requirePage("settings"), async (req, res) => {
  const existing = await prisma.tenantBranding.findFirst();
  if (!existing) return res.json({ reset: false });
  // deleteMany, not delete: `delete` throws P2025 when the row has gone between the
  // read and the write — two administrators pressing Reset together, or a Reset
  // racing a Reset. Removing nothing is the correct outcome of a reset, not an error.
  // attendanceBandConfig.save() takes the same line for the same reason.
  await prisma.tenantBranding.deleteMany({ where: { id: existing.id } });
  branding.invalidate();
  audit.record(req, {
    action: "branding.reset", entity: "TenantBranding", entityId: existing.id,
    summary: "Branding reset to the platform defaults",
  });
  res.json({ reset: true, resolved: await branding.get() });
});

module.exports = router;
module.exports.PUBLIC_FIELDS = PUBLIC_FIELDS;
module.exports.MAX_LOGO_BYTES = MAX_LOGO_BYTES;
