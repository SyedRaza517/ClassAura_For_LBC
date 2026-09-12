// Barrel for the student app's UI primitives, so a screen imports one module instead
// of thirteen. Pure re-export — nothing here changes what any of these components do.
// pctTone/progressTone's old three-colour version are gone: attendanceTone is the ONE
// ladder that replaced them (see tokens.js's file-level comment for why), and
// progressTone is rebuilt on top of it rather than removed outright — Reviews.jsx still
// calls it, just with the college's own band list threaded through now.
export { ACCENT, ACCENT_TONE, DEFAULT_ATTENDANCE_BANDS, bandForPct, attendanceTone, gradeTone, progressTone, toneFromColour, toneVars, ATT, MOTION_MS } from "./tokens";
export { default as useCountUp } from "./useCountUp";
export { default as Screen } from "./Screen";
export { default as Card } from "./Card";
export { default as ErrBox } from "./ErrBox";
export { default as Skeleton } from "./Skeleton";
export { default as LoadingScreen } from "./LoadingScreen";
export { default as SectionTitle } from "./SectionTitle";
export { default as Ring } from "./Ring";
export { default as StatusBar } from "./StatusBar";
export { default as Empty } from "./Empty";
export { default as Row } from "./Row";
export { default as Stat } from "./Stat";
export { default as Action } from "./Action";
export { default as HeroTile } from "./HeroTile";
