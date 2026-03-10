"use client";

import React from "react";
import { Download } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { usePwaInstall } from "./pwa-provider";

export function PwaInstallButton() {
  const { isInstallAvailable, isInstalled, install } = usePwaInstall();

  if (!isInstallAvailable || isInstalled) {
    return null;
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="gap-1.5 font-mono tracking-wider text-[10px]"
      onClick={() => {
        void install();
      }}
    >
      <Download className="h-4 w-4" weight="bold" />
      <span className="hidden sm:inline">Install App</span>
      <span className="sm:hidden">Install</span>
    </Button>
  );
}
