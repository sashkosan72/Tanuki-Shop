-- Additive migration: preserve all existing orders and mark historical shipping as unspecified.
-- Apply to Preview D1 first. Production must be backed up and migrated before releasing this code.
ALTER TABLE orders ADD COLUMN shipping_method TEXT NOT NULL DEFAULT 'unspecified'
  CHECK(shipping_method IN ('unspecified','nova_poshta','ukrposhta'));
