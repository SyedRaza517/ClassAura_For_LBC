import useReveal from "./RevealButton";
import React, { useState } from "react";
import { useAuth } from "./auth";
import { TotpSetup, TotpVerify } from "./TwoFactor";
import { ForgotPasswordForm } from "./ResetPassword";
import { LogIn, Loader2, Mail, Lock, GraduationCap, ArrowLeft } from "lucide-react";
import { BrandLockup } from "./Brand";
import { rememberedEmail, rememberedPassword, setRememberedLogin, forgetRememberedLogin, passwordMatchesEmail } from "./rememberEmail";
import BiometricSignIn from "./BiometricSignIn";

const NAVY = "#1a3a8f", NAVY_DARK = "#14306f", MAROON = "#9e1b32";

export default function Login({ onBack }) {
  const { login, applySession, error } = useAuth();
  const [email, setEmail] = useState(() => rememberedEmail());
  const [password, setPassword] = useState(() => rememberedPassword());
  // One tickbox covers both. It starts ticked ONLY when a password was actually
  // stored — an existing user who had the old email-only "remember me" must opt into
  // password storage deliberately, not be upgraded into it by a relabelled tickbox.
  const [remember, setRemember] = useState(() => Boolean(rememberedPassword()));
  // The password box is prefilled from storage and has not been retyped. While that
  // holds, the reveal button is withheld, so the next person at a shared machine
  // cannot simply read the previous user's password off the screen.
  const [pwFromStore, setPwFromStore] = useState(() => Boolean(rememberedPassword()));
  const [busy, setBusy] = useState(false);
  const pw = useReveal();
  // Admin accounts don't use 2FA by default, but one can turn it on — so this
  // screen has to be able to finish a two-step sign-in too.
  const [challenge, setChallenge] = useState(null);
  const [forgot, setForgot] = useState(false);

  const submit = async (e) => {
    // A real form submit, so Enter works and password managers see a sign-in.
    e?.preventDefault();
    setBusy(true);
    const res = await login(email.trim(), password);
    setBusy(false);
    // Save only once the server has ACCEPTED these credentials. Saving beforehand
    // persisted typos, and kept a temporary password that the forced-change gate had
    // already replaced — the form then prefilled a dead password as dots and the user
    // locked their own account by retrying it.
    if (res?.ok || res?.mfaRequired || res?.totpSetupRequired) {
      if (remember) setRememberedLogin(email, password); else forgetRememberedLogin();
    }
    if (res?.mfaRequired || res?.totpSetupRequired) setChallenge(res);
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden p-4" style={{ fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Lora:ital,wght@0,600;1,500&display=swap');`}</style>

      {/* Animated gradient backdrop */}
      <div
        className="animated-gradient absolute inset-0"
        style={{
          background: `linear-gradient(135deg, ${NAVY_DARK} 0%, ${NAVY} 30%, #2b3f9e 55%, ${MAROON} 100%)`,
          backgroundSize: "220% 220%",
        }}
      />

      {/* Soft floating decorative blobs (behind card) */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="float absolute -top-24 -left-24 h-80 w-80 rounded-full blur-3xl" style={{ background: "rgba(99,130,255,0.35)", animationDelay: "0s" }} />
        <div className="float-slow absolute top-1/3 -right-28 h-96 w-96 rounded-full blur-3xl" style={{ background: "rgba(158,27,50,0.30)", animationDelay: "1.2s" }} />
        <div className="float absolute -bottom-28 left-1/4 h-72 w-72 rounded-full blur-3xl" style={{ background: "rgba(73,99,205,0.30)", animationDelay: "2.4s" }} />
        <div className="float-slow absolute top-10 left-1/2 h-40 w-40 rounded-full blur-2xl" style={{ background: "rgba(255,255,255,0.10)", animationDelay: "0.6s" }} />
      </div>

      {/* Login card */}
      <div className="scale-in hover-lift relative w-full max-w-sm rounded-3xl border border-white/40 bg-white/95 p-7 shadow-2xl ring-1 ring-black/5 backdrop-blur-xl">
        {onBack && !challenge && !forgot && (
          <button onClick={onBack} title="Back" className="press absolute left-4 top-4 flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700">
            <ArrowLeft size={16} />
          </button>
        )}
        <div className="mb-5 flex flex-col items-center">
          <div className="float mb-3 flex flex-col items-center justify-center gap-1 rounded-2xl bg-white px-5 py-3 shadow-lg ring-1 ring-slate-200/80">
            <BrandLockup />
          </div>
          <h1
            className="gradient-text text-2xl font-extrabold"
            style={{ backgroundImage: `linear-gradient(90deg, ${NAVY} 0%, #4a63cf 50%, ${MAROON} 100%)` }}
          >
            Staff Hub
          </h1>
          <p className="mt-0.5 text-sm text-slate-400">{challenge ? "One more step" : forgot ? "Account recovery" : "Sign in to continue"}</p>
        </div>

        {forgot ? (
          <ForgotPasswordForm prefillEmail={email} onBack={() => setForgot(false)} />
        ) : challenge ? (
          challenge.totpSetupRequired
            ? <TotpSetup challengeToken={challenge.challengeToken} onDone={applySession} onCancel={() => setChallenge(null)} />
            : <TotpVerify challengeToken={challenge.challengeToken} name={challenge.name} onDone={applySession} onCancel={() => setChallenge(null)} />
        ) : (
        // A real <form> with named fields and autocomplete hints. Without these a
        // password manager cannot recognise this as a sign-in at all, which is why
        // nothing was ever offered to be saved on the admin login (the mobile
        // sign-in already had them). The browser now stores the password in the OS
        // keychain and refills it; we never touch it ourselves.
        <form onSubmit={submit} className="space-y-4">
          <div className="fade-up" style={{ animationDelay: "0.05s" }}>
            <label htmlFor="login-email" className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Email</label>
            <div className="group relative mt-1">
              <Mail size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 transition-colors group-focus-within:text-blue-500" />
              <input id="login-email" name="email" type="email" autoComplete="username" autoCapitalize="none" spellCheck={false}
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  // The stored password belongs to the stored address. The moment the
                  // address is edited it no longer does, so drop it rather than send
                  // one person's password against another person's email.
                  if (pwFromStore && !passwordMatchesEmail(e.target.value)) { setPassword(""); setPwFromStore(false); }
                }}
                disabled={busy} placeholder="name@edtech.co.uk"
                className="w-full rounded-xl border border-slate-200 bg-slate-50/60 py-2.5 pl-9 pr-3 text-sm outline-none transition-all duration-200 focus:border-blue-400 focus:bg-white focus:ring-4 focus:ring-blue-100 disabled:opacity-60" />
            </div>
          </div>
          <div className="fade-up" style={{ animationDelay: "0.12s" }}>
            <label htmlFor="login-password" className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Password</label>
            <div className="group relative mt-1">
              <Lock size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 transition-colors group-focus-within:text-blue-500" />
              <input id="login-password" name="password" type={pwFromStore ? "password" : pw.type} autoComplete="current-password"
                value={password}
                onChange={(e) => {
                  // The FIRST edit of a prefilled-from-storage password clears the
                  // whole field — it does not append. Otherwise the next person at a
                  // shared machine typed one character, which un-suppressed the reveal
                  // button while the stored plaintext was still in the value, and could
                  // then reveal the previous user's password. Clearing on first touch
                  // means a stored password can never be shown, only replaced.
                  if (pwFromStore) { setPassword(""); setPwFromStore(false); return; }
                  setPassword(e.target.value);
                }}
                disabled={busy}
                className="w-full rounded-xl border border-slate-200 bg-slate-50/60 py-2.5 pl-9 pr-11 text-sm outline-none transition-all duration-200 focus:border-blue-400 focus:bg-white focus:ring-4 focus:ring-blue-100 disabled:opacity-60" />
              {/* No reveal button while the value came from storage — otherwise the
                  next person at a shared machine reads the previous user's password. */}
              {!pwFromStore && pw.button}
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-slate-500">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} disabled={busy}
                className="h-4 w-4 rounded border-slate-300 accent-[#1a3a8f]" />
              Remember my email and password
            </label>
            {/* Said plainly at the moment of choosing, not buried in a policy — the
                tickbox stores a password, which is not what "remember me" usually means. */}
            {remember && (
              <p className="text-[11px] leading-snug text-amber-700">
                Both are saved on this device and stay saved after you sign out. Only use this on a device that is yours alone.
              </p>
            )}
          </div>
          {error && <p className="slide-down rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-600 ring-1 ring-rose-100">{error}</p>}
          <button type="submit" disabled={busy}
            className="shine press hover-glow flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold text-white shadow-lg transition-all duration-200 hover:shadow-xl disabled:opacity-60"
            style={{ background: `linear-gradient(135deg, ${NAVY} 0%, ${NAVY_DARK} 60%, ${MAROON} 130%)`, boxShadow: "0 10px 25px -8px rgba(26,58,143,0.6)" }}>
            {busy ? <Loader2 size={18} className="animate-spin" /> : <LogIn size={18} />} {busy ? "Signing in…" : "Sign in"}
          </button>
          {/* Renders nothing unless a remembered session exists for THIS address. */}
          <BiometricSignIn email={email} />
          {/* type="button", or clicking this would submit the form instead. */}
          <button type="button" onClick={() => setForgot(true)} className="press w-full text-center text-xs font-semibold text-slate-400 transition hover:text-slate-600">
            Forgotten your password?
          </button>
        </form>
        )}

      </div>
    </div>
  );
}
