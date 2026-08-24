// Timesheets, leave, check-ins and balance adjustments — the payroll surface.
//
// Everything this suite touches ends up in somebody's pay packet or their holiday
// entitlement, which is why the assertions here are almost all negative ones. A 200
// on "create a timesheet entry" proves very little; what matters is that a finance
// admin cannot sign off their OWN hours, that an approved month cannot be quietly
// edited afterwards, that approving a holiday cannot take a member of staff past
// their allowance, and that saving a daily summary for a day somebody never came in
// does not invent a clock-in time for them.
//
//   node scripts/smoke-timesheets.mjs
//   (needs API_URL + DATABASE_URL; the runner supplies both)
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "..", "server");
const require = createRequire(pathToFileURL(join(server, "package.json")));

// API_URL, not API_BASE: the runner exports API_URL and only smoke-branding reads
// anything else. Getting this wrong makes a suite talk to a port nobody is listening
// on and "fail" for reasons that have nothing to do with the code under test.
const BASE = process.env.API_URL || "http://localhost:4000/api";
const SEED_PASSWORD = process.env.SEED_PASSWORD || "test-seed-password-2026";
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required — point it at a throwaway database.");
  process.exit(1);
}

const { PrismaClient } = require(join(server, "node_modules", "@prisma", "client"));
const bcrypt = require(join(server, "node_modules", "bcryptjs"));
// The server's OWN holiday engine. The allowance assertions below are only meaningful
// if they agree with the thing the route actually uses to price a booking, so the
// expected numbers are derived from it rather than copied into this file, where they
// would rot the moment a bank holiday moved.
const { chargeableDays, ukBankHolidays, bankHolidayCount } = require(join(server, "src", "bankHolidays"));
// A BARE client: no tenant extension. Used only to plant a password on a seeded
// student (they ship with passwordHash null, so none of them can sign in), to read
// back a row the API refused to change, and to sweep up afterwards.
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

async function call(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json", "X-Tenant": "default" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch (_) { /* empty body */ }
  return { status: res.status, data };
}

/* ---------- dates, computed and not hard-coded ----------
   The seed is date-relative and so are the rules (you cannot book leave in the past),
   so every date below is derived from today in the organisation's zone. Hard-coded
   dates make a suite that passes this month and mysteriously fails next month. */
const iso = (d) => d.toISOString().slice(0, 10);
const asDate = (s) => new Date(s + "T00:00:00Z");
const TODAY = asDate(new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" }));
const shift = (n) => iso(new Date(TODAY.getTime() + n * 86400000));
const plus = (s, n) => iso(new Date(asDate(s).getTime() + n * 86400000));
const dow = (s) => asDate(s).getUTCDay(); // 0 = Sun … 6 = Sat

// A month far enough from "now" that nothing else lives there. Timesheet entries are
// keyed only by a date string, so the whole timesheet story runs inside one month and
// cleanup is a single deleteMany on the prefix.
const TS_MONTH = shift(120).slice(0, 7);
const TS_DAY_1 = `${TS_MONTH}-13`;
const TS_DAY_2 = `${TS_MONTH}-14`;
// Three past days with no seeded check-ins (the seed only writes today and yesterday).
const CI_SUMMARY_DAY = shift(-90);
const CI_CHECKOUT_DAY = shift(-91);
const CI_BAD_DAY = shift(-92);
const CI_DATES = [CI_SUMMARY_DAY, CI_CHECKOUT_DAY, CI_BAD_DAY];

// The next Monday bank holiday at least a week out. A booking wrapped around it is
// the clearest possible demonstration of the pricing rule: five calendar days away
// from work, two days off the allowance.
// It must also be an ISOLATED bank holiday — the only one inside the Friday-to-Tuesday
// span. Without that condition this quietly became date-dependent: for most of the year
// the next Monday holiday is on its own and the span costs two days, but from late
// August the next one is 28 December, whose span also contains Christmas Day. Two
// holidays in five days costs ONE day, not two, and the assertion below failed on a
// date roll-over with nothing about the product having changed. The rule being
// demonstrated is "weekends and bank holidays are not chargeable"; a span containing
// two of them demonstrates it just as well but not with the number written here.
const BH = (() => {
  const y = TODAY.getUTCFullYear();
  const all = [...ukBankHolidays(y), ...ukBankHolidays(y + 1), ...ukBankHolidays(y + 2)].sort();
  const holidays = new Set(all);
  return all.find((d) => {
    if (!(d > shift(7)) || dow(d) !== 1) return false;
    // Exactly one holiday between the Friday before and the Tuesday after.
    let n = 0;
    for (let i = -3; i <= 1; i++) if (holidays.has(plus(d, i))) n++;
    return n === 1;
  });
})();
const BH_START = plus(BH, -3); // the Friday before
const BH_END = plus(BH, 1);    // the Tuesday after

// A long booking, aligned to a Monday so it is a whole number of working weeks, far
// enough out that it cannot collide with anything else this suite books.
const LONG_START = (() => { let d = shift(200); while (dow(d) !== 1) d = plus(d, 1); return d; })();
const LONG_END = plus(LONG_START, 39); // six working weeks
const LONG_YEAR = LONG_START.slice(0, 4);
const LONG_DAYS = chargeableDays(LONG_START, LONG_END);
// s1 (James Whitfield) is seeded with a 28-day allowance and no approved leave. The
// bank-holiday pot is carved out of the total and is never bookable, so what he can
// actually book is 28 − 8.
const S1_BOOKABLE = 28 - bankHolidayCount(Number(LONG_YEAR));

const RUN = Date.now().toString(36);
const createdLeave = new Set();
const createdAdj = new Set();
const startedAt = new Date();

async function signIn(email) {
  const r = await call("/auth/login", { method: "POST", body: { email, password: SEED_PASSWORD } });
  if (r.status !== 200 || !r.data?.token) throw new Error(`login failed for ${email}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.token;
}

async function cleanup() {
  // Eight suites share one seeded database and the seed is NOT re-run between them,
  // so anything left behind becomes a fixture the next suite never asked for.
  await db.timesheetEntry.deleteMany({ where: { date: { startsWith: TS_MONTH } } });
  if (createdLeave.size) await db.leave.deleteMany({ where: { id: { in: [...createdLeave] } } });
  if (createdAdj.size) await db.adjustment.deleteMany({ where: { id: { in: [...createdAdj] } } });
  await db.checkIn.deleteMany({ where: { date: { in: CI_DATES } } });
  // The notifications our submissions and decisions fired. Scoped by time so a row an
  // earlier suite created in the same run is left where it is.
  await db.notification.deleteMany({ where: { createdAt: { gte: startedAt } } });
  // Put the borrowed student account back exactly as the seed left it: unable to sign in.
  await db.student.updateMany({ where: { id: "st-100121" }, data: { passwordHash: null } });
}

try {
  await cleanup();

  const admin = await signIn("admin@edtech.co.uk");   // HR Administrator, ADMIN, adminPages null
  const s1 = await signIn("j.whitfield@edtech.co.uk"); // James Whitfield, STAFF, allowance 28
  const s2 = await signIn("a.rahman@edtech.co.uk");    // Aisha Rahman, STAFF

  /* ==================== TIMESHEETS ==================== */
  console.log("\n--- timesheets: an entry is priced once, at the door ---");
  const mk = (over = {}) => ({ date: TS_DAY_1, start: "09:00", end: "11:30", mode: "campus", title: `Y12 Maths ${RUN}`, ...over });

  const created = await call("/timesheets", { method: "POST", token: s1, body: mk() });
  // minutes is DERIVED server-side and stored, because daily and monthly totals are
  // aggregated in the database. If the client could send its own minutes, a two-hour
  // session could be filed as eight and no total anywhere would contradict it.
  check("staff create a draft entry and the minutes are derived server-side",
    created.status === 201 && created.data?.minutes === 150 && created.data?.hours === 2.5 && created.data?.status === "draft",
    `HTTP ${created.status} minutes=${created.data?.minutes} status=${created.data?.status}`);
  const entryId = created.data?.id;

  const backwards = await call("/timesheets", { method: "POST", token: s1, body: mk({ start: "17:00", end: "09:00" }) });
  // An end before the start yields negative minutes. Stored, it SUBTRACTS from the
  // month's paid total — the one arithmetic error nobody reading a timesheet screen
  // would ever spot, because every individual row still looks plausible.
  check("an end time before the start time is refused", backwards.status === 400, `HTTP ${backwards.status} ${backwards.data?.error || ""}`);

  const notADate = await call("/timesheets", { method: "POST", token: s1, body: mk({ date: "2027-02-30" }) });
  // 2027-02-30 passes a YYYY-MM-DD regex and V8 rolls it forward to 2 March. A row
  // filed on a day that does not exist is invisible to every screen that filters on
  // the real date, so nobody can find it again to correct it or to pay it.
  check("a date that is not a real calendar day is refused", notADate.status === 400, `HTTP ${notADate.status} ${notADate.data?.error || ""}`);

  const badMode = await call("/timesheets", { method: "POST", token: s1, body: mk({ mode: "hybrid" }) });
  check("a mode outside campus|online is refused", badMode.status === 400, `HTTP ${badMode.status}`);

  console.log("\n--- timesheets: whose hours you are looking at ---");
  const foreignEdit = await call(`/timesheets/${entryId}`, { method: "PUT", token: s2, body: mk({ title: "TAMPERED" }) });
  // A colleague editing your timesheet is a colleague editing your pay.
  check("a colleague cannot edit someone else's entry", foreignEdit.status === 403, `HTTP ${foreignEdit.status}`);

  const submitted = await call("/timesheets/submit", { method: "POST", token: s1, body: { month: TS_MONTH } });
  check("staff send the month for review", submitted.status === 200 && submitted.data?.sent === 1 && submitted.data?.totalMinutes === 150,
    `HTTP ${submitted.status} sent=${submitted.data?.sent}`);

  const adminOwn = await call("/timesheets", { method: "POST", token: admin, body: { date: TS_DAY_2, start: "10:00", end: "12:00", mode: "online", title: `HR admin ${RUN}` } });
  check("the admin logs a session of their own", adminOwn.status === 201, `HTTP ${adminOwn.status}`);
  const adminEntryId = adminOwn.data?.id;

  const adminDefault = await call(`/timesheets?month=${TS_MONTH}`, { token: admin });
  const defaultRows = adminDefault.data || [];
  // "See everyone" has to be opt-in. The staff app's My Timesheet screen sends only a
  // month, and while that alone triggered the admin branch, a finance admin opening
  // their own timesheet was shown the entire college's hours — while their own drafts
  // vanished (admins never see drafts), so they could never send their own month.
  check("an admin asking for a month gets THEIR OWN timesheet, not the college's",
    adminDefault.status === 200 && defaultRows.length === 1 && defaultRows.every((r) => r.staffId === "admin"),
    `${defaultRows.length} rows from ${[...new Set(defaultRows.map((r) => r.staffId))].join(",") || "nobody"}`);

  const adminAll = await call(`/timesheets?month=${TS_MONTH}&scope=all`, { token: admin });
  const allRows = adminAll.data || [];
  check("scope=all shows the submitted month for review", allRows.some((r) => r.staffId === "s1" && r.status === "submitted"), `${allRows.length} rows`);
  // The review screen is an approval queue, not a window onto unfinished work. A
  // half-written draft belongs to its author until they choose to send it.
  check("...and never anyone's private drafts", !allRows.some((r) => r.status === "draft"),
    `${allRows.filter((r) => r.status === "draft").length} drafts leaked`);

  const editSent = await call(`/timesheets/${entryId}`, { method: "PUT", token: s1, body: mk({ start: "07:00" }) });
  // Once it is with finance, the numbers under review must be the numbers that were
  // sent. If the owner can keep editing underneath, "approved" means nothing.
  check("a sent entry is locked to its owner", editSent.status === 409, `HTTP ${editSent.status}`);

  const resend = await call("/timesheets/submit", { method: "POST", token: s1, body: { month: TS_MONTH } });
  check("re-sending a month with nothing left to send is refused", resend.status === 400, `HTTP ${resend.status}`);

  console.log("\n--- timesheets: nobody signs off their own hours ---");
  const selfReview = await call("/timesheets/review", { method: "POST", token: admin, body: { staffId: "admin", month: TS_MONTH, decision: "approved" } });
  // The review screen grouped by staff member and drew an Approve button on every
  // group, the reviewer's own included: log 180 hours, send them, approve them,
  // stamped reviewedBy yourself, with no second pair of eyes anywhere in the flow.
  check("an admin cannot approve their own timesheet", selfReview.status === 403, `HTTP ${selfReview.status} ${selfReview.data?.error || ""}`);

  const staffReview = await call("/timesheets/review", { method: "POST", token: s1, body: { staffId: "s2", month: TS_MONTH, decision: "approved" } });
  check("ordinary staff cannot review anyone", staffReview.status === 403, `HTTP ${staffReview.status}`);

  const silentBounce = await call("/timesheets/review", { method: "POST", token: admin, body: { staffId: "s1", month: TS_MONTH, decision: "changes_requested" } });
  // Bouncing a month back with no comment leaves the staff member guessing which of
  // twenty sessions was wrong; they re-send it unchanged and the loop repeats.
  check("sending a month back requires a reason", silentBounce.status === 400, `HTTP ${silentBounce.status}`);

  const approve = await call("/timesheets/review", { method: "POST", token: admin, body: { staffId: "s1", month: TS_MONTH, decision: "approved", note: "Checked against the register." } });
  check("an admin approves the month", approve.status === 200 && approve.data?.reviewed === 1, `HTTP ${approve.status} reviewed=${approve.data?.reviewed}`);

  const reApprove = await call("/timesheets/review", { method: "POST", token: admin, body: { staffId: "s1", month: TS_MONTH, decision: "changes_requested", note: "on reflection, no" } });
  // An approved month is a payroll decision. Re-deciding it overwrites reviewedBy and
  // reviewedAt with no trace of the first sign-off ever having happened.
  check("an approved month cannot be silently re-decided", reApprove.status === 400, `HTTP ${reApprove.status} ${reApprove.data?.error || ""}`);

  const editApproved = await call(`/timesheets/${entryId}`, { method: "PUT", token: s1, body: mk({ end: "17:30" }) });
  check("an approved entry cannot be edited by its owner", editApproved.status === 409, `HTTP ${editApproved.status}`);

  // The self-review rule is only worth something if it survives the edit path too.
  // Only one seeded account holds the timesheets page, so a colleague's sign-off is
  // staged directly: this is the state the admin's own month is in the moment
  // somebody else approves it.
  await db.timesheetEntry.update({ where: { id: adminEntryId }, data: { status: "approved", reviewedBy: "A Colleague", reviewedAt: shift(0) } });

  const adminEditsOwnApproved = await call(`/timesheets/${adminEntryId}`, { method: "PUT", token: admin, body: { date: TS_DAY_2, start: "06:00", end: "23:00", mode: "online", title: `HR admin ${RUN}` } });
  // Unlocking a signed-off entry is a REVIEWER's power and has to stop at the
  // reviewer's own hours. While it did not, everything POST /review takes away came
  // straight back: log two hours, have a colleague approve the month, then rewrite
  // the approved rows to seventeen. The month still reads "approved" with the
  // colleague's name in reviewedBy, so nothing downstream shows the numbers moved
  // after sign-off.
  check("a timesheets admin cannot edit their OWN approved entry", adminEditsOwnApproved.status === 409,
    `HTTP ${adminEditsOwnApproved.status} ${adminEditsOwnApproved.data?.error || ""}`);

  const adminDeletesOwnApproved = await call(`/timesheets/${adminEntryId}`, { method: "DELETE", token: admin });
  // The worse half: a deleted approved entry leaves nothing at all to compare the
  // sign-off against.
  check("...nor delete it", adminDeletesOwnApproved.status === 409, `HTTP ${adminDeletesOwnApproved.status}`);

  const adminFixesColleague = await call(`/timesheets/${entryId}`, { method: "PUT", token: admin, body: mk({ end: "11:00", title: `Corrected by finance ${RUN}` }) });
  // The legitimate power is untouched: correcting a COLLEAGUE'S approved entry is
  // what the review screen exists for, and there is a second pair of eyes by
  // definition when the editor is not the person being paid for those hours.
  check("...but can still correct a colleague's approved entry", adminFixesColleague.status === 200 && adminFixesColleague.data?.minutes === 120,
    `HTTP ${adminFixesColleague.status} minutes=${adminFixesColleague.data?.minutes}`);

  /* ==================== LEAVE ==================== */
  console.log("\n--- leave: what a booking actually costs ---");
  const bhBody = { type: "annual", start: BH_START, end: BH_END, reason: `bank holiday span ${RUN}` };
  const bh = await call("/leave", { method: "POST", token: s1, body: bhBody });
  if (bh.data?.id) createdLeave.add(bh.data.id);
  // Five calendar days away across a bank-holiday weekend costs TWO days of
  // allowance: Saturday, Sunday and the bank holiday are separate entitlements and
  // were never bookable. Charging the raw calendar count quietly took three extra
  // days a year off everyone who books around a long weekend.
  check(`${BH_START} to ${BH_END} costs 2 days, not 5`,
    bh.status === 201 && bh.data?.days === chargeableDays(BH_START, BH_END) && bh.data.days === 2,
    `HTTP ${bh.status} days=${bh.data?.days}`);

  const doubleTap = await call("/leave", { method: "POST", token: s1, body: bhBody });
  // A double-tap on a phone fires two identical POSTs. Both used to become requests:
  // one holiday, two rows, charged twice, and two approvals for the manager to work
  // through. A repeat has to BE the original request, not a second one.
  check("an identical repeat returns the original request, not a second one",
    doubleTap.status === 200 && doubleTap.data?.id === bh.data?.id,
    `HTTP ${doubleTap.status} same id=${doubleTap.data?.id === bh.data?.id}`);

  const overlap = await call("/leave", { method: "POST", token: s1, body: { type: "personal", start: BH, end: plus(BH, 2), reason: `overlap ${RUN}` } });
  if (overlap.data?.id) createdLeave.add(overlap.data.id);
  // Overlapping bookings were each charged in full, so 10–14 Aug plus 12–18 Aug took
  // ten days off the allowance for seven days actually absent.
  check("a booking overlapping one already requested is refused", overlap.status === 409, `HTTP ${overlap.status} ${overlap.data?.error || ""}`);

  const satur = (() => { let d = shift(8); while (dow(d) !== 6) d = plus(d, 1); return d; })();
  const weekendOnly = await call("/leave", { method: "POST", token: s1, body: { type: "annual", start: satur, end: plus(satur, 1), reason: `weekend ${RUN}` } });
  if (weekendOnly.data?.id) createdLeave.add(weekendOnly.data.id);
  // Nothing in a Saturday–Sunday range is chargeable, so there is nothing to book.
  // Creating a 0-day request instead puts a phantom absence in the shared calendar
  // that consumes no allowance and can never be reconciled against anything.
  check("a weekend-only range has nothing to book", weekendOnly.status === 400, `HTTP ${weekendOnly.status} ${weekendOnly.data?.error || ""}`);

  const past = await call("/leave", { method: "POST", token: s1, body: { type: "annual", start: shift(-30), end: shift(-29), reason: `past ${RUN}` } });
  if (past.data?.id) createdLeave.add(past.data.id);
  // Only a leave admin backfills history, so they can record a past absence on
  // someone's behalf. Staff booking the past is either an error or a way to paper
  // over an unexplained absence after the fact.
  check("ordinary staff cannot book leave in the past", past.status === 400, `HTTP ${past.status}`);

  const absurd = await call("/leave", { method: "POST", token: s1, body: { type: "annual", start: shift(10), end: shift(460), reason: `absurd ${RUN}` } });
  if (absurd.data?.id) createdLeave.add(absurd.data.id);
  // chargeableDays walks the range one day at a time on Node's single thread, and the
  // approval path re-walks it once per calendar year spanned. An unbounded range is
  // not a slow request, it is a total API outage available to anyone with a login.
  check("an absurdly long booking is refused before any date maths runs", absurd.status === 400, `HTTP ${absurd.status}`);

  const notReal = await call("/leave", { method: "POST", token: s1, body: { type: "annual", start: "2027-02-30", end: "2027-02-30", reason: `fake date ${RUN}` } });
  if (notReal.data?.id) createdLeave.add(notReal.data.id);
  check("the 30th of February is refused", notReal.status === 400, `HTTP ${notReal.status}`);

  // The bank-holiday booking has made its point; clear it so it cannot sit in the
  // overlap check's way for the allowance story below.
  await call(`/leave/${bh.data?.id}`, { method: "DELETE", token: s1 });

  console.log("\n--- leave: the allowance is enforced at the decision, not the request ---");
  const big = await call("/leave", { method: "POST", token: s1, body: { type: "annual", start: LONG_START, end: LONG_END, reason: `long break ${RUN}` } });
  if (big.data?.id) createdLeave.add(big.data.id);
  // Asking for more than you have is allowed on purpose — a pending request consumes
  // nothing. It is the DECISION that has to hold the line, which is what makes the
  // next assertion the one that matters: the check has to live on the approval path.
  check(`a ${LONG_DAYS}-day request against a ${S1_BOOKABLE}-day allowance is accepted as pending`,
    big.status === 201 && big.data?.status === "pending" && LONG_DAYS > S1_BOOKABLE,
    `HTTP ${big.status} days=${big.data?.days}`);

  const overAllowance = await call(`/leave/${big.data?.id}/decision`, { method: "PUT", token: admin, body: { status: "approved" } });
  check("approving beyond the allowance is refused",
    overAllowance.status === 400 && /allowance/i.test(overAllowance.data?.error || ""),
    `HTTP ${overAllowance.status} ${overAllowance.data?.error || ""}`);

  const stillPending = await db.leave.findUnique({ where: { id: big.data?.id } });
  // A refused approval has to leave the row exactly as it was. A half-applied
  // decision — status moved but days not re-derived, or a decidedBy stamped on a
  // request that was never actually granted — is worse than either clean outcome.
  check("the refused request is untouched and still pending",
    stillPending?.status === "pending" && stillPending?.decidedBy == null,
    `status=${stillPending?.status} decidedBy=${stillPending?.decidedBy}`);

  const adj = await call("/adjustments", { method: "POST", token: admin, body: { staffId: "s1", days: 60, note: `carry-over ${RUN}`, date: `${LONG_YEAR}-01-05` } });
  if (adj.data?.id) createdAdj.add(adj.data.id);
  check("an admin grants extra days into that leave year", adj.status === 201 && adj.data?.days === 60, `HTTP ${adj.status}`);

  const nowApproved = await call(`/leave/${big.data?.id}/decision`, { method: "PUT", token: admin, body: { status: "approved", note: "Agreed with the head of department." } });
  // Adjustments belong to the leave year they are dated in. Summing them across all
  // time meant a one-off "+3 carried over" granted three extra days in every future
  // year as well — and since usage IS year-scoped, the two could never reconcile
  // once the year turned. This proves the year-scoped sum is what feeds the check.
  check("the same request approves once that year's allowance covers it",
    nowApproved.status === 200 && nowApproved.data?.status === "approved" && nowApproved.data?.days === LONG_DAYS,
    `HTTP ${nowApproved.status} status=${nowApproved.data?.status} days=${nowApproved.data?.days}`);

  const reDecide = await call(`/leave/${big.data?.id}/decision`, { method: "PUT", token: admin, body: { status: "rejected", note: "changed my mind" } });
  // Re-deciding overwrites decidedBy, decidedAt and the manager's note — the only
  // record of who authorised somebody's absence, and the first thing anyone asks for
  // when a holiday balance is disputed a year later.
  check("a decided request cannot be re-decided", reDecide.status === 409, `HTTP ${reDecide.status} ${reDecide.data?.error || ""}`);

  const staffDecides = await call(`/leave/${big.data?.id}/decision`, { method: "PUT", token: s2, body: { status: "approved" } });
  check("ordinary staff cannot decide leave at all", staffDecides.status === 403, `HTTP ${staffDecides.status}`);

  const selfCancel = await call(`/leave/${big.data?.id}`, { method: "DELETE", token: s1 });
  // Deleting your own approved holiday hands back days a manager signed off, leaving
  // the audit row for that approval pointing at a record that no longer exists.
  check("staff cannot delete their own approved leave", selfCancel.status === 403, `HTTP ${selfCancel.status}`);

  const adminCancel = await call(`/leave/${big.data?.id}`, { method: "DELETE", token: admin });
  check("an admin can cancel it and the days come back", adminCancel.status === 200 && adminCancel.data?.days === LONG_DAYS,
    `HTTP ${adminCancel.status} days=${adminCancel.data?.days}`);

  const seededApproved = ((await call("/leave", { token: admin })).data || []).find((l) => l.staffId === "s2" && l.status === "approved");
  const reDecideSeeded = await call(`/leave/${seededApproved?.id}/decision`, { method: "PUT", token: admin, body: { status: "rejected" } });
  check("a holiday approved weeks ago is equally un-redecidable", reDecideSeeded.status === 409, `HTTP ${reDecideSeeded.status}`);

  const ownLeaveOnly = await call("/leave", { token: s1 });
  // Leave rows carry a free-text reason — "Flu", "Appointment". Being signed in is
  // not a reason to be able to read a colleague's medical history.
  check("staff see only their own leave, reasons included",
    ownLeaveOnly.status === 200 && (ownLeaveOnly.data || []).length > 0 && (ownLeaveOnly.data || []).every((l) => l.staffId === "s1"),
    `${(ownLeaveOnly.data || []).length} rows`);

  /* ==================== CHECK-INS ==================== */
  console.log("\n--- check-ins: a summary is not an attendance record ---");
  const summary = await call("/checkins/summary", { method: "PUT", token: s1, body: { date: CI_SUMMARY_DAY, summary: `Wrote schemes of work at home ${RUN}` } });
  // Writing up a day you were never on site must NOT fabricate a clock-in time. ""
  // is the deliberate sentinel for "no check-in"; stamping the current clock here
  // invents attendance that never happened, on the record that feeds monthly hours.
  check("a summary for a day with no check-in records no arrival time",
    summary.status === 200 && summary.data?.in === "", `HTTP ${summary.status} in="${summary.data?.in}"`);

  const outWithoutIn = await call(`/checkins/${summary.data?.id}/check-out`, { method: "POST", token: s1 });
  // Checking that row out would leave a departure with no arrival — a day that reads
  // as worked, from an unknown start time.
  check("that row cannot be checked out of", outWithoutIn.status === 400, `HTTP ${outWithoutIn.status} ${outWithoutIn.data?.error || ""}`);

  const onSitePast = await call(`/checkins/on-site?date=${CI_SUMMARY_DAY}`, { token: s1 });
  // The who-is-in board is deliberately open to every signed-in colleague, which is
  // only safe because it is TODAY only. Unbounded, any lecturer could walk backwards
  // day by day and rebuild every colleague's arrival times — a timesheet on somebody
  // else, which is exactly what that endpoint promises never to become.
  check("the who-is-in board cannot be walked backwards by ordinary staff", onSitePast.status === 403, `HTTP ${onSitePast.status}`);

  const planted = await call("/checkins", { method: "PUT", token: admin, body: { staffId: "s1", date: CI_CHECKOUT_DAY, in: "09:00" } });
  check("an admin can correct a missed clock-in", planted.status === 200 && planted.data?.in === "09:00", `HTTP ${planted.status}`);

  const out1 = await call(`/checkins/${planted.data?.id}/check-out`, { method: "POST", token: s1 });
  const out2 = await call(`/checkins/${planted.data?.id}/check-out`, { method: "POST", token: s1 });
  // Checking out twice silently rewrote the recorded departure to the current clock
  // with no trace of the original, so a stale tab left open until midnight could
  // falsify how long somebody was on site. The first check-out is final.
  check("checking out twice is refused and the first departure stands",
    out1.status === 200 && !!out1.data?.out && out2.status === 409 && String(out2.data?.error || "").includes(out1.data.out),
    `HTTP ${out1.status}/${out2.status} out=${out1.data?.out}`);

  const backwardsDay = await call("/checkins", { method: "PUT", token: admin, body: { staffId: "s1", date: CI_BAD_DAY, in: "17:00", out: "09:00" } });
  check("a check-out before the check-in is refused", backwardsDay.status === 400, `HTTP ${backwardsDay.status}`);

  const fakeDay = await call("/checkins", { method: "PUT", token: admin, body: { staffId: "s1", date: "2027-02-30", in: "09:00" } });
  // The staff app rolls 30 February to 2 March while the dashboard filters on the
  // exact string, so a record filed here can never be found again to correct it.
  check("an admin cannot file a check-in on a day that does not exist", fakeDay.status === 400, `HTTP ${fakeDay.status}`);

  const staffAmends = await call("/checkins", { method: "PUT", token: s2, body: { staffId: "s1", date: CI_BAD_DAY, in: "07:00", out: "19:00" } });
  // This route writes a check-in for ANYONE on ANY date. It is how a missed clock-in
  // gets fixed and equally how somebody's hours could be rewritten after the fact,
  // which is why it belongs to the Check-In page alone and is audited when used.
  check("staff cannot write a check-in for someone else", staffAmends.status === 403, `HTTP ${staffAmends.status}`);

  /* ==================== ADJUSTMENTS ==================== */
  console.log("\n--- adjustments: the number that moves a balance by hand ---");
  const zero = await call("/adjustments", { method: "POST", token: admin, body: { staffId: "s1", days: 0, note: "nothing" } });
  check("a zero-day adjustment is refused", zero.status === 400, `HTTP ${zero.status}`);

  const fraction = await call("/adjustments", { method: "POST", token: admin, body: { staffId: "s1", days: 2.5, note: "half a day" } });
  // Every balance screen sums adjustments. A fractional or NaN value poisons the
  // effective allowance for that person from then on, and nothing in the UI says why.
  check("a fractional adjustment is refused", fraction.status === 400, `HTTP ${fraction.status}`);

  const huge = await call("/adjustments", { method: "POST", token: admin, body: { staffId: "s1", days: 1e12, note: "fat finger" } });
  // days is a 32-bit Int column. A larger value can be written and then cannot be
  // read back, so GET /adjustments — and therefore every holiday balance in the
  // college — fails for everyone until somebody deletes the row by hand.
  check("an adjustment outside the 32-bit column is refused", huge.status === 400, `HTTP ${huge.status}`);

  const wrongYear = await call("/adjustments", { method: "POST", token: admin, body: { staffId: "s1", days: 3, date: `${TODAY.getUTCFullYear() - 3}-06-01`, note: "ancient history" } });
  check("an adjustment cannot be dated outside the neighbouring leave years", wrongYear.status === 400, `HTTP ${wrongYear.status}`);

  const staffAdjusts = await call("/adjustments", { method: "POST", token: s1, body: { staffId: "s1", days: 10, note: "for me" } });
  // Granting yourself ten days of holiday is the cheapest fraud available in the app.
  check("staff cannot grant themselves holiday", staffAdjusts.status === 403, `HTTP ${staffAdjusts.status}`);

  /* ==================== STUDENT SESSIONS ==================== */
  console.log("\n--- a student session cannot reach the staff routers ---");
  const STUDENT_PW = `student-suite-${RUN}`;
  await db.student.update({ where: { id: "st-100121" }, data: { passwordHash: bcrypt.hashSync(STUDENT_PW, 10) } });
  const sLogin = await call("/auth/login", { method: "POST", body: { email: "100121@edtech.co.uk", password: STUDENT_PW } });
  check("the student signs in", sLogin.status === 200 && sLogin.data?.user?.kind === "student", `HTTP ${sLogin.status}`);
  const sTok = sLogin.data?.token;
  const stTimesheets = await call("/timesheets", { token: sTok });
  const stLeave = await call("/leave", { token: sTok });
  const stCheckins = await call("/checkins/on-site", { token: sTok });
  // requireAuth holds a router ALLOWLIST: a student token reaches /api/student and
  // /api/auth and nothing else. Without it a valid student session is a valid session
  // everywhere, and the staff payroll surface becomes a surface students can call.
  check("a student token is refused by /timesheets, /leave and /checkins",
    stTimesheets.status === 403 && stLeave.status === 403 && stCheckins.status === 403,
    `HTTP ${stTimesheets.status}/${stLeave.status}/${stCheckins.status}`);
} finally {
  await cleanup();
  await db.$disconnect();
  console.log("\ncleanup: test timesheets, leave, adjustments and check-ins removed");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
