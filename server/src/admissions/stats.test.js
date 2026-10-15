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

const { buildStats, previousIntake, isCalendarDate, precedingWindow, parseScope } = require("./stats");
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

/* -------------------------------------------------------------------------- */
/* Which intake is "the previous one"                                          */
/* -------------------------------------------------------------------------- */

const INTAKES = ["January 2026", "April 2026", "September 2026", "January 2027"];

test("the previous intake is the one chronologically before it", () => {
  assert.equal(previousIntake(INTAKES, "September 2026"), "April 2026");
});

test("the previous intake crosses the year boundary", () => {
  assert.equal(previousIntake(INTAKES, "January 2027"), "September 2026");
});

test("the earliest intake has no previous intake", () => {
  // Not the last one in the list wrapped around. A first-ever intake has nothing to
  // be compared with, and saying so is the honest answer.
  assert.equal(previousIntake(INTAKES, "January 2026"), null);
});

test("chronology comes from the label, not the order the admin listed them in", () => {
  // AdmissionIntake.sortOrder is whatever an admin dragged it to, and a list ordered
  // newest-first would otherwise make "previous" mean "next" for every comparison on
  // the dashboard — a silent sign flip on every trend chip.
  const shuffled = ["January 2027", "January 2026", "September 2026", "April 2026"];
  assert.equal(previousIntake(shuffled, "September 2026"), "April 2026");
});

test("an unknown intake has no previous intake", () => {
  assert.equal(previousIntake(INTAKES, "Michaelmas 2026"), null);
});

test("unparseable labels are ignored rather than ordered arbitrarily", () => {
  // A college can type anything into the intake list. A label that is not a month and
  // a year cannot be placed in time, and guessing puts the wrong intake in the
  // comparison — worse than offering no comparison.
  assert.equal(previousIntake(["Rolling", "April 2026", "September 2026"], "September 2026"), "April 2026");
});

test("no comparison is offered when there is only one intake", () => {
  assert.equal(previousIntake(["September 2026"], "September 2026"), null);
});

/* -------------------------------------------------------------------------- */
/* Own-counts, and a yield rate that cannot exceed 100%                        */
/*                                                                             */
/* Both rules here were written against figures this tracker actually reported */
/* on a live college's data: "documents complete 55 (94.8%)" when ten of       */
/* sixty-two applicants held all ten documents, and a yield rate of 110%.      */
/* -------------------------------------------------------------------------- */

test("a stage reports what the records own, not only what a later stage implies", () => {
  // Enrolled, but holding no documents at all. The funnel implies every earlier stage
  // from the enrolment — correct for a milestone, and the reason `count` reads 1 here.
  // "Documents complete" is a state, not a milestone, and the records say otherwise.
  const out = build([row({ enrollStatus: "Enroll", documents: [] })]);
  const docs = stage(out, "documentsComplete");
  assert.equal(docs.count, 1, "the funnel still implies the stage, keeping the chart monotonic");
  assert.equal(docs.ownCount, 0, "but nobody actually holds the documents");
});

test("own-counts match the reached counts when the paperwork is complete", () => {
  const out = build([row({ enrollStatus: "Enroll", documents: allDocs(), offerSentAt: new Date("2026-03-01"), offerStatus: "accepted", applicationSubmittedAt: new Date("2026-02-01"), isms: [{ interviewDate: "2026-02-20" }] })]);
  for (const s of out.funnel) {
    assert.equal(s.ownCount, s.count, `${s.key}: a complete record should own every stage it reached`);
  }
});

test("yield never exceeds 100% when somebody is enrolled with no offer on file", () => {
  // The exact shape that produced 110%: enrolled, with no offerSentAt and no
  // offerStatus, so the enrolment reached the numerator while the offer never reached
  // the denominator.
  const out = build([
    row({ course: "HND Business", enrollStatus: "Enroll", offerSentAt: null, offerStatus: null }),
    row({ course: "HND Business", enrollStatus: "Enroll", offerSentAt: new Date("2026-03-01"), offerStatus: "accepted" }),
  ]);
  const c = out.yieldByCourse.find((x) => x.course === "HND Business");
  assert.equal(c.offers, 2, "an enrolment is itself evidence an offer was made");
  assert.equal(c.enrolled, 2);
  assert.ok(c.yieldRate <= 100, `yieldRate was ${c.yieldRate}`);
});

test("no course can report a yield above 100% whatever the paperwork says", () => {
  const rows = [];
  for (let i = 0; i < 7; i++) rows.push(row({ course: "HND Leadership", enrollStatus: "Enroll", offerSentAt: null, offerStatus: null }));
  for (let i = 0; i < 3; i++) rows.push(row({ course: "HND Leadership", offerSentAt: new Date("2026-03-01"), offerStatus: "sent" }));
  for (const c of build(rows).yieldByCourse) {
    assert.ok(c.yieldRate == null || c.yieldRate <= 100, `${c.course} reported ${c.yieldRate}`);
    assert.ok(c.enrolled <= c.offers, `${c.course}: ${c.enrolled} enrolled > ${c.offers} offers`);
  }
});

/* -------------------------------------------------------------------------- */
/* What a URL is allowed to ask for                                            */
/*                                                                             */
/* EVERY TEST BELOW IS A REGRESSION TEST FOR A CONFIRMED 500 ON A LIVE         */
/* DEPLOYMENT, reproduced against it before being fixed. They are here, against */
/* the pure functions, rather than in an HTTP suite, because the route cannot   */
/* be unit-tested without Prisma — which is exactly how four faults in it       */
/* survived a green CI run. Each one was re-run with the old code put back to   */
/* confirm it fails; a test that discriminates nothing is worse than no test.   */
/* -------------------------------------------------------------------------- */

test("a well-formed date that exists is accepted", () => {
  // The other half of the guard. A validator that only rejects passes every test in
  // this section while refusing the whole dashboard.
  for (const d of ["2026-01-01", "2026-09-30", "2026-12-31", "0001-01-01", "9999-12-31"]) {
    assert.equal(isCalendarDate(d), true, d + " is a real date and must be accepted");
  }
});

test("a date whose month or day cannot exist is refused, not sent to the database", () => {
  // ?from=2026-99-99 passed the old shape-only regex, became an Invalid Date, reached
  // Prisma and threw. Confirmed 500 on from, on to, and on the pair.
  for (const d of ["2026-99-99", "2026-13-01", "2026-00-01", "2026-01-00", "2026-01-32"]) {
    assert.equal(isCalendarDate(d), false, d + " is not a date and must be refused");
  }
});

test("a date that does not exist is refused rather than rolled forward", () => {
  // The silent half, and the worse half: ?to=2026-02-30 answered 200, because
  // new Date("2026-02-30") rolls to 2 March. The range quietly covered two extra days
  // and nothing on the dashboard looked wrong.
  assert.equal(isCalendarDate("2026-02-30"), false);
  assert.equal(isCalendarDate("2026-04-31"), false);
  assert.equal(isCalendarDate("2026-06-31"), false);
  assert.equal(isCalendarDate("2026-09-31"), false);
  assert.equal(isCalendarDate("2026-11-31"), false);
});

test("a leap day exists in a leap year and not in any other", () => {
  assert.equal(isCalendarDate("2024-02-29"), true, "2024 is a leap year");
  assert.equal(isCalendarDate("2000-02-29"), true, "a century divisible by 400 is a leap year");
  assert.equal(isCalendarDate("2026-02-29"), false, "2026 is not");
  assert.equal(isCalendarDate("1900-02-29"), false, "a century not divisible by 400 is not");
});

test("year zero is refused, because there is no year zero", () => {
  // Not pedantry. Postgres implements the proleptic Gregorian calendar, where
  // '0000-01-01'::date is an out-of-range error — another 500 rather than a refusal.
  assert.equal(isCalendarDate("0000-01-01"), false);
  assert.equal(isCalendarDate("0000-12-31"), false);
});

test("the YYYY-MM-DD shape is still required", () => {
  for (const d of ["2026-1-1", "26-01-01", "2026/01/01", "01-01-2026", "2026-01-01T00:00:00Z", "", "today"]) {
    assert.equal(isCalendarDate(d), false, JSON.stringify(d) + " is not the shape this filter takes");
  }
  assert.equal(isCalendarDate(null), false);
  assert.equal(isCalendarDate(20260101), false);
});

test("an impossible date is a refusal with a reason, not a dropped filter", () => {
  // Refused rather than ignored on purpose. Discarding an unusable `from` widens the
  // range to all time while the date box on screen still shows what the user typed.
  for (const q of [{ from: "2026-99-99" }, { to: "2026-99-99" }, { from: "2026-13-01" },
    { from: "2026-00-01" }, { from: "2026-01-01", to: "2026-99-99" }, { to: "2026-02-30" }]) {
    const out = parseScope(q);
    assert.equal(out.scope, undefined, JSON.stringify(q) + " was accepted");
    assert.match(out.error, /not a date on the calendar/);
    assert.match(out.error, /YYYY-MM-DD/, "the message must say what the right shape is");
  }
});

test("a usable scope comes back trimmed and capped, with no error", () => {
  const out = parseScope({ intake: "  Sept 2026  ", course: "HND Business", from: "2026-01-01", to: "2026-03-31" });
  assert.equal(out.error, undefined);
  assert.deepEqual(out.scope, {
    intake: "Sept 2026", course: "HND Business", compare: "", from: "2026-01-01", to: "2026-03-31",
  });
  assert.equal(parseScope({ course: "x".repeat(500) }).scope.course.length, 200);
});

test("a NUL byte in a filter is refused instead of being searched for", () => {
  // trim() does not remove NUL — it is not whitespace — so "\u0000" stayed a truthy
  // one-character filter value, reached the where clause, and Postgres refused the byte
  // sequence with a 500. Confirmed on course, intake and compare, alone and embedded.
  for (const q of [{ course: "\u0000" }, { intake: "\u0000" }, { compare: "\u0000" },
    { course: "HND\u0000Business" }, { from: "2026-01-01\u0000" }]) {
    const out = parseScope(q);
    assert.equal(out.scope, undefined, JSON.stringify(q) + " was accepted");
    assert.match(out.error, /control character/);
  }
});

test("every control character that Postgres will not store is refused", () => {
  for (const code of [0x00, 0x01, 0x07, 0x08, 0x0b, 0x0c, 0x0e, 0x1b, 0x1f, 0x7f]) {
    const out = parseScope({ course: "HND" + String.fromCharCode(code) });
    assert.equal(out.scope, undefined, "control character 0x" + code.toString(16) + " was accepted");
  }
});

test("tab, newline and carriage return are not refused", () => {
  // Deliberately allowed: Postgres stores them, so they cannot cause the failure above,
  // and trim() already handles the only case that shows up in practice — one stuck on
  // the end of a pasted course name. Refusing them would reject input that works today.
  assert.equal(parseScope({ course: "HND Business\n" }).scope.course, "HND Business");
  assert.equal(parseScope({ course: "HND\tBusiness" }).scope.course, "HND\tBusiness");
});

test("a repeated or non-string parameter is treated as absent, not coerced", () => {
  // ?course=a&course=b arrives as an array. Coercing it would filter on "a,b".
  assert.deepEqual(parseScope({ course: ["a", "b"], from: 20260101 }).scope,
    { intake: "", course: "", compare: "", from: "", to: "" });
  assert.deepEqual(parseScope().scope, { intake: "", course: "", compare: "", from: "", to: "" });
});

test("an inverted range is refused rather than filtering on nothing", () => {
  const out = parseScope({ from: "2026-05-01", to: "2026-01-01" });
  assert.equal(out.scope, undefined);
  assert.match(out.error, /ends before it starts/);
  // A single day is not inverted.
  assert.equal(parseScope({ from: "2026-05-01", to: "2026-05-01" }).error, undefined);
});

/* -------------------------------------------------------------------------- */
/* The comparison window derived from a date range                             */
/* -------------------------------------------------------------------------- */

test("the preceding window is the same length, ending the day before", () => {
  // Equal length is the rule that matters: comparing a six-week range against a whole
  // previous year is how a dashboard reports a healthy intake as a collapse.
  assert.deepEqual(precedingWindow("2026-01-01", "2026-01-31"), { from: "2025-12-01", to: "2025-12-31" });
  assert.deepEqual(precedingWindow("2026-03-01", "2026-03-01"), { from: "2026-02-28", to: "2026-02-28" });
  assert.deepEqual(precedingWindow("2024-03-01", "2024-03-01"), { from: "2024-02-29", to: "2024-02-29" },
    "the day before 1 March 2024 is a leap day");
});

test("no comparison is offered when the preceding window falls off the calendar", () => {
  // THE CONFIRMED 500, and the reason it was hard to see: the range asked for is valid.
  // It was the DERIVED window that broke — a thousand-year range has no thousand-year
  // predecessor, the negative year made toISOString emit the extended form
  // ("-000998-01-02T...") and slicing that to ten characters produced a string that was
  // neither a date nor rejected until Prisma saw it. The control that isolated it was
  // the identical range with compare=none answering 200.
  //
  // Null, not a clamped window: a comparison against a shorter period than the one on
  // screen is the exact distortion the equal-length rule exists to prevent, and the
  // dashboard already renders null as "no comparison period".
  assert.equal(precedingWindow("1013-01-01", "2026-01-01"), null);
  assert.equal(precedingWindow("1000-01-01", "2026-01-01"), null);
  assert.equal(precedingWindow("0001-01-01", "1000-01-01"), null);
  assert.equal(precedingWindow("0001-01-01", "0001-01-02"), null);
});

test("a range with room before it still gets its comparison", () => {
  // The other half: a guard that returns null too eagerly silently removes every
  // comparison chip on the dashboard, which is defect 4 in a different costume.
  const prev = precedingWindow("1100-01-01", "2026-01-01");
  assert.notEqual(prev, null, "this range has 1099 years before it and must be comparable");
  assert.deepEqual(prev, { from: "0173-12-30", to: "1099-12-31" });
});

test("the derived window is always a date string this module would itself accept", () => {
  // The specific shape of the defect: what came out of toISOString().slice(0, 10) was
  // neither a date nor rejected — "-000998-0" — and travelled all the way to Prisma.
  // Asserting the output round-trips through the validator catches that however the
  // derivation is rewritten later.
  //
  // 0500-01-01..2026-01-01 is in this list for a reason: it is a range whose predecessor
  // starts in 1027 BC, so it is the case that produced the malformed string. It must
  // come back as null (no comparison) and never as a ten-character slice of
  // "-001027-01-02T00:00:00.000Z". Without a case like it, this test passes on both the
  // fixed and the broken derivation and therefore discriminates nothing — which was
  // true of it until this line was added.
  for (const [from, to] of [["2026-01-01", "2026-01-31"], ["0001-06-01", "0001-06-02"],
    ["1100-01-01", "2026-01-01"], ["2026-02-28", "2026-03-01"], ["9999-12-30", "9999-12-31"],
    ["0500-01-01", "2026-01-01"]]) {
    const prev = precedingWindow(from, to);
    if (prev === null) continue;
    for (const end of ["from", "to"]) {
      assert.match(prev[end], /^\d{4}-\d{2}-\d{2}$/, from + ".." + to + " derived " + prev[end]);
      assert.equal(isCalendarDate(prev[end]), true, from + ".." + to + " derived " + prev[end]);
    }
    assert.ok(prev.to < from, "the comparison window must end before this one starts");
  }
});

test("an unvalidated or inverted range derives no window at all", () => {
  assert.equal(precedingWindow("2026-99-99", "2026-01-01"), null);
  assert.equal(precedingWindow("2026-02-30", "2026-03-31"), null);
  assert.equal(precedingWindow("", "2026-01-01"), null);
  assert.equal(precedingWindow("2026-05-01", "2026-01-01"), null, "a negative span has no predecessor");
});

/* -------------------------------------------------------------------------- */
/* Abbreviated intake labels                                                   */
/*                                                                             */
/* THE INTAKE TESTS ABOVE ALL USE FULL MONTH NAMES, which is why intake         */
/* comparison could be dead in production while CI stayed green. The live       */
/* college's intakes are "Sept 2026" and "Jan 2027", so intakeOrder returned    */
/* null for every label it was ever given, previousIntake found nothing, and    */
/* every comparison chip rendered blank with nothing on screen saying why.      */
/* -------------------------------------------------------------------------- */

const ABBREVIATED = ["Sept 2026", "Jan 2027"];

test("the previous intake is found for the abbreviations this college actually uses", () => {
  assert.equal(previousIntake(ABBREVIATED, "Jan 2027"), "Sept 2026");
  assert.equal(previousIntake(ABBREVIATED, "Sept 2026"), null, "nothing precedes the earlier of the two");
});

test("every month orders the same abbreviated as it does in full", () => {
  const full = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const abbr = full.map((m) => m.slice(0, 3) + " 2026");
  for (let i = 1; i < full.length; i++) {
    // The same answer from the abbreviated list as from the full one, for every month.
    assert.equal(
      previousIntake(abbr, full[i].slice(0, 3) + " 2026"),
      full[i - 1].slice(0, 3) + " 2026",
      full[i] + " abbreviated did not order correctly",
    );
    assert.equal(
      previousIntake(full.map((m) => m + " 2026"), full[i] + " 2026"),
      full[i - 1] + " 2026",
      full[i] + " in full did not order correctly",
    );
  }
});

test("full and abbreviated labels order against each other in one list", () => {
  // A college that added "September 2026" last year and "Jan 2027" this year has both
  // spellings sitting in AdmissionIntake, and the comparison has to cross between them.
  const mixed = ["September 2026", "Jan 2027", "Apr 2027", "September 2027"];
  assert.equal(previousIntake(mixed, "Jan 2027"), "September 2026");
  assert.equal(previousIntake(mixed, "September 2027"), "Apr 2027");
});

test("September is accepted as Sep, Sept and with a full stop", () => {
  for (const label of ["September 2026", "Sept 2026", "Sep 2026", "sept 2026", "SEPT 2026", "Sept. 2026"]) {
    assert.equal(previousIntake(["Apr 2026", label], label), "Apr 2026", label + " was not placed in time");
  }
});

test("a label that still cannot be placed in time offers no comparison", () => {
  // The abbreviations are a wider gate, not an open one. Guessing puts the wrong intake
  // in the comparison, which is a silent sign flip on every chip — worse than no chip.
  for (const label of ["Autumn 2026", "Q1 2027", "Rolling", "Michaelmas 2026", "2026", "Sept"]) {
    assert.equal(previousIntake(["Apr 2026", "Sept 2026", label], label), null, label + " was ordered anyway");
  }
});
