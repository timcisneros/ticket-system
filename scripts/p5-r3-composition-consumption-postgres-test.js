#!/usr/bin/env node
'use strict';

// P5-R3 — Deterministic composition consumption — PostgreSQL-native owner.
//
// Authority: docs/ARCHITECTURAL_DECISIONS_PENDING.md, P5 semantic design
// freeze — §14 (childTerminalOutcome — CRITERION-A, through the SINGLE
// existing evaluator), §15 (awaitChildTickets — bounded observation, ZERO
// completion authority), §8 (CHILD-RERUN-A / UNITKEY-A), §16
// (workspace/default target only), §17 (bounds), §18 (await evidence slot),
// §19 (evidence), §21 (NO MIGRATION).
//
// THE CONTRACT (each scenario owns one frozen assertion set):
//
//   A. End-to-end composition completion: a parent workflow that explicitly
//      authors two delegated units, observes them with awaitChildTickets,
//      branches on the existing condition semantics, and requires
//      childTerminalOutcome(completed) completes ONLY through the canonical
//      postcondition evaluator. The result lands in run.postconditions_checked
//      and the hash-bound completion decision's evaluatedPostconditions; the
//      awaited children are the Ticket-stable R2 children; R3 creates no
//      attempt, Run or Ticket of its own.
//   B. Observation/completion separation (§28): the same awaitChildTickets
//      observation of NON-terminal (held) children with NO
//      childTerminalOutcome postcondition leaves completion doctrine
//      untouched — the parent completes through the existing workflow
//      capability evidence, the decision carries NO child-outcome criterion,
//      and the observation is workflow context only.
//   C. Held children: awaitChildTickets observes the durable held state
//      (resolution resolved, attemptState none, ticketState blocked) WITHOUT
//      releasing, admitting, or mutating anything; the authored criterion
//      fails closed (CHILD_HAS_NO_ATTEMPT) and the parent fails honestly; the
//      child still has zero attempts and no Run, and no delegated_release
//      exists anywhere.
//   D. Failed child: a delegated child whose own Run fails canonically
//      settles its attempt as failed; a success-only criterion never accepts
//      it (CHILD_TERMINAL_OUTCOME_UNACCEPTABLE) and the parent fails with
//      postcondition evidence naming the truth.
//   E. Missing expected child: an authored expected unit that no plan item
//      ever spawned is CHILD_MISSING — never waived by the children that do
//      exist; the parent fails.
//   F. Forged observation: workflow context statically claiming
//      "allExpectedUnitsSettled: true" (and any cached await output) has ZERO
//      completion authority; the criterion re-reads current durable facts and
//      refuses.
//   G. Parent rerun determinism (CHILD-RERUN-A): a parent rerun resolves the
//      SAME Ticket-stable child by the authored unit identity, adopts it
//      without multiplication or re-admission, and satisfies the criterion
//      against the same durable child; the Run-scoped spawnPlanId of the new
//      plan evidence never participates.
//   H. Ambiguous child: two children durably claiming the same delegated
//      logical identity cannot satisfy the unit (CHILD_AMBIGUOUS) — the
//      criterion refuses typed and the parent fails.
//   I. Incoherent provenance: a child claiming the expected unit whose
//      delegation block diverges from its own creation payload cannot satisfy
//      the unit (CHILD_PROVENANCE_UNCOHERENT).
//   J. Bounded observation evidence: every awaitChildTickets execution
//      records a bounded truncation-explicit workflow.await_children typed
//      event + workflowAwaitChildren replay item keyed by the authored
//      unitKey; no child history transcript is dumped.
//   K. Repository authority untouched: no new migration exists (no 045; 044
//      stays unapplied and unauthorized), and the migration-execution
//      authorization record remains NOT_AUTHORIZED.
//   P. During-read criterion race (§3, CHILD-RERUN-A): while a criterion
//      evaluation's composition facts were loading — after the loader's
//      initial canonical current-attempt read and before its final consistency
//      re-read — the racing child's CANONICAL child rerun admission creates
//      the newer attempt B (unsettled). The criterion refuses typed
//      (CHILD_ATTEMPT_CHANGED_DURING_READ); the superseded settled-completed
//      attempt A is never reported as current terminal truth; B is the child's
//      canonical current attempt; the parent receives the typed deterministic
//      non-success; and the loader mutates nothing. Coordinated through the
//      TEST_COMPOSITION_READ_ADVENT test-only seam, which performs the
//      production child-rerun admission (the canonical operator rerun entry)
//      exactly once inside the composition read.
//   Q. During-read observation race (§15, §11): the same attempt-generation
//      change encountered by awaitChildTickets during its durable fact read
//      keeps the observation nonterminal — allExpectedUnitsSettled stays
//      false, the observed unit is the unsettled CURRENT attempt, and the
//      superseded attempt's settled 'completed' disposition is never surfaced
//      as settled truth; the observation itself performs no child admission
//      and no lifecycle mutation (exactly the canonical attempt A plus the
//      one coordinated rerun attempt exist). The parent has NO criterion: the
//      observation carries zero completion authority, and a later criterion
//      evaluation would independently perform its own current durable read.
//
// Corruption scenarios (H/I) plant the corrupted durable state through the
// canonical store seams while a first server with a DISABLED scheduler holds
// the normally-admitted (pending) parent runs back; the second server's live
// scheduler then dispatches them against the already-durable corruption. No
// timing race. The during-read race scenarios (P/Q) coordinate the exact
// attempt-generation change inside the composition loader through the
// test-only TEST_COMPOSITION_READ_ADVENT seam and pin the concurrency budget
// during the race window; they never depend on scheduler timing either.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const fs = require('fs');
const path = require('path');
const {
  withHarness, createAsserter, sleep
} = require('./postgres-test-harness');
const { assertScenariosExecuted } = require('./child-process-settlement');
const { DELEGATION_SCHEME } = require('../runtime/t4-spawn-relation-contract');
const {
  buildCompletionAuthoritySnapshot
} = require('../runtime/completion-decision-contract');

const STAMP = Date.now();
const assert = createAsserter();
let scenariosRun = 0;

const ROOT = path.resolve(__dirname, '..');

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
  await withHarness('p5 r3 composition consumption', async ({ store, schema, startServer }) => {
    const agent = (await store.createConfiguredAgent({
      value: { name: `P5R3Consume-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key-consume' },
      groupIds: [], changedBy: 'p5-r3-composition-consumption-test'
    })).agent;

    const childWorkflowId = `wf-r3-child-${STAMP}`;
    const childWorkflow = {
      id: childWorkflowId,
      name: 'R3 delegated child workflow',
      enabled: true,
      inputSchema: { vendorId: 'string' },
      actions: [{ id: 'done', action: 'stop', input: { result: { unitDone: '{{workflow.input.vendorId}}' } } }]
    };

    const failingChildWorkflowId = `wf-r3-child-fail-${STAMP}`;
    const failingChildWorkflow = {
      id: failingChildWorkflowId,
      name: 'R3 failing delegated child workflow',
      enabled: true,
      inputSchema: {},
      // An unknown action is refused by the child run's own definition
      // validation at execution: the child Run fails canonically and its
      // attempt settles failed.
      actions: [{ id: 'boom', action: 'noSuchR3Operation', input: {} }]
    };

    // The child workflow catalog rows exist BEFORE any planting or spawning:
    // delegated child creation asserts the referenced workflow at the store
    // seam (WorkflowCatalogReferenceError otherwise).
    for (const definition of [childWorkflow, failingChildWorkflow]) {
      await store.createWorkflow({ value: definition, changedBy: 'p5-r3-composition-consumption-test' });
    }

    // ── Corrupt-lineage parents (H/I): no spawn step — the expected children
    //    are planted directly at the store seam (durable corruption) while
    //    their normally-admitted parent runs are held PENDING by a server
    //    whose scheduler is disabled. The parent admission itself is the real
    //    /tickets path, so every admitted snapshot is exactly production's.
    const corruptAmbiguousParentId = `wf-r3-corrupt-amb-${STAMP}`;
    const corruptAmbiguousParent = {
      id: corruptAmbiguousParentId,
      name: 'R3 parent over an ambiguous delegated unit',
      enabled: true,
      inputSchema: {},
      actions: [
        {
          id: 'await', action: 'awaitChildTickets',
          input: {
            parentBinding: 'self',
            parentWorkflowId: corruptAmbiguousParentId,
            spawnedByStepId: 'spawn-units',
            childWorkflowId,
            expectedUnits: ['alpha'],
            pollIntervalMs: 100,
            maxPollMs: 1000
          },
          saveAs: 'observed',
          next: 'done'
        },
        { id: 'done', action: 'stop', input: { result: {} } }
      ],
      postconditions: [{
        id: 'child-units-complete',
        type: 'childTerminalOutcome',
        parentBinding: 'self',
        parentWorkflowId: corruptAmbiguousParentId,
        spawnedByStepId: 'spawn-units',
        childWorkflowId,
        expectedUnits: ['alpha'],
        expect: { disposition: 'completed' }
      }]
    };

    const corruptUncoherentParentId = `wf-r3-corrupt-unc-${STAMP}`;
    const corruptUncoherentParent = {
      ...corruptAmbiguousParent,
      id: corruptUncoherentParentId,
      name: 'R3 parent over an incoherently provenanced delegated unit',
      actions: corruptAmbiguousParent.actions.map(step =>
        step.id === 'await'
          ? { ...step, input: { ...step.input, parentWorkflowId: corruptUncoherentParentId } }
          : step),
      postconditions: [{
        ...corruptAmbiguousParent.postconditions[0],
        parentWorkflowId: corruptUncoherentParentId
      }]
    };

    const holdServer = await startServer({ env: {
      RUNTIME_SCHEDULER_INTERVAL_MS: '3600000'
    } });
    const holdCookie = await holdServer.login();
    for (const definition of [corruptAmbiguousParent, corruptUncoherentParent]) {
      const response = await holdServer.request('POST', '/admin/workflows', {
        cookie: holdCookie, form: { definition: JSON.stringify(definition, null, 2) }
      });
      assert(response.statusCode === 302 || response.statusCode === 200,
        `corrupt workflow ${definition.id} saved (HTTP ${response.statusCode})`);
    }
    const planted = {};
    for (const [label, definition] of [
      ['ambiguous', corruptAmbiguousParent],
      ['uncoherent', corruptUncoherentParent]
    ]) {
      const created = await holdServer.request('POST', '/tickets', {
        cookie: holdCookie,
        form: {
          objective: `p5r3 corrupt ${label} ${STAMP}`,
          capabilityType: 'workflow', workflowId: definition.id,
          workflowInput: '{}',
          assignmentTargetType: 'agent', assignmentTargetId: String(agent.id),
          assignmentMode: 'individual'
        }
      });
      assert(created.statusCode === 302, `corrupt ${label}: parent ticket created`);
      const parent = await waitFor(async () => {
        const { tickets } = await store.listTickets({ limit: 400 });
        return tickets.find(t => t.objective === `p5r3 corrupt ${label} ${STAMP}`) || null;
      }, 30000, `corrupt ${label} parent ticket`);
      planted[label] = { parent, definition };
    }
    const plantCanonicalChild = ({ parentTicket, parentRun, unitKey, childWorkflow }) => {
      const spawnKey = `ticket:${parentTicket.id}:${corruptAmbiguousParentId}:spawn-units:${childWorkflow}:${unitKey}`;
      const block = {
        scheme: DELEGATION_SCHEME,
        version: 1,
        parentTicketId: parentTicket.id,
        parentRunId: parentRun.id,
        parentWorkflowId: corruptAmbiguousParentId,
        spawnedByStepId: 'spawn-units',
        spawnPlanId: `${parentRun.id}:${corruptAmbiguousParentId}:spawn-units:transition:0`,
        spawnIdempotencyKey: spawnKey,
        unitKey,
        parentExecutionPolicyHash: null
      };
      const payload = {
        source: 'p5-r3-seam',
        parentTicketId: parentTicket.id,
        parentRunId: parentRun.id,
        parentWorkflowId: corruptAmbiguousParentId,
        spawnedByStepId: 'spawn-units',
        spawnPlanId: block.spawnPlanId,
        spawnIdempotencyKey: spawnKey,
        workflowId: childWorkflow,
        createdBy: `workflow:${corruptAmbiguousParentId}`,
        delegation: block
      };
      return (async () => {
        const created = await store.createTicketWithEvent({
          ticket: {
            objective: `p5r3 corrupt child ${parentTicket.id} ${unitKey} ${STAMP}`,
            acceptanceCriteria: null,
            assignmentTargetType: 'agent', assignmentTargetId: agent.id,
            assignmentMode: 'individual', ownedOutputPaths: null, targetRef: null,
            executionMode: 'workflow', workflowId: childWorkflow, workflowInput: { vendorId: 'vendor-corrupt' },
            capabilityType: 'workflow', capabilityId: childWorkflow,
            capabilityInput: { vendorId: 'vendor-corrupt' },
            executionPolicy: { allowChildTickets: false },
            workTypeId: null, workTypeSnapshot: null,
            workContextId: null, workContextSnapshot: null,
            status: 'blocked',
            blockedReason: 'Planted corruption fixture.',
            ...payload
          },
          eventPayload: payload
        });
        return { created, payload };
      })();
    };
    // Corruption seeding only: the append-only chain accepts NEW positions,
    // exactly like the T4 corruption seam. These payloads never substitute
    // for the production constructor.
    const plantRawCreatedEvent = async (ticketId, payload) => {
      const result = await store.pool.query(
        `INSERT INTO "${schema}".events
           (id, schema_version, ts, type, ticket_id, payload)
         VALUES (gen_random_uuid(), 1, clock_timestamp(), 'ticket.created', $1, $2::jsonb)
         RETURNING id, position`,
        [ticketId, JSON.stringify(payload)]);
      return { id: String(result.rows[0].id), position: Number(result.rows[0].position) };
    };
    const makePlainTicket = async objective => (await store.createTicketWithEvent({
      ticket: {
        objective, status: 'open',
        assignmentTargetType: 'agent', assignmentTargetId: agent.id,
        assignmentMode: 'individual', executionMode: 'agent'
      },
      eventPayload: { objective }
    })).ticket;

    // Ambiguous: TWO children durably claiming the SAME logical identity —
    // one canonical child plus a second child carrying a raw-planted copy of
    // the same coherent creation payload (the canonical constructor itself
    // refuses duplicates by spawn key, so the ambiguity fixture exists only
    // as durable corruption).
    {
      const parentRun = (await store.listRunsForTicket({ ticketId: planted.ambiguous.parent.id, limit: 10 })).runs[0];
      const { created, payload } = await plantCanonicalChild({
        parentTicket: planted.ambiguous.parent, parentRun, unitKey: 'alpha', childWorkflow: childWorkflowId
      });
      const forgedChild = await makePlainTicket(`p5r3 ambiguous twin ${STAMP}`);
      await plantRawCreatedEvent(forgedChild.id, payload);
    }
    // Incoherent: ONE child claiming the expected unit whose delegation
    // block's unitKey diverges from the payload key it rides.
    {
      const forgedChild = await makePlainTicket(`p5r3 incoherent child ${STAMP}`);
      const spawnKey = `ticket:${planted.uncoherent.parent.id}:${corruptUncoherentParentId}:spawn-units:${childWorkflowId}:alpha`;
      const conflictingBlock = {
        scheme: DELEGATION_SCHEME,
        version: 1,
        parentTicketId: planted.uncoherent.parent.id,
        parentRunId: 1,
        parentWorkflowId: corruptUncoherentParentId,
        spawnedByStepId: 'spawn-units',
        spawnPlanId: `1:${corruptUncoherentParentId}:spawn-units:transition:0`,
        spawnIdempotencyKey: spawnKey,
        unitKey: 'beta',
        parentExecutionPolicyHash: null
      };
      await plantRawCreatedEvent(forgedChild.id, {
        source: 'p5-r3-seam',
        parentTicketId: planted.uncoherent.parent.id,
        parentRunId: 1,
        parentWorkflowId: corruptUncoherentParentId,
        spawnedByStepId: 'spawn-units',
        spawnPlanId: conflictingBlock.spawnPlanId,
        spawnIdempotencyKey: spawnKey,
        workflowId: childWorkflowId,
        createdBy: `workflow:${corruptUncoherentParentId}`,
        delegation: conflictingBlock
      });
    }
    for (const [label, { parent }] of Object.entries(planted)) {
      const { runs } = await store.listRunsForTicket({ ticketId: parent.id, limit: 10 });
      assert(runs.length === 1 && runs[0].status === 'pending',
        `corrupt ${label}: the parent run was normally admitted and held pending (got ${runs.length} runs)`);
    }
    await holdServer.stop();

    // ── The live server dispatches everything: the planted pending corrupt
    //    parent runs evaluate against the already-durable corrupted state,
    //    and the E2E scenarios run through the real API. ─────────────────────
    const server = await startServer({ env: {
      RUNTIME_SCHEDULER_INTERVAL_MS: '200',
      RUN_LEASE_DURATION_MS: '60000'
    } });
    const cookie = await server.login();

    const parentWorkflowId = `wf-r3-parent-${STAMP}`;
    const parentWorkflow = {
      id: parentWorkflowId,
      name: 'R3 composition parent (complete path)',
      enabled: true,
      inputSchema: {},
      actions: [
        {
          id: 'spawn-units', action: 'executeTicketPlan',
          input: {
            tickets: [
              {
                delegated: true, unitKey: 'alpha',
                workflowId: childWorkflowId,
                objective: `R3 alpha ${STAMP}`,
                workflowInput: { vendorId: 'vendor-alpha' },
                reason: 'delegated unit alpha'
              },
              {
                delegated: true, unitKey: 'beta',
                workflowId: childWorkflowId,
                objective: `R3 beta ${STAMP}`,
                workflowInput: { vendorId: 'vendor-beta' },
                reason: 'delegated unit beta'
              }
            ],
            allowedWorkflowIds: [childWorkflowId],
            maxTickets: 5
          },
          next: 'await'
        },
        {
          id: 'await', action: 'awaitChildTickets',
          input: {
            parentBinding: 'self',
            parentWorkflowId,
            spawnedByStepId: 'spawn-units',
            childWorkflowId,
            expectedUnits: ['alpha', 'beta'],
            pollIntervalMs: 100,
            maxPollMs: 30000
          },
          saveAs: 'observed',
          next: 'check'
        },
        {
          id: 'check', action: 'condition',
          input: { value: '{{observed.allExpectedUnitsSettled}}', equals: true },
          trueNext: 'done', falseNext: 'await'
        },
        { id: 'done', action: 'stop', input: { result: { observed: '{{observed.observedUnits}}' } } }
      ],
      postconditions: [{
        id: 'child-units-complete',
        type: 'childTerminalOutcome',
        parentBinding: 'self',
        parentWorkflowId,
        spawnedByStepId: 'spawn-units',
        childWorkflowId,
        expectedUnits: ['alpha', 'beta'],
        expect: { disposition: 'completed' }
      }]
    };

    const noCriterionParentId = `wf-r3-nocriterion-${STAMP}`;
    const noCriterionParent = {
      id: noCriterionParentId,
      name: 'R3 parent without the child criterion (separation)',
      enabled: true,
      inputSchema: {},
      actions: [
        {
          id: 'spawn-unit', action: 'executeTicketPlan',
          input: {
            tickets: [{
              delegated: true, unitKey: 'alpha',
              workflowId: childWorkflowId,
              objective: `R3 separation alpha ${STAMP}`,
              workflowInput: { vendorId: 'vendor-alpha' },
              reason: 'delegated unit alpha'
            }],
            allowedWorkflowIds: [childWorkflowId],
            maxTickets: 5
          },
          next: 'await'
        },
        {
          id: 'await', action: 'awaitChildTickets',
          input: {
            parentBinding: 'self',
            parentWorkflowId: noCriterionParentId,
            spawnedByStepId: 'spawn-unit',
            childWorkflowId,
            expectedUnits: ['alpha'],
            pollIntervalMs: 100,
            maxPollMs: 2000
          },
          saveAs: 'observed',
          next: 'done'
        },
        { id: 'done', action: 'stop', input: { result: { observed: '{{observed.allExpectedUnitsSettled}}' } } }
      ]
    };

    const heldParentId = `wf-r3-held-${STAMP}`;
    const heldParent = {
      id: heldParentId,
      name: 'R3 parent over held children',
      enabled: true,
      inputSchema: {},
      actions: [
        {
          id: 'spawn-units', action: 'executeTicketPlan',
          input: {
            tickets: [{
              delegated: true, unitKey: 'alpha',
              workflowId: childWorkflowId,
              objective: `R3 held alpha ${STAMP}`,
              workflowInput: { vendorId: 'vendor-alpha' },
              reason: 'delegated unit alpha (held)'
            }],
            allowedWorkflowIds: [childWorkflowId],
            maxTickets: 5
          },
          next: 'await'
        },
        {
          id: 'await', action: 'awaitChildTickets',
          input: {
            parentBinding: 'self',
            parentWorkflowId: heldParentId,
            spawnedByStepId: 'spawn-units',
            childWorkflowId,
            expectedUnits: ['alpha'],
            pollIntervalMs: 100,
            maxPollMs: 2000
          },
          saveAs: 'observed',
          next: 'done'
        },
        { id: 'done', action: 'stop', input: { result: { settled: '{{observed.allExpectedUnitsSettled}}' } } }
      ],
      postconditions: [{
        id: 'child-units-complete',
        type: 'childTerminalOutcome',
        parentBinding: 'self',
        parentWorkflowId: heldParentId,
        spawnedByStepId: 'spawn-units',
        childWorkflowId,
        expectedUnits: ['alpha'],
        expect: { disposition: 'completed' }
      }]
    };

    const missingUnitParentId = `wf-r3-missing-${STAMP}`;
    const missingUnitParent = {
      id: missingUnitParentId,
      name: 'R3 parent with an authored but never-spawned unit',
      enabled: true,
      inputSchema: {},
      actions: [
        {
          id: 'spawn-units', action: 'executeTicketPlan',
          input: {
            tickets: [{
              delegated: true, unitKey: 'alpha',
              workflowId: childWorkflowId,
              objective: `R3 missing alpha ${STAMP}`,
              workflowInput: { vendorId: 'vendor-alpha' },
              reason: 'delegated unit alpha'
            }],
            allowedWorkflowIds: [childWorkflowId],
            maxTickets: 5
          },
          next: 'await'
        },
        {
          id: 'await', action: 'awaitChildTickets',
          input: {
            parentBinding: 'self',
            parentWorkflowId: missingUnitParentId,
            spawnedByStepId: 'spawn-units',
            childWorkflowId,
            expectedUnits: ['alpha', 'ghost'],
            pollIntervalMs: 100,
            maxPollMs: 2000
          },
          saveAs: 'observed',
          next: 'done'
        },
        { id: 'done', action: 'stop', input: { result: {} } }
      ],
      postconditions: [{
        id: 'child-units-complete',
        type: 'childTerminalOutcome',
        parentBinding: 'self',
        parentWorkflowId: missingUnitParentId,
        spawnedByStepId: 'spawn-units',
        childWorkflowId,
        expectedUnits: ['alpha', 'ghost'],
        expect: { disposition: 'completed' }
      }]
    };

    const forgedParentId = `wf-r3-forged-${STAMP}`;
    const forgedParent = {
      id: forgedParentId,
      name: 'R3 parent with a forged completion claim in context',
      enabled: true,
      inputSchema: {},
      actions: [
        {
          id: 'await', action: 'awaitChildTickets',
          input: {
            parentBinding: 'self',
            parentWorkflowId: forgedParentId,
            spawnedByStepId: 'spawn-units',
            childWorkflowId,
            expectedUnits: ['ghost'],
            pollIntervalMs: 100,
            maxPollMs: 1000
          },
          saveAs: 'observed',
          next: 'forge'
        },
        {
          // The forged observation: static workflow context claiming every
          // expected unit settled. It is ordinary context and can never
          // authorize completion.
          id: 'forge', action: 'stop',
          input: {
            result: {
              allExpectedUnitsSettled: true,
              observedUnits: [{ unitKey: 'ghost', resolution: 'resolved', attemptDisposition: 'completed' }]
            }
          }
        }
      ],
      postconditions: [{
        id: 'child-units-complete',
        type: 'childTerminalOutcome',
        parentBinding: 'self',
        parentWorkflowId: forgedParentId,
        spawnedByStepId: 'spawn-units',
        childWorkflowId,
        expectedUnits: ['ghost'],
        expect: { disposition: 'completed' }
      }]
    };

    const failedChildParentId = `wf-r3-failedchild-${STAMP}`;
    const failedChildParent = {
      id: failedChildParentId,
      name: 'R3 parent whose delegated child fails',
      enabled: true,
      inputSchema: {},
      actions: [
        {
          id: 'spawn-units', action: 'executeTicketPlan',
          input: {
            tickets: [{
              delegated: true, unitKey: 'alpha',
              workflowId: failingChildWorkflowId,
              objective: `R3 failing alpha ${STAMP}`,
              workflowInput: {},
              reason: 'delegated unit alpha (failing child)'
            }],
            allowedWorkflowIds: [failingChildWorkflowId],
            maxTickets: 5
          },
          next: 'await'
        },
        {
          id: 'await', action: 'awaitChildTickets',
          input: {
            parentBinding: 'self',
            parentWorkflowId: failedChildParentId,
            spawnedByStepId: 'spawn-units',
            childWorkflowId: failingChildWorkflowId,
            expectedUnits: ['alpha'],
            pollIntervalMs: 100,
            maxPollMs: 30000
          },
          saveAs: 'observed',
          next: 'done'
        },
        { id: 'done', action: 'stop', input: { result: {} } }
      ],
      postconditions: [{
        id: 'child-units-complete',
        type: 'childTerminalOutcome',
        parentBinding: 'self',
        parentWorkflowId: failedChildParentId,
        spawnedByStepId: 'spawn-units',
        childWorkflowId: failingChildWorkflowId,
        expectedUnits: ['alpha'],
        expect: { disposition: 'completed' }
      }]
    };

    const rerunParentId = `wf-r3-rerun-${STAMP}`;
    const rerunParent = {
      id: rerunParentId,
      name: 'R3 parent rerun determinism',
      enabled: true,
      inputSchema: {},
      actions: [
        {
          id: 'spawn-units', action: 'executeTicketPlan',
          input: {
            tickets: [{
              delegated: true, unitKey: 'alpha',
              workflowId: childWorkflowId,
              objective: `R3 rerun alpha ${STAMP}`,
              workflowInput: { vendorId: 'vendor-alpha' },
              reason: 'delegated unit alpha'
            }],
            allowedWorkflowIds: [childWorkflowId],
            maxTickets: 5
          },
          next: 'await'
        },
        {
          id: 'await', action: 'awaitChildTickets',
          input: {
            parentBinding: 'self',
            parentWorkflowId: rerunParentId,
            spawnedByStepId: 'spawn-units',
            childWorkflowId,
            expectedUnits: ['alpha'],
            pollIntervalMs: 100,
            maxPollMs: 30000
          },
          saveAs: 'observed',
          next: 'done'
        },
        { id: 'done', action: 'stop', input: { result: {} } }
      ],
      postconditions: [{
        id: 'child-units-complete',
        type: 'childTerminalOutcome',
        parentBinding: 'self',
        parentWorkflowId: rerunParentId,
        spawnedByStepId: 'spawn-units',
        childWorkflowId,
        expectedUnits: ['alpha'],
        expect: { disposition: 'completed' }
      }]
    };

    // ── P + Q race parents (during-read current-attempt consistency). The
    //    FIRST run of each executes on the primary server against the normal
    //    stable state; the DURING-READ interleaving itself is coordinated on
    //    the dedicated race server (TEST_COMPOSITION_READ_ADVENT). The race
    //    criterion parent deliberately has NO observation step, so its
    //    criterion evaluation is the parent's ONLY composition read in the
    //    race server process — the interposition must fall inside it.
    const raceCriterionParentId = `wf-r3-race-criterion-${STAMP}`;
    const raceCriterionParent = {
      id: raceCriterionParentId,
      name: 'R3 race criterion parent (no observation step)',
      enabled: true,
      inputSchema: {},
      actions: [
        {
          id: 'spawn-units', action: 'executeTicketPlan',
          input: {
            tickets: [{
              delegated: true, unitKey: 'alpha',
              workflowId: childWorkflowId,
              objective: `R3 race alpha ${STAMP}`,
              workflowInput: { vendorId: 'vendor-race-alpha' },
              reason: 'delegated unit alpha (race criterion)'
            }],
            allowedWorkflowIds: [childWorkflowId],
            maxTickets: 5
          },
          next: 'done'
        },
        { id: 'done', action: 'stop', input: { result: {} } }
      ],
      postconditions: [{
        id: 'race-child-complete',
        type: 'childTerminalOutcome',
        parentBinding: 'self',
        parentWorkflowId: raceCriterionParentId,
        spawnedByStepId: 'spawn-units',
        childWorkflowId,
        expectedUnits: ['alpha'],
        expect: { disposition: 'completed' }
      }]
    };

    const raceObservationParentId = `wf-r3-race-observation-${STAMP}`;
    const raceObservationParent = {
      id: raceObservationParentId,
      name: 'R3 race observation parent (observation only, no criterion)',
      enabled: true,
      inputSchema: {},
      actions: [
        {
          id: 'spawn-units', action: 'executeTicketPlan',
          input: {
            tickets: [{
              delegated: true, unitKey: 'alpha',
              workflowId: childWorkflowId,
              objective: `R3 race observation alpha ${STAMP}`,
              workflowInput: { vendorId: 'vendor-race-observation' },
              reason: 'delegated unit alpha (race observation)'
            }],
            allowedWorkflowIds: [childWorkflowId],
            maxTickets: 5
          },
          next: 'await'
        },
        {
          id: 'await', action: 'awaitChildTickets',
          input: {
            parentBinding: 'self',
            parentWorkflowId: raceObservationParentId,
            spawnedByStepId: 'spawn-units',
            childWorkflowId,
            expectedUnits: ['alpha'],
            pollIntervalMs: 100,
            maxPollMs: 2000
          },
          saveAs: 'observed',
          next: 'check'
        },
        {
          id: 'check', action: 'condition',
          input: { value: '{{observed.allExpectedUnitsSettled}}', equals: true },
          trueNext: 'done', falseNext: 'witness'
        },
        { id: 'done', action: 'stop', input: { result: { observed: '{{observed.observedUnits}}' } } },
        // The witness branch keeps the racing observation's honest
        // non-success terminal instead of looping on an attempt the
        // test-pinned concurrency budget cannot advance.
        { id: 'witness', action: 'stop', input: { result: { observed: '{{observed.observedUnits}}' } } }
      ]
    };

    for (const definition of [parentWorkflow, noCriterionParent,
      heldParent, missingUnitParent, forgedParent, failedChildParent, rerunParent,
      raceCriterionParent, raceObservationParent]) {
      const response = await server.request('POST', '/admin/workflows', {
        cookie, form: { definition: JSON.stringify(definition, null, 2) }
      });
      assert(response.statusCode === 302 || response.statusCode === 200,
        `workflow ${definition.id} saved (HTTP ${response.statusCode})`);
    }

    // ── L. The await observation's authority is definition-authored
    // (UNITKEY-A at the real catalog seam): a template-derived expectedUnits
    // selector refuses at save — the runtime action sees only the RESOLVED
    // input and could never prove authorship. ────────────────────────────────
    scenariosRun += 1;
    {
      const templatedAwaitId = `wf-r3-templated-await-${STAMP}`;
      const templatedAwaitParent = {
        id: templatedAwaitId,
        name: 'R3 parent with a template-derived await unit authority',
        enabled: true,
        inputSchema: {},
        actions: [{
          id: 'await', action: 'awaitChildTickets',
          input: {
            parentBinding: 'self',
            parentWorkflowId: templatedAwaitId,
            spawnedByStepId: 'spawn-units',
            childWorkflowId,
            expectedUnits: ['{{plannedUnits}}']
          },
          next: 'done'
        }, { id: 'done', action: 'stop', input: { result: {} } }]
      };
      const refused = await server.request('POST', '/admin/workflows', {
        cookie, form: { definition: JSON.stringify(templatedAwaitParent, null, 2) }
      });
      assert(refused.statusCode === 400 && typeof refused.body === 'string' &&
        refused.body.includes('expectedUnits'),
        `L: a template-derived await expectedUnits refuses at the definition seam (HTTP ${refused.statusCode})`);
      const notCreated = await store.getWorkflowById(templatedAwaitId);
      assert(!notCreated || notCreated === null,
        'L: the refused definition was never durably created');
    }

    async function runWorkflow(label, workflowId, { executionPolicy, workflowInput } = {}) {
      scenariosRun += 1;
      const objective = `p5r3 ${label} ${STAMP}`;
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
      }, 240000, `${label} terminal run`);
      const replay = await waitFor(async () => {
        const record = await store.readRunReplay(terminal.id);
        return record && record.snapshot ? record.snapshot : null;
      }, 30000, `${label} replay snapshot`);
      return { ticket, run: terminal, replay };
    }

    const childrenOf = async parentTicketId =>
      (await store.listChildTickets({ parentTicketId, limit: 50 })).tickets || [];

    const eventsOf = async ticketId =>
      (await store.listTicketEvents(ticketId, { limit: 400 })).events || [];

    const awaitEventsOf = async ticketId =>
      (await eventsOf(ticketId)).filter(event => event.type === 'workflow.await_children');

    const runEventsOf = async runId =>
      (await store.listRunEvents(runId, { limit: 400 })) || [];

    const postconditionResultOf = async (parentRunId, postconditionId) => {
      const checked = (await runEventsOf(parentRunId)).find(event =>
        event && event.type === 'run.postconditions_checked') || null;
      const payload = checked && checked.payload ? checked.payload : null;
      const results = payload && Array.isArray(payload.results) ? payload.results : [];
      return results.find(result => result && (result.id === postconditionId ||
        result.type === 'childTerminalOutcome')) || null;
    };

    // ── A. End-to-end composition completion through the canonical evaluator.
    scenariosRun += 1;
    const e2e = await runWorkflow('e2e-complete', parentWorkflowId, {
      executionPolicy: { allowChildTickets: true, maxExecutionSteps: 64, maxRuntimeMs: 900000 }
    });
    assert(e2e.run.status === 'completed',
      `A: the composition parent completes through the criterion (${e2e.run.status}: ${e2e.run.error || ''})`);
    const e2eChildren = await childrenOf(e2e.ticket.id);
    assert(e2eChildren.length === 2, `A: exactly the two authored children exist (got ${e2eChildren.length})`);
    const e2eAlpha = e2eChildren.find(child => child.delegation && child.delegation.unitKey === 'alpha');
    const e2eBeta = e2eChildren.find(child => child.delegation && child.delegation.unitKey === 'beta');
    assert(Boolean(e2eAlpha) && Boolean(e2eBeta), 'A: both authored units resolved to their children');
    assert(e2eAlpha.spawnIdempotencyKey ===
      `ticket:${e2e.ticket.id}:${parentWorkflowId}:spawn-units:${childWorkflowId}:alpha` &&
      e2eBeta.spawnIdempotencyKey ===
        `ticket:${e2e.ticket.id}:${parentWorkflowId}:spawn-units:${childWorkflowId}:beta`,
      'A: the awaited children carry the canonical Ticket-stable delegated identity');
    for (const child of [e2eAlpha, e2eBeta]) {
      assert(child.status === 'completed', `A: child ${child.delegation.unitKey} is completed`);
      const attempts = (await store.listTicketAttempts({ ticketId: child.id, limit: 10 })).attempts;
      assert(attempts.length === 1 && attempts[0].disposition === 'completed',
        `A: child ${child.delegation.unitKey} has exactly one SETTLED completed attempt`);
    }
    const e2eCriterion = await postconditionResultOf(e2e.run.id, 'child-units-complete');
    assert(Boolean(e2eCriterion) && e2eCriterion.type === 'childTerminalOutcome' &&
      e2eCriterion.passed === true,
      'A: run.postconditions_checked carries the satisfied childTerminalOutcome result');
    assert(Array.isArray(e2eCriterion.actual.perUnit) && e2eCriterion.actual.perUnit.length === 2 &&
      e2eCriterion.actual.perUnit.every(entry =>
        entry.resolution === 'resolved' &&
        entry.attemptDisposition === 'completed' &&
        entry.truthDisposition === 'completed' &&
        entry.runTerminal === true),
      'A: the satisfied result exposes the deterministic per-unit current truth');
    const e2eConsequence = await store.getRunConsequence(e2e.run.id);
    assert(Boolean(e2eConsequence) && e2eConsequence.consequence.completionDecision,
      'A: the parent terminalization recorded the canonical consequence');
    const e2eDecision = e2eConsequence.consequence.completionDecision;
    assert(e2eDecision.completionDisposition === 'completed',
      'A: the completion decision is completed');
    const e2eDecisionEntry = (e2eDecision.evaluatedPostconditions || [])
      .find(entry => entry.type === 'childTerminalOutcome');
    assert(Boolean(e2eDecisionEntry) && e2eDecisionEntry.passed === true &&
      e2eDecisionEntry.authority === 'workflow_verification_event',
      'A: the hash-bound completion decision consumed the criterion through the existing evidence seam');
    // The await evidence is bounded and keyed by the authored unitKey (§18/§19).
    const e2eAwaitEvents = await awaitEventsOf(e2e.ticket.id);
    assert(e2eAwaitEvents.length >= 1,
      `A: workflow.await_children evidence exists (got ${e2eAwaitEvents.length})`);
    const e2eAwaitPayload = e2eAwaitEvents[e2eAwaitEvents.length - 1].payload;
    assert(Array.isArray(e2eAwaitPayload.observedUnits) &&
      e2eAwaitPayload.observedUnits.length === 2 &&
      e2eAwaitPayload.observedUnits.every(entry =>
        ['alpha', 'beta'].includes(entry.unitKey) &&
        typeof entry.spawnIdempotencyKey === 'string') &&
      e2eAwaitPayload.truncated === false &&
      e2eAwaitPayload.allExpectedUnitsSettled === true,
      'A: the await observation is the bounded per-unit structure keyed by authored unitKey');
    const e2eAwaitReplay = e2e.replay.workflowAwaitChildren || [];
    assert(e2eAwaitReplay.length === e2eAwaitEvents.length,
      'J: the replay carries exactly the awaited observation items (no extra transcript)');

    // ── B. Observation/completion separation (§28). ──────────────────────────
    scenariosRun += 1;
    // No childTerminalOutcome postcondition exists: the observation of a
    // HELD child must not create, block, or alter any completion authority.
    const separation = await runWorkflow('separation', noCriterionParentId, {
      executionPolicy: { allowChildTickets: false, maxExecutionSteps: 64, maxRuntimeMs: 900000 }
    });
    assert(separation.run.status === 'completed',
      `B: the parent completes exactly as the existing workflow doctrine completes it ` +
      `(${separation.run.status}: ${separation.run.error || ''})`);
    const separationChildren = await childrenOf(separation.ticket.id);
    assert(separationChildren.length === 1 && separationChildren[0].status === 'blocked' &&
      (await store.countTicketAttempts(separationChildren[0].id)) === 0,
      'B: the observed child remains HELD with zero attempts (observation admitted nothing)');
    const separationAwaitEvents = await awaitEventsOf(separation.ticket.id);
    assert(separationAwaitEvents.length >= 1 &&
      separationAwaitEvents.some(event => event.payload &&
        event.payload.allExpectedUnitsSettled === false &&
        Array.isArray(event.payload.observedUnits) &&
        event.payload.observedUnits[0].attemptState === 'none' &&
        event.payload.observedUnits[0].ticketState === 'blocked'),
      'B: the await observation honestly reports the held child (attempt none, ticket blocked)');
    const separationConsequence = await store.getRunConsequence(separation.run.id);
    assert(Boolean(separationConsequence) && separationConsequence.consequence.completionDecision,
      'B: the canonical decision exists');
    assert((separationConsequence.consequence.completionDecision.evaluatedPostconditions || []).length === 0,
      'B: NO child-outcome criterion entered the decision — observation has zero completion authority');
    assert(separationConsequence.consequence.completionDecision.completionDisposition === 'completed',
      'B: completion came from the existing workflow capability doctrine, unchanged by the observation');

    // ── C. Held children observed; criterion fails closed; no admission. ─────
    scenariosRun += 1;
    const held = await runWorkflow('held', heldParentId);
    assert(held.run.status === 'failed',
      `C: the authored criterion fails closed over held children (${held.run.status})`);
    const heldChildren = await childrenOf(held.ticket.id);
    assert(heldChildren.length === 1, 'C: exactly one held child exists');
    const heldChild = heldChildren[0];
    assert(heldChild.status === 'blocked' &&
      (await store.countTicketAttempts(heldChild.id)) === 0,
      'C: the child REMAINS held with zero attempts after observation AND evaluation');
    const { runs: heldChildRuns } = await store.listRunsForTicket({ ticketId: heldChild.id, limit: 10 });
    assert(heldChildRuns.length === 0, 'C: no child Run exists (no passive admission, no release)');
    const heldReleaseEvents = (await eventsOf(heldChild.id))
      .filter(event => event.type === 'ticket.updated' &&
        event.payload && event.payload.admissionIntent === 'delegated_release');
    assert(heldReleaseEvents.length === 0,
      'C: R3 never invoked delegated_release — consumption is not admission');
    const heldFailures = (await eventsOf(held.ticket.id))
      .filter(event => event.type === 'run.postcondition_failed');
    assert(heldFailures.length === 1 &&
      heldFailures[0].payload.postcondition.type === 'childTerminalOutcome' &&
      Array.isArray(heldFailures[0].payload.postcondition.actual.unsatisfiedReasons) &&
      heldFailures[0].payload.postcondition.actual.unsatisfiedReasons.some(reason =>
        reason.reason === 'CHILD_HAS_NO_ATTEMPT'),
      'C: the typed unsatisfied reason is the durable held state, never success');
    const heldAwaitEvents = await awaitEventsOf(held.ticket.id);
    assert(heldAwaitEvents.some(event => event.payload &&
      event.payload.observedUnits[0].resolution === 'resolved' &&
      event.payload.observedUnits[0].attemptState === 'none' &&
      event.payload.observedUnits[0].ticketState === 'blocked'),
      'C: the await observation reports the held child deterministically');

    // ── D. Failed child never satisfies a success-only criterion. ────────────
    scenariosRun += 1;
    const failedChild = await runWorkflow('failed-child', failedChildParentId, {
      executionPolicy: { allowChildTickets: true, maxExecutionSteps: 64, maxRuntimeMs: 900000 }
    });
    assert(failedChild.run.status === 'failed',
      `D: the parent fails when the authored child outcome is failure (${failedChild.run.status})`);
    const failedChildren = await childrenOf(failedChild.ticket.id);
    assert(failedChildren.length === 1, 'D: exactly one child exists');
    const failedAttempts = (await store.listTicketAttempts({ ticketId: failedChildren[0].id, limit: 10 })).attempts;
    assert(failedAttempts.length === 1 && failedAttempts[0].disposition === 'failed',
      'D: the child attempt settled failed through the canonical settlement');
    const failedFailures = (await eventsOf(failedChild.ticket.id))
      .filter(event => event.type === 'run.postcondition_failed');
    assert(failedFailures.length === 1 &&
      failedFailures[0].payload.postcondition.type === 'childTerminalOutcome' &&
      failedFailures[0].payload.postcondition.actual.unsatisfiedReasons.some(reason =>
        reason.reason === 'CHILD_TERMINAL_OUTCOME_UNACCEPTABLE') &&
      failedFailures[0].payload.postcondition.actual.perUnit[0].truthDisposition === 'failed',
      'D: terminal failure is a known negative with the typed truth, never satisfaction');

    // ── E. Missing expected child cannot succeed. ────────────────────────────
    scenariosRun += 1;
    const missing = await runWorkflow('missing-unit', missingUnitParentId, {
      executionPolicy: { allowChildTickets: true, maxExecutionSteps: 64, maxRuntimeMs: 900000 }
    });
    assert(missing.run.status === 'failed',
      `E: an authored expected unit that was never created fails the criterion (${missing.run.status})`);
    const missingChildren = await childrenOf(missing.ticket.id);
    assert(missingChildren.length === 1,
      'E: exactly the spawned child exists (the missing authored unit was never invented)');
    const missingFailures = (await eventsOf(missing.ticket.id))
      .filter(event => event.type === 'run.postcondition_failed');
    assert(missingFailures.length === 1 &&
      missingFailures[0].payload.postcondition.actual.unsatisfiedReasons.some(reason =>
        reason.unitKey === 'ghost' && reason.reason === 'CHILD_MISSING'),
      'E: the missing authored unit is reported as missing, never waived by the completed alpha');

    // ── F. Forged observation has zero completion authority. ─────────────────
    scenariosRun += 1;
    const forged = await runWorkflow('forged-observation', forgedParentId);
    assert(forged.run.status === 'failed',
      `F: forged context claiming completion cannot complete the parent (${forged.run.status})`);
    const forgedFailures = (await eventsOf(forged.ticket.id))
      .filter(event => event.type === 'run.postcondition_failed');
    assert(forgedFailures.length === 1 &&
      forgedFailures[0].payload.postcondition.actual.unsatisfiedReasons.some(reason =>
        reason.reason === 'CHILD_MISSING'),
      'F: the criterion re-read current durable facts and refused the forged claim');
    const forgedConsequence = await store.getRunConsequence(forged.run.id);
    assert(forgedConsequence.consequence.completionDecision.completionDisposition !== 'completed' &&
      (forgedConsequence.consequence.completionDecision.evaluatedPostconditions || [])
        .some(entry => entry.type === 'childTerminalOutcome' && entry.passed === false),
      'F: the hash-bound decision records the forged claim as an unsatisfied criterion');

    // ── G. Parent rerun determinism (CHILD-RERUN-A). ─────────────────────────
    scenariosRun += 1;
    const rerunFirst = await runWorkflow('rerun-first', rerunParentId, {
      executionPolicy: { allowChildTickets: true, maxExecutionSteps: 64, maxRuntimeMs: 900000 }
    });
    assert(rerunFirst.run.status === 'completed',
      `G: the first parent run completes (${rerunFirst.run.status}: ${rerunFirst.run.error || ''})`);
    const rerunChildren = await childrenOf(rerunFirst.ticket.id);
    assert(rerunChildren.length === 1, 'G: exactly one child exists after run 1');
    const rerunChild = rerunChildren[0];
    const rerunResponse = await server.request('POST', `/api/tickets/${rerunFirst.ticket.id}/rerun`, {
      cookie, form: { mode: 'retry' }
    });
    assert(rerunResponse.statusCode === 200 || rerunResponse.statusCode === 302,
      `G: the parent rerun is accepted (HTTP ${rerunResponse.statusCode})`);
    const rerunRun = await waitFor(async () => {
      const { runs } = await store.listRunsForTicket({ ticketId: rerunFirst.ticket.id, limit: 10 });
      const pending = runs.find(candidate =>
        ['pending', 'running'].includes(candidate.status) && candidate.id !== rerunFirst.run.id);
      return pending ? pending : null;
    }, 60000, 'G parent rerun run');
    const rerunTerminal = await waitFor(async () => {
      const current = await store.getRun(rerunRun.id);
      return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
    }, 240000, 'G parent rerun terminal');
    assert(rerunTerminal.status === 'completed',
      `G: the parent rerun resolves the same child and completes (${rerunTerminal.status}: ${rerunTerminal.error || ''})`);
    const childrenAfterRerun = await childrenOf(rerunFirst.ticket.id);
    assert(childrenAfterRerun.length === 1 && childrenAfterRerun[0].id === rerunChild.id,
      'G: the rerun resolves the SAME Ticket-stable child — no Run-scoped multiplication');
    const rerunAwaitEvents = (await awaitEventsOf(rerunFirst.ticket.id))
      .filter(event => event.runId === rerunTerminal.id);
    assert(rerunAwaitEvents.length >= 1 &&
      rerunAwaitEvents.every(event => event.payload.observedUnits[0].childTicketId === rerunChild.id),
      'G: the rerun await evidence observes the identical child ticket id');
    const rerunReplay = await store.readRunReplay(rerunTerminal.id);
    const rerunPlanEvidence = ((rerunReplay && rerunReplay.snapshot && rerunReplay.snapshot.workflowTicketPlans) || [])
      .find(item => item.stepId === 'spawn-units');
    assert(Boolean(rerunPlanEvidence) &&
      rerunPlanEvidence.spawnPlanId === `${rerunTerminal.id}:${rerunParentId}:spawn-units:transition:0` &&
      (rerunPlanEvidence.createdTickets || []).every(entry => entry.adopted === true),
      'G: the rerun plan evidence carries a NEW Run-scoped spawnPlanId while the unit identity stayed stable');
    const rerunCriterion = await postconditionResultOf(rerunTerminal.id, 'child-units-complete');
    assert(Boolean(rerunCriterion) && rerunCriterion.passed === true &&
      rerunCriterion.actual.perUnit[0].childTicketId === rerunChild.id,
      'G: the rerun criterion consumes the same durable child truth');
    const attemptsAfterRerun = (await store.listTicketAttempts({ ticketId: rerunChild.id, limit: 10 })).attempts;
    assert(attemptsAfterRerun.length === 1,
      `G: the child was never re-admitted by the rerun (got ${attemptsAfterRerun.length} attempts)`);

    // ── H + I. Durable corruption: ambiguous and incoherent children. ────────
    scenariosRun += 1;
    const corruptRuns = {};
    for (const [label, { parent }] of Object.entries(planted)) {
      const run = await waitFor(async () => {
        const { runs } = await store.listRunsForTicket({ ticketId: parent.id, limit: 10 });
        return runs[0] || null;
      }, 30000, `corrupt ${label} run dispatch`);
      const terminal = await waitFor(async () => {
        const current = await store.getRun(run.id);
        return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
      }, 240000, `corrupt ${label} terminal run`);
      corruptRuns[label] = terminal;
    }

    const ambiguousFailures = (await eventsOf(planted.ambiguous.parent.id))
      .filter(event => event.type === 'run.postcondition_failed');
    assert(ambiguousFailures.length === 1 &&
      ambiguousFailures[0].payload.postcondition.actual.unsatisfiedReasons.some(reason =>
        reason.reason === 'CHILD_AMBIGUOUS' && Array.isArray(reason.childTicketIds) &&
        reason.childTicketIds.length === 2),
      'H: two children claiming one authored unit refuse typed as ambiguous');
    assert(corruptRuns.ambiguous.status === 'failed',
      `H: the ambiguous criterion fails the parent closed (${corruptRuns.ambiguous.status})`);
    const ambiguousAwaitEvents = (await awaitEventsOf(planted.ambiguous.parent.id))
      .filter(event => event.runId === corruptRuns.ambiguous.id);
    assert(ambiguousAwaitEvents.length >= 1 &&
      ambiguousAwaitEvents[0].payload.observedUnits[0].resolution === 'ambiguous',
      'H: the observation honestly reports the ambiguous resolution');

    const uncoherentFailures = (await eventsOf(planted.uncoherent.parent.id))
      .filter(event => event.type === 'run.postcondition_failed');
    assert(uncoherentFailures.length === 1 &&
      uncoherentFailures[0].payload.postcondition.actual.unsatisfiedReasons.some(reason =>
        reason.reason === 'CHILD_PROVENANCE_UNCOHERENT'),
      'I: a claiming child with incoherent provenance refuses typed');
    assert(corruptRuns.uncoherent.status === 'failed',
      `I: the incoherent-provenance criterion fails the parent closed (${corruptRuns.uncoherent.status})`);

    // ── P + Q. During-read current-attempt consistency (§3/CHILD-RERUN-A). ───
    //
    // Setup: both race parents run their FIRST execution on the primary live
    // server against the ordinary stable state, so their delegated children
    // end with attempt A settled `completed`. The DURING-READ interleaving —
    // a canonical child rerun admitted BETWEEN the loader's initial
    // current-attempt read and its final consistency re-read — is coordinated
    // on a dedicated race server through the test-only
    // TEST_COMPOSITION_READ_ADVENT seam: the hook performs the production
    // child-rerun admission (the canonical operator rerun entry) exactly once
    // per race parent, inside the composition read. The concurrency budget is
    // pinned to one active run during the race window so the coordinated
    // newer attempt cannot be dispatched before the racing evaluation consumed
    // the changed generation — the assertions must never rely on scheduler
    // timing luck.
    scenariosRun += 1;
    const raceCriterion = await runWorkflow('race-criterion-initial', raceCriterionParentId, {
      executionPolicy: { allowChildTickets: true, maxExecutionSteps: 64, maxRuntimeMs: 900000 }
    });
    const raceCriterionChild = (await childrenOf(raceCriterion.ticket.id))[0];
    assert(Boolean(raceCriterionChild) && raceCriterionChild.workflowId === childWorkflowId,
      'P setup: the race criterion parent has exactly one delegated child');
    const raceCriterionChildAttempts = (await store.listTicketAttempts({
      ticketId: raceCriterionChild.id, limit: 10
    })).attempts;
    assert(raceCriterionChildAttempts.length === 1,
      `P setup: the race child has exactly attempt A (got ${raceCriterionChildAttempts.length})`);
    const raceObservation = await runWorkflow('race-observation-initial', raceObservationParentId, {
      executionPolicy: { allowChildTickets: true, maxExecutionSteps: 64, maxRuntimeMs: 900000 }
    });
    const raceObservationChild = (await childrenOf(raceObservation.ticket.id))[0];
    assert(Boolean(raceObservationChild) && raceObservationChild.workflowId === childWorkflowId,
      'P setup: the race observation parent has exactly one delegated child');
    for (const [label, childId] of [
      ['criterion', raceCriterionChild.id], ['observation', raceObservationChild.id]
    ]) {
      await waitFor(async () => {
        const attempts = (await store.listTicketAttempts({ ticketId: childId, limit: 10 })).attempts;
        return attempts.length === 1 && attempts[0].disposition === 'completed' ? attempts[0] : null;
      }, 60000, `race ${label} child attempt A settled completed`);
    }
    assert(raceObservation.run.status === 'completed',
      `P setup: the observation-only race parent run completes (${raceObservation.run.status}: ${raceObservation.run.error || ''})`);

    await server.stop();

    // Pin the concurrency budget to one active run for the race window: while
    // a race parent run holds its lease, the coordinated newer child attempt
    // stays admitted-but-unsettled, so the criterion's and observation's
    // assertions never depend on whether the scheduler dispatched it in time.
    const limitsBefore = await store.getRuntimeLimitsConfig();
    const raceLimitValues = {
      maxAttempts: limitsBefore.maxAttempts,
      maxExecutionSteps: limitsBefore.maxExecutionSteps,
      maxModelRequestsPerRun: limitsBefore.maxModelRequestsPerRun,
      maxWorkspaceOperationsPerRun: limitsBefore.maxWorkspaceOperationsPerRun,
      maxProcessOperationsPerRun: limitsBefore.maxProcessOperationsPerRun,
      maxBrowserOperationsPerRun: limitsBefore.maxBrowserOperationsPerRun,
      maxRuntimeDurationMs: limitsBefore.maxRuntimeDurationMs,
      maxOutputArtifactBytesPerRun: limitsBefore.maxOutputArtifactBytesPerRun,
      maxActiveRuns: 1,
      localModelConcurrency: limitsBefore.localModelConcurrency
    };
    await store.updateRuntimeLimitsConfig({
      expectedRevision: limitsBefore.revision,
      value: raceLimitValues,
      changedBy: 'p5-r3-composition-read-race'
    });

    const raceServer = await startServer({ env: {
      RUNTIME_SCHEDULER_INTERVAL_MS: '200',
      RUN_LEASE_DURATION_MS: '60000',
      TEST_COMPOSITION_READ_ADVENT: JSON.stringify({
        targets: [
          { parentTicketId: raceCriterion.ticket.id },
          { parentTicketId: raceObservation.ticket.id }
        ]
      })
    } });
    const raceCookie = await raceServer.login();

    // ── P. Criterion race: the child rerun admitted DURING fact loading ─────
    //    must never let superseded A satisfy childTerminalOutcome. ──────────
    scenariosRun += 1;
    // The observed durable state decides the gate path: a failed first run
    // may or may not carry a required ticket-level triage — resolve one only
    // when the rerun surface itself reports it.
    let criterionRerunAccepted = await raceServer.request('POST',
      `/api/tickets/${raceCriterion.ticket.id}/rerun`,
      { cookie: raceCookie, form: { mode: 'retry' } });
    if (criterionRerunAccepted.statusCode === 409 &&
        String(criterionRerunAccepted.body || '').toLowerCase().includes('triage')) {
      const triageResolved = await raceServer.request('POST',
        `/api/tickets/${raceCriterion.ticket.id}/triage/resolve`,
        { cookie: raceCookie, form: { resolution: 'race setup: the first evaluation observed the in-flight child attempt honestly' } });
      assert(triageResolved.statusCode === 200,
        `P setup: the race criterion ticket triage resolved (HTTP ${triageResolved.statusCode}: ${triageResolved.body})`);
      criterionRerunAccepted = await raceServer.request('POST',
        `/api/tickets/${raceCriterion.ticket.id}/rerun`,
        { cookie: raceCookie, form: { mode: 'retry' } });
    }
    assert(criterionRerunAccepted.statusCode === 200 || criterionRerunAccepted.statusCode === 302,
      `P: the criterion race rerun is accepted (HTTP ${criterionRerunAccepted.statusCode}: ${criterionRerunAccepted.body})`);
    const criterionRaceRun = await waitFor(async () => {
      const { runs } = await store.listRunsForTicket({ ticketId: raceCriterion.ticket.id, limit: 10 });
      const next = runs.find(candidate => candidate.id !== raceCriterion.run.id);
      return next ? next : null;
    }, 60000, 'P criterion race run');
    const criterionRaceTerminal = await waitFor(async () => {
      const current = await store.getRun(criterionRaceRun.id);
      return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
    }, 240000, 'P criterion race terminal run');
    assert(criterionRaceTerminal.status === 'failed',
      `P: the parent receives the typed deterministic non-success, never satisfaction through the superseded attempt (${criterionRaceTerminal.status}: ${criterionRaceTerminal.error || ''})`);
    const criterionRaceResult = await postconditionResultOf(criterionRaceTerminal.id, 'race-child-complete');
    assert(Boolean(criterionRaceResult) && criterionRaceResult.passed === false &&
      Array.isArray(criterionRaceResult.actual.unsatisfiedReasons) &&
      criterionRaceResult.actual.unsatisfiedReasons.some(reason =>
        reason.unitKey === 'alpha' &&
        reason.reason === 'CHILD_ATTEMPT_CHANGED_DURING_READ'),
      'P: the criterion refuses typed with CHILD_ATTEMPT_CHANGED_DURING_READ');
    assert(criterionRaceResult.actual.perUnit.length === 1 &&
      criterionRaceResult.actual.perUnit[0].childTicketId === raceCriterionChild.id &&
      criterionRaceResult.actual.perUnit[0].attemptStability === 'CHILD_ATTEMPT_CHANGED_DURING_READ' &&
      criterionRaceResult.actual.perUnit[0].runTerminal === null &&
      criterionRaceResult.actual.perUnit[0].truthDisposition === null,
      'P: the superseded attempt is never reported as current terminal truth (no member completion authority is claimed)');
    const criterionRaceConsequence = await store.getRunConsequence(criterionRaceTerminal.id);
    assert(criterionRaceConsequence.consequence &&
      criterionRaceConsequence.consequence.completionDecision &&
      criterionRaceConsequence.consequence.completionDecision.completionDisposition !== 'completed' &&
      (criterionRaceConsequence.consequence.completionDecision.evaluatedPostconditions || [])
        .some(entry => entry && entry.type === 'childTerminalOutcome' && entry.passed === false),
      'P: the hash-bound completion decision records the during-read change as an unsatisfied criterion');
    const criterionRaceAttempts = (await store.listTicketAttempts({
      ticketId: raceCriterionChild.id, limit: 10
    })).attempts;
    assert(criterionRaceAttempts.length === 2 &&
      criterionRaceAttempts[0].ordinal === 1 && criterionRaceAttempts[0].disposition === 'completed' &&
      criterionRaceAttempts[1].ordinal === 2 && criterionRaceAttempts[1].id !== criterionRaceAttempts[0].id,
      'P: the coordinated child rerun created exactly the newer attempt B (ordinal 2)');
    const criterionRaceCurrent = await store.getCurrentTicketAttempt(raceCriterionChild.id);
    assert(criterionRaceCurrent && criterionRaceCurrent.ordinal === 2,
      'P: the newer attempt B is now the child\'s canonical current attempt');
    const criterionRaceReleases = (await eventsOf(raceCriterionChild.id))
      .filter(event => event.type === 'ticket.updated' &&
        event.payload && event.payload.admissionIntent === 'delegated_release');
    assert(criterionRaceReleases.length === 1,
      `P: the racing loader performed no release/admission of its own (delegated_release count ${criterionRaceReleases.length})`);
    // The coordinated child rerun eventually executes; it must add NO further
    // attempt — the child's generation moved exactly once.
    const criterionRaceChildRerunTerminal = await waitFor(async () => {
      const { runs } = await store.listRunsForTicket({ ticketId: raceCriterionChild.id, limit: 10 });
      const rerun = runs.find(candidate => candidate.ticketAttemptId === criterionRaceAttempts[1].id) || null;
      if (!rerun) return null;
      const current = await store.getRun(rerun.id);
      return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
    }, 120000, 'P coordinated child rerun terminal');
    assert(criterionRaceChildRerunTerminal.status === 'completed',
      `P: the child rerun settles through its own canonical lifecycle (${criterionRaceChildRerunTerminal.status})`);
    const criterionRaceAttemptsAfter = (await store.listTicketAttempts({
      ticketId: raceCriterionChild.id, limit: 10
    })).attempts;
    assert(criterionRaceAttemptsAfter.length === 2,
      `P: the child's attempt generation moved exactly once (got ${criterionRaceAttemptsAfter.length})`);

    // ── Q. Observation race: the same during-read change encountered by ─────
    //    awaitChildTickets keeps the observation nonterminal and the ────────
    //    superseded attempt's settled truth out of the observation. ─────────
    scenariosRun += 1;
    const observationRerunAccepted = await raceServer.request('POST',
      `/api/tickets/${raceObservation.ticket.id}/rerun`,
      { cookie: raceCookie, form: { mode: 'retry' } });
    assert(observationRerunAccepted.statusCode === 200 || observationRerunAccepted.statusCode === 302,
      `Q: the observation race rerun is accepted (HTTP ${observationRerunAccepted.statusCode})`);
    const observationRaceRun = await waitFor(async () => {
      const { runs } = await store.listRunsForTicket({ ticketId: raceObservation.ticket.id, limit: 10 });
      const next = runs.find(candidate => candidate.id !== raceObservation.run.id);
      return next ? next : null;
    }, 60000, 'Q observation race run');
    const observationRaceTerminal = await waitFor(async () => {
      const current = await store.getRun(observationRaceRun.id);
      return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
    }, 240000, 'Q observation race terminal run');
    assert(observationRaceTerminal.status === 'completed',
      `Q: the observation-only race parent run completes honestly through the witness branch (${observationRaceTerminal.status}: ${observationRaceTerminal.error || ''})`);
    const observationRaceAwaitEvents = (await awaitEventsOf(raceObservation.ticket.id))
      .filter(event => event.runId === observationRaceTerminal.id);
    assert(observationRaceAwaitEvents.length === 1 && observationRaceAwaitEvents[0].payload &&
      Array.isArray(observationRaceAwaitEvents[0].payload.observedUnits) &&
      observationRaceAwaitEvents[0].payload.observedUnits.length === 1,
      `Q: the racing observation recorded exactly one bounded await observation (got ${observationRaceAwaitEvents.length})`);
    const observationRaceEntry = observationRaceAwaitEvents[0].payload.observedUnits[0];
    assert(observationRaceAwaitEvents[0].payload.allExpectedUnitsSettled === false &&
      observationRaceEntry.resolution === 'resolved' &&
      observationRaceEntry.childTicketId === raceObservationChild.id &&
      observationRaceEntry.attemptState === 'unsettled' &&
      observationRaceEntry.attemptDisposition === null &&
      observationRaceEntry.runTerminal === null &&
      observationRaceEntry.completionDisposition === null &&
      observationRaceEntry.completionReasonCode === null &&
      observationRaceEntry.attemptStability === 'STABLE',
      'Q: the observation reports the unsettled CURRENT attempt and never surfaces the superseded attempt\'s settled truth');
    const observationRaceChecked = (await runEventsOf(observationRaceTerminal.id))
      .some(event => event && event.type === 'run.postconditions_checked');
    assert(observationRaceChecked === false,
      'Q: the observation carries zero completion authority and the parent has no criterion to satisfy');
    const observationRaceAttempts = (await store.listTicketAttempts({
      ticketId: raceObservationChild.id, limit: 10
    })).attempts;
    assert(observationRaceAttempts.length === 2 &&
      observationRaceAttempts[0].ordinal === 1 && observationRaceAttempts[0].disposition === 'completed' &&
      observationRaceAttempts[1].ordinal === 2,
      `Q: the observation performed no child admission of its own — exactly the canonical attempt A plus the coordinated attempt B (got ${observationRaceAttempts.length})`);
    const observationRaceCurrent = await store.getCurrentTicketAttempt(raceObservationChild.id);
    assert(observationRaceCurrent && observationRaceCurrent.ordinal === 2,
      'Q: the coordinated newer attempt is the canonical current attempt; the racing evaluation window itself saw it unsettled');
    const observationRaceReleases = (await eventsOf(raceObservationChild.id))
      .filter(event => event.type === 'ticket.updated' &&
        event.payload && event.payload.admissionIntent === 'delegated_release');
    assert(observationRaceReleases.length === 1,
      `Q: the racing observation performed no release/admission of its own (delegated_release count ${observationRaceReleases.length})`);

    // Restore the pinned concurrency budget before the static authority
    // assertions; the coordinated attempt's later lifecycle belongs to
    // ordinary runtime evolution, not to the racing evaluation.
    const limitsCapped = await store.getRuntimeLimitsConfig();
    await store.updateRuntimeLimitsConfig({
      expectedRevision: limitsCapped.revision,
      value: { ...raceLimitValues, maxActiveRuns: limitsBefore.maxActiveRuns },
      changedBy: 'p5-r3-composition-read-race'
    });

    // ── K. Repository authority untouched. ───────────────────────────────────
    scenariosRun += 1;
    const migrationFiles = fs.readdirSync(path.join(ROOT, 'persistence/postgres/migrations'))
      .filter(name => name.endsWith('.sql')).sort();
    assert(!migrationFiles.some(name => name.startsWith('045')),
      'K: no new migration was created (045 does not exist)');
    assert(migrationFiles.includes('044_browser_interaction_authority.sql'),
      'K: migration 044 file remains untouched in the repository');
    const authorization = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'config/migration-execution-authorization.json'), 'utf8'));
    assert(authorization.authorizationState === 'NOT_AUTHORIZED',
      'K: the migration-execution authorization record remains NOT_AUTHORIZED');

    await assertScenariosExecuted({
      label: 'p5-r3-composition-consumption-postgres-test.js',
      assertions: assert.count(),
      scenarios: scenariosRun,
      minAssertions: 95,
      minScenarios: 12
    });
    console.log(`\nPASS: P5-R3 composition consumption — ${scenariosRun} scenarios, ${assert.count()} assertions (PostgreSQL-native)`);
  }, { schemaSlug: 'p5_r3_composition_consumption' });
}

main().catch(error => {
  console.error(`\nFAIL: P5-R3 composition consumption — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
