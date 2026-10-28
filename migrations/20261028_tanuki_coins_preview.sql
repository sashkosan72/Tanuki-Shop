-- Tanuki Coins: additive Preview-only tables. Do NOT apply to Production.
-- Membership is determined solely by verified Telegram identity.
CREATE TABLE IF NOT EXISTS loyalty_order_completions(
 order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
 completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS loyalty_awards(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
 customer_id INTEGER NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('base','milestone')),
 points INTEGER NOT NULL CHECK(points>0),
 available_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 reversed_at TEXT,
 UNIQUE(order_id,customer_id,kind)
);
CREATE INDEX IF NOT EXISTS idx_loyalty_awards_customer ON loyalty_awards(customer_id,available_at,expires_at);
