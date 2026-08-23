// The app's brand mark — an institution's own logo when it has uploaded one, and
// otherwise the platform's fanlight emblem plus a wordmark taken from its name.
// recreated as SVG so every logo in the app is one shared, resolution-independent
// component. The emblem is a solid royal-blue semicircle with a white fanlight:
// an outer ring, a central hub and radial spokes.
// The institution's own colours, not the platform's. See src/brand.js — these are
// CSS variables, so a college changing its primary colour restyles the emblem and
// wordmark along with everything else.
import { getBranding, onBranding } from "./branding";
import { useState, useEffect } from "react";
export const BRAND_BLUE = "var(--brand-primary)";
export const BRAND_NAVY = "var(--brand-primary)";
export const BRAND_MAROON = "var(--brand-accent)";

/** Re-render when branding arrives, so a logo uploaded by the college appears without a reload. */
function useBrand() {
  const [b, setB] = useState(getBranding);
  useEffect(() => onBranding(setB), []);
  return b;
}

// The emblem alone. By default: a filled blue semicircle with white fanlight lines
// (for light backgrounds). Pass `mono` to draw the fanlight as a single-colour outline
// instead — e.g. a white mark on a coloured header.
export function BrandMark({ size = 40, className = "", mono = null }) {
  const brand = useBrand();
  // An institution that has uploaded its own logo gets ITS logo — the drawn emblem
  // below is the platform's, and showing it to a college that has supplied a crest
  // would be putting somebody else's mark on their app.
  if (brand.logoDataUri) {
    return (
      <img
        src={brand.logoDataUri}
        alt={brand.displayName || "Logo"}
        className={className}
        style={{ height: size * 0.58, width: "auto", maxWidth: size * 2.4, objectFit: "contain" }}
      />
    );
  }
  const cx = 50, by = 52, R = 46, rO = 39.5, rI = 13.5, N = 6;
  // N spokes evenly divide the half-circle into N+1 segments (a narrow central wedge).
  const angles = Array.from({ length: N }, (_, i) => ((i + 1) * 180) / (N + 1));
  const pt = (r, deg) => { const a = (deg * Math.PI) / 180; return [+(cx + r * Math.cos(a)).toFixed(2), +(by - r * Math.sin(a)).toFixed(2)]; };
  const arc = (r) => `M${cx - r},${by} A${r},${r} 0 0 1 ${cx + r},${by}`;
  const svgProps = { viewBox: "0 0 100 58", width: size, height: size * 0.58, className, role: "img", "aria-label": brand.displayName || "Logo" };

  if (mono) {
    // Single-colour outline for a coloured background.
    return (
      <svg {...svgProps}>
        <g stroke={mono} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" fill="none">
          <path d={arc(R)} />
          <line x1={cx - R} y1={by} x2={cx + R} y2={by} />
          <path d={arc(rI)} />
          {angles.map((deg, i) => { const [ix, iy] = pt(rI, deg), [ox, oy] = pt(R - 3, deg); return <line key={i} x1={ix} y1={iy} x2={ox} y2={oy} />; })}
        </g>
      </svg>
    );
  }
  return (
    <svg {...svgProps}>
      <path d={`${arc(R)} Z`} fill={BRAND_BLUE} />
      <g stroke="#ffffff" strokeWidth="2.6" strokeLinecap="round" fill="none">
        <path d={arc(rO)} />
        <path d={arc(rI)} />
        {angles.map((deg, i) => { const [ix, iy] = pt(rI, deg), [ox, oy] = pt(rO, deg); return <line key={i} x1={ix} y1={iy} x2={ox} y2={oy} />; })}
      </g>
    </svg>
  );
}

// The full lockup: emblem above the two-line wordmark.
export function BrandLockup({ compact = false }) {
  const brand = useBrand();
  // A college that uploaded a logo has already said what its mark is; stacking the
  // platform's two-line wordmark under it would contradict that.
  if (brand.logoDataUri) {
    return (
      <div className="flex flex-col items-center justify-center leading-none">
        <BrandMark size={compact ? 28 : 40} />
      </div>
    );
  }
  const top = brand.wordmarkTop || (brand.shortName || brand.displayName || "").toUpperCase();
  const sub = brand.wordmarkSub;
  return (
    <div className="flex flex-col items-center justify-center gap-0.5 leading-none">
      <BrandMark size={compact ? 28 : 40} />
      {top && <span className="font-extrabold tracking-tight" style={{ color: BRAND_BLUE, fontSize: compact ? 10 : 14, fontFamily: "'Lora', serif" }}>{top}</span>}
      {sub && <span className="font-bold tracking-[0.2em]" style={{ color: BRAND_NAVY, fontSize: compact ? 7 : 10, fontFamily: "'Lora', serif" }}>{sub}</span>}
    </div>
  );
}
