import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";

// Ізольована SQLite in-memory. Жодне тестове замовлення не надсилається в D1.
function createTestDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price INTEGER NOT NULL,
      sale_price INTEGER,
      stock INTEGER NOT NULL,
      track_stock INTEGER NOT NULL,
      active INTEGER NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT NOT NULL UNIQUE,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      customer_city TEXT NOT NULL,
      customer_address TEXT NOT NULL,
      customer_comment TEXT,
      total_amount INTEGER NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      price INTEGER NOT NULL,
      quantity INTEGER NOT NULL
    );
    CREATE TABLE telegram_link_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
  `);

  sqlite.prepare(`
    INSERT INTO products (id, name, price, sale_price, stock, track_stock, active)
    VALUES ('manga-1', 'Тестова манґа', 240, 180, 5, 1, 1)
  `).run();

  const meta = result => ({
    changes: Number(result.changes),
    last_row_id: Number(result.lastInsertRowid)
  });

  // Мінімальний адаптер D1: для batch діє SQLite-транзакція.
  const DB = {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            sql,
            params,
            async first() {
              return sqlite.prepare(sql).get(...params) ?? null;
            },
            async all() {
              return { results: sqlite.prepare(sql).all(...params) };
            },
            async run() {
              return { meta: meta(sqlite.prepare(sql).run(...params)) };
            }
          };
        },
        async first() {
          return sqlite.prepare(sql).get() ?? null;
        },
        async all() {
          return { results: sqlite.prepare(sql).all() };
        }
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(statement => ({
          meta: meta(sqlite.prepare(statement.sql).run(...statement.params))
        }));
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  };

  return { sqlite, DB };
}

function createEnv(DB, limitResult = true) {
  const limiter = { async limit() { return { success: limitResult }; } };
  return {
    DB,
    ADMIN_PASSWORD: "test-admin-password-never-for-production",
    ADMIN_LOGIN_LIMITER: limiter,
    ORDER_RATE_LIMITER: limiter
  };
}

function orderRequest(items = [{ id: "manga-1", quantity: 2 }]) {
  return new Request("https://test.invalid/api/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "192.0.2.25"
    },
    body: JSON.stringify({
      customerName: "Тестовий покупець",
      customerPhone: "+380000000000",
      customerCity: "Тестове місто",
      customerAddress: "Тестове відділення",
      items
    })
  });
}

test("checkout atomically saves the order and reserves stock", async t => {
  const { sqlite, DB } = createTestDatabase();
  t.after(() => sqlite.close());

  const response = await worker.fetch(orderRequest(), createEnv(DB));
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.ok, true);
  assert.equal(body.total_amount, 360);
  assert.equal(sqlite.prepare("SELECT stock FROM products").get().stock, 3);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 1);
  assert.equal(sqlite.prepare("SELECT quantity FROM order_items").get().quantity, 2);
});

test("insufficient stock does not create an order or reduce stock", async t => {
  const { sqlite, DB } = createTestDatabase();
  t.after(() => sqlite.close());

  const response = await worker.fetch(
    orderRequest([{ id: "manga-1", quantity: 6 }]),
    createEnv(DB)
  );

  assert.equal(response.status, 409);
  assert.equal(sqlite.prepare("SELECT stock FROM products").get().stock, 5);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 0);
});

test("unavailable second line does not reserve the first line", async t => {
  const { sqlite, DB } = createTestDatabase();
  t.after(() => sqlite.close());
  sqlite.prepare(`
    INSERT INTO products (id, name, price, sale_price, stock, track_stock, active)
    VALUES ('figure-1', 'Тестова фігурка', 500, NULL, 0, 1, 1)
  `).run();

  const response = await worker.fetch(orderRequest([
    { id: "manga-1", quantity: 2 },
    { id: "figure-1", quantity: 1 }
  ]), createEnv(DB));

  assert.equal(response.status, 409);
  assert.equal(sqlite.prepare("SELECT stock FROM products WHERE id = 'manga-1'").get().stock, 5);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 0);
});

test("price change between reading and committing prevents a stale-price order", async t => {
  const { sqlite, DB } = createTestDatabase();
  t.after(() => sqlite.close());
  const originalBatch = DB.batch.bind(DB);
  DB.batch = async statements => {
    sqlite.prepare("UPDATE products SET sale_price = 200 WHERE id = 'manga-1'").run();
    return originalBatch(statements);
  };

  const response = await worker.fetch(orderRequest(), createEnv(DB));

  assert.equal(response.status, 409);
  assert.equal(sqlite.prepare("SELECT stock FROM products").get().stock, 5);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 0);
});

test("failed order item insertion rolls back the order and inventory changes", async t => {
  const { sqlite, DB } = createTestDatabase();
  t.after(() => sqlite.close());
  sqlite.exec(`
    CREATE TRIGGER fail_items BEFORE INSERT ON order_items
    BEGIN SELECT RAISE(ABORT, 'test order item failure'); END;
  `);

  const response = await worker.fetch(orderRequest(), createEnv(DB));

  assert.equal(response.status, 500);
  assert.equal(sqlite.prepare("SELECT stock FROM products").get().stock, 5);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 0);
});

test("admin orders remain inaccessible without a session", async t => {
  const { sqlite, DB } = createTestDatabase();
  t.after(() => sqlite.close());

  const response = await worker.fetch(
    new Request("https://test.invalid/api/admin/orders"),
    createEnv(DB)
  );

  assert.equal(response.status, 401);
});

test("admin login issues an HttpOnly, Secure, SameSite cookie", async t => {
  const { sqlite, DB } = createTestDatabase();
  t.after(() => sqlite.close());
  const env = createEnv(DB);

  const response = await worker.fetch(new Request("https://test.invalid/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: env.ADMIN_PASSWORD })
  }), env);

  assert.equal(response.status, 200);
  const setCookie = response.headers.get("Set-Cookie");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);

  const me = await worker.fetch(new Request("https://test.invalid/api/admin/me", {
    headers: { Cookie: setCookie.split(";")[0] }
  }), env);
  assert.equal((await me.json()).authenticated, true);
});

test("admin login and checkout reject requests over the rate limit", async t => {
  const { sqlite, DB } = createTestDatabase();
  t.after(() => sqlite.close());
  const env = createEnv(DB, false);
  const login = await worker.fetch(new Request("https://test.invalid/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "wrong-password" })
  }), env);
  const order = await worker.fetch(orderRequest(), env);

  assert.equal(login.status, 429);
  assert.equal(login.headers.get("Retry-After"), "60");
  assert.equal(order.status, 429);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 0);
});

test("missing protection binding fails closed", async t => {
  const { sqlite, DB } = createTestDatabase();
  t.after(() => sqlite.close());
  const env = createEnv(DB);
  delete env.ADMIN_LOGIN_LIMITER;

  const response = await worker.fetch(new Request("https://test.invalid/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "test" })
  }), env);

  assert.equal(response.status, 503);
});
