"use client";

import dynamic from "next/dynamic";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState, type ReactNode } from "react";
import { Toaster } from "@/components/ui/toaster";
import { PwaProvider } from "@/components/layout/pwa-provider";

const AppBootstrap = dynamic(
  () =>
    import("@/components/layout/app-bootstrap").then((mod) => ({
      default: mod.AppBootstrap,
    })),
  {
    ssr: false,
  },
);

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            retry: 2,
          },
        },
      })
  );

  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
      <QueryClientProvider client={queryClient}>
        <PwaProvider>
          <AppBootstrap />
          {children}
          <Toaster />
        </PwaProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
