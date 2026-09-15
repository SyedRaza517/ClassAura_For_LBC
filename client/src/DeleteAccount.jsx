// Self-service account deletion.
//
// Required by the App Store for any app offering account creation, and expected by
// Google Play. Deliberately hard to do by accident: it states plainly what is
// destroyed, then asks for the password, the authenticator code where one is set,
// and the word DELETE typed out.
import React, { useState } from "react";
import useReveal from "./RevealButton";
import { api } from "./api";
import { useAuth } from "./auth";
import { CodeInput } from "./TwoFactor";
import { Trash2, Loader2, XCircle, AlertTriangle, Lock, Smartphone, CheckCircle2 } from "lucide-react";

import { MAROON } from "./branding";

const inputClass =
  "w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm text-slate-800 outline-none transition focus:border-transparent focus:ring-2 disabled:opacity-60";

export default function DeleteAccount({ user, onCancel }) {
  const pw = useReveal();
  const { logout } = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  // Driven by SERVER truth, not by an assumption about TOTP_ENFORCED.
  //
  // The server gates the code on `totpEnabled` alone — an account that deliberately
  // enrolled is always challenged, regardless of that switch. Hard-coding false here
  // meant such an account got "Enter the current code from your authenticator app"
  // with no code field on screen: deletion was impossible and the error unactionable,
  // which is the exact App Store requirement this screen exists to satisfy. The
  // comment claimed it fixed a lockout; it created one. ResetPassword.jsx already
  // does this correctly by asking the server.
  const needsCode = Boolean(user?.totpEnabled);
  const ready = password.length > 0 && confirm.trim().toUpperCase() === "DELETE" && (!needsCode || code.length === 6);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api.deleteAccount(password, confirm.trim().toUpperCase(), needsCode ? code : undefined);
      // The account is gone; leaving its address and password on the device would be
      // personal data outliving the deletion that was meant to remove it.
      try { const m = await import("./rememberEmail"); m.forgetRememberedLogin(); } catch (_) {}
      setDone(true);
      // Give the confirmation a moment to be read, then drop the session.
      setTimeout(() => logout(), 2600);
    } catch (err) {
      setError(err.message || "Could not delete your account.");
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  if (done) return (
    <div className="fade-up flex flex-col items-center gap-3 py-2 text-center">
      <div className="bounce-in flex h-14 w-14 items-center justify-center rounded-3xl bg-emerald-50 text-emerald-600 ring-1 ring-emerald-200">
        <CheckCircle2 size={28} />
      </div>
      <div>
        <p className="text-sm font-extrabold text-slate-800">Account deleted</p>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          Your account and personal data have been removed. Signing you out…
        </p>
      </div>
    </div>
  );

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="rounded-xl bg-rose-50 px-3 py-2.5 text-[11px] leading-relaxed text-rose-700 ring-1 ring-rose-200">
        <p className="mb-1 flex items-center gap-1.5 font-bold"><AlertTriangle size={13} /> This cannot be undone</p>
        Deleting your account permanently removes your profile, check-in history,
        leave requests and balance adjustments, and notifications. Documents shared
        with all staff are not affected.
      </div>

      <label className="block">
        <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-500">Your password</span>
        <div className="relative">
          <Lock size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <div className="relative"><input type={pw.type} value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy}
            autoComplete="current-password" className={`${inputClass} pr-11`} style={{ "--tw-ring-color": MAROON }} />{pw.button}</div>
        </div>
      </label>

      {needsCode && (
        <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
          <p className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">
            <Smartphone size={12} /> Authenticator code
          </p>
          <CodeInput value={code} onChange={setCode} disabled={busy} autoFocus={false} />
        </div>
      )}

      <label className="block">
        <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-500">
          Type <span className="font-mono text-rose-600">DELETE</span> to confirm
        </span>
        <input value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={busy} autoComplete="off"
          placeholder="DELETE"
          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-bold uppercase tracking-widest text-slate-800 outline-none transition focus:border-transparent focus:ring-2 disabled:opacity-60"
          style={{ "--tw-ring-color": MAROON }} />
      </label>

      {error && (
        <div className="pop flex items-start gap-2 rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 ring-1 ring-rose-200">
          <XCircle size={14} className="mt-px shrink-0" /> <span>{error}</span>
        </div>
      )}

      <button type="submit" disabled={busy || !ready}
        className="press flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold text-white shadow-lg transition disabled:cursor-not-allowed disabled:opacity-50"
        style={{ background: MAROON }}>
        {busy ? <><Loader2 size={16} className="animate-spin" /> Deleting…</> : <><Trash2 size={16} /> Permanently delete my account</>}
      </button>
      {/* The escape hatch from an irreversible action should not be the smallest
          target in the dialog. Given a real border and 44px of height so it is at
          least as easy to hit as the destructive button above it. */}
      <button type="button" onClick={onCancel} disabled={busy}
        className="press flex min-h-[44px] w-full items-center justify-center rounded-xl border-2 border-slate-200 bg-white text-sm font-bold text-slate-600 transition hover:border-slate-300 hover:bg-slate-50 disabled:opacity-60">
        Cancel — keep my account
      </button>
    </form>
  );
}
