// Значения, нужные сразу нескольким модулям. Строку User-Agent требуют Nominatim
// и MET Norway; две её копии в разных файлах рано или поздно разъедутся.
export const userAgent = process.env.USER_AGENT
  || 'WeatherBot/0.2 (https://github.com/code-agent-43824/weatherbot)';

export const botToken = process.env.BOT_TOKEN || '';

// Зовётся из main(), а не из тела модуля: модуль, который убивает процесс при импорте,
// уносит с собой и прогон тестов — импортировать его не сможет ни один тест.
export function requireBotToken() {
  if (!botToken) {
    console.error('BOT_TOKEN is required');
    process.exit(1);
  }
  return botToken;
}
