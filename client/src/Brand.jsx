// EdTech brand mark — the fanlight emblem plus the wordmark,
// recreated as SVG so every logo in the app is one shared, resolution-independent
// component. The emblem is a solid royal-blue semicircle with a white fanlight:
// an outer ring, a central hub and radial spokes.
export const BRAND_BLUE = "#1e40af";   // the emblem's royal blue
export const BRAND_NAVY = "#1a3a8f";   // deep navy, used in the wordmark
export const BRAND_MAROON = "#9e1b32"; // kept for backwards compatibility

// The emblem alone. By default: a filled blue semicircle with white fanlight lines
// (for light backgrounds). Pass `mono` to draw the fanlight as a single-colour outline
// instead — e.g. a white mark on a coloured header.
export function BrandMark({ size = 40, className = "", mono = null }) {
  const cx = 50, by = 52, R = 46, rO = 39.5, rI = 13.5, N = 6;
  // N spokes evenly divide the half-circle into N+1 segments (a narrow central wedge).
  const angles = Array.from({ length: N }, (_, i) => ((i + 1) * 180) / (N + 1));
  const pt = (r, deg) => { const a = (deg * Math.PI) / 180; return [+(cx + r * Math.cos(a)).toFixed(2), +(by - r * Math.sin(a)).toFixed(2)]; };
  const arc = (r) => `M${cx - r},${by} A${r},${r} 0 0 1 ${cx + r},${by}`;
  const svgProps = { viewBox: "0 0 100 58", width: size, height: size * 0.58, className, role: "img", "aria-label": "EdTech" };

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
  return (
    <div className="flex flex-col items-center justify-center gap-0.5 leading-none">
      <BrandMark size={compact ? 28 : 40} />
      <span className="font-extrabold tracking-tight" style={{ color: BRAND_BLUE, fontSize: compact ? 10 : 14, fontFamily: "'Lora', serif" }}>EDTECH</span>
      <span className="font-bold tracking-[0.2em]" style={{ color: BRAND_NAVY, fontSize: compact ? 7 : 10, fontFamily: "'Lora', serif" }}>HUB</span>
    </div>
  );
}
