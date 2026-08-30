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
    // The secret check has to happen HERE as well as inside redact(). redact() only
    // consults SECRET_FIELDS while walking the entries of an object it was handed;
    // this loop hands it the VALUE, already separated from its key, so a top-level
    // secret arrived as a bare string with nothing left to match on. diff() is the
    // path record() takes whenever both before and after are given — so passing a
    // whole Staff row, the obvious thing for a caller to do, wrote passwordHash
    // straight into the log, which is the one thing this module promises never to do.
    if (SECRET_FIELDS.has(k.toLowerCase())) { b[k] = "[redacted]"; a[k] = "[redacted]"; continue; }
    b[k] = redact(bv); a[k] = redact(av);
  }
  return { before: Object.keys(b).length ? b : null, after: Object.keys(a).length ? a : null };
}

/**
 * Who is acting, worked out from the request. A staff member, a student and an
 * applicant are different tiers, and the log has to say which — actorId alone is
 * ambiguous because a Student id and a Staff id are drawn from different tables and
 * can collide in meaning.
 *
 * req.user carries `kind` for exactly this reason (see auth.js), so a student updating
 * their own record is not filed as staff activity.
 */
function actorFrom(req) {
  // A branch for `req.platformAdmin` stood here and has gone with the operator tier
  // — platformAuth.js was the only thing that set it, and nothing writes
  // actorType: "platform" any more.
  //
  // WRITING it is dead; READING it is not. Rows the operator tier wrote are still in
  // AuditLog and still have to render, so the vocabulary on AuditLog.actorType has
  // NOT shrunk and the client still has a label and a tone for "platform". Removing
  // that too would relabel a past operator action as the machine's, which is the one
  // thing an audit trail must not do.
  if (req?.user) {
    const kind = req.user.kind;
    return {
      actorType: kind === "student" || kind === "applicant" ? kind : "staff",
      actorId: req.user.id,
      actorEmail: req.user.email || null,
    };
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
 * @param {object} [evt.actor]   explicit actor, for events that happen BEFORE a session
 *                               exists — a sign-in, a password reset, an invitation
 *                               accepted. Without it those would all be filed as
 *                               "system", which is precisely the wrong answer for the
 *                               events a security reviewer looks at first.
 *                               { actorType, actorId, actorEmail }
 */
function record(req, evt) {
  // Resolve everything synchronously, before the caller's context can unwind.
  let payload;
  try {
    const { before, after } = diff(evt.before, evt.after);
    payload = {
      ...actorFrom(req),
      ...(evt.actor || {}),
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

  // Not awaited, on purpose: an audited action must not wait on a write nobody is
  // reading yet, and by the first rule at the top of this file a failed write must not
  // fail the action it was recording. So the promise is deliberately floated and its
  // only job is to log.
  //
  // This used to be wrapped in crossTenant(), and the reason is worth keeping: with one
  // shared database, an audit row had to be stamped with the institution it concerned,
  // and a platform operator acting from OUTSIDE any institution had no tenant in scope
  // to stamp it with — so the write escaped the scope guard and supplied the id by hand.
  // A row that could not be attributed was DROPPED rather than written unattributed,
  // which meant a privileged action could go unlogged. None of that applies now: there
  // is one institution, it is the database, and every row belongs to it by construction.
  prisma.auditLog.create({ data: payload })
    .catch((e) => console.error("[audit] write failed for '" + payload.action + "':", e.message));
}

/**
 * The NAMES of the fields that differ, with none of their values.
 *
 * For records whose contents are more sensitive than the fact they changed. An
 * admission holds an NI number, an ID document number, criminal-record answers,
 * medical conditions, ethnicity and religion — special-category data under UK GDPR.
 * Copying those into the audit log would spread them into a table that more people
 * can read, that is kept for longer than the record itself, and that gets exported;
 * SECRET_FIELDS does not help, because none of it is a secret, it is simply personal.
 *
 * "Eleven fields on this application were edited, and these are their names" answers
 * the question an audit trail is asked — who changed this record, and when — without
 * the log becoming a second copy of the data.
 */
function changedKeys(before, after) {
  if (!before || !after) return [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out = [];
  for (const k of keys) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out.push(k);
  }
  return out.sort();
}

/**
 * An actor identified only by the address they claimed: a failed sign-in, a password
 * reset asked for on an account that may not exist. There is no id to record because
 * there may be no account — but the attempt is exactly what a security reviewer wants
 * to count, so it must not be filed as "system".
 */
const anonymous = (email) => ({
  actorType: "anonymous",
  actorId: null,
  actorEmail: email ? String(email).toLowerCase().slice(0, 200) : null,
});

/**
 * An actor who has just proved who they are but does not yet hold a session — the
 * successful half of a sign-in, an invitation accepted, a reset link followed.
 * @param {object} row   Staff, Student or Admission row
 * @param {string} kind  staff | student | applicant
 */
const asActor = (row, kind = "staff") => ({
  actorType: kind,
  actorId: row?.id || null,
  actorEmail: row?.email ? String(row.email).toLowerCase().slice(0, 200) : null,
});

module.exports = { record, redact, diff, actorFrom, anonymous, asActor, changedKeys };
