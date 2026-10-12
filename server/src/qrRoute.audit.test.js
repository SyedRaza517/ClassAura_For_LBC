// The QR scan ROUTE under audit, exercised as a function with no database and no server.
//
// WHY THIS FILE EXISTS AT ALL, GIVEN testing.md
//
// The convention in this codebase is that pure logic gets unit tests beside it and
// everything else is covered by HTTP smoke suites in scripts/. That convention is right
// and this file does not argue with it: scripts/smoke-qr-checkin.mjs remains the proof
// that the route is mounted, that the student token reaches it and nothing else, that the
// marks land in Postgres and that the tap log fills. Nothing here replaces any of that.
//
// What a smoke suite cannot cheaply do is sweep. The questions this audit had to answer —
// does a megabyte of rubbish in the `code` field reach the database; is the geofence
// actually applied to the student's QR path or only to staff clock-in; what does the
// handler write to the tap log when the session id is attacker-controlled; does a code
// relayed to a second enrolled student mark them too — are each one HTTP round trip plus
// a seeded college in the smoke suite, and each is a handful of microseconds here. Forty
// hostile payloads is a sweep, and a sweep belongs where it is cheap.
//
// HOW IT WORKS, AND WHAT THAT COSTS
//
// routes/student.js is an ordinary Express router, so its POST /me/qr-check-in layer is
// an ordinary async function of (req, res). This file pulls that function out, hands it a
// hand-built req and a res that records what was said, and stubs the five modules it
// reaches for — the settings resolver, the roster, the campus list, the prediction runner
// and the Prisma client. Everything else runs for real: the rate limiter, the presence
// check, the signing-key derivation, verifyCode, the window and term predicates, the
// serialiser, and every branch of the handler's own control flow.
//
// WHAT IS DELIBERATELY NOT COVERED, so nobody reads a pass here as more than it is:
//
//   * AUTHENTICATION. router.use(requireAuth, requireStudent) is a separate middleware
//     layer, and calling the route layer directly steps over it. req.user is set by this
//     file. That a staff token, an applicant token or no token at all cannot reach this
//     route is asserted in the smoke suite, where the request actually goes through the
//     stack. If this file ever appears to prove an access rule, it is lying.
//
//   * THE DATABASE. The unique constraint on (sessionId, studentId) is a Postgres
//     constraint, and the stub below honours it only because it is written to. The real
//     race — two scans landing in the same millisecond — is the smoke suite's job.
//
//   * THE WIRE. No JSON parsing, so express.json's 1mb limit is not in play here; this
//     file hands the handler the object that limit would have produced.
const test = require("node:test");
const assert = require("node:assert/strict");

const prisma = require("./db");
const tapConfig = require("./attendanceTapConfig");
// registers.js and campuses.js are NOT required here: the handler destructures their
// exports at require time, so they are stubbed one layer down at the queries they issue.
// See the long note in world() below.

const predictionRunner = require("./prediction/runner");
const { localDate, localTime } = require("./clock");
const { DEFAULTS } = require("./attendanceTapSettings");
const { distanceMetres, MAX_ACCURACY_METRES } = require("./presence");
const { windowIndexFor, deriveCode } = require("./attendanceQr");
const { qrSigningKey } = require("./secrets");

const router = require("./routes/student");

/* -------------------------------------------------------------------------- *
 * Getting at the handler
 * -------------------------------------------------------------------------- */

// Found by path rather than by index. An index would silently point at a different route
// the first time somebody adds an endpoint above this one, and the test would then be
// asserting things about the wrong handler while still passing.
const layer = router.stack.find((l) => l.route && l.route.path === "/me/qr-check-in" && l.route.methods?.post);
assert.ok(layer, "POST /me/qr-check-in is not mounted on the student router — this whole file is testing nothing");
const qrHandler = layer.route.stack[layer.route.stack.length - 1].handle;

/* -------------------------------------------------------------------------- *
 * A college, a class, a student — in memory
 * -------------------------------------------------------------------------- */

const SESSION_ID = "ckauditqrsession00000001";
// A campus in central London, and positions measured against it with presence.js's own
// haversine rather than with a hand-converted degree offset. A fixture whose distance is
// asserted by the same function the production code uses cannot drift away from the
// boundary it is supposed to sit beside.
const CAMPUS = { latitude: 51.5074, longitude: -0.1278 };
const metresNorth = (m) => ({ latitude: CAMPUS.latitude + m / 111_194.9, longitude: CAMPUS.longitude });

/** A fresh student id per call, so one test's rate-limit spend is never another's. */
let studentCounter = 0;
const freshStudent = () => `ckauditstudent${String(studentCounter += 1).padStart(10, "0")}`;

/**
 * Install the stubs and return the world the handler will see.
 *
 * Restored by the caller through `world.restore()` in a finally block. Module-level
 * monkey-patching is a blunt instrument and it is used here rather than a DI seam because
 * adding one to routes/student.js is a production edit this audit is not allowed to make
 * — and, more honestly, because the route having no seam is itself worth recording: the
 * pure halves of this feature (attendanceQr.js, presence.js, attendanceTapSettings.js)
 * are all testable without this, and the handler that stitches them together is not.
 */
function world({
  settings = {},
  roster = null,
  campusList = [],
  existingMark = null,
  sessionRow = undefined,
} = {}) {
  const taps = [];
  const marks = new Map();
  const audits = [];
  if (existingMark) marks.set(`${existingMark.sessionId}|${existingMark.studentId}`, existingMark);

  const merged = { ...DEFAULTS, ...settings };

  const session = sessionRow !== undefined ? sessionRow : {
    id: SESSION_ID,
    date: localDate(),
    // Starting now and running to the end of the day, so the window predicate is
    // satisfied whatever time the suite runs at, and statusFor returns "P" rather than
    // "L" because nothing is past the late threshold yet.
    startTime: localTime(),
    endTime: "23:59",
    checkInClosedAt: null,
    checkInOpenUntil: null,
    unit: { code: "AUD101", name: "Auditing", moodleSectionId: null, moodleCourseId: null, term: null },
  };

  const saved = {
    get: tapConfig.get,
    markStale: predictionRunner.markStale,
    tagTapCreate: prisma.tagTap.create,
    sessionFind: prisma.hndSession.findUnique,
    markFind: prisma.attendanceMark.findUnique,
    markCreate: prisma.attendanceMark.create,
    auditCreate: prisma.auditLog.create,
    enrolmentFind: prisma.enrolment.findMany,
    campusFind: prisma.campus.findMany,
  };

  tapConfig.get = async () => merged;
  predictionRunner.markStale = async () => {};

  // STUBBED AT THE PRISMA MODEL, NOT AT THE MODULE EXPORT, and the distinction cost an
  // hour so it is written down. routes/student.js destructures its helpers at require
  // time — `const { rosterForSession } = require("../timetabling/registers")` — so the
  // handler holds the function itself, not a property of the module object, and
  // reassigning registers.rosterForSession changes nothing the handler can see. tapConfig
  // and predictionRunner above ARE patchable, because they are used as `tapConfig.get()`
  // and `predictionRunner.markStale()`, through the object.
  //
  // So the roster and the campus list are stubbed one layer down, at the queries those
  // two helpers issue. That is better anyway: rosterForSession's own rule (enrolment
  // versus cohort membership, and when an absence is evidence) runs for real, and these
  // tests are not asserting a stub's opinion of who is on a register.
  //
  // It also side-steps academicScopeGuard.js, which extends the client so that any query
  // issued without a bound academic scope throws — correct in production, where scope is
  // bound by requireAuth, and unreachable here because this file calls the route layer
  // directly. Replacing the model method means the extension never runs.
  prisma.enrolment.findMany = async () => (roster === null ? [] : roster).map((studentId) => ({ studentId }));
  prisma.campus.findMany = async () => campusList;
  prisma.tagTap.create = async ({ data }) => { taps.push(data); return { id: `tap${taps.length}`, ...data }; };
  prisma.hndSession.findUnique = async ({ where }) => (session && where.id === session.id ? session : null);
  prisma.attendanceMark.findUnique = async ({ where }) => {
    const k = where.sessionId_studentId;
    return marks.get(`${k.sessionId}|${k.studentId}`) || null;
  };
  prisma.attendanceMark.create = async ({ data }) => {
    const k = `${data.sessionId}|${data.studentId}`;
    // The real uniqueness guarantee is Postgres's. Honoured here so the idempotent branch
    // is reachable, and thrown the way Prisma throws it so the handler's P2002 recovery
    // is exercised rather than stepped around.
    if (marks.has(k)) { const e = new Error("Unique constraint failed"); e.code = "P2002"; throw e; }
    const row = { id: `mark${marks.size + 1}`, ...data };
    marks.set(k, row);
    return row;
  };
  prisma.auditLog.create = async ({ data }) => { audits.push(data); return { id: "a1" }; };

  return {
    taps, marks, audits, session, settings: merged,
    restore() {
      tapConfig.get = saved.get;
      predictionRunner.markStale = saved.markStale;
      prisma.tagTap.create = saved.tagTapCreate;
      prisma.hndSession.findUnique = saved.sessionFind;
      prisma.attendanceMark.findUnique = saved.markFind;
      prisma.attendanceMark.create = saved.markCreate;
      prisma.auditLog.create = saved.auditCreate;
      prisma.enrolment.findMany = saved.enrolmentFind;
      prisma.campus.findMany = saved.campusFind;
    },
  };
}

/** A request the handler will accept as a signed-in student's scan. */
function request({ studentId, body = {}, ip = "203.0.113.9", deviceId = null } = {}) {
  return {
    ip,
    body,
    user: { id: studentId, name: "Audit Student", studentRef: "AUD-1" },
    headers: {},
    get(name) { return String(name).toLowerCase() === "x-device-id" ? deviceId : undefined; },
  };
}

/** A res that records the one thing the handler says, and refuses to be said to twice. */
function response() {
  const r = { statusCode: 200, body: null, calls: 0 };
  r.status = (code) => { r.statusCode = code; return r; };
  r.json = (body) => {
    r.calls += 1;
    // Two responses to one request is an express "headers already sent" crash in
    // production, and it is exactly what a mis-ordered early return produces. Caught here
    // rather than left to be noticed in a log.
    assert.equal(r.calls, 1, "the handler answered the same request twice");
    r.body = body;
    return r;
  };
  return r;
}

/** Run the handler once and hand back the response. Never swallows a throw. */
async function scan(w, req) {
  const res = response();
  await qrHandler(req, res);
  return res;
}

/** The code the lecturer's screen is showing for this session, right now. */
function liveCode(sessionId = SESSION_ID, rotate = DEFAULTS.qrRotateSeconds) {
  return deriveCode({
    secret: qrSigningKey(),
    sessionId,
    windowIndex: windowIndexFor(Math.floor(Date.now() / 1000), rotate),
  });
}

/* ========================================================================== *
 * 1. MALFORMED INPUT REACHES A CLEAN 4xx, NEVER A 500
 * ========================================================================== */

test("ROUTE AUDIT: every malformed code and session id is a clean 4xx with a reason", async () => {
  // The verifier's own refusal of rubbish is asserted next door in
  // attendanceQr.audit.test.js. What is asserted HERE is the handler's: that the
  // validation block in front of the verifier catches every non-string and every blank
  // before any of them can reach a database read, that it answers 400 with a reason code
  // the app can branch on, and above all that none of them throws — a throw out of this
  // handler is a 500 on a check-in, which reads to a room of students as the feature
  // being broken rather than their input being wrong.
  const hostile = [
    ["both missing", {}],
    ["null body", null],
    ["empty strings", { sessionId: "", code: "" }],
    ["whitespace only", { sessionId: "   ", code: "  \t\n " }],
    ["code missing", { sessionId: SESSION_ID }],
    ["session missing", { code: "AAAAAAAAAAAAAAAAAAAAAA" }],
    ["code is null", { sessionId: SESSION_ID, code: null }],
    ["code is undefined", { sessionId: SESSION_ID, code: undefined }],
    ["code is a number", { sessionId: SESSION_ID, code: 1234 }],
    ["code is a boolean", { sessionId: SESSION_ID, code: true }],
    ["code is an object", { sessionId: SESSION_ID, code: { toString: () => "x" } }],
    ["code is an array", { sessionId: SESSION_ID, code: ["AAAAAAAAAAAAAAAAAAAAAA"] }],
    ["session is a number", { sessionId: 42, code: "AAAAAAAAAAAAAAAAAAAAAA" }],
    ["session is an object", { sessionId: {}, code: "AAAAAAAAAAAAAAAAAAAAAA" }],
    ["session is an array", { sessionId: [SESSION_ID], code: "AAAAAAAAAAAAAAAAAAAAAA" }],
    ["session is null", { sessionId: null, code: "AAAAAAAAAAAAAAAAAAAAAA" }],
    ["a prototype-pollution body", JSON.parse('{"__proto__":{"polluted":true},"sessionId":"x"}')],
  ];

  const w = world({ roster: [] });
  try {
    for (const [label, body] of hostile) {
      const req = request({ studentId: freshStudent(), body });
      let res;
      await assert.doesNotReject(async () => { res = await scan(w, req); },
        `${label} threw out of the handler — that is a 500 on a check-in`);
      assert.equal(res.statusCode, 400, `${label} answered ${res.statusCode}, not 400`);
      assert.equal(res.body?.reason, "qr_missing", `${label} answered reason "${res.body?.reason}"`);
      assert.equal(typeof res.body?.error, "string", `${label} answered with no sentence for the student`);
    }
    assert.equal({}.polluted, undefined, "a request body polluted Object.prototype");
    // NOTHING WAS LOGGED, and that is the right call rather than an omission: a body with
    // no usable session id names no register, so a row recording it would be a refusal
    // attributable to nothing. The handler's own comment makes the opposite point for the
    // refusals that DO name a session, which the next test checks.
    assert.equal(w.taps.length, 0, `a body with no usable fields wrote ${w.taps.length} tap row(s)`);
  } finally { w.restore(); }
});

test("ROUTE AUDIT: a forged code is 404 with a reason, and an expired one is 409", async () => {
  // The two refusals the student actually meets, and they must stay distinguishable: the
  // app shows "scan the one on screen" for an expiry and "that code isn't recognised" for
  // a forgery, which are different next steps. Asserted through the route rather than
  // through verifyCode because the mapping from reason to status code lives here.
  const w = world({ roster: [] });
  try {
    const forged = await scan(w, request({ studentId: freshStudent(), body: { sessionId: SESSION_ID, code: "AAAAAAAAAAAAAAAAAAAAAA" } }));
    assert.equal(forged.statusCode, 404, `a forged code answered ${forged.statusCode}`);
    assert.equal(forged.body?.reason, "qr_bad_code");

    // A code from a real but past window of this very session. Minted twenty windows's
    // worth of seconds ago so it is outside both the grace and any boundary luck.
    const rotate = DEFAULTS.qrRotateSeconds;
    const stale = deriveCode({
      secret: qrSigningKey(), sessionId: SESSION_ID,
      windowIndex: windowIndexFor(Math.floor(Date.now() / 1000) - rotate * 3, rotate),
    });
    const expired = await scan(w, request({ studentId: freshStudent(), body: { sessionId: SESSION_ID, code: stale } }));
    assert.equal(expired.statusCode, 409, `an expired code answered ${expired.statusCode}`);
    assert.equal(expired.body?.reason, "qr_expired");

    // Both are in the tap log, with the register they named and the method that refused.
    const outcomes = w.taps.map((t) => t.outcome);
    assert.deepEqual(outcomes, ["qr_bad_code", "qr_expired"], `tap log held ${JSON.stringify(outcomes)}`);
    assert.ok(w.taps.every((t) => t.method === "qr"), "a refusal was logged without naming the capture method");
  } finally { w.restore(); }
});

test("ROUTE AUDIT: THE CODE STRING IS NEVER WRITTEN TO THE TAP LOG", async () => {
  // A code is a bearer credential for an attendance mark, and it is live for up to
  // rotate + grace seconds. A log an administrator reads in a browser must not become a
  // list of recently-valid credentials — the handler says so and this holds it to it.
  // Checked over the whole row rather than over the fields we expect to be there, so a
  // field added later that happens to carry the code fails this test.
  const w = world({ roster: [] });
  try {
    const code = liveCode();
    await scan(w, request({ studentId: freshStudent(), body: { sessionId: "a-session-that-does-not-exist", code } }));
    assert.ok(w.taps.length > 0, "nothing was logged, so this test discriminates nothing");
    for (const row of w.taps) {
      assert.ok(!JSON.stringify(row).includes(code), `the tap log row carried the code: ${JSON.stringify(row)}`);
    }
  } finally { w.restore(); }
});

test("ROUTE AUDIT: no refusal or success ever echoes the signing key", async () => {
  // The highest-severity thing that could go wrong in this feature is the signing key
  // reaching a response, because one leak forges every code on every wall for the life of
  // the deployment. qrSigningKey is HKDF'd from JWT_SECRET, so a leak of either is total.
  // Swept over every branch of the handler that answers, including the 503 the missing-key
  // path produces, because an error response is exactly where a key gets echoed by
  // accident — SecretsNotConfigured's own message names the environment variable.
  const key = qrSigningKey();
  const forbidden = [
    key.toString("base64"), key.toString("base64url"), key.toString("hex"),
    process.env.JWT_SECRET || "dev-only-change-me",
  ].filter((s) => s && s.length >= 8);

  const bodies = [];
  const w = world({ roster: [] });
  try {
    for (const body of [
      {},
      { sessionId: SESSION_ID, code: "AAAAAAAAAAAAAAAAAAAAAA" },
      { sessionId: SESSION_ID, code: liveCode() },
      { sessionId: "nope", code: liveCode("nope") },
    ]) {
      bodies.push((await scan(w, request({ studentId: freshStudent(), body }))).body);
    }
  } finally { w.restore(); }

  const offSwitch = world({ settings: { qrEnabled: false } });
  try { bodies.push((await scan(offSwitch, request({ studentId: freshStudent(), body: { sessionId: SESSION_ID, code: liveCode() } }))).body); }
  finally { offSwitch.restore(); }

  const text = JSON.stringify(bodies);
  for (const secret of forbidden) {
    assert.ok(!text.includes(secret), `a response echoed the signing material (${secret.slice(0, 6)}…)`);
  }
  // And nothing key-shaped under any name, since a future field could carry it without
  // matching the exact encodings above.
  assert.ok(!/"(secret|signingKey|key|jwt|hmac)"\s*:/i.test(text), `a response carried a key-shaped field: ${text.slice(0, 300)}`);
});

/* ========================================================================== *
 * 2. AN OVERSIZED SESSION ID IS WRITTEN TO THE TAP LOG UNBOUNDED  — FINDING
 * ========================================================================== */

test("ROUTE AUDIT: an oversized session id is NOT written to the tap log unbounded", async () => {
  // THIS TEST FAILS TODAY, AND IT IS THE FINDING. Reported rather than fixed, because the
  // coordinator applies production edits.
  //
  // The handler trims the session id and then, on every refusal, logs it:
  //   logTap(req, { studentId, sessionId, method: "qr", outcome: "qr_bad_code" })
  // TagTap.sessionId is a plain Postgres `text` column with no foreign key (checked: it is
  // nullable text precisely so a refusal that identified nobody still leaves a row), so
  // whatever arrives is stored verbatim. express.json caps the body at 1mb, so a student
  // can write just under a megabyte of chosen text into the attendance tap log, ten times
  // a minute, from an ordinary signed-in account.
  //
  // WHY THIS IS A REAL FINDING AND NOT A STYLE POINT. Every other free-text field written
  // from this request is already bounded, by the same file and the one next to it:
  //
  //   ip        String(req.ip).slice(0, 60)     routes/student.js, logTap
  //   deviceId  .replace(...).slice(0, 64)      routes/student.js, deviceIdFrom
  //   summary   String(...).slice(0, 500)       audit.js, record
  //   entityId  String(...).slice(0, 60)        audit.js, record
  //
  // sessionId is the one that was missed, and the comment on deviceIdFrom states the exact
  // reason the others are capped: "it is a header any client can set to anything, and the
  // log is read by administrators in a browser". The session id in this body is the same
  // kind of value, arriving by the same route, landing in the same table, read on the same
  // screen. A cuid is 25 characters.
  //
  // Severity is low-to-moderate rather than high: it is authenticated, rate-limited to ten
  // a minute per student, and writes junk rather than reading anything. What it costs is
  // unbounded growth in a table an administrator pages through, and a tap-log screen that
  // has to render a megabyte cell.
  //
  // THE PROPOSED FIX is a length bound in the validation block the handler already has,
  // alongside the trim — not a cap at the log, because a session id a thousand characters
  // long is not a session id and should be refused before any work is done:
  //
  //   const sessionId = rawSessionId.trim();
  // + // A cuid is 25 characters. Anything of this order is not a register id, it is a
  // + // client sending something else — and it is logged below on every refusal, into a
  // + // text column an administrator reads in a browser, exactly like the ip and the
  // + // device id that are already bounded a few lines up. Refused rather than truncated:
  // + // a truncated id would be logged as if it named a real register.
  // + if (sessionId.length > 64) {
  // +   return res.status(400).json({ error: "A class code is required", reason: "qr_missing" });
  // + }
  //
  // The bound is asserted here at 128 rather than at 64, so the test states the invariant
  // ("a session id in the tap log is of the order of an id") rather than the exact number
  // in the fix, and a fix that chooses 100 instead still passes.
  const w = world({ roster: [] });
  try {
    const huge = "s".repeat(1_000_000);
    const res = await scan(w, request({ studentId: freshStudent(), body: { sessionId: huge, code: liveCode() } }));
    assert.ok(res.statusCode >= 400 && res.statusCode < 500, `expected a 4xx, got ${res.statusCode}`);
    for (const row of w.taps) {
      assert.ok((row.sessionId || "").length <= 128,
        `a ${(row.sessionId || "").length}-character session id was written to the tap log; `
        + "every other free-text field from this request is bounded (see the comment above)");
    }
  } finally { w.restore(); }
});

test("ROUTE AUDIT: an oversized payload is refused promptly rather than hanging the handler", async () => {
  // The availability half of the same input, and this one PASSES. verifyCode runs before
  // any database read, so a verifier that degraded badly on a long candidate would let one
  // authenticated student spend the event loop. The budget is deliberately loose — a hang
  // detector, not a benchmark.
  const w = world({ roster: [] });
  try {
    for (const size of [1_000, 100_000, 1_048_576]) {
      const started = process.hrtime.bigint();
      const res = await scan(w, request({ studentId: freshStudent(), body: { sessionId: SESSION_ID, code: "A".repeat(size) } }));
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      assert.equal(res.statusCode, 404, `a ${size}-character code answered ${res.statusCode}`);
      assert.ok(ms < 2_000, `a ${size}-character code took ${ms.toFixed(0)}ms to refuse`);
    }
  } finally { w.restore(); }
});

/* ========================================================================== *
 * 3. THE SWITCH, THE ROSTER, THE WINDOW AND THE TERM
 * ========================================================================== */

test("ROUTE AUDIT: a valid code marks nobody who is not on the roster", async () => {
  // The code names its own session, so an attacker who scans any screen in the building
  // holds a cryptographically perfect code for THAT register. What stops them reaching a
  // register they have nothing to do with is this check and only this check.
  const w = world({ roster: ["somebody-else"] });
  try {
    const res = await scan(w, request({ studentId: freshStudent(), body: { sessionId: SESSION_ID, code: liveCode() } }));
    assert.equal(res.statusCode, 403, `a stranger with a valid code answered ${res.statusCode}`);
    assert.equal(res.body?.reason, "not_enrolled");
    assert.equal(w.marks.size, 0, "a mark was written for a student who is not on the roster");
    assert.equal(w.taps.at(-1)?.outcome, "not_enrolled");
  } finally { w.restore(); }
});

test("ROUTE AUDIT: a valid code outside the session's own window marks nobody", async () => {
  // A photographed code outlives its window by at most rotate + grace, but a code
  // obtained any other way — a leaked key, a lecturer's screen left up — would otherwise
  // reach a register all day. The window predicate is what bounds that, and it is checked
  // BEFORE the term so a student scanning at the wrong time of day is not told their term
  // is closed.
  const student = freshStudent();
  const closed = world({
    roster: [student],
    sessionRow: {
      id: SESSION_ID, date: localDate(), startTime: "00:00", endTime: "00:01",
      checkInClosedAt: null, checkInOpenUntil: null,
      unit: { code: "AUD101", name: "Auditing", moodleSectionId: null, moodleCourseId: null, term: null },
    },
  });
  try {
    const res = await scan(closed, request({ studentId: student, body: { sessionId: SESSION_ID, code: liveCode() } }));
    assert.equal(res.statusCode, 409, `a scan outside the window answered ${res.statusCode}`);
    assert.equal(res.body?.reason, "no_session_now");
    assert.equal(closed.marks.size, 0);
  } finally { closed.restore(); }

  // A lecturer who has ENDED check-in closes it absolutely, whatever the timetable says.
  const ended = world({
    roster: [student],
    sessionRow: {
      id: SESSION_ID, date: localDate(), startTime: localTime(), endTime: "23:59",
      checkInClosedAt: "12:00", checkInOpenUntil: null,
      unit: { code: "AUD101", name: "Auditing", moodleSectionId: null, moodleCourseId: null, term: null },
    },
  });
  try {
    const res = await scan(ended, request({ studentId: student, body: { sessionId: SESSION_ID, code: liveCode() } }));
    assert.equal(res.statusCode, 409, "a scan after the lecturer ended check-in was accepted");
    assert.equal(ended.marks.size, 0);
  } finally { ended.restore(); }
});

test("ROUTE AUDIT: a locked term answers 423 and writes nothing", async () => {
  const student = freshStudent();
  const w = world({
    roster: [student],
    sessionRow: {
      id: SESSION_ID, date: localDate(), startTime: localTime(), endTime: "23:59",
      checkInClosedAt: null, checkInOpenUntil: null,
      // Dates are strings, compared as strings — a term that ended long ago.
      unit: { code: "AUD101", name: "Auditing", moodleSectionId: null, moodleCourseId: null, term: { name: "Old", start: "2000-01-01", end: "2000-06-30" } },
    },
  });
  try {
    const res = await scan(w, request({ studentId: student, body: { sessionId: SESSION_ID, code: liveCode() } }));
    assert.equal(res.statusCode, 423, `a locked term answered ${res.statusCode}`);
    assert.equal(res.body?.reason, "term_locked");
    assert.equal(w.marks.size, 0, "a mark landed on a register the term has closed");
  } finally { w.restore(); }
});

test("ROUTE AUDIT: with the switch off, a perfect code marks nobody", async () => {
  const student = freshStudent();
  const w = world({ roster: [student], settings: { qrEnabled: false } });
  try {
    const res = await scan(w, request({ studentId: student, body: { sessionId: SESSION_ID, code: liveCode() } }));
    assert.equal(res.statusCode, 403, `with QR off, a scan answered ${res.statusCode}`);
    assert.equal(res.body?.reason, "qr_off");
    assert.equal(w.marks.size, 0);
    // SKIP IS NOT PASS, and the log is how a switched-off feature stays visible rather
    // than reading as a quiet day.
    assert.equal(w.taps.at(-1)?.outcome, "disabled");
  } finally { w.restore(); }
});

/* ========================================================================== *
 * 4. REPLAY — the definite answer
 * ========================================================================== */

test("ROUTE AUDIT: ONE CODE MARKS EVERY ENROLLED STUDENT WHO PRESENTS IT — this is the design", async () => {
  // THE REPLAY QUESTION, ANSWERED DEFINITELY AND IN BOTH DIRECTIONS.
  //
  // There is no used-code table, because codes are derived and never stored. So what stops
  // a replay is not the code. It is, exactly:
  //
  //   the SAME student twice   — the unique mark on (sessionId, studentId). The second
  //                              scan finds a mark standing, reports it, and refunds the
  //                              rate budget. Nothing is written twice and the recorded
  //                              arrival time does not move.
  //
  //   a DIFFERENT student      — NOTHING, by design. They are marked in their own right,
  //                              because one square on a projector is read by a room full
  //                              of phones and a code that named a person would have to be
  //                              a code per person.
  //
  // The consequence is real and is the headline of this audit: a student in the room can
  // photograph the square and send it to an enrolled friend who is not, and inside
  // rotate + grace (27 seconds at the default) that friend is marked Present. No check in
  // this handler can tell the two apart — unless the college has switched on the presence
  // checks, which is the next test and is the only mitigation that exists.
  const inRoom = freshStudent();
  const atHome = freshStudent();
  const w = world({ roster: [inRoom, atHome] });
  try {
    const code = liveCode();

    const first = await scan(w, request({ studentId: inRoom, body: { sessionId: SESSION_ID, code }, deviceId: "phone-in-the-room" }));
    assert.equal(first.statusCode, 201, `the student in the room answered ${first.statusCode}`);
    assert.equal(first.body?.status, "P");
    assert.ok(!first.body?.alreadyMarked);

    // THE RELAY. A different account, a different device, a different IP — the same code,
    // seconds later.
    const relayed = await scan(w, request({ studentId: atHome, body: { sessionId: SESSION_ID, code }, ip: "198.51.100.77", deviceId: "phone-at-home" }));
    assert.equal(relayed.statusCode, 201,
      "a relayed code was refused — if this now fails, the feature gained a protection and this comment is out of date");
    assert.equal(relayed.body?.status, "P", "the relayed scan did not record Present");
    assert.equal(w.marks.size, 2, "the register should hold one mark per student who presented the code");

    // The device id is RECORDED and not CHECKED, which is worth pinning: it is the only
    // trace that distinguishes the two scans after the fact, and it is a header the client
    // chooses, so it is evidence for an investigation and never a control.
    const devices = [...w.marks.values()].map((m) => m.deviceId);
    assert.deepEqual(devices, ["phone-in-the-room", "phone-at-home"], `marks recorded devices ${JSON.stringify(devices)}`);

    // THE SAME STUDENT TWICE is idempotent rather than doubled.
    const marksBefore = w.marks.size;
    const again = await scan(w, request({ studentId: inRoom, body: { sessionId: SESSION_ID, code }, deviceId: "phone-in-the-room" }));
    assert.equal(again.statusCode, 200, `a repeat scan answered ${again.statusCode}, not 200`);
    assert.equal(again.body?.alreadyMarked, true, "a repeat scan did not report the mark that already stands");
    assert.equal(w.marks.size, marksBefore, "a repeat scan wrote a second mark");
    assert.equal(again.body?.checkedInAt, first.body?.checkedInAt, "a repeat scan moved the recorded arrival time");
  } finally { w.restore(); }
});

test("ROUTE AUDIT: a scan never overwrites a mark a member of staff set", async () => {
  // The invariant that makes qrEnabled safe to ship ON. A lecturer's A, or their L, must
  // survive a student scanning afterwards — the mark is an observation and the scan is a
  // claim, and the claim does not win.
  const student = freshStudent();
  const w = world({
    roster: [student],
    existingMark: { id: "staff-mark", sessionId: SESSION_ID, studentId: student, status: "A", takenBy: "Dr Lecturer", checkedInAt: null },
  });
  try {
    const res = await scan(w, request({ studentId: student, body: { sessionId: SESSION_ID, code: liveCode() } }));
    assert.equal(res.statusCode, 200, `a scan over a lecturer's mark answered ${res.statusCode}`);
    assert.equal(res.body?.alreadyMarked, true);
    assert.equal(res.body?.status, "A", "a scan changed a lecturer's A");
    const standing = w.marks.get(`${SESSION_ID}|${student}`);
    assert.equal(standing.takenBy, "Dr Lecturer", "a scan took credit for a lecturer's mark");
    assert.equal(standing.checkedInAt, null,
      "a lecturer's mark gained an arrival time from a scan — the student never arrived");
  } finally { w.restore(); }
});

/* ========================================================================== *
 * 5. LOCATION AND PROXIMITY — the student QR path, and the exact boundary
 * ========================================================================== */

test("ROUTE AUDIT: THE GEOFENCE IS APPLIED TO THE STUDENT QR PATH, not only to staff clock-in", async () => {
  // The question this part of the audit was asked to settle, and the answer is yes — but
  // only when the college switches it on, and it ships OFF.
  //
  // There are two independent pairs of switches. `geofenceCheck`/`networkCheck` govern the
  // three STUDENT methods (sticker, code, "I'm here") through refusedForPlace in
  // routes/student.js; `staffGeofenceCheck`/`staffNetworkCheck` govern staff clock-in
  // through staffPlaceAllowed in routes/checkins.js. They deliberately share
  // `allowedNetworks` and `geofenceRadiusM`, because those describe the college rather
  // than the audience. So the student path is NOT unfenced — which was the hypothesis — it
  // is fenced by its own switch, and the staff switches do nothing for it.
  //
  // The gap that IS real is the default: geofenceCheck ships false, so out of the box a
  // relayed code from anywhere in the world is accepted. Asserted here so the default is a
  // decision somebody has to change this test to alter.
  assert.equal(DEFAULTS.geofenceCheck, false, "the student geofence default changed");
  assert.equal(DEFAULTS.networkCheck, false, "the student network default changed");
  assert.equal(DEFAULTS.staffGeofenceCheck, false);
  assert.equal(DEFAULTS.staffNetworkCheck, false);

  const student = freshStudent();

  // Off (the default): a position from the other side of the planet is accepted.
  const unfenced = world({ roster: [student] });
  try {
    const res = await scan(unfenced, request({
      studentId: student, ip: "198.51.100.77",
      body: { sessionId: SESSION_ID, code: liveCode(), position: { latitude: -33.8688, longitude: 151.2093, accuracy: 5 } },
    }));
    assert.equal(res.statusCode, 201, "with the fence off, a scan from anywhere must still work as it did before the fence existed");
  } finally { unfenced.restore(); }

  // On: the same scan from the same place is refused, by name, and nothing is written.
  const student2 = freshStudent();
  const fenced = world({ roster: [student2], settings: { geofenceCheck: true, geofenceRadiusM: 250 }, campusList: [CAMPUS] });
  try {
    const res = await scan(fenced, request({
      studentId: student2,
      body: { sessionId: SESSION_ID, code: liveCode(), position: { latitude: -33.8688, longitude: 151.2093, accuracy: 5 } },
    }));
    assert.equal(res.statusCode, 403, `with the fence on, a scan from Sydney answered ${res.statusCode}`);
    assert.equal(res.body?.reason, "off_campus");
    assert.equal(fenced.marks.size, 0, "a mark was written for a refused position");
    assert.equal(fenced.taps.at(-1)?.outcome, "off_campus", "the geofence refusal was not logged");
    // AND IT IS REFUSED BEFORE THE CODE IS EVEN VERIFIED, which is the right order: a
    // refusal about WHERE somebody is should not depend on their code being good, or the
    // response would tell an off-site attacker whether their code was valid.
  } finally { fenced.restore(); }
});

test("ROUTE AUDIT: the geofence boundary is exact — just inside passes, just outside is refused", async () => {
  // The boundary presence.test.js does not pin. It asserts "nearby passes, 1.4km away is
  // refused", which is true of any threshold between 22 and 1400 metres — including a
  // comparison that is off by a hundred metres, or one that compares the wrong way round
  // at equality. presence.js uses `away > radius`, so the student standing exactly on the
  // line is ADMITTED, and that choice needs a test or it will be reversed by somebody
  // tidying a comparison.
  //
  // THE FIXTURES ARE NOT ASSERTED AT EXACTLY THE RADIUS, and the first draft of this test
  // was wrong because they were. A latitude offset of `metres / 111194.9` is an
  // approximation of the inverse haversine, so a fixture asked for "exactly 250 metres"
  // actually lands at 250.000006 and is REFUSED — by a correct implementation, since
  // presence.js compares `away > radius`. The test failed and the code was right, which is
  // the worst way round. So the equality case is established by SEARCHING for the boundary
  // instead (below) rather than by trusting a fixture to land on it, and the cases here
  // stand a metre clear of it on each side.
  const RADIUS = 250;
  const cases = [
    ["well inside", 50, 201],
    ["just inside", RADIUS - 1, 201],
    ["just outside", RADIUS + 1, 403],
    ["well outside", RADIUS * 4, 403],
  ];
  for (const [label, metres, expected] of cases) {
    const coords = metresNorth(metres);
    // The fixture checks itself against the production haversine, so a bad offset fails
    // loudly here rather than quietly moving the boundary the test thinks it is testing.
    const actual = distanceMetres(CAMPUS, coords);
    assert.ok(Math.abs(actual - metres) < 0.5, `the ${metres}m fixture actually measures ${actual.toFixed(2)}m`);
    const student = freshStudent();
    const w = world({ roster: [student], settings: { geofenceCheck: true, geofenceRadiusM: RADIUS }, campusList: [CAMPUS] });
    try {
      const res = await scan(w, request({
        studentId: student,
        body: { sessionId: SESSION_ID, code: liveCode(), position: { ...coords, accuracy: 20 } },
      }));
      assert.equal(res.statusCode, expected,
        `${label} (${actual.toFixed(1)}m from a ${RADIUS}m fence) answered ${res.statusCode}: ${JSON.stringify(res.body)}`);
      if (expected === 403) assert.equal(res.body?.reason, "off_campus");
    } finally { w.restore(); }
  }

  // WHERE THE LINE ACTUALLY IS, found rather than assumed. Bisection on the offset, using
  // the route itself as the oracle, until the accepted and refused distances are a
  // centimetre apart — then the boundary is asserted to be the configured radius and not,
  // say, the 50-metre floor, the hard accuracy ceiling, or a radius silently halved.
  //
  // This is the assertion that an off-by-a-lot cannot survive: a comparison against the
  // wrong variable moves this number, and a >= in place of the > moves it by 0.00000001
  // and is therefore NOT what this catches. The equality direction is stated in the
  // comment above and is unobservable through a haversine; what matters for a student
  // standing at the edge of a car park is that the line is where the college put it.
  let inside = 1;
  let outside = RADIUS * 10;
  const admits = async (metres) => {
    const student = freshStudent();
    const w = world({ roster: [student], settings: { geofenceCheck: true, geofenceRadiusM: RADIUS }, campusList: [CAMPUS] });
    try {
      const res = await scan(w, request({
        studentId: student,
        body: { sessionId: SESSION_ID, code: liveCode(), position: { ...metresNorth(metres), accuracy: 20 } },
      }));
      return res.statusCode === 201;
    } finally { w.restore(); }
  };
  assert.equal(await admits(inside), true, "the search needs a known-admitted starting point");
  assert.equal(await admits(outside), false, "the search needs a known-refused starting point");
  for (let i = 0; i < 24 && outside - inside > 0.01; i += 1) {
    const mid = (inside + outside) / 2;
    if (await admits(mid)) inside = mid; else outside = mid;
  }
  const boundary = distanceMetres(CAMPUS, metresNorth(inside));
  assert.ok(Math.abs(boundary - RADIUS) < 1,
    `the fence admits up to ${boundary.toFixed(2)}m, but the college configured ${RADIUS}m`);
});

test("ROUTE AUDIT: a position too vague to mean anything is refused, and so is a missing one", async () => {
  // The easiest way round a geofence is to send the campus's own coordinates with no error
  // estimate, or with an estimate of kilometres — a circle that contains the campus from
  // most of the city. Both are refused, and so is sending no position at all: NOT
  // MEASURABLE IS NOT A PASS, which is the null-is-not-zero convention applied to a
  // decision rather than to a figure.
  const onCampus = metresNorth(10);
  const cases = [
    ["no position at all", undefined, "position_missing"],
    ["an empty position object", {}, "position_missing"],
    ["(0, 0) — an unfilled position object", { latitude: 0, longitude: 0, accuracy: 5 }, "position_missing"],
    ["coordinates with no accuracy figure", { ...onCampus }, "accuracy_unknown"],
    ["accuracy as a string", { ...onCampus, accuracy: "5" }, "accuracy_unknown"],
    ["accuracy of two kilometres", { ...onCampus, accuracy: 2000 }, "accuracy_too_poor"],
    ["accuracy wider than the college's own radius", { ...onCampus, accuracy: 251 }, "accuracy_too_poor"],
    ["an out-of-range latitude", { latitude: 91, longitude: 0, accuracy: 5 }, "position_missing"],
    ["latitude as a string", { latitude: String(onCampus.latitude), longitude: String(onCampus.longitude), accuracy: 5 }, "position_missing"],
    ["a client asserting it is in range", { inRange: true }, "position_missing"],
  ];
  for (const [label, position, reason] of cases) {
    const student = freshStudent();
    const w = world({ roster: [student], settings: { geofenceCheck: true, geofenceRadiusM: 250 }, campusList: [CAMPUS] });
    try {
      const res = await scan(w, request({ studentId: student, body: { sessionId: SESSION_ID, code: liveCode(), position } }));
      assert.equal(res.statusCode, 403, `${label} answered ${res.statusCode}`);
      assert.equal(res.body?.reason, reason, `${label} was refused as "${res.body?.reason}", expected "${reason}"`);
      assert.equal(w.marks.size, 0, `${label} wrote a mark`);
    } finally { w.restore(); }
  }

  // And an accuracy EXACTLY equal to the radius is admitted, which is the other side of
  // the same comparison (`accuracy > radius`). Pinned for the same reason as the distance
  // boundary above.
  const student = freshStudent();
  const w = world({ roster: [student], settings: { geofenceCheck: true, geofenceRadiusM: 250 }, campusList: [CAMPUS] });
  try {
    const res = await scan(w, request({ studentId: student, body: { sessionId: SESSION_ID, code: liveCode(), position: { ...onCampus, accuracy: 250 } } }));
    assert.equal(res.statusCode, 201, `an accuracy exactly equal to the radius answered ${res.statusCode}`);
    assert.ok(MAX_ACCURACY_METRES >= 250, "this case is only meaningful below the hard accuracy ceiling");
  } finally { w.restore(); }
});

test("ROUTE AUDIT: a geofence switched on with no located campus refuses everybody", async () => {
  // The misconfiguration that would otherwise make the fence theatre: switched on, nobody
  // has entered the coordinates, and every check-in passes while the settings screen says
  // the boundary is enforced. It refuses instead, by its own name, so the log says which
  // of the two things is wrong.
  const student = freshStudent();
  const w = world({ roster: [student], settings: { geofenceCheck: true }, campusList: [] });
  try {
    const res = await scan(w, request({ studentId: student, body: { sessionId: SESSION_ID, code: liveCode(), position: { ...metresNorth(5), accuracy: 10 } } }));
    assert.equal(res.statusCode, 403);
    assert.equal(res.body?.reason, "campus_not_located");
    assert.equal(w.marks.size, 0);
  } finally { w.restore(); }
});

test("ROUTE AUDIT: the network check applies to the QR path, and X-Forwarded-For cannot defeat it", async () => {
  // The address is req.ip, resolved by Express under `trust proxy: 1`, so a phone's own
  // X-Forwarded-For is pushed left and ignored. This file hands the handler req.ip
  // directly and therefore CANNOT prove the proxy configuration — that is index.js's and
  // the smoke suite's job, and it is said out loud here so a pass is not read as covering
  // it. What this does prove is that the handler consults req.ip alone and has no second
  // opinion: a header on the request changes nothing.
  const cases = [
    ["on the college network", "203.0.113.55", 201, null],
    ["a dual-stack form of the same address", "::ffff:203.0.113.55", 201, null],
    ["the same address with a port", "203.0.113.55:51234", 201, null],
    ["off the college network", "198.51.100.1", 403, "off_network"],
    ["an IPv6 address against an IPv4 list", "2001:db8::1", 403, "off_network"],
    // null, not undefined. `request()` defaults `ip` to a college address, and a default
    // parameter fires on undefined — so writing undefined here silently tested the
    // on-network case and PASSED while asserting nothing. Caught because the expectation
    // was 403 and the answer was 201; it is called out because the same trap is one
    // argument away in every other case in this file.
    ["no address at all", null, 403, "off_network"],
  ];
  for (const [label, ip, expected, reason] of cases) {
    const student = freshStudent();
    const w = world({ roster: [student], settings: { networkCheck: true, allowedNetworks: ["203.0.113.0/24"] } });
    try {
      const req = request({ studentId: student, ip, body: { sessionId: SESSION_ID, code: liveCode() } });
      // A client's own claim about where it is, which must count for nothing.
      req.headers["x-forwarded-for"] = "203.0.113.55";
      const res = await scan(w, req);
      assert.equal(res.statusCode, expected, `${label} answered ${res.statusCode}: ${JSON.stringify(res.body)}`);
      if (reason) assert.equal(res.body?.reason, reason, `${label} was refused as "${res.body?.reason}"`);
    } finally { w.restore(); }
  }

  // Switched on with an unusable list refuses everybody rather than silently admitting
  // them — the same "a rule that stops applying is worse than one never switched on"
  // reading presence.js takes everywhere else.
  for (const list of [[], ["nonsense"], ["0.0.0.0/0"]]) {
    const student = freshStudent();
    const w = world({ roster: [student], settings: { networkCheck: true, allowedNetworks: list } });
    try {
      const res = await scan(w, request({ studentId: student, ip: "203.0.113.55", body: { sessionId: SESSION_ID, code: liveCode() } }));
      assert.equal(res.statusCode, 403, `allowedNetworks=${JSON.stringify(list)} admitted a scan`);
      assert.equal(res.body?.reason, "network_not_configured");
    } finally { w.restore(); }
  }
});

test("ROUTE AUDIT: both presence checks failing reports one sentence and logs both", async () => {
  // A student gets one refusal to act on; the log gets every failure, so a college
  // switching both checks on for the first time sees that its IP list is wrong AND its
  // coordinates are, rather than discovering the second a week after fixing the first.
  const student = freshStudent();
  const w = world({
    roster: [student],
    settings: { networkCheck: true, allowedNetworks: ["203.0.113.0/24"], geofenceCheck: true, geofenceRadiusM: 250 },
    campusList: [CAMPUS],
  });
  try {
    const res = await scan(w, request({
      studentId: student, ip: "198.51.100.1",
      body: { sessionId: SESSION_ID, code: liveCode(), position: { ...metresNorth(5000), accuracy: 10 } },
    }));
    assert.equal(res.statusCode, 403);
    assert.equal(res.body?.reason, "off_network", "the student is told the first failure, in the order it is checked");
    const outcomes = w.taps.map((t) => t.outcome);
    assert.deepEqual(outcomes, ["off_network", "off_campus"], `the log held ${JSON.stringify(outcomes)}`);
  } finally { w.restore(); }
});

/* ========================================================================== *
 * 6. THE RATE BUDGET
 * ========================================================================== */

test("ROUTE AUDIT: a student's attempts are rationed, and an idempotent repeat is not charged", async () => {
  // Ten a minute per student, shared across both capture methods. It is not what stops a
  // relay — one request per class is well inside it — and it is not described as such; it
  // stops a runaway loop and a brute-force sweep of the 22-character space.
  //
  // The refund is the part worth testing, because without it a rotating code locks a
  // student out of a class they are already marked in: the app resubmits on its own, the
  // code turns over, and each redundant POST that changed nothing was still charging the
  // budget.
  const student = freshStudent();
  const w = world({ roster: [student] });
  try {
    const code = liveCode();
    const first = await scan(w, request({ studentId: student, body: { sessionId: SESSION_ID, code } }));
    assert.equal(first.statusCode, 201);

    // Twenty idempotent repeats — twice the budget — none of which may be refused for the
    // budget, because none of them changed anything.
    for (let i = 0; i < 20; i += 1) {
      const res = await scan(w, request({ studentId: student, body: { sessionId: SESSION_ID, code } }));
      assert.equal(res.statusCode, 200, `idempotent repeat ${i + 1} answered ${res.statusCode}`);
      assert.equal(res.body?.alreadyMarked, true);
    }
    assert.equal(w.marks.size, 1, "an idempotent repeat wrote a mark");

    // A student who is NOT already marked and is guessing gets exactly the budget. Counted
    // from a fresh account so the refunds above cannot be confused with the spend.
    const guesser = freshStudent();
    const statuses = [];
    for (let i = 0; i < 14; i += 1) {
      const res = await scan(w, request({ studentId: guesser, body: { sessionId: SESSION_ID, code: `AAAAAAAAAAAAAAAAAAAA${String(i).padStart(2, "0")}` } }));
      statuses.push(res.statusCode);
    }
    const refused = statuses.filter((s) => s === 429).length;
    assert.ok(refused > 0, `a guesser was never rate-limited: ${JSON.stringify(statuses)}`);
    assert.equal(statuses.slice(0, 10).every((s) => s === 404), true, `the budget is ten: ${JSON.stringify(statuses)}`);
    assert.equal(statuses.slice(10).every((s) => s === 429), true, `past the budget everything must be 429: ${JSON.stringify(statuses)}`);
    assert.ok(w.taps.some((t) => t.outcome === "rate_limited"), "a rate-limited refusal was not logged");

    // And the student sitting next to them is entirely unaffected: the budget is keyed on
    // the student, not on the lecture theatre's one shared address.
    const neighbour = freshStudent();
    const n = await scan(w, request({ studentId: neighbour, ip: "203.0.113.9", body: { sessionId: SESSION_ID, code: "AAAAAAAAAAAAAAAAAAAAAA" } }));
    assert.equal(n.statusCode, 404, "one student's spend rationed another's");
  } finally { w.restore(); }
});
