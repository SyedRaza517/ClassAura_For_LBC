// A short-lived, in-process cache for ONE response shape: the college-wide,
// unscoped attendance matrix (GET /api/hnd/attendance with no semesterId and no
// termId, asked for by a college-wide caller).
//
// WHY THIS EXISTS. That matrix is the single heaviest read in the API — every
// student × every unit, plus two raw aggregates over the whole AttendanceMark
// table — and the admin dashboard refetches it on every tab focus. Every one of
// those refetches recomputed identical figures from scratch. The suggestions feed
// (routes/suggestions.js) already answers the same problem the same way: its
// admin aggregates sweep whole tables, so they are computed once per TTL and
// served to everyone. This module is that precedent applied to the matrix.
//
// WHY ONLY THE COLLEGE-WIDE, UNSCOPED FORM IS CACHED. The response is not a
// function of the URL alone: a department-scoped caller gets different rows from
// the same request (academicScopeSql appends a predicate per caller), and a
// semester/term scope changes every figure. One cache slot keyed on "the whole
// college, all time" can never serve a scoped caller a wider answer or a
// narrower one — every other shape bypasses the cache entirely and is computed
// fresh, exactly as before. Widening this to a keyed map would mean reasoning
// about scoped answers living in shared state, and the memory of N cached
// matrices; the unscoped form is the one every admin's store fetches by default,
// so it is where virtually all of the repetition is.
//
// THE FIGURES ARE NEVER CHANGED, ONLY REUSED. A cache hit is byte-for-byte the
// response an identical request computed moments earlier — the null-vs-zero rule
// (null = not measurable) passes through untouched because nothing here looks
// inside the value. Staleness is the only trade, and it is bounded twice over:
// by the TTL below, and by invalidate(), which every path that writes an
// attendance mark calls (the register save and close-off in routes/hnd.js, the
// student tap/QR/declared check-ins in routes/student.js, the Moodle import and
// the Teams sync). Structural edits that move figures without touching a mark —
// enrolments, sessions, students, timetable groups — are caught by the
// invalidateOnWrite middleware mounted on the hnd and timetabling routers, which
// drops the slot after any successful mutation through either router.
//
// In-process and module-level, correct for ONE Node process; a clustered
// deployment needs Redis. Same caveat as every cache and limiter in this
// codebase.
const TTL_MS = Number(process.env.ATTENDANCE_MATRIX_CACHE_MS ?? 30_000);

let cached = null; // { value, at } | null

/** The cached matrix, or null when there is none, it has expired, or the cache is off. */
function get() {
  if (TTL_MS > 0 && cached && Date.now() - cached.at < TTL_MS) return cached.value;
  return null;
}

/** Store a freshly computed matrix. A no-op when the cache is disabled (TTL 0). */
function set(value) {
  if (TTL_MS > 0) cached = { value, at: Date.now() };
}

/** Drop the slot — called by every write that can move an attendance figure. */
function invalidate() {
  cached = null;
}

/**
 * Router-level middleware: drop the cache after any successful mutation.
 *
 * Mounted on the routers whose writes can move a matrix figure WITHOUT writing a
 * mark — enrolment replacement, session create/delete, student edits, timetable
 * group changes. Listing those handlers one by one is how a cache goes stale the
 * day somebody adds handler N+1, so the invalidation keys on the only thing all
 * mutations share: a non-GET method that did not fail.
 *
 * "finish", not immediately: invalidating BEFORE the write completes leaves a
 * window where a concurrent read recomputes from pre-write data and re-caches it,
 * serving the old figures for a whole TTL after the write — precisely the bug
 * invalidation exists to prevent. Only 2xx/3xx count; a refused write changed
 * nothing, so it must not cost the college a recompute.
 */
function invalidateOnWrite(req, res, next) {
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    res.on("finish", () => {
      if (res.statusCode < 400) invalidate();
    });
  }
  next();
}

module.exports = { get, set, invalidate, invalidateOnWrite, TTL_MS };
