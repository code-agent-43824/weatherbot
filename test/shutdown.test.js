import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('SIGTERM during initial forecast send waits for lastSentDate to be saved', { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'weatherbot-shutdown-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataFile = join(directory, 'store.json');
  const point = { lat: 55, lon: 37, district: 'Тест', city: 'Тест' };
  await writeFile(dataFile, JSON.stringify({ users: { '1': {
    tgId: '1', scenarios: [], nextScenarioId: 1, introShownAt: '2026-01-01',
    setup: { mode: 'regular', step: 'time', settings: { home: point, office: point } },
  } }, forecastLogs: [], addressLogs: [] }));
  const preload = join(directory, 'mock.mjs');
  await writeFile(preload, `
    let delivered = false;
    globalThis.fetch = async (url, options) => {
      const ok = (data) => ({ ok: true, json: async () => data });
      if (url.includes('api.telegram.org')) {
        if (url.endsWith('/getUpdates')) {
          if (!delivered) {
            delivered = true;
            return ok({ ok: true, result: [{ update_id: 1, message: { chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '08:30' } }] });
          }
          return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
        }
        const payload = JSON.parse(options.body);
        if (url.endsWith('/sendMessage') && payload.text.includes('Итог:')) {
          process.send('sending');
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        return ok({ ok: true, result: true });
      }
      return ok({ timezone: 'Europe/Moscow' });
    };
    await import(${JSON.stringify(new URL('../src/bot.js', import.meta.url).href)});
  `);
  const child = fork(preload, [], {
    execArgv: [], silent: true,
    env: { ...process.env, BOT_TOKEN: 'test-only', DATA_FILE: dataFile, OPENROUTER_API_KEY: '',
      OPENWEATHER_API_KEY: '', WEATHERAPI_KEY: '', TOMORROW_API_KEY: '', METEOSOURCE_API_KEY: '' },
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  let interrupted = false;
  child.on('message', (message) => {
    if (message === 'sending') { interrupted = true; child.kill('SIGTERM'); }
  });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (exitCode) => resolve(exitCode));
  });
  assert.equal(interrupted, true, stderr);
  assert.equal(code, 0, stderr);
  const saved = JSON.parse(await readFile(dataFile, 'utf8'));
  assert.match(saved.users['1'].scenarios[0].lastSentDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(saved.forecastLogs.length, 1);
});
