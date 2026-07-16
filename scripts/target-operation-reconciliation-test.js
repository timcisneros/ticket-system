#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_FILES = [
  'agents.json', 'allocation-plans.json', 'groups.json', 'logs.json', 'memberships.json',
  'operation-history.json', 'permissions.json', 'runs.json', 'tickets.json', 'users.json'
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function request(baseUrl, method, urlPath, options = {}) {
  const body = options.form ? new URLSearchParams(options.form).toString() : null;
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${urlPath}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function waitForExit(child, timeoutMs = 20_000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for test server exit')), timeoutMs))
  ]);
}

async function waitForReady(baseUrl) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await request(baseUrl, 'GET', '/health');
      if (response.statusCode === 200 && JSON.parse(response.body).ready) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for reconciliation test server');
}

async function waitForRun(dataDir, predicate) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const runs = JSON.parse(fs.readFileSync(path.join(dataDir, 'runs.json'), 'utf8'));
    const run = runs.find(predicate);
    if (run) return run;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error('Timed out waiting for reconciled run state');
}

function preloadSource(objective, fileName, content) {
  return `
global.fetch = async function(url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const combined = (body.input || []).map(item => String(item && item.content || '')).join('\\n');
  const plan = combined.includes(${JSON.stringify(objective)})
    ? { message: 'write target', actions: [{ operation: 'writeFile', args: { path: ${JSON.stringify(fileName)}, content: ${JSON.stringify(content)} } }], complete: true }
    : { message: 'complete', actions: [], complete: true };
  return { ok: true, status: 200, headers: new Map([['x-request-id', 'target-reconciliation-test']]), async text() {
    return JSON.stringify({ output_text: JSON.stringify(plan), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
  } };
};
`;
}

async function runScenario({ name, port, diverge }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `target-reconciliation-${name}-data-`));
  const workspaceRoot = createTempWorkspaceRoot(`target-reconciliation-${name}`);
  const objective = `target-reconciliation-${name}-${Date.now()}`;
  const fileName = `${objective}.txt`;
  const intendedContent = 'intended-content';
  const preloadPath = path.join(os.tmpdir(), `${objective}-preload.js`);
  const baseUrl = `http://127.0.0.1:${port}`;
  let server = null;

  try {
    for (const file of DATA_FILES) {
      const source = path.join(REAL_DATA_DIR, file);
      fs.copyFileSync(source, path.join(dataDir, file));
    }
    const agents = JSON.parse(fs.readFileSync(path.join(dataDir, 'agents.json'), 'utf8'));
    const agentId = Math.max(0, ...agents.map(agent => agent.id)) + 1;
    agents.push({
      id: agentId,
      name: `TargetReconciliation-${name}`,
      type: 'agent',
      provider: 'openai',
      model: 'gpt-test',
      apiKey: 'test-key',
      createdAt: new Date().toISOString()
    });
    fs.writeFileSync(path.join(dataDir, 'agents.json'), JSON.stringify(agents, null, 2));
    fs.writeFileSync(preloadPath, preloadSource(objective, fileName, intendedContent));

    const spawnServer = interruptionPoint => {
      const child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PORT: String(port),
          DATA_DIR: dataDir,
          WORKSPACE_ROOT: workspaceRoot,
          NODE_OPTIONS: `--require ${preloadPath}`,
          ...(interruptionPoint ? { TEST_INTERRUPTION_POINT: interruptionPoint } : {})
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      child.stdout.on('data', chunk => process.stdout.write(String(chunk)));
      child.stderr.on('data', chunk => process.stderr.write(String(chunk)));
      return child;
    };

    server = spawnServer('after_first_workspace_target_effect');
    await waitForReady(baseUrl);
    const login = await request(baseUrl, 'POST', '/login', { form: { username: 'admin', password: 'admin123' } });
    const cookie = (login.headers['set-cookie'] || []).map(value => value.split(';')[0]).join('; ');
    const created = await request(baseUrl, 'POST', '/tickets', {
      cookie,
      form: { objective, assignmentTargetType: 'agent', assignmentTargetId: String(agentId) }
    });
    assert(created.statusCode === 302, `ticket creation failed for ${name}: ${created.statusCode}`);
    await waitForExit(server);
    server = null;

    const targetPath = path.join(workspaceRoot, fileName);
    assert(fs.readFileSync(targetPath, 'utf8') === intendedContent, `${name}: target effect did not happen before crash`);
    const historyBeforeRestart = JSON.parse(fs.readFileSync(path.join(dataDir, 'operation-history.json'), 'utf8'));
    assert(historyBeforeRestart.length === 0, `${name}: receipt existed before the crash boundary`);
    const journalBeforeRestart = fs.readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8');
    assert(journalBeforeRestart.includes('workspace.operation_prepared'), `${name}: prepared intent is missing`);

    if (diverge) fs.writeFileSync(targetPath, 'unexpected-third-party-content');
    server = spawnServer(null);
    await waitForReady(baseUrl);
    const finalRun = await waitForRun(dataDir, run =>
      run.status === (diverge ? 'interrupted' : 'completed')
    );
    const history = JSON.parse(fs.readFileSync(path.join(dataDir, 'operation-history.json'), 'utf8'));
    const events = fs.readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

    if (diverge) {
      assert(history.length === 0, 'uncertain effect must not manufacture a receipt');
      assert(fs.readFileSync(targetPath, 'utf8') === 'unexpected-third-party-content', 'uncertain effect must not be retried or overwritten');
      assert(events.some(event => event.type === 'workspace.operation_reconciliation_required'),
        'uncertain effect must emit reconciliation-required evidence');
    } else {
      assert(history.length === 1, `applied effect should produce exactly one receipt, found ${history.length}`);
      assert(history[0].isRecovery === true, 'applied effect receipt must identify reconciliation');
      assert(history[0].operationKey, 'applied effect receipt must retain its stable operation key');
      assert(events.filter(event => event.type === 'workspace.operation').length === 1,
        'applied effect must produce exactly one completion event');
      assert(events.some(event => event.type === 'workspace.operation' && event.payload && event.payload.isRecovery === true),
        'completion event must expose reconciliation');
      const replay = JSON.parse(fs.readFileSync(path.join(dataDir, finalRun.replaySnapshotPath), 'utf8'));
      assert(replay.workspaceOperations.some(item => item.operationKey === history[0].operationKey && item.isRecovery === true),
        'replay must link the reconciled receipt');
    }
  } finally {
    if (server) {
      server.kill('SIGTERM');
      await waitForExit(server).catch(() => {});
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(preloadPath, { force: true });
    removeTempWorkspaceRoot(workspaceRoot);
  }
}

async function main() {
  await runScenario({ name: 'applied', port: 3494, diverge: false });
  await runScenario({ name: 'uncertain', port: 3495, diverge: true });
  console.log('PASS: prepared target effects are reconciled when applied and refused when uncertain');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
