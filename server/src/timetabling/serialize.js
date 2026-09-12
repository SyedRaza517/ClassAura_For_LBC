// What leaves the building.
//
// ALLOWLISTS, NEVER BLOCKLISTS. sAdmission is the standing example of the other way:
// it stripped a fixed list of secrets, so every column added afterwards shipped to
// the browser by default. Here, a column added to Room tomorrow is private until
// somebody adds its name below on purpose.
//
// These live in the module rather than in the shared serializers.js because this
// module is self-contained by instruction, and serializers.js is imported by thirty
// files that have no business seeing these shapes.

/**
 * A room as a person reads it: "101 - First floor [Harrow]".
 *
 * Assembled here rather than stored, so that renaming a campus renames it
 * everywhere. Each part is dropped when empty, because "101 -  []" is worse than
 * "101".
 */
function roomLabel(r) {
  if (!r) return "";
  const head = [r.name, r.floor].filter(Boolean).join(" - ");
  // The RELATED campus first. That promise above — renaming a campus renames it
  // everywhere — stopped being true the moment campuses became rows: reading only the
  // legacy `campus` string would keep printing the name the room was created with,
  // for ever, with no way to correct it. The string stays as the fallback for a room
  // the migration's fold could not place.
  const campus = r.campusRef?.name || r.campus;
  return campus ? `${head} [${campus}]` : head;
}

// An allowlist, like everything else here. The coordinates are published deliberately:
// they are not a secret — a college's address is on its website — and the settings screen
// has to show what is recorded so somebody can tell a campus that has been pinned from one
// that has not. `null` travels as null and is never coerced to 0, because 0 is a real
// coordinate in the Gulf of Guinea and would read as a located campus 5,000 km away.
const sCampus = (c) => ({
  id: c.id,
  name: c.name,
  active: !!c.active,
  latitude: c.latitude ?? null,
  longitude: c.longitude ?? null,
  locatedAt: c.locatedAt ?? null,
  locatedBy: c.locatedBy ?? null,
});

const sRoom = (r) => ({
  id: r.id,
  name: r.name,
  floor: r.floor || "",
  // The RELATED campus wins, falling back to the legacy free-text column.
  //
  // Both exist on purpose for one release: 20260907T120000_timetabling_registers folded
  // the strings into Campus rows, and Room.campus is retained as the only record of
  // what the text actually said. The fallback matters for a room whose spelling the
  // fold could not place — it still shows its campus rather than going blank, which is
  // what a bare `campusRef.name` would do to exactly the rooms needing attention.
  campus: r.campusRef?.name ?? r.campus ?? "",
  campusId: r.campusId ?? null,
  // Passed through as null, never coerced to 0. Null is "we have not recorded how
  // many this room seats"; zero would be "this room seats nobody", and a future
  // capacity check would take the second at face value and retire a real room.
  capacity: r.capacity ?? null,
  kind: r.kind || "",
  active: !!r.active,
  label: roomLabel(r),
});

const sCategory = (c) => ({
  id: c.id, name: c.name, colour: c.colour || "#1a3a8f", active: !!c.active,
});

/**
 * One event, with the names of what it is joined to.
 *
 * `changedAt` goes out as a timestamp and the SCREEN subtracts to get "changed 2
 * days ago". Sending a day count would be wrong by the next morning, with nothing on
 * the server to correct it, because a day passing is not an event that fires.
 */
const sEvent = (e) => ({
  id: e.id,
  date: e.date,
  start: e.startTime,
  end: e.endTime,
  title: e.title,
  notes: e.notes || "",
  // The rescue-hatch paste, back out to the planner that reads it — not a secret in
  // the sense that matters for that reader, since a lecturer pasting a link is trusted
  // with it anyway. But sEvent is ALSO what routes/myTimetable.js's GET /events sends
  // back, and that router is `requireAuth` only, no `requirePage` (see its own header:
  // "every lecturer reads their own timetable" is meant literally, deliberately not
  // gated the way admin pages are) — and its `type=all` scope (routes/myTimetable.js,
  // `if (type === "all")`) returns EVERY published event with no staff filter at all,
  // not only the caller's own teaching.
  //
  // So the TRUE fan-out is: a student's token cannot reach this at all — myTimetable.js
  // is absent from `STUDENT_ROUTERS` in auth.js, so a student token is refused before
  // any handler here runs — but ANY signed-in member of staff, teaching that class or
  // not, can read every published class's Teams join URL by asking for `type=all`. That
  // is a real widening from "the people already in the meeting", and it was WEIGHED,
  // not missed: narrowing myTimetable's `type=all` scope to the caller's own teaching
  // would break the deliberately broad staff-search behaviour documented on that route
  // (looking up a colleague's, a room's or a named student's week is meant to be
  // available to any member of staff, the same file's own comment says so at length),
  // for a leak whose blast radius is bounded on both sides: this router is staff-only
  // in the first place, and a Teams meeting enforces its own membership at the lobby
  // regardless of who is holding the join link — unlike a password or a token, a link
  // to a meeting the lobby will not admit you into is not itself the access. The same
  // link already sits in every organizer and co-organizer's Outlook calendar, which is
  // a wider readership than the staff list this API serves. Accepted deliberately, on
  // those two grounds, rather than re-scoped.
  teamsJoinUrl: e.teamsJoinUrl || "",
  published: !!e.published,
  changedAt: e.changedAt,

  unitId: e.unitId ?? null,
  unitCode: e.unit?.code ?? null,
  unitName: e.unit?.name ?? null,
  courseId: e.courseId ?? null,
  courseName: e.course?.name ?? null,
  roomId: e.roomId ?? null,
  room: e.room ? roomLabel(e.room) : null,
  // THE CAMPUS ON ITS OWN, beside the label that already embeds it.
  //
  // Not redundant: a reader deciding whether they can get to a class in ten minutes is
  // asking which SITE it is on, and that answer arrives buried in square brackets at the
  // end of "101 - First floor [Harrow]" — the least prominent position in the string.
  // Given separately, a screen can give it its own line and its own icon.
  //
  // Same precedence as roomLabel and for the same reason: the related campus wins so a
  // rename propagates, and the legacy free-text column is the fallback for rooms the
  // migration's fold could not place. Null rather than "" when there is no campus at
  // all, so a screen can leave the row out instead of printing an empty one.
  campus: e.room ? (e.room.campusRef?.name || e.room.campus || null) : null,
  // The two remaining halves of a location, separately, so a screen can order them the
  // way somebody walks to a class — site, then floor, then door — rather than being
  // stuck with roomLabel()'s "101 - First floor [Harrow]", which puts the room number
  // first and the building last. Both null when absent, never "".
  roomName: e.room?.name || null,
  roomFloor: e.room?.floor || null,
  categoryId: e.categoryId ?? null,
  category: e.category?.name ?? null,
  categoryColour: e.category?.colour ?? null,

  // The SCHOOL this class belongs to, as an id only.
  //
  // NULL IS A REAL ANSWER HERE and is passed through rather than coerced: on this model
  // a null academicDepartmentId means "belongs to no one school, shown to everyone",
  // which is the correct state for the workshops and study-support sessions the table
  // exists to hold. The schema says so at length, and academicScopeModels.js gives it
  // its own `columnOrNull` kind for it.
  //
  // No name and no colour, unlike category above. Those would cost a join on every
  // event in a date window, and the one screen that needs them — the planner — already
  // holds the whole school list from GET /timetabling/departments and can resolve the
  // id without the server repeating a name several hundred times per request.
  academicDepartmentId: e.academicDepartmentId ?? null,

  // Names only. A timetable needs to say who is teaching; it does not need their
  // email address, their site, or anything else on Staff.
  staff: (e.staff || []).map((x) => ({ id: x.staffId, name: x.staff?.name || "" })),
  groups: (e.groups || []).map((x) => ({ id: x.cohortId, name: x.cohort?.name || "" })),
});

/**
 * One row of the Events LIST — sEvent, plus the one field a list needs that a
 * calendar does not.
 *
 * A SPREAD OF sEvent, NOT A SECOND SHAPE. Everything the list prints — the date, the
 * times, the title, the module, the room label, the category and its colour, the school
 * id, the staff and the groups — is already assembled by sEvent for the grid, and a
 * hand-written second object carrying "most of the same fields" is the drift this
 * avoids: the day somebody teaches sEvent to print a room differently, the calendar and
 * the list would disagree about the same class, and nothing would say which was right.
 *
 * `seriesId` is the addition, and it is added HERE rather than in sEvent because sEvent
 * is shared with routes/myTimetable.js — the staff- and student-facing read. A grouping
 * id is of no use to a lecturer reading their own week, and widening a shape that four
 * other handlers already return is how a field nobody asked for ends up in a mobile
 * payload for ever. The list wants it because it is the only thing that says "these
 * forty rows are ONE thing you created", which is precisely the question a list of
 * everything is opened to answer.
 *
 * Null is passed through rather than coerced. A one-off class genuinely belongs to no
 * series, and "" would read as a series whose id happens to be blank — the screen has
 * to be able to tell a standalone class from a member of a term.
 */
const sEventRow = (e) => ({ ...sEvent(e), seriesId: e.seriesId ?? null });

/**
 * One TEACHING GROUP — a Cohort — as the Groups tab lists it.
 *
 * THE SCHOOL COMES FROM THE COURSE, AND THIS SERIALISER IS NOT ALLOWED TO FORGET IT.
 * Cohort.academicDepartmentId is a DENORMALISED copy of the course's department,
 * maintained by academicDepartments.assignCourses() — the one implementation of "move a
 * course and everything hanging off it". The id is therefore read from the cohort's own
 * column (it is kept in step, and reading it is a single hop the scope guard can also
 * use), while the NAME is read from the joined row, because a name is what drifts: a
 * school renamed on Settings must not still print its old name here.
 *
 * `schoolName` is deliberately NOT derived from `course.academicDepartment`. Reading the
 * course's department for the name and the cohort's column for the id would be two
 * sources of truth in one object, and the day the denormalisation drifts the screen would
 * show a group filed under one school and labelled with another — the failure mode the
 * column's own schema comment warns about, rendered.
 *
 * NULL IS A REAL ANSWER for both halves. A group whose course has not been assigned to a
 * school belongs to none, which is a state an administrator has to be able to SEE in
 * order to fix; coercing it to "" or to a "General" label is the silent fail-open that
 * academicDepartments.js refuses to ship a default for.
 *
 * `studentCount` is a count and a count only. The Groups tab needs to know a group has
 * eleven people in it before offering to delete it; it does not need their names, and a
 * list of students is a directory this endpoint has no business serving.
 */
const sGroup = (c) => ({
  id: c.id,
  name: c.name,
  courseId: c.courseId,
  courseName: c.course?.name ?? null,
  academicDepartmentId: c.academicDepartmentId ?? null,
  schoolName: c.academicDepartment?.name ?? null,
  // `_count` is absent when the caller forgot to ask for it, and 0 would then be a lie
  // about an intake of thirty people — the number the delete guard is read off. Null
  // says "not counted" in the house convention, and the screen can tell the difference.
  studentCount: c._count?.students ?? null,
});

/**
 * One row in the group form's COURSE picker.
 *
 * Three fields, and the third is why this is not sCourse from serializers.js. That
 * serialiser carries colour, the Moodle id, the VLE category it was imported from and
 * the unit/cohort counts — everything the Courses screen needs and nothing a dropdown
 * does. `academicDepartmentId` is here because the form filters by school on the client
 * as well as on the server, so a picker that has already loaded every course can narrow
 * itself without a second round trip when the school selection changes.
 */
const sCourseOption = (c) => ({
  id: c.id,
  name: c.name,
  academicDepartmentId: c.academicDepartmentId ?? null,
});

/**
 * One row in the "select timetables" picker, reduced to what a picker needs.
 *
 * A LABEL AND AN ID, AND NOTHING ELSE. This endpoint searches students and staff by
 * name, so anything extra returned here is a directory that every signed-in member
 * of staff can page through.
 */
function sResource(type, row) {
  switch (type) {
    case "room":    return { id: row.id, label: roomLabel(row), sub: row.kind || "" };
    case "staff":   return { id: row.id, label: row.name, sub: row.dept || "" };
    // Student has no `name` column — it is firstName + lastName + studentRef. The
    // REFERENCE is the label and the name is the subtitle, which is also how the
    // source system's picker reads ("FE00015", "FE00169"): a reference is unique and
    // a name is not, and a picker whose first line repeats for two people is a trap.
    case "student": return { id: row.id, label: row.studentRef || "", sub: `${row.firstName || ""} ${row.lastName || ""}`.trim() };
    case "group":   return { id: row.id, label: row.name, sub: row.course?.name || "" };
    case "module":  return { id: row.id, label: row.name, sub: row.code || "" };
    default:        return { id: row.id, label: String(row.name || row.id), sub: "" };
  }
}

module.exports = { sRoom, sCampus, sCategory, sEvent, sEventRow, sGroup, sCourseOption, sResource, roomLabel };
