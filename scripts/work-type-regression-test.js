'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');
const { validateWorkTypeCatalog, snapshotWorkType } = require('../work-types');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'work-type-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('work-type');
const PORT = Number(process.env.WORK_TYPE_TEST_PORT || 3441);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const STAMP = `${process.pid}-${Date.now()}`;
const SOURCE = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

const DATA_FILES = [
  'agents.json', 'allocation-plans.json', 'browser-targets.json', 'groups.json', 'logs.json',
  'memberships.json', 'operation-history.json', 'permissions.json', 'runs.json', 'tickets.json',
  'users.json', 'workflows.json', 'work-types.json'
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`  OK: ${message}`);
}

function assertThrows(fn, pattern, message) {
  let error = null;
  try { fn(); } catch (caught) { error = caught; }
  assert(error && pattern.test(error.message), message);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2));
}

function readReplay(run) {
  assert(run && run.replaySnapshotPath, `run ${run && run.id} has a replay snapshot path`);
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, run.replaySnapshotPath), 'utf8'));
}

for (const file of DATA_FILES) {
  const source = path.join(REAL_DATA_DIR, file);
  fs.writeFileSync(path.join(DATA_DIR, file), fs.existsSync(source) ? fs.readFileSync(source) : '[]');
}
fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), '');

const workspaceWorkType = {
  id: 'meeting-brief',
  name: 'Meeting Brief',
  description: 'Prepare a brief from available context.',
  status: 'active',
  allowedTargetKinds: ['workspace']
};
const browserWorkType = {
  id: 'browser-research',
  name: 'Browser Research',
  description: 'Inspect an authorized browser target without interaction.',
  status: 'active',
  allowedTargetKinds: ['browser']
};
const inactiveWorkType = {
  id: 'inactive-brief',
  name: 'Inactive Brief',
  description: 'An inactive semantic type.',
  status: 'inactive',
  allowedTargetKinds: ['workspace']
};
writeJson('work-types.json', [workspaceWorkType, browserWorkType, inactiveWorkType]);
writeJson('browser-targets.json', [{
  id: 'work-type-browser',
  name: 'Work Type Browser',
  status: 'active',
  allowedOrigins: ['https://example.com'],
  startUrl: 'https://example.com',
  limits: {
    maxNavigationsPerRun: 2,
    maxActionsPerRun: 4,
    navTimeoutMs: 5000,
    waitTimeoutMsCap: 100,
    maxPageTextBytes: 1024,
    maxScreenshotsPerRun: 1
  }
}]);

const agents = readJson('agents.json');
const agent = {
  id: Math.max(0, ...agents.map(item => Number(item.id) || 0)) + 1,
  name: `WorkTypeAgent-${STAMP}`,
  type: 'agent',
  provider: 'openai',
  model: 'gpt-4.1-mini',
  apiKey: 'work-type-test-key',
  createdAt: new Date().toISOString()
};
writeJson('agents.json', [...agents, agent]);

function request(method, urlPath, options = {}) {
  const body = options.form
    ? new URLSearchParams(options.form).toString()
    : options.json ? JSON.stringify(options.json) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${urlPath}`, {
      method,
      headers: {
        ...(options.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(options.json ? { 'Content-Type': 'application/json' } : {}),
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
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
    if (body) req.write(body);
    req.end();
  });
}

function cookieFrom(response) {
  return (response.headers['set-cookie'] || []).map(value => value.split(';')[0]).join('; ');
}

async function waitForReady() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await request('GET', '/health');
      if (response.statusCode === 200 && JSON.parse(response.body).ready) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for ticket server readiness');
}

async function waitForTerminalRun(ticketId, previousRunId = null) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const run = readJson('runs.json')
      .filter(item => item.ticketId === ticketId && (previousRunId == null || item.id !== previousRunId))
      .sort((a, b) => b.id - a.id)[0];
    if (run && ['completed', 'failed', 'interrupted'].includes(run.status) && run.replaySnapshotPath) return run;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for terminal run for ticket ${ticketId}`);
}

async function createTicket(cookie, objective, options = {}) {
  const response = await request('POST', '/tickets', {
    cookie,
    form: {
      objective,
      capabilityType: options.capabilityType || 'directAction',
      executionTargetKind: options.executionTargetKind || 'workspace',
      ...(options.browserTargetId ? { browserTargetId: options.browserTargetId } : {}),
      ...(options.targetRef ? { targetRef: JSON.stringify(options.targetRef) } : {}),
      ...(options.workflowId ? { workflowId: options.workflowId, workflowInput: '{}' } : {}),
      assignmentTargetType: 'agent',
      assignmentTargetId: String(agent.id),
      assignmentMode: 'individual',
      ...(options.workTypeId !== undefined ? { workTypeId: options.workTypeId } : {})
    }
  });
  const ticket = readJson('tickets.json').find(item => item.objective === objective) || null;
  return { response, ticket };
}

function functionSource(name) {
  const marker = `function ${name}(`;
  let start = SOURCE.indexOf(marker);
  if (start < 0) start = SOURCE.indexOf(`async ${marker}`);
  assert(start >= 0, `${name} exists`);
  const nextFunction = SOURCE.indexOf('\nfunction ', start + marker.length);
  const nextAsyncFunction = SOURCE.indexOf('\nasync function ', start + marker.length);
  const candidates = [nextFunction, nextAsyncFunction].filter(index => index >= 0);
  const next = candidates.length > 0 ? Math.min(...candidates) : SOURCE.length;
  return SOURCE.slice(start, next);
}

function createModelPreload() {
  const preloadPath = path.join(os.tmpdir(), `work-type-model-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
global.fetch = async function(_url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const combined = (body.input || []).map(item => String(item && item.content || '')).join('\\n');
  const plan = combined.includes('protected-work-type-case')
    ? { message: 'Attempt protected write.', actions: [{ operation: 'writeFile', args: { path: 'package.json', content: 'blocked' } }], complete: true }
    : { message: 'Complete semantic fixture.', actions: [], complete: true };
  return {
    ok: true, status: 200, headers: new Map([['x-request-id', 'work-type-test']]),
    async text() { return JSON.stringify({ output_text: JSON.stringify(plan), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }); }
  };
};
`);
  return preloadPath;
}

function waitForExit(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', resolve);
  });
}

async function main() {
  console.log('Work Type schema checks');
  assert(Array.isArray(validateWorkTypeCatalog([])), 'empty Work Type catalog is valid');
  assert(validateWorkTypeCatalog([workspaceWorkType])[0].id === workspaceWorkType.id, 'valid Work Type is accepted');
  assertThrows(() => validateWorkTypeCatalog({}), /JSON array/, 'non-array catalog is rejected');
  assertThrows(() => validateWorkTypeCatalog([{ ...workspaceWorkType, extra: true }]), /unknown field/, 'unknown fields are rejected');
  assertThrows(() => validateWorkTypeCatalog([{ ...workspaceWorkType, id: 'Not A Slug' }]), /slug/, 'invalid ids are rejected');
  assertThrows(() => validateWorkTypeCatalog([{ ...workspaceWorkType, name: ' ' }]), /name/, 'empty names are rejected');
  assertThrows(() => validateWorkTypeCatalog([{ ...workspaceWorkType, description: '' }]), /description/, 'empty descriptions are rejected');
  assertThrows(() => validateWorkTypeCatalog([{ ...workspaceWorkType, status: 'draft' }]), /status/, 'invalid status is rejected');
  assertThrows(() => validateWorkTypeCatalog([{ ...workspaceWorkType, allowedTargetKinds: [] }]), /non-empty array/, 'empty target-kind list is rejected');
  assertThrows(() => validateWorkTypeCatalog([{ ...workspaceWorkType, allowedTargetKinds: ['api'] }]), /workspace or browser/, 'unknown target kinds are rejected');
  assertThrows(() => validateWorkTypeCatalog([workspaceWorkType, workspaceWorkType]), /duplicate id/, 'duplicate ids are rejected');
  assert(snapshotWorkType(workspaceWorkType, '2026-01-01T00:00:00.000Z').capturedAt === '2026-01-01T00:00:00.000Z', 'snapshot captures an immutable timestamp');

  console.log('Authority boundary checks');
  for (const name of ['buildRunAuthorityContext', 'executeWorkspaceOperation', 'executeBrowserOperation', 'assertAllocatedOwnershipAllowsMutation', 'assertNoCrossTicketOverlap', 'buildAgentPrompt']) {
    assert(!/workType/i.test(functionSource(name)), `${name} does not consult Work Type metadata`);
  }
  assert(!require('../work-types').WORK_TYPE_FIELDS.includes('allowedOperations'), 'Work Type schema contains no operation permission field');

  const preloadPath = createModelPreload();
  const child = spawn(process.execPath, ['-r', preloadPath, path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(PORT),
      DATA_DIR,
      WORKSPACE_ROOT,
      OPENAI_API_KEY: 'work-type-test-key',
      RUNTIME_SCHEDULER_INTERVAL_MS: '25',
      RUN_LEASE_DURATION_MS: '5000'
    },
    stdio: ['ignore', 'inherit', 'inherit']
  });

  try {
    try {
      await waitForReady();
    } catch (error) {
      throw new Error(`${error.message} (exitCode=${child.exitCode}, signal=${child.signalCode})`);
    }
    const login = await request('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
    assert(login.statusCode === 302, 'admin login succeeds');
    const cookie = cookieFrom(login);

    const form = await request('GET', '/', { cookie });
    assert(form.statusCode === 200 && form.body.includes('id="workTypeId"'), 'ticket form renders the optional Work Type selector');
    assert(form.body.includes('Unspecified'), 'ticket form defaults Work Type to Unspecified');
    assert(form.body.includes(workspaceWorkType.name) && !form.body.includes(inactiveWorkType.name), 'ticket form lists only active Work Types');

    const legacy = await createTicket(cookie, `legacy-work-type-${STAMP}`);
    assert(legacy.response.statusCode === 302 && legacy.ticket, 'ticket creation without Work Type remains valid');
    assert(legacy.ticket.workTypeId === null && legacy.ticket.workTypeSnapshot === null, 'untyped ticket persists nullable Work Type fields');
    const legacyRun = await waitForTerminalRun(legacy.ticket.id);

    const typed = await createTicket(cookie, `typed-work-type-${STAMP}`, { workTypeId: workspaceWorkType.id });
    assert(typed.response.statusCode === 302 && typed.ticket, 'valid active Work Type is accepted');
    assert(typed.ticket.workTypeId === workspaceWorkType.id, 'ticket persists Work Type id');
    assert(typed.ticket.workTypeSnapshot.name === workspaceWorkType.name, 'ticket persists Work Type snapshot');
    const originalTicketSnapshot = JSON.parse(JSON.stringify(typed.ticket.workTypeSnapshot));
    const typedRun = await waitForTerminalRun(typed.ticket.id);
    assert(JSON.stringify(typedRun.workTypeSnapshot) === JSON.stringify(originalTicketSnapshot), 'run copies the exact ticket Work Type snapshot');
    const typedReplay = readReplay(typedRun);
    const legacyReplay = readReplay(legacyRun);
    assert(JSON.stringify(typedReplay.workTypeSnapshot) === JSON.stringify(originalTicketSnapshot), 'replay preserves the exact run Work Type snapshot');
    assert(JSON.stringify(typedReplay.primitiveContract.allowedOperations) === JSON.stringify(legacyReplay.primitiveContract.allowedOperations), 'Work Type does not change runtime allowedOperations');
    assert(JSON.stringify(typedRun.executionPolicySnapshot) === JSON.stringify(legacyRun.executionPolicySnapshot), 'Work Type does not change executionPolicy');
    assert(JSON.stringify(typedRun.verificationContractSnapshot) === JSON.stringify(legacyRun.verificationContractSnapshot), 'Work Type does not change verification or postcondition snapshots');

    const unknown = await createTicket(cookie, `unknown-work-type-${STAMP}`, { workTypeId: 'does-not-exist' });
    assert(unknown.response.statusCode === 400 && /does not exist/.test(unknown.response.body) && !unknown.ticket, 'unknown Work Type is rejected');
    const inactive = await createTicket(cookie, `inactive-work-type-${STAMP}`, { workTypeId: inactiveWorkType.id });
    assert(inactive.response.statusCode === 400 && /inactive/.test(inactive.response.body) && !inactive.ticket, 'inactive Work Type is rejected');
    const incompatible = await createTicket(cookie, `incompatible-work-type-${STAMP}`, { workTypeId: browserWorkType.id });
    assert(incompatible.response.statusCode === 400 && /not compatible/.test(incompatible.response.body) && !incompatible.ticket, 'incompatible allowedTargetKinds is rejected');
    const unauthorizedTarget = await createTicket(cookie, `unauthorized-target-${STAMP}`, {
      workTypeId: browserWorkType.id,
      targetRef: { kind: 'browser', browserTargetId: 'missing-target' }
    });
    assert(unauthorizedTarget.response.statusCode === 400 && /browser target does not exist or is inactive/i.test(unauthorizedTarget.response.body), 'Work Type does not authorize a target by itself');

    const browserTyped = await createTicket(cookie, `browser-work-type-${STAMP}`, {
      workTypeId: browserWorkType.id,
      executionTargetKind: 'browser',
      browserTargetId: 'work-type-browser'
    });
    assert(browserTyped.response.statusCode === 302 && browserTyped.ticket, 'browser-compatible Work Type is accepted for an authorized browser target');
    const browserRun = await waitForTerminalRun(browserTyped.ticket.id);
    const browserReplay = readReplay(browserRun);
    assert(JSON.stringify(browserReplay.primitiveContract.allowedOperations) === JSON.stringify(['navigate', 'observe', 'readPageText', 'screenshot', 'wait']), 'browser origin and unsupported-operation policy remain the Phase 1 primitive contract');

    const workflow = readJson('workflows.json').find(item => item && item.enabled !== false);
    assert(Boolean(workflow), 'enabled workflow fixture exists');
    const workflowBrowser = await createTicket(cookie, `workflow-browser-work-type-${STAMP}`, {
      workTypeId: browserWorkType.id,
      capabilityType: 'workflow',
      workflowId: workflow.id,
      executionTargetKind: 'browser',
      browserTargetId: 'work-type-browser'
    });
    assert(workflowBrowser.response.statusCode === 400 && /Workflow tickets cannot use browser targets/.test(workflowBrowser.response.body), 'Work Type cannot override workflow/browser incompatibility');

    const protectedCase = await createTicket(cookie, `protected-work-type-case-${STAMP}`, { workTypeId: workspaceWorkType.id });
    assert(protectedCase.response.statusCode === 302 && protectedCase.ticket, 'protected-path fixture ticket is created');
    const protectedRun = await waitForTerminalRun(protectedCase.ticket.id);
    const protectedReplay = readReplay(protectedRun);
    assert(protectedReplay.workspaceOperations.some(item => /WORKSPACE_PROTECTED_PATH|WORKSPACE_SENSITIVE_PATH/.test(JSON.stringify(item))), 'protected paths still fail with a Work Type');

    writeJson('work-types.json', [
      { ...workspaceWorkType, name: 'Changed Catalog Name', status: 'inactive' },
      browserWorkType,
      inactiveWorkType
    ]);
    const persistedTicket = readJson('tickets.json').find(item => item.id === typed.ticket.id);
    assert(JSON.stringify(persistedTicket.workTypeSnapshot) === JSON.stringify(originalTicketSnapshot), 'ticket snapshot remains unchanged after catalog edit and deactivation');
    const rerunResponse = await request('POST', `/api/tickets/${typed.ticket.id}/rerun`, { cookie, json: { mode: 'retry' } });
    assert(rerunResponse.statusCode === 200, `rerun succeeds after catalog deactivation (HTTP ${rerunResponse.statusCode})`);
    const rerun = await waitForTerminalRun(typed.ticket.id, typedRun.id);
    assert(JSON.stringify(rerun.workTypeSnapshot) === JSON.stringify(originalTicketSnapshot), 'rerun copies the ticket snapshot instead of resolving the live catalog');
    assert(JSON.stringify(readReplay(rerun).workTypeSnapshot) === JSON.stringify(originalTicketSnapshot), 'rerun replay preserves the ticket snapshot');

    const ticketPage = await request('GET', `/tickets/${typed.ticket.id}`, { cookie });
    assert(ticketPage.statusCode === 200 && ticketPage.body.includes('Work Type') && ticketPage.body.includes(workspaceWorkType.name), 'ticket detail renders Work Type snapshot');
    const runPage = await request('GET', `/runs/${typedRun.id}`, { cookie });
    assert(runPage.statusCode === 200 && runPage.body.includes('Work Type Snapshot') && runPage.body.includes(workspaceWorkType.name), 'run detail renders immutable Work Type snapshot');
    const legacyTicketPage = await request('GET', `/tickets/${legacy.ticket.id}`, { cookie });
    const legacyRunPage = await request('GET', `/runs/${legacyRun.id}`, { cookie });
    assert(legacyTicketPage.body.includes('Unspecified') && legacyRunPage.body.includes('Unspecified'), 'legacy ticket and run detail render without Work Type');

    const eventsText = fs.readFileSync(path.join(DATA_DIR, 'events.jsonl'), 'utf8');
    assert(eventsText.includes('catalog_at_ticket_creation') && eventsText.includes('ticket_snapshot'), 'ticket.created and run.created record Work Type snapshot provenance');
    console.log('\n✓ Work Type Phase 1 regression checks passed.');
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
    try { fs.unlinkSync(preloadPath); } catch (_) {}
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    removeTempWorkspaceRoot(WORKSPACE_ROOT);
  }
}

main().catch(error => {
  console.error(`\n✗ Work Type regression failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
