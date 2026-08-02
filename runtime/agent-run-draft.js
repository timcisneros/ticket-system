'use strict';

// Tranche 5 — the ONE deterministic governed/agent Run-draft construction.
//
// WHY THIS EXISTS. `prepareAgentRunDraft` mixes two different jobs: resolving
// inputs from the world (tickets, agents, workflows, browser targets, runtime
// limits, routing) and CONSTRUCTING the persisted draft from them. Only the
// second is deterministic, and only the second is what a fixture needs.
//
// Test fixtures previously hand-assembled a Run body instead. That drifted
// silently: the seeded governed leaf Run omitted `runtimeLimitsSnapshot` and
// `runtimeBudgetSnapshot`, so every suite that drove the store directly passed
// while the real scheduler crash-looped the Run — claimed, started, integrity
// failure outside the execution boundary, recovered to pending, reclaimed. The
// omission was invisible precisely because no test executed the real worker.
//
// So construction moves here, production calls it, and fixtures call the same
// function. A required field added to the draft cannot appear in production
// while staying absent from fixtures, because there is only one draft.
//
// THIS FUNCTION RESOLVES NOTHING. No environment, no provider, no database, no
// globals, no scheduling, no writes. Every input is already resolved by the
// caller, which is what keeps it deterministic and testable.

// Every field of a persisted Run draft. Asserted by test against the real
// production draft, so a new required field cannot be added on one side only.
const AGENT_RUN_DRAFT_FIELDS = Object.freeze([
  'ticketId', 'agentId', 'agentName', 'targetRef', 'browserTargetSnapshot',
  'workTypeId', 'workTypeSnapshot', 'workspaceRoot', 'mainWorkspaceRoot',
  'executionWorkspaceType', 'executionPolicySnapshot', 'processPolicySnapshot',
  'processRuntimeCapabilitySnapshot', 'runtimeLimitsSnapshot',
  'runtimeBudgetSnapshot', 'verificationContractSnapshot',
  'completionAuthoritySnapshot', 'declaredWorkSnapshot',
  'acceptanceCriteriaSnapshot', 'routingSnapshot', 'allocationPlanId',
  'allocationItemId', 'allocationSubtask', 'ownedOutputPaths', 'executionMode',
  'workflowId', 'workflowInput', 'capabilityType', 'capabilityId',
  'capabilityInput', 'rerunMode', 'delegatedUserId', 'delegatedUsername',
  'delegatedPermissionSource', 'currentPhase', 'leaseOwner', 'leaseExpiresAt',
  'currentStepId', 'currentWorkflowAction', 'lastHeartbeatAt', 'status'
]);

function buildAgentRunDraft({
  ticket,
  agent,
  browserTarget = null,
  workspaceRoot,
  usesOwnedScope,
  ownedOutputPaths,
  executionPolicySnapshot,
  processPolicySnapshot,
  processRuntimeCapabilitySnapshot,
  runtimeLimitsSnapshot,
  runtimeBudgetSnapshot,
  verificationContractSnapshot,
  completionAuthoritySnapshot,
  declaredWorkSnapshot,
  routingSnapshot,
  allocationPlanId = null,
  allocationItem = null,
  structuredLeafItem = null,
  delegated = null,
  copyWorkTypeSnapshot,
  normalizeBrowserTargetSnapshot
}) {
  const run = {
    ticketId: ticket.id,
    agentId: agent.id,
    agentName: agent.name,
    targetRef: browserTarget ? { kind: 'browser', browserTargetId: browserTarget.id } : null,
    browserTargetSnapshot: browserTarget ? normalizeBrowserTargetSnapshot(browserTarget) : null,
    workTypeId: ticket.workTypeId || null,
    workTypeSnapshot: copyWorkTypeSnapshot(ticket.workTypeSnapshot),
    workspaceRoot: workspaceRoot,
    mainWorkspaceRoot: workspaceRoot,
    executionWorkspaceType: usesOwnedScope ? 'main_owned_paths' : 'main',
    executionPolicySnapshot,
    // Complete process authority is resolved from trusted configuration exactly
    // once. Dispatch must never reread the live catalog or agent grants.
    processPolicySnapshot,
    processRuntimeCapabilitySnapshot,
    runtimeLimitsSnapshot,
    runtimeBudgetSnapshot,
    verificationContractSnapshot,
    completionAuthoritySnapshot,
    declaredWorkSnapshot,
    acceptanceCriteriaSnapshot: (typeof ticket.acceptanceCriteria === 'string' && ticket.acceptanceCriteria.trim()) ? ticket.acceptanceCriteria.trim() : null,
    // Immutable routing snapshot (r1.28): supporting metadata only, never rewritten.
    routingSnapshot: routingSnapshot,
    allocationPlanId: allocationPlanId || null,
    allocationItemId: allocationItem ? allocationItem.allocationItemId : null,
    // A structured leaf Run carries no allocation subtask: the v1 placeholder
    // sentence exists only because a v1 plan has no per-item declaration, and a
    // v2 item declares its own work.
    allocationSubtask: structuredLeafItem
      ? null
      : (allocationItem ? allocationItem.allocationSubtask || null : null),
    ownedOutputPaths,
    executionMode: ticket.executionMode === 'workflow' ? 'workflow' : 'agent',
    workflowId: ticket.executionMode === 'workflow' ? ticket.workflowId : null,
    workflowInput: ticket.executionMode === 'workflow' ? (ticket.workflowInput || {}) : null,
    capabilityType: ticket.executionMode === 'workflow' ? 'workflow' : 'directAction',
    capabilityId: ticket.executionMode === 'workflow' ? ticket.workflowId : 'agent-selected-actions',
    capabilityInput: ticket.executionMode === 'workflow' ? (ticket.workflowInput || {}) : null,
    rerunMode: ticket.rerunMode || null,
    // Delegated human authority for this run, captured at run-initiation time (not
    // derived from ticket.changedBy later). Drives permissioned cross-ticket
    // actions; null when no real user initiated the run (e.g. system/workflow).
    delegatedUserId: delegated && delegated.userId != null ? delegated.userId : null,
    delegatedUsername: delegated && delegated.username ? delegated.username : null,
    delegatedPermissionSource: delegated && delegated.source ? delegated.source : null,
    currentPhase: 'planning',
    leaseOwner: null,
    leaseExpiresAt: null,
    currentStepId: null,
    currentWorkflowAction: null,
    lastHeartbeatAt: null,
    status: 'pending'
  };
  return run;
}


// The closed runtime-limits snapshot shape, built from ALREADY RESOLVED values.
//
// Production resolves those values from deployment configuration and workload
// profile; that resolution stays in the server, because it is about deployment
// policy rather than persisted Run shape. What both production and fixtures need
// to agree on is the SHAPE, so only the shaping lives here.
//
// The four historical keys are required because run integrity validation refuses
// a Run whose snapshot lacks any of them — the omission that made a seeded Run
// crash-loop through the real scheduler.
const REQUIRED_RUNTIME_LIMIT_KEYS = Object.freeze([
  'maxExecutionSteps',
  'maxModelRequestsPerRun',
  'maxWorkspaceOperationsPerRun',
  'maxRuntimeDurationMs'
]);

const OPTIONAL_RUNTIME_LIMIT_KEYS = Object.freeze([
  'maxListDirectoryPerRun',
  'maxReadFilePerRun'
]);

function buildRuntimeLimitsSnapshot(limits, { source = null, semantics = null } = {}) {
  if (!limits || typeof limits !== 'object') {
    throw new TypeError('runtime limits must be an object of resolved values');
  }
  const snapshot = {};
  for (const key of REQUIRED_RUNTIME_LIMIT_KEYS) {
    const value = limits[key];
    if (!Number.isInteger(value) || value <= 0) {
      throw new TypeError(
        `runtime limits snapshot requires a positive integer ${key}`);
    }
    snapshot[key] = value;
  }
  for (const key of OPTIONAL_RUNTIME_LIMIT_KEYS) {
    const value = limits[key];
    if (Number.isInteger(value) && value > 0) snapshot[key] = value;
  }
  snapshot.source = source;
  snapshot.semantics = semantics;
  return snapshot;
}

module.exports = {
  AGENT_RUN_DRAFT_FIELDS,
  OPTIONAL_RUNTIME_LIMIT_KEYS,
  REQUIRED_RUNTIME_LIMIT_KEYS,
  buildAgentRunDraft,
  buildRuntimeLimitsSnapshot
};
