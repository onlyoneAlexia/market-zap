"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

const AnimatedTabs = TabsPrimitive.Root;

const AnimatedTabsList = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "relative inline-flex h-9 items-center justify-center rounded bg-card/30 border border-border p-1 text-muted-foreground backdrop-blur-sm",
      className
    )}
    {...props}
  />
));
AnimatedTabsList.displayName = "AnimatedTabsList";

interface AnimatedTabsTriggerProps
  extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> {
  /** Shared layoutId group — must be the same for all triggers in a TabsList */
  layoutGroup?: string;
  isActive?: boolean;
}

const AnimatedTabsTrigger = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Trigger>,
  AnimatedTabsTriggerProps
>(({ className, layoutGroup = "tab-indicator", isActive, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "relative inline-flex items-center justify-center whitespace-nowrap rounded px-3 py-1 text-[10px] font-mono font-bold tracking-wider ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 z-10",
      isActive && "text-foreground",
      className
    )}
    {...props}
  >
    {isActive && (
      <motion.div
        layoutId={layoutGroup}
        className="absolute inset-0 rounded bg-primary/10 border border-primary/20 shadow-sm"
        transition={{ type: "spring", stiffness: 500, damping: 36 }}
        style={{ zIndex: -1 }}
      />
    )}
    {props.children}
  </TabsPrimitive.Trigger>
));
AnimatedTabsTrigger.displayName = "AnimatedTabsTrigger";

interface AnimatedTabsContentProps
  extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content> {
  /** Unique key for AnimatePresence — should match the value prop */
  contentKey: string;
}

const AnimatedTabsContent = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Content>,
  AnimatedTabsContentProps
>(({ className, contentKey, children, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className
    )}
    {...props}
  >
    <AnimatePresence initial={false}>
      <motion.div
        key={contentKey}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.12, ease: [0.25, 0.1, 0.25, 1] }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  </TabsPrimitive.Content>
));
AnimatedTabsContent.displayName = "AnimatedTabsContent";

export {
  AnimatedTabs,
  AnimatedTabsList,
  AnimatedTabsTrigger,
  AnimatedTabsContent,
};
