// A short-TTL, in-process cache for the identity row requireAuth loads on EVERY request.
//
// WHY THIS EXISTS. requireAuth resolves the caller (staff / student / applicant) with
// one uncached Prisma read per request. The database is cross-region from the API, so
// that read costs ~10-25ms and a connection from the pool — on every single call. The
// client fires ~20 requests at once after sign-in, which meant twenty identical reads
// of the same row racing each other before the first one had even answered. Caching
// the row for a few seconds, and coalescing concurrent misses onto ONE read, turns
// that burst into a single round trip.
//
// WHY IN-PROCESS IS CORRECT HERE, not Redis: this platform is sold as one deployment
// per college — one server, one Node process, one database (see CLAUDE.md and
// .claude/rules/single-tenant-history.md). Every rate limiter and lock in this codebase
// is already a module-level Map for the same reason, each saying so in a comment; this
// follows that convention. A clustered deployment would need a shared store for this
// exactly as it would for those.
//
// CORRECTNESS OVER SPEED — the two rules that make a security cache tolerable:
//
//   1. EVERY route in this process that mutates a row's auth-relevant state
//      (password change/reset, tokenVersion bump, role or page grants, department
//      membership, activation, suspension, deletion) calls invalidate() the moment
//      the write commits. Because there is only one process, that restores exact
//      pre-cache immediacy for every mutation that goes through the API: a reset
//      password kills the old session on the very next request, not TTL later.
//      auth.js additionally re-reads once whenever a CACHED row is about to cause a
//      rejection, so a missed invalidation can wrongly deny for at most one extra
//      database read — never wrongly allow a fresh token to fail.
//
//   2. What in-process invalidation cannot see is a write this process never made:
//      a direct edit in the Supabase console, a psql session, a fixture script with
//      its own Prisma client. Those are honoured up to TTL late — seconds, bounded
//      by AUTH_CACHE_TTL_MS. That tradeoff is accepted deliberately: the TTL is
//      shorter than the time it takes to type the next query into a console, and the
//      pre-cache behaviour was already racy for such edits within a request burst —
//      twenty in-flight requests all read the row before the edit landed and served
//      answers computed from the old one. The window existed; it is now bounded and
//      written down instead of accidental. The smoke suites are exactly this case
//      (their own Prisma client mutates rows and expects the API to notice), which
//      is why the TTL defaults to 0 under NODE_ENV=test — the same ruling the test
//      harness already applies to the settings cache via ATTENDANCE_TAP_CACHE_MS=0,
//      made here on the server side because the cached thing is the caller's
//      identity and the suites that probe it must keep meaning what they say.
//
// WHAT IS CACHED: exactly what the lookup returned — the raw Prisma row (for staff,
// including the academicDepartments membership include that scoping needs). Raw rows
// hold passwordHash and totpSecret; they never leave the process except through the
// allowlist serializers, same as before, and every consumer must treat a cached row
// as IMMUTABLE — it is shared by every request that hits it. Note that routes which
// verify a password or a TOTP code all re-read the row through their own Prisma call
// already; the cache sits only under requireAuth's identity resolution.
//
// NEVER CACHED: null. A miss on a deleted or unknown account must behave exactly as
// it always has (a fresh read answering "no such row"), and a cached absence would
// pin "no account" over a row created milliseconds later by invite-accept or
// applicant registration.
//
// BOUNDED: at most maxEntries live entries — one per active user, so the default of
// 5000 covers a large college outright. Eviction is lazy (no timers to leak): dead
// entries are dropped when read, and when the cap is hit the expired are swept first,
// then the oldest WRITE goes. Oldest-write rather than true LRU is deliberate — with
// a 30s TTL an entry's remaining life is decided by its write time, so tracking reads
// would buy nothing and cost a Map re-insertion on every request.

// TTL resolution, exported for its tests. Explicit env always wins — including an
// explicit 0, the kill switch. Otherwise: 0 under NODE_ENV=test (see the long note
// above), 30 seconds everywhere else. Junk falls back to the default for the
// environment rather than poisoning every comparison with NaN.
const DEFAULT_TTL_MS = 30_000;
function resolveTtlMs(env = process.env) {
  const fallback = env.NODE_ENV === "test" ? 0 : DEFAULT_TTL_MS;
  if (env.AUTH_CACHE_TTL_MS == null || env.AUTH_CACHE_TTL_MS === "") return fallback;
  const n = Number(env.AUTH_CACHE_TTL_MS);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Cap resolution. 0 is rejected on purpose: "no entries allowed" is a disabled cache
// spelt confusingly — AUTH_CACHE_TTL_MS=0 is the real switch, and it also turns off
// the load coalescing, which a zero cap would silently leave running.
const DEFAULT_MAX_ENTRIES = 5000;
function resolveMaxEntries(env = process.env) {
  const n = Number(env.AUTH_CACHE_MAX);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MAX_ENTRIES;
}

// `now` is injectable so the tests can move time instead of sleeping through it.
function createIdentityCache({ ttlMs = resolveTtlMs(), maxEntries = resolveMaxEntries(), now = Date.now } = {}) {
  const enabled = ttlMs > 0;
  const store = new Map();    // "kind:id" -> { value, expiresAt }
  const inFlight = new Map(); // "kind:id" -> the one shared loader Promise

  const keyOf = (kind, id) => `${kind}:${id}`;

  function get(kind, id) {
    if (!enabled) return undefined;
    const key = keyOf(kind, id);
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) { store.delete(key); return undefined; }
    return entry.value;
  }

  function set(kind, id, value) {
    if (!enabled || value == null) return;
    const key = keyOf(kind, id);
    // Delete-then-set so a rewrite moves to the back of the insertion order — the
    // eviction below walks that order, and a row just refreshed is the wrong victim.
    store.delete(key);
    if (store.size >= maxEntries) {
      // Cap hit: sweep the dead first — evicting a live user's row while expired
      // ones sit in the Map would be paying for entries that answer nothing.
      const t = now();
      for (const [k, e] of store) if (e.expiresAt <= t) store.delete(k);
      // Still full ⇒ genuinely maxEntries live users; the oldest write goes.
      while (store.size >= maxEntries) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    }
    store.set(key, { value, expiresAt: now() + ttlMs });
  }

  // Drop a key the instant its row's auth-relevant state changes. Also abandons any
  // load already in flight for it: that read began BEFORE the change, so its result
  // must not be stored after it (the caller who started it still gets its value —
  // their request predates the change, exactly as without a cache).
  function invalidate(kind, id) {
    const key = keyOf(kind, id);
    store.delete(key);
    inFlight.delete(key);
  }

  // The read path requireAuth uses: cached row, or ONE shared loader call per key —
  // twenty concurrent first requests from the same sign-in cost one round trip, not
  // twenty. The result is stored only if (a) it is a row, not null, and (b) this
  // load is still the current one for the key (see invalidate above).
  async function load(kind, id, loader) {
    if (!enabled) return loader();
    const cached = get(kind, id);
    if (cached !== undefined) return cached;
    const key = keyOf(kind, id);
    const pending = inFlight.get(key);
    if (pending) return pending;
    const p = (async () => {
      try {
        const value = await loader();
        if (inFlight.get(key) === p) set(kind, id, value);
        return value;
      } finally {
        if (inFlight.get(key) === p) inFlight.delete(key);
      }
    })();
    inFlight.set(key, p);
    return p;
  }

  function clear() { store.clear(); inFlight.clear(); }
  function size() { return store.size; }

  return { get, set, invalidate, load, clear, size, ttlMs, maxEntries };
}

// The one shared instance the API uses. Module-level and process-wide on purpose —
// see the header: one deployment, one process, one college.
const identityCache = createIdentityCache();

module.exports = { createIdentityCache, identityCache, resolveTtlMs, resolveMaxEntries };
