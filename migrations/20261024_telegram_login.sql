-- Additive migration: preserves every existing customer, session and order.
CREATE TABLE IF NOT EXISTS customer_telegram_logins (
 proof_hash TEXT PRIMARY KEY,
 claim TEXT NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customer_telegram_login_expiry ON customer_telegram_logins(expires_at);
