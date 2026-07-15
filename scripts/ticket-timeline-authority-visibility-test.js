#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { sealCurrentRunEventChains } = require('./current-event-fixture');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-timeline-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-timeline-workspace-'));
const PORT = 3511;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ADMIN_HASH = '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g';
const T0 = '2026-03-01T10:00:00.000Z';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeJson(name, value) {
  fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(value, null, 2));
}

function event(id, type, ts, payload = {}, runId = 10, ticketId = 1, seq = null) {
  return {
    id,
    ts,
    type,
    ticketId,
    runId,
    stepId: null,
    payload,
    ...(seq === null ? {} : { seq, prevHash: seq === 0 ? null : `hash-${seq - 1}` })
  };
}

function sealRunEventChains(events) {
  return sealCurrentRunEventChains(events);
}

function seed() {
  fs.mkdirSync(path.join(DATA_DIR, 'replay-snapshots'), { recursive: true });
  writeJson('users.json', [
    { id: 1, username: 'admin', passwordHash: ADMIN_HASH, type: 'user', createdAt: T0 },
    { id: 2, username: 'noread', passwordHash: ADMIN_HASH, type: 'user', createdAt: T0 }
  ]);
  writeJson('permissions.json', ['ticket:read', 'ticket:update', 'user:read']);
  writeJson('groups.json', [
    { id: 1, name: 'Readers', permissions: ['ticket:read', 'ticket:update'], canReceiveTickets: false },
    { id: 2, name: 'No Read', permissions: ['user:read'], canReceiveTickets: false }
  ]);
  writeJson('memberships.json', [
    { id: 1, principalType: 'user', principalId: 1, groupId: 1 },
    { id: 2, principalType: 'user', principalId: 2, groupId: 2 }
  ]);
  writeJson('agents.json', [{ id: 1, name: 'Timeline Agent', type: 'agent', provider: 'openai', model: 'test', apiKey: '', createdAt: T0, updatedAt: T0 }]);
  writeJson('workflows.json', []);
  writeJson('allocation-plans.json', []);
  writeJson('protected-paths.json', ['restricted/**']);
  writeJson('process-templates.json', []);
  writeJson('process-template-versions.json', []);
  writeJson('process-template-triggers.json', [{
    id: 1,
    templateId: 7,
    templateName: 'Daily status packet',
    templateVersion: 2,
    triggerType: 'schedule',
    triggerToken: 'schedule:7:2026-03-01T09:00:00.000Z',
    scheduledFor: '2026-03-01T09:00:00.000Z',
    triggeredAt: '2026-03-01T09:00:00.100Z',
    ticketId: 1
  }]);
  writeJson('tickets.json', [
    {
      id: 1,
      objective: 'Prepare the scheduled status packet.',
      assignmentTargetType: 'agent',
      assignmentTargetId: 1,
      assignmentMode: 'individual',
      ownedOutputPaths: null,
      executionMode: 'agent',
      workflowId: null,
      workflowInput: null,
      capabilityType: 'directAction',
      capabilityId: 'agent-selected-actions',
      capabilityInput: null,
      executionPolicy: { requireVerification: 'when_declared', workspaceScope: 'main', maxAttempts: null },
      status: 'completed',
      source: {
        type: 'process_template',
        templateId: 7,
        templateName: 'Daily status packet',
        templateVersion: 2,
        triggerType: 'schedule',
        triggerToken: 'schedule:7:2026-03-01T09:00:00.000Z',
        scheduledFor: '2026-03-01T09:00:00.000Z',
        triggeredBy: 'system'
      },
      triage: {
        required: true,
        reasonCode: 'authority_blocked',
        summary: 'A protected follow-up was denied.',
        requiredDecision: 'change_scope',
        evidenceRefs: ['event:authority.denied'],
        allowedActions: ['review'],
        prohibitedActions: ['bypass_authority'],
        createdAt: '2026-03-01T10:00:08.000Z',
        resolvedAt: null,
        resolvedBy: null,
        resolution: null
      },
      createdBy: 'system', changedBy: 'system', createdAt: T0, changedAt: '2026-03-01T10:00:12.000Z', updatedAt: '2026-03-01T10:00:12.000Z'
    },
    {
      id: 2,
      objective: 'Legacy generated ticket.',
      assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual', ownedOutputPaths: null,
      executionMode: 'agent', workflowId: null, workflowInput: null, capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
      executionPolicy: { requireVerification: 'when_declared', workspaceScope: 'main', maxAttempts: null },
      status: 'open',
      source: { type: 'process_template', templateId: 3, templateName: 'Legacy packet', triggerType: 'manual', triggerToken: 'legacy-3', triggeredBy: 'admin' },
      createdBy: 'admin', changedBy: 'admin', createdAt: T0, changedAt: T0, updatedAt: T0
    }
  ]);

  const runEvaluation = {
    effectiveness: { status: 'passed' },
    efficiency: { durationMs: 9000, providerRequests: 1, modelResponses: 1, workspaceOperations: 3, mutationCount: 1 },
    violations: { status: 'passed', items: [] }
  };
  const runConsequence = {
    mutations: [{ operation: 'writeFile', path: 'outputs/report.md' }],
    created: [{ operation: 'writeFile', path: 'outputs/report.md' }],
    updated: [], deleted: [], renamed: [], notifications: [], externalEffects: [],
    verification: { postconditionsStatus: 'passed', violationsStatus: 'passed' }
  };
  writeJson('runs.json', [{
    id: 10, ticketId: 1, agentId: 1, agentName: 'Timeline Agent',
    workspaceRoot: WORKSPACE_ROOT, mainWorkspaceRoot: WORKSPACE_ROOT, executionWorkspaceType: 'main',
    allocationPlanId: null, allocationItemId: null, ownedOutputPaths: [], allocationSubtask: null,
    executionMode: 'agent', workflowId: null, workflowInput: null, capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    executionPolicySnapshot: { requireVerification: 'when_declared', workspaceScope: 'main' },
    verificationContractSnapshot: { workflowId: 'status', workflowName: 'Status', workflowVersion: '1', postconditions: [{ id: 'report', type: 'fileExists', path: 'outputs/report.md' }], capturedAt: T0 },
    currentPhase: 'terminalization', leaseOwner: null, leaseExpiresAt: null, currentStepId: null, currentWorkflowAction: null, lastHeartbeatAt: null,
    status: 'completed', error: null, runEvaluation, runConsequence,
    triage: {
      required: false, reasonCode: 'verification_failed', summary: 'Reviewed historical warning.', requiredDecision: 'review_failure',
      evidenceRefs: ['event:run.verification_failed'], allowedActions: ['review'], prohibitedActions: [],
      createdAt: '2026-03-01T10:00:07.000Z', resolvedAt: '2026-03-01T10:00:11.000Z', resolvedBy: 'admin', resolution: 'Reviewed; status unchanged.'
    },
    replaySnapshotPath: 'replay-snapshots/run-10.json',
    createdAt: '2026-03-01T10:00:01.000Z', startedAt: '2026-03-01T10:00:02.000Z', completedAt: '2026-03-01T10:00:10.000Z', updatedAt: '2026-03-01T10:00:11.000Z'
  }]);

  const mutationReceipt = {
    operationId: 1,
    targetId: 'local-workspace',
    targetKind: 'localWorkspace',
    targetScope: { type: 'filesystemRoot', root: WORKSPACE_ROOT },
    targetPath: 'outputs/report.md',
    targetResourceId: 'outputs/report.md',
    operation: 'writeFile',
    timestamp: '2026-03-01T10:00:05.000Z',
    before: { existed: false }, after: { existed: true, type: 'file', contentHash: 'after-hash' },
    changedResources: ['outputs/report.md'], createdResources: ['outputs/report.md'], deletedResources: [],
    providerResponse: { path: 'outputs/report.md', status: 'written' }, authorityDecision: { rule: 'workspace_mutation', status: 'allowed' }, error: null,
    actorType: 'agent', actorId: 1, runId: 10, ticketId: 1
  };
  writeJson('operation-history.json', [{
    id: 1, timestamp: '2026-03-01T10:00:05.000Z', ticketId: 1, runId: 10, allocationPlanId: null, allocationItemId: null, step: 1,
    operation: 'writeFile', args: { path: 'outputs/report.md', content: 'SECRET_MUTATION_INPUT' },
    preState: { existed: false, content: 'PRE_MUTATION_SECRET' }, postState: { existed: true, type: 'file', contentHash: 'after-hash' },
    result: { path: 'outputs/report.md', status: 'written' }, error: null,
    targetId: 'local-workspace', targetKind: 'localWorkspace', targetScope: { type: 'filesystemRoot', root: WORKSPACE_ROOT }, targetPath: 'outputs/report.md', targetResourceId: 'outputs/report.md',
    authorityDecision: { rule: 'workspace_mutation', status: 'allowed' }, mutationReceipt
  }]);

  const readReceipt = {
    targetId: 'local-workspace', targetKind: 'localWorkspace', targetScope: { type: 'filesystemRoot', root: WORKSPACE_ROOT },
    targetPath: 'inputs/source.md', targetResourceId: 'inputs/source.md', operation: 'readFile', timestamp: '2026-03-01T10:00:04.000Z',
    metadata: { size: 42, contentHash: 'read-hash' }, partial: false, truncated: false, actorType: 'agent', actorId: 1, runId: 10, ticketId: 1
  };
  const deniedReceipt = {
    operationId: null, targetId: 'local-workspace', targetKind: 'localWorkspace', targetScope: { type: 'filesystemRoot', root: WORKSPACE_ROOT },
    targetPath: 'restricted/secret.md', operation: 'writeFile', timestamp: '2026-03-01T10:00:06.100Z',
    before: null, after: null, changedResources: [], createdResources: [], deletedResources: [], providerResponse: null,
    error: { message: 'Protected path', code: 'WORKSPACE_PROTECTED_PATH', failureKind: 'protected_path' }, runId: 10, ticketId: 1
  };
  const events = sealRunEventChains([
    event('ticket-created', 'ticket.created', T0, { status: 'open' }, null, 1, null),
    event('run-created', 'run.created', '2026-03-01T10:00:01.000Z', { status: 'pending' }, 10, 1, 0),
    event('run-lease', 'run.lease_acquired', '2026-03-01T10:00:01.500Z', { status: 'pending' }, 10, 1, 1),
    event('run-started', 'run.started', '2026-03-01T10:00:02.000Z', { status: 'running' }, 10, 1, 2),
    event('authority-allow', 'authority.allowed', '2026-03-01T10:00:03.000Z', { rule: 'workspace_mutation', operation: 'writeFile', path: 'outputs/report.md', actor: 'agent:1', status: 'allowed', reason: 'Runtime authority checks passed' }, 10, 1, 3),
    event('read-event', 'workspace.operation', '2026-03-01T10:00:04.100Z', { operation: 'readFile', path: 'inputs/source.md', mutating: false, result: { path: 'inputs/source.md', content: 'SECRET_FILE_CONTENT' }, targetId: 'local-workspace', targetKind: 'localWorkspace', readReceipt }, 10, 1, 4),
    event('write-event', 'workspace.operation', '2026-03-01T10:00:05.100Z', { operation: 'writeFile', path: 'outputs/report.md', mutating: true, input: { path: 'outputs/report.md', content: 'SECRET_MUTATION_INPUT' }, result: { path: 'outputs/report.md', status: 'written', historyId: 1 }, historyId: 1, targetId: 'local-workspace', targetKind: 'localWorkspace', mutationReceipt }, 10, 1, 5),
    event('authority-denied', 'authority.denied', '2026-03-01T10:00:06.000Z', { rule: 'protected_path', operation: 'writeFile', path: 'restricted/secret.md', actor: 'agent:1', status: 'denied', reason: 'restricted/**' }, 10, 1, 6),
    event('denied-workspace', 'workspace.operation', '2026-03-01T10:00:06.100Z', { operation: 'writeFile', path: 'restricted/secret.md', mutating: true, blocked: true, error: 'Protected path', targetId: 'local-workspace', targetKind: 'localWorkspace', mutationReceipt: deniedReceipt }, 10, 1, 7),
    event('postconditions', 'run.postconditions_checked', '2026-03-01T10:00:07.000Z', { status: 'passed', passed: 1, failed: 0, total: 1, contractSource: 'run_snapshot' }, 10, 1, 8),
    event('verification', 'run.verification_passed', '2026-03-01T10:00:07.100Z', { status: 'passed' }, 10, 1, 9),
    event('violations', 'run.violations_checked', '2026-03-01T10:00:07.200Z', { status: 'passed', items: [] }, 10, 1, 10),
    event('evaluation', 'run.evaluation_completed', '2026-03-01T10:00:08.000Z', { evaluation: runEvaluation }, 10, 1, 11),
    event('consequence', 'run.consequence_recorded', '2026-03-01T10:00:08.100Z', { consequence: runConsequence }, 10, 1, 12),
    event('cross-delete', 'workspace.cross_ticket_delete_authorized', '2026-03-01T10:00:08.200Z', { path: 'old/report.md', priorOwnerTicketId: 9, priorOwnerRunId: 90, priorOwnerHistoryId: 99, permission: 'workspace.delete.cross_ticket_artifact', requestedBy: 'admin' }, 10, 1, 13),
    event('execution-complete', 'run.execution_completed', '2026-03-01T10:00:09.000Z', { status: 'completed' }, 10, 1, 14),
    event('snapshot-final', 'run.snapshot_finalized', '2026-03-01T10:00:09.100Z', { replaySnapshotPath: 'replay-snapshots/run-10.json' }, 10, 1, 15),
    event('terminal', 'run.terminalized', '2026-03-01T10:00:10.000Z', { status: 'completed' }, 10, 1, 16)
  ]);
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), `${events.map(item => JSON.stringify(item)).join('\n')}\n`);

  writeJson('logs.json', [
    { id: 1, timestamp: '2026-03-01T10:00:11.000Z', runId: null, ticketId: null, agentId: null, agentName: 'System', type: 'run:triage_resolve', message: 'Run #10 triage resolved by admin', workspaceAction: null, contextRunId: 10, contextTicketId: 1, changedBy: 'admin', changedAt: '2026-03-01T10:00:11.000Z', reasonCode: 'verification_failed', resolution: 'Reviewed; status unchanged.' },
    { id: 2, timestamp: '2026-03-01T10:00:11.100Z', runId: null, ticketId: null, agentId: null, agentName: 'System', type: 'ticket:triage_resolve', message: 'Historical ticket triage resolution note', workspaceAction: null, contextTicketId: 1, changedBy: 'admin', changedAt: '2026-03-01T10:00:11.100Z', reasonCode: 'authority_blocked', resolution: 'Historical note only.' },
    { id: 3, timestamp: '2026-03-01T10:00:05.200Z', runId: 10, ticketId: 1, agentId: 1, agentName: 'Timeline Agent', type: 'workspace:write', message: 'Duplicate workspace narrative SECRET_LOG_CONTENT', workspaceAction: { path: 'outputs/report.md' } }
  ]);

  writeJson('replay-snapshots/run-10.json', {
    version: 1, runId: 10, ticketId: 1, targetId: 'local-workspace', targetKind: 'localWorkspace', targetScope: { type: 'filesystemRoot', root: WORKSPACE_ROOT },
    capturedAt: '2026-03-01T10:00:01.000Z', terminalStatus: 'completed', finalizedAt: '2026-03-01T10:00:09.100Z',
    providerRequests: [{ body: 'SECRET_PROVIDER_BODY' }], modelResponses: [{ content: 'SECRET_MODEL_RESPONSE' }], parsedModelPlans: [], authorityChecks: [], events: [],
    workspaceOperations: [
      { operation: { operation: 'readFile', args: { path: 'inputs/source.md' } }, result: { content: 'SECRET_FILE_CONTENT' }, startedAt: '2026-03-01T10:00:04.000Z', targetId: 'local-workspace', targetKind: 'localWorkspace', readReceipt },
      { operation: { operation: 'writeFile', args: { path: 'outputs/report.md', content: 'SECRET_MUTATION_INPUT' } }, result: { path: 'outputs/report.md', status: 'written', historyId: 1 }, historyId: 1, startedAt: '2026-03-01T10:00:05.000Z', targetId: 'local-workspace', targetKind: 'localWorkspace', mutationReceipt },
      { operation: { operation: 'writeFile', args: { path: 'restricted/secret.md' }, blocked: true }, error: 'Protected path', blocked: true, startedAt: '2026-03-01T10:00:06.100Z', targetId: 'local-workspace', targetKind: 'localWorkspace', mutationReceipt: deniedReceipt }
    ],
    runEvaluation, runConsequence
  });
}

function request(method, route, options = {}) {
  const body = options.form ? new URLSearchParams(options.form).toString() : null;
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${route}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error(`request timeout: ${method} ${route}`)));
    if (body) req.write(body);
    req.end();
  });
}

function cookieFrom(response) {
  return (response.headers['set-cookie'] || []).map(value => value.split(';')[0]).join('; ');
}

async function login(username) {
  const response = await request('POST', '/login', { form: { username, password: 'admin123' } });
  assert(response.statusCode === 302, `login ${username} failed: ${response.statusCode}`);
  return cookieFrom(response);
}

function waitForReady(server, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (server.exitCode !== null) return reject(new Error('server exited before ready'));
      const healthRequest = http.get(`${BASE_URL}/api/health`, response => {
        response.resume();
        if (response.statusCode === 200) resolve();
        else if (Date.now() > deadline) reject(new Error('server readiness timeout'));
        else setTimeout(poll, 100);
      }).on('error', () => Date.now() > deadline ? reject(new Error('server readiness timeout')) : setTimeout(poll, 100));
      healthRequest.setTimeout(1000, () => healthRequest.destroy(new Error('health request timeout')));
    };
    setTimeout(poll, 200);
  });
}

function dataDigest() {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(DATA_DIR, absolute).replace(/\\/g, '/');
      if (entry.isDirectory()) visit(absolute);
      else files.push(relative);
    }
  }
  visit(DATA_DIR);
  const hash = crypto.createHash('sha256');
  for (const relative of files) {
    hash.update(relative);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(DATA_DIR, relative)));
    hash.update('\0');
  }
  return { files, hash: hash.digest('hex') };
}

async function stopServer(server) {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  await new Promise(resolve => {
    const timeout = setTimeout(() => {
      if (server.exitCode === null) server.kill('SIGKILL');
      resolve();
    }, 3000);
    server.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function main() {
  seed();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATA_DIR, WORKSPACE_ROOT, RUNTIME_SCHEDULER_INTERVAL_MS: '3600000' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  server.stdout.on('data', chunk => { output += String(chunk); });
  server.stderr.on('data', chunk => { output += String(chunk); });

  try {
    await waitForReady(server);
    const admin = await login('admin');
    const noRead = await login('noread');
    const before = dataDigest();

    const anonymous = await request('GET', '/api/tickets/1/timeline');
    assert([302, 401].includes(anonymous.statusCode), `anonymous timeline access should require auth, got ${anonymous.statusCode}`);
    const denied = await request('GET', '/api/tickets/1/timeline', { cookie: noRead });
    assert(denied.statusCode === 403, `ticket:read denial should be 403, got ${denied.statusCode}`);
    const missing = await request('GET', '/api/tickets/999/timeline', { cookie: admin });
    assert(missing.statusCode === 404, `missing ticket should be 404, got ${missing.statusCode}`);

    const first = await request('GET', '/api/tickets/1/timeline', { cookie: admin });
    assert(first.statusCode === 200, `timeline endpoint failed: ${first.statusCode} ${first.body}`);
    const timeline = JSON.parse(first.body);
    assert(timeline.ticketId === 1 && timeline.generatedAt && timeline.sourceSummary, 'timeline response envelope missing');
    assert(Array.isArray(timeline.entries) && timeline.entries.length > 0, 'timeline entries missing');
    assert(timeline.entries.some(entry => entry.type === 'ticket.state' && entry.sourceRole === 'live_state'), 'ticket state entry missing');
    assert(timeline.entries.some(entry => entry.type === 'run.created' && entry.runId === 10), 'run created entry missing');
    assert(timeline.entries.some(entry => entry.type === 'run.terminalized' && entry.runId === 10), 'run terminalized entry missing');

    const deniedEntry = timeline.entries.find(entry => entry.type === 'authority.denied');
    assert(deniedEntry && deniedEntry.details.rule === 'protected_path', 'protected-path authority denial missing');
    assert(deniedEntry.details.workspaceAttempt && deniedEntry.details.workspaceAttempt.committed !== true, 'denied workspace attempt should fold into authority entry');
    assert(!timeline.entries.some(entry => entry.type === 'target.mutation_attempted' && entry.details.path === 'restricted/secret.md'), 'denied event/replay duplicates should be folded');
    assert(timeline.entries.some(entry => entry.type === 'workspace.cross_ticket_delete_authorized'), 'permissioned cross-ticket delete audit missing');

    const committed = timeline.entries.filter(entry => entry.type === 'target.mutation_committed' && entry.details.path === 'outputs/report.md');
    assert(committed.length === 1, `committed mutation should appear once, got ${committed.length}`);
    assert(committed[0].sourceRole === 'operation_history' && committed[0].details.historyId === 1, 'committed mutation must use operation history');
    assert(committed[0].details.targetId === 'local-workspace' && committed[0].details.targetKind === 'localWorkspace', 'mutation target identity missing');
    assert(committed[0].details.receipt.operationId === 1, 'mutation receipt operation id missing');
    assert(committed[0].details.supportingSourceRefs.some(ref => ref.startsWith('events.jsonl:')), 'committed mutation should retain event source reference');
    assert(committed[0].details.supportingSourceRefs.some(ref => ref.includes('replay-snapshots/run-10.json')), 'committed mutation should retain replay source reference');

    const reads = timeline.entries.filter(entry => entry.type === 'target.read' && entry.details.path === 'inputs/source.md');
    assert(reads.length === 1, `read receipt should be deduplicated, got ${reads.length}`);
    assert(reads[0].sourceRole === 'embedded_receipt', 'read evidence should be labeled embedded_receipt');
    assert(reads[0].details.receipt.metadata.contentHash === 'read-hash', 'read receipt hash missing');
    assert(reads[0].details.receipt.metadata.size === 42, 'read receipt size missing');

    assert(timeline.entries.some(entry => entry.type === 'run.postconditions_checked'), 'postcondition entry missing');
    assert(timeline.entries.some(entry => entry.type === 'run.verification_passed'), 'verification entry missing');
    assert(timeline.entries.some(entry => entry.type === 'run.evaluation_completed'), 'evaluation entry missing');
    assert(timeline.entries.some(entry => entry.type === 'run.consequence_recorded'), 'consequence entry missing');
    assert(timeline.entries.some(entry => entry.type === 'triage.required' && entry.sourceType === 'ticket'), 'ticket triage entry missing');
    assert(timeline.entries.some(entry => entry.type === 'triage.resolved' && entry.runId === 10 && entry.details.statusUnchangedByResolution === true), 'resolved run triage entry missing');
    assert(timeline.entries.some(entry => entry.sourceRole === 'diagnostic_log' && entry.type === 'run:triage_resolve'), 'diagnostic triage log missing');

    const provenance = timeline.entries.find(entry => entry.type === 'ticket.provenance');
    assert(provenance && provenance.details.templateVersion === 2 && provenance.details.triggerType === 'schedule', 'versioned scheduled provenance missing');
    assert(provenance.details.triggerToken === 'schedule:7:2026-03-01T09:00:00.000Z', 'scheduled trigger token missing');

    for (const secret of ['SECRET_FILE_CONTENT', 'SECRET_MUTATION_INPUT', 'PRE_MUTATION_SECRET', 'SECRET_PROVIDER_BODY', 'SECRET_MODEL_RESPONSE', 'SECRET_LOG_CONTENT']) {
      assert(!first.body.includes(secret), `timeline leaked summarized content: ${secret}`);
    }

    const timestamps = timeline.entries.map(entry => entry.timestamp ? Date.parse(entry.timestamp) : 0);
    assert(timestamps.every((value, index) => index === 0 || timestamps[index - 1] <= value), 'timeline order is not deterministic chronological order');
    const second = JSON.parse((await request('GET', '/api/tickets/1/timeline', { cookie: admin })).body);
    assert(JSON.stringify(first && timeline.entries) === JSON.stringify(second.entries), 'repeated timeline projection order/content changed');

    const legacy = JSON.parse((await request('GET', '/api/tickets/2/timeline', { cookie: admin })).body);
    const legacyProvenance = legacy.entries.find(entry => entry.type === 'ticket.provenance');
    assert(legacyProvenance && legacyProvenance.details.legacyUnversioned === true, 'legacy unversioned provenance should render safely');

    const page = await request('GET', '/tickets/1', { cookie: admin });
    const timelineStart = page.body.indexOf('<summary>Timeline');
    assert(page.statusCode === 200 && timelineStart !== -1, 'ticket detail timeline section missing');
    assert(page.body.includes('Authority denied workspace mutation'), 'ticket detail authority entry missing');
    assert(page.body.includes('operation_history') && page.body.includes('embedded_receipt'), 'ticket detail source labels missing');
    const timelineEnd = page.body.indexOf('</details>', timelineStart);
    const timelineSection = timelineEnd !== -1
      ? page.body.slice(timelineStart, timelineEnd + '</details>'.length)
      : page.body.slice(timelineStart);
    assert(!timelineSection.includes('SECRET_FILE_CONTENT') && !timelineSection.includes('PRE_MUTATION_SECRET'), 'ticket timeline leaked source content');

    const after = dataDigest();
    assert(JSON.stringify(after.files) === JSON.stringify(before.files), 'timeline read created or deleted a data file');
    assert(after.hash === before.hash, 'timeline endpoint or page mutated persisted data');
    assert(!after.files.some(file => /timeline/i.test(file)), 'a persisted timeline ledger was created');

    console.log('PASS: ticket timeline is permissioned, deterministic, deduplicated, summarized, and read-only');
  } catch (error) {
    if (output) process.stderr.write(output);
    throw error;
  } finally {
    await stopServer(server);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
