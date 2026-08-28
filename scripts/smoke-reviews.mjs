// Reviews — the three routers that hold the most sensitive free text in the product:
//
//   /api/staff-reviews    an appraisal of a named colleague, written by their reviewer
//   /api/my-reviews       a lecturer's OWN self-reflection, from the staff app
//   /api/student-reviews  a lecturer's candid record of a progress conversation
//
// Every incident this suite guards against is a confidentiality or an integrity one,
// not an outage: a lecturer reading the management review that recommends escalating
// them to the COO, a colleague's appraisal being silently re-attributed to somebody
// else, a submitted reflection being quietly rewritten after the reviewer read it, or
// the whole student roster's email addresses going out to every member of staff.
// Those failures are invisible in production until somebody is sitting in a grievance
// hearing holding a printout, which is why they are asserted here.
//
//   npm test -- smoke-reviews
//   (needs API_URL + DATABASE_URL; the runner supplies both)
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "..", "server");
const require = createRequire(pathToFileURL(join(server, "package.json")));

// API_URL, not API_BASE: the runner sets API_URL, and a suite that reads anything else
// silently talks to a port nobody is listening on and "fails" for reasons that have
// nothing to do with the feature under test.
const BASE = process.env.API_URL || "http://localhost:4000/api";
const PASSWORD = process.env.SEED_PASSWORD || "test-seed-password-2026";
const TENANT = "default";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required — point it at a throwaway database.");
  process.exit(1);
}

const { PrismaClient } = require(join(server, "node_modules", "@prisma", "client"));
const bcrypt = require(join(server, "node_modules", "bcryptjs"));
// A BARE client: no tenant extension. Several assertions here are precisely "the API
// did not write what the caller asked it to write" — the stored staffId, the stripped
// hidden answer, the row that survived a delete attempt — and those can only be settled
// by reading the row the API produced rather than the JSON it chose to hand back.
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

async function call(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json", "X-Tenant": TENANT };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch (_) { /* empty body */ }
  return { status: res.status, data };
}

async function login(email, password = PASSWORD) {
  const r = await call("/auth/login", { method: "POST", body: { email, password } });
  if (r.status !== 200 || !r.data?.token) throw new Error(`login failed for ${email}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.token;
}

const RUN = Date.now().toString(36);
// Everything this suite creates is tracked so the `finally` can put the shared seeded
// database back exactly as it found it — eight suites run against one seed, in one
// process, and a leftover review shows up in somebody else's list assertion as their bug.
const madeStaffReviews = new Set();
const madeStudentReviews = new Set();
let narrowAdminId = null;

// A complete, valid Strategic Lecturer Self-Reflection. Every question on the form is
// required, so this doubles as the fixture that proves the required checks are the only
// thing standing between a part-finished draft and a filed record.
const strategicAnswers = (over = {}) => ({
  fullName: "James Whitfield",
  courseTitle: "HND Business",
  reviewTerm: "Term 2",
  academicYear: "2025/26",
  dateCompleted: "2026-03-01",
  overallPerformance: "Good",
  achievements: "Retention up, two new schemes of work, moderation cleared early.",
  proudOf: "The Y12 cohort's turnaround on unit 4.",
  successfulApproaches: "Low-stakes weekly quizzing.",
  improveTeaching: "Stretch tasks for the top quartile.",
  studentEngagement: "Effectively",
  attendanceReflection: "Attendance held above 90% except in exam fortnight.",
  achievementReflection: "Merit rate up on last term; two referrals resolved.",
  additionalSupport: "No",
  professionalPractice: {
    lessonPreparation: "Very effectively",
    assessmentPlanning: "Very effectively",
    markingDeadlines: "Somewhat effectively",
    studentCommunication: "Very effectively",
    recordKeeping: "Very effectively",
    compliance: "Somewhat effectively",
  },
  cpdCompleted: "Safeguarding refresher and an assessment-design workshop.",
  cpdImpact: "Rewrote the assignment briefs to be criterion-referenced.",
  furtherDevelopment: "Coaching on differentiation.",
  previousActions: "Marking turnaround target met in 9 weeks of 12.",
  actionEvidence: "The turnaround log and the internal verification sample.",
  nextTermPriorities: "Stretch, marking turnaround, parental contact.",
  supportNeeded: "Protected time for moderation.",
  operationalIssues: "No",
  oneChange: "Move the mock earlier in the term.",
  anythingElse: "Nothing further.",
  declaration: "Yes",
  ...over,
});

try {
  const admin = await login("admin@edtech.co.uk");
  const s1 = await login("j.whitfield@edtech.co.uk");   // James Whitfield, STAFF
  const s2 = await login("a.rahman@edtech.co.uk");      // Aisha Rahman, STAFF

  // ------------------------------------------------------------------
  console.log("\n--- /api/staff-reviews: an appraisal is not staffroom reading ---");

  // The whole router is page-gated, READS INCLUDED. That is the difference between a
  // performance review system and a rumour mill: an ordinary lecturer must not be able
  // to pull a colleague's — or their own — management review out of the admin API,
  // because the monthly form carries "Intervention Required" and an escalate-to-COO
  // question written about a named person.
  const staffPeek = await call("/staff-reviews", { token: s1 });
  check("ordinary staff cannot read the admin review register", staffPeek.status === 403, `HTTP ${staffPeek.status}`);
  const staffForms = await call("/staff-reviews/forms", { token: s1 });
  check("...not even the form definitions", staffForms.status === 403, `HTTP ${staffForms.status}`);

  const forms = await call("/staff-reviews/forms", { token: admin });
  const formTypes = (forms.data || []).map((f) => f.type);
  check("admin is served all four form definitions",
    forms.status === 200 && ["strategic", "monthly", "evaluation", "teaching-quality"].every((t) => formTypes.includes(t)),
    formTypes.join(","));

  // A review must be ABOUT somebody who exists and OF a form that exists. Both are
  // stored as bare strings, so without these checks a typo files an appraisal against a
  // staff id that will never resolve — an orphan nobody can find, read or delete.
  const badType = await call("/staff-reviews", { method: "POST", token: admin, body: { type: "annual-chat", staffId: "s1", answers: {} } });
  check("an unknown form type is refused", badType.status === 400, `HTTP ${badType.status} ${badType.data?.error || ""}`);
  const badStaff = await call("/staff-reviews", { method: "POST", token: admin, body: { type: "strategic", staffId: `ghost-${RUN}`, answers: strategicAnswers() } });
  check("a review about a non-existent colleague is refused",
    badStaff.status === 400 && /Unknown staff/i.test(badStaff.data?.error || ""),
    `HTTP ${badStaff.status} ${badStaff.data?.error || ""}`);

  // Filing a review with the questions unanswered produces a record that reads as a
  // completed appraisal in the register and is empty when opened.
  const emptySubmit = await call("/staff-reviews", { method: "POST", token: admin, body: { type: "strategic", staffId: "s1", answers: {} } });
  check("a submitted review must carry its required answers", emptySubmit.status === 400, `HTTP ${emptySubmit.status} ${emptySubmit.data?.error || ""}`);

  const draft = await call("/staff-reviews", { method: "POST", token: admin, body: { type: "strategic", staffId: "s1", status: "draft", answers: { fullName: "James Whitfield" } } });
  if (draft.data?.id) madeStaffReviews.add(draft.data.id);
  check("a part-finished review saves as a draft", draft.status === 201 && draft.data?.status === "draft", `HTTP ${draft.status}`);

  // Gating validation on `answers` alone let PUT {"status":"submitted"} promote a
  // one-answer draft straight into the record without ever running the required checks
  // — and a submitted reflection then locks, so the lecturer was left unable to correct
  // the empty appraisal now filed in their name.
  const sneakySubmit = await call(`/staff-reviews/${draft.data?.id}`, { method: "PUT", token: admin, body: { status: "submitted" } });
  check("a status flip cannot smuggle an unvalidated draft into the record", sneakySubmit.status === 400, `HTTP ${sneakySubmit.status} ${sneakySubmit.data?.error || ""}`);
  const stillDraft = await call(`/staff-reviews/${draft.data?.id}`, { token: admin });
  check("...and the rejected submit left the draft as it was", stillDraft.data?.status === "draft", `status=${stillDraft.data?.status}`);

  const filed = await call("/staff-reviews", { method: "POST", token: admin, body: { type: "strategic", staffId: "s1", answers: strategicAnswers() } });
  if (filed.data?.id) madeStaffReviews.add(filed.data.id);
  // term / academicYear / dateCompleted are lifted OUT of the answers at write time so a
  // list never parses the answers JSON to render a row. When the lifting list drifted
  // from the question ids it was copied from, every Evaluation showed a blank date for
  // months and nobody noticed until an audit asked when the reviews had happened.
  check("the list fields are lifted out of the answers",
    filed.status === 201 && filed.data?.term === "Term 2" && filed.data?.academicYear === "2025/26" && filed.data?.dateCompleted === "2026-03-01",
    `term=${filed.data?.term} year=${filed.data?.academicYear} date=${filed.data?.dateCompleted}`);

  // Who a review is about, and which questions it answers, are both fixed at creation.
  // Moving either leaves a body of candid commentary attached to the wrong colleague, or
  // to a set of questions it does not answer — the worst silent failure this feature has.
  const reattribute = await call(`/staff-reviews/${filed.data?.id}`, { method: "PUT", token: admin, body: { staffId: "s2", type: "monthly", answers: strategicAnswers() } });
  const afterMove = await db.staffReview.findUnique({ where: { id: filed.data?.id } });
  check("an edit cannot re-attribute a review to another colleague",
    reattribute.status === 200 && afterMove?.staffId === "s1" && afterMove?.type === "strategic",
    `HTTP ${reattribute.status} staffId=${afterMove?.staffId} type=${afterMove?.type}`);

  // The answer validator is the only thing between the review — and the PDF and the CSV
  // built from it — and whatever JSON a client happens to send. Each of these got
  // through in some form once: an impossible date rolled over into a real one, an object
  // stored as the literal "[object Object]", and a long paste silently truncated at
  // 5,000 characters that the author only discovered on reopening the review.
  const badDate = await call("/staff-reviews", { method: "POST", token: admin, body: { type: "strategic", staffId: "s1", answers: strategicAnswers({ dateCompleted: "2039-02-30" }) } });
  check("an impossible date is refused rather than rolled over", badDate.status === 400, `HTTP ${badDate.status} ${badDate.data?.error || ""}`);
  const badText = await call("/staff-reviews", { method: "POST", token: admin, body: { type: "strategic", staffId: "s1", answers: strategicAnswers({ proudOf: { note: "not text" } }) } });
  check("a non-text answer is refused, not stringified", badText.status === 400 && /expected text/i.test(badText.data?.error || ""), `HTTP ${badText.status} ${badText.data?.error || ""}`);
  const tooLong = await call("/staff-reviews", { method: "POST", token: admin, body: { type: "strategic", staffId: "s1", answers: strategicAnswers({ achievements: "x".repeat(5001) }) } });
  check("an over-length answer is refused, not truncated", tooLong.status === 400 && /too long/i.test(tooLong.data?.error || ""), `HTTP ${tooLong.status} ${tooLong.data?.error || ""}`);
  const badOption = await call("/staff-reviews", { method: "POST", token: admin, body: { type: "strategic", staffId: "s1", answers: strategicAnswers({ overallPerformance: "Outstanding" }) } });
  check("an off-list choice is refused", badOption.status === 400, `HTTP ${badOption.status} ${badOption.data?.error || ""}`);

  // A question that is not being asked has no answer. Recording "no students at risk"
  // and storing the description of the risk anyway puts a contradiction into the printed
  // review: the reviewer flips the trigger, the stale detail survives underneath it.
  const monthly = await call("/staff-reviews", { method: "POST", token: admin, body: { type: "monthly", staffId: "s1", status: "draft", answers: { studentsAtRisk: "No", riskDetail: "Two learners flagged for attendance." } } });
  if (monthly.data?.id) madeStaffReviews.add(monthly.data.id);
  check("a hidden question's answer is not stored",
    monthly.status === 201 && monthly.data?.answers?.studentsAtRisk === "No" && monthly.data?.answers?.riskDetail === undefined,
    `HTTP ${monthly.status} riskDetail=${JSON.stringify(monthly.data?.answers?.riskDetail)}`);

  // Filters are validated rather than silently ignored. A mistyped status that quietly
  // returned everything would show an admin the entire register while they believed they
  // were looking only at drafts.
  const badStatus = await call("/staff-reviews?status=filed", { token: admin });
  const badFilterType = await call("/staff-reviews?type=annual", { token: admin });
  check("mistyped list filters are refused, not ignored", badStatus.status === 400 && badFilterType.status === 400, `status=${badStatus.status} type=${badFilterType.status}`);

  // Postgres sorts NULLs FIRST on a DESC column, so before `nulls:"last"` an undated
  // draft pinned itself above every properly dated review at the top of the register —
  // the newest completed appraisal was never the first thing an admin saw.
  const list = await call("/staff-reviews?staffId=s1", { token: admin });
  const dates = (list.data || []).map((r) => r.dateCompleted);
  const firstNull = dates.indexOf(null);
  check("undated drafts sort below dated reviews, not above them",
    list.status === 200 && dates.length >= 3 && firstNull > 0 && dates.slice(firstNull).every((d) => d === null),
    JSON.stringify(dates));

  const goneDelete = await call(`/staff-reviews/no-such-review-${RUN}`, { method: "DELETE", token: admin });
  check("deleting a review that is not there is a 404, not a 500", goneDelete.status === 404, `HTTP ${goneDelete.status}`);

  // ------------------------------------------------------------------
  console.log("\n--- /api/my-reviews: your own reflection, and only that ---");

  const mineForms = await call("/my-reviews/forms", { token: s1 });
  const mineTypes = (mineForms.data || []).map((f) => f.type);
  check("only self-service forms are offered to a lecturer",
    mineForms.status === 200 && mineTypes.includes("strategic") && !mineTypes.includes("monthly") && !mineTypes.includes("evaluation"),
    mineTypes.join(","));

  // The monthly, evaluation and teaching-quality forms are written ABOUT a lecturer BY
  // their reviewer. Accepting one here would let a lecturer author their own management
  // review and have it read as the reviewer's judgement.
  const selfMonthly = await call("/my-reviews", { method: "POST", token: s1, body: { type: "monthly", answers: {} } });
  check("a lecturer cannot file a review that is written about them", selfMonthly.status === 400, `HTTP ${selfMonthly.status} ${selfMonthly.data?.error || ""}`);

  // staffId is never read from the request on this router — there is no id to tamper
  // with. Sending one must not write a reflection into a colleague's personnel file.
  const mineSubmitted = await call("/my-reviews", { method: "POST", token: s1, body: { type: "strategic", staffId: "s2", answers: strategicAnswers() } });
  if (mineSubmitted.data?.id) madeStaffReviews.add(mineSubmitted.data.id);
  const mineRow = mineSubmitted.data?.id ? await db.staffReview.findUnique({ where: { id: mineSubmitted.data.id } }) : null;
  check("a self-reflection is filed against the signed-in user, whatever the body says",
    mineSubmitted.status === 201 && mineRow?.staffId === "s1" && mineRow?.origin === "self",
    `HTTP ${mineSubmitted.status} staffId=${mineRow?.staffId} origin=${mineRow?.origin}`);

  const peerRead = await call(`/my-reviews/${mineSubmitted.data?.id}`, { token: s2 });
  check("a colleague cannot open somebody else's reflection", peerRead.status === 404, `HTTP ${peerRead.status}`);

  // The scope on this router is ownership AND self-service. Ownership alone handed a
  // lecturer their reviewer's in-progress Monthly review OF them — judgements they are
  // not meant to read here — and the staff app rendered a "Discard draft" button that
  // destroyed the reviewer's work.
  const myList = await call("/my-reviews", { token: s1 });
  const myIds = (myList.data || []).map((r) => r.id);
  check("the reviewer's monthly draft about me is not in my reflections", myList.status === 200 && !myIds.includes(monthly.data?.id), `${myIds.length} rows`);
  const readReviewers = await call(`/my-reviews/${monthly.data?.id}`, { token: s1 });
  check("...nor readable by id", readReviewers.status === 404, `HTTP ${readReviewers.status}`);
  const killReviewers = await call(`/my-reviews/${monthly.data?.id}`, { method: "DELETE", token: s1 });
  const survivor = await db.staffReview.findUnique({ where: { id: monthly.data?.id } });
  check("...and cannot be destroyed by its subject", killReviewers.status === 404 && !!survivor, `HTTP ${killReviewers.status} row=${survivor ? "intact" : "GONE"}`);

  // Submitting files the reflection: the reviewer may already have read it, so it stops
  // being the author's to rewrite or withdraw. Without the lock a lecturer could revise
  // their account of the term after seeing how the review meeting went.
  const editFiled = await call(`/my-reviews/${mineSubmitted.data?.id}`, { method: "PUT", token: s1, body: { answers: strategicAnswers({ proudOf: "Rewritten after the meeting." }) } });
  check("a submitted reflection can no longer be edited by its author", editFiled.status === 409, `HTTP ${editFiled.status}`);
  const withdrawFiled = await call(`/my-reviews/${mineSubmitted.data?.id}`, { method: "DELETE", token: s1 });
  check("...nor withdrawn", withdrawFiled.status === 409, `HTTP ${withdrawFiled.status}`);

  // A draft, by contrast, is the author's working copy and is theirs to discard.
  const myDraft = await call("/my-reviews", { method: "POST", token: s1, body: { type: "strategic", status: "draft", answers: { fullName: "James Whitfield" } } });
  if (myDraft.data?.id) madeStaffReviews.add(myDraft.data.id);
  const discard = await call(`/my-reviews/${myDraft.data?.id}`, { method: "DELETE", token: s1 });
  check("a lecturer may still discard their own draft", myDraft.status === 201 && discard.status === 200, `create ${myDraft.status}, delete ${discard.status}`);
  if (discard.status === 200) madeStaffReviews.delete(myDraft.data.id);

  // ------------------------------------------------------------------
  console.log("\n--- /api/student-reviews: pastoral records ---");

  // This feature is FOR ordinary lecturers, and /api/hnd is gated behind pages none of
  // them hold — so without its own options and roster the "New review" button was
  // permanently disabled for exactly the people the screen exists to serve.
  const options = await call("/student-reviews/options", { token: s1 });
  check("an ordinary lecturer can load the review form's choice lists", options.status === 200 && Array.isArray(options.data?.progress), `HTTP ${options.status}`);
  const roster = await call("/student-reviews/roster", { token: s1 });
  const sample = roster.data?.students?.[0] || {};
  // The roster is open to the ENTIRE staff body. It was returning every student's email
  // address, which is a contact-details disclosure of the whole cohort dressed up as a
  // dropdown. A picker needs a name and a reference, not a way to mail 136 people.
  check("the roster identifies students without handing out their email addresses",
    roster.status === 200 && (roster.data.students || []).length > 0 && !("email" in sample) && !!sample.studentRef,
    Object.keys(sample).join(","));

  // `mine=true` is the lecturer's own scope. Everything else is the college's entire
  // pastoral file and needs the page that says so on the Access grid.
  const allAsStaff = await call("/student-reviews", { token: s1 });
  check("a lecturer cannot list every colleague's pastoral records", allAsStaff.status === 403, `HTTP ${allAsStaff.status}`);

  const baseReview = {
    studentId: "st-100121", unitId: "m-obm", date: "2026-04-10", progress: "Monitor",
    concerns: ["Engagement", "Attendance"],
    summary: "Discussed the two missed workshops.",
    agreedActions: "Weekly check-in until half term.",
    followUp: true, followUpDate: "2026-04-24",
  };

  const badProgress = await call("/student-reviews", { method: "POST", token: s1, body: { ...baseReview, progress: "Struggling" } });
  check("progress must be one of the three tracked values", badProgress.status === 400, `HTTP ${badProgress.status} ${badProgress.data?.error || ""}`);

  // A conversation dated 2039-02-30 can never be found again by a date-filtered view,
  // and a 1999 typo sits below every real record for ever.
  const impossible = await call("/student-reviews", { method: "POST", token: s1, body: { ...baseReview, date: "2039-02-30", followUpDate: "2039-03-05" } });
  const ancient = await call("/student-reviews", { method: "POST", token: s1, body: { ...baseReview, date: "1999-12-31", followUpDate: "2000-01-05" } });
  check("an impossible or out-of-range conversation date is refused", impossible.status === 400 && ancient.status === 400, `impossible=${impossible.status} ancient=${ancient.status}`);

  // "No Concerns" is a statement that there are none; alongside a concern the record
  // contradicts itself — and the student receives a copy of that contradiction.
  const contradiction = await call("/student-reviews", { method: "POST", token: s1, body: { ...baseReview, concerns: ["No Concerns", "Attendance"] } });
  check('"No Concerns" cannot sit next to a concern', contradiction.status === 400, `HTTP ${contradiction.status} ${contradiction.data?.error || ""}`);

  // A follow-up is by definition after the conversation it follows; a backwards or
  // missing date puts an already-overdue safeguarding action on the list the moment the
  // review is filed, which is how genuinely overdue ones stop being noticed.
  const backwards = await call("/student-reviews", { method: "POST", token: s1, body: { ...baseReview, followUpDate: "2026-04-01" } });
  const missingFollowUp = await call("/student-reviews", { method: "POST", token: s1, body: { ...baseReview, followUpDate: "" } });
  check("a follow-up must be dated, and dated after the conversation", backwards.status === 400 && missingFollowUp.status === 400, `backwards=${backwards.status} missing=${missingFollowUp.status}`);

  const filedSR = await call("/student-reviews", { method: "POST", token: s1, body: { ...baseReview, staffId: "s2", staffName: "Aisha Rahman" } });
  if (filedSR.data?.id) madeStudentReviews.add(filedSR.data.id);
  // Authorship comes from the token, never the body: a review is a named lecturer's
  // account of a conversation they were in, and a forged author is a forged witness.
  check("authorship is taken from the token, not the request body",
    filedSR.status === 201 && filedSR.data?.staffId === "s1" && filedSR.data?.staffName === "James Whitfield",
    `HTTP ${filedSR.status} staffId=${filedSR.data?.staffId} staffName=${filedSR.data?.staffName}`);
  // Stored in the form's own order so two reviews always read the same way — the order
  // the boxes happened to be ticked in is not information about the student.
  check("concerns are normalised into the form's order",
    JSON.stringify(filedSR.data?.concerns) === JSON.stringify(["Attendance", "Engagement"]),
    JSON.stringify(filedSR.data?.concerns));

  // Reading `data.followUp` alone made a partial update that sent only a new date a
  // silent no-op: 200 back, nothing changed, and the lecturer believed they had
  // rescheduled a follow-up they had not.
  const reschedule = await call(`/student-reviews/${filedSR.data?.id}`, { method: "PUT", token: s1, body: { followUpDate: "2026-05-08" } });
  check("rescheduling a follow-up on its own actually saves", reschedule.status === 200 && reschedule.data?.followUpDate === "2026-05-08", `HTTP ${reschedule.status} date=${reschedule.data?.followUpDate}`);

  // Answering "no follow-up needed" must not leave it on the list of outstanding
  // pastoral actions — but it must NO LONGER destroy the date.
  //
  // This assertion used to require followUpDate === null, and that requirement is why
  // "overdue follow-ups" could not be built: unticking the flag was the only way to
  // close a follow-up, and it erased the only record that one had ever been due. A
  // promise kept on the day then became indistinguishable from a promise never made,
  // and every follow-up still carrying a date was one nobody had touched.
  //
  // The list is filtered on the FLAG, which is what "outstanding" means, so the
  // original concern is still met. The date is now the permanent record of the promise.
  const clear = await call(`/student-reviews/${filedSR.data?.id}`, { method: "PUT", token: s1, body: { followUp: false } });
  check("clearing the follow-up flag closes it WITHOUT destroying the promised date",
    clear.status === 200 && clear.data?.followUp === false && clear.data?.followUpDate === "2026-05-08",
    `followUp=${clear.data?.followUp} followUpDate=${JSON.stringify(clear.data?.followUpDate)}`);

  // Retracting the promise itself is still possible and is still a real event.
  const retract = await call(`/student-reviews/${filedSR.data?.id}`, { method: "PUT", token: s1, body: { followUpDate: "" } });
  check("an explicit empty date still retracts the promise",
    retract.status === 200 && retract.data?.followUpDate === null,
    `followUpDate=${JSON.stringify(retract.data?.followUpDate)}`);

  // And a completion cannot be invented on a row that never promised anything.
  const orphan = await call(`/student-reviews/${filedSR.data?.id}`, { method: "PUT", token: s1, body: { followUpCompletedOn: "2026-05-09" } });
  check("a completion is refused where no follow-up was ever arranged",
    orphan.status === 400 && /no follow-up/i.test(orphan.data?.error || ""),
    `HTTP ${orphan.status} ${orphan.data?.error || ""}`);

  const longSummary = await call(`/student-reviews/${filedSR.data?.id}`, { method: "PUT", token: s1, body: { summary: "y".repeat(5001) } });
  check("an over-length summary is refused, not silently cut short", longSummary.status === 400 && /too long/i.test(longSummary.data?.error || ""), `HTTP ${longSummary.status}`);

  // Another lecturer is not an audience for this record. 404 rather than 403 on purpose:
  // a 403 confirms the review exists and, with the id in hand, roughly who it is about.
  const peerGet = await call(`/student-reviews/${filedSR.data?.id}`, { token: s2 });
  const peerPut = await call(`/student-reviews/${filedSR.data?.id}`, { method: "PUT", token: s2, body: { progress: "On Track" } });
  const peerDel = await call(`/student-reviews/${filedSR.data?.id}`, { method: "DELETE", token: s2 });
  const stillThere = await db.studentReview.findUnique({ where: { id: filedSR.data?.id } });
  check("another lecturer cannot read, edit or delete this record",
    peerGet.status === 404 && peerPut.status === 404 && peerDel.status === 404 && !!stillThere,
    `get=${peerGet.status} put=${peerPut.status} del=${peerDel.status} row=${stillThere ? "intact" : "GONE"}`);

  // The gate is exactly the "Student Reviews" page. It also accepted "pat" and
  // "students", so granting either silently handed over every lecturer's pastoral
  // records — including the right to edit and delete them — with no checkbox anywhere on
  // the Access grid saying so. A permission grid nobody can trust is worse than a narrow one.
  const tenant = await db.tenant.findFirst({ where: { slug: TENANT } });
  const narrowEmail = `narrow-reviews-${RUN}@edtech.test`;
  const narrow = await db.staff.create({
    data: {
      tenantId: tenant.id, name: "Narrow Admin", jobTitle: "Data Officer", dept: "Administration",
      email: narrowEmail, passwordHash: bcrypt.hashSync(PASSWORD, 10), accountRole: "ADMIN",
      adminPages: JSON.stringify(["students", "pat"]), initials: "NA", colour: "#475569",
    },
  });
  narrowAdminId = narrow.id;
  const narrowToken = await login(narrowEmail);
  const narrowAll = await call("/student-reviews", { token: narrowToken });
  check('"students" and "pat" do not silently grant the pastoral file', narrowAll.status === 403, `HTTP ${narrowAll.status}`);
  const adminAll = await call("/student-reviews?studentId=st-100121", { token: admin });
  check("...while an unrestricted admin does see it",
    adminAll.status === 200 && (adminAll.data || []).some((r) => r.id === filedSR.data?.id),
    `HTTP ${adminAll.status}`);

  // ------------------------------------------------------------------
  console.log("\n--- a student token reaches its own copy and nothing else ---");

  // No seeded student has a password, so one is minted here and revoked again in the
  // cleanup below.
  const studentPw = `student-suite-${RUN}`;
  await db.student.update({ where: { id: "st-100121" }, data: { passwordHash: bcrypt.hashSync(studentPw, 10) } });
  const studentToken = await login("100121@edtech.co.uk", studentPw);

  // requireAuth's router allowlist is the single choke point keeping students out of ALL
  // staff data regardless of any individual route's own guards. A student who reached
  // /api/student-reviews would be reading a lecturer's candid notes on their classmates.
  const studentPeek = await call("/student-reviews", { token: studentToken });
  const studentMine = await call("/student-reviews?mine=true", { token: studentToken });
  const studentStaffReviews = await call("/staff-reviews", { token: studentToken });
  check("a student token is refused by every staff review router",
    studentPeek.status === 403 && studentMine.status === 403 && studentStaffReviews.status === 403,
    `all=${studentPeek.status} mine=${studentMine.status} staff=${studentStaffReviews.status}`);
  const studentWrite = await call("/student-reviews", { method: "POST", token: studentToken, body: baseReview });
  check("...and cannot file one", studentWrite.status === 403, `HTTP ${studentWrite.status}`);

  // The student IS meant to see the record of a conversation they took part in — but
  // through their own router, which serves their own rows only.
  const own = await call("/student/me/reviews", { token: studentToken });
  const ownIds = (own.data || []).map((r) => r.id);
  const ownCount = await db.studentReview.count({ where: { studentId: "st-100121" } });
  check("the student reads their own review on their own router", own.status === 200 && ownIds.includes(filedSR.data?.id), `HTTP ${own.status}, ${ownIds.length} rows`);
  check("...and every row served to them is about them", (own.data || []).length === ownCount, `${(own.data || []).length} of ${ownCount}`);
} catch (e) {
  check("suite ran to completion", false, e?.stack || String(e));
} finally {
  // Eight suites share one seeded database in a single run and the seed is not re-run
  // between them, so anything created here has to go and anything mutated has to be put
  // back — a leftover review, or a student who can suddenly sign in, breaks somebody
  // else's assertion in a way that looks like their bug.
  try {
    if (madeStudentReviews.size) await db.studentReview.deleteMany({ where: { id: { in: [...madeStudentReviews] } } });
    if (madeStaffReviews.size) await db.staffReview.deleteMany({ where: { id: { in: [...madeStaffReviews] } } });
    if (narrowAdminId) await db.staff.delete({ where: { id: narrowAdminId } }).catch(() => {});
    await db.student.update({ where: { id: "st-100121" }, data: { passwordHash: null } }).catch(() => {});
  } catch (e) { console.error("cleanup problem:", e?.message || e); }
  await db.$disconnect();
  console.log("\ncleanup: reviews removed, narrow admin removed, student password revoked");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
