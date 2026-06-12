#!/usr/bin/env node
// Artifact Contract Check Test — proves the workflow verifierContract's artifact-presence check
// is actually executable. This validates that declared deliverables EXIST, not outcome correctness.
// Covers:
//   1. verifierContract exists (declared on the workflow)
//   2. the artifact check executes (completeRunArtifactCheck runs the declared expectedArtifacts check)
//   3. result is recorded (run.artifacts_checked event, surfaced in buildRunEvaluation.artifactCheck)
//   4. missing artifacts mark effectiveness.status as failed
//   5. a declared-but-unexecuted artifact check cannot pass silently (effectiveness => 'unverified')

const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-contract-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.WORKSPACE_ROOT = path.join(dataDir, 'ws');

const { completeRunArtifactCheck, buildRunEvaluation } = require('../server.js');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; } else { failed++; console.error(`FAIL: ${name}`); }
}

const now = new Date().toISOString();

function contract(id, expectedArtifacts) {
  return { id, version: '1', fixture: 'unit-fixture', expectedArtifacts };
}
function workflow(id, expectedArtifacts) {
  return {
    id, name: id, version: '1', enabled: true, inputSchema: {},
    verifierContract: contract(id + '-verifier', expectedArtifacts),
    actions: [{ id: 'stop', action: 'stop', input: {} }],
    postconditions: [], createdAt: now, updatedAt: now
  };
}
function run(id, workflowId) {
  return { id, ticketId: id, agentId: 1, executionMode: 'workflow', workflowId, status: 'completed', startedAt: now, completedAt: now, replaySnapshot: {} };
}
function writeFileRecord(id, runId, p) {
  return { id, runId, ticketId: runId, operation: 'writeFile', args: { path: p }, createdAt: now, preState: { existed: false }, postState: { existed: true } };
}

// Three runs: pass (all artifacts produced), fail (one missing), not-executed (contract declared, verifier never run).
const workflows = [
  workflow('wf-pass', ['verifier-out/a.csv', 'verifier-out/b.md']),
  workflow('wf-fail', ['verifier-out/a.csv', 'verifier-out/missing.md']),
  workflow('wf-notexec', ['verifier-out/a.csv'])
];
const runs = [run(1, 'wf-pass'), run(2, 'wf-fail'), run(3, 'wf-notexec')];
const history = [
  writeFileRecord(1, 1, 'verifier-out/a.csv'),
  writeFileRecord(2, 1, 'verifier-out/b.md'),
  writeFileRecord(3, 2, 'verifier-out/a.csv') // run 2 only produced a.csv; missing.md absent
  // run 3 produced nothing relevant
];

fs.writeFileSync(path.join(dataDir, 'workflows.json'), JSON.stringify(workflows, null, 2));
fs.writeFileSync(path.join(dataDir, 'runs.json'), JSON.stringify(runs, null, 2));
fs.writeFileSync(path.join(dataDir, 'operation-history.json'), JSON.stringify(history, null, 2));
fs.writeFileSync(path.join(dataDir, 'logs.json'), '[]');
fs.writeFileSync(path.join(dataDir, 'events.jsonl'), '');

// (1) verifierContract exists on each workflow
check('1. verifierContract is declared on the workflow', workflows.every(w => w.verifierContract && w.verifierContract.id));

// (2)+(3) PRESENT run: artifact check executes and records a present result
const passResult = completeRunArtifactCheck(1);
check('2. artifact check executes and returns a result', passResult && typeof passResult.status === 'string');
check('2. all artifacts present with none missing', passResult.status === 'present' && passResult.missing.length === 0);
check('2. result records contract identity', passResult.contractId === 'wf-pass-verifier' && passResult.contractVersion === '1');

const passEval = buildRunEvaluation(runs[0]);
check('3. result surfaced in evaluation.artifactCheck (recorded event read back)', passEval.artifactCheck.status === 'present' && passEval.artifactCheck.declared === true);
check('3. all-present artifact check yields effectiveness.status = passed', passEval.effectiveness.status === 'passed');

// idempotency: re-running returns the same result without a second emission
const passResultAgain = completeRunArtifactCheck(1);
check('3. artifact check is idempotent', passResultAgain && passResultAgain.status === 'present');

// (4) MISSING run: missing artifact => missing result => effectiveness failed
const failResult = completeRunArtifactCheck(2);
check('4. missing artifact yields missing result', failResult.status === 'missing' && failResult.missing.includes('verifier-out/missing.md'));
const failEval = buildRunEvaluation(runs[1]);
check('4. missing artifacts mark effectiveness.status = failed', failEval.effectiveness.status === 'failed');
check('4. missing result surfaced in evaluation.artifactCheck', failEval.artifactCheck.status === 'missing');

// (5) NOT-CHECKED run: contract declared, completeRunArtifactCheck never called => cannot pass silently
const notExecEval = buildRunEvaluation(runs[2]);
check('5. declared-but-unchecked artifact contract reports not_checked', notExecEval.artifactCheck.status === 'not_checked' && notExecEval.artifactCheck.declared === true);
check('5. declared-but-unchecked artifact contract cannot be passed', notExecEval.effectiveness.status !== 'passed');
check('5. declared-but-unchecked artifact contract is unverified', notExecEval.effectiveness.status === 'unverified');

try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}

console.log(`\nTotal: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
