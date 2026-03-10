"use client";

import { useState } from "react";
import { ArrowUpRight, Percent } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Card, CardContent } from "@/components/ui/card";
import { TradePanel } from "./trade-panel";

type TradePanelProps = React.ComponentProps<typeof TradePanel>;

function formatPrice(price: number | undefined): string {
  if (typeof price !== "number" || Number.isNaN(price)) {
    return "--";
  }

  return `${(price * 100).toFixed(0)}%`;
}

export function MobileTradeSheet(props: TradePanelProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="lg:hidden">
      <Card className="border-primary/15 bg-card/50 backdrop-blur-xl">
        <CardContent className="flex flex-col gap-3 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-heading text-[11px] font-bold tracking-[0.18em] text-muted-foreground">
                Trade this market
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Open the trade ticket without leaving the market view.
              </p>
            </div>
            <Percent className="mt-0.5 h-4.5 w-4.5 text-primary" weight="bold" />
          </div>

          <div className="grid grid-cols-2 gap-2 rounded border bg-background/60 backdrop-blur-sm p-2 text-xs">
            <div className="rounded bg-yes/10 border border-yes/10 px-3 py-2">
              <div className="text-[10px] font-mono font-bold tracking-wider text-yes">
                {props.outcomes[0] ?? "Yes"}
              </div>
              <div className="mt-1 font-mono text-sm font-semibold text-foreground">
                {formatPrice(props.prices[0])}
              </div>
            </div>
            <div className="rounded bg-no/10 border border-no/10 px-3 py-2">
              <div className="text-[10px] font-mono font-bold tracking-wider text-no">
                {props.outcomes[1] ?? "No"}
              </div>
              <div className="mt-1 font-mono text-sm font-semibold text-foreground">
                {formatPrice(props.prices[1])}
              </div>
            </div>
          </div>

          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button className="h-11 w-full justify-center gap-2 font-mono tracking-wider">
                Open trade ticket
                <ArrowUpRight className="h-4.5 w-4.5" weight="bold" />
              </Button>
            </DialogTrigger>
            <DialogContent className="left-0 right-0 top-auto z-50 max-h-[88vh] w-full max-w-none translate-x-0 translate-y-0 gap-0 rounded-t-3xl border-x-0 border-b-0 p-0 data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom sm:left-1/2 sm:right-auto sm:top-[50%] sm:max-h-[90vh] sm:w-full sm:max-w-2xl sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-2xl sm:border sm:p-0 sm:data-[state=closed]:slide-out-to-left-1/2 sm:data-[state=closed]:slide-out-to-top-[48%] sm:data-[state=open]:slide-in-from-left-1/2 sm:data-[state=open]:slide-in-from-top-[48%]">
              <DialogHeader className="border-b px-4 pb-4 pt-5 text-left">
                <DialogTitle className="text-sm font-mono font-bold tracking-wider">Trade this market</DialogTitle>
                <DialogDescription>
                  Review pricing, choose an outcome, and submit your order.
                </DialogDescription>
              </DialogHeader>
              <div className="overflow-y-auto p-4">
                <TradePanel {...props} />
              </div>
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>
    </div>
  );
}
