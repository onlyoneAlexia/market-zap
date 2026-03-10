"use client";

import { cn } from "@/lib/utils";

interface PnlCardProps {
  label: string;
  value: string;
  change?: number;
  icon: React.ElementType;
}

export function PnlCard({ label, value, change }: PnlCardProps) {
  return (
    <div className="rounded border bg-card/30 backdrop-blur-sm p-4">
      <div className="text-[10px] font-mono font-bold tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="font-mono text-lg font-bold">{value}</span>
        {change !== undefined && (
          <span
            className={cn(
              "text-xs font-medium",
              change >= 0 ? "text-yes" : "text-no"
            )}
          >
            {change >= 0 ? "+" : ""}
            {change.toFixed(1)}%
          </span>
        )}
      </div>
    </div>
  );
}
