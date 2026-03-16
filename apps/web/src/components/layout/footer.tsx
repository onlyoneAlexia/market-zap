import Image from "next/image";

export function Footer() {
  return (
    <footer className="mt-auto border-t border-border/60 relative z-[1]">
      <div className="container mx-auto flex max-w-screen-xl items-center justify-between px-4 py-4 text-[11px] font-mono text-muted-foreground">
        <div className="flex items-center gap-0">
          <svg width="24" height="20" viewBox="0 0 32 28" fill="none" className="shrink-0 -mr-0.5">
            <polyline
              points="2,18 7,18 10,8 13,22 16,4 19,18 24,18"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
              className="text-primary"
            />
            <circle cx="16" cy="4" r="2" fill="currentColor" className="text-primary" opacity="0.4" />
          </svg>
          <span className="font-bold tracking-wider">
            arket<span className="text-primary">zap</span>
          </span>
        </div>
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            Built on
            <a
              href="https://starknet.io"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 transition-opacity hover:opacity-80 text-primary"
              title="Starknet"
            >
              Starknet
              <Image src="/starknet-icon.svg" alt="" width={16} height={16} className="h-4 w-4" />
            </a>
            with
            <a
              href="https://starkzap.com"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 transition-opacity hover:opacity-80 text-primary"
              title="StarkZap"
            >
              StarkZap
              <Image src="/starkzap-icon.svg" alt="" width={16} height={16} className="h-4 w-4 rounded" />
            </a>
          </span>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            Starknet Sepolia
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-yes" />
          </span>
        </div>
      </div>
    </footer>
  );
}
