#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { classifyTicketHistory } = require('../runtime/ticket-history-classifier-contract');
const { buildLeafRunBinding } = require('../runtime/structured-allocation-leaf-run-contract');
const { buildCompletionAuthoritySnapshot } = require('../runtime/completion-decision-contract');

const T0 = '2026-01-01T00:00:00.000Z';
const CLOSE = '2026-01-01T00:01:00.000Z';
const AFTER = '2026-01-01T00:02:00.000Z';
const PLAN_HASH = 'a0'.repeat(32);
const ITEM_HASH = 'b0'.repeat(32);
const PARENT_HASH = 'c0'.repeat(32);
const ADMISSION_HASH = 'd0'.repeat(32);

let assertions = 0;
function check(condition, message) {
  assert.ok(condition, message);
  assertions += 1;
  console.log(`  ok ${message}`);
}

function ticket(id, status, body = {}) {
  return { id, status, createdAt: T0, updatedAt: AFTER, ...body };
}

function attempt(id, ticketId, ordinal, disposition = null, settledAt = null) {
  return {
    id,
    ticketId,
    ordinal,
    memberCount: 1,
    disposition,
    admittedAt: T0,
    settledAt,
    revision: 1
  };
}

function run(id, ticketId, attemptId, status, body = {}) {
  return {
    id,
    ticketId,
    ticketAttemptId: attemptId,
    status,
    createdAt: T0,
    updatedAt: T0,
    ...body
  };
}

function closeEvidence(ticketId, fromStatus, { operator = 'operator', includeLog = true } = {}) {
  const event = {
    id: `close-event-${ticketId}`,
    position: 10,
    ticketId,
    runId: null,
    type: 'ticket.updated',
    ts: CLOSE,
    payload: {
      previousStatus: fromStatus,
      status: 'closed',
      changedBy: operator,
      changedAt: CLOSE
    }
  };
  const logs = includeLog ? [{
    id: 11,
    ticketId,
    runId: null,
    type: 'ticket:status_change',
    timestamp: CLOSE,
    body: {
      fromStatus,
      toStatus: 'closed',
      changedBy: operator,
      changedAt: CLOSE
    }
  }] : [];
  return { events: [event], logs };
}

function factsFor({ id = 1, status = 'open', attempts = [], runs = [], body = {}, consequences = [], plans = [], events = [], logs = [] } = {}) {
  return {
    ticket: ticket(id, status, body),
    attempts,
    runs,
    consequences,
    plans,
    events,
    logs
  };
}

function completedAttempt(ticketId = 1, attemptId = 1, runId = 1) {
  return {
    attempts: [attempt(attemptId, ticketId, 1, 'completed', T0)],
    runs: [run(runId, ticketId, attemptId, 'completed')]
  };
}

function unresolvedTriage() {
  return {
    triage: {
      required: true,
      createdAt: T0,
      resolvedAt: null
    }
  };
}

function v2Completed() {
  const completionAuthoritySnapshot = buildCompletionAuthoritySnapshot({
    objective: 'test objective',
    kind: 'deterministic',
    recognized: true,
    intent: 'test',
    completionPolicy: 'test_policy',
    directPostconditions: [],
    verificationPolicy: 'when_declared',
    capturedAt: T0
  });
  const decision = {
    version: 1,
    runId: 20,
    ticketId: 20,
    objectiveContractVersion: 1,
    objectiveContractHash: completionAuthoritySnapshot.objectiveContractHash,
    workflowDeclarationVersion: null,
    workflowDeclarationHash: null,
    executionPolicySnapshotHash: 'e0'.repeat(32),
    runtimeBudgetSnapshotHash: null,
    operationReceiptAuthority: { revision: 0, hash: 'f0'.repeat(32) },
    consequenceAuthority: { revision: 1, hash: '11'.repeat(32) },
    requiredEvidenceAuthority: { revision: 0, hash: '22'.repeat(32) },
    executionDisposition: 'succeeded',
    verificationDisposition: 'passed',
    completionDisposition: 'completed',
    evaluatedPostconditions: [],
    violations: [],
    evidenceIssues: [],
    reasonCode: 'OBJECTIVE_COMPLETED',
    modelClaim: null,
    browserEvidence: null,
    evaluatedAt: T0,
    decisionHash: crypto.createHash('sha256').update('classifier-test-decision').digest('hex')
  };
  const binding = buildLeafRunBinding({
    ticketId: 20,
    allocationPlanId: 20,
    planHash: PLAN_HASH,
    allocationItemId: 20,
    assignedAgentId: 20,
    itemDeclaredWorkHash: ITEM_HASH,
    ownedOutputPaths: ['reports/item/'],
    parentDeclaredWorkHash: PARENT_HASH,
    planningAttemptId: '11111111-1111-4111-8111-111111111111',
    planningAdmissionHash: ADMISSION_HASH,
    runId: 20,
    admittedAt: T0
  });
  return {
    ticket: ticket(20, 'completed'),
    attempts: [attempt(20, 20, 1, 'completed', T0)],
    runs: [run(20, 20, 20, 'completed', {
      allocationPlanId: 20,
      leafRunBinding: binding,
      declaredWorkSnapshot: { contractHash: ITEM_HASH },
      completionAuthoritySnapshot
    })],
    consequences: [{ runId: 20, ticketId: 20, recordedAt: T0, consequence: { completionDecision: decision } }],
    plans: [{
      id: 20,
      ticketId: 20,
      version: 2,
      planHash: PLAN_HASH,
      createdAt: T0,
      items: [{ allocationItemId: 20, assignedAgentId: 20, ownedOutputPaths: ['reports/item/'] }]
    }],
    events: [],
    logs: []
  };
}

function closedFacts(base, fromStatus, options = {}) {
  const close = closeEvidence(base.ticket.id, fromStatus, options);
  return { ...base, ticket: { ...base.ticket, status: 'closed' }, ...close };
}

console.log('T2 five-state historical classifier contract');

let result = classifyTicketHistory(factsFor());
check(result.proposedLifecycle === 'open' && result.classification === 'migratable', 'OPEN derives open');

result = classifyTicketHistory(factsFor({
  status: 'in_progress', attempts: [attempt(2, 2, 1)], runs: [run(2, 2, 2, 'pending')]
}));
check(result.proposedLifecycle === 'in_progress', 'valid IN_PROGRESS derives in_progress');

result = classifyTicketHistory(factsFor({ id: 3, status: 'in_progress' }));
check(result.classification === 'integrity_contradiction', 'missing IN_PROGRESS attempt refuses');

result = classifyTicketHistory(factsFor({
  id: 4, status: 'completed', ...completedAttempt(4, 4, 4)
}));
check(result.proposedLifecycle === 'completed', 'valid COMPLETED derives completed');

result = classifyTicketHistory(factsFor({ id: 5, status: 'completed' }));
check(result.classification === 'integrity_contradiction', 'COMPLETED without proof refuses');

result = classifyTicketHistory(factsFor({
  id: 6, status: 'failed', attempts: [attempt(6, 6, 1, 'failed', T0)], runs: [run(6, 6, 6, 'failed')]
}));
check(result.proposedLifecycle === 'open', 'FAILED without stronger authority demotes to open');

result = classifyTicketHistory(factsFor({
  id: 7, status: 'failed', body: unresolvedTriage(), attempts: [attempt(7, 7, 1, 'failed', T0)], runs: [run(7, 7, 7, 'failed')]
}));
check(result.proposedLifecycle === 'blocked', 'FAILED with blocker demotes to blocked');

result = classifyTicketHistory(factsFor({
  id: 8, status: 'failed', attempts: [attempt(8, 8, 1, 'failed', T0), attempt(9, 8, 2)], runs: [run(8, 8, 8, 'failed'), run(9, 8, 9, 'pending')]
}));
check(result.proposedLifecycle === 'in_progress', 'FAILED with newer unsettled attempt demotes to in_progress');

const completedFailed = completedAttempt(9, 9, 9);
result = classifyTicketHistory(factsFor({ id: 9, status: 'failed', ...completedFailed }));
check(result.proposedLifecycle === 'completed', 'FAILED with authoritative completion derives completed');

function settledHistory(ticketId, latestDisposition, latestRunStatus, body = {}) {
  return factsFor({
    id: ticketId,
    status: latestDisposition,
    body,
    attempts: [
      attempt(ticketId, ticketId, 1, 'completed', T0),
      attempt(ticketId + 1, ticketId, 2, latestDisposition === 'in_progress' ? null : latestDisposition, latestDisposition === 'in_progress' ? null : T0)
    ],
    runs: [
      run(ticketId, ticketId, ticketId, 'completed'),
      run(ticketId + 1, ticketId, ticketId + 1, latestRunStatus)
    ]
  });
}

result = classifyTicketHistory(settledHistory(40, 'failed', 'failed'));
check(result.proposedLifecycle === 'open' && result.authorityReferences.completion === null,
  'older COMPLETED plus newer FAILED without blocker derives OPEN with no completion reference');

result = classifyTicketHistory(settledHistory(41, 'failed', 'failed', unresolvedTriage()));
check(result.proposedLifecycle === 'blocked' && result.authorityReferences.completion === null,
  'older COMPLETED plus newer FAILED with blocker derives BLOCKED with no completion reference');

result = classifyTicketHistory(settledHistory(42, 'interrupted', 'interrupted'));
check(result.proposedLifecycle === 'open' && result.authorityReferences.completion === null,
  'older COMPLETED plus newer INTERRUPTED without blocker derives OPEN');

result = classifyTicketHistory(settledHistory(43, 'interrupted', 'interrupted', unresolvedTriage()));
check(result.proposedLifecycle === 'blocked' && result.authorityReferences.completion === null,
  'older COMPLETED plus newer INTERRUPTED with blocker derives BLOCKED');

result = classifyTicketHistory(settledHistory(44, 'in_progress', 'pending'));
check(result.proposedLifecycle === 'in_progress' && result.authorityReferences.completion === null,
  'older COMPLETED plus newer unsettled attempt derives IN_PROGRESS');

const failedThenCompleted = factsFor({
  id: 45,
  status: 'completed',
  attempts: [attempt(45, 45, 1, 'failed', T0), attempt(46, 45, 2, 'completed', T0)],
  runs: [run(45, 45, 45, 'failed'), run(46, 45, 46, 'completed')]
});
result = classifyTicketHistory(failedThenCompleted);
check(result.proposedLifecycle === 'completed',
  'older FAILED plus newer COMPLETED derives COMPLETED');
check(result.authorityReferences.completion && result.authorityReferences.completion.attemptId === 46,
  'completion reference belongs to the latest completed attempt');

result = classifyTicketHistory(settledHistory(47, 'failed', 'failed'));
check(result.authorityReferences.completion === null,
  'multiple settled attempts expose no older completion reference');

const closedOlderCompletion = closedFacts(settledHistory(48, 'failed', 'failed'), 'failed');
result = classifyTicketHistory(closedOlderCompletion);
check(result.closedClassification === 'proven_canceled' && result.proposedLifecycle === 'canceled',
  'CLOSED older COMPLETED plus newer FAILED follows ordinary OPEN close classification');

const closedOlderCompletionBlocked = closedFacts(
  settledHistory(49, 'failed', 'failed', unresolvedTriage()),
  'failed'
);
result = classifyTicketHistory(closedOlderCompletionBlocked);
check(result.closedClassification === 'ambiguous' && result.proposedLifecycle === null,
  'CLOSED older COMPLETED plus newer FAILED blocker remains ambiguous');

result = classifyTicketHistory(factsFor({ id: 10, status: 'blocked', body: unresolvedTriage() }));
check(result.proposedLifecycle === 'blocked', 'reconstructable BLOCKED derives blocked');

result = classifyTicketHistory(factsFor({ id: 11, status: 'blocked' }));
check(result.classification === 'integrity_contradiction', 'status-only BLOCKED refuses');

const completed = completedAttempt(12, 12, 12);
result = classifyTicketHistory(closedFacts(factsFor({ id: 12, status: 'closed', ...completed }), 'completed'));
check(result.closedClassification === 'proven_not_canceled' && result.proposedLifecycle === 'completed', 'CLOSED pre-close COMPLETED is not canceled');

const intermediateOpen = { ...factsFor({ id: 13, status: 'closed', ...completedAttempt(13, 13, 13) }), ticket: ticket(13, 'closed') };
result = classifyTicketHistory(closedFacts(intermediateOpen, 'open'));
check(result.closedClassification === 'proven_not_canceled', 'legacy intermediate OPEN cannot override completed authority');

const openClose = closedFacts(factsFor({ id: 14, status: 'closed' }), 'open');
result = classifyTicketHistory(openClose);
check(result.closedClassification === 'proven_canceled' && result.proposedLifecycle === 'canceled', 'qualifying OPEN close is canceled');

result = classifyTicketHistory({ ...openClose, logs: [] });
check(result.closedClassification === 'ambiguous', 'OPEN close without product log is ambiguous');

const inProgressBase = factsFor({ id: 15, status: 'closed', attempts: [attempt(15, 15, 1)], runs: [run(15, 15, 15, 'running')] });
const inProgressClose = closedFacts(inProgressBase, 'in_progress');
inProgressClose.events.push(
  { id: 'run-start-15', position: 9, ticketId: 15, runId: 15, type: 'run.started', ts: T0, payload: { status: 'running' } },
  { id: 'run-terminal-15', position: 12, ticketId: 15, runId: 15, type: 'run.terminalized', ts: AFTER, payload: { status: 'interrupted' } }
);
inProgressClose.logs.push({ id: 13, ticketId: 15, runId: 15, type: 'run:interrupted', timestamp: AFTER, body: { message: 'operator closed ticket #15' } });
result = classifyTicketHistory(inProgressClose);
check(result.closedClassification === 'proven_canceled', 'complete matched IN_PROGRESS interruption proves canceled');

result = classifyTicketHistory(closedFacts(inProgressBase, 'in_progress'));
check(result.closedClassification === 'ambiguous', 'partial IN_PROGRESS interruption is ambiguous');

result = classifyTicketHistory(closedFacts(factsFor({ id: 16, status: 'closed', body: unresolvedTriage() }), 'blocked'));
check(result.closedClassification === 'ambiguous', 'BLOCKED close is ambiguous');

result = classifyTicketHistory({ ...factsFor({ id: 17, status: 'closed' }), ...closeEvidence(17, 'open', { includeLog: false }) });
check(result.classification === 'ambiguous', 'missing close log is ambiguous');

const conflict = closedFacts(factsFor({ id: 18, status: 'closed' }), 'open');
const secondClose = closeEvidence(18, 'in_progress');
conflict.events.push({ ...secondClose.events[0], id: 'close-event-18b', position: 20 });
result = classifyTicketHistory(conflict);
check(result.classification === 'ambiguous', 'conflicting close operations are ambiguous');

const missingOperator = closedFacts(factsFor({ id: 19, status: 'closed' }), 'open', { operator: null });
delete missingOperator.events[0].payload.changedBy;
delete missingOperator.logs[0].body.changedBy;
result = classifyTicketHistory(missingOperator);
check(result.classification !== 'migratable', 'missing operator refuses cancellation classification');

const authority = {
  version: 1, ticketId: 20, authoritySource: 'operator', requestedBy: 'operator',
  reason: 'already canceled', committedAt: T0
};
result = classifyTicketHistory(factsFor({ id: 20, status: 'open', body: { cancellationAuthority: authority } }));
check(result.proposedLifecycle === 'canceled', 'valid migration-040 authority derives canceled');

result = classifyTicketHistory(factsFor({ id: 21, status: 'open', body: { cancellationAuthority: { ...authority, ticketId: 22 } } }));
check(result.classification === 'integrity_contradiction', 'malformed cancellation authority refuses');

const postClose = closedFacts(factsFor({ id: 22, status: 'closed' }), 'open');
postClose.attempts.push(attempt(22, 22, 1, 'completed', AFTER));
postClose.runs.push(run(22, 22, 22, 'completed'));
result = classifyTicketHistory(postClose);
check(result.closedClassification === 'proven_canceled', 'post-close completion evidence cannot alter pre-close open');

const postResolution = closedFacts(factsFor({ id: 23, status: 'closed', body: { triage: { required: true, createdAt: T0, resolvedAt: AFTER } } }), 'blocked');
result = classifyTicketHistory(postResolution);
check(result.closedClassification === 'ambiguous', 'post-close blocker resolution cannot erase pre-close blocker');

const v2 = v2Completed();
result = classifyTicketHistory(v2);
check(result.proposedLifecycle === 'completed', 'v2 completion derives from immutable leaf and Run evidence');

const v2Insufficient = { ...v2, plans: [{ ...v2.plans[0], items: [{ allocationItemId: 999, assignedAgentId: 20, ownedOutputPaths: ['reports/item/'] }] }] };
result = classifyTicketHistory(v2Insufficient);
check(result.classification === 'integrity_contradiction', 'insufficient v2 evidence refuses');

const sameAuthorityA = classifyTicketHistory(factsFor({ id: 30, status: 'open' }));
const sameAuthorityB = classifyTicketHistory(factsFor({ id: 31, status: 'failed', attempts: [attempt(31, 31, 1, 'failed', T0)], runs: [run(31, 31, 31, 'failed')] }));
check(sameAuthorityA.classification === sameAuthorityB.classification &&
  sameAuthorityA.proposedLifecycle === sameAuthorityB.proposedLifecycle,
  'equivalent reconstructed authority ignores legacy status semantics');

console.log(`  ${assertions} assertions passed`);
