-- LOCAL DEVELOPMENT FIXTURE ONLY.
-- Reconstructed from the columns and SQL used by src/index.js.
-- This is not a snapshot, baseline or migration of the production D1 schema.
-- Apply only to an isolated local database; do not apply to production.
-- No existing tables or rows are replaced by this file.

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  price INTEGER NOT NULL,
  sale_price INTEGER,
  stock INTEGER NOT NULL DEFAULT 0,
  track_stock INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS product_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL REFERENCES products(id),
  image_key TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_city TEXT NOT NULL,
  customer_address TEXT NOT NULL,
  customer_comment TEXT NOT NULL DEFAULT '',
  total_amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  price INTEGER NOT NULL,
  quantity INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL UNIQUE,
  telegram_username TEXT
);

CREATE TABLE IF NOT EXISTS telegram_link_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS order_telegram_links (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id),
  telegram_customer_id INTEGER NOT NULL REFERENCES telegram_customers(id)
);

-- These support columns/defaults match ensureSupportTables() in src/index.js.
CREATE TABLE IF NOT EXISTS support_chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL,
  customer_name TEXT NOT NULL DEFAULT 'Покупець',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TEXT,
  last_admin_read_message_id INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS support_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL REFERENCES support_chats(id),
  sender TEXT NOT NULL,
  message_text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_products_active_created
  ON products(active, created_at DESC, name);
CREATE INDEX IF NOT EXISTS idx_product_images_product
  ON product_images(product_id, position, id);
CREATE INDEX IF NOT EXISTS idx_order_items_order
  ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_telegram_link_tokens_order
  ON telegram_link_tokens(order_id);
CREATE INDEX IF NOT EXISTS idx_order_telegram_links_customer
  ON order_telegram_links(telegram_customer_id, order_id);
CREATE INDEX IF NOT EXISTS idx_support_chats_status
  ON support_chats(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_support_chats_telegram
  ON support_chats(telegram_id);
CREATE INDEX IF NOT EXISTS idx_support_messages_chat
  ON support_messages(chat_id, id);
