#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PRELOAD = path.join(__dirname, 'fixtures', 'event-journal-sync-control.js');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-recovery-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-recovery-ws-'));
const CONTROL_FILE = path.join(DATA_DIR, '.sync-control');
const PORT = process.env.PORT || '3597';
const BASE = `http://127.0.0.1:${PORT}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function request(method, route, options = {}) {
  const body = options.form ? new URLSearchParams(options.form).toString() : null;
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${route}`, {
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
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (_) {}
        resolve({ status: response.statusCode, headers: response.headers, body: raw, json });
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

function ticketForm(objective) {
  return {
    objective,
    assignmentTargetType: 'agent',
    assignmentTargetId: '1',
    assignmentMode: 'individual',
    capabilityType: 'directAction',
    executionMode: 'agent'
  };
}

async function waitForHealth(predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await request('GET', '/health');
      if (predicate(response)) return response;
    } catch (_) {
      // Server may still be starting.
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function waitForExit(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
  });
}

async function main() {
  const server = spawn(process.execPath, ['--require', PRELOAD, 'server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT,
      DATA_DIR,
      WORKSPACE_ROOT,
      EVENT_JOURNAL_SYNC_CONTROL_FILE: CONTROL_FILE,
      EVENT_JOURNAL_MAX_OUTSTANDING_ENTRIES: '1',
      RUNTIME_SCHEDULER_INTERVAL_MS: '3600000',
      PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS: '3600000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  server.stdout.on('data', chunk => { output += String(chunk); });
  server.stderr.on('data', chunk => { output += String(chunk); });

  try {
    await waitForHealth(response => response.status === 200 && response.json && response.json.ready, 'server readiness');
    const login = await request('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
    assert(login.status === 302, `admin login returned HTTP ${login.status}`);
    const cookie = cookieFrom(login);

    fs.writeFileSync(CONTROL_FILE, 'hold');
    const competing = [
      {
        objective: 'concurrent admission candidate one',
        promise: request('POST', '/tickets', {
          cookie,
          form: ticketForm('concurrent admission candidate one')
        })
      },
      {
        objective: 'concurrent admission candidate two',
        promise: request('POST', '/tickets', {
          cookie,
          form: ticketForm('concurrent admission candidate two')
        })
      }
    ];
    const firstCompleted = await Promise.race(competing.map((candidate, index) => {
      return candidate.promise.then(response => ({ index, response }));
    }));
    assert(firstCompleted.response.status === 503, 'simultaneous mutation admission was not refused before side effects');
    assert(firstCompleted.response.json && firstCompleted.response.json.code === 'EVENT_ADMISSION_BACKPRESSURED', 'simultaneous refusal lacked admission code');
    const refusedObjective = competing[firstCompleted.index].objective;
    const acceptedCandidate = competing[firstCompleted.index === 0 ? 1 : 0];

    const pressuredHealth = await waitForHealth(
      response => response.status === 503 && response.json && response.json.status === 'backpressured',
      'recoverable journal backpressure'
    );
    assert(pressuredHealth.json.ready === false, 'backpressured health did not close mutation admission');

    const diagnostics = await request('GET', '/api/runtime/status', { cookie });
    assert(diagnostics.status === 200, `read-only diagnostics returned HTTP ${diagnostics.status} during pressure`);
    assert(
      diagnostics.json && diagnostics.json.eventJournal && diagnostics.json.eventJournal.current.backpressured === true,
      'runtime diagnostics did not expose recoverable pressure'
    );
    assert(
      diagnostics.json.eventJournal.current.admittedProducers === 1 &&
      diagnostics.json.eventJournal.config.maxAdmittedProducers === 1,
      'diagnostics did not expose the bounded producer reservation'
    );

    const loginDuringPressure = await request('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
    assert(loginDuringPressure.status === 302, 'session login was incorrectly classified as journal-dependent mutation work');

    const refused = await request('POST', '/tickets', {
      cookie,
      form: ticketForm('must be refused while backpressured')
    });
    assert(refused.status === 503, `new mutation admission returned HTTP ${refused.status} during pressure`);
    assert(refused.json && refused.json.code === 'EVENT_ADMISSION_BACKPRESSURED', 'pressure refusal lacked a recoverable error code');
    assert(refused.headers['retry-after'] === '1', 'pressure refusal omitted Retry-After');

    fs.unlinkSync(CONTROL_FILE);
    const acceptedResponse = await acceptedCandidate.promise;
    assert(acceptedResponse.status === 302, `already accepted ticket returned HTTP ${acceptedResponse.status} after drain`);
    await waitForHealth(response => response.status === 200 && response.json && response.json.ready, 'automatic admission recovery');

    const afterRecovery = await request('POST', '/tickets', {
      cookie,
      form: ticketForm('accepted after journal recovery')
    });
    assert(afterRecovery.status === 302, `mutation admission did not resume after drain (HTTP ${afterRecovery.status})`);

    const tickets = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tickets.json'), 'utf8'));
    assert(tickets.some(ticket => ticket.objective === acceptedCandidate.objective), 'accepted concurrent work was lost');
    assert(tickets.some(ticket => ticket.objective === 'accepted after journal recovery'), 'post-recovery work was not persisted');
    assert(!tickets.some(ticket => ticket.objective === refusedObjective), 'simultaneously refused mutation changed ticket state');
    assert(!tickets.some(ticket => ticket.objective === 'must be refused while backpressured'), 'refused mutation changed ticket state');
    const events = fs.readFileSync(path.join(DATA_DIR, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    const createdTicketIds = new Set(events.filter(event => event.type === 'ticket.created').map(event => event.ticketId));
    const expectedTicketIds = tickets
      .filter(ticket => ticket.objective === acceptedCandidate.objective || ticket.objective === 'accepted after journal recovery')
      .map(ticket => ticket.id);
    assert(expectedTicketIds.every(id => createdTicketIds.has(id)), 'accepted ticket evidence was dropped during backpressure');

    fs.writeFileSync(CONTROL_FILE, 'fail');
    const fatalResponse = await request('POST', '/tickets', {
      cookie,
      form: ticketForm('sync failure must fail closed')
    });
    assert(fatalResponse.status >= 500, `injected sync failure returned HTTP ${fatalResponse.status}`);
    const fatalHealth = await waitForHealth(
      response => response.status === 503 && response.json && response.json.status === 'degraded',
      'fatal journal failure state'
    );
    assert(fatalHealth.json.ready === false, 'fatal journal failure did not disable mutation readiness');

    const refusedAfterFatal = await request('POST', '/tickets', {
      cookie,
      form: ticketForm('must stay refused after fatal failure')
    });
    assert(refusedAfterFatal.status === 503, `fatal failure did not latch mutation shutdown (HTTP ${refusedAfterFatal.status})`);
    assert(refusedAfterFatal.json && refusedAfterFatal.json.code === 'EVENT_PERSISTENCE_UNAVAILABLE', 'fatal refusal lacked persistence failure code');
    const fatalDiagnostics = await request('GET', '/api/runtime/status', { cookie });
    assert(fatalDiagnostics.status === 200, 'fatal failure disabled read-only diagnostics');
    assert(fatalDiagnostics.json.eventJournal.status === 'failed', 'fatal journal state was not exposed to diagnostics');
    const loginAfterFatal = await request('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
    assert(loginAfterFatal.status === 302, 'fatal journal failure incorrectly disabled session login');

    console.log('PASS: journal pressure rejects new mutations, preserves evidence, auto-recovers, and sync failure remains fail-closed');
  } catch (error) {
    console.error(error.stack || error.message);
    console.error(output.slice(-4000));
    process.exitCode = 1;
  } finally {
    if (fs.existsSync(CONTROL_FILE)) fs.unlinkSync(CONTROL_FILE);
    server.kill('SIGTERM');
    await Promise.race([waitForExit(server), new Promise(resolve => setTimeout(resolve, 3000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }
}

main();
