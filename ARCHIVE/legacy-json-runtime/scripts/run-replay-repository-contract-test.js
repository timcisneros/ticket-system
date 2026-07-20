#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  REQUIRED_RUN_REPLAY_REPOSITORY_METHODS,
  FinalizedRunReplayError,
  JsonRunReplayRepository,
  assertRunReplayRepository
} = require('../persistence/json/run-replay-repository');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');

let runs = [
  { id: 1, ticketId: 10 },
  { id: 2, ticketId: 20 },
  { id: 3, ticketId: 30 }
];
const snapshots = new Map();
let snapshotWrites = 0;
let runWrites = 0;

const repository = new JsonRunReplayRepository({
  readRuns: () => structuredClone(runs),
  writeRuns: nextRuns => {
    runs = structuredClone(nextRuns);
    runWrites += 1;
  },
  readReplaySnapshotFile: run => snapshots.has(run.id) ? structuredClone(snapshots.get(run.id)) : null,
  writeReplaySnapshotFile: (runId, snapshot) => {
    snapshots.set(runId, structuredClone(snapshot));
    snapshotWrites += 1;
  },
  attachReplayMetadata: (run, snapshot) => {
    run.replaySnapshotPath = `replay-snapshots/run-${run.id}.json`;
    run.replaySummary = { events: Array.isArray(snapshot.events) ? snapshot.events.length : 0 };
    return run;
  },
  sanitizePayload: value => structuredClone(value),
  maxQueryRows: 2
});

async function main() {
  assert.deepEqual(REQUIRED_RUN_REPLAY_REPOSITORY_METHODS, [
    'initializeRunReplay',
    'readRunReplay',
    'listRunReplays',
    'updateRunReplay'
  ]);
  assert.equal(assertRunReplayRepository(repository), repository);
  assert.equal(
    assertRunReplayRepository(Object.create(PostgresRuntimeStore.prototype)) instanceof PostgresRuntimeStore,
    true,
    'PostgreSQL store must implement the run replay repository contract'
  );
  assert.throws(() => assertRunReplayRepository({}), /must implement initializeRunReplay/);

  const initialized = await repository.initializeRunReplay({
    runId: 1,
    ticketId: 10,
    snapshot: { version: 1, events: [], artifactPrediction: null }
  });
  assert.equal(initialized.initialized, true);
  assert.equal(initialized.record.runId, 1);
  assert.equal(snapshotWrites, 1);
  assert.equal(runWrites, 1);

  const resumed = await repository.initializeRunReplay({
    runId: 1,
    ticketId: 10,
    snapshot: { version: 1, events: [{ type: 'must-not-replace' }] }
  });
  assert.equal(resumed.initialized, false, 'initialization must preserve the first replay document');
  assert.deepEqual(resumed.record.snapshot.events, []);
  assert.equal(snapshotWrites, 1);
  await assert.rejects(
    repository.initializeRunReplay({ runId: 1, ticketId: 20, snapshot: { version: 1 } }),
    /does not belong to ticket/
  );

  const firstUpdate = await repository.updateRunReplay({
    runId: 1,
    update: snapshot => ({ ...snapshot, events: [...snapshot.events, { type: 'first' }] })
  });
  assert.equal(firstUpdate.updated, true);
  assert.equal(firstUpdate.record.snapshot.events.length, 1);
  const noChange = await repository.updateRunReplay({ runId: 1, update: snapshot => snapshot });
  assert.equal(noChange.updated, false);
  assert.equal(snapshotWrites, 2);

  await Promise.all([
    repository.updateRunReplay({
      runId: 1,
      update: snapshot => ({ ...snapshot, events: [...snapshot.events, { type: 'second' }] })
    }),
    repository.updateRunReplay({
      runId: 1,
      update: snapshot => ({ ...snapshot, events: [...snapshot.events, { type: 'third' }] })
    })
  ]);
  assert.deepEqual(
    (await repository.readRunReplay(1)).snapshot.events.map(event => event.type),
    ['first', 'second', 'third'],
    'process-local concurrent updates must not lose a replay projection'
  );
  await assert.rejects(
    repository.updateRunReplay({ runId: 1, update: async snapshot => snapshot }),
    /must return synchronously/
  );

  await repository.initializeRunReplay({ runId: 2, ticketId: 20, snapshot: { version: 1, events: [] } });
  const listed = await repository.listRunReplays({ runIds: [2, 1, 2], limit: 2 });
  assert.deepEqual(listed.map(record => record.runId), [1, 2]);
  await assert.rejects(repository.listRunReplays({ runIds: [1, 2, 3], limit: 2 }), /exceeds the requested limit/);
  await assert.rejects(repository.listRunReplays({ runIds: [1], limit: 3 }), /configured maximum/);

  await repository.initializeRunReplay({
    runId: 3,
    ticketId: 30,
    snapshot: { version: 1, events: [], modelResponses: [], finalizedAt: '2026-07-16T12:00:00.000Z' }
  });
  await assert.rejects(
    repository.updateRunReplay({
      runId: 3,
      update: snapshot => ({ ...snapshot, events: [{ type: 'late' }] })
    }),
    error => error instanceof FinalizedRunReplayError
  );
  const lateEvidence = await repository.updateRunReplay({
    runId: 3,
    allowFinalizedAppend: true,
    update: snapshot => ({
      ...snapshot,
      modelResponses: [...snapshot.modelResponses, { evidenceKey: 'provider-response:late' }]
    })
  });
  assert.equal(lateEvidence.record.snapshot.modelResponses.length, 1);
  assert.equal(lateEvidence.record.snapshot.finalizedAt, '2026-07-16T12:00:00.000Z');
  await assert.rejects(
    repository.updateRunReplay({
      runId: 3,
      allowFinalizedAppend: true,
      update: snapshot => ({ ...snapshot, terminalStatus: 'changed' })
    }),
    error => error instanceof FinalizedRunReplayError
  );

  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(serverSource.includes('getRunReplayRepository().initializeRunReplay({'));
  assert.ok(serverSource.includes('getRunReplayRepository().listRunReplays({'));
  assert.ok(serverSource.includes('getRunReplayRepository().updateRunReplay({'));
  assert.ok(
    serverSource.includes('}, { allowFinalizedAppend: true });'),
    'single-item replay appends must preserve admitted late evidence after terminal fields are sealed'
  );
  assert.equal(
    (serverSource.match(/fs\.readFileSync\(snapshotPath/g) || []).length,
    1,
    'filesystem replay reads must remain confined to the JSON adapter callback'
  );
  assert.equal(
    (serverSource.match(/readRuns\(\)\.map\(hydrateRunReplaySnapshot\)/g) || []).length,
    0,
    'async replay hydration must never leak unresolved promises into a response'
  );

  console.log('PASS: run replay repository owns idempotent initialization, serialized projections, sealed terminal fields, append-only late evidence, and bounded reads');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
