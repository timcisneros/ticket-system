#!/usr/bin/env node
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OQUERY = `node ${path.join(ROOT, 'scripts', 'oquery.js')}`;
const OP_SESSION = `node ${path.join(ROOT, 'scripts', 'op-session.js')}`;
const LOCAL_DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const LOCAL_WORKSPACE_ROOT = path.resolve(path.join(ROOT, 'workspace-root'));
const TMP_ROOT = fs.mkdtempSync(path.join(require('os').tmpdir(), 'oquery-runs-'));
const EMPTY_RUNS_DIR = path.join(TMP_ROOT, 'empty');
const INIT_RUNS_DIR = path.join(TMP_ROOT, 'initializing');
const MALFORMED_RUNS_DIR = path.join(TMP_ROOT, 'malformed');
const OUTCOME_RUNS_DIR = path.join(TMP_ROOT, 'outcomes');
const REPLAY_RENDER_DIR = path.join(TMP_ROOT, 'replay-render');

function writeJson(dir, name, value) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2));
}

['tickets.json', 'runs.json', 'logs.json', 'operation-history.json', 'allocation-plans.json'].forEach(name => {
  writeJson(EMPTY_RUNS_DIR, name, []);
});
writeJson(INIT_RUNS_DIR, 'tickets.json', [{ id: 777, status: 'in_progress', objective: 'initializing run fixture' }]);
writeJson(INIT_RUNS_DIR, 'runs.json', [{
  id: 777,
  ticketId: 777,
  status: 'running',
  agentName: 'OpAgent-1',
  createdAt: '2026-05-20T00:00:00.000Z'
}]);
['logs.json', 'operation-history.json', 'allocation-plans.json'].forEach(name => {
  writeJson(INIT_RUNS_DIR, name, []);
});
writeJson(MALFORMED_RUNS_DIR, 'tickets.json', []);
writeJson(MALFORMED_RUNS_DIR, 'runs.json', { not: 'an array' });
['logs.json', 'operation-history.json', 'allocation-plans.json'].forEach(name => {
  writeJson(MALFORMED_RUNS_DIR, name, []);
});
writeJson(OUTCOME_RUNS_DIR, 'tickets.json', [
  { id: 10, status: 'completed', objective: 'completed with mutations' },
  { id: 11, status: 'completed', objective: 'completed noop' },
  { id: 12, status: 'completed', objective: 'impossible within boundary' },
  { id: 13, status: 'failed', objective: 'blocked rejected' },
  { id: 14, status: 'failed', objective: 'failed execution' },
  { id: 15, status: 'open', objective: 'interrupted run' }
]);
writeJson(OUTCOME_RUNS_DIR, 'runs.json', [
  {
    id: 10,
    ticketId: 10,
    status: 'completed',
    agentName: 'OpAgent-1',
    createdAt: '2026-05-20T00:00:00.000Z',
    mutationCount: 1,
    replaySnapshot: { model: 'test', parsedModelPlans: [{ actions: [], complete: true }], workspaceOperations: [], mutationCount: 1 }
  },
  {
    id: 11,
    ticketId: 11,
    status: 'completed',
    agentName: 'OpAgent-1',
    createdAt: '2026-05-20T00:00:00.000Z',
    mutationCount: 0,
    replaySnapshot: {
      model: 'test',
      parsedModelPlans: [{ actions: [], complete: true }],
      workspaceOperations: [],
      mutationCount: 0,
      events: [{ type: 'run:completed_noop' }]
    }
  },
  {
    id: 12,
    ticketId: 12,
    status: 'completed',
    agentName: 'OpAgent-1',
    createdAt: '2026-05-20T00:00:00.000Z',
    mutationCount: 0,
    replaySnapshot: {
      model: 'test',
      parsedModelPlans: [{ actions: [{ operation: 'listDirectory', args: { path: 'scripts' } }], complete: false }, { actions: [], complete: true }],
      workspaceOperations: [{ operation: { operation: 'listDirectory', args: { path: 'scripts' } }, result: { status: 'not_found' } }],
      mutationCount: 0,
      events: [{ type: 'run:completed_noop' }]
    }
  },
  {
    id: 13,
    ticketId: 13,
    status: 'failed',
    agentName: 'OpAgent-1',
    createdAt: '2026-05-20T00:00:00.000Z',
    error: 'Blocked protected workspace path mutation: writeFile package.json',
    mutationCount: 0,
    replaySnapshot: {
      model: 'test',
      parsedModelPlans: [{ actions: [{ operation: 'writeFile', args: { path: 'package.json', content: '{}' } }], complete: false }],
      workspaceOperations: [{ operation: { operation: 'writeFile', args: { path: 'package.json' }, blocked: true }, blocked: true, reason: 'Path matches protected workspace pattern: package.json' }],
      mutationCount: 0
    }
  },
  {
    id: 14,
    ticketId: 14,
    status: 'failed',
    agentName: 'OpAgent-1',
    createdAt: '2026-05-20T00:00:00.000Z',
    error: 'Agent run exceeded execution step limit of 4',
    mutationCount: 0,
    replaySnapshot: { model: 'test', parsedModelPlans: [], workspaceOperations: [], mutationCount: 0 }
  },
  {
    id: 15,
    ticketId: 15,
    status: 'interrupted',
    agentName: 'OpAgent-1',
    createdAt: '2026-05-20T00:00:00.000Z',
    error: 'process restarted before run completed',
    mutationCount: 0,
    replaySnapshot: { model: 'test', parsedModelPlans: [], workspaceOperations: [], mutationCount: 0, terminalStatus: 'interrupted' }
  }
]);
writeJson(OUTCOME_RUNS_DIR, 'logs.json', [
  { id: 1, runId: 11, ticketId: 11, type: 'run:completed_noop', timestamp: '2026-05-20T00:00:01.000Z', message: 'Agent run completed with no workspace changes' },
  { id: 2, runId: 12, ticketId: 12, type: 'workspace:list', timestamp: '2026-05-20T00:00:02.000Z', message: 'Ran listDirectory on scripts (not_found)', workspaceAction: { operation: 'listDirectory', args: { path: 'scripts' }, status: 'not_found', workspaceRoot: '/tmp/workspace-root' } },
  { id: 3, runId: 12, ticketId: 12, type: 'run:completed_noop', timestamp: '2026-05-20T00:00:03.000Z', message: 'Agent run completed with no workspace changes' },
  { id: 4, runId: 13, ticketId: 13, type: 'workspace:blocked', timestamp: '2026-05-20T00:00:04.000Z', message: 'Blocked protected workspace path mutation: writeFile package.json' }
]);
writeJson(OUTCOME_RUNS_DIR, 'operation-history.json', [
  {
    id: 101,
    timestamp: '2026-05-20T00:00:10.000000001Z',
    ticketId: 10,
    runId: 10,
    step: 0,
    operation: 'writeFile',
    args: { path: 'alpha.txt' },
    preState: { existed: false },
    postState: { existed: true, type: 'file' },
    result: { path: 'alpha.txt' }
  },
  {
    id: 102,
    timestamp: '2026-05-20T00:00:10.000000002Z',
    ticketId: 10,
    runId: 10,
    step: 0,
    operation: 'writeFile',
    args: { path: 'beta.txt' },
    preState: { existed: false },
    postState: { existed: true, type: 'file' },
    result: { path: 'beta.txt' }
  }
]);
writeJson(OUTCOME_RUNS_DIR, 'allocation-plans.json', []);
writeJson(REPLAY_RENDER_DIR, 'tickets.json', [
  { id: 201, status: 'failed', objective: 'replay rendering fixture' },
  { id: 202, status: 'failed', objective: 'path conflict fixture' },
  { id: 203, status: 'failed', objective: 'unsupported field fixture' },
  { id: 204, status: 'failed', objective: 'invalid json fixture' },
  { id: 205, status: 'failed', objective: 'non-progress fixture' },
  { id: 206, status: 'failed', objective: 'sensitive path fixture' },
  { id: 207, status: 'failed', objective: 'structured failure fixture' },
  { id: 208, status: 'failed', objective: 'structured timeout fixture' },
  { id: 209, status: 'interrupted', objective: 'structured interrupted fixture' }
]);
writeJson(REPLAY_RENDER_DIR, 'runs.json', [
  {
    id: 201,
    ticketId: 201,
    status: 'failed',
    agentName: 'OpAgent-1',
    createdAt: '2026-05-20T00:00:00.000Z',
    error: 'Blocked protected workspace path mutation: writeFile package.json',
    mutationCount: 1,
    replaySnapshot: {
      model: 'test',
      runtimeLimits: {
        maxExecutionSteps: 4,
        maxModelRequestsPerRun: 4,
        maxWorkspaceOperationsPerRun: 32
      },
      finalizedAt: '2026-05-20T00:00:01.000Z',
      mutationCount: 1,
      mutationOutcome: 'partial_mutations',
      failureReason: 'Blocked protected workspace path mutation: writeFile package.json',
      failure: { code: 'WORKSPACE_PROTECTED_PATH', kind: 'protected_path', detail: { operation: 'writeFile', path: 'package.json' } },
      parsedModelPlans: [{
        message: 'write one file, then hit protected path, then propose another write',
        complete: false,
        step: 0,
        actions: [
          { operation: 'writeFile', args: { path: 'app.js', content: 'ok' } },
          { operation: 'writeFile', args: { path: 'package.json', content: '{}' } },
          { operation: 'writeFile', args: { path: 'after.js', content: 'skipped' } }
        ]
      }],
      workspaceOperations: [
        {
          operation: { operation: 'writeFile', args: { path: 'app.js', content: 'ok' } },
          result: { path: 'app.js', historyId: 9001 },
          historyId: 9001
        },
        {
          operation: {
            operation: 'writeFile',
            args: { path: 'package.json' },
            blocked: true,
            reason: 'Path matches protected workspace pattern: package.json'
          },
          error: 'Blocked protected workspace path mutation: writeFile package.json',
          blocked: true,
          reason: 'Path matches protected workspace pattern: package.json',
          historyId: null
        }
      ],
      modelResponses: [{
        text: JSON.stringify({
          message: 'valid proposed writes followed by malformed action',
          actions: [
            { operation: 'writeFile', args: { path: 'app.js', content: 'ok' } },
            { operation: 'writeFile', args: { path: 'package.json', content: '{}' } },
            { operation: 'writeFile', args: { path: 'after.js', content: 'skipped' } },
            'not-an-action'
          ],
          complete: false
        })
      }]
    }
  },
  { id: 202, ticketId: 202, status: 'failed', agentName: 'OpAgent-1', createdAt: '2026-05-20T00:00:00.000Z', error: 'Path already exists and is not a directory', mutationCount: 0, replaySnapshot: { model: 'test', runtimeLimits: { maxExecutionSteps: 4 }, parsedModelPlans: [], workspaceOperations: [], mutationCount: 0, failureReason: 'Path already exists and is not a directory' } },
  { id: 203, ticketId: 203, status: 'failed', agentName: 'OpAgent-1', createdAt: '2026-05-20T00:00:00.000Z', error: 'Workspace action includes unsupported field: complete', mutationCount: 0, replaySnapshot: { model: 'test', runtimeLimits: { maxExecutionSteps: 4 }, parsedModelPlans: [], workspaceOperations: [], mutationCount: 0, failureReason: 'Workspace action includes unsupported field: complete' } },
  { id: 204, ticketId: 204, status: 'failed', agentName: 'OpAgent-1', createdAt: '2026-05-20T00:00:00.000Z', error: 'Model response was not valid execution JSON: Unterminated string', mutationCount: 0, replaySnapshot: { model: 'test', runtimeLimits: { maxExecutionSteps: 4 }, parsedModelPlans: [], workspaceOperations: [], mutationCount: 0, failureReason: 'Model response was not valid execution JSON: Unterminated string', failure: { code: 'MODEL_MALFORMED_JSON', kind: 'invalid_action', detail: { parseError: 'Unterminated string' } } } },
  { id: 205, ticketId: 205, status: 'failed', agentName: 'OpAgent-1', createdAt: '2026-05-20T00:00:00.000Z', error: 'Model repeated list-only non-progress twice', mutationCount: 0, replaySnapshot: { model: 'test', runtimeLimits: { maxExecutionSteps: 4 }, parsedModelPlans: [], workspaceOperations: [], mutationCount: 0, failureReason: 'Model repeated list-only non-progress twice', failure: { code: 'RUN_LIMIT_EXCEEDED', kind: 'no_progress', detail: { limitType: 'execution_steps', repeatedListPaths: ['.'] } } } },
  { id: 206, ticketId: 206, status: 'failed', agentName: 'OpAgent-1', createdAt: '2026-05-20T00:00:00.000Z', error: 'Agent action blocked for sensitive application path', mutationCount: 0, replaySnapshot: { model: 'test', runtimeLimits: { maxExecutionSteps: 4 }, parsedModelPlans: [], workspaceOperations: [], mutationCount: 0, failureReason: 'Agent action blocked for sensitive application path', failure: { code: 'WORKSPACE_OWNERSHIP_VIOLATION', kind: 'protected_path', detail: { path: 'scripts/oquery.js' } } } },
  { id: 207, ticketId: 207, status: 'failed', agentName: 'OpAgent-1', createdAt: '2026-05-20T00:00:00.000Z', error: 'unclassified text', mutationCount: 0, replaySnapshot: { model: 'test', runtimeLimits: { maxExecutionSteps: 4 }, parsedModelPlans: [], workspaceOperations: [], mutationCount: 0, failureReason: 'unclassified text', failure: { code: 'WORKSPACE_PROTECTED_PATH', kind: 'protected_path', detail: { path: 'package.json' } } } },
  { id: 208, ticketId: 208, status: 'failed', agentName: 'OpAgent-1', createdAt: '2026-05-20T00:00:00.000Z', error: 'unclassified text', mutationCount: 0, replaySnapshot: { model: 'test', runtimeLimits: { maxExecutionSteps: 4 }, parsedModelPlans: [], workspaceOperations: [], mutationCount: 0, failureReason: 'unclassified text', failure: { code: 'RUN_LIMIT_EXCEEDED', kind: null, detail: { limitType: 'timeout' } } } },
  { id: 209, ticketId: 209, status: 'interrupted', agentName: 'OpAgent-1', createdAt: '2026-05-20T00:00:00.000Z', error: 'unclassified text', mutationCount: 0, replaySnapshot: { model: 'test', runtimeLimits: { maxExecutionSteps: 4 }, parsedModelPlans: [], workspaceOperations: [], mutationCount: 0, failureReason: 'unclassified text', failure: { code: 'RUN_INTERRUPTED', kind: 'interrupted', detail: { reason: 'process restarted before run completed' } } } }
]);
writeJson(REPLAY_RENDER_DIR, 'logs.json', []);
writeJson(REPLAY_RENDER_DIR, 'operation-history.json', [{
  id: 9001,
  runId: 201,
  ticketId: 201,
  step: 0,
  operation: 'writeFile',
  args: { path: 'app.js' },
  result: { path: 'app.js', historyId: 9001 }
}]);
writeJson(REPLAY_RENDER_DIR, 'allocation-plans.json', []);

let passed = 0;
let failed = 0;
const errors = [];

function run(name, cmd, checkFn) {
  try {
    const stdout = execSync(cmd, { cwd: ROOT, timeout: 15000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const stderr = '';
    checkFn(stdout, stderr);
    console.log(`  ${'\x1b[32m'}✓${'\x1b[0m'} ${name}`);
    passed++;
  } catch (e) {
    const out = e.stdout || '';
    const err = e.stderr || '';
    try {
      checkFn(out, err);
      console.log(`  ${'\x1b[32m'}✓${'\x1b[0m'} ${name}`);
      passed++;
    } catch (checkErr) {
      console.log(`  ${'\x1b[31m'}✗${'\x1b[0m'} ${name}`);
      failed++;
      errors.push(`${name}: ${checkErr.message}\n  stdout: ${out.slice(0, 200)}\n  stderr: ${err.slice(0, 200)}`);
    }
  }
}

function contains(s, substr) {
  if (!s.includes(substr)) throw new Error(`Expected "${substr}" in output`);
}

function notContains(s, substr) {
  if (s.includes(substr)) throw new Error(`Did not expect "${substr}" in output`);
}

function isJSON(s) {
  JSON.parse(s);
}

function isNotJSON(s) {
  try { JSON.parse(s); throw new Error('Expected non-JSON output'); } catch (e) { if (e.message !== 'Expected non-JSON output') return; throw e; }
}

// ── Flag parsing ──

console.log('\n1. Flag parsing + ordering');
run('replay 1 (positional only)', `${OQUERY} replay 1 2>/dev/null | grep 'Replay:'`, out => contains(out, 'Replay:'));
run('replay 1 --api (flag after positional)', `${OQUERY} replay 1 --api 2>/dev/null | grep 'Replay:'`, out => contains(out, 'Replay:'));
run('replay --api 1 (flag before positional)', `${OQUERY} replay --api 1 2>/dev/null | grep 'Replay:'`, out => contains(out, 'Replay:'));
run('--api --ticket 1 (both value flags)', `${OQUERY} runs --api --ticket 1 2>/dev/null | head -2`, out => contains(out, 'R1'));
run('--ticket 1 --api (reversed)', `${OQUERY} runs --ticket 1 --api 2>/dev/null | head -2`, out => contains(out, 'R1'));

// ── JSON purity ──

console.log('\n2. JSON purity');
run('tickets --json is valid JSON', `${OQUERY} tickets --json --limit 1 2>/dev/null`, out => { isJSON(out); });
run('tickets --api --json is valid JSON', `${OQUERY} tickets --api --json --limit 1 2>/dev/null`, out => { isJSON(out); });
run('runs --json is valid JSON', `${OQUERY} runs --json --limit 1 2>/dev/null`, out => { isJSON(out); });
run('runs --api --json is valid JSON', `${OQUERY} runs --api --json --limit 1 2>/dev/null`, out => { isJSON(out); });
run('runs with no matches prints explicit state', `DATA_DIR=${EMPTY_RUNS_DIR} ${OQUERY} runs --ticket 999999 2>/dev/null`, out => contains(out, 'No matching runs.'));
run('runs with no steps prints initializing state', `DATA_DIR=${INIT_RUNS_DIR} ${OQUERY} runs --id 777 2>/dev/null`, out => { contains(out, 'initializing'); contains(out, 'no steps recorded yet'); });
run('runs malformed data prints explicit state', `DATA_DIR=${MALFORMED_RUNS_DIR} ${OQUERY} runs 2>/dev/null`, out => contains(out, 'Runs unavailable: malformed_response'));
run('runs malformed data --json is valid JSON', `DATA_DIR=${MALFORMED_RUNS_DIR} ${OQUERY} runs --json 2>/dev/null`, out => { isJSON(out); contains(out, 'malformed_response'); });
run('runs distinguishes completed with mutations', `DATA_DIR=${OUTCOME_RUNS_DIR} ${OQUERY} runs --id 10 2>/dev/null`, out => contains(out, 'completed_with_mutations'));
run('runs distinguishes completed noop', `DATA_DIR=${OUTCOME_RUNS_DIR} ${OQUERY} runs --id 11 2>/dev/null`, out => contains(out, 'completed_noop'));
run('runs distinguishes impossible within boundary', `DATA_DIR=${OUTCOME_RUNS_DIR} ${OQUERY} runs --id 12 2>/dev/null`, out => contains(out, 'impossible_within_boundary'));
run('runs distinguishes blocked rejected', `DATA_DIR=${OUTCOME_RUNS_DIR} ${OQUERY} runs --id 13 2>/dev/null`, out => contains(out, 'blocked/rejected'));
run('runs distinguishes failed execution', `DATA_DIR=${OUTCOME_RUNS_DIR} ${OQUERY} runs --id 14 2>/dev/null`, out => contains(out, 'failed_execution'));
run('runs distinguishes interrupted outcome', `DATA_DIR=${OUTCOME_RUNS_DIR} ${OQUERY} runs --id 15 2>/dev/null`, out => contains(out, 'interrupted'));
run('failures classifies interrupted status from structured run status', `DATA_DIR=${OUTCOME_RUNS_DIR} ${OQUERY} failures --type interrupted 2>/dev/null`, out => {
  contains(out, 'INTERRUPTED');
  notContains(out, 'No failures found');
});
run('runs --json includes operational outcome', `DATA_DIR=${OUTCOME_RUNS_DIR} ${OQUERY} runs --json --id 12 2>/dev/null`, out => { isJSON(out); contains(out, '"operationalOutcome": "impossible_within_boundary"'); });
run('tickets includes latest run outcome', `DATA_DIR=${OUTCOME_RUNS_DIR} ${OQUERY} tickets --limit 1 2>/dev/null`, out => contains(out, 'outcome: completed_with_mutations'));
run('tickets --json includes latest run outcome', `DATA_DIR=${OUTCOME_RUNS_DIR} ${OQUERY} tickets --json --limit 1 2>/dev/null`, out => { isJSON(out); contains(out, '"latestRunOutcome": "completed_with_mutations"'); });
run('mutations text includes canonical history ids', `DATA_DIR=${OUTCOME_RUNS_DIR} ${OQUERY} mutations --ticket 10 2>/dev/null`, out => {
  contains(out, 'H101');
  contains(out, 'H102');
});
run('failures --json is valid JSON', `${OQUERY} failures --json --limit 1 2>/dev/null`, out => { isJSON(out); });
run('failures --api --json is valid JSON', `${OQUERY} failures --api --json --limit 1 2>/dev/null`, out => { isJSON(out); });
run('coverage --json 1 is valid JSON', `${OQUERY} coverage --json 1 2>/dev/null`, out => { isJSON(out); });
run('coverage --api --json 1 is valid JSON', `${OQUERY} coverage --api --json 1 2>/dev/null`, out => { isJSON(out); });
run('replay distinguishes proposed committed blocked and skipped actions', `DATA_DIR=${REPLAY_RENDER_DIR} ${OQUERY} replay 201 2>/dev/null`, out => {
  contains(out, 'PROPOSED');
  contains(out, 'COMMITTED');
  contains(out, 'BLOCKED');
  contains(out, 'SKIPPED');
  contains(out, 'not executed after blocked/rejected operation');
});
run('failures labels valid proposed actions without implying execution success', `DATA_DIR=${REPLAY_RENDER_DIR} ${OQUERY} failures --run 201 2>/dev/null`, out => {
  contains(out, 'PROPOSED_VALID');
  notContains(out, 'OK');
});
run('failures distinguishes proposed action execution states', `DATA_DIR=${REPLAY_RENDER_DIR} ${OQUERY} failures --run 201 2>/dev/null`, out => {
  contains(out, 'PROPOSED_VALID');
  contains(out, 'COMMITTED');
  contains(out, 'BLOCKED');
  contains(out, 'SKIPPED');
  contains(out, 'not executed after blocked/rejected operation');
});
run('failures classifies protected path rejection', `DATA_DIR=${REPLAY_RENDER_DIR} ${OQUERY} failures --run 201 2>/dev/null`, out => {
  contains(out, 'PROTECTED_PATH');
  notContains(out, 'UNKNOWN');
});
run('failures classifies structured ownership rejection', `DATA_DIR=${REPLAY_RENDER_DIR} ${OQUERY} failures --run 206 2>/dev/null`, out => {
  contains(out, 'PROTECTED_PATH');
  notContains(out, 'UNKNOWN');
});
run('failures leaves unstructured path conflict unknown', `DATA_DIR=${REPLAY_RENDER_DIR} ${OQUERY} failures --run 202 2>/dev/null`, out => {
  contains(out, 'UNKNOWN');
  notContains(out, 'FS ERROR');
});
run('failures leaves unstructured unsupported fields unknown', `DATA_DIR=${REPLAY_RENDER_DIR} ${OQUERY} failures --run 203 2>/dev/null`, out => {
  contains(out, 'UNKNOWN');
  notContains(out, 'INVALID');
});
run('failures classifies structured malformed model JSON as invalid action', `DATA_DIR=${REPLAY_RENDER_DIR} ${OQUERY} failures --run 204 2>/dev/null`, out => {
  contains(out, 'INVALID');
  notContains(out, 'UNKNOWN');
});
run('failures classifies structured list-only non-progress', `DATA_DIR=${REPLAY_RENDER_DIR} ${OQUERY} failures --run 205 2>/dev/null`, out => {
  contains(out, 'NO_PROGRESS');
  notContains(out, 'UNKNOWN');
});
run('failures prefers structured failure kind over text', `DATA_DIR=${REPLAY_RENDER_DIR} ${OQUERY} failures --run 207 2>/dev/null`, out => {
  contains(out, 'PROTECTED_PATH');
  notContains(out, 'UNKNOWN');
});
run('failures maps structured run-limit timeout code', `DATA_DIR=${REPLAY_RENDER_DIR} ${OQUERY} failures --run 208 2>/dev/null`, out => {
  contains(out, 'TIMEOUT');
  notContains(out, 'UNKNOWN');
});
run('failures maps structured interrupted code', `DATA_DIR=${REPLAY_RENDER_DIR} ${OQUERY} failures --run 209 2>/dev/null`, out => {
  contains(out, 'INTERRUPTED');
  notContains(out, 'UNKNOWN');
});

// ── Substrate label suppression in JSON mode ──

console.log('\n3. Substrate label suppression in JSON mode');
run('no [local substrate] in --json', `${OQUERY} tickets --json --limit 1 2>/dev/null`, out => notContains(out, 'substrate'));
run('no [remote substrate] in --api --json', `${OQUERY} tickets --api --json --limit 1 2>/dev/null`, out => notContains(out, 'substrate'));
run('no [local substrate] in failures --json', `${OQUERY} failures --json --limit 1 2>/dev/null`, out => notContains(out, 'substrate'));
run('no [remote substrate] in coverage --api --json', `${OQUERY} coverage --api --json 1 2>/dev/null`, out => notContains(out, 'substrate'));

// ── Substrate label visibility in non-JSON mode ──

console.log('\n4. Substrate label visibility in non-JSON mode');
run('[local substrate] in tickets', `${OQUERY} tickets --limit 1 2>/dev/null`, out => contains(out, 'local substrate'));
run('[remote substrate] in tickets --api', `${OQUERY} tickets --api --limit 1 2>/dev/null`, out => contains(out, 'remote substrate'));
run('[local substrate] in stats', `${OQUERY} stats 2>/dev/null`, out => contains(out, 'local substrate'));
run('[remote substrate] in stats --api', `${OQUERY} stats --api 2>/dev/null`, out => contains(out, 'remote substrate'));
run('[local substrate] in failures', `${OQUERY} failures --limit 1 2>/dev/null`, out => contains(out, 'local substrate'));
run('[remote substrate] in failures --api', `${OQUERY} failures --api --limit 1 2>/dev/null`, out => contains(out, 'remote substrate'));

// ── Divergence warning ──

console.log('\n5. Divergence warning');
run('divergence dataDir on local when server differs', `${OQUERY} tickets --limit 1 2>/dev/null`, out => contains(out, 'dataDir:'));
run('divergence workspaceRoot with forced mismatch', `WORKSPACE_ROOT=/tmp/fake-root ${OQUERY} tickets --limit 1 2>/dev/null`, out => contains(out, 'workspaceRoot:'));
run('no divergence in --api mode', `${OQUERY} tickets --api --limit 1 2>/dev/null`, out => { notContains(out, 'dataDir:'); notContains(out, 'workspaceRoot:'); });
run('no divergence in --json mode', `${OQUERY} tickets --json --limit 1 2>/dev/null`, out => { notContains(out, 'dataDir:'); notContains(out, 'workspaceRoot:'); });
run('no divergence markers in coverage --json', `${OQUERY} coverage --json 1 2>/dev/null`, out => { notContains(out, 'dataDir:'); notContains(out, 'workspaceRoot:'); });
run('no divergence markers in failures --api --json', `${OQUERY} failures --api --json --limit 1 2>/dev/null`, out => { notContains(out, 'dataDir:'); notContains(out, 'workspaceRoot:'); });
run('both identities absent when no mismatch', `DATA_DIR=/tmp/op-data ${OQUERY} tickets --limit 1 2>/dev/null`, out => { notContains(out, 'dataDir:'); notContains(out, 'workspaceRoot:'); });

// ── op-session ──

console.log('\n6. op-session');
run('op-session list-tickets clean JSON', `${OP_SESSION} list-tickets 2>/dev/null`, out => { isJSON(out); });
run('op-session list-runs clean JSON', `${OP_SESSION} list-runs 2>/dev/null`, out => { isJSON(out); });
run('op-session run-status [local substrate]', `${OP_SESSION} run-status 2>/dev/null`, out => contains(out, 'local substrate'));
run('op-session wait nonexistent fails fast', `timeout 5 ${OP_SESSION} wait 999 2>&1`, out => contains(out, 'not found'));
run('op-session help shows BASE URL', `${OP_SESSION} help 2>/dev/null`, out => contains(out, 'http://127.0.0.1:3099'));

// ── Summary ──

console.log(`\n${passed} passed, ${failed} failed${errors.length > 0 ? '\n' + errors.join('\n') : ''}`);
process.exit(failed > 0 ? 1 : 0);
