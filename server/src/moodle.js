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
const { importAttendance } = require("./moodleAttendance");

const BASE = () => (process.env.MOODLE_URL || "").replace(/\/+$/, "");
const TOKEN = () => process.env.MOODLE_TOKEN || "";
const isConfigured = () => Boolean(BASE() && TOKEN());

// --- Moodle REST -----------------------------------------------------------------
// A single Moodle call must never hang. Without a deadline a stalled VLE left the
// sync awaiting a response forever, which pinned the in-flight lock: status reported
// "running" indefinitely, every later sync 409'd, the nightly job skipped every night,
// and only a restart recovered — with nothing logged to say why.
const CALL_TIMEOUT_MS = 120000;

async function call(wsfunction, params = {}) {
  if (!isConfigured()) throw new Error("Moodle is not configured (set MOODLE_URL and MOODLE_TOKEN)");
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
async function syncFromMoodle({ dryRun = false } = {}) {
  const summary = {
    coursesCreated: 0, coursesUpdated: 0,
    unitsCreated: 0, unitsUpdated: 0,
    assessmentsCreated: 0, assessmentsUpdated: 0,
    studentsCreated: 0, studentsMatched: 0, enrolmentsCreated: 0,
    gradesCreated: 0, gradesUpdated: 0, gradesSkippedManual: 0,
    attendanceSessionsCreated: 0, attendanceMarksCreated: 0,
    attendanceSkippedConflict: 0, attendanceSkippedNoStudent: 0,
  };
  const issues = [];
  const note = (m) => { if (issues.length < 300) issues.push(m); };

  for (const { course, sections, users, usergrades } of await readMoodle()) {
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
              data: { name: courseName, colour: colourFor(courseName), moodleCourseId: course.id },
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
        if (!dryRun) unit = await prisma.unit.update({ where: { id: unit.id }, data });
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
          row = await prisma.assessment.update({
            where: { id: row.id },
            data: { title, maxMarks: safeMax, moodleItemId: itemId, moodleCmid: item.cmid || null },
          });
        }
      } else {
        summary.assessmentsCreated++;
        if (!dryRun && unit.id) {
          try {
            row = await prisma.assessment.create({
              data: { unitId: unit.id, title, type: "Assignment", maxMarks: max, moodleItemId: itemId, moodleCmid: item.cmid || null },
            });
          } catch (e) { note(`${label} / ${unit.code}: could not create the assessment "${title}" — ${e.message}`); continue; }
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
    const toEnrol = [...wantEnrol].filter((k) => !already.has(k));
    summary.enrolmentsCreated += toEnrol.length;
    if (!dryRun && toEnrol.length) {
      await prisma.enrolment.createMany({
        data: toEnrol.map((k) => { const [studentId, unitId] = k.split("|"); return { studentId, unitId }; }),
        skipDuplicates: true,
      });
    }

    // ---------- Grades ----------
    const assessIds = [...assessByItem.values()].map((a) => a.row?.id).filter(Boolean);
    const gradeByKey = new Map(
      (assessIds.length
        ? await prisma.assessmentGrade.findMany({ where: { assessmentId: { in: assessIds } } })
        : []
      ).map((g) => [`${g.assessmentId}|${g.studentId}`, g])
    );

    for (const ug of usergrades) {
      const st = studentByMoodleId.get(ug.userid);
      if (!st) continue;
      for (const item of ug.gradeitems || []) {
        const target = assessByItem.get(item.id);
        if (!target) continue;
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
          if (!dryRun) await prisma.assessmentGrade.update({ where: { id: existing.id }, data: { marks, source: "moodle", feedback: clean(item.feedback).slice(0, 2000), gradedAt: new Date(), ...stamps } });
        }
      }
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
    Object.assign(summary, await importAttendance({ call, dryRun, note }));
  } catch (e) {
    note(`Attendance import failed: ${e.message}`);
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
      const { summary, issues } = await syncFromMoodle({});
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

module.exports = { isConfigured, isRunning, call, runSync, syncFromMoodle, parseUnitSection };
