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
const { deriveRoster, deriveUnitRoster, enrolmentIsAuthoritativeFor } = require("./roster");
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
    include: {
      groups: { select: { cohortId: true } },
      // The two Moodle ids only, and only so deriveRoster can be told whether this
      // module's enrolment list was ENUMERATED or assembled one student at a time. Read
      // here rather than per group for the same reason the enrolment probe below is:
      // it is a property of the unit and cannot differ between intakes.
      unit: { select: { moodleSectionId: true, moodleCourseId: true } },
    },
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

  // Can this module's enrolment list be read for its SILENCES? A property of the unit,
  // and deliberately NOT of the enrolment count — a count crossing zero is the cliff
  // roster.js documents, where one new Enrolment row turned a twenty-five student
  // register into a one-student one.
  const enrolmentIsAuthoritative = enrolmentIsAuthoritativeFor(event.unit);

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
          enrolmentIsAuthoritative,
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
        //
        // THREE SENTENCES SINCE 11 SEP 2026, because there are three rules. The middle
        // one is the new branch: the module HAS enrolments, and they were not written by
        // anything that enumerates a whole class, so their gaps are not being read as
        // answers. Saying "no enrolment data" there would be a false statement about a
        // module that has some, and a lecturer chasing why a name is missing would go
        // looking in the wrong place.
        audience: roster.rule === "cohort-only"
          ? "All students in the group (no enrolment data for this module)"
          : roster.rule === "cohort-over-partial-enrolment"
            ? "All students in the group (this module's enrolment list is not a full class list)"
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
 * THE UNIT IS READ, NOT JUST ITS ENROLMENTS (11 Sep 2026), because deriveRoster now needs
 * to be told whether this module's enrolment list was ENUMERATED. Callers that already
 * loaded the unit hand it over and pay nothing; the rest cost one extra indexed lookup by
 * primary key, and only on a session that HAS a cohort. That was accepted rather than
 * making every caller remember to include it: six handlers ask this question, and the one
 * that forgot would silently get the safe-but-wider answer with nothing to notice it by.
 *
 * @returns {Promise<{ studentIds: string[], rule: "cohort-and-enrolment" | "cohort-only" | "cohort-over-partial-enrolment" }>}
 */
async function rosterForSession(session) {
  const enrolled = await prisma.enrolment.findMany({
    where: { unitId: session.unitId },
    select: { studentId: true },
  });
  const enrolledIds = enrolled.map((e) => e.studentId);
  if (!session.cohortId) return { studentIds: enrolledIds, rule: "cohort-and-enrolment" };

  // Reuse the unit the caller already loaded when it carries the two columns; GET
  // /register and GET /live both include it in full. `"moodleSectionId" in unit` rather
  // than a truthiness test, because null is a real value here and means "not from
  // Moodle", while an absent key means "this caller did not select it" — and those must
  // not be confused, or a partially-selected unit would read as a hand-created one.
  const unit = session.unit && "moodleSectionId" in session.unit
    ? session.unit
    : await prisma.unit.findUnique({
        where: { id: session.unitId },
        select: { moodleSectionId: true, moodleCourseId: true },
      });

  const cohortStudents = await prisma.student.findMany({
    where: { cohortId: session.cohortId },
    select: { id: true },
  });
  return deriveRoster({
    cohortStudentIds: cohortStudents.map((s) => s.id),
    enrolledStudentIds: enrolledIds,
    // Whether a cohort member's ABSENCE from that list is evidence. Off for a
    // hand-created module, so one stray enrolment cannot empty a register a lecturer is
    // standing in front of — roster.js carries the long form.
    enrolmentIsAuthoritative: enrolmentIsAuthoritativeFor(unit),
    // A question about the UNIT, asked unfiltered by student — the same hoisted probe
    // syncEventRegisters uses, and for the same reason. Narrowing it to this group turns
    // "this module records no enrolments" into "nobody in this group enrolled", which
    // are different facts with the same shape.
    unitHasEnrolments: enrolledIds.length > 0,
  });
}

/**
 * How many students each unit concerns, under the SAME rule its registers use.
 *
 * ONE PLACE, BECAUSE THERE WERE TWO CALLERS AND THERE WILL BE A THIRD. GET /hnd/units
 * and GET /hnd/attendance both emit `studentCount` on a unit, and both used to count
 * Enrolment rows — so both showed "0 students" for every hand-created module while the
 * register beside them listed the group. A rule copied into two route handlers is a rule
 * that drifts; this is the same reason rosterForSession exists above.
 *
 * FIVE QUERIES, NOT ONE PER UNIT. These endpoints return every unit in the college —
 * 87 on the test data, hundreds on a real install — so a per-unit roster lookup is an
 * N+1 that collapses at exactly the scale the screen is for. The shape here is the one
 * GET /hnd/units already uses for its enrolment and session counts: aggregate over the
 * whole table once, index it in Node, then read it per unit. The student query is the
 * only one issued second, and only so it can be narrowed to the cohorts that actually
 * reach a unit rather than pulling the college's whole roll.
 *
 * A unit ABSENT from the returned map has no enrolments, no scheduled group and no
 * register: it is the `unmeasurable` case and callers must read it as null, not 0.
 *
 * @returns {Promise<Map<string, number|null>>} unitId -> distinct student count, or null.
 */
async function unitStudentCounts() {
  const [enrolments, eventGroups, sessionGroups, units] = await Promise.all([
    prisma.enrolment.findMany({ select: { unitId: true, studentId: true } }),
    // A cohort reaches a unit through the timetable: TimetableEvent -> TimetableEventGroup.
    // DRAFT events count. A class scheduled against a group is the college saying those
    // students take this module, and a module whose timetable is still unpublished is
    // precisely the one most likely to have no enrolments either — reporting it as
    // unmeasurable while an administrator is looking at the group they just attached
    // would be the old bug wearing a different number.
    prisma.timetableEventGroup.findMany({
      where: { event: { unitId: { not: null } } },
      select: { cohortId: true, event: { select: { unitId: true } } },
    }),
    // And through the registers themselves, which is not the same set: a register
    // survives its event being deleted (HndSession.timetableEventId is SetNull), and the
    // students on it are still the ones this module concerns. A null cohortId here is
    // the ungrouped register deriveUnitRoster asks about.
    prisma.hndSession.groupBy({ by: ["unitId", "cohortId"] }),
    // Two columns off every unit, for the same question rosterForSession asks: was this
    // module's enrolment list enumerated. The card has to ask it or it disagrees with the
    // register the moment a hand-built module gains its first enrolment — the register
    // would list the group and the card would print "1 student", which is the original
    // "0 students beside a full register" bug back with a newer number.
    prisma.unit.findMany({ select: { id: true, moodleSectionId: true, moodleCourseId: true } }),
  ]);
  const unitById = new Map(units.map((u) => [u.id, u]));

  const enrolledByUnit = new Map();
  for (const e of enrolments) {
    if (!enrolledByUnit.has(e.unitId)) enrolledByUnit.set(e.unitId, []);
    enrolledByUnit.get(e.unitId).push(e.studentId);
  }

  const cohortsByUnit = new Map();
  const ungrouped = new Set();
  const addCohort = (unitId, cohortId) => {
    if (!unitId) return;
    if (!cohortsByUnit.has(unitId)) cohortsByUnit.set(unitId, new Set());
    cohortsByUnit.get(unitId).add(cohortId);
  };
  for (const g of eventGroups) addCohort(g.event?.unitId, g.cohortId);
  for (const s of sessionGroups) {
    if (s.cohortId) addCohort(s.unitId, s.cohortId);
    else ungrouped.add(s.unitId);
  }

  const cohortIds = [...new Set([...cohortsByUnit.values()].flatMap((set) => [...set]))];
  const students = cohortIds.length
    ? await prisma.student.findMany({ where: { cohortId: { in: cohortIds } }, select: { id: true, cohortId: true } })
    : [];
  const studentsByCohort = new Map();
  for (const s of students) {
    if (!studentsByCohort.has(s.cohortId)) studentsByCohort.set(s.cohortId, []);
    studentsByCohort.get(s.cohortId).push(s.id);
  }

  const out = new Map();
  for (const unitId of new Set([...enrolledByUnit.keys(), ...cohortsByUnit.keys(), ...ungrouped])) {
    const cohorts = cohortsByUnit.get(unitId);
    const roster = deriveUnitRoster({
      enrolledStudentIds: enrolledByUnit.get(unitId) || [],
      scheduledStudentIds: cohorts ? [...cohorts].flatMap((c) => studentsByCohort.get(c) || []) : [],
      // The question is whether a GROUP reaches the unit, not whether the students it
      // produced are any. A group nobody is in yet is an answer; no group is not.
      hasScheduledGroup: !!cohorts && cohorts.size > 0,
      hasUngroupedRegister: ungrouped.has(unitId),
      enrolmentIsAuthoritative: enrolmentIsAuthoritativeFor(unitById.get(unitId)),
    });
    out.set(unitId, roster.studentIds ? roster.studentIds.length : null);
  }
  return out;
}


/**
 * Where and to whom each unit is actually delivered — groups and campuses, per unit.
 *
 * A Unit row carries a code, a name and a course. It does NOT carry who is taught it or
 * where, because both are properties of the TIMETABLE: the same module runs for SEP 25 at
 * Harrow on Tuesday and for JAN 26 at Ealing on Thursday. The card that lists units had
 * nothing to say about either, so a college with six modules called "UNIT 1" showed six
 * identical cards.
 *
 * BOTH SOURCES, for the same reason unitStudentCounts reads both: a cohort reaches a unit
 * through a timetabled event, and separately through a register that outlived its event
 * (HndSession.timetableEventId is SetNull, so deleting a class leaves its register and
 * its group behind). Reading only events would lose a term somebody has since tidied up.
 *
 * DRAFT EVENTS COUNT. A class scheduled against a group is the college saying those
 * students take this module, whether or not the timetable has been published yet — and an
 * unpublished term is exactly when somebody is looking at this screen to check their work.
 *
 * Names are RESOLVED IN BULK and returned sorted, so two callers cannot disagree about
 * the order and a screen can print the first two and a "+2 more" without sorting again.
 *
 * @returns {Promise<Map<string, { cohorts: string[], campuses: string[] }>>}
 */
async function unitTeachingContext() {
  const [events, sessions] = await Promise.all([
    prisma.timetableEvent.findMany({
      where: { unitId: { not: null } },
      select: {
        unitId: true,
        groups: { select: { cohortId: true } },
        // The campus, through the room. Same precedence as roomLabel(): the related
        // Campus wins so a rename propagates, and the legacy free-text column is the
        // fallback for rooms the migration's fold could not place.
        room: { select: { campus: true, campusRef: { select: { name: true } } } },
      },
    }),
    prisma.hndSession.findMany({
      where: { cohortId: { not: null } },
      select: { unitId: true, cohortId: true },
    }),
  ]);

  const cohortsByUnit = new Map();
  const campusesByUnit = new Map();
  const add = (map, unitId, value) => {
    if (!unitId || !value) return;
    if (!map.has(unitId)) map.set(unitId, new Set());
    map.get(unitId).add(value);
  };
  for (const e of events) {
    for (const g of e.groups) add(cohortsByUnit, e.unitId, g.cohortId);
    add(campusesByUnit, e.unitId, e.room?.campusRef?.name || e.room?.campus || null);
  }
  for (const s of sessions) add(cohortsByUnit, s.unitId, s.cohortId);

  const cohortIds = [...new Set([...cohortsByUnit.values()].flatMap((set) => [...set]))];
  const cohorts = cohortIds.length
    ? await prisma.cohort.findMany({ where: { id: { in: cohortIds } }, select: { id: true, name: true } })
    : [];
  const nameOf = new Map(cohorts.map((c) => [c.id, c.name]));

  const out = new Map();
  for (const unitId of new Set([...cohortsByUnit.keys(), ...campusesByUnit.keys()])) {
    out.set(unitId, {
      cohorts: [...(cohortsByUnit.get(unitId) || [])].map((id) => nameOf.get(id)).filter(Boolean).sort((a, b) => a.localeCompare(b)),
      campuses: [...(campusesByUnit.get(unitId) || [])].sort((a, b) => a.localeCompare(b)),
    });
  }
  return out;
}

module.exports = { syncEventRegisters, rosterForSession, unitStudentCounts, unitTeachingContext };
