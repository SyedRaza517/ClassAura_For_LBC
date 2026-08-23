// Builds a printable copy of an applicant's HND application form as a multi-page A4 PDF,
// returned as an in-memory Buffer. This is the record an admin drops into the student's
// SharePoint folder at enrolment, so it needs to be a faithful, readable dump of every
// answer the applicant gave — grouped into the same sections as the paper/online form.
//
// The `admission` record is treated as untrusted: any field may be null/undefined/blank.
// Each value is coalesced to "" then shown as "—" when empty, so a half-complete record
// still produces a valid PDF rather than printing "undefined" or throwing.
//
// We keep to pdfkit's built-in "standard 14" fonts (Helvetica / Helvetica-Bold) so there
// are no font files to resolve at runtime.
const PDFDocument = require("pdfkit");

// Brand palette. NAVY is the wordmark + section titles; MAROON the eyebrow accent;
// BLUE the emblem's royal blue. LABEL is the dark-grey field label; VALUE near-black
// body text; GREY the small-print footer; RULE the hairline colour.
const BLUE = "#1e40af";
const NAVY = "#1a3a8f";
const MAROON = "#9e1b32";
const LABEL = "#334155";
const VALUE = "#0f172a";
const GREY = "#64748b";
const RULE = "#c7ccd6";

// A4 page geometry in PostScript points (72pt = 1in).
const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN = 50;
const CONTENT_WIDTH = A4_WIDTH - MARGIN * 2;
const RIGHT = A4_WIDTH - MARGIN;

// The form, grouped into sections. Each section is [title, [[key, label], ...]] and the
// value for a field is read from admission[key]. Order and labelling mirror the form.
const SECTIONS = [
  ["Course & Personal Details", [
    ["course", "Course"],
    ["intake", "Intake"],
    ["intakeYear", "Intake year"],
    ["foundVia", "How they found us"],
    ["classOption", "Class option"],
    ["firstName", "First name"],
    ["middleName", "Middle name"],
    ["surname", "Surname"],
    ["dob", "Date of birth"],
    ["gender", "Gender"],
    ["email", "Email"],
    ["phone", "Phone"],
    ["countryOfBirth", "Country of birth"],
    ["countryOfCitizenship", "Country of citizenship"],
    ["idDocNo", "ID document no."],
    ["idDateOfIssue", "ID issue date"],
    ["idDateOfExpiry", "ID expiry date"],
    ["idIssuingCountry", "ID issuing country"],
    ["niNumber", "National Insurance no."],
  ]],
  ["Home Address & Emergency Contact", [
    ["houseNo", "House/Flat no"],
    ["street", "Street"],
    ["city", "City"],
    ["postCode", "Post code"],
    ["mailingAddress", "Mailing address"],
    ["emergencyName", "Emergency contact name"],
    ["emergencyPhone", "Emergency contact phone"],
    ["emergencyRelationship", "Emergency contact relationship"],
    ["emergencyEmail", "Emergency contact email"],
  ]],
  ["Criminal Record", [
    ["criminalConviction", "Criminal conviction?"],
    ["criminalDetails", "Details"],
  ]],
  ["Disabilities & Support", [
    ["medicalConditions", "Medical conditions?"],
    ["medicalDetails", "Details"],
    ["learningDifficulty", "Learning difficulty?"],
    ["learningDetails", "Details"],
  ]],
  ["Education & Employment", [
    ["englishFirstLanguage", "English first language?"],
    ["englishProof", "English proof"],
    ["englishProofOther", "English proof (other)"],
    ["highestEducation", "Highest education"],
    ["overseasQualification", "Overseas qualification"],
    ["appliedElsewhere", "Applied elsewhere?"],
    ["previousStudentFinance", "Previous student finance?"],
    ["previousFinanceDetails", "Details"],
    ["fundingIntent", "Funding intent"],
    ["fundingOther", "Funding (other)"],
    ["employmentStatus", "Employment status"],
    ["employmentDetails", "Employment details"],
    ["jobTitle", "Job title"],
    ["companyName", "Company"],
    ["dateStarted", "Date started"],
    ["workedPast", "Worked in past?"],
    ["workedPastDetails", "Details"],
  ]],
  ["Reference 1", [
    ["ref1Name", "Name"],
    ["ref1Contact", "Contact"],
    ["ref1Email", "Email"],
    ["ref1Relationship", "Relationship"],
  ]],
  ["Reference 2", [
    ["ref2Name", "Name"],
    ["ref2Role", "Role"],
    ["ref2Organisation", "Organisation"],
    ["ref2Relationship", "Relationship"],
  ]],
  ["Equality & Diversity", [
    ["ethnicity", "Ethnicity"],
    ["religion", "Religion"],
  ]],
  ["Declaration", [
    ["signature", "Signature"],
    ["declarationDate", "Date"],
  ]],
];

// Coalesce any field to a trimmed string, then to "—" when blank so an empty answer
// reads as "not provided" rather than a gap (and "undefined"/"null" never print).
const show = (v) => {
  const s = (v === null || v === undefined) ? "" : String(v).trim();
  return s === "" ? "—" : s;
};

/**
 * Build the application-form PDF.
 *
 * @param {object} admission - the applicant record; any field may be absent.
 * @returns {Promise<Buffer>} the finished multi-page A4 PDF.
 */
async function buildApplicationPdf(admission = {}) {
  return new Promise((resolve, reject) => {
    try {
      const a = admission || {};
      const firstName = String(a.firstName || "").trim();
      const surname = String(a.surname || "").trim();
      const fullName = `${firstName} ${surname}`.trim() || "Applicant";
      const course = String(a.course || "").trim();
      const intake = String(a.intake || "").trim();

      // Set up the document and capture its bytes into a Buffer.
      const doc = new PDFDocument({ size: "A4", margin: MARGIN });
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // ---- Vector emblem (the app's fanlight <BrandMark>), drawn at (x,y), w wide ----
      const drawEmblem = (x, y, w) => {
        const s = w / 100;
        const cx = 50, by = 52, R = 46, rO = 39.5, rI = 13.5, N = 6;
        const arc = (r) => `M ${cx - r} ${by} A ${r} ${r} 0 0 1 ${cx + r} ${by}`;
        const angles = Array.from({ length: N }, (_, i) => ((i + 1) * 180) / (N + 1));
        const pt = (r, deg) => {
          const t = (deg * Math.PI) / 180;
          return [cx + r * Math.cos(t), by - r * Math.sin(t)];
        };
        doc.save();
        doc.translate(x, y).scale(s);
        doc.path(`${arc(R)} Z`).fill(BLUE);
        doc.lineWidth(2.6).strokeColor("#ffffff").lineCap("round").lineJoin("round");
        doc.path(arc(rO)).stroke();
        doc.path(arc(rI)).stroke();
        angles.forEach((deg) => {
          const [ix, iy] = pt(rI, deg), [ox, oy] = pt(rO, deg);
          doc.moveTo(ix, iy).lineTo(ox, oy).stroke();
        });
        doc.restore();
      };

      // ---- First-page brand band ----------------------------------------------
      drawEmblem(MARGIN, 40, 40);
      const bx = MARGIN + 52;
      doc.font("Helvetica-Bold").fontSize(8).fillColor(MAROON)
        .text("HND APPLICATION FORM", bx, 42, { characterSpacing: 2, lineBreak: false });
      doc.font("Helvetica-Bold").fontSize(18).fillColor(NAVY)
        .text("EdTech", bx, 54, { lineBreak: false });

      // Applicant identity beneath the wordmark.
      doc.font("Helvetica-Bold").fontSize(13).fillColor(VALUE)
        .text(fullName, MARGIN, 92, { width: CONTENT_WIDTH, lineBreak: false });
      const meta = [course, intake].filter(Boolean).join("  ·  ");
      if (meta) {
        doc.font("Helvetica").fontSize(10).fillColor(GREY)
          .text(meta, MARGIN, 111, { width: CONTENT_WIDTH, lineBreak: false });
      }

      // Thin rule under the header.
      const ruleY = meta ? 130 : 116;
      doc.moveTo(MARGIN, ruleY).lineTo(RIGHT, ruleY).lineWidth(1).strokeColor(NAVY).stroke();

      doc.x = MARGIN;
      doc.y = ruleY + 16;

      // ---- Section + field rendering ------------------------------------------
      const BOTTOM = A4_HEIGHT - MARGIN;

      // Start a section: keep the title with at least its first row (no orphan header
      // stranded at the foot of a page).
      const sectionTitle = (title) => {
        if (doc.y > BOTTOM - 48) doc.addPage();
        doc.font("Helvetica-Bold").fontSize(12).fillColor(NAVY)
          .text(title, MARGIN, doc.y, { width: CONTENT_WIDTH });
        doc.y += 3;
        doc.moveTo(MARGIN, doc.y).lineTo(RIGHT, doc.y).lineWidth(0.6).strokeColor(RULE).stroke();
        doc.y += 6;
      };

      // One field row: bold label, then the value inline on the same run so a long
      // (textarea) value wraps naturally under it.
      const fieldRow = (label, value) => {
        if (doc.y > BOTTOM - 14) doc.addPage();
        doc.font("Helvetica-Bold").fontSize(9.5).fillColor(LABEL)
          .text(`${label}:  `, MARGIN, doc.y, { width: CONTENT_WIDTH, continued: true, lineGap: 1 });
        doc.font("Helvetica").fontSize(9.5).fillColor(VALUE).text(show(value));
        doc.y += 3;
      };

      SECTIONS.forEach(([title, fields], i) => {
        if (i > 0) doc.y += 8;
        sectionTitle(title);
        fields.forEach(([key, label]) => fieldRow(label, a[key]));
      });

      // ---- Footer address on the final page -----------------------------------
      if (doc.y > BOTTOM - 24) doc.addPage();
      doc.font("Helvetica").fontSize(7.5).fillColor(GREY)
        .text(
          "EdTech · 42 The Burroughs, Hendon, London NW4 4AP · info@edtech.co.uk · www.edtech.co.uk",
          MARGIN, BOTTOM - 12, { width: CONTENT_WIDTH, align: "center", lineBreak: false }
        );

      // Finalise — flushes the last chunk and triggers the "end" event above.
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { buildApplicationPdf };
