// Tests for the free-text date reader.
//
// No database, no fixtures, no clock. dateText.js is pure.
//
// Weighted the way the smoke suites are: mostly NEGATIVE. What matters about this
// module is not the dates it produces, it is the dates it REFUSES to produce — the
// failure it exists to prevent is a false all-clear on an immigration date, and a false
// all-clear is a value that looked confident.
//
// Two tests below name the exact wrong answers and assert we do not return them, rather
// than only asserting the status. A test that checks the status alone still passes when
// a guess is returned alongside it, and this codebase has twice shipped a test that
// passed while discriminating nothing.
//
// Run with: node --test src/dateText.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const { parseDateText, STATUS } = require("./dateText");
const { isRealDate } = require("./validate");

const expect = (raw, status, value = null) => {
  const r = parseDateText(raw);
  assert.deepEqual(r, { value, status }, `${JSON.stringify(raw)} -> ${JSON.stringify(r)}`);
};

/* -------------------------------------------------------------------------- */
/* The bug this file exists to prevent                                         */
/* -------------------------------------------------------------------------- */

test("free text compared as a date string gets BOTH answers wrong, one dangerously", () => {
  // Not a test of our code — the defect itself, written down and asserted, so the
  // reason this module exists cannot be lost or argued about later.
  const THRESHOLD = "2026-09-01";

  // A card expiring in May 2027 renders as ALREADY EXPIRED. Noisy but safe.
  assert.equal("12/05/2027" >= THRESHOLD, false);
  // The same card typed the other common way renders as NOT EXPIRED — a false
  // all-clear. Nobody chases it. This is the direction that loses a sponsor licence.
  assert.equal("May 2027" >= THRESHOLD, true);

  // Neither reaches a comparison, because neither is given a value.
  assert.equal(parseDateText("12/05/2027").value, null);
  assert.equal(parseDateText("May 2027").value, null);

  // And what it does return compares correctly, both ways.
  assert.equal(parseDateText("25/05/2027").value >= THRESHOLD, true);
  assert.equal(parseDateText("25/05/2025").value >= THRESHOLD, false);
});

/* -------------------------------------------------------------------------- */
/* Refusal 1 — the day/month order is never assumed                            */
/* -------------------------------------------------------------------------- */

test("REFUSAL: 12/05/2027 yields NO date, under either convention", () => {
  const r = parseDateText("12/05/2027");
  assert.equal(r.status, STATUS.AMBIGUOUS);
  // Both readings named explicitly, so this fails the moment somebody adds a day-first
  // default "because the college is British" — or a month-first one. The gap between
  // them is seven months of leave to remain.
  assert.notEqual(r.value, "2027-05-12", "day-first was assumed");
  assert.notEqual(r.value, "2027-12-05", "month-first was assumed");
  assert.equal(r.value, null);
});

test("a hyphen is not a promise of ISO order", () => {
  expect("12-05-2027", STATUS.AMBIGUOUS);
  expect("12.05.2027", STATUS.AMBIGUOUS);
});

test("a day over 12 resolves itself: only one reading is a real date", () => {
  expect("25/05/2027", STATUS.PARSED, "2027-05-25");
  expect("05/25/2027", STATUS.PARSED, "2027-05-25");
});

test("when both readings give the SAME date there is nothing to resolve", () => {
  // The rule is "exactly one DATE", not "exactly one reading". A version counting
  // readings would call this ambiguous and send a clean date to a human.
  expect("12/12/2027", STATUS.PARSED, "2027-12-12");
});

test("when NEITHER reading is real there is nothing to ask a human either", () => {
  expect("31/02/2027", STATUS.UNPARSEABLE);
  expect("13/13/2027", STATUS.UNPARSEABLE);
});

/* -------------------------------------------------------------------------- */
/* Refusal 2 — a missing day is never invented                                 */
/* -------------------------------------------------------------------------- */

test("REFUSAL: 'May 2027' is NOT normalised to a day", () => {
  const r = parseDateText("May 2027");
  assert.equal(r.status, STATUS.AMBIGUOUS);
  // End-of-month invents up to thirty days of validity on an immigration date;
  // start-of-month invents an expiry that has not happened. Both named, so either
  // addition fails here.
  assert.notEqual(r.value, "2027-05-31", "normalised to the end of the month");
  assert.notEqual(r.value, "2027-05-01", "normalised to the start of the month");
  assert.equal(r.value, null);
});

/* -------------------------------------------------------------------------- */
/* The house format, and month names                                           */
/* -------------------------------------------------------------------------- */

test("a YYYY-MM-DD value passes through unchanged", () => {
  expect("2027-05-12", STATUS.PARSED, "2027-05-12");
  expect("  2027-05-12  ", STATUS.PARSED, "2027-05-12");
});

test("a date-SHAPED string that is not a real date is refused", () => {
  // V8 rolls "2027-02-30" over to 2 March rather than refusing, so a lenient parser
  // returns a real-looking date two days after the one typed.
  expect("2027-02-30", STATUS.UNPARSEABLE);
  expect("2026-02-29", STATUS.UNPARSEABLE);
  expect("2028-02-29", STATUS.PARSED, "2028-02-29");
});

test("a named month cannot be mistaken for a day, so these are unambiguous", () => {
  expect("12 May 2027", STATUS.PARSED, "2027-05-12");
  expect("May 12, 2027", STATUS.PARSED, "2027-05-12");
  expect("12th May 2027", STATUS.PARSED, "2027-05-12");
  expect("12-MAY-2027", STATUS.PARSED, "2027-05-12");
  expect("2027 May 12", STATUS.PARSED, "2027-05-12");
  expect("1 Sept 2027", STATUS.PARSED, "2027-09-01");
});

test("month names we do not recognise are refused, not guessed at", () => {
  expect("12 Mai 2027", STATUS.UNPARSEABLE);
  expect("12 Maggio 2027", STATUS.UNPARSEABLE);
});

/* -------------------------------------------------------------------------- */
/* Refusal 3 — no century guessing, no dates dug out of prose                   */
/* -------------------------------------------------------------------------- */

test("REFUSAL: a two-digit year is unparseable, however written", () => {
  expect("12/05/27", STATUS.UNPARSEABLE);
  expect("12 May 27", STATUS.UNPARSEABLE);
  const r = parseDateText("12/05/27");
  assert.notEqual(r.value, "2027-05-12");
  assert.notEqual(r.value, "1927-05-12");
});

test("a date is not dug out of a sentence", () => {
  expect("expires 12 May 2027", STATUS.UNPARSEABLE);
  expect("valid until 12/05/2027", STATUS.UNPARSEABLE);
});

test("mixed separators are not given the benefit of the doubt", () => {
  expect("12/05-2027", STATUS.UNPARSEABLE);
});

/* -------------------------------------------------------------------------- */
/* What is actually in the column                                              */
/* -------------------------------------------------------------------------- */

test("the real contents of a free-text date field are unparseable, not today and not zero", () => {
  for (const junk of ["N/A", "n/a", "see passport", "unknown", "-", "TBC", "", "   "]) {
    expect(junk, STATUS.UNPARSEABLE);
  }
});

test("non-strings are refused before anything is stringified", () => {
  for (const notText of [null, undefined, 0, 20270512, NaN, true, {}, [], new Date("2027-05-12")]) {
    expect(notText, STATUS.UNPARSEABLE);
  }
});

/* -------------------------------------------------------------------------- */
/* Invariants every caller may rely on                                         */
/* -------------------------------------------------------------------------- */

const CORPUS = [
  "2027-05-12", "2027-02-30", "2028-02-29", "2027/05/12", "2027/13/05",
  "12/05/2027", "12-05-2027", "25/05/2027", "05/25/2027", "12/12/2027",
  "31/02/2027", "12/05/27", "12 May 2027", "May 12, 2027", "12-MAY-2027",
  "May 2027", "May", "12 May", "31 February 2027", "12 Mai 2027", "expires 12 May 2027",
  "N/A", "see passport", "", "   ", null, undefined, 20270512, {}, [], new Date(),
];

test("value is non-null if and ONLY if the status is parsed", () => {
  // The invariant that makes an uncertain answer impossible to misuse: there is no
  // value to misuse. Over the corpus rather than case by case, so a future branch
  // returning a "best effort" alongside a hedged status is caught even if nobody adds
  // a test for it.
  for (const raw of CORPUS) {
    const r = parseDateText(raw);
    assert.equal(r.value !== null, r.status === STATUS.PARSED, `${JSON.stringify(raw)} -> ${JSON.stringify(r)}`);
  }
});

test("every value returned is a real YYYY-MM-DD date", () => {
  // Which is what makes string comparison safe again downstream — the entire point.
  for (const raw of CORPUS) {
    const { value } = parseDateText(raw);
    if (value !== null) assert.ok(isRealDate(value), `${JSON.stringify(raw)} -> ${value}`);
  }
});

test("parsing is a pure function of the text: same input, same answer", () => {
  // A parser with a cache or a "last seen convention" could resolve 12/05/2027 from
  // whatever it saw before — the day-first assumption wearing a disguise.
  for (const raw of CORPUS) {
    assert.deepEqual(parseDateText(raw), parseDateText(raw));
  }
});
