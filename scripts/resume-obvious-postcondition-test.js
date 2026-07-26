#!/usr/bin/env node
'use strict';
// Obvious-postcondition behavior after resume — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A10).
//
// Contract under test, preserved from the JSON-era original: a run interrupted
// after its first committed workspace mutation must, on resume, CONTINUE the
// remaining work rather than short-circuit to completion because part of the
// target state already exists on disk.
//
// That is the regression this suite exists for. Two shortcuts could wrongly
// complete a resumed run — the pre-model "obvious postcondition" path and the
// post-action workspace-objective-satisfied path — and both must stay silent
// when the objective is only partially materialized. The committed mutation must
// also survive without being replayed a second time.
//
// Repaired, not rewritten. The provider stub is unchanged: it fakes `global.fetch`
// through a NODE_OPTIONS preload, which is storage-independent and still valid.
// What changed is that seeding and assertions now go through the PostgreSQL store
// instead of a DATA_DIR of JSON files the server no longer reads.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter, sleep } = require('./postgres-test-harness');

const STAMP = Date.now();
const FOLDER = `restart-validation-${STAMP}`;
const FILE_A = `${FOLDER}/a.txt`;
const FILE_B = `${FOLDER}/b.txt`;
const CONTENT_A = `A-${STAMP}`;
const CONTENT_B = `B-${STAMP}`;
const OBJECTIVE = `restart recovery obvious postcondition regression ${STAMP}: create folder ${FOLDER}, `
  + `write file ${FILE_A} containing exactly ${CONTENT_A}, and write file ${FILE_B} containing exactly ${CONTENT_B}.`;

const assert = createAsserter();

// Provider stub. Drives the run in three stages keyed off what actually exists in
// the workspace, so the resumed process genuinely has to observe partial state and
// continue from it.
function createFakeOpenAIPreload() {
  const preloadPath = path.join(os.tmpdir(), `resume-obvious-postcondition-openai-${process.pid}-${Date.now()}.js`);
  fs.writeFileSync(preloadPath, `
const fs = require('fs');
const path = require('path');
const workspaceRoot = process.env.WORKSPACE_ROOT;
const folder = process.env.TEST_RESTART_FOLDER;
const fileA = process.env.TEST_RESTART_FILE_A;
const fileB = process.env.TEST_RESTART_FILE_B;
const contentA = process.env.TEST_RESTART_CONTENT_A;
const contentB = process.env.TEST_RESTART_CONTENT_B;

function exists(relativePath) {
  return fs.existsSync(path.join(workspaceRoot, relativePath));
}

function okResponse(plan) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'fake-resume-obvious-postcondition']]),
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
  const input = Array.isArray(body.input) ? body.input : [];
  const combined = input.map(item => item && item.content ? String(item.content) : '').join('\\n');

  if (combined.includes('restart recovery obvious postcondition regression')) {
    if (exists(folder) && !exists(fileA)) {
      return okResponse({
        message: 'Resume by writing the first missing file.',
        actions: [{ operation: 'writeFile', args: { path: fileA, content: contentA } }],
        complete: false
      });
    }
    if (exists(folder) && exists(fileA) && !exists(fileB)) {
      return okResponse({
        message: 'Continue resumed execution by writing the second missing file.',
        actions: [{ operation: 'writeFile', args: { path: fileB, content: contentB } }],
        complete: true
      });
    }
    return okResponse({
      message: 'Create folder and first file before continuing.',
      actions: [
        { operation: 'createFolder', args: { path: folder } },
        { operation: 'writeFile', args: { path: fileA, content: contentA } }
      ],
      complete: false
    });
  }
  return okResponse({ message: 'No matching objective.', actions: [], complete: true });
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
    await withHarness('resume obvious postcondition', async ({ store, workspaceRoot, startServer }) => {
      const agent = (await store.createConfiguredAgent({
        value: { name: 'Resume Postcondition Agent', provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key' },
        groupIds: [], changedBy: 'resume-obvious-postcondition-test'
      })).agent;

      const providerEnv = {
        // The interruption hook SIGKILLs the process, so the crashed run keeps a
        // lease its owner can no longer renew. Recovery claims a run only once
        // that lease expires, so the default 180s would dominate the test. This
        // is a test-environment knob; no production default changes.
        RUN_LEASE_DURATION_MS: '5000',
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        NODE_OPTIONS: `--require ${preloadPath}`,
        TEST_RESTART_FOLDER: FOLDER,
        TEST_RESTART_FILE_A: FILE_A,
        TEST_RESTART_FILE_B: FILE_B,
        TEST_RESTART_CONTENT_A: CONTENT_A,
        TEST_RESTART_CONTENT_B: CONTENT_B
      };

      // ── Attempt 1: interrupt immediately after the first committed mutation ──
      const first = await startServer({
        ...providerEnv,
        TEST_INTERRUPTION_POINT: 'after_first_workspace.operation'
      });
      const cookie = await first.login();

      const created = await first.request('POST', '/tickets', {
        cookie,
        form: {
          objective: OBJECTIVE,
          assignmentTargetType: 'agent',
          assignmentTargetId: String(agent.id),
          assignmentMode: 'individual'
        }
      });
      assert(created.statusCode === 302, `ticket create returned HTTP ${created.statusCode}`);

      const run = await waitFor(async () => {
        const page = await store.listRuns({ limit: 50 });
        return (page.runs || []).find(r => r.agentId === agent.id) || null;
      }, 30000, 'run dispatch');
      assert(Boolean(run), 'run was dispatched');

      // The interruption hook fires once the first workspace operation commits.
      await waitFor(async () => {
        const events = await store.listRunEvents(run.id, { afterSeq: -1, limit: 200 });
        return (events || []).some(e => e.type === 'interruption.test_hook');
      }, 30000, 'the interruption point to be reached');
      assert(true, 'run was interrupted after its first committed mutation');

      assert(fs.existsSync(path.join(workspaceRoot, FOLDER)),
        'the folder committed before the interruption exists on disk');
      assert(!fs.existsSync(path.join(workspaceRoot, FILE_A)),
        'no further mutation landed before the interruption');

      await first.stop();

      // ── Attempt 2: restart and let recovery resume the run ──────────────────
      const second = await startServer(providerEnv);

      const finalRun = await waitFor(async () => {
        const current = await store.getRun(run.id);
        return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
      }, 90000, 'the resumed run to reach a terminal state');

      const operations = await store.listRunOperations(run.id, { limit: 200 });
      const history = (operations.operations || operations || [])
        .filter(op => op && (op.outcome === undefined || op.outcome === 'succeeded'));
      const opPath = op => (op.args && op.args.path) || op.path || null;
      const createFolderOps = history.filter(op => op.operation === 'createFolder' && opPath(op) === FOLDER);
      const writeOps = history.filter(op => op.operation === 'writeFile');

      const journal = await store.listRunEvents(run.id, { afterSeq: -1, limit: 500 });
      const replay = await store.readRunReplay(run.id);
      const replayEvents = replay && replay.snapshot && Array.isArray(replay.snapshot.events)
        ? replay.snapshot.events : [];
      const allEventTypes = [
        ...(journal || []).map(e => ({ type: e.type, payload: e.payload })),
        ...replayEvents.map(e => ({ type: e.type, payload: e }))
      ];
      const preModelPostcondition = allEventTypes.some(e =>
        (e.type === 'run:postcondition_completed' || e.type === 'run.postcondition_completed')
        && e.payload && e.payload.source === 'pre_model');
      const objectiveSatisfiedShortcut = allEventTypes.some(e =>
        e.type === 'workspace.objective_satisfied' || e.type === 'workspace:objective_satisfied');

      // ── The contract ────────────────────────────────────────────────────────
      assert(finalRun.status === 'completed',
        `resumed run completed, got ${finalRun.status}`);
      assert(fs.existsSync(path.join(workspaceRoot, FOLDER)),
        'the pre-interruption folder still exists after resume');
      assert(fs.readFileSync(path.join(workspaceRoot, FILE_A), 'utf8') === CONTENT_A,
        'resumed execution wrote file A with the exact expected content');
      assert(fs.readFileSync(path.join(workspaceRoot, FILE_B), 'utf8') === CONTENT_B,
        'resumed execution wrote file B with the exact expected content');
      assert(createFolderOps.length === 1,
        `createFolder was committed exactly once, not replayed (got ${createFolderOps.length})`);
      assert(writeOps.length === 2,
        `two writeFile mutations were committed after resume (got ${writeOps.length})`);
      assert(opPath(writeOps[0]) === FILE_A,
        'file A was the first resumed write');
      assert(opPath(writeOps[1]) === FILE_B,
        'file B was written only after the run continued past the partial mutation point');

      // The regression this suite guards: resume must not declare victory early.
      assert(!preModelPostcondition,
        'resumed run did NOT complete through the pre-model obvious-postcondition shortcut');
      assert(!objectiveSatisfiedShortcut,
        'resumed run did NOT complete through the post-action workspace-objective-satisfied shortcut');

      await second.stop();
      console.log(`\nPASS: resume obvious postcondition — ${assert.count()} assertions (PostgreSQL-native)`);
    });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
