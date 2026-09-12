import Ring from "./Ring";
import { ChevronRight } from "lucide-react";

// The two headline figures. A tinted panel behind the ring ties the number to its
// band at a glance, before the number itself is even read.
export function HeroTile({ onClick, pct, label, tone, foot, i }) {
  return (
    <button onClick={onClick} className="press fade-up rounded-3xl p-4 shadow-card ring-1"
      style={{ background: tone.soft, "--tw-ring-color": tone.colour + "2e", animationDelay: `${i * 70}ms` }}>
      <div className="flex flex-col items-center">
        <Ring pct={pct} size={112} stroke={11} colour={tone.colour} />
        <p className="mt-2.5 text-[11px] font-extrabold uppercase tracking-widest" style={{ color: tone.colour }}>{label}</p>
        <p className="mt-0.5 flex items-center gap-0.5 text-[11px] font-semibold text-slate-500">{foot}<ChevronRight size={12} className="text-slate-400" /></p>
      </div>
    </button>
  );
}
export default HeroTile;
