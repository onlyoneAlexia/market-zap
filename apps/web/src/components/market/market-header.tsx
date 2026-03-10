"use client";

import { TrendUp, Users } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Countdown } from "./countdown";

interface MarketHeaderProps {
  question: string;
  category: string;
  volume: string;
  traders?: number;
  /** Unix timestamp in seconds */
  endsAt: number;
  resolved: boolean;
  voided: boolean;
}

const categoryVariant: Record<string, "crypto" | "politics" | "sports" | "culture" | "science"> = {
  crypto: "crypto",
  politics: "politics",
  sports: "sports",
  culture: "culture",
  science: "science",
};

export function MarketHeader({
  question,
  category,
  volume,
  traders,
  endsAt,
  resolved,
  voided,
}: MarketHeaderProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Badge variant={categoryVariant[category] ?? "secondary"}>
          {category}
        </Badge>
        {resolved && <Badge variant="yes">Resolved</Badge>}
        {voided && <Badge variant="destructive">Voided</Badge>}
      </div>

      <h1 className="font-heading text-xl font-bold leading-tight tracking-wider sm:text-2xl">
        {question}
      </h1>

      <div className="flex flex-wrap items-center gap-4 text-[10px] font-mono tracking-wider text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <TrendUp className="h-3.5 w-3.5" weight="duotone" />
          <span className="font-bold text-primary">{volume}</span>
          <span>vol</span>
        </div>
        {traders !== undefined && (
          <div className="flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5" weight="duotone" />
            <span>{traders} trdrs</span>
          </div>
        )}
        {resolved || voided ? (
          <span className="font-medium text-muted-foreground">
            {voided ? "Market voided" : "Market resolved"}
          </span>
        ) : (
          <div className="flex items-center gap-1.5">
            <Countdown endsAt={endsAt} />
          </div>
        )}
      </div>

      <Separator />
    </div>
  );
}
