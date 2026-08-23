// Each institution's own identity — and, more importantly, never anybody else's.
//
// The defect this guards against is not cosmetic. Before per-tenant branding, a second
// college on the platform would have sent its applicants letters and emails carrying
// the FIRST college's name, address, phone number and admissions officer. A student
// receiving an offer from the wrong institution is not a styling bug.
//
// So the assertions here are mostly negative: given a college that has configured
// nothing, prove that nothing belonging to another institution reaches it.
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

const call = async (path, { method = "GET", body, token, tenant } = {}) => {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  if (tenant) headers["X-Tenant"] = tenant;
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

await check("an unknown institution is refused, branding included", async () => {
  const r = await call("/branding", { tenant: "no-such-college" });
  assert.equal(r.status, 404, `expected 404, got ${r.status}`);
  return "branding does not leak the list of customers";
});

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
