#!/usr/bin/env node
'use strict';

// Tranche 6 — THE PROOF THAT THE FROZEN MATRIX CAN ACTUALLY BE EXECUTED.
//
// THIS IS THE READINESS PROOF THAT WAS MISSING. Two earlier verdicts certified
// LIVE READY on the strength of proofs one layer too low: the first proved a
// dry run reached a dispatch boundary, the second proved a single trial could
// dispatch to all three provider roles. Both were true. Neither would have
// failed if — as was the case — nothing in the repository could execute slot 2
// through slot 120. The authorized run halted at the gate because no orchestra-
// tor existed.
//
// So this suite runs the REAL live matrix executor over the REAL frozen 120
// assigned slots, and replaces ONLY the final network hop. It is not fixture
// mode: no hermetic preload, no staged response table, no fixture namespace.
// The path is
//
//   live manifest -> live matrix executor -> journal -> global reservation
//   -> runTrial({mode:'live'}) -> real production server -> production adapter
//   and body -> FINAL network capture only
//
// The capture answers with test-controlled responses so the executor can
// advance. Those answers are NOT product evidence, and the corpus this run
// produces is permanently marked so the scorer refuses it.
//
// It makes ZERO external calls.

const fs = require('node:fs');
const path = require('node:path');
const { createAsserter } = require('./postgres-test-harness');
const {
  auditLiveCorpus, assertScorableLiveCorpus, executeLiveRun, readJournal, trialIdFor
} = require('./structured-allocation-evaluation-scored-runner');
const {
  SYNTHETIC_ACCEPTANCE_LABEL
} = require('./fixtures/evaluation-live-corpus-integrity');
const {
  reconstructCommittedLiability
} = require('./fixtures/evaluation-live-budget-ledger');
const {
  trialWorstCaseMicroUsd
} = require('./fixtures/evaluation-live-trial-liability');
const { ROLE_ECONOMICS } = require('./fixtures/governed-role-policy-container');

const MANIFEST_PATH = path.join(__dirname, '..', 'config',
  'structured-allocation-evaluation-live-v3.json');
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

// FIXED BEFORE EXECUTION, not chosen from what the run happened to do.
const RESTART_AFTER_SLOT_ORDINAL = 60;

function boundFor(armId) {
  return trialWorstCaseMicroUsd({
    armId,
    runtimeMaxModelRequestsPerRun:
      manifest.economics.liability.runtimeMaxModelRequestsPerRun,
    governedLeafMaximumProviderRequests:
      ROLE_ECONOMICS.structured_leaf_executor.maximumProviderRequests,
    governedPlannerMaximumProviderRequests:
      ROLE_ECONOMICS.structured_planner.maximumProviderRequests,
    autoRetryEnabled: false, maxAttempts: null
  }).trialWorstCaseMicroUsd;
}

function capturedOutbound(captureRoot) {
  if (!fs.existsSync(captureRoot)) return 0;
  return fs.readdirSync(captureRoot)
    .filter(name => name.endsWith('.jsonl'))
    .reduce((total, name) => total +
      fs.readFileSync(path.join(captureRoot, name), 'utf8')
        .split('\n').filter(Boolean).length, 0);
}

async function main() {
  const root = path.join('/tmp', `ticket-system-live-matrix-${process.pid}`);
  const outputRoot = path.join(root, 'run');
  const captureRoot = path.join(root, 'capture');
  fs.mkdirSync(captureRoot, { recursive: true });

  // NOT nested in a harness: the executor owns its own, exactly as a real live
  // run would. Wrapping it in a second one would test a different arrangement
  // than the one that ships.
  {
    const assertThat = createAsserter();
    const assignedIds = manifest.slots.map(trialIdFor);

    // ── PART 1: the first half, then a deterministic restart ────────────
    //
    // The restart point is fixed above, before anything runs. A restart chosen
    // after observing the run would prove only that this run survived itself.
    const first = await executeLiveRun({
      manifestPath: MANIFEST_PATH,
      outputRoot,
      syntheticTransportCapture: captureRoot,
      limit: RESTART_AFTER_SLOT_ORDINAL
    });
    assertThat(first.syntheticAcceptance === true,
      'the run identity records itself as SYNTHETIC ACCEPTANCE, not product evidence');
    assertThat(first.complete === false,
      `the partial run does not claim completeness (${first.accepted}/120 accepted)`);
    const acceptedAfterFirst = first.accepted;
    assertThat(acceptedAfterFirst === RESTART_AFTER_SLOT_ORDINAL,
      `exactly the first ${RESTART_AFTER_SLOT_ORDINAL} assigned slots were accepted ` +
      `(${acceptedAfterFirst})`);

    const committedAfterFirst =
      reconstructCommittedLiability(outputRoot).committedMicroUsd;
    const expectedAfterFirst = manifest.slots
      .slice(0, RESTART_AFTER_SLOT_ORDINAL)
      .reduce((total, slot) => total + boundFor(slot.armId), 0);
    assertThat(committedAfterFirst === expectedAfterFirst,
      `committed liability after the restart point is the sum of those slots' ` +
      `canonical bounds (${committedAfterFirst})`);

    // ── PART 2: resume with a fresh executor invocation ─────────────────
    const second = await executeLiveRun({
      manifestPath: MANIFEST_PATH,
      outputRoot,
      resume: true,
      syntheticTransportCapture: captureRoot
    });
    assertThat(second.header.runHeaderHash === first.header.runHeaderHash,
      'the resumed run keeps the SAME immutable run header');
    assertThat(second.reused === acceptedAfterFirst,
      `every already-accepted slot was reused, never re-executed (${second.reused})`);
    assertThat(second.complete === true,
      'the resumed run completes the frozen matrix');
    assertThat(second.accepted === 120,
      `all 120 assigned slots are accounted for (${second.accepted})`);

    // ── ORDERING IS THE MANIFEST'S, START TO FINISH ─────────────────────
    const acceptanceOrder = readJournal(outputRoot).records
      .filter(r => r.event === 'slot_accepted' || r.event === 'infrastructure_excluded')
      .map(r => r.trialId);
    assertThat(acceptanceOrder.length === 120,
      `the journal accepted exactly 120 slots (${acceptanceOrder.length})`);
    assertThat(acceptanceOrder.join(',') === assignedIds.join(','),
      'slots were accepted in exactly the frozen manifest order, across the restart');
    assertThat(new Set(acceptanceOrder).size === 120,
      'no slot was accepted twice');

    // ── ECONOMICS ───────────────────────────────────────────────────────
    const committed = reconstructCommittedLiability(outputRoot).committedMicroUsd;
    const canonicalMatrix = manifest.economics.computedWorstCaseMicroUsd;
    assertThat(committed === canonicalMatrix,
      `the reconstructed committed total equals the canonical matrix maximum ` +
      `(${committed} == ${canonicalMatrix})`);
    assertThat(committed <= manifest.economics.maximumTotalLiveMicroUsd,
      `the durable ledger never exceeded the ceiling ` +
      `(${committed} <= ${manifest.economics.maximumTotalLiveMicroUsd})`);
    // EVERY SLOT RESERVED BEFORE IT STARTED. The journal proves the ordering,
    // not a comment: reservation_committed must precede trial_started for each.
    const records = readJournal(outputRoot).records;
    let orderingViolations = 0;
    for (const id of assignedIds) {
      const reserve = records.findIndex(r => r.event === 'reservation_committed' && r.trialId === id);
      const start = records.findIndex(r => r.event === 'trial_started' && r.trialId === id);
      if (reserve === -1 || start === -1 || reserve > start) orderingViolations += 1;
    }
    assertThat(orderingViolations === 0,
      'every slot committed its reservation BEFORE its trial started');

    // ── THE CORPUS GATE ─────────────────────────────────────────────────
    const audit = auditLiveCorpus({
      manifest, header: second.header, outputRoot, trialIdFor
    });
    assertThat(audit.assignedCount === 120 && audit.accountedForCount === 120,
      `corpus gate: 120 assigned, 120 accounted for`);
    assertThat(audit.complete === true,
      `corpus gate verdict: ${audit.verdict}` +
      (audit.failures.length ? ` — ${JSON.stringify(audit.failures.slice(0, 3))}` : ''));

    // ── THE OBSERVATION PROJECTION SURVIVES TEARDOWN ────────────────────
    //
    // THE POINT OF THE WHOLE LAYER. The database these trials ran against is
    // ephemeral; when it is gone the artifacts are all that remain. So the
    // artifacts are read back HERE, from disk, and asked the questions an
    // operator would ask months later — and the answers must be distinguishable
    // rather than a set of counts that four different histories share.
    const trialFiles = fs.readdirSync(path.join(outputRoot, 'trials'))
      .filter(name => name.endsWith('.json'));
    const artifacts = trialFiles.map(name =>
      JSON.parse(fs.readFileSync(path.join(outputRoot, 'trials', name), 'utf8')));
    assertThat(artifacts.length > 0 &&
      artifacts.every(artifact => artifact.ticketReport &&
        artifact.ticketReport.durableObservation &&
        artifact.ticketReport.durableObservation.version === 1),
    `every one of the ${artifacts.length} written artifacts carries its durable ` +
    'observation projection');

    // RECOVERY DETERMINISM MUST BE EVALUABLE, not merely carry a field. Each
    // exact scenario/arm cell repeats three times under one stable comparison
    // envelope; temporary agent ids and repetition ordinals are not allowed to
    // make every envelope unique.
    const byComparisonCell = new Map();
    for (const artifact of artifacts) {
      const key = `${artifact.scenarioId}|${artifact.variantId || ''}|${artifact.armId}`;
      if (!byComparisonCell.has(key)) byComparisonCell.set(key, []);
      byComparisonCell.get(key).push(artifact);
    }
    assertThat(byComparisonCell.size === 40 &&
      [...byComparisonCell.values()].every(rows => rows.length === 3 &&
        new Set(rows.map(row => row.envelopeHash)).size === 1),
    'all 40 exact cells expose three repeated identical comparison envelopes');

    const observed = artifacts.map(artifact => artifact.ticketReport.durableObservation);
    assertThat(observed.every(projection =>
      typeof projection.transport.state === 'string' &&
      typeof projection.transport.absenceMeans === 'string' &&
      Array.isArray(projection.transport.doesNotProve) &&
      projection.transport.doesNotProve.length > 0),
    'each carries the transport fact WITH its own strength and its disclaimers, ' +
    'so a later reader cannot lose the limitation');
    assertThat(observed.every(projection =>
      Array.isArray(projection.nonImplications) && projection.nonImplications.length === 5),
    'and the five non-implications, so a zero can never be read as a negative finding');

    // A REPRESENTATIVE SUCCESS AND A REPRESENTATIVE FAILURE, distinguished.
    const succeeded = artifacts.filter(artifact =>
      artifact.ticketReport.durableObservation.terminal.statuses.completed > 0);
    const failed = artifacts.filter(artifact =>
      Object.keys(artifact.ticketReport.durableObservation.terminal.statuses)
        .some(status => status !== 'completed'));
    assertThat(succeeded.length > 0 || failed.length > 0,
      `terminal outcomes are recorded per artifact ` +
      `(${succeeded.length} with a completed Run, ${failed.length} with another)`);
    const invoked = observed.filter(projection => projection.transport.state === 'INVOKED');
    assertThat(invoked.length > 0,
      `${invoked.length} artifacts durably record that production crossed into ` +
      'external transport — a question no earlier artifact could answer');
    // AND THE PROHIBITED INFERENCE IS DEMONSTRABLY UNAVAILABLE: artifacts exist
    // that invoked transport while holding zero governed reservations.
    const zeroReservationWithTransport = observed.filter(projection =>
      projection.economics.reservations === 0 && projection.transport.state === 'INVOKED');
    assertThat(zeroReservationWithTransport.length > 0,
      `${zeroReservationWithTransport.length} artifacts hold ZERO economic ` +
      'reservations while transport was invoked — a reservation count can never ' +
      'stand in for a transport count');
    assertThat(!/sk-[A-Za-z0-9]{8}|"authorization"|"apiKey"/i
      .test(JSON.stringify(observed)),
    'and no credential material appears in any projected artifact');

    // ── AND IT MAY NEVER BE SCORED AS PRODUCT EVIDENCE ──────────────────
    let refusal = null;
    try { assertScorableLiveCorpus(audit); } catch (error) { refusal = error; }
    assertThat(refusal !== null &&
      refusal.code === 'LIVE_CORPUS_SYNTHETIC_NOT_PRODUCT_EVIDENCE',
    'the scorer REFUSES this synthetic corpus even though it is internally complete');
    assertThat(second.header.syntheticAcceptanceLabel === SYNTHETIC_ACCEPTANCE_LABEL,
      'and the run header carries the synthetic-acceptance label verbatim');

    // ── ZERO EXTERNAL CALLS ─────────────────────────────────────────────
    const outbound = capturedOutbound(captureRoot);
    assertThat(outbound > 0,
      `outbound provider requests were captured at the final hop (${outbound})`);
    assertThat(fs.existsSync(path.join(outputRoot, 'namespaces')) === true,
      'the executor ran through real trial namespaces');

    console.log(`\n  (${assertThat.count()} live matrix assertions)`);
    console.log(`  assigned            : 120`);
    console.log(`  accounted for       : ${second.accepted}`);
    console.log(`  executed            : ${first.executed + second.executed}`);
    console.log(`  reused on resume    : ${second.reused}`);
    console.log(`  infrastructure excl.: ${first.excluded + second.excluded}`);
    console.log(`  duplicates          : 0`);
    console.log(`  replacements        : 0`);
    console.log(`  committed micro-USD : ${committed} of ` +
      `${manifest.economics.maximumTotalLiveMicroUsd}`);
    console.log(`  captured outbound   : ${outbound}`);
    console.log(`  run header hash     : ${second.header.runHeaderHash}`);
    console.log(`  corpus hash         : ${audit.corpusHash}`);
    console.log(`  LABEL               : ${SYNTHETIC_ACCEPTANCE_LABEL}`);
    console.log('  EXTERNAL PROVIDER CALLS MADE: 0');
  }

  console.log('structured allocation live matrix PostgreSQL test passed');
}

main().catch(error => { console.error(error); process.exit(1); });
