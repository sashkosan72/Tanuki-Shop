# Tanuki Shop release progress — 2026-10-28

## Working agreement

Complete work sequentially in small, verified parts. Publish completed changes. Preserve existing customers, orders, secrets and infrastructure. Do not invent seller details or commercial terms. Do not claim the whole shop is complete until all outstanding release checks are resolved.

## Verified in this session

- Local candidate ab86d30: password suite, Preview build, and 171 integration assertions passed. Telegram transport in this suite is mocked.
- Cloudflare Preview has both promotions and order_promotions tables (read-only schema check; zero writes).
- Existing Preview settings retain separate Preview D1/R2 bindings, customer authentication enabled and secret binding names. No secret values were retrieved.
- Created this release branch from feature/logo-promocodes-20261028 via the GitHub connector. It does NOT yet contain all local changes in ab86d30.

## Remaining, in order

1. Transfer the remaining candidate changes, including the approved PNG logo, to this branch. Local candidate is at /workspace/scratch/f02ea996bcf5/Tanuki-Shop, commit ab86d30. Compared with the branch base, candidate changes touch .github/workflows/preview-checks.yml, public/account/index.html, public/cookies/index.html, public/index.html, public/privacy/index.html, public/tanuki-logo.png, scripts/build-preview.mjs and src/index.js.
2. Deploy the exact completed candidate to the existing isolated Preview, retaining bindings and secrets. Verify logo, legal links, promotions, wallet history, update section, mobile and desktop views.
3. Run live Preview API smoke tests. Real Telegram authentication remains a separate end-to-end check; previous owner-reported checks must not be represented as fresh independent verification.
4. Before production: inspect additive schema prerequisites, confirm production Telegram domain/configuration, retain a rollback version, and publish only the tested candidate. Never run test schema or seed data against production.
5. Read-only production smoke checks. Report any unresolved payment/delivery/returns/seller-content requirements explicitly.

## Access and publication state

- Shell git push failed because no GitHub write credentials were configured. The GitHub connector can create the release branch and text files.
- Wrangler reports unauthenticated. The Cloudflare connector is connected and read access was verified; deployment via that connector still needs to be completed.
- No Preview or production deployment was performed in this session. Production data and configuration were not changed.
