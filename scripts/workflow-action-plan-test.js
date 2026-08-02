#!/usr/bin/env node
'use strict';
// Workflow action plans (`executeActionPlan`) — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// Extracted from `workflow-composition-test.js`, which A20 recorded as the most
// valuable orphan remaining: `executeActionPlan`, `executeTicketPlan`,
// `workflowActionPlans` and `workflowTicketPlans` appear in NO registered suite, so
// workflow composition — the runtime path that executes planned workspace actions and
// spawns child tickets — has been unguarded since the PostgreSQL cutover.
//
// That monolith is one 1,275-line sequence with ~340 inline assertions and no discrete
// scenarios, so it could not be split by lifting scenario functions the way
// `operational-abuse-test.js` was. Its contracts were read out of the assertions and
// re-expressed here; this file owns the ACTION-plan half.
// `workflow-ticket-plan-test.js` owns the ticket-plan half, and keeping them apart is
// deliberate: the two plans are separate primitives with separate evidence
// collections, and the original conflated them behind one harness.
//
// THE CONTRACT:
//   1. accepted actions execute for real, in order, and the workspace shows it
//   2. the evidence quartet — proposed / accepted / rejected / executed — is recorded
//      and internally consistent
//   3. an action outside `allowedOperations` is REJECTED with a reason, executes
//      nothing, and does NOT fail the workflow
//   4. an over-cap plan rejects EVERY proposed action rather than a prefix
//   5. rejected work never appears as workspace execution
//
// (3) and (4) are the load-bearing half. A runtime that simply failed the workflow on
// any invalid plan would satisfy "nothing executed" while destroying the contract that
// bounded rejection is deterministic and survivable.
//
// The parent suite exited 0 while asserting nothing, so this one counts scenarios and
// assertions and refuses a zero-assertion exit.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const fs = require('fs');
const path = require('path');
const { withHarness, createAsserter, sleep } = require('./postgres-test-harness');
const { assertScenariosExecuted } = require('./child-process-settlement');

const STAMP = Date.now();
const assert = createAsserter();
let scenariosRun = 0;

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  await withHarness('workflow action plan', async ({ store, workspaceRoot, startServer }) => {
    const agent = (await store.createConfiguredAgent({
      value: { name: `WorkflowActionPlan-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key-action-plan' },
      groupIds: [], changedBy: 'workflow-action-plan-test'
    })).agent;

    // Workflow actions are executed by the runtime itself, not proposed by a model, so
    // no provider stub is needed: the plan is data in the workflow definition.
    const server = await startServer({ env: { RUNTIME_SCHEDULER_INTERVAL_MS: '200', RUN_LEASE_DURATION_MS: '60000' } });
    const cookie = await server.login();

    const abs = rel => path.join(workspaceRoot, rel);
    const exists = rel => fs.existsSync(abs(rel));

    async function saveWorkflow(definition) {
      const response = await server.request('POST', '/admin/workflows', {
        cookie, form: { definition: JSON.stringify(definition, null, 2) }
      });
      assert(response.statusCode === 302 || response.statusCode === 200,
        `workflow ${definition.id} saved (HTTP ${response.statusCode})`);
      return definition.id;
    }

    async function runWorkflow(label, workflowId) {
      scenariosRun += 1;
      const objective = `action-plan ${label} ${STAMP}`;
      const created = await server.request('POST', '/tickets', {
        cookie,
        form: {
          objective, capabilityType: 'workflow', workflowId, workflowInput: '{}',
          assignmentTargetType: 'agent', assignmentTargetId: String(agent.id), assignmentMode: 'individual'
        }
      });
      assert(created.statusCode === 302, `${label}: workflow ticket created (HTTP ${created.statusCode})`);
      const ticket = await waitFor(async () => {
        const { tickets } = await store.listTickets({ limit: 300 });
        return tickets.find(t => t.objective === objective) || null;
      }, 30000, `${label} ticket`);
      const run = await waitFor(async () => {
        const { runs } = await store.listRunsForTicket({ ticketId: ticket.id, limit: 10 });
        return runs[0] || null;
      }, 30000, `${label} run dispatch`);
      const terminal = await waitFor(async () => {
        const current = await store.getRun(run.id);
        return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
      }, 120000, `${label} terminal run`);
      const replay = await waitFor(async () => {
        const record = await store.readRunReplay(terminal.id);
        return record && record.snapshot ? record.snapshot : null;
      }, 30000, `${label} replay snapshot`);
      return { ticket, run: terminal, replay };
    }

    const planEvidence = (replay, stepId) =>
      (replay.workflowActionPlans || []).find(item => item.stepId === stepId) || null;

    // ── 1. A valid plan executes for real ───────────────────────────────────
    fs.mkdirSync(abs('workflow-output'), { recursive: true });
    fs.writeFileSync(abs('workflow-output/plan-source.txt'), 'plan move');

    const validId = await saveWorkflow({
      id: `wf-action-plan-valid-${STAMP}`,
      name: 'Valid action plan workflow',
      inputSchema: {},
      actions: [
        {
          id: 'execute-plan', action: 'executeActionPlan',
          input: {
            actions: [
              { operation: 'createFolder', args: { path: 'workflow-output/plan-dest' }, reason: 'prepare destination' },
              { operation: 'renamePath', args: { path: 'workflow-output/plan-source.txt', nextPath: 'workflow-output/plan-dest/plan-source.txt' }, reason: 'move selected file' }
            ],
            allowedOperations: ['createFolder', 'renamePath'],
            maxActions: 8, maxMutations: 6
          },
          next: 'done'
        },
        { id: 'done', action: 'stop', input: { result: { completed: true } } }
      ]
    });

    const valid = await runWorkflow('valid', validId);
    assert(valid.run.status === 'completed',
      `1: a valid action plan completes the workflow (${valid.run.status}: ${valid.run.error || ''})`);

    // The workspace is the strongest evidence: the plan really ran, in order.
    assert(!exists('workflow-output/plan-source.txt'), '1: the planned rename consumed the source');
    assert(fs.readFileSync(abs('workflow-output/plan-dest/plan-source.txt'), 'utf8') === 'plan move',
      '1: the moved file kept its content, so createFolder ran before renamePath');

    const validEvidence = planEvidence(valid.replay, 'execute-plan');
    assert(Boolean(validEvidence), '1: the run records workflowActionPlans evidence for the step');
    assert(validEvidence.proposedActions.length === 2, '1: both actions are recorded as proposed');
    assert(validEvidence.acceptedActions.length === 2, '1: both actions are recorded as accepted');
    assert(validEvidence.rejectedActions.length === 0, '1: a valid plan rejects nothing');
    assert(validEvidence.executedActions.length === 2, '1: both accepted actions are recorded as executed');

    const validAction = (valid.replay.workflowActions || [])
      .find(item => item.stepId === 'execute-plan' && item.action === 'executeActionPlan');
    assert(Boolean(validAction) && validAction.result.status === 'executed',
      '1: the workflow action reports executed status');

    // Attributable durable evidence: the mutations carry operation receipts.
    const validOps = await store.listRunOperations(valid.run.id, { limit: 200 });
    const validReceipts = (validOps.operations || validOps)
      .filter(op => !op.error && op.outcome !== 'failed' && op.outcome !== 'refused');
    assert(validReceipts.length === 2,
      `1: each executed action left a durable operation receipt (got ${validReceipts.length})`);

    // ── 2. An action outside allowedOperations is rejected, not fatal ───────
    fs.writeFileSync(abs('workflow-output/reject-delete.txt'), 'keep me');
    const invalidId = await saveWorkflow({
      id: `wf-action-plan-invalid-${STAMP}`,
      name: 'Invalid action plan workflow',
      inputSchema: {},
      actions: [
        {
          id: 'execute-plan', action: 'executeActionPlan',
          input: {
            actions: [{ operation: 'deletePath', args: { path: 'workflow-output/reject-delete.txt' }, reason: 'not allowed' }],
            allowedOperations: ['createFolder', 'renamePath'],
            maxActions: 8, maxMutations: 6
          },
          next: 'done'
        },
        { id: 'done', action: 'stop', input: { result: { completed: true } } }
      ]
    });

    const invalid = await runWorkflow('invalid-operation', invalidId);
    assert(invalid.run.status === 'completed',
      `2: a rejected action does NOT fail the workflow (${invalid.run.status}: ${invalid.run.error || ''})`);
    assert(exists('workflow-output/reject-delete.txt'),
      '2: the rejected deletePath never executed');

    const invalidEvidence = planEvidence(invalid.replay, 'execute-plan');
    assert(Boolean(invalidEvidence), '2: the rejected plan still records evidence');
    assert(invalidEvidence.proposedActions.length === 1, '2: the proposal is recorded even though it was refused');
    assert(invalidEvidence.acceptedActions.length === 0, '2: nothing was accepted');
    assert(invalidEvidence.rejectedActions.length === 1, '2: the refusal is recorded as a rejection');
    assert(invalidEvidence.executedActions.length === 0, '2: nothing was executed');
    assert((invalidEvidence.rejectedActions[0].validationReasons || [])
      .some(reason => /allowedOperations/i.test(String(reason))),
      '2: the rejection explains that the operation is outside allowedOperations');
    assert(!(invalid.replay.workspaceOperations || [])
      .some(item => item.operation && item.operation.operation === 'deletePath'),
      '2: a rejected operation never appears as workspace execution');

    // ── 3. An over-cap plan rejects EVERY action, not a prefix ──────────────
    // Partial acceptance would be the dangerous outcome: the run would claim a bounded
    // plan while having performed an unbounded fraction of it.
    fs.writeFileSync(abs('workflow-output/over-cap-a.txt'), 'a');
    const overCapId = await saveWorkflow({
      id: `wf-action-plan-overcap-${STAMP}`,
      name: 'Over-max action plan workflow',
      inputSchema: {},
      actions: [
        {
          id: 'execute-plan', action: 'executeActionPlan',
          input: {
            actions: [
              { operation: 'createFolder', args: { path: `workflow-output/over-cap-1-${STAMP}` }, reason: 'first' },
              { operation: 'createFolder', args: { path: `workflow-output/over-cap-2-${STAMP}` }, reason: 'second' }
            ],
            allowedOperations: ['createFolder'],
            maxActions: 1, maxMutations: 6
          },
          next: 'done'
        },
        { id: 'done', action: 'stop', input: { result: { completed: true } } }
      ]
    });

    const overCap = await runWorkflow('over-cap', overCapId);
    assert(overCap.run.status === 'completed',
      `3: an over-cap plan is rejected deterministically without failing the workflow (${overCap.run.status})`);
    const overCapEvidence = planEvidence(overCap.replay, 'execute-plan');
    assert(Boolean(overCapEvidence), '3: the over-cap plan records evidence');
    assert(overCapEvidence.acceptedActions.length === 0, '3: an over-cap plan accepts nothing');
    assert(overCapEvidence.executedActions.length === 0, '3: an over-cap plan executes nothing');
    assert(overCapEvidence.rejectedActions.length === 2,
      `3: EVERY proposed action is rejected, not a prefix (got ${overCapEvidence.rejectedActions.length} of 2)`);
    assert(!exists(`workflow-output/over-cap-1-${STAMP}`) && !exists(`workflow-output/over-cap-2-${STAMP}`),
      '3: no partial effect reached the workspace');

    assertScenariosExecuted({
      label: 'workflow action plan',
      assertions: assert.count(),
      scenarios: scenariosRun,
      minAssertions: 24,
      minScenarios: 3
    });
    console.log(`\nPASS: workflow action plans — ${scenariosRun} scenarios, ${assert.count()} assertions (PostgreSQL-native)`);
  }, { schemaSlug: 'workflow_action_plan' });
}

main().catch(error => {
  console.error(`\nFAIL: workflow action plans — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
