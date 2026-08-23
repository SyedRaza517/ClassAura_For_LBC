// Authenticator-app (TOTP) enrolment and verification.
//
// Used in two places: mid-sign-in inside the staff mobile app (driven by a
// challenge token) and from the admin login if an admin ever turns 2FA on.
import React, { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { api } from "./api";
import { ShieldCheck, Loader2, XCircle, Copy, Check, KeyRound, Smartphone, Download } from "lucide-react";

import { NAVY, MAROON } from "./branding";

// Six single-character boxes that behave like one field: typing advances,
// backspace retreats, and pasting a whole code fills every box at once.
export function CodeInput({ value, onChange, onComplete, disabled, autoFocus = true }) {
  const refs = useRef([]);
  const digits = String(value || "").padEnd(6, " ").slice(0, 6).split("");

  useEffect(() => { if (autoFocus) refs.current[0]?.focus(); }, [autoFocus]);

  const setAt = (i, ch) => {
    const next = (String(value || "").padEnd(6, " ").slice(0, 6).split(""));
    next[i] = ch || " ";
    const joined = next.join("").replace(/\s/g, "");
    onChange(joined);
    return joined;
  };

  const handleChange = (i, raw) => {
    const current = String(value || "");
    const prev = digits[i].trim();
    let only = raw.replace(/\D/g, "");

    // Typing into a box that already holds a digit hands us BOTH characters —
    // "5" plus the new "4" — which looks exactly like a two-digit paste. Drop the
    // digit the box was already showing so the two cases stay distinguishable.
    if (prev && only.length > 1) {
      const at = only.indexOf(prev);
      if (at !== -1) only = only.slice(0, at) + only.slice(at + 1);
    }

    if (!only) { setAt(i, ""); return; }

    if (only.length > 1) {
      // A real paste or an SMS/authenticator autofill landing on this box: lay it
      // over the boxes from here, keeping any digits that sit beyond its end.
      const joined = (current.slice(0, i) + only + current.slice(i + only.length))
        .replace(/\D/g, "").slice(0, 6);
      onChange(joined);
      refs.current[Math.min(i + only.length, 5)]?.focus();
      if (joined.length === 6) onComplete?.(joined);
      return;
    }

    // Overwrite the digit in THIS box and keep everything after it. Rebuilding the
    // code as "everything before i" + the new digit meant going back to correct one
    // mistyped digit silently deleted the rest — and with a TOTP code live for about
    // 30 seconds, that is a bad thing to discover midway.
    const joined = (i < current.length
      ? current.slice(0, i) + only + current.slice(i + 1)
      : current + only
    ).slice(0, 6);
    onChange(joined);
    if (i < 5) refs.current[i + 1]?.focus();
    if (joined.length === 6) onComplete?.(joined);
  };

  const handleKey = (i, e) => {
    if (e.key === "Backspace" && !digits[i].trim() && i > 0) refs.current[i - 1]?.focus();
    if (e.key === "ArrowLeft" && i > 0) refs.current[i - 1]?.focus();
    if (e.key === "ArrowRight" && i < 5) refs.current[i + 1]?.focus();
  };

  return (
    <div className="flex justify-center gap-2" onPaste={(e) => {
      const text = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, 6);
      if (text) { e.preventDefault(); onChange(text); refs.current[Math.min(text.length, 5)]?.focus(); if (text.length === 6) onComplete?.(text); }
    }}>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <input
          key={i}
          ref={(el) => (refs.current[i] = el)}
          value={digits[i].trim()}
          onChange={(e) => handleChange(i, e.target.value)}
          onKeyDown={(e) => handleKey(i, e)}
          // Tapping a filled box selects what is there, so the next keystroke
          // replaces it instead of appending — the ordinary way to fix a typo.
          onFocus={(e) => e.target.select()}
          disabled={disabled}
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          // Deliberately not 1: iOS one-time-code autofill delivers all six digits
          // to a single box, and maxLength=1 would silently throw five of them away.
          maxLength={6}
          aria-label={`Digit ${i + 1} of 6`}
          className="h-12 w-10 rounded-xl border border-slate-200 bg-white text-center text-lg font-bold tabular-nums text-slate-800 outline-none transition focus:border-transparent focus:ring-2 disabled:opacity-60"
          style={{ "--tw-ring-color": NAVY }}
        />
      ))}
    </div>
  );
}

function ErrorNote({ children }) {
  if (!children) return null;
  return (
    <div className="pop flex items-start gap-2 rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 ring-1 ring-rose-200">
      <XCircle size={14} className="mt-px shrink-0" /> <span>{children}</span>
    </div>
  );
}

function SubmitBtn({ busy, disabled, busyLabel, label, Icon = ShieldCheck }) {
  return (
    <button
      type="submit"
      disabled={busy || disabled}
      className="press shine flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold text-white shadow-lg transition disabled:cursor-not-allowed disabled:opacity-60"
      style={{ background: `linear-gradient(135deg, ${NAVY}, ${MAROON})` }}
    >
      {busy ? <><Loader2 size={16} className="animate-spin" /> {busyLabel}</> : <><Icon size={16} /> {label}</>}
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * Enrolment: show the QR / secret, then confirm with a generated code *
 * ------------------------------------------------------------------ */
export function TotpSetup({ challengeToken, onDone, onCancel }) {
  const [setup, setSetup] = useState(null);
  const [qr, setQr] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await api.totpSetup(challengeToken);
        if (cancelled) return;
        setSetup(s);
        // Rendering the QR can fail (very long URL, canvas unavailable) — the
        // typed secret below is the fallback, so don't block enrolment on it.
        try {
          const url = await QRCode.toDataURL(s.otpauthUrl, { width: 320, margin: 1, color: { dark: "#0f172a", light: "#ffffff" } });
          if (!cancelled) setQr(url);
        } catch (_) { /* fall back to manual entry */ }
      } catch (e) {
        if (!cancelled) setLoadError(e.message || "Could not start two-factor setup.");
      }
    })();
    return () => { cancelled = true; };
  }, [challengeToken]);

  const submit = async (e) => {
    e?.preventDefault();
    setError("");
    if (code.length !== 6) { setError("Enter the 6-digit code from your authenticator app."); return; }
    setBusy(true);
    try {
      const res = await api.totpEnable(challengeToken, code);
      await onDone?.(res);
    } catch (err) {
      setError(err.message || "That code isn't right.");
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  const copySecret = async () => {
    try {
      await navigator.clipboard.writeText(setup.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (_) { /* clipboard blocked — the secret is on screen anyway */ }
  };

  // Open a URL WITHOUT navigating this page — navigating away (custom scheme or
  // store link) unloads the app and loses the in-memory enrolment challenge, which
  // is why tapping used to bounce the user back to sign-in. '_system' lets the
  // native OS handle it; a new tab does the same on the web.
  const openExternally = (url) => {
    const native = typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.() === true;
    try { window.open(url, native ? "_system" : "_blank"); } catch (_) { /* no handler — QR/manual key remain */ }
  };

  // Hand the otpauth:// link to the installed authenticator.
  const openInAuthenticator = (e) => { e.preventDefault(); openExternally(setup.otpauthUrl); };

  // For staff who don't have an authenticator yet: open Google Authenticator on the
  // right store for their device (App Store on iOS, Play Store otherwise).
  const openAuthenticatorStore = (e) => {
    e.preventDefault();
    const platform = (typeof window !== "undefined" && window.Capacitor?.getPlatform?.()) || "web";
    const IOS = "https://apps.apple.com/app/google-authenticator/id388497605";
    const ANDROID = "https://play.google.com/store/apps/details?id=com.google.android.apps.authenticator2";
    openExternally(platform === "ios" ? IOS : ANDROID);
  };

  if (loadError) return (
    <div className="flex flex-col gap-3">
      <ErrorNote>{loadError}</ErrorNote>
      {onCancel && <button onClick={onCancel} className="press text-xs font-semibold text-slate-400 hover:text-slate-600">Back to sign in</button>}
    </div>
  );

  if (!setup) return (
    <div className="flex flex-col items-center gap-2 py-8 text-slate-400">
      <Loader2 size={22} className="animate-spin" />
      <p className="text-xs font-semibold">Preparing your security key…</p>
    </div>
  );

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <ol className="space-y-1 text-xs text-slate-500">
        <li><span className="font-bold text-slate-700">1.</span> Install Google Authenticator, Microsoft Authenticator or Authy.</li>
        <li><span className="font-bold text-slate-700">2.</span> Tap “Add to your authenticator” below — it fills in your details automatically.</li>
        <li><span className="font-bold text-slate-700">3.</span> Type the 6-digit code it shows.</li>
      </ol>

      {/* Primary path on the phone the app runs on: the otpauth:// link hands the
          account straight to the installed authenticator with every detail filled
          in (issuer, account, secret), so there's no need to scan a QR that's on
          the very same screen.

          IMPORTANT: we must NOT let the anchor navigate this page to otpauth://.
          Enrolment runs on an in-memory challenge, so any navigation/reload wipes
          it and dumps the user back on the sign-in (password) screen. Instead we
          preventDefault and open the link in a SEPARATE context: '_system' on the
          native app (the OS routes it to the installed authenticator) and a new
          tab on the web — either way this page, and the challenge, stay alive. */}
      <a
        href={setup.otpauthUrl}
        onClick={openInAuthenticator}
        className="press shine flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold text-white shadow-lg transition"
        style={{ background: `linear-gradient(135deg, ${NAVY}, ${MAROON})` }}
      >
        <Smartphone size={16} /> Add to your authenticator app
      </a>
      <p className="-mt-2 text-center text-[10px] leading-relaxed text-slate-400">
        Opens Google Authenticator / Authy with your account details already filled in.
        Then come back here and enter the 6-digit code.
      </p>

      {/* Staff with no authenticator installed yet: one tap to the right store. */}
      <button
        type="button"
        onClick={openAuthenticatorStore}
        className="press -mt-1 flex items-center justify-center gap-1.5 text-center text-[11px] font-semibold text-slate-500 underline decoration-slate-300 underline-offset-2 transition hover:text-slate-700"
      >
        <Download size={12} /> Don’t have one? Get Google Authenticator
      </button>

      {/* QR shown expanded so it can be scanned from another device (or demoed).
          `open` keeps it visible by default; the user can still collapse it. */}
      {qr ? (
        <details open className="rounded-xl bg-slate-50 ring-1 ring-slate-200">
          <summary className="cursor-pointer list-none px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">
            Or scan this QR code with another device
          </summary>
          <div className="flex justify-center pb-3">
            <img src={qr} alt="QR code for your authenticator app" width={168} height={168} className="rounded-xl ring-1 ring-slate-200" />
          </div>
        </details>
      ) : (
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200">
          Can’t open your authenticator? Add the key below by hand.
        </p>
      )}

      <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
        <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Or enter this key by hand</p>
        <div className="mt-1 flex items-center gap-2">
          <code className="flex-1 break-all font-mono text-[11px] font-bold text-slate-700">{setup.formattedSecret}</code>
          <button type="button" onClick={copySecret} title="Copy key" className="press flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white text-slate-500 ring-1 ring-slate-200 transition hover:text-slate-800">
            {copied ? <Check size={13} className="text-emerald-600" /> : <Copy size={13} />}
          </button>
        </div>
        <p className="mt-1 text-[10px] text-slate-400">Account: {setup.account}</p>
      </div>

      <div>
        <p className="mb-2 text-center text-[11px] font-bold uppercase tracking-wide text-slate-400">Code from your app</p>
        <CodeInput value={code} onChange={setCode} onComplete={() => {}} disabled={busy} />
      </div>

      <ErrorNote>{error}</ErrorNote>
      <SubmitBtn busy={busy} disabled={code.length !== 6} busyLabel="Verifying…" label="Confirm & finish setup" />
      {onCancel && <button type="button" onClick={onCancel} className="press text-center text-xs font-semibold text-slate-400 transition hover:text-slate-600">Cancel</button>}
    </form>
  );
}

/* ------------------------------------------------- *
 * Verification: the second step of a normal sign-in *
 * ------------------------------------------------- */
export function TotpVerify({ challengeToken, onDone, onCancel, name }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e, submitted) => {
    e?.preventDefault();
    const value = submitted || code;
    setError("");
    if (value.length !== 6) { setError("Enter the 6-digit code from your authenticator app."); return; }
    setBusy(true);
    try {
      const res = await api.totpVerify(challengeToken, value);
      await onDone?.(res);
    } catch (err) {
      setError(err.message || "That code isn't right.");
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex flex-col items-center text-center">
        <div className="float mb-2 flex h-12 w-12 items-center justify-center rounded-2xl text-white shadow-lg" style={{ background: `linear-gradient(135deg, ${NAVY}, ${MAROON})` }}>
          <Smartphone size={22} />
        </div>
        <p className="text-sm font-bold text-slate-700">Two-step verification</p>
        <p className="mt-0.5 text-xs text-slate-500">
          {name ? `Hi ${String(name).split(/\s+/)[0]} — open` : "Open"} your authenticator app and enter the current 6-digit code.
        </p>
      </div>

      <CodeInput value={code} onChange={setCode} onComplete={(v) => submit(null, v)} disabled={busy} />
      <ErrorNote>{error}</ErrorNote>
      <SubmitBtn busy={busy} disabled={code.length !== 6} busyLabel="Checking…" label="Verify & sign in" Icon={KeyRound} />
      {onCancel && <button type="button" onClick={onCancel} className="press text-center text-xs font-semibold text-slate-400 transition hover:text-slate-600">Use a different account</button>}
    </form>
  );
}
