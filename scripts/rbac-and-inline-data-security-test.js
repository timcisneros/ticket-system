#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rbac-inline-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rbac-inline-workspace-'));
const PORT = process.env.PORT || '3593';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g';
const MALICIOUS_NAME = '</script><img src=x onerror=globalThis.__storedXss=1>';
const PROVIDER_SECRET = 'super-secret-provider-key';

function writeJson(name, value) {
  fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(value, null, 2));
}

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
}

function seedData() {
  writeJson('users.json', [
    { id: 1, username: 'admin', passwordHash: PASSWORD_HASH, type: 'user' },
    { id: 2, username: 'limited', passwordHash: PASSWORD_HASH, type: 'user' },
    { id: 3, username: 'process-manager', passwordHash: PASSWORD_HASH, type: 'user' }
  ]);
  writeJson('agents.json', [
    { id: 1, name: MALICIOUS_NAME, type: 'agent', provider: 'openai', model: 'test-model', apiKey: PROVIDER_SECRET }
  ]);
  writeJson('groups.json', [
    { id: 1, name: 'Administrators', permissions: [], canReceiveTickets: false },
    {
      id: 2,
      name: 'Limited account managers',
      permissions: ['user:create', 'user:read', 'user:update', 'group:create', 'group:update'],
      canReceiveTickets: false
    },
    { id: 3, name: 'Process managers', permissions: ['processTemplate:manage'], canReceiveTickets: false },
    { id: 4, name: 'Allocated agents', permissions: [], canReceiveTickets: true }
  ]);
  writeJson('memberships.json', [
    { id: 1, principalType: 'user', principalId: 1, groupId: 1 },
    { id: 2, principalType: 'user', principalId: 2, groupId: 2 },
    { id: 3, principalType: 'user', principalId: 3, groupId: 3 },
    { id: 4, principalType: 'agent', principalId: 1, groupId: 4 }
  ]);
  writeJson('permissions.json', JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'permissions.json'), 'utf8')));
  for (const file of ['tickets.json', 'runs.json', 'logs.json', 'workflows.json']) writeJson(file, []);
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), '');
}

function request(method, route, options = {}) {
  const body = options.form ? new URLSearchParams(options.form).toString() : null;
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${route}`, {
      method,
      headers: {
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(body ? {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body)
        } : {})
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
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

async function login(username) {
  const response = await request('POST', '/login', { form: { username, password: 'admin123' } });
  assert(response.status === 302, `${username} login failed with HTTP ${response.status}`);
  return cookieFrom(response);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForReady() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await request('GET', '/health');
      if (response.status === 200 && JSON.parse(response.body).ready) return;
    } catch (_) {
      // Server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for server readiness');
}

function waitForExit(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
  });
}

async function main() {
  seedData();
  let output = '';
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', PORT, DATA_DIR, WORKSPACE_ROOT },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', chunk => { output += String(chunk); });
  server.stderr.on('data', chunk => { output += String(chunk); });

  try {
    await waitForReady();
    const limitedCookie = await login('limited');
    const processCookie = await login('process-manager');
    const adminCookie = await login('admin');

    let response = await request('POST', '/admin/users', {
      cookie: limitedCookie,
      form: { accountType: 'user', username: 'escalated-user', password: 'temporary', groupIds: '1' }
    });
    assert(response.status === 403, `group membership escalation returned HTTP ${response.status}`);
    assert(!readJson('users.json').some(user => user.username === 'escalated-user'), 'denied account creation mutated users.json');

    response = await request('POST', '/admin/users', {
      cookie: limitedCookie,
      form: { accountType: 'user', username: 'unassigned-user', password: 'temporary' }
    });
    assert(response.status === 302, `ordinary unassigned account creation returned HTTP ${response.status}`);

    response = await request('POST', '/admin/groups', {
      cookie: limitedCookie,
      form: { name: 'Escalated group', permissions: 'user:delete' }
    });
    assert(response.status === 403, `permission grant escalation returned HTTP ${response.status}`);
    assert(!readJson('groups.json').some(group => group.name === 'Escalated group'), 'denied group creation mutated groups.json');

    response = await request('POST', '/admin/groups', {
      cookie: limitedCookie,
      form: { name: 'Empty group' }
    });
    assert(response.status === 302, `ordinary empty group creation returned HTTP ${response.status}`);

    response = await request('GET', '/admin/workflows', { cookie: limitedCookie });
    assert(response.status === 403, `workflow management inherited user:read permission (HTTP ${response.status})`);
    response = await request('GET', '/admin/workflows', { cookie: adminCookie });
    assert(response.status === 200, `administrator workflow management returned HTTP ${response.status}`);

    response = await request('GET', '/api/events', { cookie: limitedCookie });
    assert(response.status === 403, `SSE endpoint bypassed ticket:read permission (HTTP ${response.status})`);

    response = await request('GET', '/process-templates', { cookie: processCookie });
    assert(response.status === 200, `process template page returned HTTP ${response.status}`);
    assert(!response.body.includes(PROVIDER_SECRET), 'process template page leaked an agent provider key');
    assert(!response.body.includes(MALICIOUS_NAME), 'process template page embedded a raw script-closing agent name');
    assert(response.body.includes('\\u003c/script\\u003e\\u003cimg'), 'process template page did not script-escape the hostile agent name');
    assert(response.body.includes('option.textContent'), 'process template selector does not populate labels through textContent');

    response = await request('GET', '/', { cookie: adminCookie });
    assert(response.status === 200, `ticket creation page returned HTTP ${response.status}`);
    assert(!response.body.includes(MALICIOUS_NAME), 'ticket creation page embedded a raw hostile agent name');
    assert(response.body.includes('\\u003c/script\\u003e\\u003cimg'), 'ticket creation page did not script-escape the hostile agent name');
    assert(response.body.includes('ownedPathsContainer.replaceChildren()'), 'allocated-agent rows are not rebuilt through DOM APIs');
    assert(response.body.includes('agentName.textContent'), 'allocated-agent labels are not assigned through textContent');
    assert(!response.body.includes('ownedPathsContainer.innerHTML'), 'allocated-agent rows still use an HTML parsing sink');

    console.log('PASS: RBAC escalation paths, workflow authority, SSE reads, and inline agent data are constrained');
  } catch (error) {
    console.error(error.stack || error.message);
    console.error(output.slice(-2000));
    process.exitCode = 1;
  } finally {
    server.kill('SIGTERM');
    await Promise.race([waitForExit(server), new Promise(resolve => setTimeout(resolve, 3000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }
}

main();
