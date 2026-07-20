#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');
const { currentRuntimeLimitsSnapshot } = require('./current-run-fixture');

const ROOT = path.resolve(__dirname, '..');
const DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!DATABASE_URL) {
  console.error('TEST_DATABASE_URL is required for the PostgreSQL page-render regression test');
  process.exit(1);
}

const SCHEMA = `page_render_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
const WORKSPACE_ROOT = createTempWorkspaceRoot('page-render-postgres');
const PORT = process.env.PAGE_RENDER_TEST_PORT || String(3400 + (process.pid % 1000));
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SESSION_SECRET = 'page-render-regression-session-secret-0123456789abcdef0123456789abcdef';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function request(method, urlPath, options = {}) {
  const body = options.body === undefined ? null : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${urlPath}`, {
      method,
      headers: {
        ...(body === null ? {} : {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Origin: BASE_URL
        }),
        ...(options.form ? {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(options.form),
          Origin: BASE_URL
        } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    if (options.form) req.write(options.form);
    else if (body !== null) req.write(body);
    req.end();
  });
}

function cookieFrom(response) {
  return (response.headers['set-cookie'] || []).map(value => value.split(';')[0]).join('; ');
}

function waitForExit(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once('exit', resolve));
}

async function waitForReady() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    try {
      const response = await request('GET', '/health');
      if (response.statusCode === 200 && JSON.parse(response.body).ready === true) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for PostgreSQL page-render server readiness');
}

async function login() {
  const form = new URLSearchParams({ username: 'admin', password: 'admin123' }).toString();
  const response = await request('POST', '/login', { form });
  assert(response.statusCode === 302, `Admin login returned HTTP ${response.statusCode}`);
  const cookie = cookieFrom(response);
  assert(cookie, 'Admin login did not return a session cookie');
  return cookie;
}

async function assertPage(cookie, urlPath, expectedText) {
  const response = await request('GET', urlPath, { cookie });
  assert(response.statusCode === 200,
    `${urlPath} returned HTTP ${response.statusCode}: ${response.body.slice(0, 240)}`);
  if (expectedText) assert(response.body.includes(expectedText), `${urlPath} did not render ${expectedText}`);
  return response;
}

function executionPolicy() {
  return {
    mode: 'assisted',
    requireVerification: 'when_declared',
    autoRetry: false,
    maxAttempts: null,
    maxRuntimeMs: null,
    maxModelRequests: null,
    maxWorkspaceOperations: null,
    allowWorkspaceWrites: true,
    allowParallelRuns: false,
    allowChildTickets: false,
    workspaceScope: 'shared'
  };
}

async function seedCurrentFormatFixture(store) {
  const agentResult = await store.createConfiguredAgent({
    value: {
      name: 'Page Render Agent',
      provider: 'ollama',
      model: 'page-render-model',
      apiKey: ''
    },
    groupIds: [],
    changedBy: 'page-render-test'
  });
  const contextResult = await store.createWorkContext({
    value: {
      name: 'PostgreSQL Page Render Context',
      purpose: 'Verify server-rendered pages against current PostgreSQL authority.',
      status: 'active',
      allowedTargetIds: [],
      allowedCapabilities: [],
      allowedProcessTemplateIds: []
    },
    changedBy: 'page-render-test'
  });
  const context = contextResult.workContext;
  await store.createBrowserTarget({
    target: {
      id: 'page-render-browser',
      name: 'PostgreSQL Page Render Browser',
      status: 'active',
      allowedOrigins: ['https://example.com'],
      startUrl: 'https://example.com',
      limits: {
        maxNavigationsPerRun: 2,
        maxActionsPerRun: 4,
        navTimeoutMs: 10_000,
        waitTimeoutMsCap: 1_000,
        maxPageTextBytes: 4_096,
        maxScreenshotsPerRun: 1
      }
    },
    changedBy: 'page-render-test'
  });
  const now = new Date().toISOString();
  const ticketResult = await store.createTicketWithEvent({
    ticket: {
      objective: 'PostgreSQL page render ticket',
      acceptanceCriteria: 'The current server-rendered ticket pages remain readable.',
      assignmentTargetType: 'agent',
      assignmentTargetId: agentResult.agent.id,
      assignmentMode: 'individual',
      ownedOutputPaths: null,
      targetRef: null,
      executionMode: 'agent',
      workflowId: null,
      workflowInput: null,
      capabilityType: 'directAction',
      capabilityId: 'agent-selected-actions',
      capabilityInput: null,
      executionPolicy: executionPolicy(),
      workTypeId: null,
      workTypeSnapshot: null,
      workContextId: context.id,
      workContextSnapshot: {
        id: context.id,
        name: context.name,
        purpose: context.purpose,
        status: context.status,
        capturedAt: now
      },
      status: 'blocked',
      blockedReason: 'Page-render fixture is intentionally not executable.',
      createdBy: 'page-render-test',
      changedBy: 'page-render-test',
      changedAt: now,
      createdAt: now,
      updatedAt: now
    },
    eventPayload: { source: 'page-render-regression' }
  });
  const createdRun = await store.createRun({
    ticketId: ticketResult.ticket.id,
    agentId: agentResult.agent.id,
    agentName: agentResult.agent.name,
    runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot(),
    status: 'pending'
  });
  const transition = await store.transitionRun({
    runId: createdRun.id,
    expectedRevision: createdRun.revision,
    fromStatuses: ['pending'],
    toStatus: 'failed',
    patch: { completedAt: now, error: 'Intentional page-render fixture terminal state.' },
    eventType: 'run.failed',
    eventPayload: { source: 'page-render-regression' }
  });
  const run = transition.run;
  await store.appendSystemLog({
    type: 'page_render.fixture',
    message: 'PostgreSQL page render fixture created',
    metadata: { contextTicketId: ticketResult.ticket.id }
  });
  return { ticket: ticketResult.ticket, run, context };
}

async function main() {
  const store = new PostgresRuntimeStore({ connectionString: DATABASE_URL, schema: SCHEMA });
  let server = null;
  try {
    await store.migrate();
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL,
        POSTGRES_SCHEMA: SCHEMA,
        SESSION_SECRET,
        ADMIN_BOOTSTRAP_PASSWORD: 'admin123',
        PORT,
        WORKSPACE_ROOT,
        TEST_SKIP_STARTUP_RUN_RECOVERY: 'true',
        RUNTIME_SCHEDULER_INTERVAL_MS: '60000',
        PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS: '60000'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', chunk => process.stdout.write(String(chunk)));
    server.stderr.on('data', chunk => process.stderr.write(String(chunk)));

    await waitForReady();
    const cookie = await login();
    const fixture = await seedCurrentFormatFixture(store);

    await assertPage(cookie, '/tickets', fixture.ticket.objective);
    await assertPage(cookie, `/tickets/${fixture.ticket.id}`, 'At a glance');
    const runDetail = await assertPage(cookie, `/runs/${fixture.run.id}`, 'Run Outcome');
    assert(runDetail.body.includes('id="run-live-status"'), 'run detail must preserve the live status target');
    assert((runDetail.body.match(/id="run-live-status"/g) || []).length === 1,
      'run detail live status target must remain unique');
    assert(runDetail.body.includes('How it was set up'), 'run detail must render its configuration zone');
    assert(runDetail.body.includes('What the system did'), 'run detail must render its evidence zone');
    assert(runDetail.body.includes('Decision Map'), 'run detail must retain the decision-map entry point');
    assert(runDetail.body.includes("target.closest('details')"),
      'replay jumps must reveal collapsed evidence ancestors before scrolling');
    await assertPage(cookie, '/logs?limit=5', 'PostgreSQL page render fixture created');
    await assertPage(cookie, '/work-contexts', fixture.context.name);
    await assertPage(cookie, `/work-contexts/${fixture.context.id}`, fixture.context.name);
    await assertPage(cookie, '/ops', 'Operational');
    const journal = await assertPage(cookie, '/event-journal', 'PostgreSQL');
    assert(!journal.body.includes('events.jsonl'), 'event journal page must not describe JSONL storage');
    await assertPage(cookie, '/admin', 'Admin Dashboard');
    await assertPage(cookie, '/admin/actions', 'Actions Catalog');
    await assertPage(cookie, '/admin/workflows', 'Workflow Capabilities');
    await assertPage(cookie, '/admin/runtime-limits', 'Runtime Limits');
    await assertPage(cookie, '/admin/browser-targets', 'PostgreSQL Page Render Browser');
    await assertPage(cookie, '/process-templates', 'Process Templates');
    await assertPage(cookie, '/model-routing-policies', 'Model Routing');
    await assertPage(cookie, '/connectors', 'Connectors');
    await assertPage(cookie, '/watchers', 'Watchers');
    await assertPage(cookie, '/workspace', 'Workspace');

    const ticketPage = await request('GET', '/api/tickets?limit=1', { cookie });
    assert(ticketPage.statusCode === 200, `ticket API returned HTTP ${ticketPage.statusCode}`);
    const ticketPayload = JSON.parse(ticketPage.body);
    assert(ticketPayload.tickets.length === 1, 'ticket API must honor its bounded limit');
    assert(ticketPayload.tickets[0].id === fixture.ticket.id, 'ticket API must read the PostgreSQL fixture');

    const summary = await request('GET', `/api/work-contexts/${fixture.context.id}/summary`, { cookie });
    assert(summary.statusCode === 200, `Work Context summary returned HTTP ${summary.statusCode}`);
    const summaryPayload = JSON.parse(summary.body);
    assert(summaryPayload.counts.ticketCount === 1, 'Work Context summary must use PostgreSQL ticket counts');
    assert(summaryPayload.counts.recentRunCount === 1, 'Work Context summary must use PostgreSQL run counts');

    const close = await request('PATCH', `/api/tickets/${fixture.ticket.id}/status`, {
      cookie,
      body: { status: 'closed' }
    });
    assert(close.statusCode === 200, `ticket status mutation returned HTTP ${close.statusCode}`);
    assert((await store.getTicket(fixture.ticket.id)).status === 'closed',
      'ticket status mutation must commit to PostgreSQL');

    const exportResponse = await request('GET', '/api/export?domain=tickets&limit=1', { cookie });
    assert(exportResponse.statusCode === 200, `bounded export returned HTTP ${exportResponse.statusCode}`);
    const exportPayload = JSON.parse(exportResponse.body);
    assert(exportPayload.domain === 'tickets' && exportPayload.items.length === 1,
      'bounded export must return PostgreSQL tickets');
    const invalidExport = await request('GET', '/api/export?domain=unknown&limit=1', { cookie });
    assert(invalidExport.statusCode === 400, 'unknown export domains must be rejected');

    console.log('PASS: page render regression — current PostgreSQL fixtures, authenticated pages, bounded reads, and ticket mutation');
  } finally {
    if (server) {
      server.kill('SIGTERM');
      await waitForExit(server);
    }
    try { await store.pool.query(`DROP SCHEMA IF EXISTS ${store.schemaSql} CASCADE`); } catch (_) {}
    await store.close();
    removeTempWorkspaceRoot(WORKSPACE_ROOT);
  }
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
