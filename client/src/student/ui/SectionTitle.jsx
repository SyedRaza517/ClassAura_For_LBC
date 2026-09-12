import { NAVY } from "../../branding";

// A soft section heading — small, wide-tracked, with a short accent rule.
export const SectionTitle = ({ children, colour = NAVY }) => (
  <div className="flex items-center gap-2 px-1 pt-1">
    <span className="h-3.5 w-1 rounded-full" style={{ background: colour }} />
    <p className="text-[11px] font-extrabold uppercase tracking-widest text-slate-500 dark:text-slate-400">{children}</p>
  </div>
);
export default SectionTitle;
