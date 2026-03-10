import { hash as snHash } from "starknet";

export const ERC20_TRANSFER_SELECTOR =
  "0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9";
export const ERC1155_TRANSFER_SINGLE_SELECTOR =
  "0x182d859c0807ba9db63baf8b9d9fdbfeb885d820be6e206b9dab626d995c433";
export const DARK_TRADE_SETTLED_SELECTOR =
  snHash.getSelectorFromName("DarkTradeSettled").toLowerCase();
