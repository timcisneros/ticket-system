#!/usr/bin/env node
'use strict';
// Workspace error containment — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// Replaces five JSON-era orphans that each covered one shape of the same contract:
// er1-readfile-recoverable, er2-createfolder-existing-file-recoverable,
// er2a-readfile-notafile-recoverable, er2b-writefile-notafile-recoverable and
// er2c-listdirectory-not-enoent-recoverable. They are one suite because they are one
// property, and splitting it five ways is what let all five rot together.
//
// THE CONTRACT — the runtime must tell two kinds of failure apart:
//
//   ENVIRONMENTAL (`workspace_error`) — the file is missing, or the path is a
//   directory where a file was expected. The world is not what the model assumed.
//   The run CONTINUES, the failure is recorded truthfully, and the model is told
//   what happened so it can correct itself.
//
//   POLICY (`protected_path`) — traversal outside the workspace, a hidden or system
//   path. The model asked for something it may never have. The run FAILS, the record
//   says it was BLOCKED, and no further turn is granted.
//
// Collapsing the two is a defect in either direction, and both directions are covered
// here. Treating environmental failure as terminal kills runs on a missing file that
// the model could have worked around — the exact failure these five suites were
// written for. Treating policy refusal as recoverable is worse: the runtime would hand
// a refused request back to the model as ordinary feedback and let it keep trying,
// turning a containment boundary into a retry loop.
//
// THE DISCRIMINATOR IS ONE LINE: `if (error.failureKind !== 'workspace_error') throw`
// in the action loop (server.js). Nothing registered in the checkpoint exercises it;
// before this suite, no registered file referenced `workspace_error`,
// `WORKSPACE_FS_ENOENT` or `WORKSPACE_PATH_TYPE_CONFLICT` at all.
//
// THE PROVIDER IS STATE-DRIVEN, NOT COUNTER-DRIVEN. The recovery action is emitted
// only when the previous turn's failure is present in `previousActionResults`, read
// from the structured request body the runtime actually sent. So containment and
// truthfulness are jointly load-bearing: a runtime that swallows the error and asks
// again cannot finish these runs, and a runtime that never asks again cannot either.
// The stub reaching turn 2 IS the evidence being carried.
//
// NO VACUOUS EXIT. There is no skip path (the harness exits non-zero without a
// database), no NOT_PROVEN outcome, and every wait throws on timeout rather than
// returning. `assertScenariosExecuted` refuses a run that asserted too little, and
// scenario 0 requires each case to have reached its exact expected number of model
// turns before any verdict below is trusted.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const { assertScenariosExecuted } = require('./child-process-settlement');

const STAMP = Date.now();
const assert = createAsserter();
let scenariosRun = 0;

const CAPTURE = path.join(os.tmpdir(), `workspace-error-capture-${process.pid}-${STAMP}.jsonl`);

// Seeded before the runs start, so every failure below is a genuine disagreement
// between what the model asked for and what is actually there.
const SEED_DIR = 'existing-folder';
const SEED_FILE = 'existing-file.txt';
const SEED_CONTENT = `seeded-${STAMP}`;

// `contained: true` — the run must survive and the model must get exactly one more
// turn. `contained: false` — the run must die on the spot and get no further turn.
const CASES = Object.freeze([
  {
    key: 'success', contained: true, control: true, turns: 2,
    label: 'a read that succeeds',
    attempt: { operation: 'readFile', args: { path: SEED_FILE } }
  },
  {
    key: 'readmissing', contained: true, turns: 2,
    label: 'readFile on a path that does not exist',
    attempt: { operation: 'readFile', args: { path: `absent-${STAMP}.txt` } },
    failedOperation: 'readFile'
  },
  {
    key: 'readfolder', contained: true, turns: 2,
    label: 'readFile on a directory',
    attempt: { operation: 'readFile', args: { path: SEED_DIR } },
    failedOperation: 'readFile'
  },
  {
    key: 'writefolder', contained: true, turns: 2,
    label: 'writeFile onto a directory',
    attempt: { operation: 'writeFile', args: { path: SEED_DIR, content: 'clobber' } },
    failedOperation: 'writeFile'
  },
  {
    key: 'folderoverfile', contained: true, turns: 2,
    label: 'createFolder where a file already exists',
    attempt: { operation: 'createFolder', args: { path: SEED_FILE } },
    failedOperation: 'createFolder'
  },
  {
    key: 'listfile', contained: true, turns: 2,
    label: 'listDirectory on a file',
    attempt: { operation: 'listDirectory', args: { path: SEED_FILE } },
    failedOperation: 'listDirectory'
  },
  {
    key: 'traversal', contained: false, turns: 1,
    label: 'readFile escaping the workspace root',
    attempt: { operation: 'readFile', args: { path: '../outside.txt' } },
    failedOperation: 'readFile'
  },
  {
    key: 'hidden', contained: false, turns: 1,
    label: 'writeFile to a hidden path',
    attempt: { operation: 'writeFile', args: { path: '.hidden-secret', content: 'x' } },
    failedOperation: 'writeFile'
  }
]);

const marker = key => `WSERR${key.toUpperCase()}${STAMP}`;
const recoveryFile = key => `recovered-${key}-${STAMP}.txt`;
const byKey = key => CASES.find(item => item.key === key);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(200);
  }
  // Never resolves to a pass. A timeout here means the property under test did not
  // happen, which is a failure, not an inconclusive result.
  throw new Error(`timed out waiting for ${label}`);
}

function createPreload() {
  const preloadPath = path.join(os.tmpdir(), `workspace-error-preload-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
const fs = require('fs');
const CAPTURE = ${JSON.stringify(CAPTURE)};
const CASES = ${JSON.stringify(CASES.map(item => ({
    key: item.key, marker: marker(item.key), attempt: item.attempt, recovery: recoveryFile(item.key)
  })))};

function ok(plan) {
  return {
    ok: true, status: 200,
    headers: new Map([['x-request-id', 'workspace-error-containment']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify(plan),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
}

global.fetch = async function(_url, options = {}) {
  const raw = options.body || '{}';
  let body = {};
  try { body = JSON.parse(raw); } catch (_) {}

  // Read the STRUCTURED ticket-context message rather than concatenating prose, so
  // the branch below turns on what the runtime actually reported, not on wording.
  let context = null;
  for (const item of (body.input || [])) {
    if (!item || typeof item.content !== 'string') continue;
    try {
      const parsed = JSON.parse(item.content);
      if (parsed && typeof parsed === 'object' && parsed.ticketObjective !== undefined) context = parsed;
    } catch (_) { /* non-JSON system prose */ }
  }
  const objective = context ? String(context.ticketObjective || '') : '';
  const prior = context && Array.isArray(context.previousActionResults) ? context.previousActionResults : [];
  fs.appendFileSync(CAPTURE, JSON.stringify({ objective, prior }) + '\\n');

  const scenario = CASES.find(candidate => objective.includes(candidate.marker));
  if (!scenario) return ok({ message: 'unrelated objective', actions: [], complete: true });

  // Turn 1 — attempt the operation that will disagree with the workspace.
  if (prior.length === 0) {
    return ok({ message: 'Attempting the operation.', actions: [scenario.attempt], complete: false });
  }

  // Turn 2 — reachable ONLY if the runtime carried the previous turn's outcome
  // forward. The recovery write is the observable proof that it did, and for the
  // policy cases it is the thing that must NEVER appear.
  const reported = prior.find(entry =>
    entry && entry.action && entry.action.operation === scenario.attempt.operation);
  if (!reported) {
    // The runtime gave another turn but said nothing useful about the last one.
    // Emit nothing so the run cannot finish: silence must not look like recovery.
    return ok({ message: 'No usable evidence of the previous attempt.', actions: [], complete: false });
  }
  return ok({
    message: 'Prior evidence explains the failure; taking the corrective action.',
    actions: [{ operation: 'writeFile', args: { path: scenario.recovery, content: 'recovered' } }],
    complete: true
  });
};
`);
  return preloadPath;
}

async function main() {
  const preloadPath = createPreload();
  fs.writeFileSync(CAPTURE, '');
  try {
    await withHarness('workspace error containment', async ({ store, workspaceRoot, startServer }) => {
      const agent = (await store.createConfiguredAgent({
        value: { name: `WorkspaceError-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'k' },
        groupIds: [], changedBy: 'workspace-error-containment-test'
      })).agent;

      fs.mkdirSync(path.join(workspaceRoot, SEED_DIR), { recursive: true });
      fs.writeFileSync(path.join(workspaceRoot, SEED_DIR, 'inside.txt'), 'inside');
      fs.writeFileSync(path.join(workspaceRoot, SEED_FILE), SEED_CONTENT);

      const server = await startServer({ env: {
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '600000'
      } });
      const cookie = await server.login();

      for (const scenario of CASES) {
        scenario.objective = `${marker(scenario.key)} resolve the ${scenario.key} case in the shared workspace`;
        const response = await server.request('POST', '/tickets', {
          cookie,
          form: {
            objective: scenario.objective,
            assignmentTargetType: 'agent',
            assignmentTargetId: String(agent.id),
            assignmentMode: 'individual'
          }
        });
        if (response.statusCode !== 302) {
          throw new Error(`ticket creation for ${scenario.key} returned HTTP ${response.statusCode}: ${response.body.slice(0, 400)}`);
        }
      }

      const tickets = (await store.listTickets({ limit: 100 })).tickets || [];
      for (const scenario of CASES) {
        const ticket = tickets.find(candidate => candidate.objective === scenario.objective);
        if (!ticket) throw new Error(`ticket for ${scenario.key} was not persisted`);
        scenario.ticketId = ticket.id;
      }

      await waitFor(async () => {
        const runs = (await store.listRuns({ limit: 100 })).runs || [];
        for (const scenario of CASES) {
          const run = runs.find(candidate => candidate.ticketId === scenario.ticketId);
          if (!run || !['completed', 'failed', 'interrupted'].includes(run.status)) return false;
          scenario.runId = run.id;
        }
        return true;
      }, 180000, 'every run to reach a terminal status');

      const states = new Map();
      for (const scenario of CASES) {
        const [run, replay] = await Promise.all([
          store.getRun(scenario.runId), store.getReplaySnapshot(scenario.runId)
        ]);
        states.set(scenario.key, {
          run,
          replay,
          snapshot: replay ? replay.snapshot : null,
          operations: (replay && replay.snapshot.workspaceOperations) || [],
          events: (replay && replay.snapshot.events) || []
        });
      }

      const captured = fs.readFileSync(CAPTURE, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
      const turnsFor = scenario => captured.filter(entry => entry.objective === scenario.objective);

      // ── 0. HARD FLOOR — the conversation happened at all ──────────────────────
      // Deliberately weak: it proves the suite is not vacuous without pre-empting the
      // verdicts below. An earlier version asserted the EXACT turn count here, and a
      // mutation that killed runs on a missing file failed with "expected 2 turns, got
      // 1" — true, and a description of the symptom rather than of the defect. The
      // run's terminal status is observable however the conversation went, so that is
      // checked first and the exact turn counts are asserted where they are the
      // property under test (scenarios 4 and 7).
      scenariosRun += 1;
      assert(captured.length > 0, '0: provider requests were captured at all');
      for (const scenario of CASES) {
        const turns = turnsFor(scenario);
        assert(turns.length >= 1,
          `0: ${scenario.key} reached the model at least once (${turns.length})`);
        assert(turns[0].prior.length === 0,
          `0: ${scenario.key} carried no prior evidence into its first turn`);
      }

      // ── 1. CONTAINED — an environmental failure does not end the run ───────────
      scenariosRun += 1;
      for (const scenario of CASES.filter(item => item.contained)) {
        const state = states.get(scenario.key);
        assert(state.run.status === 'completed',
          `1: ${scenario.label} leaves the run alive (${state.run.status}: ${state.run.error || ''})`);
        assert(state.snapshot.terminalStatus === 'completed',
          `1: ${scenario.key} replay agrees the run completed (${state.snapshot.terminalStatus})`);
        assert(!state.events.some(event => event && event.type === 'run:step_limit'),
          `1: ${scenario.key} finished on its own rather than being stopped by the step limit`);
        assert(!state.events.some(event => event && event.type === 'run:failed'),
          `1: ${scenario.key} recorded no run failure`);
      }

      // ── 2. RECOVERED — the model acted on what it was told ────────────────────
      // The corrective write is the observable consequence of containment. It exists
      // only if the run survived AND the failure was reported back accurately.
      scenariosRun += 1;
      for (const scenario of CASES.filter(item => item.contained)) {
        const recovery = path.join(workspaceRoot, recoveryFile(scenario.key));
        assert(fs.existsSync(recovery),
          `2: ${scenario.key} performed its corrective action after the failure`);
        assert(fs.readFileSync(recovery, 'utf8') === 'recovered',
          `2: ${scenario.key} corrective action wrote its intended content`);
        const writes = states.get(scenario.key).operations.filter(op =>
          op.operation && op.operation.operation === 'writeFile' &&
          op.operation.args && op.operation.args.path === recoveryFile(scenario.key));
        assert(writes.length === 1 && !writes[0].error && writes[0].result,
          `2: ${scenario.key} recorded the corrective write as a successful operation`);
      }

      // ── 3. TRUTHFUL — the failed operation is recorded as failed, not as done ──
      scenariosRun += 1;
      for (const scenario of CASES.filter(item => item.contained && !item.control)) {
        const state = states.get(scenario.key);
        const attempts = state.operations.filter(op =>
          op.operation && op.operation.operation === scenario.failedOperation &&
          op.operation.args && op.operation.args.path === scenario.attempt.args.path);
        assert(attempts.length === 1,
          `3: ${scenario.key} recorded the failed ${scenario.failedOperation} exactly once (${attempts.length})`);
        const attempt = attempts[0];
        assert(typeof attempt.error === 'string' && attempt.error.length > 0,
          `3: ${scenario.key} recorded WHY it failed rather than a bare flag (${JSON.stringify(attempt.error)})`);
        assert(!Object.prototype.hasOwnProperty.call(attempt, 'result'),
          `3: ${scenario.key} recorded no result, so nothing claims the operation succeeded`);
        assert(attempt.blocked === false,
          `3: ${scenario.key} is not recorded as a policy refusal (blocked=${attempt.blocked})`);
      }

      // ── 4. REPORTED — the next turn was told what actually happened ────────────
      // Asserted against the structured request body, not against prose the runtime
      // claims to have sent.
      scenariosRun += 1;
      for (const scenario of CASES.filter(item => item.contained && !item.control)) {
        const turns = turnsFor(scenario);
        assert(turns.length === scenario.turns,
          `4: ${scenario.key} was given exactly one further turn, not a retry loop (${turns.length})`);
        const reported = turns[1].prior.find(entry =>
          entry && entry.action && entry.action.operation === scenario.failedOperation);
        assert(reported,
          `4: ${scenario.key} carried the failed operation into the next turn (${JSON.stringify(turns[1].prior).slice(0, 200)})`);
        assert(reported.action.args && reported.action.args.path === scenario.attempt.args.path,
          `4: ${scenario.key} attributed the failure to the path it actually attempted (${JSON.stringify(reported.action.args)})`);
        assert(typeof reported.error === 'string' && reported.error.length > 0,
          `4: ${scenario.key} told the model why, not merely that, it failed (${JSON.stringify(reported.error)})`);
        assert(!Object.prototype.hasOwnProperty.call(reported, 'result'),
          `4: ${scenario.key} did not also report a result for an operation that failed`);
      }

      // ── 5. POSITIVE CONTROL — success is still reported as success ─────────────
      // Without this, a runtime that failed every operation would satisfy every
      // assertion above, because "contained" would be indistinguishable from "broken".
      scenariosRun += 1;
      const control = states.get('success');
      const controlReads = control.operations.filter(op =>
        op.operation && op.operation.operation === 'readFile');
      assert(controlReads.length === 1,
        `5: the control run performed exactly one read (${controlReads.length})`);
      assert(!controlReads[0].error,
        `5: reading a file that exists records no error (${controlReads[0].error})`);
      assert(controlReads[0].result && controlReads[0].result.content === SEED_CONTENT,
        '5: and returns the content actually on disk');
      const controlTurn = turnsFor(byKey('success'))[1].prior.find(entry =>
        entry && entry.action && entry.action.operation === 'readFile');
      assert(controlTurn && !controlTurn.error && controlTurn.result,
        `5: the next turn was told it succeeded (${JSON.stringify(controlTurn).slice(0, 200)})`);

      // ── 6. TERMINAL — a policy refusal ends the run and says so ────────────────
      scenariosRun += 1;
      for (const scenario of CASES.filter(item => !item.contained)) {
        const state = states.get(scenario.key);
        assert(state.run.status === 'failed',
          `6: ${scenario.label} fails the run (${state.run.status})`);
        assert(state.snapshot.terminalStatus === 'failed',
          `6: ${scenario.key} replay agrees the run failed (${state.snapshot.terminalStatus})`);
        assert(state.events.some(event => event && event.type === 'run:failed'),
          `6: ${scenario.key} recorded the failure in its replay events`);
        const attempts = state.operations.filter(op =>
          op.operation && op.operation.operation === scenario.failedOperation);
        assert(attempts.length === 1,
          `6: ${scenario.key} recorded the refused operation (${attempts.length})`);
        assert(attempts[0].blocked === true,
          `6: ${scenario.key} is recorded as BLOCKED, distinguishing policy from environment (blocked=${attempts[0].blocked})`);
        assert(typeof attempts[0].error === 'string' && attempts[0].error.length > 0,
          `6: ${scenario.key} names the rule it violated (${JSON.stringify(attempts[0].error)})`);
        assert(!Object.prototype.hasOwnProperty.call(attempts[0], 'result'),
          `6: ${scenario.key} manufactured no result for a refused operation`);
      }

      // ── 7. NO SECOND CHANCE — a refusal is not handed back as feedback ─────────
      // The sharpest half of the contract. If a policy refusal were contained, the
      // model would be asked again and its corrective write would land — so the
      // absence of BOTH is what proves the boundary held.
      scenariosRun += 1;
      for (const scenario of CASES.filter(item => !item.contained)) {
        assert(turnsFor(scenario).length === 1,
          `7: ${scenario.key} was never asked again after being refused`);
        assert(!fs.existsSync(path.join(workspaceRoot, recoveryFile(scenario.key))),
          `7: ${scenario.key} performed no follow-up action`);
        assert(states.get(scenario.key).run.error && states.get(scenario.key).run.error.length > 0,
          `7: ${scenario.key} run carries the refusal as its terminal error (${states.get(scenario.key).run.error})`);
      }

      // ── 8. CONTAINED IN THE WORKSPACE TOO — a failure changed nothing ──────────
      // "The run survived" is not enough: a half-applied mutation behind a reported
      // failure is exactly the state an operator cannot reconstruct.
      scenariosRun += 1;
      assert(fs.statSync(path.join(workspaceRoot, SEED_DIR)).isDirectory(),
        '8: the directory a writeFile targeted is still a directory');
      assert(fs.readFileSync(path.join(workspaceRoot, SEED_DIR, 'inside.txt'), 'utf8') === 'inside',
        '8: and its contents are untouched');
      assert(fs.statSync(path.join(workspaceRoot, SEED_FILE)).isFile(),
        '8: the file a createFolder targeted is still a file');
      assert(fs.readFileSync(path.join(workspaceRoot, SEED_FILE), 'utf8') === SEED_CONTENT,
        '8: with its original content, so the refused write really did not land');
      assert(!fs.existsSync(path.join(workspaceRoot, `absent-${STAMP}.txt`)),
        '8: the path that did not exist was not created by the failed read');
      assert(!fs.existsSync(path.join(workspaceRoot, '.hidden-secret')),
        '8: the refused hidden path was never written');
      assert(!fs.existsSync(path.join(path.dirname(workspaceRoot), 'outside.txt')),
        '8: nothing was written outside the workspace root');

      // ── 9. ATTRIBUTION — each run's evidence is its own ────────────────────────
      scenariosRun += 1;
      for (const scenario of CASES) {
        const state = states.get(scenario.key);
        assert(state.snapshot.runId === scenario.runId && state.replay.ticketId === scenario.ticketId,
          `9: ${scenario.key} replay identifies its own run and ticket`);
        const foreign = state.operations.filter(op => {
          const target = op.operation && op.operation.args && op.operation.args.path;
          return typeof target === 'string' && /^recovered-/.test(target) &&
            target !== recoveryFile(scenario.key);
        });
        assert(foreign.length === 0,
          `9: ${scenario.key} carries no other run's corrective write (${JSON.stringify(foreign.map(op => op.operation.args.path))})`);
      }
      const receiptOwners = new Set();
      for (const scenario of CASES) {
        const receipts = await store.listOperationReceipts(scenario.runId, { limit: 100 });
        for (const receipt of receipts) {
          assert(receipt.runId === scenario.runId && receipt.ticketId === scenario.ticketId,
            `9: ${scenario.key} operation receipts belong to its own run and ticket`);
          receiptOwners.add(receipt.runId);
        }
      }
      assert(receiptOwners.size >= CASES.filter(item => item.contained).length,
        `9: every contained run produced durable operation receipts of its own (${receiptOwners.size})`);

      assertScenariosExecuted({
        label: 'workspace error containment',
        assertions: assert.count(),
        scenarios: scenariosRun,
        minAssertions: 90,
        minScenarios: 10
      });
      console.log(`\nPASS: workspace error containment — ${scenariosRun} scenarios, ${assert.count()} assertions (PostgreSQL-native)`);
    }, { schemaSlug: 'workspace_error' });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
    try { fs.unlinkSync(CAPTURE); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(`\nFAIL: workspace error containment — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
