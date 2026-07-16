'use strict';

async function runBoundedWorkerPool(items, workers, operation) {
  if (!Array.isArray(items) || items.length === 0) return [];
  if (!Array.isArray(workers) || workers.length === 0) {
    throw new Error('Bounded worker pool requires at least one worker');
  }
  if (typeof operation !== 'function') throw new TypeError('Bounded worker pool operation must be a function');

  const results = new Array(items.length);
  let nextIndex = 0;
  async function work(worker) {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await operation(items[index], worker, index);
    }
  }
  await Promise.all(workers.slice(0, items.length).map(work));
  return results;
}

module.exports = { runBoundedWorkerPool };
