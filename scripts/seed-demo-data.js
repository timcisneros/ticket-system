#!/usr/bin/env node
// Deterministic, no-provider demo seed. Writes a complete, internally coherent
// fixture to an isolated demo data directory (default .local-demo-data) so a fresh
// demo shows the full product loop without running a live model:
//
//   ticket → run → verification → triage → /triage inbox → operator resolution/control
//          → logs/audit → attempt/usage/budget visibility
//
// This is DEMO DATA ONLY. It changes no runtime behavior. All runs are pre-seeded
// in terminal states with persisted runEvaluation/triage; no provider key is used.
//
// Usage:
//   npm run demo:seed
//   DATA_DIR=.local-demo-data WORKSPACE_ROOT=.local-demo-workspace npm run dev
//   (login: admin / admin123)

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEMO_DATA_DIR = path.resolve(process.env.DEMO_DATA_DIR || path.join(ROOT, '.local-demo-data'));
const DEMO_WORKSPACE_ROOT = path.resolve(process.env.DEMO_WORKSPACE_ROOT || path.join(ROOT, '.local-demo-workspace'));

// argon2id hash of password "admin123" (matches the local demo bootstrap credential).
const ADMIN_HASH = '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g';

const T0 = '2026-03-01T09:00:00.000Z';
const T0_PLUS_2S = '2026-03-01T09:00:02.000Z';
const T1 = '2026-03-01T09:05:00.000Z';

function writeJson(file, value) { fs.writeFileSync(path.join(DEMO_DATA_DIR, file), JSON.stringify(value, null, 2)); }

// ---- ticket / run factories (mirror the persisted shapes the server normalizes) ----
function ticket(id, status, objective, extra = {}) {
  return {
    id, objective,
    assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual',
    ownedOutputPaths: null, executionMode: 'agent', workflowId: null, workflowInput: null,
    capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    executionPolicy: { maxAttempts: null }, status,
    createdBy: 'admin', changedBy: 'admin', changedAt: T0, createdAt: T0, updatedAt: T0,
    ...extra
  };
}
function run(id, ticketId, status, extra = {}) {
  return {
    id, ticketId, agentId: 1, agentName: 'Demo Agent',
    workspaceRoot: DEMO_WORKSPACE_ROOT, mainWorkspaceRoot: DEMO_WORKSPACE_ROOT, executionWorkspaceType: 'main',
    allocationPlanId: null, allocationItemId: null, ownedOutputPaths: [],
    executionMode: 'agent', workflowId: null, workflowInput: null,
    capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    executionPolicySnapshot: { requireVerification: 'when_declared' },
    currentPhase: 'terminalization', leaseOwner: null, leaseExpiresAt: null,
    currentStepId: null, currentWorkflowAction: null, lastHeartbeatAt: null,
    status, createdAt: T0, updatedAt: T0, startedAt: T0,
    completedAt: ['completed', 'failed', 'interrupted'].includes(status) ? T0 : undefined,
    replaySnapshotPath: `replay-snapshots/run-${id}.json`,
    ...extra
  };
}
const evaluation = over => ({
  effectiveness: { status: 'unknown', postconditionsPassed: 0, postconditionsFailed: 0, errors: [] },
  efficiency: { durationMs: 1200, workflowSteps: 0, providerRequests: 3, modelResponses: 3, workspaceOperations: 2, mutationCount: 1, retryCount: 0 },
  violations: { status: 'none', items: [] }, effectiveRuntimeConfig: null,
  ...over
});
const verifyContract = { workflowId: 'demo-verified-wf', workflowName: 'Demo verified workflow', workflowVersion: '1', postconditions: [{ id: 'pc', type: 'fileExists', path: 'out.txt' }], verifierContract: null, capturedAt: T0 };

const RUN_TRIAGE = {
  required: true, reasonCode: 'verification_failed', summary: 'Verification failed: 1 postcondition did not pass',
  requiredDecision: 'review_failure', evidenceRefs: ['event:run.verification_failed', 'replay:failure'],
  allowedActions: ['review', 'rerun_from_start'], prohibitedActions: ['mark_completed_without_verification'],
  createdAt: T0, resolvedAt: null, resolvedBy: null, resolution: null
};
const TICKET_TRIAGE = {
  required: true, reasonCode: 'authority_blocked', summary: 'Objective requires writable scope outside this ticket\'s granted paths',
  requiredDecision: 'change_scope', evidenceRefs: ['event:ticket.blocked', 'ticket:feasibility'],
  allowedActions: ['review', 'edit_ticket'], prohibitedActions: ['start_run_without_scope_change'],
  createdAt: T0, resolvedAt: null, resolvedBy: null, resolution: null
};
const RUN_TRIAGE_RESOLVED = {
  required: false, reasonCode: 'runtime_failed', summary: 'Run failed: external dependency timed out',
  requiredDecision: 'review_failure', evidenceRefs: ['event:run.terminalized', 'replay:failure'],
  allowedActions: ['review', 'rerun_from_start'], prohibitedActions: ['automatic_retry'],
  createdAt: T0, resolvedAt: T1, resolvedBy: 'admin', resolution: 'Acknowledged — known flaky external dependency; no rerun needed.'
};

function seed() {
  fs.rmSync(DEMO_DATA_DIR, { recursive: true, force: true });
  fs.rmSync(DEMO_WORKSPACE_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(DEMO_DATA_DIR, 'replay-snapshots'), { recursive: true });
  fs.mkdirSync(DEMO_WORKSPACE_ROOT, { recursive: true });

  writeJson('users.json', [{ id: 1, username: 'admin', passwordHash: ADMIN_HASH, createdAt: T0, type: 'user' }]);
  writeJson('permissions.json', ['ticket:create', 'ticket:read', 'ticket:update', 'user:read', 'user:update', 'user:delete', 'group:update', 'workspace:read', 'workspace:write', 'workspace:reset']);
  writeJson('groups.json', [
    { id: 1, name: 'Administrators', permissions: ['ticket:create', 'ticket:read', 'ticket:update', 'user:read', 'user:update', 'user:delete', 'group:update', 'workspace:read', 'workspace:write', 'workspace:reset'], canReceiveTickets: false },
    { id: 2, name: 'Demo Agents', permissions: ['ticket:read'], canReceiveTickets: true }
  ]);
  writeJson('memberships.json', [{ id: 1, principalType: 'user', principalId: 1, groupId: 1 }]);
  writeJson('agents.json', [{ id: 1, name: 'Demo Agent', type: 'agent', provider: 'openai', model: 'gpt-demo', apiKey: '', createdAt: T0, updatedAt: T0 }]);
  writeJson('workflows.json', [{ id: 'demo-verified-wf', name: 'Demo verified workflow', version: '1', enabled: true, inputSchema: {}, actions: [{ id: 'done', action: 'stop', input: {} }], postconditions: [{ id: 'pc', type: 'fileExists', path: 'out.txt' }] }]);
  writeJson('allocation-plans.json', []);
  writeJson('operation-history.json', []);
  writeJson('protected-paths.json', []);

  // Tickets: one per demonstrated capability.
  writeJson('tickets.json', [
    ticket(1, 'completed', 'Generate Q3 compliance summary (completed + verified)', { executionMode: 'workflow', workflowId: 'demo-verified-wf', capabilityType: 'workflow', capabilityId: 'demo-verified-wf', workflowInput: {} }),
    ticket(2, 'failed', 'Generate vendor risk report (verification failed → run triage)', { executionMode: 'workflow', workflowId: 'demo-verified-wf', capabilityType: 'workflow', capabilityId: 'demo-verified-wf', workflowInput: {} }),
    ticket(3, 'blocked', 'Reorganize protected legal archive (blocked: ticket-level triage)', { triage: { ...TICKET_TRIAGE }, blockedReason: TICKET_TRIAGE.summary, feasibility: { status: 'blocked', reason: TICKET_TRIAGE.summary, code: 'TICKET_FEASIBILITY_MISSING_GRANTS', kind: 'impossible_authority_scope', requiredWritableRoots: [], grantedWritableRoots: [] } }),
    ticket(4, 'completed', 'Bulk-process intake backlog (budget advisory)'),
    ticket(5, 'completed', 'Reconcile billing exports (manual rerun ceiling: maxAttempts 2)', { executionPolicy: { maxAttempts: 2 } }),
    ticket(6, 'failed', 'Migrate shared drive folders (run triage resolved)')
  ]);

  writeJson('runs.json', [
    // A. completed + verified
    run(101, 1, 'completed', {
      executionMode: 'workflow', workflowId: 'demo-verified-wf', capabilityType: 'workflow', capabilityId: 'demo-verified-wf', workflowInput: {},
      verificationContractSnapshot: { ...verifyContract },
      runEvaluation: evaluation({ effectiveness: { status: 'passed', postconditionsPassed: 1, postconditionsFailed: 0, errors: [] } })
    }),
    // B. verification failure → run-level triage (shows in /triage)
    run(102, 2, 'failed', {
      executionMode: 'workflow', workflowId: 'demo-verified-wf', capabilityType: 'workflow', capabilityId: 'demo-verified-wf', workflowInput: {},
      verificationContractSnapshot: { ...verifyContract }, error: 'Verification failed: 1 postcondition did not pass',
      runEvaluation: evaluation({ effectiveness: { status: 'failed', postconditionsPassed: 0, postconditionsFailed: 1, errors: ['Verification failed: 1 postcondition did not pass'] } }),
      triage: { ...RUN_TRIAGE }
    }),
    // D. budget advisory (usage exceeds recorded thresholds)
    run(104, 4, 'completed', {
      startedAt: T0, completedAt: T0_PLUS_2S,
      executionPolicySnapshot: { requireVerification: 'when_declared', maxRuntimeMs: 1000, maxModelRequests: 5, maxWorkspaceOperations: 3 },
      runEvaluation: evaluation({ efficiency: { durationMs: 2000, workflowSteps: 0, providerRequests: 8, modelResponses: 8, workspaceOperations: 6, mutationCount: 4, retryCount: 0 } })
    }),
    // E. maxAttempts example (one attempt used; ceiling 2)
    run(105, 5, 'completed', { runEvaluation: evaluation({}) }),
    // F. resolved run triage (excluded from /triage; shown resolved on run detail)
    run(106, 6, 'failed', { error: 'Run failed: external dependency timed out', runEvaluation: evaluation({ effectiveness: { status: 'failed', postconditionsPassed: 0, postconditionsFailed: 0, errors: ['Run failed: external dependency timed out'] } }), triage: { ...RUN_TRIAGE_RESOLVED } })
  ]);

  // Operator-control audit trail (system-log shape: contextTicketId / contextRunId).
  writeJson('logs.json', [
    { id: 1, timestamp: T0, runId: null, ticketId: null, agentId: null, agentName: 'System', type: 'ticket:max_attempts_change', message: 'Ticket #5 maxAttempts changed from unlimited to 2 by admin', workspaceAction: null, contextTicketId: 5, changedBy: 'admin', fromMaxAttempts: null, toMaxAttempts: 2 },
    { id: 2, timestamp: T1, runId: null, ticketId: null, agentId: null, agentName: 'System', type: 'run:triage_resolve', message: 'Run #106 triage resolved by admin', workspaceAction: null, contextRunId: 106, contextTicketId: 6, changedBy: 'admin', reasonCode: 'runtime_failed', resolution: RUN_TRIAGE_RESOLVED.resolution }
  ]);

  // Verification verdicts (no execution_completed → startup reconciliation leaves
  // these terminal runs untouched; the verdict events keep the Usage/Attempt
  // verification line coherent with the run evaluation).
  const events = [
    { id: 'v101', ts: T0, type: 'run.verification_passed', ticketId: 1, runId: 101, payload: { status: 'passed' } },
    { id: 'v102', ts: T0, type: 'run.verification_failed', ticketId: 2, runId: 102, payload: { status: 'failed', error: 'Verification failed: 1 postcondition did not pass' } }
  ];
  fs.writeFileSync(path.join(DEMO_DATA_DIR, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');

  // Minimal replay snapshots for every run that references one.
  [101, 102, 104, 105, 106].forEach(id => {
    fs.writeFileSync(path.join(DEMO_DATA_DIR, 'replay-snapshots', `run-${id}.json`), JSON.stringify({ runId: id, providerRequests: [], modelResponses: [], workspaceOperations: [], events: [] }, null, 2));
  });
}

seed();
console.log('Demo seed written.');
console.log(`  DATA_DIR=${DEMO_DATA_DIR}`);
console.log(`  WORKSPACE_ROOT=${DEMO_WORKSPACE_ROOT}`);
console.log('Run the app against it:');
console.log(`  DATA_DIR=${path.relative(ROOT, DEMO_DATA_DIR) || DEMO_DATA_DIR} WORKSPACE_ROOT=${path.relative(ROOT, DEMO_WORKSPACE_ROOT) || DEMO_WORKSPACE_ROOT} npm run dev`);
console.log('Login: admin / admin123  ·  See docs/DEMO_WALKTHROUGH.md');
