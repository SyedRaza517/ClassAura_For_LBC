export function Empty({ icon: Icon, title, msg }) {
  return (
    <div className="px-4 py-8 text-center">
      <span className="mx-auto mb-2 flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-100 dark:bg-slate-700"><Icon size={19} className="text-slate-400 dark:text-slate-400" /></span>
      <p className="text-[13px] font-bold text-slate-600 dark:text-slate-300">{title}</p>
      <p className="mx-auto mt-1 max-w-[15rem] text-[11px] leading-relaxed text-slate-400 dark:text-slate-500">{msg}</p>
    </div>
  );
}
export default Empty;
