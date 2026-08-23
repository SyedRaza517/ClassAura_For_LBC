// A college's own offer-letter and application-form PDFs.
//
// Upload the letter you already send, position the applicant's details on it, preview
// it, switch it on. From then on every letter is your document with the details
// written on — not a redrawing of it. See docTemplate.js for why nothing is redrawn.
//
// Inside the tenant middleware, so a college can only ever reach its own templates.
const express = require("express");
const prisma = require("./../db");
const { requireAuth, requirePage } = require("./../auth");
const dt = require("./../docTemplate");
const audit = require("./../audit");

const router = express.Router();

const KINDS = ["offer", "application"];
const isKind = (k) => KINDS.includes(k);

// The PDF arrives as a base64 data URI, like the branding logo, so a college
// uploading its letterhead does not first need object storage configured.
const DATA_URI = /^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/i;

/** What a client may see. Never the PDF bytes — those are fetched separately, as a
 *  PDF, rather than inflating every JSON response by a few megabytes. */
function present(row) {
  if (!row) return null;
  return {
    kind: row.kind,
    pdfName: row.pdfName,
    pdfPages: row.pdfPages,
    fields: dt.parseFields(row.fields),
    enabled: row.enabled,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
    hasPdf: true,
  };
}

/* ----------------------------------------------------------------- read ----- */

// GET /api/doc-templates — what this college has set up, and what may be placed.
router.get("/", requireAuth, requirePage("settings"), async (_req, res) => {
  const rows = await prisma.tenantDocTemplate.findMany();
  const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));
  res.json({
    templates: KINDS.map((k) => ({
      kind: k,
      template: present(byKind[k]),
      // The placeable values, so the editor and the generator can never disagree
      // about what exists.
      fields: dt.FIELDS[k] || [],
    })),
    limits: { maxPdfBytes: dt.MAX_PDF_BYTES },
  });
});

// GET /api/doc-templates/:kind/pdf — the uploaded PDF itself, for the editor to
// render behind the draggable fields.
router.get("/:kind/pdf", requireAuth, requirePage("settings"), async (req, res) => {
  const kind = String(req.params.kind || "").toLowerCase();
  if (!isKind(kind)) return res.status(404).json({ error: "Unknown template" });
  const row = await prisma.tenantDocTemplate.findFirst({ where: { kind } });
  if (!row) return res.status(404).json({ error: "No template uploaded" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${(row.pdfName || kind).replace(/[^\w.-]/g, "_")}"`);
  res.send(Buffer.from(row.pdf));
});

// GET /api/doc-templates/:kind/preview — the college's template filled with sample
// values, so they see their own letter completed before an applicant does.
router.get("/:kind/preview", requireAuth, requirePage("settings"), async (req, res) => {
  const kind = String(req.params.kind || "").toLowerCase();
  if (!isKind(kind)) return res.status(404).json({ error: "Unknown template" });
  const row = await prisma.tenantDocTemplate.findFirst({ where: { kind } });
  if (!row) return res.status(404).json({ error: "No template uploaded" });
  // Positions may be posted for preview without being saved, so a college can try a
  // placement before committing to it.
  const fields = req.query.fields ? String(req.query.fields) : row.fields;
  try {
    const out = await dt.preview(Buffer.from(row.pdf), fields, kind);
    res.setHeader("Content-Type", "application/pdf");
    res.send(out);
  } catch (e) {
    res.status(400).json({ error: "Could not build a preview: " + e.message });
  }
});

/* ---------------------------------------------------------------- write ----- */

// PUT /api/doc-templates/:kind — upload a PDF and/or save field positions.
router.put("/:kind", requireAuth, requirePage("settings"), async (req, res) => {
  const kind = String(req.params.kind || "").toLowerCase();
  if (!isKind(kind)) return res.status(404).json({ error: "Unknown template" });

  const body = req.body || {};
  const existing = await prisma.tenantDocTemplate.findFirst({ where: { kind } });
  const data = { kind, updatedBy: req.user?.email || null };

  if (body.pdfDataUri !== undefined) {
    const m = DATA_URI.exec(String(body.pdfDataUri || "").trim());
    if (!m) return res.status(400).json({ error: "The template must be a PDF." });
    const buf = Buffer.from(m[1], "base64");
    if (buf.length > dt.MAX_PDF_BYTES) {
      return res.status(400).json({
        error: `That PDF is ${Math.round(buf.length / 1024 / 1024 * 10) / 10}MB. The limit is ${dt.MAX_PDF_BYTES / 1024 / 1024}MB.`,
      });
    }
    // Parsed BEFORE it is stored: a file that pdf-lib cannot open would otherwise be
    // accepted here and fail later, at the moment an offer letter was being sent.
    let info;
    try {
      info = await dt.inspect(buf);
    } catch (e) {
      return res.status(400).json({ error: "That file could not be read as a PDF. " + e.message });
    }
    data.pdf = buf;
    data.pdfName = String(body.pdfName || "template.pdf").slice(0, 160);
    data.pdfPages = info.pages;
    // A new PDF invalidates positions measured against the old one — silently keeping
    // them would put the applicant's name in the wrong place on a letter that looks
    // right at a glance. Cleared, and switched off until repositioned.
    if (existing && body.fields === undefined) {
      data.fields = null;
      data.enabled = false;
    }
  }

  if (body.fields !== undefined) {
    const list = Array.isArray(body.fields) ? body.fields : [];
    const allowed = new Set((dt.FIELDS[kind] || []).map((f) => f.key));
    const cleaned = [];
    for (const f of list) {
      if (!f || !allowed.has(f.key)) continue;   // an unknown key is dropped, not stored
      cleaned.push({
        key: f.key,
        page: Math.max(0, Number(f.page) || 0),
        xPct: Math.min(1, Math.max(0, Number(f.xPct) || 0)),
        yPct: Math.min(1, Math.max(0, Number(f.yPct) || 0)),
        size: Math.min(72, Math.max(4, Number(f.size) || 11)),
        bold: !!f.bold,
        align: ["left", "center", "right"].includes(f.align) ? f.align : "left",
        colour: /^#[0-9a-f]{6}$/i.test(String(f.colour || "")) ? f.colour : "#000000",
      });
    }
    data.fields = JSON.stringify(cleaned);
  }

  if (body.enabled !== undefined) {
    const on = !!body.enabled;
    // Switching it on with nothing positioned would send letters with no applicant
    // name on them, which is worse than sending the built-in letter.
    const willHaveFields = data.fields !== undefined ? data.fields : existing?.fields;
    if (on && !dt.parseFields(willHaveFields).length) {
      return res.status(400).json({ error: "Place at least one field on the template before switching it on." });
    }
    data.enabled = on;
  }

  if (!existing && !data.pdf) return res.status(400).json({ error: "Upload a PDF first." });

  const saved = existing
    ? await prisma.tenantDocTemplate.update({ where: { id: existing.id }, data })
    : await prisma.tenantDocTemplate.create({ data });

  audit.record(req, {
    action: "docTemplate.saved", entity: "TenantDocTemplate", entityId: saved.id,
    summary: `${kind === "offer" ? "Offer letter" : "Application form"} template ` +
      (data.pdf ? "uploaded" : "updated") + `, ${saved.enabled ? "in use" : "not in use"}` +
      ` (${dt.parseFields(saved.fields).length} field(s) placed)`,
    // Never the PDF bytes — an audit row is a summary, not a copy of every version of
    // a five-megabyte document.
    before: existing ? { enabled: existing.enabled, fields: dt.parseFields(existing.fields).length, pdfName: existing.pdfName } : null,
    after: { enabled: saved.enabled, fields: dt.parseFields(saved.fields).length, pdfName: saved.pdfName },
  });

  res.json(present(saved));
});

// DELETE /api/doc-templates/:kind — back to the built-in letter.
router.delete("/:kind", requireAuth, requirePage("settings"), async (req, res) => {
  const kind = String(req.params.kind || "").toLowerCase();
  if (!isKind(kind)) return res.status(404).json({ error: "Unknown template" });
  const existing = await prisma.tenantDocTemplate.findFirst({ where: { kind } });
  if (!existing) return res.json({ removed: false });
  await prisma.tenantDocTemplate.delete({ where: { id: existing.id } });
  audit.record(req, {
    action: "docTemplate.removed", entity: "TenantDocTemplate", entityId: existing.id,
    summary: `${kind === "offer" ? "Offer letter" : "Application form"} template removed — reverting to the built-in document`,
  });
  res.json({ removed: true, note: "Removed. Documents will use the built-in layout again." });
});

module.exports = router;
