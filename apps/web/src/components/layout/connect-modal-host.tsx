"use client";

import dynamic from "next/dynamic";

const ConnectModal = dynamic(
  () =>
    import("@/components/wallet/connect-modal").then((mod) => ({
      default: mod.ConnectModal,
    })),
  {
    ssr: false,
  },
);

export function ConnectModalHost() {
  return <ConnectModal />;
}
