export interface MarketRow {
  id: string;
  market_id: string;
  on_chain_market_id: string | null;
  condition_id: string | null;
  title: string;
  description: string;
  category: string;
  outcome_count: number;
  outcome_labels: string[];
  collateral_token: string;
  resolution_source: string;
  resolution_time: Date | null;
  status: "ACTIVE" | "PAUSED" | "RESOLVED" | "VOIDED";
  winning_outcome: number | null;
  total_volume: string;
  liquidity: string;
  created_at: Date;
  updated_at: Date;
  market_type: "public" | "private";
}

export interface TradeRow {
  id: string;
  market_id: string;
  outcome_index: number;
  buyer: string;
  seller: string;
  price: string;
  amount: string;
  fee: string;
  side: "BID" | "ASK";
  buyer_nonce: string;
  seller_nonce: string;
  tx_hash: string | null;
  settled: boolean;
  trade_commitment: string | null;
  created_at: Date;
}

export interface OrderRow {
  id: string;
  market_id: string;
  outcome_index: number;
  user_address: string;
  side: "BID" | "ASK";
  order_type: "LIMIT" | "MARKET";
  price: string;
  amount: string;
  filled_amount: string;
  status: "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED";
  nonce: string;
  signature: string;
  expiry: number;
  created_at: Date;
  updated_at: Date;
}

export interface PortfolioRow {
  market_id: string;
  title: string;
  outcome_index: number;
  outcome_label: string;
  net_amount: string;
  avg_price: string;
  realized_pnl: string;
  unrealized_pnl: string;
}

export interface LeaderboardRow {
  user_address: string;
  total_trades: number;
  total_volume: string;
  realized_pnl: string;
  win_rate: number;
}

export interface DatabaseOptions {
  connectionString?: string;
  maxConnections?: number;
}
