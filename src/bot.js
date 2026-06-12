const token = process.env.BOT_TOKEN;
const pollTimeoutSeconds = Number(process.env.POLL_TIMEOUT_SECONDS || 30);

if (!token) {
  console.error('BOT_TOKEN is required');
  process.exit(1);
}

const apiBase = `https://api.telegram.org/bot${token}`;
let offset = 0;

async function callTelegram(method, payload) {
  const response = await fetch(`${apiBase}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`${method} failed: ${data.description || response.statusText}`);
  }
  return data.result;
}

async function sendMessage(chatId, text) {
  await callTelegram('sendMessage', {
    chat_id: chatId,
    text,
  });
}

async function pollOnce() {
  const updates = await callTelegram('getUpdates', {
    offset,
    timeout: pollTimeoutSeconds,
    allowed_updates: ['message'],
  });

  for (const update of updates) {
    offset = update.update_id + 1;
    const chatId = update.message?.chat?.id;
    if (!chatId || !update.message?.text) {
      continue;
    }
    await sendMessage(chatId, 'погода хорошая');
  }
}

async function main() {
  console.log('WeatherBot started');
  while (true) {
    try {
      await pollOnce();
    } catch (error) {
      console.error(error);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

main();
