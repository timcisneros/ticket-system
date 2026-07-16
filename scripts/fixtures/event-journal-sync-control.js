'use strict';

// Preload used only by event-journal-admission-recovery-test.js. It wraps the
// real events.jsonl FileHandle.sync so the integration test can deterministically
// hold or fail the durability barrier without changing production runtime code.
const fs = require('fs');
const path = require('path');

const controlFile = process.env.EVENT_JOURNAL_SYNC_CONTROL_FILE;
const dataDir = process.env.DATA_DIR;
const targetFile = dataDir ? path.join(path.resolve(dataDir), 'events.jsonl') : null;
const originalOpen = fs.promises.open.bind(fs.promises);

function readControl() {
  if (!controlFile || !fs.existsSync(controlFile)) return '';
  return fs.readFileSync(controlFile, 'utf8').trim();
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

fs.promises.open = async function controlledOpen(filePath, ...args) {
  const handle = await originalOpen(filePath, ...args);
  if (!targetFile || path.resolve(filePath) !== targetFile) return handle;

  const originalSync = handle.sync.bind(handle);
  handle.sync = async function controlledSync() {
    while (readControl() === 'hold') await wait(10);
    if (readControl() === 'fail') throw new Error('injected event journal sync failure');
    return originalSync();
  };
  return handle;
};
