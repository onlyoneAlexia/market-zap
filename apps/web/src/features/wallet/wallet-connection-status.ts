import type { WalletProvider } from "./wallet-provider";

export type WalletConnectionPhase =
  | "idle"
  | "preparing"
  | "opening_wallet"
  | "waiting_for_approval"
  | "authorizing_session"
  | "retrying"
  | "connected"
  | "error";

export interface WalletConnectionStatus {
  provider: WalletProvider | null;
  phase: WalletConnectionPhase;
  message: string | null;
  isSlow: boolean;
}

export const IDLE_WALLET_CONNECTION_STATUS: WalletConnectionStatus = {
  provider: null,
  phase: "idle",
  message: null,
  isSlow: false,
};
