#!/usr/bin/env node
'use strict';
// Action-batch preflight and recovery — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// Replaces the JSON-era `invalid-action-preflight-recovery-test.js`.
//
// THE CONTRACT IS ATOMICITY OF ADMISSION: the ENTIRE action batch is validated before
// any action executes. One action with invalid arguments rejects the whole batch.
//
// WHY THAT ORDERING IS THE WHOLE POINT. If validation happened per action during
// execution, a batch of [createFolder ok, createFolder ""] would create the first folder
// and only then discover the second is invalid. The run fails with a workspace that was
// half-modified by a batch the runtime considers rejected, and no receipt explains the
// leftover. "Rejected" would then mean "partially applied", which is the worst state for
// an operator to reason about — worse than either executing or refusing cleanly.
//
// So the assertions are not merely "an error was recorded". They are: the prefix
// mutation left NO filesystem effect, NO operation receipt, and the run recovered.
//
// THE PROVIDER IS STATE-DRIVEN, NOT COUNTER-DRIVEN. Each response is chosen from the
// evidence carried into that request:
//
//   no prior warning ................................ turn 1: invalid batch (valid prefix + invalid arg)
//   prior `workspace.invalid_action_args` ........... turn 2: mixed-phase batch
//   prior `execution.phase_violation` ............... turn 3: valid single-phase batch, complete
//
// Each branch is reachable ONLY if the runtime delivered the corresponding corrective
// evidence, so a runtime that rejects silently cannot finish the run at all and the
// suite fails hard rather than passing vacuously. Turn 3 is simultaneously the recovery
// proof and the positive control that a valid batch still executes.
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

const OBJECTIVE = `action batch preflight ${STAMP}`;
const PREFIX_DIR = `preflight-prefix-${STAMP}`;
const MIXED_DIR = `preflight-mixed-${STAMP}`;
const FINAL_DIR = `preflight-final-${STAMP}`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function createPreload(capturePath) {
  const preloadPath = path.join(os.tmpdir(), `preflight-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
const fs = require('fs');
const CAPTURE = ${JSON.stringify(capturePath)};
const OBJECTIVE = ${JSON.stringify(OBJECTIVE)};
const PREFIX_DIR = ${JSON.stringify(PREFIX_DIR)};
const MIXED_DIR = ${JSON.stringify(MIXED_DIR)};
const FINAL_DIR = ${JSON.stringify(FINAL_DIR)};

function ok(plan) {
  return {
    ok: true, status: 200,
    headers: new Map([['x-request-id', 'preflight']]),
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
  const input = Array.isArray(body.input) ? body.input : [];

  let context = null;
  for (const item of input) {
    if (!item || typeof item.content !== 'string') continue;
    try {
      const parsed = JSON.parse(item.content);
      if (parsed && typeof parsed === 'object' && parsed.ticketObjective !== undefined) context = parsed;
    } catch (_) { /* system prose */ }
  }
  const objective = context ? String(context.ticketObjective || '') : '';
  const prior = context && Array.isArray(context.previousActionResults) ? context.previousActionResults : [];

  fs.appendFileSync(CAPTURE, JSON.stringify({ objective, previousActionResults: prior }) + '\\n');
  if (objective !== OBJECTIVE) return ok({ message: 'unrelated', actions: [], complete: true });

  const sawInvalidArgs = prior.some(item => item && item.warning === 'workspace.invalid_action_args');
  const sawPhaseViolation = prior.some(item => item && item.warning === 'execution.phase_violation');

  if (sawPhaseViolation) {
    // Turn 3 — recovery AND the positive control: a valid single-phase batch executes.
    return ok({
      message: 'Emitting a corrected single-phase mutation batch.',
      actions: [{ operation: 'createFolder', args: { path: FINAL_DIR } }],
      complete: true
    });
  }
  if (sawInvalidArgs) {
    // Turn 2 — mixed phases in one response: inspection plus mutation.
    return ok({
      message: 'Inspecting and mutating together.',
      actions: [
        { operation: 'listDirectory', args: { path: '' } },
        { operation: 'createFolder', args: { path: MIXED_DIR } }
      ],
      complete: false
    });
  }
  // Turn 1 — a VALID action followed by an invalid one. createFolder may not take an
  // empty path. If preflight ran per action instead of over the batch, the first folder
  // would already exist by the time the second was rejected.
  return ok({
    message: 'Creating folders.',
    actions: [
      { operation: 'createFolder', args: { path: PREFIX_DIR } },
      { operation: 'createFolder', args: { path: '' } }
    ],
    complete: false
  });
};
`);
  return preloadPath;
}

async function main() {
  const capturePath = path.join(os.tmpdir(), `preflight-capture-${process.pid}-${STAMP}.jsonl`);
  fs.writeFileSync(capturePath, '');
  const preloadPath = createPreload(capturePath);

  try {
    await withHarness('action batch preflight', async ({ store, workspaceRoot, startServer }) => {
      const agent = (await store.createConfiguredAgent({
        value: { name: `Preflight-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'k' },
        groupIds: [], changedBy: 'action-batch-preflight-test'
      })).agent;

      const server = await startServer({ env: {
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '60000',
        // Headroom over the three intended turns, so a suite failure means the contract
        // broke rather than the conversation being silently truncated by a limit.
        AGENT_MAX_EXECUTION_STEPS: '6',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '6'
      } });
      const cookie = await server.login();

      assert((await server.request('POST', '/tickets', {
        cookie,
        form: {
          objective: OBJECTIVE,
          assignmentTargetType: 'agent', assignmentTargetId: String(agent.id), assignmentMode: 'individual'
        }
      })).statusCode === 302, 'ticket created');

      const run = await waitFor(async () => {
        const runs = (await store.listRuns({ limit: 50 })).runs || [];
        const found = runs.find(r => r.agentId === agent.id);
        return found && ['completed', 'failed', 'interrupted'].includes(found.status) ? found : null;
      }, 90000, 'the run to reach a terminal status');

      const captured = fs.readFileSync(capturePath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
      const turns = captured.filter(entry => entry.objective === OBJECTIVE);
      const replay = await store.readRunReplay(run.id);
      const snapshot = (replay && replay.snapshot) || {};
      const replayEvents = snapshot.events || [];
      const operations = await store.listRunOperations(run.id, { limit: 50 });
      const receipts = operations.operations || operations;

      // ── 0. NOTHING from the invalid batch executed ──────────────────────────
      // Checked FIRST, before the turn/status floor, because a leftover prefix effect is
      // observable however the run ended and is the contract itself. Ordering it after
      // the floor made a preflight regression report "the run didn't reach three turns",
      // which is true but names the symptom rather than the defect.
      // The core of the contract. A valid action preceded the invalid one; if validation
      // were per action, this folder would exist.
      scenariosRun += 1;
      assert(!fs.existsSync(path.join(workspaceRoot, PREFIX_DIR)),
        `0: the VALID action preceding the invalid one left no filesystem effect (${PREFIX_DIR})`);
      assert(!receipts.some(receipt => String(receipt.workspacePath || '').includes(PREFIX_DIR)),
        '0: and produced no operation receipt');
      const prefixOps = (snapshot.workspaceOperations || []).filter(item =>
        JSON.stringify(item.operation || {}).includes(PREFIX_DIR));
      assert(prefixOps.length === 0,
        `0: replay records no execution of the rejected batch's prefix (${prefixOps.length})`);

      // ── 1. HARD FLOOR — every intended branch was reached ───────────────────
      scenariosRun += 1;
      assert(turns.length >= 3,
        `1: the run reached all three state-driven turns (${turns.length})`);
      assert(run.status === 'completed',
        `1: and recovered to completion rather than dying at a limit (${run.status}: ${run.error || ''})`);

      // ── 2. Structured evidence identifies the invalid action ───────────────
      scenariosRun += 1;
      const invalidEvent = replayEvents.find(event => event && event.type === 'workspace.invalid_action_args');
      assert(invalidEvent,
        `2: the rejection is durable evidence (${replayEvents.map(e => e && e.type).join(', ')})`);
      assert(invalidEvent.rejectedBatch === true && invalidEvent.executed === false,
        `2: recorded explicitly as a rejected, unexecuted batch ` +
        `(rejectedBatch=${invalidEvent.rejectedBatch} executed=${invalidEvent.executed})`);
      assert(invalidEvent.operation === 'createFolder',
        `2: naming the operation that was invalid (${invalidEvent.operation})`);
      assert(invalidEvent.actionIndex === 1,
        `2: and WHICH action it was — index 1, not the valid action at index 0 (${invalidEvent.actionIndex})`);
      assert(Array.isArray(invalidEvent.validationErrors) && invalidEvent.validationErrors.length > 0,
        `2: with a reason, not merely a rejection (${JSON.stringify(invalidEvent.validationErrors)})`);

      const ticketEvents = (await store.listTicketEvents(run.ticketId, { limit: 200 })).events;
      const journalEvent = ticketEvents.find(event =>
        event.type === 'workspace.invalid_action_args' && event.runId === run.id);
      assert(journalEvent && journalEvent.payload.actionIndex === 1,
        '2: the same rejection is in the append-only journal, not only the replay snapshot');

      // ── 3. The next turn receives truthful corrective evidence ─────────────
      scenariosRun += 1;
      const secondPrior = turns[1].previousActionResults;
      const correction = secondPrior.find(item => item && item.warning === 'workspace.invalid_action_args');
      assert(correction,
        `3: the next model turn is told the batch was rejected ` +
        `(${secondPrior.map(i => i && (i.warning || (i.action && i.action.operation))).join(', ')})`);
      assert(correction.executed === false && correction.rejectedBatch === true,
        '3: and told explicitly that nothing ran, so it does not assume a partial effect');
      assert(correction.actionIndex === 1 && correction.operation === 'createFolder',
        `3: naming the offending action so a correction is possible (${correction.actionIndex}, ${correction.operation})`);
      assert(typeof correction.message === 'string' && correction.message.length > 0,
        '3: with a message explaining what to emit instead');

      // ── 4. Mixed-phase batches are rejected without mutating ───────────────
      scenariosRun += 1;
      const phaseEvent = replayEvents.find(event => event && event.type === 'execution.phase_violation');
      assert(phaseEvent,
        `4: a batch mixing inspection and mutation is refused (${replayEvents.map(e => e && e.type).join(', ')})`);
      assert(!fs.existsSync(path.join(workspaceRoot, MIXED_DIR)),
        `4: and its mutation never executed (${MIXED_DIR})`);
      assert(!receipts.some(receipt => String(receipt.workspacePath || '').includes(MIXED_DIR)),
        '4: leaving no receipt for the mixed batch either');
      const thirdPrior = turns[2].previousActionResults;
      assert(thirdPrior.some(item => item && item.warning === 'execution.phase_violation'),
        `4: and the model is told why (${thirdPrior.map(i => i && i.warning).join(', ')})`);

      // ── 5. POSITIVE CONTROL — a valid single-phase batch still executes ────
      // Without this, every assertion above is satisfied by a runtime that refuses
      // everything, which would be a far worse system than the one being guarded.
      scenariosRun += 1;
      assert(fs.existsSync(path.join(workspaceRoot, FINAL_DIR)),
        `5: the corrected single-phase batch DID execute (${FINAL_DIR})`);
      const finalReceipts = receipts.filter(receipt =>
        String(receipt.workspacePath || '').includes(FINAL_DIR));
      assert(finalReceipts.length === 1,
        `5: producing exactly one operation receipt (${finalReceipts.length})`);
      assert(receipts.length === 1,
        `5: and it is the ONLY receipt the run produced — the two rejected batches left none (${receipts.length})`);

      assertScenariosExecuted({
        label: 'action batch preflight',
        assertions: assert.count(),
        scenarios: scenariosRun,
        minAssertions: 20,
        minScenarios: 6
      });
      console.log(`\nPASS: action batch preflight — ${scenariosRun} scenarios, ${assert.count()} assertions (PostgreSQL-native)`);
    }, { schemaSlug: 'preflight_batch' });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
    try { fs.unlinkSync(capturePath); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(`\nFAIL: action batch preflight — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
