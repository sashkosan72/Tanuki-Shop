// Preview never falls back to the production Telegram bot or origin.
export function telegramBotUsername(env) {
  const name = env.TELEGRAM_BOT_USERNAME || (env.ENVIRONMENT === 'preview' ? '' : 'TanukiShopNotifyBot');
  if (env.ENVIRONMENT === 'preview' && name.toLowerCase() === 'tanukishopnotifybot') return '';
  return /^[A-Za-z0-9_]{5,32}$/.test(name) ? name : '';
}

export function siteOrigin(env) {
  const value = env.SITE_ORIGIN || (env.ENVIRONMENT === 'preview' ? '' : 'https://tanukishop.pp.ua');
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return '';
    if (env.ENVIRONMENT === 'preview' && url.hostname === 'tanukishop.pp.ua') return '';
    return url.origin;
  } catch { return ''; }
}

export function telegramReady(env) {
  return !!(telegramBotUsername(env) && siteOrigin(env) && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET);
}
