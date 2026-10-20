import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../src/index.js";
import { SqliteD1 } from "./helpers/sqlite-d1.mjs";

function request(path, method, body, cookie = "") {
  return new Request(`https://tanuki.test${path}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body)
  });
}

async function fixture(t) {
  const DB = new SqliteD1();
  t.after(() => DB.close());
  const network = t.mock.method(globalThis, "fetch", () => {
    throw new Error("Network requests are forbidden in product-validation tests.");
  });
  t.after(() => assert.equal(network.mock.callCount(), 0));
  const env = { DB, ADMIN_PASSWORD: "unit-test-product-password-only" };
  const login = await worker.fetch(request("/api/admin/login", "POST", {
    password: env.ADMIN_PASSWORD
  }), env);
  assert.equal(login.status, 200);
  const cookie = login.headers.get("Set-Cookie").split(";", 1)[0];
  return { env, cookie };
}

function product(extra = {}) {
  return {
    id: "test-product",
    name: "Тестовий товар",
    category: "Манґа",
    price: 200,
    stock: 5,
    track_stock: true,
    ...extra
  };
}

function stored(DB) {
  return DB.sqlite.prepare("SELECT * FROM products ORDER BY id").all().map(row => ({ ...row }));
}

function changes(DB) {
  return DB.sqlite.prepare("SELECT total_changes() AS count").get().count;
}

test("create and update reject invalid sale prices without changing product data", async t => {
  const { env, cookie } = await fixture(t);
  const invalidPrices = ["not-a-price", 0, -1, 1.5, 100000001, 200, 201];

  for (const salePrice of invalidPrices) {
    const before = stored(env.DB);
    const beforeChanges = changes(env.DB);
    const response = await worker.fetch(request("/api/admin/products", "POST", product({
      sale_price: salePrice
    }), cookie), env);
    assert.equal(response.status, 400, `create sale_price=${JSON.stringify(salePrice)}`);
    assert.equal((await response.json()).ok, false);
    assert.deepEqual(stored(env.DB), before);
    assert.equal(changes(env.DB), beforeChanges);
  }

  const created = await worker.fetch(request("/api/admin/products", "POST", product({
    sale_price: 150
  }), cookie), env);
  assert.equal(created.status, 201);

  for (const salePrice of invalidPrices) {
    const before = stored(env.DB);
    const beforeChanges = changes(env.DB);
    const response = await worker.fetch(request("/api/admin/products/test-product", "PATCH", {
      sale_price: salePrice
    }, cookie), env);
    assert.equal(response.status, 400, `update sale_price=${JSON.stringify(salePrice)}`);
    assert.equal((await response.json()).ok, false);
    assert.deepEqual(stored(env.DB), before);
    assert.equal(changes(env.DB), beforeChanges);
  }
});

test("create allows an omitted, null or empty sale price as a regular-price product", async t => {
  const { env, cookie } = await fixture(t);

  for (const [index, extra] of [{}, { sale_price: null }, { sale_price: "" }].entries()) {
    const id = `test-regular-${index}`;
    const response = await worker.fetch(request("/api/admin/products", "POST", product({
      id,
      ...extra
    }), cookie), env);
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.product.sale_price, null);
    assert.equal(result.product.current_price, 200);
    const row = env.DB.sqlite.prepare("SELECT sale_price, price FROM products WHERE id = ?").get(id);
    assert.deepEqual({ ...row }, { sale_price: null, price: 200 });
  }
});

test("a valid lower sale price is persisted by create and update", async t => {
  const { env, cookie } = await fixture(t);
  const created = await worker.fetch(request("/api/admin/products", "POST", product({
    sale_price: 150
  }), cookie), env);
  assert.equal(created.status, 201);
  assert.equal((await created.json()).product.current_price, 150);
  assert.equal(stored(env.DB)[0].sale_price, 150);

  const updated = await worker.fetch(request("/api/admin/products/test-product", "PATCH", {
    sale_price: 175
  }, cookie), env);
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).product.current_price, 175);
  assert.equal(stored(env.DB)[0].sale_price, 175);
});

test("update preserves an omitted discount and clears it for null or an empty string", async t => {
  const { env, cookie } = await fixture(t);
  const created = await worker.fetch(request("/api/admin/products", "POST", product({
    sale_price: 150
  }), cookie), env);
  assert.equal(created.status, 201);

  const preserved = await worker.fetch(request("/api/admin/products/test-product", "PATCH", {
    name: "Оновлений тестовий товар"
  }, cookie), env);
  assert.equal(preserved.status, 200);
  assert.equal(stored(env.DB)[0].sale_price, 150);

  for (const salePrice of [null, ""]) {
    const restored = await worker.fetch(request("/api/admin/products/test-product", "PATCH", {
      sale_price: 150
    }, cookie), env);
    assert.equal(restored.status, 200);
    const cleared = await worker.fetch(request("/api/admin/products/test-product", "PATCH", {
      sale_price: salePrice
    }, cookie), env);
    assert.equal(cleared.status, 200);
    assert.equal((await cleared.json()).product.current_price, 200);
    assert.equal(stored(env.DB)[0].sale_price, null);
  }
});
