#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STAMP = Date.now();
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'target-provider-contract-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'target-provider-contract-workspace-'));
const PORT = String(19000 + Math.floor(Math.random() * 1000));
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AGENT_ID = 9914;
const CONTRACT_OBJECTIVE = `TARGET-PROVIDER-CONTRACT-${STAMP}`;
const PROTECTED_OBJECTIVE = `TARGET-PROVIDER-PROTECTED-${STAMP}`;
const TARGET_ID = 'local-workspace';
const TARGET_KIND = 'localWorkspace';

let server = null;
let preloadPath = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2));
}

function readEvents() {
  const file = path.join(DATA_DIR, 'events.jsonl');
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function setupDataDir() {
  fs.mkdirSync(path.join(DATA_DIR, 'replay-snapshots'), { recursive: true });
  for (const file of ['users.json', 'agents.json', 'groups.json', 'memberships.json', 'permissions.json', 'workflows.json']) {
    fs.copyFileSync(path.join(ROOT, 'data', file), path.join(DATA_DIR, file));
  }
  for (const file of ['tickets.json', 'runs.json', 'logs.json', 'operation-history.json', 'allocation-plans.json']) {
    writeJson(file, []);
  }
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), '');
  fs.writeFileSync(path.join(WORKSPACE_ROOT, 'seed.txt'), 'seed content', 'utf8');

  const agents = readJson('agents.json').filter(agent => agent.id !== AGENT_ID);
  agents.push({
    id: AGENT_ID,
    name: 'Target Provider Contract Agent',
    type: 'agent',
    provider: 'openai',
    model: 'fake-target-provider-model',
    apiKey: 'fake-target-provider-key',
    runtimeConfig: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  writeJson('agents.json', agents);
}

function createPreload() {
  preloadPath = path.join(os.tmpdir(), `target-provider-contract-openai-${process.pid}-${STAMP}.js`);
  const source = `
const calls = new Map();

function response(plan) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'target-provider-contract']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify(plan),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
}

global.fetch = async function(_url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const combined = (Array.isArray(body.input) ? body.input : [])
    .map(item => item && item.content ? String(item.content) : '')
    .join('\\n');

  if (combined.includes(${JSON.stringify(PROTECTED_OBJECTIVE)})) {
    return response({
      message: 'Attempt protected write.',
      actions: [{ operation: 'writeFile', args: { path: '.env.target-provider-test', content: 'blocked' } }],
      complete: true
    });
  }

  const marker = ${JSON.stringify(CONTRACT_OBJECTIVE)};
  const count = (calls.get(marker) || 0) + 1;
  calls.set(marker, count);
  if (count === 1) {
    return response({
      message: 'Inspect local target.',
      actions: [
        { operation: 'listDirectory', args: { path: '' } },
        { operation: 'readFile', args: { path: 'seed.txt' } }
      ],
      complete: false
    });
  }
  if (count === 2) {
    return response({
      message: 'Create target resources.',
      actions: [
        { operation: 'createFolder', args: { path: 'contract-dir' } },
        { operation: 'writeFile', args: { path: 'contract-dir/note.txt', content: 'target provider contract' } }
      ],
      complete: false
    });
  }
  return response({
    message: 'Rename and delete target resource.',
    actions: [
      { operation: 'renamePath', args: { path: 'contract-dir/note.txt', nextPath: 'contract-dir/renamed.txt' } },
      { operation: 'deletePath', args: { path: 'contract-dir/renamed.txt' } }
    ],
    complete: true
  });
};
`;
  fs.writeFileSync(preloadPath, source);
  return preloadPath;
}

function request(method, urlPath, options = {}) {
  const body = options.form ? new URLSearchParams(options.form).toString() : null;
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${urlPath}`, {
      method,
      headers: {
        ...(body ? {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body)
        } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function cookieFrom(response) {
  return (response.headers['set-cookie'] || []).map(cookie => cookie.split(';')[0]).join('; ');
}

async function waitFor(fn, timeoutMs = 30000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(intervalMs);
  }
  throw new Error('Timed out waiting for condition');
}

async function waitForReady() {
  await waitFor(async () => {
    if (server && server.exitCode !== null) throw new Error(`Server exited before ready with code ${server.exitCode}`);
    try {
      const response = await request('GET', '/health');
      return response.statusCode === 200 && JSON.parse(response.body).ready;
    } catch (_) {
      return false;
    }
  }, 15000);
}

async function login() {
  const response = await request('POST', '/login', {
    form: { username: 'admin', password: 'admin123' }
  });
  assert(response.statusCode === 302, `Admin login failed with HTTP ${response.statusCode}`);
  return cookieFrom(response);
}

async function createTicket(cookie, objective) {
  const response = await request('POST', '/tickets', {
    cookie,
    form: {
      objective,
      assignmentTargetType: 'agent',
      assignmentTargetId: String(AGENT_ID),
      assignmentMode: 'individual'
    }
  });
  assert(response.statusCode === 302, `Ticket creation failed with HTTP ${response.statusCode}: ${response.body}`);
  return waitFor(() => {
    const ticket = readJson('tickets.json').find(item => item.objective === objective);
    if (!ticket) return null;
    const run = readJson('runs.json').find(item => item.ticketId === ticket.id);
    return run ? { ticket, run } : null;
  });
}

async function waitForTerminalRun(runId) {
  return waitFor(() => {
    const run = readJson('runs.json').find(item => item.id === runId);
    return run && ['completed', 'failed', 'interrupted'].includes(run.status) ? run : null;
  });
}

function readSnapshot(runId) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'replay-snapshots', `run-${runId}.json`), 'utf8'));
}

function assertTargetIdentity(value, label) {
  assert(value.targetId === TARGET_ID, `${label} targetId mismatch`);
  assert(value.targetKind === TARGET_KIND, `${label} targetKind mismatch`);
  assert(value.targetScope && value.targetScope.root === WORKSPACE_ROOT, `${label} targetScope mismatch`);
}

async function main() {
  setupDataDir();
  const preload = createPreload();
  let output = '';

  try {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT,
        DATA_DIR,
        WORKSPACE_ROOT,
        NODE_OPTIONS: `--require ${preload}`,
        AGENT_MAX_EXECUTION_STEPS: '5',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '5',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '12',
        AGENT_MAX_RUNTIME_DURATION_MS: '15000'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', chunk => { output += chunk.toString(); });
    server.stderr.on('data', chunk => { output += chunk.toString(); });

    await waitForReady();
    const cookie = await login();
    const created = await createTicket(cookie, CONTRACT_OBJECTIVE);
    const run = await waitForTerminalRun(created.run.id);
    assert(run.status === 'completed', `Contract run did not complete: ${run.status} ${run.error || ''}`);

    const snapshot = readSnapshot(run.id);
    assertTargetIdentity(snapshot, 'Replay snapshot');
    assert(snapshot.targetProvider && snapshot.targetProvider.id === TARGET_ID, 'Replay snapshot missing target provider descriptor');
    assert(snapshot.targetProvider.capabilities.listDirectory === true, 'Target provider missing listDirectory capability');
    assert(snapshot.targetProvider.capabilities.readFile === true, 'Target provider missing readFile capability');
    assert(snapshot.targetProvider.capabilities.writeFile === true, 'Target provider missing writeFile capability');
    assert(snapshot.targetProvider.capabilities.renamePath === true, 'Target provider missing renamePath capability');
    assert(snapshot.targetProvider.capabilities.deletePath === true, 'Target provider missing deletePath capability');

    const operations = snapshot.workspaceOperations || [];
    const byOperation = operationName => operations.find(item => item.operation && item.operation.operation === operationName);
    for (const operationName of ['listDirectory', 'readFile', 'createFolder', 'writeFile', 'renamePath', 'deletePath']) {
      const entry = byOperation(operationName);
      assert(entry, `Replay snapshot missing ${operationName}`);
      assertTargetIdentity(entry, `Replay ${operationName}`);
      assert(entry.workspaceRoot === WORKSPACE_ROOT, `Replay ${operationName} lost workspaceRoot`);
    }

    const listReceipt = byOperation('listDirectory').readReceipt;
    const readReceipt = byOperation('readFile').readReceipt;
    assert(listReceipt && listReceipt.metadata.entryCount >= 1, 'listDirectory read receipt missing entry metadata');
    assert(listReceipt.partial === false && listReceipt.truncated === false, 'listDirectory read receipt markers changed');
    assert(readReceipt && readReceipt.metadata.contentHash, 'readFile receipt missing content hash');
    assert(readReceipt.metadata.size === Buffer.byteLength('seed content'), 'readFile receipt size mismatch');

    const runEvents = readEvents().filter(event => event.runId === run.id);
    const eventsByEvidenceKey = new Map(runEvents
      .filter(event => event.payload && event.payload.evidenceKey)
      .map(event => [event.payload.evidenceKey, event]));
    for (const [collection, eventType] of [
      ['providerRequests', 'provider.request.persisted'],
      ['modelResponses', 'provider.response.persisted'],
      ['parsedModelPlans', 'model.plan.parsed'],
      ['targetSnapshots', 'target.snapshot.captured'],
      ['workspaceOperations', 'workspace.operation']
    ]) {
      const items = Array.isArray(snapshot[collection]) ? snapshot[collection] : [];
      assert(items.length > 0, `${collection} evidence is missing`);
      for (const item of items) {
        assert(typeof item.evidenceKey === 'string' && item.evidenceKey.length > 0,
          `${collection} item is missing a stable evidence key`);
        const pairedEvent = eventsByEvidenceKey.get(item.evidenceKey);
        assert(pairedEvent && pairedEvent.type === eventType,
          `${collection} item is not paired with ${eventType}`);
      }
    }

    const history = readJson('operation-history.json').filter(item => item.runId === run.id);
    assert(history.length === 4, `Expected four mutation history entries, found ${history.length}`);
    for (const record of history) {
      assertTargetIdentity(record, `History ${record.operation}`);
      assert(record.args && record.preState && record.postState, `History ${record.operation} lost existing fields`);
      assert(record.mutationReceipt, `History ${record.operation} missing mutation receipt`);
      assert(record.mutationReceipt.operationId === record.id, `History ${record.operation} receipt id mismatch`);
      assert(record.mutationReceipt.runId === run.id, `History ${record.operation} receipt run id mismatch`);
      assert(record.mutationReceipt.ticketId === run.ticketId, `History ${record.operation} receipt ticket id mismatch`);
      assert(record.mutationReceipt.authorityDecision && record.mutationReceipt.authorityDecision.status === 'allowed', `History ${record.operation} receipt missing authority decision`);
    }

    const workspaceEvents = await waitFor(() => {
      const events = readEvents().filter(event => event.runId === run.id && event.type === 'workspace.operation');
      return events.length >= 6 ? events : null;
    });
    assert(workspaceEvents.length === 6, `Expected six workspace.operation events, found ${workspaceEvents.length}`);
    for (const event of workspaceEvents) {
      assertTargetIdentity(event.payload, `Event ${event.payload.operation}`);
      assert(Object.prototype.hasOwnProperty.call(event.payload, 'input'), `Event ${event.payload.operation} lost input`);
    }
    assert(workspaceEvents.find(event => event.payload.operation === 'listDirectory').payload.readReceipt, 'listDirectory event missing read receipt');
    assert(workspaceEvents.find(event => event.payload.operation === 'writeFile').payload.mutationReceipt, 'writeFile event missing mutation receipt');

    assert(Array.isArray(snapshot.targetSnapshots) && snapshot.targetSnapshots.length >= 1, 'Replay snapshot missing target snapshots');
    const rootSnapshot = snapshot.targetSnapshots[0].snapshot;
    assertTargetIdentity(rootSnapshot, 'Root target snapshot');
    assert(rootSnapshot.bounded === true && rootSnapshot.partial === true && rootSnapshot.full === false, 'Root snapshot bounds metadata mismatch');
    assert(rootSnapshot.entryLimit === 200 && rootSnapshot.truncated === false, 'Root snapshot limit/truncation metadata mismatch');
    assert(rootSnapshot.entries.some(entry => entry.name === 'seed.txt'), 'Root snapshot lost existing listing behavior');

    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'contract-dir')), 'createFolder behavior changed');
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, 'contract-dir', 'note.txt')), 'renamePath source still exists');
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, 'contract-dir', 'renamed.txt')), 'deletePath behavior changed');

    const traversal = await request('GET', '/api/workspace/file?path=../outside.txt', { cookie });
    assert(traversal.statusCode === 400, `Traversal request returned HTTP ${traversal.statusCode}`);
    assert(traversal.body.includes('Path traversal is not allowed'), 'Traversal rejection message changed');

    const protectedCreated = await createTicket(cookie, PROTECTED_OBJECTIVE);
    const protectedRun = await waitForTerminalRun(protectedCreated.run.id);
    assert(protectedRun.status === 'failed', `Protected-path run should fail, got ${protectedRun.status}`);
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, '.env.target-provider-test')), 'Protected path mutation was not blocked');
    assert(!readJson('operation-history.json').some(item => item.runId === protectedRun.id), 'Blocked protected mutation created operation history');
    const protectedEvents = await waitFor(() => {
      const events = readEvents().filter(event => event.runId === protectedRun.id);
      return events.some(event => event.type === 'workspace.operation') &&
        events.some(event => event.type === 'authority.denied')
        ? events
        : null;
    });
    assert(protectedEvents.some(event => event.type === 'authority.denied' && event.payload.rule === 'protected_path'), 'Protected path authority denial missing');
    const protectedWorkspaceEvent = protectedEvents.find(event => event.type === 'workspace.operation');
    assert(protectedWorkspaceEvent, 'Protected path workspace operation evidence missing');
    assertTargetIdentity(protectedWorkspaceEvent.payload, 'Protected workspace event');
    assert(protectedWorkspaceEvent.payload.mutationReceipt && protectedWorkspaceEvent.payload.mutationReceipt.error, 'Protected path denied receipt missing error classification');

    console.log('Target provider contract test passed');
  } catch (error) {
    console.error(error.stack || error.message);
    if (output) console.error(output);
    process.exitCode = 1;
  } finally {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise(resolve => server.once('exit', resolve));
    }
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
    if (preloadPath) fs.rmSync(preloadPath, { force: true });
  }
}

main();
