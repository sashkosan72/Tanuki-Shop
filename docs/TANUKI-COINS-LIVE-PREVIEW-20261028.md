# Tanuki Coins isolated live Preview — 2026-10-28

**Live Preview:** https://tanuki-shop-coins-preview.sashh4051.workers.dev/
**Branch:** feature/tanuki-coins-preview-20261028
**Production remains unchanged. Do not promote this Worker as-is.**

## Isolated resources created
- Cloudflare Worker: tanuki-shop-coins-preview
- New disposable D1: tanuki-shop-coins-preview-20261028 (0e57936a-31e3-4db3-91e8-601cb3d8c747)
- New disposable R2 bucket: tanuki-shop-preview-coins-images
- No Production DB/R2/secrets copied.
- Seven isolated schema/migration scripts succeeded.
- Test D1: 0 orders, 0 loyalty awards, 0 loyalty spends. Two synthetic QA catalog records intentionally set inactive to prevent accidental purchases by visitors.
- Production D1 order count verified unchanged: 49.

## Live smoke results
- /api/health -> ok:true and database:connected.
- / and /account/ serve.
- /api/customer/auth-config -> ready:false for TanukiShopPreviewBot, since separate test bot secret is NOT configured.
- Feature flag enabled only in this new Preview Worker; full logged-in wallet functionality can't be manually tested until Preview Telegram secret is connected.
- Static pages are served via temporary inlined text asset handler; binary logo redirects to branch raw GitHub. For Production, native Workers Assets bundle is REQUIRED; do not reuse this one-off Preview wrapper.

## Must complete before any release
1. Supply a separate Preview-only Telegram test bot token as a Cloudflare secret binding on this new Worker (never disclose in chat or copy Production token). Confirm the bot domain and perform real login smoke tests.
2. Run authenticated end-to-end order/Coins checkout on disposable D1 with synthetic products activated only during a controlled test; verify 14-day hold, awards, spending, reversal/debt and double spend across concurrent requests.
3. Validate browser/mobile rendering and ensure client-side cart promo and Coins totals update correctly.
4. Complete manual-payment verification controls and refund/chargeback policies.
5. Keep PR11 production release gate separate; take a fresh production DB backup before any production changes, secure Cloudflare/Wrangler upload of native assets, and migrate only after approval.

There is no Production deployment, no changes to 49 existing orders and no public customer incentive program running yet.
