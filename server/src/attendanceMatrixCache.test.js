// The attendance-matrix cache: what it keeps, what expires, and — the part a
// stale dashboard would trace back to — exactly which requests drop it.
//
// The TTL is pinned via the env var BEFORE the module loads (it is read once at
// require time, matching every other cache in this codebase), short enough that
// the expiry test does not slow the suite and long enough that the roundtrip
// tests cannot flake on a slow machine.
process.env.ATTENDANCE_MATRIX_CACHE_MS = "500";

const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const cache = require("./attendanceMatrixCache");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A minimal req/res pair for the middleware. The res is an EventEmitter because
// the middleware listens for "finish" — the moment Express has sent the response
// — and reads statusCode off it, which is all it touches.
function fakeExchange(method, statusCode) {
  const req = { method };
  const res = new EventEmitter();
  res.statusCode = statusCode;
  let called = false;
  const next = () => { called = true; };
  cache.invalidateOnWrite(req, res, next);
  assert.ok(called, "the middleware must always call next()");
  return res;
}

test("an empty cache answers null, and a set value comes back as-is", () => {
  cache.invalidate();
  assert.equal(cache.get(), null);
  const value = { rows: [{ overall: { pct: null } }] }; // null pct: "not measured" must survive untouched
  cache.set(value);
  // Identity, not deep-equality: the cache must hand back the very object it was
  // given, because a copy would be where a null could silently become a zero.
  assert.strictEqual(cache.get(), value);
});

test("invalidate() drops the slot", () => {
  cache.set({ marker: 1 });
  assert.ok(cache.get());
  cache.invalidate();
  assert.equal(cache.get(), null);
});

test("the value expires after the TTL", async () => {
  cache.set({ marker: 2 });
  assert.ok(cache.get(), "fresh value should still be served");
  await sleep(600); // past the 500ms TTL pinned above
  assert.equal(cache.get(), null, "an expired value must not be served");
});

test("a successful mutation through the middleware drops the cache on finish", () => {
  cache.set({ marker: 3 });
  const res = fakeExchange("PUT", 200);
  // Not yet: invalidating before the write completes would let a concurrent read
  // re-cache pre-write figures. The drop happens when the response finishes.
  assert.ok(cache.get(), "the cache must survive until the response has finished");
  res.emit("finish");
  assert.equal(cache.get(), null, "a finished 2xx mutation must drop the cache");
});

test("a GET never drops the cache, however it ends", () => {
  cache.set({ marker: 4 });
  fakeExchange("GET", 200).emit("finish");
  assert.ok(cache.get(), "a read must not invalidate anything");
});

test("a refused mutation (4xx/5xx) leaves the cache standing", () => {
  cache.set({ marker: 5 });
  fakeExchange("POST", 403).emit("finish");
  fakeExchange("DELETE", 500).emit("finish");
  assert.ok(cache.get(), "a write that failed changed no figures, so it must not cost a recompute");
});
