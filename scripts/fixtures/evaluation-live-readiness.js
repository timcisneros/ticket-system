'use strict';

// Tranche 6 — the LIVE-MODEL readiness audit.
//
// WHAT THIS IS FOR. A live matrix spends real money against a real provider and
// produces evidence that cannot be re-derived from the repository. Every value
// that shapes it must therefore be frozen BEFORE the first call — and a value
// that is merely absent must be reported as absent, never chosen here to let
// execution proceed.
//
// So this module reads the authoritative protocol and answers, per item,
// FROZEN or UNRESOLVED. It chooses nothing. It computes one thing — the
// worst-case monetary liability implied by the already-frozen pricing and
// ceiling contracts — because a reader cannot judge whether an economic
// authorization is adequate without knowing what it would authorize.
//
// While any item is UNRESOLVED the verdict is BLOCKED, and the live executor
// has no manifest to run.

const protocol = require('../../config/structured-allocation-evaluation-v1.json');

const LIVE_READINESS_VERSION = 1;

// The exact worst case the frozen contracts imply, not an estimate.
//
// `model_context_window_ceiling` is the frozen bound method: a request may cost
// at most a full context window of input plus the capped output. That is the
// number an economic authorization has to cover, and it is deliberately the
// pessimistic one — an authorization sized to a nominal estimate is not an
// authorization at all.
const PRICING = Object.freeze({
  inputMicroUsdPerMillionTokens: 150_000,
  outputMicroUsdPerMillionTokens: 600_000,
  contextWindowTokens: 128_000,
  maximumOutputTokensPerRequest: 2_048,
  boundMethod: 'model_context_window_ceiling'
});

// Maximum provider requests per trial, by arm, from the frozen role economics.
// The ungoverned arms carry no governed ceiling, so the worker cap is used as
// the closest frozen bound and is labelled as such.
const MAX_REQUESTS_PER_TRIAL = Object.freeze({
  A: { planner: 0, worker: 3, basis: 'worker economic ceiling (no governed planner on this path)' },
  A2a: { planner: 0, worker: 3, basis: 'worker economic ceiling (no governed planner on this path)' },
  A2b: { planner: 0, worker: 3, basis: 'worker economic ceiling (no governed planner on this path)' },
  B: { planner: 1, worker: 9, basis: 'planner ceiling 1 + 3 leaf Runs x worker ceiling 3' },
  C: { planner: 1, worker: 9, basis: 'planner ceiling 1 + 3 leaf Runs x worker ceiling 3' }
});

// THE KERNEL OWNS THIS NUMBER. This used to be a second pricing implementation:
// a single floating division of the summed product, with no rounding, which
// produced a fractional monetary authority (20,428.8) in a contract whose
// first rule is integer micro-USD rounded up. It now asks the same
// `computeMaximumLiability` that governed economics trusts.
const { canonicalPerRequestMicroUsd } =
  require('./evaluation-live-canonical-price');

function worstCaseMicroUsdPerRequest() {
  return canonicalPerRequestMicroUsd({ role: 'structured_leaf_executor' })
    .perRequestMicroUsd;
}

function worstCaseLiability({ trialsPerArm }) {
  const perRequest = worstCaseMicroUsdPerRequest();
  const byArm = {};
  let totalMicroUsd = 0;
  for (const [armId, trials] of Object.entries(trialsPerArm)) {
    const caps = MAX_REQUESTS_PER_TRIAL[armId];
    if (!caps) continue;
    const requests = caps.planner + caps.worker;
    const perTrial = requests * perRequest;
    byArm[armId] = {
      trials,
      maxRequestsPerTrial: requests,
      basis: caps.basis,
      perTrialMicroUsd: perTrial,
      totalMicroUsd: perTrial * trials
    };
    totalMicroUsd += perTrial * trials;
  }
  return Object.freeze({
    boundMethod: PRICING.boundMethod,
    perRequestMicroUsd: perRequest,
    byArm: Object.freeze(byArm),
    totalMicroUsd,
    // Informational only. Every authority here is integer micro-USD.
    totalUsdInformational: totalMicroUsd / 1e6,
    note: 'worst case under the frozen bound method, not a nominal estimate'
  });
}

// ── The audit ───────────────────────────────────────────────────────────────
//
// Each item names WHERE its value would live. An item is FROZEN only when the
// authoritative source actually carries it — never because a sensible default
// exists.
// `liveManifest` is injectable so the audit's dependence on it can be proved:
// with no manifest every derived decision must fall back to UNRESOLVED, which
// is the state the repository was in before the decisions were approved.
// `sources` exists so the NEGATIVE case is provable. An audit that can only be
// observed saying FROZEN is not a gate — it has to be shown going UNRESOLVED
// when the evidence it names is absent, which is what these overrides allow a
// test to do without editing the repository.
function auditLiveReadiness({ liveManifest, sources = {} } = {}) {
  const items = [];
  const record = (id, state, detail, source) =>
    items.push({ id, state, detail, source });

  const fixed = protocol.fixedModel || {};
  const datedSnapshot = typeof fixed.model === 'string' &&
    /\d{4}-\d{2}-\d{2}$/.test(fixed.model);

  record('provider', fixed.provider ? 'FROZEN' : 'UNRESOLVED',
    fixed.provider || null, 'protocol.fixedModel.provider');
  record('model_snapshot', datedSnapshot ? 'FROZEN' : 'UNRESOLVED',
    fixed.model || null, 'protocol.fixedModel.model');
  record('adapter_identity', fixed.adapterId ? 'FROZEN' : 'UNRESOLVED',
    fixed.adapterId || null, 'protocol.fixedModel.adapterId');
  // The protocol states one identity for planner and every worker, which is
  // what stops planner quality varying between arms.
  record('planner_and_worker_model_identity',
    fixed.note && /planner agent and every worker agent/i.test(fixed.note)
      ? 'FROZEN' : 'UNRESOLVED',
    fixed.note || null, 'protocol.fixedModel.note');
  record('pricing_snapshot', 'FROZEN',
    'runtime/model-pricing-catalog with the frozen catalog used by the cost method',
    'protocol.costMethod.normalized');
  record('context_and_output_ceilings', 'FROZEN',
    `context ${PRICING.contextWindowTokens}, output cap ${PRICING.maximumOutputTokensPerRequest}`,
    'provider-adapter-capability + role economic policy');

  record('live_repetitions',
    Number.isSafeInteger(protocol.repetition.liveModelRepetitions) &&
    protocol.repetition.liveModelRepetitions > 0 ? 'FROZEN' : 'UNRESOLVED',
    protocol.repetition.liveModelRepetitions, 'protocol.repetition.liveModelRepetitions');
  record('pooling_rule', protocol.repetition.poolingRule ? 'FROZEN' : 'UNRESOLVED',
    protocol.repetition.poolingRule, 'protocol.repetition.poolingRule');
  record('arm_ordering_strategy', protocol.ordering && protocol.ordering.strategy
    ? 'FROZEN' : 'UNRESOLVED',
  protocol.ordering && protocol.ordering.strategy, 'protocol.ordering.strategy');
  record('timeout', protocol.failureHandling.timeoutMs ? 'FROZEN' : 'UNRESOLVED',
    protocol.failureHandling.timeoutMs, 'protocol.failureHandling.timeoutMs');
  record('product_failure_retention',
    protocol.failureHandling.productFailureRule ? 'FROZEN' : 'UNRESOLVED',
    protocol.failureHandling.productFailureRule, 'protocol.failureHandling');
  record('result_freezing', protocol.failureHandling.resultFreezing ? 'FROZEN' : 'UNRESOLVED',
    protocol.failureHandling.resultFreezing, 'protocol.failureHandling.resultFreezing');
  record('authorized_metrics', protocol.authorizedDimensions.length === 5
    ? 'FROZEN' : 'UNRESOLVED',
  protocol.authorizedDimensions, 'protocol.authorizedDimensions');
  record('decision_thresholds', protocol.decisionThresholds ? 'FROZEN' : 'UNRESOLVED',
    'retain/revise/stop and 5 hard disqualifiers', 'protocol.decisionThresholds');

  // ── The eight approved decisions, DERIVED from the live manifest ──────
  //
  // Not a literal flipped from UNRESOLVED to FROZEN: each reads the frozen live
  // manifest and is CLOSED only when the manifest actually carries the approved
  // value. A missing manifest leaves every one of them unresolved, which is the
  // state the repository was in before the decisions were approved.
  let live = liveManifest === undefined ? null : liveManifest;
  if (liveManifest === undefined) {
    try {
      // eslint-disable-next-line global-require
      live = require('../../config/structured-allocation-evaluation-live-v1.json');
    } catch (_) { live = null; }
  }

  const derived = (id, condition, detail, source) =>
    record(id, live && condition ? 'FROZEN' : 'UNRESOLVED', detail, source);

  derived('live_matrix_membership',
    live && live.uniqueCellCount === 40 && live.totalAssignedTrials === 120 &&
      live.cells.every(cell => Array.isArray(cell.sourceFixtureSlots) &&
        cell.sourceFixtureSlots.length > 0),
    live && `${live.uniqueCellCount} cells x ${live.repetitions} repetitions = ` +
      `${live.totalAssignedTrials} slots, each derived from frozen fixture slots`,
    'live manifest cells[].sourceFixtureSlots');

  derived('sampling_parameters',
    live && live.sampling && live.sampling.temperature === 0 && live.sampling.topP === 1 &&
      live.sampling.appliesTo.length >= 2,
    live && `temperature ${live.sampling.temperature}, top_p ${live.sampling.topP} ` +
      'for every role',
    'live manifest sampling');

  derived('provider_seed_support',
    live && live.providerSeedSupport === false && live.providerSeed === null &&
      typeof live.stochasticityDeclaration === 'string',
    live && 'no provider seed; residual stochasticity declared as an experimental variable',
    'live manifest providerSeedSupport');

  derived('live_economic_ceiling',
    live && live.economics &&
      live.economics.maximumTotalLiveMicroUsd === 20_000_000 &&
      live.economics.computedWorstCaseMicroUsd <= live.economics.maximumTotalLiveMicroUsd,
    live && `cap ${live.economics.maximumTotalLiveMicroUsd} micro-USD, worst case ` +
      `${live.economics.computedWorstCaseMicroUsd}, headroom ${live.economics.headroomMicroUsd}`,
    'live manifest economics');

  derived('provider_failure_classification',
    (() => {
      try {
        // eslint-disable-next-line global-require
        const { classifyLiveFailure } = require('./evaluation-live-failure-classifier');
        return classifyLiveFailure({ httpStatus: 429, modelResultObserved: false })
            .classification === 'infrastructure_exclusion' &&
          classifyLiveFailure({ requestDelivered: null, modelResultObserved: false })
            .classification === 'product_data' &&
          classifyLiveFailure({ httpStatus: 401 }).classification === 'run_fatal_configuration';
      } catch (_) { return false; }
    })(),
    'three classes, proved by the frozen classifier contract',
    'evaluation-live-failure-classifier');

  derived('rate_limit_and_outage_handling',
    live && live.resultFreezing && live.productFailureRule,
    live && 'excluded slots keep their assignment; resume preserves manifest, ' +
      'slot order, arm, repetition and stochastic contract',
    'live manifest resultFreezing / productFailureRule');

  derived('fixture_live_evidence_combination',
    (() => {
      try {
        // eslint-disable-next-line global-require
        const { combineEvidence } = require('./evaluation-evidence-combination');
        return combineEvidence({
          fixture: { hardDisqualifierTriggered: true, ordinaryDecision: 'STOP' },
          live: { ordinaryDecision: 'RETAIN', corpusComplete: true }
        }).finalProductDecision === 'STOP' &&
          combineEvidence({
            fixture: { hardDisqualifierTriggered: false, ordinaryDecision: 'STOP' },
            live: { ordinaryDecision: 'RETAIN', corpusComplete: true }
          }).finalProductDecision === 'RETAIN';
      } catch (_) { return false; }
    })(),
    'fixture disqualifier vetoes; fixture ordinary STOP reverses only through ' +
    'the frozen live RETAIN rule; denominators are never pooled',
    'evaluation-evidence-combination');

  derived('live_phase_necessity',
    live && live.livePhaseMandatory === true,
    live && 'live evaluation is MANDATORY before the final product decision',
    'live manifest livePhaseMandatory');

  // ── THE FACTS THE PREVIOUS READY VERDICT LACKED ───────────────────────
  //
  // That verdict verified the manifest, the contracts, the cap and a dry run
  // that "stopped before dispatch" — while NO dispatch path existed beyond that
  // stop and the frozen sampling reached no request. Documentation and config
  // could satisfy every item it checked. These eight cannot be satisfied that
  // way: each reads the implementation.
  const runnerSource = sources.runnerSource !== undefined ? sources.runnerSource : (() => {
    try {
      return require('node:fs').readFileSync(
        require('node:path').join(__dirname, '..',
          'structured-allocation-evaluation-runner.js'), 'utf8');
    } catch (_) { return ''; }
  })();
  const bodySource = sources.bodySource !== undefined ? sources.bodySource : (() => {
    try {
      return require('node:fs').readFileSync(
        require('node:path').join(__dirname, '..', '..', 'runtime',
          'provider-request-body.js'), 'utf8');
    } catch (_) { return ''; }
  })();
  const serverSource = sources.serverSource !== undefined ? sources.serverSource : (() => {
    try {
      return require('node:fs').readFileSync(
        require('node:path').join(__dirname, '..', '..', 'server.js'), 'utf8');
    } catch (_) { return ''; }
  })();
  const plannerSource = sources.plannerSource !== undefined ? sources.plannerSource : (() => {
    try {
      return require('node:fs').readFileSync(
        require('node:path').join(__dirname, '..', '..', 'runtime',
          'structured-planner-governance.js'), 'utf8');
    } catch (_) { return ''; }
  })();

  const suiteSource = sources.suiteSource !== undefined ? sources.suiteSource : (() => {
    try {
      return require('node:fs').readFileSync(
        require('node:path').join(__dirname, '..',
          'structured-allocation-live-dispatch-postgres-test.js'), 'utf8');
    } catch (_) { return ''; }
  })();
  const registered = sources.registered !== undefined ? sources.registered : (() => {
    try {
      return require('node:fs').readFileSync(
        require('node:path').join(__dirname, '..', 'test-manifest.js'), 'utf8')
        .includes('structured-allocation-live-dispatch-postgres-test.js');
    } catch (_) { return false; }
  })();

  // ── THE THREE ROLES ARE THREE FACTS ─────────────────────────────────────
  //
  // One boolean must never stand in for several unexercised roles. That is
  // exactly how a verdict came to claim three roles on two captured requests:
  // the planner received a worker-shaped answer, no plan was admitted, and the
  // governed leaf executor was never reached. Each role therefore has its own
  // item, and each requires the acceptance suite to be registered AND to carry
  // the assertion that fails when that role produces no outbound request.
  const roleModule = sources.roleModule !== undefined ? sources.roleModule : (() => {
    try {
      // eslint-disable-next-line global-require
      return require('./evaluation-live-capture-roles');
    } catch (_) { return null; }
  })();
  const roleProved = role => registered && roleModule !== null &&
    roleModule.ROLES.includes(role) &&
    typeof roleModule.assertEveryRoleDispatched === 'function' &&
    suiteSource.includes('assertEveryRoleDispatched(allCaptured)') &&
    suiteSource.includes('at least one ACTUAL outbound request instance was captured');

  // A live trial must be able to run WITHOUT the hermetic response fixture.
  record('liveDispatchPathImplemented',
    runnerSource.includes('assertMode(mode)') &&
      runnerSource.includes("const isLive = mode === 'live'") &&
      runnerSource.includes('live-transport-capture-preload.js')
      ? 'FROZEN' : 'UNRESOLVED',
    'runTrial accepts live mode and spawns without the hermetic response fixture',
    'structured-allocation-evaluation-runner runTrial');

  record('ungovernedWorkerDispatchProved', roleProved('ungoverned_worker')
    ? 'FROZEN' : 'UNRESOLVED',
  'an actual ungoverned worker request was captured at the final network hop',
  'structured-allocation-live-dispatch-postgres-test');
  record('structuredPlannerDispatchProved', roleProved('structured_planner')
    ? 'FROZEN' : 'UNRESOLVED',
  'an actual structured planner request was captured at the final network hop',
  'structured-allocation-live-dispatch-postgres-test');
  record('governedLeafDispatchProved', roleProved('governed_leaf_worker')
    ? 'FROZEN' : 'UNRESOLVED',
  'an actual governed leaf worker request was captured, after a real admitted plan',
  'structured-allocation-live-dispatch-postgres-test');

  // ── SAMPLING, PER ROLE ──────────────────────────────────────────────────
  const samplingWired = bodySource.includes('options.sampling');
  record('liveSamplingPlannerProved',
    samplingWired && plannerSource.includes('sampling: resolveProviderSampling()')
      ? 'FROZEN' : 'UNRESOLVED',
    'the planner request body carries the canonical sampling authority',
    'structured-planner-governance buildOpenAiResponsesBody options');
  record('liveSamplingGovernedWorkerProved',
    samplingWired && serverSource.includes('sampling: resolveProviderSampling()')
      ? 'FROZEN' : 'UNRESOLVED',
    'the governed leaf request body carries the canonical sampling authority',
    'server.js governed leaf body');
  record('liveSamplingUngovernedWorkerProved',
    samplingWired && serverSource.includes('sampling: resolveProviderSampling(),')
      ? 'FROZEN' : 'UNRESOLVED',
    'the ungoverned worker request body carries the canonical sampling authority',
    'server.js callOpenAI');

  // ── THE OUTPUT CAP, PER ROLE ────────────────────────────────────────────
  //
  // The liability model prices every request at one output cap. A role whose
  // wire body omits it is priced against a bound it does not carry — which is
  // what made the ungoverned arms' liability claim false.
  const capAgrees = source => source.includes('assertOutputCapAgrees(');
  record('liveOutputCapPlannerProved', capAgrees(plannerSource)
    ? 'FROZEN' : 'UNRESOLVED',
  'the planner output cap is checked to agree with the frozen live control',
  'structured-planner-governance assertOutputCapAgrees');
  record('liveOutputCapGovernedWorkerProved', capAgrees(serverSource)
    ? 'FROZEN' : 'UNRESOLVED',
  'the governed leaf output cap is checked to agree with the frozen live control',
  'server.js governed leaf assertOutputCapAgrees');
  record('liveOutputCapUngovernedWorkerProved',
    serverSource.includes('resolveUngovernedOutputCap()')
      ? 'FROZEN' : 'UNRESOLVED',
    'the ungoverned worker carries the frozen live output cap on the wire',
    'server.js callOpenAI resolveUngovernedOutputCap');

  // ── HISTORICAL COMPATIBILITY ────────────────────────────────────────────
  record('fixtureBodyCompatibilityProved',
    bodySource.includes('options.sampling !== undefined && options.sampling !== null') &&
      !bodySource.includes('sampling = { temperature')
      ? 'FROZEN' : 'UNRESOLVED',
    'a body built without live controls is byte-identical to its historical form',
    'provider-request-body explicit sampling with no default');

  // ── THE GLOBAL ECONOMIC GATE ────────────────────────────────────────────
  const ledger = sources.ledger !== undefined ? sources.ledger : (() => {
    try {
      // eslint-disable-next-line global-require
      return require('./evaluation-live-budget-ledger');
    } catch (_) { return null; }
  })();
  record('liveGlobalEconomicGateImplemented',
    ledger && typeof ledger.assertDispatchWithinGlobalCeiling === 'function'
      ? 'FROZEN' : 'UNRESOLVED',
    'a global ceiling is enforced before every provider dispatch',
    'evaluation-live-budget-ledger');

  // THE WHOLE TRIAL, NOT ONE REQUEST. Reserving `perRequestMicroUsd` for a
  // trial that may issue ten requests is a gate sized for the wrong number.
  record('liveTrialWorstCaseReservationProved',
    runnerSource.includes('trialWorstCaseMicroUsd({') &&
      runnerSource.includes('maximumLiabilityMicroUsd: liveTrialBound.trialWorstCaseMicroUsd')
      ? 'FROZEN' : 'UNRESOLVED',
    'the reservation is the whole trial worst case, derived from Run topology',
    'evaluation-live-trial-liability trialWorstCaseMicroUsd');

  record('liveRetryLiabilityBoundProved',
    (() => {
      try {
        // eslint-disable-next-line global-require
        const liability = require('./evaluation-live-trial-liability');
        return typeof liability.assertRetryLiabilityBounded === 'function';
      } catch (_) { return false; }
    })() ? 'FROZEN' : 'UNRESOLVED',
    'every product-authorized retry attempt is inside the reserved bound',
    'evaluation-live-trial-liability assertRetryLiabilityBounded');

  record('liveGlobalEconomicGateRecoveryProved',
    ledger && typeof ledger.reconstructCommittedLiability === 'function'
      ? 'FROZEN' : 'UNRESOLVED',
    'committed live liability reconstructs after restart from durable records',
    'evaluation-live-budget-ledger reconstructCommittedLiability');

  record('liveGlobalEconomicGateConcurrencyProved',
    ledger && typeof ledger.withLedgerLock === 'function'
      ? 'FROZEN' : 'UNRESOLVED',
    'two concurrent dispatchers cannot spend the same remaining authority',
    'evaluation-live-budget-ledger withLedgerLock');

  record('liveDryRunReachedProviderBoundary',
    runnerSource.includes("mode = 'fixture'") &&
      (() => {
        try {
          const scored = require('node:fs').readFileSync(
            require('node:path').join(__dirname, '..',
              'structured-allocation-evaluation-scored-runner.js'), 'utf8');
          return scored.includes('LIVE DRY RUN REACHED REAL PROVIDER DISPATCH BOUNDARY');
        } catch (_) { return false; }
      })() ? 'FROZEN' : 'UNRESOLVED',
    'the dry run traverses to the real provider dispatch boundary before stopping',
    'scored runner preflightLiveRun');

  record('externalProviderCallsZero',
    registered && suiteSource.includes('EXTERNAL PROVIDER CALLS MADE: 0') &&
      suiteSource.includes('LIVE_CAPTURE_ESCAPE')
      ? 'FROZEN' : 'UNRESOLVED',
    'the acceptance proof makes zero external calls and refuses any escape route',
    'live-transport-capture-preload escape guard');

  // ── THE MATRIX EXECUTOR ─────────────────────────────────────────────────
  //
  // THE LAYER TWO EARLIER VERDICTS MISSED. `liveDispatchPathImplemented` proves
  // a trial can dispatch; `liveDryRunReachedProviderBoundary` proves a dry run
  // reaches the boundary. Both were true while NOTHING could execute slot 2
  // through slot 120, and an authorized run halted at the gate because of it.
  // These facts are deliberately separate: collapsing them into the dispatch
  // fact is exactly the mistake that was made.
  const scoredSource = sources.scoredSource !== undefined ? sources.scoredSource : (() => {
    try {
      return require('node:fs').readFileSync(
        require('node:path').join(__dirname, '..',
          'structured-allocation-evaluation-scored-runner.js'), 'utf8');
    } catch (_) { return ''; }
  })();
  const matrixSuite = sources.matrixSuiteSource !== undefined
    ? sources.matrixSuiteSource : (() => {
      try {
        return require('node:fs').readFileSync(
          require('node:path').join(__dirname, '..',
            'structured-allocation-live-matrix-postgres-test.js'), 'utf8');
      } catch (_) { return ''; }
    })();
  const matrixRegistered = registered && (() => {
    try {
      return require('node:fs').readFileSync(
        require('node:path').join(__dirname, '..', 'test-manifest.js'), 'utf8')
        .includes('structured-allocation-live-matrix-postgres-test.js');
    } catch (_) { return false; }
  })();
  const corpusModule = (() => {
    try {
      // eslint-disable-next-line global-require
      return require('./evaluation-live-corpus-integrity');
    } catch (_) { return null; }
  })();
  const journalModule = (() => {
    try {
      // eslint-disable-next-line global-require
      return require('./evaluation-live-run-journal');
    } catch (_) { return null; }
  })();

  record('liveMatrixExecutorImplemented',
    scoredSource.includes('async function executeLiveRun(') ? 'FROZEN' : 'UNRESOLVED',
    'an executor exists that runs the assigned live matrix, not just one trial',
    'scored runner executeLiveRun');
  record('liveManifestSlotsConsumedByExecutor',
    scoredSource.includes('for (const slot of plan)') &&
      scoredSource.includes('manifest.slots') ? 'FROZEN' : 'UNRESOLVED',
    'the executor consumes the manifest preassigned slots',
    'scored runner executeLiveRun slot iteration');
  record('liveMatrixOrderingProved',
    matrixRegistered &&
      matrixSuite.includes('exactly the frozen manifest order') ? 'FROZEN' : 'UNRESOLVED',
    'slots execute in the frozen manifest order, proved across a restart',
    'live matrix acceptance suite');
  record('liveMatrixJournalProved',
    journalModule !== null &&
      typeof journalModule.appendJournal === 'function' &&
      typeof journalModule.acceptedSlots === 'function' ? 'FROZEN' : 'UNRESOLVED',
    'an append-only hash-chained journal owns which slot is accepted',
    'evaluation-live-run-journal');
  record('liveMatrixResumeProved',
    matrixRegistered && matrixSuite.includes('never re-executed') &&
      scoredSource.includes('alreadyAccepted.has(id)') ? 'FROZEN' : 'UNRESOLVED',
    'resume reuses accepted slots and never re-executes them',
    'live matrix acceptance suite + executor resume');
  record('liveMatrixEconomicReservationProved',
    scoredSource.includes('assertDispatchWithinGlobalCeiling({') &&
      scoredSource.includes('liveReservationAlreadyCommitted: true') &&
      matrixSuite.includes('BEFORE its trial started') ? 'FROZEN' : 'UNRESOLVED',
    'every slot reserves its canonical whole-trial bound before transport',
    'executor reservation ordering');
  // BEHAVIOURAL, not a text match. The artifact's shape is owned by
  // `buildExclusionArtifact`, so the fact CALLS it and inspects the result —
  // a grep for the literal `replacementSlot: null` would have gone stale the
  // moment that line moved to the module that owns it, which is exactly what
  // happened.
  record('liveMatrixInfrastructureExclusionProved',
    scoredSource.includes("classified.classification === 'infrastructure_exclusion'") &&
      corpusModule !== null &&
      typeof corpusModule.buildExclusionArtifact === 'function' &&
      (() => {
        try {
          const built = corpusModule.buildExclusionArtifact({
            label: 'probe', trialId: 'probe',
            header: { runHeaderHash: 'r', manifestHash: 'm', repositoryCommit: 'c' },
            slot: { slot: 1, armId: 'A', scenarioId: 's', variantId: null,
              repetition: 1, stochasticIdentity: 'frozen-identity' },
            classified: { classification: 'infrastructure_exclusion',
              reason: 'probe', evidence: {} }
          });
          return built.replacementSlot === null &&
            built.assignedSlot.seed === 'frozen-identity' &&
            built.assignedSlot.slot === 1;
        } catch (_) { return false; }
      })() ? 'FROZEN' : 'UNRESOLVED',
    'infrastructure exclusions keep their slot and gain no replacement',
    'evaluation-live-corpus-integrity buildExclusionArtifact');
  record('liveCorpusIntegrityGateImplemented',
    corpusModule !== null &&
      typeof corpusModule.auditLiveCorpus === 'function' &&
      typeof corpusModule.assertScorableLiveCorpus === 'function'
      ? 'FROZEN' : 'UNRESOLVED',
    'a corpus integrity gate exists and the scorer refuses anything it rejects',
    'evaluation-live-corpus-integrity');
  record('liveFullCaptured120SlotExecutionProved',
    matrixRegistered &&
      matrixSuite.includes('all 120 assigned slots are accounted for')
      ? 'FROZEN' : 'UNRESOLVED',
    'the complete 120-slot matrix executes under the final-hop capture',
    'live matrix acceptance suite');
  record('liveFullCapturedRunExternalProviderCallsZero',
    matrixRegistered &&
      matrixSuite.includes('EXTERNAL PROVIDER CALLS MADE: 0') ? 'FROZEN' : 'UNRESOLVED',
    'that full-matrix proof makes zero external provider calls',
    'live matrix acceptance suite');
  record('liveSyntheticAcceptanceCannotBeScoredAsProductEvidence',
    corpusModule !== null &&
      (() => {
        try {
          corpusModule.assertScorableLiveCorpus({ syntheticAcceptance: true, complete: true });
          return false;
        } catch (error) {
          return error.code === 'LIVE_CORPUS_SYNTHETIC_NOT_PRODUCT_EVIDENCE';
        }
      })() ? 'FROZEN' : 'UNRESOLVED',
    'the synthetic acceptance corpus can never be scored as live product evidence',
    'evaluation-live-corpus-integrity assertScorableLiveCorpus');

  // ── CREDENTIAL PROPAGATION ──────────────────────────────────────────────
  //
  // A LAYER NEITHER DISPATCH NOR MATRIX EXECUTION PROVES. The harness strips
  // OPENAI_API_KEY before spawning — correct, and it stays — and the real
  // uncaptured live branch must restore it through the override the harness
  // applies afterwards. Every earlier live proof took the capture branch, which
  // supplies a sentinel, so the branch a real matrix depends on was never
  // exercised and an authorized run reached its gate unable to authenticate.
  //
  // `liveDispatchPathImplemented` and `liveFullCaptured120SlotExecutionProved`
  // are both true while this is broken. They prove different layers.
  const envModule = (() => {
    try {
      // eslint-disable-next-line global-require
      return require('./evaluation-server-env');
    } catch (_) { return null; }
  })();
  const harnessSource = sources.harnessSource !== undefined ? sources.harnessSource : (() => {
    try {
      return require('node:fs').readFileSync(
        require('node:path').join(__dirname, '..', 'postgres-test-harness.js'), 'utf8');
    } catch (_) { return ''; }
  })();
  const credentialSuiteRegistered = (() => {
    try {
      return require('node:fs').readFileSync(
        require('node:path').join(__dirname, '..', 'test-manifest.js'), 'utf8')
        .includes('evaluation-live-credential-postgres-test.js');
    } catch (_) { return false; }
  })();
  // BEHAVIOURAL: the module is CALLED, in each of the three modes.
  const credentialModes = envModule === null ? null : (() => {
    try {
      const probe = 'probe-credential-value';
      const fixture = envModule.buildEvaluationServerCredentialEnv({
        mode: 'fixture', env: { OPENAI_API_KEY: probe } });
      const captured = envModule.buildEvaluationServerCredentialEnv({
        mode: 'live', liveTransportCapture: '/x', env: { OPENAI_API_KEY: probe } });
      const live = envModule.buildEvaluationServerCredentialEnv({
        mode: 'live', liveTransportCapture: null, env: { OPENAI_API_KEY: probe } });
      let refused = false;
      try {
        envModule.buildEvaluationServerCredentialEnv({
          mode: 'live', liveTransportCapture: null, env: {} });
      } catch (error) { refused = error.code === 'REAL_LIVE_CREDENTIAL_ABSENT'; }
      return { fixture, captured, live, refused, probe };
    } catch (_) { return null; }
  })();

  record('realLiveCredentialPropagationImplemented',
    credentialModes !== null &&
      credentialModes.live.env.OPENAI_API_KEY === credentialModes.probe &&
      runnerSource.includes('buildEvaluationServerCredentialEnv({')
      ? 'FROZEN' : 'UNRESOLVED',
    'the real uncaptured live branch forwards the authorized credential',
    'evaluation-server-env buildEvaluationServerCredentialEnv');

  record('realLiveCredentialPropagationBehaviourallyProved',
    credentialSuiteRegistered ? 'FROZEN' : 'UNRESOLVED',
    'a registered suite observes the real branch at the spawn boundary',
    'evaluation-live-credential-postgres-test');

  record('ordinaryHarnessCredentialStrippingStillProved',
    harnessSource.includes("'OPENAI_API_KEY', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID'") &&
      harnessSource.includes('delete inheritedEnv[credentialKey]') &&
      credentialSuiteRegistered ? 'FROZEN' : 'UNRESOLVED',
    'the harness still strips inherited credentials for every ordinary spawn',
    'postgres-test-harness inheritedEnv stripping');

  record('syntheticCaptureUsesSentinelNotRealCredential',
    credentialModes !== null &&
      credentialModes.captured.env.OPENAI_API_KEY === envModule.SENTINEL_CREDENTIAL &&
      credentialModes.fixture.env.OPENAI_API_KEY === envModule.SENTINEL_CREDENTIAL &&
      credentialModes.captured.usesRealCredential === false
      ? 'FROZEN' : 'UNRESOLVED',
    'fixture and captured live receive a sentinel, never the real credential',
    'evaluation-server-env sentinel modes');

  record('realLiveMissingCredentialRefusesBeforeSpawn',
    credentialModes !== null && credentialModes.refused === true
      ? 'FROZEN' : 'UNRESOLVED',
    'a real live trial with no credential refuses before a server is spawned',
    'evaluation-server-env REAL_LIVE_CREDENTIAL_ABSENT');

  // ── THE LAYERS THE THREE-ROLE DISPATCH PROOF DOES NOT COVER ─────────────
  //
  // `ungovernedWorkerDispatchProved` and `liveFullCaptured120SlotExecutionProved`
  // were both true while production had NEVER been observed consuming the
  // envelope the provider actually returns: every proof answered with a
  // top-level `output_text` on a hand-written Response clone, and the real API
  // returns neither. A fixture defect was reported as a product runtime defect
  // because of it.
  //
  // Each fact below reads its OWN evidence. They deliberately do not share a
  // single boolean, because one boolean standing in for several unexercised
  // layers is exactly the failure these items exist to prevent.
  const registeredSuite = name => {
    try {
      return require('node:fs').readFileSync(
        require('node:path').join(__dirname, '..', 'test-manifest.js'), 'utf8')
        .includes(name);
    } catch (_) { return false; }
  };
  const suiteText = name => {
    try {
      return require('node:fs').readFileSync(
        require('node:path').join(__dirname, '..', name), 'utf8');
    } catch (_) { return ''; }
  };

  const envelopeSuite = 'ungoverned-real-envelope-pipeline-postgres-test.js';
  const envelopeSource = sources.envelopeSuiteSource !== undefined
    ? sources.envelopeSuiteSource : suiteText(envelopeSuite);
  const envelopeRegistered = sources.envelopeSuiteRegistered !== undefined
    ? sources.envelopeSuiteRegistered : registeredSuite(envelopeSuite);
  const envelopeProves = statement =>
    envelopeRegistered && envelopeSource.includes(statement);

  record('realProviderEnvelopeShapeProved',
    envelopeProves('it is the REAL Responses envelope — output[].content[] ') &&
      envelopeProves('carries NO top-level output_text')
      ? 'FROZEN' : 'UNRESOLVED',
    'production is observed consuming output[].content[] with type output_text, ' +
    'and the envelope it never receives is proved absent',
    `${envelopeSuite} — persisted provider response body`);

  record('ungovernedOneActionResponsePipelineProved',
    envelopeProves('exactly one durable createFolder receipt') &&
      envelopeProves('the child was ABSENT immediately before the mutation') &&
      envelopeProves('the Run truthfully completes')
      ? 'FROZEN' : 'UNRESOLVED',
    'one valid createFolder traverses the whole ungoverned pipeline to a durable ' +
    'receipt and a truthful completion, against the real envelope',
    `${envelopeSuite} — A one action`);

  record('ungovernedActionLimitProductRefusalProved',
    envelopeProves('under the stable code reason=mutating_action_limit') &&
      envelopeProves('the refused response produced ZERO operations') &&
      envelopeProves('the parser ACCEPTED the response — it is structurally valid')
      ? 'FROZEN' : 'UNRESOLVED',
    'four canonical mutations are structurally valid and refused by the ' +
    'per-response action authority — product/model data, not a harness defect',
    `${envelopeSuite} — A four actions`);

  // ── THE DURABLE TRANSPORT SEAM ──────────────────────────────────────────
  //
  // BEHAVIOURAL, then wired, then proved. The contract is CALLED so a fact
  // cannot survive the semantics being weakened; the production wiring is read
  // so the seam cannot exist unused; the suite is required so the durable
  // ordering is actually exercised.
  const transportSuite = 'provider-transport-invocation-postgres-test.js';
  const transportSuiteSource = sources.transportSuiteSource !== undefined
    ? sources.transportSuiteSource : suiteText(transportSuite);
  const transportRegistered = sources.transportSuiteRegistered !== undefined
    ? sources.transportSuiteRegistered : registeredSuite(transportSuite);
  const transportContract = (() => {
    try {
      // eslint-disable-next-line global-require
      const contract = require('../../runtime/provider-transport-observation');
      const built = contract.buildProviderTransportInvocationPayload({
        role: 'ungoverned_worker', evidenceKey: 'probe',
        endpointIdentity: 'https://api.openai.com/v1/responses',
        transportOwner: 'a-dispatch-helper'
      });
      let refusedCredential = false;
      try {
        contract.buildProviderTransportInvocationPayload({
          role: 'ungoverned_worker', evidenceKey: 'probe',
          endpointIdentity: 'https://api.openai.com/v1/responses',
          Authorization: 'x'
        });
      } catch (error) {
        refusedCredential =
          error.code === 'PROVIDER_TRANSPORT_OBSERVATION_CREDENTIAL_MATERIAL';
      }
      return {
        recordedAfter: contract.PROVIDER_TRANSPORT_INVOKED_STRENGTH
          .recordedRelativeToInvocation === 'after',
        absenceUnknown: /UNKNOWN/.test(
          contract.PROVIDER_TRANSPORT_INVOKED_STRENGTH.absenceMeans),
        // The owner is DERIVED from the role, so a caller cannot record a
        // higher-level dispatch site as though it were the wire.
        ownerDerived: built.transportOwner === contract.TRANSPORT_OWNERS.ungoverned_worker,
        refusedCredential,
        roles: contract.TRANSPORT_INVOCATION_ROLES.length,
        contract
      };
    } catch (_) { return null; }
  })();

  // ── THE SEAM IS INERT ───────────────────────────────────────────────────
  //
  // The second half of the fact, and the half that was once FALSE. An
  // observation is invoked with the request already in flight, so a seam that
  // could throw would let an evidence writer discard a provider result, settle
  // a reservation at its authorized maximum, and fail a Run that succeeded.
  //
  // Proved two ways, because neither alone is enough. The contract must CARRY
  // the closed result vocabulary and the stated invariant — a seam that reports
  // outcomes instead of throwing them has to have somewhere to report them —
  // and the registered suite must CALL it with a writer that throws, a payload
  // it must refuse, and a reporter that throws too. This audit is synchronous,
  // so the behavioural half is owned by the suite, exactly as the envelope facts
  // are; removing either half leaves the fact unresolved.
  const transportContractInert = transportContract !== null && (() => {
    try {
      const contract = transportContract.contract;
      return Array.isArray(contract.OBSERVATION_RESULTS) &&
        contract.OBSERVATION_RESULTS.includes('not_persisted') &&
        contract.OBSERVATION_RESULTS.includes('payload_refused') &&
        typeof contract.PROVIDER_TRANSPORT_INVOKED_STRENGTH
          .cannotAlterObservedOutcome === 'string' &&
        /never cancels a provider result/.test(
          contract.PROVIDER_TRANSPORT_INVOKED_STRENGTH.cannotAlterObservedOutcome);
    } catch (_) { return false; }
  })();

  // The unit proof lives with the contract it tests, not with the integration
  // suite, so it is read from its own file.
  const transportUnitSuite = 'provider-transport-observation-test.js';
  const transportUnitSource = sources.transportUnitSource !== undefined
    ? sources.transportUnitSource : suiteText(transportUnitSuite);
  const transportSeamProvedInert = transportContractInert &&
    registeredSuite(transportUnitSuite) &&
    transportUnitSource.includes(
      'GOVERNED: a throwing observation writer produces the IDENTICAL provider ') &&
    transportUnitSource.includes(
      'the seam REPORTS a failed write rather than throwing it') &&
    transportUnitSource.includes('no retry and no duplicate provider request');

  // AND AT THE REAL PIPELINE, on both transports. A unit proof of the seam does
  // not show that production above it survives a failed write.
  const envelopeProvesInert =
    envelopeProves('observation fault: the Run still truthfully completes') &&
    envelopeProves('no retry, no duplicate') &&
    envelopeProves('the artifact projects transport UNKNOWN');
  const governedProvesInert = transportRegistered &&
    transportSuiteSource.includes(
      'governed observation fault: NO transport-invocation event is durable') &&
    transportSuiteSource.includes(
      'governed observation fault: identical reservation states');

  const governedTransportSource = sources.governedTransportSource !== undefined
    ? sources.governedTransportSource : (() => {
      try {
        return require('node:fs').readFileSync(
          require('node:path').join(__dirname, '..', '..', 'runtime',
            'governed-openai-transport.js'), 'utf8');
      } catch (_) { return ''; }
    })();

  record('providerTransportInvocationObservationProved',
    transportContract !== null && transportContract.recordedAfter &&
      transportContract.absenceUnknown && transportContract.ownerDerived &&
      transportContract.refusedCredential && transportContract.roles === 3 &&
      // WIRED AT THE ACTUAL TRANSPORT OWNERS, not at a dispatch helper.
      governedTransportSource.includes('observeProviderTransportInvocation(') &&
      serverSource.includes('createRunTransportInvocationObserver(') &&
      serverSource.includes('observeProviderTransportInvocation(options.observeTransportInvocation') &&
      transportRegistered &&
      transportSuiteSource.includes('THE OBSERVATION IS RECORDED AFTER THE PLATFORM CALL') &&
      transportSuiteSource.includes('a reservation count can never stand in for a ') &&
      // AND THE SEAM IS AN OBSERVATION, NOT A CONTROL POINT. Both halves are
      // required: recording the fact when the write succeeds, and being unable
      // to change the outcome when it fails.
      transportSeamProvedInert && envelopeProvesInert && governedProvesInert
      ? 'FROZEN' : 'UNRESOLVED',
    'production crossing into external transport is durably observed at both ' +
    'transport owners, recorded AFTER the platform call, with absence meaning ' +
    'UNKNOWN — and a failed observation write cannot alter the provider outcome ' +
    'it observes, on either transport',
    'runtime/provider-transport-observation + provider-transport-invocation-postgres-test');

  // ── THE LIVE FAILURE OBSERVATION PROJECTION ─────────────────────────────
  //
  // BEHAVIOURAL. The projection is CALLED with a durable state that carries no
  // transport observation and no receipts, and it must answer UNKNOWN rather
  // than "not invoked" — which is the whole point of the layer. A text match
  // could not tell the two apart.
  const reportSource = sources.reportSource !== undefined ? sources.reportSource : (() => {
    try {
      return require('node:fs').readFileSync(
        require('node:path').join(__dirname, '..',
          'structured-allocation-evaluation-report.js'), 'utf8');
    } catch (_) { return ''; }
  })();
  const projectionBehaviour = (() => {
    try {
      // eslint-disable-next-line global-require
      const { projectLiveDurableObservation } =
        require('./evaluation-live-observation-projection');
      // A request was authorized and NOTHING else is known.
      const silent = projectLiveDurableObservation({
        events: [{ type: 'provider.request.persisted', payload: {} }]
      });
      // Transport was invoked and no workspace work followed.
      const invoked = projectLiveDurableObservation({
        events: [
          { type: 'provider.request.persisted', payload: {} },
          { type: 'provider.transport_invoked', payload: { role: 'ungoverned_worker' } },
          { type: 'run.execution_completed',
            payload: { failure: { code: 'MODEL_MALFORMED_JSON', kind: 'invalid_action' } } }
        ]
      });
      // A structurally valid response refused by the per-response authority.
      const overLimit = projectLiveDurableObservation({
        events: [
          { type: 'model.plan.parsed', payload: { actionCount: 4 } },
          { type: 'action.suppressed',
            payload: { reason: 'mutating_action_limit', limit: 2, mutatingCount: 4 } }
        ]
      });
      // A workspace refusal keeps its own stable code.
      const workspaceRefused = projectLiveDurableObservation({
        events: [{ type: 'authority.denied', payload: { rule: 'owned_output_path' } }],
        receipts: [{ operation: 'createFolder', outcome: 'refused',
          receipt: { error: { code: 'WORKSPACE_OWNERSHIP_VIOLATION' } } }]
      });
      return silent.transport.state === 'UNKNOWN' &&
        silent.response.state === 'UNKNOWN' &&
        silent.extraction.state === 'UNKNOWN' &&
        silent.parser.state === 'UNKNOWN' &&
        invoked.transport.state === 'INVOKED' &&
        invoked.operationReceipts.count === 0 &&
        invoked.parser.refusalCode === 'MODEL_MALFORMED_JSON' &&
        overLimit.actionLimit.state === 'REFUSED' &&
        overLimit.actionLimit.classification === 'product_model_response_authority' &&
        overLimit.parser.state === 'ACCEPTED' &&
        workspaceRefused.workspace.refusalCodes.WORKSPACE_OWNERSHIP_VIOLATION === 1 &&
        workspaceRefused.workspace.authorityDenialRules.owned_output_path === 1;
    } catch (_) { return false; }
  })();

  record('liveFailureObservationProjectionProved',
    projectionBehaviour &&
      // AND THE READER ACTUALLY PROJECTS IT ONTO THE ARTIFACT. A correct
      // projection nobody calls survives no teardown.
      reportSource.includes('projectLiveDurableObservation({') &&
      reportSource.includes('durableObservation:')
      ? 'FROZEN' : 'UNRESOLVED',
    'the live artifact preserves dispatch, transport, response, extraction, ' +
    'parser, action-limit and workspace evidence — and keeps UNKNOWN unknown',
    'evaluation-live-observation-projection + evaluation reader');

  // ── THE ABORTED CORPUS ──────────────────────────────────────────────────
  //
  // BEHAVIOURAL at all three doors into a decision. Each is called; none is
  // matched by text.
  const abortedRejection = (() => {
    try {
      // eslint-disable-next-line global-require
      const corpus = require('./evaluation-live-corpus-integrity');
      // eslint-disable-next-line global-require
      const { combineEvidence } = require('./evaluation-evidence-combination');
      // eslint-disable-next-line global-require
      const scorer = require('../structured-allocation-evaluation-scorer');
      const abortedHeader = { runHeaderHash: corpus.PERMANENTLY_ABORTED_RUNS[0].runHeaderHash };

      let corpusRefused = false;
      try {
        corpus.assertScorableLiveCorpus({ aborted: true, complete: true });
      } catch (error) {
        corpusRefused = error.code === 'LIVE_CORPUS_ABORTED_NOT_DECISION_EVIDENCE';
      }
      let scorerRefused = false;
      try {
        scorer.assertCorpusIntegrity({
          manifest: { trials: [], manifestHash: 'm', failureHandling: { infrastructureExclusions: [] } },
          header: abortedHeader, artifacts: [] });
      } catch (error) {
        scorerRefused = error.detail &&
          error.detail.code === 'SCORER_ABORTED_RUN_NOT_DECISION_EVIDENCE';
      }
      let combinationRefused = false;
      try {
        combineEvidence({
          fixture: { ordinaryDecision: 'RETAIN' },
          live: { ordinaryDecision: 'RETAIN', corpusComplete: true, runHeader: abortedHeader }
        });
      } catch (error) {
        combinationRefused = error.code === 'EVIDENCE_ABORTED_NOT_DECISION_EVIDENCE';
      }
      // AND THE IDENTITY IS RECOGNIZED WITHOUT A LABEL, so a rewritten header
      // cannot launder it back in.
      const identityRecognized = corpus.isAbortedRunHeader(abortedHeader) === true;
      return corpusRefused && scorerRefused && combinationRefused && identityRecognized;
    } catch (_) { return false; }
  })();

  record('abortedCorpusMechanicallyUnscorableProved',
    abortedRejection ? 'FROZEN' : 'UNRESOLVED',
    'a run marked ABORTED — NOT DECISION EVIDENCE is refused by identity at the ' +
    'corpus gate, the scorer and the evidence-combination contract',
    'evaluation-aborted-runs enforced at all three doors');

  const unresolved = items.filter(item => item.state === 'UNRESOLVED');
  return Object.freeze({
    version: LIVE_READINESS_VERSION,
    items: Object.freeze(items),
    unresolved: Object.freeze(unresolved.map(item => item.id)),
    verdict: unresolved.length === 0
      ? 'TRANCHE 6 LIVE-MODEL EVALUATION READY'
      : 'TRANCHE 6 LIVE-MODEL EVALUATION BLOCKED',
    liability: worstCaseLiability({
      // ILLUSTRATIVE ONLY, and labelled so: the live matrix membership is
      // itself unresolved, so this shows what the fixture cells would cost at
      // the frozen live repetition count — not what has been authorized.
      trialsPerArm: { A: 24, A2a: 24, A2b: 12, B: 36, C: 24 }
    })
  });
}

// The gate a live executor must pass before its first provider call. It refuses
// while anything is unresolved, and it names what.
function assertLiveExecutionPermitted(audit = auditLiveReadiness()) {
  if (audit.unresolved.length > 0) {
    const error = new Error(
      'LIVE EVALUATION BLOCKED — the live protocol is not frozen: ' +
      audit.unresolved.join(', '));
    error.code = 'LIVE_EVALUATION_BLOCKED';
    error.detail = { unresolved: audit.unresolved };
    throw error;
  }
  return true;
}

module.exports = {
  LIVE_READINESS_VERSION,
  MAX_REQUESTS_PER_TRIAL,
  PRICING,
  assertLiveExecutionPermitted,
  auditLiveReadiness,
  worstCaseLiability,
  worstCaseMicroUsdPerRequest
};
