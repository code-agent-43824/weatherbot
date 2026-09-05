import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createNonOverlappingRunner } from './non-overlapping-runner.js';
import { buildForecastDetails } from './forecast-details.js';
import { callTelegram, sendMessage, registerBotCommands } from './telegram.js';
import { geocodeRussia } from './geocode.js';
import { collectWeather, openMeteo } from './weather.js';
import { polishForecastWithLlm } from './llm.js';
import {
  aggregateWindows,
  templateForecast,
  formatWindow,
} from './aggregate.js';
import {
  isoDateInTimezone,
  hhmmInTimezone,
  dayOffsetDate,
  daysUntil,
  parseTime,
  parseDate,
} from './datetime.js';

const pollTimeoutSeconds = Number(process.env.POLL_TIMEOUT_SECONDS || 30);
const dataFile = process.env.DATA_FILE || './data/weatherbot.json';

let offset = 0;
let store = {
  users: {},
  forecastLogs: [],
  addressLogs: [],
};
let saveChain = Promise.resolve();
const maxForecastLogs = 500;
const maxAddressLogs = 500;

async function loadStore() {
  try {
    store = JSON.parse(await readFile(dataFile, 'utf8'));
    for (const user of Object.values(store.users || {})) migrateUserState(user);
    await saveStore();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await saveStore();
  }
}

function saveStore() {
  const data = JSON.stringify(store, null, 2);
  const tmpFile = `${dataFile}.tmp`;
  saveChain = saveChain
    .catch(() => {})
    .then(async () => {
      await mkdir(dirname(dataFile), { recursive: true });
      await writeFile(tmpFile, data);
      await rename(tmpFile, dataFile);
    });
  return saveChain;
}

function userState(tgId) {
  const key = String(tgId);
  store.users[key] ||= {
    tgId: key,
    setup: null,
    scenarios: [],
    nextScenarioId: 1,
    introShownAt: null,
    createdAt: new Date().toISOString(),
  };
  migrateUserState(store.users[key]);
  return store.users[key];
}

function migrateUserState(user) {
  if (!Array.isArray(user.scenarios)) user.scenarios = [];
  if (!Object.hasOwn(user, 'introShownAt')) {
    user.introShownAt = user.createdAt || new Date().toISOString();
  }
  if (!Number.isInteger(user.nextScenarioId) || user.nextScenarioId < 1) {
    user.nextScenarioId = user.scenarios.reduce((max, scenario) => Math.max(max, Number(scenario.id) || 0), 0) + 1;
  }
  if (user.setup && !user.setup.settings) {
    user.setup = {
      mode: user.mode || 'regular',
      step: user.setup.step,
      settings: user.settings || {},
    };
  }
  if (user.mode && user.settings && !user.scenarios.length) {
    user.scenarios.push({
      id: user.nextScenarioId,
      mode: user.mode,
      settings: user.settings,
      stopped: Boolean(user.stopped),
      lastSentDate: user.lastSentDate || null,
      createdAt: user.createdAt || new Date().toISOString(),
    });
    user.nextScenarioId += 1;
  }
  delete user.mode;
  delete user.settings;
  delete user.stopped;
  delete user.lastSentDate;
}

function startScenarioSetup(user, mode) {
  user.setup = {
    mode,
    step: mode === 'regular' ? 'home' : 'base',
    settings: {},
  };
}

function finishScenarioSetup(user) {
  const scenario = {
    id: user.nextScenarioId,
    mode: user.setup.mode,
    settings: user.setup.settings,
    stopped: false,
    lastSentDate: null,
    createdAt: new Date().toISOString(),
  };
  user.nextScenarioId += 1;
  user.scenarios.push(scenario);
  user.setup = null;
  return scenario;
}

function activeScenarios(user) {
  return user.scenarios.filter((scenario) => !scenario.stopped);
}

function scenarioById(user, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id)) return null;
  return user.scenarios.find((scenario) => scenario.id === id) || null;
}

function scenarioRouteLabel(scenario) {
  if (scenario.mode === 'regular') {
    return `${scenario.settings.home.district} -> ${scenario.settings.office.district}`;
  }
  return `${scenario.settings.base.city} -> ${scenario.settings.destination.city}, ${scenario.settings.tripDate}`;
}

function formatScenarioList(user) {
  if (!user.scenarios.length) return 'Сценариев пока нет. Нажмите Регулярный или Поездка.';
  return [
    'Сценарии:',
    ...user.scenarios.map((scenario) => {
      const mode = scenario.mode === 'regular' ? 'регулярный' : 'плановый';
      const status = scenario.stopped ? 'остановлен' : `активен, ${scenario.settings.time}`;
      return `${scenario.id}. ${mode}: ${scenarioRouteLabel(scenario)} — ${status}`;
    }),
  ].join('\n');
}

function introText() {
  return [
    '🏍️ WeatherBot помогает понять, стоит ли ехать на мотоцикле и не попадёте ли вы под дождь.',
    '',
    'Как это работает:',
    '• бот проверяет маршрут сразу по нескольким погодным источникам;',
    '• сравнивает утро, день и вечер;',
    '• присылает короткий вывод о дождевом риске и пригодности погоды для поездки.',
    '',
    'Есть два вида сценариев:',
    '🏠 Регулярный — ежедневный маршрут дом → офис → дом. Бот учитывает, что возвращаться нужно на том же мотоцикле.',
    '🗺️ Поездка — прогноз для выбранной даты и маршрута в одну сторону.',
    '',
    'Как начать:',
    '1. Нажмите Регулярный или Поездка.',
    '2. Введите адреса, дату (для поездки) и время отправки.',
    '3. После настройки бот сразу пришлёт первый прогноз, а затем будет писать по расписанию.',
    '',
    'Полезные команды:',
    '/forecast — получить прогноз сейчас',
    '/scenarios — показать все сценарии',
    '/stop 2 — остановить сценарий №2',
    '/reset — удалить все сценарии',
    '/help — краткая справка',
    '/intro — снова показать это описание',
  ].join('\n');
}

function scenarioDateIsExpired(scenario, now = new Date()) {
  if (scenario.mode !== 'planned' || !scenario.settings?.tripDate) return false;
  const timezone = scenario.settings.timezone || 'Europe/Moscow';
  return scenario.settings.tripDate < isoDateInTimezone(now, timezone);
}

async function cleanupExpiredScenarios(user, notify = false) {
  const expired = user.scenarios.filter((scenario) => scenarioDateIsExpired(scenario));
  if (!expired.length) return [];

  const expiredIds = new Set(expired.map((scenario) => scenario.id));
  user.scenarios = user.scenarios.filter((scenario) => !expiredIds.has(scenario.id));
  await saveStore();

  if (notify) {
    for (const scenario of expired) {
      try {
        await sendMessage(
          user.tgId,
          `Плановая поездка ${scenario.id} на ${scenario.settings.tripDate} уже прошла, я удалил этот сценарий. Для новой поездки нажмите Поездка.`,
        );
      } catch (error) {
        console.error('expired notification failed:', user.tgId, scenario.id, error);
      }
    }
  }
  return expired;
}

function routePoints(from, to) {
  return [
    from,
    {
      label: 'промежуточная точка маршрута',
      lat: (from.lat + to.lat) / 2,
      lon: (from.lon + to.lon) / 2,
      district: `${from.district} / ${to.district}`,
      city: from.city,
    },
    to,
  ];
}

async function buildForecast(user, scenario, targetDate = null) {
  const regular = scenario.mode === 'regular';
  const from = regular ? scenario.settings.home : scenario.settings.base;
  const to = regular ? scenario.settings.office : scenario.settings.destination;
  const points = routePoints(from, to);
  const weather = await collectWeather(points);
  const timezone = weather.find((item) => item.source === 'Open-Meteo')?.timezone || scenario.settings.timezone || 'UTC';
  scenario.settings.timezone = timezone;
  const date = targetDate || dayOffsetDate(0, timezone);
  const windows = aggregateWindows(weather, date, timezone);
  const draftText = templateForecast(scenario, date, windows);
  const polishedText = await polishForecastWithLlm(draftText);
  const longRange = scenario.mode === 'planned' && daysUntil(date, timezone) > 7;
  const details = buildForecastDetails(windows, { longRange });
  const finalText = details ? `${polishedText}\n${details}` : polishedText;

  store.forecastLogs.push({
    tgId: user.tgId,
    scenarioId: scenario.id,
    mode: scenario.mode,
    date,
    routeDistricts: regular
      ? { from: scenario.settings.home.district, to: scenario.settings.office.district }
      : { from: scenario.settings.base.district, to: scenario.settings.destination.district },
    createdAt: new Date().toISOString(),
    windows,
    message: finalText,
  });
  if (store.forecastLogs.length > maxForecastLogs) {
    store.forecastLogs = store.forecastLogs.slice(-maxForecastLogs);
  }
  await saveStore();
  return finalText;
}

async function handleCommand(chatId, user, text) {
  const buttonCommands = {
    'Прогноз': '/forecast',
    'Сценарии': '/scenarios',
    'Регулярный': '/regular',
    'Поездка': '/planned',
    'Сброс': '/reset',
    'Помощь': '/help',
  };
  text = buttonCommands[text] || text;
  const [command, arg] = text.split(/\s+/, 2);
  if (text === '/intro') {
    user.introShownAt = new Date().toISOString();
    await saveStore();
    await sendMessage(chatId, introText());
    return true;
  }
  if (text === '/start') {
    user.introShownAt = new Date().toISOString();
    await saveStore();
    await sendMessage(chatId, introText());
    return true;
  }
  if (text === '/help') {
    await sendMessage(chatId, [
      'Команды:',
      '/intro — как работает бот и как им пользоваться',
      'Регулярный — добавить прогноз дом/офис/дом',
      'Поездка — добавить плановую поездку',
      'Сценарии — список сценариев',
      'Прогноз — прислать прогноз по активным сценариям',
      'Сброс — удалить все сценарии',
      '',
      'Также работают slash-команды:',
      '/regular, /planned, /scenarios, /forecast, /reset',
      '/forecast 2 — прогноз по сценарию 2',
      '/stop — остановить отправки по всем сценариям',
      '/stop 2 — остановить сценарий 2',
    ].join('\n'));
    return true;
  }
  if (text === '/regular') {
    startScenarioSetup(user, 'regular');
    await saveStore();
    await sendMessage(chatId, 'Введите домашний адрес в России.');
    return true;
  }
  if (text === '/planned') {
    startScenarioSetup(user, 'planned');
    await saveStore();
    await sendMessage(chatId, 'Введите базовый город или адрес отправления в России.');
    return true;
  }
  if (text === '/scenarios') {
    await sendMessage(chatId, formatScenarioList(user));
    return true;
  }
  if (command === '/stop') {
    if (arg) {
      const scenario = scenarioById(user, arg);
      if (!scenario) {
        await sendMessage(chatId, 'Не нашёл сценарий с таким номером. Проверьте /scenarios.');
        return true;
      }
      scenario.stopped = true;
      await saveStore();
      await sendMessage(chatId, `Остановил сценарий ${scenario.id}. Настройки сохранил.`);
      return true;
    }
    for (const scenario of user.scenarios) scenario.stopped = true;
    await saveStore();
    await sendMessage(chatId, 'Остановил отправки по всем сценариям. Настройки сохранил.');
    return true;
  }
  if (text === '/reset') {
    user.setup = null;
    user.scenarios = [];
    user.nextScenarioId = 1;
    await saveStore();
    await sendMessage(chatId, 'Сбросил все сценарии. Можно заново добавить Регулярный или Поездка.');
    return true;
  }
  if (command === '/forecast') {
    const scenarios = arg ? [scenarioById(user, arg)].filter(Boolean) : activeScenarios(user);
    if (arg && !scenarios.length) {
      await sendMessage(chatId, 'Не нашёл сценарий с таким номером. Проверьте /scenarios.');
      return true;
    }
    if (!scenarios.length) {
      await sendMessage(chatId, 'Сначала настройте Регулярный или Поездка.');
      return true;
    }
    if (scenarios.length > 1) await sendMessage(chatId, `Сейчас пришлю ${scenarios.length} прогноз(а) по активным сценариям.`);
    for (const scenario of scenarios) {
      const date = scenario.mode === 'planned' ? scenario.settings.tripDate : null;
      await sendMessage(chatId, await buildForecast(user, scenario, date));
    }
    return true;
  }
  return false;
}

async function handleSetup(chatId, user, text) {
  if (!user.setup) return false;
  const step = user.setup.step;
  const settings = user.setup.settings;

  if (['home', 'office', 'base', 'destination'].includes(step)) {
    const address = await geocodeRussia(text);
    if (!address) {
      await sendMessage(chatId, 'Не нашёл такой адрес в России. Попробуйте уточнить: город, улица, дом.');
      return true;
    }
    settings[step] = address;
    store.addressLogs.push({
      tgId: user.tgId,
      input: text,
      label: address.label,
      district: address.district,
      city: address.city,
      exactHouse: address.exactHouse,
      matchedQuery: address.matchedQuery,
      provider: address.provider,
      createdAt: new Date().toISOString(),
    });
    if (store.addressLogs.length > maxAddressLogs) {
      store.addressLogs = store.addressLogs.slice(-maxAddressLogs);
    }
    const precisionNote = address.exactHouse
      ? ''
      : '\n\nВажно: точный дом геокодер не подтвердил, взял ближайшую улично-районную точку. Для прогноза по району этого достаточно.';
    if (step === 'home') {
      user.setup.step = 'office';
      await saveStore();
      await sendMessage(chatId, `Дом: ${address.label}${precisionNote}\nТеперь введите адрес офиса.`);
      return true;
    }
    if (step === 'office') {
      user.setup.step = 'time';
      await saveStore();
      await sendMessage(chatId, `Офис: ${address.label}${precisionNote}\nВо сколько ежедневно присылать прогноз? Формат 08:30.`);
      return true;
    }
    if (step === 'base') {
      user.setup.step = 'tripDate';
      await saveStore();
      await sendMessage(chatId, `База: ${address.label}${precisionNote}\nВведите дату поездки: YYYY-MM-DD или ДД.ММ.ГГГГ.`);
      return true;
    }
    if (step === 'destination') {
      user.setup.step = 'time';
      await saveStore();
      await sendMessage(chatId, `Пункт назначения: ${address.label}${precisionNote}\nВо сколько ежедневно присылать сводку по поездке? Формат 08:30.`);
      return true;
    }
  }

  if (step === 'tripDate') {
    const date = parseDate(text);
    if (!date) {
      await sendMessage(chatId, 'Не понял дату. Введите YYYY-MM-DD или ДД.ММ.ГГГГ.');
      return true;
    }
    if (date < dayOffsetDate(0, settings.timezone || 'Europe/Moscow')) {
      await sendMessage(chatId, 'Эта дата уже прошла. Введите будущую дату поездки: YYYY-MM-DD или ДД.ММ.ГГГГ.');
      return true;
    }
    settings.tripDate = date;
    user.setup.step = 'destination';
    await saveStore();
    await sendMessage(chatId, 'Введите город или адрес назначения в России.');
    return true;
  }

  if (step === 'time') {
    const time = parseTime(text);
    if (!time) {
      await sendMessage(chatId, 'Не понял время. Формат: 08:30.');
      return true;
    }
    const point = settings.home || settings.base;
    const weather = await openMeteo(point);
    settings.time = time;
    settings.timezone = weather.timezone || 'UTC';
    const scenario = finishScenarioSetup(user);
    await saveStore();
    await sendMessage(chatId, `Готово. Сценарий ${scenario.id}, отправка в ${time} (${settings.timezone}). Сейчас пришлю прогноз.`);
    try {
      await sendMessage(chatId, await buildForecast(user, scenario, scenario.mode === 'planned' ? scenario.settings.tripDate : null));
      scenario.lastSentDate = isoDateInTimezone(new Date(), scenario.settings.timezone || 'UTC');
      await saveStore();
    } catch (error) {
      console.error('initial forecast failed:', user.tgId, scenario.id, error);
      await sendMessage(chatId, 'Сценарий сохранён, но предварительный прогноз сейчас не собрался. Я попробую снова по расписанию.');
    }
    return true;
  }

  return false;
}

async function handleMessage(update) {
  const message = update.message;
  const chatId = message?.chat?.id;
  const chatType = message?.chat?.type;
  const tgId = message?.from?.id;
  const text = message?.text?.trim();
  if (!chatId || !tgId || !text) return;

  const user = userState(tgId);
  await cleanupExpiredScenarios(user, true);
  if (chatType === 'private' && !user.introShownAt && text !== '/intro' && text !== '/start') {
    user.introShownAt = new Date().toISOString();
    await saveStore();
    await sendMessage(chatId, introText());
  }
  if (await handleCommand(chatId, user, text)) return;
  if (await handleSetup(chatId, user, text)) return;
  await sendMessage(chatId, 'Выберите режим: Регулярный или Поездка. Для справки: Помощь.');
}

async function pollOnce() {
  const updates = await callTelegram('getUpdates', {
    offset,
    timeout: pollTimeoutSeconds,
    allowed_updates: ['message'],
  });

  for (const update of updates) {
    offset = update.update_id + 1;
    try {
      await handleMessage(update);
    } catch (error) {
      console.error('message failed:', error);
      const chatId = update.message?.chat?.id;
      if (chatId) await sendMessage(chatId, 'Не смог обработать запрос. Попробуйте ещё раз чуть позже.');
    }
  }
}

async function sendScheduledForecasts() {
  for (const user of Object.values(store.users)) {
    migrateUserState(user);
    try {
      await cleanupExpiredScenarios(user, true);
    } catch (error) {
      console.error('expired cleanup failed:', user.tgId, error);
    }
    for (const scenario of activeScenarios(user)) {
      if (!scenario.settings?.time) continue;
      const timezone = scenario.settings.timezone || 'UTC';
      const now = new Date();
      const today = isoDateInTimezone(now, timezone);
      if (scenario.lastSentDate === today || hhmmInTimezone(now, timezone) !== scenario.settings.time) continue;
      try {
        const date = scenario.mode === 'planned' ? scenario.settings.tripDate : null;
        await sendMessage(user.tgId, await buildForecast(user, scenario, date));
        scenario.lastSentDate = today;
        await saveStore();
      } catch (error) {
        console.error('scheduled forecast failed:', user.tgId, scenario.id, error);
      }
    }
  }
}

const runScheduledForecasts = createNonOverlappingRunner(sendScheduledForecasts);

async function cleanupAllExpiredScenarios() {
  for (const user of Object.values(store.users)) {
    migrateUserState(user);
    try {
      await cleanupExpiredScenarios(user, true);
    } catch (error) {
      console.error('startup expired cleanup failed:', user.tgId, error);
    }
  }
}

let shuttingDown = false;

async function main() {
  await loadStore();
  console.log('WeatherBot started');

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, saving store…`);
    try {
      await saveStore();
    } catch (error) {
      console.error('saveStore on shutdown failed:', error);
    }
    console.log('WeatherBot stopped');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    await registerBotCommands();
  } catch (error) {
    console.error('command registration failed:', error);
  }
  await cleanupAllExpiredScenarios();
  setInterval(() => runScheduledForecasts().catch((error) => console.error(error)), 30_000);
  while (true) {
    if (shuttingDown) break;
    try {
      await pollOnce();
    } catch (error) {
      console.error(error);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

main();
