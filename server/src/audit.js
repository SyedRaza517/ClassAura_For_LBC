// Recording who did what.
//
// Two rules govern everything here.
//
// FIRST: an audit failure must never break the action it was recording. Approving
// leave must still approve leave if the log write fails — the same reasoning that
// makes notification failures swallowed. A system that refuses to work when it cannot
// write history is worse than one with a gap in its history.
//
// SECOND: nothing secret is ever written. Diffs pass through a redactor before they
// are stored, because "what changed" on a staff record includes passwordHash, and an
// audit log is read by more people, kept for longer, and exported more often than the
// table it describes.
const prisma = require("./db");
const { currentTenantId, crossTenant } = require("./db");

// Field names whose VALUES never reach the log. Matched case-insensitively on the
// whole name, so "passwordHash" and "totpSecret" are caught but "passwordChangedAt"
// — which is a useful thing to see change — is not.
const SECRET_FIELDS = new Set([
  "password", "passwordhash", "newpassword", "currentpassword", "confirmpassword",
  "totpsecret", "secretenc", "secret", "token", "tokenhash", "uploadtokenhash",
  "offertokenhash", "clientsecret", "apikey", "credentialskey", "jwtsecret",
]);

// Values longer than this are truncated. An audit row is a summary of a change, not
// a copy of the record — a 40KB JSON blob in a Json column, per action, is how an
// audit table becomes the largest thing in the database.
const MAX_VALUE_LEN = 500;
const MAX_KEYS = 40;

function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 4) return "[deep]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(value)) {
      if (n++ >= MAX_KEYS) { out["…"] = "truncated"; break; }
      if (SECRET_FIELDS.has(k.toLowerCase())) { out[k] = "[redacted]"; continue; }
      out[k] = redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > MAX_VALUE_LEN) {
    return value.slice(0, MAX_VALUE_LEN) + "… (" + value.length + " chars)";
  }
  return value;
}

/** Only the fields that actually differ, so the log shows the change not the record. */
function diff(before, after) {
  if (!before || !after) return { before: redact(before), after: redact(after) };
  const b = {}, a = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    const bv = before[k], av = after[k];
    if (JSON.stringify(bv) === JSON.stringify(av)) continue;
    b[k] = redact(bv); a[k] = redact(av);
  }
  return { before: Object.keys(b).length ? b : null, after: Object.keys(a).length ? a : null };
}

/**
 * Who is acting, worked out from the request. A platform operator and a staff member
 * are different tiers, and the log has to say which — actorId alone is ambiguous
 * because a PlatformAdmin is not a Staff row.
 */
function actorFrom(req) {
  if (req?.platformAdmin) {
    return { actorType: "platform", actorId: req.platformAdmin.id, actorEmail: req.platformAdmin.email };
  }
  if (req?.user) {
    return { actorType: "staff", actorId: req.user.id, actorEmail: req.user.email || null };
  }
  return { actorType: "system", actorId: null, actorEmail: null };
}

/**
 * Record one event. Fire-and-forget by design — callers do not await it, and it
 * cannot reject.
 *
 * @param {object} req      the Express request, for actor and address (optional)
 * @param {object} evt
 * @param {string} evt.action    dotted verb, e.g. "staff.access.changed"
 * @param {string} evt.summary   one readable line
 * @param {string} [evt.entity]  model name
 * @param {string} [evt.entityId]
 * @param {object} [evt.before]  previous state — diffed and redacted
 * @param {object} [evt.after]   new state
 * @param {string} [evt.tenantId] required only outside a tenant-scoped request
 */
function record(req, evt) {
  // Resolve everything synchronously, before the caller's context can unwind.
  let payload;
  try {
    const tenantId = evt.tenantId || currentTenantId();
    if (!tenantId) {
      // Nothing to attach it to. Log loudly rather than silently dropping, because a
      // privileged action with no audit row is exactly what this exists to prevent.
      console.error("[audit] dropped '" + evt.action + "' — no tenant in scope and none supplied");
      return;
    }
    const { before, after } = diff(evt.before, evt.after);
    payload = {
      tenantId,
      ...actorFrom(req),
      action: String(evt.action || "unknown").slice(0, 100),
      entity: evt.entity ? String(evt.entity).slice(0, 60) : null,
      entityId: evt.entityId ? String(evt.entityId).slice(0, 60) : null,
      summary: String(evt.summary || evt.action || "").slice(0, 500),
      before, after,
      ip: req?.ip ? String(req.ip).slice(0, 60) : null,
      userAgent: req?.headers?.["user-agent"] ? String(req.headers["user-agent"]).slice(0, 300) : null,
    };
  } catch (e) {
    console.error("[audit] could not build entry for '" + (evt && evt.action) + "':", e.message);
    return;
  }

  // crossTenant, then an explicit tenantId: a platform operator acts OUTSIDE any
  // tenant scope, but the row belongs to the institution they affected. Awaiting this
  // would make every audited action wait on a write nobody is reading yet.
  crossTenant(() => prisma.auditLog.create({ data: payload }))
    .catch((e) => console.error("[audit] write failed for '" + payload.action + "':", e.message));
}

module.exports = { record, redact, diff, actorFrom };
