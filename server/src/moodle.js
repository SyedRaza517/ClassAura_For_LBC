// Moodle (VLE) integration — reads the college's Moodle and mirrors it into Staff Hub.
//
// Direction is ONE WAY: Moodle → Staff Hub. Nothing is ever written back to Moodle,
// and nothing here deletes a Staff Hub record. A re-run updates what it created
// before (matched on the stored moodle* ids) and reports anything it had to skip.
//
// How this college's Moodle is laid out, and therefore how it maps:
//
//   Moodle course                     →  Course      e.g. "…HND in Business (June 2025)"
//     section "Unit 1 - …"            →    Unit      the taught unit
//       lti activity (grade item)     →      Assessment   a Turnitin submission point
//   enrolled user with role "student" →  Student + Enrolment
//   that user's grade for an item     →  AssessmentGrade
//
// Sections that aren't units (Introduction, Study Skills, Library…) are ignored, as
// are the Moodle "attendance" grade item (Staff Hub records attendance itself) and
// the course-total item.
const prisma = require("./db");
const { withoutAcademicScope } = require("./academicScope");
const { importAttendance } = require("./moodleAttendance");
// A student's progression score is cached and recomputed by a background runner, never
// in the request path. This sync rewrites the very things it is computed from — marks,
// enrolments, attendance — so whoever it touched has to be flagged for rescoring, or
// the dashboard goes on showing last night's score against tonight's data.
const predictionRunner = require("./prediction/runner");
const engagement = require("./vle/engagementNormalise");
const { assessmentTypeFor: itemType } = require("./vle/moodleItemType");
const { dueDatesByCmid } = require("./vle/moodleActivityDates");
const { submissionsForAssessment: submissionsFor } = require("./vle/moodleSubmissions");
const { soleEditingTeacher } = require("./vle/moodleTeachers");
const { isoDate } = require("./vle/isoDate");
const { localDate, ZONE } = require("./clock");

// Prefer what THIS institution saved over the server-wide environment. Primed once
// per request in call() below; integrationConfig.peek() falls back to process.env, so
// a deployment that configures by environment behaves exactly as it always did.
const cfg = require("./integrationConfig");
const BASE = () => String(cfg.peek("moodle").url || "").replace(/\/+$/, "");
const TOKEN = () => String(cfg.peek("moodle").token || "");
const isConfigured = () => Boolean(BASE() && TOKEN());

// --- Moodle REST -----------------------------------------------------------------
// A single Moodle call must never hang. Without a deadline a stalled VLE left the
// sync awaiting a response forever, which pinned the in-flight lock: status reported
// "running" indefinitely, every later sync 409'd, the nightly job skipped every night,
// and only a restart recovered — with nothing logged to say why.
const CALL_TIMEOUT_MS = 120000;

async function call(wsfunction, params = {}) {
  // The single choke point every Moodle request passes through, so priming here is
  // enough for the synchronous accessors above.
  await cfg.load("moodle");
  if (!isConfigured()) throw new Error("Moodle is not configured — add this institution's Moodle URL and token in Settings, or set MOODLE_URL and MOODLE_TOKEN.");
  const body = new URLSearchParams({ wstoken: TOKEN(), moodlewsrestformat: "json", wsfunction });
  for (const [k, v] of Object.entries(params)) body.append(k, String(v));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${BASE()}/webservice/rest/server.php`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: controller.signal,
    });
  } catch (e) {
    if (e?.name === "AbortError") throw new Error(`${wsfunction}: Moodle did not respond within ${CALL_TIMEOUT_MS / 1000}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`${wsfunction}: Moodle did not return JSON (HTTP ${res.status})`); }
  // Moodle answers 200 with an exception object rather than an HTTP error code.
  if (data && data.exception) throw new Error(`${wsfunction}: ${data.errorcode} — ${data.message}`);
  return data;
}

// --- Parsing helpers -------------------------------------------------------------

// Section names look like "Unit 1 - The Contemporary Business Environment (Core)",
// "Unit-8 Digital Business In Practice (DBP)" or "Unit 46- Developing Individuals…".
// Anything not starting with "Unit" is a support section, not a taught unit.
const UNIT_RE = /^\s*unit\s*[-–]?\s*(\d+[a-z]?)\s*[-–:.]?\s*(.*)$/i;
function parseUnitSection(name) {
  const raw = String(name || "").replace(/&amp;/g, "&").trim();
  const m = raw.match(UNIT_RE);
  if (!m) return null;
  const number = m[1];
  // Drop the "(Core)" / "(Optional)" / "(Pearson-set)" suffix — a classification,
  // not part of the unit's name.
  const title = (m[2] || "").replace(/\s*\((core|optional|pearson[- ]set)[^)]*\)\s*$/i, "").trim();
  return { number, name: title || raw, code: `UNIT ${number}` };
}

// Which year and term a unit is taught in.
//
// Moodle records this structurally: a section named "Year 1 - Term 1" holds one
// `subsection` activity per unit, and that activity's customdata points at the unit's
// own section id — e.g. {"sectionid":"11"}. So the term sections give section id →
// {year, term}, which is then matched against the units by their section id.
//
// Matching on the id rather than the repeated unit name matters: the same unit name
// appears in several courses, and the names are inconsistently punctuated.
const TERM_RE = /year\s*(\d+)\s*[-–]?\s*term\s*(\d+)/i;
function termsBySectionId(sections) {
  const out = new Map();
  for (const sec of sections) {
    const m = String(sec.name || "").match(TERM_RE);
    if (!m) continue;
    const place = { year: Number(m[1]), termNumber: Number(m[2]) };
    for (const mod of sec.modules || []) {
      if (mod.modname !== "subsection") continue;
      let target = null;
      try { target = Number(JSON.parse(mod.customdata || "{}").sectionid); } catch (_) { /* not a link we understand */ }
      // Term sections also carry non-unit subsections such as "Useful Links"; those
      // simply never match a unit section, so they fall away on their own.
      if (Number.isFinite(target)) out.set(target, place);
    }
  }
  return out;
}

const clean = (s) => String(s ?? "").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").trim();

// The college's student number, which is what a student types when they sign up.
//
// Moodle's `idnumber` was the obvious source, but on this site it holds an opaque
// internal hash ("_-_AQaJw5yr2TMLcSRJLR5qIfg"), not the college number. The real
// number is the local part of the college email — 100104@edtech.co.uk.
// Importing the hash left every student with a reference nobody could ever quote,
// so sign-up could not match them and staff could not search for them.
const COLLEGE_NUMBER = /^\d{4,10}$/;
function collegeNumber(idnumber, email) {
  const id = clean(idnumber);
  if (COLLEGE_NUMBER.test(id)) return id;
  const local = String(email || "").split("@")[0].trim();
  if (COLLEGE_NUMBER.test(local)) return local;
  return id;  // nothing better available — keep whatever Moodle gave us
}
const initialsOf = (f, l) => `${clean(f)[0] || ""}${clean(l)[0] || ""}`.toUpperCase() || "??";
const PALETTE = ["#1a3a8f", "#9e1b32", "#0d7a5f", "#b45309", "#6d28d9", "#0e7490", "#be123c"];
const colourFor = (seed) => PALETTE[Math.abs(String(seed).split("").reduce((a, c) => a + c.charCodeAt(0), 0)) % PALETTE.length];
// Moodle timestamps are unix seconds; 0 means "never".
const tsToDate = (t) => (t ? new Date(Number(t) * 1000).toISOString().slice(0, 10) : null);

// A grade item we mirror: a real activity, not the course total, not a grade-category
// subtotal, and not the Moodle attendance plugin (Staff Hub keeps its own attendance
// and must not have it overwritten).
const isGradableItem = (it) =>
  it.itemtype !== "course" && it.itemtype !== "category" && it.itemmodule !== "attendance";

// --- Read the whole picture out of Moodle ----------------------------------------
async function readMoodle() {
  const courses = (await call("core_course_get_courses")).filter((c) => c.format !== "site");
  const out = [];
  for (const c of courses) {
    const [sections, users, grades] = await Promise.all([
      call("core_course_get_contents", { courseid: c.id }),
      call("core_enrol_get_enrolled_users", { courseid: c.id }),
      call("gradereport_user_get_grade_items", { courseid: c.id }),
    ]);
    out.push({ course: c, sections, users, usergrades: grades.usergrades || [] });
  }
  return out;
}

// --- The sync --------------------------------------------------------------------
//
// `dryRun` performs every lookup and reports exactly what WOULD change, writing
// nothing — so an admin can see the effect before committing to it. In a preview a
// row that would be created has no id yet, so everything hanging off it is likewise
// counted as new; that keeps a first-run preview's numbers honest rather than empty.
/**
 * Import everything the VLE offers.
 *
 * INSTITUTION-WIDE BY NATURE, not by permission. The sync reads every course the Moodle
 * site exposes, and it runs BEFORE anybody has decided which academic department those
 * courses belong to -- capturing the category that will later answer that question is
 * part of what it does. There is no department it could be scoped to.
 *
 * Declared here rather than at each call site because it is true of every call site: the
 * nightly scheduler has no caller at all, and an administrator triggering a sync by hand
 * is still asking for the whole site to be imported, not their own department's slice.
 */
async function syncFromMoodle(opts = {}) {
  return withoutAcademicScope(
    "moodle sync: imports every course the VLE offers, before any of them has a department",
    () => syncFromMoodleInner(opts),
  );
}

async function syncFromMoodleInner({ dryRun = false, onProgress = null } = {}) {
  const summary = {
    coursesCreated: 0, coursesUpdated: 0,
    unitsCreated: 0, unitsUpdated: 0,
    assessmentsCreated: 0, assessmentsUpdated: 0,
    studentsCreated: 0, studentsMatched: 0, enrolmentsCreated: 0,
    gradesCreated: 0, gradesUpdated: 0, gradesSkippedManual: 0,
    attendanceSessionsCreated: 0, attendanceMarksCreated: 0,
    attendanceSkippedConflict: 0, attendanceSkippedNoStudent: 0,
    // Engagement observations written, and users this Moodle would not let us observe.
    // The second is reported rather than swallowed: it is the difference between "nobody
    // is using the VLE" and "this site hides lastaccess", and no later count can
    // reconstruct it.
    engagementObserved: 0, engagementNotObservable: 0,
    // Submission rows written, and assessments this Moodle would not let us observe.
    // The second is reported rather than swallowed, for the same reason as
    // engagementNotObservable: it is the difference between "this cohort handed nothing
    // in" and "this activity type does not publish submission dates". A Turnitin site
    // that reports nothing will show a large submissionsUnobserved and zero recorded,
    // which is the honest diagnosis rather than a screen of 0% submission rates.
    submissionsRecorded: 0, submissionsUnobserved: 0,
    // Units whose lecturer or module leader this run filled in from Moodle.
    teachersLinked: 0,
  };
  const issues = [];
  const note = (m) => { if (issues.length < 300) issues.push(m); };

  // Every student whose cached progression score this run has invalidated, gathered as
  // the sync goes and flagged ONCE at the end. Flagging per write would be a query per
  // mark; one flush is a query per 200 students. A Set because a student picked up by a
  // grade, an enrolment and an attendance mark is still one student to flag.
  const touched = new Set();
  // Adds everyone enrolled on a unit. Used where a change moves a DENOMINATOR rather
  // than one person's mark — the whole cohort's derived percentages shift, including
  // students who have submitted nothing at all and so appear in no grade row.
  const touchUnitCohort = async (unitId) => {
    if (!unitId) return;
    const rows = await prisma.enrolment.findMany({ where: { unitId }, select: { studentId: true } });
    for (const r of rows) touched.add(r.studentId);
  };

  const everything = await readMoodle();
  let coursesDone = 0;
  for (const { course, sections, users, usergrades } of everything) {
    const label = clean(course.shortname) || `course ${course.id}`;

    // ---------- Course ----------
    const courseName = clean(course.fullname) || label;
    let dbCourse = await prisma.course.findFirst({ where: { moodleCourseId: course.id } });
    if (!dbCourse) {
      // A course of the same name may already exist from manual setup — adopt it
      // rather than creating a duplicate.
      const byName = await prisma.course.findFirst({ where: { name: courseName } });
      // Only adopt a same-named course that ISN'T already claimed by another Moodle
      // course. Two Moodle courses sharing a fullname both adopted the same row and
      // rewrote moodleCourseId, so one Staff Hub course flip-flopped between them on
      // alternate nights, merging two intakes' units and registers into one.
      if (byName && byName.moodleCourseId == null) {
        summary.coursesUpdated++;
        try {
          dbCourse = dryRun ? byName
            : await prisma.course.update({ where: { id: byName.id }, data: { moodleCourseId: course.id } });
        } catch (e) { note(`${label}: could not link to the existing course "${courseName}" — ${e.message}`); continue; }
      } else if (byName) {
        note(`${label}: a Staff Hub course called "${courseName}" is already linked to a different Moodle course, so this one was skipped. Rename one of them in Moodle.`);
        continue;
      } else {
        summary.coursesCreated++;
        if (!dryRun) {
          try {
            dbCourse = await prisma.course.create({
              data: {
                name: courseName, colour: colourFor(courseName), moodleCourseId: course.id,
                // THE VLE'S OWN GROUPING, CAPTURED ON CREATE. categoryid is already in the
                // core_course_get_courses response readMoodle() makes, so this costs zero
                // extra calls -- the same shape as the engagement work, where
                // lastcourseaccess was already in a response the sync was making anyway.
                //
                // Captured even though nothing maps it yet: it is free, and it is the
                // evidence the mapping screen is built from. A college that syncs tonight
                // and configures departments next week has a populated screen waiting.
                //
                // Stored as a STRING because it identifies a row in somebody else's
                // database. Canvas's account_id and Blackboard's category id go in the
                // same column and are not integers.
                vleCategoryExternalId: course.categoryid != null ? String(course.categoryid) : null,
              },
            });
          } catch (e) { note(`${label}: could not create the course — ${e.message}`); continue; }
        }
      }
    } else if (dbCourse.name !== courseName) {
      // Renames follow Moodle; nothing is ever deleted. Guarded like every sibling
      // branch: Course.name is @unique, so a rename that collides with another course
      // threw P2002 straight out of the sync and abandoned every course after this one
      // — no marks, no attendance, for the whole night.
      summary.coursesUpdated++;
      if (!dryRun) {
        // THE CATEGORY IS NEVER REWRITTEN BY A LATER SYNC, and that is a security decision
        // rather than an oversight. Once departments are mapped, a course's category
        // decides which staff can see its students. Somebody reorganising Moodle's
        // categories at eleven at night would otherwise migrate whole cohorts across an
        // access boundary overnight, with nobody watching and no record of it -- a Law
        // tutor waking up able to read Health & Social Care pastoral notes.
        //
        // A changed category is surfaced as a PROPOSED change for an administrator to
        // approve, on the mapping screen, never applied. This sync already has dryRun and
        // a preview culture; this fits it rather than fighting it.
        try { await prisma.course.update({ where: { id: dbCourse.id }, data: { name: courseName } }); }
        catch (e) { note(`${label}: could not rename to "${courseName}" — ${e.code === "P2002" ? "another course already has that name" : e.message}`); }
      }
    }

    // ---------- Units (the unit-shaped sections) ----------
    const unitSections = sections
      .map((sec) => ({ sec, parsed: parseUnitSection(sec.name) }))
      .filter((x) => x.parsed);
    if (!unitSections.length) {
      note(`${label}: no sections named "Unit …" — nothing to import from this course.`);
      continue;
    }

    // Every unit already linked to this Moodle course or sitting on this course, in
    // one query, rather than two lookups per section.
    const existingUnits = dbCourse
      ? await prisma.unit.findMany({ where: { OR: [{ moodleCourseId: course.id }, { courseId: dbCourse.id }] } })
      : [];
    const unitBySection = new Map(existingUnits.filter((u) => u.moodleSectionId != null).map((u) => [u.moodleSectionId, u]));
    const unitByCode = new Map(existingUnits.map((u) => [u.code, u]));

    const placeOf = termsBySectionId(sections);
    // Deadlines for this course's activities, keyed by course-module id. Built ONCE per
    // course, from the core_course_get_contents response already in hand — see
    // vle/moodleActivityDates.js. Costs no extra Moodle call.
    const dueByCmid = dueDatesByCmid(sections);
    const unplaced = [];

    const unitByCmid = new Map();  // course-module id → unit, to trace a grade item home
    const courseUnits = [];        // every unit on this course, activities or not
    for (const { sec, parsed } of unitSections) {
      // A unit outside every "Year N - Term M" section keeps year/term null rather
      // than being guessed at — it is reported below so someone can place it.
      const place = placeOf.get(sec.id) || null;
      const data = {
        code: parsed.code,
        unitNumber: parsed.number,
        name: parsed.name,
        courseId: dbCourse ? dbCourse.id : null,
        moodleSectionId: sec.id,
        moodleCourseId: course.id,
      };
      let unit = unitBySection.get(sec.id) || unitByCode.get(parsed.code) || null;
      // Year/term follow Moodle ONLY when Moodle actually places the unit. When it
      // doesn't, the existing value is left alone: previously this wrote null every
      // run, so a placement an admin set by hand — which the note below explicitly
      // tells them to do — was wiped again at 02:00, night after night.
      if (place) {
        data.year = place.year;
        data.termNumber = place.termNumber;
      } else if (!unit) {
        data.year = null;
        data.termNumber = null;
      }
      // Only worth reporting if nobody has placed it yet, in Moodle or by hand.
      if (!place && !(unit && unit.year != null)) unplaced.push(parsed.code);
      if (unit) {
        summary.unitsUpdated++;
        if (!dryRun) {
          // A unit that changes course, year or term changes which units a student is
          // measured across, so everyone on it needs rescoring. Read the register
          // BEFORE the update — afterwards the unit belongs somewhere else, and the
          // question is who was on it when it moved.
          const moved = data.courseId !== unit.courseId
            || (data.year !== undefined && data.year !== unit.year)
            || (data.termNumber !== undefined && data.termNumber !== unit.termNumber);
          if (moved) await touchUnitCohort(unit.id);
          unit = await prisma.unit.update({ where: { id: unit.id }, data });
        }
      } else {
        summary.unitsCreated++;
        if (!dryRun) {
          try { unit = await prisma.unit.create({ data }); }
          catch (e) {
            note(`${label} / ${parsed.code}: could not create the unit — ${e.code === "P2002" ? "that unit code already exists on this course" : e.message}`);
            continue;
          }
        }
      }
      // In a preview `unit` is null (nothing was written); keep the code so its
      // assessments and grades are still counted as new.
      const ref = unit || { id: null, code: parsed.code };
      courseUnits.push(ref);
      for (const mod of sec.modules || []) unitByCmid.set(mod.id, ref);
    }
    if (unplaced.length) {
      note(`${label}: ${unplaced.join(", ")} ${unplaced.length === 1 ? "is" : "are"} not inside any "Year N - Term M" section in Moodle, so ${unplaced.length === 1 ? "it has" : "they have"} no year or term. Set ${unplaced.length === 1 ? "it" : "them"} on the Registers tab, or move ${unplaced.length === 1 ? "it" : "them"} into a term in Moodle and sync again.`);
    }

    // ---------- Students (role "student" only) ----------
    const studentUsers = users.filter((u) => (u.roles || []).some((r) => r.shortname === "student"));
    // Both the derived college number AND Moodle's raw idnumber, so students imported
    // by an earlier run — which stored the raw hash — are still found and repaired.
    const refs = studentUsers.flatMap((u) => [collegeNumber(u.idnumber, u.email), clean(u.idnumber)]).filter(Boolean);
    const emails = studentUsers.map((u) => clean(u.email).toLowerCase()).filter(Boolean);
    const known = await prisma.student.findMany({
      where: {
        OR: [
          { moodleUserId: { in: studentUsers.map((u) => u.id) } },
          { studentRef: { in: refs } },
          { email: { in: emails } },
        ],
      },
    });
    const byMoodleId = new Map(known.filter((s) => s.moodleUserId != null).map((s) => [s.moodleUserId, s]));
    const byRef = new Map(known.map((s) => [s.studentRef, s]));
    const byEmail = new Map(known.map((s) => [s.email.toLowerCase(), s]));

    const studentByMoodleId = new Map();
    for (const u of studentUsers) {
      const email = clean(u.email).toLowerCase();
      const ref = collegeNumber(u.idnumber, u.email);
      const rawRef = clean(u.idnumber);
      // Match on a link made previously, then the college's own student number,
      // then the raw Moodle idnumber an earlier run may have stored, then email.
      let st = byMoodleId.get(u.id) || (ref && byRef.get(ref)) || (rawRef && byRef.get(rawRef)) || (email && byEmail.get(email)) || null;
      if (st) {
        summary.studentsMatched++;
        if (!dryRun) {
          // Repair a reference stored before we knew idnumber was a hash. Guarded,
          // because the number is unique and another row may already hold it.
          const fix = {};
          if (st.moodleUserId !== u.id) fix.moodleUserId = u.id;
          if (ref && st.studentRef !== ref && COLLEGE_NUMBER.test(ref)) fix.studentRef = ref;
          if (Object.keys(fix).length) {
            try { st = await prisma.student.update({ where: { id: st.id }, data: fix }); }
            catch (_) { /* another student already holds that number or Moodle id — leave as is */ }
          }
        }
      } else {
        if (!ref && !email) { note(`${label}: a Moodle student has neither a student number nor an email — skipped.`); continue; }
        summary.studentsCreated++;
        if (!dryRun) {
          const first = clean(u.firstname) || clean(u.fullname).split(" ")[0] || "Student";
          const last = clean(u.lastname);
          try {
            st = await prisma.student.create({
              data: {
                firstName: first, lastName: last,
                studentRef: ref || `M${u.id}`,
                email: email || `moodle-${u.id}@placeholder.invalid`,
                initials: initialsOf(first, last), colour: colourFor(email || String(u.id)),
                active: true, moodleUserId: u.id,
              },
            });
          } catch (e) {
            note(`${label}: could not add the student with number ${ref || "(none)"} — ${e.code === "P2002" ? "that student number or email is already in use" : e.message}`);
            continue;
          }
        }
      }
      if (st) studentByMoodleId.set(u.id, st);
    }

    // ---------- Assessments ----------
    // gradereport_user_get_grade_items repeats the same item list for every user,
    // each carrying that user's mark. So the items define the assessments once, and
    // every user then supplies one mark against them.
    const itemsById = new Map();
    for (const ug of usergrades) for (const it of ug.gradeitems || []) if (isGradableItem(it)) itemsById.set(it.id, it);

    const existingByItem = new Map(
      (await prisma.assessment.findMany({ where: { moodleItemId: { in: [...itemsById.keys()] } } }))
        .map((a) => [a.moodleItemId, a])
    );
    const assessByItem = new Map();  // Moodle grade-item id → { row, unit, max }
    for (const [itemId, item] of itemsById) {
      const unit = unitByCmid.get(item.cmid);
      if (!unit) continue;  // an activity outside any unit section, e.g. in Introduction
      const title = clean(item.itemname) || "Assessment";
      const max = Number(item.grademax) > 0 ? Math.round(Number(item.grademax)) : 100;

      // The deadline Moodle holds for this activity, or undefined when it holds none.
      // `undefined` rather than null matters: it is the difference between "Moodle does
      // not say" and "Moodle says there is no deadline", and only the first must leave
      // a date a human typed alone.
      const moodleDue = item.cmid != null ? dueByCmid.get(Number(item.cmid)) : undefined;

      let row = existingByItem.get(itemId) || null;
      // An assessment of the same name may already have been created by hand.
      if (!row && unit.id) row = await prisma.assessment.findFirst({ where: { unitId: unit.id, title } });
      if (row) {
        summary.assessmentsUpdated++;
        if (!dryRun) {
          // Never lower the maximum below a mark already awarded.
          //
          // PUT /assessments/:id refuses this and names the offending mark; the sync
          // wrote the same column with no check at all — unattended, at 02:00. A
          // rescale from 100 to 50 with a 78 on file gave 100% from the API, 156% on
          // the marking screen, a false Distinction, and a Save button disabled for
          // the whole assessment so nobody could correct it.
          let safeMax = max;
          if (max < row.maxMarks) {
            const top = await prisma.assessmentGrade.aggregate({ where: { assessmentId: row.id }, _max: { marks: true } });
            if (top._max.marks != null && top._max.marks > max) {
              safeMax = row.maxMarks;
              note(`${unit.code} · ${title}: Moodle lowered the maximum to ${max}, but ${top._max.marks} has already been awarded — kept the maximum at ${row.maxMarks}. Change that mark first, then re-sync.`);
            }
          }
          // The maximum is the denominator of every percentage derived from this
          // assessment, so rescaling it moves the score of everyone on the unit — not
          // only those with a mark on file. A retitle changes nothing anybody is
          // measured on, hence the comparison.
          const rescaled = safeMax !== row.maxMarks;
          // THE DEADLINE IS FILLED, NEVER OVERWRITTEN.
          //
          // Assessment.dueDate has no `source` column, so there is no way to tell a
          // date this sync wrote from one an administrator typed on the Assessments
          // page. Overwriting nightly would silently revert their correction — the
          // failure moodleItemType.js already refuses to commit with `type`, where a
          // correction "appears to work and silently reverts".
          //
          // So: set it when we have none, and when Moodle disagrees with a date already
          // on file, REPORT it and change nothing. That mirrors how a manually-entered
          // mark is handled a few dozen lines below, and it keeps the sync incapable of
          // moving a deadline students have been told about.
          const dueData = {};
          if (moodleDue && !row.dueDate) {
            dueData.dueDate = moodleDue;
          } else if (moodleDue && row.dueDate && row.dueDate !== moodleDue) {
            note(`${unit.code} · ${title}: Moodle has a deadline of ${moodleDue} but ${row.dueDate} is on file here — left unchanged. Change it on the Assessments page if Moodle is right.`);
          }
          row = await prisma.assessment.update({
            where: { id: row.id },
            data: { title, maxMarks: safeMax, moodleItemId: itemId, moodleCmid: item.cmid || null, ...dueData },
          });
          if (rescaled) await touchUnitCohort(unit.id);
        }
      } else {
        summary.assessmentsCreated++;
        if (!dryRun && unit.id) {
          try {
            row = await prisma.assessment.create({
              // ON CREATE ONLY, and only where the mapping is confident. Moodle's
              // itemmodule is already in hand -- the filter above reads it to drop
              // attendance items -- and this line used to throw it away, so every piece
              // of work at a synced college became coursework and
              // prediction/assessmentType.js could never find a student who fails exams.
              //
              // Unmapped modules keep the old default, so this can only add information.
              // And it is NOT applied on update: staff can correct a type on the
              // Assessments page, and a sync that re-flattened their correction every
              // night would be worse than never having mapped anything -- the correction
              // would appear to work and silently revert.
              //
              // dueDate arrives here for the first time. Until now the sync created
              // every assessment with no deadline at all, so "when is this due" was
              // unanswerable at exactly the colleges that import their assessments
              // rather than typing them — and the assessment tracker is built around
              // that column. `?? null` because the map omits activities with no
              // deadline, and undefined would make Prisma skip the field rather than
              // store "not recorded".
              data: { unitId: unit.id, title, type: itemType(item.itemmodule) || "Assignment", maxMarks: max, moodleItemId: itemId, moodleCmid: item.cmid || null, dueDate: moodleDue ?? null },
            });
          } catch (e) { note(`${label} / ${unit.code}: could not create the assessment "${title}" — ${e.message}`); continue; }
          // A brand-new assessment is work nobody has done yet, so it enlarges the
          // missing-work denominator for the whole cohort the moment it appears —
          // again, regardless of who has a mark. Outside the try: a failure to read the
          // register is not a failure to create the assessment, and must not be
          // reported as one.
          await touchUnitCohort(unit.id);
        }
      }
      assessByItem.set(itemId, { row, unit, max });
    }

    // ---------- Enrolments ----------
    // Everyone on the course is enrolled on EVERY unit of that course.
    //
    // Moodle only ever enrols a student on the course, never on a unit, so unit
    // enrolment has to be inferred. Inferring it from the gradebook ("they appear
    // against this unit's assessments") looked reasonable but left every unit that
    // has no assessments yet with nobody on it — you could not open a register for
    // a unit until after its first assignment existed, which is backwards.
    const courseUnitIds = [...new Set(courseUnits.map((u) => u.id).filter(Boolean))];

    // ---------- Lecturer and module leader, where Moodle is unambiguous ----------
    //
    // COSTS NO EXTRA CALL: core_enrol_get_enrolled_users is already in hand for this
    // course, and every user's `roles` came with it. The sync read only "student" and
    // discarded the rest — the same shape as the activity dates and lastcourseaccess.
    //
    // Only fires when the course has EXACTLY ONE editing teacher (see
    // vle/moodleTeachers.js for why anything else is a guess), and only ever FILLS AN
    // EMPTY FIELD. Roles are per course while units are sections, so this writes the
    // same person onto every unit of the course — correct for a single-lecturer course,
    // and the reason it must never overwrite what a human set on a shared one.
    if (!dryRun && courseUnitIds.length) {
      try {
        const lead = soleEditingTeacher(users);
        if (lead) {
          // Matched by email against an existing account. This never CREATES staff: a
          // Moodle teacher without an account here is somebody the college has chosen
          // not to give one, and inventing logins from a VLE roster is not this sync's
          // business.
          const staff = await prisma.staff.findFirst({
            where: { email: { equals: lead.email, mode: "insensitive" } },
            select: { id: true, name: true },
          });
          if (staff) {
            const filled = await prisma.unit.updateMany({
              where: { id: { in: courseUnitIds }, leaderStaffId: null },
              data: { leaderStaffId: staff.id },
            });
            const taught = await prisma.unit.updateMany({
              where: { id: { in: courseUnitIds }, tutorStaffId: null },
              data: { tutorStaffId: staff.id, tutor: staff.name },
            });
            summary.teachersLinked += filled.count + taught.count;
          } else {
            note(`${label}: ${lead.fullname || lead.email} is the only editing teacher on this course, but no staff account here has that email — module leader left unset.`);
          }
        }
      } catch (e) {
        // Never allowed to abort a sync that has already imported students and marks.
        note(`${label}: could not set the module leader from Moodle — ${e.message}`);
      }
    }
    const wantEnrol = new Set();
    for (const st of studentByMoodleId.values()) {
      for (const unitId of courseUnitIds) wantEnrol.add(`${st.id}|${unitId}`);
    }
    const unitIds = courseUnitIds;
    const already = new Set(
      (unitIds.length
        ? await prisma.enrolment.findMany({ where: { unitId: { in: unitIds } }, select: { studentId: true, unitId: true } })
        : []
      ).map((e) => `${e.studentId}|${e.unitId}`)
    );
    /* --- VLE engagement -------------------------------------------------------
     *
     * COSTS NOTHING EXTRA. core_enrol_get_enrolled_users was already called above for
     * this course and `lastcourseaccess` is already in the response; until now it was
     * being thrown away.
     *
     * A ROW MEANS "WE LOOKED". A student the site reports on gets a row, `accessed`
     * true or false. A student whose site hides the field gets NO ROW, and the counter
     * above records that we could not see them. Absence is the null, and it has to be
     * decided HERE, by the code that saw the HTTP response, because no later count can
     * separate "a disengaged cohort" from "a Moodle with hiddenuserfields set" from "a
     * college that teaches face to face" -- all three are zero.
     *
     * The observation is dated in the COLLEGE'S OWN ZONE, not UTC and not the host
     * clock: a sync run at 00:30 London on the 28th is an observation about the 28th,
     * and a UTC slice would file it under the 27th and put two observations on one day.
     */
    const observedOn = localDate();
    const engagementRows = [];
    for (const u of studentUsers) {
      const st = studentByMoodleId.get(u.id);
      if (!st) continue;
      const seen = engagement.observeUser(u, observedOn, (iso) => isoDate(iso, ZONE));
      if (!seen.observable) { summary.engagementNotObservable += 1; continue; }
      for (const unitId of courseUnitIds) {
        engagementRows.push({
          studentId: st.id, unitId, observedOn,
          accessed: seen.accessed, lastAccessOn: seen.lastAccessOn,
        });
      }
    }
    summary.engagementObserved += engagementRows.length;
    if (!dryRun && engagementRows.length) {
      // skipDuplicates rather than an upsert loop: the unique key is
      // (studentId, unitId, observedOn), so a second sync on the same day keeps the
      // FIRST observation of that day. That is the honest one -- lastcourseaccess only
      // moves forward, so a later run on the same day can only ever make a student look
      // more active than they were when we first looked, and re-running a sync must not
      // be a way to improve somebody's engagement figure.
      await prisma.vleEngagement.createMany({ data: engagementRows, skipDuplicates: true });
      for (const r of engagementRows) touched.add(r.studentId);
    }

    const toEnrol = [...wantEnrol].filter((k) => !already.has(k));
    summary.enrolmentsCreated += toEnrol.length;
    if (!dryRun && toEnrol.length) {
      await prisma.enrolment.createMany({
        data: toEnrol.map((k) => { const [studentId, unitId] = k.split("|"); return { studentId, unitId }; }),
        skipDuplicates: true,
      });
      // Being enrolled on another unit adds a unit's worth of work to what the student
      // is measured on, so the cached score no longer covers their actual programme.
      for (const k of toEnrol) touched.add(k.split("|")[0]);
    }

    // ---------- Grades ----------
    const assessIds = [...assessByItem.values()].map((a) => a.row?.id).filter(Boolean);
    const gradeByKey = new Map(
      (assessIds.length
        ? await prisma.assessmentGrade.findMany({ where: { assessmentId: { in: assessIds } } })
        : []
      ).map((g) => [`${g.assessmentId}|${g.studentId}`, g])
    );

    // ---------- Submissions: who handed the work in ----------
    //
    // Collected in the SAME pass as the grades below, but decided afterwards, because
    // the decision is per ASSESSMENT across the whole cohort and this loop runs per
    // STUDENT. See vle/moodleSubmissions.js: an activity that reports nothing about
    // anybody cannot be told apart from a cohort that submitted nothing, so the guard
    // needs every student's entry for an item before it can answer.
    //
    // assessmentId -> [{ studentId, submittedOn, hasGrade }]
    const submissionObs = new Map();

    for (const ug of usergrades) {
      const st = studentByMoodleId.get(ug.userid);
      if (!st) continue;
      for (const item of ug.gradeitems || []) {
        const target = assessByItem.get(item.id);
        if (!target) continue;
        // BEFORE the graderaw skip below, deliberately. That skip is what discarded the
        // submitted-but-unmarked student — the entire population the marking percentage
        // measures — and moving this line after it would reintroduce the bug this
        // feature exists to fix.
        if (target.row?.id) {
          if (!submissionObs.has(target.row.id)) submissionObs.set(target.row.id, []);
          submissionObs.get(target.row.id).push({
            studentId: st.id,
            submittedOn: tsToDate(item.gradedatesubmitted),
            hasGrade: item.graderaw != null && item.graderaw !== "",
          });
        }
        if (item.graderaw == null || item.graderaw === "") continue;  // not marked in Moodle yet
        const value = Number(item.graderaw);
        if (!Number.isFinite(value)) continue;
        const marks = Math.max(0, Math.min(target.max, Math.round(value)));
        const stamps = { submittedAt: tsToDate(item.gradedatesubmitted), gradedOn: tsToDate(item.gradedategraded) };

        const existing = target.row ? gradeByKey.get(`${target.row.id}|${st.id}`) : null;
        if (!existing) {
          summary.gradesCreated++;
          if (!dryRun && target.row) {
            try {
              await prisma.assessmentGrade.create({
                data: {
                  assessmentId: target.row.id, studentId: st.id, marks,
                  source: "moodle", gradedBy: "Moodle",
                  feedback: clean(item.feedback).slice(0, 2000), ...stamps,
                },
              });
              // A mark that did not exist a moment ago is exactly what a progression
              // score is built from.
              touched.add(st.id);
            } catch (_) { /* created by a concurrent run */ }
          }
        } else if (existing.source === "manual") {
          // Somebody typed this mark in the app. Never silently overwrite a person's
          // work — report the difference and let them decide.
          if (existing.marks !== marks) {
            summary.gradesSkippedManual++;
            note(`${target.unit.code} · ${clean(item.itemname)}: Moodle has ${marks}/${target.max} but ${existing.marks}/${target.max} was entered by hand — left unchanged.`);
          }
        // `feedback` belongs in this predicate. Without it, a tutor who entered a mark
        // on Monday and wrote their feedback on Wednesday — touching neither the grade
        // nor its dates — never had that feedback imported, so the student's app showed
        // a mark with an empty comment for ever.
        } else if (existing.marks !== marks || existing.submittedAt !== stamps.submittedAt || existing.gradedOn !== stamps.gradedOn || existing.feedback !== clean(item.feedback).slice(0, 2000)) {
          summary.gradesUpdated++;
          if (!dryRun) {
            await prisma.assessmentGrade.update({ where: { id: existing.id }, data: { marks, source: "moodle", feedback: clean(item.feedback).slice(0, 2000), gradedAt: new Date(), ...stamps } });
            // Flagged even when only the dates or the feedback moved: a submission date
            // is what tells a score whether work was late, not merely what it scored.
            touched.add(existing.studentId);
          }
        }
      }
    }

    // ---------- Submissions, decided and written ----------
    //
    // One assessment at a time, from the whole cohort's entries. An unobserved activity
    // writes NOTHING — no rows, no deletions — so the tracker keeps reading null and
    // saying "Not synced", which is the truth about a Turnitin activity that does not
    // publish submission dates.
    for (const [assessmentId, observations] of submissionObs) {
      const { observed, rows } = submissionsFor(observations);
      if (!observed) { summary.submissionsUnobserved++; continue; }
      for (const r of rows) {
        try {
          if (!dryRun) {
            // Upsert on the pair the table is unique over. `update` rather than skip:
            // a student who submits late moves from not_submitted to submitted, and a
            // row frozen at the first sync would keep the tracker reporting a hand-in
            // that has since arrived as missing.
            //
            // recordedBy names the source in the same vocabulary AssessmentGrade uses,
            // so a row this sync wrote is distinguishable from one a person entered if
            // manual entry is ever added.
            await prisma.assessmentSubmission.upsert({
              where: { assessmentId_studentId: { assessmentId, studentId: r.studentId } },
              create: { assessmentId, studentId: r.studentId, status: r.status, submittedOn: r.submittedOn, source: "moodle", recordedBy: "Moodle" },
              update: { status: r.status, submittedOn: r.submittedOn, source: "moodle", recordedBy: "Moodle" },
            });
          }
          summary.submissionsRecorded++;
          // Whether work was handed in, and whether it was late, are inputs to the
          // progression score — the missing-work and on-time signals read this table.
          touched.add(r.studentId);
        } catch (e) {
          note(`could not record a submission for assessment ${assessmentId} — ${e.message}`);
        }
      }
    }

    // One course finished. Reported so a long first import shows movement rather than
    // a spinner that could equally mean "working" or "hung" — the failure mode the
    // 120-second call timeout above was added for, seen from the outside.
    //
    // Never allowed to throw: a progress write failing must not abandon an import that
    // has already landed students and marks.
    coursesDone++;
    if (onProgress) {
      try { await onProgress({ coursesDone, coursesTotal: everything.length, summary }); }
      catch (_) { /* reporting is not the job */ }
    }
  }

  // ---------- Attendance ----------
  // Runs last: it needs the students, units and courses above to exist and be matched
  // before a register can be attached to anything. Kept in its own module because it
  // reshapes the data rather than copying it — Moodle records attendance per intake,
  // Staff Hub per unit.
  //
  // Deliberately non-fatal. Reading attendance needs mod_attendance functions on the
  // token's external service, which is a separate Moodle setting from the rest of the
  // sync; if it is missing, the grades and enrolments above must still land.
  try {
    // `studentIds` is who the attendance import wrote for; it is kept out of `summary`
    // because that object is counters, stored as JSON on the run and shown to an admin.
    const { studentIds = [], ...counts } = await importAttendance({ call, dryRun, note });
    Object.assign(summary, counts);
    for (const id of studentIds) touched.add(id);
  } catch (e) {
    note(`Attendance import failed: ${e.message}`);
  }

  // One flush for the whole run, and deliberately swallowed. Invalidation is
  // bookkeeping for a background job: a sync that imported the night's marks correctly
  // must not be reported as failed because a flag could not be written. The cost of it
  // failing is a score that refreshes late, which is why it is reported rather than
  // silenced. A preview writes nothing, so there is nothing to invalidate.
  if (!dryRun && touched.size) {
    try {
      await predictionRunner.markStale([...touched]);
    } catch (e) {
      note(`Progression scores could not be marked out of date (${e.message}) — they will refresh after the next sync.`);
    }
  }

  return { summary, issues };
}

// One sync at a time, process-wide — the nightly job and the admin's "Sync now"
// button must not run together, or they race on the same rows and double the counts.
// The lock lives here rather than in the route so both callers share it.
let inFlight = null;
const isRunning = () => Boolean(inFlight);

// Runs a sync and records it, so the UI can show what happened and when.
async function runSync({ dryRun = false, startedBy = null, mode = "manual" } = {}) {
  if (dryRun) return { preview: true, ...(await syncFromMoodle({ dryRun: true })) };
  if (inFlight) throw new Error("A sync is already running.");

  inFlight = (async () => {
    const run = await prisma.moodleSync.create({ data: { status: "running", mode, startedBy } });
    try {
      // Progress is written into the run's `summary` column as it goes, rather than
      // only at the end. A first import at a real college takes minutes, and until now
      // the only thing an admin could see was "running" — indistinguishable from hung,
      // which is exactly the failure the 120-second call timeout exists to prevent and
      // which was invisible from the screen.
      //
      // No new column: `summary` is already JSON, already returned by /moodle/status,
      // and already rendered. The final write below replaces this with the real
      // counters, so a finished run looks exactly as it always did.
      const onProgress = async ({ coursesDone, coursesTotal, summary }) => {
        await prisma.moodleSync.update({
          where: { id: run.id },
          data: { summary: JSON.stringify({ ...summary, coursesDone, coursesTotal }) },
        });
      };
      const { summary, issues } = await syncFromMoodle({ onProgress });
      await prisma.moodleSync.update({
        where: { id: run.id },
        data: { status: "ok", finishedAt: new Date(), summary: JSON.stringify(summary), issues: JSON.stringify(issues) },
      });
      return { id: run.id, summary, issues };
    } catch (e) {
      await prisma.moodleSync.update({
        where: { id: run.id },
        data: { status: "failed", finishedAt: new Date(), error: String(e.message || e).slice(0, 1000) },
      });
      throw e;
    }
  })();

  try { return await inFlight; }
  finally { inFlight = null; }
}

// Resolve abandoned runs.
//
// A process killed mid-sync (a Render deploy, an OOM) leaves its row saying "running"
// for ever, and nothing else ever resolves it. Two things then go wrong: the admin card
// keys off finishedAt, so it reads "Never run", and the nightly job's 12-hour dedupe
// counts the ghost as tonight's run and skips the import entirely.
//
// STALE_AFTER_MS is deliberately far longer than any real sync. isRunning() is
// PER-PROCESS, so on a multi-instance deploy the guard below cannot see another
// instance's in-flight sync — the age is what stops this marking a live run as failed.
//
// Lives here because both callers (GET /moodle/status, which sweeps before reporting,
// and the nightly job in scheduler.js, which sweeps before its dedupe counts) need the
// identical rule. They each had their own copy, with the same hour written out twice.
const STALE_AFTER_MS = 60 * 60 * 1000;
async function sweepStaleRuns() {
  if (isRunning()) return 0; // this process owns a live run; leave every row alone
  const r = await prisma.moodleSync.updateMany({
    where: { status: "running", startedAt: { lt: new Date(Date.now() - STALE_AFTER_MS) } },
    data: { status: "failed", finishedAt: new Date(), error: "Interrupted — the server restarted while this sync was running." },
  });
  return r.count;
}


// --- Test connection ----------------------------------------------------------
// core_webservice_get_site_info is the cheapest call Moodle offers that proves both
// halves at once: the URL is reachable AND the token is accepted. Read-only, and it
// returns the site's own name, which is the useful confirmation — an administrator
// who pasted the wrong college's URL sees the wrong college's name back.
async function testConnection() {
  await cfg.load("moodle");
  if (!isConfigured()) return { ok: false, note: "Not configured — a Moodle URL and a web-services token are both required." };
  try {
    const info = await call("core_webservice_get_site_info");
    const name = info?.sitename || info?.siteurl || "your Moodle site";
    return { ok: true, note: "Connected to " + name + (info?.username ? " as " + info.username : "") + "." };
  } catch (e) {
    return { ok: false, note: "Could not reach Moodle — " + e.message };
  }
}

module.exports = { testConnection, isConfigured, isRunning, call, runSync, syncFromMoodle, sweepStaleRuns, parseUnitSection };
