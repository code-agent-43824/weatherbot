// Не передаём URL, headers, response body и исходные ошибки наружу:
// они могут содержать API-ключи, Telegram-токен или адрес пользователя.
export async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      const error = new Error(`HTTP request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } catch (error) {
    // Даже ошибка JSON/сетевой библиотеки может включить URL или фрагмент ответа.
    const safeError = new Error(controller.signal.aborted ? 'HTTP request aborted or timed out' : 'HTTP request failed');
    if (Number.isInteger(error.status)) safeError.status = error.status;
    throw safeError;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
