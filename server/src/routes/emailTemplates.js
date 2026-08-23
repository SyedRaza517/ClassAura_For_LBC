// A college's own wording for the emails the system sends.
//
// Inside the tenant middleware, so a college reaches only its own. See
// emailTemplate.js for why placeholders are substituted rather than evaluated, and
// why a body is escaped before it is sent.
const express = require("express");
const prisma = require("./../db");
const { requireAuth, requirePage } = require("./../auth");
const et = require("./../emailTemplate");
const audit = require("./../audit");

const router = express.Router();

const MAX_SUBJECT = 200;
const MAX_BODY = 8000;

const present = (kind, row) => ({
  kind,
  label: et.KINDS[kind].label,
  when: et.KINDS[kind].when,
  fields: et.KINDS[kind].fields,
  defaultSubject: et.KINDS[kind].defaultSubject,
  defaultBody: et.KINDS[kind].defaultBody,
  subject: row?.subject ?? null,
  body: row?.body ?? null,
  enabled: row?.enabled ?? false,
  updatedAt: row?.updatedAt ?? null,
  updatedBy: row?.updatedBy ?? null,
});

// GET /api/email-templates — every email a college may reword.
router.get("/", requireAuth, requirePage("settings"), async (_req, res) => {
  const rows = await prisma.tenantEmailTemplate.findMany();
  const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));
  res.json({ templates: Object.keys(et.KINDS).map((k) => present(k, byKind[k])) });
});

// GET /api/email-templates/:kind/preview — exactly what would be sent, with sample
// values. A college should never have to send a real applicant a test.
router.get("/:kind/preview", requireAuth, requirePage("settings"), async (req, res) => {
  const kind = String(req.params.kind || "");
  if (!et.KINDS[kind]) return res.status(404).json({ error: "Unknown email" });
  const samples = {
    firstName: "Amina", lastName: "Hassan", fullName: "Amina Hassan",
    course: "HND Business", intake: "September", intakeYear: "2026",
    interviewDate: "3 September 2026", interviewTime: "10:30",
    tutorName: "Daniel Okoye", meetingDate: "14 September 2026",
    attendancePct: "68",
  };
  const out = await et.render(kind, samples);
  res.json(out);
});

// PUT /api/email-templates/:kind — save this college's wording.
router.put("/:kind", requireAuth, requirePage("settings"), async (req, res) => {
  const kind = String(req.params.kind || "");
  const spec = et.KINDS[kind];
  if (!spec) return res.status(404).json({ error: "Unknown email" });

  const body = req.body || {};
  const data = { kind, updatedBy: req.user?.email || null };

  if (body.subject !== undefined) {
    const v = String(body.subject || "").trim();
    if (v.length > MAX_SUBJECT) return res.status(400).json({ error: `The subject must be ${MAX_SUBJECT} characters or fewer.` });
    data.subject = v || null;
  }
  if (body.body !== undefined) {
    const v = String(body.body || "").trim();
    if (v.length > MAX_BODY) return res.status(400).json({ error: `The message must be ${MAX_BODY} characters or fewer.` });
    data.body = v || null;
  }

  // A placeholder that does not exist is REFUSED rather than saved and silently sent
  // as literal "{{studentName}}" to an applicant. Naming the offender and the valid
  // list makes it a typo to fix rather than a mystery.
  for (const [what, text] of [["subject", data.subject], ["message", data.body]]) {
    if (!text) continue;
    const bad = et.unknownPlaceholders(text, kind);
    if (bad.length) {
      return res.status(400).json({
        error: `The ${what} uses ${bad.map((b) => "{{" + b + "}}").join(", ")}, which ${bad.length === 1 ? "is not a value" : "are not values"} available in this email. You can use: ${spec.fields.map((f) => "{{" + f + "}}").join(", ")}.`,
      });
    }
  }

  if (body.enabled !== undefined) data.enabled = !!body.enabled;

  const existing = await prisma.tenantEmailTemplate.findFirst({ where: { kind } });
  const saved = existing
    ? await prisma.tenantEmailTemplate.update({ where: { id: existing.id }, data })
    : await prisma.tenantEmailTemplate.create({ data });

  audit.record(req, {
    action: "emailTemplate.saved", entity: "TenantEmailTemplate", entityId: saved.id,
    summary: `"${spec.label}" email ${existing ? "updated" : "customised"} — ${saved.enabled ? "in use" : "not in use"}`,
    before: existing ? { enabled: existing.enabled, subject: existing.subject } : null,
    after: { enabled: saved.enabled, subject: saved.subject },
  });

  res.json(present(kind, saved));
});

// DELETE /api/email-templates/:kind — back to the built-in wording.
router.delete("/:kind", requireAuth, requirePage("settings"), async (req, res) => {
  const kind = String(req.params.kind || "");
  if (!et.KINDS[kind]) return res.status(404).json({ error: "Unknown email" });
  const existing = await prisma.tenantEmailTemplate.findFirst({ where: { kind } });
  if (!existing) return res.json({ removed: false });
  await prisma.tenantEmailTemplate.delete({ where: { id: existing.id } });
  audit.record(req, {
    action: "emailTemplate.removed", entity: "TenantEmailTemplate", entityId: existing.id,
    summary: `"${et.KINDS[kind].label}" email reset to the built-in wording`,
  });
  res.json({ removed: true });
});

module.exports = router;
