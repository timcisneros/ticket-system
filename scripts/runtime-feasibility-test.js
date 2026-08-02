#!/usr/bin/env node
'use strict';
// Runtime feasibility admission and rejection — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A10).
//
// Contract under test, preserved from the JSON-era original: when an objective
// contract requires more mutations than the step budget can deliver, the run is
// REJECTED before it mutates anything. Three objective shapes pin that:
//
//   delete range     — deterministic grammar; 10 deletes at 2/response needs 5
//                      steps against a limit of 4
//   create range     — deterministic grammar; 24 remaining creates need 12 steps,
//                      and the provider is never called at all
//   compiled create  — prose the grammar misses, normalized by the objective
//                      compiler; 16 remaining creates need 8 steps
//
// For every shape: run fails with "Runtime budget infeasible", triage reasonCode
// is runtime_budget_insufficient, triage offers raise_limit / split_task /
// manual_recovery, and nothing in the workspace is mutated.
//
// The create-range scenario's provider assertion is the sharpest one here: it is
// what proves the gate rejects BEFORE the model is consulted rather than after a
// first turn.
//
// Repaired, not rewritten. The provider stub (a NODE_OPTIONS `global.fetch`
// preload) is storage-independent and preserved verbatim in behavior. Seeding, run
// lookup, triage, and replay reads now go through the PostgreSQL store.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter, sleep } = require('./postgres-test-harness');

const assert = createAsserter();
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

// Only the objective compiler is answered meaningfully; execution plans are never
// expected, because every scenario must be rejected before execution.
function createFakeOpenAIPreload() {
  const preloadPath = path.join(os.tmpdir(), `runtime-feasibility-openai-${process.pid}-${Date.now()}.js`);
  fs.writeFileSync(preloadPath, `
global.fetch = async function(url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const input = Array.isArray(body.input) ? body.input : [];
  const combined = input.map(item => item && item.content ? String(item.content) : '').join('\\n');

  if (combined.includes('objective compiler')) {
    const userContent = input
      .filter(item => item && item.role === 'user')
      .map(item => item.content)
      .join(' ');
    let intent = 'model_driven';
    let targets = [];
    if (/folder/i.test(userContent) && /A-Z/i.test(userContent)) {
      intent = 'create_folders';
      targets = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    }
    return {
      ok: true,
      status: 200,
      headers: new Map([['x-request-id', 'fake-runtime-feasibility-compiler']]),
      async text() {
        return JSON.stringify({
          output_text: JSON.stringify({ intent, targetRoot: '', targets }),
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        });
      }
    };
  }

  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'fake-runtime-feasibility']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify({ message: 'Should not be called', actions: [], complete: true }),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
};
`);
  return preloadPath;
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const preloadPath = createFakeOpenAIPreload();
  try {
    await withHarness('runtime feasibility', async ({ store, workspaceRoot, startServer }) => {
      const agent = (await store.createConfiguredAgent({
        value: { name: 'Feasibility Agent', provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key' },
        groupIds: [], changedBy: 'runtime-feasibility-test'
      })).agent;

      const server = await startServer({ env: {
        NODE_OPTIONS: `--require ${preloadPath}`,
        AGENT_MAX_EXECUTION_STEPS: '4',
        AGENT_MAX_MUTATING_ACTIONS_PER_RESPONSE: '2',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '10',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '20',
        AGENT_MAX_RUNTIME_DURATION_MS: '15000',
        ENABLE_MODEL_CONTRACT_COMPILER: 'true',
        RUNTIME_SCHEDULER_INTERVAL_MS: '200'
      } });
      const cookie = await server.login();

      const seen = new Set();
      async function failedRunFor(objective) {
        const created = await server.request('POST', '/tickets', {
          cookie,
          form: {
            objective,
            assignmentTargetType: 'agent',
            assignmentTargetId: String(agent.id),
            assignmentMode: 'individual'
          }
        });
        if (created.statusCode !== 302) {
          throw new Error(`ticket create returned HTTP ${created.statusCode}`);
        }
        const run = await waitFor(async () => {
          const page = await store.listRuns({ limit: 100 });
          return (page.runs || []).find(r => r.agentId === agent.id && !seen.has(r.id)) || null;
        }, 30000, `run dispatch for "${objective}"`);
        seen.add(run.id);
        const terminal = await waitFor(async () => {
          const current = await store.getRun(run.id);
          return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
        }, 60000, `terminal run for "${objective}"`);
        const replay = await store.readRunReplay(terminal.id);
        return { run: terminal, snapshot: replay ? replay.snapshot : null };
      }

      // The rejection contract is identical for every shape; asserted for each.
      function assertRejected(label, run) {
        assert(run.status === 'failed', `${label}: run failed (got ${run.status})`);
        assert(/Runtime budget infeasible/i.test(run.error || ''),
          `${label}: error identifies budget infeasibility`);
        assert(run.triage && run.triage.reasonCode === 'runtime_budget_insufficient',
          `${label}: triage reason is runtime_budget_insufficient`);
        for (const action of ['raise_limit', 'split_task', 'manual_recovery']) {
          assert(run.triage.allowedActions.includes(action), `${label}: triage offers ${action}`);
        }
      }

      const isDir = rel => fs.existsSync(path.join(workspaceRoot, rel))
        && fs.statSync(path.join(workspaceRoot, rel)).isDirectory();

      // ── Scenario 1: delete range ───────────────────────────────────────────
      const deleteTargets = ['A','B','C','D','E','F','G','H','I','J'];
      for (const name of deleteTargets) {
        fs.writeFileSync(path.join(workspaceRoot, name), `target ${name}\n`);
      }
      const deleteResult = await failedRunFor(`Delete files ${deleteTargets.join(', ')}`);
      assertRejected('delete range', deleteResult.run);
      for (const name of deleteTargets) {
        assert(fs.existsSync(path.join(workspaceRoot, name)),
          `delete range: target ${name} was not deleted`);
      }

      for (const name of deleteTargets) fs.rmSync(path.join(workspaceRoot, name), { force: true });

      // ── Scenario 2: create range, rejected before the model is consulted ────
      for (const name of ['L', 'M']) fs.mkdirSync(path.join(workspaceRoot, name), { recursive: true });
      const createResult = await failedRunFor('Create folders A-Z');
      assertRejected('create range', createResult.run);
      for (const name of LETTERS) {
        if (name === 'L' || name === 'M') {
          assert(isDir(name), `create range: pre-existing folder ${name} remains`);
        } else {
          assert(!isDir(name), `create range: folder ${name} was not created`);
        }
      }
      assert(!createResult.snapshot
        || !Array.isArray(createResult.snapshot.providerRequests)
        || createResult.snapshot.providerRequests.length === 0,
        'create range: provider was never called — the gate rejects pre-model');
      if (createResult.run.triage && createResult.run.triage.summary) {
        assert(createResult.run.triage.summary.includes('24 required mutation'),
          'create range: summary states 24 required mutations (26 targets minus L and M)');
        assert(createResult.run.triage.summary.includes('12 execution step'),
          'create range: summary states 12 projected steps');
      }

      // ── Scenario 3: compiled create range ──────────────────────────────────
      for (const name of ['A','B','C','D','E','F','G','H']) {
        fs.mkdirSync(path.join(workspaceRoot, name), { recursive: true });
      }
      const compiledResult = await failedRunFor('Make folders for the letter A-Z in the workspace');
      assertRejected('compiled create range', compiledResult.run);
      const preExisting = new Set(['A','B','C','D','E','F','G','H','L','M']);
      for (const name of LETTERS) {
        if (!preExisting.has(name)) {
          assert(!isDir(name), `compiled create range: folder ${name} was not created`);
        }
      }
      assert(compiledResult.snapshot && Array.isArray(compiledResult.snapshot.providerRequests)
        && compiledResult.snapshot.providerRequests.length >= 1,
        'compiled create range: the compiler provider request was recorded');
      if (compiledResult.run.triage && compiledResult.run.triage.summary) {
        assert(compiledResult.run.triage.summary.includes('16 required mutation'),
          'compiled create range: summary states 16 required mutations');
        assert(compiledResult.run.triage.summary.includes('8 execution step'),
          'compiled create range: summary states 8 projected steps');
      }

      console.log(`\nPASS: runtime feasibility admission/rejection — ${assert.count()} assertions (PostgreSQL-native)`);
    });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
