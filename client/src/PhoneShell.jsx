// The staff app's container.
//
// On a desktop screen it draws a decorative phone (frame, notch, fake status bar)
// so the demo reads as "this is the mobile app". On an actual phone — or inside
// the packaged Capacitor app — that chrome is wrong: it wastes screen space and
// paints a fake clock and battery next to the real ones. There we go full-bleed
// and let the device supply its own status bar.
import React, { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

// True when the app is running inside the native Capacitor shell.
export const isNativeApp = () =>
  typeof window !== "undefined" &&
  (window.Capacitor?.isNativePlatform?.() === true ||
    /(^|;)\s*capacitor:\/\//.test(window.location.protocol) ||
    window.location.protocol === "capacitor:");

// A handset is: the packaged app, OR a narrow screen, OR a TOUCH screen that is
// short. That last clause matters — a phone rotated to landscape is ~850x390, so
// a width-only test decided it was a desktop and drew the decorative 390x820 phone
// frame inside the real phone, which then could not even fit. The height limit
// keeps tablets (768px+ tall in landscape) on the desktop presentation.
const HANDSET_QUERY = "(max-width: 640px), (pointer: coarse) and (max-height: 600px)";

export function useIsHandset() {
  const [isHandset, setIsHandset] = useState(() => {
    if (typeof window === "undefined") return false;
    return isNativeApp() || window.matchMedia(HANDSET_QUERY).matches;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(HANDSET_QUERY);
    const update = () => setIsHandset(isNativeApp() || mq.matches);
    update();
    // addEventListener is not available on older Safari's MediaQueryList.
    if (mq.addEventListener) { mq.addEventListener("change", update); return () => mq.removeEventListener("change", update); }
    mq.addListener(update);
    return () => mq.removeListener(update);
  }, []);
  return isHandset;
}

/* ============================== pull-to-refresh ============================== */
// A CUSTOM gesture, not the browser's own rubber-band-triggered reload. index.css:136+
// sets `overscroll-behavior-y: none` on <body> deliberately — a packaged app has no
// browser chrome to bounce against, so native overscroll there just reads as the UI
// glitching. Turning that off also removes Android WebView/iOS's own native
// pull-to-refresh gesture, which rode on exactly the overscroll this app just switched
// off, so a student on the phone build lost the gesture entirely once that landed.
// This rebuilds it by hand, scoped to the ONE element it belongs on: the scrollport,
// not the page, and only when it is already scrolled to the very top.
const PULL_THRESHOLD = 64; // px of drag past which releasing triggers a refresh
const PULL_MAX = 96;       // the indicator's travel cap; drag further and it slows down
const PULL_SNAP_MS = 220;  // the spring-back/settle duration — index.css's own motion
                            // language (student/ui/tokens.js#MOTION_MS) runs 120-420ms
                            // for "something responding to touch"; this sits in that band.

function usePullToRefresh(ref, onRefresh, active) {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // A ref alongside the state: touchend needs the LATEST drag distance to decide
  // whether the threshold was cleared, but putting `pull` in the effect's own
  // dependency array would tear down and re-attach all four listeners on every pixel
  // of the drag — expensive, and a real risk of dropping a touchmove event exactly
  // between the old listener's removal and the new one's attachment.
  const pullRef = useRef(0);
  const busyRef = useRef(false);
  const setBoth = (v) => { pullRef.current = v; setPull(v); };

  useEffect(() => {
    const el = ref.current;
    if (!el || !active) return undefined;
    let tracking = false;
    let startY = 0;

    const onTouchStart = (e) => {
      if (busyRef.current) return;
      // Only a pull that STARTS at the very top counts — a drag begun mid-list must
      // stay an ordinary scroll, never hijacked into a refresh gesture.
      if (el.scrollTop > 0) { tracking = false; return; }
      tracking = true;
      startY = e.touches[0].clientY;
    };
    const onTouchMove = (e) => {
      if (!tracking || busyRef.current) return;
      const dy = e.touches[0].clientY - startY;
      // An upward drag, or one that has scrolled the list since it started (a fast
      // swipe can do both in one gesture), hands control straight back to the browser.
      if (dy <= 0 || el.scrollTop > 0) { tracking = false; setBoth(0); return; }
      // Stop the page's own scroll/rubber-band for exactly this gesture — the one
      // place in the app that DOES want the finger to move the content, on the one
      // element overscroll-behavior-y:none otherwise keeps still. Requires this
      // listener to be non-passive (below), or preventDefault is a silent no-op.
      e.preventDefault();
      // Resistance past PULL_MAX, so the indicator settles into a ceiling rather than
      // following the finger indefinitely — the same "it pushes back" feel every
      // native pull-to-refresh has.
      const capped = dy <= PULL_MAX ? dy : PULL_MAX + (dy - PULL_MAX) * 0.15;
      setBoth(capped);
    };
    const onTouchEnd = () => {
      if (!tracking) return;
      tracking = false;
      if (pullRef.current >= PULL_THRESHOLD) {
        busyRef.current = true;
        setRefreshing(true);
        setBoth(PULL_THRESHOLD); // hold the indicator open while the refresh is in flight
        Promise.resolve(onRefresh?.()).finally(() => {
          busyRef.current = false;
          setRefreshing(false);
          setBoth(0);
        });
      } else {
        setBoth(0); // released short of the threshold — spring back, nothing happens
      }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [ref, onRefresh, active]);

  return { pull, refreshing };
}

// The indicator + the content wrapper that visibly follows the finger. A single
// component so the handset and desktop-decorative renders below share one
// implementation rather than two copies of the same gesture math.
function PullToRefresh({ scrollRef, onRefresh, children }) {
  const active = typeof onRefresh === "function";
  const { pull, refreshing } = usePullToRefresh(scrollRef, onRefresh, active);
  if (!active) return children;
  const progress = Math.min(1, pull / PULL_THRESHOLD);
  const dragging = pull > 0 && !refreshing;
  return (
    <>
      {/* The indicator sits ABOVE the content, revealed as the content is pushed down
          rather than overlaid on top of it — the same visual language as the
          platform gestures this replaces (index.css's comment on WHY explains what
          it replaces and why it had to be rebuilt by hand). */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center"
        style={{ height: PULL_MAX, transform: `translateY(${Math.min(pull, PULL_MAX) - PULL_MAX}px)`, opacity: pull > 2 || refreshing ? 1 : 0, transition: dragging ? "none" : `opacity ${PULL_SNAP_MS}ms ease, transform ${PULL_SNAP_MS}ms cubic-bezier(.4,0,.2,1)` }}
      >
        <span className="mt-auto mb-2 flex h-9 w-9 items-center justify-center rounded-full bg-white shadow-card ring-1 ring-slate-200/80 dark:bg-slate-800 dark:ring-slate-700/60">
          <RefreshCw
            size={16}
            className={`text-slate-500 dark:text-slate-300 ${refreshing ? "animate-spin" : ""}`}
            style={refreshing ? undefined : { transform: `rotate(${progress * 180}deg)`, transition: dragging ? "none" : `transform ${PULL_SNAP_MS}ms ease` }}
          />
        </span>
      </div>
      <div style={{ transform: pull ? `translateY(${pull}px)` : undefined, transition: dragging ? "none" : `transform ${PULL_SNAP_MS}ms cubic-bezier(.4,0,.2,1)` }}>
        {children}
      </div>
    </>
  );
}

/**
 * header    — the app's coloured top bar (supplies its own background)
 * children  — the scrolling body
 * onRefresh — optional. When given, the scrollport grows a custom pull-to-refresh
 *             gesture (see usePullToRefresh above); omitted, PhoneShell behaves
 *             exactly as before. Only the student app passes it today.
 * refreshing— optional, whether a refresh triggered elsewhere (the header's own
 *             refresh button) is already in flight, so the gesture does not start a
 *             second overlapping one and its indicator does not lag reality.
 *
 * The header keeps its own styling in both modes; this component only decides
 * between "decorative phone on a desktop page" and "fill the device screen".
 */
export default function PhoneShell({ header, children, onRefresh, refreshing }) {
  const handset = useIsHandset();
  const scrollRef = useRef(null);
  // Never armed while a refresh from elsewhere (the header's spinner) is already
  // running — usePullToRefresh's own `busyRef` guards a SECOND drag mid-refresh, but
  // that guard only exists once a drag has already started; this stops one starting
  // at all while `refreshing` is already true from the outside.
  const effectiveOnRefresh = refreshing ? undefined : onRefresh;

  if (handset) {
    return (
      // Fills whatever height the parent gives it, so it can sit under the app's
      // top bar without the two together overflowing the screen.
      <div className="flex h-full w-full flex-col overflow-hidden bg-white dark:bg-slate-950">
        <div className="shrink-0">{header}</div>
        <div
          ref={scrollRef}
          className="relative flex-1 overflow-y-auto bg-slate-50 dark:bg-slate-900"
          // Clear of the home indicator, with momentum scrolling on iOS.
          style={{ paddingBottom: "env(safe-area-inset-bottom)", WebkitOverflowScrolling: "touch" }}
        >
          <PullToRefresh scrollRef={scrollRef} onRefresh={effectiveOnRefresh}>
            {children}
          </PullToRefresh>
        </div>
      </div>
    );
  }

  // Desktop: the decorative phone.
  return (
    <div className="flex justify-center py-6">
      <div className="scale-in relative w-[390px] max-w-full overflow-hidden rounded-[2.6rem] border-[10px] border-slate-900 bg-white shadow-2xl ring-1 ring-slate-900/5 dark:bg-slate-950" style={{ height: 820 }}>
        <div className="absolute left-1/2 top-0 z-30 h-6 w-36 -translate-x-1/2 rounded-b-2xl bg-slate-900" />
        <div className="flex h-full flex-col">
          <div className="shrink-0">{header}</div>
          <div ref={scrollRef} className="relative flex-1 overflow-y-auto bg-slate-50 dark:bg-slate-900">
            <PullToRefresh scrollRef={scrollRef} onRefresh={effectiveOnRefresh}>
              {children}
            </PullToRefresh>
          </div>
        </div>
      </div>
    </div>
  );
}
