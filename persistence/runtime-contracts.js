'use strict';

// Backend-neutral contracts used by the server composition root. Concrete
// adapters may live under postgres/ or test-only fixture packages, but runtime
// composition must not import an implementation merely to validate an
// interface.

const CONTRACTS = Object.freeze({
  runLease: ['getRun', 'verifyRunLease', 'listPendingRuns', 'listExpiredRunningRuns', 'claimPendingRun', 'startClaimedRun', 'heartbeatRunLease', 'releaseRunLease', 'persistRunWorkflowStep', 'recoverExpiredRun'],
  runPhase: ['advanceRunPhase'],
  runTerminalization: ['terminalizeRun', 'repairRunTerminalization'],
  ticketRunLifecycle: ['createTicketWithEvent', 'transitionTicketState', 'createRunsAndStartTicket', 'transitionTicketAfterRun', 'reopenTicket', 'createRetryRun'],
  nonTerminalEvidence: ['appendRunEvidence', 'completeActionReceipt', 'prepareTargetOperation', 'completeTargetOperation', 'getTargetOperation', 'withTargetOperationLock'],
  workspaceOwnership: ['findMutationConflict', 'listArtifactOwners'],
  operatorRecovery: ['getOperatorRecovery', 'prepareOperatorRecovery', 'completeOperatorRecovery', 'withOperatorRecoveryLock'],
  runReplay: ['initializeRunReplay', 'readRunReplay', 'listRunReplays', 'updateRunReplay'],
  runtimeStateRead: ['getTicket', 'getRun', 'listTickets', 'listTicketPage', 'countTicketsByStatus', 'listRuns', 'listRunsForTicket', 'listRunsForTickets', 'listLatestRunsForTickets', 'getRunAttemptPositions', 'listChildTickets', 'listRunsNeedingTerminalReconciliation', 'listRunEvents', 'listRunTimelineEvents', 'listTicketEvents', 'getRunEvaluation', 'getRunConsequence', 'listRunOperations', 'listTicketOperations', 'countRunMutations'],
  runRecovery: ['listRecoverableRuns', 'claimRunRecovery', 'resumeRecoveredRun', 'repairRecoveredRunTerminalProjection'],
  runtimeBootstrap: ['acquireRuntimeAuthority', 'prepareRuntimePersistence', 'refreshRuntimeAuthority', 'releaseRuntimeAuthority'],
  triage: ['createRunTriage', 'resolveTicketTriage', 'resolveRunTriage', 'getUnresolvedTriageSummary'],
  operationalStatus: ['getRuntimeOperationalSummary'],
  diagnosticLog: ['appendRunLog', 'appendSystemLog', 'listLogs', 'listLogsForRuns', 'hasRunLogType', 'getRunLogMetrics', 'resetLogs'],
  performanceAnalytics: ['listPerformanceRunEvidence'],
  workContext: ['listWorkContexts', 'getWorkContextById', 'getWorkContextCounts', 'createWorkContext', 'updateWorkContext'],
  configuredAgent: ['listConfiguredAgents', 'getConfiguredAgentById', 'getConfiguredAgentByName', 'getConfiguredAgentsByIds', 'listConfiguredAgentsByGroup', 'listAgentGroupMemberships', 'createConfiguredAgent', 'updateConfiguredAgent', 'deleteConfiguredAgent', 'removeConfiguredAgentMembershipsForGroup'],
  processTemplateProjection: ['listProcessTemplateStates', 'getProcessTemplateStateById', 'getProcessTemplateCounts', 'getProcessTemplateCountsByWorkContextIds', 'getProcessTemplateTriggerProvenance']
});

function assertRepository(repository, contractName, label) {
  if (!repository || typeof repository !== 'object') throw new TypeError(`${label} repository is required`);
  for (const method of CONTRACTS[contractName]) {
    if (typeof repository[method] !== 'function') {
      throw new TypeError(`${label} repository must implement ${method}()`);
    }
  }
  return repository;
}

function assertion(contractName, label) {
  return repository => assertRepository(repository, contractName, label);
}

class RunLeaseLostError extends Error {
  constructor(runId, leaseOwner) {
    super(`Run ${runId} is no longer controlled by live lease ${leaseOwner}`);
    this.name = 'RunLeaseLostError';
    this.code = 'RUN_LEASE_LOST';
    this.runId = runId;
    this.leaseOwner = leaseOwner;
  }
}

module.exports = {
  CONTRACTS,
  RunLeaseLostError,
  assertRunLeaseRepository: assertion('runLease', 'run lease'),
  assertRunPhaseRepository: assertion('runPhase', 'run phase'),
  assertRunTerminalizationRepository: assertion('runTerminalization', 'run terminalization'),
  assertTicketRunLifecycleRepository: assertion('ticketRunLifecycle', 'ticket/run lifecycle'),
  assertNonTerminalEvidenceRepository: assertion('nonTerminalEvidence', 'non-terminal evidence'),
  assertWorkspaceOwnershipRepository: assertion('workspaceOwnership', 'workspace ownership'),
  assertOperatorRecoveryRepository: assertion('operatorRecovery', 'operator recovery'),
  assertRunReplayRepository: assertion('runReplay', 'run replay'),
  assertRuntimeStateReadRepository: assertion('runtimeStateRead', 'runtime state read'),
  assertRunRecoveryRepository: assertion('runRecovery', 'run recovery'),
  assertRuntimeBootstrapRepository: assertion('runtimeBootstrap', 'runtime bootstrap'),
  assertTriageRepository: assertion('triage', 'triage'),
  assertOperationalStatusRepository: assertion('operationalStatus', 'operational status'),
  assertDiagnosticLogRepository: assertion('diagnosticLog', 'diagnostic log'),
  assertPerformanceAnalyticsRepository: assertion('performanceAnalytics', 'performance analytics'),
  assertWorkContextRepository: assertion('workContext', 'work context'),
  assertConfiguredAgentRepository: assertion('configuredAgent', 'configured agent'),
  assertProcessTemplateProjectionRepository: assertion('processTemplateProjection', 'process template projection')
};
