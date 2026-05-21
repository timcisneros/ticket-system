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
run('failures --json is valid JSON', `${OQUERY} failures --json --limit 1 2>/dev/null`, out => { isJSON(out); });
run('failures --api --json is valid JSON', `${OQUERY} failures --api --json --limit 1 2>/dev/null`, out => { isJSON(out); });
run('coverage --json 1 is valid JSON', `${OQUERY} coverage --json 1 2>/dev/null`, out => { isJSON(out); });
run('coverage --api --json 1 is valid JSON', `${OQUERY} coverage --api --json 1 2>/dev/null`, out => { isJSON(out); });

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
