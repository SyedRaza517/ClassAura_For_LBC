// Referrals to support departments — and, mostly, who is refused.
//
// The feature hands a student to Wellbeing, ASK or Student Support and tracks what
// became of it. Almost everything worth testing about it is a refusal, because the
// thing being protected is a student's disclosure to a wellbeing officer and the way
// that leaks is not a crash — it is a queue that answers a question it should have
// declined, or a serialiser that grew a field.
//
// Three assertions carry the suite:
//
//   1. A member of ASK reading the Wellbeing queue gets 403, NOT an empty list. An
//      empty queue and a queue you may not read are different answers, and the second
//      dressed as the first teaches staff the wellbeing desk has no work.
//   2. The referrer's view is asserted as an EXACT KEY SET. A test that checks `notes`
//      and `outcomeDetail` are absent passes just as happily when a third field leaks —
//      and the whole point of sReferralForReferrer being an allowlist is that a column
//      added tomorrow must not appear without somebody deciding it should.
//   3. The student is emailed only when asked. notifyStudent defaults OFF and is
//      `=== true`, so a truthy non-boolean must not turn it on.
//
// Alongside those: a referral cannot be accepted twice, cannot be closed without an
// outcome, cannot be raised against an unknown or RETIRED department, cannot be
// attached to another student's meeting, and cannot be reached at all without the page.
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { collegeWideReader } from "./lib/college-wide-reader.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
const require = createRequire(pathToFileURL(join(ROOT, "server", "package.json")));
const { PrismaClient } = require(`${ROOT}/server/node_modules/@prisma/client`);
// Signing the student in needs a password hash written directly: every seeded student
// has passwordHash null, which is what the student portal suite already works around.
const bcrypt = require(`${ROOT}/server/node_modules/bcryptjs`);
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required — point it at a throwaway database."); process.exit(1); }
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const BASE = process.env.API_URL || "http://localhost:4010/api";
const ADMIN = process.env.SEED_ADMIN_EMAIL || "admin@edtech.co.uk";
const PASSWORD = process.env.SEED_PASSWORD || "test-seed-password-2026";

let passed = 0, failed = 0;
const ok = (label, detail) => { passed++; console.log(`✓ ${label}${detail ? "  — " + detail : ""}`); };
const bad = (label, e) => { failed++; console.log(`✗ ${label}\n    ${e && e.message ? e.message : e}`); };
async function check(label, fn) {
  try { const d = await fn(); ok(label, d); } catch (e) { bad(label, e); }
}

const call = async (path, { method = "GET", body, token } = {}) => {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
};

// Work written after the response and never awaited — the department notifications and
// the audit rows — has no completion signal from outside. Poll rather than sleep once,
// so a slow first write does not fail the run and a fast one does not cost a second.
const eventually = async (fn, tries = 25, gap = 120) => {
  for (let i = 0; i < tries; i++) {
    const got = await fn();
    if (got) return got;
    await new Promise((r) => setTimeout(r, gap));
  }
  return null;
};

console.log("\n=== referrals to support departments ===\n");

const admin = await call("/auth/login", { method: "POST", body: { email: ADMIN, password: PASSWORD } });
if (!admin.body.token) {
  console.log("✗ could not sign in as the seeded admin — is the API seeded?");
  console.log(JSON.stringify(admin.body).slice(0, 200));
  process.exit(1);
}
const adminToken = admin.body.token;

// Feature present at all? A build without the router answers 404 on every path under
// it, and a suite that then reported thirty failures would bury that one fact.
const probe = await call("/referrals/departments", { token: adminToken });
if (probe.status === 404) {
  console.log("SKIP — /api/referrals is not mounted in this build");
  process.exit(2);
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

// FOUR ACCOUNTS, because the confidentiality split cannot be demonstrated with fewer:
// a referrer who belongs to no department, and one member each of Wellbeing, ASK and
// Student Support. The ASK member exists only to be refused.
//
// Built here rather than added to prisma/seed.js. A fixture in the shared seed is a
// change to every other suite — smoke-account-deletion.mjs has a rule that only holds
// while the college has one administrator, and the last suite to seed a second admin
// silently switched it off and then deleted the shared account.
const stamp = Date.now();
const people = {
  referrer: { name: "Referring Tutor", email: `ref.tutor.${stamp}@edtech.co.uk`, pw: "RefTutor123!", pages: ["referrals", "pat"], depts: null },
  well:     { name: "Wellbeing Officer", email: `ref.well.${stamp}@edtech.co.uk`, pw: "WellPass123!", pages: ["referrals"], depts: ["wellbeing"] },
  ask:      { name: "ASK Adviser", email: `ref.ask.${stamp}@edtech.co.uk`, pw: "AskPass123!", pages: ["referrals"], depts: ["ask"] },
  supp:     { name: "Support Officer", email: `ref.supp.${stamp}@edtech.co.uk`, pw: "SuppPass123!", pages: ["referrals"], depts: ["student-support"] },
  // THE SUPER ADMIN, and the reason there is one here at all: PUT /staff/:id/access is
  // the only route that grants department membership and it is Super-Admin-only, so
  // until now this suite could not exercise that route and wrote the column directly.
  // The seeded college has no Super Admin, so one is created and deleted with the rest.
  boss:     { name: "The Super Admin", email: `ref.boss.${stamp}@edtech.co.uk`, pw: "BossPass123!", pages: [], depts: null, superAdmin: true },
};

for (const p of Object.values(people)) {
  const made = await call("/staff", { method: "POST", token: adminToken, body: { name: p.name, email: p.email, password: p.pw } });
  if (!made.body?.id) {
    console.log(`✗ could not create the fixture ${p.email}`);
    console.log(JSON.stringify(made.body).slice(0, 200));
    process.exit(1);
  }
  p.id = made.body.id;
  // MEMBERSHIP IS WRITTEN DIRECTLY, and that is not laziness. The only route that sets
  // Staff.supportDepartments is PUT /staff/:id/access, which is Super-Admin-only and
  // the seeded college has none — and that handler currently computes the value and
  // then updates without it (see the report accompanying this suite). The page grant
  // goes in the same way, for the reason smoke-mitigations.mjs already records.
  await db.staff.update({
    where: { id: p.id },
    data: {
      accountRole: "ADMIN",
      // A Super Admin's grant is null — every page — and the flag is what this suite
      // needs; the pages list above is empty for them and would demote them if stored.
      adminPages: p.superAdmin ? null : JSON.stringify(p.pages),
      ...(p.superAdmin ? { isSuperAdmin: true } : {}),
      supportDepartments: p.depts ? JSON.stringify(p.depts) : null,
      mustChangePassword: false,
    },
  });
  const login = await call("/auth/login", { method: "POST", body: { email: p.email, password: p.pw } });
  if (!login.body?.token) {
    console.log(`✗ could not sign in as the fixture ${p.email}`);
    process.exit(1);
  }
  p.token = login.body.token;
}
const { referrer, well, ask, supp, boss } = people;

const students = (await call("/hnd/students", { token: adminToken })).body || [];
if (students.length < 2) {
  console.log("SKIP — fewer than two seeded students, so there is nobody to refer and nobody to confuse them with");
  await db.staff.deleteMany({ where: { email: { in: Object.values(people).map((p) => p.email) } } });
  await db.$disconnect();
  process.exit(2);
}
const [alice, bob] = students;

// A PAT meeting belonging to BOB, used to prove a referral for ALICE cannot borrow it.
// Written directly because POST /interactions emails the student a record of the row,
// which is a real email to a fixture address for a meeting that never happened.
const bobsMeeting = await db.interaction.create({
  data: { studentId: bob.id, date: "2026-08-01", time: "10:00", queryType: "1 to 1 Meeting", summary: "Fixture" },
});
const alicesMeeting = await db.interaction.create({
  data: { studentId: alice.id, date: "2026-08-01", time: "11:00", queryType: "1 to 1 Meeting", summary: "Fixture" },
});

// Canaries. Distinct, unlikely strings, so "did this text reach somewhere it should
// not" is a substring search over a whole JSON payload rather than a field-by-field
// list that only covers the fields somebody remembered.
const REASON = `REASON-CANARY-${stamp}`;
const NOTES = `NOTES-CANARY-${stamp}`;
const DETAIL = `DETAIL-CANARY-${stamp}`;

const createdReferrals = [];
const raise = async (body, token = referrer.token) => {
  const r = await call("/referrals", { method: "POST", token, body });
  if (r.status === 201 && r.body?.id) createdReferrals.push(r.body.id);
  return r;
};

/* -------------------------------------------------------------------------- */
/* Who may reach it at all                                                     */
/* -------------------------------------------------------------------------- */

await check("an unauthenticated caller is refused every route, reads included", async () => {
  const paths = [
    ["/referrals/departments", "GET"],
    ["/referrals?department=wellbeing", "GET"],
    ["/referrals/mine", "GET"],
    ["/referrals", "POST"],
    ["/referrals/anything/accept", "PUT"],
  ];
  for (const [path, method] of paths) {
    const r = await call(path, { method });
    assert.equal(r.status, 401, `${method} ${path} answered ${r.status} with no token`);
  }
  return `${paths.length} routes, all 401`;
});

await check("A MEMBER OF STAFF WITHOUT THE PAGE IS REFUSED EVERY ROUTE, READS INCLUDED", async () => {
  // A referral says which student was sent to Wellbeing and why. That is not a fact to
  // hand to any signed-in member of staff, so the guard is on the router rather than on
  // the writes — the reads are the leak.
  const login = await call("/auth/login", { method: "POST", body: { email: "j.whitfield@edtech.co.uk", password: PASSWORD } });
  if (!login.body?.token) return "skipped — could not sign in as the seeded plain staff member";
  const t = login.body.token;
  const attempts = [
    ["/referrals/departments", "GET", undefined],
    ["/referrals?department=wellbeing", "GET", undefined],
    ["/referrals/mine", "GET", undefined],
    ["/referrals", "POST", { studentId: alice.id, department: "wellbeing", reason: "x" }],
    ["/referrals/anything/accept", "PUT", {}],
    ["/referrals/anything/notes", "PUT", { notes: "x" }],
    ["/referrals/anything/close", "PUT", { outcome: "supported" }],
  ];
  for (const [path, method, body] of attempts) {
    const r = await call(path, { method, token: t, body });
    assert.equal(r.status, 403, `${method} ${path} answered ${r.status} for a staff member without the grant`);
  }
  return `${attempts.length} routes, all 403`;
});

await check("holding the page does not make you a member of anything", async () => {
  // The split the feature is built on: the grant opens the FEATURE, membership decides
  // the queues. A tutor who holds `referrals` so they can see what they sent must not
  // thereby read the wellbeing desk's caseload.
  const r = await call("/referrals/departments", { token: referrer.token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.mine, [], "a tutor with no membership was handed departments");
  assert.ok(r.body.departments.some((d) => d.key === "wellbeing"), "the department list did not resolve");
  return "departments visible, membership empty";
});

await check("a wellbeing officer sees exactly their own membership", async () => {
  const r = await call("/referrals/departments", { token: well.token });
  assert.deepEqual(r.body.mine, ["wellbeing"]);
  return "mine = [wellbeing]";
});

await check("editing the college's department list needs `settings`, not merely `referrals`", async () => {
  // A wellbeing officer holds this page to work a queue. Retiring the ASK desk is an
  // administrative act on the college's organisation chart, and it is a destructive one
  // — a key that disappears takes its name with it and every referral raised against it
  // renders as a slug.
  const r = await call("/referrals/departments", { method: "PUT", token: well.token, body: { departments: [] } });
  assert.equal(r.status, 403, `a caseworker got ${r.status} editing the department list`);
  return "403";
});

/* -------------------------------------------------------------------------- */
/* Raising one — what is refused                                               */
/* -------------------------------------------------------------------------- */

await check("a referral with no student is refused", async () => {
  const r = await raise({ department: "wellbeing", reason: "x" });
  assert.equal(r.status, 400);
  return r.body.error;
});

await check("a referral for an unknown student is refused", async () => {
  const r = await raise({ studentId: "no-such-student", department: "wellbeing", reason: "x" });
  assert.equal(r.status, 404);
  return "404";
});

await check("a referral with no reason is refused", async () => {
  // The reason is the only field both sides see, and a queue of blank referrals is a
  // queue the department has to chase by email — which takes the conversation off the
  // record, the failure the whole feature exists to fix.
  const r = await raise({ studentId: alice.id, department: "wellbeing", reason: "   " });
  assert.equal(r.status, 400);
  return r.body.error;
});

await check("a referral to an UNKNOWN department key is refused", async () => {
  const r = await raise({ studentId: alice.id, department: "careers", reason: REASON });
  assert.equal(r.status, 400, "a department the college has never heard of was accepted");
  return r.body.error;
});

await check("a referral to a department that is only a substring of a real one is refused", async () => {
  // The key is matched with ===, and this pins that. A prefix match would send work to
  // "student-support" from a client that typed "student".
  const r = await raise({ studentId: alice.id, department: "student", reason: REASON });
  assert.equal(r.status, 400);
  return r.body.error;
});

await check("A REFERRAL CANNOT BE ATTACHED TO ANOTHER STUDENT'S PAT MEETING", async () => {
  // The meeting link is what a reader follows to see the conversation behind a
  // referral. Pointed at a different student's meeting it does not merely mislabel the
  // referral — it opens one student's pastoral record from another student's page.
  const r = await raise({ studentId: alice.id, department: "wellbeing", reason: REASON, interactionId: bobsMeeting.id });
  assert.equal(r.status, 400, `a referral for one student borrowed another's meeting (${r.status})`);
  assert.match(r.body.error, /different student/i);
  return r.body.error;
});

await check("a referral naming a meeting that does not exist is refused", async () => {
  const r = await raise({ studentId: alice.id, department: "wellbeing", reason: REASON, interactionId: "no-such-meeting" });
  assert.equal(r.status, 400);
  return r.body.error;
});

/* -------------------------------------------------------------------------- */
/* Raising one — and what it defaults to                                       */
/* -------------------------------------------------------------------------- */

// The referral the rest of the suite works on: raised by a tutor who is a member of no
// department, against Wellbeing, with the meeting that really is this student's.
let mainId = null;
await check("a referral is raised OPEN, with no outcome and nobody having picked it up", async () => {
  const r = await raise({
    studentId: alice.id, department: "wellbeing", urgency: "urgent",
    reason: REASON, interactionId: alicesMeeting.id,
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, "open");
  assert.equal(r.body.outcome, null, "outcome must be null until closed — null means NOT CLOSED YET");
  assert.equal(r.body.acceptedOn, null);
  assert.equal(r.body.closedOn, null);
  assert.equal(r.body.interactionId, alicesMeeting.id);
  mainId = r.body.id;
  return `id ${mainId}`;
});

await check("THE STUDENT IS NOT EMAILED UNLESS ASKED — the field defaults off", async () => {
  // Not a UI default. A tutor raising a safeguarding concern must not have to remember
  // to suppress anything, and a client that omits the field entirely must not be
  // treated as having ticked the box.
  const r = await call(`/referrals/mine`, { token: referrer.token });
  const row = (r.body || []).find((x) => x.id === mainId);
  assert.ok(row, "the referral just raised is not in the referrer's list");
  assert.equal(row.studentNotified, false);
  return "studentNotified false";
});

await check("a TRUTHY NON-BOOLEAN does not turn the student email on", async () => {
  // `notifyStudent === true`, deliberately. The string "false" is truthy in JavaScript,
  // and a client serialising a checkbox as text would otherwise email a student about a
  // safeguarding referral because of a type mismatch nobody would ever see in review.
  for (const value of ["false", "true", 1, "yes", {}, ["true"]]) {
    const r = await raise({ studentId: alice.id, department: "wellbeing", reason: REASON, notifyStudent: value });
    assert.equal(r.status, 201);
    assert.equal(r.body.studentNotified, false, `notifyStudent: ${JSON.stringify(value)} switched the email ON`);
  }
  return "6 truthy non-booleans, all off";
});

await check("...and a real `true` DOES turn it on, so the checks above discriminate something", async () => {
  // Without this, the two assertions above would pass against a field hardcoded false.
  const r = await raise({ studentId: alice.id, department: "wellbeing", reason: REASON, notifyStudent: true });
  assert.equal(r.status, 201);
  assert.equal(r.body.studentNotified, true);
  return "studentNotified true";
});

// A second open referral, kept aside so the closure rules below can be exercised
// without spending the one the rest of the suite follows.
let spareId = null;
await check("an unknown urgency falls back to routine rather than being stored verbatim", async () => {
  const r = await raise({ studentId: alice.id, department: "wellbeing", reason: REASON, urgency: "catastrophic" });
  assert.equal(r.status, 201);
  assert.equal(r.body.urgency, "routine");
  spareId = r.body.id;
  return "routine";
});

/* -------------------------------------------------------------------------- */
/* The queues                                                                  */
/* -------------------------------------------------------------------------- */

await check("A MEMBER OF ASK CANNOT READ THE WELLBEING QUEUE — 403, NOT AN EMPTY LIST", async () => {
  // The single assertion this suite exists for. Returning [] would be a defensible
  // implementation and a bad answer: it says the wellbeing desk has no work, which is
  // false, and it teaches an ASK adviser that a screen they cannot use is simply empty.
  const r = await call("/referrals?department=wellbeing", { token: ask.token });
  assert.equal(r.status, 403, `an ASK adviser got ${r.status} from the wellbeing queue`);
  assert.ok(!Array.isArray(r.body), "the wellbeing queue returned a list to somebody outside the department");
  assert.ok(!JSON.stringify(r.body).includes(REASON), "the refusal carried a referral's reason with it");
  return "403, no list";
});

await check("...and the wellbeing officer really can read it, so the 403 above is a decision", async () => {
  // The control. Without it, "everything answers 403" would pass the assertion above.
  const r = await call("/referrals?department=wellbeing", { token: well.token });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
  const row = r.body.find((x) => x.id === mainId);
  assert.ok(row, "the wellbeing queue does not contain the referral raised to it");
  return `${r.body.length} in the queue`;
});

await check("the person who RAISED it cannot read the queue it went to", async () => {
  // Raising a referral is not membership. The tutor learns what became of it through
  // /mine, which is a different serialiser — this is the route that would hand them the
  // department's whole caseload.
  const r = await call("/referrals?department=wellbeing", { token: referrer.token });
  assert.equal(r.status, 403);
  return "403";
});

await check("a queue read with no department named is refused rather than returning everything", async () => {
  const r = await call("/referrals", { token: well.token });
  assert.equal(r.status, 400, `an unfiltered queue read answered ${r.status}`);
  assert.ok(!Array.isArray(r.body));
  return r.body.error;
});

await check("an ASK adviser cannot act on a wellbeing referral either", async () => {
  // The membership check is shared by every mutation, so it cannot be forgotten on a
  // handler added later. Asserted on all three, because "shared helper" is a claim.
  for (const [path, body] of [["accept", {}], ["notes", { notes: NOTES }], ["close", { outcome: "supported" }]]) {
    const r = await call(`/referrals/${mainId}/${path}`, { method: "PUT", token: ask.token, body });
    assert.equal(r.status, 403, `PUT ${path} answered ${r.status} for a non-member`);
    assert.ok(!JSON.stringify(r.body).includes(REASON), `the ${path} refusal leaked the referral's reason`);
  }
  return "accept, notes and close all 403";
});

await check("an unknown referral id is 404 for a member of the department", async () => {
  const r = await call("/referrals/no-such-referral/accept", { method: "PUT", token: well.token, body: {} });
  assert.equal(r.status, 404);
  return "404";
});

/* -------------------------------------------------------------------------- */
/* Working one                                                                 */
/* -------------------------------------------------------------------------- */

await check("accepting stamps WHO picked it up and WHEN", async () => {
  const r = await call(`/referrals/${mainId}/accept`, { method: "PUT", token: well.token, body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "accepted");
  assert.equal(r.body.acceptedBy, people.well.name);
  assert.ok(r.body.acceptedOn, "no acceptance date");
  return `${r.body.acceptedOn} by ${r.body.acceptedBy}`;
});

await check("A REFERRAL CANNOT BE ACCEPTED TWICE", async () => {
  // The second acceptance overwrites who picked it up and when — the one fact this
  // transition exists to record. A 409 rather than a silent no-op, so a queue two
  // people are working says so.
  const r = await call(`/referrals/${mainId}/accept`, { method: "PUT", token: well.token, body: {} });
  assert.equal(r.status, 409, `a second acceptance answered ${r.status}`);
  const still = await call("/referrals?department=wellbeing", { token: well.token });
  const row = still.body.find((x) => x.id === mainId);
  assert.equal(row.acceptedBy, people.well.name, "the second acceptance rewrote the first");
  return "409, first acceptance intact";
});

await check("a colleague in the SAME department cannot accept it out from under them either", async () => {
  // Membership is not the only guard on this transition; status is. Written with a
  // second wellbeing member to prove the 409 is about the referral's state rather than
  // about repeating a request as the same person.
  await db.staff.update({ where: { id: supp.id }, data: { supportDepartments: JSON.stringify(["student-support", "wellbeing"]) } });
  const relogin = await call("/auth/login", { method: "POST", body: { email: supp.email, password: supp.pw } });
  const r = await call(`/referrals/${mainId}/accept`, { method: "PUT", token: relogin.body.token, body: {} });
  assert.equal(r.status, 409);
  await db.staff.update({ where: { id: supp.id }, data: { supportDepartments: JSON.stringify(["student-support"]) } });
  supp.token = (await call("/auth/login", { method: "POST", body: { email: supp.email, password: supp.pw } })).body.token;
  return "409";
});

await check("the department writes its case notes", async () => {
  const r = await call(`/referrals/${mainId}/notes`, { method: "PUT", token: well.token, body: { notes: NOTES } });
  assert.equal(r.status, 200);
  assert.equal(r.body.notes, NOTES, "the department's own view must carry the notes it just wrote");
  return "notes stored";
});

await check("A REFERRAL CANNOT BE CLOSED WITHOUT AN OUTCOME", async () => {
  // Null on `outcome` means "not closed yet". A closure with no outcome collapses that
  // into "closed, nobody recorded what happened", after which the referrer's view can
  // no longer tell a case still being worked from one finished and never written up.
  for (const body of [{}, { outcome: "" }, { outcome: "   " }, { outcome: null }, { outcomeDetail: DETAIL }]) {
    const r = await call(`/referrals/${mainId}/close`, { method: "PUT", token: well.token, body });
    assert.equal(r.status, 400, `close with ${JSON.stringify(body)} answered ${r.status}`);
  }
  return "5 outcome-less closures, all 400";
});

await check("...nor with an INVENTED outcome code", async () => {
  // The outcome is the one part of the closure the referrer is shown, so it is a code
  // and not prose — free text here would carry the reason across the split with it.
  // "SUPPORTED" is in this list on purpose: the outcome is NOT lower-cased on the way
  // in, unlike a department key, so a client sending a display label rather than the
  // code is refused rather than storing a fifth spelling of an existing outcome.
  for (const outcome of ["solved", "SUPPORTED", "closed", "other_thing", "supported;drop", 7, true]) {
    const r = await call(`/referrals/${mainId}/close`, { method: "PUT", token: well.token, body: { outcome } });
    assert.equal(r.status, 400, `outcome ${JSON.stringify(outcome)} was accepted`);
  }
  return "7 invented codes, all 400";
});

await check("...though surrounding whitespace is TRIMMED rather than making a new code", async () => {
  // The complement of the check above, and the reason it does not simply assert that
  // anything unequal to a code is refused. " supported " is the same decision typed
  // with a stray space; refusing it would be a validation message about whitespace,
  // while storing it verbatim would put a sixth value in a five-value column.
  //
  // Spent on the SPARE referral: it closes one, and the referral the rest of the suite
  // follows has to stay open for the assertions below.
  const r = await call(`/referrals/${spareId}/close`, { method: "PUT", token: well.token, body: { outcome: "  supported  " } });
  assert.equal(r.status, 200);
  assert.equal(r.body.outcome, "supported");
  return "trimmed to `supported`";
});

await check("...and the referral is still OPEN after every refused closure", async () => {
  // A refusal that half-applied would be worse than an acceptance. This is what makes
  // the two checks above assertions about state rather than about status codes.
  const q = await call("/referrals?department=wellbeing", { token: well.token });
  const row = q.body.find((x) => x.id === mainId);
  assert.equal(row.status, "accepted");
  assert.equal(row.outcome, null);
  assert.equal(row.closedOn, null);
  return "still accepted, outcome null";
});

await check("closing with a real outcome records the code, the detail, and who closed it", async () => {
  const r = await call(`/referrals/${mainId}/close`, { method: "PUT", token: well.token, body: { outcome: "supported", outcomeDetail: DETAIL } });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "closed");
  assert.equal(r.body.outcome, "supported");
  assert.equal(r.body.outcomeDetail, DETAIL);
  assert.equal(r.body.closedBy, people.well.name);
  assert.ok(r.body.closedOn);
  return `closed as supported on ${r.body.closedOn}`;
});

await check("a closed referral cannot be closed again", async () => {
  const r = await call(`/referrals/${mainId}/close`, { method: "PUT", token: well.token, body: { outcome: "no_response" } });
  assert.equal(r.status, 409, `a second closure answered ${r.status}`);
  return "409";
});

/* -------------------------------------------------------------------------- */
/* THE REFERRER'S VIEW — the exact key set                                     */
/* -------------------------------------------------------------------------- */

// Every field sReferralForReferrer is allowed to emit, and nothing else. Asserted as a
// SET rather than as the absence of `notes` and `outcomeDetail`, because a denylist
// test proves only that the two fields somebody thought of are missing — it passes
// unchanged on the day a third one is added to the serialiser, which is exactly how the
// column that leaks would arrive.
const REFERRER_KEYS = [
  "acceptedOn", "closedOn", "createdAt", "department", "id", "interactionId",
  "outcome", "raisedOn", "reason", "status", "student", "studentId",
  "studentNotified", "urgency",
].sort();
const STUDENT_KEYS = ["colour", "id", "initials", "name", "studentRef"].sort();

await check("THE REFERRER'S VIEW CARRIES EXACTLY THESE FIELDS AND NO OTHERS", async () => {
  const r = await call("/referrals/mine", { token: referrer.token });
  assert.equal(r.status, 200);
  const row = (r.body || []).find((x) => x.id === mainId);
  assert.ok(row, "the referrer cannot see their own referral at all");
  assert.deepEqual(Object.keys(row).sort(), REFERRER_KEYS,
    "the referrer's serialiser has gained or lost a field — if it gained one, decide whether the tutor should have it before changing this list");
  assert.deepEqual(Object.keys(row.student).sort(), STUDENT_KEYS,
    "the nested student summary has gained or lost a field");
  return `${REFERRER_KEYS.length} keys, exactly as declared`;
});

await check("the case notes and the closing detail are nowhere in the referrer's whole payload", async () => {
  // Belt and braces beside the key set: a substring search over the entire response
  // catches the text arriving under a name nobody predicted, including nested.
  const r = await call("/referrals/mine", { token: referrer.token });
  const blob = JSON.stringify(r.body);
  assert.ok(!blob.includes(NOTES), "the receiving team's CASE NOTES reached the referrer");
  assert.ok(!blob.includes(DETAIL), "the closing DETAIL reached the referrer");
  assert.ok(blob.includes(REASON), "the referrer's own words are missing — they wrote them, they must see them");
  return "no notes, no detail, own reason present";
});

await check("the referrer IS told the status and the outcome CODE", async () => {
  // The other half of the same decision. A tutor who never learns what happened stops
  // referring and starts emailing, which takes the whole conversation off the record —
  // so the split is "status and code, yes; case notes, no", not "nothing".
  const r = await call("/referrals/mine", { token: referrer.token });
  const row = r.body.find((x) => x.id === mainId);
  assert.equal(row.status, "closed");
  assert.equal(row.outcome, "supported");
  assert.ok(row.closedOn, "the referrer cannot see when it was closed");
  return "closed / supported";
});

await check("/mine is MINE — it does not carry a colleague's referrals", async () => {
  const r = await call("/referrals/mine", { token: well.token });
  assert.equal(r.status, 200);
  assert.ok(!r.body.some((x) => x.id === mainId),
    "a wellbeing officer's Sent-by-me list contains a referral somebody else raised");
  return `${r.body.length} of their own`;
});

/* -------------------------------------------------------------------------- */
/* A RETIRED department: closed to new work, still readable                    */
/* -------------------------------------------------------------------------- */

let retiredId = null;
await check("a referral to Student Support is accepted while the desk is open", async () => {
  const r = await raise({ studentId: bob.id, department: "student-support", reason: REASON });
  assert.equal(r.status, 201);
  retiredId = r.body.id;
  return `id ${retiredId}`;
});

await check("retiring a department is a save, not a deletion", async () => {
  const r = await call("/referrals/departments", {
    method: "PUT", token: adminToken,
    body: {
      departments: [
        { key: "wellbeing", name: "Wellbeing", active: true },
        { key: "ask", name: "ASK", active: true },
        { key: "student-support", name: "Student Support", active: false },
      ],
    },
  });
  assert.equal(r.status, 200);
  const retired = r.body.departments.find((d) => d.key === "student-support");
  assert.equal(retired.active, false);
  assert.equal(retired.name, "Student Support", "the retired desk lost its name — its old queue would render as a slug");
  return "student-support retired";
});

await check("A RETIRED DEPARTMENT REFUSES NEW REFERRALS", async () => {
  // The subtle half of "unknown department is refused". `active()` gates what may be
  // raised; `all()` still resolves the key for reading. A handler written against
  // all() accepts this and the referral goes to a desk the college has closed, where
  // nobody is watching the queue.
  const r = await raise({ studentId: bob.id, department: "student-support", reason: REASON });
  assert.equal(r.status, 400, `a retired department accepted new work (${r.status})`);
  return r.body.error;
});

await check("...but its existing queue is still readable, under its NAME", async () => {
  // The other side of the same decision, and the reason byKey() tolerates retirement.
  // A term's worth of case records must not become unreachable because the college
  // reorganised.
  const q = await call("/referrals?department=student-support", { token: supp.token });
  assert.equal(q.status, 200, `a retired queue answered ${q.status} to its own member`);
  assert.ok(q.body.some((x) => x.id === retiredId), "the retired queue lost the referrals raised to it");
  const list = await call("/referrals/departments", { token: supp.token });
  assert.ok(list.body.departments.some((d) => d.key === "student-support" && d.active === false),
    "the retired department is missing from the list the nav is built from");
  return "readable, retired";
});

await check("a non-member is still refused the retired queue", async () => {
  const r = await call("/referrals?department=student-support", { token: ask.token });
  assert.equal(r.status, 403);
  return "403";
});

await check("the department list rejects a body that is not an array", async () => {
  const r = await call("/referrals/departments", { method: "PUT", token: adminToken, body: { departments: "wellbeing" } });
  assert.equal(r.status, 400);
  return r.body.error;
});

/* -------------------------------------------------------------------------- */
/* What is told to whom, outside the response                                  */
/* -------------------------------------------------------------------------- */

await check("the department is notified in-app, and the notification NAMES NO STUDENT", async () => {
  // A queue nobody is told about is a queue nobody works. But the notification is a row
  // anyone holding the recipient's session can read on any screen, so it says work has
  // arrived and the queue itself says what — no student, no reason.
  const got = await eventually(async () => {
    const r = await call("/notifications", { token: well.token });
    const mine = (r.body || []).filter((n) => /referral/i.test(n.message || ""));
    return mine.length ? mine : null;
  });
  assert.ok(got, "the wellbeing team was never told a referral had arrived");
  const blob = JSON.stringify(got);
  assert.ok(!blob.includes(REASON), "the notification carried the referral's reason");
  assert.ok(!blob.includes(alice.firstName + " " + alice.lastName), "the notification named the student");
  assert.ok(!blob.includes(alice.studentRef), "the notification carried the student's reference");
  return `${got.length} notifications, no student named`;
});

await check("a department is not notified about another department's work", async () => {
  const r = await call("/notifications", { token: ask.token });
  const wellbeing = (r.body || []).filter((n) => /waiting for Wellbeing/i.test(n.message || ""));
  assert.equal(wellbeing.length, 0, "ASK was notified about wellbeing referrals");
  return "none";
});

await check("THE AUDIT TRAIL RECORDS WHO AND WHERE, NEVER WHY", async () => {
  // The audit log is read on Settings and Access by administrators who were never
  // granted this page — the same route by which a mitigating-circumstances category
  // would have escaped. The summary may name the student and the department; the
  // referrer's reason, the case notes and the closing detail may not appear anywhere.
  // THE AUDIT TRAIL IS COLLEGE-WIDE ONLY since 28 Sep 2026, so this assertion needs a
  // college-wide reader to keep running in the scoped pass, where every seeded account is
  // narrowed. In the ordinary pass this IS the caller's own token and nothing is created.
  // See lib/college-wide-reader.mjs for why the assertion is worth the helper.
  const reader = await collegeWideReader({ call, token: adminToken, label: "ref" });
  const rows = await eventually(async () => {
    const log = await call("/audit?entity=Referral&take=100", { token: reader.token });
    const entries = log.body?.entries || [];
    return entries.length ? entries : null;
  });
  await reader.dispose();
  assert.ok(rows, "no audit rows were written for any referral at all");
  const actions = new Set(rows.map((e) => e.action));
  for (const wanted of ["referral.raised", "referral.accepted", "referral.noted", "referral.closed"]) {
    assert.ok(actions.has(wanted), `nothing recorded ${wanted}`);
  }
  const blob = JSON.stringify(rows);
  assert.ok(!blob.includes(REASON), "the audit trail carries the referrer's REASON");
  assert.ok(!blob.includes(NOTES), "the audit trail carries the department's CASE NOTES");
  assert.ok(!blob.includes(DETAIL), "the audit trail carries the closing DETAIL");
  return `${rows.length} rows, four verbs, no reason`;
});

/* -------------------------------------------------------------------------- */
/* Handing a case to another desk                                              */
/* -------------------------------------------------------------------------- */

// A transfer is the one operation in this feature that can move a confidentiality
// boundary, so it gets the heaviest negative weighting in the suite. The failure it
// exists to prevent is silent: a student discloses something to Wellbeing, the case is
// handed to ASK for a coursework question, and the disclosure arrives with it. Nothing
// crashes, nobody is told, and the college finds out when the student does.
const T_REASON = `TRANSFER-CANARY-${stamp}`;
const T_NOTES = `TRANSFERNOTES-CANARY-${stamp}`;
const MSG_WELL = `MSGWELL-CANARY-${stamp}`;
const MSG_TUTOR = `MSGTUTOR-CANARY-${stamp}`;
const MSG_ASK = `MSGASK-CANARY-${stamp}`;

// One referral, raised at Wellbeing, worked there, then handed to ASK. Every assertion
// below reads this same case, because the interesting questions are all about what
// crossed the hand-off and what did not.
const moved = await raise({ studentId: alice.id, department: "wellbeing", reason: REASON, urgency: "urgent" });
const movedId = moved.body?.id;
await call(`/referrals/${movedId}/accept`, { method: "PUT", token: well.token });
await call(`/referrals/${movedId}/notes`, { method: "PUT", token: well.token, body: { notes: T_NOTES } });

await check("a tutor who is on no department cannot hand a case on", async () => {
  const r = await call(`/referrals/${movedId}/transfer`, { method: "PUT", token: referrer.token, body: { department: "ask", reason: "x" } });
  assert.equal(r.status, 403, `the referrer got ${r.status}`);
  return "403";
});

await check("A DEPARTMENT THAT DOES NOT HOLD THE CASE CANNOT HAND IT ON", async () => {
  // ASK moving a wellbeing referral would be ASK deciding where a wellbeing disclosure
  // goes next. The 403 comes from the same loader that guards accept, notes and close,
  // which is why a handler added later cannot forget it.
  const r = await call(`/referrals/${movedId}/transfer`, { method: "PUT", token: ask.token, body: { department: "student-support", reason: "x" } });
  assert.equal(r.status, 403, `ASK got ${r.status}`);
  return "403";
});

await check("a case cannot be handed to the department already holding it", async () => {
  const r = await call(`/referrals/${movedId}/transfer`, { method: "PUT", token: well.token, body: { department: "wellbeing", reason: "x" } });
  assert.equal(r.status, 400, `got ${r.status}`);
  return r.body.error;
});

await check("...nor to a department that does not exist", async () => {
  const r = await call(`/referrals/${movedId}/transfer`, { method: "PUT", token: well.token, body: { department: "careers", reason: "x" } });
  assert.equal(r.status, 400, `an invented department got ${r.status}`);
  return r.body.error;
});

await check("...nor with no reason, because the next team has to know why it arrived", async () => {
  for (const reason of ["", "   ", undefined]) {
    const r = await call(`/referrals/${movedId}/transfer`, { method: "PUT", token: well.token, body: { department: "ask", reason } });
    assert.equal(r.status, 400, `reason ${JSON.stringify(reason)} got ${r.status}`);
  }
  return "3 empty reasons, all 400";
});

await check("...and the case has not moved after any of those refusals", async () => {
  const q = await call("/referrals?department=wellbeing", { token: well.token });
  assert.ok(q.body.some((r) => r.id === movedId), "the referral left the wellbeing queue anyway");
  return "still with Wellbeing";
});

// The transfer that actually happens.
const didTransfer = await call(`/referrals/${movedId}/transfer`, {
  method: "PUT", token: well.token, body: { department: "ask", reason: T_REASON },
});

await check("a hand-off moves the case, and resets it to WAITING", async () => {
  assert.equal(didTransfer.status, 200, `transfer answered ${didTransfer.status}: ${JSON.stringify(didTransfer.body).slice(0, 120)}`);
  assert.equal(didTransfer.body.department, "ask");
  // The reset is the point. A case arriving already marked accepted, stamped with a
  // name from another team, is a case the receiving desk has no reason to pick up.
  assert.equal(didTransfer.body.status, "open", `arrived as ${didTransfer.body.status}`);
  assert.equal(didTransfer.body.acceptedBy, null, "it arrived still stamped with who accepted it at the last desk");
  assert.equal(didTransfer.body.acceptedOn, null, "it arrived carrying the last desk's acceptance date");
  return "with ASK, open, unstamped";
});

await check("THE SENDING TEAM'S CASE NOTES DO NOT TRAVEL WITH THE CASE", async () => {
  // The assertion that matters most in this file. Read from ASK's own queue, as a
  // whole-payload substring search rather than a field check — a notes column renamed
  // or duplicated would still be caught.
  const q = await call("/referrals?department=ask", { token: ask.token });
  const row = q.body.find((r) => r.id === movedId);
  assert.ok(row, "the case did not arrive in the ASK queue at all");
  assert.equal(row.notes, "", `ASK received case notes: ${row.notes}`);
  assert.ok(!JSON.stringify(q.body).includes(T_NOTES), "the wellbeing case notes reached the ASK queue");
  return "ASK sees an empty notes field and no canary";
});

await check("...but the referrer's original reason DOES, because both sides always shared it", async () => {
  const q = await call("/referrals?department=ask", { token: ask.token });
  const row = q.body.find((r) => r.id === movedId);
  assert.equal(row.reason, REASON, "the receiving team lost the reason the case was raised for");
  return "reason intact";
});

await check("THE SENDING TEAM CAN STILL READ THE NOTES IT WROTE, ARCHIVED AT THE HAND-OFF", async () => {
  // Deleting them was the rejected option: an officer who mis-clicked would have
  // destroyed their own record, and the college could no longer answer what its
  // wellbeing team knew and when.
  const h = await call(`/referrals/${movedId}/history`, { token: well.token });
  assert.equal(h.status, 200, `wellbeing got ${h.status} on the history of its own hand-off`);
  assert.equal(h.body.length, 1, `expected one transfer, got ${h.body.length}`);
  assert.equal(h.body[0].notesAtTransfer, T_NOTES, "the archived notes are not the ones that were written");
  assert.equal(h.body[0].fromDepartment, "wellbeing");
  assert.equal(h.body[0].toDepartment, "ask");
  return "archived and readable by Wellbeing alone";
});

await check("...and the RECEIVING team cannot, from the same route", async () => {
  const h = await call(`/referrals/${movedId}/history`, { token: ask.token });
  assert.equal(h.status, 200, `ASK got ${h.status} on the history of the case it holds`);
  assert.equal(h.body.length, 1);
  // ABSENT, not empty. sReferralTransfer never names the field and the route adds it
  // back one entry at a time, so a reader who is not on the sending department gets a
  // payload where the key does not exist — which an empty string would not prove.
  assert.ok(!("notesAtTransfer" in h.body[0]), "the field is present for ASK, even if blank");
  assert.ok(!JSON.stringify(h.body).includes(T_NOTES), "the wellbeing notes reached ASK through the history route");
  return "the key is absent for ASK, not merely empty";
});

await check("...nor can the TUTOR who raised it, who never reads case notes at all", async () => {
  const h = await call(`/referrals/${movedId}/history`, { token: referrer.token });
  assert.equal(h.status, 200, `the referrer got ${h.status} on their own referral's history`);
  assert.ok(!("notesAtTransfer" in (h.body[0] || {})), "the referrer was handed the case notes");
  assert.ok(!JSON.stringify(h.body).includes(T_NOTES), "the case notes reached the referrer");
  // The hand-off REASON is shared, deliberately — the tutor is entitled to know their
  // referral moved and why. That is the one field crossing this boundary.
  assert.equal(h.body[0].reason, T_REASON, "the referrer was not told why their referral moved");
  return "reason yes, notes no";
});

await check("somebody who is party to nothing gets 403 from the history, not an empty trail", async () => {
  const h = await call(`/referrals/${movedId}/history`, { token: supp.token });
  assert.equal(h.status, 403, `Student Support got ${h.status}`);
  return "403";
});

await check("the case has genuinely LEFT the sending team's queue", async () => {
  const q = await call("/referrals?department=wellbeing", { token: well.token });
  assert.ok(!q.body.some((r) => r.id === movedId), "it is still in the wellbeing queue as well");
  return "gone from Wellbeing";
});

await check("the receiving department is told, and the notification names no student", async () => {
  const rows = await eventually(async () => {
    const n = await db.notification.findMany({ where: { staffId: ask.id } });
    return n.length ? n : null;
  });
  assert.ok(rows, "ASK was never told the case arrived");
  const blob = JSON.stringify(rows);
  assert.ok(!blob.includes(alice.firstName) && !blob.includes(alice.studentRef), "the notification names the student");
  assert.ok(!blob.includes(REASON) && !blob.includes(T_REASON), "the notification carries a reason");
  return `${rows.length} notifications, no student named`;
});

await check("A CLOSED CASE CANNOT BE HANDED ON — the outcome the referrer was shown stands", async () => {
  const c = await raise({ studentId: alice.id, department: "wellbeing", reason: REASON });
  await call(`/referrals/${c.body.id}/close`, { method: "PUT", token: well.token, body: { outcome: "supported" } });
  const r = await call(`/referrals/${c.body.id}/transfer`, { method: "PUT", token: well.token, body: { department: "ask", reason: "x" } });
  assert.equal(r.status, 409, `a closed referral answered ${r.status}`);
  return "409";
});

/* -------------------------------------------------------------------------- */
/* The conversation                                                            */
/* -------------------------------------------------------------------------- */

// The thread is a THIRD visibility and the suite treats it as one. It is not a window
// onto the case notes and it is not the referrer's reason: both sides wrote it knowing
// the other would read it. What has to be proved is that it is scoped like the notes
// across a hand-off — otherwise it becomes the route by which a wellbeing conversation
// reaches the team the case was passed to.

await check("a department that is party to nothing cannot read the thread", async () => {
  const r = await call(`/referrals/${movedId}/messages`, { token: supp.token });
  assert.equal(r.status, 403, `Student Support got ${r.status}`);
  return "403";
});

await check("an empty message is refused rather than stored", async () => {
  for (const body of ["", "   ", undefined]) {
    const r = await call(`/referrals/${movedId}/messages`, { method: "POST", token: referrer.token, body: { body } });
    assert.equal(r.status, 400, `${JSON.stringify(body)} got ${r.status}`);
  }
  return "3 empty bodies, all 400";
});

await check("the referrer and the department holding the case can both write to it", async () => {
  const a = await call(`/referrals/${movedId}/messages`, { method: "POST", token: referrer.token, body: { body: MSG_TUTOR } });
  const b = await call(`/referrals/${movedId}/messages`, { method: "POST", token: ask.token, body: { body: MSG_ASK } });
  assert.equal(a.status, 201, `the referrer got ${a.status}`);
  assert.equal(b.status, 201, `ASK got ${b.status}`);
  // The ROLE is stamped from who is asking, not from a field the client sends.
  assert.equal(a.body.authorRole, "referrer");
  assert.equal(b.body.authorRole, "department");
  return "referrer and department, both stamped by the server";
});

// A message written under WELLBEING, before the hand-off. Written directly, because the
// case has already moved and the route would now stamp it with ASK — which is correct
// behaviour and exactly why the fixture cannot go through it.
await db.referralMessage.create({
  data: { referralId: movedId, department: "wellbeing", authorRole: "department", authorName: well.name, body: MSG_WELL },
});

await check("A TEAM THAT HANDED A CASE ON DOES NOT SEE THE PREVIOUS TEAM'S THREAD", async () => {
  // The mirror of the case-notes rule, and the one a reader is most likely to widen
  // later for a screen they are building: the referral is one row, so a thread scoped
  // to the referral rather than the department reads perfectly sensibly and hands ASK
  // a conversation Wellbeing had about a disclosure.
  const r = await call(`/referrals/${movedId}/messages`, { token: ask.token });
  assert.equal(r.status, 200);
  const blob = JSON.stringify(r.body);
  assert.ok(!blob.includes(MSG_WELL), "ASK can read the wellbeing thread");
  assert.ok(blob.includes(MSG_ASK), "ASK cannot read its own thread");
  return `${r.body.length} messages, none of them Wellbeing's`;
});

await check("...while the sending team still reads its own, having been part of it", async () => {
  const r = await call(`/referrals/${movedId}/messages`, { token: well.token });
  assert.equal(r.status, 200, `wellbeing got ${r.status}`);
  const blob = JSON.stringify(r.body);
  assert.ok(blob.includes(MSG_WELL), "Wellbeing lost the thread it wrote");
  assert.ok(!blob.includes(MSG_ASK), "Wellbeing can read ASK's thread");
  return "its own thread, and only its own";
});

await check("...and a team that has handed a case on can no longer REPLY to it", async () => {
  // Reading is wider than writing here on purpose. A case being answered by two teams
  // at once is how a student gets two different answers.
  const r = await call(`/referrals/${movedId}/messages`, { method: "POST", token: well.token, body: { body: "should not land" } });
  assert.equal(r.status, 403, `wellbeing got ${r.status} posting to a case it handed on`);
  return "403";
});

await check("THE REFERRER READS THE WHOLE THREAD, because every message was written to or by them", async () => {
  const r = await call(`/referrals/${movedId}/messages`, { token: referrer.token });
  assert.equal(r.status, 200);
  const blob = JSON.stringify(r.body);
  for (const canary of [MSG_TUTOR, MSG_ASK, MSG_WELL]) {
    assert.ok(blob.includes(canary), "the referrer is missing part of their own thread");
  }
  // And the thread is still not a way round the case notes.
  assert.ok(!blob.includes(T_NOTES), "the case notes reached the referrer through the thread");
  return `${r.body.length} messages, no case notes`;
});

/* -------------------------------------------------------------------------- */
/* What the student is told                                                    */
/* -------------------------------------------------------------------------- */

// The student portal's view exists because a college that refers somebody to Wellbeing
// and never tells them has a support service the student cannot find. What it must NOT
// do is defeat the tickbox that decides whether they are told at all.
const A_PASSWORD = `RefStudent!${stamp}`;
await db.student.update({ where: { id: alice.id }, data: { passwordHash: bcrypt.hashSync(A_PASSWORD, 10), tokenVersion: 0 } });
const aliceLogin = await call("/auth/login", { method: "POST", body: { email: alice.email, password: A_PASSWORD } });
const aliceToken = aliceLogin.body?.token;

// Two referrals for the same student, differing only in the tickbox.
//
// WELLBEING, not Student Support: the retirement test above has already closed that
// desk, and the tidy-up does not reopen it until after this block. A fixture raised
// against a retired department is refused, and the assertion below then fails for a
// reason that has nothing to do with what it is testing.
const told = await raise({ studentId: alice.id, department: "wellbeing", reason: REASON, notifyStudent: true });
const notTold = await raise({ studentId: alice.id, department: "wellbeing", reason: REASON, notifyStudent: false });
if (!told.body?.id || !notTold.body?.id) {
  console.log(`✗ could not raise the student-portal fixtures: ${JSON.stringify(told.body).slice(0, 120)}`);
}

await check("A STUDENT IS SHOWN ONLY THE REFERRALS THEY WERE TOLD ABOUT", async () => {
  // The whole point of the tickbox. It defaults OFF so a tutor raising a safeguarding
  // concern does not have to remember to suppress anything — and a portal listing every
  // referral would surface that concern to the student the same evening.
  if (!aliceToken) return "skipped — could not sign the student in";
  const r = await call("/student/me/referrals", { token: aliceToken });
  assert.equal(r.status, 200, `the student got ${r.status}`);
  const ids = r.body.map((x) => x.id);
  assert.ok(ids.includes(told.body.id), "the student cannot see the referral they were told about");
  assert.ok(!ids.includes(notTold.body.id), "THE STUDENT CAN SEE A REFERRAL RAISED WITH THE TICKBOX OFF");
  return `${r.body.length} shown, the unticked one withheld`;
});

await check("...and the student's view carries EXACTLY these fields and no others", async () => {
  if (!aliceToken) return "skipped — could not sign the student in";
  const r = await call("/student/me/referrals", { token: aliceToken });
  const row = r.body.find((x) => x.id === told.body.id);
  // selfReferred joined the set when the student forms landed. `reason` is deliberately
  // NOT here: this row was raised by a tutor, and on those the reason is that tutor's
  // account of the student and never crosses. The self-referral tests above assert the
  // other half — that a student DOES get their own words back.
  const expected = ["id", "department", "departmentName", "status", "outcome", "raisedOn", "acceptedOn", "closedOn", "selfReferred"];
  assert.deepEqual(Object.keys(row).sort(), [...expected].sort(),
    `the student's payload is ${Object.keys(row).sort().join(", ")}`);
  return `${expected.length} keys, exactly as declared`;
});

await check("...so the tutor's REASON never reaches the student it was written about", async () => {
  if (!aliceToken) return "skipped — could not sign the student in";
  const r = await call("/student/me/referrals", { token: aliceToken });
  const blob = JSON.stringify(r.body);
  for (const canary of [REASON, NOTES, DETAIL, T_NOTES, MSG_WELL, MSG_ASK]) {
    assert.ok(!blob.includes(canary), "the student's payload carries text written about them for somebody else");
  }
  // And the department is named rather than slugged.
  assert.ok(r.body.every((x) => x.departmentName && x.departmentName !== x.department), "the student is being shown a slug");
  return "no reason, no notes, no thread — and a name rather than a key";
});

await check("A STUDENT TOKEN CANNOT REACH THE STAFF REFERRAL ROUTES AT ALL", async () => {
  // The router allowlist, not a per-route check. A student reaching /api/referrals would
  // be reading a queue of other students' disclosures.
  if (!aliceToken) return "skipped — could not sign the student in";
  const attempts = [
    ["/referrals/departments", "GET"],
    ["/referrals?department=wellbeing", "GET"],
    ["/referrals/mine", "GET"],
    [`/referrals/${movedId}/messages`, "GET"],
    [`/referrals/${movedId}/history`, "GET"],
  ];
  for (const [path, method] of attempts) {
    const r = await call(path, { method, token: aliceToken });
    assert.equal(r.status, 403, `${method} ${path} answered ${r.status} to a student`);
  }
  return `${attempts.length} routes, all 403`;
});

await check("the transfer and the message are in the audit trail, and neither carries its prose", async () => {
  const rows = await eventually(async () => {
    const e = await db.auditLog.findMany({ where: { entity: "Referral" } });
    const acts = new Set(e.map((x) => x.action));
    return acts.has("referral.transferred") && acts.has("referral.messaged") ? e : null;
  });
  assert.ok(rows, "no audit row records a transfer or a message");
  const blob = JSON.stringify(rows);
  // The hand-off reason is shared between the three people involved. It is still prose
  // written about a student, and the audit log is read on Settings by administrators who
  // were never granted this page.
  assert.ok(!blob.includes(T_REASON), "the audit trail carries the hand-off reason");
  assert.ok(!blob.includes(T_NOTES), "the audit trail carries the archived case notes");
  for (const canary of [MSG_TUTOR, MSG_ASK, MSG_WELL]) {
    assert.ok(!blob.includes(canary), "the audit trail carries the text of a message");
  }
  return "two more verbs, no prose";
});

/* -------------------------------------------------------------------------- */
/* A student asking a support team for help themselves                         */
/* -------------------------------------------------------------------------- */

// Until now the only way into the Wellbeing or ASK queue was a member of staff raising a
// referral, so a student who knew they were struggling had no route to either team. The
// form fills that. What has to be proved is that it did not open a hole on the way in:
// a self-referral must not become readable as somebody else's case, must not let a
// student write into a tutor's thread, and must not let one person flood a queue.

const SELF_REASON = `SELFREF-CANARY-${stamp}`;
const SELF_MSG = `SELFMSG-CANARY-${stamp}`;

await check("the form offers only departments the college is actually running", async () => {
  if (!aliceToken) return "skipped — could not sign the student in";
  const r = await call("/student/me/support-departments", { token: aliceToken });
  assert.equal(r.status, 200, `got ${r.status}`);
  const keys = r.body.map((d) => d.key);
  assert.ok(keys.includes("wellbeing") && keys.includes("ask"), `offered ${keys.join(", ")}`);
  // Names, never slugs — a student picking a team should not be shown a database key.
  assert.ok(r.body.every((d) => d.name && d.name !== d.key), "a department came back as a bare key");
  return keys.join(", ");
});

let selfId = null;
await check("A STUDENT CAN ASK A TEAM FOR HELP, and it lands in that team's queue", async () => {
  if (!aliceToken) return "skipped — could not sign the student in";
  const r = await call("/student/me/referrals", {
    method: "POST", token: aliceToken,
    body: { department: "wellbeing", reason: SELF_REASON, urgency: "urgent" },
  });
  assert.equal(r.status, 201, `got ${r.status}: ${JSON.stringify(r.body).slice(0, 140)}`);
  selfId = r.body.id;
  assert.equal(r.body.selfReferred, true, "it was not marked as self-referred");
  // The wellbeing officer must see it in the ordinary queue, not in a second inbox.
  const q = await call("/referrals?department=wellbeing", { token: well.token });
  const row = q.body.find((x) => x.id === selfId);
  assert.ok(row, "the request never reached the wellbeing queue");
  assert.equal(row.reason, SELF_REASON, "the student's own words did not arrive");
  assert.equal(row.raisedBy, null, "a self-referral was stamped with a staff name");
  return `in the queue, urgency ${row.urgency}`;
});

await check("...and it never appears in a colleague's Sent by me", async () => {
  // /referrals/mine matches on raisedBy, which a self-referral deliberately leaves null.
  for (const [who, token] of [["the referrer", referrer.token], ["the wellbeing officer", well.token]]) {
    const r = await call("/referrals/mine", { token });
    assert.ok(!r.body.some((x) => x.id === selfId), `it showed up in ${who}'s Sent by me`);
  }
  return "absent from both";
});

await check("...and the student is shown THEIR OWN words back", async () => {
  if (!aliceToken) return "skipped — could not sign the student in";
  const r = await call("/student/me/referrals", { token: aliceToken });
  const row = r.body.find((x) => x.id === selfId);
  assert.ok(row, "the student cannot see the request they just made");
  assert.equal(row.reason, SELF_REASON, "the student cannot read what they themselves wrote");
  assert.equal(row.selfReferred, true);
  return "their own reason, returned";
});

await check("A TUTOR'S REFERRAL STILL WITHHOLDS ITS REASON FROM THE STUDENT", async () => {
  // The whole point of making `reason` conditional. A staff referral's reason is
  // somebody else's account of this student, written for a third party, and self-referral
  // must not have opened it up.
  if (!aliceToken) return "skipped — could not sign the student in";
  const r = await call("/student/me/referrals", { token: aliceToken });
  const staffRaised = r.body.filter((x) => x.selfReferred === false);
  assert.ok(staffRaised.length, "no staff-raised referral to check against");
  for (const row of staffRaised) {
    assert.ok(!("reason" in row), `a staff referral carried a reason: ${JSON.stringify(Object.keys(row))}`);
  }
  assert.ok(!JSON.stringify(staffRaised).includes(REASON), "the tutor's reason reached the student");
  return `${staffRaised.length} staff referrals, none carrying a reason`;
});

await check("an empty or absent reason is refused", async () => {
  if (!aliceToken) return "skipped — could not sign the student in";
  for (const reason of ["", "  ", "x", undefined]) {
    const r = await call("/student/me/referrals", { method: "POST", token: aliceToken, body: { department: "ask", reason } });
    assert.equal(r.status, 400, `${JSON.stringify(reason)} got ${r.status}`);
  }
  return "4 empty reasons, all 400";
});

await check("a team the college does not run is refused", async () => {
  if (!aliceToken) return "skipped — could not sign the student in";
  for (const department of ["careers", "", "WELLBEING; DROP TABLE", undefined]) {
    const r = await call("/student/me/referrals", { method: "POST", token: aliceToken, body: { department, reason: "help please" } });
    assert.equal(r.status, 400, `${JSON.stringify(department)} got ${r.status}`);
  }
  return "4 unknown departments, all 400";
});

await check("ONE OPEN REQUEST PER TEAM — a double tap does not make two cases", async () => {
  if (!aliceToken) return "skipped — could not sign the student in";
  const r = await call("/student/me/referrals", {
    method: "POST", token: aliceToken, body: { department: "wellbeing", reason: "again" },
  });
  assert.equal(r.status, 409, `a second open request got ${r.status}`);
  // It names the existing one, so the app can point at it rather than inventing a reason.
  assert.equal(r.body.referralId, selfId, "the refusal did not name the request already open");
  const q = await call("/referrals?department=wellbeing", { token: well.token });
  assert.equal(q.body.filter((x) => x.selfReferred && x.studentId === alice.id).length, 1, "a duplicate reached the queue anyway");
  return "409, one case in the queue";
});

await check("...but a DIFFERENT team is not blocked by it", async () => {
  // The dedupe must not become a gag. Someone already talking to Wellbeing may still
  // have a coursework question for ASK.
  if (!aliceToken) return "skipped — could not sign the student in";
  const r = await call("/student/me/referrals", { method: "POST", token: aliceToken, body: { department: "ask", reason: "coursework" } });
  assert.equal(r.status, 201, `asking a second team got ${r.status}`);
  return "ASK accepted it";
});

await check("a student can add to their own request rather than starting another", async () => {
  if (!aliceToken) return "skipped — could not sign the student in";
  const r = await call(`/student/me/referrals/${selfId}/messages`, { method: "POST", token: aliceToken, body: { body: SELF_MSG } });
  assert.equal(r.status, 201, `got ${r.status}`);
  assert.equal(r.body.authorRole, "student", `stamped as ${r.body.authorRole}`);
  const back = await call(`/student/me/referrals/${selfId}/messages`, { token: aliceToken });
  assert.ok(JSON.stringify(back.body).includes(SELF_MSG), "the message did not come back");
  // And the department working the case sees it.
  const dept = await call(`/referrals/${selfId}/messages`, { token: well.token });
  assert.ok(JSON.stringify(dept.body).includes(SELF_MSG), "the team cannot see what the student added");
  return "written, and visible to Wellbeing";
});

await check("A STUDENT CANNOT READ OR WRITE THE THREAD ON A TUTOR'S REFERRAL", async () => {
  // The sharpest one. That thread is between a tutor and a department, written by two
  // people who did not know the student would read it — so the student routes are scoped
  // to selfReferred, not merely to "a referral about me".
  if (!aliceToken) return "skipped — could not sign the student in";
  const staffRaised = told.body?.id;
  assert.ok(staffRaised, "no staff-raised referral to test against");
  const r = await call(`/student/me/referrals/${staffRaised}/messages`, { token: aliceToken });
  assert.equal(r.status, 404, `reading a tutor's thread got ${r.status}`);
  const w = await call(`/student/me/referrals/${staffRaised}/messages`, { method: "POST", token: aliceToken, body: { body: "let me in" } });
  assert.equal(w.status, 404, `writing to a tutor's thread got ${w.status}`);
  return "404 on both, not merely empty";
});

await check("...nor another student's request at all", async () => {
  if (!aliceToken) return "skipped — could not sign the student in";
  // Bob's, reached with Alice's token. Scoped on studentId, so this is a 404 rather than
  // a leak — and a 404 rather than a 403, because confirming the id names a real request
  // would itself say something about Bob.
  const bobs = await raise({ studentId: bob.id, department: "wellbeing", reason: REASON, notifyStudent: true });
  const r = await call(`/student/me/referrals/${bobs.body.id}/messages`, { token: aliceToken });
  assert.equal(r.status, 404, `got ${r.status}`);
  const list = await call("/student/me/referrals", { token: aliceToken });
  assert.ok(!list.body.some((x) => x.id === bobs.body.id), "another student's referral appeared in this student's list");
  return "404, and absent from their list";
});

await check("the receiving team is told, and the notification still names no student", async () => {
  const rows = await eventually(async () => {
    const n = await db.notification.findMany({ where: { staffId: well.id, message: { contains: "asked" } } });
    return n.length ? n : null;
  });
  assert.ok(rows, "Wellbeing was never told a student had asked for support");
  const blob = JSON.stringify(rows);
  assert.ok(!blob.includes(alice.firstName) && !blob.includes(alice.studentRef), "the notification names the student");
  assert.ok(!blob.includes(SELF_REASON), "the notification carries what they wrote");
  return `${rows.length} notifications, no student named`;
});

await check("the audit trail records the request and never what it said", async () => {
  const rows = await eventually(async () => {
    const e = await db.auditLog.findMany({ where: { action: "referral.selfRaised" } });
    return e.length ? e : null;
  });
  assert.ok(rows, "nothing recorded referral.selfRaised");
  const blob = JSON.stringify(rows);
  assert.ok(!blob.includes(SELF_REASON), "the audit trail carries what the student wrote");
  assert.ok(!blob.includes(SELF_MSG), "the audit trail carries the text of a message");
  return `${rows.length} rows, no prose`;
});

/* -------------------------------------------------------------------------- */
/* The Super Admin, who is not exempt and therefore has to be able to join      */
/* -------------------------------------------------------------------------- */

// HOLDING EVERY PAGE IS NOT THE SAME AS BEING ON THE WELLBEING TEAM.
//
// canReadDepartment deliberately does not exempt a Super Admin: one is a claim about
// administrative authority, the other about who reads a student's disclosures. That
// decision is only defensible if the Super Admin can PUT THEMSELVES on a team — and
// PUT /staff/:id/access refused every edit to a Super Admin outright, so they could
// not. The account that sets a college up held the Referrals page, saw the parent in
// the sidebar, and found nothing under it. These four checks are that round trip.

await check("A SUPER ADMIN SEES NO QUEUE UNTIL THEY JOIN ONE — every page is not every desk", async () => {
  const r = await call("/referrals?department=wellbeing", { token: boss.token });
  assert.equal(r.status, 403, `the Super Admin got ${r.status} on a department they are not on`);
  return "403, exactly as anybody else";
});

await check("...and the access route still refuses to touch their PAGES", async () => {
  // The half that must not change. A request carrying no supportDepartments can only
  // be an attempt to re-grant, and that is the thing this guard exists for.
  const r = await call(`/staff/${boss.id}/access`, { method: "PUT", token: boss.token, body: { pages: [] } });
  assert.equal(r.status, 400, `demoting the Super Admin answered ${r.status}`);
  return r.body.error;
});

await check("...but they CAN put themselves on a team, which is the documented way out", async () => {
  const r = await call(`/staff/${boss.id}/access`, {
    method: "PUT", token: boss.token,
    // `pages: []` rides along exactly as the Access screen sends it. The server must
    // ignore it for this account rather than trusting the client not to send it — so
    // this asserts the demotion did NOT happen while the membership did.
    body: { pages: [], supportDepartments: ["wellbeing"] },
  });
  assert.equal(r.status, 200, `joining answered ${r.status}: ${JSON.stringify(r.body).slice(0, 120)}`);
  assert.deepEqual(r.body.supportDepartments, ["wellbeing"], "membership was not stored");
  assert.equal(r.body.isSuperAdmin, true, "the Super Admin was demoted by a membership change");
  const row = await db.staff.findUnique({ where: { id: boss.id } });
  assert.equal(row.accountRole, "ADMIN", `accountRole became ${row.accountRole}`);
  assert.equal(row.adminPages, null, "the Super Admin's page grant was rewritten");
  return "on wellbeing, still unrestricted";
});

await check("...and the queue opens for them the moment they are on it", async () => {
  const r = await call("/referrals?department=wellbeing", { token: boss.token });
  assert.equal(r.status, 200, `the Super Admin still got ${r.status} after joining`);
  return `${r.body.length} in the queue`;
});

await check("a department key the college does not have is dropped, not stored", async () => {
  // The filter is against the college's OWN list, so a key naming no department cannot
  // sit dormant in the column and come to life if somebody later creates that desk.
  const r = await call(`/staff/${boss.id}/access`, {
    method: "PUT", token: boss.token, body: { pages: [], supportDepartments: ["wellbeing", "careers"] },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.supportDepartments, ["wellbeing"], `stored ${JSON.stringify(r.body.supportDepartments)}`);
  return "unknown key dropped";
});

await check("AN ORDINARY ADMIN CANNOT HAND OUT DEPARTMENT MEMBERSHIP AT ALL", async () => {
  // The route is Super-Admin-only, and this is the assertion that keeps it that way:
  // membership decides who reads a student's disclosures, so it is not something a
  // colleague with the Staff page can grant themselves.
  const r = await call(`/staff/${ask.id}/access`, {
    method: "PUT", token: well.token, body: { pages: ["referrals"], supportDepartments: ["wellbeing"] },
  });
  assert.equal(r.status, 403, `a wellbeing officer got ${r.status}`);
  const row = await db.staff.findUnique({ where: { id: ask.id } });
  assert.equal(row.supportDepartments, JSON.stringify(["ask"]), "ASK's membership was changed anyway");
  return "403, membership untouched";
});

/* -------------------------------------------------------------------------- */
/* Tidy up                                                                     */
/* -------------------------------------------------------------------------- */

// The department list goes back to the platform defaults. It is a singleton row shared
// by everything that runs after this suite, and leaving Student Support retired would
// hand the next reader a college that quietly reorganised itself.
await call("/referrals/departments", {
  method: "PUT", token: adminToken,
  body: {
    departments: [
      { key: "wellbeing", name: "Wellbeing", active: true },
      { key: "ask", name: "ASK", active: true },
      { key: "student-support", name: "Student Support", active: true },
    ],
  },
});

await check("the department list is back to the platform defaults for the suites after this one", async () => {
  const r = await call("/referrals/departments", { token: adminToken });
  assert.ok(r.body.departments.every((d) => d.active), "a department is still retired");
  return r.body.departments.map((d) => d.key).join(", ");
});

// The student goes back to having no password. Seeded students have passwordHash null
// and the student-portal suite asserts on that state, so leaving one signed-in-able
// would be this suite changing another one's world.
await db.student.update({ where: { id: alice.id }, data: { passwordHash: null, tokenVersion: 0 } }).catch(() => {});

// There is no DELETE route for a referral, deliberately — a case record is not
// something a caseworker may remove. So the fixtures go out the way they came in.
await db.referral.deleteMany({ where: { id: { in: createdReferrals } } });
await db.interaction.deleteMany({ where: { id: { in: [bobsMeeting.id, alicesMeeting.id] } } });
await db.notification.deleteMany({ where: { staffId: { in: Object.values(people).map((p) => p.id) } } });
// The staff fixtures go LAST, after every assertion that used their tokens. Leaving
// them behind would give the college four extra administrators, which is a change to
// smoke-account-deletion.mjs's world and not only to this suite's.
await db.staff.deleteMany({ where: { email: { in: Object.values(people).map((p) => p.email) } } });
await db.supportDepartmentConfig.deleteMany({ where: { id: "singleton" } });
await db.$disconnect();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
