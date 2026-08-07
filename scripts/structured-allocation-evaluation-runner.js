#!/usr/bin/env node
'use strict';

// Tranche 6 — the executable trial runner.
//
// ONE TRIAL, ONE ARM, ONE ARTIFACT. It drives the REAL production path end to
// end: the real server, an authenticated session, the real `POST /tickets`
// form, the existing scheduler and workers, the existing terminalization and
// reconciliation. It inserts no allocation plan, no planning attempt, no Run,
// no leaf binding, no receipt, no evidence, no block, no consequence, no
// completion decision and no terminal status — because inserting any of those
// would fabricate the very behaviour the evaluation exists to observe.
//
// THE ONLY THING IT CONFIGURES IS THE TICKET FORM. Which production path runs
// is then decided by production, from the same six form fields an operator
// supplies. The adapters below contribute configuration and a durable path
// predicate; they never assert a path from the arm label, because an arm label
// is a request, not evidence.
//
// IT DOES NOT SCORE. No comparison, no ranking, no aggregate, no threshold.
// Every artifact is labelled UNSCORED HARNESS SMOKE — NOT PRODUCT EVIDENCE.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const {
  ARMS, assertArmReachesIntendedPath, assertObservedPathMatches,
  classifyPathStage, expectedPathStage
} = require('./fixtures/evaluation-arms');
const {
  getScenario, assertArmAllowed, materializeResponses, buildOracleFor,
  resolveScenarioVariant, PROTOCOL_VERSION
} = require('./fixtures/evaluation-scenarios');
const {
  createFixtureNamespace, stageResponses, transcriptHash, externalStateHash,
  transportSummary, readAccessLog, readTranscript
} = require('./fixtures/evaluation-fixture-provider');
const {
  evaluateCouplingWithFixture
} = require('./fixtures/evaluation-coupling-oracle');
const { assertAllWorkerResponsesConsumed } = require('./fixtures/evaluation-fetch-fixture');
const { assertDispatchWithinGlobalCeiling } =
  require('./fixtures/evaluation-live-budget-ledger');
const { trialWorstCaseMicroUsd } = require('./fixtures/evaluation-live-trial-liability');
const {
  OBSERVATION_SINK_VERSION, readObservations
} = require('./fixtures/evaluation-observation-sink');
const { evaluateScenarioOutcome, classifyTruthfulness } = require('./fixtures/evaluation-oracle');
const {
  observeQuiescence, buildTrialArtifact, writeTrialArtifact, assertMode
} = require('./fixtures/evaluation-quiescence');
const {
  collectTrialObservations, durableFingerprint
} = require('./structured-allocation-evaluation-report');
const {
  freezePricingSnapshot, buildNormalizedCost
} = require('./fixtures/evaluation-normalized-cost');
const {
  buildComparisonEnvelope, classifyTrialInclusion, CONTROLLED_FIELDS
} = require('./fixtures/evaluation-trial-record');
const { pricedCatalogValue } = require('./governed-structured-fixture');
const {
  buildGovernedExecutionValue
} = require('./fixtures/governed-role-policy-container');
const { buildPricingCatalog } = require('../runtime/model-pricing-catalog');

const SUPPORTED_MODES = Object.freeze(['fixture', 'live']);
const QUIESCENCE_TIMEOUT_MS = 180_000;

class EvaluationRunnerError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'EvaluationRunnerError';
    this.detail = detail;
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      throw new EvaluationRunnerError(`unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new EvaluationRunnerError(`--${key} requires a value`);
    }
    parsed[key] = value;
    index += 1;
  }
  for (const required of ['mode', 'scenario', 'arm', 'repetition', 'seed', 'output']) {
    if (!parsed[required]) {
      throw new EvaluationRunnerError(`--${required} is required`);
    }
  }
  if (!SUPPORTED_MODES.includes(parsed.mode)) {
    throw new EvaluationRunnerError(
      `--mode must be one of ${SUPPORTED_MODES.join(', ')}`);
  }
  // Live mode carries prerequisites this session does not satisfy, and refusing
  // here is what stops a live call being made by a typo.
  if (parsed.mode === 'live') {
    throw new EvaluationRunnerError(
      'live mode requires the frozen live prerequisites and is refused by this ' +
      'runner; only fixture mode is executable');
  }
  if (!ARMS[parsed.arm]) {
    throw new EvaluationRunnerError(`unknown arm ${parsed.arm}`);
  }
  // `--variant` is OPTIONAL: a scenario with one canonical variant needs none.
  // When supplied it must belong to the selected scenario, and the arm must be
  // allowed for it — both are checked here, before any server is spawned.
  const scenario = getScenario(parsed.scenario);
  let resolved;
  try {
    resolved = resolveScenarioVariant(scenario, parsed.variant || null);
  } catch (error) {
    throw new EvaluationRunnerError(error.message, error.detail || {});
  }
  try {
    assertArmAllowed(resolved, parsed.arm);
  } catch (error) {
    throw new EvaluationRunnerError(error.message, error.detail || {});
  }
  parsed.variant = resolved.variantId || null;
  const repetition = Number(parsed.repetition);
  if (!Number.isSafeInteger(repetition) || repetition <= 0) {
    throw new EvaluationRunnerError('--repetition must be a positive integer');
  }
  return { ...parsed, repetition };
}

// ── The five adapters ───────────────────────────────────────────────────────
//
// Configuration only. Each returns the exact form fields an operator would
// submit, plus the durable facts its path must show.

function buildTicketForm(arm, scenario, context) {
  const base = { objective: scenario.objective };
  if (arm.armId === 'A') {
    return {
      ...base,
      assignmentTargetType: 'agent',
      assignmentTargetId: String(context.workerAgentIds[0]),
      assignmentMode: 'individual'
    };
  }
  // Every agent in the group needs its OWN, NON-OVERLAPPING owned path:
  // production refuses a member without one, and refuses two members that
  // share one. Reusing the scenario's owned roots modulo the agent count
  // produced exactly that duplicate.
  const ownedOutputPaths = context.ownershipMap;

  const group = {
    ...base,
    assignmentTargetType: 'group',
    assignmentTargetId: String(context.groupId),
    assignmentMode: arm.assignmentMode
  };
  // Operator ownership is supplied only where the arm says the operator
  // supplies it. Dynamic arms leave it out so production derives it.
  if (arm.ownershipSource === 'operator') {
    group.ownedOutputPaths = JSON.stringify(ownedOutputPaths);
  }
  // declaredWork is what routes a group ticket to the structured v2 path.
  if (arm.declaredWork) {
    group.declaredWork = JSON.stringify(scenario.declaredWork);
  }
  return group;
}

// The variant participates in the trial identity, so two variants of one
// scenario can never share a fixture namespace or silently reuse staged state.
// Exported so that property can be proved directly rather than inferred from a
// run that happens not to collide.
function trialIdFor(scenario, arm, repetition) {
  return `${scenario.scenarioId}${scenario.variantId ? `--${scenario.variantId}` : ''}` +
    `--${arm.armId}--r${repetition}`;
}

// ── Family-7 churn facts and family-8 recovery facts ────────────────────────
//
// FACTS, NOT VERDICTS. Each function reports what the fixture transcript and
// the durable Ticket report actually showed. Neither decides whether the
// product behaved correctly, and neither is compared between arms — they exist
// so a reader can tell a genuine no-progress window from an undelivered
// response, and a reused durable response from a retransmission.
// PLANNER AND WORKER ARE DIFFERENT WINDOWS.
//
// A family-7 variant injects its boundary on the WORKER request. Counting the
// planner's durable response in the same total would report "a response became
// durable" for a window in which none did — crediting the planner's success to
// the worker's boundary. Every transport fact is therefore reported per role,
// and the combined view is never used to judge a variant.
function transportFactsFor(transport, role) {
  const scoped = role === null
    ? transport : transport.filter(entry => entry.role === role);
  const served = scoped.filter(entry => entry.boundary === 'response_durable');
  const attempted = scoped.filter(entry => entry.boundary !== 'refused_before_transport');
  const identities = served.map(entry => entry.responseIdentity).filter(Boolean);
  return Object.freeze({
    durableResponses: served.length,
    attemptedTransports: attempted.length,
    refusedTransports: scoped.length - served.length,
    duplicateServedCalls: identities.length - new Set(identities).size,
    responseIdentities: Object.freeze([...new Set(identities)].sort()),
    boundaries: Object.freeze([...new Set(scoped.map(entry => entry.boundary))].sort()),
    // HOW MANY TIMES EACH BOUNDARY WAS REACHED. A structured trial has sibling
    // leaf Runs, so a total transport count says nothing about the ONE request a
    // variant injected its boundary on. The count of that boundary does.
    boundaryCounts: Object.freeze(scoped.reduce((counts, entry) => {
      counts[entry.boundary] = (counts[entry.boundary] || 0) + 1;
      return counts;
    }, {})),
    // Only the boundaries the SCENARIO staged. A refusal for want of a staged
    // response is a different fact and is counted above, never here.
    injectedBoundaryCounts: Object.freeze(scoped.filter(entry => entry.injected)
      .reduce((counts, entry) => {
        counts[entry.boundary] = (counts[entry.boundary] || 0) + 1;
        return counts;
      }, {}))
  });
}

function buildChurnFacts(report, observations) {
  const transport = observations.transport;
  const served = transport.filter(entry => entry.boundary === 'response_durable');
  const refused = transport.filter(entry => entry.boundary !== 'response_durable');
  return Object.freeze({
    observationCompleteness: observations.completeness,
    // The two windows, never summed.
    planner: transportFactsFor(transport, 'planner'),
    worker: transportFactsFor(transport, 'worker'),
    // Did a response become durable at all? A refused transport produced none,
    // so no window may be judged from it.
    durableResponses: served.length,
    refusedTransports: refused.length,
    refusalReasons: Object.freeze([...new Set(refused.map(e => e.boundary))].sort()),
    // The canonical churn block the product itself recorded, if any. Reported
    // beside the fixture facts rather than derived from them.
    noProgressStreak: report.churn && report.churn.noProgressStreak !== undefined
      ? report.churn.noProgressStreak : null,
    progressBlocks: report.churn && report.churn.progressBlocks !== undefined
      ? report.churn.progressBlocks : null,
    verifiedProgressCredits: report.churn && report.churn.verifiedProgressCredits !== undefined
      ? report.churn.verifiedProgressCredits : null,
    providerRequests: Array.isArray(report.canonicalRequests)
      ? report.canonicalRequests.length : null
  });
}

function buildRecoveryFacts(observations, workspaceRoot, scenario) {
  const transport = observations.transport;
  // A transport ATTEMPT is any request whose bytes left, whether or not a
  // response came back. That is the count family 8 needs: retransmission is
  // about attempts, not about answers.
  const attempted = transport.filter(entry => entry.boundary !== 'refused_before_transport');
  const served = transport.filter(entry => entry.boundary === 'response_durable');
  const identities = served.map(entry => entry.responseIdentity).filter(Boolean);
  // A committed effect is observed in RAW workspace state, never inferred from
  // a receipt: the question is whether the world changed, and how many times.
  const effectPath = scenario.oracle && scenario.oracle.kind === 'raw_state' &&
    scenario.oracle.expectations[0] && scenario.oracle.expectations[0].path
    ? path.join(workspaceRoot, scenario.oracle.expectations[0].path) : null;
  const committedEffects = effectPath && fs.existsSync(effectPath) ? 1 : 0;
  return Object.freeze({
    observationCompleteness: observations.completeness,
    // Recovery boundaries belong to the WORKER request. The planner's transport
    // is reported beside it so a reader can see it was not the thing under test.
    planner: transportFactsFor(transport, 'planner'),
    worker: transportFactsFor(transport, 'worker'),
    servedCalls: served.length,
    attemptedTransports: attempted.length,
    // Serving the same staged response twice is a RETRANSMISSION, which the
    // uncertain-delivery boundary must never produce.
    duplicateServedCalls: identities.length - new Set(identities).size,
    responseIdentities: Object.freeze([...new Set(identities)].sort()),
    durableResponse: served.some(entry => Boolean(entry.responseIdentity)),
    refusedBefore: transport.filter(e => e.boundary === 'refused_before_transport').length,
    committedEffects,
    // One effect path, observed once. A duplicated effect would appear as a
    // second distinct artifact, which the scenarios deliberately do not stage.
    duplicateEffects: 0,
    failureBoundary: scenario.failureBoundary || 'none'
  });
}

// ── Cross-role parent policy revision parity ────────────────────────────────
//
// Exported so it can be exercised with DISAGREEING inputs. A happy-path trial
// always agrees, so a predicate that simply returned true would be
// indistinguishable there — the only way to prove it discriminates is to feed it
// a mismatch directly.
//
// `workerReferences` arrives DISTINCT from SQL: more than one entry means the
// leaf Runs disagree among themselves, which is a parity failure regardless of
// what the planner captured.
function sameParentPolicyRevisionOf(plannerReference, workerReferences) {
  const canonical = value => (value && typeof value === 'object'
    ? JSON.stringify(Object.keys(value).sort().map(key => [key, value[key]]))
    : null);
  const distinct = [...new Set((workerReferences || []).map(canonical))];
  return Boolean(
    plannerReference &&
    distinct.length === 1 &&
    distinct[0] !== null &&
    distinct[0] === canonical(plannerReference));
}

// ── Durable path proof ──────────────────────────────────────────────────────
//
// Read from persisted state, never from the arm label. `assertObservedPathMatches`
// refuses when the facts belong to another path.
async function proveDurablePath(store, ticketId, arm) {
  const runs = (await store.pool.query(
    `SELECT id, body->>'allocationPlanId' AS allocation_plan_id,
            body ? 'leafRunBinding' AS governed_leaf,
            body ? 'governedExecution' AS governed_envelope
       FROM ${store.table('runs')} WHERE ticket_id = $1 ORDER BY id`, [ticketId])).rows;
  const plans = (await store.pool.query(
    `SELECT id, body FROM ${store.table('allocation_plans')} WHERE ticket_id = $1`,
    [ticketId])).rows;
  const planningAttempts = (await store.pool.query(
    `SELECT count(*)::int AS n FROM ${store.table('events')}
      WHERE ticket_id = $1 AND type LIKE 'ticket.structured_planning%'`, [ticketId])).rows[0].n;
  // The SELECTED role-policy hashes, also from captured state. They must differ:
  // one revision funding two roles is not the same as one policy funding both.
  const capturedPolicyHashes = (await store.pool.query(
    `SELECT
       (SELECT body #>> '{structuredAllocationPlanningAttempt,governedExecution,economicPolicyHash}'
          FROM ${store.table('tickets')} WHERE id = $1) AS planner_hash,
       (SELECT DISTINCT body #>> '{governedExecution,economicPolicyHash}'
          FROM ${store.table('runs')}
         WHERE ticket_id = $1 AND body ? 'leafRunBinding' LIMIT 1) AS worker_hash`,
    [ticketId])).rows[0];
  const plannerReservations = (await store.pool.query(
    `SELECT count(*)::int AS n FROM ${store.table('economic_request_reservations')}
      WHERE ticket_id = $1 AND role = 'structured_planner'`, [ticketId])).rows[0].n;
  // WORKER-ROLE facts, read separately from the planner's.
  //
  // `structured_v2_executed` may not be claimed from an admitted leaf Run: a
  // Run can be admitted with complete governed authority and never claimed. The
  // proof of EXECUTION is a worker-role reservation — created only when a
  // governed leaf request is actually issued under the leaf-executor role — and
  // a Run that was actually claimed.
  const workerReservations = (await store.pool.query(
    `SELECT count(*)::int AS n FROM ${store.table('economic_request_reservations')}
      WHERE ticket_id = $1 AND role = 'structured_leaf_executor'`, [ticketId])).rows[0].n;
  const claimedLeafRuns = (await store.pool.query(
    `SELECT count(*)::int AS n FROM ${store.table('runs')}
      WHERE ticket_id = $1 AND body ? 'leafRunBinding' AND started_at IS NOT NULL`,
    [ticketId])).rows[0].n;
  // Reservations must never cross roles: a planner reservation may not be
  // charged to a worker account, nor the reverse. Read as distinct accounts
  // rather than inferred from counts.
  const roleAccounts = (await store.pool.query(
    `SELECT role, count(DISTINCT account_id)::int AS accounts
       FROM ${store.table('economic_request_reservations')}
      WHERE ticket_id = $1 GROUP BY role ORDER BY role`, [ticketId])).rows;
  const ticketStatus = (await store.pool.query(
    `SELECT status FROM ${store.table('tickets')} WHERE id = $1`,
    [ticketId])).rows[0];
  // THE CANONICAL RECONCILIATION AUTHORITY. Written by the store in the same
  // transaction as the aggregate decision it describes, so its presence is
  // evidence the reconciler ran and its write committed.
  const reconciliationEvents = (await store.pool.query(
    `SELECT payload->>'aggregateStatus' AS aggregate_status,
            payload->>'aggregateDecisionHash' AS decision_hash
       FROM ${store.table('events')}
      WHERE ticket_id = $1 AND type = 'ticket.allocation_leaf_items_reconciled'
      ORDER BY seq DESC`, [ticketId])).rows;
  // How many executable items the admitted plan actually declared. EVERY one of
  // them must receive its own governed leaf Run: a plan that silently produced
  // fewer Runs than items would leave declared work with no executor while
  // still looking like a successful structured trial.
  // ── PARENT POLICY REVISION PARITY, from CAPTURED state only ──────────
  //
  // Read out of the durable planning attempt and the durable Run envelopes.
  // Deriving this from the currently active container would prove nothing: the
  // whole question is whether the two roles were funded by the SAME revision at
  // the time they were captured, and current configuration cannot answer that.
  const plannerParent = (await store.pool.query(
    `SELECT body #> '{structuredAllocationPlanningAttempt,governedExecution,parentPolicyReference}'
              AS reference
       FROM ${store.table('tickets')} WHERE id = $1`, [ticketId])).rows[0];
  const workerParents = (await store.pool.query(
    `SELECT DISTINCT body #> '{governedExecution,parentPolicyReference}' AS reference
       FROM ${store.table('runs')}
      WHERE ticket_id = $1 AND body ? 'leafRunBinding'`, [ticketId])).rows;
  const plannerReference = plannerParent && plannerParent.reference
    ? plannerParent.reference : null;
  const workerReferences = workerParents
    .map(row => row.reference).filter(Boolean);
  const sameParentPolicyRevision =
    sameParentPolicyRevisionOf(plannerReference, workerReferences);

  const executableItems = plans.reduce((total, plan) => {
    const items = plan.body && Array.isArray(plan.body.items) ? plan.body.items : [];
    return total + items.length;
  }, 0);

  // A STRUCTURED PLANNING ATTEMPT IS ITSELF EVIDENCE OF THE STRUCTURED PATH.
  //
  // A ticket whose planning was attempted and then blocked admits no plan and
  // creates no Run, which looks identical to the direct path by plan/Run counts
  // alone. Classifying that as `direct` would mislabel a truthful structured
  // outcome as a different architecture, so the attempt counts.
  const observed = {
    structuredPlanAdmitted: runs.some(run => run.governed_leaf) || planningAttempts > 0,
    planningAttempts,
    plannerRequestCount: plannerReservations,
    governedLeafRunCount: runs.filter(run => run.governed_leaf).length,
    allocationPlanPresent: plans.length > 0,
    runCount: runs.length
  };
  // A structured ticket that never even attempted planning is a genuine routing
  // failure and must not be reported as a blocked structured trial.
  if (arm.expectedPath === 'structured_v2' && planningAttempts === 0) {
    throw new EvaluationRunnerError(
      `arm ${arm.armId} made no structured planning attempt — the structured ` +
      'path was not reached at all');
  }
  const observedPath = assertObservedPathMatches(arm, observed);

  // Version is a fact about how the plan was ADMITTED, not about the arm and
  // not about how many Runs followed. Deriving it from leaf Runs reported a
  // genuinely admitted v2 plan as v1 whenever leaf admission had not yet run.
  const planVersion = plans.length === 0 ? null
    : (planningAttempts > 0 || runs.some(run => run.governed_leaf) ? 2 : 1);
  if (arm.expectedPath === 'legacy_v1' && planVersion !== 1) {
    throw new EvaluationRunnerError(
      `arm ${arm.armId} must show allocation plan version 1, observed ${planVersion}`);
  }
  if (arm.expectedPath === 'structured_v2' && plans.length > 0 && planVersion !== 2) {
    throw new EvaluationRunnerError(
      `arm ${arm.armId} admitted a plan that is not version 2, observed ${planVersion}`);
  }
  if (!arm.expectedGoverned && runs.some(run => run.governed_envelope)) {
    throw new EvaluationRunnerError(
      `arm ${arm.armId} must carry no governed execution envelope`);
  }
  if (arm.expectedPath !== 'structured_v2' && planningAttempts > 0) {
    throw new EvaluationRunnerError(
      `arm ${arm.armId} must make no structured planning attempt, observed ${planningAttempts}`);
  }
  const planningFailures = (await store.pool.query(
    `SELECT payload FROM ${store.table('events')}
      WHERE ticket_id = $1 AND type = 'ticket.structured_planning_failed'
      ORDER BY seq DESC LIMIT 1`, [ticketId])).rows;
  // The four separate facts the milestone distinguishes, so a planning attempt
  // can never be read as executed governed work.
  const proof = {
    observedPath, planVersion, planningAttempts,
    planningAttempted: planningAttempts > 0,
    planAdmitted: plans.length > 0,
    leafRunsAdmitted: observed.governedLeafRunCount > 0,
    // ADMISSION IS NOT EXECUTION. Both facts must hold: a governed leaf request
    // was actually issued under the worker role, and a leaf Run was actually
    // claimed and started.
    governedLeafExecutionObserved: workerReservations > 0 && claimedLeafRuns > 0,
    planningFailureReason: planningFailures.length > 0
      ? JSON.stringify(planningFailures[0].payload).slice(0, 300) : null,
    plannerRequestCount: plannerReservations,
    leafExecutorRequestCount: workerReservations,
    claimedLeafRunCount: claimedLeafRuns,
    // One account per role, and never one shared between them.
    executableItemCount: executableItems,
    // Authority validity, NOT a comparison metric. It says whether this trial's
    // governed authority is coherent, never whether an arm performed better.
    plannerParentPolicyReference: plannerReference,
    workerParentPolicyReference: workerReferences.length > 0 ? workerReferences[0] : null,
    economicPolicySetVersion: plannerReference
      ? plannerReference.economicPolicySetVersion : null,
    economicPolicySetHash: plannerReference
      ? plannerReference.economicPolicySetHash : null,
    plannerEconomicPolicyHash: capturedPolicyHashes.planner_hash || null,
    workerEconomicPolicyHash: capturedPolicyHashes.worker_hash || null,
    sameParentPolicyRevision,
    roleAccounts: roleAccounts.map(row => ({
      role: row.role, accounts: Number(row.accounts)
    })),
    // ── TWO DIFFERENT FACTS, NAMED SEPARATELY ────────────────────────────
    //
    // This field previously inferred reconciliation from the Ticket's status:
    // a settled status was read as "the aggregate reconciler ran". Those are
    // not the same claim, and the weaker one may not wear the stronger one's
    // name — completion truthfulness is an authorized metric, so an inferred
    // historical claim would corrupt exactly the thing being measured.
    //
    // `aggregateReconciliationObserved` is now bound to the ONE durable
    // authority that records a reconciliation actually happening:
    // `ticket.allocation_leaf_items_reconciled`, journalled by the store in the
    // same transaction as the aggregate write, so it can never describe a
    // reconciliation that rolled back.
    //
    // Terminal Run status cannot set it. Quiescence cannot set it. A `blocked`
    // Ticket MAY be reconciled — the event, not the status, decides.
    aggregateReconciliationObserved: reconciliationEvents.length > 0,
    aggregateReconciliationAuthority: reconciliationEvents.length > 0
      ? Object.freeze({
        events: reconciliationEvents.length,
        aggregateStatus: reconciliationEvents[0].aggregate_status,
        aggregateDecisionHash: reconciliationEvents[0].decision_hash
      })
      : null,
    // The INFERRED fact, kept because it is genuinely useful — under its own
    // name, saying only what it observes.
    aggregateSettled:
      ['completed', 'failed', 'interrupted', 'cancelled', 'blocked']
        .includes(ticketStatus && ticketStatus.status),
    ticketResultStatus: ticketStatus ? ticketStatus.status : null,
    ticketStatus: ticketStatus ? ticketStatus.status : null,
    runCount: runs.length,
    governedLeafRunCount: observed.governedLeafRunCount,
    allocationPlanIds: plans.map(plan => plan.id),
    authority: 'durable_state'
  };
  // ONE classifier, shared with the read-only report. The stage is derived
  // last, from the durable facts above, so it can never be more optimistic than
  // they are.
  return Object.freeze({
    ...proof,
    pathStage: classifyPathStage(arm, proof),
    expectedPathStage: expectedPathStage(arm)
  });
}

// ── Quiescence, with a truthful timeout ─────────────────────────────────────

async function waitForQuiescence(store, ticketId, namespace, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await observeQuiescence(store, ticketId, { fixtureNamespace: namespace });
    if (last.quiescent) return { ...last, timedOut: false };
    if (Date.now() > deadline) {
      // A timeout is a trial RESULT, not an exclusion and not a pretence of
      // quiescence.
      return { ...last, timedOut: true };
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

// ── The trial ───────────────────────────────────────────────────────────────

async function runTrial({
  store, startServer, workspaceRoot, scenario: requestedScenario, arm, repetition,
  seed, outputPath, commit, smokeRoot, namespaceRoot, variant = null,
  omitStagedLogicalTasks = null,
  // Supplied ONLY by the scored executor. Its absence is what keeps every
  // other caller's artifact explicitly unscored.
  scoredIdentity = null,
  // ── LIVE MODE ────────────────────────────────────────────────────────────
  //
  // The difference between fixture and live is the PROVIDER ENVIRONMENT, not
  // the product semantics: the same trial construction, the same server, the
  // same scheduler, workers, quiescence, oracle and artifact contract. Live
  // mode removes the hermetic response fixture and supplies the frozen request
  // controls — sampling and the output cap — and changes nothing else.
  //
  // `liveTransportCapture` is a TEST-ONLY path. When set, the spawned server
  // loads a preload that replaces only the final network hop, so the live
  // dispatch path can be proved without spending money. When it is null and
  // mode is live, the server reaches the real provider.
  mode = 'fixture',
  liveRequestControls = null,
  liveTransportCapture = null,
  // THE GLOBAL ECONOMIC CEILING, enforced at dispatch.
  //
  // "At dispatch" is taken conservatively: the trial's ENTIRE authorized worst
  // case is committed to the durable ledger BEFORE the process that could reach
  // the provider is spawned. So no request can leave the machine without its
  // liability already recorded, and a crash mid-trial cannot make spent money
  // look unspent on resume. Reserving per-request inside the server would need
  // a production hook into the transport, which is exactly the backdoor this
  // evaluation must not add.
  liveBudget = null
}) {
  assertMode(mode);
  // ONE RESOLUTION POINT. The variant is resolved into a complete scenario here
  // and nowhere else, so every downstream step — staging, oracle, artifact —
  // consumes it exactly as it consumes a single-variant scenario. An unknown
  // variant, or one belonging to another scenario, refuses rather than falling
  // back to the default.
  const scenario = resolveScenarioVariant(requestedScenario, variant);
  assertArmAllowed(scenario, arm.armId);
  if (scenario.protocolVersion !== PROTOCOL_VERSION) {
    throw new EvaluationRunnerError('scenario protocol version mismatch');
  }
  if (fs.existsSync(outputPath)) {
    throw new EvaluationRunnerError(
      `refusing to overwrite an existing trial artifact at ${outputPath}`);
  }

  const trialId = trialIdFor(scenario, arm, repetition);
  // Fixture namespaces live under a PER-INVOCATION root while artifacts stay at
  // a stable per-commit path. Reuse inside one invocation still refuses — that
  // is the isolation guarantee — but re-running the milestone is not blocked by
  // the previous attempt's leftovers, which would otherwise make the guarantee
  // indistinguishable from a broken harness.
  const namespace = createFixtureNamespace(namespaceRoot || smokeRoot, trialId);

  // ISOLATED INITIAL WORKSPACE STATE.
  //
  // The server uses the harness workspace root, so the trial state must live
  // there rather than in a private subdirectory the product would never read.
  // Trials run sequentially, so isolation comes from RESETTING that root to the
  // scenario's declared initial state before each trial: identical starting
  // point, no residue from an earlier arm.
  const trialWorkspace = workspaceRoot;
  for (const entry of fs.readdirSync(trialWorkspace)) {
    fs.rmSync(path.join(trialWorkspace, entry), { recursive: true, force: true });
  }
  // A path whose KIND raw observation cannot decide.
  //
  // Family 9C needs a genuine "insufficient raw state" case, and the obvious
  // candidates do not produce one: a directory where a file is expected is a
  // truthful FAIL (the file really is absent), and an unreadable file depends
  // on the running uid, which is not a property of the scenario. A FIFO is
  // neither a regular file nor a directory, so the oracle must refuse to judge
  // it however the harness is run.
  for (const fifo of scenario.initialState.undecidablePaths || []) {
    const target = path.join(trialWorkspace, fifo);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    execFileSync('mkfifo', [target]);
  }
  for (const folder of scenario.initialState.folders || []) {
    fs.mkdirSync(path.join(trialWorkspace, folder), { recursive: true });
  }
  // Owned-scope paths must EXIST before ticket creation: production refuses an
  // allocated ticket whose owned paths are absent. Creating them is part of the
  // scenario's initial state, not a bypass — an operator does the same. The
  // exact set is computed below, once the group membership is known.
  const initialWorkspaceHash = crypto.createHash('sha256')
    .update(JSON.stringify(scenario.initialState)).digest('hex');

  // Canonical setup: agents, group and planner configuration. This is setup,
  // not the branch under evaluation — the branch is ticket creation onward, and
  // that goes through the real form.
  const stamp = `eval-${trialId}-${Date.now()}`;
  const group = (await store.createGroup({
    value: { name: `Eval ${stamp}`, permissions: [], canReceiveTickets: true },
    changedBy: 'evaluation-runner'
  })).group;
  const makeAgent = async name => (await store.createConfiguredAgent({
    value: {
      name: `${name} ${stamp}`, provider: 'openai',
      model: 'gpt-4o-mini-2024-07-18',
      apiKey: 'test-only-sentinel-not-a-real-credential'
    },
    groupIds: [group.id], changedBy: 'evaluation-runner'
  })).agent;
  const workerOne = await makeAgent('WorkerOne');
  const workerTwo = await makeAgent('WorkerTwo');
  // A PLANNER IS ADDED ONLY WHERE THE ARM NEEDS ONE.
  //
  // The legacy v1 plan requires an owned output path for EVERY agent in the
  // group and refuses the ticket otherwise, so a planner sitting in the group
  // unused would 400 the legacy arms at ticket creation. It is also the
  // truthful configuration: an operator running the legacy path does not
  // designate a planner.
  // GOVERNED ROUTING AUTHORITY, for the structured arms only.
  //
  // The previous B/C trials failed at `invocation_readiness` with
  // `planner_route_unavailable` and `requestHash: null` — no planner request
  // was ever issued. The cause was not the planner fixture response and not the
  // declared work: `loadGovernedPlannerPolicyContainer` requires exactly one
  // ACTIVE model routing policy carrying `governedExecution`, and the trial
  // environment had none. Production was refusing to spend without captured
  // routing and pricing authority, which is correct.
  //
  // Seeding it is configuration the operator supplies, not a contract change:
  // one policy carrying role routes and economic policy for the planner and the
  // leaf executor, priced from the same catalog the evaluation's normalized
  // cost uses.
  if (arm.plannerAgent) {
    // EXACTLY ONE active governed routing policy may exist:
    // `loadGovernedPlannerPolicyContainer` refuses when two do. Seeding one per
    // trial made the SECOND structured trial in a run fail planning with an
    // ambiguity the first trial had caused — so an existing policy is reused
    // rather than duplicated.
    const existing = await store.listModelRoutingPolicies({
      statuses: ['active'], limit: 100
    });
    const rows = Array.isArray(existing) ? existing : (existing && existing.policies) || [];
    const alreadyGoverned = rows.some(row => row && row.governedExecution);
    // ONE container, BOTH roles.
    //
    // The singular `economicPolicy` this block used to seed funded only the
    // planner, so leaf admission refused with
    // `leaf_governed_authority_unavailable` — truthfully, because no worker
    // economics were configured anywhere. The container now carries the
    // role-keyed set, and BOTH the planner invocation and leaf admission read
    // their own entry from this same active revision through the production
    // loader. Nothing here hands a policy source to the store directly.
    if (!alreadyGoverned) await store.createModelRoutingPolicy({
      value: {
        name: `Eval governed routing ${stamp}`,
        status: 'active',
        workContextId: null,
        capabilityId: null,
        allowedProviders: ['openai'],
        preferredProvider: 'openai',
        preferredModel: 'gpt-4o-mini-2024-07-18',
        fallbackProviders: [],
        maxCost: null,
        maxLatency: null,
        riskClass: 'standard',
        toolRequirements: [],
        targetRequirements: [],
        verificationRequirement: null,
        triageOnNoRoute: true,
        governedExecution: buildGovernedExecutionValue()
      },
      changedBy: 'evaluation-runner'
    });
  }

  let planner = null;
  if (arm.plannerAgent) {
    planner = await makeAgent('Planner');
    await store.updateGroup({
      groupId: group.id, expectedRevision: group.revision,
      value: { ...group, plannerAgentId: planner.id }, changedBy: 'evaluation-runner'
    });
  }

  // Candidate agents are the group's WORKERS: the proposal assigns work to
  // them, and the planner is not a candidate for its own plan.
  // EVERY group member is a captured candidate, planner included, and lowering
  // refuses a proposal that omits one.
  const staged = materializeResponses(scenario, seed, {
    candidateAgentIds: [workerOne.id, workerTwo.id,
      ...(planner ? [planner.id] : [])]
  });
  // NEGATIVE-CONTROL SEAM, test-only and never used by the scored or unscored
  // matrix. It removes exactly the named worker responses from the staged set
  // so a real governed request can be made for an identity nothing staged —
  // the only way to exercise the unexpected-request path through a real server.
  const stagedForTrial = omitStagedLogicalTasks
    ? staged.filter(entry => !(entry.role === 'worker' &&
        omitStagedLogicalTasks.includes(entry.logicalTaskId)))
    : staged;
  if (omitStagedLogicalTasks && stagedForTrial.length === staged.length) {
    throw new EvaluationRunnerError(
      `omitStagedLogicalTasks removed nothing: ${omitStagedLogicalTasks.join(', ')} ` +
      'matched no staged worker response, so the negative control would prove nothing');
  }
  // A LIVE run stages NOTHING. Every step below that reads or annotates the
  // staged table belongs to the fixture path, and running it for a live trial
  // would leave staged-answer state beside a run that must have consulted the
  // provider.
  if (mode !== 'live') {
    stageResponses(namespace, stagedForTrial);
    // The fetch adapter recovers the logical task from what production sent.
    const table = JSON.parse(fs.readFileSync(namespace.stagedPath, 'utf8'));
    for (const entry of Object.values(table)) {
      const source = staged.find(item =>
        item.role === entry.role && item.ordinal === entry.ordinal &&
        item.logicalTaskId === entry.logicalTaskId);
      if (source && source.match) entry.match = source.match;
    }
    fs.writeFileSync(namespace.stagedPath, JSON.stringify(table));
  }

  const envelope = buildComparisonEnvelope({
    objective: scenario.objective,
    declaredWorkHash: crypto.createHash('sha256')
      .update(JSON.stringify(scenario.declaredWork)).digest('hex'),
    expectationHash: scenario.oracle.kind === 'raw_state'
      ? buildOracleFor(scenario).expectationHash : 'coupling',
    initialWorkspaceHash,
    postconditionHash: crypto.createHash('sha256')
      .update(JSON.stringify(scenario.oracle)).digest('hex'),
    provider: 'openai',
    model: 'gpt-4o-mini-2024-07-18',
    maxOutputTokens: 2048,
    contextWindowTokens: 128000,
    runtimeLimitsHash: 'default',
    economicCeilingMicroUsd: 1_000_000,
    retryPolicyHash: 'autoRetry:false',
    allowParallelRuns: false,
    toolCatalogHash: 'default',
    scenarioSeed: seed,
    fixtureResponseHash: crypto.createHash('sha256')
      .update(JSON.stringify(staged)).digest('hex'),
    verificationPolicy: 'when_declared'
  });

  // THE GOVERNED PLANNER RESPONSE, from the same staged table.
  //
  // The planner request goes through the governed transport's `https.request`
  // seam, which the hermetic preload feeds from `HERMETIC_TRANSPORT_RESPONSE`.
  // Writing it from the SAME staged entries keeps one response source for both
  // transports; a second table would let the two arms diverge invisibly.
  // BOTH ROLES, from the SAME materialized set.
  //
  // Only planner responses used to be written here, so a governed WORKER
  // request had nothing staged and was refused — which meant families 7 and 8
  // could never reach the worker boundaries they exist to test, and no governed
  // worker transport observation was ever produced. Every staged entry is now
  // written, carrying its match string, role, ordinal and failure boundary.
  //
  // Selection stays CONTENT-ADDRESSED: the preload matches `match` against the
  // request bytes. The arm label is not written here and cannot select anything.
  // A LIVE run stages NOTHING. Writing the table and merely not loading it
  // would leave a staged-answer file beside a run that must have consulted the
  // provider, and "it was there but unused" is not a claim evidence can carry.
  const governedResponsePath = path.join(namespace.dir, 'governed-responses.json');
  if (mode !== 'live') fs.writeFileSync(governedResponsePath, JSON.stringify({
    responses: stagedForTrial.map(entry => ({
      statusCode: 200,
      role: entry.role,
      ordinal: entry.ordinal,
      logicalTaskId: entry.logicalTaskId,
      // The planner request carries the ticket objective; a worker request
      // carries its owned path. Both appear in the request bytes, so one match
      // rule serves both roles.
      match: entry.role === 'planner' ? null : entry.match,
      failureBoundary: entry.failureBoundary || 'none',
      body: JSON.stringify({
        id: `fixture-${entry.role}-${entry.logicalTaskId}-${entry.ordinal}`,
        output_text: entry.body,
        usage: {
          input_tokens: entry.inputTokens,
          output_tokens: entry.outputTokens,
          total_tokens: entry.inputTokens + entry.outputTokens
        }
      })
    }))
  }));

  const isLive = mode === 'live';
  // The hermetic evaluation preload STAGES provider responses. A live run must
  // not load it: a staged answer would mean the provider was never consulted,
  // which is the exact defect that made the previous readiness verdict false.
  const preload = isLive
    ? (liveTransportCapture
      ? path.join(__dirname, 'fixtures', 'live-transport-capture-preload.js')
      : null)
    : path.join(__dirname, 'fixtures', 'evaluation-preload.js');

  // THE RESERVATION HAPPENS HERE — before the server exists, not after it
  // answered. A refusal throws, and nothing is spawned.
  //
  // WHAT IS RESERVED IS THE WHOLE TRIAL. Reserving one request's worth, as an
  // earlier version did, let a trial that may issue ten requests pass a gate
  // sized for one. The bound is derived from the arm's Run topology and the two
  // enforced per-Run request ceilings, so it cannot drift from what the product
  // can actually spend.
  let liveTrialBound = null;
  if (isLive) {
    if (!liveBudget) {
      throw new EvaluationRunnerError(
        'a live trial requires an explicit global budget authority; refusing to ' +
        'dispatch against an unbounded ceiling');
    }
    liveTrialBound = trialWorstCaseMicroUsd({
      armId: arm.armId,
      perRequestMicroUsd: liveBudget.perRequestMicroUsd,
      runtimeMaxModelRequestsPerRun: liveBudget.runtimeMaxModelRequestsPerRun,
      governedLeafMaximumProviderRequests:
        liveBudget.governedLeafMaximumProviderRequests,
      governedPlannerMaximumProviderRequests:
        liveBudget.governedPlannerMaximumProviderRequests,
      // Proven off for every live trial: the trial form supplies no
      // executionPolicy and `normalizeExecutionPolicy` makes autoRetry a strict
      // opt-in. If that ever changed, the bound would grow, not silently
      // understate.
      autoRetryEnabled: false,
      maxAttempts: null
    });
    assertDispatchWithinGlobalCeiling({
      runRoot: liveBudget.runRoot,
      ceilingMicroUsd: liveBudget.ceilingMicroUsd,
      maximumLiabilityMicroUsd: liveTrialBound.trialWorstCaseMicroUsd,
      trialId,
      role: `trial_worst_case:${arm.armId}`,
      ordinal: repetition
    });
  }

  const server = await startServer({
    env: {
      ...(preload ? { NODE_OPTIONS: `--require ${preload}` } : {}),
      ...(isLive ? {} : { EVALUATION_FIXTURE_NAMESPACE: namespace.dir }),
      // ONE immutable descriptor, carried as a single serialized value. Every
      // observation the spawned server writes names this exact trial, so two
      // trials can never be averaged into one set of streams.
      ...(isLive ? {
        // THE FROZEN SAMPLING AUTHORITY, supplied only in live mode. Absent in
        // fixture mode, so every completed fixture body stays byte-identical.
        EVALUATION_LIVE_REQUEST_CONTROLS: JSON.stringify(liveRequestControls),
        ...(liveTransportCapture ? {
          LIVE_TRANSPORT_CAPTURE: liveTransportCapture,
          LIVE_TRANSPORT_CAPTURE_TRIAL_ID: trialId
        } : {})
      } : {}),
      ...(isLive ? {} : { EVALUATION_OBSERVATION_DESCRIPTOR: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        trialId,
        namespaceDir: namespace.dir,
        scenarioId: scenario.scenarioId,
        variantId: scenario.variantId || null,
        repetition,
        seed,
        fixtureTableHash: crypto.createHash('sha256')
          .update(fs.readFileSync(namespace.stagedPath)).digest('hex')
      }) }),
      // Scopes the real-read observer to THIS trial's workspace. Without it the
      // wrapper does not install at all.
      EVALUATION_OBSERVED_WORKSPACE_ROOT: trialWorkspace,
      ...(process.env.EVALUATION_CAPTURE_LEAF_ADMISSION === '1'
        ? { EVALUATION_CAPTURE_LEAF_ADMISSION: '1' } : {}),
      // NO hermetic response staging in live mode.
      ...(isLive ? {} : {
        HERMETIC_TRANSPORT_RESPONSE: governedResponsePath,
        HERMETIC_TRANSPORT_CAPTURE: path.join(namespace.dir, 'governed-capture.jsonl')
      }),
      // CREDENTIALS.
      //
      // Fixture mode uses a sentinel that is not a credential. A CAPTURED live
      // run also uses a sentinel: the final network hop is replaced, so no
      // request can leave the machine and a real key would be pointless risk —
      // but the governed planner refuses to route without SOME credential
      // present, so the sentinel is what lets the real dispatch path run at all.
      // A genuine live run supplies neither, inheriting the real credential from
      // normal secret configuration, and never writes it anywhere.
      ...(isLive && !liveTransportCapture
        ? {}
        : { OPENAI_API_KEY: 'test-only-sentinel-not-a-real-credential' }),
      // NOT AGGRESSIVE. A 200 ms tick made a scheduler continuation race the
      // synchronous post-planning leaf admission for the same plan, and the
      // loser blocked the Ticket with `leaf_admission_conflict` before any leaf
      // Run was created. The race is real in production too, but forcing it
      // here measured the harness rather than the product.
      // THE PINNED PER-RUN REQUEST CEILING. An ungoverned Run has no economic
      // authority, so this production knob is its only bound on provider
      // attempts — and the reservation is computed against exactly this number.
      // Supplying it here is what makes the priced bound and the enforced bound
      // the same bound.
      ...(isLive ? {
        AGENT_MAX_MODEL_REQUESTS_PER_RUN:
          String(liveBudget.runtimeMaxModelRequestsPerRun)
      } : {}),
      RUNTIME_SCHEDULER_INTERVAL_MS: '2000'
    }
  });

  let artifact = null;
  try {
    // The harness may return the cookie with or without its `sessionId=`
    // prefix. Doubling it produces a valid-looking header that the server
    // rejects, and the ticket POST then redirects to /login with a 302 that
    // looks exactly like success.
    const rawCookie = await server.login();
    const cookieHeader = String(rawCookie).startsWith('sessionId=')
      ? String(rawCookie)
      : `sessionId=${rawCookie}`;
    const groupAgentIds = [workerOne.id, workerTwo.id,
      ...(planner ? [planner.id] : [])];
    // One distinct path per agent: the scenario's declared roots first, then
    // uniquely named siblings for any additional member.
    const declaredOwners = Object.values(scenario.ownedOutputPaths);
    const ownershipMap = {};
    groupAgentIds.forEach((agentId, index) => {
      ownershipMap[String(agentId)] = index < declaredOwners.length
        ? declaredOwners[index]
        : `reports/agent-${index}/`;
    });
    for (const owned of Object.values(ownershipMap)) {
      fs.mkdirSync(path.join(trialWorkspace, owned.replace(/\/$/, '')),
        { recursive: true });
    }
    const form = buildTicketForm(arm, scenario, {
      groupId: group.id,
      workerAgentIds: [workerOne.id, workerTwo.id],
      groupAgentIds,
      ownershipMap
    });
    // Pre-trial refusal: the configuration must reach the arm's intended path.
    assertArmReachesIntendedPath(arm, {
      assignmentTargetType: form.assignmentTargetType,
      assignmentMode: form.assignmentMode === 'individual'
        ? arm.assignmentMode : form.assignmentMode,
      declaredWorkSupplied: Boolean(form.declaredWork),
      plannerAgentPresent: arm.plannerAgent
    });

    const created = await server.request('POST', '/tickets', {
      form, headers: { Cookie: cookieHeader }
    });
    if (created.statusCode !== 302) {
      // Surface the server's own refusal text. The form re-renders with the
      // message inside an error element; matching loose keywords picked up
      // static help copy instead, so this reads the element.
      const raw = String(created.body || '');
      const match = raw.match(/class="[^"]*error[^"]*"[^>]*>([\s\S]{0,300}?)</i) ||
        raw.match(/Owned-scope[^<]{0,200}/i) ||
        raw.match(/(?:refused|rejected|invalid|must)[^<]{0,200}/i);
      const detail = match ? (match[1] || match[0]).replace(/\s+/g, ' ').trim() : '';
      throw new EvaluationRunnerError(
        `ticket creation failed with HTTP ${created.statusCode}` +
        (detail ? `: ${detail.slice(0, 220)}` : ''));
    }
    const ticketRows = (await store.pool.query(
      `SELECT id FROM ${store.table('tickets')} ORDER BY id DESC LIMIT 1`)).rows;
    if (ticketRows.length === 0) {
      throw new EvaluationRunnerError(
        'the ticket form returned a redirect but created no Ticket — the ' +
        'submission did not reach ticket creation', { location: created.headers && created.headers.location });
    }
    const ticketId = ticketRows[0].id;

    const quiescence = await waitForQuiescence(
      store, ticketId, namespace, QUIESCENCE_TIMEOUT_MS);

    const pathProof = await proveDurablePath(store, ticketId, arm);

    // ZERO DRIFT: fingerprint, report, fingerprint, report, fingerprint.
    const before = await durableFingerprint(store, ticketId);
    const pricingInputs = {
      provider: 'openai', model: 'gpt-4o-mini-2024-07-18',
      authorizedOutputTokens: 2048, boundInputTokens: 8000
    };
    const firstReport = await collectTrialObservations(store, {
      ticketId, armId: arm.armId, pricingInputs });
    const between = await durableFingerprint(store, ticketId);
    const secondReport = await collectTrialObservations(store, {
      ticketId, armId: arm.armId, pricingInputs });
    const after = await durableFingerprint(store, ticketId);
    const drift = JSON.stringify(before) !== JSON.stringify(between) ||
      JSON.stringify(between) !== JSON.stringify(after);
    if (drift) {
      throw new EvaluationRunnerError(
        'the read-only report changed durable state', { before, between, after });
    }

    // ── THE INDEPENDENT ORACLE, one of two kinds ─────────────────────────
    //
    // A raw-state oracle reads the filesystem. A COUPLING oracle additionally
    // consults the fixture-owned access log, because "did the consumer actually
    // read the producer?" cannot be answered by final files: a summary naming
    // the right hash looks identical whether the product read it or the staged
    // response already contained it. Both kinds are arm-blind and neither reads
    // any product table.
    const oracleContract = buildOracleFor(scenario);
    // The shared sink is the ONE observation authority. Completeness is read
    // before any count, so an absent observer can never be reported as a
    // negative finding.
    const observations = readObservations(namespace.dir);
    let oracleResult;
    if (scenario.oracle.kind === 'coupling') {
      // AVAILABILITY IS ABOUT THE OBSERVER, NOT ABOUT WHAT IT SAW.
      //
      // The log file is created lazily, on the first observed read. Treating an
      // absent file as "unavailable" would report every trial in which nothing
      // was read as REFUSED — collapsing "the consumer demonstrably did not read
      // the producer" into "we could not tell", which are opposite findings. The
      // observer was installed for the whole trial whenever the namespace
      // exists, so that is what availability means; an empty log is zero
      // observed reads.
      // An oracle that needs an access observation may return PASS or FAIL only
      // when the observation is COMPLETE. Anything else refuses.
      oracleResult = evaluateCouplingWithFixture({
        workspaceRoot: trialWorkspace,
        seed,
        producerPath: oracleContract.producerPath,
        consumerPath: oracleContract.consumerPath,
        consumerReaderId: oracleContract.consumerReaderId,
        accessLogAvailable: observations.completeness === 'complete',
        // Real reads, observed by the shared sink AFTER the production read
        // returned. The reader identity is the consumer task the scenario
        // declared; the sink records the path and the exact returned bytes.
        accessLog: observations.consumerReads
          .filter(entry => entry.requestedPath === oracleContract.producerPath)
          .map(entry => ({
            reader: oracleContract.consumerReaderId,
            artifactPath: entry.requestedPath,
            artifactHash: entry.contentHash
          }))
      });
    } else {
      oracleResult = evaluateScenarioOutcome({
        workspaceRoot: trialWorkspace, expectation: oracleContract });
    }
    const truthfulness = classifyTruthfulness({
      productClaimsCompleted: firstReport.productClaimsCompleted, oracleResult });

    const snapshot = freezePricingSnapshot(buildPricingCatalog(pricedCatalogValue()));
    const cost = buildNormalizedCost({
      snapshot,
      requests: firstReport.canonicalRequests,
      truthfulCompletions: truthfulness === 'true_positive_completion' ? 1 : 0,
      durableGovernedMicroUsd: firstReport.durableGovernedMicroUsd,
      releasedReservations: firstReport.releasedReservations
    });

    const transcript = readTranscript(namespace);
    const warnings = [];
    // Consumption is a FIXTURE contract: it asks whether every staged answer
    // was used. A live run stages none, so there is nothing to consume.
    try { if (mode !== 'live') assertAllWorkerResponsesConsumed(namespace.dir); }
    catch (error) { warnings.push(error.message); }
    if (quiescence.timedOut) warnings.push('trial timed out before quiescence');

    artifact = buildTrialArtifact({
      ...(scoredIdentity || {}),
      protocolVersion: PROTOCOL_VERSION,
      repositoryCommit: commit,
      scenarioId: scenario.scenarioId,
      family: scenario.family,
      variantId: scenario.variantId || null,
      variantLabel: scenario.variantLabel || null,
      variantExpectation: scenario.variantExpectation || null,
      armId: arm.armId,
      repetition,
      seed,
      mode,
      envelopeHash: envelope.envelopeHash,
      pathProof,
      ticketReport: { ...firstReport, secondReadIdentical: !drift },
      oracleResult,
      normalizedCost: cost,
      durableGovernedCost: firstReport.durableGovernedMicroUsd,
      latency: firstReport.latency,
      churn: firstReport.churn,
      churnFacts: buildChurnFacts(firstReport, observations),
      recoveryFacts: buildRecoveryFacts(observations, trialWorkspace, scenario),
      observationSinkVersion: OBSERVATION_SINK_VERSION,
      observationCompleteness: observations.completeness,
      observationStreamIdentities: observations.streamIdentities,
      truthfulness,
      quiescence,
      fixtureTranscriptHash: transcriptHash(namespace),
      externalStateHash: externalStateHash(namespace),
      exclusions: [classifyTrialInclusion({
        completedTrial: !quiescence.timedOut, failureReason: null })],
      warnings: warnings.concat([
        `truthfulness=${truthfulness}`,
        `transport=${JSON.stringify(transportSummary(namespace))}`,
        `initialWorkspaceHash=${initialWorkspaceHash}`,
        `zeroDriftFingerprint=${JSON.stringify(before)}`
      ])
    });
    writeTrialArtifact(outputPath, artifact);
  } finally {
    if (process.env.EVALUATION_DUMP_SERVER_OUTPUT === '1') {
      const out = typeof server.output === 'function' ? server.output() : '';
      const lines = String(out).split('\n')
        .filter(line => /LEAF_ADMISSION_RAW_ERROR|leaf|admission|allocation|Error|error/i.test(line));
      console.log('SERVER OUTPUT (filtered):\n' + lines.slice(-25).join('\n'));
    }
    await server.stop().catch(() => {});
  }
  return artifact;
}

module.exports = {
  sameParentPolicyRevisionOf,
  trialIdFor,
  SUPPORTED_MODES,
  QUIESCENCE_TIMEOUT_MS,
  EvaluationRunnerError,
  parseArguments,
  buildTicketForm,
  proveDurablePath,
  waitForQuiescence,
  runTrial
};

if (require.main === module) {
  console.error(
    'The runner executes inside the canonical PostgreSQL/real-server harness. ' +
    'Invoke it through scripts/structured-allocation-evaluation-runner-postgres-test.js, ' +
    'which supplies the store, workspace and server lifecycle.');
  process.exit(2);
}
