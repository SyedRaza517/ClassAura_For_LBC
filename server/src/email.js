// Outbound email.
//
// Configured entirely by environment variables. Set SMTP_URL (or SMTP_HOST and
// friends) in server/.env and mail is really sent; leave them unset and the app
// still runs with zero configuration, printing each message to the console
// instead. That keeps `npm run dev` working out of the box while making the
// production path a config change rather than a code change.
//
//   SMTP_URL     smtp://user:pass@host:587   or  smtps://user:pass@host:465
//   — or —
//   SMTP_HOST    mail.example.com
//   SMTP_PORT    587            (default 587, or 465 when SMTP_SECURE=true)
//   SMTP_SECURE  true|false     (default: true only when the port is 465)
//   SMTP_USER    username       (optional — omit for an open relay / local MTA)
//   SMTP_PASS    password
//   MAIL_FROM    "Your College <no-reply@your-college.ac.uk>"
//
// Sending is always best-effort: a mail failure is logged and swallowed so it can
// never break the action that triggered it (approving leave, resetting a password).
const nodemailer = require("nodemailer");
const mailAssets = require("./mailAssets");

// The last-resort sender, used when neither the caller nor the institution's branding
// supplies one. SMTP_USER comes next because on Microsoft 365 and most relays that IS
// the authenticated mailbox, so it is the one address we know is allowed to send.
//
// There is deliberately no fallback DOMAIN. This used to default to a real college's
// no-reply address, which meant an unconfigured deployment sent every college's mail
// under that college's name. A bounce nobody owns is a better failure than a letter
// signed by the wrong institution, and it shows up on the first send rather than months
// later in somebody else's inbox.
// Resolved per SEND, not once at require time.
//
// This was a module-level constant read from process.env, which is the whole defect in
// miniature: whichever institution the server was configured for became the sender for
// every other institution on the platform. A college's applicants must see that
// college's address, or the offer they receive is, quite literally, from someone else.
//
// Order: what this college saved, then its username if that is an address, then the
// server-wide setting, then a deliberately undeliverable address. That last step is
// intentional — a bounce nobody owns is a better failure than a letter signed by the
// wrong institution, and it surfaces on the first send rather than months later in
// somebody else's inbox.
const FROM = () => {
  const c = E();
  if (c.fromEmail) return String(c.fromEmail);
  if (/@/.test(String(c.user || ""))) return String(c.user);
  if (process.env.MAIL_FROM) return process.env.MAIL_FROM;
  if (/@/.test(process.env.SMTP_USER || "")) return process.env.SMTP_USER;
  return "Staff Hub <no-reply@localhost>";
};
// Resend (https://resend.com) sends over HTTPS, so it works on hosts that block
// outbound SMTP ports (e.g. Render's free tier). Preferred when RESEND_API_KEY is set.
// --- Whose mailbox is this? ------------------------------------------------------
//
// This used to read process.env directly, which cannot survive more than one
// institution: every college's applicants received mail from whichever college the
// server happened to be configured for. That is not a branding problem — a student
// receiving an offer "from" another institution is a different institution's letter.
//
// So the settings are resolved per tenant, exactly like Moodle and SharePoint:
// what the college saved, then the environment, then nothing. Same choke-point trick
// as moodle.js — cfg.load() is awaited once at the entry point (sendEmail /
// verifyEmail) and the synchronous accessors below read the primed value, so the
// dozens of call sites did not have to become async.
//
// A deployment where no college has configured anything behaves exactly as before.
const cfg = require("./integrationConfig");

const E = () => cfg.peek("email");
const RESEND_KEY = () => {
  const c = E();
  // Resend and SMTP share the `password` slot: a college picks one transport, and the
  // key only counts as a Resend key when the college said "resend".
  if (c.provider === "resend" && c.password) return c.password;
  return process.env.RESEND_API_KEY || "";
};
const SMTP_HOST = () => String(E().host || "");
const SMTP_PORT = () => Number(E().port) || 587;
const SMTP_SECURE = () => {
  const v = E().secure;
  if (v === undefined || v === "" || v === null) return SMTP_PORT() === 465;
  return v === true || String(v).toLowerCase() === "true";
};
const SMTP_USER = () => String(E().user || "");
const SMTP_PASS = () => (E().provider === "resend" ? "" : String(E().password || ""));
const SMTP_URL = () => String(E().url || process.env.SMTP_URL || "");

const useResend = () => Boolean(RESEND_KEY());
const isConfigured = () => Boolean(RESEND_KEY() || SMTP_URL() || SMTP_HOST());

// Send via Resend's HTTP API with a hard timeout so it can never hang a request.
// `attachments` (optional) is [{ filename, content }] where content is a Buffer or a
// base64 string — Resend wants base64, so a Buffer is encoded here.
async function sendViaResend(to, subject, text, html, attachments, from) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const payload = { from: from || FROM(), to, subject, text, html };
    if (attachments && attachments.length) {
      payload.attachments = attachments.map((a) => ({
        filename: a.filename,
        content: Buffer.isBuffer(a.content) ? a.content.toString("base64") : a.content,
      }));
    }
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY()}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || `Resend responded ${res.status}`);
    console.log(`[email] sent to ${to} via Resend — ${subject} (id: ${data.id})`);
    return { sent: true, stubbed: false, messageId: data.id };
  } catch (e) {
    console.error(`[email] Resend FAILED to ${to}: ${e.message}`);
    return { sent: false, stubbed: false, error: e.message };
  } finally { clearTimeout(timer); }
}

// PER TENANT, not per process. A single module-level transporter would hold one
// college's authenticated SMTP connection and hand it to every other college's mail —
// the same defect the SharePoint token cache had, with the same consequence: mail
// leaving under the wrong institution's name. Keyed by the resolved settings so a
// college that corrects its password gets a new connection rather than the stale one.
const transports = new Map();

function getTransport() {
  const key = [SMTP_URL(), SMTP_HOST(), SMTP_PORT(), SMTP_USER(), SMTP_SECURE()].join("|");
  const cached = transports.get(key);
  if (cached) return cached;
  let transporter;
  if (SMTP_URL()) {
    transporter = nodemailer.createTransport(SMTP_URL());
  } else {
    const port = SMTP_PORT();
    // Implicit TLS is port 465; 587 uses STARTTLS, which nodemailer negotiates
    // automatically when secure is false.
    const secure = SMTP_SECURE();
    transporter = nodemailer.createTransport({
      host: SMTP_HOST(),
      port,
      secure,
      auth: SMTP_USER() ? { user: SMTP_USER(), pass: SMTP_PASS() } : undefined,
      // Fail fast instead of hanging ~2 min when the SMTP port is blocked/unreachable
      // (common on PaaS free tiers). A blocked send must not stall the request.
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
  }
  transports.set(key, transporter);
  return transporter;
}

// Minimal branded HTML wrapper. Used when a caller doesn't supply its own.
// Bare URLs are turned into links so a reset link is clickable in an HTML client
// while the plain-text alternative stays readable.
//
// `brand` is passed in rather than resolved here because this helper also runs where
// there is no institution at all (a script, the startup check): sendEmail resolves it
// once and hands over whatever it got, which may be nothing.
function defaultHtml(subject, text, brand) {
  const b = brand || {};
  const primary = b.primaryColor || "#334155";
  const accent = b.accentColor || "#475569";
  const escape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = escape(text)
    .replace(/(https?:\/\/[^\s<]+)/g, `<a href="$1" style="color:${primary};word-break:break-all">$1</a>`)
    .replace(/\n/g, "<br>");
  return `<div style="margin:0;padding:24px;background:#eef1f6;font-family:'Segoe UI',system-ui,-apple-system,sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(15,23,42,.08)">
    <div style="background:linear-gradient(135deg,${primary},${accent});padding:20px 24px">
      ${mailAssets.wordmark(b, { size: 16 })}
      <p style="margin:2px 0 0;color:rgba(255,255,255,.7);font-size:11px;letter-spacing:.18em">STAFF HUB</p>
    </div>
    <div style="padding:24px">
      <h1 style="margin:0 0 12px;font-size:17px;color:#0f172a">${escape(subject)}</h1>
      <div style="font-size:14px;line-height:1.6;color:#334155">${body}</div>
    </div>
    <div style="padding:14px 24px;background:#f8fafc;border-top:1px solid #e2e8f0">
      <p style="margin:0;font-size:11px;color:#94a3b8">This is an automated message from the Staff Hub — please don't reply.</p>
    </div>
  </div>
</div>`;
}

// Send a message. Returns { sent, stubbed, messageId?, previewUrl?, error? } so
// callers and the check script can report what happened; nothing throws.
async function sendEmail(to, subject, body, { html, attachments, from } = {}) {
  // The choke point. Every accessor below reads what this primes; without it they
  // fall back to the environment, which is the old single-institution behaviour.
  await cfg.load("email");
  if (!to) return { sent: false, stubbed: false, error: "no recipient" };

  if (!isConfigured()) {
    console.log(`\n[email:stub] would send →`);
    console.log(`  To:      ${to}`);
    console.log(`  Subject: ${subject}`);
    console.log(`  Body:    ${body}`);
    if (attachments?.length) console.log(`  Attach:  ${attachments.map((a) => a.filename).join(", ")}`);
    console.log("");
    return { sent: false, stubbed: true };
  }

  // The wrapper needs the institution's name and colours, and both transports need the
  // same finished HTML — so it is resolved once, here, and only when the caller has not
  // brought its own body. An unreachable branding table must not stop a password reset
  // going out, hence the swallow: the wrapper then renders without a wordmark.
  let htmlBody = html;
  if (!htmlBody) {
    let brand = null;
    try { brand = await require("./branding").get(); } catch { brand = null; }
    htmlBody = defaultHtml(subject, body, brand);
  }

  // Prefer the HTTP API when configured (works where SMTP is blocked).
  if (useResend()) return sendViaResend(to, subject, body, htmlBody, attachments, from);

  try {
    const info = await getTransport().sendMail({
      from: from || FROM(),
      to,
      subject,
      text: body,
      html: htmlBody,
      // nodemailer takes a Buffer (or base64 with encoding) directly.
      attachments: attachments?.map((a) => ({ filename: a.filename, content: a.content })),
    });
    // Ethereal and other test transports expose a browsable copy of the message.
    const previewUrl = nodemailer.getTestMessageUrl ? nodemailer.getTestMessageUrl(info) || undefined : undefined;
    console.log(`[email] sent to ${to} — ${subject}${previewUrl ? ` (preview: ${previewUrl})` : ""}`);
    return { sent: true, stubbed: false, messageId: info.messageId, previewUrl };
  } catch (e) {
    // Deliberately swallowed: the caller's real work has already succeeded.
    console.error(`[email] FAILED to send to ${to}: ${e.message}`);
    return { sent: false, stubbed: false, error: e.message };
  }
}

// Check the configured SMTP connection without sending anything.
async function verifyEmail() {
  await cfg.load("email");
  if (!isConfigured()) return { configured: false };
  try {
    await getTransport().verify();
    return { configured: true, ok: true };
  } catch (e) {
    return { configured: true, ok: false, error: e.message };
  }
}

// One-line description of the active mode, for the startup banner.
function describeEmail() {
  if (useResend()) return `Resend HTTP API as "${FROM()}"`;
  if (!isConfigured()) return "console stub (no email configured — add it under Settings, Connected systems)";
  const target = SMTP_URL() ? SMTP_URL().replace(/\/\/[^@]*@/, "//***@") : `${SMTP_HOST()}:${SMTP_PORT()}`;
  return `SMTP via ${target} as "${FROM()}"`;
}

// --- Test connection -------------------------------------------------------------
// Same contract as moodle.testConnection / sharepoint.testConnection, so the Settings
// screen can offer one button per integration. Read-only: it opens the connection and
// authenticates, and sends nothing — a college testing its settings must not have to
// put a real message in somebody's inbox to find out it typed the password wrong.
async function testConnection() {
  await cfg.load("email");
  if (!isConfigured()) {
    return { ok: false, note: "Not configured — add an SMTP server, or a Resend API key." };
  }
  if (useResend()) {
    // Resend has no cheap authenticated no-op, so the key's shape is all that can be
    // checked without sending. Said plainly rather than implied as a full check.
    return RESEND_KEY().startsWith("re_")
      ? { ok: true, note: "Resend API key is present. It is only verified for real when the first message is sent." }
      : { ok: false, note: "That does not look like a Resend API key (they begin \"re_\")." };
  }
  try {
    await getTransport().verify();
    return { ok: true, note: "Connected to " + SMTP_HOST() + (SMTP_USER() ? " as " + SMTP_USER() : "") + "." };
  } catch (e) {
    return { ok: false, note: "Could not sign in to the mail server — " + e.message };
  }
}

module.exports = { sendEmail, verifyEmail, describeEmail, isConfigured, testConnection };
