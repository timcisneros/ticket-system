#!/usr/bin/env node
'use strict';
// Integration test for execution-semantics persistence and historical provenance.
//
// Real server + real PostgreSQL store (isolated schema) + mock ollama. Covers the
// complete production path that focused tests cannot reach:
//
//   dispatch resolution → run creation → persistence → reload → authority
//   rendering → diagnostic-bundle generation
//
// Proves, in order:
//   0. The feasibility gate's durable decision is written through real dispatch,
//      to BOTH the replay snapshot and the event journal, with matching payloads.
//      The focused test covers all six outcome paths against stubs; this proves
//      the async gate wiring and evidence persistence work in production.
//   1. A run created through the REAL ticket-dispatch path (POST /tickets →
//      createRunsForTicket → resolveAgentRuntimeLimits) persists
//      runtimeLimitsSnapshot.semantics.
//   2. Every required semantic control survives a reload from storage, read
//      through a FRESH store connection rather than the in-memory run object.
//   3. After the server is restarted with DIFFERENT live per-response defaults,
//      the historical run's authority block and diagnostic bundle still report
//      the values recorded at run start — the new environment value appears
//      nowhere in that run's rendering.
//   4. A legacy run with no semantics but a recorded runtimeEnvelope falls back
//      to that historical envelope, labelled as such.
//   5. A legacy run with neither is explicitly labelled unrecorded, with the
//      remaining controls described as not reconstructable rather than inferred.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');
const { currentRuntimeLimitsSnapshot } = require('./current-run-fixture');
const { allocateTestPort } = require('./test-port');

const DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('TEST_DATABASE_URL (or DATABASE_URL) is required for the execution-semantics persistence test');
  process.exit(1);
}

const SCHEMA = `exec_semantics_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
let PORT = null;
let BASE = null;
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-semantics-ws-'));

// Run-start defaults, then a deliberately different value after the restart. The
// second value must never appear in the first run's rendering.
const MUTATING_AT_RUN_START = '2';
const MUTATING_AFTER_CHANGE = '7';

const REQUIRED_CONTROLS = [
  'prefixTruncationEnabled',
  'contractCompilerEnabled',
  'actionContractViolationThreshold',
  'stalledResponseThreshold',
  'inspectionNoProgressThreshold',
  'workspaceSnapshotMaxEntries',
  'maxActionsPerResponse',
  'maxMutatingActionsPerResponse'
];

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
  console.log(`  ok ${message}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Mock ollama that immediately completes with no actions, so a real dispatched
// run terminates quickly. This test is about what the run RECORDS, not what it does.
function startMockProvider() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/api/chat')) { res.writeHead(404); res.end(); return; }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        model: 'mock-model', done: true, done_reason: 'stop',
        created_at: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: JSON.stringify({ message: 'Nothing to do', actions: [], complete: true })
        },
        eval_count: 4, prompt_eval_count: 10, total_duration: 1000
      }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function request(method, urlPath, { form = null, cookie = null } = {}) {
  const body = form ? new URLSearchParams(form).toString() : null;
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${urlPath}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(cookie ? { Cookie: cookie } : {})
      }
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function startServer(mutatingLimit, providerUrl) {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test', DATABASE_URL, POSTGRES_SCHEMA: SCHEMA,
      SESSION_SECRET: 'exec-semantics-session-secret-0123456789abcdef0123456789abcdef',
      ADMIN_BOOTSTRAP_PASSWORD: 'admin123', PORT, WORKSPACE_ROOT,
      OLLAMA_BASE_URL: providerUrl,
      AGENT_MAX_MUTATING_ACTIONS_PER_RESPONSE: mutatingLimit,
      RUN_LEASE_DURATION_MS: '60000',
      TEST_SKIP_STARTUP_RUN_RECOVERY: 'true',
      RUNTIME_SCHEDULER_INTERVAL_MS: '200',
      PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS: '3600000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  server.stdout.on('data', c => { out += c; });
  server.stderr.on('data', c => { out += c; });
  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null) throw new Error('server exited:\n' + out.slice(-3000));
    try { if ((await request('GET', '/login')).statusCode === 200) return { server, out: () => out }; } catch (_) {}
    await sleep(400);
  }
  throw new Error('server did not start:\n' + out.slice(-3000));
}

async function stopServer(handle) {
  if (!handle) return;
  handle.server.kill('SIGTERM');
  for (let i = 0; i < 40 && handle.server.exitCode === null; i++) await sleep(200);
  if (handle.server.exitCode === null) handle.server.kill('SIGKILL');
  await sleep(500);
}

async function login() {
  const response = await request('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
  if (response.statusCode !== 302) throw new Error(`login returned HTTP ${response.statusCode}`);
  const raw = response.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map(c => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('login returned no session cookie');
  return cookie;
}

function decodeHtml(value) {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

// The bundle is rendered into the run-detail page; pulling it from there proves
// the real generator ran, not a re-implementation of it.
function extractBundle(html) {
  const match = html.match(/<textarea id="run-diagnostics-bundle"[^>]*>([\s\S]*?)<\/textarea>/);
  if (!match) throw new Error('run diagnostic bundle textarea not found in run detail page');
  return decodeHtml(match[1]);
}

function bundleValue(bundle, label) {
  const match = bundle.match(new RegExp(`^- ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: (.*)$`, 'm'));
  return match ? match[1].trim() : null;
}

function extractSection(bundle, heading) {
  const start = bundle.indexOf(heading);
  if (start === -1) throw new Error(`bundle section not found: ${heading}`);
  const rest = bundle.slice(start + heading.length);
  const next = rest.search(/\n#{2,3} /);
  return next === -1 ? rest : rest.slice(0, next);
}

async function main() {
  // OS-allocated ephemeral port: see scripts/test-port.js. Fixed or pid-derived
  // ports collided across suites and surfaced as a misleading start failure.
  PORT = String(await allocateTestPort());
  BASE = `http://127.0.0.1:${PORT}`;
  const store = new PostgresRuntimeStore({ connectionString: DATABASE_URL, schema: SCHEMA, disposableMigrations: true });
  await store.migrate();
  const provider = await startMockProvider();
  let handle = null;

  try {
    // ── Phase 1: a run created through the REAL dispatch path ───────────────
    handle = await startServer(MUTATING_AT_RUN_START, provider.url);
    let cookie = await login();

    const agent = (await store.createConfiguredAgent({
      value: { name: 'Semantics Agent', provider: 'ollama', model: 'mock-model', apiKey: '' },
      groupIds: [], changedBy: 'exec-semantics-test'
    })).agent;

    // POST /tickets reaches createRunsForTicket → prepareAgentRunDraft →
    // resolveAgentRuntimeLimits. No snapshot is supplied by the test, so whatever
    // is persisted was produced by production resolution.
    const created = await request('POST', '/tickets', {
      cookie,
      form: {
        // Recognized by the deterministic objective grammar as create_folder with
        // exactly two targets, and feasible under the run-start step limit, so the
        // feasibility gate takes its `passed` path with known inputs. Neither
        // folder exists in the fresh temp workspace, so both count as required.
        objective: 'Create folders Alpha, Beta',
        assignmentTargetType: 'agent', assignmentTargetId: String(agent.id),
        assignmentMode: 'individual', capabilityType: 'directAction', executionMode: 'agent'
      }
    });
    assert(created.statusCode === 302 || created.statusCode === 200,
      `ticket creation through the real dispatch path succeeded (HTTP ${created.statusCode})`);

    let dispatched = null;
    for (let i = 0; i < 60; i++) {
      const page = await store.listRuns({ limit: 50 });
      dispatched = (page && Array.isArray(page.runs) ? page.runs : []).find(r => r.agentId === agent.id) || null;
      if (dispatched) break;
      await sleep(300);
    }
    assert(dispatched, 'the real dispatch path created a run');
    const runId = dispatched.id;

    for (let i = 0; i < 80; i++) {
      const current = await store.getRun(runId);
      if (current && ['completed', 'failed'].includes(current.status)) break;
      await sleep(300);
    }

    // ── Phase 2: reload from storage through a FRESH connection ─────────────
    await store.close();
    const reloadStore = new PostgresRuntimeStore({ connectionString: DATABASE_URL, schema: SCHEMA });
    const reloaded = await reloadStore.getRun(runId);
    assert(reloaded && reloaded.runtimeLimitsSnapshot,
      'run reloaded from storage carries a runtimeLimitsSnapshot');

    const semantics = reloaded.runtimeLimitsSnapshot.semantics;
    assert(semantics && typeof semantics === 'object',
      'runtimeLimitsSnapshot.semantics was persisted by the real resolution path');
    for (const control of REQUIRED_CONTROLS) {
      assert(Object.prototype.hasOwnProperty.call(semantics, control),
        `semantic control survives reload: ${control}`);
    }
    assert(semantics.maxMutatingActionsPerResponse === 2,
      'persisted mutating cap is the run-start value (2)');
    assert(semantics.maxActionsPerResponse === 8, 'persisted total-action cap is 8');
    assert(semantics.prefixTruncationEnabled === false, 'persisted prefix-truncation flag is false');
    assert(semantics.contractCompilerEnabled === false, 'persisted compiler flag is false');
    assert(semantics.actionContractViolationThreshold === 2, 'persisted contract-violation threshold is 2');
    assert(semantics.stalledResponseThreshold === 2, 'persisted stalled-response threshold is 2');
    assert(semantics.inspectionNoProgressThreshold === 3, 'persisted inspection no-progress threshold is 3');
    assert(semantics.workspaceSnapshotMaxEntries === 200, 'persisted workspace snapshot entry limit is 200');
    assert(Object.prototype.hasOwnProperty.call(semantics, 'workloadProfile'),
      'resolved workload profile recorded (null when none matched)');

    // ── Phase 2b: the feasibility gate's durable decision, through real dispatch ─
    // The focused test proves all six outcome paths against stubs. This proves the
    // async gate actually runs and persists during production dispatch, to both
    // evidence surfaces, with payloads that agree.
    const replay = await reloadStore.readRunReplay(runId);
    const replayEvents = replay && replay.snapshot && Array.isArray(replay.snapshot.events)
      ? replay.snapshot.events : [];
    const replayDecisions = replayEvents.filter(e => e && e.type === 'run:feasibility_decision');
    assert(replayDecisions.length === 1,
      `exactly one run:feasibility_decision replay event was persisted (got ${replayDecisions.length})`);
    const replayDecision = replayDecisions[0];

    const journalEvents = [];
    for (let afterSeq = -1; ;) {
      const page = await reloadStore.listRunEvents(runId, { afterSeq, limit: 100 });
      if (!Array.isArray(page) || page.length === 0) break;
      journalEvents.push(...page);
      afterSeq = page[page.length - 1].seq;
    }
    const journalDecisions = journalEvents.filter(e => e && e.type === 'run.feasibility_decision');
    assert(journalDecisions.length === 1,
      `exactly one run.feasibility_decision journal event was persisted (got ${journalDecisions.length})`);
    const journalPayload = journalDecisions[0].payload;

    assert(replayDecision.checked === true, 'feasibility decision records checked: true');
    assert(replayDecision.recognized === true, 'feasibility decision records recognized: true');
    assert(replayDecision.outcome === 'passed', 'feasibility decision records outcome: passed');
    assert(replayDecision.requiredMutations === 2,
      'feasibility decision records the 2 required mutations from the recognized contract');
    assert(replayDecision.effectiveMutationCap === semantics.maxMutatingActionsPerResponse,
      'feasibility decision records the same mutation cap the run recorded in its semantics');
    assert(replayDecision.effectiveExecutionStepLimit === reloaded.runtimeLimitsSnapshot.maxExecutionSteps,
      "feasibility decision records the run's own persisted execution-step limit");
    assert(replayDecision.projectedSteps
      === Math.ceil(replayDecision.requiredMutations / replayDecision.effectiveMutationCap),
      'projected steps equal ceil(requiredMutations / effectiveMutationCap)');
    assert(replayDecision.projectedSteps <= replayDecision.effectiveExecutionStepLimit,
      'a passed decision projects within the recorded step limit');
    assert(typeof replayDecision.recognitionSource === 'string' && replayDecision.recognitionSource,
      `feasibility decision records a recognition source (${replayDecision.recognitionSource})`);

    // Both surfaces must tell the same story. Compare field-by-field rather than
    // by serialized string: the replay event additionally carries the envelope
    // fields type/message/capturedAt, and PostgreSQL jsonb does not preserve key
    // insertion order, so a stringify comparison would fail for reasons that have
    // nothing to do with agreement between the two records.
    const REPLAY_ENVELOPE_FIELDS = ['type', 'message', 'capturedAt'];
    const replayPayload = Object.fromEntries(
      Object.entries(replayDecision).filter(([key]) => !REPLAY_ENVELOPE_FIELDS.includes(key))
    );
    assert(Object.keys(replayPayload).sort().join(',') === Object.keys(journalPayload).sort().join(','),
      'journal and replay decisions carry the same payload fields');
    for (const key of Object.keys(journalPayload).sort()) {
      assert(JSON.stringify(journalPayload[key]) === JSON.stringify(replayPayload[key]),
        `journal and replay agree on ${key} (${JSON.stringify(journalPayload[key])})`);
    }

    // ── Phase 3: seed pre-semantics runs, then restart with a DIFFERENT live default ─
    // currentRuntimeLimitsSnapshot() is the pre-existing old-style fixture: no
    // semantics block. Left deliberately untouched so its other consumers keep
    // exercising backward compatibility. "Legacy" here means only that the Run
    // predates execution-semantics capture; it is not a pre-Ticket-attempt row.
    // Each independent provenance case therefore owns one fresh Ticket and one
    // current singleton attempt. Sharing a Ticket would falsely make the second
    // case an overlapping attempt, while grouping the cases would falsely claim
    // they were one execution wave.
    async function seedPreSemanticsRun({ objective, runtimeEnvelope }) {
      const legacyTicket = (await reloadStore.createTicketWithEvent({
        ticket: {
          objective, acceptanceCriteria: null,
          assignmentTargetType: 'agent', assignmentTargetId: agent.id, assignmentMode: 'individual',
          ownedOutputPaths: null, targetRef: null, executionMode: 'agent',
          workflowId: null, workflowInput: null,
          capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
          executionPolicy: {
            mode: 'assisted', requireVerification: 'when_declared', autoRetry: false,
            maxAttempts: null, maxRuntimeMs: null, maxModelRequests: null, maxWorkspaceOperations: null,
            allowWorkspaceWrites: true, allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'shared'
          },
          workTypeId: null, workTypeSnapshot: null, workContextId: null, workContextSnapshot: null,
          status: 'open', createdBy: 'admin', changedBy: 'admin',
          changedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
        },
        eventPayload: { source: 'exec-semantics-test' }
      })).ticket;
      const run = await reloadStore.createRun({
        ticketId: legacyTicket.id, agentId: agent.id, agentName: agent.name,
        runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot(),
        executionPolicySnapshot: { requireVerification: 'when_declared' }, status: 'pending'
      });
      await reloadStore.initializeRunReplay({
        runId: run.id, ticketId: legacyTicket.id,
        snapshot: {
          version: 1, runId: run.id, ticketId: legacyTicket.id,
          provider: 'ollama', model: 'mock-model', runtimeEnvelope,
          events: [], parsedModelPlans: [], providerRequests: [], modelResponses: [],
          workspaceOperations: [], terminalStatus: 'completed', mutationCount: 0,
          createdAt: new Date().toISOString()
        }
      });
      const attempt = await reloadStore.getTicketAttempt(run.ticketAttemptId);
      assert(attempt && attempt.ticketId === legacyTicket.id && attempt.memberCount === 1,
        `pre-semantics provenance case owns one current singleton Ticket attempt (${objective})`);
      return { runId: run.id, ticketId: legacyTicket.id, attemptId: attempt.id };
    }

    const legacyWithEnvelope = await seedPreSemanticsRun({
      objective: 'pre-semantics run with a recorded runtime envelope',
      runtimeEnvelope: { maxActionsPerResponse: 8, maxMutatingActionsPerResponse: 2 }
    });
    const legacyBare = await seedPreSemanticsRun({
      objective: 'pre-semantics run without a recorded runtime envelope',
      runtimeEnvelope: {}
    });
    assert(legacyWithEnvelope.ticketId !== legacyBare.ticketId &&
      legacyWithEnvelope.attemptId !== legacyBare.attemptId,
      'independent pre-semantics provenance cases do not share Ticket-attempt authority');
    await reloadStore.close();

    await stopServer(handle);
    handle = await startServer(MUTATING_AFTER_CHANGE, provider.url);
    cookie = await login();

    // The live default really did change in the restarted process.
    const configPage = await request('GET', '/admin/runtime-limits', { cookie });
    assert(configPage.statusCode === 200, 'restarted server is serving with the changed configuration');

    // ── Phase 3a: historical run still reports its run-start values ──────────
    const detail = await request('GET', `/runs/${runId}`, { cookie });
    assert(detail.statusCode === 200, 'historical run detail renders after the configuration change');

    const authorityRow = (detail.body.match(/<dt>Max Actions<\/dt>\s*<dd>([\s\S]*?)<\/dd>/) || [])[1] || '';
    assert(/8 per response/.test(authorityRow),
      'authority block reports the recorded total-action cap (8)');
    assert(/2 mutating/.test(authorityRow),
      'authority block reports the recorded mutating cap (2), not the changed live default');
    assert(!/7 mutating/.test(authorityRow),
      'authority block does NOT present the current environment value (7) as governing');
    assert(!/not recorded for this run/.test(authorityRow),
      'a run WITH recorded semantics is not labelled unrecorded');

    const bundle = extractBundle(detail.body);
    const semanticsSection = extractSection(bundle, '### Execution semantics (run-start)');
    assert(bundleValue(bundle, 'Recorded at run creation') === 'yes',
      'bundle states the semantics were recorded at run creation');
    assert(bundleValue(bundle, 'Max mutating actions per response') === '2',
      'bundle reports the recorded mutating cap (2) after the live default changed');
    assert(bundleValue(bundle, 'Max actions per response') === '8',
      'bundle reports the recorded total-action cap (8)');
    assert(bundleValue(bundle, 'Prefix truncation enabled') === 'false',
      'bundle reports the recorded prefix-truncation flag');
    assert(bundleValue(bundle, 'Objective-contract compiler enabled') === 'false',
      'bundle reports the recorded compiler flag');
    assert(bundleValue(bundle, 'Action-contract violation threshold') === '2',
      'bundle reports the recorded contract-violation threshold');
    assert(bundleValue(bundle, 'Stalled-response threshold') === '2',
      'bundle reports the recorded stalled-response threshold');
    assert(bundleValue(bundle, 'Inspection no-progress threshold') === '3',
      'bundle reports the recorded inspection no-progress threshold');
    assert(bundleValue(bundle, 'Workspace snapshot entry limit') === '200',
      'bundle reports the recorded workspace snapshot entry limit');
    assert(!/\b7\b/.test(semanticsSection),
      'the changed environment value (7) appears nowhere in the recorded semantics section');
    assert(!/not reconstructable/.test(semanticsSection),
      'a fully recorded run is not described as unreconstructable');

    // ── Phase 3b: legacy run WITH a recorded runtimeEnvelope ────────────────
    const legacyDetail = await request('GET', `/runs/${legacyWithEnvelope.runId}`, { cookie });
    assert(legacyDetail.statusCode === 200, 'legacy run with an envelope renders');
    const legacyBundle = extractBundle(legacyDetail.body);
    const legacySection = extractSection(legacyBundle, '### Execution semantics (run-start)');
    assert(bundleValue(legacyBundle, 'Recorded at run creation') === 'no (run predates execution-semantics capture)',
      'legacy run is explicitly reported as predating semantics capture');
    assert(/Max mutating actions per response: 2 \(source: runtime_envelope\)/.test(legacySection),
      'legacy run falls back to its historical runtimeEnvelope, labelled runtime_envelope');
    assert(/Max actions per response: 8 \(source: runtime_envelope\)/.test(legacySection),
      'legacy total-action cap also comes from the historical envelope');
    assert(!/\b7\b/.test(legacySection),
      'the changed environment value (7) is not substituted for a legacy run that recorded an envelope');
    assert(/Remaining semantic controls: not reconstructable for this run/.test(legacySection),
      'remaining controls are described as not reconstructable rather than inferred');

    // ── Phase 3c: legacy run with NOTHING recorded ──────────────────────────
    const bareDetail = await request('GET', `/runs/${legacyBare.runId}`, { cookie });
    assert(bareDetail.statusCode === 200, 'legacy run without an envelope renders');
    const bareBundle = extractBundle(bareDetail.body);
    const bareSection = extractSection(bareBundle, '### Execution semantics (run-start)');
    assert(/Max mutating actions per response: 7 \(source: live_defaults_unrecorded\)/.test(bareSection),
      'with nothing recorded the current default is shown but explicitly labelled unrecorded');
    assert(/Remaining semantic controls: not reconstructable for this run/.test(bareSection),
      'remaining controls are not reconstructable for a bare legacy run');

    const bareAuthorityRow = (bareDetail.body.match(/<dt>Max Actions<\/dt>\s*<dd>([\s\S]*?)<\/dd>/) || [])[1] || '';
    assert(/not recorded for this run; showing current defaults/.test(bareAuthorityRow),
      'the authority block labels an unrecorded cap instead of presenting it as governing');

    console.log(`\nPASS: execution-semantics persistence — ${passed} checks (real dispatch → persistence → reload → authority + bundle provenance across a configuration change)`);
  } finally {
    await stopServer(handle);
    provider.server.close();
    const cleanup = new PostgresRuntimeStore({ connectionString: DATABASE_URL, schema: SCHEMA });
    try { await cleanup.pool.query(`DROP SCHEMA IF EXISTS ${cleanup.schemaSql} CASCADE`); } catch (_) {}
    await cleanup.close();
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
