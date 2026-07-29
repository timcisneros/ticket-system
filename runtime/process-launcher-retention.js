'use strict';

const {
  hashProcessContractValue
} = require('./process-execution-contract');

class ProcessLauncherRetentionError extends Error {
  constructor(message, code = 'PROCESS_LAUNCHER_RETENTION_INVALID') {
    super(message);
    this.name = 'ProcessLauncherRetentionError';
    this.code = code;
  }
}

function durableFinalizationAuthority(candidate) {
  const operation = candidate && candidate.processOperation;
  const receipt = candidate && candidate.operationReceipt;
  const decision = candidate && candidate.runConsequence &&
    candidate.runConsequence.completionDecision;
  if (!operation || operation.lifecycleState !== 'terminal' ||
      operation.requiredEvidenceState !== 'complete' ||
      operation.launcherOutputAcknowledged !== true ||
      !['completed', 'failed', 'interrupted'].includes(candidate.runStatus) ||
      !receipt || receipt.operationIdentity !== operation.operationIdentity ||
      receipt.terminalResultHash !== operation.terminalResultHash ||
      !decision || typeof decision.decisionHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(decision.decisionHash)) {
    throw new ProcessLauncherRetentionError(
      'Process operation lacks exact durable compaction authority'
    );
  }
  for (const stream of ['stdout', 'stderr']) {
    const stored = operation[`${stream}Artifact`];
    const recorded = receipt[`${stream}Artifact`];
    if ((stored === null) !== (recorded === null) ||
        stored !== null &&
          hashProcessContractValue(stored) !== hashProcessContractValue(recorded)) {
      throw new ProcessLauncherRetentionError(
        `Process ${stream} artifact authority does not match its receipt`
      );
    }
  }
  const authority = {
    version: 1,
    operationIdentity: operation.operationIdentity,
    terminalResultHash: operation.terminalResultHash,
    stdoutArtifact: operation.stdoutArtifact,
    stderrArtifact: operation.stderrArtifact,
    requiredEvidenceState: operation.requiredEvidenceState,
    launcherOutputAcknowledged: operation.launcherOutputAcknowledged,
    completionDecisionHash: decision.decisionHash,
    runStatus: candidate.runStatus
  };
  return Object.freeze({
    ...authority,
    durableFinalizationHash: hashProcessContractValue(authority)
  });
}

async function compactEligibleLauncherOperations({
  repository,
  launcherClient,
  limit = 100
} = {}) {
  const candidates = await repository.listProcessLauncherCompactionCandidates({
    limit
  });
  const compacted = [];
  for (const candidate of candidates) {
    const authority = durableFinalizationAuthority(candidate);
    await launcherClient.compactOperation({
      operationIdentity: authority.operationIdentity,
      terminalResultHash: authority.terminalResultHash,
      durableFinalizationHash: authority.durableFinalizationHash
    });
    compacted.push(Object.freeze({
      operationIdentity: authority.operationIdentity,
      durableFinalizationHash: authority.durableFinalizationHash
    }));
  }
  return Object.freeze({ version: 1, compacted });
}

module.exports = {
  ProcessLauncherRetentionError,
  compactEligibleLauncherOperations,
  durableFinalizationAuthority
};
