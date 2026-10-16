import Ring from "./Ring";
import { ChevronRight } from "lucide-react";
import { toneVars } from "./tokens";

// The two headline figures. A tinted panel behind the ring ties the number to its
// band at a glance, before the number itself is even read. `tone` is now the whole
// attendanceTone()/gradeTone() shape (light + dark pair already computed) rather than
// a bare colour string, so this component never has to invent its own dark-mode value.
export function HeroTile({ onClick, pct, label, tone, foot, i }) {
  return (
    // min-w-0: this is a grid item (Home's `grid-cols-2`), and a grid item defaults to
    // `min-width: auto`, which means it refuses to be narrower than its own content
    // however small the track is — the archetypal small-phone overflow in this codebase.
    // Ring now carries a `max-width: 100%` of its own, but a percentage max-width is
    // ignored while the browser is working out intrinsic contributions, so without this
    // the 112px ring still sized the tile and the cap never came into play. The pair is
    // what makes the tile honour its track at 320px; neither half works alone.
    <button onClick={onClick} className="tone-panel press fade-up min-w-0 rounded-3xl p-4 shadow-card ring-1"
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
