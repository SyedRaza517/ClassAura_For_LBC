// Staleness + in-flight gating for the store's refetchers.
//
// The problem this solves: the store re-fetches on window focus, on tab
// visibility, on a 20-second timer, on page mount, and after every mutation.
// Those triggers overlap constantly — alt-tabbing back to the app fired the
// focus AND visibilitychange listeners, on top of whatever the timer and a
// freshly-mounted page were already doing — and each trigger re-downloaded
// everything, including the registers payload (every student, every session,
// the whole attendance matrix). A gate sits in front of each refetcher and
// answers one question: does THIS call actually need a network round trip?
//
// Why not a data-fetching library (react-query / SWR)? Those solve exactly
// this — staleTime, request dedupe, focus refetch — but they own the cache:
// adopting one means moving every collection out of useState and every
// mutation into their invalidation model, across a 500-line store and every
// component that reads it. This module is ~60 lines of logic the store wraps
// around its EXISTING refetchers, changing no data shape and no component.
// The trade (accepted deliberately) is that we maintain the gate ourselves.
//
// Pure logic, no React and no globals, so `node --test` covers it directly —
// the same "pure logic beside its tests" pattern the server uses.
//
// Two entry points, because callers need two different guarantees:
//
//   fresh(fetch, scope)   — "the data I get back must reflect the world as of
//                           this call." Used by the exported refresh()/
//                           refreshHnd()/… — i.e. mount effects, the manual
//                           Refresh buttons, and every post-mutation resync.
//                           It ALWAYS costs a fetch; the only saving is that
//                           calls arriving while a batch is in flight share a
//                           single follow-up batch instead of each opening a
//                           concurrent one.
//   ifStale(fetch, scope) — "recent data is fine; skip if we have it." Used
//                           only by the focus/visibility listeners and the
//                           poll timer, where nothing has changed on OUR side
//                           and the only question is whether the cached copy
//                           is old enough to be worth replacing.
//
// Why fresh() queues a follow-up instead of simply returning the in-flight
// promise (the rejected alternative): a post-save resync joining a batch that
// STARTED before the save could hand back pre-save rows — the user saves a
// register mark and the matrix never shows it, because the join returned data
// read before the write landed and (for the registers collections) nothing
// else refetches until the next focus. Worse, today's behaviour — starting a
// second concurrent batch — has the mirror-image race: the OLD batch can
// resolve last and overwrite the post-save state with pre-save rows. Running
// the follow-up strictly after the current batch settles fixes both: it costs
// at most one extra sequential batch, shared by every caller that arrived
// mid-flight, and it always reads after the write.
//
// `scope` is an opaque key describing WHAT the fetcher would download — the
// store passes the user identity plus (for registers) the selected semester.
// Freshness and dedupe never cross scopes: changing the semester picker means
// the cached data is for the wrong scope entirely, so a 10-second-old copy of
// semester A is useless for semester B and the gate must let the refetch
// through. Time-based staleness alone would have silently served the wrong
// semester for up to a minute.
export function createRefetchGate({ maxAgeMs, now = Date.now }) {
  // null, never 0: "has never completed" must stay distinguishable from
  // "completed at epoch" — the same null-vs-zero rule as the academic figures
  // (.claude/rules/conventions.md). A gate that has never fetched is always
  // stale, whatever the clock says (a test clock pinned at 0 must still fetch).
  let lastSettledAt = null;
  let settledScope = null;
  let inFlight = null;      // the batch currently on the wire, or null
  let inFlightScope = null;
  let trailing = null;      // the single queued follow-up batch, or null
  // Bumped every time a batch starts. A queued follow-up remembers the
  // generation it was queued under and refuses to run if another batch started
  // in between — which can only happen on a scope change (same-scope callers
  // join rather than start). Without this, changing the semester while a
  // follow-up was queued replayed the OLD semester's fetcher after the new
  // semester's batch, overwriting the rescoped data with the previous scope's.
  let generation = 0;

  const start = (fetch, scope) => {
    generation += 1;
    // The fetcher is invoked SYNCHRONOUSLY — the un-gated refresh() opened its
    // requests the instant it was called, and deferring to a microtask (the
    // rejected `Promise.resolve().then(fetch)` form) is both a behaviour
    // change and unobservable-in-flight for that first tick. A synchronous
    // throw is converted to a rejection so it cannot unwind the caller's
    // stack mid-bookkeeping.
    let p;
    try { p = Promise.resolve(fetch()); } catch (err) { p = Promise.reject(err); }
    const settle = () => {
      // Stamped on settle, success OR failure. The store's refetchers catch
      // their own errors and resolve regardless (a failed load toasts and
      // moves on), so rejection barely reaches here — but if a fetcher ever
      // does reject, stamping anyway stops a hard-down endpoint being hammered
      // on every focus event; the poll timer retries it on its own cadence.
      lastSettledAt = now();
      settledScope = scope;
      // Clear the registration only if it is still OURS: a scope change starts
      // a new batch while the old one is still on the wire, and the old one
      // settling late must not evict the newer batch's registration (which
      // would let a third caller start yet another concurrent batch).
      if (inFlight === p) { inFlight = null; inFlightScope = null; }
    };
    p.then(settle, settle);
    inFlight = p;
    inFlightScope = scope;
    return p;
  };

  return {
    fresh(fetch, scope) {
      if (inFlight && inFlightScope === scope) {
        if (!trailing) {
          const queuedUnder = generation;
          const followUp = () => {
            trailing = null;
            // A different-scope batch superseded us while we waited: the data
            // this caller wanted is for a scope nobody is looking at any more,
            // so resolve without fetching rather than replay a stale scope.
            if (generation !== queuedUnder) return undefined;
            return start(fetch, scope);
          };
          // .then(f, f) not .finally(): the follow-up must run (and its result
          // become ours) whether the current batch resolved or rejected.
          trailing = inFlight.then(followUp, followUp);
        }
        return trailing;
      }
      return start(fetch, scope);
    },

    ifStale(fetch, scope) {
      // Joining the in-flight batch (not the trailing one) is deliberate:
      // this caller only wants "recent", and the batch on the wire is as
      // recent as it gets without paying for another round trip.
      if (inFlight && inFlightScope === scope) return inFlight;
      if (lastSettledAt !== null && settledScope === scope && now() - lastSettledAt < maxAgeMs) {
        // null = "skipped, nothing on the wire" — distinct from a promise so
        // tests (and callers, if they ever care) can tell a skip from a join.
        return null;
      }
      return start(fetch, scope);
    },
  };
}
