// The college's OWN attendance bands — and, above all, the students they decide about.
//
// The bands were six numbers in the code (85+, 70–84, 60–69, 50–59, 40–49, 0–39), which
// is one institution's attendance policy written into the product. Now that a deployment
// serves a single college that is no longer a leak between institutions, but it is the
// same defect for the college in front of it: its regulations are not the ones shipped in
// the source. That is not a settings problem: a band decides whether a student receives a
// letter telling them their place on the programme is at risk. A college that warns at 75% and
// escalates at 60% was, until now, warning nobody at 75% and escalating nobody at 60%.
//
// So the assertions here are mostly about what a BAD band list would do to a student:
// a gap swallows them (classified as having no data, skipped by the send, silently), an
// overlap makes their letter depend on the order of an array, and a ladder that stops
// short of 0% or 100% loses the two students it is most important not to lose.
import { strict as assert } from "node:assert";

// API_URL is what scripts/test.mjs exports to a suite (it also accepts an
// already-running API that way).
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

console.log("\n=== attendance bands ===\n");

const admin = await call("/auth/login", { method: "POST", body: { email: ADMIN, password: PASSWORD } });
if (!admin.body.token) {
  console.log("✗ could not sign in as the seeded admin — is the API seeded?");
  console.log(JSON.stringify(admin.body).slice(0, 200));
  process.exit(1);
}
const token = admin.body.token;

// Every test starts from a known ladder, and the suite puts the defaults back at the end.
const putBands = (bands) => call("/attendance-emails/config", { method: "PUT", token, body: { bands } });
const getConfig = () => call("/attendance-emails/config", { token });

// A reporting period wide enough to contain every seeded register mark. The fixtures do
// not necessarily have a teaching term running TODAY, and a suite that quietly computed
// over an empty term would assert about classification while classifying nobody — which
// is the shape of a test that passes for years and protects nothing.
const WIDE = "?from=2000-01-01&to=2099-12-31";
const RANGE = { from: "2000-01-01", to: "2099-12-31" };
const getData = () => call("/attendance-emails/data" + WIDE, { token });

/* ---------------------------------------------------- defaults, not a special case --- */

await check("a college that has configured nothing gets the built-in ladder", async () => {
  await putBands(null); // reset
  const r = await getConfig();
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  const b = r.body.bands;
  assert.ok(Array.isArray(b), "config should carry the bands");
  assert.equal(b.length, 6, `expected the 6 default bands, got ${b.length}`);
  assert.equal(b[0].min, 85, "the top band should still start at 85%");
  assert.equal(b[b.length - 1].min, 0, "the bottom band should still start at 0%");
  assert.ok(b.every((x) => x.emailTrigger), "every default band emailed before this existed, and must still");
  return b.map((x) => `${x.min}–${x.max}`).join(" ");
});

await check("every default band has a colour and a letter of its own", async () => {
  const r = await getConfig();
  for (const band of r.body.bands) {
    assert.ok(/^#[0-9a-f]{6}$/i.test(band.colour), `${band.label} has no usable colour: ${band.colour}`);
    const t = r.body.templates[band.key];
    assert.ok(t && t.subject && t.body, `${band.label} has no template — every student in it would be skipped`);
  }
  return "six bands, six colours, six letters";
});

/* --------------------------------------------------------------------- validation --- */
// Each of these is refused with a message that NAMES the band and the consequence.
// "Invalid" is not actionable; an administrator has to be told which band and why.

await check("a gap is refused, and the message says which student falls into it", async () => {
  const r = await putBands([
    { label: "Top", min: 75, max: 100, colour: "#15803d", emailTrigger: true },
    { label: "Bottom", min: 0, max: 60, colour: "#b91c1c", emailTrigger: true },
  ]);
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  assert.ok(/gap/i.test(r.body.error), r.body.error);
  assert.ok(/61/.test(r.body.error), "the message should name the percentage that would fall through");
  return r.body.error;
});

await check("an overlap is refused — one student, one band, always", async () => {
  const r = await putBands([
    { label: "Top", min: 60, max: 100, colour: "#15803d", emailTrigger: true },
    { label: "Bottom", min: 0, max: 70, colour: "#b91c1c", emailTrigger: true },
  ]);
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  assert.ok(/overlap/i.test(r.body.error), r.body.error);
  return r.body.error;
});

await check("a ladder that never reaches 0% is refused", async () => {
  const r = await putBands([{ label: "Only", min: 40, max: 100, colour: "#15803d", emailTrigger: true }]);
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  assert.ok(/0%/.test(r.body.error), r.body.error);
  return r.body.error;
});

await check("a ladder that stops short of 100% is refused", async () => {
  const r = await putBands([{ label: "Only", min: 0, max: 90, colour: "#15803d", emailTrigger: true }]);
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  assert.ok(/100%/.test(r.body.error), r.body.error);
  return r.body.error;
});

await check("an empty ladder is refused", async () => {
  const r = await putBands([]);
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  return r.body.error;
});

await check("more than ten bands is refused, with the count", async () => {
  // Eleven contiguous slices, so ONLY the count is wrong.
  const many = [];
  for (let i = 10; i >= 0; i--) many.push({ label: `Band ${i}`, min: i * 9, max: i === 10 ? 100 : i * 9 + 8, colour: "#334155", emailTrigger: false });
  const r = await putBands(many);
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  assert.ok(/11/.test(r.body.error), "the message should say how many were sent");
  return r.body.error;
});

await check("a bound outside 0–100 is refused", async () => {
  const r = await putBands([
    { label: "Top", min: 101, max: 120, colour: "#15803d", emailTrigger: true },
    { label: "Bottom", min: 0, max: 100, colour: "#b91c1c", emailTrigger: true },
  ]);
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  assert.ok(/between 0 and 100/i.test(r.body.error), r.body.error);
  return r.body.error;
});

await check("a colour that is not a colour is refused", async () => {
  const r = await putBands([{ label: "Only", min: 0, max: 100, colour: "peach", emailTrigger: true }]);
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  assert.ok(/hex/i.test(r.body.error), r.body.error);
  return r.body.error;
});

await check("a band with no name is refused", async () => {
  const r = await putBands([{ label: "   ", min: 0, max: 100, colour: "#334155", emailTrigger: true }]);
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  return r.body.error;
});

await check("a refused ladder changes nothing", async () => {
  const r = await getConfig();
  assert.equal(r.body.bands.length, 6, "the defaults should still be in force after every rejection above");
  return "still the six defaults";
});

/* ------------------------------------------------------------ a college's own bands --- */

const OWN = [
  { label: "Meeting expectations", min: 80, max: 100, colour: "#15803d", emailTrigger: false },
  { label: "Watch list",           min: 65, max: 79,  colour: "#b45309", emailTrigger: true },
  { label: "Formal concern",       min: 0,  max: 64,  colour: "#b91c1c", emailTrigger: true },
];

await check("a college can run three bands with its own thresholds", async () => {
  const r = await putBands(OWN);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.bands.length, 3, "three bands, not four and not six");
  assert.equal(r.body.bands[0].min, 80);
  assert.equal(r.body.bands[1].label, "Watch list");
  return r.body.bands.map((b) => `${b.label} ${b.min}–${b.max}`).join(" · ");
});

await check("a band the college invented still gets a sendable letter", async () => {
  const r = await getConfig();
  for (const band of r.body.bands) {
    const t = r.body.templates[band.key];
    assert.ok(t && t.subject && t.body, `"${band.label}" has no letter — every student in it would be silently skipped`);
  }
  // The bands in force are the college's own, not the six built-in ones.
  assert.ok(!r.body.bands.some((b) => b.key === "highrisk"), "the built-in bands should not be in force here");
  return Object.keys(r.body.templates).join(", ");
});

await check("students are classified against the college's bands, not the built-in ones", async () => {
  const r = await getData();
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  const labels = r.body.bands.map((b) => b.label);
  assert.deepEqual(labels, OWN.map((b) => b.label), `got ${labels.join(", ")}`);
  for (const s of r.body.students) {
    if (s.pct == null) { assert.equal(s.bandKey, null, `${s.name} has no marks but was banded`); continue; }
    const band = r.body.bands.find((b) => b.key === s.bandKey);
    // The real assertion: EVERY student with a figure has exactly one band, decimals
    // included. A student on 69.5% used to match neither `<= 69` nor `>= 70` and came
    // back unbanded, which every caller reads as "no attendance data" and skips.
    assert.ok(band, `${s.name} on ${s.pct}% fell into no band at all and would be skipped`);
    assert.ok(s.pct >= band.min, `${s.name} on ${s.pct}% was put in ${band.label} (${band.min}–${band.max})`);
    assert.ok(s.pct <= band.max + 1, `${s.name} on ${s.pct}% was put in ${band.label} (${band.min}–${band.max})`);
    assert.equal(s.bandTriggers, band.emailTrigger, `${s.name}'s trigger flag disagrees with their band`);
  }
  const banded = r.body.students.filter((s) => s.pct != null).length;
  return `${banded} student${banded === 1 ? "" : "s"} with a figure, every one of them in exactly one band`;
});

await check("a boundary percentage lands in the higher band, not in nothing", async () => {
  const r = await getData();
  const bands = r.body.bands;
  // Simulated rather than seeded: the fixtures cannot be relied on to contain a student
  // sitting exactly on a threshold, and the rule under test is the classifier's.
  const forPct = (p) => [...bands].sort((a, b) => b.min - a.min).find((b) => p >= b.min);
  for (const b of bands) {
    assert.equal(forPct(b.min).key, b.key, `${b.min}% should be the first percentage in "${b.label}"`);
    if (b.min > 0) {
      assert.notEqual(forPct(b.min - 0.5).key, b.key, `${b.min - 0.5}% should fall to the band below`);
      assert.ok(forPct(b.min - 0.5), "a half-percentage must still land somewhere");
    }
  }
  return "whole and half percentages both land in exactly one band";
});

/* ---------------------------------------------------- which bands actually send mail --- */

await check("a band with its trigger off is not written to by the monthly run", async () => {
  const data = await getData();
  const quiet = data.body.bands.find((b) => !b.emailTrigger);
  assert.ok(quiet, "this fixture should have a non-emailing band");
  const inQuiet = data.body.students.filter((s) => s.bandKey === quiet.key && s.email);
  const r = await call("/attendance-emails/run", { method: "POST", token, body: { force: true, ...RANGE } });
  // Email is normally unconfigured under test, which is its own 400 ("email-off"). Both
  // outcomes are acceptable here; what must never happen is those students being SENT to.
  if (r.status === 200) {
    assert.ok(r.body.notTriggered >= inQuiet.length,
      `${inQuiet.length} students sit in "${quiet.label}", which does not email, but only ${r.body.notTriggered} were held back`);
    return `${r.body.notTriggered} held back, ${r.body.sent} sent`;
  }
  assert.ok(/configured|teaching term|attendance bands/i.test(r.body.error || ""), r.body.error);
  return `run refused for an unrelated reason (${(r.body.error || "").slice(0, 60)}…), nothing sent`;
});

await check("switching every trigger off is reported, not treated as a clean send", async () => {
  await putBands(OWN.map((b) => ({ ...b, emailTrigger: false })));
  // A run that is valid in every OTHER respect — a real reporting period, students with
  // marks in it — so the only thing stopping it is that no band asks for a letter.
  const r = await call("/attendance-emails/run", { method: "POST", token, body: { force: true, ...RANGE } });
  assert.equal(r.status, 400, `expected 400, got ${r.status}: ${JSON.stringify(r.body).slice(0, 160)}`);
  assert.ok(/none of your attendance bands/i.test(r.body.error || ""), r.body.error);
  return r.body.error.slice(0, 80) + "…";
});

/* ------------------------------------------------------------------- renaming a band --- */

await check("renaming a band keeps the letter that belongs to it", async () => {
  await putBands(OWN);
  const before = await getConfig();
  const key = before.body.bands[1].key;
  const wording = "Subject written for the watch list — " + Date.now();
  await call("/attendance-emails/config", { method: "PUT", token, body: { templates: { [key]: { subject: wording, body: before.body.templates[key].body } } } });

  // Same key, new label — which is exactly what the editor sends on a rename.
  const renamed = OWN.map((b, i) => (i === 1 ? { ...b, key, label: "Amber" } : b));
  const r = await putBands(renamed);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  const after = await getConfig();
  assert.equal(after.body.bands[1].label, "Amber");
  assert.equal(after.body.templates[key].subject, wording,
    "the letter must follow the band through a rename — it is an afternoon's work to write");
  return "letter intact";
});

/* ----------------------------------------------------------------------- isolation --- */
//
// REMOVED: "bands cannot be read for an institution that does not exist". It sent
// X-Tenant: no-such-college and required a 404 — the middleware refusing to serve an
// unknown institution without confirming whether it exists. There is no X-Tenant header
// and no institution registry to miss in, so the header would be ignored and the call
// would simply return this college's bands with a 200. Restating it against the new
// behaviour would assert only that an unknown request header is ignored, which is true
// of every header and proves nothing about who may read the band ladder.
//
// The assertion below is the one that carried the access rule, and it is untouched.

await check("bands cannot be changed without signing in", async () => {
  const r = await call("/attendance-emails/config", { method: "PUT", body: { bands: OWN } });
  assert.ok(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}`);
  return "the ladder that decides who gets a warning letter is not public";
});

/* --------------------------------------------------------------------------- reset --- */

await check("resetting restores the platform defaults", async () => {
  const r = await putBands(null);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.bands.length, 6);
  assert.equal(r.body.bands[0].min, 85);
  assert.ok(r.body.bands.every((b) => b.emailTrigger), "the defaults all email, as they did before bands were configurable");
  return "back to the six defaults";
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
