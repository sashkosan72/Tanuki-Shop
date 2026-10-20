import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";

const TEST_TOKEN = "a".repeat(64);

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
      status TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
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
  // Тестуємо саме SQL-міграцію з репозиторію.
  sqlite.exec(readFileSync(new URL("../migrations/0001_customer_auth.sql", import.meta.url), "utf8"));
  sqlite.prepare(`
    INSERT INTO customers(id, email, display_name, password_salt, password_hash, email_verified_at)
    VALUES (1, 'buyer@example.test', 'Покупець', 'placeholder', 'placeholder', CURRENT_TIMESTAMP)
  `).run();
  sqlite.prepare(`
    INSERT INTO customer_sessions(token_hash, customer_id, expires_at)
    VALUES (?, 1, datetime('now', '+7 days'))
  `).run(createHash("sha256").update(TEST_TOKEN).digest("hex"));

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
    CUSTOMER_AUTH_LIMITER: limiter,
    TELEGRAM_BOT_TOKEN: "test-telegram-bot-secret",
    EMAIL_FROM: "noreply@tanukishop.pp.ua",
    EMAIL: {
      messages: [],
      async send(message) { this.messages.push(message); return { messageId: "test-message" }; }
    },
    ADMIN_LOGIN_LIMITER: limiter,
    ORDER_RATE_LIMITER: limiter
  };
}

function orderRequest(items = [{ id: "manga-1", quantity: 2 }]) {
  return new Request("https://test.invalid/api/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "192.0.2.25",
      Cookie: `__Host-tanuki_customer=${TEST_TOKEN}`
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
  assert.equal(sqlite.prepare("SELECT customer_id FROM customer_orders").get().customer_id, 1);
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

function authRequest(path, body, cookie = "") {
  return new Request(`https://test.invalid${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body)
  });
}

test("checkout requires a verified customer session", async t => {
  const { sqlite, DB } = createTestDatabase();
  t.after(() => sqlite.close());
  const guest = orderRequest();
  guest.headers.delete("Cookie");
  const response = await worker.fetch(guest, createEnv(DB));
  assert.equal(response.status, 401);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM orders").get().n, 0);
});

test("email registration, verification, login and logout", async t => {
  const { sqlite, DB } = createTestDatabase();
  t.after(() => sqlite.close());
  const env = createEnv(DB);
  const email = "new@example.test";
  const password = "AReallyLongTestPassword!2026";
  const registration = await worker.fetch(authRequest("/api/auth/register", { name: "Новий покупець", email, password }), env);
  assert.equal(registration.status, 201);
  assert.equal(env.EMAIL.messages.length, 1);
  const row = sqlite.prepare("SELECT * FROM customers WHERE email = ?").get(email);
  assert.ok(row.password_hash);
  assert.equal(row.email_verified_at, null);
  const beforeVerify = await worker.fetch(authRequest("/api/auth/login", { email, password }), env);
  assert.equal(beforeVerify.status, 403);
  const token = /#verify=([a-f0-9]{64})/.exec(env.EMAIL.messages[0].text)[1];
  const verify = await worker.fetch(authRequest("/api/auth/verify", { token }), env);
  assert.equal(verify.status, 200);
  const reused = await worker.fetch(authRequest("/api/auth/verify", { token }), env);
  assert.equal(reused.status, 400);
  const wrongPassword = await worker.fetch(authRequest("/api/auth/login", { email, password: "wrongpassword!!!!" }), env);
  assert.equal(wrongPassword.status, 401);
  const login = await worker.fetch(authRequest("/api/auth/login", { email, password }), env);
  assert.equal(login.status, 200);
  assert.match(login.headers.get("Set-Cookie"), /HttpOnly; Secure; SameSite=Lax/);
  const cookie = login.headers.get("Set-Cookie").split(";")[0];
  const me = await worker.fetch(new Request("https://test.invalid/api/auth/me", { headers: { Cookie: cookie } }), env);
  assert.equal((await me.json()).user.email, email);
  const logout = await worker.fetch(authRequest("/api/auth/logout", {}, cookie), env);
  assert.equal(logout.status, 200);
  const after = await worker.fetch(new Request("https://test.invalid/api/auth/me", { headers: { Cookie: cookie } }), env);
  assert.equal((await after.json()).authenticated, false);
});

test("Telegram login verifies HMAC and rejects altered, stale or unsigned data", async t => {
  const { sqlite, DB } = createTestDatabase();
  t.after(() => sqlite.close());
  const env = createEnv(DB);
  const payload = { id: 123456, first_name: "Танукі", auth_date: Math.floor(Date.now() / 1000) };
  const content = Object.keys(payload).sort().map(key => `${key}=${payload[key]}`).join("\n");
  const signatureKey = createHash("sha256").update(env.TELEGRAM_BOT_TOKEN).digest();
  payload.hash = createHmac("sha256", signatureKey).update(content).digest("hex");
  const response = await worker.fetch(authRequest("/api/auth/telegram", payload), env);
  assert.equal(response.status, 200);
  assert.equal(sqlite.prepare("SELECT telegram_id FROM customers WHERE telegram_id = ?").get("123456").telegram_id, "123456");
  const tampered = await worker.fetch(authRequest("/api/auth/telegram", { ...payload, first_name: "Зловмисник" }), env);
  assert.equal(tampered.status, 401);
  const unsigned = await worker.fetch(authRequest("/api/auth/telegram", { ...payload, hash: "0".repeat(64) }), env);
  assert.equal(unsigned.status, 401);
  const stale = await worker.fetch(authRequest("/api/auth/telegram", { ...payload, auth_date: 1 }), env);
  assert.equal(stale.status, 401);
});

test("account order history is private and linked to the correct customer", async t => {
  const { sqlite, DB } = createTestDatabase();
  t.after(() => sqlite.close());
  const env = createEnv(DB);
  await worker.fetch(orderRequest(), env);
  const guest = await worker.fetch(new Request("https://test.invalid/api/account/orders"), env);
  assert.equal(guest.status, 401);
  const authorized = await worker.fetch(new Request("https://test.invalid/api/account/orders", {
    headers: { Cookie: `__Host-tanuki_customer=${TEST_TOKEN}` }
  }), env);
  const data = await authorized.json();
  assert.equal(authorized.status, 200);
  assert.equal(data.orders.length, 1);
  assert.equal(data.orders[0].items[0].quantity, 2);
  sqlite.prepare(`INSERT INTO customers(id, telegram_id, display_name) VALUES (2, '777', 'Інший')`).run();
  const otherToken = "b".repeat(64);
  sqlite.prepare(`INSERT INTO customer_sessions(token_hash, customer_id, expires_at)
    VALUES (?, 2, datetime('now', '+7 days'))`).run(createHash("sha256").update(otherToken).digest("hex"));
  const other = await worker.fetch(new Request("https://test.invalid/api/account/orders", {
    headers: { Cookie: `__Host-tanuki_customer=${otherToken}` }
  }), env);
  assert.equal((await other.json()).orders.length, 0);
});

test("customer authentication is rate limited and email setup is fail-closed", async t => {
  const { sqlite, DB } = createTestDatabase();
  t.after(() => sqlite.close());
  const env = createEnv(DB, false);
  const throttled = await worker.fetch(authRequest("/api/auth/register", {
    email: "example@example.test", password: "LongEnoughPassword1!"
  }), env);
  assert.equal(throttled.status, 429);
  env.CUSTOMER_AUTH_LIMITER = { async limit() { return { success: true }; } };
  delete env.EMAIL;
  const missingEmail = await worker.fetch(authRequest("/api/auth/register", {
    email: "example@example.test", password: "LongEnoughPassword1!"
  }), env);
  assert.equal(missingEmail.status, 503);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM customers").get().n, 1);
  const crossOrigin = await worker.fetch(new Request("https://test.invalid/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://another.invalid" },
    body: JSON.stringify({ email: "buyer@example.test", password: "guess" })
  }), env);
  assert.equal(crossOrigin.status, 403);
});
