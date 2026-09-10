// A React hook below an early return, found by reading the file — because there is no
// client-side test framework here and this bug has now been shipped three times.
//
// The failure it catches is React error #310, "rendered more hooks than during the
// previous render". A component that returns early while its data is loading, and then
// calls useState below that point, renders FEWER hooks on the first pass than on the
// second. React's hook state is positional, so the lists no longer line up and it throws
// — not in the component, but at the root, which unmounts the whole screen. The symptom is
// a blank page and a minified error code, and the cause is a line that reads perfectly.
//
// It is caught HERE, in a server-side unit test that opens the client's source, for the
// reason the testing rule gives: `StaffHub.jsx` and its neighbours are ~12k lines verified
// only by building, and a build does not have an opinion about hook order. The same
// precedent as adminPages-contract.test.js next door, which keeps two hand-maintained
// copies of a list in step by reading both files.
//
// DELIBERATELY A TEXT SCAN, NOT A PARSER. The rule is narrow enough that indentation
// carries it: a hook at exactly two spaces is at a component's top level, and an early
// return at exactly two spaces is the guard clause that precedes it. Anything nested
// deeper is inside a callback or a block and is not what this is about. A parser would
// catch more and would also be a dependency, a build step and a thing to maintain, for a
// rule with one shape.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const CLIENT_SRC = path.join(__dirname, "..", "..", "client", "src");

// `if (...) return …;` on one line, at a component's top level. The guard clause shape:
// `if (!draft) return null;`, `if (!data) return <Spinner />;`.
const EARLY_RETURN = /^ {2}if\s*\([^)]*\)\s*return[\s;]/;
// ...EXCEPT when the condition is a module-level constant, which is a real exemption
// rather than a hole in the rule. React's complaint is that the NUMBER of hooks differed
// between two renders of the same component. A condition that cannot change while the
// process runs — `if (!BIOMETRICS_ENABLED) return null;`, a parked feature switched off in
// code — returns on every render or on none, so the count never varies and there is
// nothing to line up wrongly. The bundler drops the rest of the component too.
//
// SCREAMING_CASE is the signal, and it is the right one to key on precisely because it
// cannot be a prop or a piece of state: those are the two things that change between
// renders, and neither is ever written this way in this codebase.
const CONSTANT_CONDITION = /^ {2}if\s*\(\s*!?\s*([A-Z][A-Z0-9_]*)\s*\)\s*return[\s;]/;
// A hook call at a component's top level. `use[A-Z]` covers useState, useEffect, useMemo,
// useCallback, useRef and any custom hook this codebase adds later — useDismissOnOutside
// is already one, and the rule binds it exactly as hard.
const TOP_LEVEL_HOOK = /^ {2}(?:const|let|var)?\s*(?:\[[^\]]*\]|\{[^}]*\}|[A-Za-z_$][\w$]*)?\s*=?\s*(use[A-Z]\w*)\s*\(/;
// The closing brace of a top-level function, which ends the component we are inside.
const END_OF_FUNCTION = /^\}/;

function offences(source) {
  const lines = source.split("\n");
  const found = [];
  let returnedAt = null;   // line number of the early return we are past, within this component
  lines.forEach((line, i) => {
    if (END_OF_FUNCTION.test(line)) { returnedAt = null; return; }
    if (EARLY_RETURN.test(line)) {
      if (CONSTANT_CONDITION.test(line)) return;
      if (returnedAt === null) returnedAt = i + 1;
      return;
    }
    if (returnedAt === null) return;
    const hook = line.match(TOP_LEVEL_HOOK);
    if (hook) found.push({ line: i + 1, hook: hook[1], after: returnedAt, text: line.trim() });
  });
  return found;
}

test("no React hook is called below an early return", () => {
  const files = fs.readdirSync(CLIENT_SRC).filter((f) => f.endsWith(".jsx"));
  assert.ok(files.length > 5, "the client source moved; this test is reading the wrong place");

  const bad = [];
  for (const file of files) {
    for (const o of offences(fs.readFileSync(path.join(CLIENT_SRC, file), "utf8"))) {
      bad.push(`${file}:${o.line}  ${o.hook} after the early return on line ${o.after}\n      ${o.text}`);
    }
  }
  assert.deepEqual(bad, [], `React error #310 waiting to happen:\n  ${bad.join("\n  ")}`);
});

test("the scan actually finds the bug it is looking for", () => {
  // Without this, the test above passes for ever the moment a regex stops matching — which
  // is the exact failure mode of a text scan, and the reason two tests in this codebase
  // have already passed while discriminating nothing.
  const broken = `
function Thing({ data }) {
  const [a, setA] = useState(1);
  if (!data) return null;
  const [b, setB] = useState(2);
  return <p>{a}{b}</p>;
}
`;
  const found = offences(broken);
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(found[0].hook, "useState");
  assert.equal(found[0].line, 5);
});

test("...and does not fire on the shapes that are fine", () => {
  const fine = `
function Thing({ data }) {
  const [a, setA] = useState(1);
  useEffect(() => {
    if (!data) return;
    setA(2);
  }, [data]);
  const items = useMemo(() => [], []);
  if (!data) return null;
  return <p>{a}{items.length}</p>;
}

function Other() {
  if (!x) return null;
  const handler = () => useless();
  const cb = () => { const [q] = useState(1); return q; };
  return null;
}
`;
  // The early `return` inside the useEffect callback is indented four spaces, so it is not
  // a guard clause. `useless()` starts with "use" but not "use[A-Z]". And a hook inside a
  // nested arrow is indented past two spaces — wrong in its own way, but not this rule's
  // business and not something this scan should claim to have found.
  assert.deepEqual(offences(fine), []);
});

test("a guard on a module constant is not an offence", () => {
  // The parked biometrics feature, which is the real shape this exemption exists for. The
  // hook count cannot vary because the condition cannot vary, so React has nothing to
  // misalign — and flagging it would train somebody to ignore this test's output.
  const parked = `
function Parked() {
  if (!BIOMETRICS_ENABLED) return null;
  const [a, setA] = useState(1);
  return <p>{a}</p>;
}
`;
  assert.deepEqual(offences(parked), []);
});

test("...but a guard on a PROP still is, however similar it looks", () => {
  // The exemption must not widen into "any early return is fine". A prop or a piece of
  // state is exactly what changes between renders, which is the whole bug.
  const broken = `
function Thing({ enabled }) {
  if (!enabled) return null;
  const [a, setA] = useState(1);
  return <p>{a}</p>;
}
`;
  assert.equal(offences(broken).length, 1);
});
