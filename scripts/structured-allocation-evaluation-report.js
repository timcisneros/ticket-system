#!/usr/bin/env node
'use strict';

// Tranche 6 — the Ticket-scoped evaluation READER.
//
// STRICTLY READ-ONLY. It issues SELECT statements and nothing else. It does not
// transition Tickets, claim Runs, reconstruct missing product authority, create
// evidence, settle reservations, retry work, or change execution behaviour in
// any way. The accompanying suite mutation-proves zero durable drift: every
// table's row count, every Run revision and the events maximum are identical
// before and after a full collection.
//
// WHY A SCRIPT AND NOT AN API. An evaluation reader is measurement, not product
// surface. Exposing it as a route would make it a thing operators depend on and
// a thing the product must keep stable; it is neither.
//
// WHAT IT DELIBERATELY DOES NOT DECIDE. It collects durable facts and hands them
// to the trial record. It does not judge truthfulness: the independent oracle
// answers "was the objective actually achieved" from raw state, and this reader
// only reports what the PRODUCT claimed. Keeping those two apart is the whole
// point of the truthfulness measurement.

const {
  ARMS,
  assertObservedPathMatches
} = require('./fixtures/evaluation-arms');
const {
  projectLiveDurableObservation
} = require('./fixtures/evaluation-live-observation-projection');

const GOVERNED_WORKER_ROLE = 'structured_leaf_executor';
const GOVERNED_PLANNER_ROLE = 'structured_planner';

class EvaluationReaderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EvaluationReaderError';
  }
}

// Every statement this module may issue. Asserted by the suite: a reader that
// grew an INSERT or UPDATE would stop being a reader.
function assertSelectOnly(sql) {
  const normalized = String(sql).trim().toUpperCase();
  if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
    throw new EvaluationReaderError(
      'the evaluation reader may only issue SELECT statements');
  }
  return sql;
}

async function readOnly(store, sql, params) {
  const result = await store.pool.query(assertSelectOnly(sql), params);
  return result.rows;
}

// ── Durable collection, per Ticket ─────────────────────────────────────────

async function collectTicketFacts(store, ticketId) {
  const runs = await readOnly(store,
    `SELECT id, status, created_at, started_at, completed_at,
            body->>'allocationPlanId' AS allocation_plan_id,
            body->>'allocationItemId' AS allocation_item_id,
            body ? 'leafRunBinding' AS governed_leaf,
            body ? 'governedProgressBlock' AS has_block,
            body->'governedProgressBlock' AS progress_block
       FROM ${store.table('runs')}
      WHERE ticket_id = $1 ORDER BY id`, [ticketId]);

  const plans = await readOnly(store,
    `SELECT id FROM ${store.table('allocation_plans')} WHERE ticket_id = $1 ORDER BY id`,
    [ticketId]);

  const reservations = await readOnly(store,
    `SELECT id, ticket_id, planning_attempt_id, run_id, role, state,
            model_request_ordinal, logical_source_identity, exact_request_hash,
            settled_micro_usd, settlement_receipt, reserved_max_micro_usd,
            economic_authority, prepared_request,
            settlement_receipt IS NOT NULL AS settled
       FROM ${store.table('economic_request_reservations')}
      WHERE ticket_id = $1 ORDER BY id`, [ticketId]);

  // The receipt document carries the operation's stable refusal code. Without
  // it a refused workspace action projects only as "not succeeded".
  const receipts = await readOnly(store,
    `SELECT id, run_id, operation, outcome, workspace_path, recorded_at, receipt
       FROM ${store.table('operation_receipts')}
      WHERE ticket_id = $1 ORDER BY id`, [ticketId]);

  // PAYLOADS ARE READ, not just types. The live artifact must survive the
  // ephemeral database, and the stable codes that distinguish a parser refusal
  // from a per-response action-limit refusal from a workspace refusal live in
  // the payloads. Reading only types is what left the artifact with counts it
  // could not interpret.
  const events = await readOnly(store,
    `SELECT type, run_id, seq, ts, payload FROM ${store.table('events')}
      WHERE ticket_id = $1 ORDER BY seq`, [ticketId]);

  const ticket = (await readOnly(store,
    `SELECT id, status, created_at, updated_at FROM ${store.table('tickets')}
      WHERE id = $1`, [ticketId]))[0] || null;

  // Model-request budget charges are the ONE request-count authority present on
  // every arm — governed and ungoverned alike — which is what makes a
  // normalized cross-arm cost possible at all.
  const charges = await readOnly(store,
    `SELECT charge.run_id, charge.source_identity, charge.state
       FROM ${store.table('run_budget_charges')} AS charge
       JOIN ${store.table('runs')} AS run ON run.id = charge.run_id
      WHERE run.ticket_id = $1 AND charge.dimension = 'model_request'
      ORDER BY charge.id`, [ticketId]);

  // Provider-reported usage, durable in diagnostic logs. Present for the
  // ungoverned arms; the governed arms carry usage in their settlement receipt
  // instead. Both are read, and the trial record records which source each
  // request's tokens came from.
  const usageLogs = await readOnly(store,
    `SELECT run_id, body->'usage' AS usage
       FROM ${store.table('diagnostic_logs')}
      WHERE ticket_id = $1 AND type = 'model:response'
        AND body ? 'usage'
      ORDER BY id`, [ticketId]);

  const consequences = await readOnly(store,
    `SELECT consequence.run_id, consequence.consequence
       FROM ${store.table('run_consequences')} AS consequence
       JOIN ${store.table('runs')} AS run ON run.id = consequence.run_id
      WHERE run.ticket_id = $1 ORDER BY consequence.run_id`, [ticketId]);

  return { ticket, runs, plans, reservations, receipts, events, charges, usageLogs, consequences };
}

// ── Derivations, each from the facts above ─────────────────────────────────

// What the PRODUCT claims. Deliberately a single boolean plus its authority, so
// the truthfulness classifier receives the product's claim and the oracle's
// independent verdict as two separate inputs.
function deriveProductCompletionClaim(facts) {
  const decisions = facts.consequences
    .map(row => row.consequence && row.consequence.completionDecision)
    .filter(Boolean);
  const ticketCompleted = Boolean(facts.ticket && facts.ticket.status === 'completed');
  const anyRunCompleted = facts.runs.some(run => run.status === 'completed');
  return {
    productClaimsCompleted: ticketCompleted,
    authority: {
      ticketStatus: facts.ticket ? facts.ticket.status : null,
      anyRunCompleted,
      completionDecisionCount: decisions.length,
      completionDecidedEvents: facts.events.filter(e => e.type === 'run.completion_decided').length
    }
  };
}

function deriveLatency(facts) {
  const at = row => (row && row.ts ? new Date(row.ts).getTime() : null);
  const earliest = values => values.reduce((minimum, value) =>
    (Number.isFinite(value) && (!Number.isFinite(minimum) || value < minimum)
      ? value : minimum), null);
  const earliestEvent = predicate => earliest(
    facts.events.filter(predicate).map(at));
  const ticketCreated = facts.ticket && facts.ticket.created_at
    ? new Date(facts.ticket.created_at).getTime() : null;
  const firstReceipt = earliest(facts.receipts.map(receipt =>
    new Date(receipt.recorded_at).getTime()));
  const terminalTicketAt = earliestEvent(event =>
    event.type === 'ticket.updated' && event.run_id === null &&
    ['completed', 'failed', 'blocked'].includes(event.payload && event.payload.status));
  const planAdmittedAt = earliestEvent(event => String(event.type).includes('plan_admitted'));
  const firstBlockAt = earliestEvent(event => event.type === 'run.progress_blocked');

  // The frozen withheld-time contract is block -> NEXT authorized request.
  // A terminal parent transition is not a request and may legally precede a
  // later leaf's progress block when several structured leaves settle
  // independently. Using that parent transition as the endpoint manufactured
  // a negative duration for a valid product candidate. Both canonical request
  // authorities are included: provider.request.persisted owns Run requests,
  // while ticket.economic_request_started also covers the planning request.
  const nextAuthorizedRequestAt = Number.isFinite(firstBlockAt)
    ? earliestEvent(event =>
      ['provider.request.persisted', 'ticket.economic_request_started'].includes(event.type) &&
      Number.isFinite(at(event)) && at(event) >= firstBlockAt)
    : null;

  const delta = (from, to) => (Number.isFinite(from) && Number.isFinite(to) && to >= from
    ? to - from : null);
  return {
    planningMs: delta(ticketCreated, planAdmittedAt),
    timeToFirstExecutionMs: delta(ticketCreated, firstReceipt),
    endToEndMs: delta(ticketCreated, terminalTicketAt),
    recoveryMs: null,
    withheldMs: delta(firstBlockAt, nextAuthorizedRequestAt)
  };
}

// Canonical churn only. `null` — never zero — for arms with no churn control,
// so "this arm cannot be blocked" is never read as "this arm did not churn".
function deriveChurn(facts, arm) {
  if (!arm.expectedGoverned) return null;
  const persistedBlocks = facts.runs.map(run => run.progress_block).filter(Boolean);
  const blocks = persistedBlocks.length;
  const blockEvents = facts.events.filter(e => e.type === 'run.progress_blocked');
  if (persistedBlocks.some(block =>
    !Number.isSafeInteger(block.consecutiveNoProgressWindows) ||
    block.consecutiveNoProgressWindows < 0)) {
    throw new EvaluationReaderError(
      'a persisted governed progress block lacks its no-progress-window authority');
  }
  return {
    // A Run without a persisted stop has no durable non-progress streak. A
    // stopped Run carries the exact cutoff-bound count in its immutable block.
    // Zero is therefore an observed absence under complete durable state, not
    // a guess from provider behavior.
    noProgressStreak: persistedBlocks.reduce((maximum, block) =>
      Math.max(maximum, block.consecutiveNoProgressWindows), 0),
    progressBlocks: blocks,
    persistedProgressBlocks: blocks,
    blockEvents: blockEvents.length,
    // Reservations that were started and answered but whose window credited no
    // fact. Persistence interruptions and unanswered requests are excluded by
    // construction: an unanswered reservation has no response and a reservation
    // whose charge never committed was never delivered to execution.
    deliveredResponses: facts.charges.filter(c => c.state === 'committed').length,
    answeredReservations: facts.reservations.filter(r => r.settled).length,
    releasedReservations: facts.reservations.filter(r => r.state === 'released').length,
    wastedOperations: facts.receipts.filter(r => r.outcome !== 'succeeded').length
  };
}

function deriveObservedPath(facts) {
  // A durable structured PLANNING ATTEMPT counts. A trial blocked during
  // planning admits no plan and creates no Run, so counting only plans and Runs
  // would report it as the direct path — mislabelling a truthful structured
  // outcome as a different architecture.
  const planningAttempts = facts.events
    .filter(event => String(event.type).startsWith('ticket.structured_planning')).length;
  return {
    structuredPlanAdmitted:
      facts.runs.some(run => run.governed_leaf) || planningAttempts > 0,
    planningAttempts,
    plannerRequestCount: facts.reservations.filter(r => r.role === GOVERNED_PLANNER_ROLE).length,
    governedLeafRunCount: facts.runs.filter(run => run.governed_leaf).length,
    allocationPlanPresent: facts.plans.length > 0,
    runCount: facts.runs.length
  };
}

// Canonical request list for normalized pricing. Governed requests come from
// their immutable economic reservations; ungoverned requests come from the
// committed Run-budget charge authority that exists on those arms.
function deriveCanonicalRequests(facts, { provider, model, authorizedOutputTokens, boundInputTokens }) {
  if (!facts || !Array.isArray(facts.reservations) || !Array.isArray(facts.charges) ||
      !Array.isArray(facts.usageLogs)) {
    throw new EvaluationReaderError(
      'canonical request projection requires reservations, charges and usage logs');
  }
  const usageByRun = new Map();
  for (const row of facts.usageLogs) {
    if (!usageByRun.has(row.run_id)) usageByRun.set(row.run_id, []);
    usageByRun.get(row.run_id).push(row.usage);
  }
  // Governed requests have a stronger request authority than the generic Run
  // budget ledger: one immutable economic reservation captures the exact
  // request, provider/model/pricing authority, response and settlement usage.
  // Planner reservations are planning-attempt scoped and therefore have no
  // Run charge at all. Leaf reservations carry the SAME logical source
  // identity as their Run charge. Projecting governed reservations first and
  // suppressing only that exact matching charge includes planners while
  // preventing leaf requests from being counted twice.
  const governed = [];
  const governedIdentities = new Set();
  const governedChargeKeys = new Set();
  const expectedTicketId = facts.ticket && Number(facts.ticket.id);
  for (const reservation of facts.reservations) {
    if (Number.isSafeInteger(expectedTicketId) &&
        Number(reservation.ticket_id) !== expectedTicketId) {
      throw new EvaluationReaderError(
        `economic reservation ${reservation.id} belongs to another Ticket`);
    }
    if (reservation.state === 'released' || reservation.state === 'reserved') continue;
    if (!['request_started', 'response_persisted', 'settled'].includes(reservation.state)) {
      throw new EvaluationReaderError(
        `economic reservation ${reservation.id} has unsupported state ${reservation.state}`);
    }
    const planner = reservation.role === GOVERNED_PLANNER_ROLE;
    const worker = reservation.role === GOVERNED_WORKER_ROLE;
    if (!planner && !worker) {
      throw new EvaluationReaderError(
        `economic reservation ${reservation.id} has unsupported role ${reservation.role}`);
    }
    const identity = planner
      ? `planner:${reservation.ticket_id}:${reservation.planning_attempt_id}:` +
        `${reservation.model_request_ordinal}`
      : `worker:${reservation.run_id}:${reservation.logical_source_identity}`;
    if ((planner && (!reservation.planning_attempt_id || reservation.run_id !== null)) ||
        (worker && (!Number.isSafeInteger(Number(reservation.run_id)) ||
          !reservation.logical_source_identity))) {
      throw new EvaluationReaderError(
        `economic reservation ${reservation.id} has ambiguous subject identity`);
    }
    if (governedIdentities.has(identity)) {
      throw new EvaluationReaderError(`duplicate governed request identity ${identity}`);
    }
    governedIdentities.add(identity);
    if (worker) {
      governedChargeKeys.add(
        `${Number(reservation.run_id)}:${reservation.logical_source_identity}`);
    }
    const common = { role: planner ? 'planner' : 'worker', provider, model };
    // A started request with no complete settlement is still a provider-bearing
    // logical request. The frozen normalized-cost method prices it at the
    // CAPTURED authorized maximum; dropping it (or guessing zero) would erase
    // exactly the delivery-uncertainty product state the protocol retains.
    if (reservation.state !== 'settled') {
      const prepared = reservation.prepared_request;
      const authority = reservation.economic_authority;
      if (!prepared || !authority || authority.provider !== provider ||
          authority.dispatchTarget !== model ||
          !Number.isSafeInteger(prepared.authorizedOutputTokens) ||
          prepared.authorizedOutputTokens <= 0 ||
          !Number.isSafeInteger(authority.contextWindowTokens) ||
          authority.contextWindowTokens <= 0) {
        throw new EvaluationReaderError(
          `economic reservation ${reservation.id} lacks captured authorized-maximum authority`);
      }
      governed.push({ ...common,
        authorizedOutputTokens: prepared.authorizedOutputTokens,
        boundInputTokens: authority.contextWindowTokens });
      continue;
    }

    const receipt = reservation.settlement_receipt;
    if (!receipt || Number(receipt.ticketId) !== Number(reservation.ticket_id) ||
        receipt.role !== reservation.role || receipt.requestCount !== 1) {
      throw new EvaluationReaderError(
        `economic reservation ${reservation.id} settlement identity is inconsistent`);
    }
    if (receipt.usageSource === 'provider_reported') {
      if (!Number.isSafeInteger(receipt.inputTokens) || receipt.inputTokens < 0 ||
          !Number.isSafeInteger(receipt.outputTokens) || receipt.outputTokens < 0) {
        throw new EvaluationReaderError(
          `economic reservation ${reservation.id} has invalid metered settlement usage`);
      }
      governed.push({ ...common,
        inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens });
    } else if (receipt.usageSource === 'authorized_maximum_assumed') {
      const output = receipt.authorizedOutputTokens;
      const input = receipt.contextWindowTokens;
      if (!Number.isSafeInteger(output) || output < 0 ||
          !Number.isSafeInteger(input) || input < 0) {
        throw new EvaluationReaderError(
          `economic reservation ${reservation.id} has no usable authorized maximum`);
      }
      governed.push({ ...common,
        authorizedOutputTokens: output, boundInputTokens: input });
    } else {
      throw new EvaluationReaderError(
        `economic reservation ${reservation.id} has unrecognized usage authority`);
    }
  }

  const ungoverned = [];
  const chargeIdentities = new Set();
  for (const charge of facts.charges.filter(row => row.state === 'committed')) {
    const chargeKey = `${Number(charge.run_id)}:${charge.source_identity}`;
    if (chargeIdentities.has(chargeKey)) {
      throw new EvaluationReaderError(`duplicate model-request charge identity ${chargeKey}`);
    }
    chargeIdentities.add(chargeKey);
    if (governedChargeKeys.has(chargeKey)) continue;
      const pending = usageByRun.get(charge.run_id) || [];
      const usage = pending.shift() || null;
      const input = usage && Number.isFinite(Number(usage.input_tokens ?? usage.prompt_tokens))
        ? Number(usage.input_tokens ?? usage.prompt_tokens) : null;
      const output = usage && Number.isFinite(Number(usage.output_tokens ?? usage.completion_tokens))
        ? Number(usage.output_tokens ?? usage.completion_tokens) : null;
      ungoverned.push({
        role: 'worker',
        provider,
        model,
        ...(Number.isSafeInteger(input) && Number.isSafeInteger(output)
          ? { inputTokens: input, outputTokens: output }
          : { authorizedOutputTokens, boundInputTokens })
      });
  }
  return Object.freeze([...governed, ...ungoverned]);
}

function durableGovernedMicroUsd(facts, arm) {
  if (!arm.expectedGoverned) return null;
  return facts.reservations.reduce(
    (total, row) => total + Number(row.settled_micro_usd || 0), 0);
}

// The whole collection, per Ticket. Returns durable facts plus derivations; it
// never assembles the final trial record, because that also needs the
// independent oracle result, which this module is not allowed to compute.
async function collectTrialObservations(store, { ticketId, armId, pricingInputs }) {
  const arm = ARMS[armId];
  if (!arm) throw new EvaluationReaderError(`unknown arm ${armId}`);
  const facts = await collectTicketFacts(store, ticketId);
  const observedPath = deriveObservedPath(facts);
  // Refuses when the durable facts show a different production path than the
  // arm claims. An invalid trial must not become a data point.
  const path = assertObservedPathMatches(arm, observedPath);

  return {
    armId,
    ticketId,
    observedProductionPath: path,
    runIds: facts.runs.map(run => run.id),
    allocationPlanId: facts.plans.length > 0 ? facts.plans[0].id : null,
    allocationItemIds: facts.runs.map(run => run.allocation_item_id).filter(Boolean),
    plannerRequestCount: observedPath.plannerRequestCount,
    // A GOVERNED RESERVATION COUNT, and nothing more. The ungoverned arms hold
    // none, so this is not — and never was — a count of provider contacts. The
    // durable observation below is where that question is answered.
    workerRequestCount: facts.reservations
      .filter(r => r.role === GOVERNED_WORKER_ROLE).length,
    operationReceiptCount: facts.receipts.length,
    // THE PROJECTION THAT SURVIVES THE EPHEMERAL DATABASE. Derived entirely
    // from the durable events and records collected above; it decides nothing
    // and adds no authority of its own.
    durableObservation: projectLiveDurableObservation({
      events: facts.events,
      receipts: facts.receipts,
      reservations: facts.reservations,
      runs: facts.runs
    }),
    terminalRunStatuses: facts.runs.map(run => run.status),
    terminalTicketStatus: facts.ticket ? facts.ticket.status : null,
    ...deriveProductCompletionClaim(facts),
    latency: deriveLatency(facts),
    churn: deriveChurn(facts, arm),
    canonicalRequests: deriveCanonicalRequests(facts, pricingInputs),
    durableGovernedMicroUsd: durableGovernedMicroUsd(facts, arm),
    releasedReservations: facts.reservations.filter(r => r.state === 'released').length,
    ownershipAssignments: facts.runs.map(run => ({
      runId: run.id, allocationItemId: run.allocation_item_id
    }))
  };
}

// A durable-state fingerprint, used by the suite to prove the reader writes
// nothing. Counts every table the reader touches plus the events maximum.
async function durableFingerprint(store, ticketId) {
  const rows = await readOnly(store,
    `SELECT
       (SELECT count(*) FROM ${store.table('runs')} WHERE ticket_id = $1)::int AS runs,
       (SELECT COALESCE(sum(revision), 0) FROM ${store.table('runs')} WHERE ticket_id = $1)::bigint AS run_revisions,
       (SELECT count(*) FROM ${store.table('events')} WHERE ticket_id = $1)::int AS events,
       (SELECT count(*) FROM ${store.table('operation_receipts')} WHERE ticket_id = $1)::int AS receipts,
       (SELECT count(*) FROM ${store.table('economic_request_reservations')} WHERE ticket_id = $1)::int AS reservations,
       (SELECT count(*) FROM ${store.table('run_consequences')} AS c
          JOIN ${store.table('runs')} AS r ON r.id = c.run_id WHERE r.ticket_id = $1)::int AS consequences,
       (SELECT count(*) FROM ${store.table('diagnostic_logs')} WHERE ticket_id = $1)::int AS logs`,
    [ticketId]);
  return rows[0];
}

module.exports = {
  EvaluationReaderError,
  assertSelectOnly,
  collectTicketFacts,
  collectTrialObservations,
  deriveProductCompletionClaim,
  deriveLatency,
  deriveChurn,
  deriveObservedPath,
  deriveCanonicalRequests,
  durableFingerprint
};

if (require.main === module) {
  console.error('This module is a read-only evaluation reader; it is invoked by ' +
    'the evaluation harness rather than run directly.');
  process.exit(2);
}
