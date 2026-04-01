# MarketZap

**A decentralized prediction market protocol on Starknet with hybrid CLOB + AMM matching, gasless onboarding, and privacy-preserving dark markets.**

Built for the Starknet hackathon. Live on Sepolia testnet.

---

## What is MarketZap?

MarketZap lets users bet on real-world event outcomes (elections, sports, crypto prices) by buying YES/NO position tokens. Unlike Polymarket (Ethereum L1), MarketZap runs entirely on Starknet — giving users sub-second finality, near-zero gas costs, and native account abstraction for gasless trading.

**Key differentiators:**
- **Hybrid CLOB + LMSR AMM** — limit orders match on a central order book first; an on-chain AMM provides fallback liquidity so markets are never empty
- **Dark markets** — privacy-preserving markets where orderbook depth, trader addresses, and individual trades are hidden from public view
- **Gasless UX** — users sign orders off-chain (SNIP-12 TypedData); the engine settles on-chain via AVNU paymaster. Zero gas for traders.
- **Social login** — no wallet extension required. Sign in with Google/Discord/Passkey via Cartridge Controller, get a smart account instantly.
- **Multi-collateral** — USDC, ETH, and STRK accepted as collateral

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         MONOREPO (Turborepo)                        │
├──────────────┬──────────────┬──────────────┬────────────────────────┤
│  apps/web    │ services/    │ packages/    │ contracts/             │
│              │   engine     │   shared     │                        │
│  Next.js 15  │  Express +   │  API client  │  Cairo 2.15           │
│  Tailwind    │  WebSocket   │  Types       │  5 smart contracts    │
│  shadcn/ui   │  Postgres    │  StarkZap    │  OpenZeppelin v4      │
│  Zustand     │  Redis       │  SDK wrapper │  snforge 0.56         │
│  TanStack Q  │  CLOB+AMM    │  Order hash  │  64 tests             │
│              │  193 tests   │  ABIs        │                        │
│  Port 3000   │  Port 3001   │              │  Starknet Sepolia     │
└──────────────┴──────────────┴──────────────┴────────────────────────┘
```

### System Overview

```
User (Browser)                      Starknet Sepolia
     │                                    │
     │ ① Connect wallet                   │
     │   (Argent X / Braavos /            │
     │    Cartridge social login)         │
     │                                    │
     ▼                                    │
┌─────────────┐    REST + WS    ┌─────────┴──────────┐
│  Next.js    │◄──────────────►│   CLOB Engine       │
│  Frontend   │  (+ X-MZ-Auth) │   ├─ Matcher        │
│             │                 │   ├─ AMM (LMSR)     │
│  - Markets  │                 │   ├─ Settler        │
│  - Trading  │                 │   ├─ REST API       │
│  - Portfolio│                 │   └─ WebSocket      │
│  - Leaderbd │                 │         │           │
└─────────────┘                 └─────────┤───────────┘
                                          │ multicall
                                          ▼
                              ┌───────────────────────┐
                              │ Starknet Contracts     │
                              │ ├─ CLOBExchange        │
                              │ ├─ ConditionalTokens   │
                              │ ├─ CollateralVault     │
                              │ ├─ MarketFactory       │
                              │ └─ AdminResolver       │
                              └───────────────────────┘
```

---

## Smart Contracts (Cairo)

Five upgradeable contracts deployed on Starknet Sepolia:

| Contract | Purpose | Address |
|----------|---------|---------|
| **CLOBExchange** | Trade settlement, balance reservation, fee collection | `0x03dc...9d6e` |
| **ConditionalTokens** | ERC-1155 outcome tokens (YES/NO positions) | `0x076a...c8b2` |
| **CollateralVault** | USDC escrow with actual-received accounting | `0x052c...5a0c` |
| **MarketFactory** | Market creation, bond gating, public/dark type flag | `0x055d...f644` |
| **AdminResolver** | Outcome resolution, 24h dispute period, voiding | `0x059a...1b3c` |

**Key design decisions:**
- All financial math uses `u256` (never `felt252`) to prevent overflow
- SNIP-12 TypedData signature verification via `ISRC6` account abstraction
- Partial fills tracked per `(trader, nonce)` — nonce marked used only at `filled == amount`
- Settlement atomicity: `reserve_balance` + `settle_trade` in a single multicall
- Dark markets use `settle_dark_trade()` with Poseidon commitment hashes instead of full order calldata

---

## CLOB Engine

The matching engine is the core of MarketZap — a Node.js/Express server that manages the full order lifecycle:

### Order Flow

```
1. User signs SNIP-12 order off-chain (wallet popup)
2. Frontend POSTs signed order to engine
3. Engine verifies signature, checks balances
4. Matcher attempts CLOB match against resting orders
5. If no CLOB match → AMM (LMSR, b=100) provides fill
6. Matched trades recorded optimistically (settled=false)
7. Settler submits multicall to Starknet (reserve + settle)
8. On tx confirmation → flip settled=true
9. WebSocket broadcasts price update + trade to subscribers
```

### Matching Engine

- **CLOB first**: Incoming orders sweep the opposite side of the book at maker price (price-time priority)
- **AMM fallback**: LMSR market maker (`b=100`, max loss ~69 USDC/market) fills remaining quantity
- **Partial fills**: A single order can partially fill against multiple resting orders + AMM
- **Execution price**: Always the maker (resting) price, not the taker price
- **Dark markets**: Same matching logic, but orderbook/trade data is redacted from API responses

### Fee Structure

| | Rate |
|---|---|
| Maker fee | 0% |
| Taker fee | 1% |
| Settlement | On-chain to treasury |

### Data Stores

- **Redis** — In-memory orderbook projection (bid/ask levels, price cache)
- **PostgreSQL** — Canonical trade log, market metadata, balances, leaderboard materialized view

---

## Frontend

Next.js 15 app with 11 routes:

| Route | Description |
|-------|-------------|
| `/` | Market listing with filters (active, resolved, dark) |
| `/markets/[id]` | Market detail — price chart, orderbook, trade panel |
| `/create` | Create market (public or dark, $20 USDC bond) |
| `/portfolio` | User positions, P&L, open orders |
| `/leaderboard` | Top traders ranked by realized profit |
| `/resolve` | Admin resolution panel |
| `/account` | Wallet settings, balance management |

**Tech stack:**
- **State**: Zustand (persisted wallet state) + TanStack Query (server state)
- **Styling**: Tailwind CSS + shadcn/ui (dark theme, red accent)
- **Real-time**: Global WebSocket with auto-reconnect + exponential backoff
- **Wallet**: StarkZap SDK wrapping Argent X, Braavos, and Cartridge Controller
- **API**: All calls go through `MarketZapAPI` singleton (never raw `fetch`)

---

## Dark Markets (Privacy Feature)

MarketZap supports "dark" prediction markets where trading activity is hidden from public view:

| Data Point | Public Market | Dark Market |
|------------|--------------|-------------|
| Orderbook depth | Full bid/ask levels | Redacted (empty) |
| Trade history | Full (maker, taker, price, amount) | Volume + timestamp only |
| Best bid/ask | Visible | Hidden (AMM-only pricing) |
| On-chain event | `TradeSettled` (full details) | `DarkTradeSettled` (commitment hash only) |
| Settlement calldata | 2 full Order structs + signatures | Minimal (no orders, no sigs) |
| Portfolio (own) | Visible | Visible (auth-gated via SNIP-12 `MZAuth` signature) |
| Leaderboard | Included | Excluded |

**Auth**: User-specific endpoints require `X-MZ-Auth` header containing a SNIP-12 TypedData signature (`{address, timestamp}`, 5-min TTL). Server verifies via on-chain `is_valid_signature()`.

---

## Getting Started

### Prerequisites

- Node.js 18+
- Docker (for Postgres + Redis)
- Scarb 2.15.0 + snforge 0.56.0 (for contract development)
- A Starknet wallet (Argent X or Braavos browser extension)

### Setup

```bash
# Clone and install
git clone https://github.com/your-org/market-zap.git
cd market-zap
npm install

# Start infrastructure
docker compose up -d  # Postgres + Redis

# Start development
npm run dev:engine    # Engine on :3001
npm run dev:web       # Frontend on :3000
```

### Environment Variables

```bash
# services/engine/.env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/market_zap
REDIS_URL=redis://localhost:6379
STARKNET_RPC_URL=https://starknet-sepolia.public.blastapi.io
ADMIN_ADDRESS=0x033484...3837
ENGINE_API_KEY=your-api-key
RESOLUTION_DISPUTE_PERIOD_SECONDS=300
SKIP_BALANCE_CHECK=true  # false in production
```

### Contract Development

```bash
cd contracts

# Build
scarb build

# Test (64 tests)
snforge test

# Deploy
cd .. && npm run script:deploy
```

---

## Testing

```bash
# Engine unit tests (193 tests)
cd services/engine && npx vitest run

# Web build verification
cd apps/web && npx next build

# Contract tests (64 tests)
cd contracts && snforge test

# Full typecheck
npx turbo typecheck

# E2E smoke test
node services/engine/e2e-test.mjs
```

---

## Project Structure

```
market-zap/
├── apps/
│   └── web/                    # Next.js 15 frontend
│       └── src/
│           ├── app/            # App router (11 routes)
│           ├── components/     # UI components (market, trading, wallet, etc.)
│           ├── hooks/          # useMarkets, useWallet, useWS, etc.
│           ├── lib/            # API client, utils, store
│           └── providers/      # React context (WS, wallet)
├── services/
│   └── engine/                 # CLOB matching engine
│       └── src/
│           ├── matcher.ts      # CLOB + AMM hybrid matcher
│           ├── amm.ts          # LMSR automated market maker
│           ├── amm-state.ts    # AMM state management
│           ├── settler.ts      # On-chain trade settlement
│           ├── orderbook.ts    # Redis orderbook projection
│           ├── api/            # REST routes + WebSocket
│           ├── db/             # Postgres queries + schema
│           └── __tests__/      # 193 unit tests
├── packages/
│   └── shared/                 # Shared between web + engine
│       └── src/
│           ├── api-client.ts   # MarketZapAPI class
│           ├── types/          # TypeScript types (Market, Trade, Order, etc.)
│           ├── contracts.ts    # Contract address registry
│           ├── starkzap.ts     # StarkZap SDK wrapper
│           ├── order-hash.ts   # SNIP-12 order hashing
│           ├── addresses/      # Deployed contract addresses (JSON)
│           └── abis/           # Contract ABIs
├── contracts/                  # Cairo smart contracts
│   ├── src/
│   │   ├── clob_exchange.cairo
│   │   ├── conditional_tokens.cairo
│   │   ├── collateral_vault.cairo
│   │   ├── market_factory.cairo
│   │   ├── admin_resolver.cairo
│   │   └── interfaces/
│   └── tests/                  # 64 snforge tests
├── scripts/                    # Deploy, seed, QA, debug scripts
├── diagrams/                   # Excalidraw architecture diagrams
└── docs/                       # Additional documentation
```

---

## WebSocket Protocol

The engine exposes a WebSocket server for real-time updates:

```typescript
// Connect
const ws = new WebSocket('ws://localhost:3001')

// Subscribe to market price updates
ws.send(JSON.stringify({ type: 'subscribe', channel: 'price:market-123' }))

// Receive broadcasts
// { channel: 'price:market-123', data: { lastPrice: 0.65, bestBid: 0.64, bestAsk: 0.66 } }

// Heartbeat: server sends ping every 30s, client responds with pong
ws.send(JSON.stringify({ type: 'pong' }))
```

**Channels**: `price:<marketId>`, `trades:<marketId>`, `orderbook:<marketId>`
**Client messages**: `subscribe`, `unsubscribe`, `pong` (no other types accepted)

---

## API Endpoints

All endpoints return `{ success: true, data: ... }` envelope. Paginated endpoints include `{ items, page, pageSize, hasMore }`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/markets` | List markets (filterable by status, type) |
| `GET` | `/api/markets/:id` | Market detail + price |
| `POST` | `/api/markets` | Create market (admin or bond-gated) |
| `GET` | `/api/markets/:id/orderbook` | Orderbook depth (redacted for dark) |
| `GET` | `/api/markets/:id/trades` | Trade history (redacted for dark) |
| `GET` | `/api/markets/:id/price` | Current price (CLOB midpoint + AMM) |
| `GET` | `/api/markets/:id/quote` | Price quote for a given size |
| `POST` | `/api/orders` | Submit signed order |
| `GET` | `/api/portfolio/:address` | User positions + P&L |
| `GET` | `/api/balance/:address` | User collateral balance |
| `GET` | `/api/leaderboard` | Top traders by realized profit |
| `POST` | `/api/markets/:id/resolve` | Resolve market (admin) |

---

## Diagrams

Architecture diagrams are in the [`diagrams/`](diagrams/) folder (Excalidraw format, open with VS Code Excalidraw extension or excalidraw.com):

| File | Description |
|------|-------------|
| [01-system-architecture.excalidraw](diagrams/01-system-architecture.excalidraw) | Full system overview — frontend, engine, contracts, data stores |
| [02-dark-market-trade-flow.excalidraw](diagrams/02-dark-market-trade-flow.excalidraw) | Sequence diagram for private market trade lifecycle |
| [03-user-onboarding-flow.excalidraw](diagrams/03-user-onboarding-flow.excalidraw) | Wallet connection paths (social login vs browser extension) |
| [04-public-vs-private-markets.excalidraw](diagrams/04-public-vs-private-markets.excalidraw) | Side-by-side comparison of data visibility |
| [05-market-lifecycle.excalidraw](diagrams/05-market-lifecycle.excalidraw) | Market states: create → active → resolution → resolved/voided |
| [06-order-matching-settlement.excalidraw](diagrams/06-order-matching-settlement.excalidraw) | CLOB + AMM matching flow with on-chain settlement |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Smart contracts | Cairo 2.15, OpenZeppelin v4, Scarb 2.15.0, snforge 0.56.0 |
| Blockchain | Starknet Sepolia (testnet) |
| Backend | Node.js, Express, WebSocket (`ws`), TypeScript |
| Database | PostgreSQL (canonical log) + Redis (orderbook projection) |
| Frontend | Next.js 15, React 19, Tailwind CSS, shadcn/ui, Zustand, TanStack Query |
| Wallet SDK | StarkZap SDK (gasless txns via AVNU paymaster, Cartridge social login) |
| Monorepo | Turborepo, npm workspaces |
| Testing | snforge (Cairo), Vitest (engine), Next.js build (web) |

---

## Security Model

- **Order signing**: SNIP-12 TypedData signatures verified on-chain via ISRC6 (`is_valid_signature`)
- **Settlement atomicity**: Reserve + settle in single multicall — no partial states
- **Financial math**: All amounts in `u256`, never floating-point
- **Balance checks**: On-chain balance verification before trade execution
- **Dark market privacy**: Poseidon commitment hashes, minimal calldata, auth-gated queries
- **Rate limiting**: All user-facing endpoints rate-limited, max 50 WS channels per connection
- **Input validation**: Zod schemas at all API boundaries

---

## License

MIT
