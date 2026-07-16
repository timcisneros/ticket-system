'use strict';

const BASE_RUNTIME_LIMITS = Object.freeze({
  maxExecutionSteps: 4,
  maxModelRequestsPerRun: 4,
  maxWorkspaceOperationsPerRun: 32,
  maxRuntimeDurationMs: 120000
});

function currentRuntimeLimitsSnapshot(overrides = {}) {
  return {
    ...BASE_RUNTIME_LIMITS,
    ...overrides,
    source: {
      uiConfigured: false,
      deploymentCapped: true,
      workloadProfile: null,
      workflowLimits: null,
      ...(overrides.source || {})
    }
  };
}

module.exports = { currentRuntimeLimitsSnapshot };
