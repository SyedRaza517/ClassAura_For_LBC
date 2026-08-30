// Read Canvas and report what an importer WOULD find. Writes nothing, ever.
//
// WHY THIS EXISTS BEFORE AN IMPORTER DOES
//
// vle/canvas.js (auth, paging, throttling, connection test) and vle/canvasNormalise.js
// (Canvas's shapes → the shapes this database stores) are both complete and both called
// by nothing. Canvas has a Settings card, a working Test button, and no way to see a
// single course, student or mark inside the app.
//
// Building the importer first would mean discovering only afterwards whether this
// account's submissions carry hand-in dates — the one property that decides whether a
// Canvas import is worth having at all, because Moodle+Turnitin does not carry them and
// an importer that reproduces that limitation is a lot of work for the same floors.
//
// So: read, count, report, write nothing. And every line of the reading is the reading
// an importer needs, so none of it is throwaway.
//
// NO DATABASE IMPORT IN THIS FILE. Not "no writes by convention" — prisma is not
// required here at all, so a preview cannot create a row by accident.
const canvas = require("./vle/canvas");
const normalise = require("./vle/canvasNormalise");
const { summarisePreview, verdictText } = require("./vle/canvasPreviewSummary");

// A preview is a diagnostic, not an import: it samples rather than sweeping the whole
// account. A college with 300 courses would otherwise spend minutes and thousands of
// API calls answering a yes/no question, and Canvas rate-limits by cost.
const MAX_COURSES = 5;
// Canvas returns one submission row per student per assignment, so a large course is
// hundreds of rows. The verdict needs a sample, not a census.
const MAX_SUBMISSIONS = 500;

/**
 * @returns { ok, note, summary, courses, issues }
 *   `ok:false` carries a `note` an administrator can act on; it never throws for a
 *   Canvas-side problem, because "Canvas said no" is a finding this screen should show
 *   rather than a 500.
 */
async function preview() {
  const issues = [];
  const note = (m) => { if (issues.length < 30) issues.push(m); };

  // TWO SCOPES, TRIED IN ORDER — and the connection test is deliberately NOT the gate.
  //
  // testConnection() fails a token that cannot see accounts, and that is right for an
  // IMPORT: a sync configured that way runs, finds nothing and reports success, which
  // is the most confusing possible outcome for whoever set it up. It is wrong for a
  // PREVIEW, whose whole job is to find out what a token can see.
  //
  // So a non-admin token is not turned away here. Canvas Free-for-Teacher is free and
  // instant, and a teacher token can read /courses — the courses that user teaches —
  // plus their students, assignments and submissions. Every field this preview's verdict
  // rests on, `submitted_at` included, exists at course scope. That means the one
  // question worth answering ("does Canvas give real hand-in dates?") can be answered
  // today on a free account, with no trial and no procurement.
  //
  // The scope IS reported, because what a teacher account cannot prove is the
  // multi-course, whole-account shape a real import would run against.
  let courseList = [];
  let scope = "account";
  const conn = await canvas.testConnection();

  try {
    // `state[]=available` excludes unpublished shells, which are course-shaped and
    // contain nobody — counting them would inflate every figure here.
    courseList = await canvas.paginate("/accounts/self/courses", { "state[]": "available" });
  } catch (e) {
    note(`Account-level courses could not be read (${e.message}) — falling back to the courses this token's own user teaches.`);
  }

  if (!Array.isArray(courseList) || !courseList.length) {
    scope = "teacher";
    try {
      courseList = await canvas.paginate("/courses", { enrollment_state: "active" });
    } catch (e) {
      // Both scopes failed, so the token cannot read courses at all. The connection
      // test's wording is the more useful of the two messages here.
      return {
        ok: false,
        note: conn.ok ? `Canvas is connected, but no courses could be read — ${e.message}` : conn.note,
        summary: null, courses: [], scope, issues,
      };
    }
  }

  const sample = (Array.isArray(courseList) ? courseList : []).slice(0, MAX_COURSES);
  const courses = [];

  for (const c of sample) {
    const row = { id: c.id, name: c.name || `Course ${c.id}`, students: 0, assignments: 0, submissions: [] };
    try {
      // STUDENTS COME FROM ENROLMENTS, and that is load-bearing rather than incidental.
      // canvasNormalise.isTestStudent cannot see a StudentViewEnrollment on a user
      // object embedded in a submission — that shape carries only id, name and avatar.
      // So the real student set is built here, and submission rows for anyone outside
      // it are dropped below. Canvas's built-in Test Student otherwise appears as a
      // real person who never submits anything.
      const users = await canvas.paginate(`/courses/${c.id}/users`, { "enrollment_type[]": "student", "include[]": "enrollments" });
      const realStudents = (users || []).filter((u) => !normalise.isTestStudent(u));
      row.students = realStudents.length;
      const studentIds = new Set(realStudents.map((u) => String(u.id)));

      const assignments = await canvas.paginate(`/courses/${c.id}/assignments`, {});
      row.assignments = (assignments || []).length;
      const byId = new Map((assignments || []).map((a) => [String(a.id), a]));

      // One call for the whole course rather than one per assignment.
      const subs = await canvas.paginate(`/courses/${c.id}/students/submissions`, { "student_ids[]": "all" });
      for (const s of (subs || []).slice(0, MAX_SUBMISSIONS)) {
        if (!studentIds.has(String(s.user_id))) continue;   // Test Student, or an unenrolled ghost
        // The judgement about what counts as a submission stays in ONE place — the
        // normaliser the importer would use, already tested against Canvas's shapes.
        const decided = normalise.submissionOf(s, byId.get(String(s.assignment_id)));
        row.submissions.push({ studentId: String(s.user_id), submittedOn: decided.submittedOn, status: decided.status });
      }
    } catch (e) {
      // One bad course must not lose the whole report — the rest of the sample is still
      // evidence, and the failure itself is worth showing.
      note(`${row.name}: ${e.message}`);
    }
    courses.push(row);
  }

  const summary = summarisePreview(courses);
  if (courseList.length > sample.length) {
    note(`Sampled ${sample.length} of ${courseList.length} courses — a preview answers a yes/no question and does not sweep the whole account.`);
  }
  if (scope === "teacher") {
    note("Read at TEACHER scope: these are the courses this token's own user teaches, not the whole account. The hand-in-date finding transfers — submitted_at behaves identically at both scopes — but a full import needs an account-administrator token to see every course.");
  }
  return {
    ok: true,
    note: verdictText(summary, scope),
    summary, scope,
    courses: courses.map((c) => ({ id: c.id, name: c.name, students: c.students, assignments: c.assignments, submissions: c.submissions.length })),
    issues,
  };
}

module.exports = { preview, MAX_COURSES, MAX_SUBMISSIONS };
