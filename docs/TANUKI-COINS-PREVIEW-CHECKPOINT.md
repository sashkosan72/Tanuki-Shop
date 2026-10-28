# Tanuki Coins — Preview-only implementation checkpoint (2026-10-28)

**Release decision: NOT READY for Production. Feature must remain off until staged E2E testing is complete.**

## Approved rules
- Start 2% until 999 UAH lifetime completed purchases; Fan 3% from 1000 UAH; VIP 5% from 5000 UAH.
- Milestone gifts: +10/+20/+40/+70 Coins on purchase numbers 1/3/5/10.
- Base award cap: 100 Coins per order and 300 Coins per vesting month.
- Coins vest 14 days after an explicitly completed order and expire 180 days later.
- Redemption: 1 Coin = 1 UAH, maximum 20% of merchandise amount, not with a promotion code, never shipping.
- No retroactive backfill: only orders marked completed while the Preview feature flag is enabled are counted. No bank-card payouts or Coin transfers.

## Implemented and verified in isolated local Workers + D1 CI
- Preview-only guarded earnings, one-time order-completion records, tier rules, milestone rewards and expiry.
- Signed Telegram-session based wallet balance and reward history, with pending and expiry information in account UI.
- Authenticated Preview checkout accepts `coins_to_spend`; all limits and promo exclusions are re-verified server side, never trusted from the browser.
- Database `loyalty_spends` ledger tracks per-award consumption; SQL trigger enforces identity, expiry and remaining balance at insert time (protecting concurrent redemptions).
- D1 order insertion, order items and award spend records are in a single batch transaction. Stock reservation rollbacks are handled by existing checkout error path.
- Status cancellation marks award reversals and refunds spent Coins, keeping the original order history.
- Automated integration covers real test checkout with 10 Coins, a 20% rejection, duplicate/overspend attempt, refund on cancellation, unrelated-user rejection, and production feature-flag protection.
- Latest CI verified green: https://github.com/sashkosan72/Tanuki-Shop/actions/runs/40737453709

## Outstanding before enabling on a public Preview
1. End-to-end test on a dedicated new Worker backed by disposable Preview D1, including actual Telegram login with Preview-only bot credentials. Existing Preview PR6 and Production bot secrets must not be moved or exposed.
2. Harden issuance under simultaneous wallet reads: current monthly cap is non-transactional; make monthly award allocation atomic before real money value can accrue.
3. Handle cancellation/refund of an **original award-generating order** after the awarded Coins have already been spent elsewhere; resolve debt/recovery policy. Current ledger prevents reusing reversed awards, but further credit/debt reconciliation is necessary.
4. Ensure staff can only mark orders 'completed' after verified payment; payment via IBAN has no automatic payment confirmation.
5. Add explicit customer confirmation of non-combinable promo/Coins states and broader accessibility/mobile/real-browser QA.
6. Verify migration with rollback on disposable Preview D1 before any release plan. Production database and its 49 existing orders remain untouched.

## Scope protection
This branch was created from feature/logo-promocodes-20261028 (not main). There is no release/merge to Production. The opt-in requires **both** `ENVIRONMENT='preview'` and `TANUKI_COINS_ENABLED='true'`; ordinary Preview/Production traffic stays disabled. The migration file is `migrations/20261028_tanuki_coins_preview.sql`.
