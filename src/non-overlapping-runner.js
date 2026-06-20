export function createNonOverlappingRunner(task) {
  let running = false;

  return async function run() {
    if (running) return false;
    running = true;
    try {
      await task();
      return true;
    } finally {
      running = false;
    }
  };
}
