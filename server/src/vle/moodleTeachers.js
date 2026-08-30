// Who teaches a Moodle course, for filling in a module's lecturer and leader.
//
// PURE. Same seam as the other vle/ helpers, same reason.
//
// WHY THIS IS DELIBERATELY TIMID
//
// MOODLE ASSIGNS ROLES PER COURSE, NOT PER UNIT. Staff Hub's units are SECTIONS inside
// a Moodle course, and Moodle has no concept of "the lecturer for section 3". So the
// most this can honestly say is "one person teaches this whole course" — and a course
// with six units taught by six different lecturers reports all six of them at course
// level, with nothing to say which teaches which.
//
// Naming the wrong lecturer against a module is worse than naming nobody. "— not set —"
// reads as not recorded, which is true and prompts somebody to set it; a confidently
// wrong name gets chased about a register they do not take, and quietly stops anyone
// looking for the right person.
//
// So: a course with EXACTLY ONE editing teacher yields that person, and every other
// shape yields nothing. Two teachers is ambiguous. Zero is unknown. That is the whole
// rule, and it is why the return type is a single value rather than a list — a list
// would invite a caller to pick the first one, which is picking at random.
//
// WHICH ROLE COUNTS
//
// `editingteacher` only. Moodle's plain `teacher` is the non-editing role, given to
// visiting lecturers, teaching assistants and observers; treating it as ownership would
// name a support tutor as a module's leader. `manager` is administrative and often held
// by whoever built the course, which is not a teaching relationship at all.
const EDITING_TEACHER = "editingteacher";

/**
 * The one editing teacher on a course, or null when there is not exactly one.
 *
 * @param users the core_enrol_get_enrolled_users response for a course.
 * @returns { email, fullname } | null
 */
function soleEditingTeacher(users) {
  const list = Array.isArray(users) ? users : [];
  const teachers = [];
  const seen = new Set();
  for (const u of list) {
    const roles = Array.isArray(u?.roles) ? u.roles : [];
    if (!roles.some((r) => String(r?.shortname || "").toLowerCase() === EDITING_TEACHER)) continue;
    const email = String(u?.email || "").trim().toLowerCase();
    // No email means nothing to match a Staff account against, so this person cannot be
    // linked to anybody here. They still COUNT toward ambiguity below — a course with
    // one matchable teacher and one unmatchable one is not a course with one teacher.
    const key = email || `id:${u?.id}`;
    if (seen.has(key)) continue;      // Moodle can list a role twice via two enrolments
    seen.add(key);
    teachers.push({ email, fullname: String(u?.fullname || "").trim() });
  }
  if (teachers.length !== 1) return null;
  if (!teachers[0].email) return null;   // nothing to match on
  return teachers[0];
}

module.exports = { soleEditingTeacher, EDITING_TEACHER };
