// При остановке закрываем вход и ждём текущие операции до финальной записи JSON.
export function createTaskTracker() {
  const pending = new Set();
  let closed = false;
  return {
    run(task) {
      if (closed) return Promise.resolve();
      const work = Promise.resolve().then(task);
      pending.add(work);
      const remove = () => pending.delete(work);
      work.then(remove, remove);
      return work;
    },
    async close() {
      closed = true;
      await Promise.allSettled([...pending]);
    },
  };
}
