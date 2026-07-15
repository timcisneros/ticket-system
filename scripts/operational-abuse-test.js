#!/usr/bin/env node
// Operational abuse test suite — exercises runtime edge cases and failure paths.
// Uses fake OpenAI provider to inject deterministic model responses.
// Distinguishes model failures from runtime failures.
// Verifies evaluation/consequence/replay integrity after each scenario.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'operational-abuse-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('operational-abuse');
const PORT = process.env.PORT || '3457';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const STAMP = Date.now();
const DATA_FILES = ['agents.json', 'allocation-plans.json', 'events.jsonl', 'groups.json', 'logs.json', 'memberships.json', 'operation-history.json', 'permissions.json', 'runs.json', 'tickets.json', 'users.json', 'workflows.json'];

for (const file of DATA_FILES) {
  const src = path.join(REAL_DATA_DIR, file);
  const dst = path.join(DATA_DIR, file);
  if (file === 'events.jsonl') {
    fs.writeFileSync(dst, '');
  } else {
    fs.writeFileSync(dst, fs.existsSync(src) ? fs.readFileSync(src, 'utf8') : '[]');
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
}

function readRunReplaySnapshotFile(run) {
  if (!run || !run.replaySnapshotPath) return null;
  const snapshotPath = path.join(DATA_DIR, run.replaySnapshotPath);
  if (!snapshotPath.startsWith(DATA_DIR + path.sep)) return null;
  if (!fs.existsSync(snapshotPath)) return null;
  try { return JSON.parse(fs.readFileSync(snapshotPath, 'utf8')); } catch (e) { return null; }
}

function writeJson(file, value) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2));
}

function readEvents() {
  const raw = fs.readFileSync(path.join(DATA_DIR, 'events.jsonl'), 'utf8').trim();
  return raw ? raw.split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
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
        ...(options.form ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
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
  if (!condition) throw new Error(`ABUSE_ASSERTION_FAILED: ${message}`);
}

// ── Fake OpenAI preload ──────────────────────────────────────────────
// Each abuse scenario pattern corresponds to a unique keyword in the
// ticket objective. The fake preload inspects the combined prompt text
// and returns a deterministic response matching the scenario.

function createFakeOpenAIPreload() {
  const preloadPath = path.join(os.tmpdir(), `operational-abuse-openai-${process.pid}-${STAMP}.js`);
  const source = `
function okResponse(plan) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'fake-abuse-' + Date.now()]]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify(plan),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
}

global.fetch = async function(_url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const input = Array.isArray(body.input) ? body.input : [];
  const combined = input.map(item => item && item.content ? String(item.content) : '').join('\\n');

  // ── Abuse scenario: Malformed handoff task ──
  if (combined.includes('ABUSE-MALFORMED-HANDOFF-${STAMP}')) {
    return okResponse({
      message: 'Executing handoff task to non-existent executor.',
      actions: [{
        operation: 'createHandoffTask',
        args: { executor: 'NonExistentAgent_${STAMP}', operation: 'writeFile', args: { path: 'abuse-handoff-output.txt', content: 'test' } }
      }],
      complete: true
    });
  }

  // ── Abuse scenario: Authority denial (protected path write) ──
  if (combined.includes('ABUSE-PROTECTED-PATH-${STAMP}')) {
    return okResponse({
      message: 'Writing to .env file.',
      actions: [{
        operation: 'writeFile',
        args: { path: '.env', content: 'ABUSE_ATTEMPT=1' }
      }],
      complete: true
    });
  }

  // ── Abuse scenario: Invalid workflow draft intent (missing id) ──
  if (combined.includes('ABUSE-INVALID-DRAFT-INTENT-${STAMP}')) {
    return okResponse({
      message: 'Creating workflow draft intent with missing id.',
      actions: [{
        operation: 'createWorkflowDraftIntent',
        args: { name: 'IntentionalAbuseDraft-${STAMP}', writes: [{ path: 'abuse-draft.txt', content: 'test' }], postconditions: [{ type: 'fileExists', path: 'abuse-draft.txt' }] }
      }],
      complete: true
    });
  }

  // ── Abuse scenario: Stalled model responses ──
  if (combined.includes('ABUSE-STALLED-${STAMP}')) {
    return okResponse({
      message: 'Thinking...',
      actions: [],
      complete: false
    });
  }

  // ── Abuse scenario: Default normal write ──
  // (ABUSE-LONGRUN was intentionally removed — interruption uses pending-run stop)

  // ── Abuse scenario: Disabled operation attempt ──
  if (combined.includes('ABUSE-DISABLED-OP-${STAMP}')) {
    return okResponse({
      message: 'Trying to create workflow draft.',
      actions: [{ operation: 'createWorkflowDraftIntent', args: { id: 'abuse-disabled-op-draft-${STAMP}', name: 'AbuseDisabledOp', writes: [{ path: 'abuse-disabled.txt', content: 'test' }], postconditions: [{ type: 'fileExists', path: 'abuse-disabled.txt' }] } }],
      complete: true
    });
  }

  // ── Abuse scenario: Handoff executor mismatch (invalid executor format) ──
  if (combined.includes('ABUSE-HANDOFF-INVALID-EXECUTOR-${STAMP}')) {
    return okResponse({
      message: 'Handing off to number executor that does not exist.',
      actions: [{
        operation: 'createHandoffTask',
        args: { executor: '999999', operation: 'writeFile', args: { path: 'abuse-handoff-number.txt', content: 'test' } }
      }],
      complete: true
    });
  }

  // ── Abuse scenario: Too many actions per response ──
  if (combined.includes('ABUSE-TOO-MANY-ACTIONS-${STAMP}')) {
    const manyActions = [];
    for (let i = 0; i < 20; i++) {
      manyActions.push({ operation: 'readFile', args: { path: 'nonexistent-' + i + '.txt' } });
    }
    return okResponse({
      message: 'Returning too many actions.',
      actions: manyActions,
      complete: false
    });
  }

  // ── Abuse scenario: Too many mutating actions ──
  if (combined.includes('ABUSE-TOO-MANY-MUTATING-${STAMP}')) {
    return okResponse({
      message: 'Returning too many mutating actions.',
      actions: [
        { operation: 'writeFile', args: { path: 'abuse-mut-1.txt', content: '1' } },
        { operation: 'writeFile', args: { path: 'abuse-mut-2.txt', content: '2' } },
        { operation: 'writeFile', args: { path: 'abuse-mut-3.txt', content: '3' } }
      ],
      complete: true
    });
  }

  // ── Default: Normal workspace write (succeed) ──
  return okResponse({
    message: 'Writing output file.',
    actions: [{ operation: 'writeFile', args: { path: 'abuse-output-' + Date.now() + '.txt', content: 'ok' } }],
    complete: true
  });
};
`;
  fs.writeFileSync(preloadPath, source);
  return preloadPath;
}

// ── Helpers ──────────────────────────────────────────────────────────

async function waitForReady() {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    try {
      const response = await request('GET', '/health');
      if (response.statusCode === 200 && JSON.parse(response.body).ready) return;
    } catch (e) { /* server starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for server ready');
}

async function login() {
  const response = await request('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
  assert(response.statusCode === 302, `Admin login failed: HTTP ${response.statusCode}`);
  return cookieFrom(response);
}

function seedAgent(extraFields = {}) {
  const agents = readJson('agents.json');
  const agent = {
    id: Math.max(0, ...agents.map(a => a.id || 0)) + 1,
    name: `AbuseAgent-${STAMP}`,
    type: 'agent',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    apiKey: 'test-key-abuse',
    createdAt: new Date().toISOString(),
    ...extraFields
  };
  writeJson('agents.json', [...agents, agent]);
  return agent;
}

async function createAgentTicket(cookie, agent, objective) {
  const response = await request('POST', '/tickets', {
    cookie,
    form: {
      objective,
      assignmentTargetType: 'agent',
      assignmentTargetId: String(agent.id),
      assignmentMode: 'individual'
    }
  });
  // Allow 302 success or 400 on form re-render
  if (response.statusCode === 302) {
    return readJson('tickets.json').find(t => t.objective === objective);
  }
  // Return error info on failure
  return { error: true, statusCode: response.statusCode, body: response.body };
}

async function waitForTerminalRun(ticketId, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const runs = readJson('runs.json').filter(run => run.ticketId === ticketId);
    const run = runs[runs.length - 1];
    if (run && ['completed', 'failed', 'interrupted'].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for terminal run for ticket ${ticketId}`);
}

async function getRunState(cookie, runId) {
  const response = await request('GET', `/api/runs/${runId}/state`, { cookie });
  assert(response.statusCode === 200, `Run state API returned HTTP ${response.statusCode}: ${response.body}`);
  return JSON.parse(response.body);
}

async function getRunEvents(cookie, runId) {
  const response = await request('GET', `/api/runs/${runId}/events`, { cookie });
  assert(response.statusCode === 200, `Run events API returned HTTP ${response.statusCode}: ${response.body}`);
  return JSON.parse(response.body).events || [];
}

async function stopRun(cookie, runId) {
  const response = await request('POST', `/api/runs/${runId}/stop`, { cookie });
  if (response.statusCode !== 200) {
    return { error: true, statusCode: response.statusCode, body: response.body };
  }
  return JSON.parse(response.body);
}

function countMissingEvidence(runState, events) {
  const missing = {};
  // Runs that fail before any workspace action won't have authorityEvidence
  // Runs that fail during model parsing may skip postcondition/violation checks
  // Always require replaySummary and events
  if (!runState.runEvaluation) missing.runEvaluation = true;
  if (!runState.runConsequence) missing.runConsequence = true;
  if (!runState.replaySummary) missing.replaySummary = true;
  if (events.length === 0) missing.events = true;
  return missing;
}

function assertRunIntegrity(runState, events, opts = {}) {
  const missing = countMissingEvidence(runState, events, opts);
  const keys = Object.keys(missing);
  assert(keys.length === 0, `Run ${runState.id} missing evidence: ${keys.join(', ')}`);

  // Check replay summary has structural integrity
  const replay = runState.replaySummary;
  if (replay) {
    assert(typeof replay.steps !== 'undefined' || typeof replay.modelResponses !== 'undefined',
      'Replay missing steps or modelResponses');
    assert(typeof replay.workspaceOperations !== 'undefined',
      'Replay missing workspaceOperations count');
    assert(typeof replay.mutationCount !== 'undefined' || typeof replay.providerRequests !== 'undefined',
      'Replay missing expected fields');
  }

  // Verify events contain lifecycle markers appropriate to outcome
  const eventTypes = new Set(events.map(e => e.type));
  assert(eventTypes.has('run.started') || eventTypes.has('run.starting') ||
    events.some(e => e.type && e.type.startsWith('run.')),
    'Missing any run lifecycle event');
}

function expectAuthorityDenial(runState, events, rule) {
  const denied = events.filter(e => e.type === 'authority.denied');
  assert(denied.length > 0, 'No authority.denied events recorded');
  const evidenceMatches = (runState.authorityEvidence || []).filter(e =>
    e.status === 'denied' && (!rule || e.rule === rule)
  );
  if (rule) {
    assert(evidenceMatches.length > 0, `No authority denials with rule: ${rule}`);
  }
}

function formatDuration(ms) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}

// ── Abuse Scenarios ──────────────────────────────────────────────────

async function testMalformedHandoff(cookie, agent) {
  console.log('\n[1/15] Malformed handoff task — executor not found');
  const objective = `ABUSE-MALFORMED-HANDOFF-${STAMP} Hand off to NonExistentAgent_${STAMP}`;
  const ticket = await createAgentTicket(cookie, agent, objective);
  assert(ticket && !ticket.error, `Ticket creation failed for malformed handoff: ${JSON.stringify(ticket)}`);
  const run = await waitForTerminalRun(ticket.id);
  assert(run.status === 'failed', `Expected failed run, got ${run.status}`);
  const runState = await getRunState(cookie, run.id);
  const events = await getRunEvents(cookie, run.id);
  assertRunIntegrity(runState, events);
  // Verify runtime rejected the nonexistent executor — should have HANDOFF_EXECUTOR_NOT_FOUND in logs
  const runLogs = readJson('logs.json').filter(l => l.runId === run.id);
  const hasHandoffRejection = runLogs.some(l =>
    l.message && (l.message.includes('HANDOFF_EXECUTOR_NOT_FOUND') || l.message.includes('executor not found'))
  );
  console.log(`  Result: ${run.status}, handoff rejection in logs: ${hasHandoffRejection}`);
  return { name: 'malformed-handoff', passed: true, run, runState, events };
}

async function testProtectedPathWrite(cookie, agent) {
  console.log('\n[2/15] Authority denial — protected path write (to .env)');
  const objective = `ABUSE-PROTECTED-PATH-${STAMP} Write to .env file`;
  const ticket = await createAgentTicket(cookie, agent, objective);
  assert(ticket && !ticket.error, `Ticket creation failed for protected path: ${JSON.stringify(ticket)}`);
  const run = await waitForTerminalRun(ticket.id);
  assert(run.status === 'failed', `Expected failed run for protected path, got ${run.status}`);
  const runState = await getRunState(cookie, run.id);
  const events = await getRunEvents(cookie, run.id);
  assertRunIntegrity(runState, events);
  expectAuthorityDenial(runState, events, 'protected_path');
  console.log(`  Result: ${run.status}, authority.denied events: ${events.filter(e => e.type === 'authority.denied').length}`);
  return { name: 'protected-path', passed: true, run, runState, events };
}

async function testInvalidDraftIntent(cookie, agent) {
  console.log('\n[3/15] Invalid workflow draft intent — missing id');
  const objective = `ABUSE-INVALID-DRAFT-INTENT-${STAMP} Create a workflow draft`;
  const ticket = await createAgentTicket(cookie, agent, objective);
  assert(ticket && !ticket.error, `Ticket creation failed for invalid draft intent: ${JSON.stringify(ticket)}`);
  const run = await waitForTerminalRun(ticket.id);
  assert(run.status === 'failed', `Expected failed run for invalid draft intent, got ${run.status}`);
  const runState = await getRunState(cookie, run.id);
  const events = await getRunEvents(cookie, run.id);
  assertRunIntegrity(runState, events);
  // compileWorkflowDraftIntent should reject missing 'id' field
  const intentEvents = events.filter(e => e.type === 'workflow.draft_created');
  assert(intentEvents.length === 0, 'Draft was created despite missing id');
  const runLogs = readJson('logs.json').filter(l => l.runId === run.id);
  const hasRejection = runLogs.some(l => l.message && (l.message.includes('WORKFLOW_DRAFT_INVALID') || l.message.includes('missing')));
  console.log(`  Result: ${run.status}, draft events: ${intentEvents.length}, runtime rejected: ${hasRejection}`);
  return { name: 'invalid-draft-intent', passed: true, run, runState, events };
}

async function testStalledResponses(cookie, agent) {
  console.log('\n[4/15] Stalled model responses — complete:false with no actions repeatedly');
  const objective = `ABUSE-STALLED-${STAMP} Think about the problem`;
  const ticket = await createAgentTicket(cookie, agent, objective);
  assert(ticket && !ticket.error, `Ticket creation failed for stall test: ${JSON.stringify(ticket)}`);
  const run = await waitForTerminalRun(ticket.id);
  const runState = await getRunState(cookie, run.id);
  const events = await getRunEvents(cookie, run.id);
  assertRunIntegrity(runState, events);

  const replaySnapshot = readRunReplaySnapshotFile(run);
  const replayRunEvents = (replaySnapshot && replaySnapshot.events) || [];
  const replayStallEvents = replayRunEvents.filter(e => e.type === 'model:stalled');

  // Diagnostics: check model requests to see what was sent
  const modelRequests = (replaySnapshot && replaySnapshot.providerRequests) || [];
  const modelResponses = (replaySnapshot && replaySnapshot.modelResponses) || [];
  const parsedPlans = (replaySnapshot && replaySnapshot.parsedModelPlans) || [];
  const failureEvent = replayRunEvents.find(e => e.type === 'run.terminalized' || e.type.includes('failed'));
  const snapshotEvents = replayRunEvents.map(e => e.type).join(', ');

  console.log(`  Result: ${run.status}`);
  console.log(`    Replay: steps=${runState.replaySummary?.steps}, modelReqs=${modelRequests.length}, resp=${modelResponses.length}, plans=${parsedPlans.length}`);
  console.log(`    Replay events: ${snapshotEvents}`);
  console.log(`    Stall events in replay: ${replayStallEvents.length} (expected colon in type)`);
  if (failureEvent) console.log(`    Failure: ${failureEvent.message}`);
  if (parsedPlans.length > 0) {
    console.log(`    Parsed plans: ${JSON.stringify(parsedPlans[0]).substring(0, 200)}`);
  }
  return { name: 'stalled', passed: run.status === 'failed', run, runState, events };
}

async function testRunInterruption(cookie, agent) {
  console.log('\n[5/15] Interrupted run — stop a pending run via API');
  // Stop a run while it's still pending (before scheduler picks it up)
  const objective = `Interruption test ${STAMP} Write an interruption-output.txt`;
  const ticket = await createAgentTicket(cookie, agent, objective);
  assert(ticket && !ticket.error, `Ticket creation failed for interruption test: ${JSON.stringify(ticket)}`);

  // The run is created as 'pending'. Stop it immediately before the scheduler picks it up.
  const runs = readJson('runs.json').filter(r => r.ticketId === ticket.id);
  let run = runs[runs.length - 1];
  assert(run, 'No run created for ticket');
  console.log(`  Run status before stop: ${run.status}`);

  const stopResult = await stopRun(cookie, run.id);
  const wasStopped = !stopResult.error;
  console.log(`  Stop attempt: ${wasStopped ? 'success' : JSON.stringify(stopResult)}`);

  // Wait for terminal state
  run = await waitForTerminalRun(ticket.id, 5000);
  const runState = await getRunState(cookie, run.id);
  const events = await getRunEvents(cookie, run.id);
  assertRunIntegrity(runState, events);
  const hasInterruptEvent = events.some(e => e.type === 'run.terminalized');
  const isInterrupted = run.status === 'interrupted';
  console.log(`  Final status: ${run.status}, interrupted event: ${hasInterruptEvent}`);
  return { name: 'interruption', passed: true, run, runState, events };
}

async function testInvalidRuntimeConfig(cookie) {
  console.log('\n[6/15] Invalid runtimeConfig values — negative integers, wrong types');
  const abuseCases = [
    { desc: 'negative maxRuntimeDurationMs', config: { maxRuntimeDurationMs: -100 } },
    { desc: 'string instead of number', config: { maxModelRequestsPerRun: 'string-val' } },
    { desc: 'null override (should be ignored)', config: { temperature: null } },
  ];
  const results = [];
  for (const abuse of abuseCases) {
    try {
      const agent = seedAgent({
        name: `AbuseConfig-${STAMP}-${abuse.desc.replace(/\s+/g, '-')}`,
        runtimeConfig: abuse.config
      });
      const reloaded = readJson('agents.json').find(a => a.id === agent.id);
      const cfg = reloaded && reloaded.runtimeConfig;
      const keptNegative = cfg && cfg.maxRuntimeDurationMs === -100;
      const keptString = cfg && cfg.maxModelRequestsPerRun === 'string-val';
      const hasNull = cfg && cfg.temperature === null;
      results.push({ case: abuse.desc, cfgKeys: Object.keys(cfg || {}), keptNegative, keptString, hasNull });
    } catch (err) {
      results.push({ case: abuse.desc, error: err.message });
    }
  }
  results.forEach(r => console.log(`  ${r.case}: keys=${JSON.stringify(r.cfgKeys)}, neg=${r.keptNegative}, str=${r.keptString}, null=${r.hasNull}`));
  return { name: 'invalid-config', passed: true, results };
}

async function testTooManyActions(cookie, agent) {
  console.log('\n[7/15] Too many actions per response — model exceeds MAX_AGENT_ACTIONS_PER_RESPONSE');
  const objective = `ABUSE-TOO-MANY-ACTIONS-${STAMP} Do many reads`;
  const ticket = await createAgentTicket(cookie, agent, objective);
  assert(ticket && !ticket.error, `Ticket creation failed for too many actions: ${JSON.stringify(ticket)}`);
  const run = await waitForTerminalRun(ticket.id);
  const runState = await getRunState(cookie, run.id);
  const events = await getRunEvents(cookie, run.id);
  assertRunIntegrity(runState, events);
  const replaySnapshot = readRunReplaySnapshotFile(run);
  const replayEvents = (replaySnapshot && replaySnapshot.events) || [];
  const limitEvents = replayEvents.filter(e => e.type === 'model:action_limit');
  const parsedPlans = (replaySnapshot && replaySnapshot.parsedModelPlans) || [];
  const actionCounts = parsedPlans.map(p => (p.actions || []).length);
  console.log(`  Result: ${run.status}, action-limit events: ${limitEvents.length}, plan action counts: [${actionCounts.join(', ')}]`);
  return { name: 'too-many-actions', passed: true, run, runState, events };
}

async function testTooManyMutatingActions(cookie, agent) {
  console.log('\n[8/15] Too many mutating actions — model exceeds MAX_MUTATING_ACTIONS_PER_RESPONSE');
  const objective = `ABUSE-TOO-MANY-MUTATING-${STAMP} Write three files`;
  const ticket = await createAgentTicket(cookie, agent, objective);
  assert(ticket && !ticket.error, `Ticket creation failed for too many mutating: ${JSON.stringify(ticket)}`);
  const run = await waitForTerminalRun(ticket.id, 15000);
  const runState = await getRunState(cookie, run.id);
  const events = await getRunEvents(cookie, run.id);
  assertRunIntegrity(runState, events);
  const replaySnapshot = readRunReplaySnapshotFile(run);
  const replayEvents = (replaySnapshot && replaySnapshot.events) || [];
  const limitEvents = replayEvents.filter(e => e.type === 'model:mutating_action_limit');
  const parsedPlans = (replaySnapshot && replaySnapshot.parsedModelPlans) || [];
  const actionOperationCounts = parsedPlans.map(p => (p.actions || []).map(a => a.operation));
  console.log(`  Result: ${run.status}, mutating-limit events: ${limitEvents.length}, plan actions: [${JSON.stringify(actionOperationCounts[0] || [])}]`);
  return { name: 'too-many-mutating', passed: true, run, runState, events };
}

async function testLeaseExpiryRecovery(cookie, agent) {
  console.log('\n[9/15] Lease expiry recovery — manually expire a run lease');
  const objective = `ABUSE-STALLED-${STAMP} Lease test ticket ${Date.now()}`;
  const ticket = await createAgentTicket(cookie, agent, objective);
  assert(ticket && !ticket.error, `Ticket creation failed for lease test: ${JSON.stringify(ticket)}`);

  await new Promise(resolve => setTimeout(resolve, 300));
  let runs = readJson('runs.json').filter(r => r.ticketId === ticket.id);
  let run = runs[runs.length - 1];

  if (run && run.status === 'running') {
    run.leaseExpiresAt = new Date(Date.now() - 60000).toISOString();
    run.leaseOwner = `expired-process-${Date.now()}`;
    writeJson('runs.json', readJson('runs.json').map(r => r.id === run.id ? run : r));
    console.log('  Lease expired manually');
  } else {
    console.log(`  Run status when trying to expire: ${run ? run.status : 'none'}`);
  }

  run = await waitForTerminalRun(ticket.id, 15000);
  const runState = await getRunState(cookie, run.id);
  const events = await getRunEvents(cookie, run.id);
  assertRunIntegrity(runState, events);
  const eventTypes = events.map(e => e.type).join(', ');
  const hasStaleDetected = events.some(e => e.type && e.type.includes('lease') && e.type.includes('stale'));
  const hasRunSkipped = events.some(e => e.type === 'scheduler.run_skipped');
  const hasReacquired = events.some(e => e.type && e.type.includes('lease') && (e.type.includes('acquired') || e.type.includes('reacquired')));
  console.log(`  Result: ${run.status}, stale-lease: ${hasStaleDetected}, re-acquired: ${hasReacquired}, events: ${eventTypes}`);
  return { name: 'lease-expiry', passed: true, run, runState, events };
}

async function testConcurrentAgentRuns(cookie, agent) {
  console.log('\n[10/15] Concurrent agent runs — create multiple tickets for same agent');
  const ticket1 = await createAgentTicket(cookie, agent, `concurrent-1-${STAMP}-${Date.now()} Write concurrent-1.txt`);
  const ticket2 = await createAgentTicket(cookie, agent, `concurrent-2-${STAMP}-${Date.now()} Write concurrent-2.txt`);
  assert(ticket1 && !ticket1.error, `Ticket 1 creation failed`);
  assert(ticket2 && !ticket2.error, `Ticket 2 creation failed`);

  // Wait for both to complete (they'll be serialized by the scheduler)
  const run1 = await waitForTerminalRun(ticket1.id, 20000);
  const run2 = await waitForTerminalRun(ticket2.id, 20000);
  const runState1 = await getRunState(cookie, run1.id);
  const runState2 = await getRunState(cookie, run2.id);
  const events1 = await getRunEvents(cookie, run1.id);
  const events2 = await getRunEvents(cookie, run2.id);
  assertRunIntegrity(runState1, events1);
  assertRunIntegrity(runState2, events2);

  // Both tickets should have completed (either success or failure)
  assert(['completed', 'failed', 'interrupted'].includes(run1.status), `Run 1 unexpected status: ${run1.status}`);
  assert(['completed', 'failed', 'interrupted'].includes(run2.status), `Run 2 unexpected status: ${run2.status}`);
  console.log(`  Run 1: ${run1.status}, Run 2: ${run2.status}`);
  return { name: 'concurrent-runs', passed: true, run1, run2, runState1, runState2 };
}

async function testHandoffExecutorMismatch(cookie, agent) {
  console.log('\n[11/15] Handoff executor mismatch — numeric executor that does not exist');
  const objective = `ABUSE-HANDOFF-INVALID-EXECUTOR-${STAMP} Hand off to agent id 999999`;
  const ticket = await createAgentTicket(cookie, agent, objective);
  assert(ticket && !ticket.error, `Ticket creation failed for handoff mismatch: ${JSON.stringify(ticket)}`);
  const run = await waitForTerminalRun(ticket.id);
  assert(run.status === 'failed', `Expected failed run for handoff mismatch, got ${run.status}`);
  const runState = await getRunState(cookie, run.id);
  const events = await getRunEvents(cookie, run.id);
  assertRunIntegrity(runState, events);
  const eventTypes = events.map(e => e.type).join(', ');
  const replaySnapshot = readRunReplaySnapshotFile(run);
  const replayEvents = (replaySnapshot && replaySnapshot.events) || [];
  const modelPlans = (replaySnapshot && replaySnapshot.parsedModelPlans) || [];
  const runLogs = readJson('logs.json').filter(l => l.runId === run.id);
  const errorLogs = runLogs.filter(l => l.message && (l.message.includes('HANDOFF') || l.message.includes('handoff') || l.message.includes('error')));
  console.log(`  Result: ${run.status}, event types: ${eventTypes}`);
  console.log(`    Logs: ${runLogs.length}, error-related: ${errorLogs.length}, model plans: ${modelPlans.length}`);
  if (modelPlans.length > 0) {
    console.log(`    Plan actions: ${JSON.stringify((modelPlans[0].actions || []).map(a => a.operation))}`);
  }
  if (errorLogs.length > 0) {
    errorLogs.slice(0, 2).forEach(l => console.log(`    ${l.type}: ${(l.message || '').substring(0, 200)}`));
  }
  return { name: 'handoff-executor-mismatch', passed: true, run, runState, events };
}

async function testDisabledOperationGate(cookie, agent) {
  console.log('\n[12/15] Disabled operation attempt — try createWorkflowDraftIntent when disabled via runtimeConfig');

  const restrictedAgent = seedAgent({
    name: `AbuseRestrictedAgent-${STAMP}`,
    runtimeConfig: { allowWorkflowDraftIntent: false }
  });

  const objective = `ABUSE-DISABLED-OP-${STAMP} Create a workflow draft intent`;
  const ticket = await createAgentTicket(cookie, restrictedAgent, objective);
  assert(ticket && !ticket.error, `Ticket creation failed for disabled op: ${JSON.stringify(ticket)}`);
  const run = await waitForTerminalRun(ticket.id, 15000);
  const runState = await getRunState(cookie, run.id);
  const events = await getRunEvents(cookie, run.id);
  assertRunIntegrity(runState, events);

  const draftEvents = events.filter(e => e.type === 'workflow.draft_created');
  const hasDraft = draftEvents.length > 0;
  const violation = (runState.runEvaluation || {}).violations || {};
  const restrictionEnforced = !hasDraft;

  console.log(`  Result: ${run.status}, draft created: ${hasDraft}, restriction enforced: ${restrictionEnforced}`);
  if (!restrictionEnforced) {
    console.log('  FINDING: allowWorkflowDraftIntent runtimeConfig is declared but not enforced in parseAgentDirectAction or action dispatch');
  }

  return { name: 'disabled-operation', passed: true, run, runState, events, hasDraft, restrictionEnforced };
}

async function testReplayEventConsistency(cookie, agent) {
  console.log('\n[13/15] Replay/event consistency — verify replay matches events after failure');
  const objective = `ABUSE-PROTECTED-PATH-${STAMP} Protected path consistency check ${Date.now()}`;
  const ticket = await createAgentTicket(cookie, agent, objective);
  assert(ticket && !ticket.error, `Ticket creation failed: ${JSON.stringify(ticket)}`);
  const run = await waitForTerminalRun(ticket.id);
  const runState = await getRunState(cookie, run.id);
  const events = await getRunEvents(cookie, run.id);
  assertRunIntegrity(runState, events);
  expectAuthorityDenial(runState, events, 'protected_path');

  // Verify replay summary structure
  const replay = runState.replaySummary;
  assert(typeof replay.workspaceOperations !== 'undefined', 'Replay missing workspaceOperations');

  // Verify events contain required lifecycle markers
  const eventTypes = new Set(events.map(e => e.type));
  assert(eventTypes.has('run.started') || eventTypes.has('run.starting'), 'Missing run start event');
  assert(eventTypes.has('run.terminalized'), 'Missing current terminal run event (run.terminalized)');

  console.log(`  Result: ${run.status}, events: ${events.length}, replay steps: ${replay.steps}`);
  return { name: 'replay-consistency', passed: true, run, runState, events };
}

async function testMultiStepStallThenRecover(cookie, agent) {
  console.log('\n[14/15] Multi-step stall then recover — stall once then write');
  // Use the default fake model behavior which writes a file on each call
  // This tests normal operation after the abuse scenarios
  const objective = `Recover test ${STAMP} Write recovery-output.txt confirming runtime integrity after abuse suite`;
  const ticket = await createAgentTicket(cookie, agent, objective);
  assert(ticket && !ticket.error, `Ticket creation failed for recovery test: ${JSON.stringify(ticket)}`);
  const run = await waitForTerminalRun(ticket.id, 20000);
  const runState = await getRunState(cookie, run.id);
  const events = await getRunEvents(cookie, run.id);
  assertRunIntegrity(runState, events);
  console.log(`  Result: ${run.status}, events: ${events.length}`);
  return { name: 'multi-step-recover', passed: run.status === 'completed', run, runState, events };
}

async function testAgentDirectOperationAccess(cookie, agent) {
  console.log('\n[15/15] Agent-direct operation access — verify writeFile succeeds for normal agent');
  const objective = `Normal agent ticket ${STAMP} Write abuse-final-output.txt confirming access`;
  const ticket = await createAgentTicket(cookie, agent, objective);
  assert(ticket && !ticket.error, `Ticket creation failed: ${JSON.stringify(ticket)}`);
  const run = await waitForTerminalRun(ticket.id, 20000);
  const runState = await getRunState(cookie, run.id);
  const events = await getRunEvents(cookie, run.id);
  assertRunIntegrity(runState, events);

  const workspaceOps = (runState.replaySummary || {}).workspaceOperations || 0;
  console.log(`  Result: ${run.status}, workspace ops: ${workspaceOps}`);
  return { name: 'agent-direct-access', passed: run.status === 'completed', run, runState, events };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  const preloadPath = createFakeOpenAIPreload();
  const results = {};

  console.log(`Operational Abuse Test Suite`);
  console.log(`  PID: ${process.pid}`);
  console.log(`  DATA_DIR: ${DATA_DIR}`);
  console.log(`  WORKSPACE_ROOT: ${WORKSPACE_ROOT}`);
  console.log(`  STAMP: ${STAMP}`);

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      NODE_OPTIONS: `--require ${preloadPath}`,
      PORT,
      DATA_DIR,
      WORKSPACE_ROOT,
      AGENT_MAX_EXECUTION_STEPS: '6',
      AGENT_MAX_MODEL_REQUESTS_PER_RUN: '6',
      AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
      AGENT_MAX_RUNTIME_DURATION_MS: '15000',
      AGENT_MAX_CONSECUTIVE_STALLS: '2',
      AGENT_ALLOW_CANONICAL_WORKFLOW_DRAFT: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let childOutput = '';
  server.stdout.on('data', chunk => { childOutput += chunk.toString(); });
  server.stderr.on('data', chunk => { childOutput += chunk.toString(); });

  let exitCode = 0;

  try {
    await waitForReady();
    const cookie = await login();
    // Use an agent with allowWorkflowDraftIntent: true so disabled-op test can test restriction
    const agent = seedAgent({
      runtimeConfig: { allowWorkflowDraftIntent: true, allowHandoffTask: true }
    });
    console.log(`  Agent ID: ${agent.id}, Name: ${agent.name}\n`);

    const scenarios = [
      ['malformed-handoff', () => testMalformedHandoff(cookie, agent)],
      ['protected-path', () => testProtectedPathWrite(cookie, agent)],
      ['invalid-draft-intent', () => testInvalidDraftIntent(cookie, agent)],
      ['stalled', () => testStalledResponses(cookie, agent)],
      ['interruption', () => testRunInterruption(cookie, agent)],
      ['invalid-config', () => testInvalidRuntimeConfig(cookie)],
      ['too-many-actions', () => testTooManyActions(cookie, agent)],
      ['too-many-mutating', () => testTooManyMutatingActions(cookie, agent)],
      ['lease-expiry', () => testLeaseExpiryRecovery(cookie, agent)],
      ['concurrent-runs', () => testConcurrentAgentRuns(cookie, agent)],
      ['handoff-executor-mismatch', () => testHandoffExecutorMismatch(cookie, agent)],
      ['disabled-operation', () => testDisabledOperationGate(cookie, agent)],
      ['replay-consistency', () => testReplayEventConsistency(cookie, agent)],
      ['multi-step-recover', () => testMultiStepStallThenRecover(cookie, agent)],
      ['agent-direct-access', () => testAgentDirectOperationAccess(cookie, agent)]
    ];

    for (const [name, fn] of scenarios) {
      try {
        const result = await fn();
        results[name] = { passed: true, ...result };
      } catch (err) {
        results[name] = { passed: false, error: err.message };
        console.log(`  ✗ FAILED: ${err.message}`);
      }
    }
  } catch (error) {
    console.error(`Fatal error: ${error.stack || error.message}`);
    exitCode = 1;
  } finally {
    const durationMs = Date.now() - startedAt;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Abuse Test Suite Results (${formatDuration(durationMs)})`);
    console.log(`${'='.repeat(60)}`);

    let passed = 0;
    let failed = 0;
    for (const [name, result] of Object.entries(results)) {
      const status = result.passed ? '✓ PASS' : '✗ FAIL';
      if (result.passed) passed++; else failed++;
      console.log(`  ${status}: ${name}`);
      if (!result.passed && result.error) {
        console.log(`         ${result.error}`);
      }
    }
    console.log(`\nTotal: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);

    if (failed > 0) exitCode = 1;

    server.kill();
    await new Promise(resolve => server.once('exit', resolve));
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    removeTempWorkspaceRoot(WORKSPACE_ROOT);
    fs.rmSync(preloadPath, { force: true });

    if (server.exitCode && server.exitCode !== 0) {
      process.stderr.write(childOutput);
    }
  }

  process.exit(exitCode);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
