import type { ReactNode } from "react";

export function PageTransition({ children }: { children: ReactNode }) {
  return <div className="animate-in fade-in duration-100 motion-reduce:duration-0">{children}</div>;
}
