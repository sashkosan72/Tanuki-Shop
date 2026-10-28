# Tanuki Shop PR11 — Production release gate (2026-10-28)

Status: **BLOCKED — DO NOT MERGE OR DEPLOY YET**.

## Verified
- Feature branch ahead of main; CI tests and a Preview-only synthetic checkout succeeded.
- Production contains 49 orders; D1 foreign_key_check returned zero violations.
- Production D1 bookmark exists; SQL export previously completed (secure download must be retained separately, not in Git).
- Telegram login is configured on Production; PR11 Preview keeps customer auth disabled and lacks its own Telegram secrets.
- Nova Poshta address directory works in PR11 Preview with server-only key. No live TTN creation was tested.

## Release order
1. Verify a fresh, retrievable and securely retained full D1 SQL export immediately before release, plus a Time Travel bookmark. Never commit backups or customer records.
2. Verify customer Telegram sign-in on a production-equivalent staging deployment, preserving the existing bot/webhook and account cookies. **Do not** copy Production credentials into public files.
3. Confirm the legal merchant identity/return policy and that manually requested IBAN payments are authorized. Payment is not automatically confirmed.
4. Apply only the additive SQL changes in `migrations/20261028_promotions.sql` and `migrations/20261028_shipping_methods.sql` to Production after verifying they are not already present; separately verify `promotions`, `order_promotions` and `orders.shipping_method`. Do not reapply the ALTER.
5. Deploy the tested commit using **native Cloudflare Workers Assets** so the owner-provided binary PNG and all subpages are uploaded. The connector-only Preview's raw-GitHub asset redirect is **not an acceptable Production build**. Preserve all current D1/R2 bindings, routes, secrets and Telegram webhook.
6. Verify public catalog, images, admin authorization, Telegram login, promo quote, both carriers, order creation, order history and zero unexpected changes to existing orders, then monitor errors.
7. On a failed smoke test, roll back the **Worker deployment** first. **Do not blindly restore D1** while new customer orders could have arrived. Use bookmark/export for careful reconciliation only.

## Explicit blockers on 2026-10-28
- No production-equivalent PR11 Telegram sign-in test.
- No confirmed native Workers Assets upload/deploy path for current connector-only environment; directly PUTting JS would lose static assets or bindings.
- Merchant/legal launch details and production shipping API secret not confirmed.

Current Production `tanukishop.pp.ua` is intentionally unchanged.
