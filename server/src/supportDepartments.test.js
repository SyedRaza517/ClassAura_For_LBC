// The pure half of supportDepartments.js: the validator that decides what a college is
// allowed to store as its own organisation chart.
//
// No database. Requiring the module constructs the shared Prisma client but issues no
// query, and nothing below reaches all(), active(), byKey() or save().
//
// Run with: node --test src/supportDepartments.test.js   (from server/)
//
// WHY THESE ARE WORTH TESTING AT ALL. A department key is not a display string: it is
// STORED ON EVERY REFERRAL as a plain string, it is what a membership check in
// Staff.supportDepartments matches on, and it is what the queue URL carries. Nothing
// downstream re-validates it, and it can never be edited afterwards without orphaning
// the referrals raised against it. So this function is the only place a bad key can be
// stopped, and every rule it enforces is load-bearing somewhere it cannot be seen.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  cleanOne, cleanList, KEY_RE, DEFAULTS, membershipOf, canReadDepartment,
} = require("./supportDepartments");

/* -------------------------------------------------------------------------- */
/* KEY_RE — what a slug may be                                                */
/* -------------------------------------------------------------------------- */

test("KEY_RE accepts lower case, digits and hyphens, and nothing else", () => {
  for (const good of ["wellbeing", "ask", "student-support", "a", "team-2", "0", "a".repeat(40)]) {
    assert.equal(KEY_RE.test(good), true, `${good} should be a valid key`);
  }
});

test("KEY_RE rejects a key with a space in it", () => {
  // The key travels in a URL fragment and in a query string. One that needs escaping
  // would work in the browser that created it and break in the next one to read it.
  assert.equal(KEY_RE.test("student support"), false);
});

test("KEY_RE rejects capitals", () => {
  // The whole system compares keys with ===, on a value that came from three different
  // places: a config screen, a stored referral row, and a membership array. "ASK" and
  // "ask" comparing unequal is how a department's own team loses access to its queue.
  assert.equal(KEY_RE.test("ASK"), false);
  assert.equal(KEY_RE.test("Wellbeing"), false);
});

test("KEY_RE rejects non-ASCII, including a lookalike", () => {
  // "wellbeing" with a Cyrillic е is a different string that renders identically, and
  // it would sit in the list next to the real one looking like a duplicate nobody can
  // explain. Confusables belong nowhere near an identifier used as an access key.
  assert.equal(KEY_RE.test("wellbéing"), false);
  assert.equal(KEY_RE.test("wеllbeing"), false); // Cyrillic е
  assert.equal(KEY_RE.test("福祉"), false);
});

test("KEY_RE rejects underscores, dots and slashes", () => {
  for (const bad of ["student_support", "student.support", "student/support", "ask?"]) {
    assert.equal(KEY_RE.test(bad), false, `${bad} should not be a valid key`);
  }
});

test("KEY_RE is bounded at 40 characters — 40 passes, 41 does not", () => {
  assert.equal(KEY_RE.test("a".repeat(40)), true);
  assert.equal(KEY_RE.test("a".repeat(41)), false);
});

test("KEY_RE rejects the empty string", () => {
  // {1,40} rather than {0,40}, which matters because str() turns undefined, null and a
  // whitespace-only key all into "" — so one bound catches every one of them.
  assert.equal(KEY_RE.test(""), false);
});

test("KEY_RE is anchored at both ends", () => {
  // An unanchored /[a-z0-9-]{1,40}/ matches a substring, so "ASK Desk!" would pass on
  // the strength of the "sk" in the middle of it.
  assert.equal(KEY_RE.test("ASK Desk!"), false);
  assert.equal(KEY_RE.test("ask\ndrop"), false);
});

/* -------------------------------------------------------------------------- */
/* cleanOne — one submitted department                                        */
/* -------------------------------------------------------------------------- */

test("cleanOne returns null for a key the regex rejects", () => {
  for (const key of ["student support", "wellbéing", "a".repeat(41), "", "   ", "under_score"]) {
    assert.equal(cleanOne({ key, name: "Something" }), null, `key ${JSON.stringify(key)} should be refused`);
  }
});

test("cleanOne LOWER-CASES before testing, so a typed capital is normalised rather than refused", () => {
  // The distinction matters and is easy to get backwards: KEY_RE.test("ASK") is false,
  // but cleanOne({ key: "ASK" }) is accepted as "ask". The regex is the rule about what
  // may be STORED; cleanOne is the funnel that gets a human's typing there. An
  // administrator typing "ASK" into the key box means the ask desk, and refusing it
  // outright would be a validation message about character classes.
  assert.equal(KEY_RE.test("ASK"), false);
  assert.deepEqual(cleanOne({ key: "ASK", name: "ASK" }), { key: "ask", name: "ASK", active: true });
  assert.equal(cleanOne({ key: "  Student-Support  ", name: "Student Support" }).key, "student-support");
});

test("cleanOne returns null when there is no name", () => {
  // A department with no name renders as a blank row in a queue picker: staff cannot
  // choose it and cannot tell it apart from the next blank one.
  assert.equal(cleanOne({ key: "wellbeing" }), null);
  assert.equal(cleanOne({ key: "wellbeing", name: "" }), null);
  assert.equal(cleanOne({ key: "wellbeing", name: "   " }), null, "a whitespace-only name is not a name");
  assert.equal(cleanOne({ key: "wellbeing", name: 42 }), null, "a number is not a name");
  assert.equal(cleanOne({ key: "wellbeing", name: null }), null);
});

test("cleanOne survives being handed something that is not an object", () => {
  for (const junk of [null, undefined, "wellbeing", 7, [], true]) {
    assert.equal(cleanOne(junk), null, `${JSON.stringify(junk)} should be refused, not thrown on`);
  }
});

test("cleanOne trims the name and caps it at 60 characters", () => {
  assert.equal(cleanOne({ key: "ask", name: "  ASK Desk  " }).name, "ASK Desk");
  assert.equal(cleanOne({ key: "ask", name: "n".repeat(200) }).name.length, 60);
});

test("active defaults to TRUE when the field is absent", () => {
  // A department the college has just added is one it wants to receive referrals. The
  // opposite default would create desks that exist, appear in the config screen, and
  // silently take no work.
  assert.equal(cleanOne({ key: "ask", name: "ASK" }).active, true);
  assert.equal(cleanOne({ key: "ask", name: "ASK", active: undefined }).active, true);
});

test("an explicit active:false SURVIVES — retiring a department is expressible", () => {
  // The retirement flag is the whole difference between "this desk is closed to new
  // referrals" and "this desk never existed". A cleaner that coerced it back to true
  // would make retirement impossible while appearing to save.
  assert.equal(cleanOne({ key: "ask", name: "ASK", active: false }).active, false);
});

test("only the BOOLEAN false retires a department — the string \"false\" leaves it open", () => {
  // Deliberately asymmetric with notifyStudent on a referral, which is `=== true`.
  // Both fail safe, in opposite directions: a truthy-but-not-true value must not start
  // emailing a student, and a falsy-but-not-false value must not silently close a desk
  // the college is still running. Pinned here so the asymmetry is a decision on the
  // record rather than something a later reader "tidies up" into agreement.
  assert.equal(cleanOne({ key: "ask", name: "ASK", active: "false" }).active, true);
  assert.equal(cleanOne({ key: "ask", name: "ASK", active: 0 }).active, true);
  assert.equal(cleanOne({ key: "ask", name: "ASK", active: null }).active, true);
});

test("cleanOne is an ALLOWLIST: fields the client invented are dropped, not stored", () => {
  // sAdmission is the standing cautionary tale — it stripped a fixed list of secrets,
  // so every column added afterwards shipped by default. Here the JSON column has no
  // schema at all, so anything not named is anything at all: an `id` that a later
  // reader mistakes for a relation, or a `members` array that looks like an access
  // control and enforces nothing.
  const cleaned = cleanOne({
    key: "ask", name: "ASK", active: true,
    id: "smuggled", members: ["someone"], isAdmin: true, notes: "case note", __proto__: {},
  });
  assert.deepEqual(Object.keys(cleaned).sort(), ["active", "key", "name"]);
});

/* -------------------------------------------------------------------------- */
/* cleanList — the whole submitted list                                       */
/* -------------------------------------------------------------------------- */

test("cleanList returns NULL for anything that is not an array", () => {
  // Null is the caller's signal to refuse the save ("Send an array of departments."),
  // and it is a different answer from [] — see the next test.
  for (const junk of [null, undefined, "wellbeing", 7, {}, { departments: [] }]) {
    assert.equal(cleanList(junk), null, `${JSON.stringify(junk)} should be null, not a list`);
  }
});

test("an EMPTY array is a real answer, and must not read as \"nothing was sent\"", () => {
  // all() falls back to the platform defaults when the stored value is null and only
  // then. A college that runs no support desks stores [], and collapsing that to null
  // here would resurrect Wellbeing, ASK and Student Support at the next read.
  assert.deepEqual(cleanList([]), []);
  assert.notEqual(cleanList([]), null);
});

test("invalid entries are dropped and the valid ones around them survive", () => {
  const got = cleanList([
    { key: "wellbeing", name: "Wellbeing" },
    { key: "no name here" },
    { key: "ask", name: "" },
    null,
    { key: "careers", name: "Careers" },
  ]);
  assert.deepEqual(got, [
    { key: "wellbeing", name: "Wellbeing", active: true },
    { key: "careers", name: "Careers", active: true },
  ]);
});

test("duplicate keys collapse to the FIRST occurrence, and the first is the one kept", () => {
  // "One of them is dropped" is not the guarantee. Which one survives decides what
  // every existing referral to that key renders as, so it has to be the same answer
  // every time — and first-wins matches the order the administrator sees on screen.
  const got = cleanList([
    { key: "ask", name: "ASK Desk", active: true },
    { key: "ask", name: "Academic Skills Kiosk", active: false },
  ]);
  assert.equal(got.length, 1);
  assert.equal(got[0].name, "ASK Desk", "the SECOND entry won — first-wins has been reversed");
  assert.equal(got[0].active, true, "the second entry's active flag overwrote the first's");
});

test("duplicate detection happens AFTER normalisation, so ASK and ask are the same key", () => {
  // The two would otherwise both be stored, and the second would be permanently
  // unreachable: every queue read, every membership check and every stored referral
  // matches on the lower-cased key alone, so the first one answers for both.
  const got = cleanList([
    { key: "ask", name: "First" },
    { key: "ASK", name: "Second" },
    { key: "  Ask  ", name: "Third" },
  ]);
  assert.equal(got.length, 1);
  assert.equal(got[0].name, "First");
});

test("the list is capped at 50 submitted entries", () => {
  const fifty_five = Array.from({ length: 55 }, (_, i) => ({ key: `dept-${i}`, name: `Dept ${i}` }));
  const got = cleanList(fifty_five);
  assert.equal(got.length, 50);
  assert.equal(got[49].key, "dept-49", "the cap should keep the first 50, not the last 50");
});

test("the cap is applied to what was SUBMITTED, before cleaning", () => {
  // list.slice(0, 50) runs first, so 55 entries whose first five are junk yield 45
  // departments and not 50. Stated here because the alternative reading — "keep
  // cleaning until you have 50 good ones" — is the one somebody will assume.
  const junk = Array.from({ length: 5 }, () => ({ key: "bad key", name: "x" }));
  const good = Array.from({ length: 50 }, (_, i) => ({ key: `dept-${i}`, name: `Dept ${i}` }));
  assert.equal(cleanList([...junk, ...good]).length, 45);
});

test("cleanList drops unknown fields on every entry, not only the first", () => {
  const got = cleanList([
    { key: "a", name: "A", secret: 1 },
    { key: "b", name: "B", secret: 2 },
  ]);
  for (const d of got) assert.deepEqual(Object.keys(d).sort(), ["active", "key", "name"]);
});

test("the platform defaults are themselves valid input to the cleaner", () => {
  // The defaults are handed straight back by all() when no row exists, so anything
  // true of a stored list has to be true of them — otherwise a college that never
  // touched the screen is running on a shape the validator would have refused.
  assert.deepEqual(cleanList(DEFAULTS), DEFAULTS);
});

/* -------------------------------------------------------------------------- */
/* membershipOf / canReadDepartment — pure, and the access control            */
/* -------------------------------------------------------------------------- */

test("a staff row with nothing stored belongs to no department", () => {
  assert.deepEqual(membershipOf({}), []);
  assert.deepEqual(membershipOf({ supportDepartments: null }), []);
  assert.deepEqual(membershipOf(null), []);
});

test("an UNPARSEABLE membership column reads as no membership, never as full membership", () => {
  // Fail closed. A corrupted column is exactly the moment somebody must not silently
  // acquire every wellbeing case note in the college.
  assert.deepEqual(membershipOf({ supportDepartments: "not json" }), []);
  assert.deepEqual(membershipOf({ supportDepartments: "{\"wellbeing\":true}" }), []);
  assert.deepEqual(membershipOf({ supportDepartments: "42" }), []);
});

test("non-string entries inside the array are dropped", () => {
  assert.deepEqual(membershipOf({ supportDepartments: '["wellbeing", 1, null, {"key":"ask"}]' }), ["wellbeing"]);
});

test("canReadDepartment matches case-insensitively on the key it is asked about", () => {
  const staff = { supportDepartments: '["wellbeing"]' };
  assert.equal(canReadDepartment(staff, "wellbeing"), true);
  assert.equal(canReadDepartment(staff, "WELLBEING"), true);
  assert.equal(canReadDepartment(staff, " Wellbeing "), true);
  assert.equal(canReadDepartment(staff, "ask"), false);
});

test("A SUPER ADMIN IS NOT EXEMPT — seniority is not membership", () => {
  // Unlike adminPages, where isSuperAdmin short-circuits everything. Holding every
  // admin page is a statement about administrative authority; being on the wellbeing
  // team is a statement about who reads a student's disclosures. "The most senior
  // account sees every case note by default" is the outcome the confidentiality split
  // exists to prevent, and a Super Admin who needs the queue can join the team
  // visibly, in a column somebody can audit.
  assert.equal(canReadDepartment({ isSuperAdmin: true, accountRole: "ADMIN", adminPages: null }, "wellbeing"), false);
});
