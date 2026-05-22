const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const WORKSPACE_ROOT = createTempWorkspaceRoot('allocated-live');
const PORT = process.env.PORT || '3423';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DATA_FILES = [
  'agents.json',
  'allocation-plans.json',
  'groups.json',
  'logs.json',
  'memberships.json',
  'runs.json',
  'tickets.json',
  'users.json'
];
const STAMP = Date.now();
const TEST_GROUP_NAME = `AllocatedLiveGroup-${STAMP}`;
const TEST_AGENT_NAMES = [
  `AllocatedLiveAgentA-${STAMP}`,
  `AllocatedLiveAgentB-${STAMP}`
];

function requireLiveTestEnv() {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Live allocated OpenAI tests require NODE_ENV=test');
  }

  if (process.env.ALLOW_LIVE_OPENAI_TESTS !== 'true') {
    throw new Error('Live allocated OpenAI tests require ALLOW_LIVE_OPENAI_TESTS=true');
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Live allocated OpenAI tests require OPENAI_API_KEY');
  }

  if (!process.env.OPENAI_MODEL) {
    throw new Error('Live allocated OpenAI tests require OPENAI_MODEL');
  }
}

function readJson(file) {
  const filePath = path.join(DATA_DIR, file);
  let lastError = null;

  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      lastError = error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }

  throw lastError;
}

function writeJson(file, value) {
  fs.writeFileSync(path.join(DATA_DIR, file), `${JSON.stringify(value, null, 2)}\n`);
}

function backupData() {
  return new Map(DATA_FILES.map(file => [file, fs.readFileSync(path.join(DATA_DIR, file), 'utf8')]));
}

function restoreData(backup) {
  backup.forEach((contents, file) => {
    fs.writeFileSync(path.join(DATA_DIR, file), contents);
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
  return (response.headers['set-cookie'] || []).map(cookie => cookie.split(';')[0]).join('; ');
}

function waitForExit(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.killed) return resolve();
    child.once('exit', () => resolve());
  });
}

async function waitForServer() {
  const started = Date.now();

  while (Date.now() - started < 15000) {
    try {
      const response = await request('GET', '/login');
      if (response.statusCode === 200) return;
    } catch (error) {
      // Server is still starting.
    }

    await new Promise(resolve => setTimeout(resolve, 150));
  }

  throw new Error('Timed out waiting for local server');
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

function openLogStream(cookie, receivedLogs) {
  const req = http.request(`${BASE_URL}/api/logs/events`, {
    method: 'GET',
    headers: {
      Accept: 'text/event-stream',
      Cookie: cookie
    }
  });
  let buffer = '';

  req.on('response', res => {
    res.setEncoding('utf8');
    res.on('data', chunk => {
      buffer += chunk;
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';

      events.forEach(eventText => {
        const dataLine = eventText.split('\n').find(line => line.startsWith('data: '));
        if (!dataLine) return;

        try {
          receivedLogs.push(JSON.parse(dataLine.slice(6)));
        } catch (error) {
          // Ignore non-JSON SSE payloads.
        }
      });
    });
  });

  req.on('error', () => {});
  req.end();
  return req;
}

function seedAllocatedGroup() {
  const groups = readJson('groups.json');
  const group = {
    id: Math.max(0, ...groups.map(item => item.id)) + 1,
    name: TEST_GROUP_NAME,
    permissions: [],
    canReceiveTickets: true
  };

  writeJson('groups.json', [...groups, group]);
  return group;
}

async function createAgent(cookie, groupId, name) {
  const response = await request('POST', '/admin/users', {
    cookie,
    form: {
      accountType: 'agent',
      agentName: name,
      model: process.env.OPENAI_MODEL,
      apiKey: process.env.OPENAI_API_KEY,
      groupIds: String(groupId)
    }
  });

  if (response.statusCode !== 302) {
    throw new Error(`Agent create failed with HTTP ${response.statusCode}: ${response.body}`);
  }

  const agent = readJson('agents.json').find(item => item.name === name);
  if (!agent) throw new Error(`Created agent ${name} was not persisted`);
  if (agent.model !== process.env.OPENAI_MODEL) throw new Error(`Agent ${name} did not persist selected model`);

  return agent;
}

async function createAllocatedTicket(cookie, groupId, objective) {
  const agents = readJson('agents.json').filter(agent =>
    readJson('memberships.json').some(m =>
      m.principalType === 'agent' && m.principalId === agent.id && m.groupId === groupId
    )
  );
  const ownedPathMap = {};
  agents.forEach(agent => {
    ownedPathMap[agent.id] = `test-output/agent-${agent.id}/`;
  });
  Object.values(ownedPathMap).forEach(p => fs.mkdirSync(path.join(WORKSPACE_ROOT, p), { recursive: true }));

  const response = await request('POST', '/tickets', {
    cookie,
    form: {
      objective,
      assignmentTargetType: 'group',
      assignmentTargetId: String(groupId),
      assignmentMode: 'allocated',
      ownedOutputPaths: JSON.stringify(ownedPathMap)
    }
  });

  if (response.statusCode !== 302) {
    throw new Error(`Allocated ticket create failed with HTTP ${response.statusCode}: ${response.body}`);
  }

  const ticket = readJson('tickets.json').find(item => item.objective === objective);
  if (!ticket) throw new Error('Allocated ticket was not persisted');
  return ticket;
}

async function waitForTicketStatus(ticketId, expectedStatus, timeoutMs) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const ticket = readJson('tickets.json').find(item => item.id === ticketId);
    if (ticket && ticket.status === expectedStatus) return ticket;
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ticket ${ticketId} to become ${expectedStatus}`);
}

async function waitForTerminalRuns(ticketId, expectedCount) {
  const started = Date.now();

  while (Date.now() - started < 180000) {
    const runs = readJson('runs.json').filter(run => run.ticketId === ticketId);

    if (runs.length >= expectedCount && runs.every(run => ['completed', 'failed'].includes(run.status))) {
      return runs;
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error(`Timed out waiting for ${expectedCount} allocated live runs for ticket ${ticketId}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertRunLogs(ticket, runs, receivedLogs) {
  const logs = readJson('logs.json').filter(log => log.ticketId === ticket.id);

  runs.forEach(run => {
    const runLogs = logs.filter(log => log.runId === run.id);
    const streamedLogs = receivedLogs.filter(log => log.runId === run.id);

    assert(runLogs.length > 0, `Missing persisted logs for run ${run.id}`);
    assert(streamedLogs.length > 0, `Missing SSE logs for run ${run.id}`);
    assert(runLogs.some(log => log.type === 'run:runtime'), `Missing runtime envelope log for run ${run.id}`);
    assert(runLogs.some(log => log.type === 'model:request'), `Missing model request log for run ${run.id}`);
    assert(runLogs.some(log => log.type === 'model:response'), `Missing model response log for run ${run.id}`);
    assert(runLogs.some(log => log.type === 'workspace:write'), `Missing workspace write log for run ${run.id}`);
    assert(run.executionWorkspaceType === 'main_owned_paths', `Allocated live run ${run.id} did not use owned path execution`);
    assert(run.mainWorkspaceRoot === WORKSPACE_ROOT, `Allocated live run ${run.id} has wrong main workspace root`);
    assert(Array.isArray(run.ownedOutputPaths) && run.ownedOutputPaths.length === 1, `Allocated live run ${run.id} missing owned output path`);
    assert(run.replaySnapshot && run.replaySnapshot.ownedOutputPaths[0] === run.ownedOutputPaths[0], `Allocated live replay missing owned output path for run ${run.id}`);
    assert(run.replaySnapshot.runtimeEnvelope.workspaceRoot === WORKSPACE_ROOT, `Allocated live runtime envelope did not point at main workspace for run ${run.id}`);
    assert(run.replaySnapshot.runtimeEnvelope.executionWorkspaceType === 'main_owned_paths', `Allocated live runtime envelope missing owned path type for run ${run.id}`);
    assert(runLogs.some(log =>
      log.type === 'workspace:write' &&
      log.workspaceAction &&
      log.workspaceAction.workspaceRoot === WORKSPACE_ROOT &&
      log.workspaceAction.executionWorkspaceType === 'main_owned_paths'
    ), `Allocated live workspace log did not identify owned path execution for run ${run.id}`);
    assert(runLogs.some(log => log.type === 'run:completed'), `Missing completion log for run ${run.id}`);
    assert(
      runLogs.every(log =>
        log.ticketId === run.ticketId &&
        log.agentId === run.agentId &&
        log.agentName === run.agentName
      ),
      `Incorrect run/ticket/agent log identity for run ${run.id}`
    );
    assert(
      streamedLogs.every(log =>
        log.ticketId === run.ticketId &&
        log.agentId === run.agentId &&
        log.agentName === run.agentName
      ),
      `Incorrect streamed run/ticket/agent identity for run ${run.id}`
    );
  });
}

function assertWorkspaceFiles(agents) {
  const runs = readJson('runs.json').filter(run => agents.some(agent => agent.id === run.agentId));

  agents.forEach(agent => {
    const run = runs.find(item => item.agentId === agent.id && item.status === 'completed');
    assert(run && run.ownedOutputPaths && run.ownedOutputPaths.length === 1, `Missing completed owned-path run for agent ${agent.id}`);
    const filePath = path.join(WORKSPACE_ROOT, run.ownedOutputPaths[0], `allocated-live-agent-${STAMP}-${agent.id}.txt`);
    const mainFilePath = path.join(WORKSPACE_ROOT, `allocated-live-agent-${STAMP}-${agent.id}.txt`);

    assert(fs.existsSync(filePath), `Expected owned output file missing for agent ${agent.id}`);
    assert(!fs.existsSync(mainFilePath), `Allocated live run wrote outside owned path for agent ${agent.id}`);
    assert(
      fs.readFileSync(filePath, 'utf8').trim() === `allocated-live-ok-${agent.id}`,
      `Unexpected owned output file content for agent ${agent.id}`
    );
  });
}

function assertAgentMetrics(agents) {
  const runs = readJson('runs.json');
  const logs = readJson('logs.json');

  agents.forEach(agent => {
    const agentRuns = runs.filter(run => run.agentId === agent.id);
    const completedRuns = agentRuns.filter(run => run.status === 'completed');
    const workspaceActions = logs.filter(log =>
      log.agentId === agent.id &&
      log.type &&
      log.type.startsWith('workspace:')
    );

    assert(completedRuns.length === 1, `Expected one completed run for agent ${agent.id}`);
    assert(workspaceActions.length > 0, `Expected workspace metrics source logs for agent ${agent.id}`);
  });
}

async function assertAgentsPage(cookie, agents) {
  const response = await request('GET', '/agents', { cookie });
  assert(response.statusCode === 200, `/agents returned HTTP ${response.statusCode}`);

  agents.forEach(agent => {
    assert(response.body.includes(agent.name), `/agents page missing ${agent.name}`);
  });
}

async function main() {
  requireLiveTestEnv();

  const backup = backupData();
  const group = seedAllocatedGroup();
  const receivedLogs = [];
  let server = null;
  let logStream = null;
  let agents = [];

  try {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT,
        WORKSPACE_ROOT,
        OPENAI_API_KEY: undefined
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    server.stdout.on('data', chunk => process.stdout.write(String(chunk).replace(/sk-[A-Za-z0-9_*\-]+/g, '[redacted-api-key]')));
    server.stderr.on('data', chunk => process.stderr.write(String(chunk).replace(/sk-[A-Za-z0-9_*\-]+/g, '[redacted-api-key]')));

    await waitForServer();
    const cookie = await login();
    logStream = openLogStream(cookie, receivedLogs);

    agents = [
      await createAgent(cookie, group.id, TEST_AGENT_NAMES[0]),
      await createAgent(cookie, group.id, TEST_AGENT_NAMES[1])
    ];

    const objective = [
      `Allocated live OpenAI test files ${STAMP}.`,
      `If runtimeEnvelope.assignedAgentId is ${agents[0].id}, create exactly one file named allocated-live-agent-${STAMP}-${agents[0].id}.txt inside runtimeEnvelope.ownedOutputPaths[0] with content exactly allocated-live-ok-${agents[0].id}.`,
      `If runtimeEnvelope.assignedAgentId is ${agents[1].id}, create exactly one file named allocated-live-agent-${STAMP}-${agents[1].id}.txt inside runtimeEnvelope.ownedOutputPaths[0] with content exactly allocated-live-ok-${agents[1].id}.`,
      'Return one writeFile workspace action, wait for its result, then complete.'
    ].join(' ');
    const ticket = await createAllocatedTicket(cookie, group.id, objective);

    await waitForTicketStatus(ticket.id, 'in_progress', 60000);
    const runs = await waitForTerminalRuns(ticket.id, 2);
    const ticketAfterRuns = readJson('tickets.json').find(item => item.id === ticket.id);

    assert(runs.length === 2, `Expected 2 allocated runs, found ${runs.length}`);
    assert(new Set(runs.map(run => run.agentId)).size === 2, 'Expected one independent run per agent');
    assert(new Set(runs.map(run => run.ticketOpenedAt)).size === 1, 'Allocated runs did not share one current batch marker');
    assert(runs.every(run => run.status === 'completed'), 'Expected both allocated live runs to complete');
    assert(ticketAfterRuns && ticketAfterRuns.status === 'completed', 'Allocated ticket did not aggregate to completed');

    assertRunLogs(ticket, runs, receivedLogs);
    assertWorkspaceFiles(agents);
    assertAgentMetrics(agents);
    await assertAgentsPage(cookie, agents);

    console.log(JSON.stringify({
      ticketId: ticket.id,
      ticketStatus: ticketAfterRuns.status,
      runIds: runs.map(run => run.id),
      agentIds: runs.map(run => run.agentId),
      streamedLogEvents: receivedLogs.filter(log => log.ticketId === ticket.id).length
    }));
  } finally {
    if (logStream) logStream.destroy();
    if (server) {
      server.kill('SIGTERM');
      await waitForExit(server);
    }
    restoreData(backup);
    removeTempWorkspaceRoot(WORKSPACE_ROOT);
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
