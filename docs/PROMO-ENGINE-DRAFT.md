# Promotional code engine — isolated draft
The helper in `src/promo-engine.js` computes indicative discounts in whole UAH units, with normalized codes, minimum order, activation window and type validation. Tests in `tests/promo-engine.mjs` cover valid/invalid rules and boundaries.

**Not launched:** no public endpoint, no admin CRUD, no redemption storage or limit checks, no checkout integration and no changes to production. Before activation, add additive D1 migration for codes and redemptions, authenticated admin controls, transactional/atomic usage limits, coupon-specific refund policy, a server-authoritative quote at checkout and comprehensive integration/preview tests. Never trust a client-submitted discount.
