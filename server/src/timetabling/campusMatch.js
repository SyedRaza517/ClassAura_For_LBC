// Matching the free-text campus strings on Room into a managed list.
//
// Room.campus is a plain string, so "Ealing", "ealing" and "Ealing Campus" are three
// campuses to any filter built on it — and the register dashboard filters by campus.
// This is what the migration uses to fold the spellings into rows.
//
// EXACT AND CASE-INSENSITIVE ONLY, DELIBERATELY. A fuzzy match that decides "Ealing"
// and "Ealing Annexe" are the same place merges two campuses inside a filter a head of
// department will later count students with, and the merge is invisible in the data
// afterwards — there is nothing left saying it happened. Anything this cannot group
// stays its own campus and a human decides. Under-merging is a tidy-up; over-merging
// is a wrong number nobody can trace.
//
// Whitespace IS normalised, because "Ealing  Campus" and "Ealing Campus" differ by a
// typing accident rather than by meaning, and no college has two campuses separated
// only by a double space.

/** Lower-cased, trimmed, internal runs of whitespace collapsed to one. */
const normaliseCampus = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Group spellings of the same campus.
 *
 * Returns [{ canonical, variants }]. The canonical form is the most common spelling,
 * ties broken alphabetically — the tie-break is not cosmetic: without it two runs over
 * the same rows can disagree about which spelling wins, and a migration whose output
 * depends on row order is one nobody can verify by re-running it.
 */
function groupCampuses(names) {
  const byKey = new Map();
  for (const raw of names) {
    const key = normaliseCampus(raw);
    // No campus recorded is not a campus called "". A room whose campus was never
    // filled in must end up with a null campusId, not a membership of an empty one.
    if (!key) continue;
    const counts = byKey.get(key) || new Map();
    const spelling = String(raw).trim().replace(/\s+/g, " ");
    counts.set(spelling, (counts.get(spelling) || 0) + 1);
    byKey.set(key, counts);
  }

  return [...byKey.values()]
    .map((counts) => {
      const variants = [...counts.keys()].sort();
      // Most common spelling wins. On a tie, the CAPITALISED one — `caseFirst: "upper"`
      // rather than a plain localeCompare, which puts lowercase first and would elect
      // "ealing" over "Ealing" whenever a college had written each once. A campus name
      // is a proper noun on a dropdown, and "ealing" there reads as a fault.
      const canonical = variants
        .slice()
        .sort((a, b) =>
          counts.get(b) - counts.get(a) ||
          a.localeCompare(b, undefined, { caseFirst: "upper" }))[0];
      return { canonical, variants };
    })
    // SORTED OUTPUT, not Map insertion order. Without this the result follows the
    // order the rows arrived in, so the same table read twice — by a re-run, or by a
    // query the planner chose to order differently — produces the same campuses in a
    // different sequence. A migration whose output depends on row order cannot be
    // verified by running it again, which is the only check anybody actually performs.
    .sort((a, b) => a.canonical.localeCompare(b.canonical));
}

module.exports = { normaliseCampus, groupCampuses };
