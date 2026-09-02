# Admission Tracker — design

**Date:** 2026-09-02
**Status:** approved, implementing

An admissions analytics dashboard: a seven-stage funnel, KPI tiles with period-on-period
comparison, a trend chart, source and geography breakdowns, cycle progress, and actuals
measured against configurable targets.

## Why this needed a design rather than a build

The request arrived as a screenshot of a US university's admission dashboard. Three of its
tiles have no data behind them in this platform, and two more mean something different
here:

| Mockup tile | What exists |
|---|---|
| Total Inquiries / Applications | `Admission` rows; `applicationSubmittedAt` separates draft from submitted |
| Complete Applications | `AdmissionDocument` rows |
| Admits | `ismOutcome`, `offerStatus` |
| Enrolled | `enrollStatus = "Enroll"` |
| Applications by Source | `foundVia` — a **required** 5-value dropdown, so no normalisation needed |
| Yield by College/School | one college here, so this is **by course** |
| Revenue (Est.) | **nothing** — no fee or tuition column anywhere. `SlcApplication.amount` is free text and loan applicants only |
| Metrics vs Targets | **nothing** — no targets are stored |
| Geographic (US choropleth) | UK college; `countryOfCitizenship`, `postCode`, `city` |

Copying the mockup literally would have produced a confident, wrong revenue figure and a
map of a country the college does not recruit from.

## Decisions

**Revenue and targets are both built**, with revenue estimated from a configurable
per-course fee. The estimate is a placeholder for real finance data once SLC is developed,
so the whole calculation lives in **one function** (`estimateRevenue`) marked as the swap
point. Replacing it later is one edit, not a hunt.

**A new `admissions-tracker` admin page**, not a tab on the existing Admissions screen. The
existing `admissions` grant opens full applicant records — passport numbers, NI numbers,
addresses, medical declarations. A principal or marketing lead needs the funnel, not four
thousand people's identity documents. The endpoint therefore emits **aggregates only**.

**Seven funnel stages, with the offer as the admit.** Enquiries → Applications → Documents
complete → Interviewed → Offers sent → Offers accepted → Enrolled. Admit rate is offers
sent / applications; yield is enrolled / offers sent. The offer is the college's formal
decision *and it carries a timestamp*, so the rate is measured rather than inferred.
`ismOutcome` was the alternative and was rejected: it is a free-text mirror field staff
often leave blank, so a rate built on it under-reports exactly when record-keeping slips.

**Geography answers two questions, on a toggle**: citizenship (UK / EU / rest of world plus
top countries — the split that drives fee status and visa route) and UK region derived from
the postcode area (the split that drives marketing spend).

**Scoped by intake first, date range second.** A college asks "how is the September intake
going", not "how did 1 Aug to 31 Jul go". The primary filter is the intake, from the
existing `AdmissionIntake` list, with course and an optional creation-date range beside it.
The comparison defaults to the equivalent previous intake.

**Aggregation is a pure function.** `stats.js` takes rows and returns the dashboard object,
with no Prisma and no Express, matching `src/prediction/`. This matters more here than
usual: there is **no client-side test framework at all**, so logic left in JSX is verified
only by the build compiling. The route selects columns and calls the function.

Computing in the browser from `GET /admissions` was rejected outright — it would ship every
applicant's passport and NI number to a browser in order to draw a bar chart, defeating the
separate permission.

## Schema

Two additive changes in one migration. No destructive statements, no unique-constraint
risk.

**`AdmissionCourse.feeAmountPence Int?`** — nullable, and that is load-bearing. A course
with no fee set is *not measurable*, not £0. Its enrolments leave the revenue estimate and
are counted in a coverage figure the tile shows ("estimated from 4 of 6 courses"). An unset
fee read as zero would under-report revenue on an executive screen with nothing to say so.

**`AdmissionTrackerSettings`** — the sixth single-row config table of the shape CLAUDE.md
documents, so it gets both halves: `id String @id @default("singleton")`, written by
**upsert on the literal `"singleton"`**, read by `findFirst`. Find-then-create is not
atomic; two admins saving at once both find nothing, both insert, and the targets a
dashboard measures against become a coin toss between two rows.

One `data Json` column merged over code defaults:

```json
{
  "targets": {
    "default":  { "applications": null, "admitRate": null, "yieldRate": null, "enrolled": null, "revenuePence": null },
    "byIntake": { "September 2026": { "applications": 1200 } }
  },
  "requiredDocTypes": ["photo", "passport", "cv", "address", "ni", "immigration", "personalStatement", "english", "qualifications", "employment"]
}
```

`requiredDocTypes` exists because there are ten document types and **none is marked
optional**. "Documents complete = all ten" would read artificially low — an immigration
share code does not apply to a UK national. Rather than invent a required subset in code
and impose one college's rules on another, the set is configurable and defaults to all ten.

## Server

`GET /api/admission-stats?intake=&course=&from=&to=&compare=`, gated
`requireAuth, requireAnyPage(["admissions-tracker", "admissions"])` — the pattern
`/assessments/exec-summary` already uses, so an admissions officer keeps access to their own
funnel without needing the new grant.

### Funnel rules

| Stage | Rule |
|---|---|
| Enquiries | every `Admission` in scope |
| Applications | `applicationSubmittedAt` set, or `source === "apply"` |
| Documents complete | every type in `requiredDocTypes` present |
| Interviewed | a linked `Ism` with `interviewDate` set |
| Offers sent | `offerSentAt` set, or `offerStatus` ∈ (`sent`, `accepted`) |
| Offers accepted | `offerStatus === "accepted"` |
| Enrolled | `enrollStatus === "Enroll"` |

**Every stage is implied by each later one:** `reached(N) = own rule OR reached(any later
stage)`. Counted independently, a student enrolled without a recorded ISM makes stage 6
exceed stage 4 and draws an *inverted* trapezoid, which reads as a rendering fault rather
than as the missing interview record it is. This is the subtlest rule in the feature and it
gets its own test.

### Null is not zero

A rate whose denominator is zero is `null` — "not measurable" — and renders "—". An intake
with no offers yet has an unmeasurable yield rate; 0% would sort it to the bottom of a
comparison it is not in. The same applies to the comparison: no comparable prior intake
means **no trend chip at all**, never a fabricated +100%.

### Aggregates only

No applicant row, name or identifier leaves this endpoint. Postcodes are read for regioning
and **bucketed and dropped before serialisation**.

## Client

`StaffHub.jsx` is 15,786 lines and this screen is roughly 900 lines of chart and layout
code, so it is extracted, following `AssessmentTracker.jsx`:

- `client/src/AdmissionTracker.jsx` — filters, fetching, loading and error state, layout.
- `client/src/AdmissionTrackerPanels.jsx` — the panels, each a pure function of props.

Four small edits wire it into `StaffHub.jsx`: the import, `ADMIN_PAGES` + `PAGE_LABELS`,
one nav entry, one render line. The nav entry goes **after** "Applications" in the existing
`admissions-interviews` group — `groupNav` anchors a group to its first child, so inserting
after leaves the sidebar order untouched.

| Panel | Built with |
|---|---|
| KPI row (6 tiles) | existing `StatCard`; its `trend` prop already renders the ▲/▼ chip |
| Seven-stage funnel with conversion % | plain divs — recharts' `FunnelChart` cannot place per-stage conversion labels where the design has them, and divs are responsive for free |
| Trend over time, 4 series, Monthly \| Weekly | recharts `LineChart` |
| Applications by source | recharts donut `PieChart` over the five `foundVia` values |
| Admission cycle progress | vertical stepper derived from where the intake stands |
| Key metrics vs targets | table; a metric with no target shows "—", never a 0 target |
| Yield rate by course | recharts horizontal `BarChart` |
| Geography — Country \| UK Region | bar lists; unparseable postcodes get an explicit "Unknown" bucket rather than being dropped |
| Download Report | existing `downloadCSV`, which already guards CSV formula injection |

### Loading discipline

Taken from `ExecutiveDashboard`, which learned each of these the hard way:

- A **`loadSeq` ref** so only the newest request writes state. Switching intake twice
  quickly could otherwise let the first response land last, painting September 2025's
  funnel under September 2026's heading.
- A failed reload **drops** stale data rather than keeping it. The previous intake's numbers
  under the new intake's name is worse than nothing, because it looks right.
- A 403 says figures are *hidden*, not zero.

## Testing

Pure unit tests under `node --test`, no database:

- `stats.test.js` — funnel monotonicity; rates `null` not `0` on a zero denominator; a
  missing comparison producing no chip; doc-completeness honouring a *configured* required
  set; revenue excluding fee-less courses while reporting coverage.
- `postcodeRegions.test.js` — area → region, and unparseable input landing in "Unknown"
  rather than vanishing.

**A text-level contract test.** `schema-contract.test.js` already guards `metrics.js` by
reading it as text and failing if `category` or `detail` appear in a select, because that
rule lives in one place and is exactly what a later reader widens for a screen they are
building. "Aggregates only" has the same shape and gets the same guard: parse
`admissionStats.js` and fail if `firstName`, `surname`, `email`, `niNumber`, `idDocNo` or
`dob` appear in its Prisma select.

**Smoke suite** `scripts/smoke-admission-tracker.mjs`, weighted to negative assertions:

- 403 without the grant.
- **No seeded applicant's name, email or NI number appears anywhere in the response body.**
- Aggregates match the seeded fixtures.
- Saving settings twice leaves one row.

Each test is proved able to fail by reintroducing the bug — specifically the monotonicity
inversion and the personal-data leak.

## Build order

1. Migration + schema
2. `postcodeRegions.js` + tests
3. `stats.js` + tests — the bulk of the logic
4. Route + contract test + smoke suite
5. `AdmissionTrackerPanels.jsx`, then `AdmissionTracker.jsx`
6. `StaffHub.jsx` wiring, client build
7. `STATUS.md`, `API.md`

Server logic is complete and tested before any JSX exists, so the charts render data already
known to be correct.

## Out of scope

Real revenue (waiting on SLC), a settings UI beyond a simple form on the tracker itself, and
any change to the existing Admissions screen.
