// The one-shot handoff between a scanned code and the signed-in app, pinned.
//
// Every rule in pendingQr.js fails silently: a wrong regex means a scanned link opens the
// app and nothing happens; a stash that is taken rather than peeked vanishes under
// StrictMode's double invoke (which is how it shipped broken once); a stash that outlives
// its ten minutes resubmits a code the server will refuse anyway, but with a worse
// message. None of that had a test. The browser bits are stood in for by a small fake
// window and storage, set up BEFORE the module is imported because it reads them at load.
//
// Run with: node --test src/pendingQr.test.js   (from client/)
import test from "node:test";
import assert from "node:assert/strict";

const store = new Map();
const listeners = new Map();
const dispatched = [];
let replaced = null;

globalThis.sessionStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.CustomEvent = class CustomEvent { constructor(type) { this.type = type; } };
globalThis.window = {
  location: { hash: "", pathname: "/", search: "" },
  history: { replaceState: (_s, _t, url) => { replaced = url; } },
  addEventListener: (type, fn) => listeners.set(type, fn),
  dispatchEvent: (e) => { dispatched.push(e.type); },
};

const mod = await import("./pendingQr.js");
const { capturePendingQr, peekPendingQr, hasPendingQr, clearPendingQr, stashScan } = mod;
const KEY = "edtech.pendingQr";
const reset = () => { store.clear(); dispatched.length = 0; replaced = null; window.location.hash = ""; };

test("a #checkin= fragment is captured at load and stripped from the address bar", () => {
  reset();
  window.location.hash = "#checkin=ses-abc.CODE_123-x";
  window.location.search = "?tab=home";
  capturePendingQr();
  assert.deepEqual(peekPendingQr(), { sessionId: "ses-abc", code: "CODE_123-x" });
  assert.equal(replaced, "/?tab=home", "the fragment left the address bar, the rest stayed");
});

test("a fragment of any other shape is left alone", () => {
  reset();
  for (const h of ["#/registers", "#checkin=only-one-part", "#checkin=ses.code.extra", "#checkin=ses/../code"]) {
    window.location.hash = h;
    capturePendingQr();
    assert.equal(peekPendingQr(), null, h);
  }
});

test("peeking does not take: two reads see the same scan", () => {
  reset();
  stashScan({ sessionId: "s1", code: "c1" });
  assert.deepEqual(peekPendingQr(), peekPendingQr());
  assert.equal(hasPendingQr(), true);
});

test("a stash older than ten minutes reads as nothing", () => {
  reset();
  store.set(KEY, JSON.stringify({ sessionId: "s1", code: "c1", at: Date.now() - 10 * 60 * 1000 - 1 }));
  assert.equal(peekPendingQr(), null);
  store.set(KEY, JSON.stringify({ sessionId: "s1", code: "c1", at: Date.now() - 9 * 60 * 1000 }));
  assert.deepEqual(peekPendingQr(), { sessionId: "s1", code: "c1" });
});

test("a code from the in-app scanner takes the same road, and announces itself", () => {
  reset();
  assert.equal(stashScan({ sessionId: "s2", code: "c2" }), true);
  assert.deepEqual(peekPendingQr(), { sessionId: "s2", code: "c2" });
  assert.deepEqual(dispatched, ["edtech:pending-qr"]);
});

test("clearing removes the scan", () => {
  reset();
  stashScan({ sessionId: "s3", code: "c3" });
  clearPendingQr();
  assert.equal(peekPendingQr(), null);
  assert.equal(hasPendingQr(), false);
});

test("a scan landing in an already-open app is picked up by the hashchange listener", () => {
  reset();
  capturePendingQr(); // registers the listener
  window.location.hash = "#checkin=ses-later.CODE9";
  listeners.get("hashchange")();
  assert.deepEqual(peekPendingQr(), { sessionId: "ses-later", code: "CODE9" });
  assert.ok(dispatched.includes("edtech:pending-qr"), "the mounted app was told");
});

test("junk in storage reads as nothing rather than throwing", () => {
  reset();
  store.set(KEY, "{not json");
  assert.equal(peekPendingQr(), null);
  store.set(KEY, JSON.stringify({ code: "only" }));
  assert.equal(peekPendingQr(), null);
});
