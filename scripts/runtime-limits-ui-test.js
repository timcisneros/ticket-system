#!/usr/bin/env node
'use strict';
// Runtime limits admin UI and run-detail limit reporting — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A10).
//
// Contract under test, unchanged from the JSON-era original and confirmed live
// during the A10 audit: the runtime-limits admin page is admin-only on GET and POST,
// renders an inherit-blank input, carries an optimistic `expectedRevision`, rejects
// fractional and below-minimum values with a visible validation error, permits
// admins to exceed deployment caps, and — on run detail — reports the run's
// run-start limits as `usage / limit` pairs with the limit outcome that ended it.
//
// Repaired, not rewritten. The two JSON-era couplings called out in the A10 entry are
// replaced rather than ported:
//
//   * users, groups, memberships, tickets and runs were seeded from data/*.json;
//     they now come from the store's access and run APIs. The suite needs a real
//     SECOND, non-admin principal to prove the 403 paths, so the viewer gets its own
//     credential and group rather than a copy of the admin's password hash.
//   * persistence was asserted by re-reading runtime-limits.json; it is now asserted
//     through the store's runtime-limits accessor.
//
// Scope boundary: the JSON API surface (/api/runtime-limits) belongs to
// runtime-limits-config-test.js. This suite owns the rendered admin form and the
// run-detail limits block.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const argon2 = require('argon2');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const { buildRuntimeBudgetSnapshot } = require('../runtime/runtime-budget-contract');

const STAMP = Date.now();
const VIEWER_PASSWORD = 'viewer-password-runtime-limits-ui';
const DEPLOYMENT = {
  maxExecutionSteps: 10,
  maxModelRequestsPerRun: 10,
  maxWorkspaceOperationsPerRun: 20,
  maxRuntimeDurationMs: 20000
};

// The limits the fixture run was admitted under, and the usage it recorded against
// them. Kept together so the `usage / limit` assertions below read as one contract.
const APPLIED_LIMITS = {
  maxExecutionSteps: 3,
  maxModelRequestsPerRun: 4,
  maxWorkspaceOperationsPerRun: 8,
  maxRuntimeDurationMs: 5000,
  source: { uiConfigured: true, deploymentCapped: true, workloadProfile: null, workflowLimits: null }
};
const ADMITTED_EXECUTION_POLICY = {
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
  allowParallelRuns: false,
  allowChildTickets: false,
  workspaceScope: 'shared'
};
const ADMITTED_RUNTIME_LIMITS = {
  revision: 1,
  maxAttempts: 3,
  maxExecutionSteps: APPLIED_LIMITS.maxExecutionSteps,
  maxModelRequestsPerRun: APPLIED_LIMITS.maxModelRequestsPerRun,
  maxWorkspaceOperationsPerRun: APPLIED_LIMITS.maxWorkspaceOperationsPerRun,
  maxProcessOperationsPerRun: 2,
  maxBrowserOperationsPerRun: 5,
  maxRuntimeDurationMs: APPLIED_LIMITS.maxRuntimeDurationMs,
  maxOutputArtifactBytesPerRun: 4096
};
const ADMITTED_BUDGET = buildRuntimeBudgetSnapshot({
  runtimeLimits: ADMITTED_RUNTIME_LIMITS,
  executionPolicy: ADMITTED_EXECUTION_POLICY
});
const TIMEOUT_ERROR = 'Agent run exceeded runtime duration limit of 5000ms';

const assert = createAsserter();

async function main() {
  await withHarness('runtime limits UI', async ({ store, workspaceRoot, startServer }) => {
    // ── Principals ───────────────────────────────────────────────────────────
    const viewerGroup = (await store.createGroup({
      value: { name: `Viewers-${STAMP}`, permissions: ['ticket:read'], canReceiveTickets: false },
      changedBy: 'runtime-limits-ui-test'
    })).group;
    await store.createUser({
      value: { username: 'viewer', passwordHash: await argon2.hash(VIEWER_PASSWORD) },
      groupIds: [viewerGroup.id],
      changedBy: 'runtime-limits-ui-test'
    });

    const agent = (await store.createConfiguredAgent({
      value: { name: `RuntimeLimitsUI-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key-runtime-limits-ui' },
      groupIds: [], changedBy: 'runtime-limits-ui-test'
    })).agent;

    // ── A terminal run that hit its runtime-duration limit ───────────────────
    // Seeded through the store rather than orchestrated, because what is under test
    // is how run detail REPORTS applied limits, not how a run reaches a timeout.
    const now = () => new Date().toISOString();
    const objective = `Create applied.txt ${STAMP}`;
    const ticket = (await store.createTicketWithEvent({
      ticket: {
        objective, acceptanceCriteria: null,
        assignmentTargetType: 'agent', assignmentTargetId: agent.id, assignmentMode: 'individual',
        ownedOutputPaths: null, targetRef: null, executionMode: 'agent',
        workflowId: null, workflowInput: null,
        capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
        executionPolicy: {
          mode: 'assisted', requireVerification: 'when_declared', autoRetry: false,
          maxAttempts: null, maxRuntimeMs: null, maxModelRequests: null, maxWorkspaceOperations: null,
          allowWorkspaceWrites: true, allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'shared'
        },
        workTypeId: null, workTypeSnapshot: null, workContextId: null, workContextSnapshot: null,
        // T2 Tranche 5: Ticket-level `failed` is retired; fixture holds 'open'.
        status: 'open', createdBy: 'admin', changedBy: 'admin',
        changedAt: now(), createdAt: now(), updatedAt: now()
      },
      eventPayload: { source: 'runtime-limits-ui-test' }
    })).ticket;

    const created = await store.createRun({
      ticketId: ticket.id, agentId: agent.id, agentName: agent.name,
      runtimeLimitsSnapshot: APPLIED_LIMITS,
      executionPolicySnapshot: ADMITTED_EXECUTION_POLICY,
      runtimeBudgetSnapshot: ADMITTED_BUDGET,
      capabilityType: 'directAction', capabilityId: 'agent-selected-actions',
      workspaceRoot, mainWorkspaceRoot: workspaceRoot, executionWorkspaceType: 'main',
      runEvaluation: {
        effectiveness: { status: 'unknown' },
        efficiency: {
          durationMs: 4000, providerRequests: 2, modelResponses: 1,
          workspaceOperations: 3, mutationCount: 0, workflowSteps: 0, retryCount: 0
        },
        violations: { status: 'none', items: [] },
        effectiveRuntimeConfig: null
      },
      status: 'pending'
    });
    const claim = await store.claimPendingRun({
      leaseOwner: 'runtime-limits-ui-fixture', leaseDurationMs: 60000, eligibleRunIds: [created.id]
    });
    const started = await store.transitionRun({
      runId: created.id, expectedRevision: claim.run.revision, fromStatuses: ['pending'],
      toStatus: 'running', leaseOwner: 'runtime-limits-ui-fixture', eventType: 'run.started'
    });
    await store.transitionRun({
      runId: created.id, expectedRevision: started.run.revision, fromStatuses: ['running'],
      toStatus: 'failed', leaseOwner: 'runtime-limits-ui-fixture', eventType: 'run.execution_failed',
      patch: { error: TIMEOUT_ERROR, completedAt: now() },
      eventPayload: { status: 'failed' }
    });
    await store.initializeRunReplay({
      runId: created.id, ticketId: ticket.id,
      snapshot: {
        version: 1, runId: created.id, ticketId: ticket.id,
        assignedAgentId: agent.id, agentNameSnapshot: agent.name,
        provider: 'openai', model: 'gpt-4.1-mini',
        runtimeEnvelope: {}, ticketObjectiveSnapshot: objective, systemInstructionSnapshot: 'sys',
        primitiveContract: {}, workspaceRoot, mainWorkspaceRoot: workspaceRoot,
        executionWorkspaceType: 'main',
        runtimeLimitsSnapshot: APPLIED_LIMITS,
        // Two provider requests against one model response: the neutral "request
        // recorded without matching response" symptom the run detail must report
        // without inventing a cause.
        providerRequests: [{ durationMs: 1 }, { durationMs: 1 }],
        modelResponses: [{ durationMs: 100 }],
        parsedModelPlans: [
          { step: 0, message: 'continue', actions: [], complete: false },
          { step: 1, message: 'continue', actions: [], complete: false }
        ],
        workspaceOperations: [
          { operation: { operation: 'readFile', args: { path: 'a.txt' } }, result: {} },
          { operation: { operation: 'readFile', args: { path: 'b.txt' } }, result: {} },
          { operation: { operation: 'readFile', args: { path: 'c.txt' } }, result: {} }
        ],
        events: [],
        terminalStatus: 'failed',
        failureReason: TIMEOUT_ERROR,
        failure: {
          code: 'RUN_LIMIT_EXCEEDED', kind: 'timeout',
          detail: { limitType: 'timeout', currentValue: 5001, configuredLimit: 5000 }
        },
        mutationCount: 0, mutationOutcome: 'no_mutations',
        createdAt: now(), finalizedAt: now()
      }
    });

    const server = await startServer({ env: {
      RUNTIME_SCHEDULER_INTERVAL_MS: '60000',
      AGENT_MAX_EXECUTION_STEPS: String(DEPLOYMENT.maxExecutionSteps),
      AGENT_MAX_MODEL_REQUESTS_PER_RUN: String(DEPLOYMENT.maxModelRequestsPerRun),
      AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: String(DEPLOYMENT.maxWorkspaceOperationsPerRun),
      AGENT_MAX_RUNTIME_DURATION_MS: String(DEPLOYMENT.maxRuntimeDurationMs)
    } });
    const admin = await server.login();
    const viewer = await server.login('viewer', VIEWER_PASSWORD);

    async function submit(cookie, form) {
      const current = await server.request('GET', '/admin/runtime-limits', { cookie });
      const match = current.body.match(/name="expectedRevision" value="([1-9]\d*)"/);
      if (!match) throw new Error('the runtime limits form did not expose expectedRevision');
      return server.request('POST', '/admin/runtime-limits', {
        cookie, form: { ...form, expectedRevision: match[1] }
      });
    }

    // ── Authorization ────────────────────────────────────────────────────────
    assert((await server.request('GET', '/admin/runtime-limits', { cookie: viewer })).statusCode === 403,
      'a non-admin cannot open the runtime limits page');
    assert((await server.request('POST', '/admin/runtime-limits', {
      cookie: viewer, form: { maxExecutionSteps: '2' }
    })).statusCode === 403, 'a non-admin cannot post the runtime limits form');

    // ── Initial render ───────────────────────────────────────────────────────
    const initial = await server.request('GET', '/admin/runtime-limits', { cookie: admin });
    assert(initial.statusCode === 200 && initial.body.includes('Runtime Limits'),
      'the runtime limits page renders for an admin');
    assert(initial.body.includes('newly started agent runs'),
      'the page states that changes apply to newly started runs');
    assert(initial.body.includes(`<code>${DEPLOYMENT.maxExecutionSteps}</code>`)
      && initial.body.includes(`<code>${DEPLOYMENT.maxRuntimeDurationMs}</code>`),
      'the page shows the inherited deployment values as effective');
    assert(initial.body.includes('name="maxExecutionSteps"') && initial.body.includes('value=""'),
      'an inherited limit renders as a blank input rather than a pre-filled number');
    assert(initial.body.includes('name="expectedRevision" value="1"'),
      'the form carries the optimistic revision it was rendered from');
    // The concurrency settings moved from process scope to deployment scope, so the
    // JSON-era label "Max active runs in this process" no longer exists. Asserting it
    // would be pinning retired wording; the live framing is asserted instead.
    assert(initial.body.includes('Process-Enforced Limits') && initial.body.includes('name="maxActiveRuns"'),
      'the run admission setting is on the form');
    assert(initial.body.includes('Max active runs in this deployment'),
      'the run admission setting is presented as deployment-wide');
    assert(initial.body.includes('name="localModelConcurrency"'),
      'the local-model concurrency setting is on the form');

    // ── Saving ───────────────────────────────────────────────────────────────
    const validForm = {
      maxExecutionSteps: '3', maxModelRequestsPerRun: '4',
      maxWorkspaceOperationsPerRun: '8', maxRuntimeDurationMs: '5000'
    };
    const saved = await submit(admin, validForm);
    assert(saved.statusCode === 302 && saved.headers.location === '/admin/runtime-limits?saved=1',
      'a valid form redirects with a confirmation');

    const storedAfterSave = await store.getRuntimeLimitsConfig();
    assert(storedAfterSave.maxExecutionSteps === 3 && storedAfterSave.maxRuntimeDurationMs === 5000,
      'the submitted values reach the store');

    const confirmation = await server.request('GET', '/admin/runtime-limits?saved=1', { cookie: admin });
    assert(confirmation.body.includes('Runtime limits saved.'), 'the confirmation banner renders');
    assert(confirmation.body.includes('value="3"') && confirmation.body.includes('<code>3</code>'),
      'the configured value renders both as the form value and as the effective value');

    // ── Inheriting again by blanking ─────────────────────────────────────────
    const blanks = {
      maxExecutionSteps: '', maxModelRequestsPerRun: '',
      maxWorkspaceOperationsPerRun: '', maxRuntimeDurationMs: ''
    };
    assert((await submit(admin, blanks)).statusCode === 302, 'a blank (inherit) form saves');
    const blanked = await store.getRuntimeLimitsConfig();
    // Asserted field-by-field rather than by counting non-null values, which is what
    // the JSON-era suite did: a count passes for the wrong reason as soon as the
    // config record grows or loses a key.
    for (const key of ['maxExecutionSteps', 'maxModelRequestsPerRun', 'maxWorkspaceOperationsPerRun', 'maxRuntimeDurationMs']) {
      assert(blanked[key] === null, `a blank ${key} persists as null (inherit), not as zero`);
    }
    assert(typeof blanked.revision === 'number' && blanked.updatedBy === 'admin' && typeof blanked.updatedAt === 'string',
      'blanking still records the revision and the audit metadata');

    // ── Validation errors render on the page ─────────────────────────────────
    const fractional = await submit(admin, { ...blanks, maxExecutionSteps: '1.5' });
    assert(fractional.statusCode === 400 && fractional.body.includes('must be a positive integer or null'),
      'a fractional value renders a validation error');
    const tooLow = await submit(admin, { ...blanks, maxRuntimeDurationMs: '4999' });
    assert(tooLow.statusCode === 400 && tooLow.body.includes('must be at least 5000'),
      'a below-minimum runtime duration renders a validation error');

    // ── Admins may exceed the deployment cap ─────────────────────────────────
    const overCap = await submit(admin, { ...blanks, maxExecutionSteps: '11' });
    assert(overCap.statusCode === 302, 'an admin may configure above the deployment default');
    assert((await store.getRuntimeLimitsConfig()).maxExecutionSteps === 11,
      'the above-default value is persisted rather than silently clamped');

    // ── Run detail reports the APPLIED limits, not current policy ────────────
    // Current policy is now 11 execution steps; the run was admitted under 3. The
    // page must report the run's own snapshot.
    const applied = await server.request('GET', `/runs/${created.id}`, { cookie: admin });
    assert(applied.statusCode === 200 && applied.body.includes('Runtime limits and usage'),
      'run detail renders the runtime limits block');
    assert(applied.body.includes('Applied run-start limits'),
      'run detail names the applied run-start limits as the source');
    assert(applied.body.includes('2 / 3'), 'run detail pairs execution-turn usage against the applied limit');
    assert(applied.body.includes('2 / 4'), 'run detail pairs model-request usage against the applied limit');
    assert(applied.body.includes('3 / 8'), 'run detail pairs workspace-operation usage against the applied limit');
    assert(!applied.body.includes('2 / 11'),
      'run detail does not re-bound a finished run against the current policy');
    assert(applied.body.includes('<code>timeout</code>'), 'run detail names the limit outcome that ended the run');
    assert(applied.body.includes('request recorded without matching response'),
      'run detail reports the unmatched provider request as a neutral symptom');
    assert(applied.body.includes('Limit source: Applied run-start limits'),
      'the diagnostics block names the applied-limit source');
    assert(applied.body.includes('Execution turns: 2 / 3'),
      'the diagnostics block repeats the usage/limit pair');
    assert(applied.body.includes('Budget (enforced)'),
      'a Tranche 5 run labels its immutable effective budget as enforced');
    assert(applied.body.includes(`<dt>Max attempts</dt><dd><code>${ADMITTED_BUDGET.maxAttempts}</code> · enforced`),
      'run detail renders the concrete admitted max-attempt limit');
    assert(new RegExp(`<dt>Runtime</dt><dd>[^<]* / ${ADMITTED_BUDGET.maxRuntimeDurationMs}ms`).test(applied.body),
      'run detail renders the concrete enforced runtime-duration limit');
    assert(applied.body.includes(`<dt>Max process operations</dt><dd><code>${ADMITTED_BUDGET.maxProcessOperations}</code> · enforced`),
      'run detail renders the concrete admitted process-operation limit');
    assert(applied.body.includes(`<dt>Max browser operations</dt><dd><code>${ADMITTED_BUDGET.maxBrowserOperations}</code> · enforced`),
      'run detail renders the concrete admitted browser-operation limit');
    assert(applied.body.includes(`<dt>Max output artifact bytes</dt><dd><code>${ADMITTED_BUDGET.maxOutputArtifactBytes}</code> · enforced aggregate raw bytes`),
      'run detail renders the concrete admitted aggregate artifact limit');
    assert(!/<dt>Max (?:attempts|execution steps|runtime|model requests|workspace operations|process operations|browser operations|output artifact bytes)[^<]*<\/dt><dd>.*recorded intent, not enforced/.test(applied.body),
      'enforced numeric limits never render as recorded intent, not enforced');
    assert(applied.body.includes('recorded intent · not implemented'),
      'allowChildTickets remains explicitly unimplemented');

    const ticketDetail = await server.request('GET', `/tickets/${ticket.id}`, { cookie: admin });
    assert(ticketDetail.statusCode === 200 &&
      ticketDetail.body.includes('Runs: 1 enforced, 0 historical advisory'),
    'ticket budget rollup still classifies a current Tranche 5 run as enforced');

    console.log(`\nPASS: runtime limits admin UI and run-detail reporting — ${assert.count()} assertions (PostgreSQL-native)`);
  }, { schemaSlug: 'runtime_limits_ui' });
}

main().catch(error => {
  console.error(`\nFAIL: runtime limits admin UI — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
