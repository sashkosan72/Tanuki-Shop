// Покупці Tanuki Shop. Не використовує існуючу admin-сесію.
const COOKIE_NAME = "__Host-tanuki_customer";
const PENDING_COOKIE_NAME = "__Host-tanuki_registration";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const PENDING_SECONDS = 15 * 60;
const PASSWORD_ITERATIONS = 210_000;
const enc = new TextEncoder();

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers }
  });
}

function cookie(value, maxAge = SESSION_SECONDS) {
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function pendingCookie(value, maxAge = PENDING_SECONDS) {
  return `${PENDING_COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function jsonWithCookies(body, cookies, status = 200) {
  const response = json(body, status);
  for (const value of cookies) response.headers.append("Set-Cookie", value);
  return response;
}

function readNamedCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  const item = header.split(";").map(part => part.trim()).find(part => part.startsWith(`${name}=`));
  if (!item) return null;
  try { return decodeURIComponent(item.slice(name.length + 1)); } catch { return null; }
}

function readCookie(request) {
  return readNamedCookie(request, COOKIE_NAME);
}

function hex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

async function digest(value) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value))));
}

function fromHex(value) {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{2})+$/i.test(value)) return null;
  return Uint8Array.from(value.match(/.{2}/g), byte => parseInt(byte, 16));
}

function constantTimeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function passwordHash(password, salt) {
  const raw = fromHex(salt);
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(new Uint8Array(await crypto.subtle.deriveBits({
    name: "PBKDF2", hash: "SHA-256", salt: raw, iterations: PASSWORD_ITERATIONS
  }, key, 256)));
}

function emailAddress(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null;
}

async function bodyFrom(request) {
  const size = Number(request.headers.get("Content-Length") || 0);
  if (size > 8192 || !request.headers.get("Content-Type")?.includes("application/json")) return null;
  try {
    const raw = await request.text();
    if (raw.length > 8192) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  return (!origin || origin === new URL(request.url).origin) && fetchSite !== "cross-site";
}

function publicCustomer(row) {
  return {
    id: row.id,
    name: row.display_name || "Покупець",
    email: row.email || null,
    email_verified: Boolean(row.email_verified_at),
    telegram_connected: Boolean(row.telegram_id)
  };
}

export async function customerFromRequest(request, env) {
  const token = readCookie(request);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const tokenHash = await digest(token);
  return env.DB.prepare(`
    SELECT c.id, c.email, c.display_name, c.email_verified_at, c.telegram_id
    FROM customer_sessions s JOIN customers c ON c.id = s.customer_id
    WHERE s.token_hash = ? AND s.expires_at > CURRENT_TIMESTAMP
    LIMIT 1
  `).bind(tokenHash).first();
}

async function newSession(env, customerId) {
  const token = randomToken();
  await env.DB.prepare(`
    INSERT INTO customer_sessions(token_hash, customer_id, expires_at)
    VALUES (?, ?, datetime('now', '+7 days'))
  `).bind(await digest(token), customerId).run();
  return token;
}

async function sendVerification(env, customerId, email) {
  const token = randomToken();
  const verifyUrl = `https://tanukishop.pp.ua/#verify=${token}`;
  await env.DB.prepare(`
    INSERT INTO customer_email_verifications(customer_id, token_hash, expires_at)
    VALUES (?, ?, datetime('now', '+24 hours'))
    ON CONFLICT(customer_id) DO UPDATE SET token_hash=excluded.token_hash,
      expires_at=excluded.expires_at, created_at=CURRENT_TIMESTAMP
  `).bind(customerId, await digest(token)).run();
  await env.EMAIL.send({
    to: email,
    from: { email: env.EMAIL_FROM || "noreply@tanukishop.pp.ua", name: "Tanuki Shop" },
    subject: "Підтвердіть email — Tanuki Shop",
    text: `Привіт! Підтвердьте вашу адресу для Tanuki Shop:\n${verifyUrl}\n\nПосилання дійсне 24 години. Якщо ви не реєструвалися, проігноруйте лист.`
  });
}

async function emailRegister(request, env) {
  const body = await bodyFrom(request);
  const email = emailAddress(body?.email);
  const password = body?.password;
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 100) : "";
  if (!email || typeof password !== "string" || password.length < 12 || password.length > 128) {
    return json({ ok: false, error: "Перевірте email і пароль (від 12 до 128 символів)." }, 400);
  }
  const existing = await env.DB.prepare("SELECT id FROM customers WHERE email = ? LIMIT 1").bind(email).first();
  if (existing) return json({ ok: false, error: "Цей email уже зареєстрований. Увійдіть в акаунт." }, 409);

  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await passwordHash(password, salt);
  const token = randomToken();
  try {
    // Заявка не створює акаунт. Вона стане акаунтом лише після перевірки Telegram.
    await env.DB.prepare("DELETE FROM customer_registration_attempts WHERE expires_at <= CURRENT_TIMESTAMP").bind().run();
    await env.DB.prepare(`
      INSERT INTO customer_registration_attempts
        (token_hash, email, display_name, password_salt, password_hash, expires_at)
      VALUES (?, ?, ?, ?, ?, datetime('now', '+15 minutes'))
    `).bind(await digest(token), email, name, salt, hash).run();
    return jsonWithCookies({
      ok: true,
      message: "Тепер підтвердіть реєстрацію через Telegram протягом 15 хвилин."
    }, [pendingCookie(token)], 201);
  } catch (error) {
    console.error("Customer registration error:", error.message);
    return json({ ok: false, error: "Не вдалося створити заявку на реєстрацію. Спробуйте пізніше." }, 503);
  }
}

async function cancelRegistration(request, env) {
  const token = readNamedCookie(request, PENDING_COOKIE_NAME);
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    await env.DB.prepare("DELETE FROM customer_registration_attempts WHERE token_hash = ?")
      .bind(await digest(token)).run();
  }
  return jsonWithCookies({ ok: true, message: "Незавершену реєстрацію скасовано." }, [pendingCookie("", 0)]);
}

async function resendVerification(request, env) {
  if (!env.EMAIL?.send) return json({ ok: false, error: "Відправка листів ще не налаштована." }, 503);
  const body = await bodyFrom(request);
  const email = emailAddress(body?.email);
  if (!email) return json({ ok: false, error: "Вкажіть коректний email." }, 400);
  const row = await env.DB.prepare(`
    SELECT id FROM customers WHERE email = ? AND email_verified_at IS NULL LIMIT 1
  `).bind(email).first();
  // Не розкриваємо, чи існує обліковий запис.
  if (row && env.EMAIL?.send) {
    try { await sendVerification(env, row.id, email); }
    catch (error) { console.error("Email resend failed:", error.message); return json({ ok: false, error: "Сервіс листів тимчасово недоступний." }, 503); }
  }
  return json({ ok: true, message: "Якщо email очікує підтвердження, ми надіслали лист." });
}

async function verifyEmail(request, env) {
  const body = await bodyFrom(request);
  const token = body?.token;
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) {
    return json({ ok: false, error: "Недійсне посилання підтвердження." }, 400);
  }
  const tokenHash = await digest(token);
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE customers SET email_verified_at = CURRENT_TIMESTAMP
      WHERE id = (SELECT customer_id FROM customer_email_verifications
        WHERE token_hash = ? AND expires_at > CURRENT_TIMESTAMP)
        AND email_verified_at IS NULL
    `).bind(tokenHash),
    env.DB.prepare("DELETE FROM customer_email_verifications WHERE token_hash = ?").bind(tokenHash)
  ]);
  if (!(results[0]?.meta?.changes || 0)) return json({ ok: false, error: "Посилання вже використано або його термін минув." }, 400);
  return json({ ok: true, message: "Email підтверджено! Тепер можете увійти." });
}

async function emailLogin(request, env) {
  const body = await bodyFrom(request);
  const email = emailAddress(body?.email);
  const password = body?.password;
  if (!email || typeof password !== "string" || password.length > 128) {
    return json({ ok: false, error: "Неправильний email або пароль." }, 401);
  }
  const row = await env.DB.prepare(`
    SELECT * FROM customers WHERE email = ? LIMIT 1
  `).bind(email).first();
  if (!row?.password_hash || !row.password_salt) return json({ ok: false, error: "Неправильний email або пароль." }, 401);
  const actual = await passwordHash(password, row.password_salt);
  if (!constantTimeEqual(fromHex(actual), fromHex(row.password_hash))) return json({ ok: false, error: "Неправильний email або пароль." }, 401);
  // Старі акаунти без Telegram можуть увійти лише для прив'язування Telegram.
  // Checkout перевіряє Telegram окремо на сервері.
  const token = await newSession(env, row.id);
  return jsonWithCookies({ ok: true, user: publicCustomer(row), needs_telegram: !row.telegram_id },
    [cookie(token), pendingCookie("", 0)]);
}

async function telegramValid(data, token) {
  if (!token || typeof data?.hash !== "string" || !/^[a-f0-9]{64}$/i.test(data.hash)) return false;
  if (!/^\d{1,20}$/.test(String(data.id || ""))) return false;
  const authDate = Number(data.auth_date);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(authDate) || authDate > now + 60 || now - authDate > 300) return false;
  const allowed = ["auth_date", "first_name", "id", "last_name", "photo_url", "username"];
  if (Object.keys(data).some(field => field !== "hash" && !allowed.includes(field))) return false;
  const pairs = [];
  for (const key of allowed) {
    if (data[key] === undefined) continue;
    if (!["string", "number"].includes(typeof data[key])) return false;
    const value = String(data[key]);
    if (value.length > 500 || value.includes("\n")) return false;
    pairs.push(`${key}=${value}`);
  }
  // Сортування ключів уже в алфавітному порядку; інші поля відкидаються.
  const secretKey = await crypto.subtle.digest("SHA-256", enc.encode(token));
  const key = await crypto.subtle.importKey("raw", secretKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(pairs.join("\n"))));
  return constantTimeEqual(signed, fromHex(data.hash));
}

async function telegramLogin(request, env) {
  if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: "Telegram-вхід не налаштований." }, 503);
  const body = await bodyFrom(request);
  if (!body || !(await telegramValid(body, env.TELEGRAM_BOT_TOKEN))) return json({ ok: false, error: "Не вдалося перевірити дані Telegram." }, 401);
  const telegramId = String(body.id);
  const name = [body.first_name, body.last_name].filter(part => typeof part === "string").join(" ").trim().slice(0, 100) || "Покупець";
  const active = await customerFromRequest(request, env);
  if (active) {
    const occupied = await env.DB.prepare("SELECT id FROM customers WHERE telegram_id = ?").bind(telegramId).first();
    if ((occupied && occupied.id !== active.id) || (active.telegram_id && active.telegram_id !== telegramId)) {
      return json({ ok: false, error: "Цей Telegram уже пов'язаний з іншим акаунтом." }, 409);
    }
    try {
      await env.DB.prepare("UPDATE customers SET telegram_id = ? WHERE id = ? AND (telegram_id IS NULL OR telegram_id = ?)")
        .bind(telegramId, active.id, telegramId).run();
    } catch {
      return json({ ok: false, error: "Цей Telegram уже пов'язаний з іншим акаунтом." }, 409);
    }
    const row = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(active.id).first();
    if (row?.telegram_id !== telegramId) {
      return json({ ok: false, error: "Не вдалося прив'язати Telegram до цього акаунта." }, 409);
    }
    return json({ ok: true, user: publicCustomer(row) });
  }

  const pendingToken = readNamedCookie(request, PENDING_COOKIE_NAME);
  if (pendingToken !== null) {
    if (!/^[a-f0-9]{64}$/.test(pendingToken)) {
      return json({ ok: false, error: "Недійсна заявка на реєстрацію." }, 400);
    }
    const pendingHash = await digest(pendingToken);
    const pending = await env.DB.prepare(`
      SELECT email FROM customer_registration_attempts
      WHERE token_hash = ? AND expires_at > CURRENT_TIMESTAMP LIMIT 1
    `).bind(pendingHash).first();
    if (!pending) {
      return jsonWithCookies({ ok: false, error: "Час підтвердження минув. Зареєструйтеся ще раз." },
        [pendingCookie("", 0)], 410);
    }
    try {
      // INSERT і видалення використаної заявки атомарні. Діючі акаунти не змінюємо.
      const results = await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO customers(email, display_name, password_salt, password_hash, telegram_id)
          SELECT r.email, r.display_name, r.password_salt, r.password_hash, ?
          FROM customer_registration_attempts r
          WHERE r.token_hash = ? AND r.expires_at > CURRENT_TIMESTAMP
            AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.email = r.email OR c.telegram_id = ?)
        `).bind(telegramId, pendingHash, telegramId),
        env.DB.prepare(`
          DELETE FROM customer_registration_attempts
          WHERE token_hash = ? AND EXISTS (
            SELECT 1 FROM customers WHERE email = ? AND telegram_id = ?
          )
        `).bind(pendingHash, pending.email, telegramId)
      ]);
      if (!(results[0]?.meta?.changes || 0)) {
        return json({ ok: false, error: "Email або Telegram уже прив'язано до іншого акаунта. Увійдіть у свій акаунт." }, 409);
      }
      const row = await env.DB.prepare("SELECT * FROM customers WHERE telegram_id = ?").bind(telegramId).first();
      const token = await newSession(env, row.id);
      return jsonWithCookies({ ok: true, user: publicCustomer(row) },
        [cookie(token), pendingCookie("", 0)]);
    } catch (error) {
      console.error("Telegram registration error:", error.message);
      return json({ ok: false, error: "Не вдалося підтвердити акаунт. Перевірте, чи email або Telegram вже не зайнятий." }, 409);
    }
  }

  // Старий спосіб входу тільки через Telegram зберігається.
  await env.DB.prepare(`
    INSERT INTO customers(telegram_id, display_name) VALUES (?, ?)
    ON CONFLICT(telegram_id) DO NOTHING
  `).bind(telegramId, name).run();
  const row = await env.DB.prepare("SELECT * FROM customers WHERE telegram_id = ?").bind(telegramId).first();
  const token = await newSession(env, row.id);
  return json({ ok: true, user: publicCustomer(row) }, 200, { "Set-Cookie": cookie(token) });
}

async function accountOrders(env, customerId) {
  const orders = await env.DB.prepare(`
    SELECT o.id, o.order_number, o.total_amount, o.status, o.created_at
    FROM customer_orders co JOIN orders o ON o.id = co.order_id
    WHERE co.customer_id = ? ORDER BY o.id DESC LIMIT 50
  `).bind(customerId).all();
  const result = [];
  for (const order of orders.results || []) {
    const items = await env.DB.prepare(`
      SELECT product_name, price, quantity FROM order_items WHERE order_id = ?
    `).bind(order.id).all();
    result.push({ ...order, items: items.results || [] });
  }
  return json({ ok: true, orders: result });
}

export async function routeCustomerApi(request, env, checkRateLimit) {
  const path = new URL(request.url).pathname;
  const method = request.method.toUpperCase();
  if (path === "/api/auth/me" && method === "GET") {
    const customer = await customerFromRequest(request, env);
    const pending = !customer && readNamedCookie(request, PENDING_COOKIE_NAME);
    return json({
      ok: true,
      authenticated: Boolean(customer),
      user: customer ? publicCustomer(customer) : null,
      pending_registration: Boolean(pending)
    });
  }
  if (path === "/api/account/orders" && method === "GET") {
    const customer = await customerFromRequest(request, env);
    return customer ? accountOrders(env, customer.id) : json({ ok: false, error: "Увійдіть в акаунт." }, 401);
  }
  if (method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);
  if (!sameOrigin(request)) return json({ ok: false, error: "Запит з іншого сайту заборонено." }, 403);
  if (path === "/api/auth/logout") {
    const token = readCookie(request);
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      await env.DB.prepare("DELETE FROM customer_sessions WHERE token_hash = ?").bind(await digest(token)).run();
    }
    return jsonWithCookies({ ok: true }, [cookie("", 0), pendingCookie("", 0)]);
  }
  const limited = await checkRateLimit(request, env.CUSTOMER_AUTH_LIMITER);
  if (limited) return limited;
  if (path === "/api/auth/register") return emailRegister(request, env);
  if (path === "/api/auth/cancel-registration") return cancelRegistration(request, env);
  if (path === "/api/auth/login") return emailLogin(request, env);
  if (path === "/api/auth/verify") return verifyEmail(request, env);
  if (path === "/api/auth/resend") return resendVerification(request, env);
  if (path === "/api/auth/telegram") return telegramLogin(request, env);
  return json({ ok: false, error: "Endpoint not found." }, 404);
}
