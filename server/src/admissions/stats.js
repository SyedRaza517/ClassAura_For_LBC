// The Admission Tracker's aggregation: rows in, dashboard out.
//
// PURE. No Prisma, no Express, no host clock. The route selects columns and calls
// buildStats; everything a college would query about its own funnel is decided here
// and tested in milliseconds against hand-built fixtures.
//
// THIS MATTERS MORE HERE THAN ELSEWHERE IN THIS CODEBASE. There is no client-side test
// framework at all — StaffHub.jsx is verified only by building — so a rule left in JSX
// is a rule nothing checks. Every funnel definition, every rate, and every null-versus-
// zero decision therefore lives on this side of the boundary.
//
// NOTHING PERSONAL LEAVES THIS MODULE. It reads postcodes and citizenship to bucket
// them and returns counts against bucket names; no id, name, email or address appears
// in the output. That is the structural reason the tracker can have its own permission,
// separate from the "admissions" grant that opens passport and NI numbers, and a test
// asserts it on the whole serialised object rather than field by field.
const { ZONE } = require("../clock");
const { countByRegion } = require("./postcodeRegions");
const { targetsFor } = require("./trackerSettings");

/* -------------------------------------------------------------------------- */
/* Small arithmetic shared by every panel                                      */
/* -------------------------------------------------------------------------- */

// One decimal place, which is as much precision as any of these figures deserve.
const r1 = (n) => Math.round(n * 10) / 10;

// A percentage, or NULL when the denominator is zero.
//
// The single most repeated rule in this codebase, and the reason it is a helper rather
// than an inline division: an intake with no offers yet has an UNMEASURABLE yield rate.
// Reported as 0% it sorts to the bottom of a comparison it is not in, and reads as
// "nobody accepted" when the truth is "nobody has been asked".
const pct = (num, den) => (den > 0 ? r1((num / den) * 100) : null);

// Period-on-period change for a COUNT, as a percentage. Null when the previous period
// was empty: growth from zero has no percentage, and producing one means dividing by it.
const changePct = (now, prev) => (prev == null || prev === 0 ? null : r1(((now - prev) / prev) * 100));

// Period-on-period change for a RATE, in PERCENTAGE POINTS.
//
// A yield going 20% → 30% is +10pp, not +50%. Expressing a change in a rate as a
// percentage of that rate is the classic rate-of-a-rate error; it makes small
// movements at low rates look enormous, and it is exactly what the "pp" suffix on the
// dashboard's chips exists to signal.
const changePp = (now, prev) => (now == null || prev == null ? null : r1(now - prev));

// The month a timestamp falls in, as YYYY-MM, in the ORGANISATION's zone rather than
// the server's. Render runs in UTC; an enquiry at 00:30 BST on 1 September is 23:30 UTC
// on 31 August, and bucketing in UTC files it under the wrong month — and under the
// previous INTAKE, at the one moment of the year the distinction is most looked at.
// "en-CA" formats in ISO order, the same trick clock.js uses.
const monthKey = (d, zone) => {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-CA", { timeZone: zone }).slice(0, 7);
};

/* -------------------------------------------------------------------------- */
/* The funnel                                                                  */
/* -------------------------------------------------------------------------- */

// Each stage's OWN rule — "does this row, on its own evidence, show this happened".
// The stage a row is counted at is not decided here; see reachedMatrix below.
const STAGES = [
  {
    key: "enquiries",
    label: "Enquiries",
    own: () => true,
  },
  {
    key: "applications",
    label: "Applications",
    // source:"apply" rows are CREATED BY the act of submitting the public form, so they
    // never carry a separate applicationSubmittedAt. Requiring the timestamp reports a
    // college that recruits through its own website as having almost no applications.
    own: (r) => !!r.applicationSubmittedAt || r.source === "apply",
  },
  {
    key: "documentsComplete",
    label: "Documents complete",
    own: (r, required) => {
      const have = new Set((r.documents || []).map((d) => d.docType));
      return required.every((k) => have.has(k));
    },
  },
  {
    key: "interviewed",
    label: "Interviewed",
    // The DATE, not the row. An Ism row exists as soon as somebody opens the form;
    // counting rows reports interviews that were scheduled and never held.
    own: (r) => (r.isms || []).some((i) => !!i.interviewDate),
  },
  {
    key: "offersSent",
    label: "Offers sent",
    // Either half is enough. offerSentAt is written by the send path, offerStatus by
    // the applicant accepting; a row can legitimately carry one without the other.
    own: (r) => !!r.offerSentAt || r.offerStatus === "sent" || r.offerStatus === "accepted",
  },
  {
    key: "offersAccepted",
    label: "Offers accepted",
    own: (r) => r.offerStatus === "accepted",
  },
  {
    key: "enrolled",
    label: "Enrolled",
    own: (r) => r.enrollStatus === "Enroll",
  },
];

/**
 * For each row, which stages it has reached — with EVERY STAGE IMPLIED BY EACH LATER
 * ONE.
 *
 * This is the subtlest rule in the feature. A student enrolled with no recorded ISM and
 * no offer letter on file is ordinary: staff enrol from a decision taken in a room and
 * tidy the record later, or never. Counted on their own rules, stage 7 reads 1 while
 * stages 4-6 read 0, and the funnel WIDENS as it descends — which on screen reads as a
 * rendering fault rather than as the missing paperwork it actually is, and sends
 * somebody looking for a bug in the chart.
 *
 * Walking backwards is what makes it cheap: a row that reached stage N reached N-1.
 */
function reachedMatrix(rows, required) {
  return rows.map((row) => {
    const reached = new Array(STAGES.length).fill(false);
    for (let i = STAGES.length - 1; i >= 0; i--) {
      reached[i] = STAGES[i].own(row, required) || (i < STAGES.length - 1 && reached[i + 1]);
    }
    return reached;
  });
}

const stageCounts = (matrix) =>
  STAGES.map((_, i) => matrix.reduce((a, reached) => a + (reached[i] ? 1 : 0), 0));

/**
 * How many rows own each stage ON THEIR OWN RULE, with nothing implied by a later one.
 *
 * WHY BOTH NUMBERS ARE NEEDED, AND WHY NEITHER IS WRONG
 *
 * reachedMatrix above implies every earlier stage from a later one, and the comment
 * there is right about why: without it the funnel widens as it descends and reads as a
 * broken chart. For a MILESTONE that rule also repairs the record — somebody enrolled
 * was certainly offered a place, whether or not anyone filed the letter.
 *
 * "Documents complete" is not a milestone. It is a CURRENT STATE, and implying it from
 * enrolment asserts something measurably false: this college has 40 enrolled students
 * and 10 who hold all ten required documents. The funnel therefore reported 55 and
 * printed "94.8%" beside it, where the true figure is 10 of 62 — and a registrar
 * reading that stage concluded collection was finished while 52 files were incomplete.
 *
 * Removing the implication was the obvious fix and is the wrong one: it breaks
 * monotonicity, fails both the unit test and the smoke suite that pin it, and restores
 * exactly the broken-looking chart the rule exists to prevent.
 *
 * So the funnel keeps its shape and gains the truth beside it. `count` stays the
 * reached figure the chart is drawn from; `ownCount` is what is actually true of the
 * records right now. A caller rendering a stage whose meaning is a state — documents —
 * should show ownCount, and the two being equal for every milestone stage is a useful
 * signal in itself that the paperwork is complete.
 */
const stageOwnCounts = (rows, required) =>
  STAGES.map((s) => rows.reduce((a, r) => a + (s.own(r, required) ? 1 : 0), 0));

/* -------------------------------------------------------------------------- */
/* Geography                                                                   */
/* -------------------------------------------------------------------------- */

// countryOfCitizenship is FREE TEXT on the application form — not a dropdown — so the
// same nationality arrives a dozen ways. These are the spellings that actually turn up.
const UK_ALIASES = new Set([
  "uk", "u.k.", "u.k", "gb", "gbr", "united kingdom", "united kingdom of great britain and northern ireland",
  "great britain", "britain", "british", "england", "english", "scotland", "scottish",
  "wales", "welsh", "northern ireland", "northern irish",
]);

// The 27 member states, plus the aliases people write instead of the formal name.
// Ireland is EU; Northern Ireland is UK, and the two are one keystroke apart, which is
// why both lists are explicit rather than one being "whatever is left over".
const EU_ALIASES = new Set([
  "austria", "belgium", "bulgaria", "croatia", "cyprus", "czechia", "czech republic",
  "denmark", "estonia", "finland", "france", "germany", "greece", "hungary",
  "ireland", "republic of ireland", "irish", "italy", "latvia", "lithuania", "luxembourg",
  "malta", "netherlands", "the netherlands", "holland", "poland", "portugal", "romania",
  "slovakia", "slovenia", "spain", "sweden",
]);

// How a country is LABELLED on the chart. Recognised UK spellings collapse to one name
// so "UK", "British" and "england" are one bar rather than three; everything else keeps
// what the applicant wrote, normalised for case and spacing so "india", "India" and
// " INDIA " merge. Short all-caps strings (USA, UAE) keep their capitals — title-casing
// them produces "Usa", which looks like a typo the college made.
const displayCountry = (raw) => {
  const t = String(raw).trim().replace(/\s+/g, " ");
  if (UK_ALIASES.has(t.toLowerCase())) return "United Kingdom";
  if (t.length <= 3 && t === t.toUpperCase()) return t;
  return t.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\B\w/g, (c) => c.toLowerCase());
};

function geography(rows) {
  const citizenship = { uk: 0, eu: 0, other: 0, notRecorded: 0 };
  const countries = new Map();

  for (const r of rows) {
    const raw = typeof r.countryOfCitizenship === "string" ? r.countryOfCitizenship.trim() : "";
    if (!raw) {
      // NOT "rest of world". A blank field is a question nobody answered, and filing it
      // under an answer is the same mistake as scoring an unmeasured attendance as 0.
      citizenship.notRecorded++;
      continue;
    }
    const key = raw.toLowerCase().replace(/\s+/g, " ");
    if (UK_ALIASES.has(key)) citizenship.uk++;
    else if (EU_ALIASES.has(key)) citizenship.eu++;
    else citizenship.other++;

    const label = displayCountry(raw);
    countries.set(label, (countries.get(label) || 0) + 1);
  }

  const topCountries = [...countries.entries()]
    .map(([country, count]) => ({ country, count }))
    // Ties break on name so refetching the same data cannot reshuffle the bars.
    .sort((a, b) => b.count - a.count || a.country.localeCompare(b.country));

  return { citizenship, topCountries, regions: countByRegion(rows.map((r) => r.postCode)) };
}

/* -------------------------------------------------------------------------- */
/* Revenue — the swap point for real finance data                              */
/* -------------------------------------------------------------------------- */

/**
 * Estimated revenue from enrolments, in pence.
 *
 * THIS IS THE PLACEHOLDER, AND THIS FUNCTION IS THE ONLY PLACE TO REPLACE. The figure
 * is enrolments × the fee an administrator typed against each course, which is an
 * estimate and nothing more; when SLC is developed and real funding amounts exist, the
 * whole tile changes by rewriting this one function rather than by hunting through
 * panels. Keep it that way.
 *
 * A COURSE WITH NO FEE SET IS EXCLUDED, NOT COUNTED AS ZERO. Null means "this college
 * has not told us what this course costs"; treating it as free under-reports revenue on
 * an executive screen with nothing on it to indicate the gap. The coverage counts come
 * back alongside so the tile can say "estimated from 4 of 6 courses" — and the whole
 * figure is null, not 0, when NO enrolled course has a fee, because "we cannot tell you"
 * and "this intake earned nothing" are very different sentences to put in front of a
 * principal.
 */
function estimateRevenue(rows, courseFees) {
  const fees = courseFees || {};
  let pence = 0;
  let coveredEnrolments = 0;
  let totalEnrolments = 0;

  for (const r of rows) {
    if (r.enrollStatus !== "Enroll") continue;
    totalEnrolments++;
    const fee = fees[r.course];
    if (typeof fee !== "number" || !Number.isFinite(fee)) continue;
    pence += fee;
    coveredEnrolments++;
  }

  // THREE OUTCOMES, AND THE MIDDLE ONE IS THE POINT.
  //   nobody enrolled            → 0. Measurably nothing: the intake has earned no fees
  //                                yet, which is a true and useful thing to show.
  //   enrolled, but no fee known → null. "We cannot tell you", not "nothing".
  //   otherwise                  → the sum over the courses we do have a fee for.
  // Collapsing the first two into one null would blank the tile for every college in
  // September, before anybody has enrolled — reading as broken rather than as early.
  return {
    pence: totalEnrolments === 0 ? 0 : coveredEnrolments > 0 ? pence : null,
    coveredEnrolments,
    totalEnrolments,
  };
}

/* -------------------------------------------------------------------------- */
/* Trend                                                                       */
/* -------------------------------------------------------------------------- */

// Each series and the date that places an event in time. An event with no date is
// omitted from the trend rather than dropped into the month the record was created —
// an offer whose status says "sent" but which carries no offerSentAt cannot be placed,
// and guessing puts a spike in the wrong month.
const TREND_SERIES = [
  { key: "enquiries", at: (r) => r.createdAt },
  { key: "applications", at: (r) => r.applicationSubmittedAt || (r.source === "apply" ? r.createdAt : null) },
  { key: "offers", at: (r) => r.offerSentAt },
  { key: "enrolled", at: (r) => (r.enrollStatus === "Enroll" ? r.enrolEmailSentAt || r.offerAcceptedAt : null) },
];

const nextMonth = (key) => {
  const [y, m] = key.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

function trend(rows, zone) {
  const buckets = new Map();
  const note = (key, series) => {
    if (!key) return;
    if (!buckets.has(key)) buckets.set(key, { enquiries: 0, applications: 0, offers: 0, enrolled: 0 });
    buckets.get(key)[series]++;
  };

  for (const r of rows) {
    for (const s of TREND_SERIES) note(monthKey(s.at(r), zone), s.key);
  }
  if (!buckets.size) return [];

  // GAPS ARE FILLED. Plotting only the months that hold data draws January straight to
  // April as a smooth slope, which reads as steady decline through a period that was
  // actually a hole — the chart inventing a trend out of missing months.
  const keys = [...buckets.keys()].sort();
  const out = [];
  for (let k = keys[0]; k <= keys[keys.length - 1]; k = nextMonth(k)) {
    out.push({ period: k, ...(buckets.get(k) || { enquiries: 0, applications: 0, offers: 0, enrolled: 0 }) });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Sources and per-course yield                                                */
/* -------------------------------------------------------------------------- */

// Admin-entered rows often have no foundVia — it is required on the public form only.
// Kept as a named bucket rather than dropped, so the percentages add up over the same
// population as the tile above them.
const NOT_RECORDED = "Not recorded";

function sources(rows) {
  const counts = new Map();
  for (const r of rows) {
    const v = typeof r.foundVia === "string" ? r.foundVia.trim() : "";
    const key = v || NOT_RECORDED;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const total = rows.length;
  return [...counts.entries()]
    .map(([source, count]) => ({ source, count, pct: pct(count, total) }))
    .sort((a, b) => {
      if (a.source === NOT_RECORDED) return 1;
      if (b.source === NOT_RECORDED) return -1;
      return b.count - a.count || a.source.localeCompare(b.source);
    });
}

function yieldByCourse(rows) {
  const byCourse = new Map();
  for (const r of rows) {
    const course = (typeof r.course === "string" && r.course.trim()) || NOT_RECORDED;
    if (!byCourse.has(course)) byCourse.set(course, { course, applications: 0, offers: 0, enrolled: 0 });
    const c = byCourse.get(course);
    c.applications++;
    // Offers counted the SAME way the funnel counts them — implied by enrolment, not
    // only by the paperwork.
    //
    // This read `offersSent.own(r)` and produced a yield rate ABOVE 100%: one applicant
    // is marked enrolled with no offerSentAt and no offerStatus, so the enrolment landed
    // in the numerator while the offer never reached the denominator. HND Business
    // reported 16 applications, 10 offers and 11 enrolments — 110% — and narrowing the
    // scope amplified it to 200%, because a single row is a larger share of a smaller
    // set. A conversion rate above 100% is not a figure anybody can act on; it just
    // says the panel is wrong.
    //
    // The funnel already resolves this and hides it, by implying the offer from the
    // enrolment. The two panels sat in ONE response disagreeing, which is how the
    // defect stayed visible in the yield table while the funnel looked healthy. Using
    // the same rule makes enrolled <= offers true by construction rather than by luck,
    // and the two panels can no longer contradict each other.
    const ownsOffer = STAGES.find((s) => s.key === "offersSent").own(r);
    const ownsEnrol = STAGES.find((s) => s.key === "enrolled").own(r);
    if (ownsOffer || ownsEnrol) c.offers++;
    if (ownsEnrol) c.enrolled++;
  }
  return [...byCourse.values()]
    // pct, not a bare division: a course with no offers yet has an UNMEASURABLE yield,
    // and 0% would rank it below courses that are genuinely converting badly.
    .map((c) => ({ ...c, yieldRate: pct(c.enrolled, c.offers) }))
    .sort((a, b) => b.applications - a.applications || a.course.localeCompare(b.course));
}

/* -------------------------------------------------------------------------- */
/* Headline figures for one period                                             */
/* -------------------------------------------------------------------------- */

// Everything a period needs in order to be compared with another period. Computed for
// the current scope and, separately, for the comparison scope — one function, so the
// two can never be measured by different rules, which is how a comparison chip comes to
// show a change that is really a definition mismatch.
function periodFigures(rows, required) {
  const counts = stageCounts(reachedMatrix(rows, required));
  const at = (key) => counts[STAGES.findIndex((s) => s.key === key)];
  return {
    counts,
    enquiries: at("enquiries"),
    applications: at("applications"),
    offersSent: at("offersSent"),
    enrolled: at("enrolled"),
    admitRate: pct(at("offersSent"), at("applications")),
    yieldRate: pct(at("enrolled"), at("offersSent")),
  };
}

/* -------------------------------------------------------------------------- */
/* Targets                                                                     */
/* -------------------------------------------------------------------------- */

const TARGET_ROWS = [
  { key: "applications", label: "Applications", unit: "count" },
  { key: "admitRate", label: "Admit rate", unit: "percent" },
  { key: "yieldRate", label: "Yield rate", unit: "percent" },
  { key: "enrolled", label: "Enrolled students", unit: "count" },
  { key: "revenuePence", label: "Revenue (est.)", unit: "currency" },
];

function targets(config, intake, now, revenue) {
  const set = targetsFor(config, intake);
  const actualOf = {
    applications: now.applications,
    admitRate: now.admitRate,
    yieldRate: now.yieldRate,
    enrolled: now.enrolled,
    revenuePence: revenue.pence,
  };
  return TARGET_ROWS.map((t) => {
    const target = set[t.key];
    const actual = actualOf[t.key];
    const measurable = target != null && actual != null;
    return {
      ...t,
      actual,
      target,
      // A rate's distance from its target is in PERCENTAGE POINTS, for the same reason
      // its period-on-period change is. A count's is a percentage of the target.
      variancePct: measurable && t.unit !== "percent" ? changePct(actual, target) : null,
      variancePp: measurable && t.unit === "percent" ? changePp(actual, target) : null,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* The whole dashboard                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Build the Admission Tracker payload.
 *
 * @param rows         Admission rows already filtered to the scope, each carrying its
 *                     `documents` [{docType}] and `isms` [{interviewDate}].
 * @param compareRows  The comparison period's rows, or null/undefined for no comparison.
 * @param config       A merged trackerSettings config.
 * @param courseFees   { [course name]: fee in pence }. A course absent here has no fee set.
 * @param intake       The selected intake label, for per-intake targets. Null = all.
 * @param zone         Timezone for month bucketing; defaults to the organisation's.
 */
function buildStats({ rows = [], compareRows = null, config, courseFees = {}, intake = null, zone = ZONE } = {}) {
  const required = config.requiredDocTypes;
  const now = periodFigures(rows, required);
  // NULL, not an empty-array stand-in. "There is no comparison period" and "the
  // comparison period was empty" produce different chips: no chip at all, versus a
  // change that cannot be divided. Collapsing them loses the distinction.
  const before = compareRows ? periodFigures(compareRows, required) : null;

  const revenue = estimateRevenue(rows, courseFees);
  const beforeRevenue = compareRows ? estimateRevenue(compareRows, courseFees) : null;

  const owned = stageOwnCounts(rows, required);

  const funnel = STAGES.map((s, i) => ({
    key: s.key,
    label: s.label,
    count: now.counts[i],
    // What is true of the records themselves, with nothing implied by a later stage.
    // Equal to `count` on a stage where the paperwork is complete; lower where it is
    // not. See stageOwnCounts for why both are reported rather than one replacing the
    // other — "documents complete" is the stage where the gap is not a filing lag but
    // a fact, and 55-versus-10 is the difference between "collection is finished" and
    // "fifty-two files are incomplete".
    ownCount: owned[i],
    // Null for the first stage (nothing above it) and whenever the stage above is
    // empty — a conversion out of nobody is not 0%, it is unanswerable.
    conversionFromPrevious: i === 0 ? null : pct(now.counts[i], now.counts[i - 1]),
    // The same conversion measured on own-counts. Where the two disagree, the records
    // disagree with the chart, and that is worth being able to see without recomputing
    // it by hand from the raw list.
    ownConversionFromPrevious: i === 0 ? null : pct(owned[i], owned[i - 1]),
  }));

  const count = (key) => ({
    value: now[key],
    previous: before ? before[key] : null,
    changePct: before ? changePct(now[key], before[key]) : null,
  });
  const rate = (key) => ({
    value: now[key],
    previous: before ? before[key] : null,
    changePp: before ? changePp(now[key], before[key]) : null,
  });

  return {
    funnel,
    overallConversion: pct(now.enrolled, now.enquiries),
    kpis: {
      enquiries: count("enquiries"),
      applications: count("applications"),
      admitRate: rate("admitRate"),
      yieldRate: rate("yieldRate"),
      enrolled: count("enrolled"),
      revenue: {
        ...revenue,
        previousPence: beforeRevenue ? beforeRevenue.pence : null,
        changePct: beforeRevenue ? changePct(revenue.pence, beforeRevenue.pence) : null,
      },
    },
    trend: trend(rows, zone),
    sources: sources(rows),
    yieldByCourse: yieldByCourse(rows),
    geography: geography(rows),
    targets: targets(config, intake, now, revenue),
  };
}

/* -------------------------------------------------------------------------- */
/* Which intake is "the previous one"                                          */
/* -------------------------------------------------------------------------- */

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

// Month name → month number, FULL NAMES AND ABBREVIATIONS.
//
// WHY THE ABBREVIATIONS ARE NOT OPTIONAL. This lookup was `MONTHS.indexOf(...)` on full
// names alone, and it made automatic intake comparison permanently dead on a live
// college: its intakes are labelled "Sept 2026" and "Jan 2027", exactly as the admin
// typed them into AdmissionIntake, so intakeOrder returned null for every label,
// previousIntake found nothing to compare against, and every comparison chip on the
// dashboard rendered blank with nothing on screen saying why. The unit tests all used
// "September 2026", so this passed CI for as long as it was broken in production —
// which is the reason the tests below now assert both spellings of the same month.
//
// The college is not going to retype its intake list to suit a parser. A label is a
// free-text field an admin picks for human readers, and "Sept 2026" is how a human
// writes it.
const MONTH_INDEX = (() => {
  const map = new Map();
  MONTHS.forEach((name, i) => {
    map.set(name, i);
    // The three-letter form, which is the abbreviation everyone actually uses and is
    // unambiguous for all twelve months (jan feb mar apr may jun jul aug sep oct nov
    // dec are distinct). Derived rather than listed so a second hand-maintained copy
    // of the month names cannot drift from the first.
    map.set(name.slice(0, 3), i);
  });
  // September is the one month whose common abbreviation is four letters, and it is
  // also the biggest intake in the UK further-education year — the one label this
  // college was most certain to have.
  map.set("sept", 8);
  return map;
})();

// An intake label is a month and a year — "September 2026" — because that is the
// single combined string the admin adds to AdmissionIntake and the applicant picks on
// the form. Sortable as year*12+month.
//
// The optional full stop accepts "Sept. 2026", which is the same abbreviation with
// punctuation and no more ambiguous for it. Nothing looser is attempted on purpose:
// "Autumn 2026", "Q1 2027" and "Rolling" still return null, because a label that
// cannot be placed in time must offer NO comparison rather than a guessed one — see
// previousIntake below for why a wrong comparison is worse than no comparison.
const intakeOrder = (label) => {
  const m = /^\s*([A-Za-z]+)\.?\s+(\d{4})\s*$/.exec(String(label || ""));
  if (!m) return null;
  const month = MONTH_INDEX.get(m[1].toLowerCase());
  return month === undefined ? null : Number(m[2]) * 12 + month;
};

/**
 * The intake immediately before `current`, or null when there is none.
 *
 * CHRONOLOGY COMES FROM THE LABEL, NOT FROM AdmissionIntake.sortOrder. sortOrder is
 * wherever an admin dragged the row, and a list kept newest-first — an entirely
 * reasonable way to keep it, since the current intake is the one being worked — would
 * make "previous" mean "next" for every comparison on the dashboard. That is a silent
 * sign flip on every trend chip: a rise reported as a fall, with nothing on screen to
 * suggest anything is wrong.
 *
 * A label that is not a month and a year cannot be placed in time (a college may type
 * "Rolling"), so it is ignored rather than ordered arbitrarily. Offering no comparison
 * is better than comparing against the wrong intake.
 */
function previousIntake(labels, current) {
  const here = intakeOrder(current);
  if (here == null) return null;
  let best = null;
  let bestOrder = -Infinity;
  for (const label of labels || []) {
    const o = intakeOrder(label);
    if (o == null || o >= here) continue;
    if (o > bestOrder) { bestOrder = o; best = label; }
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/* What a URL is allowed to ask for                                            */
/*                                                                             */
/* WHY THIS IS IN stats.js AND NOT IN THE ROUTE. Same reason previousIntake is  */
/* here: the route cannot be unit-tested without Prisma and Express, so logic   */
/* left in it is logic nothing checks until a request fails in production — and  */
/* every defect fixed in this section was found that way, as a 500 on a live    */
/* deployment. These functions are pure, take plain objects and strings, and     */
/* the route is left as a thin adapter that turns { error } into a 400.          */
/* -------------------------------------------------------------------------- */

// The longest a filter value may be. A course or intake label is a short human string;
// anything longer is either a mistake or somebody probing, and truncating is enough.
const MAX_PARAM = 200;

// C0 control characters, minus tab/newline/carriage-return, plus DEL.
//
// NUL IS THE ONE THAT MATTERS, AND IT IS WHY THIS EXISTS. Trimming and length-capping a
// parameter is not sanitising it: NUL is not whitespace, so `"\u0000".trim()` is still a
// one-character string, still truthy, and still reached the `where` clause as a real
// filter value — at which point Postgres refuses the byte sequence outright and the
// dashboard answers 500. Confirmed on ?course=%00, ?intake=%00, ?compare=%00 and
// ?course=HND%00Business.
//
// Tab, newline and carriage return are deliberately NOT in this set. Postgres stores
// them happily, so they cannot produce the failure above, and a value that merely has
// one at either end is already fixed by trim(). Refusing them would reject input that
// works today for no gain.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const daysInMonth = (y, m) => (m === 2 && isLeapYear(y) ? 29 : MONTH_LENGTHS[m - 1]);

/**
 * True only for a `YYYY-MM-DD` string naming a day that exists.
 *
 * SHAPE IS NOT VALIDITY, and treating it as validity was two separate bugs.
 * `/^\d{4}-\d{2}-\d{2}$/` accepts 2026-99-99, which became an Invalid Date, reached
 * Prisma and threw — a 500 on a typo. It also accepts 2026-02-30, which was WORSE
 * because it returned 200: `new Date("2026-02-30")` rolls forward to 2 March, so the
 * filter quietly covered two days nobody asked for and no figure on the dashboard
 * looked wrong. A date that does not exist is refused here rather than rolled.
 *
 * THE CALENDAR IS COMPUTED, NOT DELEGATED TO `Date`. Two traps rule `Date` out of the
 * checking as well as the arithmetic: it rolls invalid components silently instead of
 * reporting them (the 2026-02-30 bug), and `Date.UTC(y, ...)` maps years 0-99 onto
 * 1900-1999, so a two-digit year would validate as something else entirely. A leap-year
 * rule is four lines and has none of that behaviour.
 *
 * Year 0 and negative years are refused: there is no year 0 in the proleptic Gregorian
 * calendar Postgres implements, `'0000-01-01'::date` is an out-of-range error there,
 * and ISO 8601 cannot write a negative year in this four-digit form at all.
 */
function isCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const y = Number(value.slice(0, 4));
  const m = Number(value.slice(5, 7));
  const d = Number(value.slice(8, 10));
  if (y < 1 || m < 1 || m > 12 || d < 1) return false;
  return d <= daysInMonth(y, m);
}

// A UTC instant for a validated YYYY-MM-DD, and back again.
//
// setUTCFullYear, not Date.UTC, for the two-digit-year reason above: Date.UTC(26, 0, 1)
// is 1926, setUTCFullYear(26, 0, 1) is year 26.
//
// The formatter is hand-rolled because toISOString().slice(0, 10) is what caused defect
// 3 below — for a year outside 0001-9999 it emits the ISO extended form
// ("-000998-01-02T…") and slicing that to ten characters yields "-000998-0", a string
// that is neither a date nor rejected until Prisma sees it. Formatting from the
// components cannot produce that, and the floor check in precedingWindow means a year
// outside the four-digit range never reaches it in the first place.
function instantOf(date) {
  const d = new Date(0);
  d.setUTCFullYear(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

const DAY_MS = 86400000;

function dateStringOf(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  return `${String(y).padStart(4, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// The earliest date this module will name. See isCalendarDate for why year 0 does not
// exist; 0001-01-01 is therefore the floor, not an arbitrary limit.
const FIRST_DAY_MS = instantOf("0001-01-01");

/**
 * The window of equal length immediately before [from, to], or null when there is none.
 *
 * THE SAME LENGTH, ENDING THE DAY BEFORE. Comparing a six-week range against a whole
 * previous year is how a dashboard reports a healthy intake as a collapse.
 *
 * NULL WHEN THE PRECEDING WINDOW WOULD FALL OFF THE CALENDAR, and that is the fix for a
 * confirmed 500: ?from=1013-01-01&to=2026-01-01 is a perfectly valid range, but the
 * window before it of the same thousand-year length starts in 998 BC, and the malformed
 * string that came out of toISOString for it (see dateStringOf) failed inside Prisma.
 * The control that isolated it was the identical range with &compare=none returning
 * 200: nothing was wrong with what the user asked for, only with what was derived.
 *
 * CLAMPING THE WINDOW TO 0001-01-01 WAS REJECTED. It would answer 200 with a comparison
 * against a SHORTER period than the one on screen, which is precisely the distortion the
 * equal-length rule exists to prevent, and nothing in the response would say so. Null is
 * a real answer here and the route already knows how to render it — "no comparison
 * period", no chip — because a first-ever intake has the same honest nothing to compare
 * against.
 *
 * An inverted range gets null for the same reason rather than a window computed from a
 * negative span, which would end before it started.
 */
function precedingWindow(from, to) {
  if (!isCalendarDate(from) || !isCalendarDate(to)) return null;
  const start = instantOf(from);
  const end = instantOf(to);
  if (end < start) return null;
  const span = end - start + DAY_MS;
  const prevStart = start - span;
  if (prevStart < FIRST_DAY_MS) return null;
  return { from: dateStringOf(prevStart), to: dateStringOf(start - DAY_MS) };
}

/**
 * The dashboard's query parameters, validated: `{ scope }` or `{ error }`.
 *
 * ONE PLACE, AND IT REFUSES RATHER THAN IGNORING. Every value the route filters on
 * passes through here, so there is no second route-shaped opinion on what a date is.
 *
 * A bad value is refused with a message instead of being dropped, which is a change
 * from the behaviour this replaces: an unparseable `from` used to be silently discarded,
 * and discarding a date filter widens the range to all time while the date box on screen
 * still shows what the user typed. That is the same class of fault as the 2026-02-30
 * roll — a filter that is not the one the user asked for, with nothing saying so — and
 * an admin reading figures off this screen needs to know which it is.
 */
function parseScope(query = {}) {
  const scope = {};
  for (const key of ["intake", "course", "compare", "from", "to"]) {
    const raw = query[key];
    // Only a single string is a value. A repeated parameter (?course=a&course=b) arrives
    // as an array and an unexpected shape arrives as whatever the parser made of it;
    // both are treated as absent rather than coerced into a filter nobody asked for.
    if (typeof raw !== "string") { scope[key] = ""; continue; }
    if (CONTROL_CHARS.test(raw)) {
      return { error: `The ${key} filter contains a control character, which is not text this can search for.` };
    }
    scope[key] = raw.trim().slice(0, MAX_PARAM);
  }

  for (const key of ["from", "to"]) {
    if (scope[key] && !isCalendarDate(scope[key])) {
      return { error: `"${scope[key]}" is not a date on the calendar. Use YYYY-MM-DD — for example 2026-09-01.` };
    }
  }

  // Dates are strings and compare as strings — the convention this codebase holds
  // everywhere — so this needs no parsing to be correct for same-shape dates.
  if (scope.from && scope.to && scope.to < scope.from) {
    return { error: `The range ends before it starts: ${scope.from} to ${scope.to}. Swap the two dates.` };
  }

  return { scope };
}

module.exports = {
  buildStats,
  estimateRevenue,
  previousIntake,
  isCalendarDate,
  precedingWindow,
  parseScope,
  STAGES,
};
