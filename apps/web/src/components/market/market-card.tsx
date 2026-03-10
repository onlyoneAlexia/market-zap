"use client";

import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { TrendUp, Users, LockKey } from "@phosphor-icons/react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Countdown } from "./countdown";

interface MarketCardProps {
  id: string;
  question: string;
  category: string;
  outcomes: string[];
  prices: number[];
  volume: string;
  /** Unix timestamp in seconds */
  endsAt: number;
  traders?: number;
  marketType?: "public" | "private";
  resolved?: boolean;
  voided?: boolean;
}

const categoryVariant: Record<string, "crypto" | "politics" | "sports" | "culture" | "science"> = {
  crypto: "crypto",
  politics: "politics",
  sports: "sports",
  culture: "culture",
  science: "science",
};

export const MarketCard = React.memo(function MarketCard({
  id,
  question,
  category,
  outcomes,
  prices,
  volume,
  endsAt,
  traders,
  marketType,
  resolved,
  voided,
}: MarketCardProps) {
  const router = useRouter();
  const hasPrefetchedRef = React.useRef(false);
  const yesPrice = prices[0] ?? 0.5;
  const noPrice = prices[1] ?? 0.5;
  const href = `/markets/${id}`;

  const prefetchMarket = () => {
    if (hasPrefetchedRef.current) {
      return;
    }

    hasPrefetchedRef.current = true;
    void router.prefetch(href);
  };

  return (
    <motion.div>
      <Link
        href={href}
        prefetch={false}
        onMouseEnter={prefetchMarket}
        onFocus={prefetchMarket}
        onTouchStart={prefetchMarket}
      >
        <motion.div
          whileHover={{ y: -2, boxShadow: "0 0 30px rgba(255,152,0,0.04)" }}
          transition={{ duration: 0.15, ease: [0.2, 0, 0, 1] }}
        >
          <Card className={`group h-full cursor-pointer overflow-hidden transition-all duration-snappy ease-snappy ${marketType === "private" ? "border-primary/15" : ""}`}>
            <CardContent className="flex h-full flex-col p-4 sm:p-5">
              {/* Header */}
              <div className="mb-3 flex items-start justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant={categoryVariant[category] ?? "secondary"}>
                    {category}
                  </Badge>
                  {marketType === "private" && (
                    <Badge variant="outline" className="gap-1 border-primary/20 bg-primary/10 text-primary">
                      <LockKey className="h-2.5 w-2.5" weight="duotone" />
                      Dark
                    </Badge>
                  )}
                </div>
                {resolved ? (
                  <Badge variant="yes">Resolved</Badge>
                ) : voided ? (
                  <Badge variant="destructive">Voided</Badge>
                ) : (
                  <Countdown endsAt={endsAt} compact className="text-[10px] font-mono" />
                )}
              </div>

              {/* Question */}
              <h3 className="mb-4 font-heading line-clamp-3 min-h-[4.2rem] text-sm font-semibold leading-relaxed tracking-wide transition-colors group-hover:text-primary sm:min-h-[3.8rem] sm:text-[15px]">
                {question}
              </h3>

              {/* Price display — terminal style */}
              <div className="mb-4 flex gap-3">
                <div className="flex-1 rounded bg-yes/5 border border-yes/10 py-2.5 text-center">
                  <div className="font-mono text-xl font-bold text-yes text-glow-green">
                    {(yesPrice * 100).toFixed(0)}%
                  </div>
                  <div className="text-[10px] font-mono text-yes/50 tracking-wider mt-0.5">
                    {outcomes[0] ?? "Yes"}
                  </div>
                </div>
                <div className="flex-1 rounded bg-no/5 border border-no/10 py-2.5 text-center">
                  <div className="font-mono text-xl font-bold text-no text-glow-red">
                    {(noPrice * 100).toFixed(0)}%
                  </div>
                  <div className="text-[10px] font-mono text-no/50 tracking-wider mt-0.5">
                    {outcomes[1] ?? "No"}
                  </div>
                </div>
              </div>

              {/* Stats — terminal data row */}
              <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-mono text-muted-foreground">
                <span>Vol {volume}</span>
                {traders !== undefined && <span>Traders {traders}</span>}
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </Link>
    </motion.div>
  );
});
