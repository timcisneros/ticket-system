#!/usr/bin/env node
'use strict';
// Workflow ticket plans (`executeTicketPlan`) — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// The ticket-plan half of the `workflow-composition-test.js` split;
// `workflow-action-plan-test.js` owns the action-plan half. They are separate files
// because they are separate primitives with separate evidence collections
// (`workflowTicketPlans` vs `workflowActionPlans`), and the original conflated them
// behind one harness — which is part of why a 1,275-line monolith was the only thing
// guarding either.
//
// THE CONTRACT:
//   1. planned child tickets are created with the requested workflow, objective and
//      workflow input, and are fully attributable to the parent — ticket, run, step
//      and plan
//   2. children are spawned with a parent-scoped idempotency key, so a re-executed
//      plan step does not duplicate them
//   3. v1 does NOT auto-run children; they are created blocked and stay that way
//   4. a ticket naming a workflow outside `allowedWorkflowIds` is REJECTED with a
//      reason, creates nothing, and does not fail the parent workflow
//
// (3) is easy to lose and expensive to get wrong: auto-running spawned children would
// let one ticket fan out into unbounded execution with no operator decision in between.
// (2) is what makes a rerun safe.
//
// The parent suite exited 0 while asserting nothing, so this one counts scenarios and
// assertions and refuses a zero-assertion exit.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

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
  await withHarness('workflow ticket plan', async ({ store, startServer }) => {
    const agent = (await store.createConfiguredAgent({
      value: { name: `WorkflowTicketPlan-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key-ticket-plan' },
      groupIds: [], changedBy: 'workflow-ticket-plan-test'
    })).agent;

    const server = await startServer({ RUNTIME_SCHEDULER_INTERVAL_MS: '200', RUN_LEASE_DURATION_MS: '60000' });
    const cookie = await server.login();

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
      const objective = `ticket-plan ${label} ${STAMP}`;
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

    const childrenOf = async parentTicketId =>
      (await store.listChildTickets({ parentTicketId, limit: 50 })).tickets
        || (await store.listChildTickets({ parentTicketId, limit: 50 }));

    const childWorkflowId = await saveWorkflow({
      id: `wf-ticket-plan-child-${STAMP}`,
      name: 'Ticket plan child workflow',
      enabled: true,
      inputSchema: { basePath: 'string', vendorId: 'string' },
      actions: [{ id: 'done', action: 'stop', input: { result: { child: true, vendorId: '{{workflow.input.vendorId}}' } } }]
    });

    // ── 1. A valid plan creates fully attributable children ─────────────────
    const parentId = await saveWorkflow({
      id: `wf-ticket-plan-parent-${STAMP}`,
      name: 'Ticket plan parent workflow',
      inputSchema: {},
      actions: [
        {
          id: 'execute-ticket-plan', action: 'executeTicketPlan',
          input: {
            tickets: [
              { workflowId: childWorkflowId, objective: `Child A ${STAMP}`, workflowInput: { basePath: 'vendors', vendorId: 'vendor-002' }, reason: 'expired certification' },
              { workflowId: childWorkflowId, objective: `Child B ${STAMP}`, workflowInput: { basePath: 'vendors', vendorId: 'vendor-003' }, reason: 'active incident' }
            ],
            allowedWorkflowIds: [childWorkflowId],
            maxTickets: 5
          },
          next: 'done'
        },
        { id: 'done', action: 'stop', input: { result: { completed: true } } }
      ]
    });

    const parent = await runWorkflow('valid', parentId);
    assert(parent.run.status === 'completed',
      `1: a valid ticket plan completes the parent workflow (${parent.run.status}: ${parent.run.error || ''})`);

    const children = await childrenOf(parent.ticket.id);
    assert(children.length === 2, `1: both planned child tickets were created (got ${children.length})`);
    assert(children.every(child => child.workflowId === childWorkflowId),
      '1: children use the requested child workflow');
    assert(children.every(child => child.parentTicketId === parent.ticket.id),
      '1: children record their parent ticket');
    assert(children.every(child => child.parentRunId === parent.run.id),
      '1: children record the run that spawned them');
    assert(children.every(child => child.spawnedByStepId === 'execute-ticket-plan'),
      '1: children record the plan step that spawned them');
    assert(children.every(child => child.parentWorkflowId === parentId),
      '1: children record the parent workflow');
    assert(children.every(child => typeof child.spawnPlanId === 'string'
      && child.spawnPlanId.includes(`${parent.run.id}:${parentId}:execute-ticket-plan`)),
      '1: children record the plan instance that spawned them');
    const vendorIds = children.map(child => (child.workflowInput || {}).vendorId).sort();
    assert(vendorIds.join(',') === 'vendor-002,vendor-003',
      `1: each child preserved its own workflow input (got ${vendorIds.join(',')})`);

    // Parent-scoped idempotency is what makes a rerun safe.
    assert(children.every(child => typeof child.spawnIdempotencyKey === 'string'
      && child.spawnIdempotencyKey.startsWith(`${parent.ticket.id}:${childWorkflowId}:`)),
      '1: children carry a parent-scoped spawn idempotency key');
    assert(new Set(children.map(child => child.spawnIdempotencyKey)).size === 2,
      '1: the two children have distinct idempotency keys');

    const planEvidence = (parent.replay.workflowTicketPlans || [])
      .find(item => item.stepId === 'execute-ticket-plan');
    assert(Boolean(planEvidence), '1: the run records workflowTicketPlans evidence');
    assert(planEvidence.proposedTickets.length === 2, '1: both tickets are recorded as proposed');
    assert(planEvidence.acceptedTickets.length === 2, '1: both tickets are recorded as accepted');
    assert(Array.isArray(planEvidence.createdTicketIds) && planEvidence.createdTicketIds.length === 2,
      '1: the created ticket ids are recorded');
    assert(planEvidence.createdTicketIds.every(id => children.some(child => child.id === id)),
      '1: the recorded ids are the tickets that actually exist');

    // ── 2. v1 does not auto-run children ────────────────────────────────────
    // Without this, one ticket could fan out into unbounded execution with no
    // operator decision in between.
    for (const child of children) {
      const childRuns = (await store.listRunsForTicket({ ticketId: child.id, limit: 10 })).runs;
      assert(childRuns.length === 0,
        `2: child ticket ${child.id} was created without a run (got ${childRuns.length})`);
    }
    assert(children.every(child => child.status === 'blocked'),
      `2: children are created blocked (got ${children.map(c => c.status).join(',')})`);

    // ── 3. A workflow outside allowedWorkflowIds is rejected, not fatal ─────
    const invalidId = await saveWorkflow({
      id: `wf-ticket-plan-invalid-${STAMP}`,
      name: 'Invalid ticket plan workflow',
      inputSchema: {},
      actions: [
        {
          id: 'execute-ticket-plan', action: 'executeTicketPlan',
          input: {
            tickets: [{ workflowId: 'missing-child-workflow', objective: `Invalid child ${STAMP}`, workflowInput: { vendorId: 'vendor-999' }, reason: 'invalid workflow' }],
            allowedWorkflowIds: [childWorkflowId],
            maxTickets: 5
          },
          next: 'done'
        },
        { id: 'done', action: 'stop', input: { result: { completed: true } } }
      ]
    });

    const invalid = await runWorkflow('invalid-workflow', invalidId);
    assert(invalid.run.status === 'completed',
      `3: a rejected ticket plan does NOT fail the parent workflow (${invalid.run.status}: ${invalid.run.error || ''})`);
    const invalidChildren = await childrenOf(invalid.ticket.id);
    assert(invalidChildren.length === 0,
      `3: a rejected ticket plan creates no child tickets (got ${invalidChildren.length})`);

    const invalidEvidence = (invalid.replay.workflowTicketPlans || [])
      .find(item => item.stepId === 'execute-ticket-plan');
    assert(Boolean(invalidEvidence), '3: the rejected plan still records evidence');
    assert(invalidEvidence.proposedTickets.length === 1,
      '3: the proposal is recorded even though it was refused');
    assert(invalidEvidence.acceptedTickets.length === 0, '3: nothing was accepted');
    assert((invalidEvidence.rejectedTickets || []).length === 1, '3: the refusal is recorded as a rejection');
    assert((invalidEvidence.createdTicketIds || []).length === 0,
      '3: no created ticket id is claimed for work that never happened');

    assertScenariosExecuted({
      label: 'workflow ticket plan',
      assertions: assert.count(),
      scenarios: scenariosRun,
      minAssertions: 22,
      minScenarios: 2
    });
    console.log(`\nPASS: workflow ticket plans — ${scenariosRun} scenarios, ${assert.count()} assertions (PostgreSQL-native)`);
  }, { schemaSlug: 'workflow_ticket_plan' });
}

main().catch(error => {
  console.error(`\nFAIL: workflow ticket plans — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
