// Filling a college's OWN document template.
//
// WHY NOTHING HERE REDRAWS THE PAGE
//
// The offer letter used to be drawn from scratch by pdfkit, which meant every
// institution's letter was the one college the code was written for: its typography,
// its margins, its registered-office footer. A college cannot be asked to abandon its
// letterhead because of how the software draws.
//
// The obvious fix — read their design and recreate it — is the wrong one, and it is
// worth saying why: it cannot be exact. Fonts get substituted, kerning shifts, an
// embedded crest is resampled, and the result is a letter that looks *nearly* like
// theirs, which for a document a student receives from their college is worse than
// obviously different.
//
// So their PDF is not read for its design at all. It is loaded and used AS the page,
// and the applicant's details are written on top. Nothing is re-typeset, so nothing
// can drift: every pixel the college drew is the pixel that comes out.
//
// Positions are stored as a PERCENTAGE of page width and height rather than in
// points, so a template re-exported at a different paper size still puts the name in
// the right place instead of off the edge.
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

// The values a college may place on a letter. Named and described here because this
// list is also what the positioning editor offers, and two copies of it would drift.
const FIELDS = {
  offer: [
    { key: "firstName", label: "Applicant first name", sample: "Amina" },
    { key: "lastName", label: "Applicant surname", sample: "Hassan" },
    { key: "fullName", label: "Applicant full name", sample: "Amina Hassan" },
    { key: "course", label: "Course", sample: "HND Business" },
    { key: "intake", label: "Intake", sample: "September" },
    { key: "intakeYear", label: "Intake year", sample: "2026" },
    { key: "inductionDate", label: "Induction date", sample: "14 September 2026" },
    { key: "reportTime", label: "Arrival time", sample: "09:45 AM" },
    { key: "sessionTime", label: "Session start", sample: "10:00 AM" },
    { key: "signatoryName", label: "Signed by", sample: "Dr Helen Whitfield" },
    { key: "signatoryTitle", label: "Signatory title", sample: "Head of Admissions" },
    { key: "today", label: "Today's date", sample: "23 August 2026" },
    { key: "reference", label: "Application reference", sample: "APP-100121" },
  ],
  application: [
    { key: "fullName", label: "Applicant full name", sample: "Amina Hassan" },
    { key: "email", label: "Email", sample: "amina@example.com" },
    { key: "phone", label: "Phone", sample: "+44 7700 900123" },
    { key: "course", label: "Course", sample: "HND Business" },
    { key: "intake", label: "Intake", sample: "September" },
    { key: "intakeYear", label: "Intake year", sample: "2026" },
    { key: "dob", label: "Date of birth", sample: "4 March 2004" },
    { key: "address", label: "Address", sample: "14 Chapel Street, Manchester" },
    { key: "today", label: "Today's date", sample: "23 August 2026" },
    { key: "reference", label: "Application reference", sample: "APP-100121" },
  ],
};

const MAX_PDF_BYTES = 5 * 1024 * 1024;

/** Parse the stored field list, tolerating anything malformed rather than throwing
 *  mid-letter: a broken position must not stop an offer going out. */
function parseFields(json) {
  let list;
  try { list = JSON.parse(json || "[]"); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.filter((f) => f && typeof f.key === "string"
    && Number.isFinite(Number(f.xPct)) && Number.isFinite(Number(f.yPct)));
}

const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0));

/**
 * Write `values` onto `pdfBytes` at the positions in `fields`.
 *
 * @returns {Promise<Buffer>} the college's own PDF, with the values on it.
 */
async function fill(pdfBytes, fields, values) {
  const doc = await PDFDocument.load(pdfBytes);
  const pages = doc.getPages();

  // The standard-14 fonts, which every PDF reader has. A college's own typeface is
  // already in their page; this is only for the values written on top, and embedding
  // an arbitrary uploaded font is a much larger surface than it is worth here.
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  for (const f of parseFields(fields)) {
    const raw = values[f.key];
    // A field with no value is SKIPPED, not printed as "undefined" or left as a
    // visible placeholder. A letter missing an optional line reads as a letter; one
    // saying "undefined" reads as broken software.
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;

    const idx = Math.max(0, Math.min(pages.length - 1, Number(f.page || 0)));
    const page = pages[idx];
    const { width, height } = page.getSize();

    const text = String(raw);
    const size = Math.max(4, Math.min(72, Number(f.size) || 11));
    const font = f.bold ? bold : regular;

    // yPct is measured from the TOP in the editor, because that is how a person reads
    // a page; PDF's origin is bottom-left. Converting here keeps the editor honest.
    const x0 = clamp01(f.xPct) * width;
    const y = height - clamp01(f.yPct) * height - size;

    let x = x0;
    if (f.align === "center" || f.align === "right") {
      const w = font.widthOfTextAtSize(text, size);
      x = f.align === "center" ? x0 - w / 2 : x0 - w;
    }

    let colour = rgb(0, 0, 0);
    const m = /^#?([0-9a-f]{6})$/i.exec(String(f.colour || ""));
    if (m) {
      const n = parseInt(m[1], 16);
      colour = rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
    }

    page.drawText(text, { x, y, size, font, color: colour });
  }

  return Buffer.from(await doc.save());
}

/** Page count and size, for the positioning editor. Also validates that what was
 *  uploaded is a PDF at all, before it is ever stored. */
async function inspect(pdfBytes) {
  const doc = await PDFDocument.load(pdfBytes);
  const pages = doc.getPages();
  return {
    pages: pages.length,
    sizes: pages.map((p) => { const { width, height } = p.getSize(); return { width, height }; }),
  };
}

/** A preview using the sample values, so a college can see its own letter filled in
 *  before an applicant does. */
async function preview(pdfBytes, fields, kind) {
  const samples = {};
  for (const f of FIELDS[kind] || []) samples[f.key] = f.sample;
  return fill(pdfBytes, fields, samples);
}

module.exports = { fill, inspect, preview, parseFields, FIELDS, MAX_PDF_BYTES };
