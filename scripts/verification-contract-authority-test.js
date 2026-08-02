#!/usr/bin/env node
'use strict';
// Verification contract authority — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// Replaces the JSON-era `verification-contract-reconciliation-test.js`, which asserted
// the right contract against a runtime that no longer exists (it copied `data/*.json`
// into a temp dir and read `runs.json` back). The contract it guarded is the one this
// suite keeps.
//
// THE QUESTION THIS SUITE ANSWERS: when a run finishes, WHOSE definition of "verified"
// applies — the workflow as it exists now, or the workflow as it existed when the run
// started? It must be the latter. A workflow is mutable operator configuration; a run
// is a durable claim about work that already happened. If verification read live
// workflow state, editing a workflow would retroactively change what past runs proved,
// in both directions: relaxing it would launder a failure into a pass, and tightening
// it would convict a run of violating a rule that did not exist.
//
// THE MECHANISM. Each scenario crashes the server at `before_run.snapshot_finalized`
// — after execution, before terminalization — then MUTATES THE WORKFLOW while the
// process is down, then restarts. Startup recovery reconciles the run. Whether it uses
// the run's captured snapshot or the live catalog is then directly observable, because
// the two now disagree on purpose.
//
//   relaxed  the live workflow drops its postconditions; the run violated the ORIGINAL
//            one, so it must still FAIL. A runtime reading live state would pass it.
//   stricter the live workflow adds a requirement the run never had to meet; the run
//            satisfied the ORIGINAL one, so it must still PASS. A runtime reading live
//            state would fail it.
//
// The pair is the control structure: no single "reads the snapshot" implementation and
// no blanket pass/fail satisfies both directions at once.
//
// IT ALSO PINS WHEN VERIFICATION IS REQUIRED AT ALL. `isRunVerificationRequired` is
// governed by the run's captured contract, not by `executionPolicy.requireVerification`
// — which `normalizeExecutionPolicy` pins to its single supported value and cannot be
// used to force verification on or off. Scenarios 3-5 prove that a snapshot which is
// absent, empty, or missing its own `workflowId` leaves verification NOT required, and
// scenario 6 proves the boundary that stores a raw policy now rejects any other
// `requireVerification` value instead of silently downgrading it.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const { assertScenariosExecuted } = require('./child-process-settlement');
const { currentRuntimeLimitsSnapshot } = require('./current-run-fixture');

const STAMP = Date.now();
const assert = createAsserter();
let scenariosRun = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// The workflow runs deterministically without a model: `writeFile` then `stop`.
function createPreload() {
  const preloadPath = path.join(os.tmpdir(), `verification-contract-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
global.fetch = async function() {
  return {
    ok: true, status: 200,
    headers: new Map([['x-request-id', 'fake-verification-contract']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify({ message: 'workflow run', actions: [], complete: true }),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
};
`);
  return preloadPath;
}

async function main() {
  const preloadPath = createPreload();
  try {
    await withHarness('verification contract authority', async ({ store, startServer }) => {
      const agent = (await store.createConfiguredAgent({
        value: { name: `VerificationContract-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'k' },
        groupIds: [], changedBy: 'verification-contract-authority-test'
      })).agent;

      const env = {
        RUN_LEASE_DURATION_MS: '5000',
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        NODE_OPTIONS: `--require ${preloadPath}`
      };

      const ticketEvents = async ticketId =>
        (await store.listTicketEvents(ticketId, { limit: 400 })).events;

      // ── The crash/mutate/restart scenario ─────────────────────────────────
      // `expected` is what the ORIGINAL contract implies. The live workflow is edited
      // to imply the opposite, so a runtime reading live state lands on the other one.
      async function reconcileScenario({ label, written, originalPostconditions, mutatedPostconditions, expected }) {
        scenariosRun += 1;
        const workflowId = `vc-${label}-${STAMP}`;
        const outputPath = `${label}-${STAMP}.txt`;

        const created = (await store.createWorkflow({
          value: {
            id: workflowId, name: `Verification contract ${label}`, version: '1', enabled: true,
            inputSchema: {},
            actions: [
              { id: 'write', action: 'writeFile', input: { path: outputPath, content: written }, next: 'done' },
              { id: 'done', action: 'stop', input: { result: { path: outputPath } } }
            ],
            postconditions: originalPostconditions(outputPath),
            verifierContract: { id: `${workflowId}-verifier`, version: '1' }
          },
          changedBy: 'verification-contract-authority-test'
        })).workflow;

        // ── Boot 1: crash after execution, before terminalization ───────────
        const first = await startServer({ env: { ...env, TEST_INTERRUPTION_POINT: 'before_run.snapshot_finalized' } });
        const cookie = await first.login();
        try {
          await first.request('POST', '/tickets', {
            cookie,
            form: {
              objective: `verification contract ${label} ${STAMP}`,
              capabilityType: 'workflow', workflowId, workflowInput: '{}',
              assignmentTargetType: 'agent', assignmentTargetId: String(agent.id),
              assignmentMode: 'individual'
            }
          });
        } catch (_) { /* expected: the seam kills the process mid-request */ }

        const run = await waitFor(async () => {
          const runs = (await store.listRuns({ limit: 100 })).runs || [];
          return runs.find(r => r.workflowId === workflowId) || null;
        }, 30000, `${label}: the interrupted run to be persisted`);

        // The snapshot must already be durable at the moment of the crash — if it were
        // captured at terminalization it would be captured from the MUTATED workflow,
        // and none of what follows would mean anything.
        assert(run.verificationContractSnapshot && run.verificationContractSnapshot.workflowId === workflowId,
          `${label}: the run captured its verification contract BEFORE the crash`);
        assert(JSON.stringify(run.verificationContractSnapshot.postconditions.map(p => p.id)) ===
               JSON.stringify(originalPostconditions(outputPath).map(p => p.id)),
          `${label}: the captured contract is the workflow's ORIGINAL contract`);
        const capturedSnapshot = JSON.stringify(run.verificationContractSnapshot);

        try { await first.stop(); } catch (_) { /* already dead */ }

        // ── Mutate the workflow while the process is down ───────────────────
        const current = await store.getWorkflowById(workflowId);
        await store.updateWorkflow({
          workflowId, expectedRevision: current.revision,
          value: { ...current, postconditions: mutatedPostconditions(outputPath) },
          changedBy: 'verification-contract-authority-test'
        });
        const reread = await store.getWorkflowById(workflowId);
        assert(JSON.stringify(reread.postconditions) !== JSON.stringify(created.postconditions),
          `${label}: the live workflow now genuinely disagrees with the run's snapshot`);

        // ── Boot 2: recovery reconciles the run ─────────────────────────────
        const second = await startServer({ env });
        const terminal = await waitFor(async () => {
          const latest = await store.getRun(run.id);
          return ['completed', 'failed', 'interrupted'].includes(latest.status) ? latest : null;
        }, 60000, `${label}: the run to reach a terminal status`);

        assert(terminal.status === expected,
          `${label}: reconciliation used the RUN SNAPSHOT, not the live workflow ` +
          `(expected ${expected}, got ${terminal.status}${terminal.error ? `: ${terminal.error}` : ''})`);

        // ── The evidence must say which contract it used ────────────────────
        const events = await waitFor(async () => {
          const all = (await ticketEvents(run.ticketId)).filter(e => e.runId === run.id);
          return all.some(e => e.type === 'run.postconditions_checked') ? all : null;
        }, 30000, `${label}: postcondition evidence`);

        const checked = events.find(e => e.type === 'run.postconditions_checked');
        assert(checked.payload && checked.payload.contractSource === 'run_snapshot',
          `${label}: the evidence records WHICH contract governed (got ${checked.payload && checked.payload.contractSource})`);
        const verdictType = expected === 'completed' ? 'run.verification_passed' : 'run.verification_failed';
        assert(events.some(e => e.type === verdictType),
          `${label}: the verification outcome is recorded as ${verdictType}`);

        // The replay snapshot must carry the same contract, or the durable record of
        // what was verified would not survive the run it describes.
        const replay = await store.readRunReplay(run.id);
        assert(replay && JSON.stringify(replay.snapshot.verificationContractSnapshot) === capturedSnapshot,
          `${label}: the replay snapshot preserved the contract verification used`);

        try { await second.stop(); } catch (_) { /* best effort */ }
        return run;
      }

      // ── 1. A RELAXED workflow cannot launder a failure into a pass ────────
      await reconcileScenario({
        label: 'relaxed',
        written: 'actual',
        originalPostconditions: p => [{ id: 'original', type: 'fileContains', path: p, contains: 'expected' }],
        mutatedPostconditions: () => [],
        expected: 'failed'
      });

      // ── 2. A STRICTER workflow cannot convict a run retroactively ─────────
      await reconcileScenario({
        label: 'stricter',
        written: 'original',
        originalPostconditions: p => [{ id: 'original', type: 'fileContains', path: p, contains: 'original' }],
        mutatedPostconditions: p => [{ id: 'stricter', type: 'fileContains', path: p, contains: 'never-written' }],
        expected: 'completed'
      });

      // ── 3-5. When is verification REQUIRED? ───────────────────────────────
      // Not by policy — by the run's captured contract. These probe the gate through
      // manual completion, which refuses only while required verification is
      // unresolved. Each fixture is a completed run with no passing verdict; the only
      // thing that varies is the SHAPE of the captured contract.
      const server = await startServer({ env: { ...env, RUNTIME_SCHEDULER_INTERVAL_MS: '3600000' } });
      const cookie = await server.login();
      const now = () => new Date().toISOString();

      async function completedRunWithContract(label, contractSnapshot, requireVerification = 'when_declared') {
        const ticket = (await store.createTicketWithEvent({
          ticket: {
            objective: `verification gate ${label} ${STAMP}`, acceptanceCriteria: null,
            assignmentTargetType: 'agent', assignmentTargetId: agent.id, assignmentMode: 'individual',
            ownedOutputPaths: null, targetRef: null, executionMode: 'agent',
            workflowId: null, workflowInput: null,
            capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
            executionPolicy: {
              mode: 'assisted', requireVerification, autoRetry: false,
              maxAttempts: null, maxRuntimeMs: null, maxModelRequests: null, maxWorkspaceOperations: null,
              allowWorkspaceWrites: true, allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'shared'
            },
            workTypeId: null, workTypeSnapshot: null, workContextId: null, workContextSnapshot: null,
            status: 'in_progress', createdBy: 'admin', changedBy: 'admin',
            changedAt: now(), createdAt: now(), updatedAt: now()
          },
          eventPayload: { source: 'verification-contract-authority-test' }
        })).ticket;

        const run = await store.createRun({
          ticketId: ticket.id, agentId: agent.id, agentName: agent.name,
          executionMode: 'workflow', workflowId: `wf-gate-${label}-${STAMP}`,
          verificationContractSnapshot: contractSnapshot,
          runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot(),
          executionPolicySnapshot: { requireVerification }, status: 'pending'
        });
        const claim = await store.claimPendingRun({
          leaseOwner: 'vc-fixture', leaseDurationMs: 60000, eligibleRunIds: [run.id]
        });
        const started = await store.transitionRun({
          runId: run.id, expectedRevision: claim.run.revision, fromStatuses: ['pending'],
          toStatus: 'running', leaseOwner: 'vc-fixture', eventType: 'run.started'
        });
        await store.transitionRun({
          runId: run.id, expectedRevision: started.run.revision, fromStatuses: ['running'],
          toStatus: 'completed', leaseOwner: 'vc-fixture', eventType: 'run.execution_completed',
          patch: { completedAt: now() }, eventPayload: { status: 'completed' }
        });
        return ticket;
      }

      const completeTicket = ticketId =>
        server.request('PATCH', `/api/tickets/${ticketId}/status`, { cookie, body: { status: 'completed' } });

      const validContract = label => ({
        workflowId: `wf-gate-${label}-${STAMP}`,
        workflowName: 'Gate fixture',
        capturedAt: now(),
        postconditions: [{ id: 'pc', type: 'fileExists', path: `gate-${STAMP}.txt` }]
      });

      // ── 3. A valid captured contract REQUIRES verification ────────────────
      // The positive control for the whole gate: without it, scenarios 4-5 would be
      // satisfied by a runtime that never requires verification at all.
      scenariosRun += 1;
      const requiredTicket = await completedRunWithContract('required', validContract('required'));
      const requiredResponse = await completeTicket(requiredTicket.id);
      assert(requiredResponse.statusCode >= 400 && requiredResponse.statusCode < 500,
        `3: a captured contract with postconditions REQUIRES verification (HTTP ${requiredResponse.statusCode})`);
      assert(/verif/i.test(String(requiredResponse.body)),
        '3: the refusal names verification as the reason');
      assert((await store.getTicket(requiredTicket.id)).status !== 'completed',
        '3: the ticket is not completed while verification is unresolved');

      // ── 4. NEGATIVE CONTROL — no contract, no requirement ─────────────────
      scenariosRun += 1;
      const absentTicket = await completedRunWithContract('absent', null);
      assert((await completeTicket(absentTicket.id)).statusCode === 200,
        '4: a run with NO captured contract does not require verification');
      assert((await store.getTicket(absentTicket.id)).status === 'completed',
        '4: and the completion actually persisted');

      // ── 5. NEGATIVE CONTROL — malformed contracts do not require it either ─
      // Both shapes normalize to null: an empty postcondition list declares nothing to
      // verify, and a snapshot without its own `workflowId` is rejected outright by
      // `normalizeVerificationContractSnapshot`. The second is the trap that made this
      // assertion look unreproducible twice — the field is easy to omit and its absence
      // silently disables the requirement, so it is pinned here deliberately.
      scenariosRun += 1;
      const emptyTicket = await completedRunWithContract('empty', {
        ...validContract('empty'), postconditions: []
      });
      assert((await completeTicket(emptyTicket.id)).statusCode === 200,
        '5: a captured contract declaring NO postconditions does not require verification');

      const anonymousContract = validContract('anonymous');
      delete anonymousContract.workflowId;
      const anonymousTicket = await completedRunWithContract('anonymous', anonymousContract);
      assert((await completeTicket(anonymousTicket.id)).statusCode === 200,
        '5: a contract snapshot with no workflow identity of its own does not require verification');
      assert((await store.getTicket(anonymousTicket.id)).status === 'completed',
        '5: the identity-less contract is treated as absent, not as a silent failure');

      // ── 6. The raw-policy boundary refuses a misleading configuration ─────
      // `normalizeExecutionPolicy` pins `requireVerification`, so a template author
      // writing anything else used to be silently downgraded and never told. Process
      // templates are the only surface that stores an UNNORMALIZED policy, so that is
      // where the value has to be refused.
      scenariosRun += 1;
      const templateBody = requireVerification => ({
        name: `vc-template-${requireVerification}-${STAMP}`,
        ticketTemplate: {
          objective: 'verification contract template', capabilityType: 'directAction',
          assignmentTargetType: 'agent', assignmentTargetId: agent.id, assignmentMode: 'individual',
          executionPolicy: { autoRetry: false, requireVerification }
        }
      });
      const rejected = await server.request('POST', '/api/process-templates',
        { cookie, body: templateBody('always') });
      assert(rejected.statusCode === 400,
        `6: a template declaring an unsupported requireVerification is REFUSED (HTTP ${rejected.statusCode})`);
      assert(/requireVerification/.test(String(rejected.body)),
        '6: the refusal names the offending field');
      assert(/when_declared/.test(String(rejected.body)),
        '6: and names the only supported value, so the author can fix it');

      // POSITIVE CONTROL: the supported value, and omission, both still work — the
      // guard must reject a wrong value, not the endpoint.
      const acceptedExplicit = await server.request('POST', '/api/process-templates',
        { cookie, body: templateBody('when_declared') });
      assert(acceptedExplicit.statusCode === 200,
        `6: the supported value is accepted (HTTP ${acceptedExplicit.statusCode}: ${String(acceptedExplicit.body).slice(0, 160)})`);
      const omitted = templateBody('when_declared');
      delete omitted.ticketTemplate.executionPolicy.requireVerification;
      omitted.name = `vc-template-omitted-${STAMP}`;
      assert((await server.request('POST', '/api/process-templates', { cookie, body: omitted })).statusCode === 200,
        '6: omitting the field entirely is still accepted');

      assertScenariosExecuted({
        label: 'verification contract authority',
        assertions: assert.count(),
        scenarios: scenariosRun,
        minAssertions: 24,
        minScenarios: 6
      });
      console.log(`\nPASS: verification contract authority — ${scenariosRun} scenarios, ${assert.count()} assertions (PostgreSQL-native)`);
    }, { schemaSlug: 'verification_contract' });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(`\nFAIL: verification contract authority — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
