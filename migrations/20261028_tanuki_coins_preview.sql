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

-- Every checkout spends specific unexpired awards (earliest expiry first).
-- One order may consume several awards. Each award is protected against
-- concurrent over-spend by the database trigger, not by a client quote.
CREATE TABLE IF NOT EXISTS loyalty_spends(
 order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
 award_id INTEGER NOT NULL REFERENCES loyalty_awards(id) ON DELETE RESTRICT,
 customer_id INTEGER NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
 points INTEGER NOT NULL CHECK(points>0),
 refunded_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(order_id,award_id)
);
CREATE INDEX IF NOT EXISTS idx_loyalty_spends_award ON loyalty_spends(award_id,refunded_at);
CREATE INDEX IF NOT EXISTS idx_loyalty_spends_customer ON loyalty_spends(customer_id,created_at);
CREATE TRIGGER IF NOT EXISTS trg_loyalty_spends_guards BEFORE INSERT ON loyalty_spends
BEGIN
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM orders o WHERE o.id=NEW.order_id AND o.status='new'
 ) THEN RAISE(ABORT,'COINS_ORDER_NOT_NEW') END;
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM loyalty_awards a
  JOIN orders original ON original.id=a.order_id
  WHERE a.id=NEW.award_id AND a.customer_id=NEW.customer_id
    AND a.reversed_at IS NULL AND original.status='completed'
    AND a.available_at<=datetime('now') AND a.expires_at>datetime('now')
    AND NEW.points<=a.points-COALESCE((
      SELECT SUM(s.points) FROM loyalty_spends s
      JOIN orders used ON used.id=s.order_id
      WHERE s.award_id=a.id AND s.refunded_at IS NULL
        AND used.status!='cancelled'
    ),0)
 ) THEN RAISE(ABORT,'INSUFFICIENT_COINS') END;
END;
