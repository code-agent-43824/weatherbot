// Окно догона для регулярного маршрута: прогноз на утреннюю дорогу, присланный
// в обед, уже бесполезен — день закрываем без отправки. У плановой поездки прогноз
// про будущую дату, опоздание на несколько часов его не портит, поэтому догон
// не ограничен. Обе величины меняются здесь одной строкой.
export const commuteCatchUpMinutes = 60;

function minutesOfDay(hhmm) {
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(String(hhmm).trim());
  if (!match) return null;
  const hours = Number(match[1]);
  // Полночь в разных сборках ICU печатается как 00:00 или 24:00.
  if (hours > 24) return null;
  return (hours === 24 ? 0 : hours) * 60 + Number(match[2]);
}

/**
 * Что делать со сценарием прямо сейчас:
 *
 * 'send' — пора отправлять;
 * 'done' — сегодня уже отправляли;
 * 'wait' — время ещё не пришло либо время не задано;
 * 'skip' — окно упущено, день закрываем без отправки.
 *
 * Сравнивать текущее время со временем сценария на точное совпадение нельзя:
 * пользователи и сценарии обходятся последовательно, каждый прогноз — это сеть,
 * и стоит обходу пересечь границу минуты, как следующий сценарий терял свой день.
 */
export function scenarioSendDecision(scenario, today, nowHhmm) {
  const scheduled = minutesOfDay(scenario?.settings?.time);
  const current = minutesOfDay(nowHhmm);
  if (scheduled === null || current === null) return 'wait';
  if (scenario.lastSentDate === today) return 'done';

  const minutesLate = current - scheduled;
  if (minutesLate < 0) return 'wait';
  if (scenario.mode === 'planned') return 'send';
  return minutesLate <= commuteCatchUpMinutes ? 'send' : 'skip';
}
