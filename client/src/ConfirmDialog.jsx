import React from "react";
import { useBackHandler } from "./backButton";
import ModalPortal from "./ModalPortal";

// A small centred confirmation dialog — used to guard actions like signing out so
// an accidental tap doesn't do something disruptive. Renders nothing when closed.
//
// THROUGH A PORTAL, and at a z-index above every other overlay. This dialog is the
// one component in the app that routinely has to cover ANOTHER modal: it is what asks
// "Delete this class?" while the event modal that asked is still open behind it. Left
// in the tree where it is written, it was trapped in the console view's containing
// block and stacking context — see ModalPortal.jsx for why that happens — so it drew
// low on the page and UNDERNEATH the modal it belonged to, with only its buttons
// showing below the modal's bottom edge. The modal had to be closed to reach them,
// which meant cancelling the very action being confirmed.
//
// z-[200] rather than the z-[120] it carried, because once everything is in one
// stacking context the numbers finally mean something and this must win: the console's
// own overlays sit at 50, 80, 95 and 120, and a confirmation that ties with the sheet
// it is covering is decided by mount order, which is not a rule anyone can reason
// about.
export default function ConfirmDialog({ open, title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false, onConfirm, onCancel }) {
  // Android back cancels the dialog (never the confirm — no accidental sign-out).
  useBackHandler(open, () => { onCancel?.(); return true; });
  if (!open) return null;
  return (
    <ModalPortal>
      <div className="fixed inset-0 z-[200] flex items-center justify-center p-4" style={{ background: "rgba(15,23,42,.45)", backdropFilter: "blur(2px)" }} onClick={onCancel}>
        {/* max-w-sm, not max-w-xs: these messages name the thing being deleted and say
            what survives it, which is two or three lines at 320px and reads as a wall.
            max-h/overflow-y so a long title on a short screen — a phone in landscape,
            a laptop with the browser half-height — scrolls the message rather than
            pushing the buttons out of reach, which is the same failure this whole
            change exists to fix. */}
        <div className="bounce-in flex max-h-[85vh] w-full max-w-sm flex-col overflow-hidden rounded-2xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <p className="text-base font-extrabold text-slate-800">{title}</p>
            {message && <p className="mt-1 text-sm leading-relaxed text-slate-500">{message}</p>}
          </div>
          {/* Wraps to one button per row below ~260px of usable width — two labels as
              long as "Keep it"/"Delete" fit side by side on any real phone, but a
              translated or longer pair must not overflow the card. */}
          <div className="mt-5 flex shrink-0 flex-wrap gap-2">
            <button onClick={onCancel} className="press min-w-[7rem] flex-1 rounded-xl border-2 border-slate-200 py-2.5 text-sm font-bold text-slate-600 transition hover:bg-slate-50">{cancelLabel}</button>
            <button onClick={onConfirm} className="press min-w-[7rem] flex-1 rounded-xl py-2.5 text-sm font-bold text-white shadow-md" style={{ background: danger ? "#9e1b32" : "var(--brand-primary)" }}>{confirmLabel}</button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
