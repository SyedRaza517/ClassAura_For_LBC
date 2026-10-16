import { ATT, toneVars } from "./tokens";

// Stacked attendance bar. Segments are separated by a 2px gap and each carries its
// own count + letter, so the four states never rely on colour alone to be told apart.
export function StatusBar({ counts }) {
  const total = ATT.reduce((n, a) => n + (counts[a.key] || 0), 0);
  if (!total) return <div className="h-2.5 rounded-full bg-slate-100 dark:bg-slate-700" />;
  return (
    <>
      <div className="flex h-2.5 gap-[2px] overflow-hidden">
        {ATT.map(a => {
          const v = counts[a.key] || 0;
          if (!v) return null;
          // A solid fill, unchanged in both schemes — this bar is decorative, not
          // text, and the four status colours (checked colour-blind-safe, see
          // tokens.js) read fine on either card without an AA-nudged pair.
          return <div key={a.key} className="h-full first:rounded-l-full last:rounded-r-full" style={{ width: `${(v / total) * 100}%`, background: a.colour, minWidth: 3 }} title={`${a.label}: ${v}`} />;
        })}
      </div>
      {/* min-w-0 + truncate on the label, because a grid item defaults to
          `min-width: auto` and so cannot be narrower than its own longest word. Four
          across inside the Attendance screen's p-5 panel leaves 57px a cell at 320px,
          which "Excused" at 9px just fits — but the margin is a few pixels, and under
          200% OS text zoom these four legends would widen the panel and with it the
          page. Truncating is the right failure here rather than wrapping: the figure
          above each label is the thing being read, the word underneath is a legend for
          it, and the stacked bar immediately above already carries the same four states
          as colour plus a title attribute. */}
      <div className="mt-2.5 grid grid-cols-4 gap-1.5">
        {ATT.map(a => (
          <div key={a.key} className="tone-soft min-w-0 rounded-xl py-1.5 text-center" style={toneVars(a.tone)}>
            <p className="tone-text text-sm font-extrabold tabular-nums" style={toneVars(a.tone)}>{counts[a.key] ?? 0}</p>
            <p className="truncate text-[9px] font-semibold text-slate-500 dark:text-slate-400">{a.label}</p>
          </div>
        ))}
      </div>
    </>
  );
}
export default StatusBar;
