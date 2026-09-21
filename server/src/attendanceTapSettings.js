// Per-college settings for NFC tap check-in — the pure half.
//
// Split from attendanceTapConfig.js on purpose: everything here is a function of its
// arguments, so the rules a college's attendance depends on are testable without a
// database. The DB-backed resolver next door does the caching and the writing.
//
// Shape follows attendanceBandConfig.js, which is the reference implementation:
// platform defaults in code, one JSON column merged over them, an allowlist on the way
// out, and a short cache invalidated on save.

// The CIDR parser lives in presence.js beside the check that uses it, and is imported
// here rather than reimplemented: a settings screen that accepts a range the check will
// not match is worse than one that rejects it, because the college is then told their
// network is configured while every student is refused.
const { parseCidr, MAX_RADIUS_METRES } = require("./presence");

const DEFAULTS = Object.freeze({
  // Ships OFF. Attendance emails do the same, and for the same reason: a feature that
  // writes to the attendance record must not switch itself on at every college on the
  // next deploy.
  enabled: false,
  // Past this many minutes after the start, a tap records L rather than P.
  lateAfterMins: 15,
  // Minutes BEFORE the start that taps begin to be accepted. Zero is the rule as
  // specified — not before the lecture. It is a setting because a student outside the
  // door at 08:58 for a 09:00 class is a normal thing that will be reported as a bug in
  // week one, and a college that decides five minutes is fine should not need a deploy
  // to say so.
  earlyGraceMins: 0,
  // How long a tag read keeps the check-in button live in the app. Long enough to press,
  // too short to walk to another room.
  armSeconds: 60,
  // Whether the same stickers also clock staff in — and, when on, REQUIRE a tap for an
  // onsite clock-in (Online stays a plain button). Its own master switch now.
  //
  // SHIPS OFF since 13 Sep 2026, flipped from true. While staff-tap was gated on
  // `enabled && staffTapEnabled`, this being true was harmless: `enabled` (the student
  // NFC master) ships off, so the pair resolved to off anyway and true here only meant
  // "ready if student NFC is ever switched on". Decoupled, `staffTapEnabled` stands
  // alone — a true default would silently turn NFC-REQUIRED clock-in on for every
  // college that has never opened this screen, locking out anyone without a sticker to
  // hand. Off by default; a college switches it on deliberately under Attendance
  // Settings, the same standard every other capture writer here follows.
  staffTapEnabled: false,
  // Whether a lecturer can put a rotating QR code on screen and have students scan it.
  //
  // SHIPS ON, and this is a deliberate product decision taken on 4 Sep 2026, reversing the
  // default this shipped with for two days. It is recorded here because the reasoning is
  // not obvious and the obvious "tidy-up" is to put it back.
  //
  // The original default was OFF, on the reasoning that a college must not gain a second
  // way of writing to its attendance record merely because somebody deployed. That
  // reasoning was written when this platform served every college from one deployment,
  // where "somebody deployed" meant every institution at once. It now serves ONE
  // institution per deployment, so the blast radius of this default is exactly the one
  // college whose server it is, and QR check-in is the headline capability that college
  // is buying. Shipping it off meant the feature was invisible until an administrator
  // found a settings screen, which is how a capability gets reported as missing.
  //
  // What it can still never do is unchanged and is what makes the default safe: a scan
  // cannot overwrite a mark a member of staff set, cannot record an absence, cannot land
  // outside the class's own timetabled window, and cannot reach a register whose term is
  // closed. Switching this on adds a way for an enrolled student to mark THEMSELVES
  // present in the room, and nothing else.
  //
  // SEPARATE from `enabled` rather than implied by it, which has not changed. The sticker
  // switch stays OFF by default: it needs hardware the college has to buy and place, and a
  // capture method nobody has installed must not appear to be running.
  qrEnabled: true,
  // How often the on-screen code changes.
  //
  // This is the single number the feature's honesty rests on. A photographed screen works
  // until the code rotates, so this is literally how long proxy attendance stays possible
  // — and it trades directly against a student with a slow phone or poor signal, who is
  // refused if the code moves on before they can focus. It is a setting because this is
  // exactly the sort of threshold a college will want to argue about, and it should not
  // need a deploy to say so.
  //
  // TWENTY, down from thirty on 11 Sep 2026, and the change is smaller than it looks
  // because a second change came with it. The old code used to verify for the WHOLE of the
  // following window, so a code actually lived for up to twice this number: thirty seconds
  // of setting bought sixty seconds of exposure. attendanceQr.js now accepts it only for
  // GRACE_SECONDS after it leaves the screen, so the real figure went from 60 to 27 — and
  // the student with the slow phone is no worse off, because seven seconds of grace is
  // what they actually needed rather than another whole window.
  qrRotateSeconds: 20,
  // Whether a student can mark themselves present straight from their class list — no
  // sticker, no code. The app shows what the timetable says is running now and they tap
  // the one they are in.
  //
  // SHIPS OFF, AND UNLIKE qrEnabled ABOVE, THIS DEFAULT IS NOT A PRODUCT DECISION THAT
  // COULD REASONABLY GO THE OTHER WAY. Read that block first: the argument that made QR
  // safe to ship ON is that a scan still has to happen in the room — switching it on
  // "adds a way for an enrolled student to mark THEMSELVES present in the room, and
  // nothing else". This one removes the room. There is no artefact to be near and no
  // proximity to establish, so the mark records that a student SAID they were in a class
  // the timetable says is running. Every other mark in this database is an observation;
  // this is the only one that is a claim.
  //
  // A college may well want it, and refusing to build it would have been the worse
  // failure: distance and blended delivery are real, a lecturer teaching a practical
  // cannot also take a register, and a basement room with no signal defeats a camera.
  // But it changes what this college's own attendance data MEANS at a funding audit, a
  // visa compliance check or a student's appeal — and a change of that size is one an
  // institution takes deliberately, on a settings screen, with the trade-off in front of
  // them. Never one they acquire because somebody deployed. So this default stays false
  // whatever happens to the other two, and "tidying" it to match qrEnabled is the one
  // change here that cannot be undone from the data afterwards.
  //
  // What it can never do is the SAME list binding the other two, and none of it is
  // relaxed: it cannot overwrite a mark a member of staff set, cannot record an absence,
  // cannot land outside the class's own timetabled window, cannot reach a register whose
  // term is closed, and cannot reach a register the student is not on. The honest
  // difference is proximity, and only proximity.
  declareEnabled: false,

  /* ------------------------------------------------------------------ *
   * IS THE PHONE ACTUALLY IN THE BUILDING?
   *
   * These apply to ALL THREE student-made methods — the sticker, the code and the
   * "I'm here" button alike — and that uniformity is deliberate. A presence rule that
   * applied to two of the three would be a rule with a documented way round it, and
   * the way round it would be the method with the least evidence behind it.
   *
   * They deliberately do NOT apply to a mark a member of staff sets. A lecturer
   * correcting a register from home in the evening is doing their job, and refusing
   * that would break the one capture method nobody has ever doubted.
   *
   * The decision each one produces lives in presence.js, which is pure and tested
   * without a database. What lives here is only what the college chose.
   * ------------------------------------------------------------------ */

  // Whether a check-in must arrive from the college's own network.
  //
  // "Connected to the college WiFi" observed from the FAR END, and that is not a
  // compromise — it is the only portable way to observe it at all. iOS gives a browser
  // no network name whatsoever; Android gives one only behind a location permission. The
  // college's public address, by contrast, is already in front of the server on every
  // request, needs no permission, prompts nobody, and works identically on an iPhone, an
  // Android and a laptop in a computer room.
  networkCheck: false,
  // The college's public IP ranges, as CIDR ("203.0.113.0/24") or bare addresses.
  //
  // EMPTY WHILE THE CHECK IS ON MEANS REFUSE EVERYBODY, which is worth stating because
  // the opposite reading is the tempting one. Treating "no ranges" as "any range" would
  // mean an administrator ticks the box, saves, sees no error, and believes the college
  // network is enforced while every check-in on earth passes. A rule that silently stops
  // applying is worse than one that was never switched on.
  allowedNetworks: [],

  // Whether a check-in must be near one of the college's campuses.
  //
  // A CAMPUS BOUNDARY, NEVER A ROOM ONE, and the settings screen has to say so: indoor
  // GPS accuracy is 10-50 metres and worse through concrete, so this can prove "on
  // campus" and can never prove "in room B204". Room resolution is precisely what the
  // £1 stickers and the beacons are for. "Geofencing" sounds more precise than it is,
  // and a college describing its attendance controls at a funding audit needs the true
  // version rather than the impressive one.
  geofenceCheck: false,
  // How far from a campus's recorded coordinates still counts as being at it.
  //
  // Bounded at both ends in presence.js rather than here, because the floor is doing real
  // work: a 5-metre radius does not mean "very strict", it means "refuses the student
  // standing in the room", and that failure presents as "check-in never works" rather
  // than as a bad setting — so it gets blamed on the feature. Same reasoning as
  // MIN_QR_ROTATE_SECONDS above.
  geofenceRadiusM: 250,

  /* ------------------------------------------------------------------ *
   * THE SAME TWO QUESTIONS, ASKED OF STAFF
   *
   * SEPARATE FIELDS, NOT THE PAIR ABOVE WIDENED, and this is the whole decision.
   *
   * `networkCheck` and `geofenceCheck` are described to an administrator on the settings
   * screen as applying to the three STUDENT methods — the copy says so in as many words:
   * "It does not affect a lecturer taking the register." Teaching them to govern staff as
   * well would mean that every college which ticked one for students begins refusing
   * staff clock-ins on the next deploy, for a decision nobody took and nothing on screen
   * announces. That is the exact failure this file legislates against everywhere else.
   *
   * BUT THEY SHARE `allowedNetworks` AND `geofenceRadiusM`, because those describe the
   * COLLEGE, not the audience: one network, one set of campuses. Two lists that had to be
   * kept in sync would drift, and the drift would present as "check-in stopped working
   * for staff only" — which nobody connects to a settings screen edited a month earlier.
   *
   * Both OFF, like every other switch here that writes to a record the college is asked
   * to evidence.
   * ------------------------------------------------------------------ */

  // Whether a member of staff clocking in ONSITE must be on the college network.
  //
  // Never applied to Online. Somebody working from home is BY DEFINITION off the college
  // network, so checking it would refuse every honest remote clock-in and leave the
  // truthful answer unrecordable — the same reasoning that makes `staffTapEnabled` gate
  // on `site` rather than on the route.
  staffNetworkCheck: false,
  // Whether a member of staff clocking in ONSITE must be at a campus.
  //
  // A CAMPUS BOUNDARY, NEVER A ROOM ONE — see geofenceCheck above, which says why at
  // length. For staff the honest claim is smaller still: this says somebody was at the
  // college, not that they were at their desk.
  staffGeofenceCheck: false,
});

const SETTING_FIELDS = Object.freeze(Object.keys(DEFAULTS));

// A ceiling on every minute field. Without one, a typo of 600 in earlyGraceMins accepts
// a tap ten hours before the class starts — which is not a setting, it is an outage in
// the attendance record. Two hours is past any plausible intent.
const MAX_MINS = 120;
const MAX_ARM_SECONDS = 600;

// The rotation period is bounded at BOTH ends, and the floor does as much work as the
// ceiling — which is unusual here and worth saying why.
//
// Too long, and the code stops rotating in any meaningful sense: a square that lives for
// an hour is the permanent code this whole design exists to avoid, reachable by typing a
// large number into a settings box.
//
// Too short, and the feature simply does not work. A code that changes every second is
// gone before a phone at the back of a room can focus on it, and the failure presents as
// "the QR never works" rather than as a bad setting — so it gets blamed on the feature and
// switched off. Ten seconds is about the floor of what a phone camera plus a network round
// trip can actually complete.
const MIN_QR_ROTATE_SECONDS = 10;
const MAX_QR_ROTATE_SECONDS = 300;

/** A whole non-negative number within range, or null when the value is unusable. */
function wholeNumber(v, max) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  if (n < 0) return null;
  return Math.min(n, max);
}

/** A whole number of minutes within range, or null when the value is unusable. */
const minutes = wholeNumber;

// How many ranges a college may keep. A public egress is one range, or a handful across
// campuses; a list in the hundreds is a paste accident, and every entry is walked on every
// check-in. Generous enough that no real college meets it.
const MAX_NETWORKS = 32;

/**
 * The settings this college actually runs on: `base`, with any usable value from
 * `stored` merged over it.
 *
 * Always complete and always valid, so no caller needs a fallback of its own and no
 * caller can be handed a half-configured object. A stored blob can predate a rule or be
 * edited by hand in a console; an unusable value falls back rather than reaching the
 * resolver, where a NaN comparison would silently mark nobody and look exactly like a
 * quiet day.
 *
 * WHAT `base` IS FOR, AND WHY IT IS NOT ALWAYS DEFAULTS
 *
 * Reading a stored row falls back to the platform defaults, which is right: nothing else
 * is known. But saving a PATCH must fall back to what the college ALREADY had, or a
 * single bad key silently undoes a neighbouring setting somebody tuned last term — send
 * `{ lateAfterMins: "twenty" }` and a carefully chosen 30 reverts to 15, answering 200 OK.
 * Worse, `{ enabled: null }` is reachable from JSON and would switch a whole college OFF
 * while reporting success. So save() passes the current settings as the base, which makes
 * an unusable key IGNORED rather than reset. That is what the PATCH contract in
 * attendanceTapConfig.save() actually promises.
 */
function merge(stored, base = DEFAULTS) {
  const out = { ...base };
  if (!stored || typeof stored !== "object") return out;

  // Booleans are compared identically, not coerced. "false" and 0 are both mistakes
  // somewhere in a chain of JSON, and reading either as consent to switch a college on
  // is the wrong failure to choose.
  if (stored.enabled === true || stored.enabled === false) out.enabled = stored.enabled;
  if (stored.staffTapEnabled === true || stored.staffTapEnabled === false) out.staffTapEnabled = stored.staffTapEnabled;

  const late = minutes(stored.lateAfterMins, MAX_MINS);
  if (late !== null) out.lateAfterMins = late;

  const grace = minutes(stored.earlyGraceMins, MAX_MINS);
  if (grace !== null) out.earlyGraceMins = grace;

  const arm = minutes(stored.armSeconds, MAX_ARM_SECONDS);
  if (arm !== null) out.armSeconds = arm;

  if (stored.qrEnabled === true || stored.qrEnabled === false) out.qrEnabled = stored.qrEnabled;

  // Compared identically, exactly like `enabled` and `qrEnabled` above, and for a sharper
  // version of the same reason. `"false"` and `0` are both mistakes somewhere in a chain
  // of JSON; reading either as consent would switch a college's attendance record from
  // observation to declaration by accident. Anything that is not a literal boolean falls
  // through to the base — which, for a college that has never opened this screen, is
  // DEFAULTS and therefore off.
  if (stored.declareEnabled === true || stored.declareEnabled === false) out.declareEnabled = stored.declareEnabled;

  if (stored.networkCheck === true || stored.networkCheck === false) out.networkCheck = stored.networkCheck;
  if (stored.geofenceCheck === true || stored.geofenceCheck === false) out.geofenceCheck = stored.geofenceCheck;

  // Compared identically, exactly like the student pair above. A college's staff being
  // locked out of clocking in is not a failure that announces itself — it presents as
  // "the app is broken" at 08:45 on a Monday — so no coerced value is read as consent.
  if (stored.staffNetworkCheck === true || stored.staffNetworkCheck === false) out.staffNetworkCheck = stored.staffNetworkCheck;
  if (stored.staffGeofenceCheck === true || stored.staffGeofenceCheck === false) out.staffGeofenceCheck = stored.staffGeofenceCheck;

  // THE ONLY ARRAY IN THIS SETTINGS OBJECT, so it is the only field where "unusable" is
  // not all-or-nothing, and the choice made here needs saying.
  //
  // Entries that do not parse are DROPPED, and the rest are kept. A college pasting four
  // ranges from a network diagram will get one line wrong, and throwing away the other
  // three — or refusing the save outright — punishes them for the typo by taking down
  // check-in for everybody. The route that accepts the save is where an administrator is
  // TOLD which lines were rejected; this is the last line of defence for a blob that was
  // written before a rule existed or edited by hand in a console.
  //
  // Dropping every entry is not the same as sending none: `allowedNetworks: []` with the
  // check on refuses everybody by name (see presence.js), so a college whose whole list
  // was nonsense finds out immediately rather than running unprotected.
  //
  // Not an array at all — a bare string, an object, null — falls through to the base
  // untouched, exactly like every other unusable value here, because that is a shape
  // error rather than a content one and the PATCH contract promises to ignore it.
  if (Array.isArray(stored.allowedNetworks)) {
    const seen = new Set();
    const kept = [];
    for (const entry of stored.allowedNetworks) {
      if (kept.length >= MAX_NETWORKS) break;
      const parsed = parseCidr(entry);
      if (!parsed) continue;
      // Deduplicated on the PARSED form, not the typed one: "203.0.113.0/24" and
      // "203.0.113.7/24" are the same network written two ways, and a college that typed
      // both should not carry two copies of it forward for ever.
      const key = `${parsed.base}/${parsed.bits}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // The TYPED text is stored, not the canonical form, so an administrator opening the
      // screen sees the line they wrote. Only presence.js needs the parsed version, and it
      // parses again at the point of use.
      kept.push(parsed.text);
    }
    out.allowedNetworks = kept;
  }

  // Metres, so `minutes()` next door is the wrong helper however similar the arithmetic
  // looks — reusing it would leave a settings field whose validation is named after a
  // unit it does not use, which is the sort of thing that survives until somebody changes
  // the minute cap and silently changes a radius.
  const radius = wholeNumber(stored.geofenceRadiusM, MAX_RADIUS_METRES);
  if (radius !== null) out.geofenceRadiusM = radius;

  // Clamped rather than merely capped, because this field has a meaningful floor. Note
  // `minutes()` is reused for the range check but returns null for anything unusable, so a
  // bad value still falls through to the base — ignored, not reset, as the PATCH contract
  // promises. A usable-but-too-small number is raised to the floor rather than ignored:
  // somebody typing 5 meant "as fast as possible", not "leave it alone".
  const rotate = minutes(stored.qrRotateSeconds, MAX_QR_ROTATE_SECONDS);
  if (rotate !== null) out.qrRotateSeconds = Math.max(MIN_QR_ROTATE_SECONDS, rotate);

  return out;
}

/**
 * Would this settings object refuse every member of staff? A message if so, else null.
 *
 * PURE, and applied to the MERGED result rather than to the patch, because a PATCH that
 * sends only `{ staffNetworkCheck: true }` is exactly the dangerous one: the ranges it
 * would be judged against are the ones already stored, which the patch never mentions.
 *
 * ONLY THE NETWORK CHECK HAS ONE. The geofence reaches the same dead end — switched on
 * with no campus located — but the fix for that lives on a different screen (a campus's
 * coordinates), so refusing the save would leave an administrator unable to express the
 * intent at all. That one is caught at the point of use and shouted about in the log
 * instead, which is what the student path already does.
 *
 * Why refuse rather than warn: `allowedNetworks: []` with the check ON refuses everybody
 * by name, and presence.js is right to do that — "no ranges" must never read as "any
 * range". But it means an administrator can tick a box, see a successful save, and lock
 * out a whole college while the screen reports the network is enforced. The save is the
 * last moment anybody is looking.
 */
function staffNetworkGuard(settings) {
  if (!settings || settings.staffNetworkCheck !== true) return null;
  const list = settings.allowedNetworks;
  if (Array.isArray(list) && list.length > 0) return null;
  return "Add at least one college IP range before requiring staff to clock in from the college network — with none saved, every clock-in would be refused.";
}

module.exports = {
  DEFAULTS, SETTING_FIELDS, MAX_MINS, MAX_ARM_SECONDS, MAX_NETWORKS,
  MIN_QR_ROTATE_SECONDS, MAX_QR_ROTATE_SECONDS, merge, staffNetworkGuard,
};
