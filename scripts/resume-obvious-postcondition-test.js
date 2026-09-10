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
  if (combined.includes('r2f1-' + process.env.TEST_RESTART_R2_STAMP + '.md containing R2F1MARKER')) {
    // P2-R2 F-1 reachability. Attempt 1 never requests the model: the
    // pre-model satisfied claim completes the execution loop and the
    // interruption hook kills the process at before_run.snapshot_finalized,
    // AFTER the positive pre-model observation is durable. Recovery (the file
    // has since been rewritten WITHOUT the substring) requests the model here:
    // an idempotent complete:true whose post-batch observation is the later
    // decisive negative.
    return okResponse({ message: 'Nothing to do.', actions: [], complete: true });
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
      const first = await startServer({ env: {
        ...providerEnv,
        TEST_INTERRUPTION_POINT: 'after_first_workspace.operation'
      } });
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
      const second = await startServer({ env: providerEnv });

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

      // ── P2-R2 F-1 reachability: positive observation → crash/lease-loss →
      // recovery → later negative observation → terminal decision FAIL ──────
      const r2Stamp = String(STAMP);
      const r2File = `r2f1-${r2Stamp}.md`;
      const r2Objective = `create file r2f1-${r2Stamp}.md containing R2F1MARKER`;
      // The criterion is satisfied at admission time: the file exists WITH the
      // required substring, so the FIRST observation of attempt 1 (the durable
      // pre-model check) is a positive observation.
      fs.writeFileSync(path.join(workspaceRoot, r2File), 'payload has R2F1MARKER inside');

      const r2First = await startServer({ env: {
        ...providerEnv,
        TEST_RESTART_R2_STAMP: r2Stamp,
        TEST_INTERRUPTION_POINT: 'before_run.snapshot_finalized'
      } });
      const r2Cookie = await r2First.login();
      const r2Created = await r2First.request('POST', '/tickets', {
        cookie: r2Cookie,
        form: {
          objective: r2Objective,
          assignmentTargetType: 'agent',
          assignmentTargetId: String(agent.id),
          assignmentMode: 'individual'
        }
      });
      assert(r2Created.statusCode === 302, `r2 ticket create returned HTTP ${r2Created.statusCode}`);
      const r2Run = await waitFor(async () => {
        const page = await store.listRuns({ limit: 50 });
        return (page.runs || []).find(r => r.agentId === agent.id && r.id !== run.id) || null;
      }, 30000, 'the r2 run dispatch');
      await waitFor(async () => {
        const events = await store.listRunEvents(r2Run.id, { afterSeq: -1, limit: 200 });
        return (events || []).some(e => e.type === 'interruption.test_hook');
      }, 30000, 'the r2 interruption point to be reached');

      // The positive observation is DURABLE before the crash: the pre-model
      // check observed the file containing the required substring.
      const r2PreCrashReplay = await store.readRunReplay(r2Run.id);
      const r2PreCrashEvents = r2PreCrashReplay && r2PreCrashReplay.snapshot && Array.isArray(r2PreCrashReplay.snapshot.events)
        ? r2PreCrashReplay.snapshot.events : [];
      const r2PreCrashObservations = (r2PreCrashEvents || [])
        .filter(e => e.type === 'run:direct_postcondition_observed')
        .flatMap(e => Array.isArray(e && e.observations) ? e.observations : (e && e.payload && Array.isArray(e.payload.observations)) ? e.payload.observations : []);
      assert(r2PreCrashObservations.some(o => o.path === r2File && o.present === true),
        'r2 F-1: a positive criterion observation is durable BEFORE the crash/lease-loss');
      await r2First.stop();

      // Between the crash and recovery the file's content changes: the required
      // substring is no longer present. Recovery must observe the LATER state.
      fs.writeFileSync(path.join(workspaceRoot, r2File), 'rewritten without the marker');

      const r2Second = await startServer({ env: {
        ...providerEnv,
        TEST_RESTART_R2_STAMP: r2Stamp
      } });
      const r2FinalRun = await waitFor(async () => {
        const current = await store.getRun(r2Run.id);
        return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
      }, 90000, 'the r2 resumed run to reach a terminal state');
      const r2Replay = await store.readRunReplay(r2Run.id);
      const r2Events = r2Replay && r2Replay.snapshot && Array.isArray(r2Replay.snapshot.events)
        ? r2Replay.snapshot.events : [];
      const r2Observations = (r2Events || [])
        .filter(e => e.type === 'run:direct_postcondition_observed')
        .flatMap(e => Array.isArray(e && e.observations) ? e.observations : (e && e.payload && Array.isArray(e.payload.observations)) ? e.payload.observations : []);
      const r2BoundObservations = r2Observations.filter(o => o.path === r2File);
      assert(r2BoundObservations.length >= 2,
        `r2 F-1: both temporal observations are durable (${r2BoundObservations.length})`);
      assert(r2BoundObservations[0].present === true &&
        r2BoundObservations[r2BoundObservations.length - 1].present === false,
        'r2 F-1: the positive observation is followed by a later negative observation');
      const r2ConsequenceRow = await store.getRunConsequence(r2Run.id);
      const r2Decision = r2ConsequenceRow && r2ConsequenceRow.consequence &&
        r2ConsequenceRow.consequence.completionDecision;
      assert(r2FinalRun.status === 'completed',
        `r2 F-1: the recovered run terminalized (status=${r2FinalRun.status})`);
      assert(r2Decision && r2Decision.completionDisposition === 'incomplete' &&
        r2Decision.reasonCode === 'VERIFICATION_FAILED',
        'r2 F-1: the later negative observation makes the terminal decision FAIL');
      const r2Evaluated = (r2Decision.evaluatedPostconditions || [])
        .find(item => item.type === 'fileContains');
      assert(r2Evaluated && r2Evaluated.passed === false &&
        r2Evaluated.reasonCode === 'POSTCONDITION_EVALUATION_FAILED',
        'r2 F-1: the recovered negative is observed-unsatisfied, never unavailable');
      const r2Ticket = await store.getTicket(r2Run.ticketId);
      assert(r2Ticket.status !== 'completed',
        `r2 F-1: the Ticket must not complete on the later negative (got ${r2Ticket.status})`);
      await r2Second.stop();

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
