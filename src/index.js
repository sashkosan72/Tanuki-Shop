/* -------------------- BUYER SUPPORT -------------------- */

async function handleBuyerSupport(
  env,
  chatId,
  telegramUser,
  messageText
) {
  const adminChat = env.TELEGRAM_CHAT_ID;
  const safeText = cleanText(messageText, 1500);

  if (!adminChat) {
    await sendBuyerMenu(
      env,
      chatId,
      "💬 Підтримка тимчасово недоступна."
    );
    return;
  }

  if (!safeText) {
    await sendBuyerMenu(
      env,
      chatId,
      "Напишіть повідомлення, і ми передамо його адміністратору."
    );
    return;
  }

  const telegramId = String(telegramUser.id);

  const customer = await env.DB.prepare(`
    SELECT id
    FROM telegram_customers
    WHERE telegram_id = ?
    LIMIT 1
  `)
    .bind(telegramId)
    .first();

  if (!customer) {
    await sendBuyerMenu(
      env,
      chatId,
      "Спочатку прив'яжіть своє замовлення через посилання з сайту Tanuki Shop."
    );
    return;
  }

  try {
    await telegramCall(env, "sendMessage", {
      chat_id: adminChat,
      text: [
        "💬 ПОВІДОМЛЕННЯ ДО ПІДТРИМКИ TANUKI SHOP",
        "",
        `👤 ${telegramDisplayName(telegramUser)}`,
        `🆔 Telegram ID: ${telegramId}`,
        "",
        safeText,
        "",
        "↩️ Натисніть Reply, щоб відповісти покупцеві."
      ].join("\n")
    });

    await sendBuyerMenu(
      env,
      chatId,
      "✅ Повідомлення передано підтримці Tanuki Shop!\n\nОчікуйте на відповідь у цьому чаті."
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

/* -------------------- ADMIN SUPPORT REPLY -------------------- */

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

  const match = originalText.match(
    /Telegram ID:\s*(\d+)/
  );

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
    await sendBuyerMessage(
      env,
      buyerTelegramId,
      [
        "🦝 Tanuki Shop — відповідь підтримки",
        "",
        answer
      ].join("\n")
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
