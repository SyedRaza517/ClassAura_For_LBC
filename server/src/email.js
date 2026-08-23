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
//   MAIL_FROM    "EdTech <no-reply@edtech.co.uk>"
//
// Sending is always best-effort: a mail failure is logged and swallowed so it can
// never break the action that triggered it (approving leave, resetting a password).
const nodemailer = require("nodemailer");

const FROM = process.env.MAIL_FROM || "EdTech Staff Hub <no-reply@edtech.co.uk>";
// Resend (https://resend.com) sends over HTTPS, so it works on hosts that block
// outbound SMTP ports (e.g. Render's free tier). Preferred when RESEND_API_KEY is set.
const useResend = () => Boolean(process.env.RESEND_API_KEY);
const isConfigured = () => Boolean(process.env.RESEND_API_KEY || process.env.SMTP_URL || process.env.SMTP_HOST);

// Send via Resend's HTTP API with a hard timeout so it can never hang a request.
// `attachments` (optional) is [{ filename, content }] where content is a Buffer or a
// base64 string — Resend wants base64, so a Buffer is encoded here.
async function sendViaResend(to, subject, text, html, attachments, from) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const payload = { from: from || FROM, to, subject, text, html: html || defaultHtml(subject, text) };
    if (attachments && attachments.length) {
      payload.attachments = attachments.map((a) => ({
        filename: a.filename,
        content: Buffer.isBuffer(a.content) ? a.content.toString("base64") : a.content,
      }));
    }
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
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

let transporter = null;
function getTransport() {
  if (transporter) return transporter;
  if (process.env.SMTP_URL) {
    transporter = nodemailer.createTransport(process.env.SMTP_URL);
  } else {
    const port = Number(process.env.SMTP_PORT) || 587;
    // Implicit TLS is port 465; 587 uses STARTTLS, which nodemailer negotiates
    // automatically when secure is false.
    const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : port === 465;
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      // Fail fast instead of hanging ~2 min when the SMTP port is blocked/unreachable
      // (common on PaaS free tiers). A blocked send must not stall the request.
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
  }
  return transporter;
}

// Minimal branded HTML wrapper. Used when a caller doesn't supply its own.
// Bare URLs are turned into links so a reset link is clickable in an HTML client
// while the plain-text alternative stays readable.
function defaultHtml(subject, text) {
  const escape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = escape(text)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#1a3a8f;word-break:break-all">$1</a>')
    .replace(/\n/g, "<br>");
  return `<div style="margin:0;padding:24px;background:#eef1f6;font-family:'Segoe UI',system-ui,-apple-system,sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(15,23,42,.08)">
    <div style="background:linear-gradient(135deg,#1a3a8f,#9e1b32);padding:20px 24px">
      <p style="margin:0;color:#fff;font-size:16px;font-weight:700">EdTech</p>
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

  // Prefer the HTTP API when configured (works where SMTP is blocked).
  if (useResend()) return sendViaResend(to, subject, body, html, attachments, from);

  try {
    const info = await getTransport().sendMail({
      from: from || FROM,
      to,
      subject,
      text: body,
      html: html || defaultHtml(subject, body),
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
  if (useResend()) return `Resend HTTP API as "${FROM}"`;
  if (!isConfigured()) return "console stub (set RESEND_API_KEY, or SMTP_URL/SMTP_HOST, in server/.env to send real email)";
  const target = process.env.SMTP_URL ? process.env.SMTP_URL.replace(/\/\/[^@]*@/, "//***@") : `${process.env.SMTP_HOST}:${Number(process.env.SMTP_PORT) || 587}`;
  return `SMTP via ${target} as "${FROM}"`;
}

module.exports = { sendEmail, verifyEmail, describeEmail, isConfigured };
