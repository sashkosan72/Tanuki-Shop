const PRODUCTS = {
  "tanuki-plush": { name: "Tanuki Plush", price: 499 },
  "kawaii-stickers": { name: "Kawaii Sticker Pack", price: 149 },
  "kawaii-accessory": { name: "Kawaii Accessory", price: 299 }
};

const ADMIN_SESSION_SECONDS = 8 * 60 * 60;
const TELEGRAM_BOT_USERNAME = "TanukiShopNotifyBot";

const ORDER_STATUSES = [
  "new", "confirmed", "shipped", "completed", "cancelled"
];

const STATUS_LABELS = {
  new: "🆕 Нове",
  confirmed: "✅ Підтверджено",
  shipped: "📦 Відправлено",
  completed: "🎉 Виконано",
  cancelled: "❌ Скасовано"
};

const BUYER_MENU = {
  keyboard: [
    [
      { text: "🛍 Мої замовлення" },
      { text: "📦 Статус замовлення" }
    ],
    [
      { text: "💬 Підтримка" },
      { text: "🏠 Головне меню" }
    ]
  ],
  resize_keyboard: true
};

/* -------------------- GENERAL HELPERS -------------------- */

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
  const header = request.headers.get("Cookie") || "";

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;

    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (key === name) {
      try {
        return decodeURIComponent(value);
      } catch {
        return null;
      }
    }
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

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );

  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

function createTelegramLinkToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function telegramDisplayName(user) {
  if (!user) return "Покупець";
  if (user.username) return `@${user.username}`;

  return [
    user.first_name,
    user.last_name
  ].filter(Boolean).join(" ") || "Покупець";
}

/* -------------------- SUPPORT DATABASE -------------------- */

async function ensureSupportTables(env) {
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS support_chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT NOT NULL,
        customer_name TEXT NOT NULL DEFAULT 'Покупець',
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        closed_at TEXT,
        last_admin_read_message_id INTEGER NOT NULL DEFAULT 0
      )
    `),

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS support_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        sender TEXT NOT NULL,
        message_text TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),

    env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_support_chats_status
      ON support_chats(status, updated_at)
    `),

    env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_support_chats_telegram
      ON support_chats(telegram_id)
    `),

    env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_support_messages_chat
      ON support_messages(chat_id, id)
    `)
  ]);

  // Міграція для вже створеної таблиці.
  // Якщо поле існує, повторне додавання не заважає роботі.
  try {
    await env.DB.prepare(`
      ALTER TABLE support_chats
      ADD COLUMN last_admin_read_message_id INTEGER NOT NULL DEFAULT 0
    `).run();
  } catch (error) {
    const message = String(error.message || error).toLowerCase();

    if (!message.includes("duplicate column")) {
      throw error;
    }
  }
}

async function getOrCreateSupportChat(env, telegramId, customerName) {
  let chat = await env.DB.prepare(`
    SELECT id, status
    FROM support_chats
    WHERE telegram_id = ?
      AND status = 'open'
    ORDER BY id DESC
    LIMIT 1
  `).bind(String(telegramId)).first();

  if (chat) {
    await env.DB.prepare(`
      UPDATE support_chats
      SET customer_name = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(customerName, chat.id).run();

    return chat.id;
  }

  const result = await env.DB.prepare(`
    INSERT INTO support_chats (
      telegram_id,
      customer_name,
      status
    )
    VALUES (?, ?, 'open')
  `).bind(String(telegramId), customerName).run();

  return result.meta.last_row_id;
}

async function saveSupportMessage(env, chatId, sender, messageText) {
  await env.DB.prepare(`
    INSERT INTO support_messages (
      chat_id,
      sender,
      message_text
    )
    VALUES (?, ?, ?)
  `).bind(chatId, sender, messageText).run();

  await env.DB.prepare(`
    UPDATE support_chats
    SET updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(chatId).run();
}

/* -------------------- ADMIN SESSION -------------------- */

async function createAdminSignature(timestamp, password) {
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "HMAC", hash: "SHA-256" },
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

/* -------------------- TELEGRAM API -------------------- */

async function telegramCall(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("Не налаштовано TELEGRAM_BOT_TOKEN.");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    throw new Error(
      `Telegram ${method}: ${result.description || "Невідома помилка"}`
    );
  }

  return result.result;
}

async function configureTelegramWebhook(env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
    throw new Error("Не налаштовані секрети Telegram webhook.");
  }

  return telegramCall(env, "setWebhook", {
    url: "https://tanukishop.pp.ua/api/telegram/webhook",
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"]
  });
}

async function sendBuyerMessage(env, telegramId, text, extra = {}) {
  return telegramCall(env, "sendMessage", {
    chat_id: telegramId,
    text,
    ...extra
  });
}

/* -------------------- ADMIN TELEGRAM NOTIFICATION -------------------- */

async function notifyTelegram(env, order) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.error("Telegram не налаштований: перевірте секрети.");
    return;
  }

  try {
    await configureTelegramWebhook(env);
  } catch (error) {
    console.error("Telegram webhook error:", error.message);
  }

  const itemsText = order.items.map(item =>
    `• ${escapeHtml(item.name)} × ${item.quantity} — ${item.price * item.quantity} ₴`
  ).join("\n");

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
    console.error("Telegram notification error:", error.message);
  }
}

/* -------------------- BUYER STATUS NOTIFICATION -------------------- */

async function notifyBuyerOrderStatus(env, orderId, status) {
  try {
    const linked = await env.DB.prepare(`
      SELECT tc.telegram_id, o.order_number
      FROM order_telegram_links l
      JOIN telegram_customers tc ON tc.id = l.telegram_customer_id
      JOIN orders o ON o.id = l.order_id
      WHERE l.order_id = ?
      LIMIT 1
    `).bind(orderId).first();

    if (!linked) return;

    await sendBuyerMessage(
      env,
      linked.telegram_id,
      [
        "🦝 Tanuki Shop — оновлення замовлення!",
        "",
        `🧾 Замовлення: ${linked.order_number}`,
        `📦 Новий статус: ${STATUS_LABELS[status] || status}`
      ].join("\n")
    );
  } catch (error) {
    console.error("Buyer status notification error:", error.message);
  }
}

/* -------------------- BUYER MENU -------------------- */

async function sendBuyerMenu(env, chatId, greeting = "Вітаємо в Tanuki Shop! 🦝") {
  return sendBuyerMessage(env, chatId, greeting, {
    reply_markup: BUYER_MENU
  });
}

/* -------------------- TELEGRAM ORDER LINK -------------------- */

async function linkTelegramOrder(env, chatId, telegramUser, rawToken) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(rawToken)) {
    await sendBuyerMenu(
      env,
      chatId,
      "Посилання для прив'язки некоректне або неповне. Відкрийте посилання з підтвердження замовлення ще раз."
    );
    return;
  }

  const tokenHash = await sha256Hex(rawToken);

  const tokenRow = await env.DB.prepare(`
    SELECT id, order_id
    FROM telegram_link_tokens
    WHERE token_hash = ?
      AND used_at IS NULL
      AND expires_at > datetime('now')
    LIMIT 1
  `).bind(tokenHash).first();

  if (!tokenRow) {
    await sendBuyerMenu(
      env,
      chatId,
      "Це посилання вже використане або термін його дії минув. Зверніться до підтримки магазину."
    );
    return;
  }

  const existingLink = await env.DB.prepare(`
    SELECT tc.telegram_id
    FROM order_telegram_links l
    JOIN telegram_customers tc ON tc.id = l.telegram_customer_id
    WHERE l.order_id = ?
    LIMIT 1
  `).bind(tokenRow.order_id).first();

  if (
    existingLink &&
    String(existingLink.telegram_id) !== String(telegramUser.id)
  ) {
    await sendBuyerMenu(
      env,
      chatId,
      "Це замовлення вже прив'язане до іншого Telegram-акаунта."
    );
    return;
  }

  const telegramId = String(telegramUser.id);
  const username = cleanText(telegramUser.username || "", 100) || null;
  const claimMarker = new Date().toISOString() + "-" + crypto.randomUUID();

  try {
    const batchResults = await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO telegram_customers (telegram_id, telegram_username)
        VALUES (?, ?)
        ON CONFLICT(telegram_id)
        DO UPDATE SET telegram_username = excluded.telegram_username
      `).bind(telegramId, username),

      env.DB.prepare(`
        UPDATE telegram_link_tokens
        SET used_at = ?
        WHERE id = ?
          AND used_at IS NULL
          AND expires_at > datetime('now')
      `).bind(claimMarker, tokenRow.id),

      env.DB.prepare(`
        INSERT INTO order_telegram_links (order_id, telegram_customer_id)
        SELECT
          telegram_link_tokens.order_id,
          telegram_customers.id
        FROM telegram_link_tokens
        JOIN telegram_customers
          ON telegram_customers.telegram_id = ?
        WHERE telegram_link_tokens.id = ?
          AND telegram_link_tokens.used_at = ?
        ON CONFLICT(order_id) DO NOTHING
      `).bind(telegramId, tokenRow.id, claimMarker)
    ]);

    if (!(batchResults[1]?.meta?.changes || 0)) {
      await sendBuyerMenu(
        env,
        chatId,
        "Посилання вже використане або термін його дії минув."
      );
      return;
    }

    const linkedOrder = await env.DB.prepare(`
      SELECT o.order_number, o.status, tc.telegram_id
      FROM order_telegram_links l
      JOIN telegram_customers tc ON tc.id = l.telegram_customer_id
      JOIN orders o ON o.id = l.order_id
      WHERE l.order_id = ?
      LIMIT 1
    `).bind(tokenRow.order_id).first();

    if (!linkedOrder || String(linkedOrder.telegram_id) !== telegramId) {
      throw new Error("Не вдалося підтвердити прив'язку Telegram.");
    }

    await sendBuyerMenu(
      env,
      chatId,
      [
        "✅ Telegram успішно прив'язано!",
        "",
        `🧾 Замовлення: ${linkedOrder.order_number}`,
        `📦 Статус: ${STATUS_LABELS[linkedOrder.status] || "Невідомий"}`,
        "",
        "Тепер ви отримуватимете повідомлення про зміну статусу."
      ].join("\n")
    );
  } catch (error) {
    console.error("Telegram order linking error:", error.message);

    await sendBuyerMenu(
      env,
      chatId,
      "Не вдалося завершити прив'язку. Якщо це замовлення вже прив'язане до вашого Telegram, скористайтеся меню. Якщо ні — зверніться до підтримки."
    );
  }
}

/* -------------------- BUYER ORDERS -------------------- */

async function showBuyerOrders(env, chatId, telegramId) {
  const result = await env.DB.prepare(`
    SELECT o.order_number, o.status, o.total_amount, o.created_at
    FROM order_telegram_links l
    JOIN telegram_customers tc ON tc.id = l.telegram_customer_id
    JOIN orders o ON o.id = l.order_id
    WHERE tc.telegram_id = ?
    ORDER BY o.id DESC
    LIMIT 20
  `).bind(String(telegramId)).all();

  const orders = result.results || [];

  if (!orders.length) {
    await sendBuyerMenu(
      env,
      chatId,
      "Поки що немає прив'язаних замовлень.\n\nПісля покупки відкрийте посилання для Telegram-прив'язки на сайті."
    );
    return;
  }

  const lines = orders.map(order => [
    `🧾 ${order.order_number}`,
    `📦 ${STATUS_LABELS[order.status] || order.status}`,
    `💰 ${order.total_amount} ₴`
  ].join("\n"));

  await sendBuyerMenu(
    env,
    chatId,
    `🛍 Ваші замовлення:\n\n${lines.join("\n\n")}`
  );
}

async function showBuyerStatuses(env, chatId, telegramId) {
  return showBuyerOrders(env, chatId, telegramId);
}

/* -------------------- BUYER SUPPORT -------------------- */

async function handleBuyerSupport(env, chatId, telegramUser, messageText) {
  const adminChat = env.TELEGRAM_CHAT_ID;

  if (!adminChat) {
    await sendBuyerMenu(
      env,
      chatId,
      "💬 Підтримка тимчасово недоступна. Спробуйте написати пізніше."
    );
    return;
  }

  const safeText = cleanText(messageText, 1500);

  if (!safeText) {
    await sendBuyerMenu(env, chatId, "Напишіть своє повідомлення звичайним текстом.");
    return;
  }

  const telegramId = String(telegramUser.id);

  const linkedCustomer = await env.DB.prepare(`
    SELECT id
    FROM telegram_customers
    WHERE telegram_id = ?
    LIMIT 1
  `).bind(telegramId).first();

  if (!linkedCustomer) {
    await sendBuyerMenu(
      env,
      chatId,
      "Спочатку прив'яжіть покупку через посилання з сайту Tanuki Shop."
    );
    return;
  }

  try {
    await ensureSupportTables(env);

    const customerName = telegramDisplayName(telegramUser);
    const supportChatId = await getOrCreateSupportChat(
      env,
      telegramId,
      customerName
    );

    await saveSupportMessage(env, supportChatId, "buyer", safeText);

    await telegramCall(env, "sendMessage", {
      chat_id: adminChat,
      text: [
        "💬 НОВЕ ЗВЕРНЕННЯ — TANUKI SHOP",
        "",
        `👤 ${customerName}`,
        `🆔 Telegram ID: ${telegramId}`,
        `🧾 Звернення №${supportChatId}`,
        "",
        "Повідомлення покупця:",
        safeText,
        "",
        "Відповісти можна через адмін-панель сайту або Reply у Telegram."
      ].join("\n")
    });

    await sendBuyerMenu(
      env,
      chatId,
      "✅ Ваше повідомлення передано підтримці Tanuki Shop!\n\nОчікуйте на відповідь у цьому Telegram-чаті."
    );
  } catch (error) {
    console.error("Support forwarding error:", error.message);

    await sendBuyerMenu(
      env,
      chatId,
      "Не вдалося передати повідомлення. Спробуйте пізніше."
    );
  }
}

/* -------------------- ADMIN TELEGRAM REPLY -------------------- */

async function handleAdminSupportReply(env, message) {
  const expectedAdmin = String(env.TELEGRAM_CHAT_ID || "");
  if (!expectedAdmin) return false;

  const actualChat = String(message.chat?.id || "");
  const actualUser = String(message.from?.id || "");

  if (
    actualChat !== expectedAdmin ||
    actualUser !== expectedAdmin ||
    message.chat?.type !== "private"
  ) {
    return false;
  }

  if (!message.reply_to_message) return false;

  const originalText =
    message.reply_to_message.text ||
    message.reply_to_message.caption ||
    "";

  const match = originalText.match(/Telegram ID:\s*(\d+)/);
  if (!match) return false;

  const buyerTelegramId = match[1];
  const answer = cleanText(message.text || "", 1500);

  if (!answer || answer.startsWith("/")) {
    await sendBuyerMessage(
      env,
      expectedAdmin,
      "Напишіть звичайний текст відповіді на повідомлення покупця."
    );
    return true;
  }

  try {
    await ensureSupportTables(env);

    const chat = await env.DB.prepare(`
      SELECT id
      FROM support_chats
      WHERE telegram_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).bind(buyerTelegramId).first();

    if (chat) {
      await saveSupportMessage(env, chat.id, "admin", answer);
    }

    await sendBuyerMessage(
      env,
      buyerTelegramId,
      `🦝 Tanuki Shop — відповідь підтримки\n\n${answer}`
    );

    await sendBuyerMessage(
      env,
      expectedAdmin,
      "✅ Відповідь успішно надіслана покупцеві."
    );
  } catch (error) {
    console.error("Admin support reply error:", error.message);

    await sendBuyerMessage(
      env,
      expectedAdmin,
      "❌ Не вдалося доставити відповідь покупцеві."
    );
  }

  return true;
}

/* -------------------- BUYER TELEGRAM MESSAGES -------------------- */

async function handleBuyerMessage(env, message) {
  const chatId = message.chat?.id;
  const telegramUser = message.from;
  const text = cleanText(message.text || "", 2000);

  if (!chatId || !telegramUser) return;
  if (message.chat?.type !== "private") return;

  if (text.startsWith("/start")) {
    const payload = text.split(/\s+/, 2)[1] || "";

    if (payload) {
      await linkTelegramOrder(env, chatId, telegramUser, payload);
    } else {
      await sendBuyerMenu(
        env,
        chatId,
        "Вітаємо в Tanuki Shop! 🦝\n\nТут ви можете переглядати свої замовлення та отримувати сповіщення."
      );
    }
    return;
  }

  if (text === "/menu" || text === "🏠 Головне меню") {
    await sendBuyerMenu(env, chatId);
    return;
  }

  if (text === "🛍 Мої замовлення") {
    await showBuyerOrders(env, chatId, telegramUser.id);
    return;
  }

  if (text === "📦 Статус замовлення") {
    await showBuyerStatuses(env, chatId, telegramUser.id);
    return;
  }

  if (text === "💬 Підтримка") {
    await sendBuyerMenu(
      env,
      chatId,
      "💬 Напишіть своє запитання звичайним повідомленням у цей чат. Ми передамо його підтримці."
    );
    return;
  }

  if (text.startsWith("/support")) {
    const supportText = text.replace(/^\/support(?:@\w+)?\s*/i, "").trim();

    await handleBuyerSupport(
      env,
      chatId,
      telegramUser,
      supportText
    );
    return;
  }

  const linkedCustomer = await env.DB.prepare(`
    SELECT id
    FROM telegram_customers
    WHERE telegram_id = ?
    LIMIT 1
  `).bind(String(telegramUser.id)).first();

  if (linkedCustomer && text && !text.startsWith("/")) {
    await handleBuyerSupport(env, chatId, telegramUser, text);
    return;
  }

  if (linkedCustomer) {
    await sendBuyerMenu(
      env,
      chatId,
      "Скористайтеся кнопками меню або напишіть повідомлення, щоб зв'язатися з підтримкою."
    );
  } else {
    await sendBuyerMenu(
      env,
      chatId,
      "Щоб користуватися меню замовлень і підтримкою, спочатку прив'яжіть покупку через посилання з сайту Tanuki Shop."
    );
  }
}

/* -------------------- TELEGRAM WEBHOOK -------------------- */

async function handleTelegramWebhook(request, env) {
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    return json({
      ok: false,
      error: "Telegram webhook secret is not configured."
    }, 500);
  }

  if (getTelegramSecret(request) !== env.TELEGRAM_WEBHOOK_SECRET) {
    return json({
      ok: false,
      error: "Unauthorized webhook request."
    }, 401);
  }

  const update = await readJson(request);

  if (!update) {
    return json({ ok: false, error: "Invalid JSON." }, 400);
  }

  try {
    if (update.message) {
      const handled = await handleAdminSupportReply(env, update.message);

      if (!handled) {
        await handleBuyerMessage(env, update.message);
      }

      return json({ ok: true });
    }

    const callback = update.callback_query;
    if (!callback) return json({ ok: true });

    const callbackData = cleanText(callback.data, 100);
    const match = callbackData.match(
      /^tanuki:(\d+):(confirmed|shipped|cancelled)$/
    );

    if (!match) {
      await telegramCall(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Невідома дія."
      }).catch(() => {});

      return json({ ok: true });
    }

    const orderId = Number(match[1]);
    const newStatus = match[2];
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
        text: "Немає доступу до керування замовленнями.",
        show_alert: true
      }).catch(() => {});

      return json({ ok: true });
    }

    const current = await env.DB.prepare(`
      SELECT order_number, status
      FROM orders
      WHERE id = ?
      LIMIT 1
    `).bind(orderId).first();

    if (!current) {
      await telegramCall(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Замовлення не знайдено.",
        show_alert: true
      });

      return json({ ok: true });
    }

    if (current.status !== newStatus) {
      await env.DB.prepare(`
        UPDATE orders
        SET status = ?
        WHERE id = ?
      `).bind(newStatus, orderId).run();

      await notifyBuyerOrderStatus(env, orderId, newStatus);
    }

    await telegramCall(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: `Статус: ${STATUS_LABELS[newStatus]}`
    });

    const newText = [
      "🦝 <b>Tanuki Shop — замовлення</b>",
      "",
      `🧾 <b>Номер:</b> ${escapeHtml(current.order_number)}`,
      `🔄 <b>Поточний статус:</b> ${STATUS_LABELS[newStatus]}`
    ].join("\n");

    await telegramCall(env, "editMessageText", {
      chat_id: actualChat,
      message_id: callback.message.message_id,
      text: newText,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] }
    });
  } catch (error) {
    console.error("Telegram webhook error:", error.message);

    if (update.callback_query?.id) {
      await telegramCall(env, "answerCallbackQuery", {
        callback_query_id: update.callback_query.id,
        text: "Не вдалося виконати дію.",
        show_alert: true
      }).catch(() => {});
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
    return json({ ok: false, error: "Некоректні дані замовлення." }, 400);
  }

  const customerName = cleanText(
    body.customerName || body.customer_name || body.name, 120
  );

  const customerPhone = cleanText(
    body.customerPhone || body.customer_phone || body.phone, 50
  );

  const customerCity = cleanText(
    body.customerCity || body.customer_city || body.city, 120
  );

  const customerAddress = cleanText(
    body.customerAddress || body.customer_address || body.address, 300
  );

  const customerComment = cleanText(
    body.customerComment || body.customer_comment || body.comment, 1000
  );

  if (!customerName || !customerPhone || !customerCity || !customerAddress) {
    return json({
      ok: false,
      error: "Заповніть ім'я, телефон, місто та адресу."
    }, 400);
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return json({ ok: false, error: "Кошик порожній." }, 400);
  }

  if (body.items.length > 30) {
    return json({ ok: false, error: "Забагато позицій у замовленні." }, 400);
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

    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) {
      return json({ ok: false, error: "Некоректна кількість товару." }, 400);
    }

    const lineTotal = product.price * quantity;

    if (!Number.isSafeInteger(lineTotal)) {
      return json({ ok: false, error: "Некоректна сума замовлення." }, 400);
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
    return json({ ok: false, error: "Некоректна сума замовлення." }, 400);
  }

  const orderNumber = generateOrderNumber();

  try {
    const statements = [
      env.DB.prepare(`
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
      `).bind(
        orderNumber,
        customerName,
        customerPhone,
        customerCity,
        customerAddress,
        customerComment,
        totalAmount
      ),

      ...orderItems.map(item =>
        env.DB.prepare(`
          INSERT INTO order_items (
            order_id,
            product_id,
            product_name,
            price,
            quantity
          )
          SELECT id, ?, ?, ?, ?
          FROM orders
          WHERE order_number = ?
        `).bind(
          item.id,
          item.name,
          item.price,
          item.quantity,
          orderNumber
        )
      )
    ];

    await env.DB.batch(statements);

    const savedOrder = await env.DB.prepare(`
      SELECT id
      FROM orders
      WHERE order_number = ?
      LIMIT 1
    `).bind(orderNumber).first();

    if (!savedOrder) {
      throw new Error("Не вдалося отримати ID замовлення.");
    }

    const orderId = savedOrder.id;
    let telegramLink = null;

    try {
      const rawToken = createTelegramLinkToken();
      const tokenHash = await sha256Hex(rawToken);

      await env.DB.prepare(`
        INSERT INTO telegram_link_tokens (
          order_id,
          token_hash,
          expires_at
        )
        VALUES (?, ?, datetime('now', '+24 hours'))
      `).bind(orderId, tokenHash).run();

      telegramLink =
        `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${rawToken}`;
    } catch (error) {
      console.error("Telegram link creation error:", error.message);
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

    await notifyTelegram(env, order);

    return json({
      ok: true,
      order_id: orderId,
      order_number: orderNumber,
      total_amount: totalAmount,
      orderNumber,
      total: totalAmount,
      telegram_link: telegramLink,
      telegramLink,
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

/* -------------------- ADMIN LOGIN -------------------- */

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
    return json({ ok: false, error: "Неправильний пароль." }, 401);
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

/* -------------------- ADMIN ORDERS -------------------- */

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
        SELECT product_id, product_name, price, quantity
        FROM order_items
        WHERE order_id = ?
      `).bind(order.id).all();

      result.push({
        ...order,
        items: items.results || []
      });
    }

    return json({ ok: true, orders: result });
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
    return json({ ok: false, error: "Невідомий статус замовлення." }, 400);
  }

  try {
    const current = await env.DB.prepare(`
      SELECT status
      FROM orders
      WHERE id = ?
      LIMIT 1
    `).bind(orderId).first();

    if (!current) {
      return json({ ok: false, error: "Замовлення не знайдено." }, 404);
    }

    if (current.status !== status) {
      await env.DB.prepare(`
        UPDATE orders
        SET status = ?
        WHERE id = ?
      `).bind(status, orderId).run();

      await notifyBuyerOrderStatus(env, orderId, status);
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

/* -------------------- ADMIN SUPPORT API -------------------- */

async function adminGetSupportChats(env) {
  try {
    await ensureSupportTables(env);

    const result = await env.DB.prepare(`
      SELECT
        c.id,
        c.telegram_id,
        c.customer_name,
        c.status,
        c.created_at,
        c.updated_at,

        (
          SELECT m.message_text
          FROM support_messages m
          WHERE m.chat_id = c.id
          ORDER BY m.id DESC
          LIMIT 1
        ) AS last_message,

        (
          SELECT m.sender
          FROM support_messages m
          WHERE m.chat_id = c.id
          ORDER BY m.id DESC
          LIMIT 1
        ) AS last_sender,

        (
          SELECT COUNT(*)
          FROM support_messages m
          WHERE m.chat_id = c.id
            AND m.sender = 'buyer'
            AND m.id > c.last_admin_read_message_id
        ) AS unread_count

      FROM support_chats c

      ORDER BY
        CASE WHEN c.status = 'open' THEN 0 ELSE 1 END,
        c.updated_at DESC

      LIMIT 200
    `).all();

    return json({
      ok: true,
      chats: result.results || []
    });
  } catch (error) {
    console.error("Admin support list error:", error.message);

    return json({
      ok: false,
      error: "Не вдалося завантажити звернення."
    }, 500);
  }
}

async function adminGetSupportMessages(env, chatId) {
  try {
    await ensureSupportTables(env);

    const chat = await env.DB.prepare(`
      SELECT id, telegram_id, customer_name, status, created_at, updated_at
      FROM support_chats
      WHERE id = ?
      LIMIT 1
    `).bind(chatId).first();

    if (!chat) {
      return json({
        ok: false,
        error: "Звернення не знайдено."
      }, 404);
    }

    // Визначаємо останнє повідомлення від покупця.
    const latestBuyerMessage = await env.DB.prepare(`
      SELECT COALESCE(MAX(id), 0) AS id
      FROM support_messages
      WHERE chat_id = ?
        AND sender = 'buyer'
    `).bind(chatId).first();

    // Позначаємо повідомлення покупця прочитаними.
    await env.DB.prepare(`
      UPDATE support_chats
      SET last_admin_read_message_id = MAX(
        last_admin_read_message_id,
        ?
      )
      WHERE id = ?
    `).bind(
      Number(latestBuyerMessage?.id || 0),
      chatId
    ).run();

    const messages = await env.DB.prepare(`
      SELECT id, sender, message_text, created_at
      FROM support_messages
      WHERE chat_id = ?
      ORDER BY id ASC
      LIMIT 500
    `).bind(chatId).all();

    return json({
      ok: true,
      chat,
      messages: messages.results || []
    });
  } catch (error) {
    console.error("Admin support messages error:", error.message);

    return json({
      ok: false,
      error: "Не вдалося завантажити листування."
    }, 500);
  }
}

async function adminReplySupport(request, env, chatId) {
  const body = await readJson(request);
  const answer = cleanText(body?.message, 1500);

  if (!answer) {
    return json({
      ok: false,
      error: "Напишіть текст відповіді."
    }, 400);
  }

  try {
    await ensureSupportTables(env);

    const chat = await env.DB.prepare(`
      SELECT id, telegram_id, status
      FROM support_chats
      WHERE id = ?
      LIMIT 1
    `).bind(chatId).first();

    if (!chat) {
      return json({
        ok: false,
        error: "Звернення не знайдено."
      }, 404);
    }

    if (chat.status !== "open") {
      return json({
        ok: false,
        error: "Це звернення вже закрито."
      }, 409);
    }

    await sendBuyerMessage(
      env,
      chat.telegram_id,
      `🦝 Tanuki Shop — відповідь підтримки\n\n${answer}`
    );

    await saveSupportMessage(env, chatId, "admin", answer);

    return json({
      ok: true,
      message: "Відповідь надіслана покупцеві."
    });
  } catch (error) {
    console.error("Admin support reply API error:", error.message);

    return json({
      ok: false,
      error: "Не вдалося надіслати відповідь. Перевірте Telegram."
    }, 500);
  }
}

async function adminCloseSupport(env, chatId) {
  try {
    await ensureSupportTables(env);

    const chat = await env.DB.prepare(`
      SELECT id, status
      FROM support_chats
      WHERE id = ?
      LIMIT 1
    `).bind(chatId).first();

    if (!chat) {
      return json({
        ok: false,
        error: "Звернення не знайдено."
      }, 404);
    }

    await env.DB.prepare(`
      UPDATE support_chats
      SET status = 'closed',
          closed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(chatId).run();

    return json({
      ok: true,
      message: "Звернення закрито."
    });
  } catch (error) {
    console.error("Admin close support error:", error.message);

    return json({
      ok: false,
      error: "Не вдалося закрити звернення."
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
      if (path === "/api/health" && method === "GET") {
        return healthCheck(env);
      }

      if (path === "/api/telegram/webhook" && method === "GET") {
        return json({
          ok: true,
          endpoint: "Tanuki Shop Telegram webhook",
          method: "POST",
          note: "Telegram надсилає оновлення сюди автоматично."
        });
      }

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

      if (path === "/api/orders" && method === "POST") {
        return createOrder(request, env);
      }

      if (path === "/api/admin/login" && method === "POST") {
        return adminLogin(request, env);
      }

      if (path === "/api/admin/logout" && method === "POST") {
        return adminLogout();
      }

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

      if (path.startsWith("/api/admin/")) {
        const authorized = await requireAdmin(request, env);

        if (!authorized) {
          return json({
            ok: false,
            error: "Потрібно увійти як адміністратор."
          }, 401);
        }

        if (path === "/api/admin/orders" && method === "GET") {
          return adminGetOrders(env);
        }

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

        if (path === "/api/admin/support" && method === "GET") {
          return adminGetSupportChats(env);
        }

        const supportMessagesMatch = path.match(
          /^\/api\/admin\/support\/(\d+)$/
        );

        if (supportMessagesMatch && method === "GET") {
          return adminGetSupportMessages(
            env,
            Number(supportMessagesMatch[1])
          );
        }

        const supportReplyMatch = path.match(
          /^\/api\/admin\/support\/(\d+)\/reply$/
        );

        if (supportReplyMatch && method === "POST") {
          return adminReplySupport(
            request,
            env,
            Number(supportReplyMatch[1])
          );
        }

        const supportCloseMatch = path.match(
          /^\/api\/admin\/support\/(\d+)\/close$/
        );

        if (supportCloseMatch && method === "PATCH") {
          return adminCloseSupport(
            env,
            Number(supportCloseMatch[1])
          );
        }

        return json({
          ok: false,
          error: "Admin API endpoint not found."
        }, 404);
      }

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
