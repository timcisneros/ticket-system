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

      const serialTicket = await createTicket(store, agent, 'Serial ticket');
      const serialSnapshot = budget({
        executionPolicy: { allowParallelRuns: false }
      });
      const serialOne = await createRun(store, serialTicket, agent, serialSnapshot);
      const otherAgent = await createAgent(store, 'Serial peer');
      const serialTwo = await createRun(store, serialTicket, otherAgent, serialSnapshot);
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
      await assert.rejects(
        store.createRunsAndStartTicket({
          ticketId: boundedAttemptTicket.id,
          runDrafts: [
            {
              ticketId: boundedAttemptTicket.id,
              agentId: agent.id,
              status: 'pending',
              runtimeBudgetSnapshot: maxOne
            },
            {
              ticketId: boundedAttemptTicket.id,
              agentId: otherAgent.id,
              status: 'pending',
              runtimeBudgetSnapshot: maxOne
            }
          ]
        }),
        error => error && error.code === 'RUN_BUDGET_EXHAUSTED'
      );
      check((await store.listRunsForTicket({
        ticketId: boundedAttemptTicket.id
      })).runs.length === 0,
        'transactional attempt exhaustion performs no partial run admission');

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
