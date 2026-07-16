#!/usr/bin/env node
'use strict';

const { runBoundedWorkerPool } = require('../runtime/bounded-worker-pool');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function main() {
  const gates = Array.from({ length: 5 }, deferred);
  const started = [];
  const pool = runBoundedWorkerPool([0, 1, 2, 3, 4], ['a', 'b'], async (item, worker) => {
    started.push({ item, worker });
    await gates[item].promise;
    return `${worker}:${item}`;
  });

  await new Promise(resolve => setImmediate(resolve));
  assert(started.map(entry => entry.item).join(',') === '0,1', 'worker pool exceeded or failed to use initial concurrency');

  gates[0].resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert(started.some(entry => entry.item === 2), 'freed worker did not replenish from overflow while another worker remained busy');
  assert(!started.some(entry => entry.item === 3), 'worker pool exceeded its bounded concurrency');

  gates[2].resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert(started.some(entry => entry.item === 3), 'replenished worker did not continue consuming overflow');

  gates[1].resolve();
  gates[3].resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert(started.some(entry => entry.item === 4), 'final overflow item was not scheduled');
  gates[4].resolve();

  const results = await pool;
  assert(results.length === 5 && results.every(Boolean), 'worker pool lost a result');
  assert(results[0] === 'a:0' && results[1] === 'b:1', 'worker pool did not preserve result order');
  console.log('PASS: bounded worker pool replenishes concurrency and preserves result order');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
