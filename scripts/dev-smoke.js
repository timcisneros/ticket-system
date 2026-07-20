#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const { promptHidden, safeErrorMessage } = require('./dev-environment');

const DEFAULT_URL = 'http://127.0.0.1:3099';
const SMOKE_OBJECTIVE = 'Ensure folder onboarding-smoke exists';
const SMOKE_FOLDER = 'onboarding-smoke';

function parseArgs(argv) {
  const options = { url: DEFAULT_URL, agent: null, timeoutMs: 300_000, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--help') {
      options.help = true;
      continue;
    }
    if (argument === '--password' || argument.startsWith('--password=')) {
      throw new Error('Passwords cannot be passed on the command line; use the secure prompt or DEV_SMOKE_PASSWORD');
    }
    if (['--url', '--agent', '--timeout-ms'].includes(argument)) {
      const value = String(argv[index + 1] || '').trim();
      if (!value) throw new Error(argument + ' requires a value');
      options[argument === '--timeout-ms' ? 'timeoutMs' : argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error('Unknown argument: ' + argument);
  }
  options.timeoutMs = Number(options.timeoutMs);
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 900_000) {
    throw new Error('--timeout-ms must be an integer between 1000 and 900000');
  }
  return options;
}

function httpRequest(method, target, { headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const client = url.protocol === 'https:' ? https : http;
    const requestHeaders = { ...headers };
    if (body) requestHeaders['Content-Length'] = Buffer.byteLength(body);
    const request = client.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: requestHeaders,
      timeout: 10_000
    }, response => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { responseBody += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: responseBody
      }));
    });
    request.on('timeout', () => request.destroy(new Error('HTTP request timed out')));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function parseJson(response, label) {
  try {
    return JSON.parse(response.body);
  } catch (_) {
    throw new Error(label + ' returned invalid JSON (HTTP ' + response.status + ')');
  }
}

function cookieFrom(response) {
  const values = response.headers && response.headers['set-cookie'];
  const first = Array.isArray(values) ? values[0] : values;
  const match = String(first || '').match(/(?:^|;)\s*sessionId=([^;]+)/);
  return match ? match[1] : null;
}

async function waitForTicketAndRun({
  request,
  url,
  cookie,
  afterTicketId,
  timeoutMs,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
}) {
  const deadline = Date.now() + timeoutMs;
  let ticket = null;
  let run = null;
  while (Date.now() < deadline) {
    if (!ticket) {
      const list = await request('GET', url + '/api/tickets', {
        headers: { Cookie: 'sessionId=' + cookie }
      });
      if (list.status !== 200) throw new Error('Ticket lookup failed (HTTP ' + list.status + ')');
      const data = parseJson(list, 'Ticket lookup');
      const tickets = Array.isArray(data.tickets) ? data.tickets : Array.isArray(data) ? data : [];
      ticket = tickets
        .filter(item => item.id > afterTicketId && item.objective === SMOKE_OBJECTIVE)
        .sort((left, right) => right.id - left.id)[0] || null;
    }
    if (ticket) {
      const runtime = await request('GET', url + '/api/tickets/' + ticket.id + '/runtime', {
        headers: { Cookie: 'sessionId=' + cookie }
      });
      if (runtime.status !== 200) throw new Error('Runtime lookup failed (HTTP ' + runtime.status + ')');
      const data = parseJson(runtime, 'Runtime lookup');
      ticket = data.ticket || ticket;
      run = data.latestRun || data.currentRun || null;
      if (run && ['completed', 'failed', 'interrupted', 'resumable_pending'].includes(run.status)) {
        return { ticket, run };
      }
    }
    await sleep(1_000);
  }
  throw new Error('Smoke ticket did not reach a terminal run within ' + timeoutMs + 'ms');
}

async function runSmoke({
  options,
  env = process.env,
  request = httpRequest,
  passwordPrompt = promptHidden,
  output = process.stdout,
  sleep
}) {
  const health = await request('GET', options.url + '/health');
  if (health.status !== 200) throw new Error('Server health check failed (HTTP ' + health.status + ')');
  const healthData = parseJson(health, 'Health check');
  if (healthData.ready !== true) throw new Error('Server is not ready');

  const username = String(env.DEV_SMOKE_USERNAME || env.OPERC_USERNAME || 'admin').trim();
  const password = String(env.DEV_SMOKE_PASSWORD || env.OPERC_PASSWORD || '') ||
    await passwordPrompt('Admin password');
  const loginBody = new URLSearchParams({ username, password }).toString();
  const login = await request('POST', options.url + '/login', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: loginBody
  });
  if (login.status !== 302) throw new Error('Login failed (HTTP ' + login.status + ')');
  const cookie = cookieFrom(login);
  if (!cookie) throw new Error('Login succeeded without a session cookie');

  const requestedAgent = options.agent || env.DEV_AGENT_NAME || '1';
  const resolution = await request('GET',
    options.url + '/api/configured-agents/resolve?value=' + encodeURIComponent(requestedAgent), {
      headers: { Cookie: 'sessionId=' + cookie }
    });
  if (resolution.status !== 200) throw new Error('Configured agent not found: ' + requestedAgent);
  const agent = parseJson(resolution, 'Agent resolution').agent;
  if (!agent || !agent.id) throw new Error('Agent resolution returned no agent');

  const before = await request('GET', options.url + '/api/tickets', {
    headers: { Cookie: 'sessionId=' + cookie }
  });
  if (before.status !== 200) throw new Error('Initial ticket lookup failed (HTTP ' + before.status + ')');
  const beforeData = parseJson(before, 'Initial ticket lookup');
  const beforeTickets = Array.isArray(beforeData.tickets) ? beforeData.tickets : Array.isArray(beforeData) ? beforeData : [];
  const afterTicketId = beforeTickets.reduce((maximum, ticket) => Math.max(maximum, Number(ticket.id) || 0), 0);

  const ticketBody = new URLSearchParams({
    objective: SMOKE_OBJECTIVE,
    assignmentTargetType: 'agent',
    assignmentTargetId: String(agent.id),
    assignmentMode: 'individual'
  }).toString();
  const create = await request('POST', options.url + '/tickets', {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: 'sessionId=' + cookie
    },
    body: ticketBody
  });
  if (create.status !== 302) throw new Error('Smoke ticket creation failed (HTTP ' + create.status + ')');

  const result = await waitForTicketAndRun({
    request,
    url: options.url,
    cookie,
    afterTicketId,
    timeoutMs: options.timeoutMs,
    sleep
  });
  if (result.run.status !== 'completed' || result.ticket.status !== 'completed') {
    throw new Error(
      'Smoke run did not complete: ticket #' + result.ticket.id + ' ' + result.ticket.status +
      ', run #' + result.run.id + ' ' + result.run.status +
      '. Inspect with pnpm codex:trace -- --run ' + result.run.id
    );
  }

  const workspace = await request('GET',
    options.url + '/api/workspace/list?path=' + encodeURIComponent(SMOKE_FOLDER), {
      headers: { Cookie: 'sessionId=' + cookie }
    });
  if (workspace.status !== 200) {
    throw new Error('Smoke target verification failed for ' + SMOKE_FOLDER + ' (HTTP ' + workspace.status + ')');
  }

  output.write(
    'PASS: ticket #' + result.ticket.id + ', run #' + result.run.id + ', agent "' +
    agent.name + '", and workspace folder ' + SMOKE_FOLDER + ' verified\n'
  );
  return { ...result, agent, workspaceVerified: true };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: pnpm dev:smoke [--agent <id|name>] [--url <url>] [--timeout-ms <ms>]\n\nCreates one bounded ensure-folder ticket, waits for completion, and verifies the workspace target.');
    return;
  }
  await runSmoke({ options });
}

module.exports = {
  DEFAULT_URL,
  SMOKE_FOLDER,
  SMOKE_OBJECTIVE,
  cookieFrom,
  httpRequest,
  parseArgs,
  runSmoke,
  waitForTicketAndRun
};

if (require.main === module) {
  main().catch(error => {
    console.error('Development smoke failed: ' + safeErrorMessage(error));
    process.exit(1);
  });
}
