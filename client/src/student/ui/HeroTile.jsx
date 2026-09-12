import Ring from "./Ring";
import { ChevronRight } from "lucide-react";
import { toneVars } from "./tokens";

// The two headline figures. A tinted panel behind the ring ties the number to its
// band at a glance, before the number itself is even read. `tone` is now the whole
// attendanceTone()/gradeTone() shape (light + dark pair already computed) rather than
// a bare colour string, so this component never has to invent its own dark-mode value.
export function HeroTile({ onClick, pct, label, tone, foot, i }) {
  return (
    <button onClick={onClick} className="tone-panel press fade-up rounded-3xl p-4 shadow-card ring-1"
      style={{ ...toneVars(tone), animationDelay: `${i * 70}ms` }}>
      <div className="flex flex-col items-center">
        <Ring pct={pct} size={112} stroke={11} tone={tone} />
        <p className="tone-text mt-2.5 text-[11px] font-extrabold uppercase tracking-widest" style={toneVars(tone)}>{label}</p>
        <p className="mt-0.5 flex items-center gap-0.5 text-[11px] font-semibold text-slate-500 dark:text-slate-400">{foot}<ChevronRight size={12} className="text-slate-400 dark:text-slate-500" /></p>
      </div>
    </button>
  );
}
export default HeroTile;
