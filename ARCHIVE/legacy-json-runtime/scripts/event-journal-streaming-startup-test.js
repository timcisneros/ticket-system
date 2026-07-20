#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  RUN_EVENT_SCHEMA_VERSION,
  computeRunEventHash
} = require('../runtime/event-integrity');
const { scanCurrentEventJournal } = require('../runtime/event-journal-scan');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createRunEvent(runId, seq, prevHash) {
  const event = {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    id: `run-${runId}-event-${seq}`,
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, seq % 60)).toISOString(),
    type: 'run.progress',
    ticketId: runId,
    runId,
    stepId: null,
    seq,
    prevHash,
    payload: { seq }
  };
  event.hash = computeRunEventHash(event);
  return event;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-journal-stream-'));
  const file = path.join(dir, 'events.jsonl');
  const tips = new Map();
  const lines = [];
  const eventCount = 20000;

  for (let index = 0; index < eventCount; index += 1) {
    const runId = (index % 4) + 1;
    const tip = tips.get(runId) || { seq: 0, hash: null };
    const event = createRunEvent(runId, tip.seq, tip.hash);
    tips.set(runId, { seq: tip.seq + 1, hash: event.hash });
    lines.push(JSON.stringify(event));
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = () => {
    throw new Error('startup integrity scan attempted a whole-file read');
  };
  let result;
  try {
    result = await scanCurrentEventJournal(file);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  assert(result.eventCount === eventCount, 'streaming scan did not validate every event');
  assert(result.states.size === tips.size, 'streaming scan retained more than run-chain tips');
  tips.forEach((tip, runId) => {
    const recovered = result.states.get(runId);
    assert(recovered && recovered.nextSeq === tip.seq, `run ${runId} sequence tip was not recovered`);
    assert(recovered.previousHash === tip.hash, `run ${runId} hash tip was not recovered`);
  });

  fs.appendFileSync(file, '{not-json}\n', 'utf8');
  let corruption = null;
  try {
    await scanCurrentEventJournal(file);
  } catch (error) {
    corruption = error;
  }
  assert(corruption && /line 20001 is not valid JSON/.test(corruption.message), 'streaming scan did not fail closed on malformed evidence');

  fs.writeFileSync(file, `${'x'.repeat(129)}\n`, 'utf8');
  let oversized = null;
  try {
    await scanCurrentEventJournal(file, { maxLineBytes: 128 });
  } catch (error) {
    oversized = error;
  }
  assert(oversized && /line 1 exceeds 128 bytes/.test(oversized.message), 'startup scan did not bound one corrupt record');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('PASS: startup journal integrity validation streams history and retains only run-chain tips');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
