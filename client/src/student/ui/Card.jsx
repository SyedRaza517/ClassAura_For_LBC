// Rounder corners and layered shadows read as physical cards rather than boxes.
// `i` staggers a list's entrance so rows arrive one after another.
export const Card = ({ children, className = "", i }) => (
  <div className={`fade-up rounded-3xl bg-white p-4 shadow-card ring-1 ring-slate-200/60 ${className}`} style={i != null ? { animationDelay: `${i * 55}ms` } : undefined}>{children}</div>
);
export default Card;
