// Tap-a-sticker check-in, for both apps.
//
// One component, two callers: the student app marks a register, the staff app clocks in
// Onsite. What differs is a single API call and the words on the result, so both are
// props rather than two near-identical screens that drift apart.
//
// THE SHAPE OF THE INTERACTION
//
// The button is dead until a sticker has been read, and goes dead again sixty seconds
// later. That is the whole security model on the device side: a tap proves the person
// was at that wall a moment ago, and an arming window long enough to press but too short
// to walk to another room is what keeps it meaning that.
//
// Android arms itself the moment the screen opens — reader mode is silent. iPhone cannot:
// Apple's scan sheet is compulsory, so there is a "Scan the sticker" button first. The
// difference is read from nfc.js rather than restated here.
import React, { useState, useEffect, useCallback, useRef } from "react";
import { Nfc, CheckCircle2, Loader2, AlertTriangle, Clock3, Wifi, WifiOff, Smartphone } from "lucide-react";
import { nfcStatus, scanOnce, cancelScan } from "./nfc";
import { NAVY } from "./branding";

/** mm:ss remaining, for the arming countdown. */
const secsLeft = (until) => Math.max(0, Math.ceil((until - Date.now()) / 1000));

/**
 * @param {object} props
 * @param {number} props.armSeconds     how long a read keeps the button live
 * @param {function} props.onCheckIn    async (tagCode) => result. Throws to show an error.
 * @param {string} props.actionLabel    the button's words, e.g. "Check in"
 * @param {React.ReactNode} props.subtitle  what this check-in is FOR, rendered above
 * @param {function} [props.renderResult]   turn a successful result into a message
 * @param {boolean} [props.disabled]    the caller says now is not the time
 * @param {string} [props.disabledNote] and why
 */
export default function CheckInCard({
  armSeconds = 60,
  onCheckIn,
  actionLabel = "Check in",
  subtitle = null,
  renderResult,
  disabled = false,
  disabledNote = "",
}) {
  const [status, setStatus] = useState(null);      // from nfcStatus()
  const [scanning, setScanning] = useState(false);
  const [code, setCode] = useState(null);          // the sticker we read
  const [armedUntil, setArmedUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const alive = useRef(true);

  useEffect(() => () => { alive.current = false; cancelScan(); }, []);

  useEffect(() => { nfcStatus().then((s) => { if (alive.current) setStatus(s); }); }, []);

  // One timer, ticking only while the button is actually armed. A permanent interval
  // would re-render this card every second for the whole time the screen is open.
  useEffect(() => {
    if (!armedUntil) return undefined;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [armedUntil]);

  const armed = armedUntil > now && !!code;
  const remaining = armed ? secsLeft(armedUntil) : 0;

  // When the window closes, the code goes with it. Keeping it would leave a button that
  // looks dead but would still work if anything re-armed it — the arming window has to
  // be the only thing standing between a read and a check-in.
  useEffect(() => {
    if (armedUntil && armedUntil <= now) { setCode(null); setArmedUntil(0); }
  }, [now, armedUntil]);

  const startScan = useCallback(async () => {
    setError(""); setResult(null); setScanning(true);
    try {
      const c = await scanOnce({ alertMessage: "Hold your phone near the sticker" });
      if (!alive.current) return;
      setCode(c);
      setArmedUntil(Date.now() + armSeconds * 1000);
      setNow(Date.now());
    } catch (e) {
      if (alive.current) setError(e?.message || "Could not read the sticker.");
    } finally {
      if (alive.current) setScanning(false);
    }
  }, [armSeconds]);

  // Android arms itself as soon as the card appears, and re-arms after the window
  // lapses, so a student who walks up and holds their phone to the wall never presses
  // anything first. iOS cannot do this — Apple's sheet needs a gesture.
  useEffect(() => {
    if (!status?.ok || status.needsPrompt) return;
    if (armed || scanning || busy || disabled) return;
    startScan();
  }, [status, armed, scanning, busy, disabled, startScan]);

  async function submit() {
    if (!code || busy) return;
    setBusy(true); setError("");
    try {
      const r = await onCheckIn(code);
      if (!alive.current) return;
      setResult(r);
      setCode(null); setArmedUntil(0);
    } catch (e) {
      if (alive.current) setError(e?.message || "That didn't work.");
      // The code is dropped on failure too. A refused tap is not a credential to retry
      // with — whatever the reason, the honest next step is to touch the sticker again.
      setCode(null); setArmedUntil(0);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  /* ---------- states where tapping is not the answer ---------- */

  if (status && !status.ok) {
    const messages = {
      web: { Icon: Smartphone, title: "Use the app to check in", body: "Tap check-in needs the college app on your phone — a browser can't read a sticker." },
      "no-hardware": { Icon: WifiOff, title: "This phone can't read stickers", body: "It has no NFC chip, so your lecturer will mark you in the usual way." },
      disabled: { Icon: Wifi, title: "NFC is switched off", body: "Turn NFC on in your phone's settings, then come back to this screen." },
      error: { Icon: AlertTriangle, title: "NFC isn't working", body: status.detail || "Something went wrong starting the reader." },
    };
    const { Icon, title, body } = messages[status.reason] || messages.error;
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-5">
        <div className="flex gap-3">
          <Icon size={20} className="mt-0.5 shrink-0 text-slate-400" />
          <div>
            <p className="text-sm font-semibold text-slate-800">{title}</p>
            <p className="mt-1 text-[13px] leading-relaxed text-slate-500">{body}</p>
          </div>
        </div>
      </div>
    );
  }

  /* ---------- the ordinary case ---------- */

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5" style={armed ? { borderColor: NAVY, boxShadow: `0 0 0 3px ${NAVY}18` } : undefined}>
      {subtitle}

      {result && (
        <div className="mb-3 flex gap-2.5 rounded-xl bg-emerald-50 p-3 ring-1 ring-emerald-200">
          <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-600" />
          <div className="text-[13px] leading-relaxed text-emerald-900">
            {renderResult ? renderResult(result) : "Checked in."}
          </div>
        </div>
      )}

      {error && (
        <div className="mb-3 flex gap-2.5 rounded-xl bg-rose-50 p-3 ring-1 ring-rose-200">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-rose-600" />
          <p className="text-[13px] leading-relaxed text-rose-900">{error}</p>
        </div>
      )}

      {disabled ? (
        <p className="flex items-center gap-2 text-[13px] text-slate-500">
          <Clock3 size={15} className="shrink-0" />{disabledNote || "Check-in isn't open."}
        </p>
      ) : (
        <>
          <div className="mb-3 flex items-center gap-2.5">
            <span
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors"
              style={{ background: armed ? NAVY : "#f1f5f9", color: armed ? "#fff" : "#94a3b8" }}
            >
              {scanning ? <Loader2 size={19} className="animate-spin" /> : <Nfc size={19} />}
            </span>
            <p className="text-[13px] leading-snug text-slate-600">
              {armed
                ? <>Sticker read. <span className="font-semibold text-slate-800">Press {actionLabel.toLowerCase()}</span> — {remaining}s left.</>
                : scanning
                  ? "Hold your phone against the sticker…"
                  : status?.needsPrompt
                    ? "Scan the sticker to switch on the button below."
                    : "Hold your phone against the sticker on the wall."}
            </p>
          </div>

          {status?.needsPrompt && !armed && (
            <button
              type="button" onClick={startScan} disabled={scanning}
              className="press mb-2 w-full rounded-xl border border-slate-300 py-2.5 text-sm font-semibold text-slate-700 disabled:opacity-50"
            >
              {scanning ? "Scanning…" : "Scan the sticker"}
            </button>
          )}

          <button
            type="button" onClick={submit} disabled={!armed || busy}
            className="press w-full rounded-xl py-3 text-sm font-bold text-white transition-all disabled:cursor-not-allowed"
            style={{ background: armed && !busy ? NAVY : "#cbd5e1" }}
          >
            {busy ? <span className="flex items-center justify-center gap-2"><Loader2 size={16} className="animate-spin" />Checking in…</span> : actionLabel}
          </button>
        </>
      )}
    </div>
  );
}
