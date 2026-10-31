import { fetchJsonWithTimeout } from './http.js';
const openRouterApiKey = process.env.OPENROUTER_API_KEY || '';
// Дефолт держим тем же, что и в .env.example: бесплатный вариант, без счёта.
const openRouterModel = process.env.OPENROUTER_MODEL || 'openai/gpt-oss-120b:free';

const systemPrompt = [
  'Ты редактор короткого Telegram-прогноза для мотоциклиста.',
  'Верни весь черновик с теми же строками и в том же порядке.',
  'Строки сценария, маршрута, даты, окон погоды и Итог скопируй строго без изменений.',
  'Разрешена только стилистическая правка строки 🌦️, сохрани фразу «По нескольким источникам.».',
  'Не добавляй погодные факты, рекомендации, числа, единицы измерения и названия провайдеров.',
].join(' ');

// Не пытаемся угадать семантическую эквивалентность: факты и вердикт неизменяемы.
function validatePolished(text, draft) {
  if (!text) return false;
  const before = draft.split('\n');
  const after = text.split('\n');
  if (before.length !== after.length) return false;
  return before.every((line, index) => {
    if (!line.startsWith('🌦️')) return after[index] === line;
    return after[index] === line
      || /^🌦️ (?:Сводка: )?По нескольким источникам\.$/u.test(after[index]);
  });
}

export async function polishForecastWithLlm(draft) {
  if (!openRouterApiKey) return draft;
  try {
    const data = await fetchJsonWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${openRouterApiKey}`,
        'content-type': 'application/json',
        'http-referer': 'https://github.com/code-agent-43824/weatherbot',
        'x-title': 'WeatherBot',
      },
      body: JSON.stringify({
        model: openRouterModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: draft },
        ],
        temperature: 0.1,
        max_tokens: 350,
      }),
    }, 15_000);
    const text = String(data.choices?.[0]?.message?.content || '').trim();
    return validatePolished(text, draft) ? text : draft;
  } catch (error) {
    console.error('OpenRouter failed:', error.message);
    return draft;
  }
}

export { validatePolished };
