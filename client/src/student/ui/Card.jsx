// Rounder corners and layered shadows read as physical cards rather than boxes.
// `i` staggers a list's entrance so rows arrive one after another.
// dark:bg-slate-800 is the ONE card surface every dark-mode AA number in ui/tokens.js
// (toneFromColour's DARK_SURFACE) is computed against — change this colour and the
// contrast maths there stops being true.
export const Card = ({ children, className = "", i }) => (
  <div className={`fade-up rounded-3xl bg-white p-4 shadow-card ring-1 ring-slate-200/60 dark:bg-slate-800 dark:ring-slate-700/60 ${className}`} style={i != null ? { animationDelay: `${i * 55}ms` } : undefined}>{children}</div>
);
export default Card;
