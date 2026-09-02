// Tests for the Admission Tracker's aggregation.
//
// The module is pure — rows in, dashboard object out, no Prisma and no Express — which
// is the whole reason the arithmetic lives in its own file. It matters more here than
// in most of this codebase: THERE IS NO CLIENT-SIDE TEST FRAMEWORK AT ALL, so any rule
// left in JSX is verified only by the build compiling.
//
// Run with: node --test src/admissions/stats.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const { buildStats } = require("./stats");
const { merge } = require("./trackerSettings");
const { DOC_KEYS } = require("../admissionDocs");

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

let seq = 0;
const row = (over = {}) => ({
  id: `a${++seq}`,
  createdAt: new Date("2026-01-15T10:00:00Z"),
  applicationSubmittedAt: null,
  course: "HND Business",
  intake: "September 2026",
  foundVia: "Agent",
  source: "portal",
  countryOfCitizenship: "United Kingdom",
  postCode: "B1 1AA",
  offerStatus: null,
  offerSentAt: null,
  offerAcceptedAt: null,
  enrollStatus: null,
  documents: [],
  isms: [],
  ...over,
});

// All ten documents present — the default "documents complete".
const allDocs = () => DOC_KEYS.map((docType) => ({ docType }));

const CONFIG = merge(null);
const build = (rows, opts = {}) => buildStats({ rows, config: CONFIG, ...opts });
const stage = (out, key) => out.funnel.find((s) => s.key === key);

/* -------------------------------------------------------------------------- */
/* The funnel — stage rules                                                    */
/* -------------------------------------------------------------------------- */

test("every row in scope is an enquiry", () => {
  assert.equal(stage(build([row(), row(), row()]), "enquiries").count, 3);
});

test("a submitted application counts as an application", () => {
  const out = build([row({ applicationSubmittedAt: new Date("2026-02-01") }), row()]);
  assert.equal(stage(out, "applications").count, 1);
});

test("a public-form row counts as an application without a submitted timestamp", () => {
  // source:"apply" rows are created BY the act of submitting the public form, so they
  // have no separate applicationSubmittedAt. Requiring the timestamp would report a
  // college that recruits through its website as having almost no applications.
  assert.equal(stage(build([row({ source: "apply" })]), "applications").count, 1);
});

test("documents are complete only when every required type is present", () => {
  const short = allDocs().slice(0, 5);
  const out = build([row({ documents: allDocs() }), row({ documents: short })]);
  assert.equal(stage(out, "documentsComplete").count, 1);
});

test("documents complete honours a college's reduced required set", () => {
  // The rule the configurable set exists for: this college asks for two documents, so
  // an applicant who supplied two is complete even though eight types exist.
  const config = merge({ requiredDocTypes: ["passport", "cv"] });
  const out = buildStats({
    rows: [row({ documents: [{ docType: "passport" }, { docType: "cv" }] })],
    config,
  });
  assert.equal(stage(out, "documentsComplete").count, 1);
});

test("an interview counts only when the ISM records a date", () => {
  // An Ism row is created when somebody opens the form. Counting the row rather than
  // the date reports interviews that were scheduled and never held.
  const out = build([
    row({ isms: [{ interviewDate: "2026-03-01" }] }),
    row({ isms: [{ interviewDate: null }] }),
    row({ isms: [] }),
  ]);
  assert.equal(stage(out, "interviewed").count, 1);
});

test("an offer counts from either the timestamp or the status", () => {
  const out = build([
    row({ offerSentAt: new Date("2026-04-01") }),
    row({ offerStatus: "sent" }),
    row({ offerStatus: "accepted" }),
    row(),
  ]);
  assert.equal(stage(out, "offersSent").count, 3);
});

test("only an accepted offer counts as accepted", () => {
  const out = build([row({ offerStatus: "accepted" }), row({ offerStatus: "sent" })]);
  assert.equal(stage(out, "offersAccepted").count, 1);
});

test("enrolled counts the Enroll decision, not a rejection", () => {
  const out = build([row({ enrollStatus: "Enroll" }), row({ enrollStatus: "Rejected" })]);
  assert.equal(stage(out, "enrolled").count, 1);
});

/* -------------------------------------------------------------------------- */
/* The funnel — monotonicity. The subtlest rule in the feature.               */
/* -------------------------------------------------------------------------- */

test("reaching a later stage implies every earlier one", () => {
  // A student enrolled with no recorded ISM and no offer letter is ordinary: staff
  // enrol from a paper decision and tidy the record later, or never. Counted
  // independently, stage 7 would read 1 while stages 3-6 read 0 — an INVERTED funnel,
  // which on screen reads as a rendering fault rather than as the missing paperwork
  // it actually is.
  const out = build([row({ enrollStatus: "Enroll" })]);
  for (const s of out.funnel) {
    assert.equal(s.count, 1, `stage ${s.key} should be implied by enrolment`);
  }
});

test("the funnel never widens as it descends", () => {
  const out = build([
    row({ enrollStatus: "Enroll" }),
    row({ offerStatus: "sent" }),
    row({ applicationSubmittedAt: new Date("2026-02-01") }),
    row(),
  ]);
  const counts = out.funnel.map((s) => s.count);
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i] <= counts[i - 1], `stage ${i} (${counts[i]}) exceeds stage ${i - 1} (${counts[i - 1]})`);
  }
});

test("conversion between stages is a percentage of the stage above", () => {
  const out = build([
    row({ applicationSubmittedAt: new Date("2026-02-01") }),
    row({ applicationSubmittedAt: new Date("2026-02-01") }),
    row(),
    row(),
  ]);
  assert.equal(stage(out, "applications").conversionFromPrevious, 50);
});

test("conversion is null, not zero, when the stage above is empty", () => {
  assert.equal(stage(build([]), "applications").conversionFromPrevious, null);
});

test("the first stage has no conversion to report", () => {
  assert.equal(stage(build([row()]), "enquiries").conversionFromPrevious, null);
});

/* -------------------------------------------------------------------------- */
/* Rates — null is not zero                                                    */
/* -------------------------------------------------------------------------- */

test("admit rate is offers sent over applications", () => {
  const rows = [
    row({ applicationSubmittedAt: new Date("2026-02-01"), offerStatus: "sent" }),
    row({ applicationSubmittedAt: new Date("2026-02-01") }),
  ];
  assert.equal(build(rows).kpis.admitRate.value, 50);
});

test("admit rate is null when nobody has applied", () => {
  // 0% would sort this intake to the bottom of a comparison it is not in. Nobody has
  // been refused; nobody has asked.
  assert.equal(build([row()]).kpis.admitRate.value, null);
});

test("yield rate is enrolled over offers sent", () => {
  const rows = [
    row({ offerStatus: "sent", enrollStatus: "Enroll" }),
    row({ offerStatus: "sent" }),
    row({ offerStatus: "sent" }),
    row({ offerStatus: "sent" }),
  ];
  assert.equal(build(rows).kpis.yieldRate.value, 25);
});

test("yield rate is null when no offer has gone out", () => {
  assert.equal(build([row()]).kpis.yieldRate.value, null);
});

test("overall conversion is enrolled over enquiries", () => {
  const rows = [row({ enrollStatus: "Enroll" }), row(), row(), row()];
  assert.equal(build(rows).overallConversion, 25);
});

/* -------------------------------------------------------------------------- */
/* Comparison against a previous period                                        */
/* -------------------------------------------------------------------------- */

test("no comparison period means no previous figure and no change", () => {
  // Not a +100% chip. There is nothing to compare against, and inventing a rise is
  // how a first-ever intake gets reported as a triumph.
  const k = build([row(), row()]).kpis.enquiries;
  assert.equal(k.previous, null);
  assert.equal(k.changePct, null);
});

test("a count change is reported as a percentage", () => {
  const out = build([row(), row(), row()], { compareRows: [row(), row()] });
  assert.equal(out.kpis.enquiries.previous, 2);
  assert.equal(out.kpis.enquiries.changePct, 50);
});

test("a count change is null when the previous period was empty", () => {
  // Growth from zero has no percentage. Reporting one requires dividing by it.
  const out = build([row()], { compareRows: [] });
  assert.equal(out.kpis.enquiries.changePct, null);
});

test("a rate change is reported in percentage points, not percent", () => {
  // 20% -> 30% is +10pp. Calling it +50% is the classic rate-of-a-rate error, and it
  // is what the mockup's "-2.3pp" chip is guarding against.
  const now = [
    row({ applicationSubmittedAt: new Date("2026-02-01"), offerStatus: "sent" }),
    ...Array.from({ length: 9 }, () => row({ applicationSubmittedAt: new Date("2026-02-01") })),
  ];
  const before = [
    ...Array.from({ length: 20 }, () => row({ applicationSubmittedAt: new Date("2025-02-01") })),
  ];
  const out = buildStats({ rows: now, compareRows: before, config: CONFIG });
  assert.equal(out.kpis.admitRate.value, 10);
  assert.equal(out.kpis.admitRate.previous, 0);
  assert.equal(out.kpis.admitRate.changePp, 10);
});

test("a rate change is null when the previous rate was unmeasurable", () => {
  const out = build([row({ applicationSubmittedAt: new Date("2026-02-01") })], { compareRows: [row()] });
  assert.equal(out.kpis.admitRate.previous, null);
  assert.equal(out.kpis.admitRate.changePp, null);
});

/* -------------------------------------------------------------------------- */
/* Revenue — an unset fee is not measurable, never zero                        */
/* -------------------------------------------------------------------------- */

const FEES = { "HND Business": 925000, "HND Computing": 800000 };

test("revenue is the fee times the enrolments, per course", () => {
  const rows = [
    row({ course: "HND Business", enrollStatus: "Enroll" }),
    row({ course: "HND Business", enrollStatus: "Enroll" }),
    row({ course: "HND Computing", enrollStatus: "Enroll" }),
  ];
  assert.equal(buildStats({ rows, config: CONFIG, courseFees: FEES }).kpis.revenue.pence, 925000 * 2 + 800000);
});

test("an applicant who has not enrolled contributes no revenue", () => {
  const rows = [row({ course: "HND Business", offerStatus: "sent" })];
  assert.equal(buildStats({ rows, config: CONFIG, courseFees: FEES }).kpis.revenue.pence, 0);
});

test("a course with no fee set is excluded and reported as uncovered", () => {
  // Not counted as £0. The tile has to be able to say "estimated from 1 of 2 courses",
  // because an unset fee read as zero under-reports revenue on an executive screen
  // with nothing on it to indicate the gap.
  const rows = [
    row({ course: "HND Business", enrollStatus: "Enroll" }),
    row({ course: "HND Art", enrollStatus: "Enroll" }),
  ];
  const r = buildStats({ rows, config: CONFIG, courseFees: FEES }).kpis.revenue;
  assert.equal(r.pence, 925000);
  assert.equal(r.coveredEnrolments, 1);
  assert.equal(r.totalEnrolments, 2);
});

test("revenue is null when no enrolled course has a fee at all", () => {
  // Zero would read as "this intake earned nothing", which is a finding. "We cannot
  // tell you" is the truth.
  const rows = [row({ course: "HND Art", enrollStatus: "Enroll" })];
  const r = buildStats({ rows, config: CONFIG, courseFees: {} }).kpis.revenue;
  assert.equal(r.pence, null);
  assert.equal(r.coveredEnrolments, 0);
});

/* -------------------------------------------------------------------------- */
/* Sources                                                                     */
/* -------------------------------------------------------------------------- */

test("applications are grouped by how the applicant found the college", () => {
  const rows = [row({ foundVia: "Agent" }), row({ foundVia: "Agent" }), row({ foundVia: "Friend" })];
  assert.deepEqual(build(rows).sources, [
    { source: "Agent", count: 2, pct: 66.7 },
    { source: "Friend", count: 1, pct: 33.3 },
  ]);
});

test("a missing source is kept as Not recorded rather than dropped", () => {
  // Admin-entered rows often have no foundVia. Dropping them makes the percentages
  // add up over a population smaller than the one on the tile above.
  const rows = [row({ foundVia: "Agent" }), row({ foundVia: null }), row({ foundVia: "  " })];
  const notRecorded = build(rows).sources.find((s) => s.source === "Not recorded");
  assert.equal(notRecorded.count, 2);
});

/* -------------------------------------------------------------------------- */
/* Geography                                                                   */
/* -------------------------------------------------------------------------- */

test("UK citizenship is recognised through its common spellings", () => {
  const rows = ["United Kingdom", "UK", "British", "england", "  Great Britain "]
    .map((c) => row({ countryOfCitizenship: c }));
  assert.equal(build(rows).geography.citizenship.uk, 5);
});

test("EU citizenship is counted separately from the rest of the world", () => {
  const rows = [
    row({ countryOfCitizenship: "Poland" }),
    row({ countryOfCitizenship: "Romania" }),
    row({ countryOfCitizenship: "India" }),
  ];
  const c = build(rows).geography.citizenship;
  assert.equal(c.eu, 2);
  assert.equal(c.other, 1);
});

test("a missing citizenship is Not recorded, not rest of world", () => {
  const c = build([row({ countryOfCitizenship: null })]).geography.citizenship;
  assert.equal(c.notRecorded, 1);
  assert.equal(c.other, 0);
});

test("top countries merge spellings that differ only by case or spacing", () => {
  const rows = [
    row({ countryOfCitizenship: "india" }),
    row({ countryOfCitizenship: "India" }),
    row({ countryOfCitizenship: " INDIA " }),
  ];
  const top = build(rows).geography.topCountries;
  assert.equal(top[0].count, 3);
  assert.equal(top[0].country, "India");
});

test("regions come from the postcode, with unreadable ones kept as Unknown", () => {
  const rows = [row({ postCode: "B1 1AA" }), row({ postCode: "N/A" })];
  const regions = build(rows).geography.regions;
  assert.deepEqual(regions, [
    { region: "West Midlands", count: 1 },
    { region: "Unknown", count: 1 },
  ]);
});

/* -------------------------------------------------------------------------- */
/* Trend                                                                       */
/* -------------------------------------------------------------------------- */

test("the trend series buckets activity by month", () => {
  const rows = [
    row({ createdAt: new Date("2026-01-10T00:00:00Z") }),
    row({ createdAt: new Date("2026-01-20T00:00:00Z") }),
    row({ createdAt: new Date("2026-02-05T00:00:00Z") }),
  ];
  const t = build(rows).trend;
  assert.equal(t[0].period, "2026-01");
  assert.equal(t[0].enquiries, 2);
  assert.equal(t[1].period, "2026-02");
  assert.equal(t[1].enquiries, 1);
});

test("months with no activity are present so the line does not lie about its shape", () => {
  // Plotting only the months that have data draws January straight to April as though
  // the intervening months were a smooth slope rather than a hole.
  const rows = [
    row({ createdAt: new Date("2026-01-10T00:00:00Z") }),
    row({ createdAt: new Date("2026-04-10T00:00:00Z") }),
  ];
  assert.deepEqual(build(rows).trend.map((p) => p.period), ["2026-01", "2026-02", "2026-03", "2026-04"]);
  assert.equal(build(rows).trend[1].enquiries, 0);
});

test("an enrolment is plotted in the month it was decided, not the month enquired", () => {
  const rows = [row({
    createdAt: new Date("2026-01-10T00:00:00Z"),
    offerSentAt: new Date("2026-03-02T00:00:00Z"),
    offerStatus: "accepted",
    enrollStatus: "Enroll",
  })];
  const t = build(rows).trend;
  assert.equal(t.find((p) => p.period === "2026-01").offers, 0);
  assert.equal(t.find((p) => p.period === "2026-03").offers, 1);
});

test("the trend is empty rather than throwing when nothing is in scope", () => {
  assert.deepEqual(build([]).trend, []);
});

/* -------------------------------------------------------------------------- */
/* Yield by course                                                             */
/* -------------------------------------------------------------------------- */

test("yield is broken down per course", () => {
  const rows = [
    row({ course: "HND Business", offerStatus: "sent", enrollStatus: "Enroll" }),
    row({ course: "HND Business", offerStatus: "sent" }),
    row({ course: "HND Computing", offerStatus: "sent", enrollStatus: "Enroll" }),
  ];
  const by = build(rows).yieldByCourse;
  assert.equal(by.find((c) => c.course === "HND Business").yieldRate, 50);
  assert.equal(by.find((c) => c.course === "HND Computing").yieldRate, 100);
});

test("a course with no offers yet has an unmeasurable yield, not zero", () => {
  const rows = [row({ course: "HND Art" })];
  assert.equal(build(rows).yieldByCourse.find((c) => c.course === "HND Art").yieldRate, null);
});

/* -------------------------------------------------------------------------- */
/* Targets                                                                     */
/* -------------------------------------------------------------------------- */

test("an actual is measured against the configured target", () => {
  const config = merge({ targets: { default: { applications: 4 } } });
  const rows = Array.from({ length: 3 }, () => row({ applicationSubmittedAt: new Date("2026-02-01") }));
  const t = buildStats({ rows, config }).targets.find((x) => x.key === "applications");
  assert.equal(t.actual, 3);
  assert.equal(t.target, 4);
  assert.equal(t.variancePct, -25);
});

test("a metric with no target set reports no variance rather than a zero target", () => {
  const t = build([row()]).targets.find((x) => x.key === "applications");
  assert.equal(t.target, null);
  assert.equal(t.variancePct, null);
});

test("targets follow the selected intake", () => {
  const config = merge({
    targets: { default: { enrolled: 100 }, byIntake: { "September 2026": { enrolled: 250 } } },
  });
  const t = buildStats({ rows: [], config, intake: "September 2026" }).targets.find((x) => x.key === "enrolled");
  assert.equal(t.target, 250);
});

/* -------------------------------------------------------------------------- */
/* Nothing personal leaves this module                                         */
/* -------------------------------------------------------------------------- */

test("the output carries no applicant identifier or personal field", () => {
  // The structural guarantee behind the separate permission. Asserted on the whole
  // serialised object, so a field added to any nested panel later is caught here and
  // not by somebody reading a network tab.
  const rows = [row({
    id: "adm_secret_id",
    postCode: "B1 1AA",
    countryOfCitizenship: "United Kingdom",
  })];
  const json = JSON.stringify(buildStats({ rows, config: CONFIG, courseFees: FEES }));
  assert.equal(json.includes("adm_secret_id"), false);
  assert.equal(json.includes("B1 1AA"), false, "a postcode must be bucketed and dropped");
});
