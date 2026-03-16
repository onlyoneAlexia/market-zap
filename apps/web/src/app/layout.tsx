import type { Metadata, Viewport } from "next";
import "@/styles/globals.css";
import { Providers } from "@/components/layout/providers";
import { Navbar } from "@/components/layout/navbar";
import { ConnectModalHost } from "@/components/layout/connect-modal-host";
import { Footer } from "@/components/layout/footer";
import { WarpGrid } from "@/components/ui/warp-grid";
import { Space_Grotesk, Outfit, JetBrains_Mono } from "next/font/google";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  display: "swap",
});

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "MarketZap — Prediction Markets on Starknet",
    template: "%s | MarketZap",
  },
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "MarketZap",
  },
  icons: {
    icon: "/icon",
    apple: "/apple-icon",
  },
  description: "Trade on the outcome of real-world events. Fast, fair, and gasless prediction markets powered by Starknet.",
  keywords: ["prediction markets", "starknet", "crypto", "trading", "binary options"],
};

export const viewport: Viewport = {
  themeColor: "#0a0e17",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="dns-prefetch" href="//api.cartridge.gg" />
        <link rel="dns-prefetch" href="//x.cartridge.gg" />
        <link rel="dns-prefetch" href="//auth.turnkey.com" />
        <link rel="dns-prefetch" href="//js.stripe.com" />
        <link rel="preconnect" href="https://api.cartridge.gg" crossOrigin="" />
        <link rel="preconnect" href="https://x.cartridge.gg" crossOrigin="" />
        <link rel="preconnect" href="https://auth.turnkey.com" crossOrigin="" />
        <link rel="preconnect" href="https://js.stripe.com" crossOrigin="" />
      </head>
      <body
        className={`${spaceGrotesk.variable} ${outfit.variable} ${jetbrains.variable} min-h-screen font-sans bg-background text-foreground`}
      >
        <Providers>
          <div className="relative flex min-h-screen flex-col">
            <Navbar />
            <WarpGrid />
            <main className="relative z-[1] flex-1">{children}</main>
            <Footer />
          </div>
          <ConnectModalHost />
        </Providers>
      </body>
    </html>
  );
}
