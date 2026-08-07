#!/usr/bin/env node
'use strict';

// Tranche 6 — the persistent global live economic ceiling, and the corrected
// readiness facts.
//
// The cap is the one thing in this evaluation that cannot be corrected after
// the fact: money spent past it is gone. So the ledger is durable, the gate
// runs BEFORE dispatch, and a release requires positive proof that nothing
// reached the provider.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  LiveBudgetError, assertDispatchWithinGlobalCeiling, ledgerPath,
  reconstructCommittedLiability, recordObservedSpend,
  releaseUndispatchedReservation, withLedgerLock
} = require('./fixtures/evaluation-live-budget-ledger');
const { auditLiveReadiness, assertLiveExecutionPermitted } =
  require('./fixtures/evaluation-live-readiness');
const {
  CONTROLS_ENV, assertOutputCapAgrees, resolveLiveRequestControls,
  resolveProviderSampling, resolveUngovernedOutputCap
} = require('../runtime/live-request-controls');
const {
  TrialLiabilityError, ARM_IDS, assertRetryLiabilityBounded, trialWorstCaseMicroUsd
} = require('./fixtures/evaluation-live-trial-liability');
const { ROLE_ECONOMICS } = require('./fixtures/governed-role-policy-container');
const { buildOpenAiResponsesBody } = require('../runtime/provider-request-body');
const liveManifest = require('../config/structured-allocation-evaluation-live-v1.json');

const CAP = liveManifest.economics.maximumTotalLiveMicroUsd;
const PER_REQUEST = liveManifest.economics.liability.perRequestMicroUsd;
const RUNTIME_REQUESTS_PER_RUN =
  liveManifest.economics.liability.runtimeMaxModelRequestsPerRun;
// The exact bytes of an ungoverned body built with NO live controls. This hash
// is the fixture corpus's compatibility guarantee: if it moves, every completed
// fixture artifact describes a request the code no longer builds.
const HISTORICAL_UNGOVERNED_BODY_SHA256 =
  '559a044d666a2e59410cf434b121443f92150a941bd81dcee57da4796d5eeb88';

let passed = 0;
function ok(condition, message) {
  assert.equal(condition, true, message);
  passed += 1;
  console.log(`  ok ${message}`);
}
function refuses(fn) { try { fn(); return null; } catch (error) { return error; } }
function freshRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'live-budget-')); }

function main() {
  console.log('evaluation live budget');

  // ── 1-3. Reserve, persist, reconstruct ────────────────────────────────
  {
    const root = freshRoot();
    ok(reconstructCommittedLiability(root).committedMicroUsd === 0,
      '2 an empty run has zero committed liability');
    const first = assertDispatchWithinGlobalCeiling({
      runRoot: root, ceilingMicroUsd: CAP, maximumLiabilityMicroUsd: PER_REQUEST,
      trialId: 't1', role: 'structured_planner', ordinal: 1
    });
    ok(first.permitted === true && first.remainingMicroUsd === CAP - PER_REQUEST,
      '1 the first dispatch reserves global liability before it may proceed');
    // DURABLE: reconstruction reads the file, not a variable.
    ok(fs.existsSync(ledgerPath(root)),
      '2 the reservation is written to a durable ledger, not held in memory');
    ok(reconstructCommittedLiability(root).committedMicroUsd === PER_REQUEST,
      '2 restart reconstructs the committed liability from that ledger');
    // 5. A retry is another dispatch and consumes its own authority.
    assertDispatchWithinGlobalCeiling({
      runRoot: root, ceilingMicroUsd: CAP, maximumLiabilityMicroUsd: PER_REQUEST,
      trialId: 't1', role: 'structured_planner', ordinal: 2
    });
    ok(reconstructCommittedLiability(root).committedMicroUsd === PER_REQUEST * 2,
      '5 a product retry consumes additional authority — it is another dispatch');
    fs.rmSync(root, { recursive: true, force: true });
  }

  // ── 4, 6. Release requires POSITIVE proof ─────────────────────────────
  {
    const root = freshRoot();
    const reservation = assertDispatchWithinGlobalCeiling({
      runRoot: root, ceilingMicroUsd: CAP, maximumLiabilityMicroUsd: PER_REQUEST,
      trialId: 't1', role: 'worker', ordinal: 1
    });
    // AMBIGUOUS DELIVERY IS NOT FREE. "We are not sure it arrived" is not
    // evidence that it did not.
    const ambiguous = refuses(() => releaseUndispatchedReservation({
      runRoot: root, reservationId: reservation.reservationId,
      proof: 'ambiguous_delivery'
    }));
    ok(ambiguous instanceof LiveBudgetError &&
       ambiguous.code === 'LIVE_BUDGET_RELEASE_UNPROVEN',
    '4 ambiguous delivery is never released — it stays committed');
    ok(reconstructCommittedLiability(root).committedMicroUsd === PER_REQUEST,
      '4 and the liability remains committed after the refused release');
    // 6. A proven pre-delivery refusal DOES release.
    releaseUndispatchedReservation({
      runRoot: root, reservationId: reservation.reservationId,
      proof: 'pre_delivery_refusal_no_provider_contact'
    });
    ok(reconstructCommittedLiability(root).committedMicroUsd === 0,
      '6 a proven pre-delivery refusal releases its liability');
    const twice = refuses(() => releaseUndispatchedReservation({
      runRoot: root, reservationId: reservation.reservationId,
      proof: 'pre_delivery_refusal_no_provider_contact'
    }));
    ok(twice !== null, 'a reservation cannot be released twice');
    fs.rmSync(root, { recursive: true, force: true });
  }

  // ── 7, 8. The ceiling binds ───────────────────────────────────────────
  {
    const root = freshRoot();
    assertDispatchWithinGlobalCeiling({
      runRoot: root, ceilingMicroUsd: CAP, maximumLiabilityMicroUsd: CAP - 1,
      trialId: 'big', role: 'worker', ordinal: 1
    });
    const exhausted = refuses(() => assertDispatchWithinGlobalCeiling({
      runRoot: root, ceilingMicroUsd: CAP, maximumLiabilityMicroUsd: PER_REQUEST,
      trialId: 'next', role: 'worker', ordinal: 1
    }));
    ok(exhausted instanceof LiveBudgetError &&
       exhausted.code === 'LIVE_BUDGET_EXHAUSTED',
    '7 insufficient remaining authority STOPS before transport');
    ok(exhausted.detail.projected > exhausted.detail.ceilingMicroUsd,
      '8 and the ceiling is never exceeded — the projection is what refuses');
    ok(reconstructCommittedLiability(root).committedMicroUsd === CAP - 1,
      '8 a refused dispatch commits nothing further');
    fs.rmSync(root, { recursive: true, force: true });
  }

  // ── 9. The gate may tighten, never widen ──────────────────────────────
  {
    const root = freshRoot();
    // Global headroom is large, but the request's own bounded liability is what
    // is reserved — headroom never enlarges a trial's authority.
    const reservation = assertDispatchWithinGlobalCeiling({
      runRoot: root, ceilingMicroUsd: CAP, maximumLiabilityMicroUsd: PER_REQUEST,
      trialId: 't', role: 'worker', ordinal: 1
    });
    ok(reservation.committedAfterMicroUsd === PER_REQUEST,
      '9 abundant global headroom does not widen a trial\'s own authority');
    fs.rmSync(root, { recursive: true, force: true });
  }

  // ── 10. Two dispatchers cannot spend the same authority ───────────────
  {
    const root = freshRoot();
    let inner = null;
    withLedgerLock(root, () => {
      // A second dispatcher, while the first holds the ledger.
      inner = refuses(() => assertDispatchWithinGlobalCeiling({
        runRoot: root, ceilingMicroUsd: CAP, maximumLiabilityMicroUsd: PER_REQUEST,
        trialId: 'concurrent', role: 'worker', ordinal: 1
      }));
    });
    ok(inner instanceof LiveBudgetError && inner.code === 'LIVE_BUDGET_LOCKED',
      '10 a concurrent dispatcher cannot read the same remaining authority');
    // And the lock is released afterwards, so the run is not wedged.
    ok(assertDispatchWithinGlobalCeiling({
      runRoot: root, ceilingMicroUsd: CAP, maximumLiabilityMicroUsd: PER_REQUEST,
      trialId: 'after', role: 'worker', ordinal: 1
    }).permitted === true, '10 and the lock is released when the holder finishes');
    fs.rmSync(root, { recursive: true, force: true });
  }

  // Observed spend is recorded beside liability and never relaxes the gate.
  {
    const root = freshRoot();
    assertDispatchWithinGlobalCeiling({
      runRoot: root, ceilingMicroUsd: CAP, maximumLiabilityMicroUsd: PER_REQUEST,
      trialId: 't', role: 'worker', ordinal: 1
    });
    recordObservedSpend({ runRoot: root, trialId: 't', observedMicroUsd: 12 });
    ok(reconstructCommittedLiability(root).committedMicroUsd === PER_REQUEST,
      'observed spend is recorded beside the liability and never relaxes the gate');
    fs.rmSync(root, { recursive: true, force: true });
  }

  // ── Request controls: fixture compatibility and live presence ─────────
  const CONTROLS = JSON.stringify({ temperature: 0, topP: 1, maxOutputTokens: 2048 });
  ok(resolveLiveRequestControls({}) === null,
    'live request controls are absent by default — there is no ambient default');
  ok(resolveProviderSampling({}) === null && resolveUngovernedOutputCap({}) === null,
    'so neither sampling nor an output cap is invented for a non-live caller');

  // HISTORICAL COMPATIBILITY. A fixture body must stay byte-identical, or the
  // completed 200-trial corpus stops being evidence about the same requests.
  const historical = buildOpenAiResponsesBody({
    model: 'gpt-4o-mini-2024-07-18', input: [{ role: 'user', content: 'x' }],
    options: { sampling: resolveProviderSampling({}),
      maxOutputTokens: resolveUngovernedOutputCap({}) }
  });
  ok(Object.keys(historical).sort().join(',') === 'input,model,text',
    'a historical ungoverned body carries no sampling and no output cap');
  ok(crypto.createHash('sha256').update(JSON.stringify(historical)).digest('hex') ===
     HISTORICAL_UNGOVERNED_BODY_SHA256,
  'and its exact bytes are unchanged from the executed fixture corpus');

  const liveControls = resolveLiveRequestControls({ [CONTROLS_ENV]: CONTROLS });
  const liveBody = buildOpenAiResponsesBody({
    model: 'gpt-4o-mini-2024-07-18', input: [{ role: 'user', content: 'x' }],
    options: { sampling: liveControls.sampling,
      maxOutputTokens: liveControls.maxOutputTokens }
  });
  ok(liveBody.temperature === 0 && liveBody.top_p === 1 &&
     liveBody.max_output_tokens === 2048 && liveBody.truncation === 'disabled' &&
     !('seed' in liveBody),
  'a live body adds exactly temperature, top_p and the 2048 output cap, with no seed');

  // THE CAP IS ONE NUMBER. A governed role is priced at its authorized cap, so
  // a live control that disagreed would reserve against a bound the wire does
  // not carry — the exact defect that made the ungoverned liability false.
  ok(assertOutputCapAgrees(2048, { [CONTROLS_ENV]: CONTROLS }) === 2048,
    'an authorized cap that agrees with the live control is permitted');
  const disagreement = refuses(() =>
    assertOutputCapAgrees(4096, { [CONTROLS_ENV]: CONTROLS }));
  ok(disagreement !== null && disagreement.code === 'LIVE_OUTPUT_CAP_DISAGREEMENT',
    'a cap that disagrees with the frozen live control REFUSES');
  ok(assertOutputCapAgrees(4096, {}) === 4096,
    'and outside a live run the authorization stands alone, unchanged');

  for (const bad of ['{}', '{"temperature":0}', '{"topP":1}',
    '{"temperature":0,"topP":1}', '{"temperature":0,"topP":1,"seed":7}', 'nonsense',
    '[0,1]', 'null', '{"temperature":0,"topP":"1","maxOutputTokens":2048}',
    '{"temperature":"0","topP":1,"maxOutputTokens":2048}',
    '{"temperature":0,"topP":null,"maxOutputTokens":2048}',
    '{"temperature":0,"topP":1e999,"maxOutputTokens":2048}',
    '{"temperature":1e999,"topP":1,"maxOutputTokens":2048}',
    '{"temperature":0,"topP":1,"maxOutputTokens":0}',
    '{"temperature":0,"topP":1,"maxOutputTokens":2048.5}']) {
    ok(refuses(() => resolveLiveRequestControls({ [CONTROLS_ENV]: bad })) !== null,
      `an incomplete or malformed control value refuses rather than defaulting (${bad.slice(0, 30)})`);
  }

  // ── The trial worst case ──────────────────────────────────────────────
  //
  // Reserving one request's worth for a whole trial is the defect this closes.
  const derivation = { perRequestMicroUsd: PER_REQUEST,
    runtimeMaxModelRequestsPerRun: RUNTIME_REQUESTS_PER_RUN,
    governedLeafMaximumProviderRequests:
      ROLE_ECONOMICS.structured_leaf_executor.maximumProviderRequests,
    governedPlannerMaximumProviderRequests:
      ROLE_ECONOMICS.structured_planner.maximumProviderRequests,
    autoRetryEnabled: false, maxAttempts: null };
  for (const armId of ARM_IDS) {
    const bound = trialWorstCaseMicroUsd({ armId, ...derivation });
    ok(bound.trialWorstCaseMicroUsd > PER_REQUEST,
      `${armId}: a trial reserves more than a single request's liability`);
    ok(bound.trialWorstCaseMicroUsd ===
       bound.totalProviderAttempts * PER_REQUEST,
    `${armId}: the bound is exactly ${bound.totalProviderAttempts} authorized attempts`);
    ok(bound.plannerRequestMaximum +
       bound.maximumWorkerRuns * bound.workerRequestsPerRun * bound.attemptsPerRun ===
       bound.totalProviderAttempts,
    `${armId}: planner + every worker Run + every attempt are all inside the bound`);
  }
  // A governed trial covers its planner AND all its leaf Runs.
  const structured = trialWorstCaseMicroUsd({ armId: 'B', ...derivation });
  ok(structured.plannerRequestMaximum === 1 && structured.maximumWorkerRuns === 3,
    'a structured trial prices one planning attempt and every leaf Run it can admit');
  ok(structured.totalProviderAttempts >
     trialWorstCaseMicroUsd({ armId: 'A', ...derivation }).totalProviderAttempts,
  'and therefore reserves more than a direct trial');
  // A group arm has more than one Run, which the old per-request bound ignored.
  ok(trialWorstCaseMicroUsd({ armId: 'A2a', ...derivation }).maximumWorkerRuns === 2,
    'a legacy group trial prices one Run per worker agent, not one Run');

  // AN UNPROVEN CEILING IS NEVER PRICED.
  for (const missing of ['runtimeMaxModelRequestsPerRun',
    'governedLeafMaximumProviderRequests', 'governedPlannerMaximumProviderRequests']) {
    const broken = refuses(() =>
      trialWorstCaseMicroUsd({ armId: 'B', ...derivation, [missing]: null }));
    ok(broken instanceof TrialLiabilityError &&
       broken.code === 'TRIAL_LIABILITY_CEILING_UNPROVEN',
    `a trial may not be priced against an unproven ${missing}`);
  }

  // RETRIES ARE INSIDE THE BOUND, never invented headroom.
  ok(assertRetryLiabilityBounded({ armId: 'A', autoRetryEnabled: false }) === 1,
    'auto-retry off means exactly one attempt per Run is priced');
  ok(assertRetryLiabilityBounded({ armId: 'A', autoRetryEnabled: true, maxAttempts: 3 }) === 3,
    'auto-retry on an agent ticket prices every attempt it may make');
  ok(assertRetryLiabilityBounded({ armId: 'B', autoRetryEnabled: true, maxAttempts: 3 }) === 1,
    'a group ticket is refused for auto-retry, so it prices one attempt');
  const unbounded = refuses(() =>
    assertRetryLiabilityBounded({ armId: 'A', autoRetryEnabled: true, maxAttempts: null }));
  ok(unbounded instanceof TrialLiabilityError &&
     unbounded.code === 'TRIAL_LIABILITY_RETRY_UNBOUNDED',
  'an enabled retry with no proven attempt ceiling REFUSES to be priced');

  // THE MANIFEST PRICES WHAT THE WIRE CARRIES.
  ok(liveManifest.maximumOutputTokensPerRequest === liveControls.maxOutputTokens,
    'the manifest output cap and the live wire cap are one number');
  ok(liveManifest.economics.computedWorstCaseMicroUsd <=
     liveManifest.economics.maximumTotalLiveMicroUsd,
  'the recomputed worst case is within the frozen ceiling');
  ok(liveManifest.slots.length === 120 &&
     new Set(liveManifest.slots.map(s => s.cellKey)).size === 40 &&
     liveManifest.repetitions === 3,
  'and the frozen 40 cells x 3 repetitions = 120 slots are unchanged');

  // ── The corrected readiness facts ─────────────────────────────────────
  const audit = auditLiveReadiness();
  const byId = Object.fromEntries(audit.items.map(item => [item.id, item.state]));
  // EVERY ROLE IS ITS OWN FACT. One boolean standing in for three unexercised
  // roles is exactly how the previous verdict claimed more than it proved.
  for (const id of ['liveDispatchPathImplemented',
    'ungovernedWorkerDispatchProved', 'structuredPlannerDispatchProved',
    'governedLeafDispatchProved',
    'liveSamplingUngovernedWorkerProved', 'liveSamplingPlannerProved',
    'liveSamplingGovernedWorkerProved',
    'liveOutputCapUngovernedWorkerProved', 'liveOutputCapPlannerProved',
    'liveOutputCapGovernedWorkerProved',
    'fixtureBodyCompatibilityProved',
    'liveGlobalEconomicGateImplemented', 'liveTrialWorstCaseReservationProved',
    'liveRetryLiabilityBoundProved', 'liveGlobalEconomicGateRecoveryProved',
    'liveGlobalEconomicGateConcurrencyProved',
    'liveDryRunReachedProviderBoundary', 'externalProviderCallsZero']) {
    ok(byId[id] === 'FROZEN', `readiness fact ${id} is proved`);
  }
  ok(audit.unresolved.length === 0 &&
     audit.verdict === 'TRANCHE 6 LIVE-MODEL EVALUATION READY',
  'the corrected readiness verdict is READY');
  ok(assertLiveExecutionPermitted(audit) === true,
    'and live execution would be permitted — READY does not authorize spending');

  console.log(`\nevaluation live budget test passed — ${passed} assertions`);
  console.log('EXTERNAL PROVIDER CALLS: 0');
}

main();
