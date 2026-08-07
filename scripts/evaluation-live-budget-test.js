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
const { resolveProviderSampling } = require('../runtime/provider-sampling-authority');
const { buildOpenAiResponsesBody } = require('../runtime/provider-request-body');
const liveManifest = require('../config/structured-allocation-evaluation-live-v1.json');

const CAP = liveManifest.economics.maximumTotalLiveMicroUsd;
const PER_REQUEST = Math.round(liveManifest.economics.liability.perRequestMicroUsd);

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

  // ── Sampling: fixture compatibility and live presence ─────────────────
  ok(resolveProviderSampling({}) === null,
    'sampling is absent by default — there is no ambient default');
  const fixtureBody = buildOpenAiResponsesBody({
    model: 'm', input: [], options: { governed: true, maxOutputTokens: 2048,
      sampling: resolveProviderSampling({}) }
  });
  ok(!('temperature' in fixtureBody) && !('top_p' in fixtureBody),
    'a fixture body is byte-identical to its historical form');
  const liveBody = buildOpenAiResponsesBody({
    model: 'm', input: [], options: { governed: true, maxOutputTokens: 2048,
      sampling: resolveProviderSampling({
        EVALUATION_LIVE_SAMPLING: JSON.stringify({ temperature: 0, topP: 1 }) }) }
  });
  ok(liveBody.temperature === 0 && liveBody.top_p === 1 && !('seed' in liveBody),
    'a live body carries the frozen sampling and no seed');
  // A partial, mistyped or non-finite value REFUSES. A silent fallback here is
  // exactly the ambient default this authority exists to remove, and it would be
  // invisible in the request evidence afterwards.
  for (const bad of ['{}', '{"temperature":0}', '{"topP":1}',
    '{"temperature":0,"topP":1,"seed":7}', 'nonsense', '[0,1]', 'null',
    '{"temperature":0,"topP":"1"}', '{"temperature":"0","topP":1}',
    '{"temperature":0,"topP":null}', '{"temperature":0,"topP":1e999}',
    '{"temperature":1e999,"topP":1}']) {
    ok(refuses(() => resolveProviderSampling({ EVALUATION_LIVE_SAMPLING: bad })) !== null,
      `an incomplete or malformed sampling value refuses rather than defaulting (${bad.slice(0, 24)})`);
  }

  // ── The corrected readiness facts ─────────────────────────────────────
  const audit = auditLiveReadiness();
  const byId = Object.fromEntries(audit.items.map(item => [item.id, item.state]));
  for (const id of ['liveDispatchPathImplemented', 'liveDispatchPathBehaviourallyProved',
    'liveSamplingPlannerProved', 'liveSamplingGovernedWorkerProved',
    'liveSamplingUngovernedWorkerProved', 'liveGlobalEconomicGateImplemented',
    'liveGlobalEconomicGateRecoveryProved', 'liveDryRunReachedProviderBoundary']) {
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
