import React from "react";
import { useBackHandler } from "./backButton";

// A small centred confirmation dialog — used to guard actions like signing out so
// an accidental tap doesn't do something disruptive. Renders nothing when closed.
export default function ConfirmDialog({ open, title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false, onConfirm, onCancel }) {
  // Android back cancels the dialog (never the confirm — no accidental sign-out).
  useBackHandler(open, () => { onCancel?.(); return true; });
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4" style={{ background: "rgba(15,23,42,.45)", backdropFilter: "blur(2px)" }} onClick={onCancel}>
      <div className="bounce-in w-full max-w-xs rounded-2xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <p className="text-base font-extrabold text-slate-800">{title}</p>
        {message && <p className="mt-1 text-sm leading-relaxed text-slate-500">{message}</p>}
        <div className="mt-5 flex gap-2">
          <button onClick={onCancel} className="press flex-1 rounded-xl border-2 border-slate-200 py-2.5 text-sm font-bold text-slate-600 transition hover:bg-slate-50">{cancelLabel}</button>
          <button onClick={onConfirm} className="press flex-1 rounded-xl py-2.5 text-sm font-bold text-white shadow-md" style={{ background: danger ? "#9e1b32" : "var(--brand-primary)" }}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
