// The Admission Tracker — and above all, what never leaves the building.
//
// The tracker exists to answer one awkward question: how do you show a principal or a
// marketing lead the admissions funnel without also showing them four thousand
// applicants' passport numbers, National Insurance numbers, home addresses and medical
// declarations? The answer is a separate admin page over an endpoint that emits
// aggregates only — and that answer is worth exactly as much as the assertions holding
// it up.
//
// Three assertions carry this suite:
//
//   1. A member of staff granted ONLY "admissions-tracker" gets the figures, and a
//      member of staff granted neither page gets 403 — not an empty dashboard. An empty
//      funnel and a funnel you may not read are different answers, and the second
//      dressed as the first teaches an executive the college has no applicants.
//   2. NO SEEDED APPLICANT'S NAME, EMAIL, NI NUMBER, POSTCODE OR ID APPEARS ANYWHERE IN
//      THE RESPONSE BODY. Asserted against the whole serialised payload rather than
//      field by field, because the failure being guarded against is a field somebody
//      adds to a panel next year, not one that is there today.
//   3. The funnel does not widen as it descends, over REAL rows including an enrolled
//      applicant with no interview and no offer on file — the exact shape that produces
//      an inverted trapezoid when each stage is counted on its own evidence.
//
// Alongside those: the singleton settings row stays single under concurrent saves, a
// course fee reaches the revenue estimate, and rates come back null rather than zero
// where nothing has happened yet.
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
const require = createRequire(pathToFileURL(join(ROOT, "server", "package.json")));
const { PrismaClient } = require(`${ROOT}/server/node_modules/@prisma/client`);
const { DOC_KEYS } = require(`${ROOT}/server/src/admissionDocs`);
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required — point it at a throwaway database."); process.exit(1); }
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

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
  return { status: res.status, body: json, text };
};

console.log("\n=== admission tracker ===\n");

const admin = await call("/auth/login", { method: "POST", body: { email: ADMIN, password: PASSWORD } });
if (!admin.body.token) {
  console.log("✗ could not sign in as the seeded admin — is the API seeded?");
  console.log(JSON.stringify(admin.body).slice(0, 200));
  process.exit(1);
}
const adminToken = admin.body.token;

// A build without the router answers 404 on every path under it. Reporting that once is
// worth more than twenty failures burying it.
const probe = await call("/admission-stats/settings", { token: adminToken });
if (probe.status === 404) {
  console.log("SKIP — /api/admission-stats is not mounted in this build");
  process.exit(2);
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const stamp = Date.now();
const COURSE = `Smoke HND Tracker ${stamp}`;
const INTAKE = "September 2026";
const FEE_PENCE = 925000;

// Deliberately unmistakable personal data. Every one of these strings is searched for
// in the response body, so they must not be words that could legitimately appear in an
// aggregate — no real region, country, course or source name resembles them.
const PII = {
  firstName: `Zebulon${stamp}`,
  surname: `Quixotebury${stamp}`,
  email: `zeb.quixotebury.${stamp}@example.test`,
  niNumber: `QQ${String(stamp).slice(-6)}C`,
  postCode: "B15 2TT",
  idDocNo: `PASSPORT${stamp}`,
};

// Two staff accounts, because the whole feature is the gap between them: one granted
// the tracker and NOTHING else, one granted a page that has nothing to do with it.
const people = {
  viewer: { name: "Tracker Viewer", email: `trk.viewer.${stamp}@edtech.co.uk`, pw: "TrkView123!", pages: ["admissions-tracker"] },
  outsider: { name: "Unrelated Tutor", email: `trk.outsider.${stamp}@edtech.co.uk`, pw: "TrkOut123!", pages: ["pat"] },
};

for (const p of Object.values(people)) {
  const made = await call("/staff", { method: "POST", token: adminToken, body: { name: p.name, email: p.email, password: p.pw } });
  if (!made.body?.id) {
    console.log(`✗ could not create the fixture ${p.email}`);
    console.log(JSON.stringify(made.body).slice(0, 200));
    process.exit(1);
  }
  p.id = made.body.id;
  // The page grant is written directly, for the reason smoke-mitigations.mjs records:
  // the route that sets adminPages is not the subject of this suite.
  await db.staff.update({
    where: { id: p.id },
    data: { accountRole: "ADMIN", adminPages: JSON.stringify(p.pages), mustChangePassword: false },
  });
  const login = await call("/auth/login", { method: "POST", body: { email: p.email, password: p.pw } });
  if (!login.body?.token) {
    console.log(`✗ could not sign in as the fixture ${p.email}`);
    process.exit(1);
  }
  p.token = login.body.token;
}

const course = await db.admissionCourse.create({ data: { name: COURSE, feeAmountPence: FEE_PENCE } });
// The intake list drives "compare against the previous intake". Both labels are real
// month-and-year strings because that is what previousIntake() can place in time.
const intakes = [];
for (const label of ["April 2026", INTAKE]) {
  const existing = await db.admissionIntake.findFirst({ where: { label } });
  if (!existing) intakes.push(await db.admissionIntake.create({ data: { label } }));
}

const docs = () => ({ create: DOC_KEYS.map((docType) => ({ docType, fileName: `${docType}.pdf` })) });
const base = { course: COURSE, intake: INTAKE, foundVia: "Agent", source: "portal", countryOfCitizenship: "United Kingdom", ...PII };
const T = (s) => new Date(s);

// Seven applicants, one per rung, so every stage count is known exactly — and the last
// one is the awkward case the funnel rule exists for.
const made = [];
made.push(await db.admission.create({ data: { ...base } }));                                           // 1 enquiry only
made.push(await db.admission.create({ data: { ...base, applicationSubmittedAt: T("2026-02-01") } }));   // 2 applied
made.push(await db.admission.create({ data: { ...base, applicationSubmittedAt: T("2026-02-02"), documents: docs() } }));
made.push(await db.admission.create({ data: { ...base, applicationSubmittedAt: T("2026-02-03"), documents: docs() } }));
made.push(await db.admission.create({ data: { ...base, applicationSubmittedAt: T("2026-02-04"), documents: docs(), offerSentAt: T("2026-04-01"), offerStatus: "sent" } }));
made.push(await db.admission.create({ data: { ...base, applicationSubmittedAt: T("2026-02-05"), documents: docs(), offerSentAt: T("2026-04-02"), offerStatus: "accepted", offerAcceptedAt: T("2026-04-10") } }));
// THE AWKWARD ONE: enrolled, with no interview recorded and no offer letter on file.
// Ordinary in real life — staff enrol from a decision taken in a room and tidy the
// record later, or never — and the exact row that inverts a naively counted funnel.
made.push(await db.admission.create({ data: { ...base, enrollStatus: "Enroll" } }));

// Interviews for rows 4, 5 and 6 only. An Ism with a DATE is what counts; one without
// is a form somebody opened.
const isms = [];
for (const a of [made[3], made[4], made[5]]) {
  isms.push(await db.ism.create({ data: { admissionId: a.id, interviewDate: "2026-03-01", admitted: "Yes" } }));
}
isms.push(await db.ism.create({ data: { admissionId: made[2].id, interviewDate: null } }));

const scoped = `?course=${encodeURIComponent(COURSE)}&intake=${encodeURIComponent(INTAKE)}`;

/* -------------------------------------------------------------------------- */
/* Who may read it                                                             */
/* -------------------------------------------------------------------------- */

await check("a staff member granted only the tracker page can read the figures", async () => {
  const r = await call(`/admission-stats${scoped}`, { token: people.viewer.token });
  assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  assert.ok(Array.isArray(r.body.funnel), "no funnel in the response");
  return `${r.body.funnel.length} stages`;
});

await check("a staff member granted neither page is refused, not shown an empty funnel", async () => {
  const r = await call(`/admission-stats${scoped}`, { token: people.outsider.token });
  assert.equal(r.status, 403, `expected 403, got ${r.status}`);
  // The distinction that matters: a refusal must not arrive dressed as a dashboard.
  //
  // Asserted on the RAW TEXT, not on r.body.funnel. Checking a parsed field is absent
  // from an error body cannot fail — the 403 above already guarantees there is no
  // funnel in it — so the check read as coverage while discriminating nothing. The
  // failure actually worth catching is a handler that returns figures alongside an
  // error status, and only the body text can show that.
  assert.ok(!r.text.includes("\"funnel\""), "a refused request still returned funnel data");
  assert.ok(!r.text.includes("\"kpis\""), "a refused request still returned KPI data");
  return "403";
});

await check("an unauthenticated request is refused", async () => {
  const r = await call(`/admission-stats${scoped}`);
  assert.equal(r.status, 401, `expected 401, got ${r.status}`);
  return "401";
});

await check("an admissions officer keeps access without the new grant", async () => {
  // The new page ADDS an audience; it must not take one away from the people whose
  // funnel it is.
  const r = await call(`/admission-stats${scoped}`, { token: adminToken });
  assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  return "200";
});

/* -------------------------------------------------------------------------- */
/* Nothing personal leaves the building                                        */
/* -------------------------------------------------------------------------- */

await check("no applicant name, email, NI number, ID number or postcode is in the response", async () => {
  const r = await call(`/admission-stats${scoped}`, { token: people.viewer.token });
  // THE POSITIVE HALF FIRST, and it is not decoration. Without it every "field is
  // absent" assertion below passes on a 403, a 500, or an empty body — the check would
  // report six fields safely absent from a response that never contained anything at
  // all, and would go on passing after the endpoint was deleted. A negatives-only guard
  // is exactly what aggregates-contract.test.js warns about; that reasoning belongs
  // here too.
  assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  assert.ok(Array.isArray(r.body.funnel) && r.body.funnel.length === 7, "no funnel in the response — nothing was actually inspected");
  assert.ok(r.body.funnel[0].count > 0, "the funnel is empty, so the absence of personal data proves nothing");

  const body = JSON.stringify(r.body);
  for (const [field, value] of Object.entries(PII)) {
    assert.ok(!body.includes(value),
      `the response contains the applicant's ${field} ("${value}"). This endpoint is reachable ` +
      `by staff deliberately NOT granted the admissions page.`);
  }
  return `${Object.keys(PII).length} fields absent from ${body.length} bytes of real figures`;
});

await check("no applicant id is in the response", async () => {
  const r = await call(`/admission-stats${scoped}`, { token: people.viewer.token });
  const body = JSON.stringify(r.body);
  for (const a of made) {
    assert.ok(!body.includes(a.id), `the response contains an Admission id (${a.id})`);
  }
  return `${made.length} ids absent`;
});

await check("the postcode is reported as a region, which is the point of reading it", async () => {
  // The positive half. A guard that only checks the postcode is absent would also pass
  // if the geography panel had been deleted — which is a different bug, not a fix.
  const r = await call(`/admission-stats${scoped}`, { token: people.viewer.token });
  const west = r.body.geography.regions.find((x) => x.region === "West Midlands");
  assert.ok(west, "B15 2TT did not become a West Midlands count");
  assert.equal(west.count, made.length);
  return `West Midlands ${west.count}`;
});

/* -------------------------------------------------------------------------- */
/* The funnel, over real rows                                                  */
/* -------------------------------------------------------------------------- */

await check("the funnel counts each stage against the seeded applicants", async () => {
  const r = await call(`/admission-stats${scoped}`, { token: people.viewer.token });
  const at = (k) => r.body.funnel.find((s) => s.key === k).count;
  assert.equal(at("enquiries"), 7, "enquiries");
  assert.equal(at("applications"), 6, "applications");         // 5 submitted + the enrolled one, implied
  assert.equal(at("documentsComplete"), 5, "documentsComplete");
  assert.equal(at("interviewed"), 4, "interviewed");
  assert.equal(at("offersSent"), 3, "offersSent");
  assert.equal(at("offersAccepted"), 2, "offersAccepted");
  assert.equal(at("enrolled"), 1, "enrolled");
  return r.body.funnel.map((s) => s.count).join(" → ");
});

await check("the funnel does not widen as it descends, over real rows", async () => {
  const r = await call(`/admission-stats${scoped}`, { token: people.viewer.token });
  const counts = r.body.funnel.map((s) => s.count);
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i] <= counts[i - 1],
      `stage ${r.body.funnel[i].key} (${counts[i]}) exceeds ${r.body.funnel[i - 1].key} (${counts[i - 1]}) — ` +
      `an applicant enrolled without an interview on file has inverted the funnel`);
  }
  return "monotonic";
});

await check("an ISM with no date is not counted as an interview", async () => {
  // Row 3 has an Ism row with interviewDate null. If it counted, interviewed would be 5.
  const r = await call(`/admission-stats${scoped}`, { token: people.viewer.token });
  assert.equal(r.body.funnel.find((s) => s.key === "interviewed").count, 4);
  return "4, not 5";
});

await check("rates are computed from the seeded rows", async () => {
  const r = await call(`/admission-stats${scoped}`, { token: people.viewer.token });
  assert.equal(r.body.kpis.admitRate.value, 50);      // 3 offers / 6 applications
  assert.equal(r.body.kpis.yieldRate.value, 33.3);    // 1 enrolled / 3 offers
  return `admit 50%, yield 33.3%`;
});

await check("a scope with nothing in it reports unmeasurable rates, not zero", async () => {
  const r = await call(`/admission-stats?course=${encodeURIComponent("No Such Course " + stamp)}`, { token: people.viewer.token });
  assert.equal(r.status, 200);
  assert.equal(r.body.kpis.admitRate.value, null, "an empty scope reported a 0% admit rate");
  assert.equal(r.body.kpis.yieldRate.value, null, "an empty scope reported a 0% yield rate");
  assert.equal(r.body.funnel.find((s) => s.key === "enquiries").count, 0);
  return "null, not 0";
});

/* -------------------------------------------------------------------------- */
/* Revenue reaches the figure from the course fee                              */
/* -------------------------------------------------------------------------- */

await check("a course fee reaches the estimated revenue", async () => {
  const r = await call(`/admission-stats${scoped}`, { token: people.viewer.token });
  const rev = r.body.kpis.revenue;
  assert.equal(rev.pence, FEE_PENCE, "one enrolment on a course with a fee");
  assert.equal(rev.coveredEnrolments, 1);
  assert.equal(rev.totalEnrolments, 1);
  return `${rev.pence}p from ${rev.coveredEnrolments}/${rev.totalEnrolments} enrolments`;
});

await check("clearing the fee makes revenue unmeasurable rather than zero", async () => {
  await db.admissionCourse.update({ where: { id: course.id }, data: { feeAmountPence: null } });
  const r = await call(`/admission-stats${scoped}`, { token: people.viewer.token });
  const rev = r.body.kpis.revenue;
  assert.equal(rev.pence, null, "a course with no fee reported £0 of revenue");
  assert.equal(rev.totalEnrolments, 1, "the enrolment itself must still be counted");
  await db.admissionCourse.update({ where: { id: course.id }, data: { feeAmountPence: FEE_PENCE } });
  return "null, with the enrolment still counted";
});

/* -------------------------------------------------------------------------- */
/* The settings row stays single                                               */
/* -------------------------------------------------------------------------- */

await check("saving settings twice leaves exactly one row", async () => {
  await call("/admission-stats/settings", { method: "PUT", token: adminToken, body: { targets: { default: { applications: 100 } } } });
  await call("/admission-stats/settings", { method: "PUT", token: adminToken, body: { targets: { default: { applications: 200 } } } });
  const n = await db.admissionTrackerSettings.count();
  assert.equal(n, 1, `${n} settings rows — the constant primary key is not holding`);
  return "1 row";
});

await check("two administrators saving at once still leave one row", async () => {
  // The race the constant primary key exists for. Find-then-create would let both
  // writers insert, after which findFirst returns whichever row the planner picks and
  // the targets this dashboard judges the admissions team against become a coin toss.
  await db.admissionTrackerSettings.deleteMany({});
  await Promise.all([
    call("/admission-stats/settings", { method: "PUT", token: adminToken, body: { targets: { default: { enrolled: 10 } } } }),
    call("/admission-stats/settings", { method: "PUT", token: adminToken, body: { targets: { default: { enrolled: 20 } } } }),
  ]);
  const n = await db.admissionTrackerSettings.count();
  assert.equal(n, 1, `${n} settings rows after concurrent saves`);
  return "1 row";
});

await check("a saved target comes back on the dashboard", async () => {
  await call("/admission-stats/settings", { method: "PUT", token: adminToken, body: { targets: { default: { applications: 12 } } } });
  const r = await call(`/admission-stats${scoped}`, { token: people.viewer.token });
  const t = r.body.targets.find((x) => x.key === "applications");
  assert.equal(t.target, 12);
  assert.equal(t.actual, 6);
  assert.equal(t.variancePct, -50);
  return "6 against a target of 12 — −50%";
});

await check("a metric with no target reports no variance rather than a zero target", async () => {
  const r = await call(`/admission-stats${scoped}`, { token: people.viewer.token });
  const t = r.body.targets.find((x) => x.key === "yieldRate");
  assert.equal(t.target, null);
  assert.equal(t.variancePp, null);
  return "null target, null variance";
});

await check("an unusable document type is refused entry to the required list", async () => {
  const r = await call("/admission-stats/settings", { method: "PUT", token: adminToken, body: { requiredDocTypes: ["passport", "unicorn"] } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.requiredDocTypes, ["passport"], "an unknown doc type was stored");
  return "unicorn dropped";
});

await check("narrowing the required documents moves the funnel stage it defines", async () => {
  // The reason the list is configurable at all: with only a passport required, the two
  // applicants who uploaded nothing are still short, but nobody is failed for missing
  // an immigration share code their nationality does not need.
  const r = await call(`/admission-stats${scoped}`, { token: people.viewer.token });
  assert.equal(r.body.funnel.find((s) => s.key === "documentsComplete").count, 5);
  return "5 complete against a one-document requirement";
});

/* -------------------------------------------------------------------------- */
/* Cleanup                                                                     */
/* -------------------------------------------------------------------------- */

// Ism.admissionId is SetNull, so the interviews outlive their applicants and must go
// explicitly — otherwise this suite leaves orphaned interview records behind for every
// run, which is a change to the college's world and not only to this suite's.
await db.ism.deleteMany({ where: { id: { in: isms.map((i) => i.id) } } });
// AdmissionDocument is Cascade, so the uploaded-document rows go with the applicants.
await db.admission.deleteMany({ where: { id: { in: made.map((a) => a.id) } } });
await db.admissionCourse.deleteMany({ where: { id: course.id } });
await db.admissionIntake.deleteMany({ where: { id: { in: intakes.map((i) => i.id) } } });
// The settings row goes back to not existing, which is the state a college that has
// never opened this screen is in — and the state the defaults are written for.
await db.admissionTrackerSettings.deleteMany({});
// The staff fixtures LAST, after every assertion that used their tokens. Leaving them
// would give the college two extra administrators, which smoke-account-deletion.mjs
// has a rule about.
await db.staff.deleteMany({ where: { email: { in: Object.values(people).map((p) => p.email) } } });
await db.$disconnect();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
