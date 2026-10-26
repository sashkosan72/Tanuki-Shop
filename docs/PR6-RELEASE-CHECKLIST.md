# PR6 release checklist

## Verified on 2026-10-26

- Preview admin partner create and delete with the browser confirmation dialog.
- Preview admin PNG upload, actual rendered image dimensions, and image deletion.
- Existing customer session opens the account profile and wallet response after the native Assets deployment.
- Local in-memory SQLite check: apply all three repository migrations twice; pre-existing synthetic order, item, Telegram link and product rows remain identical. Foreign-key check is empty and integrity check returns ok. No customer data was copied.
- Corrected the storefront description to match Telegram passwordless authentication. Preview build for cf8497fa3d9e096414b41dcae6477cd0bec750a6 succeeded.

## Required before release

- Real first-time Telegram registration using an identity that has not registered in Preview. Existing-account login and synthetic signed fixtures are not this test. Never delete an existing customer merely to simulate signup.
- Final phone viewport/touch check of menu, catalog, cart and account. Prior narrow iframe coverage is not a real-device test.
- Confirm additive migration prerequisites and explicit customer-auth configuration before enabling the feature. Preserve existing deployment bindings, secrets, bot and data. Never run test schema/seed on production.
- Confirm production Telegram Login domain through the owner-controlled bot settings; do not change the production webhook for Preview testing.
- Release only the tested commit after all checks pass; smoke-test production read-only and retain a rollback path.

No production release has been performed. This checklist intentionally contains no private infrastructure IDs, schema exports, credentials or customer records.
