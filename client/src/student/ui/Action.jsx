import { toneFromColour, toneVars } from "./tokens";

// `c` is one of the fixed ACCENT section colours. Resolved through toneFromColour like
// every other dynamic colour in this app now is: the button's own tint+text (`.tone-soft`)
// and the icon square's solid fill (`.tone-solid`) both read AA-legible on a dark card.
export function Action({ onClick, Icon, label, sub, c, badge, i = 0 }) {
  const tone = toneFromColour(c);
  return (
    // min-w-0 for the same reason HeroTile and Stat now carry it: these render two
    // across in Home's Quick-actions grid, and a grid item will not shrink below its
    // own content while `min-width: auto` stands. Today's longest label ("Ask the
    // College") still fits the 138px a cell gets at 320px, so this is pre-emptive — but
    // `sub` is built from live state ("3 new replies", "Next at 18:00", whatever
    // checkInSub returns next) and the cell is the one place a longer phrase would show
    // up as a sideways scroll of the whole screen rather than as a tighter tile.
    <button onClick={onClick} className="tone-soft press fade-up relative flex min-w-0 flex-col items-start gap-2.5 rounded-3xl p-4 text-left shadow-card ring-1"
      style={{ ...toneVars(tone), animationDelay: `${300 + i * 55}ms` }}>
      <span className="tone-solid relative flex h-11 w-11 items-center justify-center rounded-2xl shadow-md" style={toneVars(tone)}>
        <Icon size={19} />
        {badge > 0 && <span className="pop absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-400 px-1 text-[10px] font-extrabold text-slate-900 ring-2 ring-white dark:ring-slate-800">{badge}</span>}
      </span>
      <span>
        <span className="tone-text block text-[13px] font-extrabold leading-tight" style={toneVars(tone)}>{label}</span>
        <span className={`mt-0.5 block text-[11px] ${badge > 0 ? "font-bold text-amber-600 dark:text-amber-400" : "text-slate-500 dark:text-slate-400"}`}>{sub}</span>
      </span>
    </button>
  );
}
export default Action;
