-- Preview-first additive migration. Never seed or apply to production without explicit release review.
CREATE TABLE IF NOT EXISTS promo_codes (
 code TEXT PRIMARY KEY COLLATE NOCASE,
 discount_type TEXT NOT NULL CHECK(discount_type IN ('percent','fixed')),
 value INTEGER NOT NULL CHECK(value>0),
 minimum_order INTEGER NOT NULL DEFAULT 0 CHECK(minimum_order>=0),
 starts_at TEXT,
 expires_at TEXT,
 max_uses INTEGER CHECK(max_uses IS NULL OR max_uses>0),
 active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(discount_type!='percent' OR value<=100),
 CHECK(starts_at IS NULL OR expires_at IS NULL OR starts_at<expires_at)
);
CREATE TABLE IF NOT EXISTS promo_redemptions (
 order_id INTEGER PRIMARY KEY REFERENCES orders(id),
 code TEXT NOT NULL REFERENCES promo_codes(code),
 subtotal_amount INTEGER NOT NULL,
 discount_amount INTEGER NOT NULL,
 redeemed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(subtotal_amount>0),
 CHECK(discount_amount>=0 AND discount_amount<=subtotal_amount)
);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_code ON promo_redemptions(code);
