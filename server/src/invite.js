// Invitation links for admin-created accounts.
//
// An admin adding someone no longer sets a password they could sign in with. The
// account is created inactive with an unguessable random password, and the person
// receives a link to choose their own. Until they do, the account cannot be signed
// into at all — previously it carried the shared default `password123`, so anyone
// who guessed the email address had full access.
//
// Shares the PasswordReset table with the forgotten-password flow: same hashed,
// single-use, expiring token, distinguished by `purpose`.
const crypto = require("crypto");
const prisma = require("./db");
const { sendEmail } = require("./email");
const branding = require("./branding");
const mailAssets = require("./mailAssets");

// A week, not thirty minutes: someone added on a Friday should still be able to
// activate on Monday.
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLIENT_URL = (process.env.CLIENT_URL || "http://localhost:5173").replace(/\/$/, "");

const hashToken = (raw) => crypto.createHash("sha256").update(String(raw)).digest("hex");

// The password an invited account is created with. Nobody ever learns it — the
// point is that it cannot be guessed, so the account is unusable until activated.
const unguessablePassword = () => crypto.randomBytes(48).toString("base64url");

/**
 * Issue (or re-issue) an invitation and email it. Any earlier outstanding invite
 * for the same person stops working, so a forwarded old email is useless.
 */
async function sendInvite(staff, { invitedBy } = {}) {
  await prisma.passwordReset.updateMany({
    where: { staffId: staff.id, purpose: "invite", usedAt: null },
    data: { usedAt: new Date() },
  });

  const raw = crypto.randomBytes(32).toString("hex");
  await prisma.passwordReset.create({
    data: {
      staffId: staff.id,
      tokenHash: hashToken(raw),
      purpose: "invite",
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
  });

  const link = `${CLIENT_URL}/?invite=${raw}`;
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const who = invitedBy ? ` by ${invitedBy}` : "";
  const b = await branding.get();
  // " at <college>" is a whole clause, dropped rather than left dangling as " at ." when
  // the institution has not set a display name — and the same for the subject, because
  // "Your Staff Hub account" is still true of every college while naming the wrong one
  // is not.
  const at = b.displayName ? ` at ${b.displayName}` : "";
  const subject = b.displayName ? `Your ${b.displayName} Staff Hub account` : "Your Staff Hub account";
  const text =
    `Hello ${staff.name},\n\n` +
    `A Staff Hub account has been created for you${who}${at}.\n\n` +
    `Choose your password to activate it. This link is valid for 7 days and can only be used once:\n\n${link}\n\n` +
    `Until you do, the account cannot be used. If you weren't expecting this, you can ignore this email.`;

  const html = `<div style="margin:0;padding:24px;background:#eef1f6;font-family:'Segoe UI',system-ui,-apple-system,sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(15,23,42,.08)">
    <div style="background:linear-gradient(135deg,${b.primaryColor},${b.accentColor});padding:20px 24px">
      ${mailAssets.wordmark(b, { size: 16 })}
      <p style="margin:2px 0 0;color:rgba(255,255,255,.7);font-size:11px;letter-spacing:.18em">STAFF HUB</p>
    </div>
    <div style="padding:24px">
      <h1 style="margin:0 0 10px;font-size:17px;color:#0f172a">Your Staff Hub account is ready</h1>
      <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#334155">Hello ${esc(staff.name)}, an account has been created for you${esc(who)}. Choose a password to activate it — this link lasts <strong>7 days</strong> and can only be used once.</p>
      <p style="margin:0 0 18px"><a href="${link}" style="display:inline-block;background:${b.primaryColor};color:#fff;text-decoration:none;padding:11px 22px;border-radius:10px;font-size:14px;font-weight:700">Set my password</a></p>
      <p style="margin:0 0 6px;font-size:11px;color:#94a3b8">If the button doesn't work, copy this address into your browser:</p>
      <p style="margin:0 0 18px;font-size:11px;word-break:break-all"><a href="${link}" style="color:${b.primaryColor}">${link}</a></p>
      <p style="margin:0;font-size:12px;line-height:1.6;color:#64748b">Until you set a password the account cannot be used. If you weren't expecting this, ignore this email.</p>
    </div>
    <div style="padding:14px 24px;background:#f8fafc;border-top:1px solid #e2e8f0">
      <p style="margin:0;font-size:11px;color:#94a3b8">This is an automated message from the Staff Hub — please don't reply.</p>
    </div>
  </div>
</div>`;

  await sendEmail(staff.email, subject, text, { html });
  return { ok: true };
}

/**
 * Tell an existing account holder that someone tried to sign up with their address.
 * The sign-up form deliberately gives the same answer whether or not the email is
 * known — that stops it being used to check who works here — but the real owner
 * should still find out, and an applicant who is already registered needs to be
 * told to sign in rather than wait for an approval that will never come.
 */
async function notifyExistingAccount(staff) {
  const text =
    `Hello ${staff.name},\n\n` +
    `Someone just used the Staff Hub sign-up form with your email address.\n\n` +
    `You already have an account, so no new one was created and nothing has changed.\n\n` +
    `If that was you: just sign in as normal. If you've forgotten your password, use ` +
    `"Forgotten your password?" on the sign-in screen.\n\n` +
    `If it wasn't you, no action is needed — but consider changing your password.`;
  await sendEmail(staff.email, "Someone tried to sign up with your email", text);
}

module.exports = { sendInvite, notifyExistingAccount, unguessablePassword, hashToken, INVITE_TTL_MS };
