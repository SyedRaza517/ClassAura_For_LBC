const express = require("express");
const router = express.Router();
const prisma = require("../db");
const storage = require("../storage");
const { sDoc } = require("../serializers");
const { requireAuth, requirePage, hasPage } = require("../auth");
const { isString, isNonEmptyString, MAX_TEXT } = require("../validate");
const { localDate } = require("../clock");
const audit = require("../audit");

const today = () => localDate();

// How a document is named in the audit trail.
//
// The NAME of a personal document is the sensitive part — "Disciplinary outcome —
// T Ward" tells you the whole story without opening anything, which is why GET /
// redacts it for admins who lack the Documents page. The audit trail is read on the
// Settings, Access and Staff pages, so writing that name here would hand it to
// exactly the admins that redaction was protecting it from. A shared policy carries
// no such problem, so it keeps its name.
const docLabel = (d) => (d.scope === "personal" ? `a personal ${String(d.type || "document").toLowerCase()}` : `"${d.name}"`);

// GET /api/documents — admin: all; staff: shared + personal templates + own private docs
router.get("/", requireAuth, async (req, res) => {
  // Only a documents admin sees the CONTENT of every document.
  const canReadAll = hasPage(req.user, "documents");
  // Overview and Settings both render a document COUNT, and previously read the full
  // list to get it — which shipped every private document's title and assignee to
  // admins who were never granted Documents ("Disciplinary outcome — T. Ward", plus
  // the staff id it belongs to). They still get an accurate count, but a row they may
  // not read arrives redacted rather than omitted, so `docs.length` stays correct
  // without the names travelling.
  const needsCount = hasPage(req.user, ["overview", "settings"]);

  const rows = await prisma.document.findMany({ orderBy: { date: "desc" } });
  const mine = (d) => d.scope !== "personal" || d.assignedToId === req.user.id;

  if (canReadAll) return res.json(rows.map(sDoc));
  if (needsCount) {
    // A redacted stub carries NO detail of a document this admin may not read — not
    // its name, its assignee, its category, nor its date. `type` is free text that can
    // hold a sensitive label ("Disciplinary outcome", "Payslip"), so leaking it (and
    // the date) still let an overview/settings-only admin enumerate the category and
    // timing of every private HR record. Only enough to keep the COUNT correct travels.
    return res.json(rows.map((d) => (mine(d) ? sDoc(d) : {
      id: d.id, name: "Private document", type: "Document", date: null, scope: "personal", assignedTo: null, redacted: true,
    })));
  }
  res.json(rows.filter(mine).map(sDoc));
});

// POST /api/documents  (admin)
router.post("/", requireAuth, requirePage("documents"), async (req, res) => {
  const { name, type, scope, assignedTo } = req.body || {};
  if (!name) return res.status(400).json({ error: "Name required" });
  // Type-check before Prisma sees it — a non-string threw and surfaced as a 500.
  if (!isNonEmptyString(name)) return res.status(400).json({ error: "Name must be text" });
  if (name.length > MAX_TEXT) return res.status(400).json({ error: `Name is too long (${MAX_TEXT} characters maximum)` });
  if (type != null && !isString(type)) return res.status(400).json({ error: "Type must be text" });
  // For a personal doc with an assignee, guard against a bad staffId — otherwise the
  // foreign-key insert throws an unhandled P2003 and the request 500s.
  if (scope === "personal" && assignedTo != null) {
    if (typeof assignedTo !== "string") return res.status(400).json({ error: "assignedTo must be a string" });
    const staffExists = await prisma.staff.findUnique({ where: { id: assignedTo } });
    if (!staffExists) return res.status(400).json({ error: "Unknown staff member" });
  }
  const doc = await prisma.document.create({
    data: {
      name, type: type || "Policy", date: today(),
      scope: scope === "personal" ? "personal" : "all",
      assignedToId: scope === "personal" && assignedTo ? assignedTo : null,
    },
  });
  audit.record(req, {
    action: "document.created", entity: "Document", entityId: doc.id,
    summary: `${doc.scope === "personal" ? "Personal" : "Shared"} document ${docLabel(doc)} created` + (doc.assignedToId ? " and assigned" : ""),
    after: { type: doc.type, scope: doc.scope, assignedToId: doc.assignedToId, date: doc.date },
  });
  res.status(201).json(sDoc(doc));
});

/* ==================================================================== *
 *                          The file itself                             *
 * ==================================================================== */

// May this user read this document? The same rule GET / uses, in one place so the
// download path and the list path can never disagree about who sees what.
const mayRead = (doc, user) =>
  hasPage(user, "documents") || doc.scope !== "personal" || doc.assignedToId === user.id;

// POST /api/documents/:id/file  (admin) — upload the bytes for a document.
//
// The body is the RAW file. express.raw() is used rather than a multipart parser
// because that needs no dependency, and the alternative — base64 inside JSON —
// inflates every upload by a third and would need the global 1MB JSON cap raised for
// all routes. `type: "*/*"` because a policy may be a PDF, a Word file or a
// spreadsheet, and the real content type travels in the header.
router.post(
  "/:id/file",
  requireAuth,
  requirePage("documents"),
  express.raw({ type: "*/*", limit: storage.MAX_BYTES }),
  async (req, res) => {
    if (!storage.isConfigured()) {
      return res.status(503).json({ error: "Document storage isn't set up on the server yet. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." });
    }
    const doc = await prisma.document.findUnique({ where: { id: req.params.id } });
    if (!doc) return res.status(404).json({ error: "Document not found" });

    // Percent-encoded by the client, because HTTP header values must be latin-1 and a
    // filename can contain anything. A malformed value falls back rather than throwing.
    const rawName = req.get("X-File-Name") || "";
    let fileName = doc.name || "document";
    if (rawName) { try { fileName = decodeURIComponent(rawName); } catch (_) { fileName = rawName; } }
    fileName = String(fileName).slice(0, 200);
    const mimeType = String(req.get("Content-Type") || "application/octet-stream").split(";")[0];
    try {
      const { path, size } = await storage.putObject(doc.id, fileName, mimeType, req.body);
      // Replacing a file leaves no orphan: the key is derived from the document id, so
      // an upload with the same extension overwrites, and a different one is cleaned up.
      if (doc.filePath && doc.filePath !== path) await storage.removeObject(doc.filePath);
      const updated = await prisma.document.update({
        where: { id: doc.id },
        data: { filePath: path, fileName, mimeType, sizeBytes: size, uploadedAt: new Date() },
      });
      audit.record(req, {
        action: doc.filePath ? "document.file.replaced" : "document.file.uploaded",
        entity: "Document", entityId: doc.id,
        summary: `File ${doc.filePath ? "replaced" : "uploaded"} for ${docLabel(doc)} — ${size} bytes` + (doc.filePath ? ", the previous file is gone" : ""),
        before: doc.filePath ? { sizeBytes: doc.sizeBytes, mimeType: doc.mimeType, uploadedAt: doc.uploadedAt } : null,
        after: { sizeBytes: size, mimeType, scope: doc.scope, assignedToId: doc.assignedToId },
      });
      res.json(sDoc(updated));
    } catch (e) {
      // These messages are written for an administrator to act on (missing bucket,
      // file too large), so they are passed through rather than flattened to a 500.
      res.status(400).json({ error: e.message || "Upload failed" });
    }
  },
);

// GET /api/documents/:id/download — a short-lived link to read the file.
//
// Signing is NOT authorisation: the access check happens here, first, and only then
// is a URL minted. Personal documents stay readable by their owner and by a documents
// admin, exactly as the list does.
router.get("/:id/download", requireAuth, async (req, res) => {
  const doc = await prisma.document.findUnique({ where: { id: req.params.id } });
  if (!doc) return res.status(404).json({ error: "Document not found" });
  // 404 rather than 403 for a document they may not see — a 403 would confirm it
  // exists, which for a file called "Disciplinary outcome — T Ward" is itself a leak.
  if (!mayRead(doc, req.user)) return res.status(404).json({ error: "Document not found" });
  if (!doc.filePath) return res.status(404).json({ error: "No file has been uploaded for this document yet." });
  try {
    const url = await storage.signedUrl(doc.filePath);
    // Reads are not normally audited — the trail records changes, not browsing. This
    // one is the exception: an administrator opening a personal file that belongs to
    // somebody else is a privileged action on that person's HR record, and it is the
    // access a subject-access request or a grievance actually asks about. The owner
    // reading their own file is not recorded; there is nothing to answer for.
    if (doc.scope === "personal" && doc.assignedToId && doc.assignedToId !== req.user.id) {
      audit.record(req, {
        action: "document.personal.opened", entity: "Document", entityId: doc.id,
        summary: `${req.user.name} opened ${docLabel(doc)} belonging to another member of staff`,
        after: { type: doc.type, assignedToId: doc.assignedToId },
      });
    }
    res.json({ url, fileName: doc.fileName || doc.name, mimeType: doc.mimeType });
  } catch (e) {
    res.status(502).json({ error: e.message || "Could not create a download link" });
  }
});

// DELETE /api/documents/:id  (admin)
router.delete("/:id", requireAuth, requirePage("documents"), async (req, res) => {
  const existing = await prisma.document.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Document not found" });
  try {
    await prisma.document.delete({ where: { id: existing.id } });
    // After the row, and best-effort: an orphaned object wastes a little space, but a
    // deleted file with a surviving row would be a document that opens to nothing.
    await storage.removeObject(existing.filePath);
    audit.record(req, {
      action: "document.deleted", entity: "Document", entityId: existing.id,
      summary: `${existing.scope === "personal" ? "Personal" : "Shared"} document ${docLabel(existing)} deleted` + (existing.filePath ? ", and its stored file with it" : ""),
      before: { type: existing.type, scope: existing.scope, assignedToId: existing.assignedToId, date: existing.date, hadFile: !!existing.filePath },
      after: null,
    });
    res.json({ ok: true });
  } catch (e) { res.status(404).json({ error: "Document not found" }); }
});

module.exports = router;
