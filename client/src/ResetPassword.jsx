// Forgotten-password flow.
//
//   ForgotPasswordForm — "email me a link", shown inside the mobile app's sign-in
//                        and the admin login card.
//   ResetPasswordPage  — the full screen the emailed link opens (?reset=<token>).
//
// The reset link alone is never enough for an account with an authenticator: the
// server also demands a current code, so reaching the mailbox doesn't bypass 2FA.
import React, { useEffect, useState } from "react";
import useReveal from "./RevealButton";
import { api } from "./api";
import { CodeInput } from "./TwoFactor";
import {
  Mail, Loader2, XCircle, CheckCircle2, ArrowLeft, KeyRound, Lock, ShieldCheck,
  GraduationCap, MailCheck, Smartphone,
} from "lucide-react";

import { NAVY, NAVY_DARK, MAROON } from "./branding";

const inputClass =
  "w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm text-slate-800 outline-none transition focus:border-transparent focus:ring-2 disabled:opacity-60";

function Note({ tone = "error", children }) {
  if (!children) return null;
  const map = {
    error: "bg-rose-50 text-rose-700 ring-rose-200",
    info: "bg-blue-50 text-blue-700 ring-blue-100",
  };
  const Icon = tone === "error" ? XCircle : ShieldCheck;
  return (
    <div className={`pop flex items-start gap-2 rounded-xl px-3 py-2 text-xs font-semibold ring-1 ${map[tone]}`}>
      <Icon size={14} className="mt-px shrink-0" /> <span>{children}</span>
    </div>
  );
}

function Labelled({ label, Icon, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-500">{label}</span>
      <div className="relative">
        <Icon size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        {children}
      </div>
    </label>
  );
}

// Declared at unit scope, NOT inside the page component.
//
// A component defined inside another component's body is a new component *type* on
// every render, so React unmounts and remounts its entire subtree each time state
// changes. That destroyed the focused password field on every keystroke: you could
// type one character, then focus fell to <body> and the on-screen keyboard closed.
// Verified on real WebKit — typing 13 characters left "N" in the field.
function AuthCard({ header, body }) {
  return (
    <div className="animated-gradient flex min-h-screen w-full items-center justify-center p-4"
      style={{ fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", background: `linear-gradient(160deg, ${NAVY} 0%, ${NAVY_DARK} 55%, #0f172a 100%)`, backgroundSize: "220% 220%" }}>
      {/* p-5 on the phone, the original p-7 from 640px up. The card is already capped by
          the page's own p-4, so at 320px the 28px of inner padding was spending 56 of the
          288 available pixels on whitespace — and this card hosts the six-box
          authenticator code input (TwoFactor.jsx#CodeInput), which is the one piece of
          content here that genuinely needs the width. Stepped down at base only, so no
          screen at or above `sm:` changes at all. */}
      <div className="scale-in w-full max-w-md rounded-3xl bg-white p-5 shadow-2xl ring-1 ring-black/5 sm:p-7">
        <div className="mb-5 flex flex-col items-center text-center">
          <div className="float mb-3 flex h-14 w-14 items-center justify-center rounded-2xl text-white shadow-lg" style={{ background: `linear-gradient(135deg, ${NAVY}, ${MAROON})` }}>
            <GraduationCap size={26} />
          </div>
          {header}
        </div>
        {body}
      </div>
    </div>
  );
}

function Submit({ busy, disabled, busyLabel, label, Icon = KeyRound }) {
  return (
    <button type="submit" disabled={busy || disabled}
      className="press shine flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold text-white shadow-lg transition disabled:cursor-not-allowed disabled:opacity-60"
      style={{ background: `linear-gradient(135deg, ${NAVY}, ${MAROON})` }}>
      {busy ? <><Loader2 size={16} className="animate-spin" /> {busyLabel}</> : <><Icon size={16} /> {label}</>}
    </button>
  );
}

/* ============ "email me a link" ============ */

export function ForgotPasswordForm({ onBack, prefillEmail = "" }) {
  const [email, setEmail] = useState(prefillEmail);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (!email.trim()) { setError("Enter the email address for your account."); return; }
    setBusy(true);
    try {
      const res = await api.forgotPassword(email.trim());
      setSent(res?.message || "If that email belongs to an account, a reset link is on its way.");
    } catch (err) {
      setError(err.message || "Could not send the reset link.");
    } finally {
      setBusy(false);
    }
  };

  if (sent) return (
    <div className="fade-up flex flex-col items-center gap-4 text-center">
      <div className="bounce-in flex h-16 w-16 items-center justify-center rounded-3xl bg-emerald-50 text-emerald-600 ring-1 ring-emerald-200">
        <MailCheck size={30} />
      </div>
      <div>
        <h2 className="text-lg font-extrabold tracking-tight text-slate-800">Check your email</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">{sent}</p>
      </div>
      <button onClick={onBack} className="press w-full rounded-xl py-2.5 text-sm font-bold text-white shadow-lg" style={{ background: `linear-gradient(135deg, ${NAVY}, ${MAROON})` }}>
        Back to sign in
      </button>
    </div>
  );

  return (
    <form onSubmit={submit} className="fade-up flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-extrabold tracking-tight text-slate-800">Forgotten password</h2>
        <p className="text-xs text-slate-500">We'll email you a link to choose a new one.</p>
      </div>

      <Labelled label="Email" Icon={Mail}>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy}
          placeholder="name@edtech.co.uk" autoComplete="username" className={inputClass} style={{ "--tw-ring-color": NAVY }} />
      </Labelled>

      <Note>{error}</Note>
      <Submit busy={busy} busyLabel="Sending…" label="Email me a reset link" Icon={Mail} />
      <button type="button" onClick={onBack} className="press text-center text-xs font-semibold text-slate-500 transition hover:text-slate-600">
        Back to sign in
      </button>
    </form>
  );
}

/* ============ the page the emailed link opens ============ */

export default function ResetPasswordPage({ token, onDone }) {
  const pw = useReveal();
  const pw2 = useReveal();
  const [state, setState] = useState({ status: "checking" }); // checking | ready | invalid | done
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.verifyResetToken(token);
        if (!cancelled) setState({ status: "ready", ...res });
      } catch (e) {
        if (!cancelled) setState({ status: "invalid", error: e.message });
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (password.length < 8) { setError("New password must be at least 8 characters."); return; }
    if (password !== confirm) { setError("The passwords do not match."); return; }
    if (state.requiresCode && code.length !== 6) { setError("Enter the 6-digit code from your authenticator app."); return; }
    setBusy(true);
    try {
      await api.resetPassword(token, password, state.requiresCode ? code : undefined);
      // Whatever was remembered on this device is now the OLD password.
      try { const m = await import("./rememberEmail"); m.forgetRememberedPassword(); } catch (_) {}
      setState((s) => ({ ...s, status: "done" }));
    } catch (err) {
      setError(err.message || "Could not reset your password.");
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  if (state.status === "checking") return (
    <AuthCard
      header={<h1 className="text-xl font-extrabold tracking-tight text-slate-800">Checking your link…</h1>}
      body={<div className="flex justify-center py-6 text-slate-400"><Loader2 size={26} className="animate-spin" /></div>}
    />
  );

  if (state.status === "invalid") return (
    <AuthCard
      header={(<>
        <h1 className="text-xl font-extrabold tracking-tight text-slate-800">Link no longer valid</h1>
        <p className="mt-1 text-sm text-slate-500">{state.error || "This reset link has expired or has already been used."}</p>
      </>)}
      body={(
        <button onClick={onDone} className="press min-h-[44px] w-full rounded-xl py-2.5 text-sm font-bold text-white shadow-lg" style={{ background: `linear-gradient(135deg, ${NAVY}, ${MAROON})` }}>
          <span className="flex items-center justify-center gap-2"><ArrowLeft size={16} /> Back to sign in</span>
        </button>
      )}
    />
  );

  if (state.status === "done") return (
    <AuthCard
      header={(<>
        <div className="bounce-in mb-2 flex h-14 w-14 items-center justify-center rounded-3xl bg-emerald-50 text-emerald-600 ring-1 ring-emerald-200">
          <CheckCircle2 size={28} />
        </div>
        <h1 className="text-xl font-extrabold tracking-tight text-slate-800">Password reset</h1>
        <p className="mt-1 text-sm text-slate-500">You've been signed out on every device. Sign in with your new password.</p>
      </>)}
      body={(
        <button onClick={onDone} className="press min-h-[44px] w-full rounded-xl py-2.5 text-sm font-bold text-white shadow-lg" style={{ background: `linear-gradient(135deg, ${NAVY}, ${MAROON})` }}>
          Go to sign in
        </button>
      )}
    />
  );

  return (
    <AuthCard
      header={(<>
        <h1 className="text-xl font-extrabold tracking-tight text-slate-800">Choose a new password</h1>
        {/* break-words because an email address is one unbreakable token as far as the
            line-breaker is concerned. A college address of any length —
            firstname.lastname@institution.ac.uk and longer — therefore set this
            paragraph's minimum width wider than the card and pushed the whole page into
            horizontal scroll at 320px. Nothing else on the screen can be blamed: the
            card itself is capped, the fields are w-full. */}
        <p className="mt-1 break-words text-sm text-slate-500">
          {state.name ? `${state.name.split(/\s+/)[0]} — ` : ""}for {state.email}
        </p>
      </>)}
      body={(
        <form onSubmit={submit} className="flex flex-col gap-3.5">
          <Labelled label="New password" Icon={Lock}>
            <div className="relative"><input type={pw.type} value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy}
              autoComplete="new-password" className={`${inputClass} pr-11`} style={{ "--tw-ring-color": NAVY }} />{pw.button}</div>
          </Labelled>
          <Labelled label="Confirm new password" Icon={Lock}>
            <div className="relative"><input type={pw2.type} value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={busy}
              autoComplete="new-password" className={`${inputClass} pr-11`} style={{ "--tw-ring-color": NAVY }} />{pw2.button}</div>
          </Labelled>
          <p className="text-[11px] text-slate-500">At least 8 characters, and different from your current one.</p>

          {state.requiresCode && (
            <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
              <p className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">
                <Smartphone size={12} /> Authenticator code
              </p>
              <CodeInput value={code} onChange={setCode} disabled={busy} autoFocus={false} />
              <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
                Your account uses two-step verification, so the emailed link on its own isn't enough.
              </p>
            </div>
          )}

          <Note>{error}</Note>
          <Submit busy={busy} busyLabel="Saving…" label="Set new password" Icon={ShieldCheck} />
        </form>
      )}
    />
  );
}
