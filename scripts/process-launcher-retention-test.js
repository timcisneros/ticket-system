#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const {
  compactEligibleLauncherOperations,
  durableFinalizationAuthority
} = require('../runtime/process-launcher-retention');

const operationIdentity = `process-operation:${'1'.repeat(64)}`;
const artifact = stream => ({
  version: 1,
  id: `${stream}-artifact`,
  stream,
  byteCount: 0,
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
});
const candidate = {
  processOperation: {
    operationIdentity,
    lifecycleState: 'terminal',
    terminalResultHash: '2'.repeat(64),
    requiredEvidenceState: 'complete',
    launcherOutputAcknowledged: true,
    stdoutArtifact: artifact('stdout'),
    stderrArtifact: artifact('stderr')
  },
  runStatus: 'completed',
  operationReceipt: {
    operationIdentity,
    terminalResultHash: '2'.repeat(64),
    stdoutArtifact: artifact('stdout'),
    stderrArtifact: artifact('stderr')
  },
  runConsequence: {
    completionDecision: { decisionHash: '3'.repeat(64) }
  }
};
const exact = durableFinalizationAuthority(candidate);
assert(/^[0-9a-f]{64}$/.test(exact.durableFinalizationHash));
for (const mutation of [
  { processOperation: { ...candidate.processOperation, lifecycleState: 'active' } },
  {
    processOperation: {
      ...candidate.processOperation,
      launcherOutputAcknowledged: false
    }
  },
  {
    operationReceipt: {
      ...candidate.operationReceipt,
      operationIdentity: `process-operation:${'4'.repeat(64)}`
    }
  },
  {
    operationReceipt: {
      ...candidate.operationReceipt,
      terminalResultHash: '5'.repeat(64)
    }
  }
]) {
  assert.throws(() => durableFinalizationAuthority({
    ...candidate,
    ...mutation
  }), /compaction authority|does not match/);
}

let calls = 0;
compactEligibleLauncherOperations({
  repository: {
    async listProcessLauncherCompactionCandidates() {
      return [candidate];
    }
  },
  launcherClient: {
    async compactOperation(request) {
      calls += 1;
      assert.equal(request.operationIdentity, operationIdentity);
      assert.equal(request.terminalResultHash, '2'.repeat(64));
      assert.equal(request.durableFinalizationHash, exact.durableFinalizationHash);
    }
  }
}).then(result => {
  assert.equal(calls, 1);
  assert.equal(result.compacted.length, 1);
  console.log('PASS: launcher retention compacts only exact durable finalization');
}).catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
