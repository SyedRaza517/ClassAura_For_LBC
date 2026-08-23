// Applicant portal — a prospective student self-registers, signs in, and manages their
// own application: fill/edit the form, upload documents, see the offer letter, and see
// their interview call + outcome and overall progress.
//
// An "applicant" is an Admission row that has been given a passwordHash. Login is the
// shared /api/auth/login (it issues a kind:"applicant" token); auth.js confines that
// token to this router + /api/auth. Registration below is PUBLIC (before the guard);
// everything after router.use(requireAuth, requireApplicant) is scoped to req.user.id —
// an applicant can only ever see and change their OWN record.
const express = require("express");
const router = express.Router();
const prisma = require("../db");
const sharepoint = require("../sharepoint");
const storage = require("../storage");
const { ADMISSION_DOC_TYPES, DOC_KEYS, docLabel, admissionFolderSegments } = require("../admissionDocs");
const { pick, str } = require("../admissionFields");
const { hashPassword, verifyPassword, signApplicantToken, requireAuth, requireApplicant } = require("../auth");
const { sApplicant } = require("../serializers");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const safeName = (s) => String(s || "").replace(/[\\/:*?"<>|#%]+/g, " ").replace(/\s+/g, " ").trim();

// Is this email already a login anywhere — staff, student, or another applicant account?
// Login is shared, so an applicant email must be unique across all three or the login
// would resolve to the wrong account. `exceptId` skips the caller's own Admission row.
async function emailInUse(emailLc, exceptId) {
  const [staff, student, appl] = await Promise.all([
    prisma.staff.findFirst({ where: { email: emailLc } }).catch(() => null),
    prisma.student.findFirst({ where: { email: emailLc } }).catch(() => null),
    prisma.admission.findFirst({
      where: {
        email: { equals: emailLc, mode: "insensitive" },
        passwordHash: { not: null },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
    }).catch(() => null),
  ]);
  return !!(staff || student || appl);
}

// The applicant's own view of their application — safe to send to them (no token hashes,
// no passwordHash). Includes the form fields (to edit), the document checklist, the offer,
// the interview call + outcome, and a small progress summary the portal renders as a tracker.
function meView(a) {
  const byType = Object.fromEntries((a.documents || []).map((d) => [d.docType, d]));
  const documents = ADMISSION_DOC_TYPES.map((t) => {
    const d = byType[t.key];
    return { key: t.key, label: t.label, uploaded: !!d, fileName: d?.fileName || null, confirmed: !!d?.confirmed, uploadedAt: d?.uploadedAt || null };
  });
  const uploaded = documents.filter((d) => d.uploaded).length;
  const confirmed = documents.filter((d) => d.confirmed).length;

  // Only the writable form fields, straight off the row (null → "" for the inputs).
  const application = {};
  for (const k of require("../admissionFields").FIELDS) application[k] = a[k] == null ? "" : a[k];

  return {
    id: a.id,
    email: a.email || "",
    firstName: a.firstName || "",
    surname: a.surname || "",
    name: [a.firstName, a.surname].filter(Boolean).join(" ") || a.email || "Applicant",
    application,
    documents,
    offer: {
      status: a.offerStatus || null,            // null | "sent" | "accepted"
      sentAt: a.offerSentAt || null,
      acceptedAt: a.offerAcceptedAt || null,
      inductionDate: a.offerInductionDate || "",
    },
    interview: {
      inviteSentAt: a.interviewInviteSentAt || null,
      date: a.interviewInviteDate || "",
      time: a.interviewInviteTime || "",
      mode: a.interviewInviteMode || "",
      location: a.interviewInviteLocation || "",
      link: a.interviewInviteLink || "",
      note: a.interviewInviteNote || "",
      outcome: a.ismOutcome || null,            // "Yes" | "No" | "May Be" | null
    },
    progress: {
      applicationSubmitted: !!a.applicationSubmittedAt,
      submittedAt: a.applicationSubmittedAt || null,
      docsTotal: documents.length,
      docsUploaded: uploaded,
      docsConfirmed: confirmed,
      interviewInvited: !!a.interviewInviteSentAt,
      interviewOutcome: a.ismOutcome || null,
      offerStatus: a.offerStatus || null,
      offerAccepted: a.offerStatus === "accepted",
      enrollStatus: a.enrollStatus || null,     // "Enroll" | "Rejected" | "Withdraw" | null
      enrolled: a.enrollStatus === "Enroll",
      inductionDate: a.enrolInductionDate || "",
      inductionTime: a.enrolInductionTime || "",
    },
  };
}

const loadMe = (id) => prisma.admission.findUnique({ where: { id }, include: { documents: { orderBy: { uploadedAt: "asc" } } } });

/* ============================ PUBLIC ============================ */

// POST /api/applicant/register — create an applicant account (open self-registration).
// Auto-signs-in on success by returning a session token, like the login endpoint.
router.post("/register", async (req, res) => {
  const b = req.body || {};
  const email = str(b.email).toLowerCase();
  const firstName = str(b.firstName);
  const surname = str(b.surname);
  const password = typeof b.password === "string" ? b.password : "";
  const confirm = typeof b.confirmPassword === "string" ? b.confirmPassword : "";

  if (!firstName || !surname) return res.status(400).json({ error: "Please enter your first name and surname." });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Please enter a valid email address." });
  if (password.length < 8) return res.status(400).json({ error: "Your password must be at least 8 characters." });
  if (password !== confirm) return res.status(400).json({ error: "The two passwords don't match." });

  if (await emailInUse(email, null)) {
    return res.status(409).json({ error: "This email is already registered. Please sign in instead, or use a different email." });
  }

  const created = await prisma.admission.create({
    data: { email, firstName, surname, passwordHash: hashPassword(password), active: true, source: "portal" },
  });
  return res.status(201).json({ token: signApplicantToken(created), user: { ...sApplicant(created), kind: "applicant" } });
});

// --- check-email rate limiter (per IP) ---
//
// The endpoint below answers, to anybody, "does this address have an account here?" —
// across staff, students AND applicants. Unauthenticated and unthrottled, that is a
// roster oracle: feed it a breach dump and it tells you which of those people work or
// study at the college, which is the reconnaissance step before a credential-stuffing
// or phishing run. The login itself has been rate limited since July precisely so it
// could not be used this way; this endpoint was the same oracle with no password to
// guess and no lockout to hit.
//
// Same in-process shape as the limiters in routes/auth.js — a module-level Map, a
// window, and a sweep on a size trigger so unauthenticated traffic from random
// addresses cannot grow it without bound. Correct for one Node process; a clustered
// deployment needs a shared store (Redis) for this one exactly as it does for those.
const CHECK_ATTEMPTS = new Map();
const CHECK_WINDOW_MS = 15 * 60 * 1000;
// Generous on purpose. The form calls this on BLUR of the email field, so one real
// person registering costs a handful, and a college network puts every applicant
// behind one NAT address. The cap is set to stop a script working through a list, not
// to ration a form: 40 in a quarter of an hour is far more than a shared address of
// genuine applicants produces and far less than enumeration needs.
const CHECK_MAX = 40;
const CHECK_SWEEP_ABOVE = 5000;

function checkEmailBudgetSpent(req) {
  const key = String(req.ip || "?");
  const now = Date.now();
  let s = CHECK_ATTEMPTS.get(key);
  if (!s || now - s.first > CHECK_WINDOW_MS) { s = { count: 0, first: now }; CHECK_ATTEMPTS.set(key, s); }
  s.count += 1;
  // Swept on read, so a caller who is over budget cannot stop the tidying by going
  // quiet — the same reasoning as sweep() in auth.js.
  if (CHECK_ATTEMPTS.size > CHECK_SWEEP_ABOVE) {
    for (const [k, v] of CHECK_ATTEMPTS) if (now - v.first > CHECK_WINDOW_MS) CHECK_ATTEMPTS.delete(k);
  }
  return s.count > CHECK_MAX;
}

// POST /api/applicant/check-email — live "is this email free?" check for the forms.
router.post("/check-email", async (req, res) => {
  const email = str(req.body?.email).toLowerCase();
  // A malformed address never reaches the database, so it costs nothing and is not
  // charged against the budget — otherwise somebody typing their address slowly, one
  // blur at a time, would spend it on nothing.
  if (!EMAIL_RE.test(email)) return res.json({ valid: false, available: false });

  // Over budget: stop ANSWERING the question rather than refusing the request. A 429
  // here would be worse than useless — api.js turns any failure into
  // { valid: false, available: false }, which the register form renders as "this email
  // is already taken", so a throttled honest applicant would be told to pick a
  // different address. Saying "available" instead simply removes the live hint; the
  // register endpoint still refuses a duplicate with a clear 409, which is the check
  // that actually matters. `checked: false` is there so a caller can tell the two
  // apart; nothing enumerable is in the reply either way.
  if (checkEmailBudgetSpent(req)) return res.json({ valid: true, available: true, checked: false });

  res.json({ valid: true, available: !(await emailInUse(email, null)), checked: true });
});

/* ======================= AUTHENTICATED (applicant only) ======================= */
router.use(requireAuth, requireApplicant);

// GET /api/applicant/me — the whole application + progress.
router.get("/me", async (req, res) => {
  const a = await loadMe(req.user.id);
  if (!a) return res.status(404).json({ error: "Your application could not be found." });
  res.json(meView(a));
});

// PUT /api/applicant/me — save the application form (draft). The email field is the
// account login too, so a change is uniqueness-checked; a blank email is ignored rather
// than clearing the login.
router.put("/me", async (req, res) => {
  const data = pick(req.body); // trims + length-caps only the known Admission columns

  if (data.email) {
    const newEmail = String(data.email).toLowerCase();
    if (newEmail !== (req.user.email || "").toLowerCase() && (await emailInUse(newEmail, req.user.id))) {
      return res.status(409).json({ error: "That email is already in use — please use a different email." });
    }
    data.email = newEmail;
  } else {
    delete data.email; // never null-out the account email
  }

  await prisma.admission.update({ where: { id: req.user.id }, data });
  const a = await loadMe(req.user.id);
  res.json(meView(a));
});

// POST /api/applicant/me/submit — save + mark the application submitted (the progress
// tracker's "Application" step). Requires the essentials; the client enforces the full set.
router.post("/me/submit", async (req, res) => {
  const data = pick(req.body);
  if (data.email) {
    const newEmail = String(data.email).toLowerCase();
    if (newEmail !== (req.user.email || "").toLowerCase() && (await emailInUse(newEmail, req.user.id))) {
      return res.status(409).json({ error: "That email is already in use — please use a different email." });
    }
    data.email = newEmail;
  } else {
    delete data.email;
  }
  if (!data.firstName || !data.surname || !data.course) {
    return res.status(400).json({ error: "Please complete at least your name and chosen course before submitting." });
  }
  const existing = await prisma.admission.findUnique({ where: { id: req.user.id } });
  data.applicationSubmittedAt = existing?.applicationSubmittedAt || new Date();
  await prisma.admission.update({ where: { id: req.user.id }, data });
  const a = await loadMe(req.user.id);
  res.json(meView(a));
});

// GET /api/applicant/documents — the upload checklist.
router.get("/documents", async (req, res) => {
  const a = await loadMe(req.user.id);
  res.json({ docs: meView(a).documents });
});

// POST /api/applicant/documents?type=<docType> — upload/replace one document. Raw file
// body + X-File-Name, normalised to PDF, stored to SharePoint (or Supabase fallback).
// Mirrors the token-based public upload route, but scoped to the logged-in applicant.
router.post("/documents", express.raw({ type: "*/*", limit: sharepoint.MAX_BYTES }), async (req, res) => {
  const type = String(req.query.type || "");
  if (!DOC_KEYS.includes(type)) return res.status(400).json({ error: "Unknown document type." });
  if (!req.body || !req.body.length) return res.status(400).json({ error: "The file is empty." });

  const admission = await prisma.admission.findUnique({ where: { id: req.user.id } });
  if (!admission) return res.status(404).json({ error: "Your application could not be found." });

  // Everything is stored as a PDF (a real PDF passes through; a photo is wrapped).
  let buffer, contentType;
  try {
    const out = await require("../uploadToPdf").ensurePdf(req.body);
    buffer = out.buffer; contentType = out.contentType;
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const storedName = `${safeName(docLabel(type))}.pdf`;

  const existing = await prisma.admissionDocument.findUnique({
    where: { admissionId_docType: { admissionId: admission.id, docType: type } },
  });

  let data;
  try {
    if (sharepoint.isConfigured()) {
      let folderId = admission.spFolderId;
      if (!folderId) {
        const folder = await sharepoint.ensureFolderPath(admissionFolderSegments(admission));
        folderId = folder.id;
        await prisma.admission.update({ where: { id: admission.id }, data: { spFolderId: folder.id, spFolderUrl: folder.webUrl } });
      }
      if (existing?.spItemId) await sharepoint.deleteItem(existing.spItemId);
      const up = await sharepoint.uploadFile(folderId, storedName, buffer, contentType);
      data = { fileName: storedName, mimeType: "application/pdf", sizeBytes: up.size, spItemId: up.id, webUrl: up.webUrl, storagePath: null };
    } else if (storage.isConfigured()) {
      if (existing?.storagePath) await storage.removeObject(existing.storagePath);
      const key = `adm_${admission.id}_${type}`;
      const up = await storage.putObject(key, storedName, contentType, buffer);
      data = { fileName: storedName, mimeType: "application/pdf", sizeBytes: up.size, spItemId: null, webUrl: null, storagePath: up.path };
    } else {
      return res.status(503).json({ error: "Document storage isn't set up on the server yet. Please try again later." });
    }
  } catch (e) {
    return res.status(400).json({ error: e.message || "Upload failed." });
  }

  const base = { ...data, uploadedAt: new Date(), confirmed: false, confirmedAt: null, confirmedBy: null };
  await prisma.admissionDocument.upsert({
    where: { admissionId_docType: { admissionId: admission.id, docType: type } },
    create: { admissionId: admission.id, docType: type, ...base },
    update: base,
  });
  const a = await loadMe(req.user.id);
  res.json({ ok: true, docs: meView(a).documents });
});

// GET /api/applicant/offer — the applicant's offer state.
router.get("/offer", async (req, res) => {
  const a = await prisma.admission.findUnique({ where: { id: req.user.id } });
  if (!a) return res.status(404).json({ error: "Your application could not be found." });
  res.json({
    status: a.offerStatus || null,
    sentAt: a.offerSentAt || null,
    acceptedAt: a.offerAcceptedAt || null,
    inductionDate: a.offerInductionDate || "",
    course: a.course || "",
    name: [a.firstName, a.surname].filter(Boolean).join(" ") || "Applicant",
  });
});

// POST /api/applicant/offer/accept — accept the offer (idempotent; only once sent).
router.post("/offer/accept", async (req, res) => {
  const a = await prisma.admission.findUnique({ where: { id: req.user.id } });
  if (!a) return res.status(404).json({ error: "Your application could not be found." });
  if (!a.offerStatus) return res.status(400).json({ error: "You don't have an offer to accept yet." });
  if (a.offerStatus !== "accepted") {
    await prisma.admission.update({ where: { id: a.id }, data: { offerStatus: "accepted", offerAcceptedAt: new Date() } });
  }
  const fresh = await loadMe(req.user.id);
  res.json(meView(fresh));
});

// Stream a PDF as a download.
const sendPdf = (res, filename, buf) => {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${String(filename).replace(/[^A-Za-z0-9 ._-]/g, "_")}"`);
  res.send(buf);
};
const nameOf = (a) => [a.firstName, a.surname].filter(Boolean).join(" ") || "Applicant";

// GET /api/applicant/offer-letter.pdf — download the official offer letter (once sent).
router.get("/offer-letter.pdf", async (req, res) => {
  const a = await prisma.admission.findUnique({ where: { id: req.user.id } });
  if (!a) return res.status(404).json({ error: "Your application could not be found." });
  if (!a.offerStatus) return res.status(400).json({ error: "Your offer letter isn't available yet." });
  try {
    const buf = await require("../offerLetter").buildOfferLetterPdf(a, {
      inductionDate: a.offerInductionDate || "",
      // Falls through to the institution's own signatory in offerLetter.js rather than
      // naming one college's admissions officer on every other college's letters.
      signatoryName: a.offerSignatoryName || undefined,
      signatoryTitle: "Admissions Officer",
    });
    sendPdf(res, `Offer Letter - ${nameOf(a)}.pdf`, buf);
  } catch (e) {
    res.status(500).json({ error: e.message || "Could not build the offer letter PDF" });
  }
});

// GET /api/applicant/application.pdf — download a PDF copy of the application form.
router.get("/application.pdf", async (req, res) => {
  const a = await prisma.admission.findUnique({ where: { id: req.user.id } });
  if (!a) return res.status(404).json({ error: "Your application could not be found." });
  try {
    const buf = await require("../applicationPdf").buildApplicationPdf(a);
    sendPdf(res, `Application Form - ${nameOf(a)}.pdf`, buf);
  } catch (e) {
    res.status(500).json({ error: e.message || "Could not build the application PDF" });
  }
});

module.exports = router;
