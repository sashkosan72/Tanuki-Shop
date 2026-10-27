# PR6 release checklist

## Verified on 2026-10-26

- Preview admin partner create and delete with the browser confirmation dialog.
- Preview admin PNG upload, actual rendered image dimensions, and image deletion.
- Existing customer session opens the account profile and wallet response after the native Assets deployment.
- Local in-memory SQLite check: apply all three repository migrations twice; pre-existing synthetic order, item, Telegram link and product rows remain identical. Foreign-key check is empty and integrity check returns ok. No customer data was copied.
- Corrected the storefront description to match Telegram passwordless authentication. Preview build for cf8497fa3d9e096414b41dcae6477cd0bec750a6 succeeded.

## Verified on 2026-10-27

- User confirmed the requested phone checks: menu, cart quantity changes and existing account profile work. This is user-reported coverage, separate from browser automation.
- Reviewed the new order-history endpoint: it selects orders only through the authenticated Telegram identity and explicit order links.
- Live Preview browser displayed the existing synthetic linked order in the account history.
- Fixed wallet network/JSON failures preventing order history from loading; locally tested network exception, malformed JSON, HTTP failure and normal wallet response. Order history rendered in all four cases.
- Added wrapping for long profile text. Preview deployment for 00d76289780963d734b4d593cac0cf261c2c6d89 completed successfully; Cloudflare integration suite contains 129 assertions.

- User explicitly confirmed successful first-time login/profile creation with a different Telegram account after being asked to test an identity not previously registered in Preview. Recorded as user-assisted real signup QA, not an independently observed browser run.

## Required before release

- Confirm additive migration prerequisites and explicit customer-auth configuration before enabling the feature. Preserve existing deployment bindings, secrets, bot and data. Never run test schema/seed on production.
- Confirm production Telegram Login domain through the owner-controlled bot settings; do not change the production webhook for Preview testing.
- Release only the tested commit after all checks pass; smoke-test production read-only and retain a rollback path.

No production release has been performed. This checklist intentionally contains no private infrastructure IDs, schema exports, credentials or customer records.
