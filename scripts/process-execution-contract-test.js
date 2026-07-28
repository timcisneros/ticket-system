#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  PROCESS_AUTHORITY_RULE,
  PROCESS_EVIDENCE_CONTRACT,
  PROCESS_OPERATION,
  PROCESS_PRE_EXECUTION_EVIDENCE_FIELDS,
  PROCESS_TERMINAL_EVIDENCE_FIELDS,
  PROCESS_TERMINAL_OUTCOMES,
  buildProcessPolicySnapshot,
  isProcessContractFeatureEnabled,
  normalizeProcessPolicySnapshot,
  parseProcessOperationRequest,
  processAuthorityReferences,
  refuseProcessOperation,
  resolveProcessOperationRequest,
  validateProcessEvidenceRecord,
  validateProcessTerminalOutcome
} = require('../runtime/process-execution-contract');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;

function ok(condition, message) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`  ok ${message}`);
}

function equal(actual, expected, message) {
  assert.deepStrictEqual(actual, expected, message);
  passed += 1;
  console.log(`  ok ${message}`);
}

function throwsCode(fn, code, message) {
  assert.throws(fn, error => error && error.code === code, message);
  passed += 1;
  console.log(`  ok ${message}`);
}

const request = {
  operation: PROCESS_OPERATION,
  args: {
    targetId: 'trusted-target',
    profileId: 'readonly-profile',
    operationId: 'operation-001'
  }
};

equal(parseProcessOperationRequest(request), request, 'well-formed runProcess request parses');

const enabledSnapshot = buildProcessPolicySnapshot({
  capabilityEnabled: true,
  grants: [{ targetId: 'trusted-target', profileIds: ['readonly-profile'] }],
  capturedAt: '2026-07-27T12:00:00.000Z'
});
equal(
  resolveProcessOperationRequest({
    ...request,
    args: { ...request.args, targetId: 'unknown-target' }
  }, enabledSnapshot).code,
  'PROCESS_TARGET_UNKNOWN',
  'unknown target is deterministically policy-denied'
);
equal(
  resolveProcessOperationRequest({
    ...request,
    args: { ...request.args, profileId: 'unknown-profile' }
  }, enabledSnapshot).code,
  'PROCESS_PROFILE_UNKNOWN',
  'unknown profile is deterministically policy-denied'
);

for (const field of ['targetId', 'profileId', 'operationId']) {
  const args = { ...request.args };
  delete args[field];
  throwsCode(
    () => parseProcessOperationRequest({ operation: PROCESS_OPERATION, args }),
    'PROCESS_REQUEST_MALFORMED',
    `missing ${field} is rejected`
  );
}

const forbiddenFields = [
  'command', 'executable', 'executablePath', 'args', 'argumentVector',
  'environment', 'env', 'workingDirectory', 'cwd', 'timeout', 'timeoutMs',
  'resourceLimits', 'shell', 'stdin', 'inputRedirection', 'stdout',
  'outputRedirection', 'pipeline', 'background', 'detached'
];
for (const field of forbiddenFields) {
  throwsCode(
    () => parseProcessOperationRequest({
      ...request,
      args: { ...request.args, [field]: field === 'args' ? [] : 'model-controlled' }
    }),
    'PROCESS_REQUEST_MALFORMED',
    `model-supplied ${field} is rejected`
  );
}
throwsCode(
  () => parseProcessOperationRequest({ ...request, command: 'forbidden' }),
  'PROCESS_REQUEST_MALFORMED',
  'extra model-supplied executable field on the action envelope is rejected'
);

equal(isProcessContractFeatureEnabled({}), false, 'process contract capability is disabled by default');
const defaultSnapshot = buildProcessPolicySnapshot({
  capabilityEnabled: isProcessContractFeatureEnabled({}),
  grants: [],
  capturedAt: '2026-07-27T12:00:00.000Z'
});
equal(resolveProcessOperationRequest(request, defaultSnapshot).disposition, 'disabled',
  'default snapshot resolves runProcess as disabled');
const featureOnlySnapshot = buildProcessPolicySnapshot({
  capabilityEnabled: true,
  grants: [],
  capturedAt: '2026-07-27T12:00:00.000Z'
});
equal(processAuthorityReferences(featureOnlySnapshot), [],
  'enabling the contract grants no target or profile authority');
equal(resolveProcessOperationRequest(request, featureOnlySnapshot).code, 'PROCESS_TARGET_UNKNOWN',
  'an existing non-process target cannot become process authority implicitly');

equal(resolveProcessOperationRequest(request, enabledSnapshot).disposition, 'unsupported',
  'authorized request resolves as unsupported because no executor exists');
throwsCode(
  () => refuseProcessOperation(request, enabledSnapshot),
  'PROCESS_EXECUTOR_UNAVAILABLE',
  'enabling and authorizing the contract still cannot execute a process'
);
const contractSource = fs.readFileSync(path.join(ROOT, 'runtime/process-execution-contract.js'), 'utf8');
ok(!/require\s*\(\s*['"]child_process['"]\s*\)/.test(contractSource),
  'process contract imports no child_process API');
ok(!/\b(?:spawn|execFile|exec)\s*\(/.test(contractSource),
  'process contract contains no process-launch call');

for (const outcome of PROCESS_TERMINAL_OUTCOMES) {
  equal(validateProcessTerminalOutcome(outcome), outcome, `terminal outcome ${outcome} is accepted`);
}
for (const outcome of ['', 'failed', 'unknown', 'success', null, 1]) {
  assert.throws(() => validateProcessTerminalOutcome(outcome), TypeError);
  passed += 1;
  console.log(`  ok invalid terminal outcome ${JSON.stringify(outcome)} is rejected`);
}

equal(Object.keys(PROCESS_EVIDENCE_CONTRACT.preExecution), [...PROCESS_PRE_EXECUTION_EVIDENCE_FIELDS],
  'pre-execution evidence fields are frozen by the machine-readable contract');
equal(Object.keys(PROCESS_EVIDENCE_CONTRACT.terminal), [...PROCESS_TERMINAL_EVIDENCE_FIELDS],
  'terminal evidence fields are frozen by the machine-readable contract');
const evidence = validateProcessEvidenceRecord({
  operationId: 'operation-001',
  runId: 1,
  ticketId: 2,
  targetId: 'trusted-target',
  profileId: 'readonly-profile',
  declaredEnvironmentVariableNames: ['SAFE_NAME', 'SECRET_NAME'],
  policySnapshotHash: enabledSnapshot.snapshotHash,
  terminalOutcome: 'policy_denied'
});
ok(Object.isFrozen(evidence), 'validated process evidence is immutable in memory');
assert.throws(
  () => validateProcessEvidenceRecord({ ...evidence, environment: { SECRET_NAME: 'secret' } }),
  TypeError
);
passed += 1;
console.log('  ok secret environment values are outside the evidence schema');

const mutableConfiguration = [{
  targetId: 'historical-target',
  profileIds: ['historical-profile']
}];
const historicalSnapshot = buildProcessPolicySnapshot({
  capabilityEnabled: true,
  grants: mutableConfiguration,
  capturedAt: '2026-07-27T12:30:00.000Z'
});
const historicalHash = historicalSnapshot.snapshotHash;
mutableConfiguration[0].targetId = 'changed-target';
mutableConfiguration[0].profileIds[0] = 'changed-profile';
mutableConfiguration.push({ targetId: 'new-target', profileIds: ['new-profile'] });
equal(historicalSnapshot.snapshotHash, historicalHash,
  'later configuration mutation does not change historical snapshot hash');
equal(processAuthorityReferences(historicalSnapshot), [{
  targetId: 'historical-target',
  profileIds: ['historical-profile']
}], 'later configuration mutation does not change historical grants');
equal(
  resolveProcessOperationRequest({
    operation: PROCESS_OPERATION,
    args: {
      targetId: 'historical-target',
      profileId: 'historical-profile',
      operationId: 'historical-operation'
    }
  }, historicalSnapshot).disposition,
  'unsupported',
  'historical request continues to resolve from its captured snapshot'
);
equal(normalizeProcessPolicySnapshot(JSON.parse(JSON.stringify(historicalSnapshot))), historicalSnapshot,
  'historical process policy snapshot survives persistence round-trip');

equal(PROCESS_AUTHORITY_RULE, [
  'The model requests an existing process profile.',
  'The runtime resolves and enforces authority.',
  'The target configuration grants authority.',
  'Process output is evidence, not authority.'
], 'authority rule is exact');

console.log(`\nPASS: process execution Tranche 0 contract — ${passed} assertions`);
