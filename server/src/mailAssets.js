// The pieces of an institution's identity that every email header and footer repeats.
//
// The logo used to be one file shipped with the front-end (client/public/edtech-logo.png)
// resolved against the client origin, so every college's mail carried EdTech's mark; the
// footers under it were eight separate copies of one address and one phone number. Both
// now come from the tenant's branding, and both are assembled here so the "leave the line
// out when the college has not set it" rule is written once instead of eight times.
//
// WHY THE LOGO IS A data: URI AND NOT A HOSTED <img>
//
// A hosted URL renders everywhere; a data: URI is stripped by Gmail and Outlook.com. We
// still prefer the data: URI, because the two failure modes are not comparable. A blocked
// image leaves the wordmark printed underneath it, which still reads as the right college.
// A hosted fallback would have to point at a file belonging to somebody else. LOGO_URL is
// kept for a deployment that hosts its own image and would rather have it render.
//
// Every function here returns "" (not "undefined", not an empty label) when there is
// nothing to show, so a caller can interpolate it unconditionally.

// No default. A guessed URL is either a 404 or another institution's logo.
const LOGO_URL = process.env.LOGO_URL || null;

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * The postal address on one line, "" when the college has not given one. It is stored
 * with real newlines because it is a postal address; every place it appears in an email —
 * a footer, a "Location:" row — is a single line, so it is flattened once here.
 */
const addressOneLine = (brand) =>
  String((brand && brand.addressLines) || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(", ");

/**
 * How to name a place to go to: the institution, then its address. Either half may be
 * missing and is left out; "" when it has given neither, so the caller can drop the whole
 * line rather than send an applicant to an address belonging to somebody else.
 */
const venue = (brand) => [brand && brand.displayName, addressOneLine(brand)].filter(Boolean).join(", ");

/** The image to use for this institution, or null when it has none. */
function logoSrc(brand) {
  return (brand && brand.logoDataUri) || LOGO_URL || null;
}

/**
 * The header <img>, or "" when there is no logo — never a broken image and never
 * another institution's mark. width/height are inlined because Outlook will not
 * lay the header out without them.
 */
function logoImg(brand, { width = 44, height = 26 } = {}) {
  const src = logoSrc(brand);
  if (!src) return "";
  return `<img src="${src}" width="${width}" height="${height}" alt="${esc((brand && brand.displayName) || "")}" ` +
    `style="display:block;margin:0 0 10px;border:0;outline:none;max-width:${width}px" />`;
}

/** The wordmark line in a header, or "" when the college has no name to print. */
function wordmark(brand, { size = 18 } = {}) {
  const name = brand && brand.displayName;
  if (!name) return "";
  return `<p style="margin:0;color:#fff;font-size:${size}px;font-weight:800">${esc(name)}</p>`;
}

/**
 * The two footer lines — "<name> · <address>" and "<email> · <phone> · <website>" —
 * with every part the college has not filled in dropped rather than printed as an
 * empty separator. Returns [] when it has filled in none of them, so the whole
 * footer block can be omitted instead of rendering an empty grey bar.
 */
function footerLines(brand) {
  const b = brand || {};
  const first = [b.displayName, addressOneLine(b)].filter(Boolean).join(" · ");
  const second = [b.contactEmail, b.contactPhone, b.website].filter(Boolean).join(" · ");
  return [first, second].filter(Boolean);
}

/** The same, as plain text for the text/plain alternative. */
const footerText = (brand) => footerLines(brand).join("\n");

/** The same, as the inner HTML of a footer paragraph. "" when there is nothing to say. */
const footerHtml = (brand) => footerLines(brand).map(esc).join("<br>");

module.exports = { logoSrc, logoImg, wordmark, addressOneLine, venue, footerLines, footerText, footerHtml, esc };
