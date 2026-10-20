-- Етап 2. Тільки нові таблиці: існуючі orders, order_items та Telegram-зв'язки не змінюються.
-- Запускати на production лише після перевірки та окремого погодження.
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  password_salt TEXT,
  password_hash TEXT,
  email_verified_at TEXT,
  telegram_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((email IS NOT NULL AND password_salt IS NOT NULL AND password_hash IS NOT NULL)
    OR telegram_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS customer_sessions (
  token_hash TEXT PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_customer_sessions_customer ON customer_sessions(customer_id);

CREATE TABLE IF NOT EXISTS customer_email_verifications (
  customer_id INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customer_orders (
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  PRIMARY KEY (customer_id, order_id)
);
