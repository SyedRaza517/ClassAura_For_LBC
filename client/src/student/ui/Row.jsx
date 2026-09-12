import { ChevronRight } from "lucide-react";

export function Row({ Icon, label, sub, onClick, danger, open }) {
  return (
    <button onClick={onClick} className="press flex w-full items-center gap-3 border-t border-slate-100 px-3.5 py-3.5 text-left first:border-t-0 dark:border-slate-700">
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${danger ? "bg-rose-50 dark:bg-rose-950/40" : "bg-slate-100 dark:bg-slate-700"}`}>
        <Icon size={16} className={danger ? "text-rose-500 dark:text-rose-400" : "text-slate-500 dark:text-slate-300"} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block text-[13px] font-bold ${danger ? "text-rose-600 dark:text-rose-400" : "text-slate-700 dark:text-slate-200"}`}>{label}</span>
        <span className="block truncate text-[11px] text-slate-400 dark:text-slate-500">{sub}</span>
      </span>
      <ChevronRight size={16} className={`shrink-0 text-slate-300 transition-transform dark:text-slate-600 ${open ? "rotate-90" : ""}`} />
    </button>
  );
}
export default Row;
