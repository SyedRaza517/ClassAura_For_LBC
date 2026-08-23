// Admissions — the college's HND application form, entered and managed by an admin.
//
// One row per applicant. Every field is free text so the form can change without a
// migration; the admin fills in what the paper/online application gives them. The
// whole router is gated on the "admissions" admin page — nobody else can see, add,
// edit or delete an application (they hold personal data: ID numbers, NI, address).
const router = require("express").Router();
const crypto = require("crypto");
const prisma = require("../db");
const { requireAuth, requirePage } = require("../auth");
const email = require("../email");
const sharepoint = require("../sharepoint");
const storage = require("../storage");
const { ADMISSION_DOC_TYPES, admissionFolderSegments } = require("../admissionDocs");
const { FIELDS, pick, str } = require("../admissionFields");
const mailAssets = require("../mailAssets");
const branding = require("../branding");
const et = require("../emailTemplate");
const audit = require("../audit");

// An applicant's name, for a log line a person can read. Never more than the name:
// see the note on audit.changedKeys for why the rest of this record stays out of the
// audit trail.
const applicantName = (a) => [a.firstName, a.surname].filter(Boolean).join(" ") || "Applicant";

// Where the applicant's upload page lives (the SPA reads ?upload=<token>).
const CLIENT_URL = (process.env.CLIENT_URL || "http://localhost:5173").replace(/\/$/, "");
// The upload link is reusable (applicants add documents over several days) but not
// forever — a stale link on an old email shouldn't work months later.
const UPLOAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const hashToken = (raw) => crypto.createHash("sha256").update(String(raw)).digest("hex");

// What of an Admission row may reach the admin client — an ALLOWLIST, not a list of
// things to strip.
//
// It used to be a denylist (`const { uploadTokenHash, offerTokenHash, passwordHash,
// ...rest } = r`), and a denylist is the wrong default here: every column added to this
// model in future becomes public the moment it exists, and nobody adding one thinks to
// come back to a serializer to opt it out. That is exactly how the bcrypt hash got out.
// The applicant portal added passwordHash, active and tokenVersion to this table long
// after the serializer was written; all three then shipped to the admin dashboard on
// every list and every update. A hash is not a password, but handing one to a browser
// gives an attacker an offline target they should never have had.
//
// So: name what goes out. A new column is invisible until it is added here on purpose,
// which is the safe way round — a field that should have been shown is a missing badge
// somebody reports, a field that should not have been is a breach nobody sees.
//
// FIELDS is the shared list of the application form's own answers (admissionFields.js),
// so the form can gain a question without touching this list; everything after it is a
// system/workflow column the Admissions screen actually reads.
const ADMISSION_OUT = [
  "id", "createdAt", "updatedAt",
  ...FIELDS,
  // Document workflow. spFolderUrl is a link an admin clicks; spFolderId — the Graph
  // driveItem id behind it — has no client use, so it stays in.
  "docsRequestedAt", "uploadTokenExpires", "spFolderUrl",
  // Admissions decision.
  "interviewStatus", "enrollStatus", "studentId", "ismOutcome",
  // Offer letter. The raw accept token lives only in the email; only its status is here.
  "offerStatus", "offerSentAt", "offerAcceptedAt", "offerInductionDate", "offerSignatoryName",
  // Interview call (the invitation the applicant sees in the portal).
  "interviewInviteDate", "interviewInviteTime", "interviewInviteMode", "interviewInviteLocation",
  "interviewInviteLink", "interviewInviteNote", "interviewInviteSentAt",
  // Enrolment induction.
  "enrolInductionDate", "enrolInductionTime", "enrolEmailSentAt",
  // How the row was created ("portal" | "apply" | null) and whether the applicant has
  // pressed Submit — both drive badges in the admin list.
  "source", "applicationSubmittedAt",
];
// Deliberately absent, each for a reason worth writing down so a later reader does not
// "helpfully" add them back:
//   passwordHash                      the applicant's bcrypt portal password
//   uploadTokenHash / offerTokenHash  the hashed halves of the emailed magic links
//   tokenVersion, active              the applicant's session/account state; the admin
//                                     screen never reads either, and tokenVersion tells
//                                     an attacker how often that session was revoked
//   tenantId                          an internal id that only leaks the estate's shape

// The uploaded-document rows that ride along on `documents`. Same rule — named, not
// stripped. spItemId / storagePath / webUrl are storage locations the client never
// needs: it opens a file through GET /admissions/documents/:id/file, which authorises
// first and then mints a short-lived link.
const ADMISSION_DOC_OUT = [
  "id", "admissionId", "docType", "fileName", "mimeType", "sizeBytes",
  "uploadedAt", "confirmed", "confirmedAt", "confirmedBy",
];

// `k in row` rather than a blind copy, so a column the query did not select stays
// absent instead of appearing as an explicit undefined.
const only = (row, keys) => {
  const out = {};
  for (const k of keys) if (row && k in row) out[k] = row[k];
  return out;
};

const sAdmissionDoc = (d) => only(d, ADMISSION_DOC_OUT);

const sAdmission = (r) => {
  const out = only(r, ADMISSION_OUT);
  // `documents` is present only when the query asked for it (withDocs). Absent stays
  // absent: the client distinguishes "this applicant has uploaded nothing" from "this
  // response did not include the checklist" by exactly that difference.
  if (Array.isArray(r.documents)) out.documents = r.documents.map(sAdmissionDoc);
  return out;
};

// Format an ISO date (YYYY-MM-DD) as the offer letter reads it, e.g.
// "Tuesday, 15th September 2026". Falls back to the raw input if unparseable.
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ordinal = (d) => (d % 10 === 1 && d !== 11) ? "st" : (d % 10 === 2 && d !== 12) ? "nd" : (d % 10 === 3 && d !== 13) ? "rd" : "th";
function formatOfferDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (isNaN(d.getTime())) return iso || "";
  return `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()}${ordinal(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function formatLetterDate(d) {
  return `${d.getDate()}${ordinal(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// The "You're enrolled" congratulations email, sent when an admin enrols an applicant and
// sets their induction date/time. Branded, celebratory, table-based for broad client support.
//
// There is no editable template for this one — it is the only email in the flow with no
// entry in emailTemplate.KINDS — so the wording is the system's and only the identity in
// it comes from branding. Async because branding does: everything after the await is one
// synchronous template, resolved first the way offerLetter.js does it.
async function buildEnrolEmail(a) {
  const b = await branding.get();
  const name = [a.firstName, a.surname].filter(Boolean).join(" ") || "there";
  const first = a.firstName || name;
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const when = `${formatOfferDate(a.enrolInductionDate)}${a.enrolInductionTime ? ` at ${a.enrolInductionTime}` : ""}`;
  const course = a.course || "your course";
  // Every one of these collapses to nothing when the college has not set the field, so a
  // sentence loses a clause rather than gaining the word "undefined" or, worse, the name
  // and street address of a different college.
  const atCollege = b.displayName ? ` at ${b.displayName}` : "";
  const where = mailAssets.venue(b);
  const signOff = ["Kind regards,", "Admissions Team", b.displayName].filter(Boolean).join("\n");
  const subject = b.displayName ? `${b.displayName} — You're enrolled! 🎉` : "You're enrolled! 🎉";
  const text = `Dear ${first},\n\nCongratulations! We are delighted to confirm that you are now enrolled on ${course}${atCollege}.\n\nYour induction is on:\n${when}\n${where ? `Location: ${where}\n` : ""}\nPlease arrive a little early and bring a form of photo ID. During induction you will receive your timetable, student ID card and programme information.\n\nWe look forward to welcoming you.\n\n${signOff}`;
  const html = `<div style="margin:0;padding:24px;background:#eef1f6;font-family:'Segoe UI',Roboto,system-ui,-apple-system,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(15,23,42,.08)">
    <tr><td style="background:linear-gradient(135deg,#0f766e,#15803d);padding:24px 28px">
      ${mailAssets.logoImg(b)}
      ${mailAssets.wordmark(b)}
      <p style="margin:3px 0 0;color:rgba(255,255,255,.8);font-size:11px;font-weight:700;letter-spacing:.18em">ENROLMENT CONFIRMED</p>
    </td></tr>
    <tr><td style="padding:30px 28px 4px;text-align:center">
      <div style="font-size:38px;line-height:1">&#127881;</div>
      <h1 style="margin:12px 0 0;font-size:25px;font-weight:800;color:#15803d">Congratulations, ${esc(first)}!</h1>
      <p style="margin:8px 0 0;font-size:12px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:#0f766e">You're enrolled</p>
    </td></tr>
    <tr><td style="padding:18px 28px 4px">
      <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#334155">We are delighted to confirm that you are now enrolled on <b>${esc(course)}</b>${esc(atCollege)}. Here are your induction details.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
        <tr><td style="padding:14px 18px;border-bottom:1px solid #eef1f6;font-size:13px;color:#334155"><span style="font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#64748b">Induction</span><br><b style="font-size:16px;color:#0f172a">${esc(when)}</b></td></tr>
        ${where ? `<tr><td style="padding:14px 18px;font-size:13px;color:#334155"><span style="font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#64748b">Location</span><br><b style="font-size:15px;color:#0f172a">${esc(where)}</b></td></tr>` : ""}
      </table>
      <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#334155">Please arrive a little early and bring a form of photo ID. During induction you will receive your <b>timetable, student ID card and programme information</b>.</p>
      <p style="margin:0 0 22px;font-size:14px;line-height:1.6;color:#334155">We look forward to welcoming you.<br><br>Kind regards,<br><b>Admissions Team</b>${b.displayName ? `<br>${esc(b.displayName)}` : ""}</p>
    </td></tr>
    ${mailAssets.footerHtml(b) ? `<tr><td style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e2e8f0">
      <p style="margin:0;font-size:11px;line-height:1.6;color:#94a3b8">${mailAssets.footerHtml(b)}</p>
    </td></tr>` : ""}
  </table>
</div>`;
  return { subject, text, html };
}

router.use(requireAuth, requirePage("admissions"));

const withDocs = { include: { documents: { orderBy: { uploadedAt: "asc" } } } };

// Newest first — an admin works the top of the pile. The list is small (one college's
// intake), so no pagination on the server; the client paginates for display.
router.get("/", async (_req, res) => {
  const rows = await prisma.admission.findMany({ orderBy: { createdAt: "desc" }, ...withDocs });
  res.json(rows.map(sAdmission));
});

router.post("/", async (req, res) => {
  const data = pick(req.body);
  // We need SOMETHING to call the applicant in the list. Require at least one name part
  // rather than the whole form, so a half-finished paper application can still be saved.
  if (!data.firstName && !data.surname) {
    return res.status(400).json({ error: "An applicant needs at least a first name or surname." });
  }
  const row = await prisma.admission.create({ data, ...withDocs });
  // The arrival of a new personal record. Only the identifiers go in the log — the
  // application itself holds special-category data (see audit.changedKeys).
  audit.record(req, {
    action: "admission.created", entity: "Admission", entityId: row.id,
    summary: `Application created for ${applicantName(row)}` + (row.course ? ` — ${row.course}` : ""),
    after: { course: row.course, intake: row.intake, intakeYear: row.intakeYear },
  });
  res.status(201).json(sAdmission(row));
});

// --- Document workflow (must come before the /:id routes so "documents" isn't read as an id) ---

// Mark a single uploaded document as verified (or un-verify it) once the admin has
// eyeballed it in SharePoint.
router.put("/documents/:docId/confirm", async (req, res) => {
  const doc = await prisma.admissionDocument.findUnique({ where: { id: req.params.docId } });
  if (!doc) return res.status(404).json({ error: "Document not found." });
  const confirmed = req.body?.confirmed !== false; // default to confirming
  const updated = await prisma.admissionDocument.update({
    where: { id: doc.id },
    data: { confirmed, confirmedAt: confirmed ? new Date() : null, confirmedBy: confirmed ? (req.user?.name || req.user?.email || null) : null },
  });
  audit.record(req, {
    action: confirmed ? "admission.document.verified" : "admission.document.unverified",
    entity: "AdmissionDocument", entityId: doc.id,
    summary: `${doc.docType || "Document"} "${doc.fileName || ""}" ${confirmed ? "verified" : "un-verified"}`,
    before: { confirmed: doc.confirmed },
    after: { confirmed, admissionId: doc.admissionId },
  });
  // An AdmissionDocument, not an Admission — this used to be run through sAdmission,
  // which under the old denylist quietly echoed the document row back (tenantId and the
  // storage keys included). The client reloads the list after this call and ignores the
  // body, so nothing depended on the wrong shape; return the right one.
  res.json(sAdmissionDoc(updated));
});

// A link to view one uploaded document. SharePoint files return their web URL (the
// admin opens them in SharePoint and can confirm there); fallback files return a
// short-lived signed URL from Supabase.
router.get("/documents/:docId/file", async (req, res) => {
  const doc = await prisma.admissionDocument.findUnique({ where: { id: req.params.docId } });
  if (!doc) return res.status(404).json({ error: "Document not found." });
  if (doc.webUrl) return res.json({ url: doc.webUrl, fileName: doc.fileName });
  if (doc.storagePath) {
    try { return res.json({ url: await storage.signedUrl(doc.storagePath), fileName: doc.fileName }); }
    catch (e) { return res.status(400).json({ error: e.message || "Could not create a link." }); }
  }
  return res.status(404).json({ error: "No file stored for this document." });
});

// Remove one uploaded document (and its file, best-effort).
router.delete("/documents/:docId", async (req, res) => {
  const doc = await prisma.admissionDocument.findUnique({ where: { id: req.params.docId } });
  if (!doc) return res.status(404).json({ error: "Document not found." });
  if (doc.spItemId) await sharepoint.deleteItem(doc.spItemId);
  else if (doc.storagePath) await storage.removeObject(doc.storagePath);
  await prisma.admissionDocument.delete({ where: { id: doc.id } });
  // Destroying an applicant's identity document. The file is gone from SharePoint or
  // Supabase too, so this row is the only remaining evidence it ever existed.
  audit.record(req, {
    action: "admission.document.deleted", entity: "AdmissionDocument", entityId: doc.id,
    summary: `${doc.docType || "Document"} "${doc.fileName || ""}" deleted, and its stored file with it`,
    before: { docType: doc.docType, fileName: doc.fileName, confirmed: doc.confirmed, admissionId: doc.admissionId },
    after: null,
  });
  res.json({ ok: true });
});

// Email the applicant a secure link to upload their documents. Creates (or reuses) their
// SharePoint folder up front so the admin sees the folder link straight away, mints a
// reusable upload token, and sends the email. Safe to press again to re-send.
router.post("/:id/request-documents", async (req, res) => {
  const a = await prisma.admission.findUnique({ where: { id: req.params.id } });
  if (!a) return res.status(404).json({ error: "Application not found." });
  if (!a.email) return res.status(400).json({ error: "This applicant has no email address on file — add one first." });

  const name = [a.firstName, a.surname].filter(Boolean).join(" ") || "Applicant";
  // Fresh token each time (an old emailed link stops working), stored only as a hash.
  const raw = crypto.randomBytes(32).toString("hex");
  const patch = { uploadTokenHash: hashToken(raw), uploadTokenExpires: new Date(Date.now() + UPLOAD_TTL_MS), docsRequestedAt: new Date() };

  // Best-effort: create the SharePoint folder now. If it fails (or SharePoint isn't set
  // up yet) the upload route will create it when the first file arrives, so don't block.
  let warning = null;
  if (sharepoint.isConfigured()) {
    try {
      // Admissions / <course> / <intake> / <student name>
      const folder = await sharepoint.ensureFolderPath(admissionFolderSegments(a));
      patch.spFolderId = folder.id; patch.spFolderUrl = folder.webUrl;
    } catch (e) { warning = `Could not create the SharePoint folder yet: ${e.message}`; }
  }

  await prisma.admission.update({ where: { id: a.id }, data: patch });
  const link = `${CLIENT_URL}/?upload=${raw}`;

  // Plain-text fallback — readable on its own, with the documents as a bulleted list.
  const list = ADMISSION_DOC_TYPES.map((d) => `• ${d.label}`).join("\n");
  // The same escaper the other three builders in this file use — the branding values
  // below reach the markup too, and a college with an ampersand in its name would
  // otherwise break the message it is signing.
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const nameEsc = esc(name);
  // Resolved before the two bodies below, both of which are synchronous templates.
  const b = await branding.get();
  // "please contact our Admissions Team at <email> or <phone>" — the whole sentence goes
  // when the college has given neither, because an invitation to contact nobody is worse
  // than no invitation, and printing another college's address here would send this
  // applicant's questions to an institution that has never heard of them.
  const contactBits = [b.contactEmail, b.contactPhone].filter(Boolean).join(" or ");
  const contactSentence = contactBits ? ` If you have any questions, please contact our Admissions Team at ${contactBits}.` : "";
  const applyingTo = b.displayName ? ` to ${b.displayName}` : "";
  const signOff = b.displayName ? `${b.displayName} Admissions` : "Admissions";
  const subject = b.displayName
    ? `${b.displayName} — Please upload your application documents`
    : "Please upload your application documents";
  const text =
    `Dear ${name},\n\n` +
    `Thank you for applying${applyingTo}. To move your application forward, please upload the documents below using your secure link. You only need to provide the ones that apply to you, and you can return to the same link any time to add or replace a file.\n\n` +
    `Documents requested:\n${list}\n\n` +
    `Upload your documents here:\n${link}\n\n` +
    `This secure link expires in 30 days.${contactSentence}\n\n` +
    `Kind regards,\n${signOff}`;

  // Branded HTML email — table-based with inline styles for broad email-client support.
  // The document rows are generated from ADMISSION_DOC_TYPES so the email always matches
  // the upload page and never drifts out of sync.
  const docRowsHtml = ADMISSION_DOC_TYPES.map((d, i) =>
    `<tr><td style="padding:11px 18px;${i < ADMISSION_DOC_TYPES.length - 1 ? "border-bottom:1px solid #eef1f6;" : ""}font-size:14px;color:#334155">` +
    `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${b.accentColor};margin-right:11px;vertical-align:middle"></span>${d.label}</td></tr>`
  ).join("");

  // The same sentence as the text body, but with the address as a mailto: link. Built
  // here rather than inline so the two bodies cannot drift apart about whether there is
  // anyone to contact.
  const contactHtml = contactBits
    ? ` If you have any questions, please contact our Admissions Team at ` +
      [
        b.contactEmail ? `<a href="mailto:${esc(b.contactEmail)}" style="color:${b.primaryColor}">${esc(b.contactEmail)}</a>` : null,
        b.contactPhone ? esc(b.contactPhone) : null,
      ].filter(Boolean).join(" or ") + `.`
    : "";

  const html = `<div style="margin:0;padding:24px;background:#eef1f6;font-family:'Segoe UI',Roboto,system-ui,-apple-system,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(15,23,42,.08)">
    <tr><td style="background:linear-gradient(135deg,${b.primaryColor},${b.accentColor});padding:24px 28px">
      ${mailAssets.logoImg(b)}
      ${mailAssets.wordmark(b)}
      <p style="margin:3px 0 0;color:rgba(255,255,255,.75);font-size:11px;font-weight:700;letter-spacing:.18em">ADMISSIONS</p>
    </td></tr>
    <tr><td style="padding:28px">
      <h1 style="margin:0 0 16px;font-size:19px;color:#0f172a">Your application documents</h1>
      <p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#334155">Dear ${nameEsc},</p>
      <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#334155">Thank you for applying${esc(applyingTo)}. To move your application forward, please upload the documents below using your secure link. You only need to provide the ones that apply to you, and you can return to the same link any time to add or replace a file.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
        <tr><td style="background:#f8fafc;padding:10px 18px;border-bottom:1px solid #e2e8f0;font-size:11px;font-weight:800;letter-spacing:.12em;color:#64748b;text-transform:uppercase">Documents requested</td></tr>
        ${docRowsHtml}
      </table>
      <table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto 18px"><tr><td style="border-radius:10px" bgcolor="${b.primaryColor}">
        <a href="${link}" style="display:inline-block;padding:14px 30px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;background:linear-gradient(135deg,${b.primaryColor},${b.accentColor})">Upload your documents</a>
      </td></tr></table>
      <p style="margin:0 0 4px;font-size:12px;line-height:1.5;color:#64748b;text-align:center">Or paste this link into your browser:</p>
      <p style="margin:0 0 20px;font-size:12px;line-height:1.5;word-break:break-all;text-align:center"><a href="${link}" style="color:${b.primaryColor}">${link}</a></p>
      <p style="margin:0;font-size:12px;line-height:1.6;color:#94a3b8">This secure link expires in 30 days.${contactHtml}</p>
      <p style="margin:18px 0 0;font-size:14px;line-height:1.6;color:#334155">Kind regards,<br><b>${esc(signOff)}</b></p>
    </td></tr>
    ${mailAssets.footerHtml(b) ? `<tr><td style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e2e8f0">
      <p style="margin:0;font-size:11px;line-height:1.6;color:#94a3b8">${mailAssets.footerHtml(b)}</p>
    </td></tr>` : ""}
  </table>
</div>`;

  // sendEmail never throws on a send failure — it returns { sent, stubbed, error }. Read
  // that result so a rejected/blocked send is reported instead of falsely showing success.
  let emailed = false;
  try {
    const sent = await email.sendEmail(a.email, subject, text, { html });
    emailed = !!sent.sent;
    if (!sent.sent && !sent.stubbed) warning = (warning ? warning + " " : "") + `Email could not be sent: ${sent.error || "unknown error"}`;
  } catch (e) { warning = (warning ? warning + " " : "") + `Email could not be sent: ${e.message}`; }

  // Minting a token that lets whoever holds the emailed link upload documents onto
  // this applicant's record for the next 30 days. The token itself is never written —
  // only its hash is stored, and neither reaches the log.
  audit.record(req, {
    action: "admission.documents.requested", entity: "Admission", entityId: a.id,
    summary: `Document upload link sent to ${applicantName(a)} at ${a.email} — valid for 30 days`,
    after: { emailed, expiresAt: patch.uploadTokenExpires, sharePointFolderCreated: !!patch.spFolderId },
  });

  const updated = await prisma.admission.findUnique({ where: { id: a.id }, ...withDocs });
  // Return the link too, so the admin can copy it if email isn't configured on the server.
  res.json({ admission: sAdmission(updated), emailed, link, warning });
});

// Inline admin decision fields from the list — enrol decision (Enroll/Rejected/Withdraw),
// and the manually-assigned student ID. Only the keys present in the body are touched.
// On ENROL, the applicant's SharePoint folder is renamed to "<studentId> - <name>".
router.put("/:id/status", async (req, res) => {
  const existing = await prisma.admission.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Application not found." });
  const b = req.body || {};
  const data = {};
  if ("interviewStatus" in b) data.interviewStatus = str(b.interviewStatus) || null;
  if ("enrollStatus" in b) data.enrollStatus = str(b.enrollStatus) || null;
  if ("studentId" in b) data.studentId = str(b.studentId).slice(0, 100) || null;

  // Enrolling with an induction date (the Enroll dialog): store the induction date/time and
  // send the student a "You're enrolled" confirmation email below. A plain inline studentId
  // edit or a Reject/Withdraw carries no inductionDate, so it never triggers the email.
  const enrolling = data.enrollStatus === "Enroll" && !!str(b.inductionDate);
  if (enrolling) {
    data.enrolInductionDate = str(b.inductionDate) || null;
    data.enrolInductionTime = str(b.inductionTime) || null;
  }
  let row = await prisma.admission.update({ where: { id: req.params.id }, data });

  // On enrolment, the applicant's SharePoint folder is named "<studentId> - <name>".
  // If the folder already exists it's renamed; if it doesn't (documents were never
  // requested), it's created now in the right Course/Intake path with that name.
  let warning = null;
  if (row.enrollStatus === "Enroll" && sharepoint.isConfigured()) {
    if (!row.studentId) {
      warning = "Enrolled — add a Student ID so the folder can be named after the student.";
    } else {
      const name = [row.firstName, row.surname].filter(Boolean).join(" ") || "Applicant";
      try {
        // admissionFolderSegments now yields "<studentId> - <name>" because the row is enrolled.
        const folder = row.spFolderId
          ? await sharepoint.renameItem(row.spFolderId, `${row.studentId} - ${name}`)
          : await sharepoint.ensureFolderPath(admissionFolderSegments(row));
        row = await prisma.admission.update({ where: { id: row.id }, data: { spFolderId: folder.id, spFolderUrl: folder.webUrl } });

        // Drop a printable copy of the completed application form into the student's
        // folder. Best-effort and separate from the folder step: a PDF/upload failure
        // must not undo the enrolment or the folder rename above.
        try {
          const { buildApplicationPdf } = require("../applicationPdf");
          const appPdf = await buildApplicationPdf(row);
          await sharepoint.uploadFile(folder.id, "Application Form.pdf", appPdf, "application/pdf");
        } catch (e) { warning = (warning ? warning + " " : "") + `Enrolled, but the application-form PDF couldn't be saved to SharePoint: ${e.message}`; }
      } catch (e) { warning = `Enrolled, but the SharePoint folder couldn't be set: ${e.message}`; }
    }
  }

  // Send the enrolment confirmation email (best-effort; a send failure must never undo the
  // enrolment or the folder work above).
  let emailed = false;
  if (enrolling) {
    if (!row.email) {
      warning = (warning ? warning + " " : "") + "Enrolled — no email address on file, so no confirmation was sent.";
    } else {
      try {
        const { subject, text, html } = await buildEnrolEmail(row);
        const sent = await email.sendEmail(row.email, subject, text, { html });
        emailed = !!sent.sent;
        row = await prisma.admission.update({ where: { id: row.id }, data: { enrolEmailSentAt: new Date() } });
        if (!sent.sent && !sent.stubbed) warning = (warning ? warning + " " : "") + `Enrolled, but the confirmation email could not be sent: ${sent.error || "unknown error"}`;
      } catch (e) { warning = (warning ? warning + " " : "") + `Enrolled, but the confirmation email could not be sent: ${e.message}`; }
    }
  }

  // The decision on someone's application: interviewed, offered a place, enrolled,
  // rejected or withdrawn. Unlike the personal details on the same row, these values
  // ARE the thing worth recording, and none of them is special-category data.
  audit.record(req, {
    action: "admission.status.changed", entity: "Admission", entityId: row.id,
    summary: `${applicantName(row)}: ` + [
      "interviewStatus" in data && `interview ${row.interviewStatus || "cleared"}`,
      "enrollStatus" in data && `enrolment ${row.enrollStatus || "cleared"}`,
      "studentId" in data && `student ID ${row.studentId || "cleared"}`,
    ].filter(Boolean).join(", ") || "status updated",
    before: { interviewStatus: existing.interviewStatus, enrollStatus: existing.enrollStatus, studentId: existing.studentId },
    after: { interviewStatus: row.interviewStatus, enrollStatus: row.enrollStatus, studentId: row.studentId, inductionDate: row.enrolInductionDate, confirmationEmailed: emailed },
  });

  const full = await prisma.admission.findUnique({ where: { id: row.id }, ...withDocs });
  const out = sAdmission(full);
  if (warning) out.warning = warning;
  out.emailed = emailed;
  res.json(out);
});

// Generate the offer-letter PDF, email it to the applicant with a secure Accept link,
// and mark the offer "sent". Safe to press again to re-send (a fresh token each time).
router.post("/:id/send-offer", async (req, res) => {
  const a = await prisma.admission.findUnique({ where: { id: req.params.id } });
  if (!a) return res.status(404).json({ error: "Application not found." });
  if (!a.email) return res.status(400).json({ error: "This applicant has no email address on file — add one first." });

  const name = [a.firstName, a.surname].filter(Boolean).join(" ") || "Applicant";
  const inductionDate = str(req.body?.inductionDate) ? formatOfferDate(str(req.body.inductionDate)) : "";
  const letterDate = formatLetterDate(new Date());
  const b = await branding.get();
  // Whoever is sending types their own name in the dialog; it signs page 2 of the PDF.
  // The fallback is the institution's own configured signatory — never a person's name
  // written into this file, which is what it used to be: one college's Admissions Officer
  // signing every other college's offer letters. Empty is a legitimate answer here;
  // offerLetter.js omits the line rather than printing a placeholder over the signature.
  const senderName = str(req.body?.signatoryName) || b.signatoryName || "";
  const senderTitle = str(req.body?.signatoryTitle) || b.signatoryTitle || "Admissions Officer";

  // Build the PDF (required lazily so the router still loads if the module is absent).
  let pdf;
  try {
    const { buildOfferLetterPdf } = require("../offerLetter");
    pdf = await buildOfferLetterPdf(a, { letterDate, inductionDate, signatoryName: senderName, signatoryTitle: senderTitle });
  } catch (e) {
    return res.status(500).json({ error: `Could not generate the offer letter: ${e.message}` });
  }

  const raw = crypto.randomBytes(32).toString("hex");
  await prisma.admission.update({
    where: { id: a.id },
    // Don't regress an already-accepted offer to "sent" on a re-send (the admin may just be
    // sending the applicant another copy); keep the acceptance intact.
    data: { offerStatus: a.offerStatus === "accepted" ? "accepted" : "sent", offerSentAt: new Date(), offerTokenHash: hashToken(raw), offerInductionDate: inductionDate || null, offerSignatoryName: senderName },
  });

  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const firstEsc = esc(a.firstName || name);
  const courseEsc = esc(a.course || "your course");

  // The applicant-facing wording is the college's own "offer" template, so a college that
  // has reworded it gets its words here rather than the ones this file happened to ship
  // with. The signature block that used to close this email has gone with it: the offer
  // is signed on page 2 of the attached PDF, and repeating a named signatory under a body
  // the college wrote produced two sign-offs, one of which was not theirs.
  const tpl = await et.render("offer", {
    firstName: a.firstName || name,
    lastName: a.surname || "",
    fullName: name,
    course: a.course || "your course",
    intake: a.intake || "",
    intakeYear: a.intakeYear || "",
  });

  const acceptLink = `${CLIENT_URL}/?offer=${raw}`;
  const subject = tpl.subject;
  // The Accept link is appended by this route instead of being offered as a {{placeholder}}
  // in the template: it is minted per send and is the only way an applicant can confirm a
  // place, so a college rewording its own email must not be able to delete it. The contact
  // sentence goes the other way — it is dropped when the college has given neither an
  // address nor a number, because inviting someone to contact nobody is worse than saying
  // nothing, and naming another college's admissions inbox is worse still.
  const contactBits = [b.contactEmail, b.contactPhone].filter(Boolean).join(" or ");
  const contactHtml = contactBits
    ? `If you have any questions before joining us, please contact our Admissions Team at ` +
      [
        b.contactEmail ? `<a href="mailto:${esc(b.contactEmail)}" style="color:${b.primaryColor}">${esc(b.contactEmail)}</a>` : null,
        b.contactPhone ? esc(b.contactPhone) : null,
      ].filter(Boolean).join(" or ") + `.`
    : "";
  const text = [
    tpl.text,
    "",
    "To confirm your place, please accept your offer here:",
    acceptLink,
    ...(contactBits ? ["", `If you have any questions, contact our Admissions Team at ${contactBits}.`] : []),
  ].join("\n");

  // Branded, celebratory HTML email — mirrors the offer letter's look (gradient header,
  // coloured "Congratulations" headline, course card, Accept button). Table-based with
  // inline styles for broad email-client support.
  const html = `<div style="margin:0;padding:24px;background:#eef1f6;font-family:'Segoe UI',Roboto,system-ui,-apple-system,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(15,23,42,.08)">
    <tr><td style="background:linear-gradient(135deg,${b.primaryColor},${b.accentColor});padding:24px 28px">
      ${mailAssets.logoImg(b)}
      ${mailAssets.wordmark(b)}
      <p style="margin:3px 0 0;color:rgba(255,255,255,.75);font-size:11px;font-weight:700;letter-spacing:.18em">ADMISSIONS</p>
    </td></tr>
    <tr><td style="padding:30px 28px 6px;text-align:center">
      <div style="font-size:36px;line-height:1">&#127881;</div>
      <h1 style="margin:12px 0 0;font-size:25px;font-weight:800;color:${b.accentColor}">Congratulations, ${firstEsc}!</h1>
      <p style="margin:8px 0 0;font-size:12px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:${b.primaryColor}">Unconditional Offer</p>
    </td></tr>
    <tr><td style="padding:18px 28px 4px">
      <div style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#334155">${tpl.html}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
        <tr><td style="padding:16px 18px;font-size:13px;color:#334155"><span style="font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#64748b">Your course</span><br><b style="font-size:16px;color:#0f172a">${courseEsc}</b></td></tr>
      </table>
      <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#334155">To confirm your place, simply click the button below.</p>
      <table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto 18px"><tr><td style="border-radius:10px" bgcolor="${b.primaryColor}">
        <a href="${acceptLink}" style="display:inline-block;padding:14px 34px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;background:linear-gradient(135deg,${b.primaryColor},${b.accentColor})">Accept my offer</a>
      </td></tr></table>
      <p style="margin:0 0 4px;font-size:12px;line-height:1.5;color:#64748b;text-align:center">Or paste this link into your browser:</p>
      <p style="margin:0 0 20px;font-size:12px;line-height:1.5;word-break:break-all;text-align:center"><a href="${acceptLink}" style="color:${b.primaryColor}">${acceptLink}</a></p>
      ${contactHtml ? `<p style="margin:0 0 24px;font-size:12px;line-height:1.6;color:#94a3b8">${contactHtml}</p>` : ""}
    </td></tr>
    ${mailAssets.footerHtml(b) ? `<tr><td style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e2e8f0">
      <p style="margin:0;font-size:11px;line-height:1.6;color:#94a3b8">${mailAssets.footerHtml(b)}</p>
    </td></tr>` : ""}
  </table>
</div>`;
  const fileName = `Offer Letter - ${name}.pdf`;

  // sendEmail returns { sent, stubbed, error } and never throws on failure — read it so a
  // blocked send (e.g. SMTP "SendAsDenied", bad key) is surfaced, not reported as success.
  let emailed = false, warning = null;
  try {
    const sent = await email.sendEmail(a.email, subject, text, { html, attachments: [{ filename: fileName, content: pdf }] });
    emailed = !!sent.sent;
    if (!sent.sent && !sent.stubbed) warning = `The offer was recorded but the email could not be sent: ${sent.error || "unknown error"}`;
  } catch (e) { warning = `The offer was recorded but the email could not be sent: ${e.message}`; }

  // A formal offer of a place, sent under a named signatory. The single most
  // consequential thing the admissions team does, and the one an applicant is most
  // likely to query later.
  audit.record(req, {
    action: "admission.offer.sent", entity: "Admission", entityId: a.id,
    summary: `Offer for ${a.course || "a course"} sent to ${applicantName(a)} at ${a.email}, signed by ${senderName || b.displayName || "the college"}` + (a.offerStatus === "accepted" ? " (re-sent — the existing acceptance was kept)" : ""),
    before: { offerStatus: a.offerStatus },
    after: { offerStatus: a.offerStatus === "accepted" ? "accepted" : "sent", course: a.course, inductionDate: inductionDate || null, signatory: senderName, emailed },
  });

  const updated = await prisma.admission.findUnique({ where: { id: a.id }, ...withDocs });
  res.json({ admission: sAdmission(updated), emailed, link: acceptLink, warning });
});

// POST /:id/send-interview-invite — schedule an interview and send the applicant the
// "interview call". The details are saved on the record so the applicant sees them in the
// portal, and a branded email is sent. The interview OUTCOME is separate (recorded via ISM).
router.post("/:id/send-interview-invite", async (req, res) => {
  const a = await prisma.admission.findUnique({ where: { id: req.params.id } });
  if (!a) return res.status(404).json({ error: "Application not found." });
  if (!a.email) return res.status(400).json({ error: "This applicant has no email address on file — add one first." });

  const b = req.body || {};
  const date = str(b.date);          // YYYY-MM-DD
  const time = str(b.time);          // HH:MM
  const mode = str(b.mode);          // "Online" | "In person"
  const location = str(b.location);  // room / address
  const link = str(b.link);          // meeting link
  const note = str(b.note);
  if (!date) return res.status(400).json({ error: "Please choose an interview date." });

  await prisma.admission.update({
    where: { id: a.id },
    data: {
      interviewInviteDate: date || null,
      interviewInviteTime: time || null,
      interviewInviteMode: mode || null,
      interviewInviteLocation: location || null,
      interviewInviteLink: link || null,
      interviewInviteNote: note || null,
      interviewInviteSentAt: new Date(),
    },
  });

  const name = [a.firstName, a.surname].filter(Boolean).join(" ") || "Applicant";
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const firstEsc = esc(a.firstName || name);
  const whenText = `${formatOfferDate(date)}${time ? ` at ${time}` : ""}`;
  const isOnline = mode === "Online";
  const brand = await branding.get();
  // An in-person interview with no room given falls back to the college's own address.
  // When it has not set one the Where line is dropped entirely — an applicant sent to an
  // address that belongs to a different institution is the one outcome worth avoiding,
  // and "reply to this email and we will rearrange" is already in the body.
  const whereText = isOnline ? (link ? "Online (link below)" : "Online") : (location || mailAssets.venue(brand));
  const portalLink = `${CLIENT_URL}/`;

  // The college's own "interview" wording, with the practical detail appended by this
  // route: where, the join link and the portal link are per-send facts, and a college
  // rewording its invitation must not be able to leave an applicant without them.
  const tpl = await et.render("interview", {
    firstName: a.firstName || name,
    lastName: a.surname || "",
    fullName: name,
    course: a.course || "your course",
    interviewDate: formatOfferDate(date),
    interviewTime: time || "",
  });

  const text = [
    tpl.text,
    "",
    `When: ${whenText}`,
    ...(whereText ? [`Where: ${whereText}`] : []),
    ...(isOnline && link ? [`Join link: ${link}`] : []),
    ...(note ? ["", note] : []),
    "",
    `You can see these details any time by signing in to the Student Portal: ${portalLink}`,
    "",
    "If the time does not suit you, reply to this email and we will rearrange.",
  ].join("\n");

  const html = `<div style="margin:0;padding:24px;background:#eef1f6;font-family:'Segoe UI',Roboto,system-ui,-apple-system,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(15,23,42,.08)">
    <tr><td style="background:linear-gradient(135deg,${brand.primaryColor},${brand.accentColor});padding:24px 28px">
      ${mailAssets.logoImg(brand)}
      ${mailAssets.wordmark(brand)}
      <p style="margin:3px 0 0;color:rgba(255,255,255,.75);font-size:11px;font-weight:700;letter-spacing:.18em">INTERVIEW INVITATION</p>
    </td></tr>
    <tr><td style="padding:26px 28px 4px">
      <h1 style="margin:0 0 12px;font-size:22px;font-weight:800;color:${brand.primaryColor}">You're invited to an interview</h1>
      <div style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#334155">${tpl.html}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
        <tr><td style="padding:14px 18px;border-bottom:1px solid #eef1f6;font-size:13px;color:#334155"><span style="font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#64748b">When</span><br><b style="font-size:15px;color:#0f172a">${esc(whenText)}</b></td></tr>
        ${whereText ? `<tr><td style="padding:14px 18px;${isOnline && link ? "border-bottom:1px solid #eef1f6;" : ""}font-size:13px;color:#334155"><span style="font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#64748b">Where</span><br><b style="font-size:15px;color:#0f172a">${esc(whereText)}</b></td></tr>` : ""}
        ${isOnline && link ? `<tr><td style="padding:14px 18px;font-size:13px;color:#334155"><span style="font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#64748b">Join link</span><br><a href="${esc(link)}" style="color:${brand.primaryColor};word-break:break-all">${esc(link)}</a></td></tr>` : ""}
      </table>
      ${note ? `<p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#334155">${esc(note)}</p>` : ""}
      <table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto 16px"><tr><td style="border-radius:10px" bgcolor="${brand.primaryColor}">
        <a href="${portalLink}" style="display:inline-block;padding:13px 30px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;background:linear-gradient(135deg,${brand.primaryColor},${brand.accentColor})">Open the Student Portal</a>
      </td></tr></table>
      <p style="margin:0 0 4px;font-size:12px;line-height:1.6;color:#94a3b8;text-align:center">You can see these details any time by signing in to the Student Portal.</p>
      <p style="margin:16px 0 22px;font-size:14px;line-height:1.6;color:#334155">If the time does not suit you, simply reply to this email and we will rearrange.</p>
    </td></tr>
    ${mailAssets.footerHtml(brand) ? `<tr><td style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e2e8f0">
      <p style="margin:0;font-size:11px;line-height:1.6;color:#94a3b8">${mailAssets.footerHtml(brand)}</p>
    </td></tr>` : ""}
  </table>
</div>`;

  const subject = tpl.subject;
  let emailed = false, warning = null;
  try {
    const sent = await email.sendEmail(a.email, subject, text, { html });
    emailed = !!sent.sent;
    if (!sent.sent && !sent.stubbed) warning = `The interview was saved but the email could not be sent: ${sent.error || "unknown error"}`;
  } catch (e) { warning = `The interview was saved but the email could not be sent: ${e.message}`; }

  audit.record(req, {
    action: "admission.interview.invited", entity: "Admission", entityId: a.id,
    summary: `Interview invitation sent to ${applicantName(a)} at ${a.email}` + (a.course ? ` for ${a.course}` : ""),
    after: { course: a.course, emailed },
  });

  const updated = await prisma.admission.findUnique({ where: { id: a.id }, ...withDocs });
  res.json({ admission: sAdmission(updated), emailed, warning });
});

router.put("/:id", async (req, res) => {
  const existing = await prisma.admission.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Application not found." });
  const data = pick(req.body);
  if (!data.firstName && !data.surname) {
    return res.status(400).json({ error: "An applicant needs at least a first name or surname." });
  }
  let row = await prisma.admission.update({ where: { id: req.params.id }, data });

  // If the course or intake changed, move the applicant's folder to the matching
  // Admissions / <course> / <intake> path in SharePoint (best-effort).
  let warning = null;
  const courseChanged = (existing.course || "") !== (row.course || "");
  const intakeChanged = (existing.intake || "") !== (row.intake || "") || (existing.intakeYear || "") !== (row.intakeYear || "");
  if ((courseChanged || intakeChanged) && row.spFolderId && sharepoint.isConfigured()) {
    try {
      const [courseSeg, intakeSeg] = admissionFolderSegments(row); // [course, intake, name]
      const parent = await sharepoint.ensureFolderPath([courseSeg, intakeSeg]);
      const moved = await sharepoint.moveItem(row.spFolderId, parent.id);
      row = await prisma.admission.update({ where: { id: row.id }, data: { spFolderUrl: moved.webUrl } });
    } catch (e) { warning = `Saved, but the SharePoint folder couldn't be moved: ${e.message}`; }
  }

  // Field NAMES only. This form holds an NI number, ID document numbers,
  // criminal-record answers, medical conditions, ethnicity and religion — writing the
  // values here would copy special-category data into a table that is read by more
  // people, kept longer and exported more often than the application itself. Who
  // edited which fields, and when, is what the trail is for.
  const touched = audit.changedKeys(pick(existing), pick(row));
  if (touched.length) {
    audit.record(req, {
      action: "admission.updated", entity: "Admission", entityId: row.id,
      summary: `${applicantName(row)}: ${touched.length} field(s) edited — ${touched.join(", ")}`,
      after: { fieldsChanged: touched, course: row.course, intake: row.intake, intakeYear: row.intakeYear },
    });
  }

  const full = await prisma.admission.findUnique({ where: { id: row.id }, ...withDocs });
  const out = sAdmission(full);
  if (warning) out.warning = warning;
  res.json(out);
});

router.delete("/:id", async (req, res) => {
  const existing = await prisma.admission.findUnique({ where: { id: req.params.id }, include: { documents: true } });
  if (!existing) return res.status(404).json({ error: "Application not found." });
  // Take the applicant's files with the record (their folder in SharePoint is left in
  // place — clearing a whole folder is a heavier action an admin can do in SharePoint).
  for (const d of existing.documents) {
    if (d.spItemId) await sharepoint.deleteItem(d.spItemId);
    else if (d.storagePath) await storage.removeObject(d.storagePath);
  }
  await prisma.admission.delete({ where: { id: req.params.id } });
  // An applicant's whole record and every file with it. Under a retention schedule
  // this is the erasure a college has to be able to evidence, so the row says what
  // went and how much of it — but still not what was in it.
  audit.record(req, {
    action: "admission.deleted", entity: "Admission", entityId: existing.id,
    summary: `Application for ${applicantName(existing)} deleted, with ${existing.documents.length} uploaded document(s)`,
    before: { course: existing.course, intake: existing.intake, intakeYear: existing.intakeYear, enrollStatus: existing.enrollStatus, studentId: existing.studentId, documents: existing.documents.length },
    after: null,
  });
  res.json({ ok: true });
});

module.exports = router;
