// "Sign in with Face / Fingerprint" on the sign-in screens.
//
// This unlocks a session that was REMEMBERED when the user last signed in with the
// app lock switched on — the app being killed, or the tab closed, leaves that token
// behind. An explicit Sign out clears it (clearBiometricPrefs → forgetSession), so
// this is a way back into an interrupted session, never a way around signing out.
//
// The button renders nothing at all unless there is something to unlock, which is
// why it can sit unconditionally in both sign-in forms.
import React, { useEffect, useState } from "react";
import { Fingerprint, ScanFace, Loader2, XCircle } from "lucide-react";
import { useAuth } from "./auth";
import { api, setToken } from "./api";
import { biometricSignInStatus, biometricSignIn, forgetSession, BIOMETRICS_ENABLED } from "./biometric";

import { NAVY } from "./branding";

export default function BiometricSignIn({ className = "", email = "" }) {
  // Feature parked — see BIOMETRICS_ENABLED in biometric.js. The sign-in screens keep
  // their email/password form and the "Remember my email and password" tickbox, which
  // is what covers the convenience for now.
  if (!BIOMETRICS_ENABLED) return null;
  const { applySession } = useAuth();
  const [offer, setOffer] = useState(null);   // { label, methods, owner } once we know
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    biometricSignInStatus()
      .then((s) => { if (!cancelled && s.ok) setOffer(s); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (!offer) return null;

  // The remembered session belongs to ONE account. This button ignores the email box
  // entirely — it hands back whatever token is stored — so on the admin login an
  // administrator could type their own address, tap it, and land in whichever
  // colleague last armed the lock on that browser. Only offer it when the address in
  // the box is that account's, and name the account on the button so the two can
  // never be confused.
  const typed = String(email || "").trim().toLowerCase();
  if (offer.owner && typed && typed !== offer.owner) return null;

  const methods = offer.methods?.length ? offer.methods : [{ key: "platform", label: offer.label }];

  const go = async () => {
    setBusy(true); setError("");
    const res = await biometricSignIn();
    if (!res.ok) {
      setBusy(false);
      // A cancel is a choice, not a fault.
      if (!res.cancelled) setError(res.error || "Could not verify. Try again.");
      return;
    }
    // The token is only as good as the server says it is: it may have expired, or
    // been revoked by a password change bumping tokenVersion. Prove it with /me
    // BEFORE handing the app a session, so a dead token drops the user back to the
    // password form with an explanation instead of into a broken, half-signed-in app.
    setToken(res.token);
    try {
      const user = await api.me();
      applySession({ token: res.token, user });
    } catch (e) {
      setToken(null);
      setBusy(false);
      // "The server rejected this token" and "I never reached the server" need
      // opposite responses, and api.js distinguishes them: a network failure or a
      // timeout rejects with NO `.status`. Treating both as "expired" threw away a
      // session that was valid for another six days because someone opened the app
      // in a tunnel — and the button then vanished, with no way to get it back.
      const definitelyRejected = e?.status && e.status !== 502 && e.status !== 503 && e.status !== 504;
      if (definitelyRejected) {
        await forgetSession();
        setOffer(null);
        setError("That saved sign-in has expired. Please sign in with your password.");
      } else {
        setError("Couldn't reach the server. Check your connection and try again.");
      }
    }
  };

  return (
    <div className={className}>
      <div className="flex items-center gap-3 py-1">
        <span className="h-px flex-1 bg-slate-200" />
        <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">or</span>
        <span className="h-px flex-1 bg-slate-200" />
      </div>
      <div className="space-y-2">
        {methods.map((m) => {
          const Icon = m.key === "face" || m.key === "iris" ? ScanFace : Fingerprint;
          return (
            <button
              key={m.key}
              type="button"           /* never submit the password form */
              onClick={go}
              disabled={busy}
              className="press flex w-full items-center justify-center gap-2 rounded-xl border-2 py-3 text-sm font-bold transition hover:bg-slate-50 disabled:opacity-60"
              style={{ borderColor: NAVY, color: NAVY }}
            >
              {busy
                ? <><Loader2 size={16} className="animate-spin" /> Waiting for you…</>
                : <><Icon size={17} /> Sign in with {m.label}</>}
              {!busy && offer.owner && <span className="ml-1 max-w-[45%] truncate text-[11px] font-semibold text-slate-600">as {offer.owner}</span>}
            </button>
          );
        })}
      </div>
      {error && (
        <p className="mt-2 flex items-center gap-1.5 rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-600">
          <XCircle size={13} className="shrink-0" /> {error}
        </p>
      )}
    </div>
  );
}
