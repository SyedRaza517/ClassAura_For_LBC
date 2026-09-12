import { ATT } from "./tokens";

// Stacked attendance bar. Segments are separated by a 2px gap and each carries its
// own count + letter, so the four states never rely on colour alone to be told apart.
export function StatusBar({ counts }) {
  const total = ATT.reduce((n, a) => n + (counts[a.key] || 0), 0);
  if (!total) return <div className="h-2.5 rounded-full bg-slate-100" />;
  return (
    <>
      <div className="flex h-2.5 gap-[2px] overflow-hidden">
        {ATT.map(a => {
          const v = counts[a.key] || 0;
          if (!v) return null;
          return <div key={a.key} className="h-full first:rounded-l-full last:rounded-r-full" style={{ width: `${(v / total) * 100}%`, background: a.colour, minWidth: 3 }} title={`${a.label}: ${v}`} />;
        })}
      </div>
      <div className="mt-2.5 grid grid-cols-4 gap-1.5">
        {ATT.map(a => (
          <div key={a.key} className="rounded-xl py-1.5 text-center" style={{ background: a.colour + "12" }}>
            <p className="text-sm font-extrabold tabular-nums" style={{ color: a.colour }}>{counts[a.key] ?? 0}</p>
            <p className="text-[9px] font-semibold text-slate-500">{a.label}</p>
          </div>
        ))}
      </div>
    </>
  );
}
export default StatusBar;
