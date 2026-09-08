// Turning a published timetable event into attendance registers.
//
// The decisions live in registerRules.js and roster.js, which have no database and are
// tested without one. This file only APPLIES them, and the split is deliberate: the
// freeze rule is the one somebody will later be tempted to "fix" while building a
// screen, and a rule buried in a route handler is a rule nobody can test in isolation.
//
// ONE REGISTER PER GROUP, NOT PER EVENT. A merged class is two intakes sharing a room,
// a time and a lecturer; they do not share a mark sheet. An event with no groups gets a
// single register with a null cohortId, which HndSession_event_group_key permits
// exactly once through its COALESCE — see the comment on HndSession in schema.prisma.
const prisma = require("../db");
const { deriveRoster } = require("./roster");
const { registerAction } = require("./registerRules");

/**
 * Build or update the registers for one event.
 *
 * Never throws for an ordinary refusal — a draft event, a workshop with no module, a
 * register that has already been marked are all NORMAL and are reported in the return
 * value. The caller puts them on screen. Raising would turn "this workshop has no
 * register, as expected" into a failed publish.
 *
 * @param {string} eventId
 * @returns {Promise<{ created: number, updated: number, frozen: Array<{sessionId: string, reason: string}>, skipped: Array<{reason: string}> }>}
 */
async function syncEventRegisters(eventId) {
  const out = { created: 0, updated: 0, frozen: [], skipped: [] };

  const event = await prisma.timetableEvent.findUnique({
    where: { id: eventId },
    include: { groups: { select: { cohortId: true } } },
  });
  if (!event) {
    out.skipped.push({ reason: "No such event." });
    return out;
  }

  const shape = {
    date: event.date,
    startTime: event.startTime,
    endTime: event.endTime,
    roomId: event.roomId ?? null,
  };

  // The event-level gate: published, wanted, and attached to a module. Asked once with
  // existing:null, because none of those three answers can differ between groups, and
  // asking per group would report the same refusal once per intake.
  const gate = registerAction({
    published: event.published,
    createRegisters: event.createRegisters,
    unitId: event.unitId,
    existing: null,
    event: shape,
  });
  if (gate.action === "skip") {
    out.skipped.push({ reason: gate.reason });
    return out;
  }

  // ONE PROBE FOR THE WHOLE UNIT, HOISTED OUT OF THE LOOP AND UNFILTERED BY STUDENT.
  //
  // "Does this module have any enrolments at all" is a question about the MODULE. Asked
  // inside the loop it silently becomes "did anyone in THIS group enrol", which is a
  // different question with the same shape: a group whose students genuinely do not
  // take this module would read as missing data and get the whole cohort put on its
  // register. roster.js carries the long form of this; CLAUDE.md records that the same
  // mistake has been made three times in the prediction code.
  const unitHasEnrolments = (await prisma.enrolment.count({ where: { unitId: event.unitId } })) > 0;

  // Enrolments are a property of the unit, so they are read once too rather than once
  // per group.
  const enrolled = await prisma.enrolment.findMany({
    where: { unitId: event.unitId },
    select: { studentId: true },
  });
  const enrolledIds = enrolled.map((e) => e.studentId);

  // No groups means one register for the event itself. `[null]` rather than `[]` so the
  // loop below runs once instead of not at all.
  const cohortIds = event.groups.length ? event.groups.map((g) => g.cohortId) : [null];

  for (const cohortId of cohortIds) {
    const existing = await prisma.hndSession.findFirst({
      where: { timetableEventId: event.id, cohortId },
      select: {
        id: true, date: true, startTime: true, endTime: true, roomId: true,
        _count: { select: { marks: true } },
      },
    });

    const decision = registerAction({
      published: event.published,
      createRegisters: event.createRegisters,
      unitId: event.unitId,
      existing: existing ? { ...existing, hasMarks: existing._count.marks > 0 } : null,
      event: shape,
    });

    if (decision.action === "freeze") {
      // Reported, not raised. The event edit itself is legitimate and has already been
      // saved; what the administrator needs is to be told the register did not follow.
      out.frozen.push({ sessionId: existing.id, reason: decision.reason });
      continue;
    }
    if (decision.action === "skip") {
      if (decision.reason) out.skipped.push({ reason: decision.reason });
      continue;
    }
    if (decision.action === "update") {
      await prisma.hndSession.update({ where: { id: existing.id }, data: shape });
      out.updated++;
      continue;
    }

    // create
    const cohortStudents = cohortId
      ? await prisma.student.findMany({ where: { cohortId }, select: { id: true } })
      : [];

    const roster = cohortId
      ? deriveRoster({
          cohortStudentIds: cohortStudents.map((s) => s.id),
          enrolledStudentIds: enrolledIds,
          unitHasEnrolments,
        })
      // No group: the module's enrolment IS the roster, and there is no cohort to
      // intersect with. Reported as the enrolment rule because that is what it is.
      : { studentIds: enrolledIds, rule: "cohort-and-enrolment" };

    await prisma.hndSession.create({
      data: {
        unitId: event.unitId,
        timetableEventId: event.id,
        cohortId,
        ...shape,
        description: event.title || "",
        // Which rule produced the roster, in the field a lecturer already reads. The
        // two empty registers mean opposite things — "nobody in this group takes this
        // module" versus "we do not know who does" — and without this they look
        // identical on screen.
        audience: roster.rule === "cohort-only"
          ? "All students in the group (no enrolment data for this module)"
          : "Students enrolled on this module",
      },
    });
    out.created++;

    // NO MARKS ARE WRITTEN HERE, DELIBERATELY.
    //
    // A register starts empty. A student who has not checked in is UNMEASURED, not
    // absent, and pre-seeding an A would make "did not attend" indistinguishable from
    // "nobody has taken this register yet" — while also putting a permanent academic
    // record against every student in the college the moment a term is published.
    // Turning blanks into absences is the existing explicit close-off action, taken by
    // a person after the class has happened.
  }

  return out;
}

/**
 * Who belongs on ONE register, applying the same rule that built it.
 *
 * THE BUG THIS EXISTS TO CLOSE. syncEventRegisters decided a roster and then threw it
 * away, keeping only a sentence — "All students in the group (no enrolment data for this
 * module)" — in `audience`. The register screen meanwhile listed students from Enrolment
 * alone and never looked at cohortId. So a class scheduled for a group whose module has
 * no enrolments produced a register that said, on its own face, that it held the whole
 * group, and then showed nobody. Both halves were individually defensible and together
 * they were a register nobody could take.
 *
 * The rule itself stays in roster.js, which has no database and is tested without one.
 * This only supplies it with rows, so the listing endpoint, the saving endpoint and the
 * builder cannot drift apart into three answers to one question.
 *
 * A session with NO cohort is unchanged: the module's enrolment is the roster, which is
 * what every register generated from a unit rather than from the timetable relies on.
 *
 * @returns {Promise<{ studentIds: string[], rule: "cohort-and-enrolment" | "cohort-only" }>}
 */
async function rosterForSession(session) {
  const enrolled = await prisma.enrolment.findMany({
    where: { unitId: session.unitId },
    select: { studentId: true },
  });
  const enrolledIds = enrolled.map((e) => e.studentId);
  if (!session.cohortId) return { studentIds: enrolledIds, rule: "cohort-and-enrolment" };

  const cohortStudents = await prisma.student.findMany({
    where: { cohortId: session.cohortId },
    select: { id: true },
  });
  return deriveRoster({
    cohortStudentIds: cohortStudents.map((s) => s.id),
    enrolledStudentIds: enrolledIds,
    // A question about the UNIT, asked unfiltered by student — the same hoisted probe
    // syncEventRegisters uses, and for the same reason. Narrowing it to this group turns
    // "this module records no enrolments" into "nobody in this group enrolled", which
    // are different facts with the same shape.
    unitHasEnrolments: enrolledIds.length > 0,
  });
}

module.exports = { syncEventRegisters, rosterForSession };
