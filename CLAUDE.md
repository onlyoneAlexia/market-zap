# MarketZap — CLAUDE.md

## What This Is
A Polymarket-style prediction market on Starknet. Users buy and sell outcome positions on real-world events. Hybrid CLOB + LMSR AMM matching engine, on-chain settlement via Starknet Sepolia.

## Architecture
```
apps/web        — Next.js 15 + Tailwind + shadcn/ui + Zustand + TanStack Query (port 3000)
services/engine — Express + ws + Postgres + Redis CLOB engine (port 3001)
packages/shared — API client, types, StarkZap SDK wrapper, order signing
contracts/      — Cairo smart contracts (ConditionalTokens, Vault, Exchange, Factory, Resolver)
```

## Non-Negotiable Rules

### No Mock Data, No Fake Anything
- **ZERO mock data in the app.** Every value displayed must come from real on-chain contracts, the Postgres DB, or the live engine API.
- Never stub, fake, or hardcode data to "make it look right." If a query returns empty, show empty — don't fabricate.
- Price history, trade history, balances, positions — all must be real DB/chain reads.
- If an API endpoint is broken, fix the endpoint. Don't work around it with placeholder data.

### Security First — Engine Is Financial Infrastructure
- The engine handles real money (USDC, ETH, STRK). Treat every change to `services/engine/` as security-critical.
- **Before merging any engine change**, run relevant Trail of Bits security skills:
  - `/semgrep` on changed engine files
  - `/audit-prep-assistant` for significant feature additions
  - `/insecure-defaults` when adding config or auth logic
  - `/sharp-edges` when modifying API surface
- Validate all inputs at API boundaries with Zod. Trust nothing from the client.
- All financial math uses u256 (never felt252). No floating-point for money.
- Never skip on-chain settlement — if settlement fails, the trade must be marked failed, not silently swallowed.
- Never expose private keys, admin credentials, or internal state in API responses.
- Rate-limit and bound all user-facing endpoints. Max 50 WS channels per connection.

### Every Fix Must Be Verified in the Live UI
- After fixing any bug or making any UI change, verify it works using `/playwriter` against the running app at http://localhost:3000.
- Take screenshots of the fix working. Don't just say "it should work now."
- If the engine is needed, make sure it's running on port 3001 before testing.

### Zero Tolerance for Errors
- Fix ALL errors — not just the ones from the current task. If you see a console error, a failed test, a TypeScript warning, or a broken page, fix it.
- Pre-existing errors are not excuses. If you touch a file and see nearby issues, fix them.
- Build must be clean (`next build` exits 0). Tests must pass (`vitest run` — 151+ tests).
- No `// @ts-ignore`, no `// eslint-disable` unless there's a comment explaining exactly why.

### Changes Must Not Introduce New Problems
- Read existing code before modifying it. Understand the data flow end-to-end.
- After every change: build the web app, run engine tests, verify in the UI.
- If a fix touches the engine API response shape, update the shared types AND the frontend consumer.
- Check all callers when changing a function signature or data shape.
- Run `next build` (web) and `vitest run` (engine) after every significant change.

## Dev Commands
```bash
# Kill stale + start (auto-kills existing process on the port)
npm run dev:web       # Frontend on :3000
npm run dev:engine    # Engine on :3001

# Build & test
cd apps/web && npx next build          # Web build
cd services/engine && npx vitest run   # Engine tests (151+)
npx turbo typecheck                    # All packages typecheck

# Database
docker exec market-zap-postgres psql -U postgres -d market_zap  # Postgres shell
docker exec market-zap-redis redis-cli                          # Redis shell
```

## Key Conventions
- **Snake_case in DB, camelCase in API/frontend.** Always transform in the REST layer (see `formatMarket`, `formatTrade` in rest.ts).
- **Zustand store** (`use-store.ts`) persists wallet state to localStorage. Ephemeral UI state (modals, WS status) is not persisted.
- **Global WebSocket** (`use-ws.ts`) lives in Providers — auto-reconnects with exponential backoff. Components subscribe to channels via the store, not by creating their own WS.
- **StarkZap client** singleton in `use-wallet-reconnect.ts` — shared across all hooks via `getClient()`.
- **StarkZap LLM rules** live in `.cursorrules` and `.cursor/rules/starkzap.mdc`; apply them when editing Cairo/StarkZap integrations.
- **Wallet reconnects on refresh** — persisted provider ID triggers silent `swo.enable()` on mount.
- **`accountsChanged` listener** — auto-detects Braavos/ArgentX account switches.

## What Users Can Do
- Browse prediction markets with live countdowns
- Buy YES/NO positions via limit or market orders
- Sell positions back to the order book
- View portfolio with real P&L from on-chain data
- See leaderboard ranked by realized profit
- Create new markets (bond-gated, $20 USDC)
- Connect via Braavos or Argent X wallets

## API Contract Discipline (Frontend <-> Engine)

- **Shared package is the contract surface.** For any REST change, update the corresponding method/types in `packages/shared/src/api-client.ts` before touching UI consumers.
- **No ad-hoc `fetch()` from the web app.** All engine calls must go through the singleton `MarketZapAPI` in `apps/web/src/lib/api.ts`.
- **Standard response envelope.** Every `/api/*` endpoint must respond via `ok()` helper (`rest.ts`), producing `{ success: true, data }`. Never return raw JSON.
- **Paginated endpoints use `paginated()`.** Keep `items/page/pageSize/hasMore` consistent with `PaginatedResponse<T>` in the shared package.
- **All DB rows must be mapped in one place.** New fields go through `formatMarket()`, `formatTrade()`, or a new format helper in `rest.ts` — never sprinkle transforms across handlers.

## Database Migration Safety

- **`createTables()` must be idempotent.** Schema changes must use `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` and be safe to run on an already-populated DB.
- **No breaking schema changes in one deploy.** Column drops/renames require a 2-step migration: add new -> backfill -> cutover -> remove old.
- **NOT NULL columns require defaults + backfill.** Follow existing `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ... DEFAULT` pattern.
- **Indexes:** always use `CREATE INDEX IF NOT EXISTS` with deterministic names.
- **Materialized views (leaderboard):** keep the unique index required for `REFRESH CONCURRENTLY`. If you change the view definition, plan a real migration.

## WebSocket Protocol Rules

- **Broadcast envelope is fixed:** `{ channel: string, data: any }` — do not introduce alternate formats.
- **Valid client messages:** `subscribe | unsubscribe | pong` only. New types require updating parsing, the `IncomingMessage` union type, AND tests.
- **Channel names are regex-validated.** Adding a new channel requires updating `CHANNEL_PATTERN` in `websocket.ts` and corresponding tests.
- **Subscriptions must be idempotent.** Safe to resend on reconnect. The frontend resubscribes all active channels when the global WS reconnects.
- **Heartbeat contract:** Server sends WS ping + app-level `{type:"ping"}` every 30s. Client responds with `{type:"pong"}`. Timing changes must be coordinated on both sides.

## Order Matching & Settlement Invariants

- **Partial fills per signed nonce.** The on-chain contract tracks filled amounts per (trader, nonce) and only marks a nonce used when `filled == amount`. The matcher may sweep multiple resting orders and may rest remaining LIMIT quantity using the same signed nonce.
- **Off-chain matches must satisfy on-chain rules:** `fill_amount > 0`, same `market_id`/`token_id`, opposite sides, price crossing, both orders unexpired.
- **Execution price = maker (resting) price.** The engine records and settles trades at the maker price.
- **Settlement atomicity:** Use `reserve_balance + settle_trade` in a single multicall. Never leave "reserved but not settled" state.
- **Trade recording flow:** Insert optimistically with `settled=false` -> flip to `settled=true` only after confirmed on-chain tx. Unsettled buy costs must be deducted from available balance to prevent double-spend.

## Testing Requirements

- **After any change, run both:** `next build` (web) AND `vitest run` (engine, 151+ tests).
- **REST changes:** update/add cases in `__tests__/rest.test.ts` including envelope and pagination.
- **WS changes:** update `__tests__/websocket.test.ts` for channel/payload/lifecycle changes.
- **Matcher/AMM:** update `__tests__/matcher.test.ts`, `__tests__/amm.test.ts`, `__tests__/amm-state.test.ts`.
- **Shared types:** update `packages/shared/src/__tests__/api-client.test.ts`.
- **Cairo changes:** run `snforge test` — all 51 contract tests must pass.

## Deployment Checklist

- [ ] Deployed contract addresses match env vars (`EXCHANGE_ADDRESS`, `CONDITIONAL_TOKENS_ADDRESS`, `MARKET_FACTORY_ADDRESS`)
- [ ] `ADMIN_ADDRESS` is authorized as operator on the exchange contract
- [ ] `ENGINE_API_KEY` is set (not dev-open) for admin endpoints
- [ ] `SKIP_BALANCE_CHECK=false` in production
- [ ] DB schema + indexes + materialized views created successfully on boot
- [ ] `REFRESH MATERIALIZED VIEW CONCURRENTLY` works (unique index exists)
- [ ] Frontend env vars point to correct REST + WS endpoints
- [ ] End-to-end trading test passes (`services/engine/e2e-test.mjs`)
- [ ] WS connection verified: subscribe, receive broadcast, heartbeat working

## Deadline
This app must be production-ready within 3 days. Prioritize working features over perfect code. Ship fast, but ship correctly.
