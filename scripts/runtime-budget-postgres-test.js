#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const {
  PostgresRuntimeStore
} = require('../persistence/postgres/store');
const {
  RuntimeBudgetError,
  buildRuntimeBudgetSnapshot
} = require('../runtime/runtime-budget-contract');
const { verifyCurrentRunEventChain } = require('../runtime/event-integrity');
const {
  withHarness,
  createAsserter,
  sleep
} = require('./postgres-test-harness');

const check = createAsserter();
const SHA = 'a'.repeat(64);

const defaults = Object.freeze({
  maxAttempts: 4,
  maxExecutionSteps: 4,
  maxModelRequestsPerRun: 4,
  maxWorkspaceOperationsPerRun: 4,
  maxProcessOperationsPerRun: 2,
  maxBrowserOperationsPerRun: 4,
  maxRuntimeDurationMs: 120_000,
  maxOutputArtifactBytesPerRun: 100,
  revision: 1
});

function policy(overrides = {}) {
  return {
    mode: 'assisted',
    requireVerification: 'when_declared',
    autoRetry: false,
    maxAttempts: null,
    maxExecutionSteps: null,
    maxRuntimeMs: null,
    maxModelRequests: null,
    maxWorkspaceOperations: null,
    maxProcessOperations: null,
    maxBrowserOperations: null,
    maxOutputArtifactBytes: null,
    allowWorkspaceWrites: true,
    allowParallelRuns: true,
    allowChildTickets: false,
    workspaceScope: 'shared',
    ...overrides
  };
}

function budget(overrides = {}) {
  return buildRuntimeBudgetSnapshot({
    runtimeLimits: { ...defaults, ...(overrides.runtimeLimits || {}) },
    executionPolicy: policy(overrides.executionPolicy)
  });
}

async function createAgent(store, label, provider = 'openai') {
  return (await store.createConfiguredAgent({
    value: {
      name: `${label} ${Date.now()} ${Math.random().toString(16).slice(2)}`,
      provider,
      model: 'gpt-test',
      apiKey: ''
    },
    groupIds: [],
    changedBy: 'runtime-budget-postgres-test'
  })).agent;
}

async function createTicket(store, agent, label) {
  return (await store.createTicketWithEvent({
    ticket: {
      objective: 'Fixture requested outcome',
      status: 'open',
      title: label,
      assignmentTargetType: 'agent',
      assignmentTargetId: agent.id,
      assignmentMode: 'individual'
    }
  })).ticket;
}

async function createRun(store, ticket, agent, snapshot = budget(), body = {}) {
  return store.createRun({
    ticketId: ticket.id,
    agentId: agent.id,
    status: 'pending',
    executionMode: 'agent',
    runtimeBudgetSnapshot: snapshot,
    ...body
  });
}

async function claim(store, run, owner, duration = 30_000) {
  const result = await store.claimPendingRun({
    leaseOwner: owner,
    leaseDurationMs: duration,
    eligibleRunIds: [run.id],
    claimPayload: { source: 'runtime-budget-postgres-test' }
  });
  return result && result.run;
}

async function setSchedulerLimits(store, overrides) {
  const current = await store.getRuntimeLimitsConfig();
  return (await store.updateRuntimeLimitsConfig({
    expectedRevision: current.revision,
    value: {
      maxAttempts: current.maxAttempts,
      maxExecutionSteps: current.maxExecutionSteps,
      maxModelRequestsPerRun: current.maxModelRequestsPerRun,
      maxWorkspaceOperationsPerRun: current.maxWorkspaceOperationsPerRun,
      maxProcessOperationsPerRun: current.maxProcessOperationsPerRun,
      maxBrowserOperationsPerRun: current.maxBrowserOperationsPerRun,
      maxRuntimeDurationMs: current.maxRuntimeDurationMs,
      maxOutputArtifactBytesPerRun: current.maxOutputArtifactBytesPerRun,
      maxActiveRuns: current.maxActiveRuns,
      localModelConcurrency: current.localModelConcurrency,
      ...overrides
    },
    changedBy: 'runtime-budget-postgres-test'
  })).config;
}

async function main() {
  await withHarness('runtime budget and capacity PostgreSQL', async ({
    store,
    databaseUrl,
    schema
  }) => {
    const peer = new PostgresRuntimeStore({
      connectionString: databaseUrl,
      schema,
      lockTimeoutMs: 5_000,
      defaultMaxActiveRuns: 32,
      defaultLocalModelConcurrency: 8
    });
    try {
      const agent = await createAgent(store, 'Budget agent');
      const ticket = await createTicket(store, agent, 'Budget authority');
      const snapshot = budget();
      const run = await createRun(store, ticket, agent, snapshot);

      check(await store.isRuntimeBudgetSchemaAvailable(),
        'migration exposes the canonical runtime budget schema');
      check((await store.getRun(run.id)).runtimeBudgetSnapshot.snapshotHash ===
        snapshot.snapshotHash,
      'the immutable effective budget snapshot survives PostgreSQL round-trip');

      const exactRace = await Promise.all([
        store.reserveRunBudget({
          runId: run.id,
          dimension: 'model_request',
          sourceIdentity: 'model-request:agent:0:provider',
          amount: 1
        }),
        peer.reserveRunBudget({
          runId: run.id,
          dimension: 'model_request',
          sourceIdentity: 'model-request:agent:0:provider',
          amount: 1
        })
      ]);
      check(exactRace.filter(item => item.inserted).length === 1,
        'concurrent exact reservation creates one durable charge');
      const committedRace = await Promise.all([
        store.commitRunBudget({
          runId: run.id,
          dimension: 'model_request',
          sourceIdentity: 'model-request:agent:0:provider',
          amount: 1
        }),
        peer.commitRunBudget({
          runId: run.id,
          dimension: 'model_request',
          sourceIdentity: 'model-request:agent:0:provider',
          amount: 1
        })
      ]);
      check(committedRace.filter(item => item.committed).length === 1,
        'concurrent exact charge commits once');

      await store.reserveRunBudget({
        runId: run.id,
        dimension: 'workspace_operation',
        sourceIdentity: 'workspace-operation:abandoned',
        amount: 1
      });
      await store.releaseRunBudget({
        runId: run.id,
        dimension: 'workspace_operation',
        sourceIdentity: 'workspace-operation:abandoned',
        reason: 'no durable receipt'
      });
      const releasedReplay = await peer.releaseRunBudget({
        runId: run.id,
        dimension: 'workspace_operation',
        sourceIdentity: 'workspace-operation:abandoned',
        reason: 'no durable receipt'
      });
      check(releasedReplay.released === false &&
        releasedReplay.charge.state === 'released',
      'abandoned reservation release is forward-only and idempotent');
      await assert.rejects(
        peer.reserveRunBudget({
          runId: run.id,
          dimension: 'workspace_operation',
          sourceIdentity: 'workspace-operation:abandoned',
          amount: 1
        }),
        error => error instanceof RuntimeBudgetError &&
          error.code === 'RUN_BUDGET_RECONCILIATION_FAILED'
      );
      check(true, 'a released canonical source identity cannot authorize a later side effect');

      await store.reserveRunBudget({
        runId: run.id,
        dimension: 'output_artifact_bytes',
        sourceIdentity: 'process-artifacts:test',
        amount: 100
      });
      await store.commitRunBudget({
        runId: run.id,
        dimension: 'output_artifact_bytes',
        sourceIdentity: 'process-artifacts:test',
        amount: 10
      });
      const state = await store.getRunBudgetState(run.id);
      check(state.usage.output_artifact_bytes.committed === 10 &&
        state.usage.output_artifact_bytes.reserved === 0 &&
        state.usage.output_artifact_bytes.remaining === 90,
      'artifact reservation commits raw published bytes and releases unused authority');

      const oneModel = budget({
        executionPolicy: { maxModelRequests: 1 }
      });
      const exhaustionTicket = await createTicket(store, agent, 'Budget exhaustion');
      const exhaustionRun = await createRun(store, exhaustionTicket, agent, oneModel);
      const oversubscription = await Promise.allSettled([
        store.reserveRunBudget({
          runId: exhaustionRun.id,
          dimension: 'model_request',
          sourceIdentity: 'model-request:first',
          amount: 1
        }),
        peer.reserveRunBudget({
          runId: exhaustionRun.id,
          dimension: 'model_request',
          sourceIdentity: 'model-request:second',
          amount: 1
        })
      ]);
      check(oversubscription.filter(result => result.status === 'fulfilled').length === 1 &&
        oversubscription.filter(result => result.status === 'rejected').every(result =>
          result.reason instanceof RuntimeBudgetError &&
          result.reason.code === 'RUN_BUDGET_EXHAUSTED'),
      'concurrent runtime instances cannot oversubscribe one run budget');

      const dimensionPolicies = {
        execution_step: 'maxExecutionSteps',
        model_request: 'maxModelRequests',
        workspace_operation: 'maxWorkspaceOperations',
        process_operation: 'maxProcessOperations',
        browser_operation: 'maxBrowserOperations',
        output_artifact_bytes: 'maxOutputArtifactBytes'
      };
      for (const [dimension, policyField] of Object.entries(dimensionPolicies)) {
        const boundaryTicket = await createTicket(store, agent, `Boundary ${dimension}`);
        const boundaryRun = await createRun(store, boundaryTicket, agent, budget({
          executionPolicy: { [policyField]: 1 }
        }));
        await store.reserveRunBudget({
          runId: boundaryRun.id,
          dimension,
          sourceIdentity: `${dimension}:exact`,
          amount: 1
        });
        await store.commitRunBudget({
          runId: boundaryRun.id,
          dimension,
          sourceIdentity: `${dimension}:exact`,
          amount: 1
        });
        await assert.rejects(
          peer.reserveRunBudget({
            runId: boundaryRun.id,
            dimension,
            sourceIdentity: `${dimension}:maximum-plus-one`,
            amount: 1
          }),
          error => error instanceof RuntimeBudgetError &&
            error.code === 'RUN_BUDGET_EXHAUSTED'
        );
        check(true, `${dimension} accepts its exact maximum and rejects maximum-plus-one`);
      }

      await assert.rejects(
        store.pool.query(
          `DELETE FROM ${store.table('run_budget_charges')} WHERE run_id = $1`,
          [run.id]
        ),
        error => error && error.code === 'P0001'
      );
      check(true, 'database trigger rejects deletion of durable budget authority');

      // The optimized boundaries below deliberately keep all of the original
      // durable facts. Their contract is stronger than lower transaction count:
      // an internal failure must expose either the whole authority bundle or
      // none of it, and replay must not manufacture another charge or effect.
      const boundaryTicket = await createTicket(store, agent, 'Atomic budget boundaries');
      const boundaryRun = await createRun(store, boundaryTicket, agent, budget({
        runtimeLimits: {
          maxExecutionSteps: 8,
          maxModelRequestsPerRun: 8,
          maxWorkspaceOperationsPerRun: 8
        }
      }));
      const boundaryOwner = 'atomic-budget-worker';
      const boundaryClaim = await claim(store, boundaryRun, boundaryOwner);
      await store.transitionRun({
        runId: boundaryRun.id,
        expectedRevision: boundaryClaim.revision,
        fromStatuses: ['pending'],
        toStatus: 'running',
        leaseOwner: boundaryOwner,
        eventType: 'run.started'
      });
      await store.writeReplaySnapshot({
        runId: boundaryRun.id,
        snapshot: {
          version: 1,
          providerRequests: [],
          workspaceOperations: []
        }
      });

      const requestEvidence = {
        runId: boundaryRun.id,
        ticketId: boundaryTicket.id,
        evidenceKey: 'provider-request:atomic-boundary',
        replayKey: 'providerRequests',
        replayItem: {
          evidenceKey: 'provider-request:atomic-boundary',
          requestIdentity: 'atomic-boundary'
        },
        event: {
          type: 'provider.request.persisted',
          payload: { requestIdentity: 'atomic-boundary' }
        }
      };
      const rollbackRequestBudget = {
        runId: boundaryRun.id,
        dimension: 'model_request',
        sourceIdentity: 'model-request:rollback-boundary',
        amount: 1
      };
      const originalAppendRunEvidence = store.appendRunEvidence;
      store.appendRunEvidence = async () => {
        throw new Error('injected provider-request evidence failure');
      };
      try {
        await assert.rejects(
          store.appendRunEvidenceWithRunBudgetCharge({
            budget: rollbackRequestBudget,
            evidence: requestEvidence
          }),
          /injected provider-request evidence failure/
        );
      } finally {
        store.appendRunEvidence = originalAppendRunEvidence;
      }
      check(!(await store.listRunBudgetCharges(boundaryRun.id)).some(charge =>
        charge.sourceIdentity === rollbackRequestBudget.sourceIdentity) &&
        !(await store.readRunReplay(boundaryRun.id)).snapshot.providerRequests.length,
      'request-evidence failure rolls back its reservation and replay projection');

      const requestBudget = {
        ...rollbackRequestBudget,
        sourceIdentity: 'model-request:atomic-boundary'
      };
      await store.appendRunEvidenceWithRunBudgetCharge({
        budget: requestBudget,
        evidence: requestEvidence
      });
      await store.appendRunEvidenceWithRunBudgetCharge({
        budget: requestBudget,
        evidence: requestEvidence
      });
      let boundaryCharges = await store.listRunBudgetCharges(boundaryRun.id);
      let boundaryEvents = await store.listRunEvents(boundaryRun.id);
      check(boundaryCharges.filter(charge =>
        charge.sourceIdentity === requestBudget.sourceIdentity &&
        charge.state === 'committed').length === 1 &&
        boundaryEvents.filter(event =>
          event.type === 'provider.request.persisted' &&
          event.payload.evidenceKey === requestEvidence.evidenceKey).length === 1,
      'request authority replay preserves one committed charge and one durable request');

      const rollbackStepBudget = {
        runId: boundaryRun.id,
        dimension: 'execution_step',
        sourceIdentity: 'execution-step:rollback-boundary',
        amount: 1
      };
      const originalHeartbeatRunLease = store.heartbeatRunLease;
      store.heartbeatRunLease = async () => {
        throw new Error('injected heartbeat failure after charge');
      };
      try {
        await assert.rejects(
          store.heartbeatRunLeaseWithRunBudgetCharge({
            budget: rollbackStepBudget,
            heartbeat: {
              runId: boundaryRun.id,
              leaseOwner: boundaryOwner,
              leaseDurationMs: 30_000,
              payload: { phase: 'injected' }
            }
          }),
          /injected heartbeat failure after charge/
        );
      } finally {
        store.heartbeatRunLease = originalHeartbeatRunLease;
      }
      check(!(await store.listRunBudgetCharges(boundaryRun.id)).some(charge =>
        charge.sourceIdentity === rollbackStepBudget.sourceIdentity),
      'heartbeat failure rolls back the execution charge before product action');

      const stepBudget = {
        ...rollbackStepBudget,
        sourceIdentity: 'execution-step:atomic-boundary'
      };
      await store.heartbeatRunLeaseWithRunBudgetCharge({
        budget: stepBudget,
        heartbeat: {
          runId: boundaryRun.id,
          leaseOwner: boundaryOwner,
          leaseDurationMs: 30_000,
          payload: { phase: 'before-action' }
        }
      });
      boundaryCharges = await store.listRunBudgetCharges(boundaryRun.id);
      check(boundaryCharges.filter(charge =>
        charge.sourceIdentity === stepBudget.sourceIdentity &&
        charge.state === 'committed').length === 1,
      'execution charge and renewed lease are durable before the next product action');

      const operationKey = `run:${boundaryRun.id}:atomic-workspace-boundary`;
      const workspaceBudget = {
        runId: boundaryRun.id,
        dimension: 'workspace_operation',
        sourceIdentity: operationKey,
        amount: 1
      };
      const operationIntent = {
        runId: boundaryRun.id,
        ticketId: boundaryTicket.id,
        operationKey,
        stepId: '0',
        leaseOwner: boundaryOwner,
        identity: { executionTurn: 0, planKey: 'atomic-plan', actionIndex: 0 },
        intent: {
          operation: 'writeFile',
          args: { path: 'atomic/report.txt', content: 'ready' },
          preState: { existed: false },
          authorityDecision: { status: 'allowed' },
          target: {
            targetId: 'local-workspace',
            targetKind: 'localWorkspace',
            targetPath: 'atomic/report.txt',
            targetResourceId: 'atomic/report.txt'
          }
        }
      };
      const originalPrepareTargetOperation = store.prepareTargetOperation;
      store.prepareTargetOperation = async () => {
        throw new Error('injected prepared-intent failure');
      };
      try {
        await assert.rejects(
          store.prepareTargetOperationWithRunBudgetReservation({
            budget: workspaceBudget,
            operation: operationIntent
          }),
          /injected prepared-intent failure/
        );
      } finally {
        store.prepareTargetOperation = originalPrepareTargetOperation;
      }
      check(!(await store.listRunBudgetCharges(boundaryRun.id)).some(charge =>
        charge.sourceIdentity === workspaceBudget.sourceIdentity) &&
        !(await store.getTargetOperation(boundaryRun.id, operationKey)).intent,
      'prepared-intent failure leaves neither workspace authority nor intent');

      await store.prepareTargetOperationWithRunBudgetReservation({
        budget: workspaceBudget,
        operation: operationIntent
      });
      let workspaceState = await store.getTargetOperation(boundaryRun.id, operationKey);
      boundaryCharges = await store.listRunBudgetCharges(boundaryRun.id);
      check(Boolean(workspaceState.intent) && !workspaceState.receipt &&
        boundaryCharges.some(charge =>
          charge.sourceIdentity === workspaceBudget.sourceIdentity &&
          charge.state === 'reserved'),
      'crash after target effect retains its prepared intent and reserved charge for recovery');

      const operationCompletion = {
        runId: boundaryRun.id,
        ticketId: boundaryTicket.id,
        operationKey,
        historyRecord: {
          operation: 'writeFile',
          args: operationIntent.intent.args,
          outcome: 'succeeded'
        },
        receipt: {
          operation: 'writeFile',
          targetId: 'local-workspace',
          targetKind: 'localWorkspace',
          targetPath: 'atomic/report.txt',
          targetResourceId: 'atomic/report.txt',
          providerResponse: { path: 'atomic/report.txt', size: 5 }
        },
        replayItem: {
          operation: { operation: 'writeFile', args: operationIntent.intent.args },
          result: { path: 'atomic/report.txt', size: 5 }
        },
        event: {
          type: 'workspace.operation',
          stepId: '0',
          payload: { operation: 'writeFile', path: 'atomic/report.txt', mutating: true }
        }
      };
      const originalCommitRunBudget = store.commitRunBudget;
      store.commitRunBudget = async () => {
        throw new Error('injected charge-commit failure after receipt');
      };
      try {
        await assert.rejects(
          store.completeTargetOperationWithRunBudgetCommit({
            budget: workspaceBudget,
            operation: operationCompletion
          }),
          /injected charge-commit failure after receipt/
        );
      } finally {
        store.commitRunBudget = originalCommitRunBudget;
      }
      workspaceState = await store.getTargetOperation(boundaryRun.id, operationKey);
      boundaryCharges = await store.listRunBudgetCharges(boundaryRun.id);
      check(!workspaceState.receipt && boundaryCharges.some(charge =>
        charge.sourceIdentity === workspaceBudget.sourceIdentity &&
        charge.state === 'reserved'),
      'receipt/evidence rolls back if its required workspace charge cannot commit');

      await store.completeTargetOperationWithRunBudgetCommit({
        budget: workspaceBudget,
        operation: operationCompletion
      });
      await store.completeTargetOperationWithRunBudgetCommit({
        budget: workspaceBudget,
        operation: operationCompletion
      });
      workspaceState = await store.getTargetOperation(boundaryRun.id, operationKey);
      boundaryCharges = await store.listRunBudgetCharges(boundaryRun.id);
      boundaryEvents = await store.listRunEvents(boundaryRun.id);
      check(Boolean(workspaceState.receipt) &&
        boundaryCharges.filter(charge =>
          charge.sourceIdentity === workspaceBudget.sourceIdentity &&
          charge.state === 'committed').length === 1 &&
        boundaryEvents.filter(event =>
          event.type === 'workspace.operation' &&
          event.payload.operationKey === operationKey).length === 1,
      'workspace recovery records one receipt, one charge, and no duplicate operation');
      check(verifyCurrentRunEventChain(boundaryEvents).chainValid,
        'co-transactional budget and product facts preserve the Run event chain');
      await store.releaseRunLease({
        runId: boundaryRun.id,
        leaseOwner: boundaryOwner,
        payload: { reason: 'atomic boundary test complete' }
      });

      await setSchedulerLimits(store, {
        maxActiveRuns: 1,
        localModelConcurrency: 8
      });
      const globalTicketOne = await createTicket(store, agent, 'Global capacity one');
      const globalTicketTwo = await createTicket(store, agent, 'Global capacity two');
      const globalRunOne = await createRun(store, globalTicketOne, agent);
      const globalRunTwo = await createRun(store, globalTicketTwo, agent);
      const sameRunRace = await Promise.all([
        claim(store, globalRunOne, 'global-runtime-one'),
        claim(peer, globalRunOne, 'global-runtime-two')
      ]);
      check(sameRunRace.filter(Boolean).length === 1,
        'two runtime instances cannot acquire the same run concurrently');
      check((await claim(peer, globalRunTwo, 'global-runtime-two')) === null,
        'global active-run capacity cannot be oversubscribed across instances');
      await store.pool.query(
        `UPDATE ${store.table('runs')}
         SET lease_expires_at = clock_timestamp() - interval '1 second',
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [globalRunOne.id]
      );
      check(Boolean(await claim(peer, globalRunTwo, 'global-runtime-two')),
        'expired global capacity ownership is reclaimed deterministically');

      await setSchedulerLimits(store, {
        maxActiveRuns: 32,
        localModelConcurrency: 1
      });
      const localAgent = await createAgent(store, 'Local capacity agent', 'ollama');
      const localTicketOne = await createTicket(store, localAgent, 'Local capacity one');
      const localTicketTwo = await createTicket(store, localAgent, 'Local capacity two');
      const localRunOne = await createRun(store, localTicketOne, localAgent);
      const localRunTwo = await createRun(store, localTicketTwo, localAgent);
      check(Boolean(await claim(store, localRunOne, 'local-runtime-one')),
        'first local-model run acquires configured provider capacity');
      check((await claim(peer, localRunTwo, 'local-runtime-two')) === null,
        'configured local-model concurrency cannot be oversubscribed');
      await store.pool.query(
        `UPDATE ${store.table('runs')}
         SET lease_expires_at = clock_timestamp() - interval '1 second',
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [localRunOne.id]
      );
      check(Boolean(await claim(peer, localRunTwo, 'local-runtime-two')),
        'local-model capacity recovers when its owning run lease expires');
      await setSchedulerLimits(store, {
        maxActiveRuns: 32,
        localModelConcurrency: 8
      });

      const capacityAgent = await createAgent(store, 'Capacity agent');
      const firstTicket = await createTicket(store, capacityAgent, 'Capacity first');
      const secondTicket = await createTicket(store, capacityAgent, 'Capacity second');
      const firstRun = await createRun(store, firstTicket, capacityAgent);
      const secondRun = await createRun(store, secondTicket, capacityAgent);
      await claim(store, firstRun, 'runtime-one');
      await claim(peer, secondRun, 'runtime-two');
      const capacityRace = await Promise.all([
        store.acquireRuntimeCapacity({
          capacityDomain: 'target',
          resourceKey: 'browser:shared-target',
          limit: 1,
          leaseOwner: 'runtime-one',
          runId: firstRun.id,
          operationIdentity: 'target-operation:first',
          leaseDurationMs: 30_000,
          sourceIdentity: 'target-operation:first'
        }),
        peer.acquireRuntimeCapacity({
          capacityDomain: 'target',
          resourceKey: 'browser:shared-target',
          limit: 1,
          leaseOwner: 'runtime-two',
          runId: secondRun.id,
          operationIdentity: 'target-operation:second',
          leaseDurationMs: 30_000,
          sourceIdentity: 'target-operation:second'
        })
      ]);
      check(capacityRace.filter(result => result.acquired).length === 1,
        'PostgreSQL capacity slots prevent cross-instance target oversubscription');
      const winnerIndex = capacityRace.findIndex(result => result.acquired);
      const blockedIndex = winnerIndex === 0 ? 1 : 0;
      const blockedRun = blockedIndex === 0 ? firstRun : secondRun;
      const blockedOwner = blockedIndex === 0 ? 'runtime-one' : 'runtime-two';
      const blockedStore = blockedIndex === 0 ? store : peer;
      const blockedIdentity = blockedIndex === 0
        ? 'target-operation:first'
        : 'target-operation:second';
      const unrelated = await blockedStore.acquireRuntimeCapacity({
        capacityDomain: 'target',
        resourceKey: 'browser:unrelated-target',
        limit: 1,
        leaseOwner: blockedOwner,
        runId: blockedRun.id,
        operationIdentity: 'target-operation:unrelated',
        leaseDurationMs: 30_000,
        sourceIdentity: 'target-operation:unrelated'
      });
      check(unrelated.acquired,
        'one blocked target does not block an unrelated target');
      await blockedStore.releaseRuntimeCapacity({
        capacityDomain: 'target',
        resourceKey: 'browser:unrelated-target',
        slotNumber: unrelated.slot.slotNumber,
        leaseOwner: blockedOwner,
        runId: blockedRun.id,
        operationIdentity: 'target-operation:unrelated'
      });
      const winnerRun = winnerIndex === 0 ? firstRun : secondRun;
      const winnerOwner = winnerIndex === 0 ? 'runtime-one' : 'runtime-two';
      const winnerIdentity = winnerIndex === 0
        ? 'target-operation:first'
        : 'target-operation:second';
      const winnerStore = winnerIndex === 0 ? store : peer;
      await winnerStore.releaseRuntimeCapacity({
        capacityDomain: 'target',
        resourceKey: 'browser:shared-target',
        slotNumber: capacityRace[winnerIndex].slot.slotNumber,
        leaseOwner: winnerOwner,
        runId: winnerRun.id,
        operationIdentity: winnerIdentity,
        reason: 'test complete'
      });
      check(true, 'capacity ownership releases promptly after operation settlement');

      const retried = await blockedStore.acquireRuntimeCapacity({
        capacityDomain: 'target',
        resourceKey: 'browser:shared-target',
        limit: 1,
        leaseOwner: blockedOwner,
        runId: blockedRun.id,
        operationIdentity: blockedIdentity,
        leaseDurationMs: 30_000,
        sourceIdentity: blockedIdentity
      });
      check(retried.acquired, 'oldest blocked capacity request acquires after release');
      await blockedStore.pool.query(
        `UPDATE ${blockedStore.table('runs')}
         SET lease_expires_at = clock_timestamp() - interval '1 second',
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [blockedRun.id]
      );
      const reclaimTicket = await createTicket(store, capacityAgent, 'Capacity reclaim');
      const reclaimRun = await createRun(store, reclaimTicket, capacityAgent);
      await claim(store, reclaimRun, 'runtime-reclaimer');
      const reclaimed = await store.acquireRuntimeCapacity({
        capacityDomain: 'target',
        resourceKey: 'browser:shared-target',
        limit: 1,
        leaseOwner: 'runtime-reclaimer',
        runId: reclaimRun.id,
        operationIdentity: 'target-operation:reclaimed',
        leaseDurationMs: 30_000,
        sourceIdentity: 'target-operation:reclaimed'
      });
      check(reclaimed.acquired,
        'expired run ownership is reclaimed without leaking target capacity');
      await store.releaseRuntimeCapacity({
        capacityDomain: 'target',
        resourceKey: 'browser:shared-target',
        slotNumber: reclaimed.slot.slotNumber,
        leaseOwner: 'runtime-reclaimer',
        runId: reclaimRun.id,
        operationIdentity: 'target-operation:reclaimed'
      });

      // Durable capacity-wait row lifecycle (mechanism owner). A re-wait after
      // prior deactivation must restore active=true so the row, the
      // capacity.waiting evidence, getRunBudgetState, and the older-waiter
      // selection all describe the same current truth. The row is the durable
      // CURRENT-WAIT-EPISODE snapshot for one Run: every qualifying
      // conflict-update makes identity, cause, and first_blocked_at describe
      // the new current episode, while repeated polling of the SAME
      // already-active wait stays idempotent. This pins the MECHANISM's
      // evidence coherence; it asserts no ordering fairness.
      const waitRowFor = async runId => {
        const result = await store.pool.query(
          `SELECT capacity_domain, resource_key, source_identity, reason,
                  first_blocked_at, next_eligible_at, active, revision
           FROM ${store.table('run_capacity_waits')} WHERE run_id = $1`,
          [runId]
        );
        return result.rowCount === 1 ? result.rows[0] : null;
      };
      const waitingEventCount = async runId => {
        const result = await store.listRunEvents(runId);
        return result.filter(event => event.type === 'capacity.waiting').length;
      };

      const mechSerialSnapshot = budget({
        executionPolicy: { allowParallelRuns: false }
      });
      const mechSerialTicket = await createTicket(store, capacityAgent, 'Wait-row serial');
      const mechAdmission = await store.createRunsAndStartTicket({
        ticketId: mechSerialTicket.id,
        runDrafts: [capacityAgent, capacityAgent].map(memberAgent => ({
          ticketId: mechSerialTicket.id,
          agentId: memberAgent.id,
          status: 'pending',
          executionMode: 'agent',
          runtimeBudgetSnapshot: mechSerialSnapshot
        }))
      });
      const [mechHolder, mechWaiter] = mechAdmission.runs;
      check(Boolean(await claim(store, mechHolder, 'mech-holder-one')),
        'wait-row fixture holder occupies the serialized ticket active slot');
      const firstWait = await store.recordPendingRunCapacityWait({
        runId: mechWaiter.id,
        retryMs: 500
      });
      check(Boolean(firstWait), 'a genuinely blocked budgeted run records a capacity wait');
      const insertedRow = await waitRowFor(mechWaiter.id);
      check(insertedRow && insertedRow.active === true && Number(insertedRow.revision) === 1,
        'initial genuine capacity wait records an active row at revision 1');
      const firstWaitState = await store.getRunBudgetState(mechWaiter.id);
      check(firstWaitState.capacityWait && firstWaitState.capacityWait.active === true &&
        firstWaitState.capacityWait.capacityDomain === 'global_run',
      'getRunBudgetState reports the initial wait as coherent active evidence');
      const firstWaitingEvents = await waitingEventCount(mechWaiter.id);
      const repeatedWait = await store.recordPendingRunCapacityWait({
        runId: mechWaiter.id,
        retryMs: 500
      });
      check(Boolean(repeatedWait), 'repeated polling still observes the occupied condition');
      const afterRepeatRow = await waitRowFor(mechWaiter.id);
      check(afterRepeatRow.active === true && Number(afterRepeatRow.revision) === 1,
        'repeated identical polling while active performs no revision churn');
      check(afterRepeatRow.first_blocked_at.getTime() ===
        insertedRow.first_blocked_at.getTime(),
      'repeated identical polling while active keeps first_blocked_at stable');
      check((await waitingEventCount(mechWaiter.id)) === firstWaitingEvents,
        'repeated identical polling while active emits no duplicate waiting event');

      await store.releaseRunLease({
        runId: mechHolder.id,
        leaseOwner: 'mech-holder-one',
        payload: { reason: 'wait-row deactivation fixture' }
      });
      check(Boolean(await claim(store, mechWaiter, 'mech-waiter-one')),
        'freed serialization lets the waiting run claim its lease');
      const claimedRow = await waitRowFor(mechWaiter.id);
      check(claimedRow.active === false && Number(claimedRow.revision) === 2,
        'successful claim deactivates the wait row and advances revision exactly once');

      await store.releaseRunLease({
        runId: mechWaiter.id,
        leaseOwner: 'mech-waiter-one',
        payload: { reason: 'wait-row re-wait fixture' }
      });
      check(Boolean(await claim(peer, mechHolder, 'mech-holder-two')),
        'the holder claims again once the waiter released its lease');
      check((await claim(store, mechWaiter, 'mech-waiter-two')) === null,
        'the released waiter is capacity-blocked again before its re-wait');
      const reactivated = await store.recordPendingRunCapacityWait({
        runId: mechWaiter.id,
        retryMs: 500
      });
      check(Boolean(reactivated), 'the released waiter records a genuine re-wait');
      const reactivatedRow = await waitRowFor(mechWaiter.id);
      check(reactivatedRow.active === true && Number(reactivatedRow.revision) === 3,
        'a genuine re-wait restores active=true and advances revision exactly once');
      check(reactivatedRow.first_blocked_at.getTime() >
        insertedRow.first_blocked_at.getTime(),
      'same-identity re-wait begins a new episode: first_blocked_at resets');
      check((await waitingEventCount(mechWaiter.id)) === firstWaitingEvents + 1,
        're-wait emits one truthful new capacity.waiting event');
      const reactivatedState = await store.getRunBudgetState(mechWaiter.id);
      check(reactivatedState.capacityWait && reactivatedState.capacityWait.active === true &&
        reactivatedState.capacityWait.capacityDomain === 'global_run',
      'getRunBudgetState reports the re-wait as coherent active evidence again');

      // Changed scheduler identity across episodes (writer 1). The shared
      // runtime-limit configuration is narrowed for this fixture and restored
      // in the finally block, making the global deployment identity reachable
      // for the re-wait. The fixture first waits on ticket serialization,
      // deactivates by claiming, then genuinely re-waits on the global
      // deployment identity; the row must describe the CURRENT episode.
      const savedSchedulerLimits = await store.getRuntimeLimitsConfig();
      let fillerWave = null;
      try {
        const schedTicket = await createTicket(store, capacityAgent,
          'Wait-row scheduler identity');
        const schedAdmission = await store.createRunsAndStartTicket({
          ticketId: schedTicket.id,
          runDrafts: [capacityAgent, capacityAgent].map(memberAgent => ({
            ticketId: schedTicket.id,
            agentId: memberAgent.id,
            status: 'pending',
            executionMode: 'agent',
            runtimeBudgetSnapshot: mechSerialSnapshot
          }))
        });
        const [schedHolder, schedWaiter] = schedAdmission.runs;
        check(Boolean(await claim(store, schedHolder, 'sched-identity-holder')),
          'scheduler-identity fixture holder occupies the serialized ticket');
        check((await claim(store, schedWaiter, 'sched-identity-x')) === null,
          'the scheduler-identity waiter is genuinely blocked pre-lease');
        const schedWaitA = await store.recordPendingRunCapacityWait({
          runId: schedWaiter.id,
          retryMs: 500
        });
        check(Boolean(schedWaitA), 'the first scheduler wait episode records identity A');
        const schedRowA = await waitRowFor(schedWaiter.id);
        check(schedRowA && schedRowA.active === true &&
          schedRowA.capacity_domain === 'global_run' &&
          schedRowA.resource_key === `ticket:${schedTicket.id}` &&
          schedRowA.reason === 'Ticket policy serializes active runs' &&
          schedRowA.source_identity === `scheduler:${schedWaiter.id}`,
        'identity A wait row is coherent with the serialization block');
        const schedFirstBlockedA = schedRowA.first_blocked_at.getTime();
        const schedEventsA = await waitingEventCount(schedWaiter.id);
        await store.releaseRunLease({
          runId: schedHolder.id,
          leaseOwner: 'sched-identity-holder',
          payload: { reason: 'scheduler identity fixture' }
        });
        check(Boolean(await claim(store, schedWaiter, 'sched-identity-live')),
          'identity A clears and the waiter claims, deactivating its row');
        const schedRowInactive = await waitRowFor(schedWaiter.id);
        check(schedRowInactive.active === false,
          'the identity A row is deactivated after the successful claim');
        await store.releaseRunLease({
          runId: schedWaiter.id,
          leaseOwner: 'sched-identity-live',
          payload: { reason: 'scheduler identity fixture' }
        });
        const fillerTicket = await createTicket(store, capacityAgent,
          'Wait-row scheduler fillers');
        fillerWave = await store.createRunsAndStartTicket({
          ticketId: fillerTicket.id,
          runDrafts: [capacityAgent, capacityAgent].map(memberAgent => ({
            ticketId: fillerTicket.id,
            agentId: memberAgent.id,
            status: 'pending',
            executionMode: 'agent',
            runtimeBudgetSnapshot: budget()
          }))
        });
        check(Boolean(await claim(store, fillerWave.runs[0], 'sched-filler-one')) &&
          Boolean(await claim(store, fillerWave.runs[1], 'sched-filler-two')),
        'two filler leases saturate the narrowed global active-run ceiling');
        await setSchedulerLimits(store, { maxActiveRuns: 2 });
        const schedWaitB = await store.recordPendingRunCapacityWait({
          runId: schedWaiter.id,
          retryMs: 500
        });
        check(Boolean(schedWaitB) && schedWaitB.resourceKey === 'deployment',
          'the scheduler now blocks the waiter on the global deployment identity');
        const schedRowB = await waitRowFor(schedWaiter.id);
        check(schedRowB && schedRowB.active === true &&
          schedRowB.capacity_domain === 'global_run' &&
          schedRowB.resource_key === 'deployment' &&
          schedRowB.reason === 'Global active-run capacity is occupied' &&
          schedRowB.source_identity === `scheduler:${schedWaiter.id}`,
        'the changed-identity re-wait makes the row describe identity B');
        check(Number(schedRowB.revision) === Number(schedRowInactive.revision) + 1,
          'the changed-identity re-wait advances revision exactly once');
        check(schedRowB.first_blocked_at.getTime() > schedFirstBlockedA,
          'the changed-identity re-wait begins a new first_blocked_at episode');
        check((await waitingEventCount(schedWaiter.id)) === schedEventsA + 1,
          'exactly one new capacity.waiting event describes identity B');
        const schedStateB = await store.getRunBudgetState(schedWaiter.id);
        check(schedStateB.capacityWait && schedStateB.capacityWait.active === true &&
          schedStateB.capacityWait.resourceKey === 'deployment' &&
          schedStateB.capacityWait.reason === 'Global active-run capacity is occupied',
        'getRunBudgetState describes identity B, not the stale identity A');
        check(schedStateB.capacityWait.resourceKey !== `ticket:${schedTicket.id}`,
          'no stale active row remains on identity A');
        await store.recordPendingRunCapacityWait({
          runId: schedWaiter.id,
          retryMs: 500
        });
        const schedRowPoll = await waitRowFor(schedWaiter.id);
        check(schedRowPoll.active === true &&
          Number(schedRowPoll.revision) === Number(schedRowB.revision) &&
          schedRowPoll.first_blocked_at.getTime() ===
            schedRowB.first_blocked_at.getTime() &&
          schedRowPoll.resource_key === 'deployment',
        'repeated polling of the SAME identity B stays idempotent');
        check((await waitingEventCount(schedWaiter.id)) === schedEventsA + 1,
          'repeated polling of the SAME identity B emits no duplicate event');
      } finally {
        await setSchedulerLimits(store, {
          maxActiveRuns: savedSchedulerLimits.maxActiveRuns,
          localModelConcurrency: savedSchedulerLimits.localModelConcurrency
        });
        if (fillerWave) {
          await store.releaseRunLease({
            runId: fillerWave.runs[0].id,
            leaseOwner: 'sched-filler-one',
            payload: { reason: 'scheduler identity fixture cleanup' }
          });
          await store.releaseRunLease({
            runId: fillerWave.runs[1].id,
            leaseOwner: 'sched-filler-two',
            payload: { reason: 'scheduler identity fixture cleanup' }
          });
        }
      }

      const mechTicket = await createTicket(store, capacityAgent, 'Wait-row in-lease');
      const mechWave = await store.createRunsAndStartTicket({
        ticketId: mechTicket.id,
        runDrafts: [capacityAgent, capacityAgent, capacityAgent].map(memberAgent => ({
          ticketId: mechTicket.id,
          agentId: memberAgent.id,
          status: 'pending',
          executionMode: 'agent',
          runtimeBudgetSnapshot: budget()
        }))
      });
      const [mechWinner, mechLoser, mechYounger] = mechWave.runs;
      await claim(store, mechWinner, 'mech-runtime-winner');
      await claim(store, mechLoser, 'mech-runtime-loser');
      await claim(store, mechYounger, 'mech-runtime-younger');
      check((await store.acquireRuntimeCapacity({
        capacityDomain: 'target',
        resourceKey: 'browser:mech-shared',
        limit: 1,
        leaseOwner: 'mech-runtime-winner',
        runId: mechWinner.id,
        operationIdentity: 'mech:first',
        leaseDurationMs: 30_000,
        sourceIdentity: 'mech:first'
      })).acquired, 'in-lease fixture winner holds the single shared target slot');
      check((await store.acquireRuntimeCapacity({
        capacityDomain: 'target',
        resourceKey: 'browser:mech-shared',
        limit: 1,
        leaseOwner: 'mech-runtime-loser',
        runId: mechLoser.id,
        operationIdentity: 'mech:second',
        leaseDurationMs: 30_000,
        sourceIdentity: 'mech:second'
      })).acquired === false, 'in-lease fixture loser waits on the occupied shared slot');
      const inLeaseWaitRow = await waitRowFor(mechLoser.id);
      check(inLeaseWaitRow.active === true,
        'in-lease capacity waiting records an active durable wait row');
      await store.acquireRuntimeCapacity({
        capacityDomain: 'target',
        resourceKey: 'browser:mech-unrelated',
        limit: 1,
        leaseOwner: 'mech-runtime-loser',
        runId: mechLoser.id,
        operationIdentity: 'mech:unrelated',
        leaseDurationMs: 30_000,
        sourceIdentity: 'mech:unrelated'
      });
      check((await waitRowFor(mechLoser.id)).active === false,
        'acquiring another resource deactivates the run stale wait row');
      await store.releaseRuntimeCapacity({
        capacityDomain: 'target',
        resourceKey: 'browser:mech-unrelated',
        slotNumber: (await store.pool.query(
          `SELECT slot_number FROM ${store.table('runtime_capacity_slots')}
           WHERE capacity_domain = 'target' AND resource_key = 'browser:mech-unrelated'
             AND run_id = $1`,
          [mechLoser.id]
        )).rows[0].slot_number,
        leaseOwner: 'mech-runtime-loser',
        runId: mechLoser.id,
        operationIdentity: 'mech:unrelated'
      });
      const loserRevisionBefore = (await waitRowFor(mechLoser.id)).revision;
      check((await store.acquireRuntimeCapacity({
        capacityDomain: 'target',
        resourceKey: 'browser:mech-shared',
        limit: 1,
        leaseOwner: 'mech-runtime-loser',
        runId: mechLoser.id,
        operationIdentity: 'mech:second',
        leaseDurationMs: 30_000,
        sourceIdentity: 'mech:second'
      })).acquired === false, 'the loser genuinely re-waits on the still-occupied shared slot');
      const reactivatedInLease = await waitRowFor(mechLoser.id);
      check(reactivatedInLease.active === true &&
        Number(reactivatedInLease.revision) === Number(loserRevisionBefore) + 1,
      'in-lease re-wait restores active=true with exactly one revision advance');
      await store.releaseRuntimeCapacity({
        capacityDomain: 'target',
        resourceKey: 'browser:mech-shared',
        slotNumber: (await store.pool.query(
          `SELECT slot_number FROM ${store.table('runtime_capacity_slots')}
           WHERE capacity_domain = 'target' AND resource_key = 'browser:mech-shared'
             AND run_id = $1`,
          [mechWinner.id]
        )).rows[0].slot_number,
        leaseOwner: 'mech-runtime-winner',
        runId: mechWinner.id,
        operationIdentity: 'mech:first',
        reason: 'wait-row older-waiter fixture'
      });
      const younger = await store.acquireRuntimeCapacity({
        capacityDomain: 'target',
        resourceKey: 'browser:mech-shared',
        limit: 1,
        leaseOwner: 'mech-runtime-younger',
        runId: mechYounger.id,
        operationIdentity: 'mech:third',
        leaseDurationMs: 30_000,
        sourceIdentity: 'mech:third'
      });
      check(younger.acquired === false,
        'with a free slot, the older-waiter mechanism still yields to the reactivated waiter');
      const youngerWaitRow = await waitRowFor(mechYounger.id);
      check(youngerWaitRow && youngerWaitRow.active === true,
        'the blocked younger run records its own active wait row');

      // Changed in-lease identity across episodes (writer 2). Old wait
      // identity A -> deactivation -> genuine in-lease wait on DIFFERENT
      // identity B -> repeated identical B polls stay idempotent. Also owns
      // predecessor older-waiter truthfulness: after changed-identity
      // reactivation the mechanism must see the waiter on the ACTUAL current
      // resource B, and the stale resource A must not be falsely blocked.
      const identTicket = await createTicket(store, capacityAgent,
        'Wait-row changed identity');
      const identWave = await store.createRunsAndStartTicket({
        ticketId: identTicket.id,
        runDrafts: [capacityAgent, capacityAgent, capacityAgent, capacityAgent]
          .map(memberAgent => ({
            ticketId: identTicket.id,
            agentId: memberAgent.id,
            status: 'pending',
            executionMode: 'agent',
            runtimeBudgetSnapshot: budget()
          }))
      });
      const [identHolder, identLoser, identOther, identYounger] = identWave.runs;
      check(Boolean(await claim(store, identHolder, 'ident-holder')) &&
        Boolean(await claim(store, identLoser, 'ident-loser')) &&
        Boolean(await claim(store, identOther, 'ident-other')) &&
        Boolean(await claim(store, identYounger, 'ident-younger')),
      'the changed-identity fixture admits and claims its four members');
      check((await store.acquireRuntimeCapacity({
        capacityDomain: 'target',
        resourceKey: 'browser:ident-a',
        limit: 1,
        leaseOwner: 'ident-holder',
        runId: identHolder.id,
        operationIdentity: 'ident-holder:a',
        leaseDurationMs: 30_000,
        sourceIdentity: 'ident-holder:a'
      })).acquired, 'identity A resource is occupied by the holder');
      check((await store.acquireRuntimeCapacity({
        capacityDomain: 'target',
        resourceKey: 'browser:ident-b',
        limit: 1,
        leaseOwner: 'ident-other',
        runId: identOther.id,
        operationIdentity: 'ident-other:b',
        leaseDurationMs: 30_000,
        sourceIdentity: 'ident-other:b'
      })).acquired, 'identity B resource is occupied by the other run');
      check((await store.acquireRuntimeCapacity({
        capacityDomain: 'target',
        resourceKey: 'browser:ident-a',
        limit: 1,
        leaseOwner: 'ident-loser',
        runId: identLoser.id,
        operationIdentity: 'ident-loser:a',
        leaseDurationMs: 30_000,
        sourceIdentity: 'ident-loser:a'
      })).acquired === false, 'the loser genuinely waits on identity A');
      const identRowA = await waitRowFor(identLoser.id);
      check(identRowA && identRowA.active === true &&
        identRowA.resource_key === 'browser:ident-a' &&
        identRowA.source_identity === 'ident-loser:a',
      'identity A in-lease wait row records identity A coherently');
      const identRevisionA = Number(identRowA.revision);
      const identFirstBlockedA = identRowA.first_blocked_at.getTime();
      const identEventsA = await waitingEventCount(identLoser.id);
      check((await store.acquireRuntimeCapacity({
        capacityDomain: 'target',
        resourceKey: 'browser:ident-c',
        limit: 1,
        leaseOwner: 'ident-loser',
        runId: identLoser.id,
        operationIdentity: 'ident-loser:c',
        leaseDurationMs: 30_000,
        sourceIdentity: 'ident-loser:c'
      })).acquired, 'acquiring a free third resource deactivates identity A');
      const identRowInactive = await waitRowFor(identLoser.id);
      check(identRowInactive.active === false &&
        Number(identRowInactive.revision) === identRevisionA + 1,
      'the identity A row deactivates with exactly one revision advance');
      await store.releaseRuntimeCapacity({
        capacityDomain: 'target',
        resourceKey: 'browser:ident-c',
        slotNumber: (await store.pool.query(
          `SELECT slot_number FROM ${store.table('runtime_capacity_slots')}
           WHERE capacity_domain = 'target' AND resource_key = 'browser:ident-c'
             AND run_id = $1`,
          [identLoser.id]
        )).rows[0].slot_number,
        leaseOwner: 'ident-loser',
        runId: identLoser.id,
        operationIdentity: 'ident-loser:c'
      });
      check((await store.acquireRuntimeCapacity({
        capacityDomain: 'target',
        resourceKey: 'browser:ident-b',
        limit: 1,
        leaseOwner: 'ident-loser',
        runId: identLoser.id,
        operationIdentity: 'ident-loser:b',
        leaseDurationMs: 30_000,
        sourceIdentity: 'ident-loser:b'
      })).acquired === false, 'the loser genuinely re-waits on identity B');
      const identRowB = await waitRowFor(identLoser.id);
      check(identRowB && identRowB.active === true &&
        identRowB.capacity_domain === 'target' &&
        identRowB.resource_key === 'browser:ident-b' &&
        identRowB.source_identity === 'ident-loser:b' &&
        identRowB.reason === 'Capacity target/browser:ident-b is occupied',
      'the changed-identity re-wait makes the row describe identity B');
      check(Number(identRowB.revision) === Number(identRowInactive.revision) + 1,
        'the in-lease changed-identity re-wait advances revision exactly once');
      check(identRowB.first_blocked_at.getTime() > identFirstBlockedA,
        'the in-lease changed-identity re-wait begins a new first_blocked_at episode');
      check((await waitingEventCount(identLoser.id)) === identEventsA + 1,
        'exactly one new capacity.waiting event describes identity B');
      const identStateB = await store.getRunBudgetState(identLoser.id);
      check(identStateB.capacityWait && identStateB.capacityWait.active === true &&
        identStateB.capacityWait.capacityDomain === 'target' &&
        identStateB.capacityWait.resourceKey === 'browser:ident-b' &&
        identStateB.capacityWait.sourceIdentity === 'ident-loser:b' &&
        identStateB.capacityWait.reason ===
          'Capacity target/browser:ident-b is occupied',
      'getRunBudgetState describes identity B, not the stale identity A');
      await store.acquireRuntimeCapacity({
        capacityDomain: 'target',
        resourceKey: 'browser:ident-b',
        limit: 1,
        leaseOwner: 'ident-loser',
        runId: identLoser.id,
        operationIdentity: 'ident-loser:b',
        leaseDurationMs: 30_000,
        sourceIdentity: 'ident-loser:b'
      });
      const identRowPoll = await waitRowFor(identLoser.id);
      check(identRowPoll.active === true &&
        Number(identRowPoll.revision) === Number(identRowB.revision) &&
        identRowPoll.first_blocked_at.getTime() ===
          identRowB.first_blocked_at.getTime() &&
        identRowPoll.resource_key === 'browser:ident-b',
      'repeated identical in-lease polling of identity B stays idempotent');
      check((await waitingEventCount(identLoser.id)) === identEventsA + 1,
        'repeated identical in-lease polling emits no duplicate event');
      await store.releaseRuntimeCapacity({
        capacityDomain: 'target',
        resourceKey: 'browser:ident-b',
        slotNumber: (await store.pool.query(
          `SELECT slot_number FROM ${store.table('runtime_capacity_slots')}
           WHERE capacity_domain = 'target' AND resource_key = 'browser:ident-b'
             AND run_id = $1 AND lease_owner = 'ident-other'`,
          [identOther.id]
        )).rows[0].slot_number,
        leaseOwner: 'ident-other',
        runId: identOther.id,
        operationIdentity: 'ident-other:b'
      });
      const identBFreed = await store.pool.query(
        `SELECT slot_number FROM ${store.table('runtime_capacity_slots')}
         WHERE capacity_domain = 'target' AND resource_key = 'browser:ident-b'
           AND lease_owner IS NULL`);
      check(identBFreed.rowCount === 1,
        'the identity B slot is genuinely free for the mechanism proof');
      check((await store.acquireRuntimeCapacity({
        capacityDomain: 'target',
        resourceKey: 'browser:ident-b',
        limit: 1,
        leaseOwner: 'ident-younger',
        runId: identYounger.id,
        operationIdentity: 'ident-younger:b',
        leaseDurationMs: 30_000,
        sourceIdentity: 'ident-younger:b'
      })).acquired === false,
      'with a free B slot, the mechanism still sees the CURRENT identity B waiter');
      await store.releaseRuntimeCapacity({
        capacityDomain: 'target',
        resourceKey: 'browser:ident-a',
        slotNumber: (await store.pool.query(
          `SELECT slot_number FROM ${store.table('runtime_capacity_slots')}
           WHERE capacity_domain = 'target' AND resource_key = 'browser:ident-a'
             AND run_id = $1 AND lease_owner = 'ident-holder'`,
          [identHolder.id]
        )).rows[0].slot_number,
        leaseOwner: 'ident-holder',
        runId: identHolder.id,
        operationIdentity: 'ident-holder:a'
      });
      const identAFreed = await store.pool.query(
        `SELECT slot_number FROM ${store.table('runtime_capacity_slots')}
         WHERE capacity_domain = 'target' AND resource_key = 'browser:ident-a'
           AND lease_owner IS NULL`);
      check(identAFreed.rowCount === 1,
        'the identity A slot is genuinely free for the stale-row proof');
      check((await store.acquireRuntimeCapacity({
        capacityDomain: 'target',
        resourceKey: 'browser:ident-a',
        limit: 1,
        leaseOwner: 'ident-younger',
        runId: identYounger.id,
        operationIdentity: 'ident-younger:a',
        leaseDurationMs: 30_000,
        sourceIdentity: 'ident-younger:a'
      })).acquired,
      'the stale identity A resource is not falsely blocked by the reactivated row');

      const serialTicket = await createTicket(store, agent, 'Serial ticket');
      const serialSnapshot = budget({
        executionPolicy: { allowParallelRuns: false }
      });
      const otherAgent = await createAgent(store, 'Serial peer');
      // These two pending Runs are the complete execution wave used to prove
      // serial scheduler admission. They share one admitted policy snapshot and
      // must coexist before either is claimed, so Ticket-attempt authority owns
      // them as one exact atomic attempt rather than as overlapping singleton
      // createRun calls.
      const serialAdmission = await store.createRunsAndStartTicket({
        ticketId: serialTicket.id,
        runDrafts: [agent, otherAgent].map(memberAgent => ({
          ticketId: serialTicket.id,
          agentId: memberAgent.id,
          status: 'pending',
          executionMode: 'agent',
          runtimeBudgetSnapshot: serialSnapshot
        }))
      });
      const [serialOne, serialTwo] = serialAdmission.runs;
      check(serialAdmission.attempt.memberCount === 2 &&
        serialOne.ticketAttemptId === serialAdmission.attempt.id &&
        serialTwo.ticketAttemptId === serialAdmission.attempt.id,
      'serial-policy contenders are one exact two-member Ticket attempt');
      check(serialOne.runtimeBudgetSnapshot.snapshotHash === serialSnapshot.snapshotHash &&
        serialTwo.runtimeBudgetSnapshot.snapshotHash === serialSnapshot.snapshotHash,
      'serial-policy attempt members retain the same immutable admitted budget snapshot');
      check(Boolean(await claim(store, serialOne, 'serial-runtime-one')),
        'first serial-policy run acquires its canonical run lease');
      check((await claim(peer, serialTwo, 'serial-runtime-two')) === null,
        'allowParallelRuns false prevents a second active run for one ticket');

      const maxOne = budget({ executionPolicy: { maxAttempts: 1 } });
      const allocationAttemptTicket = await createTicket(
        store,
        agent,
        'Atomic allocation attempt'
      );
      const allocationAttempt = await store.createRunsAndStartTicket({
        ticketId: allocationAttemptTicket.id,
        runDrafts: [
          {
            ticketId: allocationAttemptTicket.id,
            agentId: agent.id,
            status: 'pending',
            allocationPlanId: 'allocation-plan-one',
            runtimeBudgetSnapshot: maxOne
          },
          {
            ticketId: allocationAttemptTicket.id,
            agentId: otherAgent.id,
            status: 'pending',
            allocationPlanId: 'allocation-plan-one',
            runtimeBudgetSnapshot: maxOne
          }
        ]
      });
      check(allocationAttempt.runs.length === 2,
        'one atomic allocation wave consumes one attempt for all allocated agents');

      const boundedAttemptTicket = await createTicket(store, agent, 'Attempt bound');
      const boundedPredecessorAdmission = await store.createRunsAndStartTicket({
        ticketId: boundedAttemptTicket.id,
        runDrafts: [{
          ticketId: boundedAttemptTicket.id,
          agentId: agent.id,
          status: 'pending',
          executionMode: 'agent',
          runtimeBudgetSnapshot: maxOne
        }]
      });
      const boundedPredecessor = (await store.transitionRun({
        runId: boundedPredecessorAdmission.runs[0].id,
        expectedRevision: boundedPredecessorAdmission.runs[0].revision,
        fromStatuses: ['pending'],
        toStatus: 'failed',
        patch: {
          error: 'expected maxAttempts predecessor fixture',
          completedAt: new Date().toISOString()
        },
        eventType: 'run.failed',
        eventPayload: { source: 'runtime-budget-postgres-test' }
      })).run;
      const boundedSettlement = await store.transitionTicketAfterRun({
        runId: boundedPredecessor.id
      });
      // T2 five-state settlement: Run and attempt failure stay BELOW the
      // Ticket lifecycle, and the retired Ticket-level FAILED status is never
      // produced. This fixture carries NO ticket-owned maxAttempts policy —
      // the ceiling lives only inside each admitted run-budget snapshot and
      // is enforced at admission — so the shared blocking-authority composer
      // wins nothing and the settled failure demotes to open, not blocked.
      check(boundedSettlement.attempt.disposition === 'failed',
      'maxAttempts predecessor settles as a failed attempt');
      check(boundedSettlement.ticket.status === 'open',
      'maxAttempts predecessor settles before retry admission into the open five-state Ticket, not retired failed');
      await assert.rejects(
        store.createRetryRun({
          ticketId: boundedAttemptTicket.id,
          predecessorRunId: boundedPredecessor.id,
          runDraft: {
            ticketId: boundedAttemptTicket.id,
            agentId: agent.id,
            status: 'pending',
            runtimeBudgetSnapshot: maxOne
          }
        }),
        error => error && error.code === 'RUN_BUDGET_EXHAUSTED'
      );
      check((await store.listRunsForTicket({
        ticketId: boundedAttemptTicket.id
      })).runs.length === 1 &&
        await store.countTicketAttempts(boundedAttemptTicket.id) === 1 &&
        (await store.getTicket(boundedAttemptTicket.id)).status === 'open',
      'transactional retry exhaustion admits no new attempt or Run');

      const waitingEvents = (await store.listRunEvents(blockedRun.id))
        .filter(event => event.type === 'capacity.waiting');
      check(waitingEvents.length === 1,
        'repeated capacity polling records one idempotent waiting event');
      const rebuilt = await store.getRunBudgetState(run.id);
      check(rebuilt.snapshot.snapshotHash === snapshot.snapshotHash &&
        rebuilt.charges.length === state.charges.length,
      'budget state reconstructs identically from immutable snapshot and charges');

      await sleep(5);
      console.log('PASS: runtime budget and capacity PostgreSQL');
    } finally {
      await peer.close();
    }
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
