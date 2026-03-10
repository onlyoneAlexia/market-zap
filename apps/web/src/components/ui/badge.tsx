import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-bold tracking-wider transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 font-mono",
  {
    variants: {
      variant: {
        default:
          "border-primary/30 bg-primary/10 text-primary",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive/15 text-destructive",
        outline: "text-foreground border-border",
        yes: "border-yes/20 bg-yes/10 text-yes",
        no: "border-no/20 bg-no/10 text-no",
        crypto: "border-orange-400/20 bg-orange-400/10 text-orange-400",
        politics: "border-blue-400/20 bg-blue-400/10 text-blue-400",
        sports: "border-emerald-400/20 bg-emerald-400/10 text-emerald-400",
        culture: "border-purple-400/20 bg-purple-400/10 text-purple-400",
        science: "border-cyan-400/20 bg-cyan-400/10 text-cyan-400",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
