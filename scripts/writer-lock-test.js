const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-lock-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('writer-lock');
const PORT_A = process.env.PORT_A || '3444';
const PORT_B = process.env.PORT_B || '3445';
const DATA_FILES = [
  'agents.json', 'allocation-plans.json', 'events.jsonl', 'groups.json',
  'logs.json', 'memberships.json', 'operation-history.json', 'permissions.json',
  'runs.json', 'tickets.json', 'users.json', 'workflows.json'
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function copyDataFiles(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const file of DATA_FILES) {
    const src = path.join(REAL_DATA_DIR, file);
    const dst = path.join(targetDir, file);
    if (fs.existsSync(src)) fs.copyFileSync(src, dst);
    else fs.writeFileSync(dst, file.endsWith('.jsonl') ? '' : '[]');
  }
}

function request(port, method, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}${urlPath}`, { method }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForReady(port, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const response = await request(port, 'GET', '/health');
      if (response.statusCode === 200 && JSON.parse(response.body).ready) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for server on port ${port}`);
}

function startServer(port) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: port,
      DATA_DIR,
      WORKSPACE_ROOT
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.output = '';
  child.stdout.on('data', chunk => { child.output += chunk.toString(); });
  child.stderr.on('data', chunk => { child.output += chunk.toString(); });
  return child;
}

function waitForExit(child, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for process exit')), timeout);
    child.once('exit', code => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function stopServer(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null || child.killed) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 5000).unref();
  });
}

function readLock() {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'writer-lock.json'), 'utf8'));
}

function readEvents() {
  const fp = path.join(DATA_DIR, 'events.jsonl');
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function main() {
  copyDataFiles(DATA_DIR);
  let serverA = null;
  let serverB = null;
  let serverC = null;

  try {
    serverA = startServer(PORT_A);
    await waitForReady(PORT_A);

    const lockA = readLock();
    assert(lockA.pid === serverA.pid, `Server A should own writer lock; expected ${serverA.pid}, got ${lockA.pid}`);
    assert(lockA.startedAt, 'Writer lock missing startedAt');
    assert(lockA.dataDir === path.resolve(DATA_DIR), 'Writer lock missing DATA_DIR');
    assert(lockA.workspaceRoot === path.resolve(WORKSPACE_ROOT), 'Writer lock missing WORKSPACE_ROOT');
    assert(lockA.heartbeatAt, 'Writer lock missing heartbeatAt');

    const beforeSkipped = readEvents().filter(event => event.type === 'scheduler.run_skipped').length;
    serverB = startServer(PORT_B);
    const exitCode = await waitForExit(serverB);
    assert(exitCode !== 0, 'Server B should refuse startup while Server A owns DATA_DIR writer lock');
    assert(serverB.output.includes('DATA_DIR writer lock is owned by a live process'), 'Server B did not report writer lock refusal');

    const lockAfterB = readLock();
    assert(lockAfterB.pid === serverA.pid, 'Server B must not replace Server A writer lock');
    const afterSkipped = readEvents().filter(event => event.type === 'scheduler.run_skipped').length;
    assert(afterSkipped === beforeSkipped, 'Server B must not append scheduler.run_skipped events');

    await stopServer(serverA);
    assert(!fs.existsSync(path.join(DATA_DIR, 'writer-lock.json')), 'Writer lock should be released on graceful shutdown');

    const deadOwner = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await waitForExit(deadOwner);
    fs.writeFileSync(path.join(DATA_DIR, 'writer-lock.json'), JSON.stringify({
      pid: deadOwner.pid,
      startedAt: new Date(Date.now() - 60000).toISOString(),
      dataDir: path.resolve(DATA_DIR),
      workspaceRoot: path.resolve(WORKSPACE_ROOT),
      heartbeatAt: new Date(Date.now() - 60000).toISOString()
    }, null, 2));

    serverC = startServer(PORT_A);
    await waitForReady(PORT_A);
    const lockC = readLock();
    assert(lockC.pid === serverC.pid, 'Server C should reclaim stale writer lock owned by a dead PID');
    await stopServer(serverC);

    console.log('Writer lock regression passed');
  } finally {
    await stopServer(serverC);
    await stopServer(serverB);
    await stopServer(serverA);
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
    try { removeTempWorkspaceRoot(WORKSPACE_ROOT); } catch (_) {}
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
