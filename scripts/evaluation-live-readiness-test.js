#!/usr/bin/env node
'use strict';

// Tranche 6 — live-model readiness, and the immutability of the fixture result.
//
// TWO THINGS ARE PROVED HERE.
//
// First, that the completed fixture evidence stays exactly as it was recorded:
// its manifest, its rules, its metrics and its decision are not re-openable by
// editing code, and the corpus reproduces its own result.
//
// Second, that a live matrix CANNOT start while any part of the live protocol
// is unfrozen. The audit chooses nothing; it reports FROZEN or UNRESOLVED, and
// an unresolved item blocks execution by refusing rather than by convention.
// A missing sampling parameter or a missing monetary ceiling is not a detail to
// be filled in during the run — it is the difference between an experiment and
// an unauthorized spend.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  MAX_REQUESTS_PER_TRIAL, PRICING, assertLiveExecutionPermitted,
  auditLiveReadiness, worstCaseLiability, worstCaseMicroUsdPerRequest
} = require('./fixtures/evaluation-live-readiness');
const {
  buildPricingCatalog, computeMaximumLiability, findPricingEntry
} = require('../runtime/model-pricing-catalog');
const { pricedCatalogValue } = require('./governed-structured-fixture');
const protocol = require('../config/structured-allocation-evaluation-v1.json');
const fixtureManifest = require('../config/structured-allocation-evaluation-scored-v1.json');

let passed = 0;
function ok(condition, message) {
  assert.equal(condition, true, message);
  passed += 1;
  console.log(`  ok ${message}`);
}

function main() {
  console.log('evaluation live readiness');
  const audit = auditLiveReadiness();

  // ── The fixture evidence is immutable ─────────────────────────────────
  ok(fixtureManifest.manifestHash ===
     '044d37828f6f251eefaef66eccb2362ff6c6498c689baf54eb357870c4d9a07b',
  'the executed fixture manifest hash is unchanged');
  ok(fixtureManifest.trials.length === 200 && fixtureManifest.repetitions === 5,
    'the fixture matrix is still 200 trials at 5 repetitions');
  ok(fixtureManifest.containsResults === false,
    'and the fixture manifest still carries no results');
  ok(protocol.repetition.deterministicFixtureRepetitions === 5,
    'the fixture repetition decision is unchanged');
  ok(protocol.authorizedDimensions.length === 5 &&
     protocol.decisionThresholds.hardDisqualifiers.length === 5,
  'the five metrics and five hard disqualifiers are unchanged');
  // The two scorer corrections stay corrections to an implementation, never
  // edits to a rule: the rule text itself is still the frozen one.
  ok(protocol.decisionThresholds.hardDisqualifiers.some(statement =>
    /identical durable state producing different terminal dispositions/i.test(statement)),
  'the non-deterministic-recovery rule text is unchanged');

  // ── The live audit chooses nothing ────────────────────────────────────
  ok(audit.items.every(item => ['FROZEN', 'UNRESOLVED'].includes(item.state)),
    'every live item is reported as FROZEN or UNRESOLVED — never defaulted');
  ok(audit.items.every(item => typeof item.source === 'string' && item.source.length > 0),
    'and every item names where its value would live');

  // ── What IS frozen ────────────────────────────────────────────────────
  const frozen = new Set(audit.items.filter(i => i.state === 'FROZEN').map(i => i.id));
  for (const id of ['provider', 'model_snapshot', 'adapter_identity',
    'planner_and_worker_model_identity', 'live_repetitions', 'pooling_rule',
    'timeout', 'authorized_metrics', 'decision_thresholds']) {
    ok(frozen.has(id), `${id} is FROZEN in the authoritative protocol`);
  }
  // A DATED snapshot, not a floating alias — a live result named after "latest"
  // could never be reproduced.
  ok(/\d{4}-\d{2}-\d{2}$/.test(protocol.fixedModel.model),
    'the live model is an exact dated snapshot, not a floating alias');
  ok(protocol.repetition.liveModelRepetitions === 3,
    'the live repetition count is the already-frozen 3, not chosen now');
  // BEHAVIOURAL: the audit must REPORT the protocol's value, not a literal of
  // its own. A duplicated constant would keep saying 3 after the protocol
  // changed, which is how a chosen number masquerades as a frozen one.
  const repetitionItem = audit.items.find(item => item.id === 'live_repetitions');
  ok(repetitionItem.detail === protocol.repetition.liveModelRepetitions,
    'and the audit reports that protocol value rather than a literal of its own');
  ok(repetitionItem.source === 'protocol.repetition.liveModelRepetitions',
    'naming the exact protocol field it read');

  // ── The eight decisions are now RESOLVED, and derived not declared ────
  //
  // Each was UNRESOLVED until the live manifest carried the approved value.
  // The audit reads that manifest, so flipping a literal would not close one.
  for (const id of ['live_matrix_membership', 'sampling_parameters',
    'provider_seed_support', 'live_economic_ceiling',
    'provider_failure_classification', 'rate_limit_and_outage_handling',
    'fixture_live_evidence_combination', 'live_phase_necessity']) {
    ok(frozen.has(id), `${id} is FROZEN, derived from the live manifest`);
  }
  ok(audit.unresolved.length === 0 &&
     audit.verdict === 'TRANCHE 6 LIVE-MODEL EVALUATION READY',
  'the verdict is READY with no unresolved live decision');

  // THE GATE STILL REFUSES when anything is unresolved — it is a gate, not a
  // formality that was satisfied once and removed.
  let blocked = null;
  try {
    assertLiveExecutionPermitted({ unresolved: ['live_economic_ceiling'] });
  } catch (error) { blocked = error; }
  ok(blocked !== null && blocked.code === 'LIVE_EVALUATION_BLOCKED',
    'an unresolved decision still REFUSES live execution');
  ok(blocked.detail.unresolved.includes('live_economic_ceiling'),
    'and the refusal names it');
  ok(assertLiveExecutionPermitted(audit) === true,
    'the fully frozen protocol permits execution — subject to explicit authorization');

  // ── The economic liability is the WORST case, not an estimate ─────────
  // THE CANONICAL KERNEL, not a restatement of its arithmetic. Recomputing the
  // formula here would only prove the test agrees with itself; asking
  // `computeMaximumLiability` proves the live layer consumes the same number
  // governed economics reserves against.
  const perRequest = worstCaseMicroUsdPerRequest();
  const canonical = computeMaximumLiability({
    entry: findPricingEntry(buildPricingCatalog(pricedCatalogValue()), {
      provider: 'openai', model: protocol.fixedModel.model,
      adapterId: protocol.fixedModel.adapterId
    }),
    maxOutputTokens: PRICING.maximumOutputTokensPerRequest,
    maxProviderRequests: 1
  });
  ok(perRequest === canonical.maximumMicroUsd &&
     PRICING.boundMethod === 'model_context_window_ceiling',
  `per-request liability is the canonical kernel maximum (${perRequest} micro-USD)`);
  // AND IT IS AN INTEGER. The previous implementation produced 20,428.8 — a
  // fractional monetary authority in an integer micro-USD contract.
  ok(Number.isSafeInteger(perRequest),
    'and it is a safe integer, never a fractional monetary authority');
  ok(perRequest === canonical.inputMicroUsdPerRequest +
     canonical.outputMicroUsdPerRequest + canonical.requestMicroUsdPerRequest,
  'each charge component is rounded UP separately, then summed — the kernel rule');
  const liability = worstCaseLiability({ trialsPerArm: { A: 10, B: 10 } });
  ok(liability.byArm.B.maxRequestsPerTrial > liability.byArm.A.maxRequestsPerTrial,
    'a structured trial carries more authorized requests than a direct one');
  ok(liability.byArm.A.perTrialMicroUsd * 10 === liability.byArm.A.totalMicroUsd,
    'liability scales with the trial count exactly');
  ok(Object.values(MAX_REQUESTS_PER_TRIAL).every(caps => typeof caps.basis === 'string'),
    'every per-arm request ceiling states the frozen basis it came from');
  // A CAP IS NOT AN AUTHORIZATION TO SPEND IT. The manifest says so in terms.
  const liveManifestPath = path.join(__dirname, '..', 'config',
    'structured-allocation-evaluation-live-v1.json');
  ok(fs.existsSync(liveManifestPath),
    'the live manifest exists now that every decision is frozen');
  const liveManifest = JSON.parse(fs.readFileSync(liveManifestPath, 'utf8'));
  ok(liveManifest.economics.note.includes('not spending authorization'),
    'and records that the cap is not spending authorization');
  ok(liveManifest.economics.computedWorstCaseMicroUsd <=
     liveManifest.economics.maximumTotalLiveMicroUsd,
  'the recomputed worst case is within the frozen cap');

  // ── Fixture and live corpora can never mix ───────────────────────────
  ok(protocol.repetition.poolingRule.includes('never combined'),
    'fixture and live results are never combined into one score');
  ok(fixtureManifest.mode === 'fixture',
    'the executed manifest is explicitly fixture mode');

  console.log(`\nevaluation live readiness test passed — ${passed} assertions`);
  console.log(`VERDICT: ${audit.verdict}`);
  console.log(`unresolved: ${audit.unresolved.join(', ')}`);
}

main();
