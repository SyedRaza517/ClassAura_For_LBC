export function Action({ onClick, Icon, label, sub, c, badge, i = 0 }) {
  return (
    <button onClick={onClick} className="press fade-up relative flex flex-col items-start gap-2.5 rounded-3xl p-4 text-left shadow-card ring-1"
      style={{ background: c + "12", "--tw-ring-color": c + "2e", animationDelay: `${300 + i * 55}ms` }}>
      <span className="relative flex h-11 w-11 items-center justify-center rounded-2xl text-white shadow-md" style={{ background: c }}>
        <Icon size={19} />
        {badge > 0 && <span className="pop absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-400 px-1 text-[10px] font-extrabold text-slate-900 ring-2 ring-white">{badge}</span>}
      </span>
      <span>
        <span className="block text-[13px] font-extrabold leading-tight" style={{ color: c }}>{label}</span>
        <span className={`mt-0.5 block text-[11px] ${badge > 0 ? "font-bold text-amber-600" : "text-slate-500"}`}>{sub}</span>
      </span>
    </button>
  );
}
export default Action;
