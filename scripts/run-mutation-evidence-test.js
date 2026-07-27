#!/usr/bin/env node
'use strict';
// Committed-mutation evidence — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A26).
//
// THE CONTRACT: what a run is recorded as having CHANGED must come from the operations
// that actually committed, and one committed operation must count exactly once.
//
// Two consumers depend on that number and must never disagree:
//
//   AUTOMATIC RETRY — a failed run that already mutated the workspace must not be
//   retried, because a retry re-enters a workspace the previous attempt left partly
//   modified.
//
//   THE FINALIZED REPLAY — `mutationCount` and `mutationOutcome` are the durable record
//   an operator reads to answer "did this run change anything?".
//
// Before A26 the helper behind both took an optional history array that defaulted to
// `[]`, and FOUR production call sites invoked it with only a run id — so it could only
// ever return 0. Every run, failed or completed, recorded `no_mutations`; the mutated-run
// retry guard never fired. The consequence record (A16) was already correct, so two
// durable authorities on the same question disagreed.
//
// THE AUTHORITATIVE SOURCE is `readAllRunOperations` — the committed operation receipts,
// the same records operation reconciliation, run consequence and the operator surfaces
// read. Deliberately NOT the requested operation name, a planned action, a refused or
// failed operation, a replay entry without a receipt, or the workspace itself (which
// cannot tell this run's changes from what was already there).
//
// FAIL-CLOSED, ASSERTED AS A SHAPE. When receipts cannot be read the count is `null` and
// the outcome is `unknown` — never 0 / `no_mutations`, because both consumers read 0 as
// permission: to retry, and to attest that nothing changed.
//
// THE MULTI-MUTATION CONTROL IS LOAD-BEARING. Scenario 1 commits TWO distinct mutations,
// so a hardcoded 1 — or a boolean "did it mutate" widened into a count — cannot pass.
//
// NO VACUOUS EXIT. No skip path, no NOT_PROVEN, every wait throws on timeout, and the
// floor requires the runs to have actually executed before any count is trusted.
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

const RETRY_POLICY = { autoRetry: true, maxAttempts: 2 };

const CASES = Object.freeze([
  // Two distinct committed mutations, then a runtime limit. Retryable classification,
  // but mutated — so the ceiling is irrelevant and it must not be retried.
  { key: 'mutated', kind: 'mutate2', policy: RETRY_POLICY, expectRuns: 1, expectCount: 2 },
  // Inspection only: the A25 eligible shape, retried exactly once.
  { key: 'clean', kind: 'stall', policy: RETRY_POLICY, expectRuns: 2, expectCount: 0 },
  // One committed mutation plus one refused mutation in the same batch.
  { key: 'refused', kind: 'refused', policy: { autoRetry: false, maxAttempts: 2 }, expectRuns: 1, expectCount: 1 },
  // Read-only work only, then a limit.
  { key: 'readonly', kind: 'readonly', policy: { autoRetry: false, maxAttempts: 2 }, expectRuns: 1, expectCount: 0 },
  // A run that COMPLETES after mutating — the `completeAgentRun` call site, which had
  // the same defect and made every successful run claim `no_mutations`.
  { key: 'completed', kind: 'complete1', policy: { autoRetry: false, maxAttempts: 2 }, expectRuns: 1, expectCount: 1 }
]);

const marker = key => `MUTEV${key.toUpperCase()}${STAMP}`;
const byKey = key => CASES.find(item => item.key === key);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function createPreload() {
  const preloadPath = path.join(os.tmpdir(), `mutation-evidence-preload-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
const CASES = ${JSON.stringify(CASES.map(item => ({ key: item.key, kind: item.kind, marker: marker(item.key) })))};
const STAMP = ${JSON.stringify(String(STAMP))};
function ok(plan) {
  return {
    ok: true, status: 200,
    headers: new Map([['x-request-id', 'run-mutation-evidence']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify(plan),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
}
global.fetch = async function(_url, options = {}) {
  const raw = String(options.body || '');
  const scenario = CASES.find(candidate => raw.includes(candidate.marker));
  if (!scenario) return ok({ message: 'unrelated', actions: [], complete: true });
  const first = !raw.includes('previousActionResults');
  const k = scenario.key;

  if (scenario.kind === 'stall') return ok({ message: 'thinking', actions: [], complete: false });

  if (scenario.kind === 'readonly') {
    if (first) return ok({ message: 'look', actions: [{ operation: 'listDirectory', args: { path: '' } }], complete: false });
    return ok({ message: 'thinking', actions: [], complete: false });
  }

  if (scenario.kind === 'complete1') {
    if (first) return ok({ message: 'write', actions: [{ operation: 'writeFile', args: { path: k + '-only-' + STAMP + '.txt', content: 'x' } }], complete: true });
    return ok({ message: 'done', actions: [], complete: true });
  }

  if (scenario.kind === 'refused') {
    // Turn 1: one legitimate mutation, plus one that PREPARES an operation and then
    // fails before its effect (writing onto a directory) — that failure leaves a
    // receipt with a non-committed outcome, which is what exercises the outcome guard.
    if (first) return ok({ message: 'mixed', actions: [
      { operation: 'writeFile', args: { path: k + '-good-' + STAMP + '.txt', content: 'x' } },
      { operation: 'writeFile', args: { path: 'seeded-dir-' + STAMP, content: 'x' } }
    ], complete: false });
    // Turn 2: a mutation refused by POLICY, which is rejected before preparation and
    // therefore leaves no receipt at all. Both non-committed shapes in one run.
    return ok({ message: 'refused', actions: [
      { operation: 'writeFile', args: { path: '.hidden-' + STAMP, content: 'x' } }
    ], complete: false });
  }

  // mutate2: two DISTINCT committed mutations, then stall into a runtime limit.
  if (first) return ok({ message: 'two', actions: [
    { operation: 'writeFile', args: { path: k + '-alpha-' + STAMP + '.txt', content: 'a' } },
    { operation: 'createFolder', args: { path: k + '-beta-' + STAMP } }
  ], complete: false });
  return ok({ message: 'thinking', actions: [], complete: false });
};
`);
  return preloadPath;
}

async function main() {
  const preloadPath = createPreload();
  try {
    await withHarness('run mutation evidence', async ({ store, workspaceRoot, startServer }) => {
      const agent = (await store.createConfiguredAgent({
        value: { name: `MutationEvidence-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'k' },
        groupIds: [], changedBy: 'run-mutation-evidence-test'
      })).agent;

      // A real directory, so `writeFile` onto it fails AFTER preparing its operation.
      fs.mkdirSync(path.join(workspaceRoot, `seeded-dir-${STAMP}`), { recursive: true });

      const serverEnv = {
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '600000',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_EXECUTION_STEPS: '3'
      };
      const server = await startServer(serverEnv);
      const cookie = await server.login();

      for (const scenario of CASES) {
        scenario.objective = `${marker(scenario.key)} exercise the ${scenario.key} mutation-evidence path`;
        const response = await server.request('POST', '/tickets', {
          cookie,
          form: {
            objective: scenario.objective,
            assignmentTargetType: 'agent',
            assignmentTargetId: String(agent.id),
            assignmentMode: 'individual',
            executionPolicy: JSON.stringify(scenario.policy)
          }
        });
        if (response.statusCode !== 302) {
          throw new Error(`ticket creation for ${scenario.key} returned HTTP ${response.statusCode}`);
        }
      }

      const tickets = (await store.listTickets({ limit: 100 })).tickets || [];
      for (const scenario of CASES) {
        const ticket = tickets.find(candidate => candidate.objective === scenario.objective);
        if (!ticket) throw new Error(`ticket for ${scenario.key} was not persisted`);
        scenario.ticketId = ticket.id;
      }

      const runsFor = async ticketId => {
        const runs = (await store.listRuns({ limit: 300 })).runs || [];
        return runs.filter(run => run.ticketId === ticketId).sort((a, b) => a.id - b.id);
      };

      // Quiesce on terminal status, not on expected counts: a count regression must
      // surface as a count assertion, never as a wait timeout.
      await waitFor(async () => {
        for (const scenario of CASES) {
          const runs = await runsFor(scenario.ticketId);
          if (runs.length === 0) return false;
          if (!runs.every(run => ['completed', 'failed', 'interrupted'].includes(run.status))) return false;
        }
        return true;
      }, 240000, 'every ticket to reach a quiet terminal state');
      await sleep(6000);

      // The count this suite checks the runtime against, derived independently here
      // from the same authoritative receipts: DISTINCT operation keys whose outcome
      // committed and whose operation mutates.
      const MUTATING = ['writeFile', 'createFolder', 'renamePath', 'deletePath'];
      const independentCount = async runId => {
        const operations = await store.listRunOperations(runId, { limit: 200 });
        const keys = new Set();
        for (const op of operations) {
          if (op.outcome !== 'succeeded') continue;
          if (!MUTATING.includes(op.operation)) continue;
          keys.add(op.operationKey);
        }
        return { count: keys.size, operations };
      };
      const firstRunOf = async key => (await runsFor(byKey(key).ticketId))[0];
      const replayOf = async runId => (await store.getReplaySnapshot(runId)).snapshot;

      // ── 0. FLOOR — the runs executed ─────────────────────────────────────────
      scenariosRun += 1;
      for (const scenario of CASES) {
        const runs = await runsFor(scenario.ticketId);
        assert(runs.length >= 1, `0: ${scenario.key} produced a run (${runs.length})`);
        assert(runs.every(run => ['completed', 'failed'].includes(run.status)),
          `0: ${scenario.key} runs settled (${runs.map(r => r.status).join(',')})`);
      }

      // ── 1. MULTI-MUTATION CONTROL — the count is a count ─────────────────────
      // Two DISTINCT committed mutations. A hardcoded 1, or a boolean widened into a
      // count, cannot satisfy this.
      scenariosRun += 1;
      const mutatedRun = await firstRunOf('mutated');
      const mutatedReplay = await replayOf(mutatedRun.id);
      assert(mutatedReplay.mutationCount === 2,
        `1: the finalized replay records both committed mutations (${mutatedReplay.mutationCount})`);
      assert(mutatedReplay.mutationOutcome === 'partial_mutations',
        `1: and classifies the outcome for a failed run that changed things (${mutatedReplay.mutationOutcome})`);
      assert(mutatedReplay.mutationOutcome !== 'no_mutations',
        '1: never as no_mutations, which is what it claimed before A26');
      assert(fs.existsSync(path.join(workspaceRoot, `mutated-alpha-${STAMP}.txt`)) &&
             fs.existsSync(path.join(workspaceRoot, `mutated-beta-${STAMP}`)),
        '1: and both effects are really on disk, so the count describes reality');
      const mutatedIndependent = await independentCount(mutatedRun.id);
      assert(mutatedIndependent.count === 2,
        `1: the authoritative receipts independently show two committed mutations (${mutatedIndependent.count})`);

      // ── 2. A MUTATED RUN IS NOT AUTOMATICALLY RETRIED ────────────────────────
      scenariosRun += 1;
      const mutatedRuns = await runsFor(byKey('mutated').ticketId);
      assert(mutatedRuns.length === 1,
        `2: a failed run that already mutated the workspace is not retried (${mutatedRuns.length} runs)`);
      assert(mutatedRun.triage && mutatedRun.triage.reasonCode === 'runtime_failed',
        `2: even though its classification is the retryable one (${mutatedRun.triage && mutatedRun.triage.reasonCode})`);
      assert(byKey('mutated').policy.autoRetry === true && byKey('mutated').policy.maxAttempts === 2,
        '2: and its policy did ask for retries, so the mutation is the only thing stopping it');

      // ── 3. A25 REMAINS INTACT — the clean run still retries ──────────────────
      // The positive control. Without it, a runtime that stopped retrying everything
      // would satisfy scenario 2.
      scenariosRun += 1;
      const cleanRuns = await runsFor(byKey('clean').ticketId);
      assert(cleanRuns.length === 2,
        `3: an inspection-only runtime failure is still retried exactly once (${cleanRuns.length} runs)`);
      assert(cleanRuns[1].delegatedPermissionSource === 'auto_retry',
        `3: with auto_retry provenance intact (${cleanRuns[1].delegatedPermissionSource})`);
      assert((await replayOf(cleanRuns[0].id)).mutationCount === 0,
        '3: and its count really is zero, so eligibility was earned rather than defaulted');
      assert((await replayOf(cleanRuns[0].id)).mutationOutcome === 'no_mutations',
        '3: recorded as no_mutations, which is now a claim rather than a default');

      // ── 4. REFUSED MUTATIONS DO NOT COUNT ────────────────────────────────────
      scenariosRun += 1;
      const refusedRun = await firstRunOf('refused');
      const refusedReplay = await replayOf(refusedRun.id);
      assert(refusedReplay.mutationCount === 1,
        `4: only the committed mutation counts, not the refused one (${refusedReplay.mutationCount})`);
      assert(fs.existsSync(path.join(workspaceRoot, `refused-good-${STAMP}.txt`)),
        '4: the committed one really landed');
      assert(!fs.existsSync(path.join(workspaceRoot, `.hidden-${STAMP}`)),
        '4: and the refused one really did not');
      // A path refused by policy is rejected BEFORE the operation is prepared, so it
      // leaves no receipt at all rather than a receipt with a failed outcome. Both
      // shapes are "not committed"; what matters is that neither can be counted, and
      // that the refusal is still recorded somewhere an operator can see.
      const refusedOps = (await independentCount(refusedRun.id)).operations;
      const committed = refusedOps.filter(op => op.outcome === 'succeeded' && MUTATING.includes(op.operation));
      assert(committed.length === 1,
        `4: exactly one operation committed a receipt (${refusedOps.map(o => `${o.operation}:${o.outcome}`).join(',')})`);
      assert(!refusedOps.some(op => op.outcome === 'succeeded' &&
             String(op.targetPath || '').includes('.hidden')),
        '4: and no receipt claims the policy-refused path succeeded');
      // The failed-before-effect mutation DID prepare an operation, so it leaves a
      // receipt whose outcome is not `succeeded`. That receipt is the one the outcome
      // guard has to reject; without it the guard would be untested here.
      const notCommitted = refusedOps.filter(op => op.outcome && op.outcome !== 'succeeded');
      assert(notCommitted.length >= 1,
        `4: a mutation that failed before its effect leaves a non-committed receipt (${refusedOps.map(o => `${o.operation}:${o.outcome}`).join(',')})`);
      assert(notCommitted.every(op => MUTATING.includes(op.operation)),
        '4: and it is a mutating operation, so only its outcome keeps it out of the count');
      assert(!fs.existsSync(path.join(workspaceRoot, `seeded-dir-${STAMP}`, 'x')),
        '4: the failed mutation left no effect inside the directory it targeted');
      const refusedReplayOps = ((await replayOf(refusedRun.id)).workspaceOperations || []);
      assert(refusedReplayOps.some(op => op.blocked === true),
        `4: the refusal is still durable evidence, recorded as blocked (${refusedReplayOps.map(o => `${o.operation && o.operation.operation}:${o.blocked}`).join(',')})`);
      assert((await independentCount(refusedRun.id)).count === 1,
        '4: and the authoritative receipts agree on exactly one committed mutation');

      // ── 5. READ-ONLY WORK DOES NOT COUNT ─────────────────────────────────────
      scenariosRun += 1;
      const readonlyRun = await firstRunOf('readonly');
      // Reads are durable in the replay, not in the receipt table — `completeActionReceipt`
      // is a mutation-commit path. That is itself part of why a read cannot be counted,
      // so the read is asserted where it actually lives.
      const readonlyReplayOps = ((await replayOf(readonlyRun.id)).workspaceOperations || []);
      assert(readonlyReplayOps.some(op => op.operation && op.operation.operation === 'listDirectory' && !op.error),
        `5: the read-only run really performed a successful read (${readonlyReplayOps.map(o => o.operation && o.operation.operation).join(',')})`);
      const readonlyOps = (await independentCount(readonlyRun.id)).operations;
      assert(!readonlyOps.some(op => MUTATING.includes(op.operation)),
        `5: and committed no mutating receipt (${readonlyOps.map(o => `${o.operation}:${o.outcome}`).join(',')})`);
      assert((await replayOf(readonlyRun.id)).mutationCount === 0,
        `5: and a successful read increments nothing (${(await replayOf(readonlyRun.id)).mutationCount})`);
      assert((await replayOf(readonlyRun.id)).mutationOutcome === 'no_mutations',
        '5: recorded as no_mutations, truthfully this time');

      // ── 6. A COMPLETED RUN IS COUNTED TOO ────────────────────────────────────
      // The `completeAgentRun` call site had the same defect, so every SUCCESSFUL run
      // attested `no_mutations` regardless of what it wrote.
      scenariosRun += 1;
      const completedRun = await firstRunOf('completed');
      assert(completedRun.status === 'completed',
        `6: the control run completed (${completedRun.status})`);
      const completedReplay = await replayOf(completedRun.id);
      assert(completedReplay.mutationCount === 1,
        `6: a completed run records the mutation it made (${completedReplay.mutationCount})`);
      assert(completedReplay.mutationOutcome === 'all_intended',
        `6: and classifies it as intended rather than partial (${completedReplay.mutationOutcome})`);

      // ── 7. ONE COMMITTED OPERATION COUNTS ONCE ───────────────────────────────
      // Receipts are keyed by a stable operation key; a reconciled or replayed effect
      // surfaces under the SAME key and must not add to the total. Proved against the
      // production write path: re-offering an identical receipt creates no second row
      // and moves no count.
      scenariosRun += 1;
      const before = await independentCount(mutatedRun.id);
      const sample = before.operations.find(op => op.outcome === 'succeeded' && MUTATING.includes(op.operation));
      assert(sample, '7: a committed mutation receipt is available to re-offer');
      const receiptsBefore = (await store.listOperationReceipts(mutatedRun.id, { limit: 200 })).length;
      let conflict = null;
      try {
        await store.recordOperationReceipt({
          runId: mutatedRun.id,
          idempotencyKey: sample.operationKey,
          stepId: String(sample.step === undefined || sample.step === null ? '0' : sample.step),
          operation: sample.operation,
          outcome: 'succeeded',
          receipt: { replayedBy: 'run-mutation-evidence-test' },
          eventType: null
        });
      } catch (error) {
        conflict = error;
      }
      // Stronger than "no second row": the store REFUSES to record a second, divergent
      // receipt under an operation key that already committed. One committed operation
      // cannot acquire a second account of itself, so it cannot be counted twice.
      assert(conflict !== null,
        '7: a second, divergent receipt for a committed operation key is refused');
      assert(/idempotency/i.test(String(conflict.message)),
        `7: refused as an idempotency conflict, naming the key (${conflict.message})`);
      const receiptsAfter = (await store.listOperationReceipts(mutatedRun.id, { limit: 200 })).length;
      assert(receiptsAfter === receiptsBefore,
        `7: the receipt table is unchanged (${receiptsBefore} → ${receiptsAfter})`);
      assert((await independentCount(mutatedRun.id)).count === before.count,
        `7: and the committed-mutation count is unchanged (${before.count})`);
      const distinctKeys = new Set(before.operations
        .filter(op => op.outcome === 'succeeded' && MUTATING.includes(op.operation))
        .map(op => op.operationKey));
      assert(distinctKeys.size === mutatedReplay.mutationCount,
        `7: the recorded count equals the number of DISTINCT committed operations (${distinctKeys.size} vs ${mutatedReplay.mutationCount})`);

      // ── 8. HYDRATION — the durable numbers survive a restart ─────────────────
      scenariosRun += 1;
      await server.stop();
      const restarted = await startServer(serverEnv);
      await restarted.login();
      await sleep(5000);
      for (const scenario of CASES) {
        const runs = await runsFor(scenario.ticketId);
        assert(runs.length === scenario.expectRuns,
          `8: ${scenario.key} gained no run across the restart (${runs.length} vs ${scenario.expectRuns})`);
        const replay = await replayOf(runs[0].id);
        assert(replay.mutationCount === scenario.expectCount,
          `8: ${scenario.key} still records ${scenario.expectCount} committed mutation(s) (${replay.mutationCount})`);
      }

      assertScenariosExecuted({
        label: 'run mutation evidence',
        assertions: assert.count(),
        scenarios: scenariosRun,
        minAssertions: 35,
        minScenarios: 9
      });
      console.log(`\nPASS: run mutation evidence — ${scenariosRun} scenarios, ${assert.count()} assertions (PostgreSQL-native)`);
    }, { schemaSlug: 'mutation_evidence' });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(`\nFAIL: run mutation evidence — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
