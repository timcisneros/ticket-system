#!/usr/bin/env node
'use strict';
// Direct-folder postcondition completeness — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A10).
//
// Contract under test, preserved from the JSON-era original: the deterministic
// folder-list postcondition shortcut may complete a run only when EVERY requested
// folder exists. Four scenarios pin that:
//
//   negative   — only some requested folders exist -> must not complete, and must
//                not emit run:postcondition_completed
//   positive   — all requested folders exist -> completes, and checkedPaths lists
//                every requested folder in order
//   single     — a one-folder objective still completes, checking exactly that path
//   ambiguous  — prose beyond a plain folder list must not complete through the
//                shortcut at all
//
// The negative scenario deliberately leans on the per-response mutating cap: the
// stub's first response proposes four createFolder actions, which exceeds
// AGENT_MAX_MUTATING_ACTIONS_PER_RESPONSE=2 and is rejected, so only the later
// two-folder response lands. That coupling is intentional and preserved.
//
// Repaired, not rewritten. The provider stub (a NODE_OPTIONS `global.fetch`
// preload) is storage-independent and unchanged. Seeding and snapshot reads now go
// through the PostgreSQL store instead of a DATA_DIR the server no longer reads.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter, sleep } = require('./postgres-test-harness');

const STAMP = Date.now();
const LIST_OBJECTIVE = 'Create folder A B C and D';
const SINGLE_FOLDER = `single-folder-${STAMP}`;
const AMBIGUOUS_FOLDER = `ambiguous-folder-${STAMP}`;

const assert = createAsserter();

function createPreload() {
  const preloadPath = path.join(os.tmpdir(), `direct-folder-postcondition-openai-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
let listCallCount = 0;

function ok(plan) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'direct-folder-postcondition']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify(plan),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
}

global.fetch = async function(_url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const combined = (Array.isArray(body.input) ? body.input : [])
    .map(item => item && item.content ? String(item.content) : '')
    .join('\\n');

  if (combined.includes(${JSON.stringify(LIST_OBJECTIVE)})) {
    listCallCount += 1;
    // Exceeds the mutating cap on purpose: this response is rejected, so the
    // negative scenario ends with only A and B on disk.
    if (listCallCount === 1) {
      return ok({
        message: 'Create folders A, B, C, and D.',
        actions: [
          { operation: 'createFolder', args: { path: 'A' } },
          { operation: 'createFolder', args: { path: 'B' } },
          { operation: 'createFolder', args: { path: 'C' } },
          { operation: 'createFolder', args: { path: 'D' } }
        ],
        complete: true
      });
    }
    if (listCallCount === 2) {
      return ok({
        message: 'Create only A and B.',
        actions: [
          { operation: 'createFolder', args: { path: 'A' } },
          { operation: 'createFolder', args: { path: 'B' } }
        ],
        complete: false
      });
    }
    return ok({ message: 'Cannot continue in this synthetic test.', actions: [], complete: false });
  }

  return ok({ message: 'Cannot continue in this synthetic test.', actions: [], complete: false });
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
  const preloadPath = createPreload();
  try {
    await withHarness('direct folder postcondition', async ({ store, workspaceRoot, startServer }) => {
      const agent = (await store.createConfiguredAgent({
        value: { name: 'Direct Folder Agent', provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key' },
        groupIds: [], changedBy: 'direct-folder-postcondition-test'
      })).agent;

      const server = await startServer({
        NODE_OPTIONS: `--require ${preloadPath}`,
        AGENT_MAX_MUTATING_ACTIONS_PER_RESPONSE: '2',
        AGENT_MAX_EXECUTION_STEPS: '4',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '4',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '20000',
        RUNTIME_SCHEDULER_INTERVAL_MS: '200'
      });
      const cookie = await server.login();

      const seenRunIds = new Set();
      async function runTicket(objective) {
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
          throw new Error(`ticket create returned HTTP ${created.statusCode}: ${created.body.slice(0, 300)}`);
        }
        const run = await waitFor(async () => {
          const page = await store.listRuns({ limit: 100 });
          return (page.runs || []).find(r => r.agentId === agent.id && !seenRunIds.has(r.id)) || null;
        }, 30000, `run dispatch for "${objective}"`);
        seenRunIds.add(run.id);
        const terminal = await waitFor(async () => {
          const current = await store.getRun(run.id);
          return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
        }, 60000, `terminal run for "${objective}"`);
        const replay = await store.readRunReplay(run.id);
        const events = replay && replay.snapshot && Array.isArray(replay.snapshot.events)
          ? replay.snapshot.events : [];
        return {
          run: terminal,
          postcondition: events.find(e => e.type === 'run:postcondition_completed') || null
        };
      }

      const folderExists = rel => fs.existsSync(path.join(workspaceRoot, rel))
        && fs.statSync(path.join(workspaceRoot, rel)).isDirectory();

      // Compare checkedPaths element-by-element rather than by JSON.stringify.
      // Element ORDER is part of the contract and is asserted; key insertion order
      // is not, and PostgreSQL jsonb does not preserve it, so a stringify
      // comparison would fail for a reason unrelated to the behavior under test.
      const checkedPathsMatch = (actual, expected) => {
        const list = Array.isArray(actual) ? actual : [];
        return list.length === expected.length
          && expected.every((want, i) => list[i]
            && list[i].type === want.type
            && list[i].path === want.path);
      };

      // ── Negative: only part of the requested list exists ───────────────────
      const negative = await runTicket(LIST_OBJECTIVE);
      assert(negative.run.status !== 'completed',
        `partial folder-list run did not complete as satisfied (status=${negative.run.status})`);
      assert(!negative.postcondition,
        'partial folder-list run emitted no run:postcondition_completed');
      assert(folderExists('A'), 'negative fixture created A');
      assert(folderExists('B'), 'negative fixture created B');
      assert(!folderExists('C'), 'negative fixture did not create C');
      assert(!folderExists('D'), 'negative fixture did not create D');

      // ── Positive: complete the list, then the shortcut may fire ────────────
      fs.mkdirSync(path.join(workspaceRoot, 'C'), { recursive: true });
      fs.mkdirSync(path.join(workspaceRoot, 'D'), { recursive: true });
      const positive = await runTicket(LIST_OBJECTIVE);
      assert(positive.run.status === 'completed', 'complete folder-list run completed');
      assert(Boolean(positive.postcondition),
        'complete folder-list run emitted run:postcondition_completed');
      assert(checkedPathsMatch(positive.postcondition.checkedPaths, [
        { type: 'folder', path: 'A' },
        { type: 'folder', path: 'B' },
        { type: 'folder', path: 'C' },
        { type: 'folder', path: 'D' }
      ]), 'complete folder-list run checked every requested folder, in order');

      // ── Single folder ──────────────────────────────────────────────────────
      fs.mkdirSync(path.join(workspaceRoot, SINGLE_FOLDER), { recursive: true });
      const single = await runTicket(`Create folder ${SINGLE_FOLDER}`);
      assert(single.run.status === 'completed', 'single-folder run completed');
      assert(Boolean(single.postcondition),
        'single-folder run emitted run:postcondition_completed');
      assert(checkedPathsMatch(single.postcondition.checkedPaths, [
        { type: 'folder', path: SINGLE_FOLDER }
      ]), 'single-folder run checked exactly the requested path');

      // ── Ambiguous prose must not take the shortcut ─────────────────────────
      fs.mkdirSync(path.join(workspaceRoot, AMBIGUOUS_FOLDER), { recursive: true });
      const ambiguous = await runTicket(`Create folder ${AMBIGUOUS_FOLDER} and write summary`);
      assert(!ambiguous.postcondition,
        'ambiguous prose emitted no run:postcondition_completed');
      assert(ambiguous.run.status !== 'completed',
        `ambiguous prose did not complete through the shortcut (status=${ambiguous.run.status})`);

      console.log(`\nPASS: direct folder-list postcondition completeness — ${assert.count()} assertions (PostgreSQL-native)`);
    });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
