#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(ROOT, 'server.js');
const SCHEDULER_PATH = path.join(ROOT, 'runtime', 'scheduler.js');
const RUNNER_PATH = path.join(ROOT, 'runtime', 'runner.js');
const JOURNAL_PATH = path.join(ROOT, 'runtime', 'durable-append.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEveryAppendIsAwaited(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const relative = path.relative(ROOT, filePath);
  source.split('\n').forEach((line, index) => {
    if (!line.includes('appendEvent(')) return;
    if (line.includes('async function appendEvent(')) return;
    assert(line.includes('await appendEvent('), `${relative}:${index + 1} must await appendEvent`);
  });
}

function main() {
  const server = fs.readFileSync(SERVER_PATH, 'utf8');
  const runner = fs.readFileSync(RUNNER_PATH, 'utf8');
  const journal = fs.readFileSync(JOURNAL_PATH, 'utf8');

  assertEveryAppendIsAwaited(SERVER_PATH);
  assertEveryAppendIsAwaited(SCHEDULER_PATH);
  assert(!server.includes('appendFileSync(EVENTS_FILE'), 'server must not synchronously append events on the main thread');
  assert(!server.includes('appendFileDurableSync'), 'server must not use the removed synchronous durable append helper');
  assert(!server.includes('fsyncSync'), 'server must not fsync events on the main thread');
  assert(server.includes('await maybeTestInterrupt('), 'interruption checkpoints must await their sealed event');
  assert(server.includes('await eventJournal.close();'), 'reset/shutdown must drain and close the event journal');
  assert(server.includes('await runtimeScheduler.whenIdle();'), 'shutdown must drain an in-flight runtime scheduler tick');
  assert(server.includes('await runtimeTemplateScheduler.whenIdle();'), 'shutdown must drain an in-flight template scheduler tick');
  assert(runner.includes('.catch(error => onError(run, error))'), 'detached run promises must have a rejection boundary');
  assert(journal.includes('await handle.sync();'), 'journal acknowledgement must follow an asynchronous file sync');
  assert(journal.includes('setImmediate(callback)'), 'journal must yield before group commit');

  console.log('PASS: all runtime event appends are awaited; main-thread append/fsync and detached rejection gaps are absent');
}

main();
