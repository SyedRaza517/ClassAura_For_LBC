// Tests for the requireAuth identity cache — the pure logic, no database, no server.
//
// Every test builds its own cache through createIdentityCache with an injected clock,
// so nothing here depends on real time passing or on the env-derived shared instance.
// The shared instance is exactly createIdentityCache with env-resolved options, so
// proving the factory proves the singleton.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createIdentityCache, resolveTtlMs, resolveMaxEntries } = require("./identityCache");

// A controllable clock: tests move time forward explicitly instead of sleeping.
function fakeClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

test("get on an empty cache misses", () => {
  const c = createIdentityCache({ ttlMs: 30_000, maxEntries: 10, now: fakeClock() });
  assert.equal(c.get("staff", "s1"), undefined);
});

test("set then get returns the same object within the TTL", () => {
  const now = fakeClock();
  const c = createIdentityCache({ ttlMs: 30_000, maxEntries: 10, now });
  const row = { id: "s1", tokenVersion: 3 };
  c.set("staff", "s1", row);
  now.advance(29_999);
  assert.equal(c.get("staff", "s1"), row); // the very object, not a copy
});

test("an entry expires after the TTL and is removed, not just hidden", () => {
  const now = fakeClock();
  const c = createIdentityCache({ ttlMs: 30_000, maxEntries: 10, now });
  c.set("staff", "s1", { id: "s1" });
  now.advance(30_000); // exactly TTL — expired (entries live for ttlMs - 1 at most)
  assert.equal(c.get("staff", "s1"), undefined);
  assert.equal(c.size(), 0); // the expired entry was deleted on read, not left to rot
});

test("the same id under different kinds are different entries", () => {
  // Staff, students and applicants are three separately-enforced identities; an id
  // collision between tables must never let one kind's row answer for another's.
  const c = createIdentityCache({ ttlMs: 30_000, maxEntries: 10, now: fakeClock() });
  c.set("staff", "x", { kind: "staff" });
  c.set("student", "x", { kind: "student" });
  assert.equal(c.get("staff", "x").kind, "staff");
  assert.equal(c.get("student", "x").kind, "student");
  c.invalidate("staff", "x");
  assert.equal(c.get("staff", "x"), undefined);
  assert.equal(c.get("student", "x").kind, "student"); // the other kind survives
});

test("invalidate removes exactly that key and leaves the rest", () => {
  const c = createIdentityCache({ ttlMs: 30_000, maxEntries: 10, now: fakeClock() });
  c.set("staff", "a", { id: "a" });
  c.set("staff", "b", { id: "b" });
  c.invalidate("staff", "a");
  assert.equal(c.get("staff", "a"), undefined);
  assert.equal(c.get("staff", "b").id, "b");
});

test("invalidating a key that was never cached is a harmless no-op", () => {
  const c = createIdentityCache({ ttlMs: 30_000, maxEntries: 10, now: fakeClock() });
  assert.doesNotThrow(() => c.invalidate("staff", "never-seen"));
});

test("the cap evicts the oldest-written entry, never the newest", () => {
  const c = createIdentityCache({ ttlMs: 30_000, maxEntries: 3, now: fakeClock() });
  c.set("staff", "a", { id: "a" });
  c.set("staff", "b", { id: "b" });
  c.set("staff", "c", { id: "c" });
  c.set("staff", "d", { id: "d" }); // over the cap — "a" (oldest write) goes
  assert.equal(c.size(), 3);
  assert.equal(c.get("staff", "a"), undefined);
  assert.equal(c.get("staff", "d").id, "d");
});

test("expired entries are swept before a live one is evicted for the cap", () => {
  const now = fakeClock();
  const c = createIdentityCache({ ttlMs: 30_000, maxEntries: 3, now });
  c.set("staff", "a", { id: "a" });
  c.set("staff", "b", { id: "b" });
  now.advance(31_000); // a and b are dead
  c.set("staff", "c", { id: "c" });
  c.set("staff", "d", { id: "d" }); // cap reached only if the dead were counted
  assert.equal(c.get("staff", "c").id, "c"); // c survived — the sweep took a and b
  assert.equal(c.get("staff", "d").id, "d");
});

test("re-setting an existing key refreshes its value and its eviction position", () => {
  const c = createIdentityCache({ ttlMs: 30_000, maxEntries: 3, now: fakeClock() });
  c.set("staff", "a", { v: 1 });
  c.set("staff", "b", { v: 1 });
  c.set("staff", "c", { v: 1 });
  c.set("staff", "a", { v: 2 }); // rewritten — now the NEWEST, so b is next out
  c.set("staff", "d", { v: 1 });
  assert.equal(c.get("staff", "a").v, 2);
  assert.equal(c.get("staff", "b"), undefined);
});

test("ttlMs of 0 disables the cache entirely", async () => {
  const c = createIdentityCache({ ttlMs: 0, maxEntries: 10, now: fakeClock() });
  c.set("staff", "s1", { id: "s1" });
  assert.equal(c.get("staff", "s1"), undefined);
  assert.equal(c.size(), 0);
  // load() must go straight to the loader every time — no reuse between calls.
  let calls = 0;
  const loader = async () => { calls += 1; return { id: "s1" }; };
  await c.load("staff", "s1", loader);
  await c.load("staff", "s1", loader);
  assert.equal(calls, 2);
});

/* ------------------------------- load() ------------------------------- */

test("load caches the loader's row and reuses it on the next call", async () => {
  const c = createIdentityCache({ ttlMs: 30_000, maxEntries: 10, now: fakeClock() });
  let calls = 0;
  const loader = async () => { calls += 1; return { id: "s1", tokenVersion: 0 }; };
  const first = await c.load("staff", "s1", loader);
  const second = await c.load("staff", "s1", loader);
  assert.equal(calls, 1);
  assert.equal(first, second);
});

test("an invalidated key forces load to re-read", async () => {
  const c = createIdentityCache({ ttlMs: 30_000, maxEntries: 10, now: fakeClock() });
  let calls = 0;
  const loader = async () => { calls += 1; return { id: "s1", tokenVersion: calls }; };
  await c.load("staff", "s1", loader);
  c.invalidate("staff", "s1");
  const after = await c.load("staff", "s1", loader);
  assert.equal(calls, 2);
  assert.equal(after.tokenVersion, 2); // the fresh row, not the invalidated one
});

test("load never caches a null or undefined result", async () => {
  // A deleted or unknown account must MISS every time — exactly the pre-cache
  // behaviour. Caching the absence would also pin "no such account" over a row
  // created milliseconds later (invite accept, applicant register).
  const c = createIdentityCache({ ttlMs: 30_000, maxEntries: 10, now: fakeClock() });
  let calls = 0;
  const loader = async () => { calls += 1; return null; };
  assert.equal(await c.load("staff", "gone", loader), null);
  assert.equal(await c.load("staff", "gone", loader), null);
  assert.equal(calls, 2);
  assert.equal(c.size(), 0);
});

test("concurrent loads of the same key share ONE loader call", async () => {
  // The whole point: ~20 requests fire together after sign-in. Without coalescing
  // they would all miss before the first answer lands and the burst would still
  // cost twenty round trips.
  const c = createIdentityCache({ ttlMs: 30_000, maxEntries: 10, now: fakeClock() });
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const loader = async () => { calls += 1; await gate; return { id: "s1" }; };
  const inFlight = Promise.all([
    c.load("staff", "s1", loader),
    c.load("staff", "s1", loader),
    c.load("staff", "s1", loader),
  ]);
  release();
  const [a, b, d] = await inFlight;
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.equal(b, d);
});

test("concurrent loads of different keys do not block each other", async () => {
  const c = createIdentityCache({ ttlMs: 30_000, maxEntries: 10, now: fakeClock() });
  const [a, b] = await Promise.all([
    c.load("staff", "a", async () => ({ id: "a" })),
    c.load("student", "a", async () => ({ id: "a-student" })),
  ]);
  assert.equal(a.id, "a");
  assert.equal(b.id, "a-student");
});

test("invalidate during an in-flight load stops the result being cached", async () => {
  // The race that matters: request A starts loading the row, a password reset lands
  // and invalidates, THEN A's read (from before the reset) returns. Storing it would
  // resurrect the pre-reset row for the rest of the TTL — the exact staleness the
  // invalidation exists to prevent. The in-flight caller still gets the row it read
  // (its request began before the reset, same as today); it just must not be kept.
  const c = createIdentityCache({ ttlMs: 30_000, maxEntries: 10, now: fakeClock() });
  let release;
  const gate = new Promise((r) => { release = r; });
  const stale = { id: "s1", tokenVersion: 0 };
  const p = c.load("staff", "s1", async () => { await gate; return stale; });
  c.invalidate("staff", "s1"); // the reset lands mid-flight
  release();
  assert.equal(await p, stale);              // the in-flight caller's own view
  assert.equal(c.get("staff", "s1"), undefined); // but nothing was kept
  let calls = 0;
  await c.load("staff", "s1", async () => { calls += 1; return { tokenVersion: 1 }; });
  assert.equal(calls, 1); // the next request re-reads
});

test("a loader that throws leaves nothing behind and the next load retries", async () => {
  const c = createIdentityCache({ ttlMs: 30_000, maxEntries: 10, now: fakeClock() });
  await assert.rejects(c.load("staff", "s1", async () => { throw new Error("db down"); }));
  let calls = 0;
  const row = await c.load("staff", "s1", async () => { calls += 1; return { id: "s1" }; });
  assert.equal(calls, 1);
  assert.equal(row.id, "s1");
});

test("clear empties everything", () => {
  const c = createIdentityCache({ ttlMs: 30_000, maxEntries: 10, now: fakeClock() });
  c.set("staff", "a", { id: "a" });
  c.set("student", "b", { id: "b" });
  c.clear();
  assert.equal(c.size(), 0);
  assert.equal(c.get("staff", "a"), undefined);
});

/* --------------------------- env resolution --------------------------- */

test("TTL: explicit env wins, test default is off, production default is 30s", () => {
  assert.equal(resolveTtlMs({ AUTH_CACHE_TTL_MS: "5000", NODE_ENV: "test" }), 5000);
  assert.equal(resolveTtlMs({ AUTH_CACHE_TTL_MS: "0" }), 0);
  assert.equal(resolveTtlMs({ NODE_ENV: "test" }), 0);
  assert.equal(resolveTtlMs({ NODE_ENV: "production" }), 30_000);
  assert.equal(resolveTtlMs({}), 30_000);
});

test("TTL: junk in the env falls back to the default rather than NaN-ing the cache", () => {
  assert.equal(resolveTtlMs({ AUTH_CACHE_TTL_MS: "soon" }), 30_000);
  assert.equal(resolveTtlMs({ AUTH_CACHE_TTL_MS: "-5" }), 30_000);
  assert.equal(resolveTtlMs({ AUTH_CACHE_TTL_MS: "soon", NODE_ENV: "test" }), 0);
});

test("max entries: explicit env wins, junk falls back to the default", () => {
  assert.equal(resolveMaxEntries({ AUTH_CACHE_MAX: "100" }), 100);
  assert.equal(resolveMaxEntries({}), 5000);
  assert.equal(resolveMaxEntries({ AUTH_CACHE_MAX: "lots" }), 5000);
  assert.equal(resolveMaxEntries({ AUTH_CACHE_MAX: "0" }), 5000); // a cap of 0 is a disabled cache spelt wrong
});
