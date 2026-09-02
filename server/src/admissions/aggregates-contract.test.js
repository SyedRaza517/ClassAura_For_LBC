// The Admission Tracker emits aggregates and nothing else — asserted from source text.
//
// WHY A TEXT-LEVEL TEST RATHER THAN AN ORDINARY ONE. The "admissions" grant opens the
// full application record: passport and ID numbers, National Insurance numbers, home
// addresses, criminal-record and medical declarations. The tracker exists so a
// principal or a marketing lead can be given the funnel WITHOUT that access, and the
// only thing standing between those two audiences is the column list in one route file.
//
// That is exactly the kind of rule somebody widens later in good faith — "I just need
// the applicant's name for a drill-down" — and once widened, nothing else in the system
// notices. So it is asserted the way schema-contract.test.js asserts that the risk
// engine never selects the REASON for a mitigating circumstance: by reading the file.
//
// Run with: node --test src/admissions/aggregates-contract.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROUTE = path.join(__dirname, "..", "routes", "admissionStats.js");
const src = fs.readFileSync(ROUTE, "utf8");

// The SELECT literal, isolated: from its declaration to the line that closes it.
function selectBlock() {
  const at = src.indexOf("const SELECT = {");
  assert.notEqual(at, -1,
    "admissionStats.js no longer declares a SELECT allowlist. If the query moved, move this " +
    "test with it deliberately — do not delete it, it is the only guard on this boundary.");
  const end = src.indexOf("\n};", at);
  assert.notEqual(end, -1, "could not find the end of the SELECT literal");
  return src.slice(at, end);
}

test("the tracker's query selects no directly identifying field", () => {
  const block = selectBlock();
  // Plain substring tests, deliberately. schema-contract.test.js records why: a
  // previous version of that guard built a RegExp inside a template literal, where \b
  // is the backspace escape, so it searched for a control character, matched nothing,
  // and passed every forbidden field while looking thorough.
  const forbidden = [
    "id:", "firstName:", "middleName:", "surname:", "email:", "phone:", "dob:",
    "niNumber:", "idDocNo:", "studentId:", "linkedStudentId:", "signature:",
    "houseNo:", "street:", "city:", "mailingAddress:",
    "emergencyName:", "emergencyPhone:", "emergencyEmail:",
  ];
  for (const f of forbidden) {
    assert.ok(!block.includes(f),
      `admissionStats.js selects "${f}". This endpoint is reachable by staff who were ` +
      `deliberately NOT granted the admissions page, and this select is the only thing ` +
      `keeping applicant identities away from them.`);
  }
});

test("the tracker's query selects no special-category declaration", () => {
  const block = selectBlock();
  // Health, disability and criminal-record answers. Article 9 / Article 10 data,
  // collected so the college can support and safeguard a student — not so a dashboard
  // can segment them. Same rule as the prediction engine: know THAT, never WHY.
  for (const f of ["criminalConviction:", "criminalDetails:", "medicalConditions:",
    "medicalDetails:", "learningDifficulty:", "learningDetails:", "ethnicity:", "religion:"]) {
    assert.ok(!block.includes(f),
      `admissionStats.js selects "${f}" — a special-category declaration that no aggregate here needs.`);
  }
});

test("the tracker's query still selects everything the funnel is built from", () => {
  // The other half, and not decoration. A guard that only checks for absences passes
  // when the matcher is broken, when the block is empty, and when the feature has been
  // deleted. This half is what makes the half above fail loudly instead of silently.
  const block = selectBlock();
  for (const needed of ["createdAt:", "applicationSubmittedAt:", "course:", "intake:",
    "foundVia:", "source:", "offerStatus:", "offerSentAt:", "enrollStatus:",
    "documents:", "isms:"]) {
    assert.ok(block.includes(needed), `the tracker's select lost "${needed}" — a funnel stage now reads zero for everyone`);
  }
});

test("the two personal fields it does read are only ever read to be bucketed", () => {
  // postCode and countryOfCitizenship ARE personal data and are selected on purpose —
  // a region chart cannot be built without them. The guarantee is that neither value
  // survives into the response: stats.js turns them into counts against bucket names
  // and drops the originals. Asserted end-to-end in stats.test.js ("the output carries
  // no applicant identifier or personal field") and in the smoke suite; named here so
  // the exception is visible beside the rule rather than looking like an oversight.
  const block = selectBlock();
  assert.ok(block.includes("postCode:"), "the region breakdown needs postCode");
  assert.ok(block.includes("countryOfCitizenship:"), "the citizenship breakdown needs countryOfCitizenship");
});

test("the router is gated, and not on the admissions page alone", () => {
  // Without a gate this endpoint is public to any signed-in account. With ONLY
  // "admissions" on it, the separate page would exist but grant nothing — the feature
  // would look delivered while its whole purpose was missing.
  assert.ok(src.includes("requireAuth"), "admissionStats.js does not require authentication");
  const at = src.indexOf("requireAnyPage(");
  assert.notEqual(at, -1, "admissionStats.js does not gate on a page at all");
  const gate = src.slice(at, src.indexOf(")", at));
  assert.ok(gate.includes("admissions-tracker"),
    "the tracker's page grant is missing from its own router — the new audience cannot reach it");
});
