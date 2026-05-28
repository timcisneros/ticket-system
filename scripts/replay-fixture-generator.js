#!/usr/bin/env node
// Replay Fixture Generator — creates minimal isolated forensic fixture.
// Produces exactly: 1 ticket, 1 run, 1 replay snapshot, 1 event lineage.
// No historical data. No background scheduler pollution.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || '3467';
const BASE_URL = `http://127.0.0.1:${PORT}`;

// ── Minimal auth scaffolding ──────────────────────────────────────

const MINIMAL_USERS = [
  {
    id: 1,
    username: 'admin',
    passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$SeE86x2lbtBr1rW+vBvyYw$Vk7owQNnteofOEq3nnd1/M0nTvxpyl2wERBgJLK0zGc',
    createdAt: new Date().toISOString(),
    type: 'user'
  }
];

const MINIMAL_GROUPS = [
  {
    id: 1,
    name: 'Administrators',
    permissions: [
      'ticket:create', 'ticket:read', 'ticket:update', 'ticket:delete',
      'user:create', 'user:read', 'user:update', 'user:delete',
      'group:create', 'group:read', 'group:update', 'group:delete',
      'permission:assign',
      'workspace:read', 'workspace:write', 'workspace:reset'
    ],
    createdAt: new Date().toISOString()
  },
  {
    id: 2,
    name: 'Agents',
    permissions: ['workspace:read', 'workspace:write'],
    createdAt: new Date().toISOString()
  }
];

const MINIMAL_MEMBERSHIPS = [
  { id: 1, principalType: 'user', principalId: 1, groupId: 1 }
];

const MINIMAL_PERMISSIONS = [
  'ticket:create', 'ticket:read', 'ticket:update', 'ticket:delete',
  'user:create', 'user:read', 'user:update', 'user:delete',
  'group:create', 'group:read', 'group:update', 'group:delete',
  'permission:assign',
  'workspace:read', 'workspace:write', 'workspace:reset'
];

const MINIMAL_AGENTS = [
  {
    id: 1,
    name: 'ForensicAgent',
    type: 'agent',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    apiKey: 'sk-fake-forensic-fixture',
    createdAt: new Date().toISOString(),
    runtimeConfig: {
      allowHandoffTask: true,
      allowWorkflowDraftIntent: true
    }
  }
];

// ── Fake OpenAI preload ──────────────────────────────────────────────

function createFakeOpenAIPreload() {
  const preloadPath = path.join(os.tmpdir(), `forensic-fixture-openai-${process.pid}.js`);
  const source = `
function okResponse(plan) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'fake-forensic-' + Date.now()]]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify(plan),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
}

let callCount = 0;
global.fetch = async function(_url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const input = Array.isArray(body.input) ? body.input : [];
  const combined = input.map(item => item && item.content ? String(item.content) : '').join('\\n');
  callCount++;

  if (combined.includes('FORENSIC-MULTI-STEP')) {
    // Multi-step run: step 1 writes file A, step 2 creates folder, step 3 writes file B
    if (callCount === 1) {
      return okResponse({
        message: 'Step 1: writing file A',
        actions: [{ operation: 'writeFile', args: { path: 'file-a.txt', content: 'content A' } }],
        complete: false
      });
    } else if (callCount === 2) {
      return okResponse({
        message: 'Step 2: creating folder',
        actions: [{ operation: 'createFolder', args: { path: 'folder-b' } }],
        complete: false
      });
    } else {
      return okResponse({
        message: 'Step 3: writing file B',
        actions: [{ operation: 'writeFile', args: { path: 'folder-b/file-b.txt', content: 'content B' } }],
        complete: true
      });
    }
  }

  if (combined.includes('FORENSIC-HANDOFF')) {
    return okResponse({
      message: 'Delegating to executor',
      actions: [{ operation: 'createHandoffTask', args: { executor: 'John', operation: 'writeFile', args: { path: 'handoff-output.txt', content: 'handoff result' } } }],
      complete: true
    });
  }

  if (combined.includes('FORENSIC-FIXTURE')) {
    return okResponse({
      message: 'Writing fixture-output.txt',
      actions: [{ operation: 'writeFile', args: { path: 'fixture-output.txt', content: 'forensic fixture' } }],
      complete: true
    });
  }

  return okResponse({ message: 'Default', actions: [], complete: true });
};
`;
  fs.writeFileSync(preloadPath, source);
  return preloadPath;
}

// ── HTTP helpers ────────────────────────────────────────────────────

function request(method, urlPath, options = {}) {
  const body = options.form
    ? new URLSearchParams(options.form).toString()
    : options.body ? JSON.stringify(options.body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${urlPath}`, {
      method,
      headers: {
        ...(options.form ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function cookieFrom(response) {
  return (response.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
}

async function waitForReady(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await request('GET', '/health');
      if (res.statusCode === 200) return true;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Server did not become ready');
}

async function login() {
  const res = await request('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
  const cookie = cookieFrom(res);
  if (!cookie) throw new Error('Login failed');
  return cookie;
}

// ── Server management ───────────────────────────────────────────────

let server = null;

function startServer(dataDir, workspaceRoot, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT,
        DATA_DIR: dataDir,
        WORKSPACE_ROOT: workspaceRoot,
        AGENT_MAX_EXECUTION_STEPS: '6',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '4',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '30000',
        AGENT_MAX_CONSECUTIVE_STALLS: '3',
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        ...envOverrides
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.on('error', reject);
    server.on('exit', () => {});
    resolve();
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    const oldServer = server;
    const onExit = () => { if (server === oldServer) server = null; resolve(); };
    oldServer.once('exit', onExit);
    oldServer.kill('SIGTERM');
    setTimeout(() => {
      if (oldServer && oldServer.exitCode === null) {
        oldServer.kill('SIGKILL');
        setTimeout(onExit, 200);
      }
    }, 3000);
  });
}

// ── File helpers ───────────────────────────────────────────────────

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// ── Main ──────────────────────────────────────────────────────────

const SCENARIOS = {
  simple: {
    objective: 'FORENSIC-FIXTURE Write fixture-output.txt',
    description: 'Single-step, single workspace operation'
  },
  multiStep: {
    objective: 'FORENSIC-MULTI-STEP Write file A, create folder B, write file B',
    description: 'Multi-step, multiple workspace operations'
  },
  handoff: {
    objective: 'FORENSIC-HANDOFF Delegate to executor to write handoff-output.txt',
    description: 'Handoff task with executor run'
  }
};

async function main() {
  const args = process.argv.slice(2);
  const scenarioName = args[0] || 'simple';
  const scenario = SCENARIOS[scenarioName] || SCENARIOS.simple;

  const startedAt = Date.now();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forensic-fixture-data-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forensic-fixture-workspace-'));
  const preloadPath = createFakeOpenAIPreload();

  console.log('Replay Fixture Generator');
  console.log(`  Scenario: ${scenarioName} (${scenario.description})`);
  console.log(`  DATA_DIR: ${dataDir}`);
  console.log(`  WORKSPACE_ROOT: ${workspaceRoot}`);

  // 1. Write minimal isolated data files (NO historical data)
  writeJson(path.join(dataDir, 'users.json'), MINIMAL_USERS);
  writeJson(path.join(dataDir, 'groups.json'), MINIMAL_GROUPS);
  writeJson(path.join(dataDir, 'memberships.json'), MINIMAL_MEMBERSHIPS);
  writeJson(path.join(dataDir, 'permissions.json'), MINIMAL_PERMISSIONS);
  writeJson(path.join(dataDir, 'agents.json'), MINIMAL_AGENTS);
  writeJson(path.join(dataDir, 'tickets.json'), []);
  writeJson(path.join(dataDir, 'runs.json'), []);
  writeJson(path.join(dataDir, 'operation-history.json'), []);
  writeJson(path.join(dataDir, 'logs.json'), []);
  writeJson(path.join(dataDir, 'workflows.json'), []);
  writeJson(path.join(dataDir, 'allocation-plans.json'), []);
  fs.writeFileSync(path.join(dataDir, 'events.jsonl'), '');
  fs.mkdirSync(path.join(dataDir, 'replay-snapshots'), { recursive: true });

  // 2. Start server on isolated data
  await startServer(dataDir, workspaceRoot, { NODE_OPTIONS: `--require ${preloadPath}` });
  await waitForReady();

  let runId = null;
  let ticketId = null;
  try {
    const cookie = await login();

    // 3. Create exactly one ticket
    const objective = scenario.objective;
    const res = await request('POST', '/tickets', {
      cookie,
      form: {
        objective,
        assignmentTargetType: 'agent',
        assignmentTargetId: '1',
        assignmentMode: 'individual'
      }
    });

    if (res.statusCode !== 302) {
      throw new Error(`Ticket creation failed: HTTP ${res.statusCode}`);
    }

    // Find the ticket we just created
    const tickets = readJson(path.join(dataDir, 'tickets.json'));
    const ticket = tickets.find(t => t.objective === objective);
    if (!ticket) throw new Error('Ticket not found after creation');
    ticketId = ticket.id;
    console.log(`  Ticket created: ${ticketId}`);

    // 4. Wait for exactly one run to complete
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const runs = readJson(path.join(dataDir, 'runs.json'));
      const run = runs.find(r => r.ticketId === ticketId && ['completed', 'failed', 'interrupted'].includes(r.status));
      if (run) {
        runId = run.id;
        break;
      }
      await new Promise(r => setTimeout(r, 200));
    }

    if (!runId) {
      throw new Error('Run did not complete within timeout');
    }

    console.log(`  Run completed: ${runId}`);

    // 5. Assert replay snapshot identity determinism
    const runs = readJson(path.join(dataDir, 'runs.json'));
    const run = runs.find(r => r.id === runId);

    if (!run) throw new Error(`Run ${runId} not found in runs.json`);
    if (!run.replaySnapshotPath) throw new Error(`Run ${runId} missing replaySnapshotPath`);

    const replayFile = path.join(dataDir, run.replaySnapshotPath);
    if (!fs.existsSync(replayFile)) {
      throw new Error(`Replay snapshot file missing: ${replayFile}`);
    }

    const snapshot = readJson(replayFile);
    if (snapshot.runId !== runId) {
      throw new Error(`Replay identity mismatch: snapshot.runId=${snapshot.runId}, run.id=${runId}`);
    }

    const filenameMatch = run.replaySnapshotPath.match(/run-(\d+)\.json$/);
    if (!filenameMatch) {
      throw new Error(`Replay filename format invalid: ${run.replaySnapshotPath}`);
    }
    const filenameId = parseInt(filenameMatch[1], 10);
    if (filenameId !== runId) {
      throw new Error(`Replay filename ID mismatch: filename=${filenameId}, run.id=${runId}`);
    }

    console.log(`  Replay snapshot: ${run.replaySnapshotPath}`);
    console.log(`  Identity invariant: run.id(${runId}) === filenameId(${filenameId}) === snapshot.runId(${snapshot.runId})`);

    // 6. Count events for this run
    const eventsRaw = fs.readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8').trim();
    const allEvents = eventsRaw ? eventsRaw.split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    const runEvents = allEvents.filter(e => e.runId === runId);
    console.log(`  Events for run: ${runEvents.length}`);

    // 7. Count operations for this run
    const opHistory = readJson(path.join(dataDir, 'operation-history.json'));
    const runOps = opHistory.filter(o => o.runId === runId);
    console.log(`  Operations for run: ${runOps.length}`);

    // 8. Assert no orphan snapshots
    const replayDir = path.join(dataDir, 'replay-snapshots');
    const allSnapshots = fs.readdirSync(replayDir).filter(f => f.endsWith('.json'));
    const runIds = new Set(runs.map(r => r.id));
    const orphanSnapshots = [];
    for (const f of allSnapshots) {
      const m = f.match(/run-(\d+)\.json$/);
      if (!m) continue;
      const sid = parseInt(m[1], 10);
      if (!runIds.has(sid)) {
        orphanSnapshots.push(f);
      }
    }
    if (orphanSnapshots.length > 0) {
      throw new Error(`Orphan snapshots detected: ${orphanSnapshots.join(', ')}`);
    }

    // 9. Assert no duplicate snapshots for same run
    const snapshotCounts = {};
    for (const f of allSnapshots) {
      const m = f.match(/run-(\d+)\.json$/);
      if (!m) continue;
      const sid = parseInt(m[1], 10);
      snapshotCounts[sid] = (snapshotCounts[sid] || 0) + 1;
    }
    const duplicates = Object.entries(snapshotCounts).filter(([, count]) => count > 1);
    if (duplicates.length > 0) {
      throw new Error(`Duplicate snapshots for runs: ${duplicates.map(([id]) => id).join(', ')}`);
    }

    // 10. Assert no background scheduler pollution
    const pendingRunning = runs.filter(r => r.status === 'pending' || r.status === 'running');
    if (pendingRunning.length > 0) {
      throw new Error(`Background scheduler pollution: ${pendingRunning.length} pending/running runs`);
    }

    // 11. Assert no inherited leases
    const leasedRuns = runs.filter(r => r.leaseOwner || r.leaseExpiresAt);
    if (leasedRuns.length > 1) {
      throw new Error(`Unexpected leased runs: ${leasedRuns.length}`);
    }

    // 12. Generate manifest
    const manifest = {
      generatedAt: new Date().toISOString(),
      runId,
      ticketId,
      replaySnapshotPath: run.replaySnapshotPath,
      replaySnapshotHash: require('crypto')
        .createHash('sha256')
        .update(fs.readFileSync(replayFile, 'utf8'))
        .digest('hex'),
      expectedEventCount: runEvents.length,
      expectedMutationCount: runOps.length,
      expectedMutationPaths: runOps.map(o => o.args && o.args.path).filter(Boolean),
      expectedTerminalStatus: run.status,
      expectedProviderRequests: (snapshot.providerRequests || []).length,
      expectedModelResponses: (snapshot.modelResponses || []).length,
      expectedWorkspaceOperations: (snapshot.workspaceOperations || []).length,
      expectedAuthorityChecks: (snapshot.authorityChecks || []).length,
      identityInvariant: {
        runId,
        filenameId: filenameId,
        snapshotRunId: snapshot.runId,
        verified: runId === filenameId && runId === snapshot.runId
      }
    };
    writeJson(path.join(dataDir, 'manifest.json'), manifest);
    console.log(`  Manifest written: ${path.join(dataDir, 'manifest.json')}`);

    // 13. Stop server to flush writes
    await stopServer();
    await new Promise(r => setTimeout(r, 500));

    const durationMs = Date.now() - startedAt;
    console.log(`\nFixture generation complete (${durationMs}ms)`);
    console.log(`  Fixture directory: ${dataDir}`);

    // Return path for downstream consumers
    if (process.send) {
      process.send({ dataDir, runId, manifest });
    }

    // Print path on stdout for shell capture
    console.log(`\nFIXTURE_DIR=${dataDir}`);

  } catch (e) {
    await stopServer().catch(() => {});
    throw e;
  }

  // Cleanup preload
  try { fs.rmSync(preloadPath, { force: true }); } catch (e) {}
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
