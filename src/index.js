
const PRODUCTS = {
  "tanuki-plush": { name: "Tanuki Plush", price: 499 },
  "kawaii-stickers": { name: "Kawaii Sticker Pack", price: 149 },
  "kawaii-accessory": { name: "Kawaii Accessory", price: 299 }
};

const ADMIN_SESSION_SECONDS = 8 * 60 * 60;
const ADMIN_COOKIE = "tanuki_admin_session";

const ORDER_STATUSES = [
  "new",
  "confirmed",
  "shipped",
  "completed",
  "cancelled"
];

const STATUS_LABELS = {
  new: "Нове",
  confirmed: "Підтверджено",
  shipped: "Відправлено",
  completed: "Завершено",
  cancelled: "Скасовано"
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers
    }
  });
}

function cleanText(value, maxLength = 1000) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookies = cookieHeader.split(";");

  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator === -1) continue;

    const key = cookie.slice(0, separator).trim();
    const value = cookie.slice(separator + 1).trim();

    if (key === name) return decodeURIComponent(value);
  }

  return null;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);

  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function hmacSign(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value)
  );

  return bytesToBase64Url(new Uint8Array(signature));
}

async function createAdminSession(secret) {
  const expiresAt = Math.floor(Date.now() / 1000) + ADMIN_SESSION_SECONDS;
  const payload = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify({ exp: expiresAt }))
  );

  const signature = await hmacSign(secret, payload);

  return `${payload}.${signature}`;
}

async function verifyAdminSession(secret, token) {
  if (!secret || !token || !token.includes(".")) return false;

  try {
    const [payload, signature] = token.split(".");
    if (!payload || !signature) return false;

    const expected = await hmacSign(secret, payload);

    const a = new TextEncoder().encode(signature);
    const b = new TextEncoder().encode(expected);

    if (a.length !== b.length) return false;

    let difference = 0;
    for (let i = 0; i < a.length; i++) {
      difference |= a[i] ^ b[i];
    }

    if (difference !== 0) return false;

    const data = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(payload))
    );

    return Number(data.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

async function isAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) return false;

  const token = getCookie(request, ADMIN_COOKIE);
  return verifyAdminSession(env.ADMIN_PASSWORD, token);
}

function adminCookie(value, maxAge = ADMIN_SESSION_SECONDS) {
  return `${ADMIN_COOKIE}=${encodeURIComponent(value)}; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

async function telegramCall(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }
  );

  const result = await response.json().catch(() => null);

  if (!response.ok || !result?.ok) {
    const description = result?.description || `HTTP ${response.status}`;
    console.error("Telegram API error:", method, description);
    throw new Error(description);
  }

  return result.result;
}

async function configureTelegramWebhook(env) {
  if (
    !env.TELEGRAM_BOT_TOKEN ||
    !env.TELEGRAM_WEBHOOK_SECRET
  ) {
    return;
  }

  const webhookUrl = "https://tanukishop.pp.ua/api/telegram/webhook";

  await telegramCall(env, "setWebhook", {
    url: webhookUrl,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["callback_query"]
  });
}

async function notifyTelegram(env, order) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.warn("Telegram notification skipped: missing configuration");
    return;
  }

  // Помилка налаштування webhook не повинна блокувати повідомлення.
  try {
    await configureTelegramWebhook(env);
  } catch (error) {
    console.error("Telegram webhook configuration failed:", error.message);
  }

  const message = [
    "🛍 <b>Нове замовлення Tanuki Shop!</b>",
    "",
    `<b>Замовлення:</b> #${escapeHtml(order.order_number)}`,
    `<b>Ім'я:</b> ${escapeHtml(order.customer_name)}`,
    `<b>Телефон:</b> ${escapeHtml(order.customer_phone)}`,
    `<b>Місто:</b> ${escapeHtml(order.customer_city)}`,
    `<b>Адреса:</b> ${escapeHtml(order.customer_address || "Не вказано")}`,
    "",
    "<b>Товари:</b>",
    ...order.items.map(item =>
      `• ${escapeHtml(item.product_name)} × ${item.quantity} — ${item.price * item.quantity} грн`
    ),
    "",
    `<b>Разом:</b> ${order.total_amount} грн`,
    `<b>Коментар:</b> ${escapeHtml(order.customer_comment || "Немає")}`,
    "",
    "<b>Статус:</b> Нове"
  ].join("\n");

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: "✅ Підтвердити",
          callback_data: `tanuki:${order.id}:confirmed`
        },
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
  };

  try {
    await telegramCall(env, "sendMessage", {
      chat_id: env.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "HTML",
      reply_markup: keyboard
    });
  } catch (error) {
    console.error("Telegram order notification failed:", error.message);
  }
}

async function handleTelegramWebhook(request, env) {
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ ok: false, error: "Webhook secret is not configured" }, 503);
  }

  const suppliedSecret = request.headers.get(
    "X-Telegram-Bot-Api-Secret-Token"
  );

  if (suppliedSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  let update;

  try {
    update = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const callback = update.callback_query;

  if (!callback) {
    return json({ ok: true });
  }

  const chatId = String(callback.message?.chat?.id ?? "");
  const userId = String(callback.from?.id ?? "");
  const allowedChatId = String(env.TELEGRAM_CHAT_ID ?? "");

  if (!allowedChatId || chatId !== allowedChatId || userId !== allowedChatId) {
    try {
      await telegramCall(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Немає доступу до керування замовленнями.",
        show_alert: true
      });
    } catch (error) {
      console.error("Telegram callback response failed:", error.message);
    }

    return json({ ok: true });
  }

  const match = String(callback.data || "").match(
    /^tanuki:(\d+):(confirmed|shipped|cancelled)$/
  );

  if (!match) {
    return json({ ok: true });
  }

  const orderId = Number(match[1]);
  const newStatus = match[2];

  try {
    const result = await env.DB.prepare(
      "UPDATE orders SET status = ? WHERE id = ?"
    ).bind(newStatus, orderId).run();

    if (!result.meta?.changes) {
      await telegramCall(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Замовлення не знайдено.",
        show_alert: true
      });

      return json({ ok: true });
    }

    const label = STATUS_LABELS[newStatus];

    await telegramCall(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: `Статус змінено: ${label}`
    });

    const oldText = String(callback.message?.text || "")
      .replace(/\n\nСтатус:.*$/s, "");

    const updatedText = `${oldText}\n\n<b>Статус:</b> ${escapeHtml(label)}`;

    await telegramCall(env, "editMessageText", {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      text: updatedText,
      parse_mode: "HTML"
    });

  } catch (error) {
    console.error("Telegram order status update failed:", error.message);

    try {
      await telegramCall(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Не вдалося змінити статус.",
        show_alert: true
      });
    } catch (callbackError) {
      console.error("Telegram callback error:", callbackError.message);
    }
  }

  return json({ ok: true });
}

async function createOrder(request, env) {
  let body;

  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Некоректні дані замовлення." }, 400);
  }

  const customerName = cleanText(body.customer_name || body.name, 120);
  const customerPhone = cleanText(body.customer_phone || body.phone, 50);
  const customerCity = cleanText(body.customer_city || body.city, 120);
  const customerAddress = cleanText(body.customer_address || body.address, 300);
  const customerComment = cleanText(body.customer_comment || body.comment, 1000);

  if (!customerName || !customerPhone || !customerCity) {
    return json({
      ok: false,
      error: "Вкажіть ім'я, телефон та місто."
    }, 400);
  }

  const rawItems = Array.isArray(body.items) ? body.items : [];

  if (!rawItems.length || rawItems.length > 30) {
    return json({ ok: false, error: "Кошик порожній або некоректний." }, 400);
  }

  const items = [];

  for (const rawItem of rawItems) {
    const productId = cleanText(
      rawItem.product_id || rawItem.productId || rawItem.id,
      100
    );

    const product = PRODUCTS[productId];
    const quantity = Number(rawItem.quantity);

    if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      return json({
        ok: false,
        error: "Один із товарів у кошику некоректний."
      }, 400);
    }

    items.push({
      product_id: productId,
      product_name: product.name,
      price: product.price,
      quantity
    });
  }

  const totalAmount = items.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0
  );

  const orderNumber = `TNK-${Date.now().toString().slice(-9)}`;

  let orderId;

  try {
    const result = await env.DB.prepare(`
      INSERT INTO orders (
        order_number,
        customer_name,
        customer_phone,
        customer_city,
        customer_address,
        customer_comment,
        total_amount,
        status,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      orderNumber,
      customerName,
      customerPhone,
      customerCity,
      customerAddress,
      customerComment,
      totalAmount,
      "new",
      new Date().toISOString()
    ).run();

    orderId = result.meta?.last_row_id;

    if (!orderId) {
      throw new Error("Database did not return the new order ID");
    }

    const statements = items.map(item =>
      env.DB.prepare(`
        INSERT INTO order_items (
          order_id,
          product_id,
          product_name,
          price,
          quantity
        ) VALUES (?, ?, ?, ?, ?)
      `).bind(
        orderId,
        item.product_id,
        item.product_name,
        item.price,
        item.quantity
      )
    );

    await env.DB.batch(statements);

  } catch (error) {
    console.error("Order creation failed:", error.message);

    if (orderId) {
      try {
        await env.DB.prepare(
          "DELETE FROM orders WHERE id = ?"
        ).bind(orderId).run();
      } catch (cleanupError) {
        console.error("Order cleanup failed:", cleanupError.message);
      }
    }

    return json({
      ok: false,
      error: "Не вдалося створити замовлення. Спробуйте ще раз."
    }, 500);
  }

  const order = {
    id: orderId,
    order_number: orderNumber,
    customer_name: customerName,
    customer_phone: customerPhone,
    customer_city: customerCity,
    customer_address: customerAddress,
    customer_comment: customerComment,
    total_amount: totalAmount,
    items
  };

  await notifyTelegram(env, order);

  return json({
    ok: true,
    order_id: orderId,
    order_number: orderNumber,
    total_amount: totalAmount,
    message: "Замовлення успішно оформлено!"
  }, 201);
}

async function handleAdmin(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/admin/login" && method === "POST") {
    let body;

    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "Некоректний запит." }, 400);
    }

    if (!env.ADMIN_PASSWORD) {
      return json({
        ok: false,
        error: "Пароль адміністратора не налаштований."
      }, 503);
    }

    if (body.password !== env.ADMIN_PASSWORD) {
      return json({
        ok: false,
        error: "Неправильний пароль."
      }, 401);
    }

    const session = await createAdminSession(env.ADMIN_PASSWORD);

    return json(
      { ok: true, message: "Вхід виконано." },
      200,
      { "Set-Cookie": adminCookie(session) }
    );
  }

  if (path === "/api/admin/logout" && method === "POST") {
    return json(
      { ok: true },
      200,
      { "Set-Cookie": adminCookie("", 0) }
    );
  }

  if (path === "/api/admin/me" && method === "GET") {
    const authenticated = await isAdmin(request, env);
    return json({ ok: true, authenticated });
  }

  if (!(await isAdmin(request, env))) {
    return json({ ok: false, error: "Потрібна авторизація." }, 401);
  }

  if (path === "/api/admin/orders" && method === "GET") {
    try {
      const ordersResult = await env.DB.prepare(`
        SELECT *
        FROM orders
        ORDER BY created_at DESC
        LIMIT 200
      `).all();

      const orders = ordersResult.results || [];

      for (const order of orders) {
        const itemsResult = await env.DB.prepare(`
          SELECT *
          FROM order_items
          WHERE order_id = ?
        `).bind(order.id).all();

        order.items = itemsResult.results || [];
      }

      return json({ ok: true, orders });
    } catch (error) {
      console.error("Admin orders loading failed:", error.message);
      return json({
        ok: false,
        error: "Не вдалося завантажити замовлення."
      }, 500);
    }
  }

  const statusMatch = path.match(/^\/api\/admin\/orders\/(\d+)\/status$/);

  if (statusMatch && method === "PATCH") {
    let body;

    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "Некоректний запит." }, 400);
    }

    const status = cleanText(body.status, 30);

    if (!ORDER_STATUSES.includes(status)) {
      return json({ ok: false, error: "Невідомий статус." }, 400);
    }

    try {
      const result = await env.DB.prepare(
        "UPDATE orders SET status = ? WHERE id = ?"
      ).bind(status, Number(statusMatch[1])).run();

      if (!result.meta?.changes) {
        return json({ ok: false, error: "Замовлення не знайдено." }, 404);
      }

      return json({
        ok: true,
        status,
        status_label: STATUS_LABELS[status]
      });
    } catch (error) {
      console.error("Admin status update failed:", error.message);
      return json({ ok: false, error: "Не вдалося змінити статус." }, 500);
    }
  }

  return json({ ok: false, error: "API endpoint not found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      if (path === "/api/health" && method === "GET") {
        let database = "disconnected";

        try {
          await env.DB.prepare("SELECT 1").first();
          database = "connected";
        } catch (error) {
          console.error("Health database check failed:", error.message);
        }

        return json({
          ok: database === "connected",
          service: "Tanuki Shop",
          database
        });
      }

      if (path === "/api/telegram/webhook") {
        if (method === "GET") {
          return json({
            ok: true,
            endpoint: "Tanuki Shop Telegram webhook",
            method: "POST",
            note: "Telegram надсилає оновлення сюди автоматично."
          });
        }

        if (method === "POST") {
          return handleTelegramWebhook(request, env);
        }

        return json({ ok: false, error: "Method not allowed" }, 405);
      }

      if (path === "/api/orders" && method === "POST") {
        return createOrder(request, env);
      }

      if (path.startsWith("/api/admin/")) {
        return handleAdmin(request, env, url);
      }

      if (path === "/admin" || path === "/admin/") {
        return Response.redirect(
          new URL("/admin/index.html", url.origin).toString(),
          302
        );
      }

      if (path.startsWith("/api/")) {
        return json({ ok: false, error: "API endpoint not found" }, 404);
      }

      return env.ASSETS.fetch(request);

    } catch (error) {
      console.error("Worker error:", error.message);

      if (path.startsWith("/api/")) {
        return json({
          ok: false,
          error: "Внутрішня помилка сервера."
        }, 500);
      }

      return new Response("Internal Server Error", { status: 500 });
    }
  }
};
