
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

const ADMIN_SESSION_SECONDS = 8 * 60 * 60;

const ORDER_STATUSES = [
  "new",
  "confirmed",
  "shipped",
  "completed",
  "cancelled"
];

const STATUS_LABELS = {
  new: "🆕 Нове",
  confirmed: "✅ Підтверджено",
  shipped: "📦 Відправлено",
  completed: "🎉 Виконано",
  cancelled: "❌ Скасовано"
};

/* -------------------- HELPERS -------------------- */

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

function cleanText(value, maxLength = 500) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;

    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (key === name) return decodeURIComponent(value);
  }

  return null;
}

function getTelegramSecret(request) {
  return request.headers.get("X-Telegram-Bot-Api-Secret-Token");
}

function generateOrderNumber() {
  const date = new Date();
  const datePart = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("");

  const randomPart = crypto.randomUUID()
    .replaceAll("-", "")
    .slice(0, 6)
    .toUpperCase();

  return `TAN-${datePart}-${randomPart}`;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/* -------------------- ADMIN SESSION -------------------- */

async function createAdminSignature(timestamp, password) {
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
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
    encoder.encode(timestamp)
  );

  return btoa(
    String.fromCharCode(...new Uint8Array(signature))
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function createAdminSession(password) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await createAdminSignature(timestamp, password);

  return `${timestamp}.${signature}`;
}

async function verifyAdminSession(request, env) {
  if (!env.ADMIN_PASSWORD) return false;

  const session = getCookie(request, "tanuki_admin_session");
  if (!session) return false;

  const parts = session.split(".");
  if (parts.length !== 2) return false;

  const [timestamp, signature] = parts;
  const createdAt = Number(timestamp);
  const now = Math.floor(Date.now() / 1000);

  if (!Number.isSafeInteger(createdAt)) return false;
  if (createdAt > now + 60) return false;
  if (now - createdAt > ADMIN_SESSION_SECONDS) return false;

  const expected = await createAdminSignature(
    timestamp,
    env.ADMIN_PASSWORD
  );

  return signature === expected;
}

function adminCookie(value, maxAge = ADMIN_SESSION_SECONDS) {
  return [
    `tanuki_admin_session=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${maxAge}`
  ].join("; ");
}

async function requireAdmin(request, env) {
  return verifyAdminSession(request, env);
}

/* -------------------- TELEGRAM -------------------- */

async function telegramCall(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("Не налаштовано TELEGRAM_BOT_TOKEN.");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    }
  );

  let result;

  try {
    result = await response.json();
  } catch {
    throw new Error("Telegram повернув некоректну відповідь.");
  }

  if (!response.ok || !result.ok) {
    const description = result.description || "Невідома помилка Telegram";
    throw new Error(`Telegram ${method}: ${description}`);
  }

  return result.result;
}

async function configureTelegramWebhook(env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
    throw new Error("Не налаштовані секрети Telegram webhook.");
  }

  const webhookUrl =
    "https://tanukishop.pp.ua/api/telegram/webhook";

  return telegramCall(env, "setWebhook", {
    url: webhookUrl,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["callback_query"]
  });
}

async function notifyTelegram(env, order) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.error("Telegram не налаштований: перевірте секрети.");
    return;
  }

  // Налаштування webhook не повинно блокувати повідомлення.
  try {
    await configureTelegramWebhook(env);
  } catch (error) {
    console.error("Telegram webhook error:", error.message);
  }

  const itemsText = order.items
    .map(item =>
      `• ${escapeHtml(item.name)} × ${item.quantity} — ${item.price * item.quantity} ₴`
    )
    .join("\n");

  const message = [
    "🦝 <b>Нове замовлення — Tanuki Shop!</b>",
    "",
    `🧾 <b>Номер:</b> ${escapeHtml(order.orderNumber)}`,
    "",
    "👤 <b>Покупець:</b>",
    escapeHtml(order.customerName),
    `📞 ${escapeHtml(order.customerPhone)}`,
    `🏙 ${escapeHtml(order.customerCity)}`,
    `📍 ${escapeHtml(order.customerAddress)}`,
    "",
    "🛍 <b>Товари:</b>",
    itemsText,
    "",
    `💰 <b>Сума:</b> ${order.total} ₴`,
    "",
    order.customerComment
      ? `💬 <b>Коментар:</b> ${escapeHtml(order.customerComment)}`
      : "",
    "",
    "🆕 <b>Статус:</b> Нове замовлення"
  ].filter(Boolean).join("\n");

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
    // Замовлення вже збережене в D1.
    // Помилка Telegram не повинна скасовувати замовлення.
    console.error("Telegram notification error:", error.message);
  }
}

async function handleTelegramWebhook(request, env) {
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    return json({
      ok: false,
      error: "Telegram webhook secret is not configured."
    }, 500);
  }

  const receivedSecret = getTelegramSecret(request);

  if (receivedSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return json({
      ok: false,
      error: "Unauthorized webhook request."
    }, 401);
  }

  const update = await readJson(request);

  if (!update) {
    return json({
      ok: false,
      error: "Invalid JSON."
    }, 400);
  }

  const callback = update.callback_query;

  if (!callback) {
    return json({ ok: true });
  }

  const callbackData = cleanText(callback.data, 100);
  const match = callbackData.match(
    /^tanuki:(\d+):(confirmed|shipped|cancelled)$/
  );

  if (!match) {
    return json({ ok: true });
  }

  const orderId = Number(match[1]);
  const newStatus = match[2];

  const expectedChat = String(env.TELEGRAM_CHAT_ID || "");
  const actualChat = String(callback.message?.chat?.id || "");
  const actualUser = String(callback.from?.id || "");

  // Дозволяємо керувати замовленнями лише з налаштованого
  // приватного Telegram-чату.
  if (
    !expectedChat ||
    actualChat !== expectedChat ||
    actualUser !== expectedChat
  ) {
    try {
      await telegramCall(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Немає доступу до керування замовленнями.",
        show_alert: true
      });
    } catch (error) {
      console.error("Telegram callback error:", error.message);
    }

    return json({ ok: true });
  }

  try {
    const result = await env.DB.prepare(
      "UPDATE orders SET status = ? WHERE id = ?"
    )
      .bind(newStatus, orderId)
      .run();

    if (!result.meta?.changes) {
      await telegramCall(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Замовлення не знайдено.",
        show_alert: true
      });

      return json({ ok: true });
    }

    const order = await env.DB.prepare(
      "SELECT order_number FROM orders WHERE id = ?"
    )
      .bind(orderId)
      .first();

    await telegramCall(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: `Статус: ${STATUS_LABELS[newStatus]}`
    });

    const oldText = callback.message?.text || "";
    const newText =
      `${oldText}\n\n🔄 <b>Новий статус:</b> ${STATUS_LABELS[newStatus]}` +
      `\n🧾 ${escapeHtml(order?.order_number || "")}`;

    await telegramCall(env, "editMessageText", {
      chat_id: actualChat,
      message_id: callback.message.message_id,
      text: newText,
      parse_mode: "HTML"
    });

  } catch (error) {
    console.error("Webhook database error:", error.message);

    try {
      await telegramCall(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Не вдалося оновити статус.",
        show_alert: true
      });
    } catch (telegramError) {
      console.error("Telegram callback error:", telegramError.message);
    }
  }

  return json({ ok: true });
}

/* -------------------- HEALTH CHECK -------------------- */

async function healthCheck(env) {
  try {
    await env.DB.prepare("SELECT 1").first();

    return json({
      ok: true,
      service: "Tanuki Shop",
      database: "connected"
    });
  } catch (error) {
    console.error("Health check error:", error.message);

    return json({
      ok: false,
      service: "Tanuki Shop",
      database: "error"
    }, 503);
  }
}

/* -------------------- CREATE ORDER -------------------- */

async function createOrder(request, env) {
  const body = await readJson(request);

  if (!body || typeof body !== "object") {
    return json({
      ok: false,
      error: "Некоректні дані замовлення."
    }, 400);
  }

  // Приймаємо і camelCase з index.html, і snake_case.
  const customerName = cleanText(
    body.customerName || body.customer_name || body.name,
    120
  );

  const customerPhone = cleanText(
    body.customerPhone || body.customer_phone || body.phone,
    50
  );

  const customerCity = cleanText(
    body.customerCity || body.customer_city || body.city,
    120
  );

  const customerAddress = cleanText(
    body.customerAddress || body.customer_address || body.address,
    300
  );

  const customerComment = cleanText(
    body.customerComment || body.customer_comment || body.comment,
    1000
  );

  if (
    !customerName ||
    !customerPhone ||
    !customerCity ||
    !customerAddress
  ) {
    return json({
      ok: false,
      error: "Заповніть ім'я, телефон, місто та адресу."
    }, 400);
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return json({
      ok: false,
      error: "Кошик порожній."
    }, 400);
  }

  if (body.items.length > 30) {
    return json({
      ok: false,
      error: "Забагато позицій у замовленні."
    }, 400);
  }

  const orderItems = [];
  let totalAmount = 0;

  for (const item of body.items) {
    const productId = cleanText(item?.id, 100);
    const quantity = Number(item?.quantity);
    const product = PRODUCTS[productId];

    if (!product) {
      return json({
        ok: false,
        error: "Один із товарів більше недоступний."
      }, 400);
    }

    if (
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity > 99
    ) {
      return json({
        ok: false,
        error: "Некоректна кількість товару."
      }, 400);
    }

    const lineTotal = product.price * quantity;

    if (!Number.isSafeInteger(lineTotal)) {
      return json({
        ok: false,
        error: "Некоректна сума замовлення."
      }, 400);
    }

    totalAmount += lineTotal;

    orderItems.push({
      id: productId,
      name: product.name,
      price: product.price,
      quantity
    });
  }

  if (!Number.isSafeInteger(totalAmount) || totalAmount <= 0) {
    return json({
      ok: false,
      error: "Некоректна сума замовлення."
    }, 400);
  }

  const orderNumber = generateOrderNumber();

  try {
    const insertOrder = await env.DB.prepare(`
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
    `)
      .bind(
        orderNumber,
        customerName,
        customerPhone,
        customerCity,
        customerAddress,
        customerComment,
        totalAmount
      )
      .run();

    const orderId = insertOrder.meta?.last_row_id;

    if (!orderId) {
      throw new Error("Не вдалося отримати ID замовлення.");
    }

    for (const item of orderItems) {
      await env.DB.prepare(`
        INSERT INTO order_items (
          order_id,
          product_id,
          product_name,
          price,
          quantity
        )
        VALUES (?, ?, ?, ?, ?)
      `)
        .bind(
          orderId,
          item.id,
          item.name,
          item.price,
          item.quantity
        )
        .run();
    }

    const order = {
      id: orderId,
      orderNumber,
      customerName,
      customerPhone,
      customerCity,
      customerAddress,
      customerComment,
      total: totalAmount,
      items: orderItems
    };

    // Сповіщення виконується після збереження замовлення.
    // Помилка Telegram не скасовує успішне замовлення.
    await notifyTelegram(env, order);

    return json({
      ok: true,
      order_id: orderId,
      order_number: orderNumber,
      total_amount: totalAmount,

      // Поля, які використовує твій index.html:
      orderNumber,
      total: totalAmount,

      message: "Замовлення успішно оформлено!"
    }, 201);

  } catch (error) {
    console.error("Create order error:", error.message);

    return json({
      ok: false,
      error: "Не вдалося зберегти замовлення. Спробуйте ще раз."
    }, 500);
  }
}

/* -------------------- ADMIN API -------------------- */

async function adminLogin(request, env) {
  if (!env.ADMIN_PASSWORD) {
    return json({
      ok: false,
      error: "Пароль адміністратора не налаштований."
    }, 500);
  }

  const body = await readJson(request);
  const password = cleanText(body?.password, 500);

  if (!password || password !== env.ADMIN_PASSWORD) {
    return json({
      ok: false,
      error: "Неправильний пароль."
    }, 401);
  }

  const session = await createAdminSession(env.ADMIN_PASSWORD);

  return json({
    ok: true,
    message: "Вхід успішний."
  }, 200, {
    "Set-Cookie": adminCookie(session)
  });
}

async function adminLogout() {
  return json({
    ok: true,
    message: "Ви вийшли з панелі."
  }, 200, {
    "Set-Cookie": adminCookie("", 0)
  });
}

async function adminGetOrders(env) {
  try {
    const orders = await env.DB.prepare(`
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
      ORDER BY id DESC
      LIMIT 200
    `).all();

    const result = [];

    for (const order of orders.results || []) {
      const items = await env.DB.prepare(`
        SELECT
          product_id,
          product_name,
          price,
          quantity
        FROM order_items
        WHERE order_id = ?
      `)
        .bind(order.id)
        .all();

      result.push({
        ...order,
        items: items.results || []
      });
    }

    return json({
      ok: true,
      orders: result
    });

  } catch (error) {
    console.error("Admin orders error:", error.message);

    return json({
      ok: false,
      error: "Не вдалося завантажити замовлення."
    }, 500);
  }
}

async function adminUpdateOrder(request, env, orderId) {
  const body = await readJson(request);
  const status = cleanText(body?.status, 30);

  if (!ORDER_STATUSES.includes(status)) {
    return json({
      ok: false,
      error: "Невідомий статус замовлення."
    }, 400);
  }

  try {
    const result = await env.DB.prepare(
      "UPDATE orders SET status = ? WHERE id = ?"
    )
      .bind(status, orderId)
      .run();

    if (!result.meta?.changes) {
      return json({
        ok: false,
        error: "Замовлення не знайдено."
      }, 404);
    }

    return json({
      ok: true,
      status,
      status_label: STATUS_LABELS[status]
    });

  } catch (error) {
    console.error("Admin update error:", error.message);

    return json({
      ok: false,
      error: "Не вдалося оновити статус."
    }, 500);
  }
}

/* -------------------- ROUTER -------------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    try {
      // Перевірка роботи сервера та бази даних.
      if (path === "/api/health" && method === "GET") {
        return healthCheck(env);
      }

      // Telegram webhook: GET для перевірки адреси.
      if (path === "/api/telegram/webhook" && method === "GET") {
        return json({
          ok: true,
          endpoint: "Tanuki Shop Telegram webhook",
          method: "POST",
          note: "Telegram надсилає оновлення сюди автоматично."
        });
      }

      // Telegram webhook: POST від Telegram.
      if (path === "/api/telegram/webhook" && method === "POST") {
        return handleTelegramWebhook(request, env);
      }

      if (path === "/api/telegram/webhook") {
        return json({
          ok: false,
          error: "Method not allowed."
        }, 405, {
          Allow: "GET, POST"
        });
      }

      // Оформлення замовлення.
      if (path === "/api/orders" && method === "POST") {
        return createOrder(request, env);
      }

      // Адміністративний вхід.
      if (path === "/api/admin/login" && method === "POST") {
        return adminLogin(request, env);
      }

      // Вихід адміністратора.
      if (path === "/api/admin/logout" && method === "POST") {
        return adminLogout();
      }

      // Перевірка авторизації адміністратора.
      if (
        path === "/api/admin/me" ||
        path === "/api/admin/session"
      ) {
        if (method !== "GET") {
          return json({
            ok: false,
            error: "Method not allowed."
          }, 405);
        }

        const authorized = await requireAdmin(request, env);

        return json({
          ok: true,
          authenticated: authorized
        });
      }

      // Усі інші адміністративні маршрути потребують входу.
      if (path.startsWith("/api/admin/")) {
        const authorized = await requireAdmin(request, env);

        if (!authorized) {
          return json({
            ok: false,
            error: "Потрібно увійти як адміністратор."
          }, 401);
        }

        if (
          path === "/api/admin/orders" &&
          method === "GET"
        ) {
          return adminGetOrders(env);
        }

        // Підтримуємо обидва варіанти:
        // PATCH /api/admin/orders/123
        // PATCH /api/admin/orders/123/status
        const statusMatch = path.match(
          /^\/api\/admin\/orders\/(\d+)(?:\/status)?$/
        );

        if (statusMatch && method === "PATCH") {
          return adminUpdateOrder(
            request,
            env,
            Number(statusMatch[1])
          );
        }

        return json({
          ok: false,
          error: "Admin API endpoint not found."
        }, 404);
      }

      // Статичні файли сайту.
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return json({
        ok: false,
        error: "Not found."
      }, 404);

    } catch (error) {
      console.error("Worker error:", error.message);

      return json({
        ok: false,
        error: "Внутрішня помилка сервера."
      }, 500);
    }
  }
};
