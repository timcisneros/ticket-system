#!/usr/bin/env node
'use strict';

// The test-server startup contract, proved through an actually spawned child.
//
// WHY THIS SUITE IS LOAD-BEARING. Every real-server suite depends on the
// environment it asks for actually reaching the server. When that silently
// stopped being true, nothing failed: a suite passed `{ env: { NODE_OPTIONS } }`
// to a wrapper whose first POSITIONAL parameter was the environment map, so the
// child got a variable named `env`, the hermetic preload never loaded, and every
// assertion resting on it was vacuous while reporting PASS.
//
// A convention cannot prevent that, because the wrong shape was the right shape
// for the adjacent function. So the contract refuses it, and this suite proves
// both halves: the supported shape genuinely reaches the child, and each known
// wrong shape is refused before a process starts.
//
// The spawn counter is installed BEFORE the harness is required, because the
// harness destructures `spawn` at load time.

const assert = require('node:assert/strict');
const path = require('node:path');

const childProcess = require('node:child_process');
const realSpawn = childProcess.spawn;
let spawnCount = 0;
childProcess.spawn = function countedSpawn(...args) {
  spawnCount += 1;
  return realSpawn.apply(this, args);
};

// A developer credential is placed in THIS process on purpose: stripping can
// only be proved when there is something to strip. The value is a fixed
// non-credential string and is never printed.
process.env.OPENAI_API_KEY = 'test-only-sentinel-not-a-real-credential';
process.env.OPENAI_ORG_ID = 'test-only-sentinel-org';
process.env.OPENAI_PROJECT_ID = 'test-only-sentinel-project';

const {
  withHarness,
  createAsserter,
  readStartArgument,
  START_SHAPE_ERROR
} = require('./postgres-test-harness');

const PROBE = path.join(__dirname, 'fixtures', 'harness-contract-probe-preload.js');
const MARKER = `harness-contract-${Date.now()}`;

// ── Pure argument-shape refusals ────────────────────────────────────────────
//
// Checked against the exported validator first so the reasons are pinned
// precisely, then re-checked through the real wrapper below to prove no child
// starts.
function refusalOf(argument) {
  try {
    readStartArgument(argument);
    return null;
  } catch (error) {
    return error;
  }
}

{
  const cases = [
    ['legacy positional env map',
      { RUNTIME_SCHEDULER_INTERVAL_MS: '200' }],
    ['legacy positional NODE_OPTIONS — the exact original mistake',
      { NODE_OPTIONS: '--require /x.js' }],
    ['unknown key beside a supported one',
      { env: {}, timeoutMs: 1000 }],
    ['nested one level too deep',
      { env: { env: { NODE_OPTIONS: '--require /x.js' } } }],
    ['nested serverOptions inside env',
      { env: { serverOptions: {} } }],
    ['env is not a plain object', { env: 'NODE_OPTIONS=--require' }],
    ['env is an array', { env: [] }],
    ['serverOptions is not a plain object', { serverOptions: 5 }],
    ['argument is a string', 'RUNTIME_SCHEDULER_INTERVAL_MS=200'],
    ['argument is an array', [{ env: {} }]],
    ['argument is null', null]
  ];
  for (const [label, argument] of cases) {
    const error = refusalOf(argument);
    assert.ok(error, `${label} is refused`);
    assert.equal(error.code, START_SHAPE_ERROR, `${label} refuses deterministically`);
    console.log(`  ok refused: ${label}`);
  }

  // The supported shapes, and only these, are accepted.
  for (const [label, argument] of [
    ['no argument', undefined],
    ['empty object', {}],
    ['env only', { env: { A: '1' } }],
    ['serverOptions only', { serverOptions: { readyTimeoutMs: 1000 } }],
    ['both', { env: { A: '1' }, serverOptions: { adminPassword: 'x' } }]
  ]) {
    const resolved = readStartArgument(argument === undefined ? {} : argument);
    assert.ok(resolved && typeof resolved.env === 'object');
    assert.ok(resolved && typeof resolved.serverOptions === 'object');
    console.log(`  ok accepted: ${label}`);
  }
}

async function main() {
  await withHarness('test server startup contract', async ({ startServer }) => {
    const assertThat = createAsserter();

    // ── Refusals through the real wrapper start no child ──────────────────
    const before = spawnCount;
    for (const argument of [
      { NODE_OPTIONS: `--require ${PROBE}` },
      { env: { env: { NODE_OPTIONS: `--require ${PROBE}` } } },
      { env: {}, unknownOption: true },
      'positional-string'
    ]) {
      await assert.rejects(() => startServer(argument),
        error => error.code === START_SHAPE_ERROR);
    }
    assertThat(spawnCount === before,
      'no child process starts after an argument-shape refusal');

    // ── The supported shape actually reaches the child ────────────────────
    const server = await startServer({
      env: {
        NODE_OPTIONS: `--require ${PROBE}`,
        HARNESS_PROBE_MARKER: MARKER,
        RUNTIME_SCHEDULER_INTERVAL_MS: '3600000'
      },
      serverOptions: { adminPassword: 'harness-contract-password' }
    });
    assertThat(spawnCount === before + 1, 'exactly one child started');

    const output = String(server.output());
    assertThat(output.includes('HARNESS_PROBE_ACTIVE=true'),
      'NODE_OPTIONS --require executed the preload inside the spawned server');
    assertThat(output.includes(`HARNESS_PROBE_MARKER=${MARKER}`),
      'an env marker reached process.env of the spawned server');
    assertThat(output.includes('HARNESS_PROBE_NESTED_ENV_PRESENT=false'),
      'no variable named env was set, so the argument was not nested');

    // ── serverOptions reached server construction ─────────────────────────
    //
    // adminPassword is consumed only by the spawn function, so a successful
    // login with it proves serverOptions traversed the wrapper rather than
    // being dropped or folded into the environment.
    const cookie = await server.login('admin', 'harness-contract-password');
    assertThat(typeof cookie === 'string' && cookie.length > 0,
      'serverOptions reached server construction (adminPassword took effect)');

    // ── Credential stripping remains active ───────────────────────────────
    assertThat(output.includes('HARNESS_PROBE_OPENAI_KEY_PRESENT=false'),
      'OPENAI_API_KEY does not reach the spawned server');
    assertThat(output.includes('HARNESS_PROBE_OPENAI_ORG_PRESENT=false'),
      'OPENAI_ORG_ID does not reach the spawned server');
    assertThat(output.includes('HARNESS_PROBE_OPENAI_PROJECT_PRESENT=false'),
      'OPENAI_PROJECT_ID does not reach the spawned server');
    assertThat(process.env.OPENAI_API_KEY === 'test-only-sentinel-not-a-real-credential',
      'stripping copies the environment rather than mutating the parent');

    await server.stop();
    console.log(`  (${assertThat.count()} harness contract assertions)`);
  });

  console.log('test server startup contract test passed');
}

main().catch(error => { console.error(error); process.exit(1); });
