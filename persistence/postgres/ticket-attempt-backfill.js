'use strict';

const {
  assertLeafBindingSetComplete,
  evaluateRunCompletionEvidence,
  normalizeAggregatePlanDecision,
  normalizeLeafRunBinding
} = require('../../runtime/structured-allocation-leaf-run-contract');
const {
  normalizeCompletionDecision
} = require('../../runtime/completion-decision-contract');
const {
  deriveTicketAttemptDisposition
} = require('../../runtime/ticket-attempt-contract');
const {
  allocationPlanFromRow
} = require('./application-state-methods');

class TicketAttemptBackfillError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'TicketAttemptBackfillError';
    this.code = code;
    this.detail = detail;
  }
}

function refuse(code, message, detail = {}) {
  throw new TicketAttemptBackfillError(code, message, detail);
}

function positiveInteger(value, label) {
  const number = typeof value === 'string' && /^[1-9]\d*$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(number) || number <= 0) {
    refuse('TICKET_ATTEMPT_BACKFILL_INVALID_ID', `${label} must be a positive safe integer`);
  }
  return number;
}

function tableName(store, name) {
  return store.table(name);
}

function planIdFromRun(run) {
  const value = run.body && run.body.allocationPlanId;
  if (value === null || value === undefined || String(value).trim() === '') return null;
  return positiveInteger(value, `run ${run.id} allocationPlanId`);
}

function completionAuthorityHash(run) {
  const authority = run.body && run.body.completionAuthoritySnapshot;
  return authority && authority.objectiveContract
    ? authority.objectiveContract.objectiveContractHash || null
    : authority && authority.objectiveContractHash
      ? authority.objectiveContractHash
      : null;
}

function terminalMemberDisposition(run, consequence) {
  if (!['completed', 'failed', 'interrupted'].includes(run.status)) return null;
  const authority = run.body && run.body.completionAuthoritySnapshot;
  if (!authority) {
    return run.status === 'completed' ? 'completed'
      : run.status === 'interrupted' ? 'interrupted'
        : 'failed';
  }
  if (!consequence || !consequence.completionDecision) {
    refuse(
      'TICKET_ATTEMPT_BACKFILL_COMPLETION_EVIDENCE_MISSING',
      `terminal Run ${run.id} has completion authority but no durable completion decision`,
      { runId: run.id, ticketId: run.ticketId }
    );
  }
  let decision;
  try {
    decision = normalizeCompletionDecision(consequence.completionDecision);
  } catch (error) {
    refuse(
      'TICKET_ATTEMPT_BACKFILL_COMPLETION_EVIDENCE_INVALID',
      `terminal Run ${run.id} has an invalid completion decision: ${error.message}`,
      { runId: run.id, ticketId: run.ticketId }
    );
  }
  const evidence = evaluateRunCompletionEvidence({
    runStatus: run.status,
    runId: run.id,
    runTicketId: run.ticketId,
    runCompletionAuthorityHash: completionAuthorityHash(run),
    decision
  });
  if (evidence.result === 'not_applicable') {
    return run.status === 'interrupted' ? 'interrupted' : 'failed';
  }
  if (evidence.result !== 'valid') {
    refuse(
      'TICKET_ATTEMPT_BACKFILL_COMPLETION_EVIDENCE_INVALID',
      `terminal Run ${run.id} cannot establish completion: ${evidence.reason}`,
      { runId: run.id, ticketId: run.ticketId, result: evidence.result }
    );
  }
  if (decision.completionDisposition === 'completed') return 'completed';
  if (decision.completionDisposition === 'blocked') return 'blocked';
  return run.status === 'interrupted' ? 'interrupted' : 'failed';
}

function timestampMillis(value, label) {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) refuse('TICKET_ATTEMPT_BACKFILL_INVALID_TIME', `${label} is invalid`);
  return millis;
}

async function inspectTicketAttemptBackfill(store, { client = store.pool } = {}) {
  // Keep one read-only transaction and one query in flight at a time. The
  // preflight deliberately uses one connection so every classification sees
  // the same snapshot.
  const runRows = await client.query(
      `SELECT id, ticket_id, status, execution_mode, body,
              created_at::text, completed_at::text
       FROM ${tableName(store, 'runs')} ORDER BY ticket_id, id`
    );
  const planRows = await client.query(
    `SELECT * FROM ${tableName(store, 'allocation_plans')} ORDER BY id`
  );
  const consequenceRows = await client.query(
    `SELECT run_id, consequence FROM ${tableName(store, 'run_consequences')}`
  );
  const replayRows = await client.query(
    `SELECT run_id, finalized_at::text FROM ${tableName(store, 'replay_snapshots')}`
  );
  const terminalEventRows = await client.query(
      `SELECT DISTINCT run_id FROM ${tableName(store, 'events')}
       WHERE run_id IS NOT NULL AND type = 'run.terminalized'`
    );

  const plans = new Map();
  for (const row of planRows.rows) {
    let plan;
    try {
      plan = allocationPlanFromRow(row);
    } catch (error) {
      refuse(
        'TICKET_ATTEMPT_BACKFILL_PLAN_INVALID',
        `allocation plan ${row.id} is invalid: ${error.message}`,
        { allocationPlanId: Number(row.id) }
      );
    }
    plans.set(plan.id, plan);
  }
  const consequenceByRun = new Map(consequenceRows.rows.map(row => [
    positiveInteger(row.run_id, 'run consequence runId'),
    row.consequence
  ]));
  const finalizedReplay = new Set(replayRows.rows
    .filter(row => row.finalized_at !== null)
    .map(row => positiveInteger(row.run_id, 'replay runId')));
  const terminalEvents = new Set(terminalEventRows.rows.map(row =>
    positiveInteger(row.run_id, 'terminal event runId')));

  const runs = runRows.rows.map(row => ({
    id: positiveInteger(row.id, 'run.id'),
    ticketId: positiveInteger(row.ticket_id, 'run.ticketId'),
    status: row.status,
    executionMode: row.execution_mode,
    body: row.body || {},
    createdAt: row.created_at,
    completedAt: row.completed_at
  }));
  const groups = new Map();
  const nonPlanBatchKeys = new Map();
  for (const run of runs) {
    const planId = planIdFromRun(run);
    let classification = 'singleton_non_plan';
    let key = `run:${run.id}`;
    let plan = null;
    if (planId !== null) {
      plan = plans.get(planId) || null;
      if (!plan) {
        refuse(
          'TICKET_ATTEMPT_BACKFILL_PLAN_MISSING',
          `Run ${run.id} references missing allocation plan ${planId}`,
          { runId: run.id, ticketId: run.ticketId, allocationPlanId: planId }
        );
      }
      if (plan.ticketId !== run.ticketId) {
        refuse(
          'TICKET_ATTEMPT_BACKFILL_CROSS_TICKET_PLAN',
          `Run ${run.id} and allocation plan ${planId} belong to different Tickets`,
          { runId: run.id, ticketId: run.ticketId, allocationPlanId: planId, planTicketId: plan.ticketId }
        );
      }
      classification = plan.version === 2 ? 'historical_v2_leaf_set' : 'v1_plan';
      key = `plan:${planId}`;
    } else {
      const openedAt = run.body.ticketOpenedAt;
      if (openedAt !== null && openedAt !== undefined && String(openedAt).trim()) {
        const batchKey = `${run.ticketId}:${String(openedAt)}`;
        const members = nonPlanBatchKeys.get(batchKey) || [];
        members.push(run.id);
        nonPlanBatchKeys.set(batchKey, members);
      }
    }
    const group = groups.get(key) || {
      key,
      ticketId: run.ticketId,
      planId,
      plan,
      classification,
      runs: []
    };
    if (group.ticketId !== run.ticketId) {
      refuse('TICKET_ATTEMPT_BACKFILL_CROSS_TICKET_MEMBERSHIP', `${key} spans Tickets`);
    }
    group.runs.push(run);
    groups.set(key, group);
  }

  for (const [batchKey, memberIds] of nonPlanBatchKeys) {
    if (memberIds.length > 1) {
      refuse(
        'TICKET_ATTEMPT_BACKFILL_NON_PLAN_WAVE_AMBIGUOUS',
        `non-plan batch ${batchKey} contains ${memberIds.length} Runs and has no authoritative membership identity`,
        { runIds: memberIds }
      );
    }
  }

  for (const group of groups.values()) {
    if (group.planId === null) continue;
    const opened = new Set(group.runs.map(run => run.body.ticketOpenedAt || null));
    if (opened.has(null) || opened.size !== 1) {
      refuse(
        'TICKET_ATTEMPT_BACKFILL_PLAN_REUSED',
        `allocation plan ${group.planId} does not identify exactly one admission wave`,
        { allocationPlanId: group.planId, runIds: group.runs.map(run => run.id) }
      );
    }
    if (group.classification !== 'historical_v2_leaf_set') continue;
    const plan = group.plan;
    if (!plan.planningProvenance) {
      refuse(
        'TICKET_ATTEMPT_BACKFILL_V2_PROVENANCE_MISSING',
        `Allocation Plan v2 ${plan.id} has Runs but no planning provenance`
      );
    }
    const bindings = [];
    const declaredWorkHashByItemId = new Map();
    for (const run of group.runs) {
      if (!run.body.leafRunBinding) {
        refuse(
          'TICKET_ATTEMPT_BACKFILL_V2_BINDING_MISSING',
          `Run ${run.id} has no v2 leaf binding`,
          { runId: run.id, allocationPlanId: plan.id }
        );
      }
      let binding;
      try {
        binding = normalizeLeafRunBinding(run.body.leafRunBinding, {
          expectedRunId: run.id,
          expectedPlanId: plan.id,
          expectedPlanHash: plan.planHash
        });
      } catch (error) {
        refuse(
          'TICKET_ATTEMPT_BACKFILL_V2_BINDING_INVALID',
          `Run ${run.id} has an invalid v2 leaf binding: ${error.message}`,
          { runId: run.id, allocationPlanId: plan.id }
        );
      }
      bindings.push(binding);
      declaredWorkHashByItemId.set(
        binding.allocationItemId,
        run.body.declaredWorkSnapshot ? run.body.declaredWorkSnapshot.contractHash : null
      );
    }
    try {
      assertLeafBindingSetComplete(bindings, plan, { declaredWorkHashByItemId });
    } catch (error) {
      refuse(
        'TICKET_ATTEMPT_BACKFILL_V2_MEMBERSHIP_INVALID',
        `Allocation Plan v2 ${plan.id} leaf membership is incomplete or contradictory: ${error.message}`,
        { allocationPlanId: plan.id }
      );
    }
  }

  const attempts = [];
  for (const group of groups.values()) {
    const allTerminal = group.runs.every(run =>
      ['completed', 'failed', 'interrupted'].includes(run.status));
    let disposition = null;
    let settledAt = null;
    if (allTerminal) {
      for (const run of group.runs) {
        if (!finalizedReplay.has(run.id) || !terminalEvents.has(run.id)) {
          refuse(
            'TICKET_ATTEMPT_BACKFILL_TERMINAL_EVIDENCE_MISSING',
            `terminal Run ${run.id} lacks finalized replay or run.terminalized evidence`,
            { runId: run.id, ticketId: run.ticketId }
          );
        }
      }
      const memberDispositions = group.runs.map(run =>
        terminalMemberDisposition(run, consequenceByRun.get(run.id) || null));
      disposition = deriveTicketAttemptDisposition(memberDispositions);
      settledAt = group.runs
        .map(run => run.completedAt)
        .sort((left, right) => timestampMillis(left, 'run.completedAt') - timestampMillis(right, 'run.completedAt'))
        .at(-1);
      if (group.classification === 'historical_v2_leaf_set') {
        if (!group.plan.aggregateDecision) {
          refuse(
            'TICKET_ATTEMPT_BACKFILL_V2_AGGREGATE_MISSING',
            `settled Allocation Plan v2 ${group.plan.id} has no aggregate decision`
          );
        }
        let aggregate;
        try {
          aggregate = normalizeAggregatePlanDecision(group.plan.aggregateDecision, {
            expectedPlanHash: group.plan.planHash,
            expectedPlanId: group.plan.id
          });
        } catch (error) {
          refuse(
            'TICKET_ATTEMPT_BACKFILL_V2_AGGREGATE_INVALID',
            `Allocation Plan v2 ${group.plan.id} aggregate decision is invalid: ${error.message}`
          );
        }
        const expectedAggregate = disposition === 'completed' ? 'completed'
          : disposition === 'interrupted' ? 'interrupted'
            : 'failed';
        if (aggregate.aggregateStatus !== expectedAggregate) {
          refuse(
            'TICKET_ATTEMPT_BACKFILL_V2_AGGREGATE_CONFLICT',
            `Allocation Plan v2 ${group.plan.id} aggregate ${aggregate.aggregateStatus} conflicts with attempt ${disposition}`
          );
        }
      }
    }
    const admittedAt = group.runs
      .map(run => run.createdAt)
      .sort((left, right) => timestampMillis(left, 'run.createdAt') - timestampMillis(right, 'run.createdAt'))[0];
    attempts.push({
      key: group.key,
      ticketId: group.ticketId,
      classification: group.classification,
      memberRunIds: group.runs.map(run => run.id).sort((left, right) => left - right),
      memberCount: group.runs.length,
      admittedAt,
      disposition,
      settledAt
    });
  }

  attempts.sort((left, right) =>
    left.ticketId - right.ticketId ||
    timestampMillis(left.admittedAt, 'attempt.admittedAt') - timestampMillis(right.admittedAt, 'attempt.admittedAt') ||
    left.memberRunIds[0] - right.memberRunIds[0]);
  const ordinalByTicket = new Map();
  for (const attempt of attempts) {
    const ordinal = (ordinalByTicket.get(attempt.ticketId) || 0) + 1;
    ordinalByTicket.set(attempt.ticketId, ordinal);
    attempt.ordinal = ordinal;
  }
  const unsettledByTicket = new Map();
  for (const attempt of attempts.filter(value => value.disposition === null)) {
    const existing = unsettledByTicket.get(attempt.ticketId);
    if (existing) {
      refuse(
        'TICKET_ATTEMPT_BACKFILL_OVERLAPPING_UNSETTLED',
        `Ticket ${attempt.ticketId} has more than one unsettled historical attempt`,
        { attemptKeys: [existing.key, attempt.key] }
      );
    }
    unsettledByTicket.set(attempt.ticketId, attempt);
  }
  const mappedRunIds = attempts.flatMap(attempt => attempt.memberRunIds);
  if (mappedRunIds.length !== runs.length || new Set(mappedRunIds).size !== runs.length) {
    refuse(
      'TICKET_ATTEMPT_BACKFILL_MAPPING_INCOMPLETE',
      'Every historical Run must map to exactly one Ticket attempt'
    );
  }
  const legacyAttemptCount = new Set(runs.map(run => {
    const planId = planIdFromRun(run);
    return `${run.ticketId}:${planId === null ? `run:${run.id}` : `plan:${planId}`}`;
  })).size;
  if (legacyAttemptCount !== attempts.length) {
    refuse(
      'TICKET_ATTEMPT_BACKFILL_COUNT_DRIFT',
      `legacy attempt count ${legacyAttemptCount} does not equal projected count ${attempts.length}`
    );
  }
  const classifications = Object.fromEntries([
    'singleton_non_plan',
    'v1_plan',
    'historical_v2_leaf_set'
  ].map(kind => [kind, attempts.filter(attempt => attempt.classification === kind).length]));
  return Object.freeze({
    runCount: runs.length,
    attemptCount: attempts.length,
    legacyAttemptCount,
    classifications: Object.freeze(classifications),
    attempts: Object.freeze(attempts.map(attempt => Object.freeze({ ...attempt })))
  });
}

module.exports = {
  TicketAttemptBackfillError,
  inspectTicketAttemptBackfill
};
