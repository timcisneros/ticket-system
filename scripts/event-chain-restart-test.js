#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { RUN_EVENT_SCHEMA_VERSION, computeRunEventHash } = require('../runtime/event-integrity');

const ROOT = path.resolve(__dirname, '..');
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g';

function writeJson(dataDir, name, value) {
  fs.writeFileSync(path.join(dataDir, name), JSON.stringify(value, null, 2));
}

function seedRestartFixture(dataDir) {
  const now = new Date().toISOString();
  writeJson(dataDir, 'users.json', [
    { id: 1, username: 'admin', passwordHash: PASSWORD_HASH, type: 'user', createdAt: now }
  ]);
  writeJson(dataDir, 'agents.json', [
    { id: 1, name: 'Restart Agent', type: 'agent', provider: 'ollama', model: 'test-model', apiKey: '', createdAt: now }
  ]);
  writeJson(dataDir, 'groups.json', [
    { id: 1, name: 'Administrators', permissions: [], canReceiveTickets: false }
  ]);
  writeJson(dataDir, 'memberships.json', [
    { id: 1, principalType: 'user', principalId: 1, groupId: 1 }
  ]);
  writeJson(dataDir, 'permissions.json', JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'permissions.json'), 'utf8')));
  writeJson(dataDir, 'tickets.json', [{
    id: 1,
    objective: 'Restart continuity fixture',
    status: 'in_progress',
    assignmentTargetType: 'agent',
    assignmentTargetId: 1,
    assignmentMode: 'individual',
    executionMode: 'agent',
    createdAt: now,
    updatedAt: now
  }]);
  writeJson(dataDir, 'runs.json', [{
    id: 1,
    ticketId: 1,
    agentId: 1,
    status: 'running',
    executionMode: 'agent',
    createdAt: now,
    updatedAt: now
  }]);
  for (const file of ['logs.json', 'workflows.json']) writeJson(dataDir, file, []);

  const event = {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    id: crypto.randomUUID(),
    ts: now,
    type: 'run.created',
    ticketId: 1,
    runId: 1,
    stepId: null,
    payload: { status: 'pending', agentId: 1 },
    seq: 0,
    prevHash: null
  };
  event.hash = computeRunEventHash(event);
  fs.writeFileSync(path.join(dataDir, 'events.jsonl'), `${JSON.stringify(event)}\n`);
  return event;
}

function request(port, route) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${route}`, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
  });
}

async function waitForReady(port) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await request(port, '/health');
      if (response.status === 200 && JSON.parse(response.body).ready) return;
    } catch (_) {
      // Server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for restarted server');
}

function waitForExit(child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Server did not shut down within the graceful-drain timeout'));
    }, timeoutMs);
    child.once('exit', code => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function verifyContinuousSealedChain(events) {
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    assert(event.seq === index, `event ${index} has seq ${event.seq}`);
    const expectedPrevHash = index === 0 ? null : events[index - 1].hash;
    assert(event.prevHash === expectedPrevHash, `event ${index} has a broken prevHash`);
    assert(event.schemaVersion === RUN_EVENT_SCHEMA_VERSION, `event ${index} has the wrong schema version`);
    assert(event.hash === computeRunEventHash(event), `event ${index} has an invalid stored hash`);
  }
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-restart-data-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'event-restart-workspace-'));
  const port = process.env.PORT || '3597';
  const initialEvent = seedRestartFixture(dataDir);
  let output = '';
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: port,
      DATA_DIR: dataDir,
      WORKSPACE_ROOT: workspaceRoot,
      OLLAMA_BASE_URL: 'http://127.0.0.1:1',
      OLLAMA_MODEL: 'test-model',
      AGENT_MAX_RUNTIME_DURATION_MS: '1000',
      RUNTIME_SCHEDULER_INTERVAL_MS: '60000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', chunk => { output += String(chunk); });
  server.stderr.on('data', chunk => { output += String(chunk); });

  try {
    await waitForReady(port);
    server.kill('SIGTERM');
    const exitCode = await waitForExit(server);
    assert(exitCode === 143, `graceful SIGTERM exit code was ${exitCode}; output=${output.slice(-1000)}`);
    assert(!fs.existsSync(path.join(dataDir, 'writer-lock.json')), 'writer lock remained after graceful shutdown');

    const events = fs.readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse)
      .filter(event => event.runId === 1);
    assert(events.length >= 2, `restart did not persist a continuation event; saw ${events.length}`);
    verifyContinuousSealedChain(events);
    const resumed = events.find(event => event.type === 'run.resumed');
    assert(resumed && resumed.seq === 1, 'run.resumed did not continue at seq 1');
    assert(resumed.prevHash === initialEvent.hash, 'run.resumed did not link to the prior process hash');
    console.log(`PASS: restart restored and gracefully drained a continuous ${events.length}-event sealed run chain`);
  } catch (error) {
    console.error(error.stack || error.message);
    console.error(output.slice(-2000));
    process.exitCode = 1;
    if (server.exitCode === null) server.kill('SIGKILL');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

main();
