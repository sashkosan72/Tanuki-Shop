
const PRODUCTS = {
  "tanuki-plush": {
    name: "Tanuki Plush",
    price: 499
  },
  "kawaii-stickers": {
    name: "Kawaii Sticker Pack",
    price: 149
  },
  "kawaii-accessory": {
    name: "Kawaii Accessory",
    price: 299
  }
};

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}

function cleanText(value, maxLength = 300) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

async function createOrder(request, env) {
  let body;

  try {
    body = await request.json();
  } catch {
    return json({
      ok: false,
      error: "Некоректний формат запиту"
    }, 400);
  }

  const customerName = cleanText(body.customerName, 100);
  const customerPhone = cleanText(body.customerPhone, 40);
  const customerCity = cleanText(body.customerCity, 100);
  const customerAddress = cleanText(body.customerAddress, 200);
  const customerComment = cleanText(body.customerComment, 1000);

  if (
    !customerName ||
    !customerPhone ||
    !customerCity ||
    !customerAddress
  ) {
    return json({
      ok: false,
      error: "Заповніть усі обов'язкові поля"
    }, 400);
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return json({
      ok: false,
      error: "Кошик порожній"
    }, 400);
  }

  if (body.items.length > 30) {
    return json({
      ok: false,
      error: "Забагато різних товарів"
    }, 400);
  }

  const items = [];
  let total = 0;

  for (const item of body.items) {
    const product = PRODUCTS[item.id];
    const quantity = Number(item.quantity);

    if (
      !product ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 50
    ) {
      return json({
        ok: false,
        error: "Некоректний товар або кількість"
      }, 400);
    }

    const itemTotal = product.price * quantity;
    total += itemTotal;

    items.push({
      id: item.id,
      name: product.name,
      price: product.price,
      quantity
    });
  }

  if (!Number.isSafeInteger(total) || total <= 0) {
    return json({
      ok: false,
      error: "Некоректна сума замовлення"
    }, 400);
  }

  const orderNumber =
    "TS-" +
    Date.now().toString(36).toUpperCase() +
    "-" +
    crypto.randomUUID().slice(0, 6).toUpperCase();

  let orderId;

  try {
    const insertedOrder = await env.DB.prepare(`
      INSERT INTO orders (
        order_number,
        customer_name,
        customer_phone,
        customer_city,
        customer_address,
        customer_comment,
        total_amount,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'new')
      RETURNING id
    `).bind(
      orderNumber,
      customerName,
      customerPhone,
      customerCity,
      customerAddress,
      customerComment,
      total
    ).first();

    if (!insertedOrder) {
      throw new Error("Не вдалося створити замовлення");
    }

    orderId = insertedOrder.id;

    const statements = items.map(item =>
      env.DB.prepare(`
        INSERT INTO order_items (
          order_id,
          product_id,
          product_name,
          price,
          quantity
        )
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        orderId,
        item.id,
        item.name,
        item.price,
        item.quantity
      )
    );

    await env.DB.batch(statements);

    return json({
      ok: true,
      orderNumber,
      total,
      message: "Замовлення успішно збережено"
    }, 201);

  } catch (error) {
    console.error("Order creation error:", error);

    if (orderId) {
      try {
        await env.DB.prepare(
          "DELETE FROM orders WHERE id = ?"
        ).bind(orderId).run();
      } catch (cleanupError) {
        console.error("Order cleanup error:", cleanupError);
      }
    }

    return json({
      ok: false,
      error: "Не вдалося зберегти замовлення. Спробуйте пізніше."
    }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!env.DB || !env.ASSETS) {
      return json({
        ok: false,
        error: "Worker bindings are not configured"
      }, 500);
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({
        ok: true,
        service: "Tanuki Shop",
        database: "connected"
      });
    }

    if (url.pathname === "/api/orders" && request.method === "POST") {
      return createOrder(request, env);
    }

    if (url.pathname.startsWith("/api/")) {
      return json({
        ok: false,
        error: "API endpoint not found"
      }, 404);
    }

    return env.ASSETS.fetch(request);
  }
};
