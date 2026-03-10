"use client";

import { ShieldCheck, Clock, Warning } from "@phosphor-icons/react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

interface OrderPreviewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  order: {
    side: "buy" | "sell";
    outcome: string;
    type: "market" | "limit";
    amount: string;
    price: string;
    cost: string;
    fee: string;
    total: string;
    worstCasePrice?: string;
    timeInForce: string;
  };
}

export function OrderPreview({
  open,
  onOpenChange,
  onConfirm,
  order,
}: OrderPreviewProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Confirm Order</DialogTitle>
          <DialogDescription>
            Review your order details before submitting.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* Order details */}
          <div className="rounded border border-border bg-card/30 p-3 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Side</span>
              <span
                className={cn(
                  "font-medium",
                  order.side === "buy" ? "text-yes" : "text-no"
                )}
              >
                {order.side === "buy" ? "Buy" : "Sell"} {order.outcome}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Type</span>
              <span className="capitalize">{order.type}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Shares</span>
              <span className="font-mono">{order.amount}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Price</span>
              <span className="font-mono">{order.price}%</span>
            </div>
            {order.worstCasePrice && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Worst-case price</span>
                <span className="font-mono">{order.worstCasePrice}%</span>
              </div>
            )}
          </div>

          <Separator />

          {/* Fees */}
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Subtotal</span>
              <span className="font-mono">${order.cost}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Fee (1%)</span>
              <span className="font-mono">${order.fee}</span>
            </div>
            <div className="flex justify-between font-medium">
              <span>Total</span>
              <span className="font-mono">${order.total}</span>
            </div>
          </div>

          {/* Info badges */}
          <div className="flex flex-wrap gap-2 text-xs">
            <div className="flex items-center gap-1 rounded border border-border bg-card/30 font-mono tracking-wider text-[10px] px-2 py-1">
              <Clock className="h-3 w-3" weight="fill" />
              {order.timeInForce}
            </div>
            <div className="flex items-center gap-1 rounded border border-border bg-card/30 font-mono tracking-wider text-[10px] px-2 py-1">
              <ShieldCheck className="h-3 w-3" weight="fill" />
              Individual settlement
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={order.side === "buy" ? "yes" : "no"}
            onClick={onConfirm}
          >
            Confirm {order.side === "buy" ? "Buy" : "Sell"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
