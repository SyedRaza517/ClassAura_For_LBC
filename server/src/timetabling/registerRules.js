// What publishing or editing a timetable event should do to its register.
//
// PURE ON PURPOSE. This is the rule set most likely to be widened later by somebody
// building a screen — "why does my room change not save?" has an obvious-looking fix
// that is the bug this module exists to prevent — and a rule that lives inside a route
// handler is a rule nobody can test in isolation or find when they go looking for it.
//
// The applier is registers.js. It does the database work and asks this file what the
// work should be.

// The fields a register copies from its event, and therefore the fields whose
// disagreement means the two have diverged. Room is in the list deliberately: a class
// relocated after the register was taken is exactly what a lecturer needs telling
// about, and comparing times alone would stay silent about it.
const FIELDS = ["date", "startTime", "endTime", "roomId"];

// `?? null` on BOTH sides, so a select that omitted roomId reads as null rather than
// as undefined — otherwise `undefined !== null` reports every register in the college
// as diverged the first time somebody trims a query.
const matches = (existing, event) => FIELDS.every((f) => (existing[f] ?? null) === (event[f] ?? null));

/**
 * @param {object} args
 * @param {boolean} args.published        Is the event published.
 * @param {boolean} args.createRegisters  Did the administrator ask for registers.
 * @param {string|null} args.unitId       The event's module, or null.
 * @param {object|null} args.existing     null, or { id, hasMarks, date, startTime, endTime, roomId }.
 * @param {object} args.event             { date, startTime, endTime, roomId }.
 * @returns {{ action: "create"|"update"|"skip"|"freeze", reason: string }}
 */
function registerAction({ published, createRegisters, unitId, existing, event }) {
  if (!unitId) {
    // HndSession.unitId is NOT NULL while TimetableEvent.unitId is nullable ON PURPOSE
    // — an exam, a workshop, study support or a staff meeting belongs to no module,
    // and being able to hold those is the reason TimetableEvent exists as its own
    // table. They structurally cannot have registers, and the screen must SAY so
    // rather than skip in silence, or an administrator spends an afternoon wondering
    // which setting is wrong.
    //
    // Checked FIRST, ahead of the draft check, because it is the permanent answer.
    // Telling somebody a workshop is "still a draft" implies that publishing it would
    // produce a register, which it never will.
    return { action: "skip", reason: "No register — not a taught session." };
  }
  if (!published) return { action: "skip", reason: "Draft events do not create registers." };
  if (!createRegisters) return { action: "skip", reason: "Register creation is switched off for this class." };

  if (!existing) return { action: "create", reason: "" };

  // Nothing to do, and this branch must come BEFORE the marks check. A term republished
  // unchanged would otherwise report every taken register in the college as diverged,
  // and a warning that fires on everything is one nobody reads.
  if (matches(existing, event)) return { action: "skip", reason: "" };

  if (existing.hasMarks) {
    // FROZEN, NOT FOLLOWED.
    //
    // Attendance is the record this college is asked to evidence most often — funding,
    // visa compliance, a student disputing a mark. A design in which editing a calendar
    // entry silently rewrites a register that has already been taken is one that
    // eventually loses a dispute, and loses it invisibly: nothing afterwards records
    // that the times were ever different.
    //
    // So the register stops following, and the divergence is REPORTED. Louder than
    // following it, and far louder than hiding it. The caller surfaces this on the
    // event; it is not an error and must not be raised as one.
    return {
      action: "freeze",
      reason: "This register has already been taken — its times no longer match the timetable.",
    };
  }

  return { action: "update", reason: "" };
}

module.exports = { registerAction, FIELDS };
