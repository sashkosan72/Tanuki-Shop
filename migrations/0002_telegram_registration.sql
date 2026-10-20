-- Тимчасові заявки для реєстрації email + пароль із підтвердженням Telegram.
-- Тільки нова таблиця. Не змінює customers, orders чи наявні Telegram-зв'язки.
CREATE TABLE IF NOT EXISTS customer_registration_attempts (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL DEFAULT '',
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_customer_registration_attempts_expires
  ON customer_registration_attempts(expires_at);
