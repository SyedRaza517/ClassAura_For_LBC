import { useState, useEffect, useCallback } from "react";
import { Loader2, RefreshCw, ShieldCheck, Fingerprint, ScanFace, ChevronRight } from "lucide-react";
import { biometricStatus, biometryLabel, isBiometricEnabled, enableBiometric, disableBiometric, BIOMETRICS_ENABLED } from "../biometric";
import { NAVY } from "../branding";

// App-lock toggle. Renders nothing on the web (no sensor), and explains itself when
// the device has biometrics but the user hasn't enrolled any.
//
// MOVED OUT OF StaffHub.jsx (Task 3, the mechanical StudentApp split). It was always
// "shared verbatim by the staff More screen and the student More screen" — the comment
// below predates the move — but living inside StaffHub.jsx meant importing it from the
// student app dragged all ~16k lines of the staff bundle along for the ride. It imports
// nothing staff-only (just ./biometric and NAVY from ./branding, both plain shared
// modules), so the move is a straight relocation: both StaffHub.jsx and the student
// More screen now import it from here, and the dependency edge that used to run
// student → staff no longer exists.
//
// Shared verbatim by the staff "More" screen and the student "More" screen, so both
// sides behave identically and there is one implementation to keep correct.
export function BiometricSetting({ owner = "" }) {
  // Feature parked — see BIOMETRICS_ENABLED in biometric.js. Returned before any hook
  // so the component does nothing at all: no device probe, no timer, no row. It is a
  // literal constant, so the bundler drops the rest of this component's work too.
  if (!BIOMETRICS_ENABLED) return null;
  const [status, setStatus] = useState(null);
  const [on, setOn] = useState(isBiometricEnabled());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [showWhy, setShowWhy] = useState(false);

  const check = useCallback(async () => {
    setBusy(true);
    try {
      setStatus(await biometricStatus());
    } catch (e) {
      // A THROW is caught here. A promise that never settles is not a throw, so
      // biometricStatus races every platform call against its own deadline — and the
      // effect below adds a last-resort timer in case anything new ever doesn't.
      setStatus({ state: "error", available: false, label: "biometric unlock", detail: String(e?.message || e), reason: "Couldn't check this device. Tap Check again." });
    }
    setBusy(false);
  }, []);

  useEffect(() => {
    check();
    // Belt and braces. "Checking this device…" must never be the final state: if
    // nothing has answered in 10s, stop waiting and show something actionable. This
    // component has now failed silently three ways — blank, then blank-with-reason,
    // then a spinner that never stopped — so the rule is that every path ends in
    // words plus a button.
    const t = setTimeout(() => {
      setStatus((s) => s || {
        state: "error", available: false, label: "biometric unlock",
        reason: "This device didn't answer. Tap Check again, or carry on — the app works without it.",
        detail: "The biometric check timed out.",
      });
      setBusy(false);
    }, 10000);
    return () => clearTimeout(t);
  }, [check]);

  // NEVER render nothing. Every hidden state this component has had — "not native",
  // "no plugin", "no sensor", "the check threw" — has been reported as "the feature
  // is missing", because an empty space cannot tell you it is empty on purpose.
  // Even the first paint, before the device has answered, says something.
  // Transient only — the effect above guarantees this resolves within 10 seconds,
  // one way or the other.
  if (!status) {
    return (
      <div className="flex items-center gap-2 px-4 py-3.5 text-sm font-semibold text-slate-400">
        <Loader2 size={15} className="animate-spin" /> Checking this device…
      </div>
    );
  }

  const label = status.label || biometryLabel(status.biometryType);
  const ready = status.state === "ready";
  // Whatever the device actually offers. The fallback keeps a single sensible entry
  // for a platform that reports no specific type (a browser, mainly).
  const methods = status.methods?.length ? status.methods : [{ key: "platform", label }];
  const errNote = note ? <p className="mt-2 rounded-lg bg-rose-50 px-2 py-1 text-[11px] font-semibold text-rose-600">{note}</p> : null;

  const turnOn = async () => {
    setBusy(true); setNote("");
    // The owner binds the credential and the remembered session to this account, so a
    // shared device can't unlock one person's session with another's face.
    const res = await enableBiometric({ owner });
    setBusy(false);
    if (res.ok) { setOn(true); return; }
    // A cancel is a choice, not a fault.
    if (res.reason !== "cancelled") setNote(res.reason || "Could not turn this on.");
  };
  const turnOff = async () => {
    setBusy(true); setNote("");
    const res = await disableBiometric();
    setBusy(false);
    if (res.ok) { setOn(false); return; }
    if (res.reason !== "cancelled") setNote(res.reason || "Could not turn this off.");
  };

  /* --- Unavailable: say why, and offer a way to re-check --- */
  if (!ready) {
    return (
      <div className="px-4 py-3.5">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-700">
          <Fingerprint size={15} className="text-slate-400" /> {label}
        </span>
        <span className="mt-0.5 block text-[11px] leading-snug text-slate-400">{status.reason}</span>
        {/* Enrolling a face or finger happens in the DEVICE's settings, outside this
            app, so there has to be a way back in that isn't force-quitting. */}
        <div className="mt-2 flex items-center gap-3">
          <button onClick={check} disabled={busy}
            className="press flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-1 text-[11px] font-bold text-slate-600 transition hover:bg-slate-200 disabled:opacity-50">
            {busy ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />} Check again
          </button>
          {status.detail && (
            <button onClick={() => setShowWhy(v => !v)} className="text-[11px] font-semibold text-slate-400 underline transition hover:text-slate-600">
              {showWhy ? "Hide details" : "Why?"}
            </button>
          )}
        </div>
        {showWhy && status.detail && (
          <p className="mt-2 rounded-lg bg-slate-50 px-2 py-1.5 text-[11px] leading-snug text-slate-500 ring-1 ring-slate-200">
            Device reported: {status.detail}
          </p>
        )}
        {errNote}
      </div>
    );
  }

  /* --- Already on: confirm it, and offer to switch it off --- */
  if (on) {
    return (
      <div className="px-4 py-3.5">
        <div className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2">
            <ShieldCheck size={16} className="shrink-0 text-emerald-600" />
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-slate-700">App lock is on</span>
              <span className="block text-[11px] leading-snug text-slate-400">
                You'll be asked for {methods.map(m => m.label).join(" or ")} when the app opens
              </span>
            </span>
          </span>
          <button onClick={turnOff} disabled={busy}
            className="press shrink-0 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50">
            {busy ? <Loader2 size={12} className="animate-spin" /> : "Turn off"}
          </button>
        </div>
        {errNote}
      </div>
    );
  }

  /* --- Off: one tappable option per method the device offers --- */
  return (
    <div className="px-4 py-3.5">
      <p className="text-sm font-semibold text-slate-700">Open the app with</p>
      <p className="mt-0.5 text-[11px] leading-snug text-slate-400">Tap one to switch the app lock on.</p>
      <div className="mt-2.5 space-y-2">
        {methods.map((m) => {
          const Icon = m.key === "face" || m.key === "iris" ? ScanFace : Fingerprint;
          return (
            <button key={m.key} onClick={turnOn} disabled={busy}
              className="press group flex w-full items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-left transition hover:border-slate-300 hover:bg-slate-50 disabled:opacity-60">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ background: "rgba(26,58,143,0.08)" }}>
                <Icon size={17} style={{ color: NAVY }} />
              </span>
              <span className="flex-1 text-sm font-semibold text-slate-700">Open with {m.label}</span>
              {busy ? <Loader2 size={15} className="animate-spin text-slate-400" /> : <ChevronRight size={16} className="text-slate-300 transition-transform group-hover:translate-x-0.5" />}
            </button>
          );
        })}
      </div>
      {/* Said plainly, because the options above cannot control this: the OS owns the
          choice of sensor once more than one is enrolled. */}
      {methods.length > 1 && (
        <p className="mt-2 text-[11px] leading-snug text-slate-400">
          If you've set up more than one, your device chooses which to ask for.
        </p>
      )}
      {errNote}
    </div>
  );
}
export default BiometricSetting;
