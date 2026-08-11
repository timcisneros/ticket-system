#!/usr/bin/env node
'use strict';

// Runner-produced REAL artifact-domain closure. Every non-ideal artifact below
// traverses runTrial, the production server, durable PostgreSQL state and a
// controlled final provider boundary. Selected artifacts are then mixed into a
// complete 120-slot corpus consumed by the actual production report command.
// The boundary never opens a network connection.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { withHarness, createAsserter } = require('./postgres-test-harness');
const { ARMS } = require('./fixtures/evaluation-arms');
const { getScenario } = require('./fixtures/evaluation-scenarios');
const { runTrial } = require('./structured-allocation-evaluation-runner');
const {
  LIVE_ARTIFACT_DOMAIN_VERSION, LIVE_RUNNER_REACHABILITY_CLASSES,
  SCORABLE_PRODUCT_EVIDENCE,
  assertLiveProductArtifactScorable, evaluateLiveArtifactDisposition
} = require('./fixtures/evaluation-live-artifact-domain');
const {
  READINESS_DRESS_REHEARSAL_EVIDENCE_CLASS,
  trialIdForLiveAssignment
} = require('./fixtures/evaluation-live-scoring');
const {
  REAL_LIVE_ARTIFACT_LABEL
} = require('./fixtures/evaluation-live-corpus-integrity');
const {
  resolveRealLiveCredentialAuthority
} = require('./fixtures/evaluation-server-env');
const {
  ROLE_ECONOMICS
} = require('./fixtures/governed-role-policy-container');
const {
  assertDispatchWithinGlobalCeiling
} = require('./fixtures/evaluation-live-budget-ledger');
const { appendJournal } = require('./fixtures/evaluation-live-run-journal');
const { hashCanonical } = require('./structured-allocation-evaluation-scorer');
const {
  headerFor, liveManifest
} = require('./evaluation-live-scoring-dress-rehearsal-test');

const ROOT = path.resolve(__dirname, '..');
const DUMMY_CREDENTIAL = 'test-only-artifact-domain-credential';
const CONTROLS = Object.freeze({
  temperature: liveManifest.sampling.temperature,
  topP: liveManifest.sampling.topP,
  maxOutputTokens: liveManifest.maximumOutputTokensPerRequest
});

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeSpec(root, name, value) {
  const target = path.join(root, `${name}.json`);
  writeJson(target, value);
  return target;
}

function trialAuthority(slot) {
  const cell = liveManifest.cells.find(entry => entry.cellKey === slot.cellKey);
  return {
    trialId: trialIdForLiveAssignment(slot),
    expectedOracleAuthority: cell.expectedOracleAuthority,
    expectedQuiescence: cell.expectedQuiescence
  };
}

function slotOf({ scenarioId, armId, repetition = 1 }) {
  const slot = liveManifest.slots.find(entry => entry.scenarioId === scenarioId &&
    entry.armId === armId && entry.repetition === repetition);
  if (!slot) throw new Error(`no live-v3 slot for ${scenarioId}/${armId}/r${repetition}`);
  return slot;
}

function header() {
  const value = {
    ...headerFor(liveManifest),
    liveArtifactDomainVersion: LIVE_ARTIFACT_DOMAIN_VERSION,
    evidenceClass: READINESS_DRESS_REHEARSAL_EVIDENCE_CLASS,
    readinessDressRehearsal: true,
    syntheticAcceptance: false,
    syntheticAcceptanceLabel: null,
    economics: {
      maximumTotalLiveMicroUsd: liveManifest.economics.maximumTotalLiveMicroUsd,
      committedMicroUsd: liveManifest.economics.computedWorstCaseMicroUsd
    }
  };
  delete value.runHeaderHash;
  value.runHeaderHash = hashCanonical(value);
  return Object.freeze(value);
}

function boundaryRows(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}

async function waitForTransportInvocation({ ticketId, store }) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const result = await store.pool.query(
      `SELECT run.id, run.status,
              EXISTS (
                SELECT 1 FROM ${store.table('events')} AS event
                 WHERE event.run_id = run.id AND event.type = 'provider.transport_invoked'
              ) AS transport_invoked
         FROM ${store.table('runs')} AS run
        WHERE run.ticket_id = $1
          AND EXISTS (
            SELECT 1 FROM ${store.table('events')} AS event
             WHERE event.run_id = run.id AND event.type = 'provider.transport_invoked'
          )
        ORDER BY run.id LIMIT 1`, [ticketId]);
    const row = result.rows[0];
    if (row && row.status === 'running' && row.transport_invoked === true) {
      return Number(row.id);
    }
    if (Date.now() >= deadline) {
      throw new Error('controlled interruption never reached running + transport invoked');
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function stopAfterTransportInvocation(input) {
  const runId = await waitForTransportInvocation(input);
  const stopped = await input.server.request('POST', `/api/runs/${runId}/stop`, {
    headers: { Cookie: input.cookieHeader }
  });
  assert.equal(stopped.statusCode, 200,
    `controlled interruption route failed: ${stopped.body}`);
}

async function releaseWorkersAfterTerminalTicket({ ticketId, store, gatePath, trace }) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const result = await store.pool.query(
      `SELECT ticket.status,
              (SELECT MIN(event.ts) FROM ${store.table('events')} AS event
                WHERE event.ticket_id = ticket.id AND event.run_id IS NULL
                  AND event.type = 'ticket.updated'
                  AND event.payload->>'status' IN ('completed', 'failed', 'blocked'))
                AS terminal_ticket_at,
              (SELECT COUNT(*)::int FROM ${store.table('events')} AS event
                WHERE event.ticket_id = ticket.id
                  AND event.type = 'run.progress_blocked') AS progress_blocks
         FROM ${store.table('tickets')} AS ticket WHERE ticket.id = $1`, [ticketId]);
    const row = result.rows[0];
    if (row && ['completed', 'failed', 'blocked'].includes(row.status) &&
        row.terminal_ticket_at && Number(row.progress_blocks) === 0) {
      // Keep the runner proof independent of JavaScript Date millisecond
      // truncation: release the sibling only after PostgreSQL's own clock has
      // crossed a distinct timestamp boundary following terminalization. This
      // is an authoritative condition wait, not a race won by a fixed sleep.
      const clock = (await store.pool.query(
        `SELECT clock_timestamp() >= $1::timestamptz + interval '5 milliseconds' AS ready`,
        [row.terminal_ticket_at])).rows[0];
      if (clock.ready !== true) {
        await new Promise(resolve => setTimeout(resolve, 1));
        continue;
      }
      trace.ticketStatusBeforeGate = row.status;
      trace.terminalTicketAt = new Date(row.terminal_ticket_at).toISOString();
      fs.writeFileSync(gatePath, 'terminal ticket observed before later workers\n', {
        mode: 0o600, flag: 'wx'
      });
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error('controlled temporal class never reached terminal Ticket before a progress block');
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-artifact-domain-pg-'));
  const corpusRoot = path.join(root, 'mixed-corpus');
  const executionBudgetRoot = path.join(root, 'execution-budget');
  fs.mkdirSync(executionBudgetRoot, { recursive: true });
  const runHeader = header();
  const actual = new Map();

  try {
    await withHarness('REAL artifact domain closure',
      async ({ store, workspaceRoot, startServer }) => {
        const assertThat = createAsserter();
        const resolved = await resolveRealLiveCredentialAuthority({
          store: { getConfiguredAgentById: async () => ({
            id: 901, revision: 1, provider: 'openai',
            model: 'credential-authority-only', apiKey: DUMMY_CREDENTIAL
          }) },
          credentialAuthority: { kind: 'configured_agent', configuredAgentId: 901 },
          expectedProvider: 'openai'
        });
        const liveBudget = {
          runRoot: executionBudgetRoot,
          ceilingMicroUsd: liveManifest.economics.maximumTotalLiveMicroUsd,
          perRequestMicroUsd: liveManifest.economics.liability.perRequestMicroUsd,
          runtimeMaxModelRequestsPerRun:
            liveManifest.economics.liability.runtimeMaxModelRequestsPerRun,
          governedLeafMaximumProviderRequests:
            ROLE_ECONOMICS.structured_leaf_executor.maximumProviderRequests,
          governedPlannerMaximumProviderRequests:
            ROLE_ECONOMICS.structured_planner.maximumProviderRequests
        };

        const cases = [
          {
            name: 'normal-success',
            reachabilityClass: 'successful_completion',
            slot: slotOf({ scenarioId: 'family-2-cleanly-separable', armId: 'A' }),
            spec: { kind: 'objective-folders' }
          },
          {
            name: 'truthful-product-failure',
            reachabilityClass: 'truthful_product_failure',
            slot: slotOf({ scenarioId: 'family-2-cleanly-separable-alt', armId: 'A' }),
            spec: { kind: 'literal', text: JSON.stringify({
              message: 'Unable to complete the declared work.', actions: [], complete: false
            }) }
          },
          {
            name: 'provider-refusal',
            reachabilityClass: 'provider_refusal',
            slot: slotOf({ scenarioId: 'family-5-ownership-known', armId: 'A' }),
            spec: { kind: 'provider-refusal' }
          },
          {
            name: 'malformed-output',
            reachabilityClass: 'malformed_response',
            slot: slotOf({ scenarioId: 'family-5-ownership-known-alt', armId: 'A' }),
            spec: { kind: 'literal', text: 'controlled malformed output' }
          },
          {
            name: 'action-authority-refusal',
            reachabilityClass: 'action_authority_refusal',
            slot: slotOf({ scenarioId: 'family-6-ownership-unknown', armId: 'A' }),
            spec: { kind: 'literal', text: JSON.stringify({
              message: 'Four controlled mutations.', complete: true,
              actions: [1, 2, 3, 4].map(index => ({
                operation: 'createFolder', args: { path: `reports/over-cap-${index}` }
              }))
            }) }
          },
          {
            name: 'coupling-oracle-refusal',
            reachabilityClass: 'coupling_oracle_refusal',
            slot: slotOf({ scenarioId: 'family-3-sibling-dependency', armId: 'A' }),
            spec: { kind: 'objective-folders' }
          },
          {
            name: 'budget-limited-no-progress',
            reachabilityClass: 'budget_limited_termination',
            slot: slotOf({ scenarioId: 'family-2-cleanly-separable', armId: 'A2a', repetition: 2 }),
            spec: { kind: 'literal', text: JSON.stringify({
              message: 'No declared fact advanced.', actions: [], complete: false
            }) }
          },
          {
            name: 'governed-no-progress',
            reachabilityClass: 'governed_no_progress',
            slot: slotOf({ scenarioId: 'family-5-ownership-known', armId: 'B', repetition: 2 }),
            spec: { kind: 'role-aware-structured-inspection' }
          },
          {
            name: 'unsupported-completion-claim',
            reachabilityClass: 'unsupported_completion_claim',
            slot: slotOf({ scenarioId: 'family-5-ownership-known-alt', armId: 'C',
              repetition: 2 }),
            spec: { kind: 'role-aware-structured-no-evidence-completion' }
          },
          {
            name: 'product-timeout',
            reachabilityClass: 'runtime_timeout',
            slot: slotOf({ scenarioId: 'family-2-cleanly-separable-alt', armId: 'A', repetition: 3 }),
            spec: { kind: 'hang' },
            quiescenceTimeoutMs: 100
          },
          {
            name: 'governed-delivery-uncertainty-timeout',
            reachabilityClass: 'delivery_uncertainty',
            slot: slotOf({ scenarioId: 'family-2-cleanly-separable-alt', armId: 'B',
              repetition: 3 }),
            spec: { kind: 'role-aware-planner-success-worker-hang' },
            quiescenceTimeoutMs: 100,
            afterTicketCreated: waitForTransportInvocation
          },
          {
            name: 'interrupted-recoverable',
            reachabilityClass: 'interrupted_recoverable',
            slot: slotOf({ scenarioId: 'family-6-ownership-unknown-alt', armId: 'A',
              repetition: 3 }),
            spec: { kind: 'hang' },
            afterTicketCreated: stopAfterTransportInvocation
          },
          {
            name: 'terminal-ticket-before-later-leaf-block',
            reachabilityClass: 'terminal_ticket_before_later_progress_block',
            slot: slotOf({ scenarioId: 'family-2-cleanly-separable', armId: 'C',
              repetition: 1 }),
            temporalTrace: {},
            gatePath: path.join(root, 'terminal-before-block.gate'),
            spec: {
              kind: 'role-aware-terminal-before-progress-block',
              failureTarget: 'controlled-outside-all-owned-roots/refusal'
            }
          }
        ];
        const temporalCase = cases.find(entry =>
          entry.name === 'terminal-ticket-before-later-leaf-block');
        temporalCase.spec.gatePath = temporalCase.gatePath;
        temporalCase.afterTicketCreated = input => releaseWorkersAfterTerminalTicket({
          ...input, gatePath: temporalCase.gatePath, trace: temporalCase.temporalTrace
        });
        assertThat(new Set(cases.map(entry => entry.reachabilityClass)).size ===
          LIVE_RUNNER_REACHABILITY_CLASSES.length &&
          LIVE_RUNNER_REACHABILITY_CLASSES.every(required =>
            cases.some(entry => entry.reachabilityClass === required)),
        'actual-runner cases cover every source-owned reachable candidate class');

        const controlledByTrial = new Map(cases.map(entry =>
          [trialIdForLiveAssignment(entry.slot), entry]));
        const entries = liveManifest.slots.map(slot => {
          const controlled = controlledByTrial.get(trialIdForLiveAssignment(slot));
          if (controlled) return controlled;
          return {
            name: `ordinary-${trialIdForLiveAssignment(slot)}`,
            slot,
            spec: { kind: ['B', 'C'].includes(slot.armId)
              ? 'role-aware-structured-success' : 'objective-folders' }
          };
        });

        for (const entry of entries) {
          const id = trialIdForLiveAssignment(entry.slot);
          const outputPath = path.join(root, 'actual', `${id}.json`);
          const observationPath = path.join(root, `boundary-${entry.name}.jsonl`);
          const responsePath = entry.spec ? writeSpec(root, `response-${entry.name}`, entry.spec) : null;
          const artifact = await runTrial({
            store, startServer, workspaceRoot,
            scenario: getScenario(entry.slot.scenarioId),
            arm: ARMS[entry.slot.armId],
            variant: entry.slot.variantId,
            repetition: entry.slot.repetition,
            seed: entry.slot.stochasticIdentity,
            outputPath,
            commit: runHeader.repositoryCommit,
            smokeRoot: root,
            namespaceRoot: path.join(root, 'namespaces'),
            mode: 'live',
            resolvedLiveCredentialAuthority: resolved,
            liveRequestControls: CONTROLS,
            liveTransportCapture: null,
            liveProviderBoundaryObservation: observationPath,
            liveProviderBoundaryResponse: responsePath,
            liveBudget,
            quiescenceTimeoutMs: entry.quiescenceTimeoutMs,
            afterTicketCreated: entry.afterTicketCreated,
            scoredIdentity: {
              label: REAL_LIVE_ARTIFACT_LABEL,
              scoredRunHash: runHeader.runHeaderHash,
              manifestHash: liveManifest.manifestHash,
              trialSlot: entry.slot.slot,
              trialId: id
            }
          });
          const result = evaluateLiveArtifactDisposition({
            artifact, trial: trialAuthority(entry.slot), manifest: liveManifest
          });
          assertThat(result.disposition === SCORABLE_PRODUCT_EVIDENCE,
            `${entry.name}: runner-produced accepted artifact is immediately scorable`);
          assertLiveProductArtifactScorable({
            artifact, trial: trialAuthority(entry.slot), manifest: liveManifest
          });
          assertThat(artifact.observationCompleteness === 'unavailable' &&
            artifact.churnFacts.evidenceAuthority === 'durable_ticket_report_v1',
          `${entry.name}: REAL sink absence stays truthful while churn uses durable product evidence`);
          if (entry.name === 'coupling-oracle-refusal') {
            assertThat(artifact.oracleResult.verdict === 'refused' &&
              artifact.truthfulness === 'oracle_refused',
            'coupling oracle: unavailable access observation refuses instead of guessing');
          }
          if (entry.name === 'normal-success') {
            assertThat(artifact.ticketReport.productClaimsCompleted === true &&
              artifact.oracleResult.verdict === 'pass',
            'normal success: product completion and independent oracle both pass');
          }
          if (entry.name === 'truthful-product-failure') {
            assertThat(artifact.ticketReport.productClaimsCompleted === false,
              'truthful product failure: the product does not claim completion');
          }
          if (entry.name === 'provider-refusal' || entry.name === 'malformed-output') {
            assertThat(artifact.ticketReport.productClaimsCompleted === false,
              `${entry.name}: unusable model output remains a product noncompletion`);
          }
          if (entry.name === 'action-authority-refusal') {
            assertThat(artifact.ticketReport.operationReceiptCount === 0 &&
              artifact.ticketReport.productClaimsCompleted === false,
            'action-authority refusal: over-cap actions do not mutate and remain product data');
          }
          if (entry.name === 'budget-limited-no-progress') {
            assertThat(artifact.ticketReport.productClaimsCompleted === false &&
              artifact.ticketReport.canonicalRequests.length > 0,
            'budget-limited noncompletion: bounded attempts remain product data');
          }
          if (entry.name === 'governed-no-progress') {
            assertThat(artifact.ticketReport.productClaimsCompleted === false &&
              artifact.ticketReport.canonicalRequests.length > 1 &&
              artifact.churnFacts.noProgressStreak === 0,
            'governed no-progress: repeated product noncompletion stays data while ' +
              'churn remains bound to the absence of a persisted progress block');
          }
          if (entry.name === 'unsupported-completion-claim') {
            assertThat(artifact.ticketReport.productClaimsCompleted === false &&
              ['failed', 'blocked'].includes(artifact.pathProof.ticketResultStatus),
            'unsupported completion: missing product evidence cannot become a successful claim');
          }
          if (entry.name === 'product-timeout') {
            assertThat(artifact.quiescence.timedOut === true &&
              artifact.oracleResult.verdict === 'refused',
            'product timeout: retained as product data without a pre-quiescence oracle guess');
          }
          if (entry.name === 'governed-delivery-uncertainty-timeout') {
            assertThat(artifact.quiescence.timedOut === true &&
              artifact.normalizedCost.unmeteredRequestCount >= 1 &&
              artifact.churnFacts.planner.attemptedTransports >= 1 &&
              artifact.churnFacts.worker.durableResponses === 0,
            'governed delivery uncertainty: started request is costed conservatively and ' +
              'remains distinct from a durable response or churn window');
          }
          if (entry.name === 'interrupted-recoverable') {
            assertThat(artifact.pathProof.ticketResultStatus === 'open' &&
              artifact.ticketReport.terminalRunStatuses.every(status => status === 'interrupted') &&
              result.detail.terminalClass === 'interrupted_recoverable',
            'interruption: normal stop route produces a scorable recoverable-open Ticket shape');
          }
          if (entry.name === 'terminal-ticket-before-later-leaf-block') {
            const ordering = (await store.pool.query(
              `SELECT
                 (SELECT MIN(event.ts) FROM ${store.table('events')} AS event
                   WHERE event.ticket_id = $1 AND event.run_id IS NULL
                     AND event.type = 'ticket.updated'
                     AND event.payload->>'status' IN ('completed', 'failed', 'blocked'))
                   AS terminal_ticket_at,
                 (SELECT MIN(event.ts) FROM ${store.table('events')} AS event
                   WHERE event.ticket_id = $1
                     AND event.type = 'run.progress_blocked') AS progress_block_at,
                 (SELECT MIN(event.position) FROM ${store.table('events')} AS event
                   WHERE event.ticket_id = $1 AND event.run_id IS NULL
                     AND event.type = 'ticket.updated'
                     AND event.payload->>'status' IN ('completed', 'failed', 'blocked'))
                   AS terminal_ticket_position,
                 (SELECT MIN(event.position) FROM ${store.table('events')} AS event
                   WHERE event.ticket_id = $1
                     AND event.type = 'run.progress_blocked') AS progress_block_position,
                 (SELECT MIN(event.ts) FROM ${store.table('events')} AS event
                   WHERE event.ticket_id = $1 AND event.run_id IS NULL
                     AND event.type = 'ticket.updated'
                     AND event.payload->>'status' IN ('completed', 'failed', 'blocked'))
                   <=
                 (SELECT MIN(event.ts) FROM ${store.table('events')} AS event
                   WHERE event.ticket_id = $1
                     AND event.type = 'run.progress_blocked') AS terminal_not_after_block`,
              [artifact.ticketReport.ticketId])).rows[0];
            const ordered = ordering.terminal_ticket_at && ordering.progress_block_at &&
              ordering.terminal_not_after_block === true &&
              BigInt(ordering.terminal_ticket_position) < BigInt(ordering.progress_block_position);
            assertThat(ordered,
              'temporal class: authoritative parent terminalization precedes the later leaf block');
            assertThat(entry.temporalTrace.ticketStatusBeforeGate &&
              artifact.churn.progressBlocks >= 1 &&
              (artifact.latency.withheldMs === null ||
                (Number.isFinite(artifact.latency.withheldMs) &&
                  artifact.latency.withheldMs >= 0)) &&
              result.detail.metricValidity.latency === true,
            'temporal class: next-request or defined-null withheld authority remains scorable ' +
              JSON.stringify({ trace: entry.temporalTrace, progressBlocks: artifact.churn.progressBlocks,
                withheldMs: artifact.latency.withheldMs,
                latencyDefined: result.detail.metricValidity.latency }));
          }
          const rows = boundaryRows(observationPath);
          assertThat(rows.every(row => row.hostname === 'api.openai.com'),
            `${entry.name}: the controlled boundary intercepted every provider target`);
          actual.set(id, artifact);
        }
      }, { timeoutMs: 20 * 60 * 1000 });

    // Complete the exact live-v3 corpus exclusively with controlled artifacts
    // produced by runTrial. The representative non-ideal shapes remain
    // byte-for-byte in the production command's input; no slot is filled by a
    // hand-built scoring fixture.
    writeJson(path.join(corpusRoot, 'live-run-header.json'), runHeader);
    writeJson(path.join(corpusRoot, 'PROVIDER-FREE-SCORING-DRESS-REHEARSAL.json'), {
      evidenceClass: READINESS_DRESS_REHEARSAL_EVIDENCE_CLASS,
      manifestHash: liveManifest.manifestHash,
      providerCalls: 0,
      runnerProducedMixedArtifactCount: actual.size
    });
    const bind = { runHeaderHash: runHeader.runHeaderHash,
      manifestHash: liveManifest.manifestHash };
    for (const slot of liveManifest.slots) {
      const id = trialIdForLiveAssignment(slot);
      const artifact = actual.get(id);
      assert.ok(artifact, `runner artifact missing for ${id}`);
      writeJson(path.join(corpusRoot, 'trials', `${id}.json`), artifact);
      assertDispatchWithinGlobalCeiling({
        runRoot: corpusRoot,
        ceilingMicroUsd: liveManifest.economics.maximumTotalLiveMicroUsd,
        maximumLiabilityMicroUsd:
          liveManifest.economics.liability.byArm[slot.armId].perTrialMicroUsd,
        trialId: id, role: `mixed_domain_rehearsal:${slot.armId}`, ordinal: slot.slot
      });
      appendJournal(corpusRoot, { ...bind, event: 'slot_accepted', trialId: id,
        slotOrdinal: slot.slot, controlledProviderCalls: 0,
        runnerProduced: actual.has(id) });
    }
    appendJournal(corpusRoot, { ...bind, event: 'run_complete', trialId: null,
      slotOrdinal: null, acceptedCount: 120, assignedCount: 120 });

    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key === 'OPENAI_API_KEY' || key.startsWith('STRUCTURED_ALLOCATION_LIVE_') ||
          key.startsWith('EVALUATION_LIVE_')) delete env[key];
    }
    const reportResult = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts/structured-allocation-evaluation-report-live.js'),
      corpusRoot, '--readiness-dress-rehearsal'
    ], { cwd: ROOT, env, encoding: 'utf8' });
    assert.equal(reportResult.status, 0,
      `production report command failed: ${reportResult.stderr}`);
    const report = JSON.parse(fs.readFileSync(path.join(corpusRoot,
      'structured-allocation-live-scoring-dress-rehearsal-v3.json'), 'utf8'));
    assert.equal(report.counts.assigned, 120);
    assert.equal(report.counts.executed, 120);
    assert.deepEqual(Object.keys(report.metricsByArm), ['A', 'A2a', 'A2b', 'B', 'C']);
    assert.equal(report.authorizedDimensions.length, 5);
    assert.equal(report.hardDisqualifiers.length, 5);
    assert.ok(['RETAIN', 'REVISE', 'STOP'].includes(report.liveOrdinaryDecision.ordinaryDecision));
    assert.ok(['RETAIN', 'REVISE', 'STOP'].includes(report.finalProductDecision));
    console.log(`REAL artifact domain runner/mixed production closure passed — ` +
      `${actual.size} runner artifacts in 120 slots; provider calls 0`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
