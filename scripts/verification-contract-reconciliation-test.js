const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_FILES = [
  'agents.json', 'allocation-plans.json', 'events.jsonl', 'groups.json',
  'logs.json', 'memberships.json', 'operation-history.json', 'permissions.json',
  'runs.json', 'tickets.json', 'users.json', 'workflows.json'
];

function copyDataFiles(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  DATA_FILES.forEach(file => {
    const source = path.join(REAL_DATA_DIR, file);
    const target = path.join(targetDir, file);
    fs.writeFileSync(target, fs.existsSync(source) ? fs.readFileSync(source) : (file.endsWith('.jsonl') ? '' : '[]'));
  });
}

function readJson(dataDir, file) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
}

function writeJson(dataDir, file, value) {
  fs.writeFileSync(path.join(dataDir, file), JSON.stringify(value, null, 2));
}

function request(baseUrl, method, urlPath, options = {}) {
  const body = options.form ? new URLSearchParams(options.form).toString() : null;
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${urlPath}`, {
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

function startServer(dataDir, workspaceRoot, port, interruptionPoint = null) {
  return spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DATA_DIR: dataDir,
      WORKSPACE_ROOT: workspaceRoot,
      RUNTIME_SCHEDULER_INTERVAL_MS: '100',
      ...(interruptionPoint ? { TEST_INTERRUPTION_POINT: interruptionPoint } : {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function waitForReady(baseUrl, child, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (child.exitCode !== null) throw new Error(`Server exited before ready with code ${child.exitCode}`);
    try {
      const response = await request(baseUrl, 'GET', '/health');
      if (response.statusCode === 200 && JSON.parse(response.body).ready) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for server ready');
}

function waitForExit(child, timeout = 10000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode) return resolve();
    const timer = setTimeout(() => reject(new Error('Timed out waiting for interrupted server exit')), timeout);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForTerminalRun(dataDir, ticketId, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const run = readJson(dataDir, 'runs.json')
      .filter(item => item.ticketId === ticketId)
      .sort((a, b) => b.id - a.id)[0];
    if (run && ['completed', 'failed', 'interrupted'].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ticket #${ticketId} terminal run`);
}

async function waitForVerificationEvents(dataDir, runId, expectedStatus, timeout = 5000) {
  const started = Date.now();
  let latest = [];
  while (Date.now() - started < timeout) {
    latest = fs.readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
      .filter(event => event.runId === runId);
    const hasChecked = latest.some(event => event.type === 'run.postconditions_checked');
    const hasTerminal = latest.some(event => event.type === 'run.terminalized');
    const hasVerdict = latest.some(event => event.type === (expectedStatus === 'completed' ? 'run.verification_passed' : 'run.verification_failed'));
    if (hasChecked && hasTerminal && hasVerdict) return latest;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${expectedStatus} verification evidence for run #${runId}: ${JSON.stringify(latest.slice(-10))}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runScenario({ name, port, originalPostconditions, mutateWorkflow, expectedStatus }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `verification-contract-${name}-`));
  const workspaceRoot = createTempWorkspaceRoot(`verification-contract-${name}`);
  const baseUrl = `http://127.0.0.1:${port}`;
  let interruptedServer = null;
  let resumedServer = null;

  try {
    copyDataFiles(dataDir);
    const agents = readJson(dataDir, 'agents.json');
    const agent = {
      id: Math.max(0, ...agents.map(item => item.id || 0)) + 1,
      name: `VerificationContractAgent-${name}`,
      type: 'agent',
      provider: 'ollama',
      model: 'verification-contract-test-model',
      apiKey: '',
      createdAt: new Date().toISOString()
    };
    writeJson(dataDir, 'agents.json', [...agents, agent]);

    const workflowId = `verification-contract-${name}`;
    const outputPath = `${name}.txt`;
    const now = new Date().toISOString();
    const workflow = {
      id: workflowId,
      name: `Verification contract ${name}`,
      version: '1',
      enabled: true,
      inputSchema: {},
      actions: [
        { id: 'write', action: 'writeFile', input: { path: outputPath, content: name === 'removed' ? 'actual' : 'original' }, next: 'done' },
        { id: 'done', action: 'stop', input: { result: { path: outputPath } } }
      ],
      postconditions: originalPostconditions(outputPath),
      verifierContract: { id: `${workflowId}-verifier`, version: '1' },
      createdAt: now,
      updatedAt: now
    };
    writeJson(dataDir, 'workflows.json', [...readJson(dataDir, 'workflows.json'), workflow]);

    // Crash immediately before the terminalization repository boundary. The
    // boundary no longer exposes a test-only gap after execution evidence.
    interruptedServer = startServer(dataDir, workspaceRoot, port, 'before_run.snapshot_finalized');
    await waitForReady(baseUrl, interruptedServer);
    const login = await request(baseUrl, 'POST', '/login', {
      form: { username: 'admin', password: 'admin123' }
    });
    const cookie = (login.headers['set-cookie'] || []).map(item => item.split(';')[0]).join('; ');
    assert(login.statusCode === 302 && cookie, 'Admin login failed');

    try {
      await request(baseUrl, 'POST', '/tickets', {
        cookie,
        form: {
          objective: `Run verification snapshot scenario ${name}`,
          capabilityType: 'workflow',
          workflowId,
          workflowInput: '{}',
          assignmentTargetType: 'agent',
          assignmentTargetId: String(agent.id),
          assignmentMode: 'individual'
        }
      });
    } catch (_) {
      // Expected: deterministic interruption kills the server before the terminal bundle.
    }
    await waitForExit(interruptedServer);
    interruptedServer = null;

    const ticket = readJson(dataDir, 'tickets.json').find(item => item.objective === `Run verification snapshot scenario ${name}`);
    assert(ticket, 'Interrupted ticket was not persisted');
    const createdRun = readJson(dataDir, 'runs.json').find(item => item.ticketId === ticket.id);
    assert(createdRun && createdRun.verificationContractSnapshot, 'Run did not persist verificationContractSnapshot before interruption');
    assert(createdRun.status === 'running', `Interrupted run status ${createdRun.status}, expected running before restart recovery`);
    assert(JSON.stringify(createdRun.verificationContractSnapshot.postconditions) === JSON.stringify(workflow.postconditions), 'Run verification snapshot differs from original workflow contract');

    const workflows = readJson(dataDir, 'workflows.json');
    const storedWorkflow = workflows.find(item => item.id === workflowId);
    mutateWorkflow(storedWorkflow, outputPath);
    storedWorkflow.updatedAt = new Date().toISOString();
    writeJson(dataDir, 'workflows.json', workflows);

    resumedServer = startServer(dataDir, workspaceRoot, port);
    await waitForReady(baseUrl, resumedServer);
    const terminalRun = await waitForTerminalRun(dataDir, ticket.id);
    assert(terminalRun.status === expectedStatus, `${name} run status ${terminalRun.status}, expected ${expectedStatus}: ${terminalRun.error || ''}`);

    const events = await waitForVerificationEvents(dataDir, terminalRun.id, expectedStatus);
    const checked = events.find(event => event.type === 'run.postconditions_checked');
    assert(checked && checked.payload.contractSource === 'run_snapshot', `${name} restart recovery did not verify from run snapshot`);
    if (expectedStatus === 'completed') {
      assert(events.some(event => event.type === 'run.verification_passed'), 'Passing restart recovery did not emit run.verification_passed');
    } else {
      assert(events.some(event => event.type === 'run.verification_failed'), 'Failing restart recovery did not emit run.verification_failed');
    }

    const replay = JSON.parse(fs.readFileSync(path.join(dataDir, terminalRun.replaySnapshotPath), 'utf8'));
    assert(JSON.stringify(replay.verificationContractSnapshot) === JSON.stringify(createdRun.verificationContractSnapshot), 'Replay did not preserve verification contract snapshot');
  } finally {
    if (interruptedServer) interruptedServer.kill('SIGTERM');
    if (resumedServer) resumedServer.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
    removeTempWorkspaceRoot(workspaceRoot);
  }
}

async function main() {
  await runScenario({
    name: 'removed',
    port: 3482,
    originalPostconditions: outputPath => [
      { id: 'original-requirement', type: 'fileContains', path: outputPath, contains: 'expected' }
    ],
    mutateWorkflow: workflow => {
      workflow.postconditions = [];
    },
    expectedStatus: 'failed'
  });

  await runScenario({
    name: 'stricter',
    port: 3483,
    originalPostconditions: outputPath => [
      { id: 'original-requirement', type: 'fileContains', path: outputPath, contains: 'original' }
    ],
    mutateWorkflow: (workflow, outputPath) => {
      workflow.postconditions = [
        { id: 'new-stricter-requirement', type: 'fileContains', path: outputPath, contains: 'new-required' }
      ];
    },
    expectedStatus: 'completed'
  });

  console.log('PASS: startup recovery uses immutable run verification contracts across the terminalization boundary');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
