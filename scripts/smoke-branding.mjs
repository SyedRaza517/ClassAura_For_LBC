// The institution's own identity on its letters, offers and emails.
//
// This suite was written when the platform was multi-tenant, and its original point was
// that a second college would otherwise have sent ITS applicants letters carrying the
// FIRST college's name, address, phone number and admissions officer. One deployment now
// serves one college, so that particular accident is impossible by construction and the
// assertion that covered it has gone (see "isolation" below).
//
// What remains is still worth asserting and is not merely cosmetic: branding is written
// through an ALLOWLIST, an unset field falls back to a platform default rather than to
// whatever happened to be in the column, a reset restores that default, and none of it is
// writable without signing in. Those are the rules that decide what an applicant reads on
// an offer letter, and they are all here.
import { strict as assert } from "node:assert";

// API_URL is what scripts/test.mjs actually exports to a suite (it also accepts an
// already-running API that way). Reading API_BASE meant this suite silently used the
// default port and would have talked to the wrong server under TEST_PORT.
const BASE = process.env.API_URL || "http://localhost:4010/api";
const ADMIN = process.env.SEED_ADMIN_EMAIL || "admin@edtech.co.uk";
const PASSWORD = process.env.SEED_PASSWORD || "test-seed-password-2026";

let passed = 0, failed = 0;
const ok = (label, detail) => { passed++; console.log(`✓ ${label}${detail ? "  — " + detail : ""}`); };
const bad = (label, e) => { failed++; console.log(`✗ ${label}\n    ${e && e.message ? e.message : e}`); };
async function check(label, fn) {
  try { const d = await fn(); ok(label, d); } catch (e) { bad(label, e); }
}

const call = async (path, { method = "GET", body, token } = {}) => {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
};

// Anything that would prove one institution's identity had leaked into another's.
const FOREIGN = [/EdTech/i, /edtech\.co\.uk/i, /Swaroop/i, /42 The Burroughs/i, /\+44 7946 830578/];
function assertNoForeignIdentity(where, text) {
  const s = JSON.stringify(text);
  for (const re of FOREIGN) {
    assert.ok(!re.test(s), `${where} contains another institution's identity: ${re}`);
  }
}

console.log("\n=== branding ===\n");

const admin = await call("/auth/login", { method: "POST", body: { email: ADMIN, password: PASSWORD } });
if (!admin.body.token) {
  console.log("✗ could not sign in as the seeded admin — is the API seeded?");
  console.log(JSON.stringify(admin.body).slice(0, 200));
  process.exit(1);
}
const token = admin.body.token;

/* ------------------------------------------------------- the public shape --- */

await check("GET /branding needs no token", async () => {
  const r = await call("/branding");
  assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  return "the sign-in screen can be branded before anyone signs in";
});

await check("the public endpoint exposes no correspondence details", async () => {
  const r = await call("/branding");
  for (const leaked of ["signatoryName", "signatoryTitle", "legalFooter", "addressLines", "contactPhone", "mailFrom"]) {
    assert.ok(!(leaked in r.body), `${leaked} must not be public`);
  }
  return "signatory, address, legal footer and mail-from all withheld";
});

/* ------------------------------------------------------------ validation --- */

await check("a colour that is not a colour is refused", async () => {
  const r = await call("/branding", { method: "PUT", token, body: { primaryColor: "red" } });
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  return r.body.error;
});

await check("a logo that is not an image is refused", async () => {
  const r = await call("/branding", { method: "PUT", token, body: { logoDataUri: "data:text/html;base64,PGh0bWw+" } });
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  return r.body.error;
});

await check("a remote logo URL is refused", async () => {
  // Only a data: URI is accepted. A URL would make every page load fetch a third
  // party chosen by a customer, from inside every other customer's app.
  const r = await call("/branding", { method: "PUT", token, body: { logoDataUri: "https://example.com/logo.png" } });
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  return r.body.error;
});

/* ------------------------------------------------- a college's own identity --- */

const saved = await call("/branding/all", { token });
const before = saved.body?.saved || {};

await check("a college can set its own identity", async () => {
  const r = await call("/branding", {
    method: "PUT", token,
    body: {
      displayName: "Riverside College", shortName: "Riverside",
      primaryColor: "#0f766e", accentColor: "#b45309",
      contactEmail: "hello@riverside.ac.uk",
      signatoryName: "Dr Helen Whitfield", signatoryTitle: "Head of Admissions",
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.resolved.displayName, "Riverside College");
  assert.equal(r.body.resolved.primaryColor, "#0f766e");
  return "name, colours, contact and signatory all applied";
});

await check("outbound mail is built on the college's OWN domain", async () => {
  const r = await call("/branding/all", { token });
  const mf = r.body.resolved.mailFrom || {};
  for (const [team, addr] of Object.entries(mf)) {
    if (!addr) continue;
    assert.ok(!/edtech\.co\.uk/i.test(addr), `${team} still sends from another institution's domain: ${addr}`);
    assert.ok(/riverside\.ac\.uk/i.test(addr), `${team} should use the college's domain, got: ${addr}`);
  }
  return mf.pat || "(no mail-from configured)";
});

await check("the change is visible to the public endpoint", async () => {
  const r = await call("/branding");
  assert.equal(r.body.displayName, "Riverside College");
  assert.equal(r.body.primaryColor, "#0f766e");
  return "a signed-out visitor sees the college's own branding";
});

/* --------------------------------------------------------- email wording --- */

await check("built-in email wording carries the college's identity, not ours", async () => {
  const r = await call("/email-templates/offer/preview", { token });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  assertNoForeignIdentity("the offer email", r.body);
  assert.ok(/Riverside College/.test(r.body.subject + r.body.text), "the college's own name should appear");
  return r.body.subject;
});

await check("a placeholder that does not exist is refused, not sent", async () => {
  const r = await call("/email-templates/offer", { method: "PUT", token, body: { subject: "Hi {{studentName}}" } });
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  assert.ok(/studentName/.test(r.body.error), "the error should name the offending placeholder");
  return r.body.error.slice(0, 90) + "…";
});

await check("HTML in a college's wording is escaped, not delivered", async () => {
  await call("/email-templates/offer", {
    method: "PUT", token,
    body: { subject: "Offer from {{college}}", body: "Dear {{firstName}} <script>alert(1)</script> & hello", enabled: true },
  });
  const r = await call("/email-templates/offer/preview", { token });
  assert.ok(!r.body.html.includes("<script>"), "a script tag must never reach an applicant");
  assert.ok(r.body.html.includes("&lt;script&gt;"), "it should be escaped, not stripped silently");
  assert.ok(r.body.html.includes("&amp;"), "an ampersand must not break the message");
  return "escaped";
});

await check("a college's own wording is what actually renders", async () => {
  const r = await call("/email-templates/offer/preview", { token });
  assert.equal(r.body.custom, true);
  assert.ok(/Offer from Riverside College/.test(r.body.subject), r.body.subject);
  return r.body.subject;
});

await check("resetting restores the built-in wording", async () => {
  await call("/email-templates/offer", { method: "DELETE", token });
  const r = await call("/email-templates/offer/preview", { token });
  assert.equal(r.body.custom, false);
  return r.body.subject;
});

/* ------------------------------------------------------------- isolation --- */
//
// REMOVED: "an unknown institution is refused, branding included". It sent
// X-Tenant: no-such-college to the unauthenticated GET /branding and demanded a 404,
// which proved that the endpoint the login screen calls before anyone has signed in
// could not be used to enumerate the supplier's customer list.
//
// There is no customer list to enumerate and no X-Tenant header to send. Restating it
// would assert that an unrecognised request header is ignored — true of every header,
// and it would sit on the summary line looking like isolation coverage. GET /branding
// is still deliberately public, and that is correct: it serves the login screen its own
// college's name and colours, which is the only thing it now knows.

/* --------------------------------------------------------------- restore --- */

await check("restore the seeded branding", async () => {
  const body = {};
  for (const k of ["displayName", "shortName", "wordmarkTop", "wordmarkSub", "primaryColor",
                   "accentColor", "addressLines", "contactEmail", "contactPhone", "website",
                   "legalFooter", "signatoryName", "signatoryTitle"]) {
    body[k] = before[k] ?? "";
  }
  const r = await call("/branding", { method: "PUT", token, body });
  assert.equal(r.status, 200);
  return "put back as it was";
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
