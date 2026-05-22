const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-provider-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('ollama-provider');
const PORT = process.env.PORT || '3438';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const STAMP = Date.now();
let workspaceRemoved = false;
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

for (const file of DATA_FILES) {
  const src = path.join(REAL_DATA_DIR, file);
  fs.writeFileSync(path.join(DATA_DIR, file), fs.existsSync(src) ? fs.readFileSync(src, 'utf8') : '[]');
}

function readJson(file) {
  const value = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  if (file !== 'runs.json' || !Array.isArray(value)) return value;
  return value.map(run => {
    if (run.replaySnapshot || !run.replaySnapshotPath) return run;
    if (!fs.existsSync(path.join(DATA_DIR, run.replaySnapshotPath))) return run;
    return { ...run, replaySnapshot: readJson(run.replaySnapshotPath) };
  });
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
      if (response.statusCode === 200 && JSON.parse(response.body).ready) return;
    } catch (error) {
      // Server is starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for server ready');
}

async function login() {
  const response = await request('POST', '/login', {
    form: { username: 'admin', password: 'admin123' }
  });
  assert(response.statusCode === 302, `Admin login failed with HTTP ${response.statusCode}`);
  return cookieFrom(response);
}

function seedOllamaAgent() {
  const agents = readJson('agents.json');
  const agent = {
    id: Math.max(0, ...agents.map(item => item.id || 0)) + 1,
    name: `OllamaProvider-${STAMP}`,
    type: 'agent',
    provider: 'ollama',
    model: 'llama-test',
    apiKey: '',
    createdAt: new Date().toISOString()
  };
  writeJson('agents.json', [...agents, agent]);
  return agent;
}

async function createTicket(cookie, agent, objective) {
  const response = await request('POST', '/tickets', {
    cookie,
    form: {
      objective,
      assignmentTargetType: 'agent',
      assignmentTargetId: String(agent.id),
      assignmentMode: 'individual'
    }
  });
  assert(response.statusCode === 302, `Ticket create failed with HTTP ${response.statusCode}: ${response.body}`);
  return readJson('tickets.json').find(ticket => ticket.objective === objective);
}

async function waitForRun(ticketId, status) {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    const run = readJson('runs.json').find(item => item.ticketId === ticketId);
    if (run && run.status === status && run.replaySnapshot && run.replaySnapshot.terminalStatus === status) return run;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ticket ${ticketId} run ${status}`);
}

function createFakeOllamaPreload() {
  const preloadPath = path.join(os.tmpdir(), `ollama-provider-${process.pid}-${Date.now()}.js`);
  const source = `
function ollamaResponse(content) {
  return {
    ok: true,
    status: 200,
    headers: new Map(),
    async text() {
      return JSON.stringify({
        model: 'llama-test',
        message: { role: 'assistant', content },
        prompt_eval_count: 3,
        eval_count: 4,
        total_duration: 7
      });
    }
  };
}

global.fetch = async function(url, options = {}) {
  if (!String(url).includes('/api/chat')) throw new Error('unexpected provider URL ' + url);
  const body = JSON.parse(options.body || '{}');
  const input = Array.isArray(body.messages) ? body.messages : [];
  const combined = input.map(item => item && item.content ? String(item.content) : '').join('\\n');

  if (combined.includes('ollama transport failure')) {
    throw new Error('fake ollama connection refused');
  }

  if (combined.includes('ollama malformed provider')) {
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      async text() { return '{not valid json'; }
    };
  }

  if (combined.includes('ollama too many mutations')) {
    return ollamaResponse(JSON.stringify({
      message: 'Too many writes.',
      actions: [
        { operation: 'writeFile', args: { path: 'ollama-too-many-a.txt', content: 'a' } },
        { operation: 'writeFile', args: { path: 'ollama-too-many-b.txt', content: 'b' } },
        { operation: 'writeFile', args: { path: 'ollama-too-many-c.txt', content: 'c' } }
      ],
      complete: false
    }));
  }

  return ollamaResponse(JSON.stringify({
    message: 'Ollama bounded write.',
    actions: [
      { operation: 'writeFile', args: { path: 'ollama-success.txt', content: 'ok' } }
    ],
    complete: true
  }));
};
`;
  fs.writeFileSync(preloadPath, source);
  return preloadPath;
}

async function main() {
  const agent = seedOllamaAgent();
  const preloadPath = createFakeOllamaPreload();
  const child = spawn(process.execPath, ['-r', preloadPath, path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT,
      DATA_DIR,
      WORKSPACE_ROOT,
      OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
      OLLAMA_MODEL: '',
      OPENAI_API_KEY: '',
      OPENAI_MODEL: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });

  try {
    await waitForReady();
    const cookie = await login();

    const successTicket = await createTicket(cookie, agent, `ollama success ${STAMP}`);
    const successRun = await waitForRun(successTicket.id, 'completed');
    assert(successRun.replaySnapshot.provider === 'ollama', 'Replay snapshot did not record Ollama provider');
    assert(successRun.replaySnapshot.model === 'llama-test', 'Replay snapshot did not record Ollama model');
    assert(successRun.replaySnapshot.providerRequests.length > 0, 'Ollama provider request was not recorded before execution');
    assert(successRun.replaySnapshot.providerRequests[0].url === 'http://127.0.0.1:11434/api/chat', 'Ollama request URL was not recorded');
    assert(successRun.replaySnapshot.modelResponses.length > 0, 'Ollama model response was not recorded');
    assert(successRun.replaySnapshot.modelResponses[0].provider === 'ollama', 'Model response did not keep provider');
    assert(successRun.replaySnapshot.modelResponses[0].providerResponsePayload.requestId === null, 'Ollama request id should be null when absent');
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'ollama-success.txt')), 'Ollama success run did not write expected file');

    const transportTicket = await createTicket(cookie, agent, `ollama transport failure ${STAMP}`);
    const transportRun = await waitForRun(transportTicket.id, 'failed');
    assert(transportRun.replaySnapshot.failure.code === 'OLLAMA_TRANSPORT_ERROR', 'Transport failure code was not structured');
    assert(transportRun.replaySnapshot.providerRequests.length > 0, 'Transport failure did not preserve provider request');
    assert(transportRun.replaySnapshot.modelResponses.length === 0, 'Transport failure should not record provider response');

    const malformedTicket = await createTicket(cookie, agent, `ollama malformed provider ${STAMP}`);
    const malformedRun = await waitForRun(malformedTicket.id, 'failed');
    assert(malformedRun.replaySnapshot.failure.code === 'OLLAMA_MALFORMED_RESPONSE', 'Malformed provider response code was not structured');
    assert(malformedRun.replaySnapshot.modelResponses.some(item =>
      item.providerResponsePayload && item.providerResponsePayload.body === '{not valid json'
    ), 'Malformed provider response body was not preserved');

    const tooManyTicket = await createTicket(cookie, agent, `ollama too many mutations ${STAMP}`);
    const tooManyRun = await waitForRun(tooManyTicket.id, 'failed');
    assert(tooManyRun.replaySnapshot.workspaceOperations.length === 0, 'Oversized Ollama mutation batch executed workspace operations');
    assert(tooManyRun.replaySnapshot.mutationCount === 0, 'Oversized Ollama mutation batch created mutations');
    assert(tooManyRun.replaySnapshot.events.filter(event => event.type === 'model:mutating_action_limit').length === 2, 'Ollama bounded transition violation was not recorded twice before early stop');

    const runPage = await request('GET', `/runs/${successRun.id}`, { cookie });
    assert(runPage.statusCode === 200, `Run detail failed with HTTP ${runPage.statusCode}`);
    assert(runPage.body.includes('Provider Requests'), 'Run detail missing provider requests section');
    assert(runPage.body.includes('ollama'), 'Run detail does not show Ollama provider data');

    console.log(JSON.stringify({
      ollamaProvider: true,
      successRun: successRun.id,
      transportFailure: transportRun.replaySnapshot.failure.code,
      malformedFailure: malformedRun.replaySnapshot.failure.code,
      boundedViolationMutations: tooManyRun.replaySnapshot.mutationCount
    }));
  } finally {
    child.kill();
    await waitForExit(child);
    removeTempWorkspaceRoot(WORKSPACE_ROOT);
    workspaceRemoved = true;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(preloadPath, { force: true });
    if (child.exitCode && child.exitCode !== 0) process.stderr.write(output);
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  if (!workspaceRemoved && fs.existsSync(WORKSPACE_ROOT)) removeTempWorkspaceRoot(WORKSPACE_ROOT);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(1);
});
