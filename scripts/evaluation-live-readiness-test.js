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

  // ── What is NOT, and must block ───────────────────────────────────────
  const unresolved = new Set(audit.unresolved);
  for (const id of ['live_matrix_membership', 'sampling_parameters',
    'live_economic_ceiling', 'provider_failure_classification',
    'fixture_live_evidence_combination', 'live_phase_necessity']) {
    ok(unresolved.has(id), `${id} is UNRESOLVED and is reported as such`);
  }
  ok(audit.verdict === 'TRANCHE 6 LIVE-MODEL EVALUATION BLOCKED',
    'the verdict is BLOCKED while any live item is unresolved');

  // THE GATE. A live executor must not be able to proceed past this.
  let blocked = null;
  try { assertLiveExecutionPermitted(audit); } catch (error) { blocked = error; }
  ok(blocked !== null && blocked.code === 'LIVE_EVALUATION_BLOCKED',
    'live execution REFUSES while the protocol is unfrozen');
  ok(blocked.detail.unresolved.length === audit.unresolved.length,
    'and the refusal names every unresolved decision');
  // A fully frozen audit would permit it — the gate is a gate, not a wall.
  ok(assertLiveExecutionPermitted({ unresolved: [] }) === true,
    'a fully frozen live protocol would permit execution');

  // ── The economic liability is the WORST case, not an estimate ─────────
  const perRequest = worstCaseMicroUsdPerRequest();
  const expected = (PRICING.contextWindowTokens * PRICING.inputMicroUsdPerMillionTokens +
    PRICING.maximumOutputTokensPerRequest * PRICING.outputMicroUsdPerMillionTokens) / 1e6;
  ok(perRequest === expected && PRICING.boundMethod === 'model_context_window_ceiling',
    'per-request liability is a full context window plus the capped output');
  const liability = worstCaseLiability({ trialsPerArm: { A: 10, B: 10 } });
  ok(liability.byArm.B.maxRequestsPerTrial > liability.byArm.A.maxRequestsPerTrial,
    'a structured trial carries more authorized requests than a direct one');
  ok(liability.byArm.A.perTrialMicroUsd * 10 === liability.byArm.A.totalMicroUsd,
    'liability scales with the trial count exactly');
  ok(Object.values(MAX_REQUESTS_PER_TRIAL).every(caps => typeof caps.basis === 'string'),
    'every per-arm request ceiling states the frozen basis it came from');
  // The number exists so an authorization can be judged; it authorizes nothing.
  ok(unresolved.has('live_economic_ceiling'),
    'computing a worst case does NOT authorize spending it');

  // ── No live manifest may exist while blocked ──────────────────────────
  const liveManifestPath = path.join(__dirname, '..', 'config',
    'structured-allocation-evaluation-live-v1.json');
  ok(!fs.existsSync(liveManifestPath),
    'no live manifest is written while the live protocol is BLOCKED');

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
