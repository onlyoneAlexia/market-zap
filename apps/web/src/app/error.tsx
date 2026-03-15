"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Auto-recover from ChunkLoadError by doing a full page reload.
    // This happens when the dev server restarts and generates new chunk hashes
    // while the browser's SPA cache still references old ones.
    if (error.name === "ChunkLoadError" || error.message?.includes("Loading chunk")) {
      window.location.reload();
    }
  }, [error]);

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 px-4">
      <h2 className="text-lg font-mono font-bold text-foreground">Something went wrong</h2>
      <p className="text-sm text-muted-foreground font-mono max-w-md text-center">
        {error.message || "An unexpected error occurred."}
      </p>
      <Button onClick={() => reset()} variant="outline" size="sm">
        Try again
      </Button>
    </div>
  );
}
