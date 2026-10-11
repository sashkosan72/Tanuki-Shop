
const PRODUCTS = {
  "tanuki-plush": { name: "Tanuki Plush", price: 499 },
  "kawaii-stickers": { name: "Kawaii Sticker Pack", price: 149 },
  "kawaii-accessory": { name: "Kawaii Accessory", price: 299 }
};

const ADMIN_SESSION_SECONDS = 8 * 60 * 60;

const ORDER_STATUSES = [
  "new",
  "confirmed",
  "shipped",
  "completed",
  "cancelled"
];

const TELEGRAM_STATUS = {
  confirmed: "Підтверджено",
  shipped: "Відправлено",
  cancelled: "Скасовано"
};

// ================================
// HELPERS
// ================================

function json(data, status = 200, headers = {}) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...headers
    }
  });
}

function cleanText(value, maxLength = 300) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

// ================================
// TELEGRAM API
// ================================

async function telegramCall(env, method, data) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("Telegram token is missing");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(10000)
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(`Telegram ${method} failed`);
  }

  return result;
}

async function configureTelegramWebhook(env) {
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    throw new Error("Webhook secret is missing");
  }

  return telegramCall(env, "setWebhook", {
    url: "https://tanukishop.pp.ua/api/telegram/webhook",
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["callback_query"]
  });
}

async function notifyTelegram(env, order) {
  if (!env.TELEGRAM_CHAT_ID) {
    console.error("TELEGRAM_CHAT_ID is missing");
    return;
  }

  const products = order.items.map(item =>
    `• ${escapeHtml(item.name)} × ${item.quantity} — ${item.price * item.quantity} ₴`
  );

  const message = [
    "🛍️ <b>Нове замовлення Tanuki Shop!</b>",
    "",
    `<b>Номер:</b> ${escapeHtml(order.orderNumber)}`,
    `<b>Покупець:</b> ${escapeHtml(order.customerName)}`,
    `<b>Телефон:</b> ${escapeHtml(order.customerPhone)}`,
    `<b>Місто:</b> ${escapeHtml(order.customerCity)}`,
    `<b>Адреса:</b> ${escapeHtml(order.customerAddress)}`,
    "",
    "<b>Товари:</b>",
    ...products,
    "",
    `<b>Сума:</b> ${order.total} ₴`,
    `<b>Коментар:</b> ${escapeHtml(order.customerComment || "Немає")}`,
    "",
    "<b>Статус:</b> Нове замовлення"
  ].join("\n");

  try {
    await configureTelegramWebhook(env);

    await telegramCall(env, "sendMessage", {
      chat_id: env.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✅ Підтвердити",
              callback_data: `tanuki:${order.id}:confirmed`
            }
          ],
          [
            {
              text: "📦 Відправлено",
              callback_data: `tanuki:${order.id}:shipped`
            }
          ],
          [
            {
              text: "❌ Скасувати",
              callback_data: `tanuki:${order.id}:cancelled`
            }
          ]
        ]
      }
    });
  } catch (error) {
    console.error("Telegram notification error:", error);
  }
}

// ================================
// TELEGRAM WEBHOOK
// ================================

async function handleTelegramWebhook(request, env) {
  const receivedSecret = request.headers.get(
    "X-Telegram-Bot-Api-Secret-Token"
  );

  if (
    !env.TELEGRAM_WEBHOOK_SECRET ||
    receivedSecret !== env.TELEGRAM_WEBHOOK_SECRET
  ) {
    return json({ ok: false }, 401);
  }

  let update;

  try {
    update = await request.json();
  } catch {
    return json({ ok: false }, 400);
  }

  const callback = update.callback_query;

  if (!callback) {
    return json({ ok: true });
  }

  const expectedChat = String(env.TELEGRAM_CHAT_ID || "");
  const actualChat = String(callback.message?.chat?.id || "");
  const actualUser = String(callback.from?.id || "");

  // Ця перевірка розрахована на приватний чат із ботом.
  if (
    !expectedChat ||
    actualChat !== expectedChat ||
    actualUser !== expectedChat
  ) {
    await telegramCall(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "У вас немає дозволу.",
      show_alert: true
    }).catch(error => console.error(error));

    return json({ ok: true });
  }

  const match = String(callback.data || "").match(
    /^tanuki:(\d+):(confirmed|shipped|cancelled)$/
  );

  if (!match) {
    await telegramCall(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Невідома дія."
    }).catch(error => console.error(error));

    return json({ ok: true });
  }

  const orderId = Number(match[1]);
  const status = match[2];

  try {
    const result = await env.DB.prepare(`
      UPDATE orders
      SET status = ?
      WHERE id = ?
    `).bind(status, orderId).run();

    if (!result.meta || result.meta.changes === 0) {
      await telegramCall(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Замовлення не знайдено.",
        show_alert: true
      });

      return json({ ok: true });
    }

    await telegramCall(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: `Статус: ${TELEGRAM_STATUS[status]}`
    });

    const originalText = callback.message?.text || "";

    const cleanMessage = originalText.replace(
      /\n\n<b>Статус:<\/b>.*$/s,
      ""
    );

    await telegramCall(env, "editMessageText", {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      text: cleanMessage +
        `\n\n<b>Статус:</b> ${TELEGRAM_STATUS[status]}`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: []
      }
    });
  } catch (error) {
    console.error("Telegram webhook error:", error);

    await telegramCall(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Не вдалося оновити статус.",
      show_alert: true
    }).catch(err => console.error(err));
  }

  return json({ ok: true });
}

// ================================
// ADMIN SESSION
// ================================

function base64UrlEncode(bytes) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function signSession(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value)
  );

  return base64UrlEncode(new Uint8Array(signature));
}

function constantTimeEqual(a, b) {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);

  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);

  for (let i = 0; i < length; i++) {
    difference |= (left[i] || 0) ^ (right[i] || 0);
  }

  return difference === 0;
}

function getCookie(request, name) {
  const cookies = request.headers.get("Cookie") || "";

  for (const part of cookies.split(";")) {
    const separator = part.indexOf("=");

    if (separator === -1) continue;

    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }

  return "";
}

async function createSession(secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  const payload = `${timestamp}.${nonce}`;
  const signature = await signSession(payload, secret);

  return `${payload}.${signature}`;
}

async function verifySession(request, secret) {
  if (!secret) return false;

  const token = getCookie(request, "tanuki_admin_session");
  const parts = token.split(".");

  if (parts.length !== 3) return false;

  const [timestampText, nonce, signature] = parts;
  const timestamp = Number(timestampText);
  const now = Math.floor(Date.now() / 1000);

  if (
    !Number.isInteger(timestamp) ||
    !nonce ||
    !signature ||
    timestamp > now + 60 ||
    now - timestamp > ADMIN_SESSION_SECONDS
  ) {
    return false;
  }

  const expected = await signSession(
    `${timestampText}.${nonce}`,
    secret
  );

  return constantTimeEqual(signature, expected);
}

// ================================
// CREATE ORDER
// ================================

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

    total += product.price * quantity;

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

    await notifyTelegram(env, {
      id: orderId,
      orderNumber,
      customerName,
      customerPhone,
      customerCity,
      customerAddress,
      customerComment,
      total,
      items
    });

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
      error: "Не вдалося зберегти замовлення"
    }, 500);
  }
}

// ================================
// ADMIN API
// ================================

async function handleAdmin(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  const secret = env.ADMIN_PASSWORD;

  if (!secret) {
    return json({
      ok: false,
      error: "ADMIN_PASSWORD is not configured"
    }, 500);
  }

  if (path === "/api/admin/login" && method === "POST") {
    let body;

    try {
      body = await request.json();
    } catch {
      return json({
        ok: false,
        error: "Некоректний запит"
      }, 400);
    }

    const password =
      typeof body.password === "string"
        ? body.password
        : "";

    if (!constantTimeEqual(password, secret)) {
      return json({
        ok: false,
        error: "Неправильний пароль"
      }, 401);
    }

    const token = await createSession(secret);

    return json({
      ok: true,
      message: "Вхід успішний"
    }, 200, {
      "Set-Cookie":
        `tanuki_admin_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/api/admin; Max-Age=${ADMIN_SESSION_SECONDS}`
    });
  }

  if (path === "/api/admin/logout" && method === "POST") {
    return json({
      ok: true,
      message: "Ви вийшли з адмін-панелі"
    }, 200, {
      "Set-Cookie":
        "tanuki_admin_session=; HttpOnly; Secure; SameSite=Strict; Path=/api/admin; Max-Age=0"
    });
  }

  if (path === "/api/admin/me" && method === "GET") {
    const authenticated = await verifySession(request, secret);

    return json({
      ok: true,
      authenticated
    });
  }

  const authenticated = await verifySession(request, secret);

  if (!authenticated) {
    return json({
      ok: false,
      error: "Потрібно увійти в адмін-панель"
    }, 401);
  }

  if (path === "/api/admin/orders" && method === "GET") {
    try {
      const result = await env.DB.prepare(`
        SELECT
          id,
          order_number,
          customer_name,
          customer_phone,
          customer_city,
          customer_address,
          customer_comment,
          total_amount,
          status,
          created_at
        FROM orders
        ORDER BY created_at DESC, id DESC
        LIMIT 100
      `).all();

      const orders = result.results || [];

      if (orders.length === 0) {
        return json({
          ok: true,
          orders: []
        });
      }

      const placeholders = orders.map(() => "?").join(",");

      const itemResult = await env.DB.prepare(`
        SELECT
          order_id,
          product_id,
          product_name,
          price,
          quantity
        FROM order_items
        WHERE order_id IN (${placeholders})
        ORDER BY id ASC
      `).bind(
        ...orders.map(order => order.id)
      ).all();

      const itemsByOrder = {};

      for (const item of itemResult.results || []) {
        if (!itemsByOrder[item.order_id]) {
          itemsByOrder[item.order_id] = [];
        }

        itemsByOrder[item.order_id].push({
          product_id: item.product_id,
          product_name: item.product_name,
          price: item.price,
          quantity: item.quantity
        });
      }

      return json({
        ok: true,
        orders: orders.map(order => ({
          ...order,
          items: itemsByOrder[order.id] || []
        }))
      });
    } catch (error) {
      console.error("Admin orders error:", error);

      return json({
        ok: false,
        error: "Не вдалося завантажити замовлення"
      }, 500);
    }
  }

  const statusMatch = path.match(
    /^\/api\/admin\/orders\/(\d+)\/status$/
  );

  if (statusMatch && method === "PATCH") {
    const orderId = Number(statusMatch[1]);

    if (!Number.isSafeInteger(orderId) || orderId <= 0) {
      return json({
        ok: false,
        error: "Некоректний номер замовлення"
      }, 400);
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return json({
        ok: false,
        error: "Некоректний формат запиту"
      }, 400);
    }

    const status = cleanText(body.status, 30);

    if (!ORDER_STATUSES.includes(status)) {
      return json({
        ok: false,
        error: "Невідомий статус замовлення"
      }, 400);
    }

    try {
      const result = await env.DB.prepare(`
        UPDATE orders
        SET status = ?
        WHERE id = ?
      `).bind(status, orderId).run();

      if (!result.meta || result.meta.changes === 0) {
        return json({
          ok: false,
          error: "Замовлення не знайдено"
        }, 404);
      }

      return json({
        ok: true,
        message: "Статус замовлення оновлено",
        status
      });
    } catch (error) {
      console.error("Admin status update error:", error);

      return json({
        ok: false,
        error: "Не вдалося змінити статус"
      }, 500);
    }
  }

  return json({
    ok: false,
    error: "Admin API endpoint not found"
  }, 404);
}

// ================================
// MAIN WORKER
// ================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!env.DB || !env.ASSETS) {
      return json({
        ok: false,
        error: "Worker bindings are not configured"
      }, 500);
    }

    if (
      url.pathname === "/api/telegram/webhook" &&
      request.method === "POST"
    ) {
      return handleTelegramWebhook(request, env);
    }

    if (
      (url.pathname === "/admin" ||
       url.pathname === "/admin/") &&
      request.method === "GET"
    ) {
      const adminUrl = new URL("/admin/index.html", url);

      return env.ASSETS.fetch(
        new Request(adminUrl, request)
      );
    }

    if (
      url.pathname === "/api/health" &&
      request.method === "GET"
    ) {
      return json({
        ok: true,
        service: "Tanuki Shop",
        database: "connected"
      });
    }

    if (
      url.pathname === "/api/orders" &&
      request.method === "POST"
    ) {
      return createOrder(request, env);
    }

    if (url.pathname.startsWith("/api/admin/")) {
      return handleAdmin(request, env, url);
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
