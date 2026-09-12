export function Stat({ icon: Icon, value, label, colour, i = 0 }) {
  return (
    <div className="fade-up rounded-2xl bg-white p-3 text-center shadow-card ring-1 ring-slate-200/60" style={{ animationDelay: `${140 + i * 45}ms` }}>
      <span className="mx-auto flex h-7 w-7 items-center justify-center rounded-xl" style={{ background: colour + "14" }}><Icon size={14} style={{ color: colour }} /></span>
      <p className="mt-1.5 text-[19px] font-extrabold leading-none tabular-nums text-slate-800">{value}</p>
      <p className="mt-1 text-[10px] font-semibold text-slate-400">{label}</p>
    </div>
  );
}
export default Stat;
