// NFC tap check-in — what a tap must never be able to do.
//
// A student taps a sticker in the app and their attendance mark is written with the
// minute they arrived; a staff member taps the same sticker and is clocked in Onsite.
// Both write to records the college is asked to evidence at a funding audit, a visa
// compliance check, or a student's appeal — so this suite spends most of its assertions
// on refusals rather than on the happy path.
//
// The two that matter most, and would otherwise be missed:
//
//   * a tap cannot overwrite a mark a lecturer already set. The suite plants an A, taps,
//     and asserts the A survived with checkedInAt still null.
//   * a later register save cannot overwrite checkedInAt. takenAt IS reset on every
//     save — that is the whole reason the column exists — so the suite taps, saves a
//     correction over it, and asserts the arrival time is unchanged.
//
//   node scripts/smoke-nfc-tap.mjs
//   (needs API_URL + DATABASE_URL; the runner supplies both)
import { createRequire } from "node:module";
import { fixtureDepartmentFor, stamp } from "./lib/fixture-department.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "..", "server");
const require = createRequire(pathToFileURL(join(server, "package.json")));

const BASE = process.env.API_URL || "http://localhost:4000/api";
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required — point it at a throwaway database.");
  process.exit(1);
}

const { PrismaClient } = require(join(server, "node_modules", "@prisma", "client"));
const bcrypt = require(join(server, "node_modules", "bcryptjs"));
// A BARE client, and not the one the API writes through, so this suite can plant fixtures the
// API would refuse to create (a lecturer's A on a register nobody has opened, a tag
// belonging to another college) and then read back what the API actually wrote rather
// than what it claims to have written.
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const SEED_PASSWORD = process.env.SEED_PASSWORD || "test-seed-password-2026";
const RUN = Date.now().toString(36);

const A_ID = "st-100121";
const A_EMAIL = "100121@edtech.co.uk";
const A_PASSWORD = "nfc-tap-suite-2026";
// A second seeded student, used only for the term-lock block, where the point is that
// exactly one class is running for them.
const B_ID = "st-100122";
const B_EMAIL = "100122@edtech.co.uk";
// A THIRD seeded student, and the reason is the rate limiter rather than tidiness.
//
// The student tap route allows 10 taps per 60 seconds per student, and A_ID makes
// EXACTLY ten of them above — the suite already sits on the ceiling, so an eleventh tap
// anywhere in this file would come back 429 and the assertion it belongs to would be
// testing the limiter instead of whatever it was written for. C_ID starts a fresh
// budget, and the blocks below spend six of its ten. C_ID is also seeded with no
// sessions today, which is what lets those blocks build an exact timetable: "two classes
// running" has to mean two and not two-plus-whatever-the-seed-had, or the ambiguous
// response cannot be counted.
const C_ID = "st-100126";
const C_EMAIL = "100126@edtech.co.uk";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

async function call(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch (_) { /* empty body */ }
  return { status: res.status, data };
}

const login = (email, password) => call("/auth/login", { method: "POST", body: { email, password } });

/** "HH:MM" now, in the same zone the server stamps with. */
const nowHHMM = () => new Date().toLocaleTimeString("en-GB", { timeZone: process.env.APP_TIMEZONE || "Europe/London", hour: "2-digit", minute: "2-digit" });
const todayLocal = () => new Date().toLocaleDateString("en-CA", { timeZone: process.env.APP_TIMEZONE || "Europe/London" });
const shift = (hhmm, mins) => {
  const [h, m] = hhmm.split(":").map(Number);
  const t = Math.max(0, Math.min(23 * 60 + 59, h * 60 + m + mins));
  return String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
};

// Everything this run creates, so the finally block puts the database back exactly as
// the seed left it — the suites share one seeded database and it is not re-run between
// them.
const made = { tags: [], sessions: [], units: [], enrolments: [], marks: [], taps: [], checkIns: [], terms: [], cohorts: [], courses: [] };
// Seeded sessions parked out of the way for the duration — see the setup block below.
let parkedSessionIds = [];
let configExisted = false, priorConfig = null;

async function cleanup() {
  try {
    // Un-park the seeded sessions FIRST: they are the only thing here that belongs to
    // another suite, and leaving them dated 1970 would quietly empty today's register
    // for everything that runs after this.
    if (parkedSessionIds.length) {
      await db.hndSession.updateMany({ where: { id: { in: parkedSessionIds } }, data: { date: todayLocal() } })
        .catch(() => {});
    }
    for (const id of made.taps) await db.tagTap.delete({ where: { id } }).catch(() => {});
    for (const id of made.marks) await db.attendanceMark.delete({ where: { id } }).catch(() => {});
    for (const id of made.checkIns) await db.checkIn.delete({ where: { id } }).catch(() => {});
    // Taps cascade with their tag; marks cascade with their session.
    for (const id of made.tags) await db.attendanceTag.delete({ where: { id } }).catch(() => {});
    for (const id of made.sessions) await db.hndSession.delete({ where: { id } }).catch(() => {});
    for (const id of made.enrolments) await db.enrolment.delete({ where: { id } }).catch(() => {});
    for (const id of made.units) await db.unit.delete({ where: { id } }).catch(() => {});
    // Terms after units (a unit points at one), then the cohort and course they hang off.
    for (const id of made.terms) await db.term.delete({ where: { id } }).catch(() => {});
    for (const id of made.cohorts) await db.cohort.delete({ where: { id } }).catch(() => {});
    for (const id of made.courses) await db.course.delete({ where: { id } }).catch(() => {});

    // Put the tap config back exactly as it was. Leaving a college switched ON is the
    // one piece of state here that would change how the product behaves for real users.
    if (configExisted) {
      // No filter: AttendanceTapConfig is the institution's single row now that one
      // deployment serves one college, so "the config" and "every config" are the same set.
      await db.attendanceTapConfig.updateMany({ data: { settings: priorConfig } }).catch(() => {});
    } else {
      await db.attendanceTapConfig.deleteMany({}).catch(() => {});
    }

    // The seeded students have NO password and tokenVersion 0. Restore both — a student
    // left signable-in by a test run is a real account with a known password.
    await db.student.update({ where: { id: A_ID }, data: { passwordHash: null, tokenVersion: 0 } }).catch(() => {});
    await db.student.update({ where: { id: B_ID }, data: { passwordHash: null, tokenVersion: 0 } }).catch(() => {});
    await db.student.update({ where: { id: C_ID }, data: { passwordHash: null, tokenVersion: 0 } }).catch(() => {});
  } catch (e) {
    console.error("cleanup problem:", e.message);
  }
}

try {
  const existingConfig = await db.attendanceTapConfig.findFirst({});
  configExisted = Boolean(existingConfig);
  priorConfig = existingConfig?.settings ?? {};

  const adminLogin = await login("admin@edtech.co.uk", SEED_PASSWORD);

  // The department the signing-in admin is narrowed to, if any. Null on the ordinary pass

  // (nothing stamped, fixtures exactly as before); under SMOKE_SCOPED_DEPARTMENT=1 it is

  // the one department everything seeded belongs to, and every unit, course and cohort

  // this suite builds carries it — so the same assertions hold on the guard's other side.

  const DEPT = await fixtureDepartmentFor(db, "admin@edtech.co.uk");
  const adminToken = adminLogin.data?.token;
  if (!adminToken) throw new Error(`admin sign-in failed (HTTP ${adminLogin.status}) — cannot run this suite`);

  await db.student.update({ where: { id: A_ID }, data: { passwordHash: bcrypt.hashSync(A_PASSWORD, 10), tokenVersion: 0 } });
  const sLogin = await login(A_EMAIL, A_PASSWORD);
  const sToken = sLogin.data?.token;
  if (!sToken) throw new Error(`student sign-in failed (HTTP ${sLogin.status}) — cannot run this suite`);

  /* ====================================================================== */
  console.log("\n--- the feature ships switched off ---");
  /* ====================================================================== */

  // Deliberately BEFORE the config is enabled. A college that has never heard of this
  // feature must not have its registers writable by anybody holding a student token.
  await db.attendanceTapConfig.deleteMany({});
  const offTap = await call("/student/me/tap-check-in", { method: "POST", token: sToken, body: { tagCode: "anything" } });
  check("a student tap is refused while the feature is off", offTap.status === 403, `HTTP ${offTap.status}`);

  const offStaff = await call("/checkins/tap-check-in", { method: "POST", token: adminToken, body: { tagCode: "anything" } });
  check("a staff tap is refused while the feature is off", offStaff.status === 403, `HTTP ${offStaff.status}`);
  // The refusal row carries its capture method. A NULL method is defined by the schema
  // as "written before the column existed", so a fresh refusal writing NULL would read
  // as pre-feature history to the administrator triaging it.
  const offStaffRow = await db.tagTap.findFirst({
    where: { staffId: { not: null }, outcome: "disabled" },
    orderBy: { at: "desc" },
  });
  check("and the staff refusal row says how the tap arrived", offStaffRow?.method === "nfc",
    `method=${offStaffRow?.method ?? "null"}`);

  const offCtx = await call("/student/me/tap-context", { token: sToken });
  // The contract changed deliberately, and this assertion changed with it.
  //
  // It used to require `now === null` while enabled returned an array — one field with
  // two shapes, which a client has to special-case. It is `[]` in both cases now.
  //
  // It also used to be titled "rather than leaking the timetable". Returning the day IS
  // the behaviour now, and it is not a leak: this route is keyed on req.user.id with no
  // id parameter, so a student sees their own classes and nobody else's — the same ones
  // /me/timetable already gives them. What must stay hidden while the feature is off is
  // the CHECK-IN state, and `enabled: false` is what says so.
  //
  // THE EMPTY-`now` HALF WAS STALE FROM 4 SEPTEMBER AND THIS SUITE DID NOT SAY SO.
  //
  // Deleting the config row leaves the DEFAULTS, and the defaults changed when QR
  // check-in shipped switched on: `enabled: false, qrEnabled: true`. The route empties
  // `now` only when BOTH capture methods are off, which is right — a QR-only college's
  // students must still be told which class is running, or they have nothing to scan
  // against. So with no row at all the day is legitimately returned, and requiring
  // `now.length === 0` asserted a contract the product had deliberately left behind.
  //
  // It survived because it is ORDER-DEPENDENT: the config is cached for 30 seconds in
  // the API process, so in a full run an earlier suite's switch-off was still being
  // served here and the assertion passed on someone else's state. Run alone it failed —
  // at this commit, at the merge that shipped QR, and on production today.
  //
  // The assertion keeps the property it is named for — ONE SHAPE for `now`, an array in
  // every case, never null — and drops the emptiness it can no longer mean.
  check("tap-context reports disabled, with one shape for `now` rather than two",
    offCtx.status === 200 && offCtx.data?.enabled === false && Array.isArray(offCtx.data?.now),
    `HTTP ${offCtx.status} enabled=${offCtx.data?.enabled} now=${JSON.stringify(offCtx.data?.now)}`);

  // Switch it on THROUGH THE API, not by writing the row directly.
  //
  // Not a stylistic choice: the config is cached for 30 seconds, and the
  // disabled assertions above have just populated that cache with enabled:false. A
  // direct row write would leave the running API refusing every tap for half a minute,
  // which is what the first run of this suite actually did. save() invalidates the
  // cache, so going through the endpoint is also the only way to test the path a real
  // administrator uses.
  const turnedOn = await call("/tags/settings", {
    method: "PUT", token: adminToken,
    body: { enabled: true, lateAfterMins: 15, earlyGraceMins: 0, armSeconds: 60, staffTapEnabled: true },
  });
  check("an administrator can switch tap check-in on",
    turnedOn.status === 200 && turnedOn.data?.enabled === true,
    `HTTP ${turnedOn.status}`);

  const settingsSeen = await call("/tags/settings", { token: adminToken });
  check("the settings read back as saved", settingsSeen.data?.lateAfterMins === 15 && settingsSeen.data?.enabled === true, "");

  const studentReadsSettings = await call("/tags/settings", { token: sToken });
  check("a student cannot read the tap settings", studentReadsSettings.status === 403, `HTTP ${studentReadsSettings.status}`);

  // A patch, not a replacement: changing one key must not reset the others.
  await call("/tags/settings", { method: "PUT", token: adminToken, body: { lateAfterMins: 20 } });
  const patched = await call("/tags/settings", { token: adminToken });
  check("changing one setting does not reset the others",
    patched.data?.lateAfterMins === 20 && patched.data?.enabled === true,
    `lateAfterMins=${patched.data?.lateAfterMins} enabled=${patched.data?.enabled}`);

  // The other half of the PATCH contract, and the sharper half: what happens to a key
  // that arrives UNUSABLE. `{ enabled: null }` is reachable from any JSON client, and
  // merge() drops it and falls back to its base — so the answer depends entirely on
  // whether save() passes the college's CURRENT settings as that base or the platform
  // defaults. With DEFAULTS as the base, this single null switches the whole college
  // OFF while answering 200 OK, and the neighbouring 30 somebody tuned reverts to 15.
  // Both halves are asserted together on purpose: `enabled` alone would pass against a
  // save() that ignored the patch entirely, and `lateAfterMins` alone would pass against
  // one that never looked at `enabled`.
  await call("/tags/settings", { method: "PUT", token: adminToken, body: { lateAfterMins: 30 } });
  const nulled = await call("/tags/settings", { method: "PUT", token: adminToken, body: { enabled: null } });
  const afterNull = await call("/tags/settings", { token: adminToken });
  check("an unusable setting is IGNORED, not reset to the platform default",
    nulled.status === 200 && afterNull.data?.lateAfterMins === 30 && afterNull.data?.enabled === true,
    `HTTP ${nulled.status} lateAfterMins=${afterNull.data?.lateAfterMins} enabled=${afterNull.data?.enabled}`);

  await call("/tags/settings", { method: "PUT", token: adminToken, body: { lateAfterMins: 15 } });

  /* ====================================================================== */
  console.log("\n--- registering a sticker ---");
  /* ====================================================================== */

  const created = await call("/tags", { method: "POST", token: adminToken, body: { label: `Smoke Room ${RUN}` } });
  const tagCode = created.data?.code;
  if (created.data?.id) made.tags.push(created.data.id);
  check("registering a tag returns its code exactly once", created.status === 201 && typeof tagCode === "string" && tagCode.length > 20, `HTTP ${created.status}`);

  const listed = await call("/tags", { token: adminToken });
  const listedMine = (listed.data || []).find((t) => t.id === created.data?.id);
  check("the tag list never includes codes", listed.status === 200 && !!listedMine && !("code" in listedMine), `HTTP ${listed.status}`);

  const noLabel = await call("/tags", { method: "POST", token: adminToken, body: { label: "  " } });
  check("a tag with no label is refused", noLabel.status === 400, `HTTP ${noLabel.status}`);

  const studentMakesTag = await call("/tags", { method: "POST", token: sToken, body: { label: "nope" } });
  check("a student token cannot reach the tag admin at all", studentMakesTag.status === 403, `HTTP ${studentMakesTag.status}`);

  /* ---------------------------------------------------------------------- */
  // Registering a BLANK sticker: the admin taps a factory tag on a phone and the app
  // sends its UID as `code`, rather than a secret being generated here and written onto
  // the tag with a separate NFC tool. Nothing exercised this path at all — every tag in
  // this suite was previously created without a code — so the whole `supplied` branch of
  // POST /tags and its two guards shipped unread. (It also had a cross-tenant clash
  // check; that branch went with multi-tenancy, and so did the assertion covering it.)
  /* ---------------------------------------------------------------------- */

  const codeNotText = await call("/tags", { method: "POST", token: adminToken, body: { label: `Numeric ${RUN}`, code: 12345678 } });
  check("a code that is not text is refused", codeNotText.status === 400, `HTTP ${codeNotText.status}`);

  // "room1" is the shape of the mistake this guard exists for: a human-chosen code short
  // enough to guess is a check-in anybody can manufacture from the corridor.
  const codeTooShort = await call("/tags", { method: "POST", token: adminToken, body: { label: `Short ${RUN}`, code: "room1" } });
  check("a code shorter than eight characters is refused", codeTooShort.status === 400, `HTTP ${codeTooShort.status}`);

  // Twelve characters, the length of a real 6-byte tag UID in hex.
  const suppliedCode = ("uid" + RUN + "000000").slice(0, 12);
  const byUid = await call("/tags", { method: "POST", token: adminToken, body: { label: `Blank Sticker ${RUN}`, code: suppliedCode } });
  if (byUid.data?.id) made.tags.push(byUid.data.id);
  // Equality with the code SENT, not merely "a code came back". A route that ignored the
  // supplied value and generated a secret instead would answer 201 with a perfectly
  // plausible body, and every sticker registered by tapping it would then be unusable —
  // the tag on the wall holds the UID, and the database would hold something else.
  check("a supplied code is stored as given, not quietly regenerated",
    byUid.status === 201 && byUid.data?.code === suppliedCode,
    `HTTP ${byUid.status} code=${byUid.data?.code}`);
  const uidRow = byUid.data?.id ? await db.attendanceTag.findUnique({ where: { id: byUid.data.id } }) : null;
  check("...and that is the code the database actually holds",
    uidRow?.code === suppliedCode,
    `stored=${uidRow?.code}`);

  /* ====================================================================== */
  console.log("\n--- an unknown or retired tag ---");
  /* ====================================================================== */

  const unknown = await call("/student/me/tap-check-in", { method: "POST", token: sToken, body: { tagCode: `no-such-code-${RUN}` } });
  check("an unknown tag code is refused", unknown.status === 404, `HTTP ${unknown.status}`);

  const retired = await db.attendanceTag.create({ data: { code: `retired-${RUN}`, label: `Retired ${RUN}`, active: false } });
  made.tags.push(retired.id);
  const retiredTap = await call("/student/me/tap-check-in", { method: "POST", token: sToken, body: { tagCode: retired.code } });
  check("a retired tag is refused, and reads identically to one that never existed",
    retiredTap.status === 404 && retiredTap.data?.error === unknown.data?.error,
    `HTTP ${retiredTap.status}`);

  // REMOVED: the cross-college tag block, and its SKIP branch.
  //
  // It planted an AttendanceTag under a second Tenant and asserted four things: that
  // tapping it here answered 404 rather than anything confirming it existed; that
  // re-registering its code was refused with a 409; that the 409 body's keys were EXACTLY
  // ["error"], carrying no hint of the other college's label, id or registration date; and
  // that no row was created here under a code this college did not own.
  //
  // All four rested on a second institution existing in the same database. There is no
  // second institution and no crossTenantTagExists() probe left in routes/tags.js, so the
  // block has nothing to plant and nothing to assert against. Note that it ALREADY printed
  // SKIP on every single-college run, which is most of them — deleting it changes what the
  // summary line claims, not what was actually being exercised.
  //
  // What survives in tenant-free form, and where:
  //   * a 404 for a code that is not ours — the unknown-tag and retired-tag checks
  //     immediately above, which already require the two refusals to read identically;
  //   * a re-registration is refused, not duplicated, and writes nothing — the LIVE-sticker
  //     clash further down, which now also counts the rows holding that code;
  //   * a PATCH against a tag id we do not hold — the 404 for an id that does not exist.
  //
  // What does NOT survive, recorded rather than quietly dropped: "the refusal carries
  // nothing but the message". That was specifically about not naming ANOTHER institution's
  // sticker, and our own live sticker's 409 deliberately DOES name its label — an admin is
  // entitled to know which of their own rows they are looking at. There is no tenant-free
  // version of it, because the thing it protected no longer exists.

  /* ====================================================================== */
  console.log("\n--- the lecture's own hours are the window ---");
  /* ====================================================================== */

  const today = todayLocal();
  const now = nowHHMM();

  // PARK EVERY SESSION THE SEED ALREADY PUT ON TODAY, OR THIS SUITE ONLY PASSES AFTER
  // THE COLLEGE HAS GONE HOME.
  //
  // The students here are the seeded ones, and they are enrolled in seeded units. The
  // seed timetables those units during ordinary teaching hours — there is a 10:00-13:00
  // lecture today — so resolveTapSession sees it as a candidate alongside the sessions
  // this suite creates. Two consequences, both of which look like product bugs and are
  // not: a tap meant to be refused because "the lecture has ended" succeeds against the
  // seeded lecture instead, and a tap meant to resolve to one session comes back
  // "ambiguous" because two are genuinely running.
  //
  // It went unnoticed because the suite is usually run in the evening, when nothing is
  // timetabled. Moved to a date far in the past rather than deleted, and restored in
  // cleanup, so the seed is untouched for the suites that run after this one.
  const preexisting = await db.hndSession.findMany({ where: { date: today }, select: { id: true } });
  parkedSessionIds = preexisting.map((s) => s.id);
  if (parkedSessionIds.length) {
    await db.hndSession.updateMany({ where: { id: { in: parkedSessionIds } }, data: { date: "1970-01-01" } });
  }

  const unit = await db.unit.create({
    data: { ...stamp(DEPT), code: `NFC${RUN}`.slice(0, 12), name: `Tap Suite Unit ${RUN}`, startDate: today, endDate: today },
  });
  made.units.push(unit.id);
  const enrol = await db.enrolment.create({ data: { studentId: A_ID, unitId: unit.id } });
  made.enrolments.push(enrol.id);

  // A class that finished an hour ago.
  const past = await db.hndSession.create({
    data: { unitId: unit.id, date: today, startTime: shift(now, -180), endTime: shift(now, -60), description: "past" },
  });
  made.sessions.push(past.id);
  const tooLate = await call("/student/me/tap-check-in", { method: "POST", token: sToken, body: { tagCode } });
  check("a tap after the lecture has ended is refused",
    tooLate.status === 409 && tooLate.data?.reason === "no_session_now",
    `HTTP ${tooLate.status} ${tooLate.data?.reason || ""}`);

  // A class that starts in an hour. earlyGraceMins is 0, so this is still refused.
  const future = await db.hndSession.create({
    data: { unitId: unit.id, date: today, startTime: shift(now, 60), endTime: shift(now, 180), description: "future" },
  });
  made.sessions.push(future.id);
  const tooEarly = await call("/student/me/tap-check-in", { method: "POST", token: sToken, body: { tagCode } });
  check("a tap before the lecture starts is refused",
    tooEarly.status === 409 && tooEarly.data?.reason === "no_session_now",
    `HTTP ${tooEarly.status} ${tooEarly.data?.reason || ""}`);

  /* ====================================================================== */
  console.log("\n--- marking, with the minute ---");
  /* ====================================================================== */

  // A class that started five minutes ago: inside the window, inside the late threshold.
  const live = await db.hndSession.create({
    data: { unitId: unit.id, date: today, startTime: shift(now, -5), endTime: shift(now, 115), description: "live" },
  });
  made.sessions.push(live.id);

  const marked = await call("/student/me/tap-check-in", { method: "POST", token: sToken, body: { tagCode } });
  check("a tap during the lecture is marked Present",
    marked.status === 201 && marked.data?.status === "P",
    `HTTP ${marked.status} ${marked.data?.status || marked.data?.error || ""}`);

  const markRow = await db.attendanceMark.findFirst({ where: { sessionId: live.id, studentId: A_ID } });
  if (markRow) made.marks.push(markRow.id);
  check("checkedInAt records the minute, not a timestamp",
    !!markRow && /^\d{2}:\d{2}$/.test(markRow.checkedInAt || ""),
    `checkedInAt=${markRow?.checkedInAt}`);
  check("the mark is stamped as a self check-in, not as a lecturer's",
    !!markRow && markRow.takenBy === "Self check-in (NFC)",
    `takenBy=${markRow?.takenBy}`);

  // The tap log must say which capture path this was. "nfc" on new rows only — rows
  // from before the method column existed stay null, because the absence of a record
  // is not a record of NFC.
  const tapRow = await db.tagTap.findFirst({
    where: { studentId: A_ID, sessionId: live.id, outcome: "marked" },
    orderBy: { at: "desc" },
  });
  if (tapRow) made.taps.push(tapRow.id);
  check("an accepted tap's log row records the method as nfc",
    !!tapRow && tapRow.method === "nfc",
    `method=${tapRow?.method}`);

  const firstCheckedInAt = markRow?.checkedInAt;

  // Tapping again must not create a second mark or move the arrival time.
  const again = await call("/student/me/tap-check-in", { method: "POST", token: sToken, body: { tagCode } });
  const markCount = await db.attendanceMark.count({ where: { sessionId: live.id, studentId: A_ID } });
  const afterAgain = await db.attendanceMark.findFirst({ where: { sessionId: live.id, studentId: A_ID } });
  check("a second tap does not create a second mark",
    again.status === 200 && again.data?.alreadyMarked === true && markCount === 1,
    `HTTP ${again.status}, ${markCount} mark(s)`);
  check("a second tap does not move the recorded arrival time",
    afterAgain?.checkedInAt === firstCheckedInAt,
    `${firstCheckedInAt} -> ${afterAgain?.checkedInAt}`);

  /* ====================================================================== */
  console.log("\n--- what a tap must never overwrite ---");
  /* ====================================================================== */

  // THE ONE THAT MATTERS. A lecturer marked this student absent. A tap must not turn
  // that into a P — where two sources disagree, the human who was in the room wins.
  const lecturerSession = await db.hndSession.create({
    data: { unitId: unit.id, date: today, startTime: shift(now, -4), endTime: shift(now, 116), description: "lecturer marked" },
  });
  made.sessions.push(lecturerSession.id);
  const plantedA = await db.attendanceMark.create({
    data: { sessionId: lecturerSession.id, studentId: A_ID, status: "A", remark: "", takenBy: "Ms Lecturer" },
  });
  made.marks.push(plantedA.id);

  // sessionId is explicit ON PURPOSE. Two sessions are running by now, so a bare tap
  // comes back "ambiguous" and never reaches the overwrite guard at all — the A would
  // survive for the wrong reason and this test would prove nothing. Naming the session
  // is what forces the tap to actually attempt the overwrite.
  const overTap = await call("/student/me/tap-check-in", {
    method: "POST", token: sToken, body: { tagCode, sessionId: lecturerSession.id },
  });
  const stillA = await db.attendanceMark.findUnique({ where: { id: plantedA.id } });
  check("a tap CANNOT overwrite a mark the lecturer already set",
    stillA?.status === "A" && stillA?.takenBy === "Ms Lecturer" && overTap.data?.alreadyMarked === true,
    `status=${stillA?.status} takenBy=${stillA?.takenBy} alreadyMarked=${overTap.data?.alreadyMarked} (HTTP ${overTap.status})`);
  check("and it does not invent an arrival time for a mark it did not write",
    stillA?.checkedInAt === null,
    `checkedInAt=${stillA?.checkedInAt}`);

  // THE OTHER ONE. takenAt IS reset on every register save; checkedInAt must not be.
  // This is the entire reason the column exists.
  const beforeSave = await db.attendanceMark.findFirst({ where: { sessionId: live.id, studentId: A_ID } });
  const saved = await call(`/hnd/sessions/${live.id}/register`, {
    method: "PUT", token: adminToken,
    body: { marks: [{ studentId: A_ID, status: "L", remark: "corrected by the tutor" }] },
  });
  const afterSave = await db.attendanceMark.findFirst({ where: { sessionId: live.id, studentId: A_ID } });
  check("a later register save does NOT overwrite checkedInAt",
    saved.status === 200 && afterSave?.checkedInAt === beforeSave?.checkedInAt && afterSave?.status === "L",
    `HTTP ${saved.status}, ${beforeSave?.checkedInAt} -> ${afterSave?.checkedInAt}, status ${afterSave?.status}`);
  // takenBy, not takenAt. The two writes land inside the same second on a fast machine,
  // so comparing timestamps proves nothing — the first version of this assertion passed
  // with 22:21:41 on both sides. takenBy genuinely changes hands: the tap stamps
  // "Self check-in (NFC)" and the register save stamps the administrator's name. That
  // the row WAS rewritten while checkedInAt survived is the whole point of the pair.
  check("the save really did rewrite the mark — provenance changed hands",
    beforeSave?.takenBy === "Self check-in (NFC)" && afterSave?.takenBy && afterSave.takenBy !== "Self check-in (NFC)",
    `takenBy ${beforeSave?.takenBy} -> ${afterSave?.takenBy}`);

  /* ====================================================================== */
  console.log("\n--- enrolment is what makes a student eligible ---");
  /* ====================================================================== */

  const strangerUnit = await db.unit.create({
    data: { ...stamp(DEPT), code: `NOEN${RUN}`.slice(0, 12), name: `Not Enrolled ${RUN}`, startDate: today, endDate: today },
  });
  made.units.push(strangerUnit.id);
  const strangerSession = await db.hndSession.create({
    data: { unitId: strangerUnit.id, date: today, startTime: shift(now, -3), endTime: shift(now, 117), description: "not enrolled" },
  });
  made.sessions.push(strangerSession.id);
  // This block previously made NO HTTP call at all: it created a session and asserted no
  // mark existed for it, which is true of any session nobody has tapped. Deleting the
  // whole enrolment filter from candidateSessions() left it green. It now actually taps,
  // naming the session explicitly so the request cannot be brushed off as ambiguous.
  const strangerTap = await call("/student/me/tap-check-in", {
    method: "POST", token: sToken, body: { tagCode, sessionId: strangerSession.id },
  });
  const strangerMark = await db.attendanceMark.findFirst({ where: { sessionId: strangerSession.id, studentId: A_ID } });
  check("a tap naming a unit the student is not enrolled on writes nothing",
    strangerTap.status === 409 && strangerMark === null,
    `HTTP ${strangerTap.status}${strangerMark ? " — A MARK WAS WRITTEN on a unit they are not on" : ""}`);
  check("...and the refusal never names that session back to them",
    !JSON.stringify(strangerTap.data || {}).includes(strangerSession.id),
    "");

  /* ====================================================================== */
  /* ====================================================================== */
  console.log("\n--- a retired sticker can be brought back ---");
  /* ====================================================================== */

  // Retiring a sticker used to destroy it. The code is globally unique, so re-registering
  // the same physical tag hit "already registered" forever with no route out — the Retire
  // button paused a sticker in the UI and permanently consumed it in the database. Nobody
  // would notice until a college tried to put a peeled-off sticker back on the wall.
  const reuseCode = `reuse-${RUN}-${Math.abs(RUN.length * 7919)}`;
  const firstReg = await call("/tags", { method: "POST", token: adminToken, body: { label: `Reusable ${RUN}`, code: reuseCode } });
  if (firstReg.data?.id) made.tags.push(firstReg.data.id);
  check("a sticker can be registered by its own identifier",
    firstReg.status === 201 && firstReg.data?.code === reuseCode,
    `HTTP ${firstReg.status}`);

  await call(`/tags/${firstReg.data?.id}`, { method: "PATCH", token: adminToken, body: { active: false } });

  const restored = await call("/tags", { method: "POST", token: adminToken, body: { label: `Reusable ${RUN} (back)`, code: reuseCode } });
  check("re-registering our own RETIRED sticker restores it rather than refusing",
    restored.status === 200 && restored.data?.restored === true && restored.data?.id === firstReg.data?.id,
    `HTTP ${restored.status} restored=${restored.data?.restored} sameRow=${restored.data?.id === firstReg.data?.id}`);
  check("...and the restore response still does not carry the code",
    !("code" in (restored.data || {})),
    Object.keys(restored.data || {}).join(","));

  const rowsForCode = await db.attendanceTag.count({ where: { code: reuseCode } });
  check("...and it reused the row rather than creating a second one",
    rowsForCode === 1,
    `${rowsForCode} row(s) hold that code`);

  const backTap = await call("/student/me/tap-check-in", { method: "POST", token: sToken, body: { tagCode: reuseCode } });
  check("...and the restored sticker is usable again",
    backTap.status === 201 || backTap.status === 409,
    `HTTP ${backTap.status} — 404 would mean it is still retired`);

  // A LIVE sticker of ours is a different situation and must not be silently relabelled.
  const liveClash = await call("/tags", { method: "POST", token: adminToken, body: { label: `Renamed ${RUN}`, code: reuseCode } });
  const afterClash = await db.attendanceTag.findFirst({ where: { code: reuseCode } });
  check("re-registering our own LIVE sticker is refused, and does not rename it",
    liveClash.status === 409 && afterClash?.label !== `Renamed ${RUN}`,
    `HTTP ${liveClash.status} label=${afterClash?.label}`);
  // Added when the cross-college clash block was removed. That block asserted "a 409 that
  // still wrote would hand the other college's sticker to this one"; the same failure is
  // reachable without a second institution — a refusal that nonetheless inserted a row
  // leaves two rows claiming one physical sticker, and the code column is the only thing
  // tying a tap to a wall.
  const rowsAfterClash = await db.attendanceTag.count({ where: { code: reuseCode } });
  check("...and the refusal wrote no second row for that sticker",
    rowsAfterClash === 1, `${rowsAfterClash} row(s) hold that code`);

  console.log("\n--- the tap log ---");
  /* ====================================================================== */

  const log = await call(`/tags/${created.data?.id}/log`, { token: adminToken });
  const outcomes = (log.data?.taps || []).map((t) => t.outcome);
  check("the log records refusals as well as marks",
    log.status === 200 && outcomes.includes("marked") && outcomes.includes("no_session_now") && outcomes.includes("already_marked"),
    `outcomes: ${[...new Set(outcomes)].join(", ")}`);
  check("the log never carries an email address",
    log.status === 200 && !JSON.stringify(log.data).includes("@"),
    "");

  const studentReadsLog = await call(`/tags/${created.data?.id}/log`, { token: sToken });
  check("a student cannot read a tag's log", studentReadsLog.status === 403, `HTTP ${studentReadsLog.status}`);

  /* ====================================================================== */
  console.log("\n--- a closed term closes the register ---");
  /* ====================================================================== */

  // The single highest-value gap this suite had. resolveTapSession has six unit tests for
  // the term rule, but NOTHING exercised the plumbing: every unit created above has no
  // term, so `s.unit?.term` was null everywhere and term_locked never fired over HTTP.
  // Deleting the `term:` include from candidateSessions() in routes/student.js left all
  // 30 unit tests and every assertion green while every closed term in the college became
  // tappable — and bypassing the term lock is one of the three things the route's own
  // comment says a tap must never do.
  // A Term needs a Cohort, which needs a Course — and this database seeds none of the
  // three. Built explicitly rather than reused, so the fixture cannot collide with
  // whatever another suite left behind.
  const termCourse = await db.course.create({ data: { ...stamp(DEPT), name: `Tap Suite Course ${RUN}` } }).catch(() => null);
  if (termCourse) made.courses.push(termCourse.id);
  const termCohort = termCourse
    ? await db.cohort.create({ data: { ...stamp(DEPT), courseId: termCourse.id, name: `Tap Intake ${RUN}` } }).catch(() => null)
    : null;
  if (termCohort) made.cohorts.push(termCohort.id);
  const closedTerm = termCohort
    ? await db.term.create({
        data: { cohortId: termCohort.id, year: 1, index: 1, name: `Closed Term ${RUN}`, start: "2020-01-06", end: "2020-06-30" },
      }).catch(() => null)
    : null;

  if (!closedTerm) {
    console.log("SKIP  could not create a Term fixture — the term lock is NOT exercised in this run");
  } else {
    const termUnit = await db.unit.create({
      data: { ...stamp(DEPT), code: `TRM${RUN}`.slice(0, 12), name: `Term Locked ${RUN}`, termId: closedTerm.id },
    });
    made.units.push(termUnit.id);
    // A DIFFERENT student, enrolled on this unit and nothing else. A_ID has several
    // classes running by now, so the resolver would filter the locked one out and report
    // `ambiguous` for the rest — which is correct behaviour and useless as a test of the
    // lock. Isolation is what makes term_locked the only possible answer.
    const termEnrol = await db.enrolment.create({ data: { studentId: B_ID, unitId: termUnit.id } });
    made.enrolments.push(termEnrol.id);
    await db.student.update({ where: { id: B_ID }, data: { passwordHash: bcrypt.hashSync(A_PASSWORD, 10), tokenVersion: 0 } });
    const bLogin = await login(B_EMAIL, A_PASSWORD);
    const bToken = bLogin.data?.token;
    const termSession = await db.hndSession.create({
      data: { unitId: termUnit.id, date: today, startTime: shift(now, -1), endTime: shift(now, 119), description: "term locked" },
    });
    made.sessions.push(termSession.id);

    const lockedTap = await call("/student/me/tap-check-in", {
      method: "POST", token: bToken, body: { tagCode },
    });
    const lockedMark = await db.attendanceMark.findFirst({ where: { sessionId: termSession.id, studentId: B_ID } });
    check("a tap on a session whose term has closed is refused",
      lockedTap.status === 409 && lockedTap.data?.reason === "term_locked",
      `HTTP ${lockedTap.status} ${lockedTap.data?.reason || ""}`);
    check("...and writes no mark",
      lockedMark === null,
      lockedMark ? "A MARK WAS WRITTEN into a closed term" : "");

    // The other half of the pair. Without this, a resolver that returned term_locked for
    // EVERYTHING would pass the assertion above — the two together are what prove the term
    // data actually reached the comparison rather than simply being absent.
    await db.term.update({ where: { id: closedTerm.id }, data: { end: "2099-12-31" } });
    const openTap = await call("/student/me/tap-check-in", {
      method: "POST", token: bToken, body: { tagCode },
    });
    const openMark = await db.attendanceMark.findFirst({ where: { sessionId: termSession.id, studentId: B_ID } });
    if (openMark) made.marks.push(openMark.id);
    check("the same tap succeeds once the term window includes today",
      openTap.status === 201 && !!openMark?.status,
      `HTTP ${openTap.status} status=${openMark?.status}`);

    // The refusal is recorded, which is the whole stated purpose of the tap log.
    const termLog = await call(`/tags/${created.data?.id}/log`, { token: adminToken });
    check("the closed-term refusal appears in the tag's log",
      (termLog.data?.taps || []).some((t) => t.outcome === "term_locked"),
      `outcomes: ${[...new Set((termLog.data?.taps || []).map((t) => t.outcome))].join(", ")}`);

    made.terms = made.terms || [];
    made.terms.push(closedTerm.id);
  }

  /* ====================================================================== */
  console.log("\n--- the lecturer's live view ---");
  /* ====================================================================== */

  const live1 = await call(`/hnd/sessions/${live.id}/live`, { token: adminToken });
  const meRow = (live1.data?.rows || []).find((r) => r.student?.id === A_ID);
  check("the live view shows the tapped student with the minute they arrived",
    live1.status === 200 && meRow?.checkedInAt === firstCheckedInAt,
    `HTTP ${live1.status} checkedInAt=${meRow?.checkedInAt}`);
  // Provenance follows the LAST writer. This row was tapped, then corrected by the
  // administrator in the register-save section above, so it must no longer read as
  // self-marked — a lecturer who takes a mark over owns it.
  check("a row a lecturer took over no longer reads as self-marked",
    meRow?.selfMarked === false && meRow?.takenBy && meRow.takenBy !== "Self check-in (NFC)",
    `selfMarked=${meRow?.selfMarked} takenBy=${meRow?.takenBy}`);

  // And the other direction, on a register nobody has corrected. Both assertions are
  // needed: the first alone would pass against a `selfMarked` hardcoded to false.
  const freshSession = await db.hndSession.create({
    data: { unitId: unit.id, date: today, startTime: shift(now, -2), endTime: shift(now, 118), description: "fresh" },
  });
  made.sessions.push(freshSession.id);
  // sessionId explicit: several of this student's sessions are running by now, so a bare
  // tap comes back ambiguous.
  await call("/student/me/tap-check-in", { method: "POST", token: sToken, body: { tagCode, sessionId: freshSession.id } });
  const freshLive = await call(`/hnd/sessions/${freshSession.id}/live`, { token: adminToken });
  const freshRow = (freshLive.data?.rows || []).find((r) => r.student?.id === A_ID);
  const freshMark = await db.attendanceMark.findFirst({ where: { sessionId: freshSession.id, studentId: A_ID } });
  if (freshMark) made.marks.push(freshMark.id);
  check("a row the student tapped DOES read as self-marked",
    freshRow?.selfMarked === true && freshRow?.checkedInAt,
    `selfMarked=${freshRow?.selfMarked} checkedInAt=${freshRow?.checkedInAt}`);
  // Asserting the counts SUM to rows.length is a tautology — every row increments exactly
  // one counter, so it holds for any input and would not notice an L counted as a P.
  // These are the known fixture contents at this point: A_ID was corrected to L by the
  // register save above, and nobody else on this unit has a mark.
  check("the counts describe the roll rather than merely summing to it",
    live1.data?.counts?.L === 1 && live1.data?.counts?.P === 0 && live1.data?.counts?.A === 0,
    JSON.stringify(live1.data?.counts));
  check("a student cannot read the lecturer's live view", (await call(`/hnd/sessions/${live.id}/live`, { token: sToken })).status === 403, "");

  // Closing the register: the ONLY path from this feature to an absence.
  const strangerEnrol = await db.enrolment.create({ data: { studentId: "st-100122", unitId: unit.id } }).catch(() => null);
  if (strangerEnrol) made.enrolments.push(strangerEnrol.id);

  const beforeClose = await call(`/hnd/sessions/${live.id}/live`, { token: adminToken });
  const notMarkedBefore = beforeClose.data?.counts?.notMarked ?? 0;
  const closed = await call(`/hnd/sessions/${live.id}/mark-remaining-absent`, { method: "POST", token: adminToken });
  const closedMarks = await db.attendanceMark.findMany({ where: { sessionId: live.id } });
  for (const m of closedMarks) if (!made.marks.includes(m.id)) made.marks.push(m.id);
  check("closing the register marks exactly the students who had no mark",
    closed.status === 200 && closed.data?.marked === notMarkedBefore,
    `marked ${closed.data?.marked} of ${notMarkedBefore} unmarked`);

  const mineAfterClose = closedMarks.find((m) => m.studentId === A_ID);
  check("closing the register does NOT touch a student who already tapped in",
    mineAfterClose?.status === "L" && mineAfterClose?.checkedInAt === firstCheckedInAt,
    `status=${mineAfterClose?.status} checkedInAt=${mineAfterClose?.checkedInAt}`);

  const closedAgain = await call(`/hnd/sessions/${live.id}/mark-remaining-absent`, { method: "POST", token: adminToken });
  check("closing an already-closed register marks nobody a second time",
    closedAgain.status === 200 && closedAgain.data?.marked === 0,
    `marked=${closedAgain.data?.marked}`);

  const studentCloses = await call(`/hnd/sessions/${live.id}/mark-remaining-absent`, { method: "POST", token: sToken });
  check("a student cannot close a register", studentCloses.status === 403, `HTTP ${studentCloses.status}`);

  const mine = await call("/hnd/my-sessions/today", { token: adminToken });
  check("my-sessions/today answers without error for a lecturer teaching nothing",
    mine.status === 200 && Array.isArray(mine.data?.sessions),
    `HTTP ${mine.status} ${mine.data?.sessions?.length} session(s)`);

  /* ====================================================================== */
  console.log("\n--- the staff side ---");
  /* ====================================================================== */

  const staffDate = todayLocal();
  const priorCheckIn = await db.checkIn.findFirst({ where: { staffId: { not: undefined }, date: staffDate } });
  const adminId = adminLogin.data?.user?.id;
  // Clear any clock-in the admin already has today, so the assertions below are about
  // this tap and not about a row another suite left behind.
  if (adminId) await db.checkIn.deleteMany({ where: { staffId: adminId, date: staffDate } });

  const staffTap = await call("/checkins/tap-check-in", { method: "POST", token: adminToken, body: { tagCode } });
  const ciRow = adminId ? await db.checkIn.findFirst({ where: { staffId: adminId, date: staffDate } }) : null;
  if (ciRow) made.checkIns.push(ciRow.id);
  check("a staff tap clocks them in Onsite",
    staffTap.status === 201 && ciRow?.site === "Onsite",
    `HTTP ${staffTap.status} site=${ciRow?.site}`);
  check("and records which sticker it came from",
    ciRow?.tagId === created.data?.id,
    `tagId=${ciRow?.tagId}`);
  check("the clock-in time is HH:MM in the college's zone",
    /^\d{2}:\d{2}$/.test(ciRow?.timeIn || ""),
    `timeIn=${ciRow?.timeIn}`);

  const staffAgain = await call("/checkins/tap-check-in", { method: "POST", token: adminToken, body: { tagCode } });
  const ciCount = adminId ? await db.checkIn.count({ where: { staffId: adminId, date: staffDate } }) : -1;
  const ciAfter = adminId ? await db.checkIn.findFirst({ where: { staffId: adminId, date: staffDate } }) : null;
  check("a second staff tap the same day does not create a second row",
    staffAgain.status === 200 && staffAgain.data?.alreadyCheckedIn === true && ciCount === 1,
    `HTTP ${staffAgain.status}, ${ciCount} row(s)`);
  check("and does not rewrite the recorded arrival time",
    ciAfter?.timeIn === ciRow?.timeIn,
    `${ciRow?.timeIn} -> ${ciAfter?.timeIn}`);

  // The row MUST be cleared first. With a clock-in already present the route returns
  // early on already_checked_in and never reaches the upsert, which is the only place
  // `site` is written — so this assertion used to read back a site written by an earlier
  // tap. Changing the route to `site: req.body?.site || "Onsite"` left it green while a
  // staff member could record Online while standing at the sticker.
  if (adminId) await db.checkIn.deleteMany({ where: { staffId: adminId, date: staffDate } });
  const staffTapNoSite = await call("/checkins/tap-check-in", { method: "POST", token: adminToken, body: { tagCode, site: "Online" } });
  const ciSite = adminId ? await db.checkIn.findFirst({ where: { staffId: adminId, date: staffDate } }) : null;
  if (ciSite && !made.checkIns.includes(ciSite.id)) made.checkIns.push(ciSite.id);
  check("a tap ignores any site the caller sends — the tap proves Onsite",
    staffTapNoSite.status === 201 && ciSite?.site === "Onsite",
    `HTTP ${staffTapNoSite.status} site=${ciSite?.site}`);

  /* ====================================================================== */
  console.log("\n--- the check-in screen before a tap ---");
  /* ====================================================================== */

  // Everything from here runs against C_ID, who is seeded with no classes today, so this
  // block builds the timetable one session at a time and asserts what the screen says
  // after each. Only tap-context knows how to say "nothing on now, your next class is at
  // 13:00" rather than presenting a dead button, and until now it was tested only in the
  // one state where it answers nothing at all — the feature switched off.
  await db.student.update({ where: { id: C_ID }, data: { passwordHash: bcrypt.hashSync(A_PASSWORD, 10), tokenVersion: 0 } });
  const cLogin = await login(C_EMAIL, A_PASSWORD);
  const cToken = cLogin.data?.token;
  if (!cToken) throw new Error(`third student sign-in failed (HTTP ${cLogin.status}) — cannot run the tap-context and ambiguity blocks`);

  const cUnit = await db.unit.create({
    data: { ...stamp(DEPT), code: `CTX${RUN}`.slice(0, 12), name: `Context Suite Unit ${RUN}`, startDate: today, endDate: today },
  });
  made.units.push(cUnit.id);
  const cEnrol = await db.enrolment.create({ data: { studentId: C_ID, unitId: cUnit.id } });
  made.enrolments.push(cEnrol.id);

  // Nothing on now, one class later today.
  const cFuture = await db.hndSession.create({
    data: { unitId: cUnit.id, date: today, startTime: shift(now, 60), endTime: shift(now, 180), description: "ctx future" },
  });
  made.sessions.push(cFuture.id);
  const ctxNone = await call("/student/me/tap-context", { token: cToken });
  check("with nothing running the screen says so AND names the next class",
    ctxNone.status === 200 && ctxNone.data?.enabled === true
      && Array.isArray(ctxNone.data?.now) && ctxNone.data.now.length === 0
      && ctxNone.data?.reason === "no_session_now"
      && ctxNone.data?.next?.id === cFuture.id,
    `HTTP ${ctxNone.status} now=${ctxNone.data?.now?.length} reason=${ctxNone.data?.reason} next=${ctxNone.data?.next?.id}`);

  // One class running.
  const cLive1 = await db.hndSession.create({
    data: { unitId: cUnit.id, date: today, startTime: shift(now, -5), endTime: shift(now, 115), description: "ctx live 1" },
  });
  made.sessions.push(cLive1.id);
  const ctxOne = await call("/student/me/tap-context", { token: cToken });
  // The id is asserted, not merely the count. A route that returned the whole day's
  // timetable as `now` would also answer with a length of one at this point.
  check("one class running is offered, by id, with no reason to refuse",
    ctxOne.status === 200 && ctxOne.data?.now?.length === 1
      && ctxOne.data.now[0]?.id === cLive1.id && ctxOne.data?.reason === null,
    `HTTP ${ctxOne.status} now=${JSON.stringify((ctxOne.data?.now || []).map((s) => s.id))} reason=${ctxOne.data?.reason}`);

  // Two classes running at once — a real timetable clash, and a question only the
  // student can answer.
  const cLive2 = await db.hndSession.create({
    data: { unitId: cUnit.id, date: today, startTime: shift(now, -6), endTime: shift(now, 116), description: "ctx live 2" },
  });
  made.sessions.push(cLive2.id);
  const ctxTwo = await call("/student/me/tap-context", { token: cToken });
  check("two overlapping classes are BOTH offered, so the student can choose",
    ctxTwo.status === 200 && ctxTwo.data?.now?.length === 2
      && new Set(ctxTwo.data.now.map((s) => s.id)).size === 2
      && ctxTwo.data.now.every((s) => [cLive1.id, cLive2.id].includes(s.id)),
    `now=${JSON.stringify((ctxTwo.data?.now || []).map((s) => s.id))}`);

  /* ====================================================================== */
  console.log("\n--- two classes at once ---");
  /* ====================================================================== */

  // The `ambiguous` 409 was never once returned by this suite: every tap that could have
  // provoked it passes an explicit sessionId, and three of those comments say so. That
  // made the branch that BUILDS the response — the one that decides what a student who
  // has not chosen yet is shown — entirely unread over HTTP.
  const ambiguous = await call("/student/me/tap-check-in", { method: "POST", token: cToken, body: { tagCode } });
  check("a tap with two classes running refuses to guess",
    ambiguous.status === 409 && ambiguous.data?.reason === "ambiguous" && ambiguous.data?.sessions?.length === 2,
    `HTTP ${ambiguous.status} reason=${ambiguous.data?.reason} sessions=${ambiguous.data?.sessions?.length}`);
  // The choices are rendered on a student's own phone, so the serialiser is the boundary
  // between "which of your two classes" and a slice of the register. Asserting the key
  // set EXACTLY, rather than the absence of a named field, is what makes a column added
  // to HndSession tomorrow fail here instead of shipping.
  const shape = (ambiguous.data?.sessions || []).map((s) => Object.keys(s).sort().join(","));
  check("...and each choice carries only the five fields the screen needs",
    shape.length === 2 && shape.every((k) => k === "endTime,id,startTime,unitCode,unitName"),
    `keys: ${JSON.stringify(shape)}`);
  const ambigMarks = await db.attendanceMark.count({
    where: { studentId: C_ID, sessionId: { in: [cLive1.id, cLive2.id] } },
  });
  check("...and it marks NEITHER class while the question is open",
    ambigMarks === 0,
    ambigMarks ? `${ambigMarks} mark(s) written by a tap that refused to choose` : "");

  // Park the second class in the past so exactly one is running again. That is what makes
  // the next case reachable at all: naming a session while two are running lands in the
  // ambiguous branch, and only a SINGLE resolved session reaches the guard below.
  await db.hndSession.update({ where: { id: cLive2.id }, data: { startTime: shift(now, -180), endTime: shift(now, -120) } });

  // A stale screen, or a tampered body: the student is shown one class and sends the id
  // of another. Marking the class they named would put a student in a lecture the
  // timetable says is not happening; marking the one that IS running would record an
  // attendance they did not ask for.
  const staleChoice = await call("/student/me/tap-check-in", {
    method: "POST", token: cToken, body: { tagCode, sessionId: cFuture.id },
  });
  const staleMarks = await db.attendanceMark.count({
    where: { studentId: C_ID, sessionId: { in: [cFuture.id, cLive1.id] } },
  });
  check("a tap naming a class that is not the one running is refused",
    staleChoice.status === 409 && /no longer running/i.test(staleChoice.data?.error || ""),
    `HTTP ${staleChoice.status} ${staleChoice.data?.error || staleChoice.data?.reason || ""}`);
  check("...and marks neither the class named nor the class running",
    staleMarks === 0,
    staleMarks ? `${staleMarks} mark(s) written` : "");

  /* ====================================================================== */
  console.log("\n--- retiring a sticker through the API ---");
  /* ====================================================================== */

  // PATCH /api/tags/:id had no coverage of any kind. It is the endpoint an administrator
  // reaches for when a sticker is peeled off a wall and walks out of the building, so
  // "the retired flag actually stops taps" is the assertion that matters — the route
  // could write `active: false` perfectly and mean nothing if the tap lookup did not
  // filter on it. The existing retired-tag test plants `active: false` directly in the
  // database, which proves the tap side and nothing about this route.
  const patchTag = await call("/tags", { method: "POST", token: adminToken, body: { label: `Peel Off ${RUN}` } });
  const patchCode = patchTag.data?.code;
  if (patchTag.data?.id) made.tags.push(patchTag.data.id);

  const patchUnknown = await call(`/tags/no-such-tag-${RUN}`, { method: "PATCH", token: adminToken, body: { active: false } });
  check("patching a tag that does not exist is a 404", patchUnknown.status === 404, `HTTP ${patchUnknown.status}`);

  // REMOVED here: "another college's tag cannot be renamed or retired from here", which
  // PATCHed the foreign tag planted above and required a 404 indistinguishable from the
  // one for an id that does not exist — so that a real id could not be confirmed by its
  // status code. Its fixture went with the second institution. The 404 for an unknown id,
  // immediately above, is what remains of the pair, and it is the half still worth having:
  // there is no longer a class of id that exists but is not ours.

  // "no" is the string a form sends when a checkbox is serialised carelessly, and
  // coercing it would retire a tag on a truthy value that means the opposite.
  const activeNotBool = await call(`/tags/${patchTag.data?.id}`, { method: "PATCH", token: adminToken, body: { active: "no" } });
  check("active must be a boolean, not a string that looks like one",
    activeNotBool.status === 400, `HTTP ${activeNotBool.status}`);
  const emptyPatch = await call(`/tags/${patchTag.data?.id}`, { method: "PATCH", token: adminToken, body: {} });
  check("a patch that changes nothing is refused rather than answering OK",
    emptyPatch.status === 400, `HTTP ${emptyPatch.status}`);
  const stillActive = await db.attendanceTag.findUnique({ where: { id: patchTag.data?.id } });
  check("...and neither refusal touched the tag",
    stillActive?.active === true && stillActive?.label === `Peel Off ${RUN}`,
    `active=${stillActive?.active} label=${stillActive?.label}`);

  // Exactly one class of C's is running now, so a bare tap resolves.
  const beforeRetire = await call("/student/me/tap-check-in", { method: "POST", token: cToken, body: { tagCode: patchCode } });
  const beforeRetireMark = await db.attendanceMark.findFirst({ where: { sessionId: cLive1.id, studentId: C_ID } });
  if (beforeRetireMark) made.marks.push(beforeRetireMark.id);
  check("the new sticker works before it is retired",
    beforeRetire.status === 201 && !!beforeRetireMark,
    `HTTP ${beforeRetire.status} status=${beforeRetireMark?.status}`);

  const retiredByApi = await call(`/tags/${patchTag.data?.id}`, { method: "PATCH", token: adminToken, body: { active: false } });
  check("an administrator can retire a sticker",
    retiredByApi.status === 200 && retiredByApi.data?.active === false && !("code" in (retiredByApi.data || {})),
    `HTTP ${retiredByApi.status} active=${retiredByApi.data?.active}`);

  // THE ONE THAT MATTERS in this block. A sticker somebody walked off with must stop
  // working, and must read exactly as if it had never been registered — a distinct
  // message would tell whoever holds it that they are holding something real.
  const retiredTapByApi = await call("/student/me/tap-check-in", { method: "POST", token: cToken, body: { tagCode: patchCode } });
  check("retiring a sticker through the API actually stops taps working",
    retiredTapByApi.status === 404, `HTTP ${retiredTapByApi.status}`);
  check("...and it reads identically to a code that never existed",
    retiredTapByApi.data?.error === unknown.data?.error,
    `"${retiredTapByApi.data?.error}" vs "${unknown.data?.error}"`);

  // And back. Without this the assertion above would pass against a route that broke
  // every tap, or against a tap route that had stopped finding tags at all.
  const unretired = await call(`/tags/${patchTag.data?.id}`, { method: "PATCH", token: adminToken, body: { active: true } });
  check("and it can be brought back", unretired.status === 200 && unretired.data?.active === true, `HTTP ${unretired.status}`);

  // A fresh session, so "works again" means a mark was WRITTEN rather than an
  // already_marked answered off the row the first tap left. sessionId is explicit
  // because two of C's classes are running once this one exists.
  const cLive3 = await db.hndSession.create({
    data: { unitId: cUnit.id, date: today, startTime: shift(now, -4), endTime: shift(now, 116), description: "ctx live 3" },
  });
  made.sessions.push(cLive3.id);
  const afterUnretire = await call("/student/me/tap-check-in", { method: "POST", token: cToken, body: { tagCode: patchCode, sessionId: cLive3.id } });
  const afterUnretireMark = await db.attendanceMark.findFirst({ where: { sessionId: cLive3.id, studentId: C_ID } });
  if (afterUnretireMark) made.marks.push(afterUnretireMark.id);
  check("taps on the restored sticker write marks again",
    afterUnretire.status === 201 && afterUnretireMark?.takenBy === "Self check-in (NFC)",
    `HTTP ${afterUnretire.status} takenBy=${afterUnretireMark?.takenBy}`);

  /* ====================================================================== */
  console.log("\n--- switching off the staff half only ---");
  /* ====================================================================== */

  // Two flags gate a staff tap — `enabled` and `staffTapEnabled` — and the suite only
  // ever moved them together, so nothing distinguished them. A college that wants
  // students tapping into registers but does not want the same stickers running its
  // timesheets sets exactly this pair, and a route reading the wrong flag serves them
  // the opposite of what they asked for in BOTH directions at once.
  const staffOff = await call("/tags/settings", { method: "PUT", token: adminToken, body: { staffTapEnabled: false } });
  check("the staff half can be switched off on its own",
    staffOff.status === 200 && staffOff.data?.staffTapEnabled === false && staffOff.data?.enabled === true,
    `staffTapEnabled=${staffOff.data?.staffTapEnabled} enabled=${staffOff.data?.enabled}`);

  const staffRefused = await call("/checkins/tap-check-in", { method: "POST", token: adminToken, body: { tagCode } });
  check("a staff tap is refused while only the staff half is off",
    staffRefused.status === 403, `HTTP ${staffRefused.status}`);

  // The pairing is the test. A staff tap alone would pass against a route reading
  // `enabled`, because that would refuse everybody — this student tap in the same window
  // is what proves the college is still switched ON and only the staff half is closed.
  const cLive4 = await db.hndSession.create({
    data: { unitId: cUnit.id, date: today, startTime: shift(now, -3), endTime: shift(now, 117), description: "ctx live 4" },
  });
  made.sessions.push(cLive4.id);
  const studentStillTaps = await call("/student/me/tap-check-in", { method: "POST", token: cToken, body: { tagCode, sessionId: cLive4.id } });
  const studentStillMark = await db.attendanceMark.findFirst({ where: { sessionId: cLive4.id, studentId: C_ID } });
  if (studentStillMark) made.marks.push(studentStillMark.id);
  check("...while a student tap in the same window still marks the register",
    studentStillTaps.status === 201 && !!studentStillMark,
    `HTTP ${studentStillTaps.status} ${studentStillTaps.data?.error || ""}`);

  const staffRestored = await call("/tags/settings", { method: "PUT", token: adminToken, body: { staffTapEnabled: true } });
  const staffWorksAgain = await call("/checkins/tap-check-in", { method: "POST", token: adminToken, body: { tagCode } });
  check("switching the staff half back on lets staff tap again",
    staffRestored.data?.staffTapEnabled === true && staffWorksAgain.status === 200 && staffWorksAgain.data?.alreadyCheckedIn === true,
    `HTTP ${staffWorksAgain.status} ${staffWorksAgain.data?.error || ""}`);

  /* ====================================================================== */
  console.log("\n--- a sticker is REQUIRED for onsite, not merely offered ---");
  /* ====================================================================== */

  // The client hid its ordinary Check In button once a college switched tap check-in on,
  // and that was the whole enforcement: the endpoint was still there and still answered,
  // so anyone who knew the URL clocked in Onsite without going near a sticker. A hidden
  // button is a convention, and a timesheet is a poor place for one.
  if (adminId) await db.checkIn.deleteMany({ where: { staffId: adminId, date: staffDate } });
  const bareOnsite = await call("/checkins/check-in", { method: "POST", token: adminToken, body: { site: "Onsite" } });
  const bareRow = adminId ? await db.checkIn.findFirst({ where: { staffId: adminId, date: staffDate } }) : null;
  check("a plain Onsite check-in is refused while stickers are required",
    bareOnsite.status === 409 && bareOnsite.data?.reason === "tap_required" && !bareRow,
    `HTTP ${bareOnsite.status} ${bareOnsite.data?.reason || ""}${bareRow ? " — A ROW WAS WRITTEN" : ""}`);

  // Online must stay open. A sticker proves presence in the building, which is exactly
  // what somebody working remotely cannot produce — gating it would make the honest
  // answer the one nobody can record.
  const bareOnline = await call("/checkins/check-in", { method: "POST", token: adminToken, body: { site: "Online" } });
  const onlineRow = adminId ? await db.checkIn.findFirst({ where: { staffId: adminId, date: staffDate } }) : null;
  if (onlineRow && !made.checkIns.includes(onlineRow.id)) made.checkIns.push(onlineRow.id);
  check("...but Online is never gated",
    bareOnline.status === 201 && onlineRow?.site === "Online",
    `HTTP ${bareOnline.status} site=${onlineRow?.site}`);

  // And with staff tapping switched off the ordinary route works again — the gate must
  // follow the college's setting rather than the feature merely existing.
  await call("/tags/settings", { method: "PUT", token: adminToken, body: { staffTapEnabled: false } });
  if (adminId) await db.checkIn.deleteMany({ where: { staffId: adminId, date: staffDate } });
  const ungated = await call("/checkins/check-in", { method: "POST", token: adminToken, body: { site: "Onsite" } });
  const ungatedRow = adminId ? await db.checkIn.findFirst({ where: { staffId: adminId, date: staffDate } }) : null;
  if (ungatedRow && !made.checkIns.includes(ungatedRow.id)) made.checkIns.push(ungatedRow.id);
  check("a college that has not enabled staff tapping keeps the ordinary button",
    ungated.status === 201 && ungatedRow?.site === "Onsite",
    `HTTP ${ungated.status} site=${ungatedRow?.site}`);
  await call("/tags/settings", { method: "PUT", token: adminToken, body: { staffTapEnabled: true } });

  /* ====================================================================== */
  console.log("\n--- tap-context carries the whole day, not just what is running ---");
  /* ====================================================================== */

  // "Which lessons do I have today and when" is the question the check-in screen exists
  // to answer, and it is worth answering whether or not the college taps stickers.
  const ctx = await call("/student/me/tap-context", { token: sToken });
  const dayList = ctx.data?.today || [];
  check("today's classes are returned, in start-time order",
    ctx.status === 200 && dayList.length > 0
      && dayList.every((c, i2) => i2 === 0 || dayList[i2 - 1].startTime <= c.startTime),
    `${dayList.length} class(es)`);

  const liveRow = dayList.find((c) => c.id === live.id);
  check("a class the student has already been marked on reports its mark",
    liveRow && liveRow.status && liveRow.checkedInAt === firstCheckedInAt,
    `status=${liveRow?.status} checkedInAt=${liveRow?.checkedInAt}`);

  // Three states rather than a boolean: "finished" and "not started" need different
  // words on screen, and a row that is neither is the one the button will mark.
  const pastRow = dayList.find((c) => c.id === past.id);
  const futureRow = dayList.find((c) => c.id === future.id);
  check("a finished class reads over, and one still to come reads upcoming",
    pastRow?.state === "over" && futureRow?.state === "upcoming",
    `past=${pastRow?.state} future=${futureRow?.state}`);
  check("a class running right now reads now",
    liveRow?.state === "now",
    `live=${liveRow?.state}`);

  // No student data beyond the class itself — this is a timetable, not a record.
  check("a day entry carries only class fields, never anything about other people",
    dayList.every((c) => Object.keys(c).every((k) =>
      ["id", "unitCode", "unitName", "startTime", "endTime", "state", "status", "checkedInAt", "termOpen"].includes(k))),
    `keys: ${[...new Set(dayList.flatMap((c) => Object.keys(c)))].sort().join(",")}`);

  // THE POINT OF RETURNING IT EITHER WAY. A college that never switches tap check-in on
  // still gets its students a timetable out of this route, so the screen is useful on
  // day one rather than a dead end until somebody flips a setting.
  await call("/tags/settings", { method: "PUT", token: adminToken, body: { enabled: false } });
  const offCtx2 = await call("/student/me/tap-context", { token: sToken });
  check("today's classes are returned even while tap check-in is switched OFF",
    offCtx2.status === 200 && offCtx2.data?.enabled === false && (offCtx2.data?.today || []).length > 0,
    `enabled=${offCtx2.data?.enabled} today=${(offCtx2.data?.today || []).length}`);
  await call("/tags/settings", { method: "PUT", token: adminToken, body: { enabled: true } });


  /* ====================================================================== */
  console.log("\n--- a class scheduled for the student's GROUP reaches their Check In screen ---");
  /* ====================================================================== */
  //
  // candidateSessions read the student's ENROLMENTS and nothing else, so a class
  // timetabled for their GROUP on a module that records no enrolments — every module
  // created by hand rather than synced from Moodle — never appeared. The student could
  // not mark themselves present at a class the college had scheduled for them, and the
  // screen told them they had nothing on. The fifth handler with this shape.
  //
  // The fixture is that case exactly: a unit with NO enrolment for this student, and a
  // register attached to a cohort they are in. A unit they were enrolled on would be
  // served by the old code and prove nothing.
  const grpCourse = await db.course.create({ data: { ...stamp(DEPT), name: `Grp Course ${RUN}` } });
  const grpCohort = await db.cohort.create({ data: { ...stamp(DEPT), courseId: grpCourse.id, name: `Grp Intake ${RUN}` } });
  const grpUnit = await db.unit.create({
    data: { ...stamp(DEPT), code: `GRP${RUN}`.slice(0, 12), name: `Group-only Unit ${RUN}`, courseId: grpCourse.id, startDate: today, endDate: today },
  });
  made.units.push(grpUnit.id);
  // Remember where the student was, and put them back at the end — this suite's other
  // sections assume their own arrangement.
  const priorCohort = (await db.student.findUnique({ where: { id: A_ID }, select: { cohortId: true } }))?.cohortId ?? null;
  await db.student.update({ where: { id: A_ID }, data: { cohortId: grpCohort.id } });

  // Created THROUGH THE API so a real TimetableEvent stands behind it — the timetable
  // assertions below read events, and a hand-made HndSession has none.
  const grpEvent = await call("/timetabling/events", { method: "POST", token: adminToken, body: {
    title: `Group Class ${RUN}`, date: today, start: shift(now, -5), end: shift(now, 115),
    unitId: grpUnit.id, cohortIds: [grpCohort.id], published: true } });
  const grpSession = (await db.hndSession.findFirst({ where: { timetableEventId: grpEvent.data?.event?.id } }));
  check("the class was created with a register behind it", !!grpSession?.id,
    `${grpEvent.status} ${JSON.stringify(grpEvent.data?.registers || {})}`);
  if (grpSession?.id) made.sessions.push(grpSession.id);

  check("the fixture module really has no enrolments",
    (await db.enrolment.count({ where: { unitId: grpUnit.id } })) === 0);
  check("and the student is in the group the class was scheduled for",
    (await db.student.findUnique({ where: { id: A_ID }, select: { cohortId: true } }))?.cohortId === grpCohort.id);

  const grpCtx = await call("/student/me/tap-context", { token: sToken });
  const grpIds = (grpCtx.data?.today || grpCtx.data?.sessions || []).map((x) => x.id);
  check("THE GROUP'S CLASS IS ON THE STUDENT'S CHECK IN SCREEN",
    grpIds.includes(grpSession.id), `HTTP ${grpCtx.status} ids=${grpIds.join(",")}`);

  // And the narrowing still holds: a class on a module they ARE enrolled on, but
  // timetabled for a group they are NOT in, must not appear. Without that, "candidate"
  // would have quietly become "anything touching a module of mine".
  const otherCohort = await db.cohort.create({ data: { ...stamp(DEPT), courseId: grpCourse.id, name: `Other Intake ${RUN}` } });
  const notMine = await db.hndSession.create({
    data: { unitId: unit.id, cohortId: otherCohort.id, date: today, startTime: shift(now, -5), endTime: shift(now, 115), description: "another group" },
  });
  made.sessions.push(notMine.id);
  // --- and the same class is on their TIMETABLE, from the calendar ---
  //
  // /me/timetable read TimetableSlot: the old weekly grid, which nothing writes any more,
  // so on this college it was empty and every student's timetable screen said "no
  // timetable yet" while their calendar was full. It now also returns the dated
  // TimetableEvent rows the staff timetable and the registers are built from.
  const ttRes = await call("/student/me/timetable", { token: sToken });
  check("the student timetable answers", ttRes.status === 200, `HTTP ${ttRes.status}`);
  const ttEv = (ttRes.data?.events || []).find((e) => e.id === grpEvent.data?.event?.id);
  check("A CLASS FROM THE CALENDAR IS ON THE STUDENT'S TIMETABLE, reached through their group",
    !!ttEv, `${(ttRes.data?.events || []).length} event(s)`);
  check("and it carries a register id, so the app can offer a check-in that will not 404",
    !!ttEv?.sessionId, `sessionId=${ttEv?.sessionId}`);
  check("with the room and campus a student needs to find it",
    ttEv?.room !== undefined && ttEv?.campus !== undefined, JSON.stringify({ room: ttEv?.room, campus: ttEv?.campus }));
  // The colour the app groups by. Null is a real answer -- the college has not
  // categorised this class -- and the app then derives a stable one from the module code
  // rather than painting every block the same shade, which would make colour carry
  // nothing. The KEY must exist either way or the client cannot tell "no category" from
  // "old server".
  check("and a colour key, so the app can group by module rather than paint one shade",
    "colour" in (ttEv || {}) && "category" in (ttEv || {}),
    JSON.stringify({ colour: ttEv?.colour, category: ttEv?.category }));

  const draftEvt = await call("/timetabling/events", { method: "POST", token: adminToken, body: {
    title: `Draft TT ${RUN}`, date: today, start: shift(now, 200), end: shift(now, 260),
    unitId: grpUnit.id, cohortIds: [grpCohort.id], published: false } });
  const ttRes2 = await call("/student/me/timetable", { token: sToken });
  check("A DRAFT CLASS IS NOT ON IT — an unannounced term must not reach a student's phone",
    !(ttRes2.data?.events || []).some((e) => e.id === draftEvt.data?.event?.id),
    `draft=${draftEvt.data?.event?.id}`);

  const grpCtx2 = await call("/student/me/tap-context", { token: sToken });
  const ids2 = (grpCtx2.data?.today || grpCtx2.data?.sessions || []).map((x) => x.id);
  check("A CLASS FOR ANOTHER GROUP IS NOT, even on a module they are enrolled on",
    !ids2.includes(notMine.id), `ids=${ids2.join(",")}`);

  await db.student.update({ where: { id: A_ID }, data: { cohortId: priorCohort } });
  await db.hndSession.deleteMany({ where: { id: { in: [grpSession.id, notMine.id] } } });
  await db.cohort.deleteMany({ where: { id: { in: [grpCohort.id, otherCohort.id] } } });
  await db.unit.delete({ where: { id: grpUnit.id } }).catch(() => {});
  await db.course.delete({ where: { id: grpCourse.id } }).catch(() => {});

  /* ====================================================================== */
  console.log("\n--- the student portal is still sealed ---");
  /* ====================================================================== */

  const studentHitsHnd = await call("/hnd/units", { token: sToken });
  check("a student token still reaches nothing but /api/student", studentHitsHnd.status === 403, `HTTP ${studentHitsHnd.status}`);

  const noTag = await call("/student/me/tap-check-in", { method: "POST", token: sToken, body: {} });
  check("a tap with no tag is refused", noTag.status === 400, `HTTP ${noTag.status}`);

  const anon = await call("/student/me/tap-check-in", { method: "POST", body: { tagCode } });
  check("a tap with no session at all is refused", anon.status === 401, `HTTP ${anon.status}`);

} catch (e) {
  console.error("\nsuite error:", e.message);
  fail++;
} finally {
  await cleanup();
  await db.$disconnect();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
