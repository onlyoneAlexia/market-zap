import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

const ENGINE_INTERNAL =
  process.env.ENGINE_INTERNAL_URL || "http://localhost:3001";

const nextConfig: NextConfig = {
  // Keep dev artifacts separate from production build artifacts so
  // `next build` and `next dev` cannot corrupt each other's manifests.
  distDir: isDev ? ".next-dev" : ".next",
  transpilePackages: ["@market-zap/shared"],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**",
      },
    ],
  },
  // Proxy engine API + WebSocket through Next.js so external clients
  // (phones, devtunnels) only need to reach the Next.js port.
  async rewrites() {
    return [
      {
        source: "/engine-api/:path*",
        destination: `${ENGINE_INTERNAL}/api/:path*`,
      },
      {
        source: "/engine-ws",
        destination: `${ENGINE_INTERNAL}/ws`,
      },
    ];
  },
};

export default nextConfig;
