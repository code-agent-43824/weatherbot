// Кэш с временем жизни и вытеснением давно не используемых. Map хранит порядок
// вставки, поэтому «давно не используемый» получается только если переставлять
// ключ в конец при каждом попадании — иначе выходит FIFO, что не одно и то же:
// популярный маршрут вытеснялся бы наравне с разовым.
export function createTtlLruCache({ maxEntries, ttlMs, now = Date.now }) {
  const entries = new Map();

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() - entry.createdAt > ttlMs) {
        entries.delete(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },

    set(key, value) {
      entries.delete(key);
      while (entries.size >= maxEntries) {
        entries.delete(entries.keys().next().value);
      }
      entries.set(key, { createdAt: now(), value });
    },

    get size() {
      return entries.size;
    },
  };
}
