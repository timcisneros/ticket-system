const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'allocated-regression-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('allocated-regression');
const PORT = process.env.PORT || '3421';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DATA_FILES = [
  'agents.json',
  'allocation-plans.json',
  'groups.json',
  'logs.json',
  'memberships.json',
  'operation-history.json',
  'permissions.json',
  'runs.json',
  'tickets.json',
  'users.json'
];
const STAMP = Date.now();

for (const file of DATA_FILES) {
  const src = path.join(REAL_DATA_DIR, file);
  const dst = path.join(DATA_DIR, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
  } else {
    fs.writeFileSync(dst, '[]');
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2));
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
  return (response.headers['set-cookie'] || []).map(cookie => cookie.split(';')[0]).join('; ');
}

function waitForExit(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.killed) return resolve();
    child.once('exit', () => resolve());
  });
}

async function waitForReady() {
  const started = Date.now();

  while (Date.now() - started < 15000) {
    try {
      const response = await request('GET', '/health');
      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        if (body.ready) return;
      }
    } catch (error) {
      // Server is still starting.
    }

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

function seedAllocatedGroup() {
  const agents = readJson('agents.json');
  const groups = readJson('groups.json');
  const memberships = readJson('memberships.json');
  const nextAgentId = Math.max(0, ...agents.map(agent => agent.id)) + 1;
  const nextGroupId = Math.max(0, ...groups.map(group => group.id)) + 1;
  const nextMembershipId = Math.max(0, ...memberships.map(membership => membership.id)) + 1;

  const seededAgents = [
    {
      id: nextAgentId,
      name: `AllocatedRegressionA-${STAMP}`,
      type: 'agent',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      apiKey: 'test-key-a',
      createdAt: new Date().toISOString()
    },
    {
      id: nextAgentId + 1,
      name: `AllocatedRegressionB-${STAMP}`,
      type: 'agent',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      apiKey: 'test-key-b',
      createdAt: new Date().toISOString()
    }
  ];
  const group = {
    id: nextGroupId,
    name: `Allocated Regression ${STAMP}`,
    permissions: [],
    canReceiveTickets: true
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

function createFakeOpenAIPreload(failingAgentId) {
  const preloadPath = path.join(os.tmpdir(), `allocated-regression-openai-${process.pid}-${Date.now()}.js`);
  const source = `
const responseCounts = new Map();

function nextCount(key) {
  const count = (responseCounts.get(key) || 0) + 1;
  responseCounts.set(key, count);
  return count;
}

global.fetch = async function(url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const input = Array.isArray(body.input) ? body.input : [];
  const combined = input.map(item => item && item.content ? String(item.content) : '').join('\\n');
  const shouldFail = combined.includes('fail-one') && combined.includes('"assignedAgentId":${failingAgentId}');

  if (shouldFail) {
    return {
      ok: false,
      status: 401,
      headers: new Map([['x-request-id', 'fake-allocated-failure']]),
      async text() {
        return JSON.stringify({ error: { message: 'allocated regression forced failure' } });
      }
    };
  }

  if (combined.includes('ownership-violation')) {
    return {
      ok: true,
      status: 200,
      headers: new Map([['x-request-id', 'fake-allocated-ownership-violation']]),
      async text() {
        return JSON.stringify({
          output_text: JSON.stringify({
            message: 'Trying to write outside owned output paths.',
            actions: [{
              operation: 'writeFile',
              args: {
                path: 'outside-owned-path.txt',
                content: 'should be blocked'
              }
            }],
            complete: true
          }),
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        });
      }
    };
  }

  if (combined.includes('path-violation-alpha')) {
    return {
      ok: true,
      status: 200,
      headers: new Map([['x-request-id', 'fake-allocated-rename-violation']]),
      async text() {
        return JSON.stringify({
          output_text: JSON.stringify({
            message: 'Trying to rename outside owned output paths.',
            actions: [{
              operation: 'renamePath',
              args: {
                path: 'outside-owned-source.txt',
                nextPath: 'outside-owned-destination.txt'
              }
            }],
            complete: true
          }),
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        });
      }
    };
  }

  if (combined.includes('path-violation-beta')) {
    return {
      ok: true,
      status: 200,
      headers: new Map([['x-request-id', 'fake-allocated-delete-violation']]),
      async text() {
        return JSON.stringify({
          output_text: JSON.stringify({
            message: 'Trying to delete outside owned output paths.',
            actions: [{
              operation: 'deletePath',
              args: {
                path: 'outside-owned-delete.txt'
              }
            }],
            complete: true
          }),
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        });
      }
    };
  }

  if (combined.includes('operation-budget')) {
    const ownedPathMatch = combined.match(/"ownedOutputPaths":\\["([^"]+)"\\]/);
    const ownedPath = ownedPathMatch ? ownedPathMatch[1] : 'allocated/unknown/';
    return {
      ok: true,
      status: 200,
      headers: new Map([['x-request-id', 'fake-allocated-operation-budget']]),
      async text() {
        return JSON.stringify({
          output_text: JSON.stringify({
            message: 'Producing too many owned outputs.',
            actions: Array.from({ length: 5 }, (_, index) => ({
              operation: 'writeFile',
              args: {
                path: ownedPath + 'budget-output-' + index + '.txt',
                content: 'budget ' + index
              }
            })),
            complete: true
          }),
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        });
      }
    };
  }

  if (combined.includes('createfolder-outside-owned')) {
    return {
      ok: true,
      status: 200,
      headers: new Map([['x-request-id', 'fake-allocated-createfolder-ownership']]),
      async text() {
        return JSON.stringify({
          output_text: JSON.stringify({
            message: 'Trying to create folder outside owned output paths.',
            actions: [{
              operation: 'createFolder',
              args: {
                path: 'outside-owned-folder'
              }
            }],
            complete: true
          }),
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        });
      }
    };
  }

  if (combined.includes('createfolder-idempotent')) {
    return {
      ok: true,
      status: 200,
      headers: new Map([['x-request-id', 'fake-allocated-createfolder-idempotent']]),
      async text() {
        const ownedPathMatch = combined.match(/"ownedOutputPaths":\\["([^"]+)"\\]/);
        const ownedPath = ownedPathMatch ? ownedPathMatch[1] : 'allocated/unknown/';
        return JSON.stringify({
          output_text: JSON.stringify({
            message: 'Idempotent folder creation.',
            actions: [{
              operation: 'createFolder',
              args: {
                path: ownedPath + 'reports'
              }
            }],
            complete: true
          }),
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        });
      }
    };
  }

  if (combined.includes('concurrent-folders')) {
    return {
      ok: true,
      status: 200,
      headers: new Map([['x-request-id', 'fake-allocated-concurrent-folders']]),
      async text() {
        const ownedPathMatch = combined.match(/"ownedOutputPaths":\\["([^"]+)"\\]/);
        const ownedPath = ownedPathMatch ? ownedPathMatch[1] : 'allocated/unknown/';
        return JSON.stringify({
          output_text: JSON.stringify({
            message: 'Concurrent folder creation.',
            actions: [{
              operation: 'createFolder',
              args: {
                path: ownedPath + 'shared-folder'
              }
            }],
            complete: true
          }),
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        });
      }
    };
  }

  if (combined.includes('bulk-write-owned')) {
    const ownedPathMatch = combined.match(/"ownedOutputPaths":\\["([^"]+)"\\]/);
    const ownedPath = ownedPathMatch ? ownedPathMatch[1] : 'allocated/unknown/';
    const count = nextCount('bulk-write-owned-' + ownedPath);
    const start = count === 1 ? 1 : 3;
    const end = count === 1 ? 2 : 4;
    return {
      ok: true,
      status: 200,
      headers: new Map([['x-request-id', 'fake-allocated-bulk-write-owned']]),
      async text() {
        return JSON.stringify({
          output_text: JSON.stringify({
            message: 'Writing owned files in batches.',
            actions: Array.from({ length: end - start + 1 }, (_, index) => ({
              operation: 'writeFile',
              args: {
                path: ownedPath + 'bulk-owned-' + String(start + index) + '.txt',
                content: 'owned-batch-' + String(start + index)
              }
            })),
            complete: count !== 1
          }),
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        });
      }
    };
  }

  if (combined.includes('action-limit-owned')) {
    const ownedPathMatch = combined.match(/"ownedOutputPaths":\\["([^"]+)"\\]/);
    const ownedPath = ownedPathMatch ? ownedPathMatch[1] : 'allocated/unknown/';
    const count = nextCount('action-limit-owned-' + ownedPath);
    if (count === 1) {
      return {
        ok: true,
        status: 200,
        headers: new Map([['x-request-id', 'fake-allocated-action-limit-owned']]),
        async text() {
          return JSON.stringify({
            output_text: JSON.stringify({
              message: 'Trying to write too many owned files at once.',
              actions: Array.from({ length: 12 }, (_, index) => ({
                operation: 'writeFile',
                args: {
                  path: ownedPath + 'action-limit-owned-' + String(index + 1).padStart(2, '0') + '.txt',
                  content: 'owned-action-limit-' + String(index + 1).padStart(2, '0')
                }
              })),
              complete: false
            }),
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
          });
        }
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Map([['x-request-id', 'fake-allocated-action-limit-owned-recover']]),
      async text() {
        return JSON.stringify({
          output_text: JSON.stringify({
            message: 'Writing owned files after correction.',
            actions: Array.from({ length: 4 }, (_, index) => ({
              operation: 'writeFile',
              args: {
                path: ownedPath + 'action-limit-owned-' + String(index + 1).padStart(2, '0') + '.txt',
                content: 'owned-action-limit-' + String(index + 1).padStart(2, '0')
              }
            })),
            complete: true
          }),
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        });
      }
    };
  }

  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'fake-allocated-request']]),
    async text() {
      const agentIdMatch = combined.match(/"assignedAgentId":(\\d+)/);
      const agentId = agentIdMatch ? agentIdMatch[1] : 'unknown';
      const ownedPathMatch = combined.match(/"ownedOutputPaths":\\["([^"]+)"\\]/);
      const ownedPath = ownedPathMatch ? ownedPathMatch[1] : 'allocated/unknown/';
      return JSON.stringify({
        output_text: JSON.stringify({
          message: 'allocated regression complete',
          actions: [{
            operation: 'writeFile',
            args: {
              path: ownedPath + 'allocated-regression-output-' + agentId + '.txt',
              content: 'allocated-regression-ok-' + agentId
            }
          }],
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

async function createAllocatedTicket(cookie, groupId, objective) {
  const response = await request('POST', '/tickets', {
    cookie,
    form: {
      objective,
      assignmentTargetType: 'group',
      assignmentTargetId: String(groupId),
      assignmentMode: 'allocated'
    }
  });

  if (response.statusCode !== 302) {
    throw new Error(`Allocated ticket create failed with HTTP ${response.statusCode}: ${response.body}`);
  }

  const ticket = readJson('tickets.json').find(item => item.objective === objective);
  if (!ticket) throw new Error('Allocated ticket was not persisted');
  return ticket;
}

async function waitForRuns(ticketId, expectedCount, predicate) {
  const started = Date.now();

  while (Date.now() - started < 30000) {
    const runs = readJson('runs.json').filter(run => run.ticketId === ticketId);
    const terminalSnapshotsReady = runs.every(run =>
      !['completed', 'failed', 'interrupted'].includes(run.status) ||
      (run.replaySnapshot && run.replaySnapshot.terminalStatus === run.status)
    );
    if (runs.length >= expectedCount && terminalSnapshotsReady && (!predicate || predicate(runs))) return runs;
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  const runs = readJson('runs.json').filter(run => run.ticketId === ticketId);
  throw new Error(`Timed out waiting for ${expectedCount} runs for ticket ${ticketId}: ${JSON.stringify(runs.map(run => ({
    id: run.id,
    agentId: run.agentId,
    status: run.status,
    error: run.error,
    terminalStatus: run.replaySnapshot && run.replaySnapshot.terminalStatus
  })))}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function verifyRunLogs(ticketId, runs) {
  const logs = readJson('logs.json').filter(log => log.ticketId === ticketId);
  const allocationPlans = readJson('allocation-plans.json');

  runs.forEach(run => {
    const runLogs = logs.filter(log => log.runId === run.id);
    const snapshot = run.replaySnapshot;
    const plan = allocationPlans.find(item => item.id === run.allocationPlanId);
    const allocationItem = plan && plan.items.find(item => item.allocationItemId === run.allocationItemId);

    assert(snapshot, `Missing replay snapshot for run ${run.id}`);
    assert(run.allocationPlanId, `Allocated run ${run.id} missing allocationPlanId`);
    assert(run.allocationItemId, `Allocated run ${run.id} missing allocationItemId`);
    assert(plan, `Missing allocation plan ${run.allocationPlanId} for run ${run.id}`);
    assert(plan.ticketId === run.ticketId, `Allocation plan has wrong ticket id for run ${run.id}`);
    assert(plan.ticketOpenedAt === run.ticketOpenedAt, `Allocation plan has wrong batch marker for run ${run.id}`);
    assert(allocationItem, `Missing allocation item ${run.allocationItemId} for run ${run.id}`);
    assert(allocationItem.assignedAgentId === run.agentId, `Allocation item assigned wrong agent for run ${run.id}`);
    assert(allocationItem.status === run.status, `Allocation item status mismatch for run ${run.id}`);
    assert(snapshot.runId === run.id, `Replay snapshot has wrong runId for run ${run.id}`);
    assert(snapshot.ticketId === run.ticketId, `Replay snapshot has wrong ticketId for run ${run.id}`);
    assert(snapshot.assignedAgentId === run.agentId, `Replay snapshot has wrong agent id for run ${run.id}`);
    assert(snapshot.agentNameSnapshot === run.agentName, `Replay snapshot has wrong agent name for run ${run.id}`);
    assert(snapshot.ticketOpenedAt === run.ticketOpenedAt, `Replay snapshot did not preserve allocated batch marker for run ${run.id}`);
    assert(run.executionWorkspaceType === 'main_owned_paths', `Allocated run ${run.id} did not use owned path execution`);
    assert(run.mainWorkspaceRoot === WORKSPACE_ROOT, `Allocated run ${run.id} has wrong main workspace root`);
    assert(Array.isArray(run.ownedOutputPaths) && run.ownedOutputPaths.length === 1, `Allocated run ${run.id} missing owned output paths`);
    assert(run.ownedOutputPaths[0] === `allocated/ticket-${run.ticketId}/agent-${run.agentId}/`, `Allocated run ${run.id} has wrong owned output path`);
    assert(run.allocationSubtask, `Allocated run ${run.id} missing allocation subtask`);
    assert(snapshot.executionWorkspaceType === 'main_owned_paths', `Replay snapshot missing owned path execution type for run ${run.id}`);
    assert(snapshot.allocationPlanId === run.allocationPlanId, `Replay snapshot missing allocation plan id for run ${run.id}`);
    assert(snapshot.allocationItemId === run.allocationItemId, `Replay snapshot missing allocation item id for run ${run.id}`);
    assert(snapshot.allocationItem && snapshot.allocationItem.assignedAgentId === run.agentId, `Replay snapshot missing allocation item for run ${run.id}`);
    assert(snapshot.mainWorkspaceRoot === WORKSPACE_ROOT, `Replay snapshot has wrong main workspace root for run ${run.id}`);
    assert(snapshot.ownedOutputPaths[0] === run.ownedOutputPaths[0], `Replay snapshot has wrong owned output path for run ${run.id}`);
    assert(snapshot.allocationSubtask === run.allocationSubtask, `Replay snapshot has wrong allocation subtask for run ${run.id}`);
    assert(snapshot.runtimeEnvelope && snapshot.runtimeEnvelope.assignedAgentId === run.agentId, `Replay snapshot missing runtime envelope for run ${run.id}`);
    assert(snapshot.runtimeEnvelope.workspaceRoot === WORKSPACE_ROOT, `Runtime envelope did not point run ${run.id} at main workspace`);
    assert(snapshot.runtimeEnvelope.mainWorkspaceRoot === WORKSPACE_ROOT, `Runtime envelope missing main workspace root for run ${run.id}`);
    assert(snapshot.runtimeEnvelope.executionWorkspaceType === 'main_owned_paths', `Runtime envelope missing owned path execution type for run ${run.id}`);
    assert(snapshot.runtimeEnvelope.allocationPlanId === run.allocationPlanId, `Runtime envelope missing allocation plan id for run ${run.id}`);
    assert(snapshot.runtimeEnvelope.allocationItemId === run.allocationItemId, `Runtime envelope missing allocation item id for run ${run.id}`);
    assert(snapshot.runtimeEnvelope.allocationItem && snapshot.runtimeEnvelope.allocationItem.assignedAgentId === run.agentId, `Runtime envelope missing allocation item for run ${run.id}`);
    assert(snapshot.runtimeEnvelope.ownedOutputPaths[0] === run.ownedOutputPaths[0], `Runtime envelope has wrong owned output path for run ${run.id}`);
    assert(snapshot.systemInstructionSnapshot && snapshot.systemInstructionSnapshot.includes('contained workspace'), `Replay snapshot missing system instructions for run ${run.id}`);
    assert(snapshot.primitiveContract && Array.isArray(snapshot.primitiveContract.allowedOperations), `Replay snapshot missing primitive contract for run ${run.id}`);
    assert(Array.isArray(snapshot.providerRequests) && snapshot.providerRequests.length > 0, `Replay snapshot missing provider request for run ${run.id}`);
    assert(Array.isArray(snapshot.modelResponses) && snapshot.modelResponses.length > 0, `Replay snapshot missing model response for run ${run.id}`);
    assert(snapshot.terminalStatus === run.status, `Replay snapshot terminal status mismatch for run ${run.id}`);
    assert(!JSON.stringify(snapshot).includes('test-key-a'), `Replay snapshot exposed first allocated agent API key for run ${run.id}`);
    assert(!JSON.stringify(snapshot).includes('test-key-b'), `Replay snapshot exposed second allocated agent API key for run ${run.id}`);
    assert(!JSON.stringify(snapshot).includes('Bearer test-key'), `Replay snapshot exposed Authorization value for run ${run.id}`);
    assert(snapshot.providerRequests.every(request =>
      request.headers && request.headers.Authorization === '[redacted]'
    ), `Replay snapshot did not redact Authorization header for run ${run.id}`);

    assert(runLogs.length > 0, `Missing logs for run ${run.id}`);
    if (run.status === 'completed') {
      assert(runLogs.some(log =>
        log.type.startsWith('workspace:') &&
        log.workspaceAction &&
        log.workspaceAction.workspaceRoot === WORKSPACE_ROOT &&
        log.workspaceAction.executionWorkspaceType === 'main_owned_paths' &&
        log.workspaceAction.allocationPlanId === run.allocationPlanId &&
        log.workspaceAction.allocationItemId === run.allocationItemId
      ), `Workspace logs did not identify owned-path main workspace for run ${run.id}`);
    }
    assert(
      runLogs.every(log =>
        log.ticketId === run.ticketId &&
        log.agentId === run.agentId &&
        log.agentName === run.agentName
      ),
      `Incorrect run/ticket/agent log identity for run ${run.id}`
    );
  });
}

function verifyAgentMetricCounts(agentIds) {
  const runs = readJson('runs.json');

  agentIds.forEach(agentId => {
    const agentRuns = runs.filter(run => run.agentId === agentId);
    assert(agentRuns.length > 0, `Expected allocated runs for agent ${agentId}`);
  });
}

function assertOwnedPathsDoNotOverlap(runs) {
  const ownedPaths = runs.flatMap(run => run.ownedOutputPaths || []);

  ownedPaths.forEach((ownedPath, index) => {
    ownedPaths.forEach((otherPath, otherIndex) => {
      if (index === otherIndex) return;
      assert(
        ownedPath !== otherPath &&
          !ownedPath.startsWith(otherPath) &&
          !otherPath.startsWith(ownedPath),
        `Allocated owned paths overlap: ${ownedPath} and ${otherPath}`
      );
    });
  });
}

function verifyOwnershipFailure(ticketId, runs, expectedOperation) {
  const logs = readJson('logs.json').filter(log => log.ticketId === ticketId);

  assert(logs.some(log =>
    log.type === 'workspace:ownership_blocked' &&
    log.workspaceAction &&
    log.workspaceAction.operation === expectedOperation &&
    Array.isArray(log.workspaceAction.ownedOutputPaths) &&
    log.workspaceAction.ownedOutputPaths.length > 0
  ), `Missing workspace:ownership_blocked log for ${expectedOperation}`);

  runs.forEach(run => {
    assert(run.status === 'failed', `Ownership violation run ${run.id} did not fail`);
    assert(run.replaySnapshot.workspaceOperations.some(item =>
      item.blocked === true &&
      item.operation &&
      item.operation.operation === expectedOperation &&
      item.reason === 'Allocated runs may only mutate owned output paths' &&
      Array.isArray(item.ownedOutputPaths)
    ), `Ownership violation missing replay capture for ${expectedOperation} run ${run.id}`);
  });
}

function seedPendingAllocatedRun(group, agent) {
  const tickets = readJson('tickets.json');
  const runs = readJson('runs.json');
  const allocationPlans = readJson('allocation-plans.json');
  const now = new Date().toISOString();
  const ticket = {
    id: Math.max(0, ...tickets.map(item => item.id)) + 1,
    objective: `allocated reports manual-stop ${STAMP}`,
    assignmentTargetType: 'group',
    assignmentTargetId: group.id,
    assignmentMode: 'allocated',
    status: 'in_progress',
    createdBy: 'admin',
    createdAt: now,
    updatedAt: now
  };
  const run = {
    id: Math.max(0, ...runs.map(item => item.id)) + 1,
    ticketId: ticket.id,
    agentId: agent.id,
    agentName: agent.name,
    workspaceRoot: WORKSPACE_ROOT,
    mainWorkspaceRoot: WORKSPACE_ROOT,
    executionWorkspaceType: 'main_owned_paths',
    allocationPlanId: Math.max(0, ...allocationPlans.map(item => item.id)) + 1,
    allocationItemId: Math.max(0, ...allocationPlans.flatMap(plan => plan.items || []).map(item => item.allocationItemId)) + 1,
    allocationSubtask: `Produce your allocated output for ticket ${ticket.id} inside your owned path only.`,
    ownedOutputPaths: [`allocated/ticket-${ticket.id}/agent-${agent.id}/`],
    status: 'pending',
    ticketOpenedAt: now,
    createdAt: now,
    updatedAt: now
  };
  const allocationPlan = {
    id: run.allocationPlanId,
    ticketId: ticket.id,
    ticketOpenedAt: run.ticketOpenedAt,
    mode: 'owned_paths',
    status: 'pending',
    createdAt: now,
    items: [{
      allocationItemId: run.allocationItemId,
      allocationSubtask: run.allocationSubtask,
      ownedOutputPaths: run.ownedOutputPaths,
      assignedAgentId: agent.id,
      status: 'pending',
      createdAt: now
    }]
  };

  writeJson('tickets.json', [...tickets, ticket]);
  writeJson('runs.json', [...runs, run]);
  writeJson('allocation-plans.json', [...allocationPlans, allocationPlan]);
  return { ticket, run };
}

async function verifyRunDetailPage(cookie, run) {
  const response = await request('GET', `/runs/${run.id}`, { cookie });

  assert(response.statusCode === 200, `/runs/${run.id} returned HTTP ${response.statusCode}`);
  assert(response.body.includes(`Run #${run.id}`), 'Run detail page missing run heading');
  assert(response.body.includes('Batch Marker'), 'Run detail page missing batch marker');
  assert(response.body.includes('main_owned_paths'), 'Run detail page missing owned-path execution type');
  assert(response.body.includes('Allocation Plan'), 'Run detail page missing allocation plan label');
  assert(response.body.includes(String(run.allocationPlanId)), 'Run detail page missing allocation plan id');
  assert(response.body.includes('Allocation Item'), 'Run detail page missing allocation item label');
  assert(response.body.includes(String(run.allocationItemId)), 'Run detail page missing allocation item id');
  assert(response.body.includes('Owned Paths'), 'Run detail page missing owned path metadata');
  assert(response.body.includes(run.ownedOutputPaths[0]), 'Run detail page missing owned output path');
  assert(response.body.includes('Allocation Subtask'), 'Run detail page missing allocation subtask');
  assert(response.body.includes('Model Responses'), 'Run detail page missing model responses section');
  assert(!response.body.includes('test-key-a'), 'Run detail page exposed first allocated agent API key');
  assert(!response.body.includes('test-key-b'), 'Run detail page exposed second allocated agent API key');
  assert(!response.body.includes('Bearer test-key'), 'Run detail page exposed Authorization value');
}

async function main() {
  const { agents, group } = seedAllocatedGroup();
  const preloadPath = createFakeOpenAIPreload(agents[1].id);
  let server = null;

  try {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT,
        NODE_OPTIONS: `--require ${preloadPath}`,
        WORKSPACE_ROOT,
        DATA_DIR,
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '4'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', chunk => process.stdout.write(String(chunk)));
    server.stderr.on('data', chunk => process.stderr.write(String(chunk)));

    await waitForReady();
    const cookie = await login();

    const completeTicket = await createAllocatedTicket(cookie, group.id, `allocated reports complete-all ${STAMP}`);
    const completeRuns = await waitForRuns(
      completeTicket.id,
      2,
      runs => runs.every(run => run.status === 'completed')
    );
    const completedTicket = readJson('tickets.json').find(ticket => ticket.id === completeTicket.id);
    assert(completedTicket.status === 'completed', 'Ticket did not complete after all allocated runs completed');
    assert(new Set(completeRuns.map(run => run.agentId)).size === 2, 'Allocated ticket did not create one run per group agent');
    assert(new Set(completeRuns.map(run => run.ticketOpenedAt)).size === 1, 'Allocated batch did not share ticketOpenedAt');
    assert(new Set(completeRuns.map(run => run.allocationPlanId)).size === 1, 'Allocated batch did not share one allocation plan');
    const completePlan = readJson('allocation-plans.json').find(plan => plan.id === completeRuns[0].allocationPlanId);
    assert(completePlan && completePlan.status === 'completed', 'Completed allocated batch did not complete allocation plan');
    assert(completePlan.items.length === 2, 'Completed allocated plan did not create one item per agent');
    assertOwnedPathsDoNotOverlap(completeRuns);
    verifyRunLogs(completeTicket.id, completeRuns);
    completeRuns.forEach(run => {
      const ownedFile = path.join(WORKSPACE_ROOT, run.ownedOutputPaths[0], `allocated-regression-output-${run.agentId}.txt`);
      const unownedFile = path.join(WORKSPACE_ROOT, `allocated-regression-output-${run.agentId}.txt`);

      assert(fs.existsSync(ownedFile), `Allocated owned output missing for run ${run.id}`);
      assert(!fs.existsSync(unownedFile), `Allocated run wrote outside owned path for agent ${run.agentId}`);
    });
    await verifyRunDetailPage(cookie, completeRuns[0]);

    const failTicket = await createAllocatedTicket(cookie, group.id, `allocated reports fail-one ${STAMP}`);
    const failedRuns = await waitForRuns(
      failTicket.id,
      2,
      runs => runs.every(run => ['completed', 'failed'].includes(run.status))
    );
    const failedTicket = await (async () => {
      const started = Date.now();
      while (Date.now() - started < 3000) {
        const ticket = readJson('tickets.json').find(ticket => ticket.id === failTicket.id);
        if (ticket && ticket.status === 'failed') return ticket;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return readJson('tickets.json').find(ticket => ticket.id === failTicket.id);
    })();
    assert(failedRuns.some(run => run.status === 'failed'), 'Expected one allocated run to fail');
    assert(failedTicket && failedTicket.status === 'failed', 'Ticket did not fail when one allocated run failed');
    const failedPlan = readJson('allocation-plans.json').find(plan => plan.id === failedRuns[0].allocationPlanId);
    assert(failedPlan && failedPlan.status === 'failed', 'Failed allocated batch did not fail allocation plan');
    verifyRunLogs(failTicket.id, failedRuns);

    const ownershipViolationTicket = await createAllocatedTicket(cookie, group.id, `allocated reports ownership-violation ${STAMP}`);
    const ownershipViolationRuns = await waitForRuns(
      ownershipViolationTicket.id,
      2,
      runs => runs.every(run => run.status === 'failed')
    );
    const ownershipViolationLogs = readJson('logs.json').filter(log => log.ticketId === ownershipViolationTicket.id);
    assert(ownershipViolationLogs.some(log => log.type === 'workspace:ownership_blocked'), 'Ownership violation did not log workspace:ownership_blocked');
    verifyOwnershipFailure(ownershipViolationTicket.id, ownershipViolationRuns, 'writeFile');

    const renameViolationTicket = await createAllocatedTicket(cookie, group.id, `allocated reports path-violation-alpha ${STAMP}`);
    const renameViolationRuns = await waitForRuns(
      renameViolationTicket.id,
      2,
      runs => runs.every(run => run.status === 'failed')
    );
    verifyOwnershipFailure(renameViolationTicket.id, renameViolationRuns, 'renamePath');

    const deleteViolationTicket = await createAllocatedTicket(cookie, group.id, `allocated reports path-violation-beta ${STAMP}`);
    const deleteViolationRuns = await waitForRuns(
      deleteViolationTicket.id,
      2,
      runs => runs.every(run => run.status === 'failed')
    );
    verifyOwnershipFailure(deleteViolationTicket.id, deleteViolationRuns, 'deletePath');

    const operationBudgetTicket = await createAllocatedTicket(cookie, group.id, `allocated reports operation-budget ${STAMP}`);
    const operationBudgetRuns = await waitForRuns(
      operationBudgetTicket.id,
      2,
      runs => runs.every(run => run.status === 'failed')
    );
    const operationBudgetLogs = readJson('logs.json').filter(log => log.ticketId === operationBudgetTicket.id);
    assert(operationBudgetLogs.some(log => log.type === 'run:operation_limit'), 'Allocated operation budget did not log run:operation_limit');
    operationBudgetRuns.forEach(run => {
      assert(run.replaySnapshot.events.some(event =>
        event.type === 'run:operation_limit' &&
        event.limitType === 'operation' &&
        event.configuredLimit === 4
      ), `Allocated operation budget missing replay event for run ${run.id}`);
    });

    const manualStop = seedPendingAllocatedRun(group, agents[0]);
    const stopResponse = await request('POST', `/api/runs/${manualStop.run.id}/stop`, { cookie });
    assert(stopResponse.statusCode === 200, `Allocated manual stop failed with HTTP ${stopResponse.statusCode}`);
    const stoppedRun = readJson('runs.json').find(run => run.id === manualStop.run.id);
    const stoppedLogs = readJson('logs.json').filter(log => log.runId === manualStop.run.id);
    assert(stoppedRun.status === 'interrupted', 'Allocated manual stop did not interrupt run');
    const stoppedPlan = readJson('allocation-plans.json').find(plan => plan.id === stoppedRun.allocationPlanId);
    const stoppedItem = stoppedPlan && stoppedPlan.items.find(item => item.allocationItemId === stoppedRun.allocationItemId);
    assert(stoppedItem && stoppedItem.status === 'interrupted', 'Allocated manual stop did not interrupt allocation item');
    assert(stoppedRun.executionWorkspaceType === 'main_owned_paths', 'Allocated manual stop did not preserve execution type');
    assert(stoppedRun.ownedOutputPaths[0] === manualStop.run.ownedOutputPaths[0], 'Allocated manual stop did not preserve owned path');
    assert(stoppedLogs.some(log => log.type === 'run:interrupted'), 'Allocated manual stop missing run:interrupted log');
    const stoppedHistory = readJson('operation-history.json').filter(h => h.runId === manualStop.run.id);
    assert(stoppedHistory.length === 0, 'Interrupted run should have no operation history');
    const retryResponse = await request('POST', `/api/runs/${manualStop.run.id}/retry`, { cookie });
    assert(retryResponse.statusCode === 200, `Allocated retry failed with HTTP ${retryResponse.statusCode}`);
    const retryRuns = await waitForRuns(
      manualStop.ticket.id,
      3,
      runs => runs.some(run => run.status === 'interrupted') &&
        runs.filter(run => run.status === 'completed').length === 2
    );
    const retriedRuns = retryRuns.filter(run => run.status === 'completed');
    assert(new Set(retriedRuns.map(run => run.allocationPlanId)).size === 1, 'Allocated retry did not create one fresh allocation plan');
    assertOwnedPathsDoNotOverlap(retriedRuns);
    retriedRuns.forEach(run => {
      assert(run.executionWorkspaceType === 'main_owned_paths', `Retry run ${run.id} did not preserve owned-path execution`);
      assert(run.ownedOutputPaths[0] === `allocated/ticket-${run.ticketId}/agent-${run.agentId}/`, `Retry run ${run.id} did not preserve deterministic owned path`);
    });

    const rejectedTicket = await request('POST', '/tickets', {
      cookie,
      form: {
        objective: `allocated delete cleanup ${STAMP}`,
        assignmentTargetType: 'group',
        assignmentTargetId: String(group.id),
        assignmentMode: 'allocated'
      }
    });
    assert(rejectedTicket.statusCode === 400, `Destructive allocated ticket was not rejected: HTTP ${rejectedTicket.statusCode}`);
    assert(rejectedTicket.body.includes('objective appears destructive'), 'Destructive rejection message was unclear');
    assert(!readJson('tickets.json').some(ticket => ticket.objective === `allocated delete cleanup ${STAMP}`), 'Rejected allocated ticket was persisted');

    const ambiguousTicket = await request('POST', '/tickets', {
      cookie,
      form: {
        objective: `allocated coordinate improvement ${STAMP}`,
        assignmentTargetType: 'group',
        assignmentTargetId: String(group.id),
        assignmentMode: 'allocated'
      }
    });
    assert(ambiguousTicket.statusCode === 400, `Ambiguous allocated ticket was not rejected: HTTP ${ambiguousTicket.statusCode}`);
    assert(ambiguousTicket.body.includes('does not clearly describe additive independent outputs'), 'Ambiguous rejection message was unclear');

    const reopen = await request('PATCH', `/api/tickets/${failTicket.id}/status`, {
      cookie,
      body: { status: 'open' }
    });
    assert(reopen.statusCode === 200, `Rerun reopen failed with HTTP ${reopen.statusCode}`);
    const rerunRuns = await waitForRuns(
      failTicket.id,
      4,
      runs => runs.length >= 4 && runs.every(run => ['completed', 'failed'].includes(run.status))
    );
    const firstBatchMarker = failedRuns[0].ticketOpenedAt;
    const freshBatchRuns = rerunRuns.filter(run => run.ticketOpenedAt !== firstBatchMarker);
    assert(freshBatchRuns.length === 2, 'Rerun did not create a fresh two-run batch');
    assert(new Set(freshBatchRuns.map(run => run.ticketOpenedAt)).size === 1, 'Rerun batch did not have a distinct shared marker');
    assert(new Set(freshBatchRuns.map(run => run.allocationPlanId)).size === 1, 'Rerun batch did not create one fresh allocation plan');
    assert(!freshBatchRuns.some(run => run.allocationPlanId === failedRuns[0].allocationPlanId), 'Rerun reused old allocation plan');
    assertOwnedPathsDoNotOverlap(freshBatchRuns);
    freshBatchRuns.forEach(run => {
      assert(run.executionWorkspaceType === 'main_owned_paths', `Rerun run ${run.id} did not preserve owned-path execution`);
      assert(run.ownedOutputPaths[0] === `allocated/ticket-${run.ticketId}/agent-${run.agentId}/`, `Rerun run ${run.id} did not preserve deterministic owned path`);
      assert(run.allocationSubtask, `Rerun run ${run.id} did not preserve allocation subtask`);
    });

    const duplicateTicketId = Math.max(0, ...readJson('tickets.json').map(ticket => ticket.id)) + 1;
    const openedAt = new Date().toISOString();
    writeJson('tickets.json', [
      ...readJson('tickets.json'),
      {
        id: duplicateTicketId,
        objective: `allocated reports duplicate-active ${STAMP}`,
        assignmentTargetType: 'group',
        assignmentTargetId: group.id,
        assignmentMode: 'allocated',
        status: 'closed',
        createdBy: 'admin',
        createdAt: openedAt,
        updatedAt: openedAt
      }
    ]);
    const nextRunId = Math.max(0, ...readJson('runs.json').map(run => run.id)) + 1;
    const duplicatePlanId = Math.max(0, ...readJson('allocation-plans.json').map(plan => plan.id)) + 1;
    const duplicateItemId = Math.max(0, ...readJson('allocation-plans.json').flatMap(plan => plan.items || []).map(item => item.allocationItemId)) + 1;
    const duplicateOwnedPath = `allocated/ticket-${duplicateTicketId}/agent-${agents[0].id}/`;
    const duplicateSubtask = `Produce your allocated output for ticket ${duplicateTicketId} inside your owned path only.`;
    writeJson('allocation-plans.json', [
      ...readJson('allocation-plans.json'),
      {
        id: duplicatePlanId,
        ticketId: duplicateTicketId,
        ticketOpenedAt: openedAt,
        mode: 'owned_paths',
        status: 'pending',
        createdAt: openedAt,
        items: [{
          allocationItemId: duplicateItemId,
          allocationSubtask: duplicateSubtask,
          ownedOutputPaths: [duplicateOwnedPath],
          assignedAgentId: agents[0].id,
          status: 'pending',
          createdAt: openedAt
        }]
      }
    ]);
    writeJson('runs.json', [
      ...readJson('runs.json'),
      {
        id: nextRunId,
        ticketId: duplicateTicketId,
        agentId: agents[0].id,
        agentName: agents[0].name,
        workspaceRoot: WORKSPACE_ROOT,
        mainWorkspaceRoot: WORKSPACE_ROOT,
        executionWorkspaceType: 'main_owned_paths',
        allocationPlanId: duplicatePlanId,
        allocationItemId: duplicateItemId,
        allocationSubtask: duplicateSubtask,
        ownedOutputPaths: [duplicateOwnedPath],
        status: 'pending',
        ticketOpenedAt: openedAt,
        createdAt: openedAt,
        updatedAt: openedAt
      }
    ]);
    const duplicateReopen = await request('PATCH', `/api/tickets/${duplicateTicketId}/status`, {
      cookie,
      body: { status: 'open' }
    });
    assert(duplicateReopen.statusCode === 200, `Duplicate active reopen failed with HTTP ${duplicateReopen.statusCode}`);
    const duplicateRuns = await waitForRuns(duplicateTicketId, 2);
    const duplicateCounts = duplicateRuns.reduce((counts, run) => {
      counts[run.agentId] = (counts[run.agentId] || 0) + 1;
      return counts;
    }, {});
    assert(duplicateCounts[agents[0].id] === 1, 'Duplicate active run was created for the same ticket + agent');
    assert(duplicateCounts[agents[1].id] === 1, 'Missing run for second group agent when first agent already had active run');
    const newDuplicateRun = duplicateRuns.find(run => run.agentId === agents[1].id);
    const newDuplicatePlan = readJson('allocation-plans.json').find(plan => plan.id === newDuplicateRun.allocationPlanId);
    assert(newDuplicatePlan && newDuplicatePlan.items.length === 1, 'Duplicate-active path created unused allocation items');

    verifyAgentMetricCounts(agents.map(agent => agent.id));

    const createFolderOwnershipTicket = await createAllocatedTicket(cookie, group.id, `allocated reports createfolder-outside-owned ${STAMP}`);
    const createFolderOwnershipRuns = await waitForRuns(
      createFolderOwnershipTicket.id,
      2,
      runs => runs.every(run => run.status === 'failed')
    );
    verifyOwnershipFailure(createFolderOwnershipTicket.id, createFolderOwnershipRuns, 'createFolder');
    const ownershipOpHistory = readJson('operation-history.json').filter(h =>
      createFolderOwnershipRuns.some(run => run.id === h.runId)
    );
    assert(ownershipOpHistory.length === 0, 'Blocked ownership violation should not create operation history');

    const idempotentTicket = await createAllocatedTicket(cookie, group.id, `allocated reports createfolder-idempotent ${STAMP}`);
    const idempotentRuns = await waitForRuns(
      idempotentTicket.id,
      2,
      runs => runs.every(run => run.status === 'completed')
    );
    verifyRunLogs(idempotentTicket.id, idempotentRuns);
    idempotentRuns.forEach(run => {
      const folderPath = path.join(WORKSPACE_ROOT, run.ownedOutputPaths[0], 'reports');
      assert(fs.existsSync(folderPath) && fs.lstatSync(folderPath).isDirectory(), `Idempotent folder missing for run ${run.id}`);
      assert(run.replaySnapshot.workspaceOperations.some(item =>
        item.operation && item.operation.operation === 'createFolder' &&
        item.result && item.result.status === 'created'
      ), `Missing created replay entry for run ${run.id}`);
      const createLogs = readJson('logs.json').filter(log => log.runId === run.id && log.type === 'workspace:create' && log.workspaceAction && log.workspaceAction.operation === 'createFolder');
      assert(createLogs.length > 0, `Missing workspace:create logs for run ${run.id}`);
      assert(createLogs.some(log => log.workspaceAction.status === 'created'), `Missing created log status for run ${run.id}`);
      const runHistory = readJson('operation-history.json').filter(h => h.runId === run.id);
      assert(runHistory.length > 0, `Missing operation history for idempotent run ${run.id}`);
      const createFolderHistory = runHistory.find(h => h.operation === 'createFolder');
      assert(createFolderHistory, `Missing createFolder history for idempotent run ${run.id}`);
      assert(createFolderHistory.preState && createFolderHistory.preState.existed === false, `createFolder preState should show non-existent for run ${run.id}`);
      assert(createFolderHistory.postState && createFolderHistory.postState.existed === true && createFolderHistory.postState.type === 'directory', `createFolder postState should show directory for run ${run.id}`);
    });

    const idempotentReopen = await request('PATCH', `/api/tickets/${idempotentTicket.id}/status`, {
      cookie,
      body: { status: 'open' }
    });
    assert(idempotentReopen.statusCode === 200, `Idempotent rerun reopen failed with HTTP ${idempotentReopen.statusCode}`);
    const idempotentRerunRuns = await waitForRuns(
      idempotentTicket.id,
      4,
      runs => runs.length >= 4 && runs.every(run => ['completed', 'failed'].includes(run.status))
    );
    const freshIdempotentRuns = idempotentRerunRuns.filter(run => run.ticketOpenedAt !== idempotentRuns[0].ticketOpenedAt);
    assert(freshIdempotentRuns.length === 2, 'Idempotent rerun did not create fresh two-run batch');
    freshIdempotentRuns.forEach(run => {
      assert(run.status === 'completed', `Idempotent rerun run ${run.id} did not complete`);
      assert(run.replaySnapshot.workspaceOperations.some(item =>
        item.operation && item.operation.operation === 'createFolder' &&
        item.result && item.result.status === 'already_exists_noop'
      ), `Missing already_exists_noop replay entry for rerun run ${run.id}`);
      const noopLogs = readJson('logs.json').filter(log => log.runId === run.id && log.type === 'workspace:create' && log.workspaceAction && log.workspaceAction.operation === 'createFolder' && log.workspaceAction.status === 'already_exists_noop');
      assert(noopLogs.length > 0, `Missing already_exists_noop log for rerun run ${run.id}`);
      const rerunHistory = readJson('operation-history.json').filter(h => h.runId === run.id);
      assert(rerunHistory.length > 0, `Missing operation history for rerun run ${run.id}`);
      const noopHistory = rerunHistory.find(h => h.operation === 'createFolder');
      assert(noopHistory, `Missing createFolder history for rerun run ${run.id}`);
      assert(noopHistory.preState && noopHistory.preState.existed === true && noopHistory.preState.type === 'directory', `Rerun createFolder preState should show existing directory for run ${run.id}`);
      assert(noopHistory.postState && noopHistory.postState.existed === true && noopHistory.postState.type === 'directory', `Rerun createFolder postState should show existing directory for run ${run.id}`);
      assert(noopHistory.result && noopHistory.result.status === 'already_exists_noop', `Rerun createFolder result should be noop for run ${run.id}`);
    });
    const allIdempotentHistory = readJson('operation-history.json').filter(h =>
      idempotentRuns.concat(freshIdempotentRuns).some(run => run.id === h.runId)
    );
    assert(allIdempotentHistory.every(h => idempotentRuns.concat(freshIdempotentRuns).some(run => run.id === h.runId)), 'All idempotent history should map to known runs');
    assert(new Set(allIdempotentHistory.map(h => h.runId)).size === 4, 'Idempotent history should span exactly 4 runs');

    const nextConcurrentTicketId = Math.max(0, ...readJson('tickets.json').map(t => t.id)) + 1;
    const preexistingConcurrentPath = path.join(WORKSPACE_ROOT, `allocated/ticket-${nextConcurrentTicketId}/agent-${agents[0].id}/shared-folder`);
    fs.mkdirSync(preexistingConcurrentPath, { recursive: true });
    const concurrentTicket = await createAllocatedTicket(cookie, group.id, `allocated reports concurrent-folders ${STAMP}`);
    const concurrentRuns = await waitForRuns(
      concurrentTicket.id,
      2,
      runs => runs.every(run => run.status === 'completed')
    );
    verifyRunLogs(concurrentTicket.id, concurrentRuns);
    const agent0Run = concurrentRuns.find(run => run.agentId === agents[0].id);
    const agent1Run = concurrentRuns.find(run => run.agentId === agents[1].id);
    assert(agent0Run && agent0Run.replaySnapshot.workspaceOperations.some(item =>
      item.operation && item.operation.operation === 'createFolder' &&
      item.result && item.result.status === 'already_exists_noop'
    ), `Concurrent run for agent 0 missing noop replay entry`);
    assert(agent1Run && agent1Run.replaySnapshot.workspaceOperations.some(item =>
      item.operation && item.operation.operation === 'createFolder' &&
      item.result && item.result.status === 'created'
    ), `Concurrent run for agent 1 missing created replay entry`);
    const concurrentHistory = readJson('operation-history.json').filter(h =>
      concurrentRuns.some(run => run.id === h.runId)
    );
    assert(concurrentHistory.length === 2, `Expected 2 concurrent operation history records, found ${concurrentHistory.length}`);
    assert(concurrentHistory.every(h => h.operation === 'createFolder'), 'All concurrent history should be createFolder');
    const agent0History = concurrentHistory.find(h => h.runId === agent0Run.id);
    const agent1History = concurrentHistory.find(h => h.runId === agent1Run.id);
    assert(agent0History && agent0History.preState && agent0History.preState.existed === true, 'Agent 0 concurrent history should show pre-existing folder');
    assert(agent1History && agent1History.preState && agent1History.preState.existed === false, 'Agent 1 concurrent history should show non-existing folder');
    assert(concurrentHistory.every((h, i) => i === 0 || h.id > concurrentHistory[i - 1].id), 'Concurrent operation history should be ordered by id');

    const bulkWriteOwnedTicket = await createAllocatedTicket(cookie, group.id, `allocated reports bulk-write-owned ${STAMP}`);
    const bulkWriteOwnedRuns = await waitForRuns(
      bulkWriteOwnedTicket.id,
      2,
      runs => runs.every(run => run.status === 'completed')
    );
    verifyRunLogs(bulkWriteOwnedTicket.id, bulkWriteOwnedRuns);
    bulkWriteOwnedRuns.forEach(run => {
      const ownedPath = run.ownedOutputPaths[0];
      for (let i = 1; i <= 4; i += 1) {
        const filePath = path.join(WORKSPACE_ROOT, ownedPath, `bulk-owned-${i}.txt`);
        assert(fs.existsSync(filePath), `Bulk write owned missing file for run ${run.id}: ${filePath}`);
      }
      const runHistory = readJson('operation-history.json').filter(h => h.runId === run.id);
      assert(runHistory.length === 4, `Expected 4 operation history records for bulk owned run ${run.id}, found ${runHistory.length}`);
      assert(runHistory.every(h => h.operation === 'writeFile'), `All bulk owned history should be writeFile for run ${run.id}`);
      assert(run.replaySnapshot.mutationCount === 4, `Bulk owned run ${run.id} mutation count should be 4, got ${run.replaySnapshot.mutationCount}`);
      assert(run.replaySnapshot.mutationOutcome === 'all_intended', `Bulk owned run ${run.id} mutation outcome should be all_intended, got ${run.replaySnapshot.mutationOutcome}`);
    });

    const actionLimitOwnedTicket = await createAllocatedTicket(cookie, group.id, `allocated reports action-limit-owned ${STAMP}`);
    const actionLimitOwnedRuns = await waitForRuns(
      actionLimitOwnedTicket.id,
      2,
      runs => runs.every(run => run.status === 'completed')
    );
    verifyRunLogs(actionLimitOwnedTicket.id, actionLimitOwnedRuns);
    actionLimitOwnedRuns.forEach(run => {
      const ownedPath = run.ownedOutputPaths[0];
      for (let i = 1; i <= 4; i += 1) {
        const filePath = path.join(WORKSPACE_ROOT, ownedPath, `action-limit-owned-${String(i).padStart(2, '0')}.txt`);
        assert(fs.existsSync(filePath), `Action-limit owned missing file for run ${run.id}: ${filePath}`);
      }
      const runLogs = readJson('logs.json').filter(log => log.runId === run.id);
      assert(runLogs.some(log => log.type === 'model:action_limit'), `Missing model:action_limit log for run ${run.id}`);
      assert(run.replaySnapshot.events.some(event =>
        event.type === 'model:action_limit' &&
        event.actionCount === 12 &&
        event.maxActionsPerResponse === 8
      ), `Replay snapshot missing action-limit event for run ${run.id}`);
      const runHistory = readJson('operation-history.json').filter(h => h.runId === run.id);
      assert(runHistory.length === 4, `Expected 4 operation history records for action-limit owned run ${run.id}, found ${runHistory.length}`);
      assert(runHistory.every(h => h.operation === 'writeFile'), `All action-limit owned history should be writeFile for run ${run.id}`);
      assert(run.replaySnapshot.mutationCount === 4, `Action-limit owned run ${run.id} mutation count should be 4, got ${run.replaySnapshot.mutationCount}`);
      assert(run.replaySnapshot.mutationOutcome === 'all_intended', `Action-limit owned run ${run.id} mutation outcome should be all_intended, got ${run.replaySnapshot.mutationOutcome}`);
    });

    const agentsPage = await request('GET', '/agents', { cookie });
    assert(agentsPage.statusCode === 200, `/agents returned HTTP ${agentsPage.statusCode}`);
    agents.forEach(agent => {
      assert(agentsPage.body.includes(agent.name), `/agents page missing ${agent.name}`);
    });

    console.log(JSON.stringify({
      completeRuns: completeRuns.length,
      failedRuns: failedRuns.length,
      rerunFreshBatchRuns: freshBatchRuns.length,
      duplicateRunCounts: duplicateCounts,
      bulkWriteOwnedRuns: bulkWriteOwnedRuns.length,
      actionLimitOwnedRuns: actionLimitOwnedRuns.length
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

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
