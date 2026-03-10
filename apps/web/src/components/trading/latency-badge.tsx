"use client";

import { Pulse } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/hooks/use-store";

export function LatencyBadge() {
  const isConnected = useAppStore((s) => s.wsConnected);
  const color = isConnected ? "text-yes" : "text-muted-foreground";

  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded border border-border bg-card/30 px-2 py-0.5 text-[10px] font-mono tracking-wider",
        color
      )}
      role="status"
      aria-label={isConnected ? "Connected" : "Disconnected"}
    >
      <Pulse className="h-3 w-3" weight="bold" />
      {isConnected ? "Live" : "---"}
    </div>
  );
}
