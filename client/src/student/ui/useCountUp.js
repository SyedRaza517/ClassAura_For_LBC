import { useState, useEffect, useRef } from "react";

// Counts a number up when it first appears. Small touch, but it makes the headline
// figures feel alive rather than static text.
export default function useCountUp(target, ms = 700) {
  const [n, setN] = useState(0);
  const raf = useRef();
  useEffect(() => {
    const to = Number(target);
    if (!Number.isFinite(to)) { setN(0); return; }
    const start = performance.now();
    const tick = (t) => {
      const k = Math.min(1, (t - start) / ms);
      // ease-out so it decelerates into the final value
      setN(Math.round(to * (1 - Math.pow(1 - k, 3)) * 10) / 10);
      if (k < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, ms]);
  return n;
}
