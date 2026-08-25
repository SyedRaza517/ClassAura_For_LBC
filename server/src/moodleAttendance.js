// Import attendance from Moodle's mod_attendance into Staff Hub's registers.
//
// The shapes do not match, and that is the whole job. Moodle keeps ONE attendance
// register per intake, with the unit written into each session's description ("LM",
// "TCBE", "MoHR"). Staff Hub keeps one register per unit, because that is what a
// per-unit attendance percentage needs. So a course-level register is fanned out into
// per-unit ones, and sessions that belong to the course rather than to any single unit
// — tutorials, seminars, workshops — go to a per-course "Tutorial / Seminar" unit
// rather than being dropped or, worse, charged to a real unit they weren't part of.
//
// Two invariants make this safe to run on a schedule:
//   * an existing mark is NEVER overwritten. Where the two systems disagree the Staff
//     Hub value stands and the difference is reported, exactly as grades behave.
//   * every register created carries `moodleSessionId` and every mark is stamped
//     takenBy IMPORT_STAMP, so an import can be identified and removed precisely.
const prisma = require("./db");

const IMPORT_STAMP = "Moodle import";

// Moodle's acronyms are inconsistent about small words — TCBE keeps "The", MoHR keeps
// "of", but MPP drops "and" — so build both forms and accept either.
// The shortest description that may be matched by the substring shortcut below.
//
// Without a floor, `similar()` returned 0.92 for ANY description whose letters are a
// substring of a unit name — so "Management" scored 0.92 against both "Human Resource
// Management" and "Leadership and Management", "IT" matched "Digital Business In
// Practice", and even "a" and "in" matched. `Array.find` then took whichever row the
// database happened to return first, and 25 students' attendance was charged to the
// wrong unit with nothing reported (note() only fires when NOTHING matches).
const MIN_SUBSTRING_MATCH = 6;
// How far clear the best candidate must be before we trust it. Two units scoring
// within this of each other is an ambiguity a human has to resolve, not a coin toss.
const MATCH_MARGIN = 0.05;

const SMALL = /^(of|and|the|a|an|in|for|to|with|&)$/i;
const wordsOf = (n) => String(n).replace(/\(.*?\)/g, " ").split(/[\s\-/,.]+/).filter(Boolean);
function acronyms(name) {
  const w = wordsOf(name);
  return new Set([w.map((x) => x[0]).join(""), w.filter((x) => !SMALL.test(x)).map((x) => x[0]).join("")]
    .map((a) => a.toUpperCase()).filter((a) => a.length >= 2));
}

// Tolerates the typos that appear in hand-typed session descriptions, e.g.
// "Princples of Sustainability" for "Principles of Sustainability".
const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, "");
function similar(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  // The substring shortcut needs a length floor — see MIN_SUBSTRING_MATCH.
  if ((a.includes(b) || b.includes(a)) && Math.min(a.length, b.length) >= MIN_SUBSTRING_MATCH) return 0.92;
  let hits = 0; const pool = b.split("");
  for (const ch of a) { const i = pool.indexOf(ch); if (i >= 0) { pool.splice(i, 1); hits++; } }
  return hits / Math.max(a.length, b.length);
}

/**
 * Score EVERY unit and take the best — but only if it is clearly better than the
 * runner-up. `units.find(u => similar(...) >= 0.85)` returned the first row over the
 * line in arbitrary database order, so where two units tied it silently picked one.
 * An ambiguous register is reported and left for a human instead.
 */
function bestFuzzyMatch(desc, units, note) {
  const scored = units
    .map((u) => ({ u, score: similar(desc, u.name) }))
    .filter((x) => x.score >= 0.85)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].score - scored[1].score < MATCH_MARGIN) {
    note(`Attendance: "${desc}" matches both ${scored[0].u.code} (${scored[0].u.name}) and ${scored[1].u.code} (${scored[1].u.name}) equally well — recorded against the course instead. Rename the Moodle session to name one unit.`);
    return null;   // falls through to the Tutorial / Seminar bucket, not a guess
  }
  return scored[0].u;
}

// Descriptions carry the delivery type as a suffix: "MPP (Lecture)", "TCBE - Lecture".
const TYPE_SUFFIX = /\s*[-–(]\s*(lecture|tutorial|workshop|seminar|lab|revision)\s*\)?\s*$/i;
function describe(raw) {
  let d = String(raw || "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").trim();
  d = d.replace(TYPE_SUFFIX, "").trim();
  return d.replace(/\s+/g, " ").trim();
}

const STATUSES = { P: "P", L: "L", E: "E", A: "A" };
const dayOf = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
const timeOf = (ts) => new Date(ts * 1000).toISOString().slice(11, 16);
const plus = (t, mins) => {
  const [h, m] = t.split(":").map(Number);
  const x = h * 60 + m + mins;
  return `${String(Math.floor(x / 60) % 24).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
};

const TUTORIAL_CODE = "TUTORIAL";
const TUTORIAL_NAME = "Tutorial / Seminar";

/**
 * @param call   the Moodle web-service caller from moodle.js
 * @param dryRun report what would change, write nothing
 * @param note   collect a human-readable issue
 * @returns counts folded into the sync summary, plus `studentIds` — see below
 */
async function importAttendance({ call, dryRun = false, note = () => {} } = {}) {
  const out = {
    attendanceSessionsCreated: 0,
    attendanceMarksCreated: 0,
    attendanceSkippedConflict: 0,
    attendanceSkippedNoStudent: 0,
    // Whose attendance or enrolment this import actually changed. Attendance feeds the
    // progression score, so those students' cached scores are now out of date — but the
    // flagging belongs to the caller, which is already collecting the students the
    // grade sync touched and can flag the lot in one go rather than twice over.
    studentIds: [],
  };
  const touched = new Set();

  // Which attendance activities exist, and in which Moodle course.
  const moodleCourses = await call("core_course_get_courses");
  const activities = [];
  for (const c of moodleCourses || []) {
    if (!c.id) continue;
    const contents = await call("core_course_get_contents", { courseid: c.id });
    for (const sec of contents || []) {
      for (const m of sec.modules || []) {
        // `instance` is the attendance record's own id; `id` is the course-module id,
        // and mod_attendance_get_sessions wants the former.
        if (m.modname === "attendance") activities.push({ name: c.fullname, moodleCourseId: c.id, instance: m.instance ?? m.id });
      }
    }
  }
  if (!activities.length) return out;

  const students = await prisma.student.findMany({ select: { id: true, moodleUserId: true } });
  const byMoodleUser = new Map(students.filter((s) => s.moodleUserId != null).map((s) => [s.moodleUserId, s.id]));
  const courses = await prisma.course.findMany({ include: { units: true } });

  for (const act of activities) {
    const course = courses.find((c) => c.moodleCourseId === act.moodleCourseId)
      || courses.find((c) => c.name.trim().toLowerCase() === String(act.name).trim().toLowerCase());
    if (!course) { note(`Attendance: no Staff Hub course matches "${act.name}" — its registers were skipped`); continue; }

    const sessions = await call("mod_attendance_get_sessions", { attendanceid: act.instance });
    if (!Array.isArray(sessions)) {
      // The token needs mod_attendance_get_sessions on its external service. Say so
      // once, plainly, rather than failing the whole sync.
      note(`Attendance: cannot read the register for "${act.name}" — check the Moodle token includes mod_attendance_get_sessions`);
      continue;
    }

    let units = course.units;
    let tutorialUnit = units.find((u) => u.code === TUTORIAL_CODE);

    for (const s of sessions) {
      const log = s.attendance_log || [];
      if (!log.length) continue;                       // register never taken

      const desc = describe(s.description);
      let unit = units.find((u) => acronyms(u.name).has(desc.toUpperCase()))
        || bestFuzzyMatch(desc, units, note);

      if (!unit) {
        // Course-level session. Create the holding unit on first need only, so a
        // course whose sessions all map to real units never gets a stray unit.
        if (!tutorialUnit) {
          if (dryRun) { tutorialUnit = { id: null, code: TUTORIAL_CODE, name: TUTORIAL_NAME }; }
          else {
            try {
              tutorialUnit = await prisma.unit.create({
                data: { code: TUTORIAL_CODE, name: TUTORIAL_NAME, unitNumber: "", courseId: course.id, tutor: "" },
              });
            } catch (e) {
              // A course with several attendance activities (one per term) walks this
              // loop once per activity, and `units` was rebound locally rather than on
              // the shared course object — so the second activity didn't see the unit
              // the first had created, tried again, and hit the (courseId, code) unique
              // index. That P2002 propagated out of importAttendance and was swallowed
              // by the caller's catch, zeroing EVERY attendance counter while the run
              // still reported "ok". Adopt the existing row instead.
              if (e?.code !== "P2002") throw e;
              tutorialUnit = await prisma.unit.findFirst({ where: { courseId: course.id, code: TUTORIAL_CODE } });
              if (!tutorialUnit) throw e;
            }
            units = [...units, tutorialUnit];
            course.units = units;   // share it, so the next activity on this course sees it
          }
        }
        unit = tutorialUnit;
      }

      const date = dayOf(s.sessdate);
      const startTime = timeOf(s.sessdate);
      const endTime = plus(startTime, Math.max(30, Math.round((s.duration || 3600) / 60)));

      // Read the status set from the session itself: a course that renumbered its
      // statuses still maps correctly, and a custom status we don't recognise is
      // skipped rather than guessed at.
      const statusById = new Map((s.statuses || [])
        .map((st) => [String(st.id), STATUSES[String(st.acronym).toUpperCase()] || null]));

      let session = unit.id ? await prisma.hndSession.findFirst({
        where: { OR: [{ moodleSessionId: Number(s.id) }, { unitId: unit.id, date, startTime }] },
      }) : null;
      const reused = !!session;

      if (!session) {
        out.attendanceSessionsCreated++;
        if (!dryRun && unit.id) {
          session = await prisma.hndSession.create({
            data: {
              unitId: unit.id, date, startTime, endTime,
              description: desc || "Imported from Moodle",
              kind: unit === tutorialUnit ? "Seminar" : "Teaching",
              moodleSessionId: Number(s.id),
            },
          });
        }
      }

      const rows = [];
      for (const l of log) {
        const studentId = byMoodleUser.get(Number(l.studentid));
        if (!studentId) { out.attendanceSkippedNoStudent++; continue; }
        const status = statusById.get(String(l.statusid));
        if (!status) continue;
        rows.push({ studentId, status, remark: String(l.remarks || "").slice(0, 500) });
      }
      if (!rows.length || !session) { out.attendanceMarksCreated += dryRun ? rows.length : 0; continue; }

      // Enrol everyone we are about to mark.
      //
      // Moodle only ever enrols a student on the COURSE, and the gradebook sync infers
      // unit enrolment from the Moodle course-sections — which never include the
      // synthetic Tutorial / Seminar unit. So this import wrote marks onto a unit with
      // zero enrolments, and the consequences all landed on the lecturer:
      //   • a new tutorial register showed "No students enrolled" and could not be taken;
      //   • adding the students Moodle missed returned "N students are not enrolled";
      //   • and every one of those marks was excluded from the attendance aggregates,
      //     which is what made the matrix's rows and totals disagree.
      // Marking someone present IS the evidence they are on it, so record that.
      if (!dryRun && unit.id) {
        await prisma.enrolment.createMany({
          data: rows.map((r) => ({ studentId: r.studentId, unitId: unit.id })),
          skipDuplicates: true,
        });
        // skipDuplicates means most of these already existed, and there is no cheap way
        // to learn which. Flagging the whole row set is the safe side of that: an extra
        // flag costs one rescore, a missed one leaves a wrong score on screen.
        for (const r of rows) touched.add(r.studentId);
      }

      if (reused) {
        // A register that already exists may hold marks a member of staff took. Those
        // win; Moodle's version is reported, never written over.
        const have = await prisma.attendanceMark.findMany({ where: { sessionId: session.id }, select: { studentId: true, status: true } });
        const existing = new Map(have.map((h) => [h.studentId, h.status]));
        const fresh = [];
        for (const r of rows) {
          const was = existing.get(r.studentId);
          if (was === undefined) fresh.push(r);
          else if (was !== r.status) out.attendanceSkippedConflict++;
        }
        if (fresh.length) {
          if (!dryRun) {
            await prisma.attendanceMark.createMany({
              data: fresh.map((r) => ({ ...r, sessionId: session.id, takenBy: IMPORT_STAMP })), skipDuplicates: true,
            });
            // Only the fresh marks: a student whose mark was already on file and kept
            // has had nothing about them change.
            for (const r of fresh) touched.add(r.studentId);
          }
          out.attendanceMarksCreated += fresh.length;
        }
      } else {
        if (!dryRun) {
          await prisma.attendanceMark.createMany({
            data: rows.map((r) => ({ ...r, sessionId: session.id, takenBy: IMPORT_STAMP })), skipDuplicates: true,
          });
          for (const r of rows) touched.add(r.studentId);
        }
        out.attendanceMarksCreated += rows.length;
      }
    }
  }

  if (out.attendanceSkippedNoStudent) {
    note(`Attendance: ${out.attendanceSkippedNoStudent} mark(s) skipped — the Moodle user has no matching Staff Hub student`);
  }
  if (out.attendanceSkippedConflict) {
    note(`Attendance: ${out.attendanceSkippedConflict} mark(s) differ from a register already taken in Staff Hub — the Staff Hub value was kept`);
  }
  out.studentIds = [...touched];
  return out;
}

module.exports = { importAttendance, IMPORT_STAMP, TUTORIAL_CODE };
