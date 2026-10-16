// The page an invitation link opens (?invite=<token>).
//
// An admin has created the account; the person sets their own password here, which
// is what actually activates it. Until then it cannot be signed into at all.
import React, { useEffect, useState } from "react";
import useReveal from "./RevealButton";
import { api } from "./api";
import {
  GraduationCap, Loader2, XCircle, CheckCircle2, Lock, ShieldCheck, ArrowLeft, UserCheck,
} from "lucide-react";

import { NAVY, NAVY_DARK, MAROON } from "./branding";

const inputClass =
  "w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm text-slate-800 outline-none transition focus:border-transparent focus:ring-2 disabled:opacity-60";

// Unit scope, NOT inside the component. A component declared inside another
// component's body is a new type on every render, so React unmounts and remounts
// its whole subtree — which destroyed the focused password field on every
// keystroke. Verified on real WebKit: typing 13 characters left "N" in the field.
function AuthCard({ header, body }) {
  return (
    <div className="animated-gradient flex min-h-screen w-full items-center justify-center p-4"
      style={{ fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", background: `linear-gradient(160deg, ${NAVY} 0%, ${NAVY_DARK} 55%, #0f172a 100%)`, backgroundSize: "220% 220%" }}>
      {/* p-5 on the phone, the original p-7 from 640px up — the same step-down as
          ResetPassword.jsx's twin of this card, and for the same reason: capped by the
          page's p-4 already, 28px of inner padding was spending 56 of 288 available
          pixels at 320px on whitespace that the invited person's own email address
          needed. Base-width only, so nothing at or above `sm:` moves. */}
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

export default function AcceptInvite({ token, onDone }) {
  const pw = useReveal();
  const pw2 = useReveal();
  const [state, setState] = useState({ status: "checking" }); // checking | ready | invalid | done
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.verifyInvite(token);
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
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (password !== confirm) { setError("The passwords do not match."); return; }
    setBusy(true);
    try {
      await api.acceptInvite(token, password);
      setState((s) => ({ ...s, status: "done" }));
    } catch (err) {
      setError(err.message || "Could not activate your account.");
    } finally {
      setBusy(false);
    }
  };

  if (state.status === "checking") return (
    <AuthCard
      header={<h1 className="text-xl font-extrabold tracking-tight text-slate-800">Checking your invitation…</h1>}
      body={<div className="flex justify-center py-6 text-slate-400"><Loader2 size={26} className="animate-spin" /></div>}
    />
  );

  if (state.status === "invalid") return (
    <AuthCard
      header={(<>
        <h1 className="text-xl font-extrabold tracking-tight text-slate-800">Invitation no longer valid</h1>
        <p className="mt-1 text-sm text-slate-500">{state.error || "This link has expired or has already been used."}</p>
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
        <h1 className="text-xl font-extrabold tracking-tight text-slate-800">Account activated</h1>
        <p className="mt-1 text-sm text-slate-500">You can now sign in with your new password.</p>
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
        <h1 className="text-xl font-extrabold tracking-tight text-slate-800">Welcome to Staff Hub</h1>
        <p className="mt-1 text-sm text-slate-500">
          {state.name ? `${state.name}, choose` : "Choose"} a password to activate your account.
        </p>
      </>)}
      body={(
        <form onSubmit={submit} className="flex flex-col gap-3.5">
          <div className="rounded-xl bg-slate-50 px-3 py-2.5 text-xs ring-1 ring-slate-200">
            {/* min-w-0 on the name row and break-words on the address below it. An email
                address is a single unbreakable token to the line-breaker, so a long
                college address (firstname.lastname@institution.ac.uk) set this summary
                box's minimum width wider than the card and took the whole page into
                horizontal scroll at 320px — on the first screen a new member of staff
                ever sees. The name row gets min-w-0 for the same family of reason: it is
                a flex row, and without it the text refuses to wrap below its own
                min-content width however narrow the box gets. */}
            <p className="flex min-w-0 items-center gap-1.5 font-bold text-slate-700"><UserCheck size={13} className="shrink-0" /> <span className="min-w-0 break-words">{state.name}</span></p>
            <p className="mt-0.5 break-words text-slate-500">{state.email}</p>
            {(state.role || state.dept) && <p className="text-slate-500">{[state.role, state.dept].filter(Boolean).join(" · ")}</p>}
          </div>

          <label className="block">
            <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-500">Choose a password</span>
            <div className="relative">
              <Lock size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <div className="relative"><input type={pw.type} value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy}
                autoComplete="new-password" className={`${inputClass} pr-11`} style={{ "--tw-ring-color": NAVY }} />{pw.button}</div>
            </div>
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-500">Confirm password</span>
            <div className="relative">
              <Lock size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <div className="relative"><input type={pw2.type} value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={busy}
                autoComplete="new-password" className={`${inputClass} pr-11`} style={{ "--tw-ring-color": NAVY }} />{pw2.button}</div>
            </div>
          </label>
          <p className="text-[11px] text-slate-500">At least 8 characters. Only you will know it.</p>

          {error && (
            <div className="pop flex items-start gap-2 rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 ring-1 ring-rose-200">
              <XCircle size={14} className="mt-px shrink-0" /> <span>{error}</span>
            </div>
          )}

          <button type="submit" disabled={busy}
            className="press shine flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold text-white shadow-lg transition disabled:opacity-60"
            style={{ background: `linear-gradient(135deg, ${NAVY}, ${MAROON})` }}>
            {busy ? <><Loader2 size={16} className="animate-spin" /> Activating…</> : <><ShieldCheck size={16} /> Activate my account</>}
          </button>
        </form>
      )}
    />
  );
}
