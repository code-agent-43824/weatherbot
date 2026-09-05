const openRouterApiKey = process.env.OPENROUTER_API_KEY || '';
// Дефолт держим тем же, что и в .env.example: бесплатный вариант, без счёта.
const openRouterModel = process.env.OPENROUTER_MODEL || 'openai/gpt-oss-120b:free';

const systemPrompt = [
  'Ты редактор короткого Telegram-прогноза для мотоциклиста.',
  'Используй только готовый черновик; не добавляй погодные факты, числа, проценты, миллиметры или названия провайдеров.',
  'Обязательно сохрани смысл каждой строки по окнам дня.',
  'Если строка содержит "X из Y источников", сохрани X, Y, силу дождя и фразу про дождевой риск.',
  'Если строка содержит "сухо", не превращай её в дождь.',
  'Обязательно оставь фразу "По нескольким источникам.".',
  'Сохрани короткую преамбулу со сценарием, маршрутом и датой.',
  'Сохрани эмодзи в начале строк.',
  'Не рассуждай про машины и транспорт.',
  'Формат: 7-8 коротких строк, последняя строка содержит "Итог:".',
].join(' ');

// Строки окон дня в черновике начинаются с этих эмодзи — см. templateForecast.
const windowMarkers = ['🌅', '☀️', '🌆'];

/**
 * Validates that LLM-polished text preserves the structure and meaning
 * of the original draft.
 */
function validatePolished(text, draft) {
  if (!text) return false;

  const banned = /(мм|%|Open-Meteo|MET Norway|7Timer|WeatherAPI|Tomorrow|Meteosource|DaData|машин|транспорт)/i;
  if (banned.test(text)) return false;

  if (!text.includes('По нескольким источникам')) return false;
  if (!text.includes('Итог:')) return false;
  if (!/[🏍️📍📅🌦️🌅☀️🌆✅]/u.test(text)) return false;

  const draftLines = draft.split('\n').filter(Boolean);
  const polishedLines = text.split('\n').filter(Boolean);
  if (polishedLines.length < draftLines.length - 2 || polishedLines.length > draftLines.length + 2) {
    return false;
  }

  // Сухое окно не должно превратиться в дождливое. Сравниваем окна по отдельности:
  // в обычном дне сухое утро и дождливый вечер живут в одном сообщении, и проверка
  // по всему тексту отбраковывала бы каждый такой прогноз, включая сам черновик.
  // «дождя» в родительном падеже пропускаем: «без дождя» — верный пересказ «сухо».
  for (const marker of windowMarkers) {
    const draftLine = draftLines.find((line) => line.startsWith(marker));
    if (!draftLine || !draftLine.includes('сухо')) continue;
    const polishedLine = polishedLines.find((line) => line.startsWith(marker));
    if (!polishedLine) return false;
    if (/(дождь|ливень)/i.test(polishedLine)) return false;
  }

  return true;
}

export async function polishForecastWithLlm(draft) {
  if (!openRouterApiKey) return draft;
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
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
    });
    const data = await response.json();
    const text = String(data.choices?.[0]?.message?.content || '').trim();
    return validatePolished(text, draft) ? text : draft;
  } catch (error) {
    console.error('OpenRouter failed:', error.message);
    return draft;
  }
}

export { validatePolished };
