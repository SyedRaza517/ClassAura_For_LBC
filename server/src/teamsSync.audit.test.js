// Audit of the TRANSPORT the Teams attendance sync ingests through: Microsoft Graph
// polling, as driven by teamsGraph.js and consumed by teamsSync.js.
//
// WHY THESE LIVE HERE RATHER THAN IN A teamsGraph.* FILE. The existing
// teamsGraph.edge.test.js covers the pure helpers — mergeRecords, localDateFromGraph,
// graphWeekday — and never calls graphFetch, so nothing in the suite has ever exercised
// the HTTP layer the whole feature depends on. Every case below is a polling failure:
// a paginated response, a 429, an expired token mid-run. They belong to the sync's
// reliability rather than to Graph's helpers, and this audit was scoped to two new
// files, so they are here under the engine's name.
//
// HOW IT RUNS WITHOUT A DATABASE OR A MICROSOFT TENANT. Two seams, both already in the
// code and neither added for this:
//
//   * `./db` is replaced in require.cache before teamsGraph loads. integrationConfig's
//     stored() wraps its one query in try/catch and answers null for any failure
//     ("the table is not there yet", integrationConfig.js:166-170), so the fake prisma
//     makes it fall through to fromEnv() — which is what the TEAMS_* variables below
//     then supply. No DATABASE_URL is read and no connection is opened.
//   * `global.fetch` is replaced per test. teamsGraph calls bare `fetch`, so the stub
//     IS the Microsoft tenant: it can hand back a nextLink, a 429 or a 401 on demand,
//     which is the only way to test any of them.
//
// The TEAMS_GRAPH_FIXTURES seam deliberately is NOT used. It short-circuits every
// exported call to a JSON file (teamsGraph.js:~317 returns fx.attendanceByOccurrence
// wholesale), so it bypasses precisely the pagination and error handling under audit —
// which is also why the smoke suite, which drives the pipeline through that seam, cannot
// see any of the findings below.
const { test } = require("node:test");
const assert = require("node:assert/strict");

// Must happen before teamsGraph (and therefore integrationConfig) is required.
const dbPath = require.resolve("./db.js");
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {}, children: [], paths: [] };

process.env.TEAMS_TENANT_ID = "00000000-0000-0000-0000-000000000000";
process.env.TEAMS_CLIENT_ID = "client-id-for-tests";
process.env.TEAMS_CLIENT_SECRET = "secret-for-tests";
process.env.TEAMS_ORGANIZER_ACCOUNTS = "classes@college.ac.uk";
// The fixtures seam would bypass everything under test here; make sure an inherited
// value from a smoke run cannot silently neuter this whole file.
delete process.env.TEAMS_GRAPH_FIXTURES;

const graph = require("./teamsGraph");

const TOKEN_HOST = "login.microsoftonline.com";
const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) });
const tokenReply = () => ok({ access_token: "test-token", expires_in: 3600 });
const failure = (status, body, headers = {}) => ({
  ok: false, status,
  headers: { get: (h) => headers[String(h).toLowerCase()] ?? null },
  text: async () => JSON.stringify(body),
});

const realFetch = global.fetch;
/** Install a stub tenant; returns the list of Graph paths it was asked for. */
function tenant(handler) {
  graph.forgetCached(); // a token or organizer list cached by a previous test is not this test's
  const asked = [];
  global.fetch = async (url, init) => {
    const s = String(url);
    if (s.includes(TOKEN_HOST)) { asked.push("TOKEN"); return tokenReply(); }
    const path = s.replace("https://graph.microsoft.com/v1.0", "");
    asked.push(path);
    return handler(path, init, asked);
  };
  return asked;
}
function restore() { global.fetch = realFetch; graph.forgetCached(); }

const interval = (fromZ, toZ) => ({ joinDateTime: fromZ, leaveDateTime: toZ });
const WHOLE_CLASS = [interval("2026-10-01T08:00:00Z", "2026-10-01T09:00:00Z")];

/* ================================================== PARTIAL PAYLOAD / PAGINATION == */

test("a paginated attendanceRecords response is followed, so page two is not marked Absent", () => {
  // THE MOST EXPENSIVE FINDING IN THIS FILE, because it is the only one that writes a
  // WRONG mark rather than no mark.
  //
  // Graph returns every collection as a page plus an @odata.nextLink, and
  // attendanceRecords is a collection. teamsGraph.js:~336 reads `recs.value` and stops:
  // there is no nextLink handling anywhere in server/src (grep returns nothing). So the
  // attendance report for a lecture with more attendees than one page holds comes back
  // containing only the first page.
  //
  // What the sync then does with it is the problem. teamsSync.js:290-302 iterates the
  // ROSTER, not the report, and a rostered student with no participant entry is scored
  // from `{ minutes: 0, firstJoin: null }` — which decideStatus correctly renders as
  // "A" with an empty remark, because for a complete report that IS the right answer.
  // Nothing distinguishes "the report says they were not there" from "the report's
  // second page was never fetched", so the truncation is written onto real registers as
  // confident absences, with the run still reporting status "ok".
  //
  // conventions.md: a figure that could not be measured is null and is excluded, never
  // coerced to 0. A dropped page is exactly a figure that could not be measured.
  const asked = tenant((path) => {
    if (path.endsWith("/attendanceReports")) {
      return ok({ value: [{ id: "report-1", meetingStartDateTime: "2026-10-01T08:00:00Z", meetingEndDateTime: "2026-10-01T09:00:00Z", totalParticipantCount: 2 }] });
    }
    if (path.includes("/attendanceRecords")) {
      // A real two-page collection, so a client that DID follow the link would get
      // bob — which is what makes this test fail the moment the defect is fixed,
      // rather than merely looping.
      if (path.includes("skiptoken=PAGE2")) {
        return ok({ value: [{ emailAddress: "bob@college.ac.uk", identity: { user: { id: "u-bob" } }, attendanceIntervals: WHOLE_CLASS }] });
      }
      // Page one of two. The nextLink is the whole point: Graph is TELLING us there is
      // more, and the client throws that away.
      return ok({
        value: [{ emailAddress: "alice@college.ac.uk", identity: { user: { id: "u-alice" } }, attendanceIntervals: WHOLE_CLASS }],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/users/org/onlineMeetings/m1/attendanceReports/report-1/attendanceRecords?$skiptoken=PAGE2",
      });
    }
    return ok({ value: [] });
  });

  return graph.attendanceByOccurrence("org", "m1").then((occurrences) => {
    try {
      assert.equal(occurrences.length, 1);
      const people = occurrences[0].intervals;
      // FIXED: graphFetch follows @odata.nextLink, so bob — rostered, present for the
      // whole hour, and previously written a permanent "A" with an empty remark — arrives.
      assert.equal(people.length, 2, "both pages are merged into one collection");
      assert.deepEqual(people.map((p) => p.email).sort(), ["alice@college.ac.uk", "bob@college.ac.uk"]);
      const recordCalls = asked.filter((p) => p.includes("/attendanceRecords"));
      assert.equal(recordCalls.length, 2, "page two was actually requested");
      assert.ok(asked.some((p) => p.includes("skiptoken")), "the skiptoken was followed");

      // The report's own cross-check now agrees: totalParticipantCount declared 2 and 2
      // is what we merged, so the truncation guard in attendanceByOccurrence stays quiet.
      // That guard is what fires if a short read ever happens for some other reason — it
      // throws rather than handing teamsSync a partial report to write Absents from.
      assert.equal(people.length, 2, "2 of a declared 2 participants");
    } finally { restore(); }
  });
});

test("a paginated attendanceReports response keeps every WEEK of a recurring series", () => {
  // The same omission one level up. attendanceReports is the per-occurrence list a
  // recurring class's register is looked up in (occurrenceForDate, teamsSync.js:235), so
  // a dropped page is dropped WEEKS — and the symptom is different and milder: no
  // occurrence for that date means `continue` and no marks at all (teamsSync.js:236-239),
  // which is the correct conservative outcome arrived at by accident.
  //
  // Milder, not harmless: the session stays eligible and the note says "the meeting had
  // no session on that date yet", which is a lie about the cause, and RETRY_DAYS (7)
  // eventually gives up on a register Graph was holding the whole time.
  const asked = tenant((path) => {
    if (path.includes("/attendanceReports") && path.includes("skiptoken=WEEK2")) {
      return ok({ value: [{ id: "week-2", meetingStartDateTime: "2026-10-08T08:00:00Z" }] });
    }
    if (path.endsWith("/attendanceReports")) {
      return ok({
        value: [{ id: "week-1", meetingStartDateTime: "2026-10-01T08:00:00Z" }],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/users/org/onlineMeetings/m1/attendanceReports?$skiptoken=WEEK2",
      });
    }
    return ok({ value: [{ emailAddress: "alice@college.ac.uk", identity: { user: { id: "u-alice" } }, attendanceIntervals: WHOLE_CLASS }] });
  });

  return graph.attendanceByOccurrence("org", "m1").then((occurrences) => {
    try {
      // FIXED: both weeks come back, so week two's register finds the occurrence for
      // its own date instead of being abandoned once RETRY_DAYS expired.
      assert.equal(occurrences.length, 2, "every week of the series, not just the first page");
      assert.deepEqual(occurrences.map((o) => o.date).sort(), ["2026-10-01", "2026-10-08"]);
      assert.ok(asked.filter((p) => p.includes("/attendanceReports")).length >= 2,
        "the reports nextLink is followed as well");
    } finally { restore(); }
  });
});

test("calendarView follows past $top=100, so discovery sees the whole college", () => {
  // Discovery's own truncation, and the likeliest of the three to bite in production
  // because of how the feature is designed: organizerAccounts is a small set of
  // DEDICATED scheduling accounts that create EVERY online class in the college
  // (integrationConfig.js's own note on the field), and the window queried is
  // daysAgo(7)..daysAhead(7) — fourteen days. teamsGraph.js:~291 sends $top=100 and
  // reads one page, so a college running more than about seven online classes a day
  // loses everything past the first hundred events.
  //
  // The loss is total and silent: no join URL is written, so the COLLECTION pass never
  // considers those sessions, no issue is noted (teamsSync.js:155-178 only notes a
  // calendar it could not read at all, and an ambiguous match), and the run finishes
  // "ok". An admin's only signal is registers that stay empty — attributable to
  // anything.
  const event = (subject, joinUrl, startTime) => ({
    subject, isOnlineMeeting: true, onlineMeeting: { joinUrl },
    start: { dateTime: `2026-10-01T${startTime}:00.0000000` }, end: { dateTime: "2026-10-01T23:00:00.0000000" },
  });
  const asked = tenant((path) => {
    if (path.includes("skiptoken=PAGE2")) {
      return ok({ value: [event("Physics", "https://teams.microsoft.com/l/meetup-join/19%3ameeting_two%40thread.v2/0", "11:00")] });
    }
    return ok({
      value: [event("Maths", "https://teams.microsoft.com/l/meetup-join/19%3ameeting_one%40thread.v2/0", "09:00")],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/users/org/calendarView?$skiptoken=PAGE2",
    });
  });

  return graph.calendarView("org", "2026-10-01", "2026-10-14").then((events) => {
    try {
      // FIXED: the Physics class on page two is discovered and can be matched to its
      // register. $top is still 100 — the page size was never the bug, discarding the
      // link was.
      assert.equal(events.length, 2, "page two of the calendar is now requested");
      assert.deepEqual(events.map((e) => e.subject).sort(), ["Maths", "Physics"]);
      const views = asked.filter((p) => p.includes("calendarView"));
      assert.equal(views.length, 2);
      assert.ok(views[0].includes("%24top=100") || views[0].includes("$top=100"),
        "the page size is unchanged; following the link is what fixes it");
      assert.ok(asked.some((p) => p.includes("skiptoken")), "nextLink followed");
    } finally { restore(); }
  });
});

/* ================================================================ HTTP 429 ========= */

test("a 429 carries Retry-After to the caller, who decides whether to honour it", () => {
  // Graph throttles per-app per-resource and answers 429 with a Retry-After header
  // naming the seconds to wait. There is no 429 or Retry-After anywhere in server/src.
  // graphFetch (teamsGraph.js:~190-210) turns any non-2xx into a throw, carrying only
  // err.status, so the header Microsoft sent to make recovery possible is read, parsed
  // and discarded by `res.text()` never touching it.
  //
  // The blast radius is set by teamsSync.js:100-109: occurrencesFor CACHES the thrown
  // error per meetingId for the whole run, so one throttled fetch takes out every week
  // of that series in that run — correctly, to avoid retrying twelve times, but it means
  // a single 429 costs a whole recurring class a full polling cycle.
  //
  // It degrades SAFELY, which is why this is a reliability finding and not a correctness
  // one: teamsSync.js:227-230 notes the failure and `continue`s without writing marks,
  // and teamsCollectedAt stays null so the session is retried. The cost is a college
  // whose registers do not fill, with the reason buried in a run's issues list.
  let attempts = 0;
  tenant((path) => {
    attempts++;
    return failure(429, { error: { code: "TooManyRequests", message: "Rate limit is exceeded. Try again in 120 seconds." } },
      { "retry-after": "120" });
  });

  return graph.attendanceByOccurrence("org", "m1").then(
    () => { restore(); assert.fail("a 429 must not resolve"); },
    (err) => {
      try {
        // Still ONE attempt, deliberately: retrying inside graphFetch changes how long a
        // whole sync may take, which is a scheduler decision rather than a fetch-helper
        // one. What changed is that the wait Microsoft named is no longer thrown away, so
        // a caller CAN honour it.
        assert.equal(attempts, 1, "no retry here — that stays the caller's decision");
        assert.equal(err.status, 429, "the status is carried, which callers branch on");
        assert.equal(typeof err.retryAfter, "number", "Retry-After is surfaced");
        // The message does at least reach an admin verbatim, which is the mitigation.
        assert.match(err.message, /HTTP 429/);
        assert.match(err.message, /TooManyRequests/);
      } finally { restore(); }
    },
  );
});

/* ====================================================== TOKEN EXPIRY MID-SYNC ====== */

test("the access token is fetched once and reused across a whole sync — the 60s-early renewal is the only guard", () => {
  // Correct behaviour, pinned because the next test depends on understanding it. One
  // client-credentials grant serves every Graph call in the run; expiresAt is set 60
  // seconds before the real expiry (teamsGraph.js:~160) so a request never sets out with
  // a token about to die. For a sync that takes seconds this is entirely sufficient.
  const asked = tenant(() => ok({ value: [] }));
  return graph.calendarView("org", "2026-10-01", "2026-10-02")
    .then(() => graph.calendarView("org", "2026-10-03", "2026-10-04"))
    .then(() => graph.resolveMeetingId("org", "https://teams.microsoft.com/l/meetup-join/x"))
    .then(() => {
      try {
        assert.equal(asked.filter((p) => p === "TOKEN").length, 1, "one grant, three Graph calls");
      } finally { restore(); }
    });
});

test("a token Graph rejects is forgotten, so the next call re-acquires instead of failing", () => {
  // What happens when the 60-second margin is not enough — the secret was rolled, the
  // app's consent was revoked, or the host clock is skewed. Graph answers 401
  // InvalidAuthenticationToken.
  //
  // graphFetch throws and leaves `cachedToken` exactly as it was, and there is no
  // 401-means-reauthenticate path anywhere. So the very next call reuses the token Graph
  // just rejected, and the one after that, for as long as the cached expiry says it is
  // valid — up to just under an hour. One transient 401 therefore poisons the whole
  // remainder of the sync AND every sync the scheduler starts inside that window, with
  // no self-healing short of a process restart or forgetCached() (which only the
  // credentials-saved path calls).
  //
  // The sequence below is the proof: TOKEN, then three Graph calls and never a second
  // TOKEN, even though the middle one was refused for being unauthenticated.
  let n = 0;
  const asked = tenant(() => {
    n++;
    if (n === 2) return failure(401, { error: { code: "InvalidAuthenticationToken", message: "Access token has expired." } });
    return ok({ value: [] });
  });

  return graph.calendarView("org", "2026-10-01", "2026-10-02")
    .then(() => graph.calendarView("org", "2026-10-03", "2026-10-04").then(
      () => assert.fail("the 401 must surface"),
      (err) => { assert.equal(err.status, 401); },
    ))
    .then(() => graph.calendarView("org", "2026-10-05", "2026-10-06"))
    .then(() => {
      try {
        // FIXED: two grants, not one. The rejected token is dropped on the 401, so the
        // call after it re-acquires rather than replaying a credential Graph has already
        // refused — which used to poison every call for the rest of the cache's hour.
        assert.equal(asked.filter((p) => p === "TOKEN").length, 2,
          "the rejected token was re-acquired, not reused");
        assert.equal(asked.filter((p) => p !== "TOKEN").length, 3);
      } finally { restore(); }
    });
});

/* ============================================== DUPLICATE DELIVERY / IDEMPOTENCY === */

test("a report delivered twice in one response merges to one person, not two sets of minutes", () => {
  // Idempotency at the identity layer, which is the layer that can see it. Graph can
  // report the same person twice in one attendanceRecords page — a rejoin under a fresh
  // identity record is the observed case — and mergeRecords keys by msUserId (falling
  // back to email) so the two rows become ONE entry with both intervals concatenated.
  // attendedMinutes then merges the overlap, so a duplicate delivery cannot inflate a
  // student past the session's own length.
  //
  // This is the half of duplicate-delivery handling that is genuinely correct. The other
  // half — the same report fetched again by a LATER run — is held by
  // createMany({ skipDuplicates: true }) on @@unique([sessionId, studentId])
  // (teamsSync.js:310) plus teamsCollectedAt, and is proved end to end by
  // scripts/smoke-teams-attendance.mjs ("creates no new marks", "three Teams log rows,
  // not six") rather than re-implemented here.
  const merged = graph.mergeRecords([
    { emailAddress: "alice@college.ac.uk", identity: { user: { id: "u-alice" } }, attendanceIntervals: [interval("2026-10-01T08:00:00Z", "2026-10-01T08:40:00Z")] },
    { emailAddress: "alice@college.ac.uk", identity: { user: { id: "u-alice" } }, attendanceIntervals: [interval("2026-10-01T08:20:00Z", "2026-10-01T09:00:00Z")] },
  ]);
  assert.equal(merged.length, 1, "one person, however many rows describe them");
  assert.equal(merged[0].intervals.length, 2, "both intervals kept — the merge is attendedMinutes' job");
  const { attendedMinutes } = require("./teamsAttendance");
  assert.equal(attendedMinutes(merged[0].intervals, { startTime: "09:00", endTime: "10:00" }).minutes, 60,
    "40 + 40 overlapping is 60 of union, never 80 of a 60-minute class");
});

test("the same meeting id is fetched ONCE per run however many weeks read it", () => {
  // The dedupe that makes a twelve-week recurring series one Graph call rather than
  // twelve (teamsSync.js:96-109's occurrencesByMeeting). It is a cache on the ENGINE, not
  // on teamsGraph, so what is asserted here is the thing that makes the cache necessary:
  // teamsGraph itself has no memoisation at all and will re-poll on every call. If the
  // engine's cache were ever removed, nothing lower down would absorb it.
  const asked = tenant((path) => {
    if (path.endsWith("/attendanceReports")) return ok({ value: [{ id: "r1", meetingStartDateTime: "2026-10-01T08:00:00Z" }] });
    return ok({ value: [] });
  });
  return graph.attendanceByOccurrence("org", "m1")
    .then(() => graph.attendanceByOccurrence("org", "m1"))
    .then(() => {
      try {
        assert.equal(asked.filter((p) => p.endsWith("/attendanceReports")).length, 2,
          "teamsGraph re-polls; only the engine's own Map prevents the twelvefold fetch");
      } finally { restore(); }
    });
});

/* ======================================== GUESTS, EXTERNAL TENANTS, DIAL-INS ======= */

test("an external-tenant guest is kept but cannot be matched to a student by identity", () => {
  // CORRECT behaviour, asserted because it is the case most likely to put a mark on the
  // wrong person's register. A user from another Microsoft tenant arrives with a real
  // identity.user.id — a GUID in THEIR directory — and their own email. mergeRecords
  // keeps them, and teamsSync.js:253 then looks that id up in byMsId (built from
  // Student.msUserId, which only ever holds ids this college's own sync cached) and the
  // email in byEmail (built from the roster). Both miss, so the participant falls to
  // teamsSync.js:254-260: participantsUnmatched++ and an issue naming them. Reported,
  // never guessed.
  const merged = graph.mergeRecords([
    { emailAddress: "visiting.lecturer@other-uni.ac.uk", identity: { user: { id: "ext-guid-from-another-tenant", displayName: "Visiting Lecturer" } }, attendanceIntervals: WHOLE_CLASS },
  ]);
  assert.equal(merged.length, 1, "an identifiable guest IS evidence, and is kept to be reported");
  assert.equal(merged[0].msUserId, "ext-guid-from-another-tenant");
  assert.equal(merged[0].email, "visiting.lecturer@other-uni.ac.uk");
  // The roster side of the match, as teamsSync builds it. Neither map can contain a
  // foreign tenant's id or a foreign domain, so neither lookup can succeed.
  const students = [{ id: 1, email: "alice@college.ac.uk", msUserId: "u-alice" }];
  const byMsId = new Map(students.filter((s) => s.msUserId).map((s) => [s.msUserId, s]));
  const byEmail = new Map(students.map((s) => [s.email.toLowerCase(), s]));
  const hit = (merged[0].msUserId && byMsId.get(merged[0].msUserId)) || (merged[0].email && byEmail.get(merged[0].email));
  assert.equal(hit, undefined, "no student — and therefore no mark — for a guest");
});

test("an anonymous guest and a phone dial-in are dropped from the merge but COUNTED", () => {
  // The three shapes with no usable identity, straight out of Graph's attendanceRecord
  // resource: an unauthenticated joiner (identity.guest, no email), a PSTN dial-in
  // (identity.phone), and a record whose identity.user is explicitly null.
  //
  // Dropping them from the merge is RIGHT — recordKey's "a guest id is not a student id
  // and a phone number is not a student id" is the correct call, and guessing a phone
  // number onto a register is the failure this feature exists to refuse. The defect was
  // WHERE it happened, and it is fixed.
  //
  // They were dropped inside mergeRecords, which runs before teamsSync ever sees the
  // report, so they never reached its unmatched counter and never produced an issue. An
  // admin reading a run that said "0 unmatched participants" was being told nobody
  // unidentifiable was on the call, for a lecture where a rostered student dialled in
  // from a train and is now carrying an Absent. The one participant who most needed a
  // human to look was the one the count could not see. countUnidentifiable now answers
  // that, without any mark changing.
  // Hoisted, because the same four records are now asked two different questions: who
  // could be identified, and how many could not.
  const records = [
    { emailAddress: "alice@college.ac.uk", identity: { user: { id: "u-alice" } }, attendanceIntervals: WHOLE_CLASS },
    { emailAddress: null, identity: { guest: { id: "guest-anon-1", displayName: "Guest" } }, attendanceIntervals: WHOLE_CLASS },
    { emailAddress: null, identity: { phone: { id: "+447700900123" } }, attendanceIntervals: WHOLE_CLASS },
    { emailAddress: null, identity: { user: null }, attendanceIntervals: WHOLE_CLASS },
  ];
  const merged = graph.mergeRecords(records);
  assert.equal(merged.length, 1, "three participants are still correctly matched to nobody");
  // FIXED: dropping them from the merge was always right — a guest id is not a student id
  // and a phone number is not a student id. What was wrong was that they vanished WITHOUT
  // TRACE, before teamsSync's counter, so a run could report "0 unmatched" for a lecture a
  // rostered student had dialled into. countUnidentifiable answers the same question
  // mergeRecords asks, from the same recordKey, so the two cannot drift apart.
  assert.equal(graph.countUnidentifiable(records), 3,
    "the three nobody could identify are counted, so an admin can see there is something to look at");
  assert.deepEqual(merged.map((p) => p.email), ["alice@college.ac.uk"]);
  // Not an off-by-one in the drop: none of the three leaks through under any key.
  assert.ok(!merged.some((p) => p.msUserId === "guest-anon-1"), "a guest id is never a student id");
  assert.ok(!merged.some((p) => String(p.msUserId || "").startsWith("+")), "a phone number is never a student id");
});

test("mergeRecords keeps a GUEST that Teams did give an email, which is a different risk", () => {
  // The in-between shape: an invited external guest whose record carries emailAddress
  // but no identity.user (the guest is in identity.guest, which mergeRecords does not
  // read). The entry is keyed on the email alone, msUserId null — so if that email
  // happens to equal a rostered student's, teamsSync matches them and marks the student
  // from the guest's intervals.
  //
  // That is correct far more often than not: the usual cause is a student joining from a
  // personal account that Teams recorded as a guest, and refusing it would cost them a
  // class they attended. It is pinned because it is the one path by which a non-student
  // identity CAN reach a student's register, and because the msUserId caching at
  // teamsSync.js:262-269 is skipped here (p.msUserId is null), so the match is re-made
  // from the email every run rather than hardened into Student.msUserId — which is the
  // right way round for a match this soft.
  const merged = graph.mergeRecords([
    { emailAddress: "Alice@College.AC.UK", identity: { guest: { id: "guest-7", displayName: "Alice (Guest)" } }, attendanceIntervals: WHOLE_CLASS },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].email, "alice@college.ac.uk", "lowercased, because the roster map is lowercase");
  assert.equal(merged[0].msUserId, null, "nothing to cache onto the student, deliberately");
});
