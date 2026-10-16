import { toneFromColour, toneVars } from "./tokens";

// `colour` is a bare hex (Home.jsx passes ACCENT-adjacent literals). Resolved through
// toneFromColour so the icon chip's tint stays AA-legible on a dark card the same way
// every band/grade/status colour in this app now does — `.tone-soft` sets the icon's
// `color` too, which the lucide glyph below picks up via currentColor rather than a
// second, hand-repeated colour prop.
export function Stat({ icon: Icon, value, label, colour, i = 0 }) {
  const tone = toneFromColour(colour);
  return (
    // min-w-0 because this renders three-across (Home's `grid-cols-3`) and a grid item
    // defaults to `min-width: auto` — it will not go narrower than its widest word plus
    // its padding, whatever the track says. At 320px each cell is 89px and today's
    // longest content ("Sessions", and a four-figure count) still fits, so this is not
    // fixing a visible break; it is making sure one cannot appear. The realistic
    // trigger is 200% OS text zoom, where every figure and label grows but the three
    // tracks do not, and the row would otherwise widen the whole screen rather than
    // letting the cells crowd.
    <div className="fade-up min-w-0 rounded-2xl bg-white p-3 text-center shadow-card ring-1 ring-slate-200/60 dark:bg-slate-800 dark:ring-slate-700/60" style={{ animationDelay: `${140 + i * 45}ms` }}>
      <span className="tone-soft mx-auto flex h-7 w-7 items-center justify-center rounded-xl" style={toneVars(tone)}><Icon size={14} /></span>
      <p className="mt-1.5 text-[19px] font-extrabold leading-none tabular-nums text-slate-800 dark:text-slate-100">{value}</p>
      <p className="mt-1 text-[10px] font-semibold text-slate-400 dark:text-slate-500">{label}</p>
    </div>
  );
}
export default Stat;
