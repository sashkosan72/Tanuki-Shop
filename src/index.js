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

const PRODUCT_CATEGORIES = [
  "Манґа",
  "Фігурки",
  "Плюшеві іграшки",
  "Одяг",
  "Аксесуари",
  "Подарунки",
  "Інше"
];

const MAX_IMAGE_SIZE = 8 * 1024 * 1024;
const MAX_PRODUCT_IMAGES = 8;

/* =========================================================
   GENERAL HELPERS
========================================================= */

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

  if (user.username) {
    return `@${user.username}`;
  }

  return [
    user.first_name,
    user.last_name
  ].filter(Boolean).join(" ") || "Покупець";
}

function toBoolean(value) {
  return value === true ||
    value === 1 ||
    value === "1" ||
    value === "true" ||
    value === "on";
}

function validInteger(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);

  return Number.isSafeInteger(number) &&
    number >= min &&
    number <= max;
}

function productSlug(value) {
  const slug = cleanText(value, 100)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9а-яіїєґ_-]+/gi, "-")
    .replace(/^-+|-+$/g, "");

  return slug || crypto.randomUUID();
}

function effectivePrice(product) {
  return product.sale_price !== null &&
    product.sale_price !== undefined
      ? Number(product.sale_price)
      : Number(product.price);
}

function imageUrl(key) {
  return `/media/${encodeURIComponent(key)}`;
}

/* =========================================================
   SUPPORT DATABASE
========================================================= */

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
  const chat = await env.DB.prepare(`
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
      SET customer_name = ?,
          updated_at = CURRENT_TIMESTAMP
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

/* =========================================================
   ADMIN SESSION
========================================================= */

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

/* =========================================================
   TELEGRAM API
========================================================= */

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

/* =========================================================
   TELEGRAM ADMIN NOTIFICATIONS
========================================================= */

async function notifyTelegram(env, order) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.error("Telegram не налаштований: перевірте секрети.");
    return;
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

async function notifyBuyerOrderStatus(env, orderId, status) {
  try {
    const linked = await env.DB.prepare(`
      SELECT tc.telegram_id, o.order_number
      FROM order_telegram_links l
      JOIN telegram_customers tc
        ON tc.id = l.telegram_customer_id
      JOIN orders o
        ON o.id = l.order_id
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

/* =========================================================
   TELEGRAM BUYER MENU
========================================================= */

async function sendBuyerMenu(
  env,
  chatId,
  greeting = "Вітаємо в Tanuki Shop! 🦝"
) {
  return sendBuyerMessage(env, chatId, greeting, {
    reply_markup: BUYER_MENU
  });
}

/* =========================================================
   TELEGRAM ORDER LINK
========================================================= */

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
    JOIN telegram_customers tc
      ON tc.id = l.telegram_customer_id
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
        INSERT INTO telegram_customers (
          telegram_id,
          telegram_username
        )
        VALUES (?, ?)
        ON CONFLICT(telegram_id)
        DO UPDATE SET
          telegram_username = excluded.telegram_username
      `).bind(telegramId, username),

      env.DB.prepare(`
        UPDATE telegram_link_tokens
        SET used_at = ?
        WHERE id = ?
          AND used_at IS NULL
          AND expires_at > datetime('now')
      `).bind(claimMarker, tokenRow.id),

      env.DB.prepare(`
        INSERT INTO order_telegram_links (
          order_id,
          telegram_customer_id
        )
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
      JOIN telegram_customers tc
        ON tc.id = l.telegram_customer_id
      JOIN orders o
        ON o.id = l.order_id
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

/* =========================================================
   TELEGRAM BUYER ORDERS
========================================================= */

async function showBuyerOrders(env, chatId, telegramId) {
  const result = await env.DB.prepare(`
    SELECT
      o.order_number,
      o.status,
      o.total_amount,
      o.created_at
    FROM order_telegram_links l
    JOIN telegram_customers tc
      ON tc.id = l.telegram_customer_id
    JOIN orders o
      ON o.id = l.order_id
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

/* =========================================================
   TELEGRAM BUYER SUPPORT
========================================================= */

async function handleBuyerSupport(
  env,
  chatId,
  telegramUser,
  messageText
) {
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
    await sendBuyerMenu(
      env,
      chatId,
      "Напишіть своє повідомлення звичайним текстом."
    );

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

    await saveSupportMessage(
      env,
      supportChatId,
      "buyer",
      safeText
    );

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

/* =========================================================
   TELEGRAM ADMIN SUPPORT REPLY
========================================================= */

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

  const telegramMatch = originalText.match(/Telegram ID:\s*(\d+)/);
  const ticketMatch = originalText.match(/Звернення №\s*(\d+)/i);

  if (!telegramMatch || !ticketMatch) return false;

  const buyerTelegramId = telegramMatch[1];
  const supportChatId = Number(ticketMatch[1]);
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
      SELECT id, telegram_id, status
      FROM support_chats
      WHERE id = ?
        AND telegram_id = ?
      LIMIT 1
    `).bind(supportChatId, buyerTelegramId).first();

    if (!chat) {
      await sendBuyerMessage(
        env,
        expectedAdmin,
        "❌ Звернення не знайдено. Перевірте, на яке повідомлення ви відповідаєте."
      );

      return true;
    }

    if (chat.status !== "open") {
      await sendBuyerMessage(
        env,
        expectedAdmin,
        `⚠️ Звернення №${supportChatId} вже закрите. Відповідь не надіслана.`
      );

      return true;
    }

    await sendBuyerMessage(
      env,
      buyerTelegramId,
      `🦝 Tanuki Shop — відповідь підтримки\n\n${answer}`
    );

    await saveSupportMessage(
      env,
      chat.id,
      "admin",
      answer
    );

    await sendBuyerMessage(
      env,
      expectedAdmin,
      `✅ Відповідь на звернення №${supportChatId} надіслана покупцеві.`
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

/* =========================================================
   TELEGRAM BUYER MESSAGES
========================================================= */

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
    const supportText = text
      .replace(/^\/support(?:@\w+)?\s*/i, "")
      .trim();

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
    await handleBuyerSupport(
      env,
      chatId,
      telegramUser,
      text
    );

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

/* =========================================================
   TELEGRAM WEBHOOK
========================================================= */

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
    return json({
      ok: false,
      error: "Invalid JSON."
    }, 400);
  }

  try {
    if (update.message) {
      const handled = await handleAdminSupportReply(
        env,
        update.message
      );

      if (!handled) {
        await handleBuyerMessage(env, update.message);
      }

      return json({ ok: true });
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
      reply_markup: {
        inline_keyboard: []
      }
    });

    return json({ ok: true });
  } catch (error) {
    console.error("Telegram webhook error:", error.message);

    if (update.callback_query?.id) {
      await telegramCall(env, "answerCallbackQuery", {
        callback_query_id: update.callback_query.id,
        text: "Не вдалося виконати дію.",
        show_alert: true
      }).catch(() => {});
    }

    return json({
      ok: false,
      error: "Webhook processing failed."
    }, 500);
  }
}

/* =========================================================
   HEALTH CHECK
========================================================= */

async function healthCheck(env) {
  try {
    await env.DB.prepare("SELECT 1").first();

    return json({
      ok: true,
      service: "Tanuki Shop",
      database: "connected",
      product_storage: env.PRODUCT_IMAGES ? "connected" : "not configured"
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

/* =========================================================
   PRODUCT DATABASE HELPERS
========================================================= */

async function getProductImages(env, productId) {
  const result = await env.DB.prepare(`
    SELECT id, image_key, position
    FROM product_images
    WHERE product_id = ?
    ORDER BY position ASC, id ASC
  `).bind(productId).all();

  return (result.results || []).map(image => ({
    id: image.id,
    url: imageUrl(image.image_key),
    position: image.position
  }));
}

async function getProductById(env, productId) {
  return env.DB.prepare(`
    SELECT
      id,
      name,
      description,
      category,
      price,
      sale_price,
      stock,
      track_stock,
      active,
      created_at,
      updated_at
    FROM products
    WHERE id = ?
    LIMIT 1
  `).bind(productId).first();
}

function formatProduct(product, images = []) {
  const price = Number(product.price);
  const salePrice = product.sale_price === null
    ? null
    : Number(product.sale_price);

  const currentPrice = salePrice !== null ? salePrice : price;

  return {
    id: product.id,
    name: product.name,
    description: product.description,
    category: product.category,
    price,
    sale_price: salePrice,
    current_price: currentPrice,
    discount_percent: salePrice !== null && price > 0
      ? Math.round((1 - salePrice / price) * 100)
      : 0,
    stock: Number(product.stock),
    track_stock: Boolean(product.track_stock),
    active: Boolean(product.active),
    available: Boolean(product.active) &&
      (!product.track_stock || Number(product.stock) > 0),
    images,
    created_at: product.created_at,
    updated_at: product.updated_at
  };
}

/* =========================================================
   PUBLIC PRODUCT API
========================================================= */

async function publicGetProducts(request, env) {
  try {
    const url = new URL(request.url);
    const category = cleanText(url.searchParams.get("category") || "", 100);
    const search = cleanText(url.searchParams.get("q") || "", 100);

    let sql = `
      SELECT
        id,
        name,
        description,
        category,
        price,
        sale_price,
        stock,
        track_stock,
        active,
        created_at,
        updated_at
      FROM products
      WHERE active = 1
    `;

    const values = [];

    if (category) {
      sql += " AND category = ?";
      values.push(category);
    }

    if (search) {
      sql += " AND (name LIKE ? OR description LIKE ?)";
      values.push(`%${search}%`, `%${search}%`);
    }

    sql += " ORDER BY created_at DESC";

    const statement = env.DB.prepare(sql);
    const result = await (
      values.length ? statement.bind(...values) : statement
    ).all();

    const products = [];

    for (const product of result.results || []) {
      const images = await getProductImages(env, product.id);

      products.push(formatProduct(product, images));
    }

    return json({
      ok: true,
      products,
      categories: PRODUCT_CATEGORIES
    });
  } catch (error) {
    console.error("Public products error:", error.message);

    return json({
      ok: false,
      error: "Не вдалося завантажити каталог."
    }, 500);
  }
}

/* =========================================================
   ADMIN PRODUCT API
========================================================= */

async function adminGetProducts(env) {
  try {
    const result = await env.DB.prepare(`
      SELECT
        id,
        name,
        description,
        category,
        price,
        sale_price,
        stock,
        track_stock,
        active,
        created_at,
        updated_at
      FROM products
      ORDER BY created_at DESC
    `).all();

    const products = [];

    for (const product of result.results || []) {
      const images = await getProductImages(env, product.id);

      products.push(formatProduct(product, images));
    }

    return json({
      ok: true,
      products,
      categories: PRODUCT_CATEGORIES
    });
  } catch (error) {
    console.error("Admin products error:", error.message);

    return json({
      ok: false,
      error: "Не вдалося завантажити товари."
    }, 500);
  }
}

function validateProductInput(body, partial = false) {
  const data = {};

  if (!partial || Object.hasOwn(body, "name")) {
    data.name = cleanText(body.name, 180);

    if (!data.name) {
      return { error: "Вкажіть назву товару." };
    }
  }

  if (!partial || Object.hasOwn(body, "description")) {
    data.description = cleanText(body.description || "", 5000);
  }

  if (!partial || Object.hasOwn(body, "category")) {
    data.category = cleanText(body.category, 100);

    if (!data.category) {
      return { error: "Вкажіть категорію товару." };
    }
  }

  if (!partial || Object.hasOwn(body, "price")) {
    if (!validInteger(body.price, 1, 100000000)) {
      return { error: "Ціна повинна бути цілим числом більше нуля." };
    }

    data.price = Number(body.price);
  }

  if (!partial || Object.hasOwn(body, "sale_price")) {
    const value = body.sale_price;

    if (value === null || value === "" || value === undefined) {
      data.sale_price = null;
    } else {
      if (!validInteger(value, 1, 100000000)) {
        return { error: "Некоректна ціна зі знижкою." };
      }

      data.sale_price = Number(value);
    }
  }

  if (!partial || Object.hasOwn(body, "stock")) {
    if (!validInteger(body.stock, 0, 100000000)) {
      return { error: "Залишок повинен бути цілим числом від нуля." };
    }

    data.stock = Number(body.stock);
  }

  if (!partial || Object.hasOwn(body, "track_stock")) {
    data.track_stock = toBoolean(body.track_stock) ? 1 : 0;
  }

  if (!partial || Object.hasOwn(body, "active")) {
    data.active = toBoolean(body.active) ? 1 : 0;
  }

  const finalPrice = data.price;
  const finalSalePrice = data.sale_price;

  if (
    finalPrice !== undefined &&
    finalSalePrice !== undefined &&
    finalSalePrice !== null &&
    finalSalePrice >= finalPrice
  ) {
    return {
      error: "Ціна зі знижкою повинна бути меншою за звичайну ціну."
    };
  }

  return { data };
}

async function adminCreateProduct(request, env) {
  const body = await readJson(request);

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({
      ok: false,
      error: "Некоректні дані товару."
    }, 400);
  }

  const validation = validateProductInput(body);

  if (validation.error) {
    return json({
      ok: false,
      error: validation.error
    }, 400);
  }

  const data = validation.data;
  const id = productSlug(body.id || body.name);

  try {
    await env.DB.prepare(`
      INSERT INTO products (
        id,
        name,
        description,
        category,
        price,
        sale_price,
        stock,
        track_stock,
        active
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      data.name,
      data.description,
      data.category,
      data.price,
      data.sale_price,
      data.stock,
      data.track_stock,
      data.active
    ).run();

    const product = await getProductById(env, id);

    return json({
      ok: true,
      product: formatProduct(product, []),
      message: "Товар створено."
    }, 201);
  } catch (error) {
    console.error("Create product error:", error.message);

    if (String(error.message).toLowerCase().includes("unique")) {
      return json({
        ok: false,
        error: "Товар із таким ID вже існує. Спробуйте інший ID."
      }, 409);
    }

    return json({
      ok: false,
      error: "Не вдалося створити товар."
    }, 500);
  }
}

async function adminUpdateProduct(request, env, productId) {
  const body = await readJson(request);

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({
      ok: false,
      error: "Некоректні дані товару."
    }, 400);
  }

  const existing = await getProductById(env, productId);

  if (!existing) {
    return json({
      ok: false,
      error: "Товар не знайдено."
    }, 404);
  }

  const merged = {
    name: Object.hasOwn(body, "name") ? body.name : existing.name,
    description: Object.hasOwn(body, "description")
      ? body.description
      : existing.description,
    category: Object.hasOwn(body, "category")
      ? body.category
      : existing.category,
    price: Object.hasOwn(body, "price") ? body.price : existing.price,
    sale_price: Object.hasOwn(body, "sale_price")
      ? body.sale_price
      : existing.sale_price,
    stock: Object.hasOwn(body, "stock") ? body.stock : existing.stock,
    track_stock: Object.hasOwn(body, "track_stock")
      ? body.track_stock
      : existing.track_stock,
    active: Object.hasOwn(body, "active")
      ? body.active
      : existing.active
  };

  const validation = validateProductInput(merged);

  if (validation.error) {
    return json({
      ok: false,
      error: validation.error
    }, 400);
  }

  const data = validation.data;

  try {
    await env.DB.prepare(`
      UPDATE products
      SET name = ?,
          description = ?,
          category = ?,
          price = ?,
          sale_price = ?,
          stock = ?,
          track_stock = ?,
          active = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      data.name,
      data.description,
      data.category,
      data.price,
      data.sale_price,
      data.stock,
      data.track_stock,
      data.active,
      productId
    ).run();

    const updated = await getProductById(env, productId);
    const images = await getProductImages(env, productId);

    return json({
      ok: true,
      product: formatProduct(updated, images),
      message: "Товар оновлено."
    });
  } catch (error) {
    console.error("Update product error:", error.message);

    return json({
      ok: false,
      error: "Не вдалося оновити товар."
    }, 500);
  }
}

async function adminDeactivateProduct(env, productId) {
  try {
    const product = await getProductById(env, productId);

    if (!product) {
      return json({
        ok: false,
        error: "Товар не знайдено."
      }, 404);
    }

    await env.DB.prepare(`
      UPDATE products
      SET active = 0,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(productId).run();

    return json({
      ok: true,
      message: "Товар приховано з каталогу."
    });
  } catch (error) {
    console.error("Deactivate product error:", error.message);

    return json({
      ok: false,
      error: "Не вдалося приховати товар."
    }, 500);
  }
}

/* =========================================================
   PRODUCT IMAGE UPLOAD
========================================================= */

function extensionForImage(type) {
  const extensions = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif"
  };

  return extensions[type] || null;
}

async function adminUploadProductImages(request, env, productId) {
  if (!env.PRODUCT_IMAGES) {
    return json({
      ok: false,
      error: "R2 binding PRODUCT_IMAGES не налаштований."
    }, 500);
  }

  const product = await getProductById(env, productId);

  if (!product) {
    return json({
      ok: false,
      error: "Товар не знайдено."
    }, 404);
  }

  const contentLength = Number(request.headers.get("Content-Length") || 0);

  if (contentLength > MAX_IMAGE_SIZE * MAX_PRODUCT_IMAGES + 1024 * 1024) {
    return json({
      ok: false,
      error: "Загальний розмір завантаження завеликий."
    }, 413);
  }

  let form;

  try {
    form = await request.formData();
  } catch {
    return json({
      ok: false,
      error: "Не вдалося прочитати завантажені файли."
    }, 400);
  }

  const files = [
    ...form.getAll("images"),
    ...form.getAll("files")
  ].filter(value => value && typeof value !== "string");

  if (!files.length) {
    return json({
      ok: false,
      error: "Виберіть хоча б одне зображення."
    }, 400);
  }

  const current = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM product_images
    WHERE product_id = ?
  `).bind(productId).first();

  const currentCount = Number(current?.count || 0);

  if (currentCount + files.length > MAX_PRODUCT_IMAGES) {
    return json({
      ok: false,
      error: `Для одного товару дозволено максимум ${MAX_PRODUCT_IMAGES} фотографій.`
    }, 400);
  }

  const uploaded = [];
  const insertedIds = [];

  try {
    for (const file of files) {
      const extension = extensionForImage(file.type);

      if (!extension) {
        throw new Error(
          "Дозволені формати фотографій: JPG, PNG, WEBP та GIF."
        );
      }

      if (!file.size || file.size > MAX_IMAGE_SIZE) {
        throw new Error("Кожна фотографія повинна бути не більшою за 8 МБ.");
      }

      const key =
        `products/${productId}/${crypto.randomUUID()}.${extension}`;

      await env.PRODUCT_IMAGES.put(key, file.stream(), {
        httpMetadata: {
          contentType: file.type,
          cacheControl: "public, max-age=31536000, immutable"
        }
      });

      uploaded.push(key);

      const position = currentCount + uploaded.length - 1;

      const result = await env.DB.prepare(`
        INSERT INTO product_images (
          product_id,
          image_key,
          position
        )
        VALUES (?, ?, ?)
      `).bind(productId, key, position).run();

      insertedIds.push(result.meta.last_row_id);
    }

    const images = await getProductImages(env, productId);

    return json({
      ok: true,
      images,
      message: "Фотографії завантажено."
    }, 201);
  } catch (error) {
    console.error("Image upload error:", error.message);

    // При помилці прибираємо вже завантажені об'єкти та записи.
    for (const id of insertedIds) {
      await env.DB.prepare(`
        DELETE FROM product_images
        WHERE id = ?
      `).bind(id).run().catch(() => {});
    }

    for (const key of uploaded) {
      await env.PRODUCT_IMAGES.delete(key).catch(() => {});
    }

    return json({
      ok: false,
      error: error.message || "Не вдалося завантажити фотографії."
    }, 400);
  }
}

/* =========================================================
   PRODUCT IMAGE DELETE
========================================================= */

async function adminDeleteProductImage(env, productId, imageId) {
  if (!env.PRODUCT_IMAGES) {
    return json({
      ok: false,
      error: "R2 binding PRODUCT_IMAGES не налаштований."
    }, 500);
  }

  const image = await env.DB.prepare(`
    SELECT id, image_key
    FROM product_images
    WHERE id = ?
      AND product_id = ?
    LIMIT 1
  `).bind(imageId, productId).first();

  if (!image) {
    return json({
      ok: false,
      error: "Фотографію не знайдено."
    }, 404);
  }

  try {
    await env.PRODUCT_IMAGES.delete(image.image_key);

    await env.DB.prepare(`
      DELETE FROM product_images
      WHERE id = ?
        AND product_id = ?
    `).bind(imageId, productId).run();

    return json({
      ok: true,
      message: "Фотографію видалено."
    });
  } catch (error) {
    console.error("Delete image error:", error.message);

    return json({
      ok: false,
      error: "Не вдалося видалити фотографію."
    }, 500);
  }
}

/* =========================================================
   PRODUCT IMAGE ORDER
========================================================= */

async function adminReorderProductImages(request, env, productId) {
  const body = await readJson(request);

  if (!Array.isArray(body?.ids)) {
    return json({
      ok: false,
      error: "Передайте масив ID фотографій у полі ids."
    }, 400);
  }

  if (body.ids.length > MAX_PRODUCT_IMAGES) {
    return json({
      ok: false,
      error: "Забагато фотографій."
    }, 400);
  }

  const ids = body.ids.map(Number);

  if (
    ids.some(id => !Number.isSafeInteger(id) || id < 1) ||
    new Set(ids).size !== ids.length
  ) {
    return json({
      ok: false,
      error: "Некоректний список фотографій."
    }, 400);
  }

  try {
    const existing = await env.DB.prepare(`
      SELECT id
      FROM product_images
      WHERE product_id = ?
      ORDER BY position ASC, id ASC
    `).bind(productId).all();

    const existingIds = (existing.results || []).map(row => Number(row.id));

    if (
      existingIds.length !== ids.length ||
      existingIds.some(id => !ids.includes(id))
    ) {
      return json({
        ok: false,
        error: "Список фотографій змінився. Оновіть сторінку."
      }, 409);
    }

    const statements = ids.map((id, index) =>
      env.DB.prepare(`
        UPDATE product_images
        SET position = ?
        WHERE id = ?
          AND product_id = ?
      `).bind(index, id, productId)
    );

    if (statements.length) {
      await env.DB.batch(statements);
    }

    return json({
      ok: true,
      images: await getProductImages(env, productId),
      message: "Порядок фотографій оновлено."
    });
  } catch (error) {
    console.error("Reorder images error:", error.message);

    return json({
      ok: false,
      error: "Не вдалося змінити порядок фотографій."
    }, 500);
  }
}

/* =========================================================
   PRIVATE R2 IMAGE DELIVERY
========================================================= */

async function serveProductImage(request, env, url) {
  if (!env.PRODUCT_IMAGES) {
    return new Response("Image storage is not configured.", {
      status: 503
    });
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed.", {
      status: 405,
      headers: { Allow: "GET, HEAD" }
    });
  }

  let key;

  try {
    const encodedKey = url.pathname.slice("/media/".length);
    key = decodeURIComponent(encodedKey);
  } catch {
    return new Response("Invalid image path.", { status: 400 });
  }

  if (
    !key ||
    !key.startsWith("products/") ||
    key.includes("..") ||
    key.includes("\\") ||
    key.includes("\0")
  ) {
    return new Response("Invalid image path.", { status: 400 });
  }

  try {
    const object = await env.PRODUCT_IMAGES.get(key);

    if (!object) {
      return new Response("Image not found.", { status: 404 });
    }

    const headers = new Headers();

    object.writeHttpMetadata(headers);

    headers.set("ETag", object.httpEtag);
    headers.set(
      "Cache-Control",
      "public, max-age=31536000, immutable"
    );
    headers.set("X-Content-Type-Options", "nosniff");

    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/octet-stream");
    }

    if (request.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers
      });
    }

    return new Response(object.body, {
      status: 200,
      headers
    });
  } catch (error) {
    console.error("R2 image delivery error:", error.message);

    return new Response("Image service error.", { status: 500 });
  }
}

/* =========================================================
   CREATE ORDER — DYNAMIC D1 PRODUCTS
========================================================= */

async function createOrder(request, env) {
  const body = await readJson(request);

  if (!body || typeof body !== "object") {
    return json({
      ok: false,
      error: "Некоректні дані замовлення."
    }, 400);
  }

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

  // Об'єднуємо однакові товари, щоб не можна було обійти перевірку залишків.
  const quantities = new Map();

  for (const item of body.items) {
    const productId = cleanText(item?.id, 100);
    const quantity = Number(item?.quantity);

    if (!productId) {
      return json({
        ok: false,
        error: "Некоректний товар у кошику."
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

    quantities.set(
      productId,
      (quantities.get(productId) || 0) + quantity
    );
  }

  const orderItems = [];
  let totalAmount = 0;

  try {
    for (const [productId, quantity] of quantities.entries()) {
      if (quantity > 99) {
        return json({
          ok: false,
          error: "Максимальна кількість одного товару — 99."
        }, 400);
      }

      const product = await getProductById(env, productId);

      if (!product || !product.active) {
        return json({
          ok: false,
          error: "Один із товарів більше недоступний."
        }, 400);
      }

      if (product.track_stock && Number(product.stock) < quantity) {
        return json({
          ok: false,
          error: `Недостатньо товару «${product.name}» на складі. Залишок: ${product.stock}.`
        }, 409);
      }

      const price = effectivePrice(product);
      const lineTotal = price * quantity;

      if (
        !Number.isSafeInteger(price) ||
        price <= 0 ||
        !Number.isSafeInteger(lineTotal)
      ) {
        return json({
          ok: false,
          error: "Некоректна ціна товару."
        }, 400);
      }

      totalAmount += lineTotal;

      orderItems.push({
        id: productId,
        name: product.name,
        price,
        quantity,
        trackStock: Boolean(product.track_stock)
      });
    }

    if (
      !Number.isSafeInteger(totalAmount) ||
      totalAmount <= 0
    ) {
      return json({
        ok: false,
        error: "Некоректна сума замовлення."
      }, 400);
    }

    /*
      Резервуємо залишки умовним UPDATE.
      Якщо товару вже не вистачає через паралельне замовлення,
      UPDATE не змінить рядок і оформлення буде зупинено.
    */

    const reserved = [];

    try {
      for (const item of orderItems) {
        if (!item.trackStock) continue;

        const result = await env.DB.prepare(`
          UPDATE products
          SET stock = stock - ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND active = 1
            AND track_stock = 1
            AND stock >= ?
        `).bind(
          item.quantity,
          item.id,
          item.quantity
        ).run();

        if (!(result.meta?.changes > 0)) {
          throw new Error(
            `Не вдалося зарезервувати товар «${item.name}». Можливо, його вже купили.`
          );
        }

        reserved.push(item);
      }

      const orderNumber = generateOrderNumber();

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
            SELECT
              id,
              ?,
              ?,
              ?,
              ?
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
        console.error(
          "Telegram link creation error:",
          error.message
        );
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
      // Повертаємо зарезервований залишок, якщо створення замовлення не вдалося.
      for (const item of reserved) {
        await env.DB.prepare(`
          UPDATE products
          SET stock = stock + ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(item.quantity, item.id).run().catch(rollbackError => {
          console.error(
            "Stock rollback error:",
            rollbackError.message
          );
        });
      }

      throw error;
    }
  } catch (error) {
    console.error("Create order error:", error.message);

    if (
      error.message &&
      error.message.startsWith("Не вдалося зарезервувати товар")
    ) {
      return json({
        ok: false,
        error: error.message
      }, 409);
    }

    return json({
      ok: false,
      error: "Не вдалося зберегти замовлення. Спробуйте ще раз."
    }, 500);
  }
}

/* =========================================================
   ADMIN LOGIN
========================================================= */

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

/* =========================================================
   ADMIN ORDERS
========================================================= */

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
      `).bind(order.id).all();

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
    const current = await env.DB.prepare(`
      SELECT status
      FROM orders
      WHERE id = ?
      LIMIT 1
    `).bind(orderId).first();

    if (!current) {
      return json({
        ok: false,
        error: "Замовлення не знайдено."
      }, 404);
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

/* =========================================================
   ADMIN SUPPORT API
========================================================= */

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
      SELECT
        id,
        telegram_id,
        customer_name,
        status,
        created_at,
        updated_at
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

    const latestBuyerMessage = await env.DB.prepare(`
      SELECT COALESCE(MAX(id), 0) AS id
      FROM support_messages
      WHERE chat_id = ?
        AND sender = 'buyer'
    `).bind(chatId).first();

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
      SELECT
        id,
        sender,
        message_text,
        created_at
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

    await saveSupportMessage(
      env,
      chatId,
      "admin",
      answer
    );

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

/* =========================================================
   ROUTER
========================================================= */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    try {
      /* ---------------- PUBLIC IMAGE DELIVERY ---------------- */

      if (path.startsWith("/media/")) {
        return serveProductImage(request, env, url);
      }

      /* ---------------- HEALTH ---------------- */

      if (path === "/api/health" && method === "GET") {
        return healthCheck(env);
      }

      /* ---------------- PUBLIC PRODUCTS ---------------- */

      if (path === "/api/products" && method === "GET") {
        return publicGetProducts(request, env);
      }

      /* ---------------- TELEGRAM WEBHOOK ---------------- */

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

      /* ---------------- CREATE ORDER ---------------- */

      if (path === "/api/orders" && method === "POST") {
        return createOrder(request, env);
      }

      /* ---------------- ADMIN LOGIN ---------------- */

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

      /* ---------------- ADMIN API AUTHORIZATION ---------------- */

      if (path.startsWith("/api/admin/")) {
        const authorized = await requireAdmin(request, env);

        if (!authorized) {
          return json({
            ok: false,
            error: "Потрібно увійти як адміністратор."
          }, 401);
        }

        /* ---------------- TELEGRAM WEBHOOK SETUP ---------------- */

        if (path === "/api/admin/telegram/webhook/setup") {
          if (method !== "POST") {
            return json({
              ok: false,
              error: "Для налаштування webhook використовуйте POST."
            }, 405, {
              Allow: "POST"
            });
          }

          try {
            await configureTelegramWebhook(env);

            return json({
              ok: true,
              message: "Telegram webhook успішно налаштовано."
            });
          } catch (error) {
            console.error("Webhook setup error:", error.message);

            return json({
              ok: false,
              error: "Не вдалося налаштувати Telegram webhook."
            }, 500);
          }
        }

        /* ---------------- ADMIN PRODUCTS ---------------- */

        if (path === "/api/admin/products" && method === "GET") {
          return adminGetProducts(env);
        }

        if (path === "/api/admin/products" && method === "POST") {
          return adminCreateProduct(request, env);
        }

        const productImagesMatch = path.match(
          /^\/api\/admin\/products\/([^/]+)\/images$/
        );

        if (productImagesMatch) {
          const productId = decodeURIComponent(productImagesMatch[1]);

          if (method === "POST") {
            return adminUploadProductImages(
              request,
              env,
              productId
            );
          }

          if (method === "PATCH") {
            return adminReorderProductImages(
              request,
              env,
              productId
            );
          }
        }

        const productImageDeleteMatch = path.match(
          /^\/api\/admin\/products\/([^/]+)\/images\/(\d+)$/
        );

        if (
          productImageDeleteMatch &&
          method === "DELETE"
        ) {
          return adminDeleteProductImage(
            env,
            decodeURIComponent(productImageDeleteMatch[1]),
            Number(productImageDeleteMatch[2])
          );
        }

        const productMatch = path.match(
          /^\/api\/admin\/products\/([^/]+)$/
        );

        if (productMatch) {
          const productId = decodeURIComponent(productMatch[1]);

          if (method === "PATCH" || method === "PUT") {
            return adminUpdateProduct(
              request,
              env,
              productId
            );
          }

          if (method === "DELETE") {
            return adminDeactivateProduct(
              env,
              productId
            );
          }
        }

        /* ---------------- ADMIN ORDERS ---------------- */

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

        /* ---------------- ADMIN SUPPORT ---------------- */

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

      /* ---------------- STATIC ASSETS ---------------- */

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
