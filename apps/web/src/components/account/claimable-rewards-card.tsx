"use client";

import React from "react";
import { Spinner, CheckCircle } from "@phosphor-icons/react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  useClaimReward,
  useClaimableRewards,
} from "@/hooks/use-portfolio";
import { useToast } from "@/hooks/use-toast";
import { shortenAddress } from "@market-zap/shared";

export function ClaimableRewardsCard() {
  const { data: claimable, isLoading } = useClaimableRewards();
  const claimReward = useClaimReward();
  const { toast } = useToast();

  const handleClaim = (reward: {
    marketId: string;
    outcomeIndex: number;
    market: { collateralToken: string; conditionId?: string };
  }) => {
    const conditionId = reward.market.conditionId;
    const collateralToken = reward.market.collateralToken;

    if (!conditionId) {
      toast({
        title: "Cannot claim",
        description: "This market has no on-chain condition ID.",
        variant: "destructive",
      });
      return;
    }

    claimReward.mutate(
      {
        collateralToken,
        conditionId,
        marketId: reward.marketId,
        outcomeIndex: reward.outcomeIndex,
      },
      {
        onSuccess: (result) => {
          toast({
            title: "Reward claimed!",
            description: `Submitted on-chain: ${shortenAddress(result.txHash)}. The indexer will confirm it in the engine shortly.`,
            variant: "success",
          });
        },
        onError: (error) => {
          toast({
            title: "Claim failed",
            description: error instanceof Error ? error.message : "Something went wrong",
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center py-12">
        {isLoading ? (
          <Spinner className="h-5 w-5 animate-spin text-muted-foreground" weight="bold" />
        ) : claimable && claimable.length > 0 ? (
          <div className="w-full space-y-3">
            {claimable.map((reward) => (
              <div
                key={reward.marketId}
                className="flex items-center justify-between rounded border bg-card/30 backdrop-blur-sm p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {reward.market.question || reward.marketId}
                  </p>
                  <p className="text-[10px] font-mono font-bold tracking-wider text-muted-foreground">
                    Won outcome #{reward.outcomeIndex} &middot; Payout: ${reward.amount}
                  </p>
                </div>
                <Button
                  size="sm"
                  className="ml-3"
                  disabled={claimReward.isPending}
                  onClick={() => handleClaim(reward)}
                >
                  {claimReward.isPending ? (
                    <Spinner className="h-3.5 w-3.5 animate-spin" weight="bold" />
                  ) : (
                    <>
                      <CheckCircle className="mr-1.5 h-3.5 w-3.5" weight="fill" />
                      Claim
                    </>
                  )}
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No claimable rewards at this time
          </p>
        )}
      </CardContent>
    </Card>
  );
}
