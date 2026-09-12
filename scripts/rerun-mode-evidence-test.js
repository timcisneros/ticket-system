#!/usr/bin/env node
'use strict';
// Rerun-mode prior-attempt context evidence — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A13; P3-R2 bounded authoritative
// prior-attempt context).
//
// RELOCATED COVERAGE, then re-frozen by P3-R2. The A13 live assertion — *reassess
// mode injects structured prior context; retry does not* — was re-expressed here
// as behavior against what the model actually received. P3-R2 replaces the legacy
// `priorFailureContext` with the ONE canonical `priorAttemptContext` projection
// at the same reassess first-step delivery seam, and this suite owns the frozen
// R2 falsification matrix (C1-C9) at that prompt boundary:
//
//   reassess — the prompt carries the bounded prior-attempt projection: the most
//              recent prior terminal run of the same ticket (including one
//              materialized `completed` whose objective decision was incomplete
//              or blocked), its canonical committed mutation paths from the
//              hydrated consequence, its persisted criterion state explicitly
//              labeled PRIOR-ATTEMPT TERMINAL/LAST-OBSERVED CRITERION STATE, and
//              the historical-boundary statement.
//
//   retry    — the default. The prompt carries NO prior-attempt context.
//
//   resume   — same-Run recovery adds no new prior-attempt projection.
//
//   truth    — the projection is model context only: it can never satisfy a
//              criterion; the new Run's own current observation and canonical
//              evaluation control actual completion.
//
// The provider stub records every prompt AND the last user message (the compact
// ticket-context JSON) separately, so every assertion reads the exact
// priorAttemptContext object the model received rather than source text or
// substrings. Scripted responses are BAKED into the stub per objective tag:
// a prompt carrying `"priorAttemptContext"` is a reassess first-step delivery and
// is served the NEXT reassess plan for that objective's tag (per process, so a
// recovered process replays the same first plan); any other prompt is served the
// tag's prior plan. Objectives stay free of scripting tokens so declared
// `fileContains` admission is exercised on the real objective text.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter, sleep } = require('./postgres-test-harness');
const { currentRuntimeLimitsSnapshot } = require('./current-run-fixture');

const STAMP = Date.now();
const assert = createAsserter();

const HISTORICAL_BOUNDARY = 'Historical prior-attempt facts only. They describe the prior attempt, not current workspace truth, and they cannot satisfy criteria or authorize actions. Current deterministic observation and canonical evaluation in this Run control actual completion.';
const CRITERION_LABEL = 'PRIOR-ATTEMPT TERMINAL/LAST-OBSERVED CRITERION STATE';

// Key-order-insensitive deep equality for projected context objects.
function deepEqual(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length &&
      leftKeys.every(key => deepEqual(left[key], right[key]));
  }
  return false;
}

function createRecordingStub(promptLog, plansByTag) {
  const preloadPath = path.join(os.tmpdir(), `rerun-mode-stub-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
const fs = require('fs');
global.__p3r2Plans = ${JSON.stringify(plansByTag)};
global.__p3r2PlanCounters = new Map();
global.fetch = async function(_url, options = {}) {
  let combined = '';
  let ticketContext = null;
  try {
    const body = JSON.parse(options.body || '{}');
    const input = Array.isArray(body.input) ? body.input : [];
    combined = input.map(i => i && i.content ? String(i.content) : '').join('\\n');
    const last = input[input.length - 1];
    if (last && typeof last.content === 'string') {
      try { ticketContext = JSON.parse(last.content); } catch (_) { ticketContext = null; }
    }
  } catch (_) {}
  try { fs.appendFileSync(${JSON.stringify(promptLog)}, JSON.stringify({ prompt: combined, ticketContext }) + '\\n'); } catch (_) {}
  function okResponse(plan) {
    return { ok: true, status: 200, headers: new Map([['x-request-id', 'fake-rerun-mode']]),
      async text() { return JSON.stringify({ output_text: JSON.stringify(plan), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }); } };
  }
  const contextPresent = combined.includes('"priorAttemptContext"');
  // Objective tag resolution. Declared fileContains fixtures key on their
  // unique workspace file marker so the objective text stays a clean admission
  // form; every other fixture keys on its unique P3R2 token.
  const declaredMatch = combined.match(/rerun-mode\\/([a-z0-9]+)-[0-9]+\\.md/);
  const markerMatch = declaredMatch ? null : combined.match(/P3R2-([A-Za-z0-9]+)-[0-9]+/);
  const tag = declaredMatch ? declaredMatch[1] : (markerMatch ? markerMatch[1] : null);
  const scripted = tag && global.__p3r2Plans[tag];
  if (contextPresent && scripted && Array.isArray(scripted.reassess) && scripted.reassess.length > 0) {
    const counter = global.__p3r2PlanCounters.get(tag) || 0;
    global.__p3r2PlanCounters.set(tag, counter + 1);
    return okResponse(scripted.reassess[Math.min(counter, scripted.reassess.length - 1)]);
  }
  if (scripted && Array.isArray(scripted.prior) && scripted.prior.length > 0) {
    return okResponse(scripted.prior[0]);
  }
  return okResponse({ message: 'noop', actions: [], complete: true });
};
`);
  return preloadPath;
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const promptLog = path.join(os.tmpdir(), `rerun-mode-prompts-${process.pid}-${STAMP}.jsonl`);
  fs.writeFileSync(promptLog, '');

  // ── Baked scripted plans, one entry per unique objective tag ──────────────
  const contestedOf = tag => `rerun-mode/contested-${tag}-${STAMP}.txt`;
  const ownerWritePlanOf = pathValue => ({
    message: 'Writing the owned file.',
    actions: [{ operation: 'writeFile', args: { path: pathValue, content: 'OWNED' } }],
    complete: true
  });
  const contestedWritePlanOf = pathValue => ({
    message: 'Writing the contested file.',
    actions: [{ operation: 'writeFile', args: { path: pathValue, content: 'INTRUDER' } }],
    complete: true
  });
  const noOpPlan = { message: 'Nothing to do.', actions: [], complete: true };
  const createFolderPlanOf = folderPath => ({
    message: 'Creating the folder.',
    actions: [{ operation: 'createFolder', args: { path: folderPath } }],
    complete: false
  });
  const markerOf = tag => `${tag.toUpperCase()}MARKER-${STAMP}`;
  const correctWritePlanOf = (pathValue, marker) => ({
    message: 'Writing the requested note.',
    actions: [{ operation: 'writeFile', args: { path: pathValue, content: `payload has ${marker} inside` } }],
    complete: true
  });
  const wrongerWritePlanOf = pathValue => ({
    message: 'Writing the requested note.',
    actions: [{ operation: 'writeFile', args: { path: pathValue, content: 'externally replaced wronger content' } }],
    complete: true
  });

  const plansByTag = {
    ocore: { prior: [ownerWritePlanOf(contestedOf('core'))], reassess: [noOpPlan] },
    failing: { prior: [contestedWritePlanOf(contestedOf('core'))], reassess: [noOpPlan] },
    oretry: { prior: [ownerWritePlanOf(contestedOf('retry'))], reassess: [noOpPlan] },
    retry: { prior: [contestedWritePlanOf(contestedOf('retry'))], reassess: [noOpPlan] },
    oc1: { prior: [ownerWritePlanOf(contestedOf('c1'))], reassess: [noOpPlan] },
    c1: {
      prior: [contestedWritePlanOf(contestedOf('c1'))],
      reassess: [createFolderPlanOf(`rerun-mode/c1-${STAMP}`), noOpPlan]
    },
    oc9res: { prior: [ownerWritePlanOf(contestedOf('c9resume'))], reassess: [noOpPlan] },
    c9res: {
      prior: [contestedWritePlanOf(contestedOf('c9resume'))],
      reassess: [createFolderPlanOf(`rerun-mode/c9resume-${STAMP}`)]
    },
    c5: { reassess: [noOpPlan] },
    c8: { reassess: [noOpPlan] },
    nobound: { reassess: [noOpPlan] },
    noconsequence: { reassess: [noOpPlan] },
    c6: { prior: [noOpPlan], reassess: [noOpPlan] },
    c6t2: {
      prior: [correctWritePlanOf(`rerun-mode/c6t2-${STAMP}.md`, markerOf('c6t2'))],
      reassess: [noOpPlan]
    },
    c6t3: { prior: [noOpPlan], reassess: [noOpPlan] },
    c6c2: {
      prior: [wrongerWritePlanOf(`rerun-mode/c6c2-${STAMP}.md`)],
      reassess: [wrongerWritePlanOf(`rerun-mode/c6c2-${STAMP}.md`)]
    }
  };

  const preloadPath = createRecordingStub(promptLog, plansByTag);

  try {
    await withHarness('rerun mode evidence', async ({ store, workspaceRoot, startServer }) => {
      const agentIds = [];
      for (let i = 0; i < 2; i += 1) {
        agentIds.push((await store.createConfiguredAgent({
          value: { name: `RerunMode Agent ${i} ${STAMP}`, provider: 'openai', model: `fake-openai-${i}`, apiKey: `fake-key-rerun-${i}` },
          groupIds: [], changedBy: 'rerun-mode-evidence-test'
        })).agent.id);
      }

      let activeServer = null;
      let activeCookie = null;

      const recordCount = () => fs.readFileSync(promptLog, 'utf8').split('\n').filter(Boolean).length;
      const records = () => fs.readFileSync(promptLog, 'utf8').split('\n').filter(Boolean)
        .map(line => JSON.parse(line));
      const recordsSince = offset => records().slice(offset);
      const contextsOf = promptRecords => promptRecords
        .filter(record => record.ticketContext && record.ticketContext.priorAttemptContext)
        .map(record => record.ticketContext.priorAttemptContext);

      async function startServerWith(env) {
        if (activeServer) await activeServer.stop();
        activeServer = await startServer({ env: {
          NODE_OPTIONS: `--require ${preloadPath}`,
          RUNTIME_SCHEDULER_INTERVAL_MS: '200',
          RUN_LEASE_DURATION_MS: '60000',
          ...env
        } });
        activeCookie = await activeServer.login();
      }

      const stopActiveServer = async () => {
        if (activeServer) {
          await activeServer.stop();
          activeServer = null;
        }
      };

      async function runTicket(agentId, objective) {
        const created = await activeServer.request('POST', '/tickets', {
          cookie: activeCookie, form: { objective, assignmentTargetType: 'agent', assignmentTargetId: String(agentId), assignmentMode: 'individual' }
        });
        if (created.statusCode !== 302) throw new Error(`ticket create returned HTTP ${created.statusCode}`);
        const ticket = await waitFor(async () => {
          const { tickets } = await store.listTickets({ limit: 300 });
          return tickets.find(t => t.objective === objective) || null;
        }, 30000, 'ticket persistence');
        const run = await waitFor(async () => {
          const { runs } = await store.listRunsForTicket({ ticketId: ticket.id, limit: 10 });
          const current = runs[0] ? await store.getRun(runs[0].id) : null;
          return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
        }, 90000, `terminal run ${ticket.id}`);
        return { ticket, run };
      }

      async function rerunAndCapture(ticketId, body, label, { requireDelivery = true } = {}) {
        const before = recordCount();
        const priorRunIds = new Set((await store.listRunsForTicket({ ticketId, limit: 50 })).runs.map(r => r.id));
        const response = await activeServer.request('POST', `/api/tickets/${ticketId}/rerun`, { cookie: activeCookie, body });
        assert(response.statusCode === 200, `${label}: the rerun was accepted (HTTP ${response.statusCode})`);
        const newRun = await waitFor(async () => {
          const { runs } = await store.listRunsForTicket({ ticketId, limit: 50 });
          const created = runs.find(r => !priorRunIds.has(r.id));
          return created && ['completed', 'failed', 'interrupted'].includes(created.status) ? created : null;
        }, 90000, `${label} rerun to terminalize`);
        const promptRecords = recordsSince(before);
        if (requireDelivery) {
          assert(promptRecords.length > 0, `${label}: the rerun issued at least one provider call`);
        }
        return { run: newRun, promptRecords, contexts: contextsOf(promptRecords) };
      }

      const objectiveOf = (tag, extra = '') => `P3R2-${tag}-${STAMP} ${extra}`.trim();

      // ── Phase 1: the core reassess/retry contract on one live server ────────
      await startServerWith({});

      // A contested path makes a run fail deterministically with a real error, so
      // reassess has real prior-attempt evidence to project.
      const owner = await runTicket(agentIds[0], objectiveOf('ocore'));
      assert(owner.run.status === 'completed',
        `setup: the owner run completed (${owner.run.status}, error: ${owner.run.error || 'none'})`);

      const failing = await runTicket(agentIds[1], objectiveOf('failing'));
      assert(failing.run.status === 'failed',
        `setup: the contested run failed (${failing.run.status}, error: ${failing.run.error || 'none'})`);
      const failingError = String(failing.run.error || '');
      assert(/conflict|previously produced/i.test(failingError),
        'setup: the failure carries a real error the reassess context could cite');

      const reassess = await rerunAndCapture(failing.ticket.id, { mode: 'reassess' }, 'reassess');
      assert(reassess.run.rerunMode === 'reassess',
        `reassess: the mode is recorded on the run (got ${reassess.run.rerunMode})`);
      assert(reassess.contexts.length === 1,
        `reassess: exactly the first model step carries the context (got ${reassess.contexts.length})`);
      const reassessContext = reassess.contexts[0];
      assert(reassessContext.priorRunId === failing.run.id,
        `reassess: the projection names the prior terminal run (got ${reassessContext.priorRunId}, want ${failing.run.id})`);
      assert(reassessContext.priorRunStatus === 'failed',
        `reassess: the prior terminal status is stated (got ${reassessContext.priorRunStatus})`);
      assert(/conflict|previously produced/i.test(String(reassessContext.priorError || '')),
        'reassess: the projection cites the real prior failure reason, boundary-sanitized');
      assert(deepEqual(reassessContext.committedPaths,
        { entries: [], total: 0, truncated: false }),
        'reassess: the refused prior write projected no committed paths (attempted/failed entries are never projected)');
      assert(reassessContext.priorCriteria === undefined,
        'reassess: no criterion section is fabricated when the prior decision carries no evaluated postconditions');
      assert(reassessContext.historicalBoundary === HISTORICAL_BOUNDARY,
        'reassess: the projection carries the exact historical-boundary statement');
      assert(!reassess.promptRecords.some(record =>
          record.prompt.includes('"priorFailureContext"')),
        'reassess: the legacy priorFailureContext key is gone from generated prompts');
      assert(reassess.promptRecords[0].prompt.includes('"priorAttemptContext"'),
        'reassess: the ONE canonical key reaches the prompt');
      for (const legacyField of ['lastAction', 'inspectedFiles', 'mutationsCompleted', 'recoveryClassification']) {
        assert(!(legacyField in reassessContext),
          `reassess: the superseded legacy field ${legacyField} is not projected`);
      }

      // ── Retry (the default): no prior-attempt context leaks in ─────────────
      // Asserted on a SEPARATE failed ticket, so this cannot pass merely because
      // the reassess rerun above already consumed the prior-attempt evidence.
      const owner2 = await runTicket(agentIds[0], objectiveOf('oretry'));
      assert(owner2.run.status === 'completed',
        `setup: the second owner run completed (${owner2.run.status}, error: ${owner2.run.error || 'none'})`);
      const failing2 = await runTicket(agentIds[1], objectiveOf('retry'));
      assert(failing2.run.status === 'failed',
        `setup: the second contested run failed (${failing2.run.status}, error: ${failing2.run.error || 'none'})`);

      const retry = await rerunAndCapture(failing2.ticket.id, {}, 'retry');
      assert(retry.run.rerunMode !== 'reassess',
        `retry: the default mode is not reassess (got ${retry.run.rerunMode})`);
      assert(retry.contexts.length === 0,
        'retry: no prior-attempt context reaches any retry prompt');
      assert(!retry.promptRecords.some(record => record.prompt.includes('"priorAttemptContext"')),
        'retry: the canonical context key never reaches the retry prompt');
      assert(!retry.promptRecords.some(record => record.prompt.includes('priorFailureContext')),
        'retry: the legacy key never reaches the retry prompt');
      // Deliberately NOT `includes(String(runId))`: run ids are small integers and
      // would match coincidentally anywhere in the prompt. The failure REASON is a
      // distinctive string, so its absence is real evidence that nothing leaked.
      assert(!/previously produced by ticket/i.test(retry.promptRecords[0].prompt),
        'retry: the prior failure reason never reaches the model');

      // ── C3: selection is the most recent PRIOR terminal run of the same
      // Ticket; the current Run and foreign Tickets can never be projected. ──
      // The retry run above just failed on the same contested path, so the
      // failing2 ticket now has TWO prior terminal runs and a reassess rerun
      // must select the newest one.
      const mostRecent = await rerunAndCapture(failing2.ticket.id, { mode: 'reassess' }, 'most-recent');
      assert(mostRecent.contexts.length === 1 &&
        mostRecent.contexts[0].priorRunId === retry.run.id,
        `most-recent: the projection selects the newest prior terminal run (got ` +
        `${mostRecent.contexts.length ? mostRecent.contexts[0].priorRunId : 'none'}, want ${retry.run.id})`);
      assert(mostRecent.contexts[0].priorRunId !== failing2.run.id,
        'most-recent: an older prior terminal run is not selected over the newest one');
      assert(mostRecent.contexts[0].priorRunStatus === 'failed',
        'most-recent: the selected prior terminal status is stated');
      const foreignTicketRuns = (await store.listRunsForTicket({ ticketId: owner.ticket.id, limit: 10 })).runs;
      assert(!foreignTicketRuns.some(run => run.id === mostRecent.contexts[0].priorRunId),
        'same-ticket: a foreign Ticket run is never selected as the prior attempt');
      // A non-terminal Run cannot be selected: the admission gate refuses a new
      // attempt while one is unsettled, so every other Run on the Ticket at
      // projection time is terminal, and the current (unsettled) Run is excluded
      // by construction — the projection named a prior terminal run, never the
      // current one.

      // ── Phase 2: C1 + C9 later-turns — the reassess first step is delivered,
      // the Run is killed at its first authority check, and recovery re-delivers
      // the SAME first step from the SAME durable prior state. ─────────────────
      const c1Owner = await runTicket(agentIds[0], objectiveOf('oc1'));
      assert(c1Owner.run.status === 'completed',
        `setup: the c1 owner run completed (${c1Owner.run.status}, error: ${c1Owner.run.error || 'none'})`);
      const c1Failing = await runTicket(agentIds[1], objectiveOf('c1'));
      assert(c1Failing.run.status === 'failed',
        `setup: the c1 contested run failed (${c1Failing.run.status}, error: ${c1Failing.run.error || 'none'})`);

      const c1Before = recordCount();
      await startServerWith({
        RUN_LEASE_DURATION_MS: '5000',
        TEST_INTERRUPTION_POINT: 'after_first_authority.allowed'
      });
      await activeServer.request('POST', `/api/tickets/${c1Failing.ticket.id}/rerun`, { cookie: activeCookie, body: { mode: 'reassess' } });
      const c1RunId = (await store.listRunsForTicket({ ticketId: c1Failing.ticket.id, limit: 10 })).runs.slice(-1)[0].id;
      await waitFor(async () => {
        const events = await store.listRunEvents(c1RunId, { afterSeq: -1, limit: 300 });
        return (events || []).some(event => event.type === 'interruption.test_hook') || null;
      }, 30000, 'the c1 authority interruption');
      await stopActiveServer();
      const attempt1 = recordsSince(c1Before);
      assert(attempt1.length === 1 && attempt1[0].ticketContext &&
        attempt1[0].ticketContext.priorAttemptContext,
        `c1: attempt 1 delivered exactly the reassess first step (got ${attempt1.length})`);
      const firstDeliveryContext = attempt1[0].ticketContext.priorAttemptContext;

      await startServerWith({ RUN_LEASE_DURATION_MS: '5000' });
      const c1Final = await waitFor(async () => {
        const current = await store.getRun(c1RunId);
        return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
      }, 90000, 'the recovered c1 run to terminalize');
      const attempt2 = recordsSince(c1Before).slice(attempt1.length);
      const attempt2Contexts = contextsOf(attempt2);
      assert(attempt2Contexts.length === 1,
        `c9: only the re-delivered FIRST step carries the projection after recovery (got ${attempt2Contexts.length})`);
      assert(deepEqual(attempt2Contexts[0], firstDeliveryContext),
        'c1: the same durable prior state projects a deep-equal priorAttemptContext on both first-step deliveries');
      assert(attempt2.length >= 2,
        `c9: the recovered Run continued past the first step (got ${attempt2.length} deliveries)`);
      assert(attempt2.slice(1).every(record => !record.ticketContext || !record.ticketContext.priorAttemptContext),
        'c9: no later turn of the same Run carries the projection');
      await stopActiveServer();

      // ── Phase 3: C9 same-Run resume — a mid-batch interruption. The recovery
      // machinery replays the durable response/plan; no NEW prior-attempt
      // projection is added to the resumed delivery. ─────────────────────────────
      await startServerWith({});
      const c9Owner = await runTicket(agentIds[0], objectiveOf('oc9res'));
      assert(c9Owner.run.status === 'completed',
        `setup: the c9resume owner run completed (${c9Owner.run.status}, error: ${c9Owner.run.error || 'none'})`);
      const c9Failing = await runTicket(agentIds[1], objectiveOf('c9res'));
      assert(c9Failing.run.status === 'failed',
        `setup: the c9resume contested run failed (${c9Failing.run.status}, error: ${c9Failing.run.error || 'none'})`);

      const c9Before = recordCount();
      await startServerWith({
        RUN_LEASE_DURATION_MS: '5000',
        TEST_INTERRUPTION_POINT: 'after_first_workspace.operation'
      });
      await activeServer.request('POST', `/api/tickets/${c9Failing.ticket.id}/rerun`, { cookie: activeCookie, body: { mode: 'reassess' } });
      const c9RunId = (await store.listRunsForTicket({ ticketId: c9Failing.ticket.id, limit: 10 })).runs.slice(-1)[0].id;
      await waitFor(async () => {
        const events = await store.listRunEvents(c9RunId, { afterSeq: -1, limit: 300 });
        return (events || []).some(event => event.type === 'interruption.test_hook') || null;
      }, 30000, 'the c9 workspace-operation interruption');
      await stopActiveServer();
      const c9Attempt1 = recordsSince(c9Before);
      assert(c9Attempt1.length === 1 && c9Attempt1[0].ticketContext &&
        c9Attempt1[0].ticketContext.priorAttemptContext,
        `c9: attempt 1 delivered the reassess first step before the mid-batch interruption (got ${c9Attempt1.length})`);

      await startServerWith({ RUN_LEASE_DURATION_MS: '5000' });
      await waitFor(async () => {
        const current = await store.getRun(c9RunId);
        return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
      }, 90000, 'the resumed c9 run to terminalize');
      const resumed = recordsSince(c9Before).slice(c9Attempt1.length);
      const resumedContexts = contextsOf(resumed);
      // The recovery machinery may re-deliver the Run's own FIRST step (the
      // durable plan cursor permits a fresh model request for turn 0), but the
      // resume adds no NEW or DIFFERENT prior-attempt projection: at most the
      // re-delivered first step carries the projection, and it is deep-equal to
      // the original first-step delivery.
      assert(resumedContexts.length <= 1 &&
        resumedContexts.every(context => deepEqual(context, c9Attempt1[0].ticketContext.priorAttemptContext)),
        `c9: the same-Run resume adds no new prior-attempt projection beyond the original first-step delivery (resumed prompts=${resumed.length}, contexts=${resumedContexts.length})`);
      await stopActiveServer();

      // ── Phase 4: canonical committed-path sources, the prior Run's own bound,
      // and historical omission (C4, C5, C7, C8). The prior Runs are crafted
      // through the repository store with the server down, then projected through
      // live reassess reruns. The crafted consequences name FICTIONAL paths that
      // exist in no replay and no receipt, so the projection naming them is proof
      // that the canonical hydrated consequence is the sole source. ─────────────
      const now = () => new Date().toISOString();
      async function craftPriorRun(tag, { limits = null, consequence = null } = {}) {
        const ticket = (await store.createTicketWithEvent({
          ticket: {
            objective: objectiveOf(tag), acceptanceCriteria: null,
            assignmentTargetType: 'agent', assignmentTargetId: agentIds[0], assignmentMode: 'individual',
            ownedOutputPaths: null, targetRef: null, executionMode: 'agent',
            workflowId: null, workflowInput: null,
            capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
            executionPolicy: {
              mode: 'assisted', requireVerification: 'when_declared', autoRetry: false,
              maxAttempts: null, maxRuntimeMs: null, maxModelRequests: null, maxWorkspaceOperations: null,
              allowWorkspaceWrites: true, allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'shared'
            },
            workTypeId: null, workTypeSnapshot: null, workContextId: null, workContextSnapshot: null,
            status: 'open', createdBy: 'rerun-mode-evidence-test', changedBy: 'rerun-mode-evidence-test',
            changedAt: now(), createdAt: now(), updatedAt: now()
          },
          eventPayload: { source: 'rerun-mode-evidence-test' }
        })).ticket;
        const run = await store.createRun({
          ticketId: ticket.id, agentId: agentIds[0], agentName: `RerunMode Agent 0 ${STAMP}`,
          ...(limits ? { runtimeLimitsSnapshot: limits } : {}),
          executionPolicySnapshot: { requireVerification: 'when_declared' },
          status: 'pending'
        });
        await store.transitionRun({
          runId: run.id,
          expectedRevision: run.revision,
          fromStatuses: ['pending'],
          toStatus: 'failed',
          eventType: 'run.execution_failed',
          eventPayload: { source: 'rerun-mode-evidence-test' }
        });
        if (consequence) {
          await store.recordRunConsequence({
            runId: run.id, consequence, eventPayload: { source: 'rerun-mode-evidence-test' }
          });
        }
        await store.transitionTicketAfterRun({ runId: run.id });
        const receipts = await store.listRunOperations(run.id, { limit: 50 });
        return { ticket, run, receiptCount: (receipts.operations || receipts || []).length };
      }

      const c5Consequence = {
        mutations: [],
        created: [
          { operation: 'writeFile', path: 'crafted/c5-a.md' },
          { operation: 'writeFile', path: 'crafted/c5-b.md' },
          { operation: 'writeFile', path: 'crafted/c5-a.md' },
          { operation: 'writeFile', path: 'crafted/c5-c.md' }
        ],
        updated: [{ operation: 'writeFile', path: 'crafted/c5-d.md' }],
        deleted: [],
        renamed: [{ operation: 'renamePath', path: 'crafted/c5-e.md', nextPath: 'crafted/c5-f.md' }],
        notifications: [], externalEffects: [],
        verification: { postconditionsStatus: 'unknown', violationsStatus: 'none', browserEvidence: null }
      };
      const c8Consequence = {
        mutations: [],
        created: [
          { operation: 'writeFile', path: 'crafted/c8-a.md' },
          { operation: 'writeFile', path: 'crafted/c8-a.md' }
        ],
        updated: [{ operation: 'writeFile', path: 'crafted/c8-b.md' }],
        deleted: [{ operation: 'deletePath', path: 'crafted/c8-c.md' }],
        renamed: [{ operation: 'renamePath', path: 'crafted/c8-d.md', nextPath: 'crafted/c8-e.md' }],
        notifications: [], externalEffects: [],
        verification: { postconditionsStatus: 'unknown', violationsStatus: 'none', browserEvidence: null }
      };
      const c5 = await craftPriorRun('c5', {
        limits: currentRuntimeLimitsSnapshot({ maxWorkspaceOperationsPerRun: 2 }),
        consequence: c5Consequence
      });
      assert(c5.receiptCount === 0,
        'c4/c5: the crafted prior Run carries no operation receipts — the projected paths cannot come from a replay fallback');
      const c8 = await craftPriorRun('c8', { limits: currentRuntimeLimitsSnapshot(), consequence: c8Consequence });
      const noBound = await craftPriorRun('nobound', { consequence: c5Consequence });
      const noConsequence = await craftPriorRun('noconsequence', {});

      await startServerWith({});
      const c5Reassess = await rerunAndCapture(c5.ticket.id, { mode: 'reassess' }, 'c5');
      assert(c5Reassess.contexts.length === 1,
        `c5: the crafted reassess delivers the context once (got ${c5Reassess.contexts.length})`);
      const c5Context = c5Reassess.contexts[0];
      assert(c5Context.priorRunId === c5.run.id && c5Context.priorRunStatus === 'failed',
        'c5: the projection names the crafted prior terminal run of its own Ticket');
      assert(deepEqual(c5Context.committedPaths, {
        entries: [
          { category: 'created', path: 'crafted/c5-a.md' },
          { category: 'created', path: 'crafted/c5-b.md' }
        ],
        total: 5,
        truncated: true
      }), 'c5: the bound is the PRIOR Run durable snapshot value (2, not the deployment default), dedup runs before the bound, canonical order is preserved, and truncation is explicit with no silent loss');
      assert(c5Context.committedPaths.entries.every(entry => !('operation' in entry)),
        'c5: the source-side dedup identity `operation` is never projected');
      assert(c5Context.priorCriteria === undefined,
        'c7: a prior Run without a persisted completion decision projects no criterion section');

      const c8Reassess = await rerunAndCapture(c8.ticket.id, { mode: 'reassess' }, 'c8');
      const c8Context = c8Reassess.contexts[0];
      assert(deepEqual(c8Context.committedPaths, {
        entries: [
          { category: 'created', path: 'crafted/c8-a.md' },
          { category: 'updated', path: 'crafted/c8-b.md' },
          { category: 'deleted', path: 'crafted/c8-c.md' },
          { category: 'renamed', path: 'crafted/c8-d.md', nextPath: 'crafted/c8-e.md' }
        ],
        total: 4,
        truncated: false
      }), 'c8: the rename is one entry carrying both paths from the SAME committed consequence item, in fixed category order, with the duplicate collapsed before the count');

      const noBoundReassess = await rerunAndCapture(noBound.ticket.id, { mode: 'reassess' }, 'no-bound');
      const noBoundContext = noBoundReassess.contexts[0];
      assert(noBoundContext.priorRunId === noBound.run.id && noBoundContext.committedPaths === undefined,
        'historical: a prior Run without a durable runtime bound omits the committed-path section — never fabricated from current defaults');
      assert(noBoundContext.priorRunStatus === 'failed',
        'historical: the prior terminal status still projects honestly');

      const noConsequenceReassess = await rerunAndCapture(noConsequence.ticket.id, { mode: 'reassess' }, 'no-consequence');
      const noConsequenceContext = noConsequenceReassess.contexts[0];
      assert(noConsequenceContext.priorRunId === noConsequence.run.id &&
        noConsequenceContext.committedPaths === undefined,
        'c4: a missing canonical consequence omits the committed-path section rather than reconstructing it from raw replay');
      assert(noConsequenceContext.priorCriteria === undefined,
        'c7: no persisted completion decision → the criterion section is omitted, never re-evaluated');
      await stopActiveServer();

      // ── Phase 5: C6 + the historical/current truth separation. Declared
      // `fileContains` objectives, so the prior Run's decision carries persisted
      // criterion state, and external workspace edits between attempts prove the
      // projection stays historical while the new Run's own machinery controls
      // completion. ───────────────────────────────────────────────────────────────
      await startServerWith({});
      async function declaredFixture(tag, { priorPlanFor = null, seedDirectory = false } = {}) {
        const fileName = `rerun-mode/${tag}-${STAMP}.md`;
        if (seedDirectory) fs.mkdirSync(path.join(workspaceRoot, fileName), { recursive: true });
        const priorPlan = priorPlanFor
          ? priorPlanFor(fileName)
          : noOpPlan;
        const objective = `create file ${fileName} containing ${tag.toUpperCase()}MARKER-${STAMP}`;
        const fixture = await runTicket(agentIds[1], objective);
        return { ...fixture, fileName, objective };
      }

      const currentObservationsOf = async runId => {
        const replay = await store.readRunReplay(runId);
        const events = replay && replay.snapshot && Array.isArray(replay.snapshot.events)
          ? replay.snapshot.events : [];
        return events
          .filter(event => event && event.type === 'run:direct_postcondition_observed')
          .flatMap(event => Array.isArray(event.observations) ? event.observations : []);
      };

      // C6: a prior Run materialized completed whose canonical decision is
      // blocked (the criterion was structurally unobservable) is still the
      // selected prior terminal attempt, presented honestly.
      const c6 = await declaredFixture('c6', { seedDirectory: true });
      assert(c6.run.status === 'completed' &&
        (await store.getRunConsequence(c6.run.id)).consequence.completionDecision
          .completionDisposition === 'blocked',
        'c6 setup: the prior Run settled completed with an unavailable canonical decision');
      const c6Reassess = await rerunAndCapture(c6.ticket.id, { mode: 'reassess' }, 'c6');
      assert(c6Reassess.contexts.length === 1 &&
        c6Reassess.contexts[0].priorRunId === c6.run.id &&
        c6Reassess.contexts[0].priorRunStatus === 'completed',
        `c6: a completed-but-objective-incomplete prior Run is eligible and honestly presented (got ` +
        `${c6Reassess.contexts.length ? c6Reassess.contexts[0].priorRunStatus : 'none'})`);
      assert(c6Reassess.contexts[0].priorReasonCode === 'VERIFICATION_UNAVAILABLE',
        'c6: the prior decision reasonCode projects as persisted');
      assert(deepEqual(c6Reassess.contexts[0].priorCriteria, {
        label: CRITERION_LABEL,
        entries: [{
          type: 'fileContains',
          path: c6.fileName,
          passed: null,
          reasonCode: 'POSTCONDITION_EVIDENCE_UNAVAILABLE'
        }]
      }), 'c6: the persisted criterion state projects exactly, keeping historical unavailable as null');

      // §21.4: the historical null is not a current blocker by itself — once the
      // workspace actually satisfies the criterion, the new Run's own machinery
      // completes it without any prior-attempt fact doing the satisfying.
      fs.rmdirSync(path.join(workspaceRoot, c6.fileName));
      fs.writeFileSync(path.join(workspaceRoot, c6.fileName), `payload has ${markerOf('c6')} inside`);
      const c6Second = await rerunAndCapture(c6.ticket.id, { mode: 'reassess' }, 'c6-current-truth',
        { requireDelivery: false });
      assert(c6Second.promptRecords.length === 0,
        'truth 4: the Run completed through the deterministic pre-model claim without any model delivery');
      assert(c6Second.run.status === 'completed' &&
        (await store.getRunConsequence(c6Second.run.id)).consequence.completionDecision
          .completionDisposition === 'completed',
        'truth 4: the current deterministic machinery completes the Run; the prior unavailable state did not block it');

      // §21.2: a prior passed:true does not suppress current re-observation. The
      // workspace is made wrong between attempts; the new Run's own channel
      // re-observes the CURRENT negative and the new Run's current machinery —
      // not the historical true — decides the outcome.
      const t2 = await declaredFixture('c6t2', {
        priorPlanFor: fileName => correctWritePlanOf(fileName, markerOf('c6t2'))
      });
      fs.writeFileSync(path.join(workspaceRoot, t2.fileName), 'rewritten without the marker');
      const t2Reassess = await rerunAndCapture(t2.ticket.id, { mode: 'reassess' }, 'truth-2');
      assert(t2Reassess.contexts.length === 1 &&
        t2Reassess.contexts[0].priorCriteria.entries[0].passed === true,
        'truth 2: the prior decision projects the historical passed=true exactly as persisted');
      const t2Observations = await currentObservationsOf(t2Reassess.run.id);
      assert(t2Observations.some(observation =>
        observation.path === t2.fileName && observation.present === false),
        'truth 2: the new Run re-observed the CURRENT negative through its own criterion-bound channel despite the prior true');
      fs.unlinkSync(path.join(workspaceRoot, t2.fileName));

      // §21.3: a prior observed-negative stays historical. With the workspace
      // corrected between attempts the new Run's own machinery completes it; the
      // prior false does not force the current decision false.
      const t3 = await declaredFixture('c6t3', {});
      assert(t3.run.status === 'failed' &&
        (await store.getRunConsequence(t3.run.id)).consequence.completionDecision
          .evaluatedPostconditions.some(entry => entry.type === 'fileContains' && entry.passed === false),
        'truth 3 setup: the prior Run durably recorded the observed negative');
      fs.writeFileSync(path.join(workspaceRoot, t3.fileName), `payload has ${markerOf('c6t3')} inside`);
      const t3Reassess = await rerunAndCapture(t3.ticket.id, { mode: 'reassess' }, 'truth-3',
        { requireDelivery: false });
      assert(t3Reassess.promptRecords.length === 0,
        'truth 3: the Run completed through the deterministic pre-model claim without any model delivery');
      assert(t3Reassess.run.status === 'completed' &&
        (await store.getRunConsequence(t3Reassess.run.id)).consequence.completionDecision
          .completionDisposition === 'completed',
        'truth 3: a prior passed=false does not force the current decision false when the workspace is now correct');

      // C2: an external workspace change between attempts does not make the prior
      // criterion state current authority. The workspace is replaced with wrong
      // content; the projection still reports the HISTORICAL persisted state, and
      // the new Run's own current machinery — not the prior context — bounds the
      // work and decides the outcome.
      const c2FileName = `rerun-mode/c6c2-${STAMP}.md`;
      fs.writeFileSync(path.join(workspaceRoot, c2FileName), `payload has ${markerOf('c6c2')} inside`);
      // No P3R2 token: the declared objective stays a clean admission form and
      // the stub resolves this tag from the unique workspace file marker.
      const c2 = await runTicket(agentIds[1],
        `create file ${c2FileName} containing ${markerOf('c6c2')}`);
      assert(c2.run.status === 'completed' &&
        (await store.getRunConsequence(c2.run.id)).consequence.completionDecision
          .evaluatedPostconditions.some(entry => entry.type === 'fileContains' && entry.passed === true),
        'c2 setup: the prior Run completed with the criterion observed true');
      fs.writeFileSync(path.join(workspaceRoot, c2FileName), 'externally replaced with different wrong content');
      const c2Reassess = await rerunAndCapture(c2.ticket.id, { mode: 'reassess' }, 'c2');
      assert(c2Reassess.contexts.length === 1 &&
        c2Reassess.contexts[0].priorCriteria.entries[0].passed === true &&
        c2Reassess.contexts[0].priorRunId === c2.run.id,
        'c2: the projection still reports the prior attempt\'s persisted state after the external workspace change');
      const c2Observations = await currentObservationsOf(c2Reassess.run.id);
      assert(c2Observations.some(observation =>
        observation.path === c2FileName && observation.present === false),
        'c2/truth 2: the new Run re-observed the CURRENT negative through its own criterion-bound channel despite the prior true');
      assert(c2Reassess.run.status === 'failed' &&
        (await store.getRunConsequence(c2Reassess.run.id)).consequence.completionDecision
          .completionDisposition === 'incomplete',
        'c2/truth 1: the new Run\'s own current machinery bounded and decided the outcome; the prior context satisfied nothing');
      fs.unlinkSync(path.join(workspaceRoot, c2FileName));

      console.log(`\nPASS: rerun-mode prior-attempt context evidence — ${assert.count()} assertions (PostgreSQL-native)`);
    }, { schemaSlug: 'rerun_mode_evidence' });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
    try { fs.unlinkSync(promptLog); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(`\nFAIL: rerun-mode prior-attempt context evidence — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
