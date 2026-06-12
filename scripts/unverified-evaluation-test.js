#!/usr/bin/env node
// Unverified Evaluation Test — verifies buildRunEvaluation reports effectiveness.status:
//   - 'unverified' for a completed run with no postcondition verdict
//   - 'passed'     for a completed run with a passing postcondition verdict
//   - 'failed'     when a postcondition failed

const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unverified-eval-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.WORKSPACE_ROOT = path.join(dataDir, 'ws');

const { appendEvent, buildRunEvaluation } = require('../server.js');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; } else { failed++; console.error(`FAIL: ${name}`); }
}

function writeBaseline(run) {
  fs.writeFileSync(path.join(dataDir, 'runs.json'), JSON.stringify([run], null, 2));
  fs.writeFileSync(path.join(dataDir, 'logs.json'), JSON.stringify([], null, 2));
  fs.writeFileSync(path.join(dataDir, 'events.jsonl'), '');
  fs.writeFileSync(path.join(dataDir, 'operation-history.json'), JSON.stringify([], null, 2));
}

const now = new Date().toISOString();

// Case 1: completed direct-agent run, no postcondition verdict → 'unverified'
{
  const run = { id: 1, ticketId: 1, agentId: 1, executionMode: 'agent', status: 'completed', startedAt: now, completedAt: now, replaySnapshot: {} };
  writeBaseline(run);
  const evaluation = buildRunEvaluation(run);
  check('completed run with no verdict => unverified', evaluation.effectiveness.status === 'unverified');
  check('unverified is not passed', evaluation.effectiveness.status !== 'passed');
}

// Case 2: completed workflow run with a passing postcondition verdict → 'passed'
{
  const run = { id: 2, ticketId: 2, agentId: 1, executionMode: 'workflow', workflowId: 'wf', status: 'completed', startedAt: now, completedAt: now, replaySnapshot: {} };
  writeBaseline(run);
  appendEvent({ type: 'run.postconditions_checked', ticketId: 2, runId: 2, payload: { status: 'passed', passed: 1, failed: 0, total: 1 } });
  const evaluation = buildRunEvaluation(run);
  check('completed run with passing verdict => passed', evaluation.effectiveness.status === 'passed');
}

// Case 3: completed run with a failed postcondition → 'failed'
{
  const run = { id: 3, ticketId: 3, agentId: 1, executionMode: 'workflow', workflowId: 'wf', status: 'completed', startedAt: now, completedAt: now, replaySnapshot: {} };
  writeBaseline(run);
  appendEvent({ type: 'run.postcondition_failed', ticketId: 3, runId: 3, payload: { reason: 'missing artifact' } });
  appendEvent({ type: 'run.postconditions_checked', ticketId: 3, runId: 3, payload: { status: 'failed', passed: 0, failed: 1, total: 1 } });
  const evaluation = buildRunEvaluation(run);
  check('completed run with failed postcondition => failed', evaluation.effectiveness.status === 'failed');
}

try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}

console.log(`\nTotal: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
