const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dynamic-regression-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('dynamic-regression');
const PORT = process.env.PORT || '3422';
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Directories to seed in the workspace for dynamic derivation
const SEED_DIRS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];

const DATA_FILES = [
  'agents.json', 'allocation-plans.json', 'groups.json', 'logs.json',
  'memberships.json', 'operation-history.json', 'permissions.json',
  'runs.json', 'tickets.json', 'users.json'
];

function copyDataFiles(targetDir) {
  for (const file of DATA_FILES) {
    const src = path.join(REAL_DATA_DIR, file);
    const dst = path.join(targetDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
    } else {
      fs.writeFileSync(dst, '[]');
    }
  }
}

copyDataFiles(DATA_DIR);

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2));
}

function nextTicketId() {
  const tickets = readJson('tickets.json');
  return Math.max(0, ...tickets.map(ticket => ticket.id)) + 1;
}

function agentsForGroup(groupId) {
  const memberAgentIds = new Set(readJson('memberships.json')
    .filter(m => m.principalType === 'agent' && m.groupId === groupId)
    .map(m => m.principalId));
  return readJson('agents.json').filter(a => memberAgentIds.has(a.id));
}

function seedWorkspaceDirs() {
  SEED_DIRS.forEach(dir => {
    fs.mkdirSync(path.join(WORKSPACE_ROOT, dir), { recursive: true });
  });
}

function request(method, urlPath, options = {}) {
  const body = options.form
    ? new URLSearchParams(options.form).toString()
    : options.body
      ? JSON.stringify(options.body)
      : null;

  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${urlPath}`, {
      method,
      headers: {
        ...(options.form ? {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body)
        } : {}),
        ...(options.body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function cookieFrom(response) {
  return (response.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
}

function waitForExit(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.killed) return resolve();
    child.once('exit', () => resolve());
  });
}

async function waitForReady(url, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const response = await request('GET', url.replace(BASE_URL, '') + '/health');
      if (response.statusCode === 200 && JSON.parse(response.body).ready) return;
    } catch (e) { }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for server ready');
}

async function login() {
  const response = await request('POST', '/login', {
    form: { username: 'admin', password: 'admin123' }
  });
  if (response.statusCode !== 302) {
    throw new Error(`Admin login failed with HTTP ${response.statusCode}`);
  }
  return cookieFrom(response);
}

function seedDynamicGroup() {
  const agents = readJson('agents.json');
  const groups = readJson('groups.json');
  const memberships = readJson('memberships.json');
  const nextAgentId = Math.max(0, ...agents.map(a => a.id)) + 1;
  const nextGroupId = Math.max(0, ...groups.map(g => g.id)) + 1;
  const nextMembershipId = Math.max(0, ...memberships.map(m => m.id)) + 1;

  const seededAgents = [
    { id: nextAgentId, name: `DynamicA-${STAMP}`, type: 'agent', provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key-a', createdAt: new Date().toISOString() },
    { id: nextAgentId + 1, name: `DynamicB-${STAMP}`, type: 'agent', provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key-b', createdAt: new Date().toISOString() }
  ];
  const group = {
    id: nextGroupId, name: `Dynamic Regression ${STAMP}`, permissions: [], canReceiveTickets: true
  };

  writeJson('agents.json', [...agents, ...seededAgents]);
  writeJson('groups.json', [...groups, group]);
  writeJson('memberships.json', [
    ...memberships,
    { id: nextMembershipId, principalType: 'agent', principalId: seededAgents[0].id, groupId: group.id },
    { id: nextMembershipId + 1, principalType: 'agent', principalId: seededAgents[1].id, groupId: group.id }
  ]);

  return { agents: seededAgents, group };
}

function createFakeOpenAIPreload() {
  const preloadPath = path.join(os.tmpdir(), `dynamic-regression-openai-${process.pid}-${Date.now()}.js`);
  const source = `
global.fetch = async function(url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const input = Array.isArray(body.input) ? body.input : [];
  const combined = input.map(item => item && item.content ? String(item.content) : '').join('\\n');

  if (combined.includes('ownership-violation')) {
    return {
      ok: true, status: 200,
      headers: new Map([['x-request-id', 'fake-dynamic-ownership-violation']]),
      async text() {
        return JSON.stringify({
          output_text: JSON.stringify({
            message: 'Trying to write outside owned output paths.',
            actions: [{ operation: 'writeFile', args: { path: 'outside-owned-path.txt', content: 'should be blocked' } }],
            complete: true
          }),
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        });
      }
    };
  }

  const ownedPathMatch = combined.match(/"ownedOutputPaths":\\["([^"]+)"\\]/);
  const ownedPath = ownedPathMatch ? ownedPathMatch[1] : 'alpha/';

  return {
    ok: true, status: 200,
    headers: new Map([['x-request-id', 'fake-dynamic-request']]),
    async text() {
      const agentIdMatch = combined.match(/"assignedAgentId":(\\d+)/);
      const agentId = agentIdMatch ? agentIdMatch[1] : 'unknown';
      return JSON.stringify({
        output_text: JSON.stringify({
          message: 'dynamic regression complete',
          actions: [{ operation: 'writeFile', args: { path: ownedPath + 'dynamic-output-' + agentId + '.txt', content: 'ok-' + agentId } }],
          complete: true
        }),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
};
`;
  fs.writeFileSync(preloadPath, source);
  return preloadPath;
}

async function createDynamicTicket(cookie, groupId, objective) {
  const response = await request('POST', '/tickets', {
    cookie,
    form: {
      objective,
      assignmentTargetType: 'group',
      assignmentTargetId: String(groupId),
      assignmentMode: 'dynamic'
    }
  });
  if (response.statusCode !== 302) {
    const err = new Error(`Dynamic ticket create failed with HTTP ${response.statusCode}: ${response.body}`);
    err.statusCode = response.statusCode;
    err.body = response.body;
    throw err;
  }
  const ticket = readJson('tickets.json').find(t => t.objective === objective);
  if (!ticket) throw new Error('Dynamic ticket was not persisted');
  return ticket;
}

async function waitForRuns(ticketId, expectedCount, predicate) {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const runs = readJson('runs.json').filter(r => r.ticketId === ticketId);
    const terminalSnapshotsReady = runs.every(r =>
      !['completed', 'failed', 'interrupted'].includes(r.status) ||
      (r.replaySnapshot && r.replaySnapshot.terminalStatus === r.status)
    );
    if (runs.length >= expectedCount && terminalSnapshotsReady && (!predicate || predicate(runs))) return runs;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const runs = readJson('runs.json').filter(r => r.ticketId === ticketId);
  throw new Error(`Timed out waiting for ${expectedCount} runs for ticket ${ticketId}: ${JSON.stringify(runs.map(r => ({
    id: r.id, agentId: r.agentId, status: r.status, error: r.error,
    terminalStatus: r.replaySnapshot && r.replaySnapshot.terminalStatus
  })))}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertOwnedPathsDoNotOverlap(runs) {
  const ownedPaths = runs.flatMap(r => r.ownedOutputPaths || []);
  ownedPaths.forEach((p, i) => {
    ownedPaths.forEach((o, j) => {
      if (i === j) return;
      assert(p !== o && !p.startsWith(o) && !o.startsWith(p), `Owned paths overlap: ${p} and ${o}`);
    });
  });
}

function assertNoScaffoldOperationHistory(ticketId) {
  const plan = readJson('allocation-plans.json').find(p => p.ticketId === ticketId);
  const ownedPaths = plan ? plan.items.flatMap(i => i.ownedOutputPaths || []) : [];
  const histories = readJson('operation-history.json').filter(h => h.ticketId === ticketId);
  const scaffold = histories.filter(h =>
    h.operation === 'createFolder' &&
    ownedPaths.some(op => h.args && h.args.path === op.slice(0, -1))
  );
  assert(scaffold.length === 0, `Dynamic allocation created scaffold operation history for ticket ${ticketId}`);
}

function verifyRunDetails(ticketId, runs, expectedDerivedPaths) {
  const logs = readJson('logs.json').filter(l => l.ticketId === ticketId);
  const plans = readJson('allocation-plans.json');

  runs.forEach(run => {
    const plan = plans.find(p => p.id === run.allocationPlanId);
    const item = plan && plan.items.find(i => i.allocationItemId === run.allocationItemId);
    const runLogs = logs.filter(l => l.runId === run.id);
    const snap = run.replaySnapshot;
    const expectedPath = expectedDerivedPaths[run.agentId];

    assert(plan, `Missing allocation plan for run ${run.id}`);
    assert(plan.ticketId === run.ticketId, `Plan wrong ticket for run ${run.id}`);
    assert(item, `Missing allocation item for run ${run.id}`);
    assert(item.assignedAgentId === run.agentId, `Item wrong agent for run ${run.id}`);
    assert(run.executionWorkspaceType === 'main_owned_paths', `Run ${run.id} not owned path execution`);
    assert(Array.isArray(run.ownedOutputPaths) && run.ownedOutputPaths.length === 1, `Run ${run.id} missing owned paths`);
    assert(run.ownedOutputPaths[0] === `${expectedPath}/`, `Run ${run.id} wrong path: ${run.ownedOutputPaths[0]} vs ${expectedPath}/`);
    assert(run.allocationSubtask, `Run ${run.id} missing subtask`);

    assert(snap, `Missing replay snapshot for run ${run.id}`);
    assert(snap.executionWorkspaceType === 'main_owned_paths', `Snap missing owned path type for run ${run.id}`);
    assert(snap.allocationPlanId === run.allocationPlanId, `Snap missing plan id for run ${run.id}`);
    assert(snap.allocationItemId === run.allocationItemId, `Snap missing item id for run ${run.id}`);
    assert(snap.ownedOutputPaths[0] === run.ownedOutputPaths[0], `Snap wrong path for run ${run.id}`);
    assert(snap.runtimeEnvelope.executionWorkspaceType === 'main_owned_paths', `Runtime envelope missing owned path type for run ${run.id}`);
    assert(snap.runtimeEnvelope.ownedOutputPaths[0] === run.ownedOutputPaths[0], `Runtime envelope wrong path for run ${run.id}`);
    assert(!JSON.stringify(snap).includes('test-key-a'), `Snap exposed key A for run ${run.id}`);
    assert(!JSON.stringify(snap).includes('test-key-b'), `Snap exposed key B for run ${run.id}`);

    assert(runLogs.length > 0, `Missing logs for run ${run.id}`);
    assert(runLogs.every(l => l.ticketId === run.ticketId && l.agentId === run.agentId), `Wrong log identity for run ${run.id}`);
  });
}

async function main() {
  const { agents, group } = seedDynamicGroup();
  seedWorkspaceDirs();
  const preloadPath = createFakeOpenAIPreload();
  let server = null;

  try {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env, NODE_ENV: 'test', PORT,
        NODE_OPTIONS: `--require ${preloadPath}`,
        WORKSPACE_ROOT, DATA_DIR,
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', chunk => process.stdout.write(String(chunk)));
    server.stderr.on('data', chunk => process.stderr.write(String(chunk)));

    await waitForReady(BASE_URL);
    const cookie = await login();

    // Test 1: Probe to verify dynamic ticket creation
    const probeResponse = await request('POST', '/tickets', {
      cookie,
      form: {
        objective: `dynamic files probe ${STAMP}`,
        assignmentTargetType: 'group',
        assignmentTargetId: String(group.id),
        assignmentMode: 'dynamic'
      }
    });
    assert(probeResponse.statusCode === 302, `Dynamic ticket probe failed: HTTP ${probeResponse.statusCode} ${probeResponse.body}`);

    // Test 2: Basic dynamic allocation — sufficient directories derive paths
    const completeTicket = await createDynamicTicket(cookie, group.id, `dynamic reports complete ${STAMP}`);
    const completeRuns = await waitForRuns(
      completeTicket.id, 2,
      runs => runs.every(r => r.status === 'completed')
    );

    // Verify ticket persisted with correct derived ownedOutputPaths
    const persistedTicket = readJson('tickets.json').find(t => t.id === completeTicket.id);
    assert(persistedTicket.ownedOutputPaths !== null, 'Dynamic ticket missing ownedOutputPaths');
    assert(typeof persistedTicket.ownedOutputPaths === 'object', 'Dynamic ticket ownedOutputPaths is not object');

    // First agent (lower id) should get 'alpha', second should get 'beta'
    assert(persistedTicket.ownedOutputPaths[agents[0].id] === 'alpha',
      `First agent should get 'alpha', got ${persistedTicket.ownedOutputPaths[agents[0].id]}`);
    assert(persistedTicket.ownedOutputPaths[agents[1].id] === 'beta',
      `Second agent should get 'beta', got ${persistedTicket.ownedOutputPaths[agents[1].id]}`);

    // Assignment mode should still be 'dynamic'
    assert(persistedTicket.assignmentMode === 'dynamic',
      `Dynamic ticket assignment mode changed: ${persistedTicket.assignmentMode}`);

    // Ticket and runs completed
    const completedTicket = readJson('tickets.json').find(t => t.id === completeTicket.id);
    assert(completedTicket.status === 'completed', 'Dynamic ticket did not complete');
    assert(new Set(completeRuns.map(r => r.agentId)).size === 2, 'Not one run per agent');
    assert(new Set(completeRuns.map(r => r.ticketOpenedAt)).size === 1, 'No shared ticketOpenedAt');
    assert(new Set(completeRuns.map(r => r.allocationPlanId)).size === 1, 'No shared allocation plan');

    const completePlan = readJson('allocation-plans.json').find(p => p.id === completeRuns[0].allocationPlanId);
    assert(completePlan && completePlan.status === 'completed', 'Allocation plan not completed');
    assert(completePlan.items.length === 2, 'Plan missing one item per agent');

    assertOwnedPathsDoNotOverlap(completeRuns);
    assertNoScaffoldOperationHistory(completeTicket.id);

    const expectedDerivedPaths = { [agents[0].id]: 'alpha', [agents[1].id]: 'beta' };
    verifyRunDetails(completeTicket.id, completeRuns, expectedDerivedPaths);

    // Files written inside derived scope
    completeRuns.forEach(run => {
      const expectedDir = expectedDerivedPaths[run.agentId];
      const ownedFile = path.join(WORKSPACE_ROOT, expectedDir, `dynamic-output-${run.agentId}.txt`);
      const unownedFile = path.join(WORKSPACE_ROOT, `dynamic-output-${run.agentId}.txt`);
      assert(fs.existsSync(ownedFile), `Dynamic output missing: ${ownedFile}`);
      assert(!fs.existsSync(unownedFile), `Dynamic wrote outside scope: ${unownedFile}`);
    });

    console.log('PASS: dynamic allocation with sufficient directories');

    // Test 3: Ownership enforcement on derived paths
    const ownershipTicket = await createDynamicTicket(cookie, group.id, `dynamic reports ownership-violation ${STAMP}`);
    const ownershipRuns = await waitForRuns(
      ownershipTicket.id, 2,
      runs => runs.every(r => r.status === 'failed')
    );
    const ownershipLogs = readJson('logs.json').filter(l => l.ticketId === ownershipTicket.id);
    assert(ownershipLogs.some(l => l.type === 'workspace:ownership_blocked'), 'Missing workspace:ownership_blocked log');
    ownershipRuns.forEach(run => {
      assert(run.status === 'failed', `Run ${run.id} did not fail`);
      assert(run.replaySnapshot.workspaceOperations.some(item =>
        item.blocked === true &&
        item.operation && item.operation.operation === 'writeFile' &&
        item.reason === 'Owned-scope runs may only mutate owned output paths'
      ), `Missing blocked replay capture for run ${run.id}`);
    });
    const opHistory = readJson('operation-history.json').filter(h =>
      ownershipRuns.some(r => r.id === h.runId)
    );
    assert(opHistory.length === 0, 'Blocked ownership violation created operation history');

    console.log('PASS: ownership enforcement on derived paths');

    // Test 4: Rerun preserves derived paths
    const reopenResponse = await request('PATCH', `/api/tickets/${completeTicket.id}/status`, {
      cookie,
      body: { status: 'open' }
    });
    assert(reopenResponse.statusCode === 200, `Rerun reopen failed with HTTP ${reopenResponse.statusCode}`);

    const rerunRuns = await waitForRuns(
      completeTicket.id, 4,
      runs => runs.length >= 4 && runs.every(r => ['completed', 'failed'].includes(r.status))
    );

    const firstBatchMarker = completeRuns[0].ticketOpenedAt;
    const freshRuns = rerunRuns.filter(r => r.ticketOpenedAt !== firstBatchMarker);
    assert(freshRuns.length === 2, 'Rerun did not create fresh two-run batch');
    assert(new Set(freshRuns.map(r => r.ticketOpenedAt)).size === 1, 'Rerun batch missing shared marker');
    assert(new Set(freshRuns.map(r => r.allocationPlanId)).size === 1, 'Rerun batch missing fresh plan');
    assert(!freshRuns.some(r => r.allocationPlanId === completeRuns[0].allocationPlanId), 'Rerun reused old plan');
    assertOwnedPathsDoNotOverlap(freshRuns);
    freshRuns.forEach(r => {
      assert(r.executionWorkspaceType === 'main_owned_paths', `Rerun run ${r.id} lost owned path execution`);
      assert(r.ownedOutputPaths[0] === `${persistedTicket.ownedOutputPaths[r.agentId]}/`,
        `Rerun run ${r.id} lost derived owned path`);
      assert(r.allocationSubtask, `Rerun run ${r.id} missing subtask`);
    });

    console.log('PASS: rerun preserves derived paths');

    const staleRunCount = readJson('runs.json').filter(r => r.ticketId === completeTicket.id).length;
    fs.rmSync(path.join(WORKSPACE_ROOT, persistedTicket.ownedOutputPaths[agents[0].id]), { recursive: true, force: true });
    const staleRerunResponse = await request('POST', `/api/tickets/${completeTicket.id}/rerun`, { cookie });
    assert(staleRerunResponse.statusCode === 400, `Stale dynamic scope rerun was not rejected: HTTP ${staleRerunResponse.statusCode}`);
    assert(staleRerunResponse.body.includes('Owned-scope path does not exist'), 'Stale dynamic scope rejection was unclear');
    assert(
      readJson('runs.json').filter(r => r.ticketId === completeTicket.id).length === staleRunCount,
      'Stale dynamic scope rerun created a new run'
    );
    assert(readJson('logs.json').some(log =>
      log.type === 'allocation:setup_failed' &&
      log.message.includes('Owned-scope path does not exist') &&
      log.code === 'WORKSPACE_ALLOCATION_PATH_MISSING' &&
      log.path === `${persistedTicket.ownedOutputPaths[agents[0].id]}/`
    ), 'Stale dynamic scope rerun did not log structured setup failure');

    console.log('PASS: stale dynamic scope rerun rejected clearly');

    console.log(JSON.stringify({
      completeRuns: completeRuns.length,
      freshRuns: freshRuns.length,
      derivedPaths: persistedTicket.ownedOutputPaths
    }));
  } finally {
    if (server) {
      server.kill('SIGTERM');
      await waitForExit(server);
    }
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(preloadPath, { force: true });
    removeTempWorkspaceRoot(WORKSPACE_ROOT);
  }
}

const STAMP = Date.now();
main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
