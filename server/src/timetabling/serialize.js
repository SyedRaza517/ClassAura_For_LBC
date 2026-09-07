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

const sCampus = (c) => ({ id: c.id, name: c.name, active: !!c.active });

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
  published: !!e.published,
  changedAt: e.changedAt,

  unitId: e.unitId ?? null,
  unitCode: e.unit?.code ?? null,
  unitName: e.unit?.name ?? null,
  courseId: e.courseId ?? null,
  courseName: e.course?.name ?? null,
  roomId: e.roomId ?? null,
  room: e.room ? roomLabel(e.room) : null,
  categoryId: e.categoryId ?? null,
  category: e.category?.name ?? null,
  categoryColour: e.category?.colour ?? null,

  // Names only. A timetable needs to say who is teaching; it does not need their
  // email address, their site, or anything else on Staff.
  staff: (e.staff || []).map((x) => ({ id: x.staffId, name: x.staff?.name || "" })),
  groups: (e.groups || []).map((x) => ({ id: x.cohortId, name: x.cohort?.name || "" })),
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

module.exports = { sRoom, sCampus, sCategory, sEvent, sResource, roomLabel };
