#!/usr/bin/env node
'use strict';

// P5-R2 — Governed delegated child execution — PostgreSQL-native owner.
//
// Authority: docs/ARCHITECTURAL_DECISIONS_PENDING.md, P5 semantic design
// freeze — §5 (non-amplification), §7 (DELEGATED-HOLD-A), §8 (CHILD-RERUN-A /
// UNITKEY-A), §9 (delegated creation evidence), §10 (eight-leg
// delegated-release authority), §11 (composer invariant), §12 (immutable
// admitted-policy doctrine), §16 (workspace/default target only), §17
// (one-level delegation), §19 (evidence), §21 (no migration).
//
// THE CONTRACT (each scenario owns one frozen assertion set):
//
//   A. Creation is UNCHANGED plus the delegation block: a delegated unit
//      creates exactly one child with complete T4 provenance, a Run-scoped
//      spawnPlanId, the Ticket-stable logical spawn key, ZERO attempts and an
//      ACTIVE admission hold. The composer is untouched: the delegation block
//      never suppresses the hold.
//   B. With the acting Run's admitted snapshot at strict-default
//      `allowChildTickets: false`, the delegated release refuses (typed,
//      recorded in plan evidence), mutates nothing, and the child remains
//      held with no Run.
//   C. With `allowChildTickets: true` frozen in the admitted parent Run
//      snapshot, `delegated_release` admits atomically: exactly one child
//      attempt + one child Run, the hold superseded BY the admission (the
//      transition event carries the intent + the superseded hold reference),
//      the child Run executes the child workflow to completion as an
//      ordinary Run.
//   D. Non-amplification: the admitted child Run carries
//      allowChildTickets: false (its own canonical default, NOT the parent's
//      true), no browser target authority, and no process authority —
//      workspace/default only.
//   E. Parent rerun (CHILD-RERUN-A): the same logical unit ADOPTS the
//      existing child (no duplicate child, no multiplication), the child
//      keeps the ORIGINAL Run-scoped spawnPlanId while the new plan evidence
//      carries the NEW run-scoped reference, and the already-attempted child
//      is never automatically re-admitted (typed skip, attempt count
//      unchanged).
//   F. Non-delegated items keep the existing derivation and semantics
//      byte-for-byte: the existing vendor key format, no delegation block, no
//      release request, and the existing rejected-duplicate outcome on a
//      rerun.
//   G. One-level delegation: a delegated unit whose child workflow itself
//      contains executeTicketPlan is refused by the existing recursive
//      prohibition; no child is created; nothing is released.
//   H. Existing bounds still hold for delegated units (leg 6): a disabled
//      child workflow refuses the plan item at plan time; no child is
//      created.
//   I. Model-minted delegation has zero authority (UNITKEY-A): a
//      whole-array template whose dynamic items claim delegated:true +
//      unitKey without a literal definition item behind them is rejected per
//      item; no delegated child is created.
//   J. Definition discipline at the catalog seam: a delegated item without a
//      literal unitKey, a template-authored unitKey, duplicate unitKeys, and
//      a unitKey on a non-delegated item are all refused at workflow save.
//   M. Operator release_hold remains intact for a delegated child, and any
//      later delegated-release intent for that child is stale and refuses
//      typed.
//   K. Seam-level doctrine (§12): a parent Run admitted while its snapshot
//      carried allowChildTickets:true KEEPS that authority after the live
//      Ticket policy is edited to false (the frozen snapshot controls), while
//      a parent Run admitted with a false snapshot cannot release and the
//      refusal leaves the child held with zero mutation.
//   L. Seam-level leg 4: a virgin delegated child whose child workflow was
//      disabled refuses with WORKFLOW_DISABLED and stays held, zero
//      mutation.
//   N. Two competing delegated releases of the same virgin child serialize on
//      the Ticket row: exactly one wins, the loser refuses typed against the
//      resulting durable state, and exactly one (unsettled) attempt exists —
//      max-one-unsettled-attempt is structural.
//   O. No migration authority is touched: this suite adds no migration and
//      asserts nothing about the database schema beyond disposable test
//      state. (The seam scenarios run after the server is stopped, so the
//      synthetic pending Runs admitted by them are never dispatched.)
//
// P5-R2 CURRENT-ACTION CORRECTION (fresh post-R2 canonical-authority review).
// The release may no longer trust caller knowledge of a valid spawn key or
// caller-asserted "validated before reachable" facts:
//   P. Current-action authority: a successful delegated release requires a
//      DURABLE, immutable `workflow.delegated_plan_authorized` evidence item
//      on the ACTING parent Run's OWN append-only event chain — recorded by
//      the executing action only after canonical plan validation and BEFORE
//      any child effect — whose identity coherently binds the child's exact
//      durable unit (logical spawn key, unitKey, child workflow, step,
//      workflow) and whose validated plan bounds allow the child workflow.
//      Fail-closed attacks: a never-acting run with no authorization (1a/1b),
//      a never-dispatched pending run (1b), a terminal
//      failed/completed/interrupted run with valid evidence (2), an
//      authorization for another step (3), a unit the action never validated
//      (4), a forged durable unit entry diverging from the canonical
//      re-derivation (4b), a stale completed/failed action boundary (5,
//      including the persisted step boundary), and a revoked parent workflow
//      authority between authorization and release (6). The ordinary
//      authorized current-action release keeps working (K, N, and the
//      attack-6 recovery leg).
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  withHarness, createAsserter, sleep
} = require('./postgres-test-harness');
const { assertScenariosExecuted } = require('./child-process-settlement');
const sourceAssert = require('node:assert/strict');
const {
  DELEGATION_SCHEME,
  DELEGATED_PLAN_AUTHORIZATION_EVENT_TYPE,
  DELEGATED_PLAN_AUTHORIZATION_REPLAY_KEY,
  buildDelegatedPlanAuthorizationEvidence
} = require('../runtime/t4-spawn-relation-contract');

const STAMP = Date.now();
const assert = createAsserter();
let scenariosRun = 0;

const WORK_DIR = path.join(os.tmpdir(), `p5-r2-delegated-${process.pid}-${STAMP}`);
fs.mkdirSync(WORK_DIR, { recursive: true });

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
  await withHarness('p5 r2 delegated admission', async ({ store, startServer }) => {
    const agent = (await store.createConfiguredAgent({
      value: { name: `P5R2Delegate-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key-delegate' },
      groupIds: [], changedBy: 'p5-r2-delegated-admission-test'
    })).agent;

    const childWorkflowId = `wf-delegate-child-${STAMP}`;
    const childWorkflow = {
      id: childWorkflowId,
      name: 'Delegated child workflow',
      enabled: true,
      inputSchema: { vendorId: 'string' },
      actions: [{ id: 'done', action: 'stop', input: { result: { unitDone: '{{workflow.input.vendorId}}' } } }]
    };

    const recursiveChildWorkflowId = `wf-delegate-recursive-${STAMP}`;
    const recursiveChildWorkflow = {
      id: recursiveChildWorkflowId,
      name: 'Recursive child workflow (invalid for children)',
      enabled: true,
      inputSchema: {},
      actions: [
        { id: 'spawn', action: 'executeTicketPlan', input: { tickets: [], allowedWorkflowIds: [], maxTickets: 0 } },
        { id: 'done', action: 'stop', input: { result: { nested: true } } }
      ]
    };

    const disabledChildWorkflowId = `wf-delegate-disabled-${STAMP}`;
    const disabledChildWorkflow = {
      id: disabledChildWorkflowId,
      name: 'Disabled delegated child workflow',
      enabled: false,
      inputSchema: { vendorId: 'string' },
      actions: [{ id: 'done', action: 'stop', input: { result: {} } }]
    };

    // Parent workflow with ONE delegated unit; the ticket policy decides
    // whether the delegated release is authorized.
    const parentDefaultId = `wf-delegate-parent-default-${STAMP}`;
    const parentDefault = {
      id: parentDefaultId,
      name: 'Delegated parent (default policy scenario)',
      enabled: true,
      inputSchema: {},
      actions: [
        {
          id: 'spawn-unit', action: 'executeTicketPlan',
          input: {
            tickets: [
              {
                delegated: true,
                unitKey: 'alpha',
                workflowId: childWorkflowId,
                objective: `Delegated alpha ${STAMP}`,
                workflowInput: { vendorId: 'vendor-alpha' },
                reason: 'delegated unit alpha'
              }
            ],
            allowedWorkflowIds: [childWorkflowId],
            maxTickets: 5
          },
          next: 'done'
        },
        { id: 'done', action: 'stop', input: { result: { plan: true } } }
      ]
    };

    // Parent workflow with one DELEGATED unit and one NON-delegated unit.
    const parentAuthId = `wf-delegate-parent-auth-${STAMP}`;
    const parentAuth = {
      id: parentAuthId,
      name: 'Delegated parent (authorized scenario)',
      enabled: true,
      inputSchema: {},
      actions: [
        {
          id: 'spawn-units', action: 'executeTicketPlan',
          input: {
            tickets: [
              {
                delegated: true,
                unitKey: 'alpha',
                workflowId: childWorkflowId,
                objective: `Authorized alpha ${STAMP}`,
                workflowInput: { vendorId: 'vendor-alpha' },
                reason: 'delegated unit alpha'
              },
              {
                workflowId: childWorkflowId,
                objective: `Plain child ${STAMP}`,
                workflowInput: { vendorId: 'vendor-plain' },
                reason: 'ordinary non-delegated child'
              }
            ],
            allowedWorkflowIds: [childWorkflowId],
            maxTickets: 5
          },
          next: 'done'
        },
        { id: 'done', action: 'stop', input: { result: { plan: true } } }
      ]
    };

    const parentRecursiveId = `wf-delegate-parent-recursive-${STAMP}`;
    const parentRecursive = {
      id: parentRecursiveId,
      name: 'Delegated parent (recursive child scenario)',
      enabled: true,
      inputSchema: {},
      actions: [
        {
          id: 'spawn-unit', action: 'executeTicketPlan',
          input: {
            tickets: [
              {
                delegated: true,
                unitKey: 'alpha',
                workflowId: recursiveChildWorkflowId,
                objective: `Recursive child ${STAMP}`,
                workflowInput: {},
                reason: 'delegated unit to a recursive workflow'
              }
            ],
            allowedWorkflowIds: [recursiveChildWorkflowId],
            maxTickets: 5
          },
          next: 'done'
        },
        { id: 'done', action: 'stop', input: { result: { plan: true } } }
      ]
    };

    const parentDisabledId = `wf-delegate-parent-disabled-${STAMP}`;
    const parentDisabled = {
      id: parentDisabledId,
      name: 'Delegated parent (disabled child workflow scenario)',
      enabled: true,
      inputSchema: {},
      actions: [
        {
          id: 'spawn-unit', action: 'executeTicketPlan',
          input: {
            tickets: [
              {
                delegated: true,
                unitKey: 'alpha',
                workflowId: disabledChildWorkflowId,
                objective: `Disabled workflow child ${STAMP}`,
                workflowInput: { vendorId: 'vendor-x' },
                reason: 'delegated unit to a disabled workflow'
              }
            ],
            allowedWorkflowIds: [disabledChildWorkflowId],
            maxTickets: 5
          },
          next: 'done'
        },
        { id: 'done', action: 'stop', input: { result: { plan: true } } }
      ]
    };

    // Whole-array template: the dynamic items claim delegation that no raw
    // definition item authorizes.
    const parentTemplateId = `wf-delegate-parent-template-${STAMP}`;
    const parentTemplate = {
      id: parentTemplateId,
      name: 'Delegated parent (whole-array template scenario)',
      enabled: true,
      inputSchema: {},
      actions: [
        {
          id: 'spawn-units', action: 'executeTicketPlan',
          input: {
            tickets: '{{workflow.input.plan}}',
            allowedWorkflowIds: [childWorkflowId],
            maxTickets: 5
          },
          next: 'done'
        },
        { id: 'done', action: 'stop', input: { result: { plan: true } } }
      ]
    };

    const server = await startServer({ env: {
      RUNTIME_SCHEDULER_INTERVAL_MS: '200',
      RUN_LEASE_DURATION_MS: '60000'
    } });
    const cookie = await server.login();

    for (const definition of [childWorkflow, recursiveChildWorkflow, disabledChildWorkflow,
      parentDefault, parentAuth, parentRecursive, parentDisabled, parentTemplate]) {
      const response = await server.request('POST', '/admin/workflows', {
        cookie, form: { definition: JSON.stringify(definition, null, 2) }
      });
      assert(response.statusCode === 302 || response.statusCode === 200,
        `workflow ${definition.id} saved (HTTP ${response.statusCode})`);
    }

    async function runWorkflow(label, workflowId, { executionPolicy, workflowInput } = {}) {
      scenariosRun += 1;
      const objective = `p5r2 ${label} ${STAMP}`;
      const created = await server.request('POST', '/tickets', {
        cookie,
        form: {
          objective, capabilityType: 'workflow', workflowId,
          workflowInput: workflowInput ? JSON.stringify(workflowInput) : '{}',
          assignmentTargetType: 'agent', assignmentTargetId: String(agent.id),
          assignmentMode: 'individual',
          ...(executionPolicy ? { executionPolicy: JSON.stringify(executionPolicy) } : {})
        }
      });
      assert(created.statusCode === 302, `${label}: workflow ticket created (HTTP ${created.statusCode})`);
      const ticket = await waitFor(async () => {
        const { tickets } = await store.listTickets({ limit: 400 });
        return tickets.find(t => t.objective === objective) || null;
      }, 30000, `${label} ticket`);
      const run = await waitFor(async () => {
        const { runs } = await store.listRunsForTicket({ ticketId: ticket.id, limit: 10 });
        return runs[0] || null;
      }, 30000, `${label} run dispatch`);
      const terminal = await waitFor(async () => {
        const current = await store.getRun(run.id);
        return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
      }, 180000, `${label} terminal run`);
      const replay = await waitFor(async () => {
        const record = await store.readRunReplay(terminal.id);
        return record && record.snapshot ? record.snapshot : null;
      }, 30000, `${label} replay snapshot`);
      return { ticket, run: terminal, replay };
    }

    const childrenOf = async parentTicketId =>
      (await store.listChildTickets({ parentTicketId, limit: 50 })).tickets || [];

    const eventsOf = async ticketId =>
      (await store.listTicketEvents(ticketId, { limit: 200 })).events || [];

    // ── A + B. Delegated creation with the default-false policy: child is
    //    created held, the release refuses typed, zero mutation. ────────────
    scenariosRun += 1;
    const defaultOutcome = await runWorkflow('default-policy', parentDefaultId);
    assert(defaultOutcome.run.status === 'completed',
      `A: the default-policy parent completes (plan evidence recorded) (${defaultOutcome.run.status})`);
    const defaultChildren = await childrenOf(defaultOutcome.ticket.id);
    assert(defaultChildren.length === 1,
      `A: exactly one delegated child was created (got ${defaultChildren.length})`);
    const heldChild = defaultChildren[0];
    assert(heldChild.status === 'blocked',
      `A: the delegated child is created blocked (got ${heldChild.status})`);
    assert(heldChild.parentTicketId === defaultOutcome.ticket.id &&
      heldChild.parentRunId === defaultOutcome.run.id &&
      heldChild.parentWorkflowId === parentDefaultId &&
      heldChild.spawnedByStepId === 'spawn-unit',
      'A: the child carries the complete parent/workflow/step provenance');
    const expectedSpawnKey = `ticket:${defaultOutcome.ticket.id}:${parentDefaultId}:spawn-unit:${childWorkflowId}:alpha`;
    assert(heldChild.spawnIdempotencyKey === expectedSpawnKey,
      `A: the delegated logical spawn identity is the canonical Ticket-stable key (got ${heldChild.spawnIdempotencyKey})`);
    assert(typeof heldChild.spawnPlanId === 'string' &&
      heldChild.spawnPlanId === `${defaultOutcome.run.id}:${parentDefaultId}:spawn-unit:transition:0`,
      `A: spawnPlanId remains the Run-scoped execution reference (got ${heldChild.spawnPlanId})`);
    assert(heldChild.delegation && heldChild.delegation.scheme === DELEGATION_SCHEME &&
      heldChild.delegation.unitKey === 'alpha' &&
      heldChild.delegation.parentRunId === defaultOutcome.run.id &&
      heldChild.delegation.parentTicketId === defaultOutcome.ticket.id,
      'A: the child body carries the delegation block');
    const createdEvents = (await eventsOf(heldChild.id)).filter(event => event.type === 'ticket.created');
    assert(createdEvents.length === 1 &&
      createdEvents[0].payload.delegation &&
      createdEvents[0].payload.delegation.scheme === DELEGATION_SCHEME &&
      createdEvents[0].payload.delegation.spawnIdempotencyKey === expectedSpawnKey,
      'A: the immutable ticket.created payload is the delegated relationship authority');
    sourceAssert.deepStrictEqual(heldChild.delegation, createdEvents[0].payload.delegation,
      'A: the body block and the event block carry the same bytes');
    const heldAttempts = await store.countTicketAttempts(heldChild.id);
    assert(heldAttempts === 0, `A: the delegated child has ZERO attempts (got ${heldAttempts})`);
    const planEvidenceDefault = (defaultOutcome.replay.workflowTicketPlans || [])
      .find(item => item.stepId === 'spawn-unit');
    assert(Boolean(planEvidenceDefault), 'A: the plan evidence is recorded');
    assert(planEvidenceDefault.acceptedTickets.length === 1 &&
      planEvidenceDefault.acceptedTickets[0].delegated === true &&
      planEvidenceDefault.acceptedTickets[0].unitKey === 'alpha',
      'A: the accepted item carries its delegated unit provenance');
    const heldEntry = (planEvidenceDefault.createdTickets || [])[0];
    assert(heldEntry && heldEntry.delegated === true && heldEntry.unitKey === 'alpha' &&
      heldEntry.delegatedRelease &&
      heldEntry.delegatedRelease.outcome === 'refused' &&
      heldEntry.delegatedRelease.code === 'DELEGATED_RELEASE_NOT_AUTHORIZED',
      `B: the delegated release refused typed under the default-false snapshot (${JSON.stringify(heldEntry && heldEntry.delegatedRelease)})`);
    const afterRefusal = (await childrenOf(defaultOutcome.ticket.id))[0];
    assert(afterRefusal.status === 'blocked' && (await store.countTicketAttempts(afterRefusal.id)) === 0,
      'B: the refusal mutated nothing: the child remains blocked with zero attempts');
    const { runs: heldChildRuns } = await store.listRunsForTicket({ ticketId: heldChild.id, limit: 10 });
    assert(heldChildRuns.length === 0, 'B: no child Run exists after the refusal');

    // ── C + D. Authorized delegated release: atomic admission, ordinary child
    //    Run, non-amplified snapshots. Also E/F setup. ──────────────────────
    scenariosRun += 1;
    const authOutcome = await runWorkflow('authorized', parentAuthId, {
      executionPolicy: { allowChildTickets: true, maxExecutionSteps: 32, maxRuntimeMs: 900000 }
    });
    assert(authOutcome.run.status === 'completed',
      `C: the authorized parent completes (${authOutcome.run.status}: ${authOutcome.run.error || ''})`);
    const authChildren = await childrenOf(authOutcome.ticket.id);
    assert(authChildren.length === 2,
      `C: one delegated and one plain child were created (got ${authChildren.length})`);
    const delegatedChild = authChildren.find(child => child.spawnIdempotencyKey.endsWith(':alpha'));
    const plainChild = authChildren.find(child => child.spawnIdempotencyKey.endsWith(':vendor-plain'));
    assert(Boolean(delegatedChild) && Boolean(plainChild), 'C: both children exist');
    assert(delegatedChild.spawnIdempotencyKey ===
      `ticket:${authOutcome.ticket.id}:${parentAuthId}:spawn-units:${childWorkflowId}:alpha`,
      'C: the delegated child carries the Ticket-stable logical key');
    assert(plainChild.spawnIdempotencyKey ===
      `${authOutcome.ticket.id}:${childWorkflowId}:vendor-plain`,
      'F: the non-delegated child keeps the EXISTING vendor key derivation');
    assert(plainChild.delegation === undefined || plainChild.delegation === null,
      'F: the non-delegated child carries NO delegation block');
    assert(plainChild.status === 'blocked', 'F: the non-delegated child stays blocked (operator-release-only)');

    const delegatedChildEvents = await eventsOf(delegatedChild.id);
    const admittedAttemptEvents = delegatedChildEvents.filter(event => event.type === 'ticket.attempt_admitted');
    assert(admittedAttemptEvents.length === 1, 'C: exactly one attempt admission event on the child');
    const childTransition = delegatedChildEvents.filter(event =>
      event.type === 'ticket.updated' && event.payload.admissionIntent === 'delegated_release');
    assert(childTransition.length === 1,
      `C: the child transition event carries the delegated_release intent (got ${childTransition.length})`);
    assert(childTransition[0].payload.supersededBlocker &&
      childTransition[0].payload.supersededBlocker.kind === 'admission_hold',
      'C: the superseded admission hold reference is recorded');
    assert(childTransition[0].payload.delegatedRelease &&
      childTransition[0].payload.delegatedRelease.parentRunId === authOutcome.run.id &&
      childTransition[0].payload.delegatedRelease.spawnIdempotencyKey === delegatedChild.spawnIdempotencyKey &&
      childTransition[0].payload.delegatedRelease.delegationScheme === DELEGATION_SCHEME &&
      childTransition[0].payload.delegatedRelease.unitKey === 'alpha',
      'C: the release evidence names the acting parent Run, the logical unit and the scheme');
    // P5-R2 current-action correction: the release evidence records exactly
    // WHICH durable authorization fact the admission transaction consumed —
    // the Run-stable evidence identity + its event position on the parent
    // Run's chain + the executing action's Run-scoped reference.
    const parentAuthorizationEvents = (await eventsOf(authOutcome.ticket.id))
      .filter(event => event.type === 'workflow.delegated_plan_authorized');
    assert(parentAuthorizationEvents.length === 1,
      `C: the parent action recorded exactly one delegated-plan authorization event ` +
      `(got ${parentAuthorizationEvents.length})`);
    const parentAuthorization = parentAuthorizationEvents[0];
    const authSpawnPlanId = `${authOutcome.run.id}:wf-delegate-parent-auth-${STAMP}:spawn-units:transition:0`;
    assert(parentAuthorization.runId === authOutcome.run.id &&
      parentAuthorization.stepId === 'spawn-units' &&
      parentAuthorization.payload.parentTicketId === authOutcome.ticket.id &&
      parentAuthorization.payload.parentRunId === authOutcome.run.id &&
      parentAuthorization.payload.action === 'executeTicketPlan' &&
      parentAuthorization.payload.spawnPlanId === authSpawnPlanId &&
      Array.isArray(parentAuthorization.payload.delegatedUnits) &&
      parentAuthorization.payload.delegatedUnits.length === 1 &&
      parentAuthorization.payload.delegatedUnits[0].spawnIdempotencyKey === delegatedChild.spawnIdempotencyKey &&
      parentAuthorization.payload.delegatedUnits[0].unitKey === 'alpha',
      'C: the durable authorization binds the acting run/action and the exact delegated unit');
    assert(childTransition[0].payload.delegatedRelease.authorizationEvidenceKey ===
        parentAuthorization.payload.evidenceKey &&
      Number.isSafeInteger(childTransition[0].payload.delegatedRelease.authorizationEventPosition) &&
      childTransition[0].payload.delegatedRelease.authorizationEventPosition > 0 &&
      childTransition[0].payload.delegatedRelease.authorizationSpawnPlanId === authSpawnPlanId,
      'C: the admission consumed exactly that durable authorization (recoverable consumption fact)');
    assert(delegatedChild.status === 'in_progress' || delegatedChild.status === 'completed',
      `C: the delegated child left the held state through admission (got ${delegatedChild.status})`);
    const { runs: delegatedRuns } = await store.listRunsForTicket({ ticketId: delegatedChild.id, limit: 10 });
    assert(delegatedRuns.length === 1, `C: exactly one child Run was admitted (got ${delegatedRuns.length})`);
    const delegatedRun = delegatedRuns[0];
    const attemptsOnChild = (await store.listTicketAttempts({ ticketId: delegatedChild.id, limit: 10 })).attempts;
    assert(attemptsOnChild.length === 1, `C: exactly one attempt exists (got ${attemptsOnChild.length})`);
    const childRunTerminal = await waitFor(async () => {
      const current = await store.getRun(delegatedRun.id);
      return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
    }, 180000, 'delegated child run terminal');
    assert(childRunTerminal.status === 'completed',
      `C: the child Run executes the child workflow as an ordinary Run (${childRunTerminal.status})`);
    // Non-amplification: the child's OWN snapshots, resolved at ITS admission.
    assert(childRunTerminal.executionPolicySnapshot &&
      childRunTerminal.executionPolicySnapshot.allowChildTickets === false,
      'D: the child Run does NOT inherit the parent allowChildTickets authority (strict default false)');
    assert(!childRunTerminal.browserTargetSnapshot && !childRunTerminal.targetRef,
      'D: the delegated child gains no browser target authority (workspace/default only)');
    assert(childRunTerminal.executionMode === 'workflow',
      'D: the delegated child is an ordinary workflow-mode Run');
    const childProcessPolicy = childRunTerminal.processPolicySnapshot || {};
    assert(childProcessPolicy.capabilityEnabled !== true ||
      (Array.isArray(childProcessPolicy.profiles) && childProcessPolicy.profiles.length === 0),
      'D: the delegated child gains no process authority');
    const authPlanEvidence = (authOutcome.replay.workflowTicketPlans || [])
      .find(item => item.stepId === 'spawn-units');
    const delegatedEntry = (authPlanEvidence.createdTickets || []).find(entry => entry.delegated === true);
    const plainEntry = (authPlanEvidence.createdTickets || []).find(entry => entry.delegated === undefined);
    assert(delegatedEntry && delegatedEntry.delegatedRelease &&
      delegatedEntry.delegatedRelease.outcome === 'admitted' &&
      delegatedEntry.delegatedRelease.attemptId === attemptsOnChild[0].id &&
      delegatedEntry.delegatedRelease.runId === delegatedRun.id,
      'C: the plan evidence records the admitted attempt + Run');
    assert(plainEntry && plainEntry.delegatedRelease === undefined,
      'F: the non-delegated entry carries no delegated-release request');
    assert(authPlanEvidence.spawnPlanId ===
      `${authOutcome.run.id}:${parentAuthId}:spawn-units:transition:0`,
      'E-pre: the plan evidence carries the Run-scoped execution reference');

    // ── E. Parent rerun adopts the same child; no multiplication. ───────────
    scenariosRun += 1;
    const childCountBeforeRerun = (await childrenOf(authOutcome.ticket.id)).length;
    const rerunResponse = await server.request('POST', `/api/tickets/${authOutcome.ticket.id}/rerun`, {
      cookie, form: { mode: 'retry' }
    });
    assert(rerunResponse.statusCode === 200 || rerunResponse.statusCode === 302,
      `E: the parent rerun is accepted (HTTP ${rerunResponse.statusCode})`);
    const rerunRun = await waitFor(async () => {
      const { runs } = await store.listRunsForTicket({ ticketId: authOutcome.ticket.id, limit: 10 });
      const pending = runs.find(candidate => ['pending', 'running'].includes(candidate.status));
      return pending ? pending : null;
    }, 60000, 'parent rerun run');
    const rerunTerminal = await waitFor(async () => {
      const current = await store.getRun(rerunRun.id);
      return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
    }, 180000, 'parent rerun terminal');
    assert(rerunTerminal.status === 'completed',
      `E: the parent rerun completes (${rerunTerminal.status}: ${rerunTerminal.error || ''})`);
    const childrenAfterRerun = await childrenOf(authOutcome.ticket.id);
    assert(childrenAfterRerun.length === childCountBeforeRerun,
      `E: the parent rerun does NOT multiply the child set (got ${childrenAfterRerun.length})`);
    const adoptedChild = childrenAfterRerun.find(child => child.id === delegatedChild.id);
    assert(Boolean(adoptedChild), 'E: the delegated child adopted is the SAME Ticket');
    assert(adoptedChild.spawnPlanId === delegatedChild.spawnPlanId &&
      adoptedChild.spawnPlanId.startsWith(`${authOutcome.run.id}:`),
      'E: the adopted child keeps the ORIGINAL Run-scoped spawnPlanId');
    const rerunReplay = await store.readRunReplay(rerunTerminal.id);
    const rerunPlanEvidence = ((rerunReplay && rerunReplay.snapshot && rerunReplay.snapshot.workflowTicketPlans) || [])
      .find(item => item.stepId === 'spawn-units');
    assert(Boolean(rerunPlanEvidence), 'E: the rerun records plan evidence');
    assert(rerunPlanEvidence.spawnPlanId ===
      `${rerunTerminal.id}:${parentAuthId}:spawn-units:transition:0`,
      'E: the rerun plan evidence carries the NEW Run-scoped execution reference');
    const rerunDelegatedEntry = (rerunPlanEvidence.createdTickets || []).find(entry => entry.delegated === true);
    assert(rerunDelegatedEntry && rerunDelegatedEntry.adopted === true &&
      rerunDelegatedEntry.ticketId === delegatedChild.id,
      'E: the rerun ADOPTED the existing delegated child');
    assert(rerunDelegatedEntry.delegatedRelease &&
      rerunDelegatedEntry.delegatedRelease.outcome === 'skipped' &&
      rerunDelegatedEntry.delegatedRelease.code === 'DELEGATED_CHILD_ALREADY_ATTEMPTED',
      `E: the already-attempted child is not automatically re-admitted (${JSON.stringify(rerunDelegatedEntry.delegatedRelease)})`);
    const attemptsAfterRerun = (await store.listTicketAttempts({ ticketId: delegatedChild.id, limit: 10 })).attempts;
    assert(attemptsAfterRerun.length === 1,
      `E: no second attempt was created for the child (got ${attemptsAfterRerun.length})`);
    const rerunRejected = (rerunPlanEvidence.rejectedTickets || [])
      .find(item => (item.validationReasons || [])
        .some(reason => reason.startsWith('duplicate child ticket already exists')));
    assert(Boolean(rerunRejected),
      'F: the non-delegated duplicate keeps the existing rejected-duplicate outcome');

    // ── G. One-level delegation. ────────────────────────────────────────────
    scenariosRun += 1;
    const recursiveOutcome = await runWorkflow('recursive', parentRecursiveId, {
      executionPolicy: { allowChildTickets: true }
    });
    assert(recursiveOutcome.run.status === 'completed',
      `G: a refused recursive delegated plan does not fail the parent (${recursiveOutcome.run.status})`);
    const recursiveChildren = await childrenOf(recursiveOutcome.ticket.id);
    assert(recursiveChildren.length === 0,
      `G: no child was created for the recursive delegated unit (got ${recursiveChildren.length})`);
    const recursivePlanEvidence = (recursiveOutcome.replay.workflowTicketPlans || [])
      .find(item => item.stepId === 'spawn-unit');
    assert((recursivePlanEvidence.rejectedTickets || []).length === 1 &&
      (recursivePlanEvidence.rejectedTickets[0].validationReasons || [])
        .some(reason => reason.includes('recursive executeTicketPlan child workflows are not allowed')),
      'G: the recursive delegated unit is refused by the existing one-level prohibition');

    // ── H. Disabled child workflow refuses the delegated plan item. ─────────
    scenariosRun += 1;
    const disabledOutcome = await runWorkflow('disabled-child', parentDisabledId, {
      executionPolicy: { allowChildTickets: true }
    });
    assert(disabledOutcome.run.status === 'completed',
      `H: the disabled-child parent completes (${disabledOutcome.run.status})`);
    assert((await childrenOf(disabledOutcome.ticket.id)).length === 0,
      'H: no child is created for a disabled child workflow');
    const disabledPlanEvidence = (disabledOutcome.replay.workflowTicketPlans || [])
      .find(item => item.stepId === 'spawn-unit');
    assert((disabledPlanEvidence.rejectedTickets || []).some(item =>
      (item.validationReasons || []).some(reason => reason.includes('workflow is disabled'))),
      'H: existing validation still refuses disabled child workflows for delegated units');

    // ── I. Model-minted delegation has zero authority. ──────────────────────
    scenariosRun += 1;
    const templateOutcome = await runWorkflow('template', parentTemplateId, {
      executionPolicy: { allowChildTickets: true },
      workflowInput: {
        plan: [
          {
            delegated: true,
            unitKey: 'alpha',
            workflowId: childWorkflowId,
            objective: `Minted unit ${STAMP}`,
            workflowInput: { vendorId: 'vendor-minted' },
            reason: 'minted by dynamic input'
          }
        ]
      }
    });
    assert(templateOutcome.run.status === 'completed',
      `I: the template parent completes (${templateOutcome.run.status})`);
    assert((await childrenOf(templateOutcome.ticket.id)).length === 0,
      'I: no delegated child is minted from a dynamic whole-array plan');
    const templatePlanEvidence = (templateOutcome.replay.workflowTicketPlans || [])
      .find(item => item.stepId === 'spawn-units');
    assert((templatePlanEvidence.rejectedTickets || []).some(item =>
      (item.validationReasons || []).some(reason =>
        reason.includes('unitKey is only valid on workflow-authored delegated'))),
      'I: a dynamic item claiming a unit identity without a literal definition item is refused');

    // ── J. Definition discipline at the catalog seam. ───────────────────────
    scenariosRun += 1;
    const invalidDefinitions = [
      {
        label: 'missing unitKey',
        definition: {
          id: `wf-delegate-bad-missing-${STAMP}`, name: 'bad missing', enabled: true, inputSchema: {},
          actions: [{ id: 's', action: 'executeTicketPlan',
            input: { tickets: [{ delegated: true, workflowId: childWorkflowId, objective: 'x', workflowInput: { vendorId: 'v' } }], allowedWorkflowIds: [childWorkflowId], maxTickets: 1 } }]
        }
      },
      {
        label: 'template unitKey',
        definition: {
          id: `wf-delegate-bad-template-${STAMP}`, name: 'bad template', enabled: true, inputSchema: {},
          actions: [{ id: 's', action: 'executeTicketPlan',
            input: { tickets: [{ delegated: true, unitKey: '{{workflow.input.unitKey}}', workflowId: childWorkflowId, objective: 'x', workflowInput: { vendorId: 'v' } }], allowedWorkflowIds: [childWorkflowId], maxTickets: 1 } }]
        }
      },
      {
        label: 'duplicate unitKeys',
        definition: {
          id: `wf-delegate-bad-duplicate-${STAMP}`, name: 'bad duplicate', enabled: true, inputSchema: {},
          actions: [{ id: 's', action: 'executeTicketPlan',
            input: { tickets: [
              { delegated: true, unitKey: 'same', workflowId: childWorkflowId, objective: 'x', workflowInput: { vendorId: 'v' } },
              { delegated: true, unitKey: 'same', workflowId: childWorkflowId, objective: 'y', workflowInput: { vendorId: 'w' } }
            ], allowedWorkflowIds: [childWorkflowId], maxTickets: 5 } }]
        }
      },
      {
        label: 'unitKey without delegation',
        definition: {
          id: `wf-delegate-bad-orphan-${STAMP}`, name: 'bad orphan', enabled: true, inputSchema: {},
          actions: [{ id: 's', action: 'executeTicketPlan',
            input: { tickets: [{ unitKey: 'orphan', workflowId: childWorkflowId, objective: 'x', workflowInput: { vendorId: 'v' } }], allowedWorkflowIds: [childWorkflowId], maxTickets: 1 } }]
        }
      }
    ];
    for (const variant of invalidDefinitions) {
      const response = await server.request('POST', '/admin/workflows', {
        cookie, form: { definition: JSON.stringify(variant.definition, null, 2) }
      });
      assert(response.statusCode !== 302,
        `J: a delegated item with ${variant.label} is refused at workflow save (HTTP ${response.statusCode})`);
      assert(String(response.body || '').includes('unitKey'),
        `J: the ${variant.label} refusal names the unitKey discipline`);
    }

    // ── M. Operator release_hold remains intact; a later delegated release is
    //    stale and refuses typed. ────────────────────────────────────────────
    scenariosRun += 1;
    {
      const operatorResponse = await server.request('POST', `/api/tickets/${heldChild.id}/release-admission`, {
        cookie, form: {}
      });
      assert(operatorResponse.statusCode === 200,
        `M: operator release_hold still releases a delegated child (HTTP ${operatorResponse.statusCode})`);
      const operatorReleased = await waitFor(async () => {
        const current = await store.getTicket(heldChild.id);
        return current && current.status === 'in_progress' ? current : null;
      }, 30000, 'operator-released delegated child');
      assert(operatorReleased.status === 'in_progress',
        'M: the operator-released delegated child is admitted under the unchanged surface');
      const operatorEvents = await eventsOf(heldChild.id);
      assert(operatorEvents.some(event => event.type === 'ticket.updated' &&
        event.payload.admissionIntent === 'release_hold'),
        'M: the operator release carries the release_hold intent');
      // Wait for the operator-released child run to terminalize so the stale
      // refusal below observes a settled attempt deterministically.
      const operatorChildRun = (await store.listRunsForTicket({ ticketId: heldChild.id, limit: 10 })).runs[0];
      await waitFor(async () => {
        const current = await store.getRun(operatorChildRun.id);
        return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
      }, 180000, 'operator-released child run terminal');
      const staleParentRun = (await store.listRunsForTicket({ ticketId: defaultOutcome.ticket.id, limit: 10 })).runs[0];
      let staleCode = null;
      try {
        await store.delegatedReleaseRuns({
          childTicketId: heldChild.id,
          parentRunId: staleParentRun.id,
          spawnIdempotencyKey: heldChild.spawnIdempotencyKey,
          runDrafts: [{
            ticketId: heldChild.id,
            agentId: agent.id,
            status: 'pending',
            executionMode: 'workflow',
            workflowId: heldChild.workflowId,
            objective: heldChild.objective,
            executionPolicySnapshot: heldChild.executionPolicy,
            rerunMode: null
          }]
        });
      } catch (error) {
        staleCode = error && error.code;
      }
      assert(staleCode === 'TICKET_BLOCKER_INTENT_MISMATCH',
        `M: a stale delegated-release intent for an already-released child refuses typed (got ${staleCode})`);
      const attemptsNow = (await store.listTicketAttempts({ ticketId: heldChild.id, limit: 10 })).attempts;
      assert(attemptsNow.length === 1,
        `M: the stale intent created no second attempt (got ${attemptsNow.length})`);
    }

    await server.stop();

    // ── Seam-level scenarios (store-only; the scheduler is now stopped, so
    //    the pending Runs admitted below are never dispatched). ─────────────

    const policyTrue = {
      mode: 'assisted', requireVerification: 'never', autoRetry: false,
      maxAttempts: null, maxRuntimeMs: null, maxModelRequests: null,
      maxWorkspaceOperations: null, allowWorkspaceWrites: true,
      allowBrowserInteractions: false, allowWorkflowInvocation: false,
      allowParallelRuns: false, allowChildTickets: true, workspaceScope: 'shared'
    };
    const policyFalse = { ...policyTrue, allowChildTickets: false };

    const now = () => new Date().toISOString();
    async function createSeamTicket(label, executionPolicy) {
      return (await store.createTicketWithEvent({
        ticket: {
          objective: `p5r2 seam ${label} ${STAMP}`,
          acceptanceCriteria: null,
          assignmentTargetType: 'agent', assignmentTargetId: agent.id,
          assignmentMode: 'individual', ownedOutputPaths: null, targetRef: null,
          executionMode: 'agent', workflowId: null, workflowInput: null,
          capabilityType: 'directAction', capabilityId: 'agent-selected-actions',
          capabilityInput: null,
          executionPolicy,
          workTypeId: null, workTypeSnapshot: null,
          workContextId: null, workContextSnapshot: null,
          status: 'open',
          createdBy: 'p5-r2-seam', changedBy: 'p5-r2-seam',
          changedAt: now(), createdAt: now(), updatedAt: now()
        },
        eventPayload: { source: 'p5-r2-seam' }
      })).ticket;
    }

    async function admitSeamParentRun(ticket, executionPolicy, { start = true } = {}) {
      const created = await store.createRunsAndStartTicket({
        ticketId: ticket.id,
        runDrafts: [{
          ticketId: ticket.id,
          agentId: agent.id,
          status: 'pending',
          executionMode: 'agent',
          objective: ticket.objective,
          executionPolicySnapshot: executionPolicy,
          rerunMode: null
        }],
        runEventPayload: run => ({ agentId: run.agentId, status: run.status, executionMode: run.executionMode })
      });
      const run = created.runs[0];
      // P5-R2 current-action correction: the acting parent Run must be the
      // DISPATCHED executor (running). Seam runs are claimed and started
      // through the same canonical claim/start seams the scheduler uses; the
      // scheduler itself is stopped, so nothing else ever dispatches them.
      // ({ start: false } admits a PENDING run that was never dispatched —
      // the never-acting liveness attack fixture.)
      if (!start) return run;
      const leaseOwner = 'p5-r2-seam';
      const leaseDurationMs = 300000;
      const claimed = await store.claimPendingRun({
        leaseOwner, leaseDurationMs, eligibleRunIds: [run.id]
      });
      if (!claimed) throw new Error(`seam run ${run.id} could not be claimed`);
      const started = await store.startClaimedRun({
        runId: run.id, leaseOwner, leaseDurationMs
      });
      if (!started) throw new Error(`seam run ${run.id} could not be started`);
      return started.run;
    }

    async function plantDelegatedChild({ parentTicket, parentRun, unitKey, childWorkflow }) {
      const spawnKey = `ticket:${parentTicket.id}:wf-seam-parent:spawn-step:${childWorkflow}:${unitKey}`;
      const block = {
        scheme: DELEGATION_SCHEME,
        version: 1,
        parentTicketId: parentTicket.id,
        parentRunId: parentRun.id,
        parentWorkflowId: 'wf-seam-parent',
        spawnedByStepId: 'spawn-step',
        spawnPlanId: `${parentRun.id}:wf-seam-parent:spawn-step:transition:0`,
        spawnIdempotencyKey: spawnKey,
        unitKey,
        parentExecutionPolicyHash: null
      };
      return (await store.createTicketWithEvent({
        ticket: {
          objective: `p5r2 seam child ${unitKey} ${STAMP}`,
          acceptanceCriteria: null,
          assignmentTargetType: 'agent', assignmentTargetId: agent.id,
          assignmentMode: 'individual', ownedOutputPaths: null, targetRef: null,
          executionMode: 'workflow', workflowId: childWorkflow, workflowInput: { vendorId: 'vendor-seam' },
          capabilityType: 'workflow', capabilityId: childWorkflow,
          capabilityInput: { vendorId: 'vendor-seam' },
          executionPolicy: policyFalse,
          workTypeId: null, workTypeSnapshot: null,
          workContextId: null, workContextSnapshot: null,
          status: 'blocked',
          blockedReason: 'Created by executeTicketPlan; child workflow execution is not automatic in v1.',
          parentTicketId: parentTicket.id,
          parentRunId: parentRun.id,
          parentWorkflowId: 'wf-seam-parent',
          spawnedByStepId: 'spawn-step',
          spawnPlanId: block.spawnPlanId,
          spawnIdempotencyKey: spawnKey,
          spawnReason: 'seam fixture',
          createdBy: 'workflow:wf-seam-parent',
          delegation: block,
          changedBy: 'p5-r2-seam',
          changedAt: now(), createdAt: now(), updatedAt: now()
        },
        eventPayload: {
          source: 'p5-r2-seam',
          parentTicketId: parentTicket.id,
          parentRunId: parentRun.id,
          parentWorkflowId: 'wf-seam-parent',
          spawnedByStepId: 'spawn-step',
          spawnPlanId: block.spawnPlanId,
          spawnIdempotencyKey: spawnKey,
          workflowId: childWorkflow,
          createdBy: 'workflow:wf-seam-parent',
          delegation: block
        }
      })).ticket;
    }

    const seamChildDraft = child => ({
      ticketId: child.id,
      agentId: agent.id,
      status: 'pending',
      executionMode: 'workflow',
      workflowId: child.workflowId,
      objective: child.objective,
      executionPolicySnapshot: child.executionPolicy,
      rerunMode: null
    });

    // The seam parent workflow must EXIST and be enabled: the corrected release
    // authority independently re-proves the action's parent workflow identity
    // from the durable authorization evidence against the live catalog.
    const seamParentWorkflowId = 'wf-seam-parent';
    await store.createWorkflow({
      value: {
        id: seamParentWorkflowId,
        name: 'Seam parent workflow',
        enabled: true,
        inputSchema: {},
        actions: [{
          id: 'spawn-step', action: 'executeTicketPlan',
          input: { tickets: [], allowedWorkflowIds: [childWorkflowId], maxTickets: 5 }
        }]
      },
      changedBy: 'p5-r2-seam'
    });

    // Durably plant the CURRENT-ACTION delegated-plan authorization evidence a
    // real executeTicketPlan execution records after canonical validation and
    // BEFORE any delegated release. The item bytes come from the ONE shared
    // production builder (runtime/t4-spawn-relation-contract.js) — no second
    // producer definition. workflowContract is a payload fact the store does
    // not verify; the seam records the minimal identity facts it knows.
    async function plantDelegatedPlanAuthorization({
      parentTicket, parentRun, unitKey, childWorkflow, transitionIndex = 0,
      planBounds = null, extraUnits = [], workflowContract = null
    }) {
      const spawnPlanId = `${parentRun.id}:${seamParentWorkflowId}:spawn-step:transition:${transitionIndex}`;
      const item = buildDelegatedPlanAuthorizationEvidence({
        run: parentRun,
        workflow: { id: seamParentWorkflowId },
        step: { id: 'spawn-step', action: 'executeTicketPlan' },
        spawnPlanId,
        planBounds: planBounds || { allowedWorkflowIds: [childWorkflowId], maxTickets: 5 },
        delegatedUnits: [
          {
            unitKey,
            childWorkflowId: childWorkflow,
            spawnIdempotencyKey:
              `ticket:${parentTicket.id}:${seamParentWorkflowId}:spawn-step:${childWorkflow}:${unitKey}`
          },
          ...extraUnits
        ],
        workflowContract: workflowContract || { workflowId: seamParentWorkflowId }
      });
      // Production initializes the run's replay snapshot at run start; a seam
      // run that never dispatched needs it seeded for the append-only evidence
      // writer (same seam the server uses).
      await store.initializeRunReplay({
        runId: parentRun.id, ticketId: parentTicket.id, snapshot: {}
      });
      const capturedAt = new Date().toISOString();
      await store.appendRunEvidence({
        runId: parentRun.id,
        ticketId: parentTicket.id,
        evidenceKey: item.evidenceKey,
        replayKey: DELEGATED_PLAN_AUTHORIZATION_REPLAY_KEY,
        replayItem: { ...item, capturedAt },
        event: {
          type: DELEGATED_PLAN_AUTHORIZATION_EVENT_TYPE,
          stepId: 'spawn-step',
          payload: { ...item, capturedAt }
        }
      });
      return item;
    }

    // Plant a durable step-execution terminal boundary (the exact event shapes
    // the real engine records after an action completes or fails), for the
    // stale/current-action attacks.
    async function plantStepBoundary(parentRun, { type, status = null }) {
      const capturedAt = new Date().toISOString();
      const payload = status === null
        ? { workflowId: seamParentWorkflowId, action: 'executeTicketPlan' }
        : { status, action: 'executeTicketPlan', workflowId: seamParentWorkflowId };
      await store.appendRunEvidence({
        runId: parentRun.id,
        ticketId: parentRun.ticketId,
        evidenceKey: `seam-step-boundary:${parentRun.id}:${type}:${status || 'terminal'}:${Date.now()}`,
        replayKey: 'workflowActions',
        replayItem: { workflowId: seamParentWorkflowId, stepId: 'spawn-step', action: 'executeTicketPlan', capturedAt },
        event: {
          type,
          stepId: 'spawn-step',
          payload
        }
      });
    }

    const refusedCodeOf = async attempt => {
      try {
        await attempt();
        return 'ADMITTED';
      } catch (error) {
        return error && error.code ? error.code : `UNKNOWN:${error && error.message}`;
      }
    };

    // ── K. Immutable admitted-policy doctrine (§12). ────────────────────────
    scenariosRun += 1;
    {
      // Case 2: a run admitted while the snapshot carried TRUE keeps its
      // authority after the LIVE ticket policy is edited to false.
      const parent = await createSeamTicket('doctrine-true', policyTrue);
      const parentRun = await admitSeamParentRun(parent, policyTrue);
      const refreshed = await store.getTicket(parent.id);
      sourceAssert.equal(refreshed.executionPolicy.allowChildTickets, true,
        'K setup: the live ticket policy starts true');
      await store.transitionTicket({
        ticketId: parent.id,
        expectedRevision: refreshed.revision,
        fromStatuses: ['in_progress'],
        toStatus: 'in_progress',
        patch: { executionPolicy: policyFalse }
      }, {});
      const revoked = await store.getTicket(parent.id);
      sourceAssert.equal(revoked.executionPolicy.allowChildTickets, false,
        'K setup: the live ticket policy is now false');
      const child = await plantDelegatedChild({
        parentTicket: parent, parentRun, unitKey: 'alpha', childWorkflow: childWorkflowId
      });
      // The acting parent run must have durably re-derived and validated the
      // unit (the real executeTicketPlan action records this before release).
      await plantDelegatedPlanAuthorization({
        parentTicket: parent, parentRun, unitKey: 'alpha', childWorkflow: childWorkflowId
      });
      const released = await store.delegatedReleaseRuns({
        childTicketId: child.id,
        parentRunId: parentRun.id,
        spawnIdempotencyKey: child.spawnIdempotencyKey,
        runDrafts: [seamChildDraft(child)]
      });
      assert(released.attempt && released.runs.length === 1,
        'K: the FROZEN admitted snapshot (true) still authorizes the release despite the live edit');
      const { runs: releasedRuns } = await store.listRunsForTicket({ ticketId: child.id, limit: 10 });
      assert(releasedRuns.length === 1, 'K: exactly one child Run was created');
      assert(released.supersededBlocker && released.supersededBlocker.kind === 'admission_hold',
        'K: the hold was superseded by the admission itself');

      // Case 1: a run admitted with a FALSE snapshot cannot delegated-release.
      const parent2 = await createSeamTicket('doctrine-false', policyFalse);
      const parentRun2 = await admitSeamParentRun(parent2, policyFalse);
      const child2 = await plantDelegatedChild({
        parentTicket: parent2, parentRun: parentRun2, unitKey: 'alpha', childWorkflow: childWorkflowId
      });
      let refusedCode = null;
      try {
        await store.delegatedReleaseRuns({
          childTicketId: child2.id,
          parentRunId: parentRun2.id,
          spawnIdempotencyKey: child2.spawnIdempotencyKey,
          runDrafts: [seamChildDraft(child2)]
        });
      } catch (error) {
        refusedCode = error && error.code;
      }
      assert(refusedCode === 'DELEGATED_RELEASE_PARENT_RUN_UNAUTHORIZED',
        `K: a run admitted without allowChildTickets cannot release (got ${refusedCode})`);
      const refusedChild = await store.getTicket(child2.id);
      assert(refusedChild.status === 'blocked' && (await store.countTicketAttempts(child2.id)) === 0,
        'K: the refusal mutated nothing — the child remains held with zero attempts');
    }

    // ── L. Leg 4: a disabled child workflow refuses the release. ────────────
    scenariosRun += 1;
    {
      const parent = await createSeamTicket('disabled-child', policyTrue);
      const parentRun = await admitSeamParentRun(parent, policyTrue);
      const child = await plantDelegatedChild({
        parentTicket: parent, parentRun, unitKey: 'alpha', childWorkflow: childWorkflowId
      });
      const current = await store.getWorkflowById(childWorkflowId);
      await store.updateWorkflow({
        workflowId: childWorkflowId,
        expectedRevision: current.revision,
        value: { ...current, enabled: false },
        changedBy: 'p5-r2-seam'
      });
      let refusedCode = null;
      try {
        await store.delegatedReleaseRuns({
          childTicketId: child.id,
          parentRunId: parentRun.id,
          spawnIdempotencyKey: child.spawnIdempotencyKey,
          runDrafts: [seamChildDraft(child)]
        });
      } catch (error) {
        refusedCode = error && error.code;
      }
      assert(refusedCode === 'WORKFLOW_DISABLED',
        `L: a disabled child workflow refuses the release (got ${refusedCode})`);
      const refusedChild = await store.getTicket(child.id);
      assert(refusedChild.status === 'blocked' && (await store.countTicketAttempts(child.id)) === 0,
        'L: zero mutation — the child remains held');
      // Restore the shared child workflow for the scenarios that follow.
      await store.updateWorkflow({
        workflowId: childWorkflowId,
        expectedRevision: (await store.getWorkflowById(childWorkflowId)).revision,
        value: { ...current, enabled: true },
        changedBy: 'p5-r2-seam'
      });
    }

    // ── N. Racing delegated releases cannot create two unsettled attempts. ──
    scenariosRun += 1;
    {
      const parent = await createSeamTicket('race', policyTrue);
      const parentRun = await admitSeamParentRun(parent, policyTrue);
      const child = await plantDelegatedChild({
        parentTicket: parent, parentRun, unitKey: 'alpha', childWorkflow: childWorkflowId
      });
      await plantDelegatedPlanAuthorization({
        parentTicket: parent, parentRun, unitKey: 'alpha', childWorkflow: childWorkflowId
      });
      const attempt = () => store.delegatedReleaseRuns({
        childTicketId: child.id,
        parentRunId: parentRun.id,
        spawnIdempotencyKey: child.spawnIdempotencyKey,
        runDrafts: [seamChildDraft(child)]
      });
      const settled = await Promise.allSettled([attempt(), attempt()]);
      const fulfilled = settled.filter(result => result.status === 'fulfilled');
      const rejected = settled.filter(result => result.status === 'rejected');
      assert(fulfilled.length === 1 && rejected.length === 1,
        `N: exactly one competing release wins (fulfilled ${fulfilled.length}, rejected ${rejected.length})`);
      const loserCode = rejected[0].reason && rejected[0].reason.code;
      assert(['TICKET_BLOCKER_INTENT_MISMATCH', 'TICKET_ATTEMPT_UNSETTLED', 'TICKET_RERUN_STALE_ATTEMPT']
        .includes(loserCode),
        `N: the loser refuses typed against the committed winner state (got ${loserCode})`);
      const childAttempts = (await store.listTicketAttempts({ ticketId: child.id, limit: 10 })).attempts;
      assert(childAttempts.length === 1 && childAttempts[0].disposition === null,
        'N: exactly ONE unsettled attempt exists after the race (max-one-unsettled-attempt)');
      const { runs: raceRuns } = await store.listRunsForTicket({ ticketId: child.id, limit: 10 });
      assert(raceRuns.length === 1, `N: exactly one child Run exists after the race (got ${raceRuns.length})`);
      const racedTicket = await store.getTicket(child.id);
      assert(racedTicket.status === 'in_progress', 'N: the winner admitted the child atomically');
    }

    // ── P5-R2 current-action / parent-liveness correction: fail-closed
    //    attacks (§13). Every attack must refuse TYPED with zero mutation —
    //    the child remains held, zero attempts, zero Runs. ──────────────────

    // ── Attack 1: never-acting Run. A coherent virgin delegated child with a
    //    valid stored spawn key, but the acting parent Run has NO durable
    //    current-action plan authorization. ──────────────────────────────────
    scenariosRun += 1;
    {
      // 1a: the run is running (dispatched) but never executed the plan —
      // exactly the never-acting attack the corrected authority refuses.
      const parent = await createSeamTicket('attack1a-no-authorization', policyTrue);
      const parentRun = await admitSeamParentRun(parent, policyTrue);
      const child = await plantDelegatedChild({
        parentTicket: parent, parentRun, unitKey: 'alpha', childWorkflow: childWorkflowId
      });
      const code = await refusedCodeOf(() => store.delegatedReleaseRuns({
        childTicketId: child.id,
        parentRunId: parentRun.id,
        spawnIdempotencyKey: child.spawnIdempotencyKey,
        runDrafts: [seamChildDraft(child)]
      }));
      assert(code === 'DELEGATED_RELEASE_PLAN_AUTHORIZATION_MISSING',
        `1a: a never-acting run without durable plan authorization refuses typed (got ${code})`);
      const refusedChild = await store.getTicket(child.id);
      assert(refusedChild.status === 'blocked' && (await store.countTicketAttempts(child.id)) === 0,
        '1a: the child remains held with zero attempts');
      const { runs: refusedRuns } = await store.listRunsForTicket({ ticketId: child.id, limit: 10 });
      assert(refusedRuns.length === 0, '1a: zero child Runs exist');

      // 1b: the run was NEVER dispatched (pending) — not a current actor.
      const parent2 = await createSeamTicket('attack1b-never-dispatched', policyTrue);
      const pendingRun = await admitSeamParentRun(parent2, policyTrue, { start: false });
      const child2 = await plantDelegatedChild({
        parentTicket: parent2, parentRun: pendingRun, unitKey: 'alpha', childWorkflow: childWorkflowId
      });
      const code2 = await refusedCodeOf(() => store.delegatedReleaseRuns({
        childTicketId: child2.id,
        parentRunId: pendingRun.id,
        spawnIdempotencyKey: child2.spawnIdempotencyKey,
        runDrafts: [seamChildDraft(child2)]
      }));
      assert(code2 === 'DELEGATED_RELEASE_PARENT_RUN_INELIGIBLE',
        `1b: a pending (never-dispatched) run is not a current actor (got ${code2})`);
      assert((await store.countTicketAttempts(child2.id)) === 0, '1b: zero mutation');
    }

    // ── Attack 2: terminal Run. Valid current-action authorization evidence,
    //    then the parent Run terminalizes before the release. ────────────────
    scenariosRun += 1;
    {
      for (const terminalStatus of ['failed', 'completed', 'interrupted']) {
        const parent = await createSeamTicket(`attack2-terminal-${terminalStatus}`, policyTrue);
        const parentRun = await admitSeamParentRun(parent, policyTrue);
        const child = await plantDelegatedChild({
          parentTicket: parent, parentRun, unitKey: 'alpha', childWorkflow: childWorkflowId
        });
        await plantDelegatedPlanAuthorization({
          parentTicket: parent, parentRun, unitKey: 'alpha', childWorkflow: childWorkflowId
        });
        const current = await store.getRun(parentRun.id);
        await store.transitionRun({
          runId: parentRun.id,
          expectedRevision: current.revision,
          fromStatuses: ['running'],
          toStatus: terminalStatus,
          leaseOwner: 'p5-r2-seam',
          eventType: 'run.terminalized_attack_fixture',
          eventPayload: { reason: `p5-r2 attack 2 fixture (${terminalStatus})` }
        });
        const terminal = await store.getRun(parentRun.id);
        sourceAssert.equal(terminal.status, terminalStatus,
          `2 setup: the parent run terminalized to ${terminalStatus}`);
        const code = await refusedCodeOf(() => store.delegatedReleaseRuns({
          childTicketId: child.id,
          parentRunId: parentRun.id,
          spawnIdempotencyKey: child.spawnIdempotencyKey,
          runDrafts: [seamChildDraft(child)]
        }));
        assert(code === 'DELEGATED_RELEASE_PARENT_RUN_INELIGIBLE',
          `2: a terminal ${terminalStatus} parent run does not retain delegation authority (got ${code})`);
        const refusedChild = await store.getTicket(child.id);
        assert(refusedChild.status === 'blocked' && (await store.countTicketAttempts(child.id)) === 0,
          `2: zero child mutation for the terminal ${terminalStatus} run`);
      }
    }

    // ── Attack 3: wrong action. The acting run's durable authorization belongs
    //    to a DIFFERENT workflow step than the child's creation relation. ────
    scenariosRun += 1;
    {
      const parent = await createSeamTicket('attack3-wrong-step', policyTrue);
      const parentRun = await admitSeamParentRun(parent, policyTrue);
      const child = await plantDelegatedChild({
        parentTicket: parent, parentRun, unitKey: 'alpha', childWorkflow: childWorkflowId
      });
      // The acting run's ONLY durable plan authorization belongs to ANOTHER
      // step of the same workflow — a wrong-action authority cannot locate the
      // child's step at all.
      const wrongStepItem = buildDelegatedPlanAuthorizationEvidence({
        run: parentRun,
        workflow: { id: seamParentWorkflowId },
        step: { id: 'other-step', action: 'executeTicketPlan' },
        spawnPlanId: `${parentRun.id}:${seamParentWorkflowId}:other-step:transition:1`,
        planBounds: { allowedWorkflowIds: [childWorkflowId], maxTickets: 5 },
        delegatedUnits: [{
          unitKey: 'alpha',
          childWorkflowId: childWorkflowId,
          spawnIdempotencyKey:
            `ticket:${parent.id}:${seamParentWorkflowId}:other-step:${childWorkflowId}:alpha`
        }],
        workflowContract: { workflowId: seamParentWorkflowId }
      });
      await store.initializeRunReplay({ runId: parentRun.id, ticketId: parent.id, snapshot: {} });
      await store.appendRunEvidence({
        runId: parentRun.id,
        ticketId: parent.id,
        evidenceKey: wrongStepItem.evidenceKey,
        replayKey: DELEGATED_PLAN_AUTHORIZATION_REPLAY_KEY,
        replayItem: { ...wrongStepItem, capturedAt: new Date().toISOString() },
        event: {
          type: DELEGATED_PLAN_AUTHORIZATION_EVENT_TYPE,
          stepId: 'other-step',
          payload: { ...wrongStepItem, capturedAt: new Date().toISOString() }
        }
      });
      const plantedEvidenceKey = wrongStepItem.evidenceKey;
      const code = await refusedCodeOf(() => store.delegatedReleaseRuns({
        childTicketId: child.id,
        parentRunId: parentRun.id,
        spawnIdempotencyKey: child.spawnIdempotencyKey,
        runDrafts: [seamChildDraft(child)]
      }));
      assert(code === 'DELEGATED_RELEASE_PLAN_AUTHORIZATION_MISSING',
        `3: an authorization for another step cannot authorize this child (got ${code})`);
      assert(!code.startsWith('ADMITTED'), '3: typed refusal, no admission');
      // The planted other-step evidence is the run's LATEST step-scoped
      // authorization for 'other-step' only; the child's own step still has
      // none (plantedEvidenceKey documents that the only durable evidence on
      // this run is for the other step).
      assert(typeof plantedEvidenceKey === 'string', '3: the other-step evidence was planted');
      assert((await store.countTicketAttempts(child.id)) === 0, '3: zero mutation');
    }

    // ── Attack 4: wrong unit. The acting run's current-action authorization
    //    covers a DIFFERENT delegated unit (and a forged unit entry must not
    //    pass the store's independent re-derivation). ────────────────────────
    scenariosRun += 1;
    {
      // 4a: the action authorized a different unit for the same step.
      const parent = await createSeamTicket('attack4-wrong-unit', policyTrue);
      const parentRun = await admitSeamParentRun(parent, policyTrue);
      const child = await plantDelegatedChild({
        parentTicket: parent, parentRun, unitKey: 'alpha', childWorkflow: childWorkflowId
      });
      await plantDelegatedPlanAuthorization({
        parentTicket: parent, parentRun, unitKey: 'beta', childWorkflow: childWorkflowId
      });
      const code = await refusedCodeOf(() => store.delegatedReleaseRuns({
        childTicketId: child.id,
        parentRunId: parentRun.id,
        spawnIdempotencyKey: child.spawnIdempotencyKey,
        runDrafts: [seamChildDraft(child)]
      }));
      assert(code === 'DELEGATED_RELEASE_UNIT_NOT_AUTHORIZED',
        `4a: a unit the current action did not validate refuses typed (got ${code})`);
      assert((await store.countTicketAttempts(child.id)) === 0, '4a: zero mutation');

      // 4b: a FORGED durable evidence entry claiming the child's exact spawn
      // key with a divergent unitKey — the store re-derives the identity and
      // refuses; durable forgery is not authority either.
      const parent3 = await createSeamTicket('attack4b-forged-entry', policyTrue);
      const parentRun3 = await admitSeamParentRun(parent3, policyTrue);
      const child3 = await plantDelegatedChild({
        parentTicket: parent3, parentRun: parentRun3, unitKey: 'alpha', childWorkflow: childWorkflowId
      });
      const forged = buildDelegatedPlanAuthorizationEvidence({
        run: parentRun3,
        workflow: { id: seamParentWorkflowId },
        step: { id: 'spawn-step', action: 'executeTicketPlan' },
        spawnPlanId: `${parentRun3.id}:${seamParentWorkflowId}:spawn-step:transition:0`,
        planBounds: { allowedWorkflowIds: [childWorkflowId], maxTickets: 5 },
        delegatedUnits: [{ unitKey: 'beta', childWorkflowId: childWorkflowId,
          spawnIdempotencyKey:
            `ticket:${parent3.id}:${seamParentWorkflowId}:spawn-step:${childWorkflowId}:beta` }],
        workflowContract: { workflowId: seamParentWorkflowId }
      });
      // Forge the unit entry AFTER the builder: a divergent unitKey claiming
      // the child's exact durable key.
      const forgedItem = {
        ...forged,
        delegatedUnits: [{
          unitKey: 'forged-key',
          childWorkflowId: childWorkflowId,
          spawnIdempotencyKey: child3.spawnIdempotencyKey
        }]
      };
      await store.initializeRunReplay({ runId: parentRun3.id, ticketId: parent3.id, snapshot: {} });
      await store.appendRunEvidence({
        runId: parentRun3.id,
        ticketId: parent3.id,
        evidenceKey: forgedItem.evidenceKey,
        replayKey: DELEGATED_PLAN_AUTHORIZATION_REPLAY_KEY,
        replayItem: { ...forgedItem, capturedAt: new Date().toISOString() },
        event: {
          type: DELEGATED_PLAN_AUTHORIZATION_EVENT_TYPE,
          stepId: 'spawn-step',
          payload: { ...forgedItem, capturedAt: new Date().toISOString() }
        }
      });
      const forgedCode = await refusedCodeOf(() => store.delegatedReleaseRuns({
        childTicketId: child3.id,
        parentRunId: parentRun3.id,
        spawnIdempotencyKey: child3.spawnIdempotencyKey,
        runDrafts: [seamChildDraft(child3)]
      }));
      assert(forgedCode === 'DELEGATED_RELEASE_PLAN_AUTHORIZATION_INVALID',
        `4b: a forged unit entry diverging from the canonical delegated identity refuses (got ${forgedCode})`);
      assert((await store.countTicketAttempts(child3.id)) === 0, '4b: zero mutation');
    }

    // ── Attack 5: stale completed action. The durable authorization exists,
    //    but the plan action reached its durable completed/failed boundary
    //    before the attempted release. ──────────────────────────────────────
    scenariosRun += 1;
    {
      const variants = [
        { label: 'workflow.step.completed', type: 'workflow.step.completed', status: null },
        { label: 'workflow.step.failed', type: 'workflow.step.failed', status: null },
        { label: 'workflow.step.persisted completed', type: 'workflow.step.persisted', status: 'completed' },
        { label: 'workflow.step.persisted failed', type: 'workflow.step.persisted', status: 'failed' }
      ];
      for (const variant of variants) {
        const parent = await createSeamTicket(`attack5-${variant.type}-${variant.status || 'e'}`, policyTrue);
        const parentRun = await admitSeamParentRun(parent, policyTrue);
        const child = await plantDelegatedChild({
          parentTicket: parent, parentRun, unitKey: 'alpha', childWorkflow: childWorkflowId
        });
        await plantDelegatedPlanAuthorization({
          parentTicket: parent, parentRun, unitKey: 'alpha', childWorkflow: childWorkflowId
        });
        await plantStepBoundary(parentRun, { type: variant.type, status: variant.status });
        const code = await refusedCodeOf(() => store.delegatedReleaseRuns({
          childTicketId: child.id,
          parentRunId: parentRun.id,
          spawnIdempotencyKey: child.spawnIdempotencyKey,
          runDrafts: [seamChildDraft(child)]
        }));
        assert(code === 'DELEGATED_RELEASE_ACTION_STALE',
          `5: an action that durably completed (${variant.label}) before the release is stale (got ${code})`);
        const refusedChild = await store.getTicket(child.id);
        assert(refusedChild.status === 'blocked' && (await store.countTicketAttempts(child.id)) === 0,
          `5: zero mutation for the stale ${variant.label} authorization`);
      }
    }

    // ── Attack 6: the action's parent workflow authority was revoked between
    //    authorization and release. ─────────────────────────────────────────
    scenariosRun += 1;
    {
      const parent = await createSeamTicket('attack6-parent-workflow-revoked', policyTrue);
      const parentRun = await admitSeamParentRun(parent, policyTrue);
      const child = await plantDelegatedChild({
        parentTicket: parent, parentRun, unitKey: 'alpha', childWorkflow: childWorkflowId
      });
      await plantDelegatedPlanAuthorization({
        parentTicket: parent, parentRun, unitKey: 'alpha', childWorkflow: childWorkflowId
      });
      const seamParentWorkflow = await store.getWorkflowById(seamParentWorkflowId);
      await store.updateWorkflow({
        workflowId: seamParentWorkflowId,
        expectedRevision: seamParentWorkflow.revision,
        value: { ...seamParentWorkflow, enabled: false },
        changedBy: 'p5-r2-seam'
      });
      const code = await refusedCodeOf(() => store.delegatedReleaseRuns({
        childTicketId: child.id,
        parentRunId: parentRun.id,
        spawnIdempotencyKey: child.spawnIdempotencyKey,
        runDrafts: [seamChildDraft(child)]
      }));
      assert(code === 'WORKFLOW_DISABLED',
        `6: a revoked (disabled) parent workflow authority refuses the release (got ${code})`);
      assert((await store.countTicketAttempts(child.id)) === 0, '6: zero mutation');
      // Restore for any later scenario.
      await store.updateWorkflow({
        workflowId: seamParentWorkflowId,
        expectedRevision: (await store.getWorkflowById(seamParentWorkflowId)).revision,
        value: { ...seamParentWorkflow, enabled: true },
        changedBy: 'p5-r2-seam'
      });
      // The still-authorized release succeeds once the parent workflow
      // authority is restored — the ordinary valid path is intact.
      const recovered = await store.delegatedReleaseRuns({
        childTicketId: child.id,
        parentRunId: parentRun.id,
        spawnIdempotencyKey: child.spawnIdempotencyKey,
        runDrafts: [seamChildDraft(child)]
      });
      assert(recovered.attempt && recovered.runs.length === 1,
        '6: the same authorization admits after the parent workflow authority is restored');
      const { runs: restoredRuns } = await store.listRunsForTicket({ ticketId: child.id, limit: 10 });
      assert(restoredRuns.length === 1, '6: exactly one child Run exists');
    }

    // ── Crash-after-authorization recovery (§6): a replayed action reuses the
    //    SAME durable authorization fact, and a divergent re-derivation fails
    //    closed at the evidence seam before any effect. ──────────────────────
    scenariosRun += 1;
    {
      const parent = await createSeamTicket('recovery-reuse', policyTrue);
      const parentRun = await admitSeamParentRun(parent, policyTrue);
      const child = await plantDelegatedChild({
        parentTicket: parent, parentRun, unitKey: 'alpha', childWorkflow: childWorkflowId
      });
      const planted = await plantDelegatedPlanAuthorization({
        parentTicket: parent, parentRun, unitKey: 'alpha', childWorkflow: childWorkflowId
      });
      // The replay snapshot carries the durable item under the Run-stable
      // replay collection (this is what the replayed action re-reads).
      const replayRecord = await store.readRunReplay(parentRun.id);
      const replayItems = (replayRecord && replayRecord.snapshot &&
          Array.isArray(replayRecord.snapshot.delegatedPlanAuthorizations)
        ? replayRecord.snapshot.delegatedPlanAuthorizations : [])
        .filter(item => item && item.evidenceKey === planted.evidenceKey);
      assert(replayItems.length === 1 && replayItems[0].delegatedUnits.length === 1 &&
        replayItems[0].delegatedUnits[0].unitKey === 'alpha',
        'recovery: the durable authorization is replay-recognizable under the Run-stable identity');
      // The replayed action re-records the SAME canonical item with the SAME
      // capturedAt: idempotent, no second event, no conflict.
      const sameItem = { ...planted, capturedAt: replayItems[0].capturedAt };
      await store.appendRunEvidence({
        runId: parentRun.id,
        ticketId: parent.id,
        evidenceKey: sameItem.evidenceKey,
        replayKey: DELEGATED_PLAN_AUTHORIZATION_REPLAY_KEY,
        replayItem: { ...sameItem },
        event: {
          type: DELEGATED_PLAN_AUTHORIZATION_EVENT_TYPE,
          stepId: 'spawn-step',
          payload: { ...sameItem }
        }
      });
      const reusedEvent = await store.getRunEvidenceEvent(parentRun.id, planted.evidenceKey);
      assert(reusedEvent && reusedEvent.type === DELEGATED_PLAN_AUTHORIZATION_EVENT_TYPE,
        'recovery: the replayed recording reused the SAME durable evidence event');
      const released = await store.delegatedReleaseRuns({
        childTicketId: child.id,
        parentRunId: parentRun.id,
        spawnIdempotencyKey: child.spawnIdempotencyKey,
        runDrafts: [seamChildDraft(child)]
      });
      assert(released.attempt && released.runs.length === 1,
        'recovery: the reused durable authorization fact still admits the ordinary path');

      // Divergent re-derivation under the SAME identity fails closed at the
      // evidence seam (the writer refuses before any effect exists).
      const parent2 = await createSeamTicket('recovery-divergent', policyTrue);
      const parentRun2 = await admitSeamParentRun(parent2, policyTrue);
      const planted2 = await plantDelegatedPlanAuthorization({
        parentTicket: parent2, parentRun: parentRun2, unitKey: 'alpha', childWorkflow: childWorkflowId
      });
      const replay2 = await store.readRunReplay(parentRun2.id);
      const existing2 = (replay2.snapshot.delegatedPlanAuthorizations || [])
        .find(item => item && item.evidenceKey === planted2.evidenceKey);
      let divergentError = null;
      try {
        await store.appendRunEvidence({
          runId: parentRun2.id,
          ticketId: parent2.id,
          evidenceKey: planted2.evidenceKey,
          replayKey: DELEGATED_PLAN_AUTHORIZATION_REPLAY_KEY,
          replayItem: { ...planted2, maxTickets: 7, capturedAt: existing2.capturedAt },
          event: {
            type: DELEGATED_PLAN_AUTHORIZATION_EVENT_TYPE,
            stepId: 'spawn-step',
            payload: { ...planted2, maxTickets: 7, capturedAt: existing2.capturedAt }
          }
        });
      } catch (error) {
        divergentError = error;
      }
      assert(divergentError && divergentError.code === 'IDEMPOTENCY_CONFLICT',
        `recovery: a divergent re-derivation of the same authorization identity fails closed ` +
        `(got ${divergentError && divergentError.code})`);
    }

    // ── Delegated_release intent isolation (accepted R2 falsification): the
    //    operator/scheduler admission surface can never mint the delegated
    //    token, even with a coherent child and valid durable evidence. ──────
    scenariosRun += 1;
    {
      const parent = await createSeamTicket('intent-isolation', policyTrue);
      const parentRun = await admitSeamParentRun(parent, policyTrue);
      const child = await plantDelegatedChild({
        parentTicket: parent, parentRun, unitKey: 'alpha', childWorkflow: childWorkflowId
      });
      await plantDelegatedPlanAuthorization({
        parentTicket: parent, parentRun, unitKey: 'alpha', childWorkflow: childWorkflowId
      });
      let injectionCode = null;
      try {
        await store.rerunAdmitRuns({
          ticketId: child.id,
          runDrafts: [seamChildDraft(child)],
          admissionIntent: 'delegated_release'
        });
      } catch (error) {
        injectionCode = error && error.code;
      }
      assert(injectionCode === 'TICKET_ADMISSION_INTENT_INVALID',
        `injection: rerunAdmitRuns does not accept the delegated_release token (got ${injectionCode})`);
      const injectedChild = await store.getTicket(child.id);
      assert(injectedChild.status === 'blocked' && (await store.countTicketAttempts(child.id)) === 0,
        'injection: zero mutation — the child remains held');
    }

    // ── Operator-vs-delegated release race (accepted R2 falsification): one
    //    winner, one typed loser, exactly one unsettled attempt. ────────────
    scenariosRun += 1;
    {
      const parent = await createSeamTicket('operator-vs-delegated-race', policyTrue);
      const parentRun = await admitSeamParentRun(parent, policyTrue);
      const child = await plantDelegatedChild({
        parentTicket: parent, parentRun, unitKey: 'alpha', childWorkflow: childWorkflowId
      });
      await plantDelegatedPlanAuthorization({
        parentTicket: parent, parentRun, unitKey: 'alpha', childWorkflow: childWorkflowId
      });
      const settled = await Promise.allSettled([
        store.rerunAdmitRuns({
          ticketId: child.id,
          runDrafts: [seamChildDraft(child)],
          admissionIntent: 'release_hold'
        }),
        store.delegatedReleaseRuns({
          childTicketId: child.id,
          parentRunId: parentRun.id,
          spawnIdempotencyKey: child.spawnIdempotencyKey,
          runDrafts: [seamChildDraft(child)]
        })
      ]);
      const fulfilled = settled.filter(result => result.status === 'fulfilled');
      const rejected = settled.filter(result => result.status === 'rejected');
      assert(fulfilled.length === 1 && rejected.length === 1,
        `race: exactly one operator-vs-delegated release wins ` +
        `(fulfilled ${fulfilled.length}, rejected ${rejected.length})`);
      const loserCode = rejected[0].reason && rejected[0].reason.code;
      assert(['TICKET_BLOCKER_INTENT_MISMATCH', 'TICKET_ATTEMPT_UNSETTLED', 'TICKET_RERUN_STALE_ATTEMPT']
        .includes(loserCode),
        `race: the loser refuses typed against the committed winner state (got ${loserCode})`);
      const raceAttempts = (await store.listTicketAttempts({ ticketId: child.id, limit: 10 })).attempts;
      assert(raceAttempts.length === 1 && raceAttempts[0].disposition === null,
        'race: exactly ONE unsettled attempt exists after the race');
      const { runs: raceRuns } = await store.listRunsForTicket({ ticketId: child.id, limit: 10 });
      assert(raceRuns.length === 1, `race: exactly one child Run exists (got ${raceRuns.length})`);
    }

    assertScenariosExecuted({
      label: 'p5 r2 delegated admission',
      assertions: assert.count(),
      scenarios: scenariosRun,
      minAssertions: 135,
      minScenarios: 17
    });
    console.log(`\nPASS: P5-R2 delegated admission — ${scenariosRun} scenarios, ${assert.count()} assertions (PostgreSQL-native)`);
  }, { schemaSlug: 'p5_r2_delegated_admission' });
}

main().catch(error => {
  console.error(`\nFAIL: P5-R2 delegated admission — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
