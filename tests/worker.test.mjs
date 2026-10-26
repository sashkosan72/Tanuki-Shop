import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../src/index.js";
import { SqliteD1 } from "./helpers/sqlite-d1.mjs";

function request(path, { method = "GET", body, headers = {} } = {}) {
  return new Request(`https://tanuki.test${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

function prohibitNetwork(t) {
  // A test can never contact Telegram, Cloudflare or another external service.
  const outbound = t.mock.method(globalThis, "fetch", () => {
    throw new Error("Network requests are forbidden in unit tests.");
  });
  t.after(() => assert.equal(outbound.mock.callCount(), 0, "Worker attempted an outbound request"));
}

function fixture(t) {
  const DB = new SqliteD1();
  t.after(() => DB.close());
  prohibitNetwork(t);
  t.mock.method(console, "error", () => {});
  return { DB };
}

function addProduct(DB, {
  id = "test-manga",
  name = "Тестова манґа",
  category = "Манґа",
  price = 200,
  salePrice = null,
  stock = 10,
  trackStock = 1,
  active = 1
} = {}) {
  DB.sqlite.prepare(`
    INSERT INTO products (id, name, description, category, price, sale_price, stock, track_stock, active)
    VALUES (?, ?, '', ?, ?, ?, ?, ?, ?)
  `).run(id, name, category, price, salePrice, stock, trackStock, active);
  return id;
}

function orderBody(items, extra = {}) {
  return {
    customerName: "Тестовий покупець",
    customerPhone: "+380000000000",
    customerCity: "Тестове місто",
    customerAddress: "Тестова адреса",
    items,
    ...extra
  };
}

function stock(DB, id = "test-manga") {
  return DB.sqlite.prepare("SELECT stock FROM products WHERE id = ?").get(id).stock;
}

function count(DB, table) {
  // Names are fixed by this test file, never supplied by requests.
  assert.ok(["orders", "order_items"].includes(table));
  return DB.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

test("catalogue exposes active products, sale prices and stock availability", async t => {
  const env = fixture(t);
  addProduct(env.DB, { salePrice: 150 });
  addProduct(env.DB, { id: "test-unavailable", name: "Тестова фігурка", category: "Фігурки", stock: 0 });
  addProduct(env.DB, { id: "test-hidden", active: 0 });

  const response = await worker.fetch(request("/api/products"), env);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(result.products.length, 2);
  const manga = result.products.find(product => product.id === "test-manga");
  assert.equal(manga.current_price, 150);
  assert.equal(manga.discount, 25);
  assert.equal(manga.available, true);
  assert.equal(result.products.find(product => product.id === "test-unavailable").available, false);

  const filtered = await worker.fetch(request("/api/products?category=" + encodeURIComponent("Манґа") + "&q=" + encodeURIComponent("манґа")), env);
  assert.deepEqual((await filtered.json()).products.map(product => product.id), ["test-manga"]);
});

test("checkout uses server prices and merges repeated product positions", async t => {
  const env = fixture(t);
  addProduct(env.DB, { salePrice: 150 });
  const response = await worker.fetch(request("/api/orders", {
    method: "POST",
    body: orderBody([
      { id: "test-manga", quantity: 1, price: 1 },
      { id: "test-manga", quantity: 2, price: 1 }
    ], { total: 3, total_amount: 3 })
  }), env);

  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.total_amount, 450);
  assert.match(result.order_number, /^TAN-\d{8}-[A-F0-9]{6}$/);
  assert.equal(stock(env.DB), 7);
  assert.equal(count(env.DB, "orders"), 1);
  assert.equal(count(env.DB, "order_items"), 1);
  const stored = env.DB.sqlite.prepare("SELECT product_name, price, quantity FROM order_items").get();
  assert.deepEqual({ ...stored }, { product_name: "Тестова манґа", price: 150, quantity: 3 });
  const token = env.DB.sqlite.prepare("SELECT token_hash, used_at FROM telegram_link_tokens").get();
  assert.match(token.token_hash, /^[a-f0-9]{64}$/);
  assert.equal(token.used_at, null);
  const rawToken = new URL(result.telegram_link).searchParams.get("start");
  assert.ok(rawToken);
  assert.notEqual(token.token_hash, rawToken);
});

test("insufficient stock rejects checkout without creating orders or changing stock", async t => {
  const env = fixture(t);
  addProduct(env.DB, { stock: 1 });
  const response = await worker.fetch(request("/api/orders", {
    method: "POST",
    body: orderBody([{ id: "test-manga", quantity: 2 }])
  }), env);

  assert.equal(response.status, 400);
  assert.equal((await response.json()).ok, false);
  assert.equal(stock(env.DB), 1);
  assert.equal(count(env.DB, "orders"), 0);
  assert.equal(count(env.DB, "order_items"), 0);
});

test("a later unavailable product restores an earlier stock reservation", async t => {
  const env = fixture(t);
  addProduct(env.DB);
  addProduct(env.DB, { id: "test-hidden", active: 0 });
  const response = await worker.fetch(request("/api/orders", {
    method: "POST",
    body: orderBody([
      { id: "test-manga", quantity: 2 },
      { id: "test-hidden", quantity: 1 }
    ])
  }), env);

  assert.equal(response.status, 400);
  assert.equal(stock(env.DB), 10);
  assert.equal(count(env.DB, "orders"), 0);
});

test("failure inside the order batch rolls back its rows and restores the reservation", async t => {
  const env = fixture(t);
  addProduct(env.DB);
  // Inject a database failure after the header INSERT but before the batch commits.
  env.DB.sqlite.exec(`
    CREATE TEMP TRIGGER fail_test_order_item BEFORE INSERT ON order_items
    BEGIN SELECT RAISE(ABORT, 'Injected unit-test order-item failure'); END;
  `);
  const response = await worker.fetch(request("/api/orders", {
    method: "POST",
    body: orderBody([{ id: "test-manga", quantity: 2 }])
  }), env);

  assert.equal(response.status, 500);
  assert.equal(stock(env.DB), 10);
  assert.equal(count(env.DB, "orders"), 0);
  assert.equal(count(env.DB, "order_items"), 0);
});

test("interleaved checkouts cannot both consume the final available units", async t => {
  const env = fixture(t);
  addProduct(env.DB, { stock: 2 });
  const responses = await Promise.all([1, 2].map(() => worker.fetch(request("/api/orders", {
    method: "POST",
    body: orderBody([{ id: "test-manga", quantity: 2 }])
  }), env)));

  assert.deepEqual(responses.map(response => response.status).sort(), [201, 400]);
  assert.equal(stock(env.DB), 0);
  assert.equal(count(env.DB, "orders"), 1);
});

test("invalid or excessive quantities are rejected without a stock change", async t => {
  const env = fixture(t);
  addProduct(env.DB, { stock: 500 });
  for (const items of [
    [{ id: "test-manga", quantity: 0 }],
    [{ id: "test-manga", quantity: 1.5 }],
    [{ id: "test-manga", quantity: 100 }],
    [{ id: "test-manga", quantity: 60 }, { id: "test-manga", quantity: 60 }]
  ]) {
    const response = await worker.fetch(request("/api/orders", {
      method: "POST", body: orderBody(items)
    }), env);
    assert.equal(response.status, 400);
  }
  assert.equal(stock(env.DB), 500);
  assert.equal(count(env.DB, "orders"), 0);
});

test("admin endpoints reject missing or forged sessions before accessing the database", async t => {
  prohibitNetwork(t);
  const env = {
    ADMIN_PASSWORD: "unit-test-admin-password-only",
    DB: { prepare() { throw new Error("Unauthorised request reached the database"); } }
  };
  for (const [path, method] of [
    ["/api/admin/orders", "GET"],
    ["/api/admin/orders/1", "PATCH"],
    ["/api/admin/products", "POST"],
    ["/api/admin/products/test-manga", "DELETE"],
    ["/api/admin/support", "GET"]
  ]) {
    for (const cookie of ["", "tanuki_admin_session=forged"]) {
      const response = await worker.fetch(request(path, { method, headers: { Cookie: cookie } }), env);
      assert.equal(response.status, 401, `${method} ${path}`);
    }
  }
});

test("Telegram webhook rejects an absent or incorrect secret before touching the database", async t => {
  prohibitNetwork(t);
  const env = {
    TELEGRAM_WEBHOOK_SECRET: "unit-test-webhook-secret-only",
    DB: { prepare() { throw new Error("Unauthorised webhook reached the database"); } }
  };
  for (const secret of ["", "incorrect-secret"]) {
    const response = await worker.fetch(request("/api/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
      body: { message: { text: "/start", chat: { id: 1, type: "private" }, from: { id: 1 } } }
    }), env);
    assert.equal(response.status, 401);
  }
});

test("admin login sets a protected cookie and a modified cookie is rejected", async t => {
  prohibitNetwork(t);
  const env = { ADMIN_PASSWORD: "unit-test-admin-password-only" };
  const response = await worker.fetch(request("/api/admin/login", {
    method: "POST", body: { password: env.ADMIN_PASSWORD }
  }), env);
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("Set-Cookie");
  assert.match(setCookie, /; HttpOnly/);
  assert.match(setCookie, /; Secure/);
  assert.match(setCookie, /; SameSite=Strict/);
  const cookie = setCookie.split(";", 1)[0];
  const authenticated = await worker.fetch(request("/api/admin/me", { headers: { Cookie: cookie } }), env);
  assert.equal((await authenticated.json()).authenticated, true);
  const forged = await worker.fetch(request("/api/admin/me", { headers: { Cookie: cookie + "modified" } }), env);
  assert.equal((await forged.json()).authenticated, false);
});

// Known defects from the audit; these are unimplemented requirements, not passes.
test.todo("retrying checkout with the same idempotency key returns the same order without another stock decrement");
test.todo("a failed read after order commit never restores stock belonging to the persisted order");
test.todo("cancelling an unshipped order releases its reservation exactly once under the agreed stock policy");
