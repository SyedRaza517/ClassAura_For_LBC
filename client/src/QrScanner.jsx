// The in-app scanner: the camera, a decode loop, and one answer.
//
// The phone's own camera app already opens the projector's link, and that stays the
// simplest route. This exists for the two cases it does not cover: the packaged app,
// where a link opens the browser rather than the app until deep links are configured,
// and a student who would rather stay inside the app. It reads the same link shape and
// hands the app the same thing a scanned link would (see scanText.js and pendingQr.js).
//
// jsQR is loaded on first open, not with the app: nobody pays for a decoder until they
// press the button. Frames are scaled to at most 640px wide before decoding — a 4K
// preview decoded at full size drops the loop to a few frames a second on a mid-range
// handset, and a code that fills a quarter of the frame decodes fine at 640.
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { parseScan } from "./scanText";

const MAX_WIDTH = 640;

export default function QrScanner({ onScan, onClose }) {
  const videoRef = useRef(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let stream = null, raf = 0, done = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const stop = () => {
      done = true;
      if (raf) cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setErr("This browser cannot open the camera. Point your phone's camera app at the code instead.");
        return;
      }
      let jsQR;
      try { jsQR = (await import("jsqr")).default; }
      catch (_) { setErr("The scanner could not load. Point your phone's camera app at the code instead."); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      } catch (e) {
        setErr(e?.name === "NotAllowedError"
          ? "Camera access was refused. Allow it in your settings, or point your phone's camera app at the code."
          : "The camera could not be opened. Point your phone's camera app at the code instead.");
        return;
      }
      if (done) { stream.getTracks().forEach((t) => t.stop()); return; }
      const v = videoRef.current;
      if (!v) { stop(); return; }
      v.srcObject = stream;
      await v.play().catch(() => {});
      const tick = () => {
        if (done) return;
        if (v.readyState >= 2 && v.videoWidth > 0) {
          const scale = Math.min(1, MAX_WIDTH / v.videoWidth);
          canvas.width = Math.round(v.videoWidth * scale);
          canvas.height = Math.round(v.videoHeight * scale);
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const hit = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
          const parsed = hit ? parseScan(hit.data) : null;
          if (parsed) { stop(); onScan(parsed); return; }
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    })();
    return stop;
  }, [onScan]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Scan the check-in code" className="fixed inset-0 z-[95] flex flex-col bg-black text-white">
      <div className="flex items-center justify-between gap-3 p-4">
        <p className="text-sm font-bold">Point the camera at the code on screen</p>
        <button onClick={onClose} aria-label="Close the scanner" className="press shrink-0 rounded-xl bg-white/10 p-2.5"><X size={22} /></button>
      </div>
      <div className="relative min-h-0 flex-1">
        <video ref={videoRef} muted playsInline autoPlay className="h-full w-full object-cover" />
        {!err && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-56 w-56 rounded-2xl border-2 border-white/80" />
          </div>
        )}
        {err && (
          <div className="absolute inset-x-4 bottom-6 rounded-2xl bg-white p-4 text-slate-800" role="alert">
            <p className="text-sm font-bold">Camera not available</p>
            <p className="mt-1 text-[13px] leading-relaxed text-slate-600">{err}</p>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
