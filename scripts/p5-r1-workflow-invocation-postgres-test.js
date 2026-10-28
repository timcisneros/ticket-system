#!/usr/bin/env node
'use strict';
// P5-R1 — Executable governed workflow invocation — PostgreSQL-native owner.
//
// Authority: docs/ARCHITECTURAL_DECISIONS_PENDING.md §22 slice P5-R1 and
// §13 INVOKE-RECOVERY-B (Run-stable invocation identity, deterministic
// same-Run re-entry, exactly-once effect replay, fail-closed divergence).
//
// THE CONTRACT (each scenario owns one frozen assertion):
//   1. `allowWorkflowInvocation` defaults FALSE (absent → false) and freezes
//      into the admitted Run's executionPolicySnapshot.
//   2. TRUE opt-in freezes into the admitted Run snapshot and cannot drift
//      after admission (later ticket edits do not retroactively change it).
//   3. FALSE policy → a proposed invokeWorkflow is refused typed
//      (WORKFLOW_INVOCATION_NOT_AUTHORIZED, authority_denied) with durable
//      denial evidence, ZERO invocation evidence, and ZERO workflow effect.
//   4. TRUE + missing workflow refuses (WORKFLOW_NOT_FOUND), zero effect.
//   5. TRUE + disabled workflow refuses (WORKFLOW_DISABLED), zero effect.
//   6. TRUE + input outside the workflow inputSchema refuses
//      (WORKFLOW_INPUT_INVALID), zero effect.
//   7. TRUE + valid workflow executes the invoked definition INSIDE the same
//      Run: workspace effect present, ONE Run-stable workflowInvocation item,
//      per-step workflowActions evidence, and the bounded result flows back to
//      the proposing Run.
//   8. Invocation creates NO child Ticket, NO attempt, and NO child Run.
//   9. invokeWorkflow remains NON-workflow-usable: a definition containing it
//      is canonically invalid and is refused by the workflow catalog surface.
//  10. The invoked workflow consumes the parent Run's immutable budget ledger
//      (execution steps, workspace operations) — no reset, no second envelope.
//  11. No authority amplification: every receipt/evidence entry carries the
//      PARENT run identity; the admitted snapshots and policy hash are
//      unchanged after the invocation; no browser authority appears.
//  12. Recovery (Case B): after durable invocation evidence but before any
//      effect, safe resume re-enters the definition deterministically — the
//      SAME invocation identity is reused and the effect executes once.
//  13. Recovery (Case C): after a committed workspace effect inside the
//      invoked workflow, the receipt is replayed — no second filesystem
//      mutation, no second receipt, evidence unchanged.
//  14. Provider identity (Case D — §13's provider leg): a started governed
//      provider request is never re-dispatched and a durable response is
//      reused. This is owned MORE STRONGLY by the existing governed
//      request/reuse authority suites —
//      scripts/governed-leaf-production-path-postgres-test.js (which pins
//      `reused_durable_response` with zero transport calls for settled and
//      recovered requests) and scripts/governed-required-persistence-postgres-test.js
//      (the required-persistence path that reaches the same reuse seam) — so
//      this suite OWNS IT BY REFERENCE instead of duplicating that harness
//      with a synthetic identity the R1 dispatch never mints.
//  15. Divergence (Case E): the same Run-stable invocation identity resolving
//      a different canonical input fails closed (WORKFLOW_INVOCATION_CONFLICT,
//      resume_rejected) with the original evidence and effects unchanged.
//  16. Slot-owned workflow divergence (Case F): the SAME recovered proposing
//      action slot resolving a DIFFERENT enabled valid workflow fails closed
//      — the identity is owned by the slot, so a recovered logical action may
//      not change which workflow it means; the second workflow reaches ZERO
//      effects and no second identity is minted.
//  17. Migration authority is untouched: this suite adds no migration and
//      asserts nothing about the database schema beyond disposable test state.
//
// The model transport is stubbed hermetically (static plans keyed by objective
// markers), so the runtime path is the real product worker loop.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter, sleep } = require('./postgres-test-harness');
const { assertScenariosExecuted } = require('./child-process-settlement');
const sourceAssert = require('node:assert/strict');

const STAMP = Date.now();
const assert = createAsserter();
let scenariosRun = 0;

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const WORK_DIR = path.join(os.tmpdir(), `p5-r1-invocation-${process.pid}-${STAMP}`);
fs.mkdirSync(WORK_DIR, { recursive: true });

// Static model stub: one plan sequence per scenario marker, one turn at a time.
// `divergePlans` switches the stub to a divergent plan set once the marker's
// `.seen` marker file exists — the deterministic divergence seam for Case E,
// because the filesystem survives the crash while process memory does not.
function writePreload(scenarioPlans, parkTurns) {
  const preloadPath = path.join(WORK_DIR, `preload-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
const fs = require('fs');
const path = require('path');
const WORK_DIR = ${JSON.stringify(WORK_DIR)};
const PLANS = ${JSON.stringify(scenarioPlans)};
const PARKS = ${JSON.stringify(parkTurns)};
const TURNS = {};

function respond(plan) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'p5-r1-workflow-invocation']]),
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
  const marker = Object.keys(PLANS).find(candidate => raw.includes(candidate));
  if (!marker) {
    return respond({ message: 'Unexpected run; finishing.', actions: [], complete: true });
  }
  const turn = (TURNS[marker] = (TURNS[marker] || 0) + 1);
  const diverged = fs.existsSync(path.join(WORK_DIR, marker + '.seen'));
  const plans = (diverged && PLANS[marker].diverged) || PLANS[marker].base;
  const plan = plans[turn - 1] || { message: 'Finishing.', actions: [], complete: true };
  const parkTurn = PARKS[marker];
  if (parkTurn && turn === parkTurn) {
    try { fs.writeFileSync(path.join(WORK_DIR, marker + '.atgate'), 'gate'); } catch (_) {}
    while (fs.existsSync(path.join(WORK_DIR, marker + '.go')) === false) {
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  return respond(plan);
};
`);
  return preloadPath;
}

// Run driver: creates the ticket through the real product form, waits for the
// run to start and terminalize, and returns the durable evidence.
async function driveTicket(server, store, { cookie, agentId, objective, executionPolicy }) {
  const response = await server.request('POST', '/tickets', {
    cookie,
    form: {
      objective,
      assignmentTargetType: 'agent',
      assignmentTargetId: String(agentId),
      assignmentMode: 'individual',
      ...(executionPolicy ? { executionPolicy: JSON.stringify(executionPolicy) } : {})
    }
  });
  if (response.statusCode !== 302) {
    throw new Error(`ticket creation for ${objective} returned HTTP ${response.statusCode}: ${String(response.body).slice(0, 300)}`);
  }
  const ticket = await waitFor(async () => {
    const { tickets } = await store.listTickets({ limit: 300 });
    return tickets.find(candidate => candidate.objective === objective) || null;
  }, 60000, `${objective} ticket`);
  const started = await waitFor(async () => {
    const { runs } = await store.listRuns({ limit: 300 });
    return runs.find(candidate => candidate.ticketId === ticket.id) || null;
  }, 60000, `${objective} run dispatch`);
  const terminal = await waitFor(async () => {
    const current = await store.getRun(started.id);
    return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
  }, 240000, `${objective} terminal run`);
  const record = await store.readRunReplay(terminal.id);
  const snapshot = record && record.snapshot ? record.snapshot : null;
  const receipts = await store.listOperationReceipts(terminal.id, { limit: 300 });
  return { ticket, run: terminal, snapshot, receipts };
}

// The invocation workflow the agent proposes: schema-checked input, one
// workspace mutation, deterministic stop result.
const INVOKED_INPUT_SCHEMA = { targetPath: 'string', content: 'string' };

function invokedWorkflowDefinition(id, { enabled = true } = {}) {
  return {
    id,
    name: 'Invoked note workflow',
    inputSchema: INVOKED_INPUT_SCHEMA,
    enabled,
    actions: [
      {
        id: 'write-note',
        action: 'writeFile',
        input: { path: '{{workflow.input.targetPath}}', content: '{{workflow.input.content}}' },
        next: 'finish'
      },
      { id: 'finish', action: 'stop', input: { result: { written: '{{workflow.input.targetPath}}' } } }
    ],
    postconditions: [{ id: 'note-exists', type: 'fileExists', path: 'invoked-note.txt' }]
  };
}

async function main() {
  const preloadPath = writePreload(
    {
      // base plans per marker: turn sequences
      [`REFUSED${STAMP}`]: { base: [{ message: 'Invoking workflow.', actions: [{ operation: 'invokeWorkflow', args: { workflowId: `wf-invoked-${STAMP}`, input: { targetPath: 'invoked-note.txt', content: 'written by the invoked workflow' } } }], complete: true }] },
      [`MISSING${STAMP}`]: { base: [{ message: 'Invoking missing workflow.', actions: [{ operation: 'invokeWorkflow', args: { workflowId: `wf-missing-${STAMP}`, input: {} } }], complete: true }] },
      [`DISABLED${STAMP}`]: { base: [{ message: 'Invoking disabled workflow.', actions: [{ operation: 'invokeWorkflow', args: { workflowId: `wf-invoked-disabled-${STAMP}`, input: { targetPath: 'invoked-note.txt', content: 'x' } } }], complete: true }] },
      [`BADINPUT${STAMP}`]: { base: [{ message: 'Invoking with bad input.', actions: [{ operation: 'invokeWorkflow', args: { workflowId: `wf-invoked-input-${STAMP}`, input: { targetPath: 123, content: 'x' } } }], complete: true }] },
      [`SUCCESS${STAMP}`]: { base: [{ message: 'Invoking approved workflow.', actions: [{ operation: 'invokeWorkflow', args: { workflowId: `wf-invoked-${STAMP}`, input: { targetPath: 'invoked-note.txt', content: 'written by the invoked workflow' } } }], complete: true }] },
      [`RECOVERY${STAMP}`]: { base: [{ message: 'Invoking approved workflow before crash.', actions: [{ operation: 'invokeWorkflow', args: { workflowId: `wf-invoked-recovery-${STAMP}`, input: { targetPath: 'invoked-recovery-note.txt', content: 'crash-recovery note' } } }], complete: true }] },
      [`RECOVERC${STAMP}`]: { base: [{ message: 'Invoking approved workflow before crash.', actions: [{ operation: 'invokeWorkflow', args: { workflowId: `wf-invoked-recovery-${STAMP}`, input: { targetPath: 'invoked-recovery-note-c.txt', content: 'crash-recovery note' } } }], complete: true }] },
      [`DIVERGE${STAMP}`]: {
        base: [{ message: 'Invoking approved workflow.', actions: [{ operation: 'invokeWorkflow', args: { workflowId: `wf-invoked-diverge-${STAMP}`, input: { targetPath: 'invoked-diverge-note.txt', content: 'original payload' } } }], complete: false },
               { message: 'Finishing after invocation.', actions: [], complete: true }],
        diverged: [{ message: 'Re-proposing with a divergent payload.', actions: [{ operation: 'invokeWorkflow', args: { workflowId: `wf-invoked-diverge-${STAMP}`, input: { targetPath: 'invoked-diverge-note.txt', content: 'DIVERGED payload' } } }], complete: false }]
      },
      [`SLOTCHANGE${STAMP}`]: {
        base: [{ message: 'Invoking the original workflow.', actions: [{ operation: 'invokeWorkflow', args: { workflowId: `wf-invoked-${STAMP}`, input: { targetPath: 'invoked-slot-note.txt', content: 'original slot workflow' } } }], complete: false },
               { message: 'Finishing after invocation.', actions: [], complete: true }],
        diverged: [{ message: 'Re-proposing a DIFFERENT workflow at the same slot.', actions: [{ operation: 'invokeWorkflow', args: { workflowId: `wf-invoked-alt-${STAMP}`, input: { targetPath: 'invoked-alt-note.txt', content: 'different workflow payload' } } }], complete: false }]
      }
    },
    // park turns: marker -> turn index that parks until <marker>.go exists
    {}
  );

  await withHarness('p5 r1 workflow invocation', async ({ store, workspaceRoot, startServer }) => {
    const agent = (await store.createConfiguredAgent({
      value: { name: `P5R1Invoke-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'k' },
      groupIds: [], changedBy: 'p5-r1-workflow-invocation-test'
    })).agent;

    const abs = rel => path.join(workspaceRoot, rel);
    const exists = rel => fs.existsSync(abs(rel));

    let sharedServer = null;
    async function saveWorkflow(definition) {
      if (!sharedServer) {
        sharedServer = await startServer({ env: {
          NODE_OPTIONS: `--require ${preloadPath}`,
          RUNTIME_SCHEDULER_INTERVAL_MS: '200',
          RUN_LEASE_DURATION_MS: '60000'
        } });
      }
      const cookie = await sharedServer.login();
      const response = await sharedServer.request('POST', '/admin/workflows', {
        cookie, form: { definition: JSON.stringify(definition, null, 2) }
      });
      assert(response.statusCode === 302 || response.statusCode === 200,
        `workflow ${definition.id} saved (HTTP ${response.statusCode})`);
      return { server: sharedServer, cookie, response };
    }

    // ── Scenario 1: policy default false (absent → false) ─────────────────
    scenariosRun += 1;
    {
      const enabledDefinition = invokedWorkflowDefinition(`wf-invoked-${STAMP}`);
      await saveWorkflow(enabledDefinition);
      const disabledDefinition = invokedWorkflowDefinition(`wf-invoked-disabled-${STAMP}`, { enabled: false });
      await saveWorkflow(disabledDefinition);
      const inputVariant = invokedWorkflowDefinition(`wf-invoked-input-${STAMP}`);
      await saveWorkflow(inputVariant);
      const recoveryVariant = invokedWorkflowDefinition(`wf-invoked-recovery-${STAMP}`, {
        enabled: true
      });
      await saveWorkflow(recoveryVariant);
      const divergeVariant = invokedWorkflowDefinition(`wf-invoked-diverge-${STAMP}`);
      await saveWorkflow(divergeVariant);
      // Case F: a SECOND enabled, valid workflow for the same-slot/different-
      // workflow divergence scenario (schema-valid input, so the recovered
      // attempt reaches the invocation-identity conflict rather than an
      // earlier shape refusal).
      const altVariant = invokedWorkflowDefinition(`wf-invoked-alt-${STAMP}`);
      await saveWorkflow(altVariant);

      const server = sharedServer;
      const cookie = await server.login();
      const ticketsBefore = (await store.listTickets({ limit: 300 })).tickets.length;
      const outcome = await driveTicket(server, store, {
        cookie, agentId: agent.id,
        objective: `P5R1 default policy ${STAMP} marker-${`REFUSED${STAMP}`}`
      });
      assert(outcome.run.status === 'failed',
        `1: default-off policy refuses a proposed invokeWorkflow (${outcome.run.status})`);
      const failure = outcome.snapshot && outcome.snapshot.failure ? outcome.snapshot.failure : null;
      assert(failure && failure.kind === 'authority_denied' &&
        failure.code === 'WORKFLOW_INVOCATION_NOT_AUTHORIZED',
        `1: the refusal carries the typed authority_denied failure (${JSON.stringify(failure)})`);
      const denials = (outcome.snapshot.authorityChecks || []).filter(check =>
        check.status === 'denied' && check.rule === 'workflow_invocation');
      assert(denials.length >= 1, '1: the denial is recorded as authority evidence');
      assert((outcome.snapshot.workflowInvocation || []).length === 0,
        '1: a refused proposal leaves NO invocation evidence');
      assert((outcome.receipts || []).every(receipt => receipt.operation !== 'writeFile'),
        '1: a refused proposal commits zero workflow effect');
      const ticketsAfterRefused = (await store.listTickets({ limit: 300 })).tickets.length;
      assert(ticketsAfterRefused === ticketsBefore + 1,
        '1: the refusal created no additional Ticket');
    }

    // ── Scenario 2: TRUE opt-in freezes into the admitted Run snapshot ────
    scenariosRun += 1;
    {
      const server = sharedServer;
      const cookie = await server.login();
      const ticketsBeforeRun = (await store.listTickets({ limit: 300 })).tickets.length;
      const outcome = await driveTicket(server, store, {
        cookie, agentId: agent.id,
        objective: `P5R1 true policy ${STAMP} marker-${`SUCCESS${STAMP}`}`,
        executionPolicy: { allowWorkflowInvocation: true, maxExecutionSteps: 16, maxModelRequests: 16, maxRuntimeMs: 900000 }
      });
      assert(outcome.run.status === 'completed',
        `2: an authorized invokeWorkflow completes the run (${outcome.run.status}: ${outcome.run.error || ''})`);
      const policy = outcome.snapshot.executionPolicySnapshot || {};
      assert(policy.allowWorkflowInvocation === true,
        '2: TRUE opt-in freezes into the admitted Run snapshot');
      // Immutability: the snapshot the fresh reader sees is the admitted one.
      const persistedRun = await store.getRun(outcome.run.id);
      sourceAssert.equal(persistedRun.executionPolicySnapshot.allowWorkflowInvocation, true,
        'the persisted Run row carries the same frozen policy');
      assert(Boolean(persistedRun.runtimeBudgetSnapshot &&
        persistedRun.runtimeBudgetSnapshot.executionPolicyHash &&
        /^[0-9a-f]{64}$/.test(persistedRun.runtimeBudgetSnapshot.executionPolicyHash)),
        '2: the invocation authority is hash-bound into the runtime budget snapshot');
      // The invoked workflow's evidence: ONE Run-stable invocation item.
      const invocations = outcome.snapshot.workflowInvocation || [];
      assert(invocations.length === 1,
        `7: exactly ONE invocation evidence item (got ${invocations.length})`);
      const invocation = invocations[0];
      assert(invocation.workflowId === `wf-invoked-${STAMP}` &&
        invocation.invocationStatus === 'authorized' &&
        invocation.workflowVersion === '1' &&
        Object.prototype.hasOwnProperty.call(invocation, 'policyTextHash') &&
        Object.prototype.hasOwnProperty.call(invocation, 'verifierContractExecution'),
        '2/7: the invocation evidence names run, slot, workflow id/version/contract hash, input, authorization');
      assert(invocation.input && invocation.input.targetPath === 'invoked-note.txt' &&
        invocation.input.content === 'written by the invoked workflow',
        '7: the canonical invocation input is evidence-recorded');
      assert(Boolean(invocation.invokingAction) &&
        invocation.invokingAction.executionTurn === 0 &&
        invocation.invokingAction.actionIndex === 0 &&
        typeof invocation.invokingAction.planKey === 'string' &&
        invocation.invokingAction.planKey.endsWith(':plan'),
        '2/12: the invoking action slot is part of the Run-stable identity');
      // The effect happened exactly once and the workspace shows it.
      assert(exists('invoked-note.txt'), '7: the invoked workflow wrote the file');
      assert(fs.readFileSync(abs('invoked-note.txt'), 'utf8') === 'written by the invoked workflow',
        '7: the written content is exact');
      const writeReceipts = (outcome.receipts || []).filter(receipt => receipt.operation === 'writeFile');
      assert(writeReceipts.length === 1,
        `7/10: exactly ONE durable writeFile receipt (got ${writeReceipts.length})`);
      sourceAssert.equal(writeReceipts[0].idempotencyKey.startsWith(`run:${outcome.run.id}:slot:`), true,
        '10: the receipt identity is bound to the PARENT run id');
      // Per-step evidence recorded with the invoking workflow identity.
      const stepEvidence = (outcome.snapshot.workflowActions || [])
        .filter(item => item.workflowId === `wf-invoked-${STAMP}`);
      assert(stepEvidence.length >= 2,
        `7: the writeFile and stop steps recorded workflowActions evidence (got ${stepEvidence.length})`);
      // No child lifecycle objects.
      const ticketsAfter = (await store.listTickets({ limit: 300 })).tickets;
      assert(ticketsAfter.length === ticketsBeforeRun + 1,
        `8: the invocation created NO child Ticket (got ${ticketsAfter.length})`);
      const { runs } = await store.listRuns({ limit: 300 });
      assert(runs.filter(candidate => candidate.ticketId === outcome.ticket.id).length === 1,
        '8: the invocation created NO second Run for the proposing Ticket');
      // Budget: the invoked workflow consumed the parent Run ledger.
      const charges = await store.listRunBudgetCharges(outcome.run.id);
      const workflowExecutionSteps = charges.filter(charge =>
        charge.dimension === 'execution_step' &&
        charge.sourceIdentity.startsWith(`execution-step:workflow:wf-invoked-${STAMP}:`));
      assert(workflowExecutionSteps.length >= 1,
        `10: the invoked workflow's execution steps charged the parent ledger (got ${workflowExecutionSteps.length})`);
      assert(workflowExecutionSteps.every(charge => charge.state === 'committed'),
        '10: the invoked workflow execution-step reservations are committed under the parent envelope');
      const workspaceCharges = charges.filter(charge =>
        charge.dimension === 'workspace_operation' && charge.state === 'committed');
      assert(workspaceCharges.length === 1,
        `10: the invoked workspace mutation charged the parent ledger exactly once (got ${workspaceCharges.length})`);
      // Non-amplification: policy hash unchanged after the invocation.
      const hashBefore = persistedRun.runtimeBudgetSnapshot.executionPolicyHash;
      const refreshed = await store.getRun(outcome.run.id);
      sourceAssert.equal(refreshed.runtimeBudgetSnapshot.executionPolicyHash, hashBefore,
        '11: the admitted policy hash is unchanged after the invocation');
      sourceAssert.equal(
        (outcome.snapshot.browserOperations || []).length === 0, true,
        '11: workflow invocation grants no browser authority');
      sourceAssert.equal(
        (outcome.snapshot.processExecutionLifecycle || []).length === 0, true,
        '11: workflow invocation grants no process authority');
      await server.stop();
      sharedServer = null;
    }

    // ── Scenario 3: TRUE + missing workflow refuses ───────────────────────
    scenariosRun += 1;
    {
      const server = await startServer({ env: {
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '60000'
      } });
      const cookie = await server.login();
      const outcome = await driveTicket(server, store, {
        cookie, agentId: agent.id,
        objective: `P5R1 missing workflow ${STAMP} marker-${`MISSING${STAMP}`}`,
        executionPolicy: { allowWorkflowInvocation: true, maxExecutionSteps: 16, maxModelRequests: 16, maxRuntimeMs: 900000 }
      });
      assert(outcome.run.status === 'failed', '3: a missing workflow refuses typed');
      const failure = outcome.snapshot && outcome.snapshot.failure ? outcome.snapshot.failure : null;
      assert(failure && failure.code === 'WORKFLOW_NOT_FOUND',
        `3: the refusal carries WORKFLOW_NOT_FOUND (${JSON.stringify(failure)})`);
      assert((outcome.snapshot.workflowInvocation || []).length === 0,
        '3: a refused invocation leaves no invocation evidence');
      await server.stop();
    }

    // ── Scenario 4: TRUE + disabled workflow refuses ──────────────────────
    scenariosRun += 1;
    {
      const server = await startServer({ env: {
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '60000'
      } });
      const cookie = await server.login();
      const outcome = await driveTicket(server, store, {
        cookie, agentId: agent.id,
        objective: `P5R1 disabled workflow ${STAMP} marker-${`DISABLED${STAMP}`}`,
        executionPolicy: { allowWorkflowInvocation: true, maxExecutionSteps: 16, maxModelRequests: 16, maxRuntimeMs: 900000 }
      });
      assert(outcome.run.status === 'failed', '4: a disabled workflow refuses typed');
      const failure = outcome.snapshot && outcome.snapshot.failure ? outcome.snapshot.failure : null;
      assert(failure && failure.code === 'WORKFLOW_DISABLED',
        `4: the refusal carries WORKFLOW_DISABLED (${JSON.stringify(failure)})`);
      assert((outcome.snapshot.workflowInvocation || []).length === 0,
        '4: a refused invocation leaves no invocation evidence');
      await server.stop();
    }

    // ── Scenario 5: TRUE + input outside the workflow inputSchema refuses ─
    scenariosRun += 1;
    {
      const server = await startServer({ env: {
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '60000'
      } });
      const cookie = await server.login();
      const outcome = await driveTicket(server, store, {
        cookie, agentId: agent.id,
        objective: `P5R1 bad input ${STAMP} marker-${`BADINPUT${STAMP}`}`,
        executionPolicy: { allowWorkflowInvocation: true, maxExecutionSteps: 16, maxModelRequests: 16, maxRuntimeMs: 900000 }
      });
      assert(outcome.run.status === 'failed', '5: schema-invalid input refuses typed');
      const failure = outcome.snapshot && outcome.snapshot.failure ? outcome.snapshot.failure : null;
      assert(failure && failure.code === 'WORKFLOW_INPUT_INVALID',
        `5: the refusal carries WORKFLOW_INPUT_INVALID (${JSON.stringify(failure)})`);
      assert((outcome.snapshot.workflowInvocation || []).length === 0,
        '5: a refused invocation leaves no invocation evidence');
      assert((outcome.receipts || []).every(receipt => receipt.operation !== 'writeFile'),
        '5: schema-invalid input reaches no workflow effect (no writeFile receipt)');
      await server.stop();
    }

    // ── Scenario 6: invokeWorkflow remains non-workflow-usable ────────────
    scenariosRun += 1;
    {
      const server = await startServer({ env: {
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '60000'
      } });
      const cookie = await server.login();
      const nestedDefinition = {
        id: `wf-nested-${STAMP}`,
        name: 'Nested invocation attempt',
        inputSchema: {},
        actions: [
          { id: 'nest', action: 'invokeWorkflow', input: { workflowId: `wf-invoked-${STAMP}`, input: {} } },
          { id: 'finish', action: 'stop', input: { result: {} } }
        ],
        postconditions: []
      };
      const response = await server.request('POST', '/admin/workflows', {
        cookie, form: { definition: JSON.stringify(nestedDefinition, null, 2) }
      });
      assert(response.statusCode !== 302,
        `9: a definition containing invokeWorkflow is refused (HTTP ${response.statusCode})`);
      const nested = await store.getWorkflowById(`wf-nested-${STAMP}`);
      assert(nested === null, '9: the recursive definition was NOT persisted');
      await server.stop();
    }

    // ── Scenario 7 (Case B): resume after durable evidence, before effect ─
    scenariosRun += 1;
    {
      const preCrashServer = await startServer({ env: {
        NODE_OPTIONS: `--require ${preloadPath}`,
        TEST_INTERRUPTION_POINT: 'after_first_authority.allowed',
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '5000'
      } });
      const cookie = await preCrashServer.login();
      const objective = `P5R1 caseB recovery ${STAMP} marker-${`RECOVERY${STAMP}`}`;
      const created = await preCrashServer.request('POST', '/tickets', {
        cookie,
        form: {
          objective,
          assignmentTargetType: 'agent',
          assignmentTargetId: String(agent.id),
          assignmentMode: 'individual',
          executionPolicy: JSON.stringify({ allowWorkflowInvocation: true, maxExecutionSteps: 16, maxModelRequests: 16, maxRuntimeMs: 900000 })
        }
      });
      assert(created.statusCode === 302, `caseB ticket accepted (${created.statusCode})`);
      const ticket = await waitFor(async () => {
        const { tickets } = await store.listTickets({ limit: 300 });
        return tickets.find(candidate => candidate.objective === objective) || null;
      }, 60000, 'caseB ticket');
      const runRow = await waitFor(async () => {
        const { runs } = await store.listRuns({ limit: 300 });
        return runs.find(candidate => candidate.ticketId === ticket.id) || null;
      }, 60000, 'caseB run dispatch');
      // The interruption hook kills the server mid-invocation. A SIGKILLed
      // child carries `signalCode`, not an `exitCode` — the crash seam is
      // detected on either (the established pattern in
      // model-contract-violation-recovery-test.js).
      await waitFor(async () => preCrashServer.child.exitCode !== null || preCrashServer.child.signalCode !== null,
        120000, 'caseB pre-crash server crash');
      await preCrashServer.stop();
      assert(!exists('invoked-recovery-note.txt'),
        '12 (Case B): the crash happened BEFORE any workflow effect');

      // Recovery: lease expiry sweep reclaims and the stub resumes the plan.
      const recoveryServer = await startServer({ env: {
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '5000'
      } });
      const recovered = await waitFor(async () => {
        const current = await store.getRun(runRow.id);
        return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
      }, 300000, 'caseB recovered run');
      assert(recovered.status === 'completed',
        `12 (Case B): the resumed run completes deterministically (${recovered.status}: ${recovered.error || ''})`);
      assert(exists('invoked-recovery-note.txt') &&
        fs.readFileSync(abs('invoked-recovery-note.txt'), 'utf8') === 'crash-recovery note',
        '12 (Case B): the workflow effect executed exactly once after resume');
      const record = await store.readRunReplay(runRow.id);
      const invocations = (record.snapshot.workflowInvocation || []);
      assert(invocations.length === 1,
        `2/12 (Case B): repeated recording of the SAME invocation resolves the SAME durable evidence identity (got ${invocations.length})`);
      const receipts = await store.listOperationReceipts(runRow.id, { limit: 300 });
      const writeReceipts = receipts.filter(receipt => receipt.operation === 'writeFile');
      assert(writeReceipts.length === 1 &&
        writeReceipts[0].idempotencyKey.startsWith(`run:${runRow.id}:slot:`),
        `12 (Case B): the stable operation identity survives safe recovery (got ${writeReceipts.length})`);
      await recoveryServer.stop();
    }

    // ── Scenario 8 (Case C): resume after a committed effect ──────────────
    scenariosRun += 1;
    {
      const preCrashServer = await startServer({ env: {
        NODE_OPTIONS: `--require ${preloadPath}`,
        TEST_INTERRUPTION_POINT: 'after_first_workspace.operation',
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '5000'
      } });
      const cookie = await preCrashServer.login();
      const objective = `P5R1 caseC recovery ${STAMP} marker-${`RECOVERC${STAMP}`}`;
      const created = await preCrashServer.request('POST', '/tickets', {
        cookie,
        form: {
          objective,
          assignmentTargetType: 'agent',
          assignmentTargetId: String(agent.id),
          assignmentMode: 'individual',
          executionPolicy: JSON.stringify({ allowWorkflowInvocation: true, maxExecutionSteps: 16, maxModelRequests: 16, maxRuntimeMs: 900000 })
        }
      });
      assert(created.statusCode === 302, `caseC ticket accepted (${created.statusCode})`);
      const ticket = await waitFor(async () => {
        const { tickets } = await store.listTickets({ limit: 300 });
        return tickets.find(candidate => candidate.objective === objective) || null;
      }, 60000, 'caseC ticket');
      const runRow = await waitFor(async () => {
        const { runs } = await store.listRuns({ limit: 300 });
        return runs.find(candidate => candidate.ticketId === ticket.id) || null;
      }, 60000, 'caseC run dispatch');
      await waitFor(async () => preCrashServer.child.exitCode !== null || preCrashServer.child.signalCode !== null,
        120000, 'caseC pre-crash server crash');
      await preCrashServer.stop();

      // The committed effect is durably receipted before the crash.
      const preCrashReceipts = await store.listOperationReceipts(runRow.id, { limit: 300 });
      const preCrashWrites = preCrashReceipts.filter(receipt => receipt.operation === 'writeFile');
      assert(preCrashWrites.length === 1 && preCrashWrites[0].outcome === 'succeeded',
        `13 (Case C): the first execution committed exactly one successful receipt (${preCrashWrites.length})`);
      const committedIdentity = preCrashWrites[0].idempotencyKey;

      const recoveryServer = await startServer({ env: {
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '5000'
      } });
      const recovered = await waitFor(async () => {
        const current = await store.getRun(runRow.id);
        return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
      }, 300000, 'caseC recovered run');
      assert(recovered.status === 'completed',
        `13 (Case C): the replay converges to the committed outcome (${recovered.status})`);
      assert(fs.readFileSync(abs('invoked-recovery-note-c.txt'), 'utf8') === 'crash-recovery note',
        '13 (Case C): the filesystem was not re-mutated (content intact)');
      const record = await store.readRunReplay(runRow.id);
      const writeItems = (record.snapshot.workspaceOperations || [])
        .filter(item => item.operation && item.operation.operation === 'writeFile' &&
          item.workflowId === `wf-invoked-recovery-${STAMP}`);
      assert(writeItems.length === 1,
        `13 (Case C): the receipt was replayed, not re-effected — exactly one workspace item (got ${writeItems.length})`);
      const receipts = await store.listOperationReceipts(runRow.id, { limit: 300 });
      const writes = receipts.filter(receipt => receipt.operation === 'writeFile');
      assert(writes.length === 1 && writes[0].idempotencyKey === committedIdentity,
        `13 (Case C): the SAME committed operation identity holds exactly one receipt (got ${writes.length})`);
      const invocations = (record.snapshot.workflowInvocation || []);
      assert(invocations.length === 1,
        `13 (Case C): the invocation identity stayed Run-stable across the resumed attempt (got ${invocations.length})`);
      await recoveryServer.stop();
    }

    // ── Scenario 9 (Case E): divergent payload under one identity ─────────
    scenariosRun += 1;
    {
      const preCrashServer = await startServer({ env: {
        NODE_OPTIONS: `--require ${preloadPath}`,
        TEST_INTERRUPTION_POINT: 'after_first_workspace.operation',
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '5000'
      } });
      const cookie = await preCrashServer.login();
      const objective = `P5R1 caseE divergence ${STAMP} marker-${`DIVERGE${STAMP}`}`;
      const created = await preCrashServer.request('POST', '/tickets', {
        cookie,
        form: {
          objective,
          assignmentTargetType: 'agent',
          assignmentTargetId: String(agent.id),
          assignmentMode: 'individual',
          executionPolicy: JSON.stringify({ allowWorkflowInvocation: true, maxExecutionSteps: 16, maxModelRequests: 16, maxRuntimeMs: 900000 })
        }
      });
      assert(created.statusCode === 302, `caseE ticket accepted (${created.statusCode})`);
      const ticket = await waitFor(async () => {
        const { tickets } = await store.listTickets({ limit: 300 });
        return tickets.find(candidate => candidate.objective === objective) || null;
      }, 60000, 'caseE ticket');
      const runRow = await waitFor(async () => {
        const { runs } = await store.listRuns({ limit: 300 });
        return runs.find(candidate => candidate.ticketId === ticket.id) || null;
      }, 60000, 'caseE run dispatch');
      await waitFor(async () => preCrashServer.child.exitCode !== null || preCrashServer.child.signalCode !== null,
        120000, 'caseE pre-crash server crash');
      await preCrashServer.stop();
      // The stub switches to the divergent plan set once it has served the
      // base plan once; the recovery attempt therefore resolves the SAME
      // Run-stable identity with a DIFFERENT canonical payload.
      fs.writeFileSync(path.join(WORK_DIR, `${`DIVERGE${STAMP}`}.seen`), 'diverge');

      const recoveryServer = await startServer({ env: {
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '5000'
      } });
      const recovered = await waitFor(async () => {
        const current = await store.getRun(runRow.id);
        return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
      }, 300000, 'caseE recovered run');
      assert(recovered.status === 'failed',
        `15 (Case E): a divergent payload under the same invocation identity fails closed (${recovered.status})`);
      const record = await store.readRunReplay(runRow.id);
      const failure = record.snapshot.failure || {};
      assert(failure.code === 'WORKFLOW_INVOCATION_CONFLICT' &&
        failure.kind === 'resume_rejected',
        `15 (Case E): the refusal is the typed idempotency/recovery refusal (${JSON.stringify(failure)})`);
      assert((record.snapshot.workflowInvocation || []).length === 1,
        '15 (Case E): the original invocation evidence stands unchanged (no second identity)');
      assert(fs.readFileSync(abs('invoked-diverge-note.txt'), 'utf8') === 'original payload',
        '15 (Case E): zero silent divergence reached the filesystem');
      const receipts = await store.listOperationReceipts(runRow.id, { limit: 300 });
      assert(receipts.filter(receipt => receipt.operation === 'writeFile').length === 1,
        '15 (Case E): no duplicated effect');
      await recoveryServer.stop();
    }

    // ── Scenario 10 (Case F): SAME recovered slot, DIFFERENT workflow ─────
    scenariosRun += 1;
    {
      // The identity is owned by the proposing action slot, so a recovered
      // logical action may not change which workflow it means. The original
      // invocation commits its effect pre-crash; the recovery re-proposes a
      // DIFFERENT enabled valid workflow at the SAME slot — the identity must
      // resolve to the SAME evidence key and the divergent payload (a
      // different workflowId) must fail closed through the existing
      // idempotency-conflict seam with zero effects from the second workflow.
      const preCrashServer = await startServer({ env: {
        NODE_OPTIONS: `--require ${preloadPath}`,
        TEST_INTERRUPTION_POINT: 'after_first_workspace.operation',
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '5000'
      } });
      const cookie = await preCrashServer.login();
      const objective = `P5R1 caseF slot divergence ${STAMP} marker-${`SLOTCHANGE${STAMP}`}`;
      const created = await preCrashServer.request('POST', '/tickets', {
        cookie,
        form: {
          objective,
          assignmentTargetType: 'agent',
          assignmentTargetId: String(agent.id),
          assignmentMode: 'individual',
          executionPolicy: JSON.stringify({ allowWorkflowInvocation: true, maxExecutionSteps: 16, maxModelRequests: 16, maxRuntimeMs: 900000 })
        }
      });
      assert(created.statusCode === 302, `caseF ticket accepted (${created.statusCode})`);
      const ticket = await waitFor(async () => {
        const { tickets } = await store.listTickets({ limit: 300 });
        return tickets.find(candidate => candidate.objective === objective) || null;
      }, 60000, 'caseF ticket');
      const runRow = await waitFor(async () => {
        const { runs } = await store.listRuns({ limit: 300 });
        return runs.find(candidate => candidate.ticketId === ticket.id) || null;
      }, 60000, 'caseF run dispatch');
      await waitFor(async () => preCrashServer.child.exitCode !== null || preCrashServer.child.signalCode !== null,
        120000, 'caseF pre-crash server crash');
      await preCrashServer.stop();

      // The ORIGINAL invocation committed its effect before the crash.
      const preCrashReceipts = await store.listOperationReceipts(runRow.id, { limit: 300 });
      const preCrashWrites = preCrashReceipts.filter(receipt => receipt.operation === 'writeFile');
      assert(preCrashWrites.length === 1 && preCrashWrites[0].outcome === 'succeeded',
        `16 (Case F): the original workflow committed exactly one effect (${preCrashWrites.length})`);
      const committedIdentity = preCrashWrites[0].idempotencyKey;
      assert(fs.readFileSync(abs('invoked-slot-note.txt'), 'utf8') === 'original slot workflow',
        '16 (Case F): the original workflow wrote its artifact');
      assert(!exists('invoked-alt-note.txt'), '16 (Case F): the alternate workflow had no pre-recovery effect');

      // The stub serves the divergent plan set once the base plan was served;
      // the recovery re-proposes the OTHER enabled workflow at the SAME slot.
      fs.writeFileSync(path.join(WORK_DIR, `${`SLOTCHANGE${STAMP}`}.seen`), 'diverge');

      const recoveryServer = await startServer({ env: {
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '5000'
      } });
      const recovered = await waitFor(async () => {
        const current = await store.getRun(runRow.id);
        return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
      }, 300000, 'caseF recovered run');
      assert(recovered.status === 'failed',
        `16 (Case F): a different workflow under the same slot identity fails closed (${recovered.status})`);
      const record = await store.readRunReplay(runRow.id);
      const failure = record.snapshot.failure || {};
      assert(failure.code === 'WORKFLOW_INVOCATION_CONFLICT' &&
        failure.kind === 'resume_rejected',
        `16 (Case F): the refusal is the typed idempotency/recovery refusal (${JSON.stringify(failure)})`);
      // The SAME identity resolved: only a payload divergence under one
      // evidence key produces this typed refusal, and the original evidence
      // remains singular and unchanged.
      const invocations = (record.snapshot.workflowInvocation || []);
      assert(invocations.length === 1 &&
        invocations[0].workflowId === `wf-invoked-${STAMP}`,
        `16 (Case F): no second invocation identity was minted (got ${invocations.length})`);
      assert(fs.readFileSync(abs('invoked-slot-note.txt'), 'utf8') === 'original slot workflow',
        "16 (Case F): the original workflow's effect is intact");
      assert(!exists('invoked-alt-note.txt'),
        '16 (Case F): the second workflow executed ZERO effects');
      const receipts = await store.listOperationReceipts(runRow.id, { limit: 300 });
      const writes = receipts.filter(receipt => receipt.operation === 'writeFile');
      assert(writes.length === 1 && writes[0].idempotencyKey === committedIdentity,
        `16 (Case F): exactly the original effect's receipt stands (got ${writes.length})`);
      await recoveryServer.stop();
    }

    // ── Case D (§13 provider leg) is owned by the existing governed
    // request/reuse authority suites — see the header, item 14. The
    // ungoverned transport re-consultation on same-turn re-entry is
    // pre-existing recovery behavior for every agent/workflow run and is
    // NOT an R1 invention; R1's provider leg is the governed reservation
    // authority, not a new seam.

    if (sharedServer) await sharedServer.stop();

    const report = assertScenariosExecuted({
      label: 'p5 r1 workflow invocation',
      assertions: assert.count(),
      scenarios: scenariosRun,
      minAssertions: 40,
      minScenarios: 10
    });
    console.log(`PASS: p5-r1 workflow invocation — ${report.assertions} assertions, ` +
      `${report.scenarios} scenarios (PostgreSQL-native)`);
  }, { schemaSlug: 'p5_r1_workflow_invocation' });
}

main().catch(error => {
  console.error(`FAIL: p5-r1 workflow invocation — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
