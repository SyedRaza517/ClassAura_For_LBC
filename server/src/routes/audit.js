// Reading the audit trail.
//
// READ ONLY, deliberately and completely. There is no POST, no PUT and no DELETE in
// this file and there should never be one: a log the people it records can edit is
// not evidence, and the whole reason a college asks for an audit trail is to be able
// to answer "who changed this" to somebody who does not trust the answer.
//
// Mounted inside the tenant middleware, so an institution's administrator sees their
// own history and no one else's — including the rows describing what a platform
// operator did TO them, which they are entitled to see.
const express = require("express");
const prisma = require("../db");
const { requireAuth, requireAnyPage } = require("../auth");

const router = express.Router();

// Reading the audit trail means reading, in summary, every change anyone made — who
// was granted access, whose leave was refused, whose credentials were replaced. That
// is an administrative capability, so it is gated on the pages that already carry
// administrative authority rather than being open to any signed-in user.
const AUDIT_PAGES = ["settings", "access", "staff"];

const MAX_PAGE = 200;
const str = (v) => (typeof v === "string" ? v.trim() : "");

// GET /api/audit
//   ?action=      exact dotted verb, e.g. "leave.decided"
//   ?entity=      model name, e.g. "Staff"
//   ?entityId=    one record's whole history
//   ?actorId=     everything one person did
//   ?from= &to=   ISO dates
//   ?take= &cursor=
router.get("/", requireAuth, requireAnyPage(AUDIT_PAGES), async (req, res) => {
  const where = {};
  const action = str(req.query.action);
  const entity = str(req.query.entity);
  const entityId = str(req.query.entityId);
  const actorId = str(req.query.actorId);
  const from = str(req.query.from);
  const to = str(req.query.to);

  if (action) where.action = action;
  if (entity) where.entity = entity;
  if (entityId) where.entityId = entityId;
  if (actorId) where.actorId = actorId;
  if (from || to) {
    where.at = {};
    // An unparseable date is ignored rather than 400ing: this is a filter on a
    // reading screen, and returning everything is more useful than an error.
    if (from && !isNaN(Date.parse(from))) where.at.gte = new Date(from);
    if (to && !isNaN(Date.parse(to))) where.at.lte = new Date(to);
    if (!Object.keys(where.at).length) delete where.at;
  }

  const take = Math.min(Math.max(parseInt(req.query.take, 10) || 50, 1), MAX_PAGE);
  const cursor = str(req.query.cursor);

  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: [{ at: "desc" }, { id: "desc" }],
    take: take + 1, // one extra, to know whether there is another page
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  res.json({
    entries: page,
    nextCursor: hasMore ? page[page.length - 1].id : null,
  });
});

// GET /api/audit/actions — the distinct verbs present, for building a filter without
// hardcoding a list in the client that would drift from what is actually recorded.
router.get("/actions", requireAuth, requireAnyPage(AUDIT_PAGES), async (_req, res) => {
  const rows = await prisma.auditLog.groupBy({ by: ["action"], _count: { _all: true }, orderBy: { action: "asc" } });
  res.json(rows.map((r) => ({ action: r.action, count: r._count._all })));
});

module.exports = router;
