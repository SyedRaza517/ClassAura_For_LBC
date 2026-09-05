// What a student is shown after scanning, as a pure decision.
//
// This lives outside the component because two of the rules below failed silently in
// review, and neither would have been caught by anything: the card is rendered only
// after a real scan against a real class, and both bugs LOOK like a working card.
//
//   A student the lecturer had already marked ABSENT scanned, and was shown a green tick
//     reading "Already checked in". The server was right and said A; the card asked only
//     whether the status was "L" and treated everything else as a success.
//   A refusal with no recognised reason printed the server's own message. One of those
//     messages is the CREDENTIALS_KEY setup instruction, shell command and all, so a
//     misconfigured deployment showed server configuration to a room full of students.
//
// Run with: node --test src/qrResultView.test.js   (from client/)
import test from "node:test";
import assert from "node:assert/strict";
import { qrScanResult, qrScanRefusal, keepScanAfter } from "./qrResultView.js";

const session = { unitCode: "OBM", unitName: "Organisational Behaviour Management" };

test("a scan that marks you present says when", () => {
  const v = qrScanResult({ ok: true, status: "P", checkedInAt: "09:02", session });
  assert.equal(v.tone, "present");
  assert.equal(v.heading, "Checked in at 09:02");
  assert.equal(v.chip, null);
  assert.equal(v.good, true);
});

test("a scan after the cut-off is marked late, and says so on the card", () => {
  const v = qrScanResult({ ok: true, status: "L", checkedInAt: "09:20", session });
  assert.equal(v.tone, "late");
  assert.equal(v.chip, "Late");
  assert.equal(v.good, true);
});

test("scanning again keeps the first time and does not claim a second check-in", () => {
  const v = qrScanResult({ ok: true, alreadyMarked: true, status: "P", checkedInAt: "09:02", session });
  assert.equal(v.tone, "present");
  assert.equal(v.heading, "Already checked in");
  assert.match(v.detail, /09:02/);
});

// THE BUG. Absent is a mark a human set, and it is the one answer a student most needs
// to read correctly. A tick here tells them they are fine when they are not.
test("a student the lecturer marked absent is told so, not shown a tick", () => {
  const v = qrScanResult({ ok: true, alreadyMarked: true, status: "A", checkedInAt: null, session });
  assert.equal(v.good, false, "an absent mark must not render as a successful check-in");
  assert.equal(v.tone, "absent");
  assert.match(v.heading, /absent/i);
  assert.match(v.detail, /lecturer/i, "the only move open to the student is to speak to their lecturer");
});

test("a student marked excused is told so, and is not asked to do anything", () => {
  const v = qrScanResult({ ok: true, alreadyMarked: true, status: "E", checkedInAt: null, session });
  assert.equal(v.good, false);
  assert.equal(v.tone, "excused");
  assert.match(v.heading, /excused/i);
});

test("the class is named on every answer, so a mis-scan is visible", () => {
  for (const status of ["P", "L", "A", "E"]) {
    const v = qrScanResult({ ok: true, alreadyMarked: true, status, session });
    assert.match(v.detail, /Organisational Behaviour Management|OBM/,
      `the ${status} card dropped the class name`);
  }
});

/* ---------- refusals ---------- */

test("an expired code asks for the current one", () => {
  const v = qrScanRefusal({ body: { reason: "qr_expired" } });
  assert.equal(v.heading, "That code has expired");
  assert.match(v.advice, /scan/i);
});

test("a code that was never valid does not accuse the student of anything", () => {
  const v = qrScanRefusal({ body: { reason: "qr_bad_code" } });
  assert.match(v.heading, /isn't recognised/);
  assert.match(v.advice, /scan/i);
});

// These two used to render a heading and then nothing, which leaves a student holding a
// phone with no idea whether to wait, rescan, or speak to somebody.
test("a class that is not running tells the student what to do instead", () => {
  const v = qrScanRefusal({ body: { reason: "no_session_now" } });
  assert.ok(v.advice.length > 0, "a refusal with no advice leaves the student stuck");
  assert.match(v.advice, /lecturer/i);
});

test("a closed register tells the student what to do instead", () => {
  const v = qrScanRefusal({ body: { reason: "term_locked" } });
  assert.ok(v.advice.length > 0);
  assert.match(v.advice, /lecturer/i);
});

// THE OTHER BUG. Anything the server says for an unrecognised reason is written for an
// operator, not for a student, and one of those strings is a configuration secret's
// setup instructions.
test("an unrecognised refusal never repeats the server's own words", () => {
  const leak =
    "CREDENTIALS_KEY is not set, so integration credentials cannot be stored. " +
    "Generate one with:  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"";
  const v = qrScanRefusal({ message: leak, body: { error: leak } });
  const shown = `${v.heading} ${v.advice}`;
  assert.doesNotMatch(shown, /CREDENTIALS_KEY/, "server configuration reached a student's phone");
  assert.doesNotMatch(shown, /node -e|randomBytes|require\(/, "a shell command reached a student's phone");
  assert.ok(v.advice.length > 0, "the student is still owed one move");
});

test("a bare network failure is answered the same safe way", () => {
  const v = qrScanRefusal({ message: "Request failed (500)" });
  assert.doesNotMatch(`${v.heading} ${v.advice}`, /500|Request failed/);
  assert.ok(v.advice.length > 0);
});

test("nothing at all still produces a usable card", () => {
  const v = qrScanRefusal(undefined);
  assert.ok(v.heading.length > 0);
  assert.ok(v.advice.length > 0);
});

// ---- A scan interrupted by an expired session -------------------------------------
//
// The card clears the one-shot stash the moment it submits, so a student cannot
// double-mark by reloading. But a 401 means the request never reached the register: the
// token had expired, the app is about to show the sign-in, and the scan was the last
// thing they did. Dropping it sends them back to the projector to scan again for no
// reason of their own. A 401, and only a 401, keeps the scan for after sign-in.
test("a scan refused because the session expired is kept for after sign-in", () => {
  assert.equal(keepScanAfter(Object.assign(new Error("Invalid token"), { status: 401 })), true);
});

test("every other refusal, and a dropped connection, does not resurrect the scan", () => {
  assert.equal(keepScanAfter(Object.assign(new Error("expired"), { status: 409, body: { reason: "qr_expired" } })), false);
  assert.equal(keepScanAfter(Object.assign(new Error("no"), { status: 403 })), false);
  assert.equal(keepScanAfter(Object.assign(new Error("server"), { status: 500 })), false);
  assert.equal(keepScanAfter(new TypeError("Load failed")), false);
  assert.equal(keepScanAfter(null), false);
});
