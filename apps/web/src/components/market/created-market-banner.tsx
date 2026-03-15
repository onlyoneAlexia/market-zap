"use client";

import Link from "next/link";
import { useMemo } from "react";
import { CheckCircle, CopySimple, LinkSimple } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

interface CreatedMarketBannerProps {
  marketId: string;
  isPrivate: boolean;
}

export function CreatedMarketBanner({
  marketId,
  isPrivate,
}: CreatedMarketBannerProps) {
  const { toast } = useToast();
  const sharePath = `/markets/${marketId}`;
  const shareUrl = useMemo(() => {
    if (typeof window === "undefined") {
      return sharePath;
    }

    return `${window.location.origin}${sharePath}`;
  }, [sharePath]);

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast({
        title: "Tester link copied",
        description: shareUrl,
        variant: "success",
      });
    } catch {
      toast({
        title: "Could not copy link",
        description: "Clipboard access was blocked. Copy the link from the address bar instead.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="mb-4 rounded border border-yes/20 bg-yes/5 px-4 py-3 text-[11px] font-mono">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-yes">
            <CheckCircle className="h-4 w-4" weight="duotone" />
            <span className="font-bold tracking-wider">Market created on Sepolia</span>
          </div>
          <p className="text-muted-foreground">
            {isPrivate
              ? "This dark market is hidden from browse and search. Share the direct link with testers."
              : "Your market is pending admin approval. Once approved, it will appear in the marketplace."}
          </p>
          <div className="flex items-center gap-1.5 text-[10px] text-primary">
            <LinkSimple className="h-3.5 w-3.5" weight="duotone" />
            <span className="truncate">{sharePath}</span>
          </div>
        </div>

        <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
          <Button type="button" size="sm" variant="outline" className="gap-1.5 font-mono" onClick={handleCopyLink}>
            <CopySimple className="h-4 w-4" weight="bold" />
            Copy link
          </Button>
          <Button asChild type="button" size="sm" className="font-mono">
            <Link href="/markets">Markets</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
