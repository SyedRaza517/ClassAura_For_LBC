// A shaped placeholder beats a lone spinner: the screen keeps its layout while it
// loads, so nothing jumps around when the data lands.
export const Skeleton = ({ className = "" }) => <div className={`skeleton rounded-3xl ${className}`} />;
export default Skeleton;
