#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { verifyCurrentRunEventChain } = require('../runtime/event-integrity');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-record-limit-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-record-limit-ws-'));
const PORT = process.env.PORT || '3598';
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

async function waitForReady() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await request('GET', '/health');
      if (response.status === 200 && response.json && response.json.ready) return;
    } catch (_) {
      // Server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
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
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT,
      DATA_DIR,
      WORKSPACE_ROOT,
      EVENT_JOURNAL_MAX_RECORD_BYTES: '1024',
      SHUTDOWN_RUN_DRAIN_TIMEOUT_MS: '2500',
      RUNTIME_SCHEDULER_INTERVAL_MS: '3600000',
      PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS: '3600000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  server.stdout.on('data', chunk => { output += String(chunk); });
  server.stderr.on('data', chunk => { output += String(chunk); });

  try {
    await waitForReady();
    const login = await request('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
    assert(login.status === 302, `admin login returned HTTP ${login.status}`);
    const cookie = cookieFrom(login);

    const rejected = await request('POST', '/tickets', {
      cookie,
      form: ticketForm('record-limit rejection must remain request scoped')
    });
    assert(rejected.status === 413, `oversized runtime event returned HTTP ${rejected.status}`);
    assert(rejected.json && rejected.json.code === 'EVENT_RECORD_TOO_LARGE', 'oversized runtime event lacked a request-scoped code');

    const health = await request('GET', '/health');
    assert(health.status === 200 && health.json && health.json.ready === true, 'oversized record disabled the process');
    const runtimeStatus = await request('GET', '/api/runtime/status', { cookie });
    assert(runtimeStatus.status === 200, 'oversized record disabled runtime diagnostics');
    assert(
      runtimeStatus.json.shutdown && runtimeStatus.json.shutdown.activeRunDrainTimeoutMs === 2500,
      'runtime diagnostics omitted the effective shutdown run-drain grace period'
    );
    assert(runtimeStatus.json.eventJournal.totals.oversizedRejections === 1, 'oversized rejection was omitted from journal metrics');

    const tickets = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tickets.json'), 'utf8'));
    const runs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'runs.json'), 'utf8'));
    assert(tickets.length === 1 && tickets[0].status === 'failed', 'record-rejected ticket was left executable');
    assert(runs.length === 1 && runs[0].status === 'failed', 'record-rejected run was left pending or executable');
    assert(/journal record limit/.test(runs[0].error || ''), 'failed run omitted the record-limit reason');
    assert(runs[0].runEvaluation && runs[0].runEvaluation.effectiveness.status === 'failed', 'failed run omitted terminal evaluation evidence');
    assert(runs[0].runConsequence && Array.isArray(runs[0].runConsequence.mutations), 'failed run omitted terminal consequence evidence');

    const events = fs.readFileSync(path.join(DATA_DIR, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    const rejection = events.find(event => event.type === 'event.record_rejected' && event.runId === runs[0].id);
    assert(rejection, 'oversized run event did not leave compact durable rejection evidence');
    assert(rejection.payload.requestedType === 'run.created', 'rejection evidence omitted the requested event type');
    assert(rejection.payload.requestedRecordBytes > rejection.payload.maxRecordBytes, 'rejection evidence omitted the enforced size boundary');
    assert(rejection.payload.outcome === 'rejected', 'rejection evidence did not describe the event outcome');
    assert(events.some(event => event.type === 'run.terminalized' && event.runId === runs[0].id), 'failed run omitted terminal lifecycle evidence');
    const evaluationEvent = events.find(event => event.type === 'run.evaluation_completed' && event.runId === runs[0].id);
    const consequenceEvent = events.find(event => event.type === 'run.consequence_recorded' && event.runId === runs[0].id);
    assert(evaluationEvent && JSON.stringify(evaluationEvent.payload.evaluation) === JSON.stringify(runs[0].runEvaluation), 'failed run evaluation event did not preserve the persisted evaluation');
    assert(consequenceEvent && JSON.stringify(consequenceEvent.payload.consequence) === JSON.stringify(runs[0].runConsequence), 'failed run consequence event did not preserve the persisted consequence');
    const runEventTypes = events.filter(event => event.runId === runs[0].id).map(event => event.type);
    assert(runEventTypes.indexOf('run.evaluation_completed') < runEventTypes.indexOf('run.consequence_recorded'), 'rejected run consequence preceded evaluation');
    assert(runEventTypes.indexOf('run.consequence_recorded') < runEventTypes.indexOf('run.terminalized'), 'rejected run terminalized before reconciliation evidence');
    assert(verifyCurrentRunEventChain(events.filter(event => event.runId === runs[0].id)).chainValid, 'compact rejection broke the run event chain');

    const rejectedAgain = await request('POST', '/tickets', {
      cookie,
      form: ticketForm('a second request proves mutation admission was not latched')
    });
    assert(rejectedAgain.status === 413, `process-wide failure was latched after a request-scoped rejection (HTTP ${rejectedAgain.status})`);
    assert((await request('GET', '/health')).status === 200, 'process degraded after repeated request-scoped rejections');

    console.log('PASS: oversized events fail only the affected request/run, preserve compact chain evidence, and keep the process ready');
  } catch (error) {
    console.error(error.stack || error.message);
    console.error(output.slice(-4000));
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
