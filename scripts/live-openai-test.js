const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const WORKSPACE_ROOT = createTempWorkspaceRoot('live-openai');
const PORT = process.env.PORT || '3417';
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
const TEST_AGENT_NAME = `LiveOpenAITestAgent-${Date.now()}`;
const FAILING_TEST_AGENT_NAME = `LiveOpenAIFailingAgent-${Date.now()}`;
const TEST_FILE = `live-openai-test-${Date.now()}.txt`;

function requireLiveTestEnv() {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Live OpenAI tests require NODE_ENV=test');
  }

  if (process.env.ALLOW_LIVE_OPENAI_TESTS !== 'true') {
    throw new Error('Live OpenAI tests require ALLOW_LIVE_OPENAI_TESTS=true');
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Live OpenAI tests require OPENAI_API_KEY');
  }

  if (!process.env.OPENAI_MODEL) {
    throw new Error('Live OpenAI tests require OPENAI_MODEL');
  }
}

function readJson(file) {
  const filePath = path.join(DATA_DIR, file);
  let lastError = null;

  for (let attempt = 0; attempt < 20; attempt += 1) {
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

    await new Promise(resolve => setTimeout(resolve, 250));
  }

  throw new Error('Timed out waiting for local server');
}

function cookieFrom(response) {
  const setCookie = response.headers['set-cookie'] || [];
  return setCookie.map(cookie => cookie.split(';')[0]).join('; ');
}

async function login() {
  const response = await request('POST', '/login', {
    form: { username: 'admin', password: 'admin123' }
  });

  if (response.statusCode !== 302) {
    throw new Error('Admin login failed for live OpenAI test');
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

function ensureTicketGroup() {
  const groups = readJson('groups.json');
  let group = groups.find(item => item.canReceiveTickets === true);

  if (!group) {
    group = {
      id: groups.length > 0 ? Math.max(...groups.map(item => item.id)) + 1 : 1,
      name: 'Live OpenAI Test Group',
      permissions: [],
      canReceiveTickets: true
    };
    groups.push(group);
    writeJson('groups.json', groups);
  }

  return group;
}

async function createAgent(cookie, groupId, options = {}) {
  const agentName = options.name || TEST_AGENT_NAME;
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  const response = await request('POST', '/admin/users', {
    cookie,
    form: {
      accountType: 'agent',
      agentName,
      model: process.env.OPENAI_MODEL,
      apiKey,
      groupIds: String(groupId)
    }
  });

  if (response.statusCode !== 302) {
    throw new Error(`Agent create failed with HTTP ${response.statusCode}`);
  }

  const agent = readJson('agents.json').find(item => item.name === agentName);
  if (!agent) throw new Error('Created test agent was not persisted');
  if (agent.model !== process.env.OPENAI_MODEL) throw new Error('Test agent model was not persisted');

  return agent;
}

async function editAgent(cookie, agent, groupId) {
  const response = await request('POST', `/admin/users/${agent.id}`, {
    cookie,
    form: {
      accountType: 'agent',
      agentName: agent.name,
      model: process.env.OPENAI_MODEL,
      groupIds: String(groupId)
    }
  });

  if (response.statusCode !== 302) {
    throw new Error(`Agent edit failed with HTTP ${response.statusCode}`);
  }

  const editedAgent = readJson('agents.json').find(item => item.id === agent.id);
  if (!editedAgent) throw new Error('Edited test agent was not persisted');
  if (editedAgent.model !== process.env.OPENAI_MODEL) throw new Error('Edited test agent model was not persisted');
  if (!editedAgent.apiKey) throw new Error('Blank API key edit did not preserve the test agent key');

  return editedAgent;
}

async function createAssignedTicket(cookie, agent) {
  const objective = [
    `Create a file named ${TEST_FILE} in the workspace root.`,
    'The file content must be exactly: live-openai-test-ok',
    'Return JSON actions only and complete when the file is written.'
  ].join(' ');
  const response = await request('POST', '/tickets', {
    cookie,
    form: {
      objective,
      assignmentTargetType: 'agent',
      assignmentTargetId: String(agent.id)
    }
  });

  if (response.statusCode !== 302) {
    throw new Error(`Ticket create failed with HTTP ${response.statusCode}`);
  }

  const ticket = readJson('tickets.json').find(item => item.objective === objective);
  if (!ticket) throw new Error('Assigned test ticket was not persisted');

  return ticket;
}

async function createFailingAssignedTicket(cookie, agent) {
  const objective = `Attempt one live OpenAI request for failure logging test ${Date.now()}.`;
  const response = await request('POST', '/tickets', {
    cookie,
    form: {
      objective,
      assignmentTargetType: 'agent',
      assignmentTargetId: String(agent.id)
    }
  });

  if (response.statusCode !== 302) {
    throw new Error(`Failing ticket create failed with HTTP ${response.statusCode}`);
  }

  const ticket = readJson('tickets.json').find(item => item.objective === objective);
  if (!ticket) throw new Error('Assigned failing test ticket was not persisted');

  return ticket;
}

async function waitForRun(ticketId) {
  const started = Date.now();

  while (Date.now() - started < 120000) {
    const run = readJson('runs.json').find(item => item.ticketId === ticketId);

    if (run && ['completed', 'failed'].includes(run.status)) {
      return run;
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error('Timed out waiting for agent run to complete or fail');
}

function verifyRun(run, ticket, receivedLogs) {
  const logs = readJson('logs.json').filter(log => log.runId === run.id);
  const modelRequest = logs.find(log => log.type === 'model:request');
  const modelResponse = logs.find(log => log.type === 'model:response');
  const workspaceActions = logs.filter(log => log.type.startsWith('workspace:'));

  if (!modelRequest) throw new Error('Missing model:request log');
  if (!modelResponse) throw new Error('Missing model:response log');
  if (!modelRequest.message.includes(process.env.OPENAI_MODEL)) {
    throw new Error('Selected model was not used in the model request log');
  }
  if (!workspaceActions.some(log => ['workspace:create', 'workspace:write'].includes(log.type))) {
    throw new Error('No workspace create/write action was logged');
  }
  if (!workspaceActions.some(log => log.workspaceAction && log.workspaceAction.operation === 'writeFile')) {
    throw new Error('Workspace write did not log the strict writeFile primitive');
  }
  if (run.executionWorkspaceType !== 'main') {
    throw new Error('Single-agent live run should use the main workspace');
  }
  if (!run.replaySnapshot || run.replaySnapshot.runtimeEnvelope.workspaceRoot !== WORKSPACE_ROOT) {
    throw new Error('Single-agent live runtime envelope did not point at the main workspace');
  }
  if (!fs.existsSync(path.join(WORKSPACE_ROOT, TEST_FILE))) {
    throw new Error('Expected workspace file was not created');
  }
  if (receivedLogs.length === 0) {
    throw new Error('No live log events were received over SSE');
  }

  const ticketAfterRun = readJson('tickets.json').find(item => item.id === ticket.id);
  if (!ticketAfterRun || !['completed', 'failed'].includes(ticketAfterRun.status)) {
    throw new Error('Ticket status did not transition to a terminal run state');
  }

  if (modelResponse.usage) {
    console.log('Provider usage metadata persisted on model response log.');
  } else {
    console.log('Provider did not return usage metadata; none was estimated.');
  }

  if (run.status === 'failed') {
    const failedLog = logs.find(log => log.type === 'run:failed');
    if (!failedLog) throw new Error('Failed run did not produce a visible run:failed log');
  }
}

function verifyFailedRun(run) {
  if (run.status !== 'failed') {
    throw new Error('Expected deliberate invalid-key run to fail');
  }

  const logs = readJson('logs.json').filter(log => log.runId === run.id);
  if (!logs.some(log => log.type === 'run:failed')) {
    throw new Error('Deliberate failed run did not produce a visible run:failed log');
  }
}

async function main() {
  requireLiveTestEnv();

  const backup = backupData();
  const receivedLogs = [];
  let server = null;
  let logStream = null;

  try {
    ensureTicketGroup();
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

    const group = ensureTicketGroup();
    const createdAgent = await createAgent(cookie, group.id);
    const agent = await editAgent(cookie, createdAgent, group.id);
    const ticket = await createAssignedTicket(cookie, agent);
    const run = await waitForRun(ticket.id);

    verifyRun(run, ticket, receivedLogs);

    const failingAgent = await createAgent(cookie, group.id, {
      name: FAILING_TEST_AGENT_NAME,
      apiKey: 'invalid-live-openai-test-key'
    });
    const failingTicket = await createFailingAssignedTicket(cookie, failingAgent);
    const failingRun = await waitForRun(failingTicket.id);
    verifyFailedRun(failingRun);

    console.log(`Live OpenAI agent test finished with run status: ${run.status}`);
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
  console.error(error.message);
  process.exit(1);
});
