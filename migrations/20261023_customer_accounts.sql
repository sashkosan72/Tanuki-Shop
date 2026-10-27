-- Apply to TEST D1 first. Never execute on production without review.
CREATE TABLE IF NOT EXISTS customer_accounts (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 password_salt TEXT NOT NULL,
 password_hash TEXT NOT NULL,
 password_iterations INTEGER NOT NULL,
 telegram_id TEXT UNIQUE,
 verified_at TEXT,
 pending_token_hash TEXT UNIQUE,
 pending_expires_at TEXT,
 failed_logins INTEGER NOT NULL DEFAULT 0,
 locked_until TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS customer_sessions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 customer_id INTEGER NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customer_sessions_customer ON customer_sessions(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_sessions_expiry ON customer_sessions(expires_at);
CREATE TABLE IF NOT EXISTS customer_password_resets (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 customer_id INTEGER NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 expires_at TEXT NOT NULL,
 used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_customer_resets_customer ON customer_password_resets(customer_id,created_at);
CREATE TABLE IF NOT EXISTS customer_wallet_transactions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 customer_id INTEGER NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
 points_delta INTEGER NOT NULL,
 reason TEXT NOT NULL,
 reference_key TEXT UNIQUE,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_customer_wallet_customer ON customer_wallet_transactions(customer_id,created_at);
CREATE TABLE IF NOT EXISTS customer_request_limits (
 key_hash TEXT PRIMARY KEY,
 window_start INTEGER NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0
);
