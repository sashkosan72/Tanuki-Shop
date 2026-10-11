
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
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("Telegram token is missing");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
