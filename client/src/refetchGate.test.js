// Tests for the staleness/dedupe gate in front of the store's refetchers.
// Run from client/: node --test "src/**/*.test.js"
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRefetchGate } from "./refetchGate.js";

// A controllable fetcher: counts calls, and each call resolves only when the
// test says so — real batches take time, and every interesting bug here lives
// in the window while one is still on the wire.
function makeFetcher() {
  const pending = [];
  let calls = 0;
  const fetch = () => {
    calls += 1;
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  };
  return {
    fetch,
    get calls() { return calls; },
    resolveNext: (v) => pending.shift().resolve(v),
    rejectNext: (e) => pending.shift().reject(e),
  };
}

// Flush enough microtask turns for chained .then bookkeeping to run.
const tick = async (n = 5) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

test("first call always fetches — even with the clock pinned at 0 (null, not 0, means never-completed)", async () => {
  // With lastSettledAt initialised to 0 instead of null, now()=0 would make the
  // gate look freshly-settled before it had ever fetched, and the first focus
  // event would be silently skipped. This is the null-vs-zero rule in miniature.
  const f = makeFetcher();
  const gate = createRefetchGate({ maxAgeMs: 15000, now: () => 0 });
  const p = gate.ifStale(f.fetch, "s");
  assert.notEqual(p, null);
  assert.equal(f.calls, 1);
  f.resolveNext();
  await p;
});

test("ifStale: skips inside the freshness window, fetches outside it", async () => {
  const f = makeFetcher();
  let t = 0;
  const gate = createRefetchGate({ maxAgeMs: 15000, now: () => t });
  const p = gate.ifStale(f.fetch, "s");
  f.resolveNext();
  await p;
  t = 14999; // alt-tab away and straight back: zero requests
  assert.equal(gate.ifStale(f.fetch, "s"), null);
  assert.equal(f.calls, 1);
  t = 15000; // a genuine return after the threshold: refetch as before
  const p2 = gate.ifStale(f.fetch, "s");
  assert.notEqual(p2, null);
  assert.equal(f.calls, 2);
  f.resolveNext();
  await p2;
});

test("ifStale: joins the in-flight batch instead of starting a second one", async () => {
  const f = makeFetcher();
  const gate = createRefetchGate({ maxAgeMs: 15000, now: () => 0 });
  const a = gate.ifStale(f.fetch, "s");
  const b = gate.ifStale(f.fetch, "s"); // focus + visibilitychange firing together
  assert.equal(a, b);
  assert.equal(f.calls, 1);
  f.resolveNext();
  await a;
});

test("fresh: callers arriving mid-flight share ONE follow-up batch that starts only after the first settles", async () => {
  const f = makeFetcher();
  const gate = createRefetchGate({ maxAgeMs: 15000, now: () => 0 });
  const a = gate.fresh(f.fetch, "s");
  // Three post-mutation resyncs land while the first batch is on the wire.
  const b = gate.fresh(f.fetch, "s");
  const c = gate.fresh(f.fetch, "s");
  const d = gate.fresh(f.fetch, "s");
  assert.equal(b, c);
  assert.equal(c, d);
  assert.equal(f.calls, 1, "the follow-up must NOT start while the first batch is still in flight");
  f.resolveNext();
  await tick();
  assert.equal(f.calls, 2, "exactly one follow-up for all three mid-flight callers");
  f.resolveNext();
  await Promise.all([a, b, c, d]);
});

test("fresh: after everything settles, the next call fetches again (freshness is never assumed)", async () => {
  const f = makeFetcher();
  const gate = createRefetchGate({ maxAgeMs: 15000, now: () => 0 });
  const a = gate.fresh(f.fetch, "s");
  f.resolveNext();
  await a;
  // Zero time has passed, but fresh() is the post-mutation path: it must hit
  // the network regardless, or a save inside the freshness window would never
  // show up on screen.
  const b = gate.fresh(f.fetch, "s");
  assert.equal(f.calls, 2);
  f.resolveNext();
  await b;
});

test("scope change bypasses staleness: a fresh copy of semester A is not a fresh copy of semester B", async () => {
  const f = makeFetcher();
  const gate = createRefetchGate({ maxAgeMs: 60000, now: () => 0 });
  const a = gate.ifStale(f.fetch, "sem-A");
  f.resolveNext();
  await a;
  // Same instant, different scope: must fetch.
  const b = gate.ifStale(f.fetch, "sem-B");
  assert.notEqual(b, null);
  assert.equal(f.calls, 2);
  f.resolveNext();
  await b;
});

test("scope change mid-flight: the new scope starts immediately, and the old batch settling late does not evict it", async () => {
  const f = makeFetcher();
  const gate = createRefetchGate({ maxAgeMs: 60000, now: () => 0 });
  const a = gate.fresh(f.fetch, "sem-A");     // old semester, still on the wire
  const b = gate.fresh(f.fetch, "sem-B");     // picker changed: no waiting, no joining
  assert.equal(f.calls, 2);
  f.resolveNext(); // sem-A settles late…
  await tick();
  // …and sem-B must still be registered as in flight: a third caller joins it
  // rather than opening batch number three.
  const c = gate.ifStale(f.fetch, "sem-B");
  assert.equal(c, b);
  assert.equal(f.calls, 2);
  f.resolveNext();
  await Promise.all([b, c]);
  await a;
});

test("a queued follow-up is abandoned when a different scope supersedes it (no stale-scope replay)", async () => {
  const fA = makeFetcher();
  const fB = makeFetcher();
  const gate = createRefetchGate({ maxAgeMs: 60000, now: () => 0 });
  const a1 = gate.fresh(fA.fetch, "sem-A");
  const a2 = gate.fresh(fA.fetch, "sem-A"); // queues the follow-up for sem-A
  const b = gate.fresh(fB.fetch, "sem-B");  // picker changed before sem-A settled
  fA.resolveNext();
  await tick();
  // The sem-A follow-up must NOT have run: replaying it here would overwrite
  // the rescoped sem-B data with sem-A rows after the user moved on.
  assert.equal(fA.calls, 1);
  assert.equal(fB.calls, 1);
  await a2; // the abandoned caller still resolves — nothing left hanging
  fB.resolveNext();
  await Promise.all([a1, b]);
});

test("a rejected batch rejects for its callers, clears the in-flight slot, and still stamps the settle time", async () => {
  const f = makeFetcher();
  let t = 0;
  const gate = createRefetchGate({ maxAgeMs: 15000, now: () => t });
  const a = gate.ifStale(f.fetch, "s");
  f.rejectNext(new Error("boom"));
  await assert.rejects(a, /boom/);
  // Stamped on settle even for failure: the store's refetchers swallow their
  // own errors anyway, and if one ever does reject, a focus storm must not
  // hammer a hard-down endpoint — the poll timer retries on its own cadence.
  t = 1000;
  assert.equal(gate.ifStale(f.fetch, "s"), null);
  t = 15001;
  const b = gate.ifStale(f.fetch, "s");
  assert.notEqual(b, null, "the in-flight slot must be cleared by a rejection, not wedged forever");
  assert.equal(f.calls, 2);
  f.resolveNext();
  await b;
});
