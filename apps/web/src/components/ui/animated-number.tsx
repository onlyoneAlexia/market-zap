"use client";

import { useEffect, useRef } from "react";
import { useSpring, useMotionValue, motion, useTransform } from "framer-motion";

interface AnimatedNumberProps {
  value: number;
  /** Format function applied to the animated value for display */
  format?: (n: number) => string;
  className?: string;
}

/**
 * Spring-animated number that counts from 0 (or previous value) to target.
 * Useful for stats, P&L, volume counters.
 */
export function AnimatedNumber({
  value,
  format = (n) => n.toFixed(0),
  className,
}: AnimatedNumberProps) {
  const motionValue = useMotionValue(0);
  const springValue = useSpring(motionValue, {
    stiffness: 100,
    damping: 20,
    mass: 0.5,
  });
  const display = useTransform(springValue, (v) => format(v));
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    motionValue.set(value);
  }, [value, motionValue]);

  // Sync the display transform to DOM for smooth rendering
  useEffect(() => {
    const unsubscribe = display.on("change", (v) => {
      if (ref.current) {
        ref.current.textContent = v;
      }
    });
    return unsubscribe;
  }, [display]);

  return <span ref={ref} className={className}>{format(value)}</span>;
}
