// Reading a date out of a free-text field a human typed.
//
// `Admission.idDateOfExpiry` and its neighbours (`dob`, `idDateOfIssue`, `dateStarted`,
// `declarationDate`) are free text. `admissionFields.pick()` trims and truncates; it
// does not validate a format and never has. The column legitimately holds
// "2027-05-12", "12/05/2027", "May 2027", "see passport", "N/A" and "".
//
// Everywhere else here a date is a YYYY-MM-DD string compared as a string. That is safe
// ONLY because YYYY-MM-DD sorts lexicographically in date order. Applied to typed text,
// the same comparison silently does this against a threshold of "2026-09-01":
//
//     "12/05/2027" >= "2026-09-01"  ->  FALSE   renders as already expired (it is not)
//     "May 2027"   >= "2026-09-01"  ->  TRUE    renders as never expiring (it does)
//
// Two of the three commonest junk values give a FALSE ALL-CLEAR on an immigration date,
// and that is the direction that loses a sponsor licence. The first is merely noisy —
// somebody chases a document that is fine. The second is the one that matters: nobody
// chases a document that expired, because the screen said it had not.
//
// THE GOVERNING RULE
//
//     Return a date ONLY when exactly one date is possible.
//     Every other case is a state a human resolves.
//
// Not "the most likely date". Not "the date under our house convention". Exactly one. A
// parser that guesses is worse than no parser, because a guess arrives wearing the same
// YYYY-MM-DD costume as a fact and nothing downstream can tell them apart.
//
//   "parsed"       exactly one date is possible; `value` is that date
//   "ambiguous"    a full four-digit year is present, so it is recognisably a date, but
//                  the day or the day/month order is undetermined. A human holding the
//                  document settles it in seconds.
//   "unparseable"  no date could be read out of it at all
//
// The line between the last two is the YEAR: an unmistakable year leaves one bounded
// question worth putting to a person; no year means the anchor is missing.
//
// `value` is null for both non-parsed statuses, without exception, so a caller cannot
// accidentally use an answer we were unsure of — there isn't one.
//
// REFUSAL 1: NO DAY-FIRST DEFAULT, EVEN THOUGH THE COLLEGE IS BRITISH.
// "12/05/2027" is 12 May read one way and 5 December the other. Choosing UK because the
// college is in the UK would be right most of the time and produce a SEVEN-MONTH error
// the rest of it, on a date whose whole purpose is to say when a student stops being
// allowed to be here. The value was copied off a passport or a BRP — documents often
// produced in countries that write the month first — by a member of staff whose own
// habit is unknown to us. Nothing in the row resolves it: not the tenant, not the
// nationality fields (a US-issued document is not a US citizen), not the sibling date
// fields, which carry the identical defect.
//
// REFUSAL 2: NO NORMALISING "May 2027" TO A DAY.
// The tempting move is the 31st, as the "safest" reading. It is not safe: it invents up
// to thirty days of validity on an immigration date, so a student whose leave ended on
// the 2nd reads as compliant through the exact window somebody should have stopped them
// attending. The 1st is no better — it invents an expiry that has not happened, sends
// staff chasing a valid document, and teaches them to distrust the field. Both fabricate
// a day nobody wrote down.
//
// REFUSAL 3: NO CENTURY GUESSING, AND NO DATES DUG OUT OF PROSE.
// "12/05/27" gets no year: POSIX pivots at 69, Excel at 29, other libraries elsewhere,
// and this FIELDS list holds both dates of birth (last century) and expiry dates (this
// one), so there is no local reading to appeal to. And "expires 12 May 2027" is refused
// rather than mined — extraction from prose is where a parser starts being confidently
// wrong about text it does not understand, invisibly.
//
// NOT refused: implausible-but-unambiguous dates. "12/05/1927" parses. This module does
// not know which field it is reading, and "is 1927 plausible?" has opposite answers for
// a date of birth and an expiry date. It is also the safe direction — an absurdly early
// date sorts below any threshold and surfaces as something to look at.
//
// This module READS. Nothing here should rewrite the stored text: staff typed those
// strings off documents, and overwriting "12/05/2027" with a parser's opinion destroys
// the only evidence of what was on the card.
const { isRealDate, DATE_RE } = require("./validate");

const STATUS = Object.freeze({ PARSED: "parsed", AMBIGUOUS: "ambiguous", UNPARSEABLE: "unparseable" });

const parsedAs = (value) => ({ value, status: STATUS.PARSED });
const ambiguous = () => ({ value: null, status: STATUS.AMBIGUOUS });
const unparseable = () => ({ value: null, status: STATUS.UNPARSEABLE });

// English months and the abbreviations that actually turn up. Other languages are NOT
// attempted: guessing at "mai" or "maggio" means guessing at the writer's language too,
// and being wrong there would be silent.
const MONTHS = new Map(Object.entries({
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
}));

const iso = (y, m, d) =>
  `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

// The backreference forces one separator throughout, so "12/05-2027" is not quietly
// accepted — a value mixing separators was not typed to any format.
const NUMERIC = /^(\d{1,4})([/.-])(\d{1,4})\2(\d{1,4})$/;
const WORD_PARTS = /[\s,./-]+/;
// Non-breaking, figure and narrow no-break spaces arrive constantly from PDFs and Word
// and are invisible on screen, so without this a date that "obviously" reads fine fails
// for a reason nobody can see.
const ODD_SPACES = /[   ]/g;

/**
 * @param {*} raw anything — this reads columns that were never validated
 * @returns {{value: string|null, status: "parsed"|"ambiguous"|"unparseable"}}
 */
function parseDateText(raw) {
  // A Date stringifies to something a lenient parser would accept, and String({}) gives
  // "[object Object]" which would then be reasoned about.
  if (typeof raw !== "string") return unparseable();

  const text = raw.replace(ODD_SPACES, " ").trim().replace(/\s+/g, " ");
  if (text === "") return unparseable();

  // Shape is not enough: "2027-02-30" matches and V8 rolls it to 2 March rather than
  // refusing. isRealDate is the existing guard, reused so there is ONE definition of a
  // real date in this codebase rather than a second one that drifts.
  if (DATE_RE.test(text)) return isRealDate(text) ? parsedAs(text) : unparseable();

  const num = NUMERIC.exec(text);
  if (num) {
    const [, a, , b, c] = num;

    // Year first. No calendar convention writes year, then day, then month, so a
    // big-endian date has one reading and nothing to report. If it is not a real date
    // it is unparseable — re-reading it in an order nobody uses would be inventing a
    // convention to rescue a typo.
    if (a.length === 4 && b.length <= 2 && c.length <= 2) {
      const s = iso(+a, +b, +c);
      return isRealDate(s) ? parsedAs(s) : unparseable();
    }

    // Year last — the ambiguous shape, and the reason this file exists. Build BOTH
    // readings, keep the ones that are real dates, and let the COUNT decide. The rule
    // in the header is then literally the implementation:
    //   2 dates  "12/05/2027"  both exist                -> ambiguous
    //   1 date   "25/05/2027"  there is no 25th month    -> parsed
    //   1 date   "12/12/2027"  two readings, one date    -> parsed
    //   0 dates  "31/02/2027"  neither is a real date    -> unparseable
    if (c.length === 4 && a.length <= 2 && b.length <= 2) {
      const year = +c;
      const dates = new Set();
      for (const [day, month] of [[+a, +b], [+b, +a]]) {
        const s = iso(year, month, day);
        if (isRealDate(s)) dates.add(s);
      }
      if (dates.size === 1) return parsedAs([...dates][0]);
      if (dates.size > 1) return ambiguous();
      return unparseable();
    }

    // Two-digit years and other numeric junk. RETURNS rather than falling through, so a
    // numeric value gets exactly one verdict and can never be re-read as prose.
    return unparseable();
  }

  // A named month cannot be mistaken for a day, so the ORDER carries no information.
  // Parts are identified by WHAT they are rather than where they sit, which is why
  // "2027 May 12" and the passport form "12-MAY-2027" fall out for free.
  const parts = text.toLowerCase().split(WORD_PARTS).filter(Boolean);
  if (parts.length > 3) return unparseable();

  const monthWords = parts.filter((p) => MONTHS.has(p));
  if (monthWords.length !== 1) return unparseable();
  const month = MONTHS.get(monthWords[0]);

  const rest = parts.filter((p) => !MONTHS.has(p));
  const years = rest.filter((p) => /^\d{4}$/.test(p));
  // "12 May 27" dies here alongside "12/05/27". Two spellings of the same missing
  // century must not get different verdicts, or the status staff see depends on
  // punctuation.
  if (years.length !== 1) return unparseable();

  const others = rest.filter((p) => !/^\d{4}$/.test(p));
  if (others.length === 0) return ambiguous();   // "May 2027" — refusal 2
  if (others.length > 1) return unparseable();

  // An ordinal suffix only ever attaches to a day, so stripping it invents nothing.
  const day = others[0].replace(/(?:st|nd|rd|th)$/, "");
  if (!/^\d{1,2}$/.test(day)) return unparseable();

  const s = iso(+years[0], month, +day);
  return isRealDate(s) ? parsedAs(s) : unparseable();
}

module.exports = { parseDateText, STATUS };
