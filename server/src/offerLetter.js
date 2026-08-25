// Builds the "unconditional offer" letter that Admissions sends to a successful HND
// applicant, rendered as an A4 PDF and returned as an in-memory Buffer.
//
// The letter is a faithful copy of the printed EdTech offer template: the branded
// letterhead, the "Congratulations" headline, the offer body (First Day + Accept Your
// Place), the "Your journey starts here." line, and the sign-off.
//
// PAGE COUNT IS NOT FIXED. Everything flows, and the footer's own height is reserved as
// the bottom margin on every page, so the body can never run through the small print —
// which it previously did: a full BTEC qualification title pushed the closing line to
// y=767 while the footer rule sat at y=743. Most letters come out as a single page; a
// long qualification title or a long institution address spills to a second, carrying
// the same letterhead and footer. The sign-off moves as one block rather than leaving a
// name on one page and its job title on the next.
//
// The letterhead logo is the college's fanlight emblem, recreated here as vector paths
// (the same geometry as the app's <BrandMark>) so there are no image files to ship or
// resolve at runtime.
//
// Everything that varies per applicant (name, course, intake) comes from the
// `admission` record; everything that varies per send (induction date, arrival/start
// times, who signs it) comes from `opts`. Both objects are treated as untrusted —
// every field can be missing, and each falls back to a sane default or is simply
// omitted so a half-complete record still produces a valid PDF rather than throwing.
//
// We keep to pdfkit's built-in PDF "standard 14" fonts (Times-Roman / Times-Bold /
// Times-Italic / Times-BoldItalic / Helvetica) so there are no font files to resolve.
const PDFDocument = require("pdfkit");

// Brand palette. BLUE is the emblem's royal blue; NAVY the wordmark; MAROON the
// "COLLEGE" line and link accents; INK the body text; GREY the small-print footer.
const BLUE = "#1e40af";
const NAVY = "#1a3a8f";
const MAROON = "#9e1b32";
const INK = "#000000";
const GREY = "#555f6d";

// A4 page geometry in PostScript points (72pt = 1in). The printable content width is
// computed once so every block and rule lines up on the same left/right edges.
const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN = 56;
const CONTENT_WIDTH = A4_WIDTH - MARGIN * 2;
const RIGHT = A4_WIDTH - MARGIN;

// Body copy point size.
const BODY_SIZE = 11;

/**
 * Build the offer letter as a PDF.
 *
 * @param {object} admission - the applicant record; any field may be absent:
 *        firstName, surname, course, intake, intakeYear.
 * @param {object} opts - per-send overrides: inductionDate, reportTime, sessionTime,
 *        signatoryName, signatoryTitle. Missing values fall back to the defaults below.
 * @returns {Promise<Buffer>} the finished A4 PDF — one page, or two when the
 *          content does not fit.
 */
async function buildBuiltInOfferLetter(admission = {}, opts = {}) {
  // Resolved BEFORE the Promise: the body below is synchronous (pdfkit draws in one
  // pass), so branding cannot be awaited inside it. Falling back to an empty object
  // keeps this working outside a request — a script, a test — where there is no
  // institution to resolve.
  let brand = {};
  try { brand = await require("./branding").get(); } catch { brand = {}; }
  return new Promise((resolve, reject) => {
    try {
      // ---- Normalise the applicant fields -------------------------------------
      // Trim everything and coalesce to "" so a null/undefined never reaches pdfkit
      // (which would otherwise print the literal word "undefined").
      const a = admission || {};
      const firstName = String(a.firstName || "").trim();
      const course = String(a.course || "").trim();
      const intake = String(a.intake || "").trim();
      const intakeYear = String(a.intakeYear || "").trim();

      // "[MONTH YEAR] INTAKE" — built from whatever intake parts we have, upper-cased
      // to match the template. Omitted entirely if we know neither month nor year.
      const intakeParts = [intake, intakeYear].filter(Boolean).join(" ");
      const intakeLine = intakeParts ? `${intakeParts} INTAKE`.toUpperCase() : "";

      // ---- Normalise the per-send options, applying the documented defaults -----
      const o = opts || {};
      const inductionDate = String(o.inductionDate || "");
      const reportTime = String(o.reportTime || "09:45 AM");
      const sessionTime = String(o.sessionTime || "10:00 AM");
      const signatoryName = String(o.signatoryName || brand.signatoryName || "");
      const signatoryTitle = String(o.signatoryTitle || brand.signatoryTitle || "");

      // ---- Set up the document and capture its bytes into a Buffer --------------
      // bufferPages, because the footer is drawn on every page AFTER the body has been
      // laid out — we cannot know how many pages there are until the text has flowed.
      const doc = new PDFDocument({ size: "A4", margin: MARGIN, bufferPages: true });
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // ===== Reusable letterhead ================================================
      // The fanlight emblem, drawn in its native 100×58 space and scaled to `w` wide.
      // This is the exact geometry of the app's <BrandMark>: a filled blue half-disc
      // with a white fanlight (outer ring, inner ring, and six radial spokes).
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
        doc.path(`${arc(R)} Z`).fill(BLUE);                       // filled blue dome
        doc.lineWidth(2.6).strokeColor("#ffffff").lineCap("round").lineJoin("round");
        doc.path(arc(rO)).stroke();                                // outer fanlight ring
        doc.path(arc(rI)).stroke();                                // inner ring
        angles.forEach((deg) => {                                  // radial spokes
          const [ix, iy] = pt(rI, deg), [ox, oy] = pt(rO, deg);
          doc.moveTo(ix, iy).lineTo(ox, oy).stroke();
        });
        doc.restore();
      };

      // The full letterhead: emblem + two-line wordmark on the left, italic tagline on
      // the right, and a navy rule beneath. Drawn identically at the top of every page.
      const drawHeader = () => {
        drawEmblem(MARGIN, 40, 44);
        doc.font("Times-Bold").fontSize(18).fillColor(NAVY)
          .text("EDTECH", MARGIN, 70, { lineBreak: false });
        doc.font("Times-Bold").fontSize(9.5).fillColor(MAROON)
          .text("COLLEGE", MARGIN, 91, { characterSpacing: 4, lineBreak: false });
        doc.font("Times-BoldItalic").fontSize(9).fillColor("#333333")
          .text("YOUR SUCCESS; OUR GOAL", MARGIN, 56, { width: CONTENT_WIDTH, align: "right" });
        doc.moveTo(MARGIN, 110).lineTo(RIGHT, 110).lineWidth(1.5).strokeColor(NAVY).stroke();
      };

      // The company small-print footer, with a hairline rule above it, pinned near the
      // foot of the current page. Drawn identically on every page.
      const FOOTER_LINES = [
        brand.legalFooter || "",
        "Tel: 0208 202 2007 | Fax: 0208 202 2047",
        [brand.contactEmail ? "email: " + brand.contactEmail : "", brand.website ? "website: " + brand.website : ""].filter(Boolean).join(" | "),
        "ISI No: 482 - Dfes No: 23278- SLN No: GNVKF0HT9",
      ];
      const FOOTER_OPTS = { width: CONTENT_WIDTH, align: "center", lineGap: 1.5 };

      // Where the footer's hairline rule sits — and therefore the lowest the body may go.
      //
      // Measured rather than assumed, because the height depends on the institution: a
      // long legal footer wraps to two lines and pushes the rule up. Body text must stop
      // above this, which is why it becomes the bottom margin below.
      const footerRuleY = () => {
        doc.font("Helvetica").fontSize(8);
        const h = FOOTER_LINES.reduce((acc, t) => acc + doc.heightOfString(t, FOOTER_OPTS), 0);
        return A4_HEIGHT - 44 - h - 12;
      };

      const drawFooter = () => {
        doc.page.margins.bottom = 0; // stop pdfkit spilling this low block onto a new page
        const ruleY = footerRuleY();
        doc.moveTo(MARGIN, ruleY).lineTo(RIGHT, ruleY).lineWidth(0.8).strokeColor("#c7ccd6").stroke();
        doc.font("Helvetica").fontSize(8).fillColor(GREY);
        let fy = ruleY + 12;
        FOOTER_LINES.forEach((t) => { doc.text(t, MARGIN, fy, FOOTER_OPTS); fy = doc.y + 1.5; });
      };

      // ===== Text helpers =======================================================
      // A paragraph of one or more inline runs. Each run is [text, font?, runOpts?]
      // where runOpts may carry { color, underline }. Runs flow inline (bold spans
      // inside a sentence) and wrap as one block; `gapAfter` adds trailing space.
      const para = (runs, opts2 = {}) => {
        const size = opts2.size || BODY_SIZE;
        const baseColor = opts2.color || INK;
        const lineGap = opts2.lineGap != null ? opts2.lineGap : 3;
        const gapAfter = opts2.gapAfter != null ? opts2.gapAfter : 10;
        const align = opts2.align || "left";
        doc.x = MARGIN;
        const y0 = doc.y;
        runs.forEach((run, i) => {
          const [text, font = "Times-Roman", ro = {}] = run;
          const last = i === runs.length - 1;
          doc.font(font).fontSize(size).fillColor(ro.color || baseColor);
          const common = { continued: !last, underline: !!ro.underline };
          if (i === 0) doc.text(text, MARGIN, y0, { width: CONTENT_WIDTH, align, lineGap, ...common });
          else doc.text(text, common);
        });
        doc.y += gapAfter;
      };
      // A single-run heading line — a thin wrapper over para for readability.
      const head = (text, size, opts2 = {}) =>
        para([[text, opts2.font || "Times-Bold", { color: opts2.color || INK }]], { size, gapAfter: opts2.gapAfter, lineGap: 1 });

      // ===== The letter =========================================================
      // Reserve the footer's own space at the foot of every page. pdfkit breaks a page
      // when text would cross the bottom margin, so a long qualification title can no
      // longer push body text down through the small print — which is what happened
      // before: with a full BTEC title the body ran to y=767 while the footer rule sat
      // at y=743, and the closing line overprinted the footer.
      const RESERVE_BOTTOM = A4_HEIGHT - footerRuleY() + 10;

      // Every page carries the same letterhead and starts the body at the same height,
      // including a page pdfkit adds by itself mid-paragraph. Margins are re-applied
      // per page because a new page inherits the document's original options, not the
      // margins we set on the page before it.
      const startPage = () => {
        doc.page.margins.bottom = RESERVE_BOTTOM;
        drawHeader();
        doc.x = MARGIN;
        doc.y = 128;
      };
      doc.on("pageAdded", startPage);
      startPage();

      // Headline + offer type.
      head(firstName ? `CONGRATULATIONS, ${firstName.toUpperCase()}!` : "CONGRATULATIONS!", 22, { gapAfter: 6 });
      head("UNCONDITIONAL OFFER", 16, { gapAfter: 10 });

      // Qualification title + intake (bold), each omitted if unknown.
      if (course) head(course, 11.5, { gapAfter: intakeLine ? 3 : 14 });
      if (intakeLine) head(intakeLine, 11.5, { gapAfter: 12 });

      // Salutation.
      para([[`Dear ${firstName || "Applicant"},`]], { gapAfter: 10 });

      // Opening two paragraphs.
      para([
        ["We are delighted to confirm that your application to "],
        [(brand.displayName || "the College") + " has been successful", "Times-Bold"],
        ["."],
      ], { gapAfter: 8 });
      para([
        ["Following a review of your application, you have met the required entry criteria and we are pleased to offer you an "],
        ["unconditional place", "Times-Bold"],
        [" on the programme above."],
      ], { gapAfter: 12 });

      // ---- Your First Day ----
      head("YOUR FIRST DAY", 12.5, { gapAfter: 6 });
      // Only show the Induction line when a date was set. An empty final run leaves the
      // line un-finalised in pdfkit, so the next line (Arrival/Start) overprints it.
      if (inductionDate) para([["Induction: ", "Times-Bold"], [inductionDate, "Times-Roman"]], { gapAfter: 3 });
      para([
        ["Arrival: ", "Times-Bold"], [reportTime, "Times-Roman"],
        ["  |  ", "Times-Roman"],
        ["Start: ", "Times-Bold"], [sessionTime, "Times-Roman"],
      ], { gapAfter: 3 });
      // The venue line is the institution's own address when it has one; without it the
      // line would read "Location:" followed by nothing, so it is omitted entirely.
      if (brand.displayName || brand.addressLines) {
        para([["Location: ", "Times-Bold"], [[brand.displayName, brand.addressLines].filter(Boolean).join(", "), "Times-Roman"]], { gapAfter: 8 });
      }
      para([
        ["Attendance at induction is required to complete your enrolment. During the session, you will receive your "],
        ["timetable, student ID card, programme information", "Times-Bold"],
        [" and guidance on the resources and support available to you."],
      ], { gapAfter: 12 });

      // ---- Accept Your Place ----
      head("ACCEPT YOUR PLACE", 12.5, { gapAfter: 6 });
      para([
        ["To confirm your place, simply "],
        ["reply to the email containing this offer and confirm that you accept your offer of admission", "Times-Bold"],
        ["."],
      ], { gapAfter: 8 });
      para([["If you have any questions before joining us, please contact our Admissions Team:"]], { gapAfter: 5 });
      para([
        [brand.contactEmail || "", "Times-Bold", { color: NAVY, underline: true }],
        ["  |  ", "Times-Roman"],
        [brand.contactPhone || "", "Times-Bold"],
      ], { gapAfter: 10 });
      para([["We are excited to welcome you to " + (brand.displayName || "the College") + " and look forward to supporting you throughout your studies."]], { gapAfter: 14 });

      // Closing line.
      head("YOUR JOURNEY STARTS HERE.", 16, { gapAfter: 16 });

      // ---- Sign-off ----
      // It travels as one block: a name on one page with its job title on the next
      // reads as a mistake, so it is measured first and moved whole if it will not fit.
      // Most letters therefore come out as a single page, and only a long qualification
      // title or a long institution address pushes it to two.
      doc.font("Times-Roman").fontSize(BODY_SIZE);
      const lineH = doc.heightOfString("Ag", { width: CONTENT_WIDTH, lineGap: 3 });
      const signOffHeight = 26 + lineH * (brand.displayName ? 4 : 3) + 4;
      if (doc.y + signOffHeight > footerRuleY() - 10) doc.addPage();

      para([["Yours sincerely,"]], { gapAfter: 26 });
      para([[signatoryName, "Times-Bold"]], { gapAfter: 2 });
      para([[signatoryTitle, "Times-Roman"]], { gapAfter: 2 });
      if (brand.displayName) para([[brand.displayName, "Times-Bold"]], { gapAfter: 0 });


      // The footer goes on every page — drawn only now, because until the body has
      // finished flowing we do not know how many pages there are.
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        drawFooter();
      }
      doc.flushPages();

      // Finalise — flushes the last chunk and triggers the "end" event above.
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * The offer letter.
 *
 * If this institution has uploaded and switched on its OWN letter, the applicant's
 * details are written onto THAT document and it is returned unchanged in every other
 * respect — see docTemplate.js for why it is never redrawn. Otherwise the built-in
 * letter below is produced exactly as before.
 *
 * A template that fails for any reason falls back to the built-in letter rather than
 * failing the send. An offer that goes out on the wrong stationery is a complaint; an
 * offer that does not go out at all is a lost student.
 */
async function buildOfferLetterPdf(admission = {}, opts = {}) {
  try {
    const prisma = require("./db");
    const row = await prisma.tenantDocTemplate.findFirst({ where: { kind: "offer" } });
    if (row && row.enabled && row.pdf) {
      const dt = require("./docTemplate");
      const branding = await require("./branding").get();
      const a = admission || {};
      const first = String(a.firstName || "").trim();
      const last = String(a.surname || a.lastName || "").trim();
      const values = {
        firstName: first,
        lastName: last,
        fullName: [first, last].filter(Boolean).join(" "),
        course: String(a.course || "").trim(),
        intake: String(a.intake || "").trim(),
        intakeYear: String(a.intakeYear || "").trim(),
        inductionDate: String(opts.inductionDate || ""),
        reportTime: String(opts.reportTime || "09:45 AM"),
        sessionTime: String(opts.sessionTime || "10:00 AM"),
        // The signatory comes from the college's own branding, not from a name
        // hardcoded in this file.
        signatoryName: String(opts.signatoryName || branding.signatoryName || ""),
        signatoryTitle: String(opts.signatoryTitle || branding.signatoryTitle || ""),
        today: new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
        reference: String(a.reference || a.id || ""),
      };
      return await dt.fill(Buffer.from(row.pdf), row.fields, values);
    }
  } catch (e) {
    console.error("[offer-letter] template failed, using the built-in letter:", e.message);
  }
  return buildBuiltInOfferLetter(admission, opts);
}

module.exports = { buildOfferLetterPdf, buildBuiltInOfferLetter };
