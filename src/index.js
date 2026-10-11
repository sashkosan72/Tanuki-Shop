
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

  let result;

  try {
    result = await response.json();
  } catch {
    throw new Error(
      `Telegram ${method}: invalid response (${response.status})`
    );
  }

  if (!response.ok || !result.ok) {
    console.error("Telegram API error:", {
      method,
      status: response.status,
      description: result.description || "Unknown error"
    });

    throw new Error(
      `Telegram ${method} failed: ${
        result.description || response.status
      }`
    );
  }

  console.log(`Telegram ${method}: success`);

  return result;
}
