// Which campuses could a check-in legitimately be at?
//
// ONE PLACE, because two routers need it: the student's three check-in methods and the
// staff clock-in. It lived privately inside routes/student.js until the staff routes
// needed the same answer, and it was LIFTED rather than copied for the reason this
// codebase has already paid for once — six handlers independently grew an answer to "who
// is on this register", disagreed with the roster rule, and were fixed six separate
// times. One of them marked students ABSENT, so the wrong answer wrote wrong data rather
// than merely showing it.
//
// The two callers ask different questions of it and that is the point of the argument:
// a student's check-in is for a class, which may have a room, which is on a campus. A
// staff clock-in is for a day, not a class, so it passes null and gets every located
// campus — which is the honest question anyway ("is this person at the college").
// PLAIN require, matching every other caller of db.js (`const prisma = require("./db")`)
// rather than destructuring `{ prisma }` out of it. `db.js` exports the client itself
// (`module.exports = prisma`) and ALSO sets `.prisma` on that same export as a second,
// self-referential handle (`module.exports.prisma = prisma`) — which is why `{ prisma }`
// destructures cleanly against the real module and reads as an equally valid style. It is
// the only file in the codebase written that way, though, and it cost something concrete:
// two test files stub db.js through `require.cache` with a bare fake object that carries
// no `.prisma` property, which is how every other module using db.js gets stubbed —
// `const { prisma } = require("./db")` against that stub destructures `undefined` instead.
// Written the majority way, this module can be stubbed the same way its neighbours can.
const prisma = require("./db");

/**
 * The campuses a check-in could legitimately be at.
 *
 * A class held in a room is at that room's campus, and that is the tightest answer
 * available. When there is no room, or the room predates campuses, or the caller has no
 * class at all, EVERY located campus is returned instead — because "which campus" is
 * frequently unknowable and refusing all of those would make the geofence unusable at
 * exactly the colleges that want it. What it still refuses is a phone at none of them,
 * which is what the college asked for.
 *
 * Only called when a geofence is switched on: this is up to two queries on the check-in
 * path, and a college that has not opted in should not pay for them.
 */
async function campusesFor(sessionId) {
  if (sessionId) {
    // Reached from the id rather than a loaded row, because the check runs BEFORE each
    // route resolves its session — and it has to. A student off the college network must
    // be told that, not handed "tag not recognised" or "wrong code" from a check they were
    // never going to get past. One query, and only when the geofence is switched on.
    const room = await prisma.hndSession.findUnique({
      where: { id: sessionId },
      select: { room: { select: { campusRef: { select: { latitude: true, longitude: true } } } } },
    }).then((s) => s?.room).catch(() => null);
    // Only when it actually has coordinates. A room on an unlocated campus falls through
    // to the college-wide list rather than refusing — the class is somewhere, and the
    // college's other campuses are a better guess than none. If NOTHING is located, the
    // list comes back empty and presence.js refuses under `campus_not_located`, which is
    // the loud failure a misconfiguration deserves.
    if (room?.campusRef?.latitude != null && room?.campusRef?.longitude != null) return [room.campusRef];
  }
  return prisma.campus.findMany({
    where: { active: true, latitude: { not: null }, longitude: { not: null } },
    select: { latitude: true, longitude: true },
  });
}

module.exports = { campusesFor };
