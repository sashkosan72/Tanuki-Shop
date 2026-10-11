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
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Telegram token is missing");

  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(10000)
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(
      `Telegram ${method} failed: ${JSON.stringify(result)}`
    );
  }

  return result;
}

async function configureTelegramWebhook(env) {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) throw new Error("TELEGRAM_WEBHOOK_SECRET is missing");

  return telegramCall(env, "setWebhook", {
    url: "https://tanukishop.pp.ua/api/telegram/webhook",
    secret_token: secret,
    allowed_updates: ["callback_query"]
  });
}

async function notifyTelegram(env, order) {
  const chatId = env.TELEGRAM_CHAT_ID;

  if (!env.TELEGRAM_BOT_TOKEN || !chatId) {
    console.error("Telegram secrets are missing");
    return;
  }

  const productLines = order.items.map(item =>
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
    ...productLines,
    "",
    `<b>Сума:</b> ${order.total} ₴`,
    `<b>Коментар:</b> ${escapeHtml(order.customerComment || "Немає")}`,
    "",
    "<b>Статус:</b> Нове замовлення"
  ].join("\n");

  try {
    await configureTelegramWebhook(env);

    await telegramCall(env, "sendMessage", {
      chat_id: chatId,
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

async function handleTelegramWebhook(request, env) {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  const receivedSecret = request.headers.get(
    "X-Telegram-Bot-Api-Secret-Token"
  );

  if (!secret || receivedSecret !== secret) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  let update;

  try {
    update = await request.json();
  } catch {
    return json({ ok: false }, 400);
  }

  const callback = update.callback_query;
  if (!callback) return json({ ok: true });

  const chatId = String(env.TELEGRAM_CHAT_ID || "");
  const callbackChatId = String(callback.message?.chat?.id || "");
  const callbackUserId = String(callback.from?.id || "");

  if (
    !chatId ||
    callbackChatId !== chatId ||
    callbackUserId !== chatId
  ) {
    await telegramCall(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "У вас немає дозволу змінювати замовлення.",
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
      text: "Невідома дія.",
      show_alert: true
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
      text: `Статус змінено: ${TELEGRAM_STATUS[status]}`
    });

    const originalText = callback.message?.text || "";
    const cleanMessage = originalText.replace(
      /\n\n<b>Статус:<\/b>.*$/s,
      ""
    );

    const updatedMessage = [
      cleanMessage,
      "",
      `<b>Статус:</b> ${TELEGRAM_STATUS[status]}`
    ].join("\n");

    await telegramCall(env, "editMessageText", {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      text: updatedMessage,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: []
      }
    });

  } catch (error) {
    console.error("Telegram webhook error:", error);

    await telegramCall(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Не вдалося оновити статус. Спробуйте ще раз.",
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
    { name: "HMAC", hash: "SHA-256" },
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
  const cookieHeader = request.headers.get("Cookie") || "";

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");

    if (separator === -1) continue;

    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (key === name) return value;
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

  try {
    const expected = await signSession(
      `${timestampText}.${nonce}`,
      secret
    );

    return constantTimeEqual(signature, expected);
  } catch (error) {
    console.error("Session verification error:", error);
    return false;
  }
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
      error: "Не вдалося зберегти замовлення. Спробуйте пізніше."
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
      error: "Потр
