import { pctTone } from "./tokens";
import useCountUp from "./useCountUp";

// The headline percentage, as a ring with the number inside it.
export function Ring({ pct, size = 132, stroke = 13, label, colour }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const tone = colour || pctTone(pct).colour;
  const shown = useCountUp(pct ?? 0);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} className="h-full w-full -rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(15,23,42,.08)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - (pct ?? 0) / 100)}
          style={{ transition: "stroke-dashoffset 1.1s cubic-bezier(.4,0,.2,1)" }}
        />
      </svg>
      <div className="scale-in absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[27px] font-extrabold leading-none tracking-tight tabular-nums" style={{ color: tone }}>{pct == null ? "—" : `${Math.round(shown)}%`}</span>
        {label && <span className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</span>}
      </div>
    </div>
  );
}
export default Ring;
