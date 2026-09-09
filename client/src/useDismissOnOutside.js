import { useEffect } from "react";

/**
 * Close `onOutside` when a pointer goes down anywhere outside `ref`, while `active`.
 *
 * A LISTENER RATHER THAN A FULL-SCREEN DIV, and that is the whole point of this file.
 *
 * The pattern it replaces is `<div className="fixed inset-0" onClick={close} />` — a
 * viewport-covering element rendered in the middle of a component. It READS as covering
 * the screen and repeatedly did not, because a fixed-position element is hostage to
 * whatever it happens to be nested inside:
 *
 *   - a <label> ancestor forwarded the click to its labeled control, so the catcher
 *     closed the dropdown and the label immediately reopened it (Scheduling, 8 Sep);
 *   - `.fade-up` — the admin console's entrance animation, declared `animation: … both`
 *     — leaves a computed matrix(1,0,0,1,0,0) for ever, and ANY computed transform makes
 *     an element the containing block for its fixed descendants, so `inset-0` resolved
 *     against the view box rather than the viewport and the menu dismissed over part of
 *     the screen only (the 3-dots menu, reported three times);
 *   - the same mechanism put a modal's Save button 159px below the fold.
 *
 * A document listener has no position, no z-index and no parent, so none of that can
 * reach it. It behaves the same inside a portalled modal as on the page behind it.
 *
 * `pointerdown`, not `click`: it fires before focus moves, so a control closes on the way
 * down rather than waiting for a mouseup that may land somewhere else entirely. CAPTURE
 * phase, so a child calling stopPropagation cannot strand a panel open.
 *
 * Escape belongs with it rather than beside it — the two are one behaviour ("let me
 * out"), and splitting them across components is how one comes back without the other.
 *
 * @param {{current: HTMLElement|null}} ref  the element that counts as "inside"
 * @param {() => void} onOutside            called on an outside pointerdown, or Escape
 * @param {boolean} active                  only listens while true
 */
export default function useDismissOnOutside(ref, onOutside, active) {
  useEffect(() => {
    if (!active) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onOutside(); };
    const onKey = (e) => { if (e.key === "Escape") onOutside(); };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [ref, onOutside, active]);
}
