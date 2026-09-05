export function isoDateInTimezone(date, timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function hhmmInTimezone(date, timezone) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function dayOffsetDate(offsetDays, timezone) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return isoDateInTimezone(date, timezone);
}

export function daysUntil(date, timezone) {
  const today = new Date(`${isoDateInTimezone(new Date(), timezone)}T00:00:00Z`);
  const target = new Date(`${date}T00:00:00Z`);
  return Math.round((target - today) / 86_400_000);
}

export function parseTime(text) {
  const match = text.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

export function parseDate(text) {
  const trimmed = text.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const match = trimmed.match(/^(\d{1,2})[.](\d{1,2})[.](\d{4})$/);
  if (!match) return null;
  return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
}
