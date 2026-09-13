import { useEffect, useRef } from "react";

// Swipe-from-the-left-edge = back, the gesture every iOS user already has in their
// thumb and Android's gesture navigation trains too. Implemented in the WEB layer,
// on window, rather than natively per platform, for two reasons:
//
// - iOS's own edge gesture is a UINavigationController affordance; a Capacitor app is
//   one WKWebView with no native navigation stack, so the system gesture simply does
//   not exist here unless the webview's back-forward gesture is enabled — and that
//   walks the WebView's HISTORY, which in this SPA is one entry deep (screens are
//   React state, not URLs), so it would do nothing. One JS listener gives iOS and
//   Android the identical gesture for free.
// - The alternative — turning screens into real history entries so the browser/webview
//   gestures work — was rejected: backButton.js, the deep-link stash (pendingQr.js)
//   and the shell's screen-as-state model all assume a single-entry history, and
//   rebuilding navigation for one gesture is out of all proportion.
//
// Tuning: the gesture must START hard against the left edge (within EDGE_PX) — a drag
// that begins mid-screen is a scroll or a chart pan, never a back. It fires DURING the
// drag, the moment the finger has travelled TRIGGER_PX and is moving clearly
// horizontally, because waiting for touchend makes the gesture feel like it was
// ignored and then acted on. Once the drag reads as vertical it is abandoned for good
// (`tracking = false`), so a scroll that happens to begin at the edge is never
// hijacked halfway through.
const EDGE_PX = 28;    // how close to the left edge the touch must start
const TRIGGER_PX = 64; // horizontal travel that commits the gesture

export function useEdgeSwipeBack(onBack) {
  // A ref rather than a dependency: onBack closes over navigation state that changes
  // every screen switch, and re-binding three window listeners per navigation for
  // that is the same churn usePullToRefresh's pullRef exists to avoid.
  const backRef = useRef(onBack);
  backRef.current = onBack;

  useEffect(() => {
    let tracking = false;
    let fired = false;
    let startX = 0;
    let startY = 0;

    const onTouchStart = (e) => {
      // Multi-touch (a pinch) is never a back gesture.
      if (e.touches.length !== 1) { tracking = false; return; }
      const t = e.touches[0];
      tracking = t.clientX <= EDGE_PX;
      fired = false;
      startX = t.clientX;
      startY = t.clientY;
    };
    const onTouchMove = (e) => {
      if (!tracking || fired) return;
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = Math.abs(t.clientY - startY);
      // Reads as a scroll (vertical wins) or a right-to-left drag — give up entirely.
      if (dx < 0 || (dy > 24 && dy > dx)) { tracking = false; return; }
      if (dx >= TRIGGER_PX && dx > dy * 1.5) {
        fired = true;
        tracking = false;
        try { backRef.current?.(); } catch (_) { /* a broken handler must not kill the listener */ }
      }
    };
    const onTouchEnd = () => { tracking = false; };

    // Passive on purpose, all three: this gesture only ever OBSERVES the touch — it
    // never preventDefaults, so scrolling stays smooth and the pull-to-refresh
    // gesture (PhoneShell.jsx), which does need a non-passive move listener, keeps
    // sole ownership of cancelling anything.
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []);
}

export default useEdgeSwipeBack;
