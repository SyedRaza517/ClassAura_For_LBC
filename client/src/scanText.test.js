// What the in-app scanner accepts. The camera hands over whatever text the QR carried;
// only OUR link shape becomes a check-in. Anything else is somebody else's code.
import test from "node:test";
import assert from "node:assert/strict";
import { parseScan } from "./scanText.js";

test("the projector's link, on any origin, yields the session and the code", () => {
  assert.deepEqual(parseScan("http://localhost:5173/#checkin=ses-demo-qr-0903.IWQ0_rwdaTNdOrDYWlEs3D"),
    { sessionId: "ses-demo-qr-0903", code: "IWQ0_rwdaTNdOrDYWlEs3D" });
  assert.deepEqual(parseScan("https://college.example/app/?x=1#checkin=cmtkmxdkx0003q95yg2a6u5qd.abc-DEF_123"),
    { sessionId: "cmtkmxdkx0003q95yg2a6u5qd", code: "abc-DEF_123" });
});

test("a bare session.code pair is accepted too, for a code shown without a link", () => {
  assert.deepEqual(parseScan("ses-1.CODE_x"), { sessionId: "ses-1", code: "CODE_x" });
});

test("surrounding whitespace is ignored", () => {
  assert.deepEqual(parseScan("  ses-1.CODE_x \n"), { sessionId: "ses-1", code: "CODE_x" });
});

test("anything else is not ours", () => {
  assert.equal(parseScan("https://example.com/menu"), null);
  assert.equal(parseScan("WIFI:S:Campus;T:WPA;P:secret;;"), null);
  assert.equal(parseScan("#checkin=nodot"), null);
  assert.equal(parseScan(""), null);
  assert.equal(parseScan(null), null);
  assert.equal(parseScan(undefined), null);
});

test("a query-string form is refused: the code must never travel where servers log it", () => {
  assert.equal(parseScan("http://localhost:5173/?checkin=ses-1.CODE"), null);
});
