const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-shaping-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('ticket-shaping');
const PORT = process.env.PORT || '3437';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const STAMP = Date.now();
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

function seedAgent() {
  const agents = readJson('agents.json');
  const agent = {
    id: Math.max(0, ...agents.map(item => item.id || 0)) + 1,
    name: `TicketShaper-${STAMP}`,
    type: 'agent',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    apiKey: 'test-key-ticket-shaper',
    createdAt: new Date().toISOString()
  };
  writeJson('agents.json', [...agents, agent]);
  return agent;
}

function createFakeOpenAIPreload() {
  const preloadPath = path.join(os.tmpdir(), `ticket-shaping-openai-${process.pid}-${Date.now()}.js`);
  const source = `
global.fetch = async function(url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const input = Array.isArray(body.input) ? body.input : [];
  const combined = input.map(item => item && item.content ? String(item.content) : '').join('\\n');
  if (!combined.includes('improve everything')) throw new Error('unexpected ticket shaping prompt');
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'fake-ticket-shaping']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify({
          suggestedObjective: 'Create docs/setup.md with install and test steps for the current project.',
          expectedOutputs: ['docs/setup.md'],
          decomposition: ['Create docs/usage.md as a separate ticket if usage guidance is needed.'],
          warnings: ['The original objective is vague and too broad.'],
          tooBroadForOneRun: true,
          groupModeFit: 'Use a group only if each agent owns a separate existing folder and output file.'
        }),
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 }
      });
    }
  };
};
`;
  fs.writeFileSync(preloadPath, source);
  return preloadPath;
}

async function main() {
  const agent = seedAgent();
  const preloadPath = createFakeOpenAIPreload();
  const child = spawn(process.execPath, ['-r', preloadPath, path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT,
      DATA_DIR,
      WORKSPACE_ROOT,
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
    const beforeTickets = readJson('tickets.json').length;

    const page = await request('GET', '/', { cookie });
    assert(page.statusCode === 200, `GET / failed with HTTP ${page.statusCode}`);
    assert(page.body.includes('Suggest bounded version'), 'Ticket form missing shaping button');
    assert(page.body.includes('Nothing changes unless you accept'), 'Ticket shaping explicit-accept copy missing');

    const response = await request('POST', '/api/tickets/shape-objective', {
      cookie,
      body: {
        objective: 'improve everything',
        assignmentTargetType: 'agent',
        assignmentTargetId: agent.id,
        assignmentMode: 'individual'
      }
    });
    assert(response.statusCode === 200, `Ticket shaping failed with HTTP ${response.statusCode}: ${response.body}`);
    const payload = JSON.parse(response.body);
    assert(payload.suggestedObjective.includes('docs/setup.md'), 'Suggested objective missing concrete output');
    assert(payload.tooBroadForOneRun === true, 'Broad objective was not flagged');
    assert(payload.expectedOutputs.includes('docs/setup.md'), 'Expected outputs missing docs/setup.md');
    assert(payload.decomposition.length === 1, 'Decomposition suggestion missing');
    assert(payload.providerRequestId === 'fake-ticket-shaping', 'Provider request id was not preserved');
    assert(readJson('tickets.json').length === beforeTickets, 'Ticket shaping created or mutated tickets');

    console.log(JSON.stringify({
      ticketShaping: true,
      suggestedObjective: payload.suggestedObjective,
      ticketsUnchanged: true
    }));
  } finally {
    child.kill();
    await waitForExit(child);
    removeTempWorkspaceRoot(WORKSPACE_ROOT);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(preloadPath, { force: true });
    if (child.exitCode && child.exitCode !== 0) {
      process.stderr.write(output);
    }
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  removeTempWorkspaceRoot(WORKSPACE_ROOT);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(1);
});
