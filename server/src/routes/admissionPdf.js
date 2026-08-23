// Server-generated PDF downloads for an applicant's application form and offer letter.
//
// These replace a fragile client-side window.open()+print() export, which behaved
// inconsistently across browsers (pop-up blockers, Safari's print quirks). The PDFs
// are built server-side by the same modules the email flow uses, then sent as an
// attachment so every browser (Chrome, Firefox, Safari/Mac, Edge) simply downloads a
// file. Gated on the "admissions" admin page, like routes/admissions.js.
const router = require("express").Router();
const prisma = require("../db");
const { requireAuth, requirePage } = require("../auth");

router.use(requireAuth, requirePage("admissions"));

// Send a Buffer as a downloadable PDF. The filename is sanitised so it can't break
// the Content-Disposition header (quotes, control chars, path separators).
const send = (res, filename, buf) => {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/[^A-Za-z0-9 ._-]/g, "_")}"`);
  res.send(buf);
};

// Applicant's display name, falling back to "Applicant" when both parts are blank.
const nameOf = (a) => [a.firstName, a.surname].filter(Boolean).join(" ") || "Applicant";

// GET /:id/application.pdf — the full application form as a PDF.
router.get("/:id/application.pdf", async (req, res) => {
  const a = await prisma.admission.findUnique({ where: { id: req.params.id } });
  if (!a) return res.status(404).json({ error: "Application not found" });
  try {
    const buf = await require("../applicationPdf").buildApplicationPdf(a);
    send(res, `Application Form - ${nameOf(a)}.pdf`, buf);
  } catch (e) {
    res.status(500).json({ error: e.message || "Could not build the application PDF" });
  }
});

// GET /:id/offer-letter.pdf — the offer letter as a PDF, signed by the Admissions Officer.
router.get("/:id/offer-letter.pdf", async (req, res) => {
  const a = await prisma.admission.findUnique({ where: { id: req.params.id } });
  if (!a) return res.status(404).json({ error: "Application not found" });
  try {
    const buf = await require("../offerLetter").buildOfferLetterPdf(a, {
      inductionDate: a.offerInductionDate || "",
      // Falls through to the institution's own signatory in offerLetter.js rather than
      // naming one college's admissions officer on every other college's letters.
      signatoryName: a.offerSignatoryName || undefined,
      signatoryTitle: "Admissions Officer",
    });
    send(res, `Offer Letter - ${nameOf(a)}.pdf`, buf);
  } catch (e) {
    res.status(500).json({ error: e.message || "Could not build the offer letter PDF" });
  }
});

module.exports = router;
