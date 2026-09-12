import useCountUp from "./useCountUp";
import { MOTION_MS, toneVars, toneFromColour } from "./tokens";

const NEUTRAL_TONE = toneFromColour(null);

// The headline percentage, as a ring with the number inside it. Takes the WHOLE tone
// object (attendanceTone/gradeTone's return shape) rather than a bare colour string —
// Ring only draws, it does not decide what a percentage means, and a bare-colour prop
// was the seam through which the old internal `pctTone(pct)` fallback used to draw the
// fixed 90/75/60 scale for a figure the caller had already re-graded against the
// college's own bands (or the separate grade ladder). Every call site now resolves its
// own tone and hands the whole thing over, so there is nowhere left for a second scale
// to sneak back in.
export function Ring({ pct, size = 132, stroke = 13, label, tone = NEUTRAL_TONE }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const shown = useCountUp(pct ?? 0);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} className="h-full w-full -rotate-90">
        {/* currentColor + a text-* pair (rather than a fixed rgba) so the unfilled
            track is still visible against a dark card — 8% black is close to
            invisible on slate-800. */}
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} className="text-slate-900/[.08] dark:text-white/10" />
        {/* The filled arc is decorative, not text, so it keeps the college's own
            saturated colour unchanged in both schemes rather than the AA-nudged
            `tone.text` — a stroke this wide reads fine on either card surface at the
            colours the default and typical custom bands actually use. */}
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone.colour} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - (pct ?? 0) / 100)}
          style={{ transition: `stroke-dashoffset ${MOTION_MS.ringFill}ms cubic-bezier(.4,0,.2,1)` }}
        />
      </svg>
      <div className="scale-in absolute inset-0 flex flex-col items-center justify-center">
        <span className="tone-text text-[27px] font-extrabold leading-none tracking-tight tabular-nums" style={toneVars(tone)}>{pct == null ? "—" : `${Math.round(shown)}%`}</span>
        {label && <span className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">{label}</span>}
      </div>
    </div>
  );
}
export default Ring;
