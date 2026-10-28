# Tanuki Coins — Preview-only implementation checkpoint

**Never apply this migration or deploy feature to Production.**

## Approved terms
- Start: 2% before 1000 UAH historic completed purchases.
- Fan: 3% after 1000 UAH; VIP: 5% after 5000 UAH.
- Only new, Preview-flagged, completed orders tracked after feature activation.
- Approved one-time milestones: order #1 +10 Coins, #3 +20, #5 +40, #10 +70.
- 1 Coin = 1 UAH *potential* discount; redemption planned, not implemented.
- Coins vest 14 days after completed status; expire 180 days after vesting.
- Base earnings cap: 100 Coins/order and 300 Coins/vesting month.
- Max redemption: 20% of eligible merchandise, never shipping.
- Redemptions cannot be combined with promo codes, are not transferable/withdrawable.
- Refunds and cancellations must reverse awards and restore spent funds fairly.
- Paid order verification is manual; setting a status to completed must happen only after payment is confirmed.

## Implemented in this branch
- `src/tanuki-coins.js` — tier calculation, bonus rules, milestone configuration, Preview guard, completed/cancelled status tracking, read-time award issuance and wallet summary.
- `migrations/20261028_tanuki_coins_preview.sql` — isolated D1 award ledger / completion timestamps.
- `src/customer-auth.js` — authenticated customer wallet uses Preview loyalty engine only when `ENVIRONMENT=preview` AND `TANUKI_COINS_ENABLED=true`.
- `src/index.js` — admin and Telegram status changes notify the Preview loyalty engine.
- `tests/tanuki-coins.mjs` — rules and production-off assertions.
- `tests/integration.mjs` — isolated D1 migration included.
- `npm test` passes in GitHub Actions as of 2026-10-28.

## NOT FINISHED; do not enable yet
- Redemption at checkout and rollback/reconciliation for cancelled/refunded orders.
- Race-safe per-month cap under concurrent reads (current reconciliation is best-effort, not a transactional issuance engine).
- Explicit validation that status 'completed' implies actual payment received (manual verification).
- UI for pending/expired coins and test of real Preview Telegram login with dedicated Preview-only bot secrets.
- Full integration tests for expiry, repeated completion callbacks, ownership isolation, reversing earned/spent Coins, and monthly cap under concurrency.
- Production migrations, deployment and credentials — explicitly out of scope.

## Deployment guard
Feature is off by default. Even if `TANUKI_COINS_ENABLED=true` accidentally appears on Production, `coinsEnabled` requires `ENVIRONMENT=preview`. No Production D1 mutation allowed. Existing `customer_wallet_transactions` table is never rewritten by this feature.

## Safe next step
Complete redemption model and tests in this branch first. Then run Preview migration only on isolated D1 and deploy to a new Preview worker whose script is built with native assets and isolated bindings. Verify an end-to-end synthetic order and status transitions, preserving all existing orders. Only later consider a separate production launch proposal.
