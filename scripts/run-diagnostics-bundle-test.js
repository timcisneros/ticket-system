#!/usr/bin/env node
'use strict';
// Run Diagnostics copyable bundle — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A10).
//
// Contract under test, unchanged from the JSON-era original: the Run Detail page
// carries a Diagnostics section whose bundle is generated SERVER-SIDE, is complete
// enough to diagnose the run without further access, is truthful about what the run
// actually did, and never leaks provider keys, session cookies, or password hashes.
//
// Three run shapes exercise it, because the bundle's failure mode is reporting the
// same thing for all of them:
//   1. a PERMISSIONED cross-ticket delete (completed) — neutral count wording,
//      the audit section, the resolved permission check
//   2. a BLOCKED cross-ticket delete (failed) — the conflicting owner, "before
//      failure" count wording, no committed mutation
//   3. a PHASE/STALL failure seeded directly — count fidelity when the model
//      proposed mutations that were never accepted
//
// Repaired, not rewritten. The model-free `#ACTIONS=` fetch stub is
// storage-independent and preserved. What changed is seeding and observation: agents,
// the restricted (non-admin) principal, tickets, runs and the seeded fixture come
// from the store instead of from data/*.json copied into a DATA_DIR the PostgreSQL
// server no longer reads.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const argon2 = require('argon2');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter, sleep } = require('./postgres-test-harness');
const { currentRuntimeLimitsSnapshot } = require('./current-run-fixture');

const STAMP = Date.now();
// A recognizable fake provider key so the redaction assertions are meaningful:
// if it appears anywhere in a bundle, redaction has a hole.
const FAKE_KEY = `fake-key-diag-${STAMP}`;
const RESTRICTED_PASSWORD = 'restricted-password-diagnostics';

const assert = createAsserter();

function encodeActions(plan) {
  return Buffer.from(JSON.stringify(plan), 'utf8').toString('base64url');
}

function createFetchStub() {
  const preloadPath = path.join(os.tmpdir(), `diag-stub-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
function okResponse(plan) {
  return { ok: true, status: 200, headers: new Map([['x-request-id', 'fake-diag']]),
    async text() { return JSON.stringify({ output_text: JSON.stringify(plan), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }); } };
}
global.fetch = async function(_url, options = {}) {
  let combined = '';
  try {
    const body = JSON.parse(options.body || '{}');
    const input = Array.isArray(body.input) ? body.input : [];
    combined = input.map(i => i && i.content ? String(i.content) : '').join('\\n');
  } catch (_) {}
  const m = combined.match(/#ACTIONS=([A-Za-z0-9_-]+=*)/);
  if (!m) return okResponse({ message: 'noop', actions: [], complete: true });
  let plan;
  try { plan = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch (_) { plan = { actions: [], complete: true }; }
  return okResponse({ message: plan.message || 'stubbed', actions: plan.actions || [], complete: plan.complete !== false });
};
`);
  return preloadPath;
}

// Extract the diagnostic bundle text from the readonly textarea on the page.
function extractBundle(pageBody) {
  const match = pageBody.match(/<textarea id="run-diagnostics-bundle"[^>]*>([\s\S]*?)<\/textarea>/);
  if (!match) return null;
  return match[1]
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&#39;/g, "'");
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
  const preloadPath = createFetchStub();
  try {
    await withHarness('run diagnostics bundle', async ({ store, workspaceRoot, startServer }) => {
      const agents = [];
      for (let i = 0; i < 2; i += 1) {
        agents.push((await store.createConfiguredAgent({
          value: { name: `Diag Agent ${i} ${STAMP}`, provider: 'openai', model: `fake-openai-${i}`, apiKey: FAKE_KEY },
          groupIds: [], changedBy: 'run-diagnostics-bundle-test'
        })).agent);
      }

      // A real non-admin principal WITHOUT the cross-ticket delete permission, so the
      // blocked case is blocked by authority rather than by a missing fixture.
      const restrictedGroup = (await store.createGroup({
        value: {
          name: `Restricted Operators ${STAMP}`,
          permissions: ['ticket:create', 'ticket:read', 'ticket:update'],
          canReceiveTickets: false
        },
        changedBy: 'run-diagnostics-bundle-test'
      })).group;
      await store.createUser({
        value: { username: 'restricted', passwordHash: await argon2.hash(RESTRICTED_PASSWORD) },
        groupIds: [restrictedGroup.id],
        changedBy: 'run-diagnostics-bundle-test'
      });

      const server = await startServer({ env: {
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '60000'
      } });
      const adminCookie = await server.login();
      const restrictedCookie = await server.login('restricted', RESTRICTED_PASSWORD);

      const objectiveWith = (tag, plan) => `diag ${tag} ${STAMP} #ACTIONS=${encodeActions(plan)}`;

      async function runTicket(cookie, agentId, objective) {
        const created = await server.request('POST', '/tickets', {
          cookie, form: { objective, assignmentTargetType: 'agent', assignmentTargetId: String(agentId), assignmentMode: 'individual' }
        });
        if (created.statusCode !== 302) throw new Error(`ticket create returned HTTP ${created.statusCode}: ${created.body.slice(0, 300)}`);
        const ticket = await waitFor(async () => {
          const { tickets } = await store.listTickets({ limit: 300 });
          return tickets.find(t => t.objective === objective) || null;
        }, 30000, `ticket "${objective.slice(0, 40)}"`);
        const run = await waitFor(async () => {
          const { runs } = await store.listRunsForTicket({ ticketId: ticket.id, limit: 10 });
          return runs[0] || null;
        }, 30000, `run dispatch for ticket ${ticket.id}`);
        const terminal = await waitFor(async () => {
          const current = await store.getRun(run.id);
          return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
        }, 90000, `terminal run ${run.id}`);
        return { ticket, run: terminal };
      }

      // Owner run creates the artifact; the deleter run is a different ticket, which
      // is what makes the delete cross-ticket.
      async function deleteFlow(deleterCookie, target, tag) {
        const owner = await runTicket(adminCookie, agents[0].id, objectiveWith(`${tag}Owner`, {
          actions: [{ operation: 'writeFile', args: { path: target, content: 'CD' } }], complete: true
        }));
        if (owner.run.status !== 'completed') throw new Error(`${tag}: owner run did not complete (${owner.run.status}: ${owner.run.error})`);
        const deleter = await runTicket(deleterCookie, agents[1].id, objectiveWith(`${tag}Del`, {
          actions: [{ operation: 'deletePath', args: { path: target } }], complete: true
        }));
        return { owner, deleter };
      }

      async function bundleFor(runId) {
        const page = await waitFor(async () => {
          const response = await server.request('GET', `/runs/${runId}`, { cookie: adminCookie });
          return response.statusCode === 200 && response.body.includes('id="run-diagnostics"') ? response : null;
        }, 20000, `diagnostics page for run ${runId}`);
        return { body: page.body, bundle: extractBundle(page.body) || '' };
      }

      // ══ 1. Permissioned cross-ticket delete ═══════════════════════════════
      const permitPath = `diag-permit/CD-${STAMP}.txt`;
      const permitted = await deleteFlow(adminCookie, permitPath, 'permit');
      assert(permitted.deleter.run.status === 'completed',
        `1: the permissioned delete run completed (${permitted.deleter.run.status}: ${permitted.deleter.run.error})`);

      const perm = await bundleFor(permitted.deleter.run.id);
      assert(perm.body.includes('id="run-diagnostics"') && perm.body.includes('<h2>Diagnostics</h2>'),
        '1: run detail carries a Diagnostics section');
      assert(/<textarea id="run-diagnostics-bundle"[^>]*\breadonly\b/.test(perm.body),
        '1: the bundle is rendered in a read-only textarea');
      assert(perm.body.includes('data-copy-diagnostics'), '1: the page offers a copy control');

      assert(perm.bundle.trimStart().startsWith('# Ticket System Diagnostic Bundle'),
        '1: the bundle starts with its required header');
      assert(perm.bundle.includes(`Ticket: #${permitted.deleter.ticket.id}`)
        && perm.bundle.includes(`Run: #${permitted.deleter.run.id}`),
        '1: the bundle identifies the ticket and run it describes');
      assert(perm.bundle.includes('run.delegatedUserId:')
        && perm.bundle.includes('run.delegatedUsername:')
        && perm.bundle.includes('run.delegatedPermissionSource:'),
        '1: the bundle reports the delegated authority fields');
      assert(perm.bundle.includes('workspace.delete.cross_ticket_artifact')
        && perm.bundle.includes('Permission present in live permissions data: yes')
        && /Delegated user has permission according to live data: yes/.test(perm.bundle),
        '1: the bundle resolves the permission check against live authority data');
      assert(perm.bundle.includes('## 12. Permissioned Cross-Ticket Delete Audit')
        && perm.bundle.includes('permissionUsed: workspace.delete.cross_ticket_artifact')
        && perm.bundle.includes(`priorOwnerTicketId: ${permitted.owner.ticket.id}`)
        && perm.bundle.includes('actorUsername: admin'),
        '1: the audit section names the permission used, the prior owner, and the actor');

      assert(perm.bundle.includes('Provider keys, session cookies, password hashes, auth tokens, and environment secrets are excluded from this diagnostic bundle.'),
        '1: the bundle carries its redaction notice');
      assert(!perm.bundle.includes('passwordHash'), '1: the bundle contains no password hash');
      assert(!perm.bundle.includes('sessionId'), '1: the bundle contains no session cookie');
      assert(!perm.bundle.includes(FAKE_KEY), '1: the bundle contains no provider API key');

      // Status-aware count wording: a completed run must not be described as having
      // counted things "before failure".
      assert(perm.bundle.includes('Model-proposed workspace actions:')
        && perm.bundle.includes('Runtime-accepted workspace operations:')
        && perm.bundle.includes('Mutations committed:'),
        '1: a completed run uses neutral count wording');
      assert(!perm.bundle.includes('Model-proposed workspace actions before failure')
        && !perm.bundle.includes('Runtime-accepted workspace operations before failure')
        && !perm.bundle.includes('Mutations committed before failure'),
        '1: a completed run omits "before failure" count wording entirely');

      assert(/deletePath path=\S+ status=ok historyId=\d+/.test(perm.bundle)
        && perm.bundle.includes(`path=${permitPath}`),
        '1: the workspace action renders with its operation, path, status, and history id');
      assert(!perm.bundle.includes('[object Object]') && !perm.bundle.includes('path=unavailable status=ok'),
        '1: no action renders as [object Object] or as an unavailable path');

      // ══ 2. Blocked cross-ticket delete ════════════════════════════════════
      const blockPath = `diag-block/CD-${STAMP}.txt`;
      const blocked = await deleteFlow(restrictedCookie, blockPath, 'block');
      assert(blocked.deleter.run.status === 'failed'
        && /conflict|previously produced/i.test(String(blocked.deleter.run.error || '')),
        `2: the unpermissioned delete run failed with a conflict (${blocked.deleter.run.status}: ${blocked.deleter.run.error})`);

      const block = await bundleFor(blocked.deleter.run.id);
      assert(block.bundle.includes('deletePath') && block.bundle.includes(blockPath),
        '2: the bundle names the blocked operation and its path');
      assert(block.bundle.includes(`conflictingTicketId: ${blocked.owner.ticket.id}`)
        && block.bundle.includes(`conflictingRunId: ${blocked.owner.run.id}`),
        '2: the bundle identifies the ticket and run that own the conflicting artifact');
      assert(/Runtime-accepted workspace operations before failure: \d+/.test(block.bundle)
        && /Mutations committed before failure: 0/.test(block.bundle),
        '2: a failed run uses "before failure" count wording and reports zero committed mutations');
      assert(block.bundle.includes('No operation-history mutation was committed for this run.')
        || block.bundle.includes('mutation committed: no'),
        '2: the bundle states plainly that nothing was committed');
      assert(!block.bundle.includes(FAKE_KEY) && !block.bundle.includes('passwordHash') && !block.bundle.includes('sessionId'),
        '2: redaction holds on the blocked bundle too');

      // ══ 3. Phase/stall failure shape ══════════════════════════════════════
      // Seeded directly rather than orchestrated: the point is bundle count fidelity
      // for a run that proposed mutations during planning and had none accepted.
      // Orchestrating the live runtime into exactly this shape would test the
      // runtime, not the bundle.
      const adminUser = await store.getUserByUsername('admin');
      const now = () => new Date().toISOString();
      const fixtureObjective = `Delete CD ${STAMP}`;
      const fixtureTicket = (await store.createTicketWithEvent({
        ticket: {
          objective: fixtureObjective, acceptanceCriteria: null,
          assignmentTargetType: 'agent', assignmentTargetId: agents[0].id, assignmentMode: 'individual',
          ownedOutputPaths: null, targetRef: null, executionMode: 'agent',
          workflowId: null, workflowInput: null,
          capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
          executionPolicy: {
            mode: 'assisted', requireVerification: 'when_declared', autoRetry: false,
            maxAttempts: null, maxRuntimeMs: null, maxModelRequests: null, maxWorkspaceOperations: null,
            allowWorkspaceWrites: true, allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'shared'
          },
          workTypeId: null, workTypeSnapshot: null, workContextId: null, workContextSnapshot: null,
          // T2 Tranche 5: Ticket-level `failed` is retired; the fixture
          // ticket holds 'open' (the RUN below still fails, unchanged).
          status: 'open', createdBy: 'admin', changedBy: 'admin',
          changedAt: now(), createdAt: now(), updatedAt: now()
        },
        eventPayload: { source: 'run-diagnostics-bundle-test' }
      })).ticket;

      const stepLimitError = 'Run hit the step limit (run:step_limit) after repeated complete:false responses with no workspace actions.';
      const fixtureRun = await store.createRun({
        ticketId: fixtureTicket.id, agentId: agents[0].id, agentName: agents[0].name,
        delegatedUserId: adminUser.id, delegatedUsername: 'admin', delegatedPermissionSource: 'created_from_ticket',
        executionMode: 'agent', capabilityType: 'directAction', capabilityId: 'agent-selected-actions',
        runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot(),
        executionPolicySnapshot: { requireVerification: 'when_declared' },
        ownedOutputPaths: [], workspaceRoot, mainWorkspaceRoot: workspaceRoot, executionWorkspaceType: 'main',
        status: 'pending'
      });
      const fixtureClaim = await store.claimPendingRun({
        leaseOwner: 'diagnostics-fixture', leaseDurationMs: 60000, eligibleRunIds: [fixtureRun.id]
      });
      const fixtureStarted = await store.transitionRun({
        runId: fixtureRun.id, expectedRevision: fixtureClaim.run.revision, fromStatuses: ['pending'],
        toStatus: 'running', leaseOwner: 'diagnostics-fixture', eventType: 'run.started'
      });
      await store.transitionRun({
        runId: fixtureRun.id, expectedRevision: fixtureStarted.run.revision, fromStatuses: ['running'],
        toStatus: 'failed', leaseOwner: 'diagnostics-fixture', eventType: 'run.execution_failed',
        patch: { error: stepLimitError, completedAt: now() },
        eventPayload: { status: 'failed' }
      });
      await store.initializeRunReplay({
        runId: fixtureRun.id, ticketId: fixtureTicket.id,
        snapshot: {
          version: 1, runId: fixtureRun.id, ticketId: fixtureTicket.id,
          assignedAgentId: agents[0].id, agentNameSnapshot: agents[0].name,
          provider: 'openai', model: 'fake-openai-0',
          runtimeEnvelope: {}, ticketObjectiveSnapshot: fixtureObjective, systemInstructionSnapshot: 'sys',
          primitiveContract: {}, workspaceRoot, mainWorkspaceRoot: workspaceRoot,
          executionWorkspaceType: 'main',
          terminalStatus: 'failed',
          failureReason: 'Run hit the step limit after repeated complete:false responses with no workspace actions.',
          providerRequests: [{}, {}, {}],
          modelResponses: [{}, {}, {}],
          workspaceOperations: [],
          parsedModelPlans: [
            { step: 0, message: 'planning', complete: false, actions: [{ operation: 'deletePath', args: { path: 'CD' } }, { operation: 'listDirectory', args: { path: '/' } }] },
            { step: 2, message: 'planning', complete: false, actions: [{ operation: 'deletePath', args: { path: 'CD' } }, { operation: 'listDirectory', args: { path: '' } }] }
          ],
          events: [
            { type: 'execution.phase_violation', message: 'mixed mutation and inspection actions' },
            { type: 'execution.phase_violation', message: 'mixed mutation and inspection actions' },
            { type: 'model:stalled', message: 'complete:false with no workspace actions' },
            { type: 'model:stalled', message: 'complete:false with no workspace actions' },
            { type: 'run:step_limit', message: 'step limit reached' }
          ],
          mutationCount: 0, mutationOutcome: 'no_mutations',
          createdAt: now(), finalizedAt: now()
        }
      });

      const fx = await bundleFor(fixtureRun.id);
      assert(fx.bundle.includes('Model-proposed workspace actions before failure: 4'),
        '3: proposed actions are counted across every parsed plan');
      assert(fx.bundle.includes('Runtime-accepted workspace operations before failure: 0'),
        '3: nothing was accepted, and the bundle says so');
      assert(fx.bundle.includes('Mutations committed before failure: 0'),
        '3: nothing was committed, and the bundle says so');
      assert(fx.bundle.includes('Phase violations: 2'), '3: phase violations are counted from the replay events');
      assert(fx.bundle.includes('Model stalls: 2'), '3: model stalls are counted from the replay events');
      assert(fx.bundle.includes('Replay event count: 5'), '3: the replay event count is reported');
      assert(fx.bundle.includes('run:step_limit'), '3: the terminating event type is surfaced');
      assert(fx.bundle.includes('deletePath CD'), '3: the proposed mutation is named with its path');
      assert(fx.bundle.includes('step 0: deletePath CD') && fx.bundle.includes('step 0: listDirectory /')
        && fx.bundle.includes('step 2: deletePath CD') && fx.bundle.includes('step 2: listDirectory ""'),
        '3: proposed actions are listed per step, preserving the step numbers');
      assert(fx.bundle.includes('failed before workspace execution')
        && fx.bundle.includes('No workspace operation was accepted')
        && fx.bundle.includes('no mutation was committed'),
        '3: the summary explains the phase/stall failure in those terms');
      // The regression this shape was written for: these counts once rendered as
      // zeros regardless of the evidence.
      assert(!fx.bundle.includes('Phase violations: 0') && !fx.bundle.includes('Model stalls: 0')
        && !fx.bundle.includes('Replay event count: 0')
        && !fx.bundle.includes('Workspace actions attempted before failure: 0'),
        '3: the counts are derived from evidence rather than rendered as false zeros');
      assert(!fx.bundle.includes(FAKE_KEY) && !fx.bundle.includes('passwordHash') && !fx.bundle.includes('sessionId'),
        '3: redaction holds on the seeded bundle too');

      console.log(`\nPASS: run diagnostics bundle — ${assert.count()} assertions (PostgreSQL-native)`);
    }, { schemaSlug: 'run_diagnostics_bundle' });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(`\nFAIL: run diagnostics bundle — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
