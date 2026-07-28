#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter, sleep } = require('./postgres-test-harness');

const STAMP = Date.now();
const assert = createAsserter();

function encodePlan(plan) {
  return Buffer.from(JSON.stringify(plan), 'utf8').toString('base64url');
}

function createFetchStub() {
  const preloadPath = path.join(os.tmpdir(), `process-contract-stub-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
function response(plan) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'process-contract-runtime']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify(plan),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
}
global.fetch = async function(_url, options = {}) {
  let combined = '';
  try {
    const body = JSON.parse(options.body || '{}');
    combined = (Array.isArray(body.input) ? body.input : [])
      .map(item => item && item.content ? String(item.content) : '')
      .join('\\n');
  } catch (_) {}
  const match = combined.match(/#PLAN=([A-Za-z0-9_-]+=*)/);
  if (!match) return response({ message: 'no plan', actions: [], complete: true });
  return response(JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')));
};
`);
  return preloadPath;
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const preloadPath = createFetchStub();
  try {
    await withHarness('process execution runtime contract', async ({ store, workspaceRoot, startServer }) => {
      const agent = (await store.createConfiguredAgent({
        value: {
          name: `ProcessContract-${STAMP}`,
          provider: 'openai',
          model: 'gpt-4.1-mini',
          apiKey: 'test-key-process-contract'
        },
        groupIds: [],
        changedBy: 'process-execution-runtime-test'
      })).agent;
      const server = await startServer({
        NODE_OPTIONS: `--require ${preloadPath}`,
        ENABLE_PROCESS_EXECUTION_CONTRACT: 'true',
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '60000'
      });
      const cookie = await server.login();

      async function runPlan(label, plan) {
        const objective = `process-contract ${label} ${STAMP} #PLAN=${encodePlan(plan)}`;
        const created = await server.request('POST', '/tickets', {
          cookie,
          form: {
            objective,
            assignmentTargetType: 'agent',
            assignmentTargetId: String(agent.id),
            assignmentMode: 'individual'
          }
        });
        assert(created.statusCode === 302, `${label}: ticket creation is accepted`);
        const ticket = await waitFor(async () => {
          const { tickets } = await store.listTickets({ limit: 100 });
          return tickets.find(item => item.objective === objective) || null;
        }, 30000, `${label} ticket`);
        const run = await waitFor(async () => {
          const { runs } = await store.listRunsForTicket({ ticketId: ticket.id, limit: 10 });
          return runs[0] || null;
        }, 30000, `${label} run`);
        const terminal = await waitFor(async () => {
          const current = await store.getRun(run.id);
          return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
        }, 90000, `${label} terminal run`);
        const replay = (await store.readRunReplay(terminal.id)).snapshot;
        const events = await store.listRunEvents(terminal.id, { afterSeq: -1, limit: 500 });
        const operationPage = await store.listRunOperations(terminal.id, { limit: 100 });
        return {
          ticket,
          run: terminal,
          replay,
          events,
          operations: operationPage.operations || operationPage
        };
      }

      const processRun = await runPlan('policy-denied', {
        message: 'Request the configured process contract target.',
        actions: [{
          operation: 'runProcess',
          args: {
            targetId: 'local-workspace',
            profileId: 'ungranted-profile',
            operationId: `process-operation-${STAMP}`
          }
        }],
        complete: true
      });
      assert(processRun.run.status === 'failed', 'enabled contract with no grant fails closed');
      assert(processRun.run.errorCode === 'PROCESS_TARGET_UNKNOWN' ||
        /not granted/i.test(String(processRun.run.error || '')),
      'runtime preserves the typed unknown-target refusal');
      assert(processRun.run.processPolicySnapshot.capabilityEnabled === true,
        'run records the enabled feature state at admission');
      assert(processRun.run.processPolicySnapshot.grants.length === 0,
        'enabled feature snapshot records no implicit grants');
      assert(processRun.replay.processPolicySnapshot.snapshotHash ===
        processRun.run.processPolicySnapshot.snapshotHash,
      'replay retains the exact admitted process-policy snapshot');
      assert(!processRun.replay.runtimeEnvelope.allowedOperations.includes('runProcess'),
        'runProcess is not advertised without an explicit snapshot grant');
      const denial = processRun.events.find(event => event.type === 'authority.denied');
      assert(Boolean(denial) && denial.payload.rule === 'process_policy_snapshot',
        'unknown target records an append-only process-policy authority denial');
      const resolutionEvent = processRun.events.find(event => event.type === 'process.operation_resolution');
      assert(Boolean(resolutionEvent) &&
        resolutionEvent.payload.enforcementCause.errorCode === 'PROCESS_TARGET_UNKNOWN',
      'typed process resolution is recorded in the append-only event chain');
      assert(Array.isArray(processRun.replay.processOperations) &&
        processRun.replay.processOperations.length === 1 &&
        processRun.replay.processOperations[0].terminalOutcome === 'policy_denied',
      'replay records one policy-denied process operation');
      assert(processRun.operations.length === 0,
        'refused process contract creates no target-operation receipt or effect claim');

      const outputPath = `process-contract-fs-control-${STAMP}.txt`;
      const filesystemRun = await runPlan('filesystem-control', {
        message: 'Write the filesystem positive control.',
        actions: [{
          operation: 'writeFile',
          args: { path: outputPath, content: 'filesystem-unchanged' }
        }],
        complete: true
      });
      assert(filesystemRun.run.status === 'completed',
        'ordinary filesystem operation remains executable with process contract enabled');
      assert(fs.readFileSync(path.join(workspaceRoot, outputPath), 'utf8') === 'filesystem-unchanged',
        'ordinary filesystem operation preserves its target behavior');
      assert(!filesystemRun.replay.runtimeEnvelope.allowedOperations.includes('runProcess'),
        'filesystem run receives no implicit process operation');
      assert(!Object.prototype.hasOwnProperty.call(filesystemRun.replay, 'processOperations'),
        'filesystem replay receives no process-operation evidence');

      console.log(`\nPASS: process execution runtime contract — ${assert.count()} assertions (PostgreSQL-native)`);
    }, { schemaSlug: 'process_execution_runtime' });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(`\nFAIL: process execution runtime contract — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
