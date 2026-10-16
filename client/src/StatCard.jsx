// The KPI tile every admin dashboard opens with.
//
// EXTRACTED FROM StaffHub.jsx rather than copied. AssessmentTracker is imported BY
// StaffHub, so importing StatCard back out of it would be a circular dependency; and a
// second copy of a tile this recognisable is the kind of duplication that drifts one
// pixel at a time until two dashboards no longer look like the same product.
//
// A STAT TILE IS THE RIGHT FORM HERE, and that is a decision rather than a default: a
// single headline figure with no comparison and no series has nothing for a chart to
// plot. A four-tile row answers "how big, how far, how bad" at a glance; the table
// underneath is where the detail lives.
import React, { useState, useEffect } from "react";
import { alpha, NAVY } from "./branding";

// A tile's accent, as a gradient. Kept here beside its only consumer.
export const grad = (c) => `linear-gradient(135deg, ${c}, ${alpha(c, 80)})`;

// Count a number up on first render. Cubic ease-out, cancelled on unmount so a tile
// that disappears mid-animation cannot go on scheduling frames.
export function useCountUp(target, dur = 700) {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf; const start = performance.now();
    const tick = (t) => { const p = Math.min(1, (t - start) / dur); setV(Math.round(target * (1 - Math.pow(1 - p, 3)))); if (p < 1) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
  }, [target, dur]);
  return v;
}

export default function StatCard({ label, value, sub, Icon, tone = NAVY, delay = 0, animate, trend }) {
  // Only count-up real numbers. Some cards pass a formatted string ("28d", "85%"),
  // and animating that multiplied a string by a number → NaN, which rendered
  // literally as "NaN". Strings (and non-finite numbers) now render as-is.
  const canAnimate = animate && typeof value === "number" && Number.isFinite(value);
  const av = useCountUp(canAnimate ? value : 0);
  // Optional trend chip: { up: bool, text: "+12", tone?: "#..." }. Up is green, down rose.
  const tc = trend ? (trend.tone || (trend.up ? "#059669" : "#e11d48")) : null;
  return (
    <div className="hover-lift group relative overflow-hidden rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200/70 transition-all duration-300 hover:-translate-y-1 hover:shadow-xl hover:ring-slate-300/80 fade-up" style={{ animationDelay: `${delay}ms` }}>
      <div className="absolute inset-x-0 top-0 h-1" style={{ background: grad(tone) }} />
      <div className="absolute -right-6 -top-6 h-24 w-24 rounded-full opacity-60 transition-transform duration-500 group-hover:scale-150" style={{ background: tone + "12" }} />
      {/* min-w-0 on the text column, shrink-0 on the icon, break-words on the label.
          This is the same defect that spilled the attendance tiles out of their card in
          AdminLiveAttendance.jsx, and it is here for the same reason: a flex child's
          min-width defaults to `auto`, which means it refuses to shrink below its own
          min-content width — the longest single word of the label. A tile is normally one
          of four across a dashboard, so on a 320px phone it has around 150px to live in,
          and 40px of p-5 plus a 44px icon leaves the label about 65px. "BALANCES" or
          "SUBMISSIONS" set at uppercase text-xs is wider than that, so the column held
          itself open, the icon was pushed out of the tile, and the row of tiles pushed
          past the right edge of the card holding them.
          min-w-0 lets the column shrink, break-words lets a long word break rather than
          become a new floor, and shrink-0 keeps the icon its intended size instead of
          being squashed into an oval once the column finally yields. All three are inert
          at any width where the tile already fits, so the dashboard is untouched. */}
      <div className="relative flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
          {/* The value wears the accent colour; the label and sub-line stay in text
              tokens. A figure is identified by the tile it sits in, not by being
              coloured — so nothing here depends on colour alone to be readable. */}
          <p className="mt-1 text-3xl font-extrabold tabular-nums" style={{ color: tone }}>{canAnimate ? av : value}</p>
          {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
          {trend && <span className="mt-1.5 inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-extrabold" style={{ background: tc + "1a", color: tc }}>{trend.up ? "▲" : "▼"} {trend.text}</span>}
        </div>
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-white shadow-md transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-6" style={{ background: grad(tone), boxShadow: `0 8px 18px -6px ${alpha(tone, 50)}` }}><Icon size={22} /></span>
      </div>
    </div>
  );
}
