# Scripts

Operational scripts are grouped by intent instead of living at the repo root.

## Layout

- `scripts/deploy.mjs`: unified deployment script (all contracts, or targeted redeploys).
- `scripts/addresses/`: shared helpers that write deployed contract addresses.
- `scripts/debug/`: one-off debugging flows for on-chain creation and settlement.
- `scripts/fixes/`: data repair and reseeding helpers.
- `scripts/qa/`: end-to-end smoke and order-flow checks.
- `scripts/seed/`: market seeding and reseeding flows.
- `scripts/tx/`: transaction inspection utilities.

## Deploy Commands

```bash
npm run script:deploy                    # Full deploy (all 6 contracts)
npm run script:deploy:exchange           # Redeploy CLOBExchange only
npm run script:deploy:usdc              # Redeploy MockERC20 + liquidity setup
npm run script:deploy:verify            # Verify all contracts are wired correctly

# Or directly:
node scripts/deploy.mjs --network sepolia          # (default)
node scripts/deploy.mjs --only Exchange --delay 5000
node scripts/deploy.mjs --verify
```

## Other Commands

- `npm run script:tx:inspect -- <txHash>`
- `npm run script:markets:seed`
- `npm run script:markets:reseed`
- `npm run script:qa:create-and-buy`
- `npm run script:qa:seed-and-buy`
- `npm run script:qa:test-buy`

## Notes

- All scripts assume they are launched from the repo root via `node ...` or the root `npm run` aliases above.
- Deployment credentials are loaded from an encrypted keystore or env vars (see `scripts/lib/keystore.mjs`).
- Deployed addresses are written to `packages/shared/src/addresses/<network>.json` (single source of truth).
