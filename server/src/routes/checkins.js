const router = require("express").Router();
const prisma = require("../db");
const audit = require("../audit");
const { sCheckin } = require("../serializers");
const { requireAuth, requirePage, hasPage } = require("../auth");
const { isString, isRealDate, MAX_TEXT, isSite } = require("../validate");
const { localDate, localTime } = require("../clock");
const tapConfig = require("../attendanceTapConfig");
const { checkPresence } = require("../presence");
const { campusesFor } = require("../campuses");

// HH:MM, 24-hour. Times are stored as plain strings and rendered verbatim.
const isTime = (v) => isString(v) && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

// Date and clock time in the organisation's local zone (London), NOT the server's.
// A UTC host would otherwise record every check-in an hour early in summer (BST).
const today = () => localDate();
const nowTime = () => localTime();

// How far back GET / reaches when the caller names no date: a year and a day.
//
// The list was unbounded, and the client polls it every 20 seconds — so an admin's
// browser re-downloaded every check-in the college has EVER recorded, three times a
// minute, forever. Nothing on screen needs that. What the dashboard provably renders
// (StaffHub.jsx, via store.checkins) is: today and the last 7 days (Overview), the
// current month (the Staff screen's hours column), a date the Check-In and Daily
// Summaries pickers select, a staff member's own most recent 6 check-ins and 4
// summaries, and the KPI screen's per-person punctuality tallies.
//
// The last three are technically open-ended — a picker can be pointed at any past
// date, and the KPI/"Check-ins" counters tally whatever arrives — so this is a
// GENEROUS cap rather than a tight one: a full leave-year of history stays visible
// everywhere, those aggregates become "over the last year" (arguably the more honest
// figure for a punctuality score), and the payload stops growing without bound. A
// screen that needs older history should ask for its date (?date=), which is exact
// and bypasses the window — not widen this.
const LIST_WINDOW_DAYS = 366;
const listWindowStart = () => {
  // String date arithmetic in UTC, matching how every academic date in this codebase
  // is compared: the window boundary is a YYYY-MM-DD string, derived from the
  // organisation's own "today" (never the host clock — see clock.js).
  const d = new Date(today() + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - LIST_WINDOW_DAYS);
  return d.toISOString().slice(0, 10);
};

// GET /api/checkins?date=YYYY-MM-DD  — admin: everyone; staff: own only.
// No ?date= means "recent history" (the window above), never "everything ever".
router.get("/", requireAuth, async (req, res) => {
  const where = {};
  // An explicit date is exact and unwindowed: it names at most one row per member
  // of staff, so it is already bounded, and it is the escape hatch for reviewing a
  // day older than the window.
  where.date = req.query.date ? String(req.query.date) : { gte: listWindowStart() };
  // Only an admin granted Check-In or Daily Summaries sees everyone; any other
  // admin is scoped to their own records like ordinary staff.
  // Pages that legitimately DISPLAY everyone's check-ins: the Check-In and Daily
  // Summaries screens, plus Overview (present-today), KPIs (punctuality) and Staff
  // (monthly hours). Gating on the owning page alone made those screens show zeros.
  if (!hasPage(req.user, ["checkin", "summaries", "overview", "kpi", "staff"])) where.staffId = req.user.id;
  const rows = await prisma.checkIn.findMany({ where, orderBy: { date: "desc" } });
  // Overview/KPI/Staff are widened above because they need dates and times — who is
  // in, punctuality, monthly hours. They do NOT need the free-text daily summary,
  // which "Daily Summaries" is a separate checkbox for, so it is blanked for them.
  // sCheckin emitted it unconditionally, handing every colleague's written account of
  // their day to admins granted an unrelated page.
  const canReadSummaries = hasPage(req.user, ["checkin", "summaries"]);
  res.json(rows.map((r) => {
    const out = sCheckin(r);
    if (!canReadSummaries && r.staffId !== req.user.id) out.summary = "";
    return out;
  }));
});

// GET /api/checkins/on-site — who is in today, for EVERY member of staff.
//
// Deliberately open to any signed-in staff member, unlike GET / above: knowing who
// else is in the building today is the point of the feature, and it is the sort of
// thing a wall board would show. It therefore returns only what a wall board would:
// name, initials, job title, home site and the clock-in time. No email, no notes, no
// check-out — nothing that turns a presence list into a timesheet on someone else.
//
// `site` is the staff member's HOME site, recorded when they signed up (HND / FE /
// SL), which is what "filter by building" means here. The check-in row carries its
// own optional site for where that particular clock-in happened; it is returned as
// `checkedInAt` so the two are never confused.
router.get("/on-site", requireAuth, async (req, res) => {
  const date = req.query.date ? String(req.query.date) : today();
  if (!isRealDate(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  // TODAY only, unless the caller holds a page that legitimately reviews history.
  // The date was unbounded, so any lecturer could walk backwards day by day and
  // rebuild every colleague's arrival and departure times — a timesheet on someone
  // else, which is exactly what the note above says this endpoint must never become.
  if (date !== today() && !hasPage(req.user, ["checkin", "summaries"])) {
    return res.status(403).json({ error: "You can only see who is on site today." });
  }
  // A wall board shows who is IN, so a row with no real clock-in isn't one. timeIn ""
  // is the sentinel PUT /summary writes for "wrote a summary, never checked in"; it
  // was listed as a present colleague with a blank arrival time, sorted to the very
  // top (""localeCompare beats every real time) and counted in "checked in today".
  const rows = await prisma.checkIn.findMany({
    where: { date, NOT: { timeIn: "" } },
    include: {
      staff: {
        select: { id: true, name: true, initials: true, colour: true, jobTitle: true, dept: true, site: true },
      },
    },
  });

  res.json({
    date,
    people: rows
      .filter((r) => r.staff)
      .map((r) => ({
        id: r.id,
        staffId: r.staff.id,
        name: r.staff.name,
        initials: r.staff.initials,
        colour: r.staff.colour,
        jobTitle: r.staff.jobTitle,
        dept: r.staff.dept,
        site: r.staff.site || null,       // home site, from sign-up — what the filter uses
        checkedInAt: r.site || null,       // where this clock-in happened, when recorded
        timeIn: r.timeIn,
        // Departure time is withheld from the general audience, as the note above
        // promises ("no check-out"). Arrival answers "is she in?"; arrival PLUS
        // departure is a record of how long a colleague worked, which is the Check-In
        // and Daily Summaries pages' business, not a wall board's.
        ...(hasPage(req.user, ["checkin", "summaries"]) ? { timeOut: r.timeOut || null } : {}),
      }))
      // Earliest arrival first: the list reads as the order people came in.
      .sort((a, b) => String(a.timeIn).localeCompare(String(b.timeIn))),
  });
});

// A member of staff's half of a presence refusal, in words they can act on.
//
// ITS OWN MAP, not the student one from routes/student.js, and the difference is the last
// clause of every line: a member of staff always has an honest alternative — Online —
// and a student does not. Telling somebody what to do instead is the difference between
// a refusal they can resolve standing there and one that sends them to a manager.
//
// The two CONFIGURATION failures deliberately read identically to the ordinary ones. A
// member of staff cannot tell the difference and there is nothing for them to do about
// it; the distinct `reason` beside it is for the log and the settings screen.
const STAFF_PLACE_REFUSALS = {
  off_network: "You're not on the college network. Choose Online if you're working remotely.",
  network_not_configured: "You're not on the college network. Choose Online if you're working remotely.",
  off_campus: "You're not at a campus. Choose Online if you're working remotely.",
  campus_not_located: "You're not at a campus. Choose Online if you're working remotely.",
  position_missing: "Turn on location so we can check you're at the college, then try again.",
  accuracy_unknown: "We couldn't get an accurate location. Try again near a window, or choose Online.",
  accuracy_too_poor: "We couldn't get an accurate location. Try again near a window, or choose Online.",
  default: "We couldn't check you're at the college. Choose Online if you're working remotely.",
};

/**
 * Is this staff clock-in allowed to happen where it is happening? Answers `true` when it
 * has ALREADY refused the request.
 *
 * ONLY EVER CALLED FOR ONSITE. Online is never checked under any setting: somebody
 * working from home is by definition off the college network and away from every campus,
 * so a rule that caught them would leave the truthful answer unrecordable. That is why
 * the caller gates on `site`, not on the route.
 *
 * TRANSLATES the staff switches into the shape presence.js expects rather than teaching
 * presence.js about staff. The engine asks "is this device in the building" and has no
 * business knowing who is holding it — and keeping it that way is what lets it stay pure,
 * database-free and tested without either audience.
 *
 * THE TRANSLATION IS THE PART THAT FAILS SILENTLY, so it is worth saying what goes wrong
 * if it is skipped: checkPresence reads `networkCheck` and `geofenceCheck`, and the staff
 * switches are `staffNetworkCheck` and `staffGeofenceCheck`. Hand it `settings` unchanged
 * and it sees both as undefined, runs no checks at all, and returns ok for every member of
 * staff — while the settings screen reports the rule as enforced. Nothing throws and
 * nothing is logged. smoke-nfc-tap.mjs pins it with a refusal that only happens if the
 * translated object arrived.
 *
 * `campusesFor(null)` — every located campus — because a clock-in is for a DAY, not a
 * class. There is no room to narrow to, and "is this person at the college" is the honest
 * question anyway.
 *
 * WHERE THE ADDRESS COMES FROM: `req.ip`, resolved by Express under `trust proxy: 1` (set
 * in index.js), which trusts exactly one hop — Render's. A phone can put anything it likes
 * in X-Forwarded-For, and with one real proxy in front its header is pushed left and the
 * address Render observed is the one used. `trust proxy: true` would take the leftmost
 * entry, which IS the phone's own claim, and the whole check would become a value the
 * member of staff chooses. routes/student.js says the same thing at length.
 *
 * @param {string} method  "nfc" when a sticker was involved, "button" when not. NEVER
 *   null: the schema defines a null `method` as "row written before the column existed",
 *   so a fresh refusal writing null would read back as pre-feature history.
 */
async function refusedForStaffPlace(req, res, settings, method) {
  // Neither switch on is the state every college is in until it opts in, and it costs
  // nothing: no campus query, no work at all. This early return is also what makes the
  // promise "with both off, behaviour is exactly what it was yesterday" structural rather
  // than something the checks below happen to agree with.
  if (settings.staffNetworkCheck !== true && settings.staffGeofenceCheck !== true) return false;

  const verdict = checkPresence({
    ip: req.ip,
    // The phone's READING, never its opinion of whether that is close enough. A client
    // that sent "I am in range" would be sending a value anybody can send.
    position: req.body?.position,
    campuses: settings.staffGeofenceCheck === true ? await campusesFor(null) : [],
    settings: {
      networkCheck: settings.staffNetworkCheck,
      geofenceCheck: settings.staffGeofenceCheck,
      allowedNetworks: settings.allowedNetworks,
      geofenceRadiusM: settings.geofenceRadiusM,
    },
  });
  if (verdict.ok) return false;

  // EVERY failure is logged, not only the one reported. A college switching this on for
  // the first time wants to see that its IP list is wrong AND its coordinates are, rather
  // than discovering the second a week after fixing the first.
  //
  // `site: "Onsite"` on every row, because this function is only ever reached for an
  // onsite claim — a tap is one by construction and POST /check-in gates on the site it
  // was sent. A refusal with no site would be unreadable next to the accepted taps.
  for (const f of verdict.failures) {
    try {
      await prisma.tagTap.create({
        data: { staffId: req.user.id, method, outcome: f.reason, site: "Onsite", ip: req.ip ? String(req.ip).slice(0, 60) : null },
      });
    } catch (e) { console.error("[tap] could not log a staff presence refusal:", e.message); }
  }

  const first = verdict.failures[0];
  // A misconfiguration is the operator's problem and it is INVISIBLE from the outside:
  // every member of staff is refused while the settings screen says the rule is enforced.
  // So it is said out loud where somebody reading the service's output will meet it.
  //
  // KEYED ON THE WHOLE LIST, NOT ON `first`, and the loop above is the reason. That loop
  // writes EVERY failure to the log precisely so a college switching both checks on for
  // the first time sees that its IP list is wrong AND its coordinates are, rather than
  // discovering the second a week after fixing the first. Asking `first.reason` here
  // contradicted that a few lines later: presence.js pushes the network failure before the
  // geofence one, so with both switched on and both misconfigured the geofence alarm never
  // fired at all — the one an operator is least likely to work out unaided, since it is
  // fixed on a different screen from the one that turned the check on.
  //
  // `first` stays as it is for the RESPONSE body: a member of staff gets one refusal to
  // act on, not a list, and the ordering is what decides which one they are told about.
  if (verdict.failures.some((f) => f.reason === "network_not_configured")) {
    console.error("[presence] the staff network check is ON but no usable IP range is saved — every staff clock-in is being refused");
  }
  if (verdict.failures.some((f) => f.reason === "campus_not_located")) {
    console.error("[presence] the staff geofence is ON but no active campus has coordinates — every staff clock-in is being refused");
  }

  // 403, not 409. Nothing is wrong with the clock-in itself; what is wrong is WHERE it
  // is being made, and the app shows a different thing for "not here" than for "not now".
  res.status(403).json({
    error: STAFF_PLACE_REFUSALS[first.reason] || STAFF_PLACE_REFUSALS.default,
    reason: first.reason,
  });
  return true;
}

// POST /api/checkins/check-in  — self, for today. `site` (Onsite | Online) records where
// this clock-in happened, and is REQUIRED — see the note on the validation line below.
router.post("/check-in", requireAuth, async (req, res) => {
  const date = today();
  const site = req.body?.site;
  // A SITE IS REQUIRED HERE, even though `isSite` permits null — and that gap was a real
  // hole, not a theoretical one. `isSite` is `(v) => v == null || SITES.includes(v)`, so
  // an empty body passed validation, `site === "Onsite"` was false, the tap requirement
  // never fired, and a row was written with no site at all. This route's own comment
  // holds it to a higher standard: "anything that can be worked around by knowing the URL
  // is a convention, and a timesheet is not a good place for one."
  //
  // The ADMINISTRATOR's PUT / is untouched and still accepts null — filling in a missed
  // clock-in for somebody else is exactly what that route is for, and an administrator
  // often does not know where the person was.
  if (!isString(site) || !isSite(site)) return res.status(400).json({ error: "site must be Onsite or Online" });

  // Where a college requires a sticker for onsite work, this route may not record one.
  //
  // Defence in depth, matching the note above the HND router: the app hides its ordinary
  // button in this case, but a hidden button is not a rule — the endpoint was still there
  // and still answered. Anything that can be worked around by knowing the URL is a
  // convention, and a timesheet is not a good place for one.
  //
  // ONLINE IS NEVER GATED, and that is the point of gating on `site` rather than on the
  // route. A sticker proves somebody stood in the building, which is precisely what a
  // person working from home cannot do; requiring one to record remote work would make
  // the honest answer the unrecordable one. An administrator's PUT / is also untouched,
  // because fixing a missed clock-in is exactly what that route is for.
  const tap = await tapConfig.get();
  // staffTapEnabled ALONE since 13 Sep 2026 — it used to be `enabled && staffTapEnabled`,
  // which chained staff clock-in to the STUDENT NFC master switch: a college running QR
  // for students (enabled:false) could never require staff to tap, because switching
  // staff enforcement on dragged student stickers on with it. The two audiences share
  // stickers, not a switch.
  if (site === "Onsite" && tap.staffTapEnabled) {
    return res.status(409).json({
      error: "Onsite clock-in is by sticker here — tap the sticker in your building. Choose Online if you are working remotely.",
      reason: "tap_required",
    });
  }

  const existing = await prisma.checkIn.findUnique({ where: { staffId_date: { staffId: req.user.id, date } } });

  // ALREADY CLOCKED IN WINS OVER PRESENCE, exactly as it does on the tap route, and the
  // symmetry is the point: "already clocked in wins" is a rule about a staff CLOCK-IN, not
  // about one of the two ways of making one. A stale tab left open since the morning, a
  // double-press, an app that retries — each of those re-sends this request, and each of
  // them WRITES NOTHING, because the arrival time already stands and re-pressing must never
  // move it. There is therefore nothing for a presence check to protect, and answering
  // "you're not on the college network" to a no-op teaches somebody the feature is flaky on
  // the one screen they use every morning.
  //
  // MOVED ABOVE THE PRESENCE GATE, where it used to sit below it. Below it, the same person
  // tethering to their phone at two in the afternoon was refused for re-pressing a button
  // that would have changed nothing.
  if (existing && existing.timeIn) return res.json(sCheckin(existing));

  // ONSITE ONLY. See refusedForStaffPlace: Online is never checked under any setting.
  // "button" rather than "nfc" — no sticker was involved in this route, and a log an
  // administrator reads to answer "why couldn't I clock in" must not describe a button
  // press as a tap.
  //
  // BELOW the short circuit above and ABOVE the fill below, and the division is exactly
  // "does this branch write". The summary-first row (`timeIn: ""`, written by PUT /summary
  // for a day somebody wrote up but never clocked into) is filled in with a real arrival
  // time by the next few lines — that is a write, it is the moment the college's record
  // starts saying this person was on site, and it has to pass the same check a fresh
  // clock-in does. Hoisting this any higher would exempt it.
  //
  // RATE LIMITED, and ONLY WHEN A PRESENCE CHECK IS ACTUALLY ABOUT TO RUN — see
  // staffPlaceAllowed above for why this exists at all. Testing `tap.staffNetworkCheck` /
  // `tap.staffGeofenceCheck` here, rather than limiting every Onsite press unconditionally,
  // is what keeps the two promises this branch must not break: an all-off college's plain
  // button stays byte-for-byte unthrottled — that is the deploy-safety promise, and
  // refusedForStaffPlace's own early return already makes the check free for that college,
  // so spending a budget slot on it here would be a behaviour change with nothing behind
  // it — and Online never reaches this line at all, so it can never be rate-limited by it.
  if (site === "Onsite" && (tap.staffNetworkCheck === true || tap.staffGeofenceCheck === true) && !staffPlaceAllowed(req.user.id)) {
    try {
      await prisma.tagTap.create({
        data: { staffId: req.user.id, method: "button", outcome: "rate_limited", site: "Onsite", ip: req.ip ? String(req.ip).slice(0, 60) : null },
      });
    } catch (e) { console.error("[tap] could not log a rate-limited staff presence check:", e.message); }
    return res.status(429).json({ error: "Too many attempts — wait a moment and try again." });
  }
  if (site === "Onsite" && await refusedForStaffPlace(req, res, tap, "button")) return;

  if (existing) {
    // A row created by a summary-first save has timeIn === "" — fill in the
    // real clock-in time now instead of leaving attendance blank for the day.
    // Record the site alongside the real clock-in time (don't wipe an existing one).
    const filled = await prisma.checkIn.update({ where: { id: existing.id }, data: { timeIn: nowTime(), ...(site ? { site } : {}) } });
    return res.json(sCheckin(filled));
  }
  // A CREATE IN A TRY, AND THE DATABASE SETTLES THE RACE. What stood here was an
  // `upsert` carrying this claim:
  //
  //     "upsert (not create) closes the race where two concurrent check-ins both pass
  //      the existence check and the second create() violates @@unique([staffId,date])."
  //
  // IT DID NOT CLOSE IT, and a comment asserting a race is shut sitting on code where it
  // is open is worse than no comment at all — it stops the next reader looking. Prisma
  // only compiles `upsert` down to a single `INSERT ... ON CONFLICT` when the `update`
  // branch has something in it. With `update: {}` it degrades to find-then-create, which
  // is visible in the query log as a bare SELECT followed by an INSERT carrying no
  // ON CONFLICT clause at all — so two simultaneous presses both select nothing, both
  // insert, and the loser comes back as an unhandled P2002. That is HTTP 500 on the
  // clock-in button, and a stress test firing two presses with Promise.all found it on its
  // first run. (Its siblings PUT / and PUT /summary both pass a non-empty `update` and do
  // emit ON CONFLICT, which is why the defect is here and only here.)
  //
  // THE DATA WAS NEVER AT RISK — @@unique([staffId, date]) held and exactly one row was
  // written. What was wrong was the answer the losing request got, and that is what this
  // fixes. The race is BENIGN: the request that won wrote precisely what this one would
  // have, so there is nothing to reconcile and nothing to retry.
  //
  // Letting the database decide rather than widening the read-then-write window is the
  // house pattern — the tap route below settles the same race the same way, by putting the
  // condition in the statement instead of in an `if`.
  try {
    const rec = await prisma.checkIn.create({ data: { staffId: req.user.id, date, timeIn: nowTime(), site: site || null } });
    return res.status(201).json(sCheckin(rec));
  } catch (e) {
    // Anything that is not the unique constraint is a real failure and still belongs in
    // the error handler; only the collision we designed for is absorbed here.
    if (e?.code !== "P2002") throw e;
    const won = await prisma.checkIn.findUnique({ where: { staffId_date: { staffId: req.user.id, date } } });
    // Gone again between the conflict and this read — somebody deleted the row in that
    // instant. There is no honest record to hand back, so the original error surfaces
    // rather than this inventing one.
    if (!won) throw e;
    // 200, NOT 201, and the distinction is deliberate rather than incidental: this request
    // created nothing, and 201 would claim it did. But the PERSON is clocked in, which is
    // the one fact they pressed the button to establish — so an error here would be the
    // screen lying to them about the only thing they asked. 200-with-the-record is exactly
    // what the already-clocked-in short circuit further up returns, so a double-press and
    // a stale tab are indistinguishable to the client. They should be: they are the same
    // thing half a second apart.
    return res.status(200).json(sCheckin(won));
  }
});

// GET /api/checkins/tap-settings — may I offer the tap button, and for how long?
//
// requireAuth ONLY, and that is the entire reason it exists. The full settings live on
// /api/tags/settings, whose router is gated on the attendance-tags admin page — so an
// ordinary lecturer asking whether they may tap got a 403, the client swallowed it, and
// the check-in card rendered nothing. The feature worked and was invisible to everybody
// it was built for.
//
// An allowlist of three booleans and a number. Nothing here is sensitive: it says only
// whether the college has switched the feature on. The lateness threshold, the grace
// window and who last changed them stay on the admin route.
router.get("/tap-settings", requireAuth, async (_req, res) => {
  const s = await tapConfig.get();
  // needsLocation IS ON THIS ROUTE because it is the only one an ordinary member of staff
  // can reach. The student app resolves the same question from /student/me/tap-context,
  // which is inside the student router's allowlist and 403s for a lecturer — so a staff
  // client asking there got `false`, sent no position, and was refused `position_missing`
  // on every single onsite clock-in. The feature would have appeared completely broken.
  //
  // Only the GEOFENCE needs it. The network check is observed from the far end of the
  // connection and asks nothing of the phone, so a college running that alone must never
  // trigger a location prompt — a permission request with no honest answer to "why does
  // this app want that" is the one thing this flag exists to avoid.
  res.json({ enabled: s.enabled, staffTapEnabled: s.staffTapEnabled, armSeconds: s.armSeconds, needsLocation: s.staffGeofenceCheck === true });
});

// In-process and module-level, correct for ONE Node process; a clustered deployment needs
// Redis. The student route has had one from the start and this did not, which was an
// oversight rather than a decision: without it a staff account can try tag codes as fast
// as the API will answer, and nothing else here throttles that.
const staffTapHits = new Map(); // staffId -> number[] of timestamps
const STAFF_TAP_WINDOW_MS = 60_000;
const STAFF_TAP_MAX = 10;
function staffTapAllowed(staffId) {
  const now = Date.now();
  const recent = (staffTapHits.get(staffId) || []).filter((t) => now - t < STAFF_TAP_WINDOW_MS);
  if (recent.length >= STAFF_TAP_MAX) { staffTapHits.set(staffId, recent); return false; }
  recent.push(now);
  staffTapHits.set(staffId, recent);
  return true;
}

// In-process and module-level, correct for ONE Node process; a clustered deployment needs
// Redis — same caveat as staffTapAllowed above and every other limiter in this file.
//
// WHY THIS EXISTS: POST /tap-check-in has carried staffTapAllowed() since it was built,
// and the comment on it says why: "the rate limit stays ahead of presence so that probing
// the checks is throttled like everything else." POST /check-in's own presence gate
// (refusedForStaffPlace, called a few lines below when site === "Onsite") had no such
// budget in front of it — an authenticated account could send an arbitrary `position` in
// the body as fast as the API would answer, and every refusal still writes a TagTap row,
// so the same loop that probes the campus boundary also floods the tap log as a side
// effect of the very check meant to guard it.
//
// A SEPARATE MAP FROM staffTapHits, deliberately, rather than one shared budget between
// the two routes. Sharing one counter would mean exhausting the sticker-guessing budget on
// the tap route also silently throttled an honest Onsite button press on this one (and vice
// versa) — two different things being probed, sharing a wall neither reader can see.
const staffPlaceHits = new Map(); // staffId -> number[] of timestamps
const STAFF_PLACE_WINDOW_MS = 60_000;
const STAFF_PLACE_MAX = 10;
function staffPlaceAllowed(staffId) {
  const now = Date.now();
  const recent = (staffPlaceHits.get(staffId) || []).filter((t) => now - t < STAFF_PLACE_WINDOW_MS);
  if (recent.length >= STAFF_PLACE_MAX) { staffPlaceHits.set(staffId, recent); return false; }
  recent.push(now);
  staffPlaceHits.set(staffId, recent);
  return true;
}

// POST /api/checkins/tap-check-in — clock in by touching an NFC sticker.
//
// `site` is NOT accepted and NOT asked for. Someone who touched a sticker in the
// building cannot be working online — the tap is what proves they were at that wall — so
// recording anything but "Onsite" would store a claim the tap itself disproves. Working
// online remains available through POST /check-in, which does take a site.
//
// WHAT THIS DOES AND DOES NOT PROVE
//
// It proves somebody was at the sticker, ONCE, with this account signed in. It does not
// prove they are there now. The code on a sticker is static and any phone with a generic
// NFC app can read it, so a member of staff who notes it down can clock in Onsite from
// home, and the tagId on the row would read as corroboration it is not. An earlier
// version of this comment claimed this was "the first time a staff clock-in has meant
// 'was in the building' rather than 'said so'" — that overstated it, and a claim like
// that in a timesheet record is worth more care than a claim about a feature.
//
// What it does raise is the bar: a clock-in now requires having walked past a sticker at
// least once rather than nothing at all, and every tap lands in TagTap with its IP, so a
// pattern is visible to somebody looking. Closing it properly needs rotating codes or a
// tag bound to a place — see the design note in docs/superpowers/specs/.
router.post("/tap-check-in", requireAuth, async (req, res) => {
  const settings = await tapConfig.get();
  // staffTapEnabled alone, not `enabled &&` — same decoupling as POST /check-in's
  // onsite gate above, and they MUST agree: if this route refused while that one
  // demanded a tap, an onsite clock-in would be impossible outright.
  if (!settings.staffTapEnabled) {
    // method on refusals too: NULL is defined as "row from before the column existed",
    // so a fresh refusal writing NULL would read as pre-feature history in the log.
    try { await prisma.tagTap.create({ data: { staffId: req.user.id, method: "nfc", outcome: "disabled", ip: req.ip ? String(req.ip).slice(0, 60) : null } }); }
    catch (e) { console.error("[tap] could not log a disabled staff tap:", e.message); }
    return res.status(403).json({ error: "Tap check-in isn't switched on for this college." });
  }

  const code = req.body?.tagCode;
  if (!isString(code) || !code.trim()) return res.status(400).json({ error: "A tag is required" });

  if (!staffTapAllowed(req.user.id)) {
    try { await prisma.tagTap.create({ data: { staffId: req.user.id, method: "nfc", outcome: "rate_limited", ip: req.ip ? String(req.ip).slice(0, 60) : null } }); }
    catch (e) { console.error("[tap] could not log a rate-limited staff tap:", e.message); }
    return res.status(429).json({ error: "Too many attempts — wait a moment and try again." });
  }

  const date = today();

  // ALREADY CLOCKED IN WINS OVER PRESENCE, and this ordering is deliberate rather than
  // accidental — it differs from the student path, where every capture method writes.
  //
  // A second tap on the way past the door writes NOTHING: the arrival time is already
  // recorded and re-tapping must never move it. There is therefore nothing to protect,
  // and answering "you're not at a campus" to a no-op teaches somebody the feature is
  // flaky — on the one screen they use every single morning.
  const existingToday = await prisma.checkIn.findUnique({ where: { staffId_date: { staffId: req.user.id, date } } });
  if (existingToday && existingToday.timeIn) {
    // THE TAG IS RESOLVED HERE, on this path alone, and for the LOG rather than for the
    // answer — which is the one thing this reordering could quietly have cost.
    //
    // Returning before the lookup would be a query cheaper and would write
    // `already_checked_in` with a null tagId. That column is the half of TagTap that
    // answers "I tapped and it didn't work", because the sticker somebody touched is
    // recorded nowhere else; STATUS.md calls it the valuable half. One extra read, on a
    // path that runs at most once per person per day, buys it back.
    const reTapTag = await prisma.attendanceTag.findFirst({ where: { code: code.trim(), active: true } });
    if (reTapTag) {
      try {
        await prisma.tagTap.create({
          data: {
            tagId: reTapTag.id, staffId: req.user.id, method: "nfc",
            outcome: "already_checked_in", site: "Onsite",
            ip: req.ip ? String(req.ip).slice(0, 60) : null,
          },
        });
      } catch (e) { console.error("[tap] could not log an already-checked-in staff tap:", e.message); }
      return res.json({ ok: true, alreadyCheckedIn: true, ...sCheckin(existingToday) });
    }
    // A code that matches NO live sticker falls through instead of answering "already
    // clocked in", so that an unrecognised tag is still reported as one. With both
    // presence switches off that lands on exactly the 404 this route has always given —
    // which is the promise that switching nothing on changes nothing. With one on, the
    // presence refusal comes first, matching the rule the student routes already follow:
    // somebody off the college network is told THAT rather than handed "tag not
    // recognised" from a check they were never going to get past.
  }

  // AFTER the rate limit and BEFORE the tag lookup.
  //
  // After the rate limit, because probing these checks must be throttled exactly like
  // probing tag codes is — otherwise the cheapest thing on this route is the one with no
  // budget attached to it.
  //
  // Before the tag lookup, matching routes/student.js and for its stated reason: somebody
  // off the college network should be told THAT, not handed "tag not recognised" from a
  // check they were never going to get past.
  //
  // Always, with no `site` test, because a tap IS an onsite claim by construction — this
  // route does not accept a site and never has.
  if (await refusedForStaffPlace(req, res, settings, "nfc")) return;

  // Tenant-scoped by db.js, so another college's tag is simply not found.
  const tag = await prisma.attendanceTag.findFirst({ where: { code: code.trim(), active: true } });
  if (!tag) {
    // The code itself is never stored — a log an administrator reads must not become a
    // list of the codes somebody has been trying.
    try { await prisma.tagTap.create({ data: { staffId: req.user.id, method: "nfc", outcome: "tag_unknown", ip: req.ip ? String(req.ip).slice(0, 60) : null } }); }
    catch (e) { console.error("[tap] could not log an unknown-tag staff tap:", e.message); }
    return res.status(404).json({ error: "That tag isn't recognised." });
  }

  // Never throws into the request: the clock-in is the record, this is the account of it.
  const logTap = async (outcome, extra = {}) => {
    try {
      await prisma.tagTap.create({
        data: { tagId: tag.id, staffId: req.user.id, method: "nfc", outcome, ip: req.ip ? String(req.ip).slice(0, 60) : null, ...extra },
      });
    } catch (e) {
      console.error("[tap] could not log a staff tap:", e.message);
    }
  };

  // The row this route read BEFORE the presence check, reused rather than read again.
  // A real clock-in already standing was dealt with up there — this is the sentinel case
  // and the no-row case, which are the two that still write.
  //
  // ONE READ, deliberately. Two reads of the same row a few lines apart is how a guard and
  // the write it guards come to disagree about what they are looking at, and the race this
  // route already legislates for below (two concurrent taps) is exactly the window in
  // which they would.
  //
  // timeIn "" is the sentinel PUT /summary writes for "wrote a summary, never checked
  // in". Fill in the real clock time rather than leaving the day blank.
  // updateMany with `timeIn: ""` in the WHERE, not a bare upsert. Two concurrent taps can
  // both pass the `existingToday.timeIn` guard above; a bare upsert then has the second one
  // rewrite the arrival time, which is exactly what that guard exists to prevent. Making
  // the condition part of the statement means the database settles it: the first write
  // fills the sentinel, the second matches nothing.
  const filled = await prisma.checkIn.updateMany({
    where: { staffId: req.user.id, date, timeIn: "" },
    data: { timeIn: nowTime(), site: "Onsite", tagId: tag.id },
  });
  let rec;
  if (filled.count === 0 && !existingToday) {
    try {
      rec = await prisma.checkIn.create({ data: { staffId: req.user.id, date, timeIn: nowTime(), site: "Onsite", tagId: tag.id } });
    } catch (e) {
      // P2002 on @@unique([staffId, date]) — somebody else's request created the row
      // between our read and this write. Their clock-in stands; report it as theirs
      // rather than as a 500.
      //
      // NARROWED TO P2002, matching POST /check-in's sibling catch above. This used to
      // absorb ANY error here — a validation failure, a dropped connection, whatever —
      // and answer it as "already checked in", which is a true statement about the wrong
      // problem and hides a real failure behind a 200. Anything that is not the collision
      // this block exists to settle belongs in the ordinary error handler.
      if (e?.code !== "P2002") throw e;
      const now = await prisma.checkIn.findUnique({ where: { staffId_date: { staffId: req.user.id, date } } });
      if (!now) throw e;
      await logTap("already_checked_in", { site: "Onsite" });
      return res.json({ ok: true, alreadyCheckedIn: true, ...sCheckin(now) });
    }
  } else {
    rec = await prisma.checkIn.findUnique({ where: { staffId_date: { staffId: req.user.id, date } } });
  }

  await prisma.attendanceTag.update({ where: { id: tag.id }, data: { lastTapAt: new Date() } });
  await logTap("checked_in", { site: "Onsite" });

  // Not audited, matching POST /check-in: this records the present, in the caller's own
  // name, and cannot alter history. PUT / — which writes anyone's hours on any date —
  // is the one that is audited.
  res.status(201).json({ ok: true, ...sCheckin(rec) });
});

// POST /api/checkins/:id/check-out  — owner or admin
router.post("/:id/check-out", requireAuth, async (req, res) => {
  const rec = await prisma.checkIn.findUnique({ where: { id: req.params.id } });
  if (!rec) return res.status(404).json({ error: "Record not found" });
  if (rec.staffId !== req.user.id && !hasPage(req.user, "checkin")) return res.status(403).json({ error: "Forbidden" });
  // A summary-first row has timeIn === "" (no real clock-in). Checking it out would
  // create a record with an out-time but no in-time — block that.
  if (!rec.timeIn) return res.status(400).json({ error: "Cannot check out — no check-in recorded for this day" });
  // Checking out twice silently rewrote the recorded departure to the current clock,
  // with no trace of the original. A stale tab or a retry could therefore falsify how
  // long someone was on site, so the first check-out is final.
  // ...and "final" has to be enforced by the STATEMENT, not by the read above it. Two
  // concurrent presses both read timeOut === null, both passed this `if`, and both wrote:
  // within the same minute the stored value is identical and the damage invisible, but
  // either side of a minute boundary the recorded departure MOVES, which is exactly what
  // this rule exists to prevent. The `timeOut: null` in the WHERE is what makes the
  // database settle it — the same fix, and the same reasoning, as the `timeIn: ""` clause
  // in POST /tap-check-in above. The fast-path 409 is kept for the ordinary sequential
  // double-press, where it answers without a write.
  if (rec.timeOut) return res.status(409).json({ error: `Already checked out at ${rec.timeOut}` });
  const stamped = await prisma.checkIn.updateMany({
    where: { id: rec.id, timeOut: null },
    data: { timeOut: nowTime() },
  });
  const now = await prisma.checkIn.findUnique({ where: { id: rec.id } });
  if (!now) return res.status(404).json({ error: "Record not found" });
  // Matched nothing: somebody else's press won between the read and this write. Their
  // departure stands, and saying so is the same answer the sequential double-press gets —
  // a loser that is told it succeeded is how a stale tab falsifies a timesheet.
  if (stamped.count === 0) return res.status(409).json({ error: `Already checked out at ${now.timeOut}` });
  res.json(sCheckin(now));
});

// PUT /api/checkins  (admin) — upsert a record for any staff/date
router.put("/", requireAuth, requirePage("checkin"), async (req, res) => {
  const { staffId, date, in: tIn, out, site } = req.body || {};
  if (!staffId || !date || !tIn) return res.status(400).json({ error: "staffId, date and in required" });
  // Type checks, not just truthiness: a number or object here reached Prisma and
  // came back as an opaque 500.
  if (!isString(staffId)) return res.status(400).json({ error: "staffId must be text" });
  if (!isTime(tIn)) return res.status(400).json({ error: "in must be a time in HH:MM format" });
  if (out != null && out !== "" && !isTime(out)) return res.status(400).json({ error: "out must be a time in HH:MM format" });
  // When both times are present, out must be after in. Zero-padded 24h HH:MM strings sort
  // chronologically, so a plain string compare is enough. Records with in-only are untouched.
  if (out != null && out !== "" && out <= tIn) return res.status(400).json({ error: "Check-out must be after check-in." });
  if (!isSite(site)) return res.status(400).json({ error: "site must be Onsite or Online" });
  // Calendar validity, matching PUT /summary. Without it an admin could file a record
  // on 2026-02-30: the staff app rolls it to 2 March while the dashboard filters on
  // the exact string, so nobody can ever find the row to correct it.
  if (!isRealDate(date)) return res.status(400).json({ error: "date must be a valid calendar date in YYYY-MM-DD format" });
  const staffExists = await prisma.staff.findUnique({ where: { id: staffId } });
  if (!staffExists) return res.status(400).json({ error: "Unknown staff member" });
  // Read first, so the log can say what the record said before an administrator
  // changed it. This route writes a check-in for ANYONE on ANY date — it is how a
  // missed clock-in gets fixed, and equally how somebody's hours could be rewritten
  // after the fact. The staff member's own POST /check-in is not audited: it records
  // the present, in their own name, and cannot alter history.
  const prior = await prisma.checkIn.findUnique({ where: { staffId_date: { staffId, date } } });
  const rec = await prisma.checkIn.upsert({
    where: { staffId_date: { staffId, date } },
    update: { timeIn: tIn, timeOut: out || null, ...(site !== undefined ? { site: site || null } : {}) },
    create: { staffId, date, timeIn: tIn, timeOut: out || null, site: site || null },
  });
  audit.record(req, {
    action: prior ? "checkin.amended" : "checkin.created",
    entity: "CheckIn", entityId: rec.id,
    summary: `Check-in for ${staffExists.name} on ${date} ${prior ? "amended" : "entered"} by ${req.user.name} — ${rec.timeIn}${rec.timeOut ? " to " + rec.timeOut : " (no check-out)"}`,
    before: prior ? { timeIn: prior.timeIn, timeOut: prior.timeOut, site: prior.site } : null,
    after: { staffId, staffName: staffExists.name, date, timeIn: rec.timeIn, timeOut: rec.timeOut, site: rec.site },
  });
  res.json(sCheckin(rec));
});

// PUT /api/checkins/summary  — self, set daily summary (creates today's record if needed)
router.put("/summary", requireAuth, async (req, res) => {
  const { date, summary } = req.body || {};
  // Validate an explicit date so a malformed or calendar-invalid value can't be persisted
  // as the row key. Checked as a string first: String({toString:1}) throws, which used
  // to escape as a 500 before the regex ever ran.
  if (date != null && !isRealDate(date)) {
    return res.status(400).json({ error: "date must be a valid calendar date in YYYY-MM-DD format" });
  }
  // summary goes straight into a String column; a number or object threw inside Prisma.
  if (summary != null && !isString(summary)) return res.status(400).json({ error: "summary must be text" });
  if (isString(summary) && summary.length > MAX_TEXT) return res.status(400).json({ error: `summary is too long (${MAX_TEXT} characters maximum)` });
  const d = date || today();
  const rec = await prisma.checkIn.upsert({
    where: { staffId_date: { staffId: req.user.id, date: d } },
    update: { summary: summary || "" },
    // Deliberately empty timeIn: saving a summary for a day with no check-in must NOT
    // fabricate a clock-in time (that would invent attendance that never happened).
    // "" is the sentinel for "no check-in"; do not change this back to nowTime().
    create: { staffId: req.user.id, date: d, timeIn: "", summary: summary || "" },
  });
  res.json(sCheckin(rec));
});

module.exports = router;
