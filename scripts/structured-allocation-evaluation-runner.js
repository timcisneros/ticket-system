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
  ARMS, assertArmReachesIntendedPath, assertObservedPathMatches
} = require('./fixtures/evaluation-arms');
const {
  getScenario, assertArmAllowed, materializeResponses, buildOracleFor,
  PROTOCOL_VERSION
} = require('./fixtures/evaluation-scenarios');
const {
  createFixtureNamespace, stageResponses, transcriptHash, externalStateHash,
  transportSummary
} = require('./fixtures/evaluation-fixture-provider');
const { assertAllWorkerResponsesConsumed } = require('./fixtures/evaluation-fetch-fixture');
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
  const plannerReservations = (await store.pool.query(
    `SELECT count(*)::int AS n FROM ${store.table('economic_request_reservations')}
      WHERE ticket_id = $1 AND role = 'structured_planner'`, [ticketId])).rows[0].n;

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
  return Object.freeze({
    observedPath, planVersion, planningAttempts,
    planningAttempted: planningAttempts > 0,
    planAdmitted: plans.length > 0,
    leafRunsAdmitted: observed.governedLeafRunCount > 0,
    governedLeafExecutionObserved: runs.some(run =>
      run.governed_leaf && run.governed_envelope),
    planningFailureReason: planningFailures.length > 0
      ? JSON.stringify(planningFailures[0].payload).slice(0, 300) : null,
    plannerRequestCount: plannerReservations,
    runCount: runs.length,
    governedLeafRunCount: observed.governedLeafRunCount,
    allocationPlanIds: plans.map(plan => plan.id),
    authority: 'durable_state'
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
  store, startServer, workspaceRoot, scenario, arm, repetition, seed,
  outputPath, commit, smokeRoot, namespaceRoot
}) {
  assertMode('fixture');
  assertArmAllowed(scenario, arm.armId);
  if (scenario.protocolVersion !== PROTOCOL_VERSION) {
    throw new EvaluationRunnerError('scenario protocol version mismatch');
  }
  if (fs.existsSync(outputPath)) {
    throw new EvaluationRunnerError(
      `refusing to overwrite an existing trial artifact at ${outputPath}`);
  }

  const trialId = `${scenario.scenarioId}--${arm.armId}--r${repetition}`;
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
    const catalog = buildPricingCatalog(pricedCatalogValue());
    const roleEntry = role => ({
      role,
      primaryRoute: {
        adapterId: 'openai.responses.v1', provider: 'openai',
        model: 'gpt-4o-mini-2024-07-18'
      },
      fallbackRoute: null,
      authorizedFallbackReasons: []
    });
    const economics = role => ({
      policyId: `${role}-economics-eval`,
      role,
      authorizedMicroUsd: 500_000,
      maximumProviderRequests: 3,
      maximumOutputTokensPerRequest: 2048,
      pricingCatalogId: catalog.catalogId,
      pricingCatalogHash: catalog.catalogHash,
      fallbackLiabilityAuthorized: false,
      fallbackProviderRequests: 0,
      // Required by the economic-authority contract: an economic policy that
      // cannot say when it was captured cannot be bound to a request.
      capturedAt: '2026-08-01T00:00:00.000Z'
    });
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
        governedExecution: {
          roleRoutingPolicy: {
            policyId: 'eval-routing-1',
            rolePolicies: [
              roleEntry('structured_planner'),
              roleEntry('structured_leaf_executor')
            ]
          },
          economicPolicy: economics('structured_planner'),
          pricingCatalog: pricedCatalogValue()
        }
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
  stageResponses(namespace, staged);
  // The fetch adapter recovers the logical task from what production sent.
  const table = JSON.parse(fs.readFileSync(namespace.stagedPath, 'utf8'));
  for (const entry of Object.values(table)) {
    const source = staged.find(item =>
      item.role === entry.role && item.ordinal === entry.ordinal &&
      item.logicalTaskId === entry.logicalTaskId);
    if (source && source.match) entry.match = source.match;
  }
  fs.writeFileSync(namespace.stagedPath, JSON.stringify(table));

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
  const plannerStaged = staged.filter(entry => entry.role === 'planner');
  const governedResponsePath = path.join(namespace.dir, 'governed-responses.json');
  fs.writeFileSync(governedResponsePath, JSON.stringify({
    responses: plannerStaged.map(entry => ({
      statusCode: 200,
      body: JSON.stringify({
        id: `fixture-planner-${entry.ordinal}`,
        output_text: entry.body,
        usage: {
          input_tokens: entry.inputTokens,
          output_tokens: entry.outputTokens,
          total_tokens: entry.inputTokens + entry.outputTokens
        }
      })
    }))
  }));

  const server = await startServer({
    env: {
      NODE_OPTIONS: `--require ${path.join(__dirname, 'fixtures', 'evaluation-preload.js')}`,
      EVALUATION_FIXTURE_NAMESPACE: namespace.dir,
      HERMETIC_TRANSPORT_RESPONSE: governedResponsePath,
      HERMETIC_TRANSPORT_CAPTURE: path.join(namespace.dir, 'governed-capture.jsonl'),
      OPENAI_API_KEY: 'test-only-sentinel-not-a-real-credential',
      // NOT AGGRESSIVE. A 200 ms tick made a scheduler continuation race the
      // synchronous post-planning leaf admission for the same plan, and the
      // loser blocked the Ticket with `leaf_admission_conflict` before any leaf
      // Run was created. The race is real in production too, but forcing it
      // here measured the harness rather than the product.
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

    const oracleResult = evaluateScenarioOutcome({
      workspaceRoot: trialWorkspace, expectation: buildOracleFor(scenario) });
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

    const warnings = [];
    try { assertAllWorkerResponsesConsumed(namespace.dir); }
    catch (error) { warnings.push(error.message); }
    if (quiescence.timedOut) warnings.push('trial timed out before quiescence');

    artifact = buildTrialArtifact({
      protocolVersion: PROTOCOL_VERSION,
      repositoryCommit: commit,
      scenarioId: scenario.scenarioId,
      armId: arm.armId,
      repetition,
      seed,
      mode: 'fixture',
      envelopeHash: envelope.envelopeHash,
      pathProof,
      ticketReport: { ...firstReport, secondReadIdentical: !drift },
      oracleResult,
      normalizedCost: cost,
      durableGovernedCost: firstReport.durableGovernedMicroUsd,
      latency: firstReport.latency,
      churn: firstReport.churn,
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
        .filter(line => /leaf|admission|allocation|Error|error/i.test(line));
      console.log('SERVER OUTPUT (filtered):\n' + lines.slice(-25).join('\n'));
    }
    await server.stop().catch(() => {});
  }
  return artifact;
}

module.exports = {
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
