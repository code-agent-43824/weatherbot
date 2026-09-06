import { botToken } from './config.js';

const telegramMaxLen = 4096;

export async function callTelegram(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!data.ok) throw new Error(`${method} failed: ${data.description || response.statusText}`);
  return data.result;
}

export function mainKeyboard() {
  return {
    keyboard: [
      [{ text: 'Прогноз' }, { text: 'Сценарии' }],
      [{ text: 'Регулярный' }, { text: 'Поездка' }],
      [{ text: 'Сброс' }, { text: 'Помощь' }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

export async function registerBotCommands() {
  await callTelegram('setMyCommands', {
    commands: [
      { command: 'intro', description: 'Как работает бот' },
      { command: 'regular', description: 'Добавить регулярный маршрут' },
      { command: 'planned', description: 'Добавить плановую поездку' },
      { command: 'scenarios', description: 'Показать сценарии' },
      { command: 'forecast', description: 'Получить прогноз сейчас' },
      { command: 'stop', description: 'Остановить отправки' },
      { command: 'reset', description: 'Удалить все сценарии' },
      { command: 'help', description: 'Краткая справка' },
    ],
  });
}

export function splitMessage(text, maxLen = telegramMaxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(pos + maxLen, text.length);
    let next = end;
    if (end < text.length) {
      const lastNewline = text.lastIndexOf('\n', end);
      // Режем по переводу строки и сам перевод выбрасываем: он становится границей
      // сообщений, а иначе следующий кусок открывался бы пустой строкой.
      if (lastNewline > pos) {
        end = lastNewline;
        next = end + 1;
      }
    }
    chunks.push(text.slice(pos, end));
    pos = next;
  }
  return chunks;
}

export async function sendMessage(chatId, text, options = {}) {
  const chunks = splitMessage(text);
  for (let i = 0; i < chunks.length; i += 1) {
    const isLast = i === chunks.length - 1;
    await callTelegram('sendMessage', {
      chat_id: chatId,
      text: chunks[i],
      disable_web_page_preview: true,
      reply_markup: isLast ? (options.reply_markup || mainKeyboard()) : undefined,
    });
  }
}
