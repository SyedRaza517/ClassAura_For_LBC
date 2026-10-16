// App lock. Covers the whole app until the device verifies the user.
//
// Shown when biometric unlock is switched on and the app has just launched, or has
// come back from the background. Signing out is always available, so a failed or
// unavailable sensor can never trap someone inside a locked screen.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { isNativeApp } from "./PhoneShell";
import { getToken } from "./api";
import { isBiometricEnabled, isBiometricArmed, verifyBiometric, biometricStatus, biometryLabel, enableBiometric, consumeRestored, isVerifyInFlight, resetBiometric, BIOMETRICS_ENABLED } from "./biometric";
import { Fingerprint, Loader2, LogOut, ShieldCheck, XCircle } from "lucide-react";
import { useBackHandler } from "./backButton";

import { NAVY, NAVY_DARK } from "./branding";

// Remembers that the user has already been offered the one-time "turn on Face ID"
// prompt and said no — so it isn't shoved in their face on every sign-in.
const PROMPT_DISMISSED_KEY = "edtech_biometric_prompt_dismissed";

// Re-lock only after a real absence. Without this, the OS briefly backgrounding the
// app (a permission dialog, the notification shade) would demand a fingerprint
// every few seconds.
const RELOCK_AFTER_MS = 30_000;

// Evaluated once, when the bundle loads: was there already a session on disk?
// If so the app is being re-opened and should lock. If not, the user is about to
// sign in — and asking for a fingerprint immediately after they typed their
// password would be pure friction.
const RESUMED_SESSION = typeof window !== "undefined" && Boolean(getToken());

export function useAppLock(hasSession) {
  const [locked, setLocked] = useState(() => RESUMED_SESSION && isBiometricArmed());
  const backgroundedAt = useRef(null);
  // Tracks whether a session already existed last render, so a session that has
  // just APPEARED (a fresh sign-in) can be told apart from one that was already
  // there (a resume, handled by RESUMED_SESSION above).
  const prevSession = useRef(RESUMED_SESSION);

  // Lock right after a FRESH sign-in too — so Face ID / fingerprint is a step of
  // signing in on the phone, not only a resume guard. The gate always offers
  // "Sign out" and falls back to the device passcode, and the authenticator (TOTP)
  // is still the account's second factor, so a missing sensor can't trap anyone.
  useEffect(() => {
    if (isBiometricArmed() && hasSession && !prevSession.current) {
      // A session restored by the launch unlock has ALREADY been verified — locking
      // again would ask for the same finger twice in a row.
      if (!consumeRestored()) setLocked(true);
    }
    prevSession.current = hasSession;
  }, [hasSession]);

  useEffect(() => {
    if (!isNativeApp()) return;
    let cleanup = () => {};
    (async () => {
      try {
        const { App } = await import("@capacitor/app");
        const handle = await App.addListener("appStateChange", ({ isActive }) => {
          // Both handlers now agree on isBiometricArmed() — the native one used to
          // check isBiometricEnabled(), so on the web the two could disagree about
          // whether a lock was even possible.
          if (!isBiometricArmed()) return;
          // The OS prompt backgrounds the app; that is not the user leaving.
          if (isVerifyInFlight()) return;
          if (!isActive) {
            backgroundedAt.current = Date.now();
            return;
          }
          const away = backgroundedAt.current ? Date.now() - backgroundedAt.current : 0;
          if (away >= RELOCK_AFTER_MS) setLocked(true);
        });
        cleanup = () => handle.remove();
      } catch (_) { /* @capacitor/app unavailable — lock still works at launch */ }
    })();
    return () => cleanup();
  }, []);

  // The browser's equivalent of appStateChange: switching tab, minimising, or the
  // machine locking. Same grace period, so a brief alt-tab doesn't demand a face.
  useEffect(() => {
    if (isNativeApp() || typeof document === "undefined") return;
    const onVisibility = () => {
      if (!isBiometricArmed()) return;
      // Windows Hello / Credential Manager can hide the page while it is on screen.
      if (isVerifyInFlight()) return;
      if (document.visibilityState === "hidden") { backgroundedAt.current = Date.now(); return; }
      const away = backgroundedAt.current ? Date.now() - backgroundedAt.current : 0;
      if (away >= RELOCK_AFTER_MS) setLocked(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Stable identities. These were inline arrows, so every render of App produced a new
  // onUnlock, which re-ran BiometricGate's effect and fired another checkBiometry()
  // round-trip — and, while the auto-unlock-on-unavailable branch existed, another
  // chance to trip it.
  const unlock = useCallback(() => { backgroundedAt.current = null; setLocked(false); }, []);
  const lock = useCallback(() => setLocked(true), []);

  return { locked: locked && isBiometricArmed(), unlock, lock };
}

export default function BiometricGate({ user, onUnlock, logout }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [label, setLabel] = useState("biometric unlock");
  // Why the sensor can't be used, when it can't. Shown on the gate so an unusable
  // lock explains itself rather than just failing.
  const [unavailable, setUnavailable] = useState(null);
  const attempted = useRef(false);

  // Set while a verification is in flight, so the resume listener in useAppLock can
  // tell "the OS prompt covered us" from "the user really left the app".
  const verifying = useRef(false);

  const attempt = useCallback(async () => {
    if (verifying.current) return;      // a second tap must not open a second prompt
    verifying.current = true;
    setBusy(true);
    setError("");
    let res;
    try {
      res = await verifyBiometric({ reason: "Unlock Staff Hub" });
    } catch (e) {
      res = { ok: false, error: e?.message || "Could not verify. Try again." };
    }
    verifying.current = false;
    setBusy(false);
    if (res.ok) { onUnlock(); return; }
    // A cancel is a choice, not a fault — but it must never leave a BLANK screen with
    // no explanation, which is what an empty string produced. WebAuthn also reports a
    // credential the authenticator no longer holds as a "cancel" after a 60s timeout,
    // so silence here is exactly the case the user most needs words for.
    setError(res.cancelled
      ? "Unlock was cancelled. Tap Unlock to try again, or sign out."
      : (res.error || "Could not verify. Try again."));
  }, [onUnlock]);

  useEffect(() => {
    let alive = true;
    (async () => {
      let status;
      try {
        status = await biometricStatus();
      } catch (e) {
        // Never leave the gate in an unexplained state if the check itself throws.
        if (alive) setError("Couldn't check this device's biometrics. Tap Unlock to try again, or sign out.");
        return;
      }
      if (!alive) return;
      setLabel(status.label || biometryLabel(status.biometryType));
      setUnavailable(status.available ? null : (status.reason || "Biometric unlock isn't available on this device right now."));

      // DELIBERATELY NOT auto-unlocking on !available.
      //
      // This used to call onUnlock() whenever checkBiometry() reported the sensor
      // unavailable, to avoid stranding someone who had removed their fingerprints.
      // But `isAvailable: false` is also what the OS reports during BIOMETRY LOCKOUT —
      // the temporary block after several failed attempts — so the lock could be
      // defeated on purpose: fail Face ID five times, reopen the app, and it opened
      // with no verification at all. The gate is worth nothing if failing it enough
      // times is the way through.
      //
      // Stranding is handled properly instead: verifyBiometric passes
      // allowDeviceCredential:true, so the device PIN or passcode always works even
      // when biometry is locked out or unenrolled, and "Sign out" is always offered.
      if (!attempted.current && status.available) { attempted.current = true; attempt(); }
    })();
    return () => { alive = false; };
  }, [attempt]);

  return (
    // THE GATE HAS TO BE SCROLLABLE, because it is the one screen a user cannot walk
    // away from. Everything here — the headline, the Unlock button, "turn off app lock",
    // "Sign out instead" — adds up to roughly 500px, and the container is pinned to
    // 100dvh with no overflow. On a handset in landscape (iOS allows it; see
    // Info.plist's UISupportedInterfaceOrientations) that is about 390px of height, so
    // both escape hatches sat below the bottom edge of a screen that could not be
    // scrolled: a locked app with no reachable way out, which is precisely the state the
    // comments above go to such lengths to make impossible. A short desktop browser
    // window does the same thing on the web build.
    //
    // overflow-y-auto on the container, and the content moved into one wrapper carrying
    // `my-auto` rather than the container keeping `justify-center`. That pairing is the
    // point: `justify-content: center` in a scroll container puts the overflow beyond
    // the START edge out of reach in every engine, so centring and scrolling cannot both
    // be had that way. An auto margin centres the wrapper while there is free space and
    // collapses to zero when there is not, which leaves both ends scrollable. App.jsx's
    // change-password overlay already solves the identical problem with the identical
    // `my-auto`, so this is the house pattern rather than a new one.
    <div
      className="animated-gradient flex w-full flex-col items-center overflow-y-auto p-6 text-center"
      style={{
        height: "100dvh",
        fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
        background: `linear-gradient(160deg, ${NAVY} 0%, ${NAVY_DARK} 55%, #0f172a 100%)`,
        backgroundSize: "220% 220%",
        paddingTop: "max(env(safe-area-inset-top), 24px)",
        paddingBottom: "max(env(safe-area-inset-bottom), 24px)",
      }}
    >
      <div className="my-auto flex w-full flex-col items-center">
        <div className="float mb-5 flex h-20 w-20 items-center justify-center rounded-3xl bg-white/10 text-white ring-1 ring-white/20">
          <Fingerprint size={40} />
        </div>

        <h1 className="text-xl font-extrabold tracking-tight text-white">Staff Hub is locked</h1>
        <p className="mt-1 max-w-xs text-sm text-white/70">
          {user?.name ? `${user.name.split(/\s+/)[0]}, use ` : "Use "}{label} to continue.
        </p>

        {unavailable && (
          <div className="pop mt-4 max-w-xs rounded-xl bg-white/10 px-3 py-2 text-xs font-semibold leading-snug text-amber-200 ring-1 ring-white/15">
            {unavailable}
            <span className="mt-1 block font-normal text-white/60">Unlock will ask for your device PIN or passcode instead.</span>
          </div>
        )}

        {error && (
          <div className="pop mt-4 max-w-xs rounded-xl bg-white/10 px-3 py-2 text-xs font-semibold leading-snug text-rose-200 ring-1 ring-white/15">
            <XCircle size={14} className="mr-1 inline align-[-2px]" />{error}
          </div>
        )}

        <button
          onClick={attempt}
          disabled={busy}
          className="press shine mt-7 flex w-full max-w-xs items-center justify-center gap-2 rounded-2xl bg-white py-3.5 text-sm font-bold shadow-xl transition disabled:opacity-70"
          style={{ color: NAVY }}
        >
          {busy ? <><Loader2 size={18} className="animate-spin" /> Waiting for you…</> : <><ShieldCheck size={18} /> Unlock</>}
        </button>

        {/* The escape hatch for a credential the authenticator no longer holds (a
            Windows Hello PIN reset, a changed Android screen lock). Every check then
            fails with a 60-second timeout the browser reports as a "cancel", so without
            this the gate can never open AND the setting can never be turned off. */}
        <button
          onClick={async () => { await resetBiometric(); logout(); }}
          className="press mt-5 text-xs font-semibold text-white/45 underline transition hover:text-white/75"
        >
          Can't unlock? Turn off app lock and sign in with your password
        </button>

        <button
          onClick={logout}
          className="press mt-3 flex items-center gap-1.5 text-xs font-semibold text-white/50 transition hover:text-white/80"
        >
          <LogOut size={13} /> Sign out instead
        </button>

        <p className="mt-8 max-w-xs text-[11px] leading-relaxed text-white/35">
          Your session stays signed in. This lock keeps staff records private if your
          phone is unlocked by someone else.
        </p>
      </div>
    </div>
  );
}

/**
 * A one-time, dismissable offer shown just after signing in on the phone, inviting
 * the user to protect the app with Face ID / fingerprint. Renders nothing on the
 * web, when the sensor is unavailable, when the lock is already on, or once the
 * user has declined. Turning it on here means the next open — and the next sign-in —
 * asks for biometrics (see useAppLock above).
 */
export function BiometricSetupPrompt() {
  // Feature parked — see BIOMETRICS_ENABLED in biometric.js. Nothing is offered, so
  // nobody is invited to switch on a lock that isn't finished.
  if (!BIOMETRICS_ENABLED) return null;
  const [show, setShow] = useState(false);
  const [label, setLabel] = useState("biometric unlock");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Android hardware back dismisses the prompt (same as "Not now") instead of falling
  // through to the screen underneath while this stays on top. Declared here (not after
  // the early return below) because hooks must run on every render.
  const dismissPrompt = useCallback(() => {
    try { localStorage.setItem(PROMPT_DISMISSED_KEY, "1"); } catch (_) {}
    setShow(false);
  }, []);
  useBackHandler(show, () => { dismissPrompt(); return true; });

  useEffect(() => {
    // No isNativeApp() gate: biometricStatus() below already reports false on a
    // platform with no usable sensor, and the browser now has a real one to offer.
    if (isBiometricEnabled()) return;
    let dismissed = false;
    try { dismissed = localStorage.getItem(PROMPT_DISMISSED_KEY) === "1"; } catch (_) {}
    if (dismissed) return;
    biometricStatus().then((s) => {
      if (s.available) { setLabel(s.label || biometryLabel(s.biometryType)); setShow(true); }
    });
  }, []);

  if (!show) return null;

  const enable = async () => {
    setBusy(true); setError("");
    const res = await enableBiometric();
    setBusy(false);
    if (res.ok) { setShow(false); return; }
    // A cancel is a choice, not a fault — leave the prompt up so they can retry.
    if (res.reason !== "cancelled") setError(res.reason || "Could not turn this on. Try again.");
  };

  const notNow = dismissPrompt;

  return (
    <div
      className="fixed inset-0 z-[95] flex items-end justify-center p-4 sm:items-center"
      style={{ paddingBottom: "max(env(safe-area-inset-bottom), 1rem)" }}
    >
      <div className="fade-up fixed inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={notNow} />
      {/* max-h/overflow-y, the same cap ConfirmDialog.jsx carries and for the same
          reason. This sheet is a fixed overlay with no height limit of its own, and it
          stacks an icon, a heading, a four-line paragraph and two full-width buttons —
          around 400px. On a handset in landscape (roughly 740x360) the two buttons, the
          only way out of it, were simply below the bottom of the screen with nothing to
          scroll: the offer could be neither accepted nor declined. dvh rather than vh
          because mobile Safari resolves vh against the viewport with the URL bar hidden,
          so 85vh can be taller than what is actually on screen — the scar StaffHub's own
          Modal carries and which ConfirmDialog cites. */}
      <div className="scale-in relative max-h-[85dvh] w-full max-w-sm overflow-y-auto rounded-3xl bg-white p-6 text-center shadow-2xl ring-1 ring-black/5">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-3xl text-white shadow-md" style={{ background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` }}>
          <Fingerprint size={30} />
        </div>
        <h2 className="text-lg font-extrabold tracking-tight text-slate-800">Protect Staff Hub with {label}?</h2>
        <p className="mt-1.5 text-sm text-slate-500">
          Ask for {label} whenever the app is opened or you sign in, so your staff records
          stay private even if someone else has your unlocked phone. You can turn this off
          any time in More.
        </p>

        {error && (
          <div className="mt-4 flex items-center justify-center gap-2 rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-600">
            <XCircle size={14} /> {error}
          </div>
        )}

        <button
          onClick={enable}
          disabled={busy}
          className="press mt-5 flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-bold text-white shadow-md transition disabled:opacity-70"
          style={{ background: NAVY }}
        >
          {busy ? <><Loader2 size={18} className="animate-spin" /> Confirming…</> : <><ShieldCheck size={18} /> Turn on {label}</>}
        </button>
        <button onClick={notNow} disabled={busy} className="press mt-2 w-full rounded-2xl py-2.5 text-sm font-semibold text-slate-500 transition hover:text-slate-700 disabled:opacity-70">
          Not now
        </button>
      </div>
    </div>
  );
}
