(() => {
  "use strict";

  let user = null;
  const $ = id => document.getElementById(id);

  async function api(path, data) {
    const response = await fetch(path, data === undefined ? {} : {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) throw new Error(result.error || "Спробуйте пізніше.");
    return result;
  }

  function message(text, error = false) {
    const target = $("accountMessage");
    if (!target) return;
    target.textContent = text;
    target.classList.toggle("error", error);
  }

  function open() {
    $("accountModal").hidden = false;
    document.body.classList.add("account-open");
    $("closeAccount").focus();
  }

  function close() {
    $("accountModal").hidden = true;
    document.body.classList.remove("account-open");
    $("accountButton").focus();
  }

  function toggleForm(register) {
    $("loginForm").hidden = register;
    $("registerForm").hidden = !register;
    $("showLogin").classList.toggle("selected", !register);
    $("showRegister").classList.toggle("selected", register);
    message("");
  }

  function createLine(label) {
    const item = document.createElement("p");
    item.textContent = label;
    return item;
  }

  async function loadOrders() {
    const container = $("accountOrders");
    container.replaceChildren(createLine("Завантаження замовлень…"));
    try {
      const { orders } = await api("/api/account/orders");
      if (!orders.length) {
        container.replaceChildren(createLine("У вас ще немає замовлень."));
        return;
      }
      container.replaceChildren();
      for (const order of orders) {
        const card = document.createElement("article");
        card.className = "account-order";
        const title = document.createElement("strong");
        title.textContent = `📦 ${order.order_number} · ${order.total_amount} ₴`;
        card.append(title, createLine(`Статус: ${order.status}`));
        for (const item of order.items) {
          card.append(createLine(`${item.product_name} × ${item.quantity}`));
        }
        container.append(card);
      }
    } catch (error) {
      container.replaceChildren(createLine("Не вдалося завантажити замовлення."));
    }
  }

  function showCurrent() {
    $("accountGuest").hidden = Boolean(user);
    $("accountUser").hidden = !user;
    $("accountButton").textContent = user ? "👤 Кабінет" : "👤 Увійти";
    if (user) {
      $("accountWelcome").textContent = `Привіт, ${user.name}! 🦝`;
      $("accountEmail").textContent = user.email ? `${user.email} · підтверджено` : "Вхід через Telegram";
      $("telegramConnect").hidden = user.telegram_connected;
      void loadOrders();
    }
  }

  async function refresh() {
    try {
      const current = await api("/api/auth/me");
      user = current.authenticated ? current.user : null;
    } catch {
      user = null;
    }
    showCurrent();
    return Boolean(user);
  }

  async function requireLogin() {
    if (await refresh()) return true;
    open();
    message("Щоб оформити замовлення, зареєструйтеся або увійдіть.");
    return false;
  }

  async function submit(form, path, payload, onSuccess) {
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    message("Зачекайте…");
    try {
      const result = await api(path, payload);
      await onSuccess(result);
    } catch (error) {
      message(error.message, true);
    } finally {
      button.disabled = false;
    }
  }

  function telegramWidget(container) {
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.setAttribute("data-telegram-login", "TanukiShopNotifyBot");
    script.setAttribute("data-size", "large");
    script.setAttribute("data-radius", "12");
    script.setAttribute("data-onauth", "onTanukiTelegramAuth(user)");
    script.setAttribute("data-request-access", "write");
    container.appendChild(script);
  }

  window.onTanukiTelegramAuth = async telegramUser => {
    open();
    message("Перевіряємо Telegram…");
    try {
      const result = await api("/api/auth/telegram", telegramUser);
      user = result.user;
      showCurrent();
      message("Telegram успішно підключено!");
    } catch (error) {
      message(error.message, true);
    }
  };

  window.tanukiAuth = { open, requireLogin };

  document.addEventListener("DOMContentLoaded", () => {
    $("accountButton").addEventListener("click", open);
    $("closeAccount").addEventListener("click", close);
    $("accountOverlay").addEventListener("click", close);
    $("showLogin").addEventListener("click", () => toggleForm(false));
    $("showRegister").addEventListener("click", () => toggleForm(true));
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !$("accountModal").hidden) close();
    });

    $("loginForm").addEventListener("submit", event => {
      event.preventDefault();
      void submit(event.currentTarget, "/api/auth/login", {
        email: $("loginEmail").value.trim(),
        password: $("loginPassword").value
      }, async result => {
        $("loginPassword").value = "";
        user = result.user;
        showCurrent();
        message("Ви увійшли в акаунт!");
      });
    });

    $("registerForm").addEventListener("submit", event => {
      event.preventDefault();
      void submit(event.currentTarget, "/api/auth/register", {
        name: $("registerName").value.trim(),
        email: $("registerEmail").value.trim(),
        password: $("registerPassword").value
      }, async result => {
        $("registerPassword").value = "";
        const email = $("registerEmail").value.trim();
        toggleForm(false);
        $("loginEmail").value = email;
        $("resendEmail").value = email;
        message(result.message);
      });
    });

    $("resendForm").addEventListener("submit", event => {
      event.preventDefault();
      void submit(event.currentTarget, "/api/auth/resend", {
        email: $("resendEmail").value.trim()
      }, async result => message(result.message));
    });

    $("logoutAccount").addEventListener("click", async () => {
      try {
        await api("/api/auth/logout", {});
        user = null;
        showCurrent();
        message("Ви вийшли з акаунта.");
      } catch (error) { message(error.message, true); }
    });

    telegramWidget($("telegramLogin"));
    telegramWidget($("telegramConnectWidget"));

    const match = /^#verify=([a-f0-9]{64})$/.exec(window.location.hash);
    if (match) {
      // Прибираємо токен із адресного рядка, щойно браузер його прочитав.
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      open();
      message("Підтверджуємо електронну адресу…");
      api("/api/auth/verify", { token: match[1] })
        .then(result => message(result.message))
        .catch(error => message(error.message, true));
    }
    void refresh();
  });
})();
