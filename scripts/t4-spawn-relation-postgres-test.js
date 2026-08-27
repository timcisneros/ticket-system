#!/usr/bin/env node
'use strict';

// T4 — workflow-spawn relationship kernel: PostgreSQL owner.
//
// Exercises the frozen kernel against real disposable PostgreSQL
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, "T4 Workflow-Spawn Relationship
// Kernel — semantic freeze", T4-I1..T4-I8):
//   - read-only persistence evidence: complete per-child creation-provenance
//     retrieval and parent-side candidate discovery over IMMUTABLE event
//     payloads (no writer, no table, no migration, no new authority);
//   - resolution through the canonical pure seam using REAL production
//     producer bytes: every coherent child below is constructed by the
//     production-owned runtime/workflow-ticket-spawn-construction.js seam
//     (the SAME definition createChildWorkflowTicketFromPlan uses) and
//     persisted through the existing createTicketWithEvent writer (M2);
//   - negative non-authority: Ticket-body drift can neither grant, deny nor
//     change relationship truth while predecessor readers stay intact
//     (T4-I2);
//   - bounded fail-closed corruption classes on real rows: malformed,
//     multiple applicable, referenced parent nonexistent (T4-I4);
//   - explicit enumeration COMPLETE / INCOMPLETE composition (T4-I5) and
//     fail-closed oversize refusal instead of silent truncation (T4-I3);
//   - frozen predecessor isolation: idempotent spawn replay stays one
//     record and the frozen T2 admissionHold composer path behaves exactly
//     as before beside the new reader surface (T4-I6/I8).

const assert = require('node:assert/strict');
const { withHarness } = require('./postgres-test-harness');
const {
  resolveChildSpawnRelation,
  coherentProvenanceParentIds,
  combineSpawnEnumeration,
  REFUSAL_REASONS,
  ENUMERATION_STATES,
  RELATIONSHIP_KIND
} = require('../runtime/t4-spawn-relation-contract');
// PRODUCTION-OWNED construction seam: the exact draft/eventPayload bytes the
// sanctioned producer writes. The test owns NO duplicate event-shape copy.
const { buildChildWorkflowTicketCreation } = require('../runtime/workflow-ticket-spawn-construction');

// N1: the builder receives the ALREADY-RESOLVED execution policy as input.
// This local object is FIXTURE DATA ONLY — sufficient for persistence and the
// scenario. It is not a canonical default, not imported by production, not a
// parity definition, and carries no T4 relationship authority (the
// authoritative eventPayload gains no execution-policy authority). Its values
// deliberately differ from every canonical default so the pass-through
// assertion below proves the builder stamps the caller-supplied policy
// instead of inventing or replacing it.
const FIXTURE_SPAWN_EXECUTION_POLICY = Object.freeze({
  mode: 'assisted',
  requireVerification: 'when_declared',
  autoRetry: true,
  maxAttempts: 3,
  allowWorkspaceWrites: true,
  allowParallelRuns: false,
  allowChildTickets: false,
  workspaceScope: 'shared'
});

let assertions = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  assertions += 1;
  console.log(`  ok ${message}`);
}
async function rejectsError(promiseFactory, predicate, message) {
  await assert.rejects(async () => { await promiseFactory(); }, predicate, message);
  assertions += 1;
  console.log(`  ok ${message}`);
}

// The exact evidence assembly the server page performs, here asserted against
// REAL store rows. Candidate discovery and provenance retrieval are read-only;
// all interpretation lives in the canonical seam.
async function enumerateChildren(store, parentTicketId) {
  const candidateIds = await store.findSpawnCandidateChildTickets({ parentTicketId });
  const provenanceByChild = [];
  for (const childTicketId of candidateIds) {
    provenanceByChild.push({
      childTicketId,
      records: await store.listChildCreationProvenance(childTicketId)
    });
  }
  const referencedParentIds = new Set([parentTicketId]);
  for (const { records } of provenanceByChild) {
    for (const id of coherentProvenanceParentIds(records)) referencedParentIds.add(id);
  }
  const existingParents = new Set((await store.listTicketsByIds({
    ticketIds: [...referencedParentIds]
  })).map(row => row.id));
  const resolutions = provenanceByChild.map(({ childTicketId, records }) =>
    resolveChildSpawnRelation({
      childTicketId,
      records,
      existingParentTicketIds: existingParents
    }));
  return combineSpawnEnumeration({ parentTicketId, resolutions });
}

async function readChildRelation(store, ticketRow) {
  const records = await store.listChildCreationProvenance(ticketRow.id);
  const referencedParentIds = coherentProvenanceParentIds(records);
  const existingParents = new Set(referencedParentIds.length
    ? (await store.listTicketsByIds({ ticketIds: referencedParentIds })).map(row => row.id)
    : []);
  return resolveChildSpawnRelation({
    childTicketId: ticketRow.id,
    records,
    existingParentTicketIds: existingParents
  });
}

// Persist one child through the PRODUCTION constructor bytes and the existing
// writer. Nothing here hand-builds a draft or event payload: the ONLY shape
// definition in this repository is buildChildWorkflowTicketCreation, shared
// with server.js's createChildWorkflowTicketFromPlan (M2).
async function spawnViaProductionConstructor(
  store,
  { run, workflow, step, planTicket, spawnPlanId, executionPolicy = FIXTURE_SPAWN_EXECUTION_POLICY }
) {
  const { ticketDraft, eventPayload } = buildChildWorkflowTicketCreation({
    run, workflow, step, planTicket, spawnPlanId,
    // N1: policy is caller-supplied fixture input; the builder owns no default.
    executionPolicy
  });
  const created = await store.createTicketWithEvent({
    ticket: ticketDraft,
    eventPayload
  });
  return created;
}

async function insertRawCreatedEvent(store, schema, ticketId, payload) {
  // Corruption seeding only: the append-only chain accepts NEW positions and
  // never lets history be rewritten, exactly like runtime appends. These
  // payloads are deliberately malformed/incoherent and never substitute for
  // the production constructor above.
  const result = await store.pool.query(
    `INSERT INTO "${schema}".events
       (id, schema_version, ts, type, ticket_id, payload)
     VALUES (gen_random_uuid(), 1, clock_timestamp(), 'ticket.created', $1, $2::jsonb)
     RETURNING id, position`,
    [ticketId, JSON.stringify(payload)]);
  return { id: String(result.rows[0].id), position: Number(result.rows[0].position) };
}

async function main() {
  await withHarness('t4 spawn relation', async ({ store, schema }) => {
    const agent = (await store.createConfiguredAgent({
      value: { name: 'T4 Agent', provider: 'openai', model: 'fixture', apiKey: '' },
      changedBy: 't4'
    })).agent;

    // Parent workflow catalog row: the production draft stamps
    // executionMode 'workflow' + workflowId, which the existing writer
    // validates against this durable catalog.
    const workflow = (await store.createWorkflow({
      value: { id: 't4-parent-workflow', name: 'T4 parent workflow' },
      changedBy: 't4'
    })).workflow;

    const makePlainTicket = async objective => (await store.createTicketWithEvent({
      ticket: {
        objective, status: 'open',
        assignmentTargetType: 'agent', assignmentTargetId: agent.id,
        assignmentMode: 'individual', executionMode: 'agent'
      },
      eventPayload: { objective }
    })).ticket;

    console.log('provenance reads over real created events');

    const parent = await makePlainTicket('t4 parent');
    ok(Number.isSafeInteger(parent.id) && parent.id > 0, 'fixture: parent ticket exists');
    ok((await readChildRelation(store, parent)).outcome === 'ABSENT',
      'a plain ticket resolves truthful relationship ABSENT (clean absence)');
    let enumeration = await enumerateChildren(store, parent.id);
    ok(enumeration.state === ENUMERATION_STATES.COMPLETE &&
       enumeration.facts.length === 0 && enumeration.candidateCount === 0,
      'a parent without candidates enumerates COMPLETE and empty');

    // Two children produced by the real production constructor, covering both
    // durable spawnPlanId shapes (composite string and legacy integer).
    const childAInsert = await spawnViaProductionConstructor(store, {
      run: { id: 90001, ticketId: parent.id, agentId: agent.id },
      workflow, step: { id: 'plan-step' },
      planTicket: {
        objective: 't4 child A',
        workflowId: workflow.id,
        workflowInput: { vendor: 'alpha' },
        reason: null,
        idempotencyKey: 't4-key-a'
      },
      spawnPlanId: '90001:t4-parent-workflow:plan-step:transition:0'
    });
    const childBInsert = await spawnViaProductionConstructor(store, {
      run: { id: 90002, ticketId: parent.id, agentId: agent.id },
      workflow, step: { id: 'plan-step' },
      planTicket: {
        objective: 't4 child B',
        workflowId: workflow.id,
        workflowInput: { vendor: 'beta' },
        reason: null,
        idempotencyKey: 't4-key-b'
      },
      spawnPlanId: 7
    });
    assert.ok(childAInsert.created === true && childBInsert.created === true,
      'fixture: both producer children inserted fresh');
    const childA = childAInsert.ticket;
    const childB = childBInsert.ticket;
    ok(childA.executionMode === 'workflow' && childB.status === 'blocked',
      'constructor bytes reached storage untouched (producer parity surface)');

    enumeration = await enumerateChildren(store, parent.id);
    ok(enumeration.state === ENUMERATION_STATES.COMPLETE,
      'two production-produced spawn children enumerate COMPLETE');
    const expectedOrder = [childA.id, childB.id].sort((x, y) => x - y);
    ok(JSON.stringify(enumeration.facts.map(fact => fact.childTicketId)) ===
       JSON.stringify(expectedOrder),
      'discovery found every proven child from immutable payloads');
    ok(enumeration.facts.every(fact => fact.parentTicketId === parent.id &&
       fact.kind === RELATIONSHIP_KIND),
      'every fact binds the requested parent and the workflow-spawn kind');

    const rawChildB = (await store.pool.query(
      `SELECT id, position FROM "${schema}".events
        WHERE ticket_id = $1 AND type = 'ticket.created' ORDER BY position`,
      [childB.id])).rows[0];
    const factB = enumeration.facts.find(fact => fact.childTicketId === childB.id);
    ok(factB.originEvent.position === Number(rawChildB.position) &&
       factB.originEvent.id === String(rawChildB.id),
      'derived identity equals the ORIGINATING event row id/position (T4-I7)');

    console.log('negative body non-authority (T4-I2)');

    // Drift 1: strip the body claims from a child. Authoritative membership
    // must not move: the body was display/prose; only events are authority.
    await store.pool.query(
      `UPDATE "${schema}".tickets
          SET body = body - 'parentTicketId' - 'spawnIdempotencyKey' - 'spawnPlanId',
              revision = revision + 1
        WHERE id = $1`, [childB.id]);
    enumeration = await enumerateChildren(store, parent.id);
    ok(enumeration.state === ENUMERATION_STATES.COMPLETE &&
       enumeration.facts.some(fact => fact.childTicketId === childB.id),
      'body removal neither denies nor alters the proven relationship');

    // Drift 2: forge a body linkage on an unrelated ticket: grants nothing.
    const forged = await makePlainTicket('t4 forged body');
    await store.pool.query(
      `UPDATE "${schema}".tickets
          SET body = jsonb_set(body, '{parentTicketId}', to_jsonb($1::bigint)),
              revision = revision + 1
        WHERE id = $2`, [parent.id, forged.id]);
    enumeration = await enumerateChildren(store, parent.id);
    ok(!enumeration.facts.some(fact => fact.childTicketId === forged.id),
      'a forged body linkage grants no relationship truth');
    ok((await readChildRelation(store, forged)).outcome === 'ABSENT',
      'the child-side read ignores body topology entirely (T4-I1/I2)');

    console.log('fail-closed corruption classes on real rows (T4-I4)');

    // Malformed provenance attributed to this parent.
    const childMalformedInsert = await spawnViaProductionConstructor(store, {
      run: { id: 90003, ticketId: parent.id, agentId: agent.id },
      workflow, step: { id: 'plan-step' },
      planTicket: {
        objective: 't4 child malformed-seed',
        workflowId: workflow.id,
        workflowInput: {},
        reason: null,
        idempotencyKey: 't4-key-c'
      },
      spawnPlanId: '90003:t4-parent-workflow:plan-step:transition:0'
    });
    const childMalformed = childMalformedInsert.ticket;
    await insertRawCreatedEvent(store, schema, childMalformed.id, {
      parentTicketId: parent.id, spawnPlanId: '   ', spawnIdempotencyKey: ''
    });
    const childReadMalformed = await readChildRelation(store, childMalformed);
    ok(childReadMalformed.outcome === 'REFUSED' &&
       childReadMalformed.reason === REFUSAL_REASONS.MALFORMED_SPAWN_PROVENANCE,
      'malformed provenance refuses the child-specific required-truth read');
    enumeration = await enumerateChildren(store, parent.id);
    ok(enumeration.state === ENUMERATION_STATES.INCOMPLETE,
      'an attributable malformed candidate makes the enumeration INCOMPLETE');
    ok(JSON.stringify(enumeration.refused) === JSON.stringify([
      { childTicketId: childMalformed.id, reason: REFUSAL_REASONS.MALFORMED_SPAWN_PROVENANCE }
    ]), 'the INCOMPLETE result types the refused child identity with its reason');
    ok(enumeration.facts.length === 2,
      'INCOMPLETE still carries both proven facts alongside the refusals');

    // Multiple applicable bindings on one child.
    const childMultipleInsert = await spawnViaProductionConstructor(store, {
      run: { id: 90004, ticketId: parent.id, agentId: agent.id },
      workflow, step: { id: 'plan-step' },
      planTicket: {
        objective: 't4 child multi-seed',
        workflowId: workflow.id,
        workflowInput: {},
        reason: null,
        idempotencyKey: 't4-key-d'
      },
      spawnPlanId: '90004:t4-parent-workflow:plan-step:transition:0'
    });
    const childMultiple = childMultipleInsert.ticket;
    await insertRawCreatedEvent(store, schema, childMultiple.id, {
      parentTicketId: parent.id,
      spawnPlanId: 'other-plan',
      spawnIdempotencyKey: 'second-binding'
    });
    const childReadMultiple = await readChildRelation(store, childMultiple);
    ok(childReadMultiple.outcome === 'REFUSED' &&
       childReadMultiple.reason === REFUSAL_REASONS.MULTIPLE_APPLICABLE_PROVENANCE,
      'multiple applicable bindings refuse — refusal-not-choice');
    enumeration = await enumerateChildren(store, parent.id);
    ok(enumeration.refused.some(entry =>
        entry.childTicketId === childMultiple.id &&
        entry.reason === REFUSAL_REASONS.MULTIPLE_APPLICABLE_PROVENANCE),
      'multiplicity surfaces as a typed refusal in the enumeration');

    // Referenced parent identity that never existed: a plain child gains one
    // additional coherent created event naming GHOST_PARENT_ID.
    const plainVictim = await makePlainTicket('t4 plain victim');
    const ghostParentId = 987654321;
    await insertRawCreatedEvent(store, schema, plainVictim.id, {
      parentTicketId: ghostParentId,
      spawnPlanId: 'ghost-plan',
      spawnIdempotencyKey: 'ghost-binding'
    });
    const ghostRead = await readChildRelation(store, plainVictim);
    ok(ghostRead.outcome === 'REFUSED' &&
       ghostRead.reason === REFUSAL_REASONS.PARENT_TICKET_NOT_FOUND,
      'coherent reference to a nonexistent parent refuses PARENT_TICKET_NOT_FOUND');
    const ghostEnumeration = await enumerateChildren(store, ghostParentId);
    ok(ghostEnumeration.state === ENUMERATION_STATES.INCOMPLETE &&
       JSON.stringify(ghostEnumeration.refused) === JSON.stringify([
         { childTicketId: plainVictim.id, reason: REFUSAL_REASONS.PARENT_TICKET_NOT_FOUND }
       ]),
      'the ghost-parent enumeration is typed INCOMPLETE with the orphaned candidate');
    enumeration = await enumerateChildren(store, parent.id);
    ok(!enumeration.refused.some(entry => entry.childTicketId === plainVictim.id),
      'corruption follows evidence: unrelated parents stay untouched');

    console.log('completeness refuses truncation instead of paging (T4-I3/T4-I5)');

    const cappedStore = new (store.constructor)({
      connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL,
      schema,
      maxQueryRows: 1
    });
    try {
      await rejectsError(
        () => cappedStore.listChildCreationProvenance(childMultiple.id),
        error => error instanceof RangeError,
        'an oversized provenance set FAILS CLOSED rather than offering a subset');
      await rejectsError(
        () => cappedStore.findSpawnCandidateChildTickets({ parentTicketId: parent.id }),
        error => error instanceof RangeError,
        'candidate discovery also fails closed on oversize rather than silently paging');
    } finally {
      await cappedStore.close();
    }

    console.log('method input validation');

    await rejectsError(
      () => store.findSpawnCandidateChildTickets({ parentTicketId: 0 }),
      error => /positive safe integer/.test(error.message),
      'candidate discovery validates the parent id');
    await rejectsError(
      () => store.listChildCreationProvenance('x'),
      error => error instanceof TypeError,
      'provenance retrieval validates the child id');
    await rejectsError(
      () => store.listTicketsByIds({ ticketIds: 'nope' }),
      error => error instanceof TypeError,
      'listTicketsByIds validates input shape');
    await rejectsError(
      () => store.listTicketsByIds({ ticketIds: [0] }),
      error => /positive safe integer/.test(error.message),
      'listTicketsByIds validates each id');

    console.log('M2 — producer-bound scenario: sanctioned producer bytes end-to-end');

    // One dedicated parent + ONE child produced exclusively through the
    // production-owned construction seam and the existing writer.
    const m2Parent = await makePlainTicket('t4 m2 parent');
    const m2Workflow = (await store.createWorkflow({
      value: { id: 't4-m2-workflow', name: 'T4 M2 workflow' },
      changedBy: 't4'
    })).workflow;
    const m2RunId = 90909;
    const m2SpawnPlanId = `${m2RunId}:${m2Workflow.id}:step-m2:transition:0`;
    const m2Insert = await spawnViaProductionConstructor(store, {
      run: { id: m2RunId, ticketId: m2Parent.id, agentId: agent.id },
      workflow: m2Workflow,
      step: { id: 'step-m2' },
      planTicket: {
        objective: 't4 m2 child',
        workflowId: m2Workflow.id,
        workflowInput: { vendor: 'gamma' },
        reason: 'customer follow-up',
        idempotencyKey: 't4-m2-idem'
      },
      spawnPlanId: m2SpawnPlanId
    });

    // 1. Exactly one real child was produced.
    ok(m2Insert.created === true && Number.isSafeInteger(m2Insert.ticket.id),
      'M2: exactly one real child was produced');
    const m2ChildRows = (await store.pool.query(
      `SELECT id FROM "${schema}".tickets WHERE body->>'spawnIdempotencyKey' = 't4-m2-idem'`
    )).rows;
    ok(m2ChildRows.length === 1 && Number(m2ChildRows[0].id) === m2Insert.ticket.id,
      'M2: the idempotency key maps to exactly one persisted child');

    // 2. Its ACTUAL persisted event row is retrieved.
    const m2EventRows = (await store.pool.query(
      `SELECT id, position, type, payload FROM "${schema}".events
        WHERE ticket_id = $1 AND type = 'ticket.created' ORDER BY position`,
      [m2Insert.ticket.id])).rows;
    ok(m2EventRows.length === 1,
      'M2: exactly one ticket.created row exists for the produced child');
    const m2Event = m2EventRows[0];
    ok(m2Event.type === 'ticket.created', 'M2: retrieved row is the creation event');
    ok(m2Event.payload.spawnIdempotencyKey === 't4-m2-idem' &&
       m2Event.payload.spawnPlanId === m2SpawnPlanId &&
       m2Event.payload.executionMode === 'workflow' &&
       m2Event.payload.workflowId === m2Workflow.id &&
       m2Event.payload.blockedReason ===
         'Created by executeTicketPlan; child workflow execution is not automatic in v1.',
      'M2: the event bytes carry the production spawn provenance verbatim');

    // 3–5. T4 consumes those ACTUAL bytes; outcome = FACT bound to identities.
    const m2Records = await store.listChildCreationProvenance(m2Insert.ticket.id);
    ok(m2Records.length === 1 &&
       String(m2Records[0].id) === String(m2Event.id) &&
       m2Records[0].position === Number(m2Event.position),
      'M2: T4 provenance retrieval yields exactly the actual event row');
    const m2Resolution = resolveChildSpawnRelation({
      childTicketId: m2Insert.ticket.id,
      records: m2Records,
      existingParentTicketIds: new Set([m2Parent.id])
    });

    // 6–9. Exact resulting fact/origin binding.
    ok(m2Resolution.outcome === 'FACT', 'M2: resolution consumes actual bytes into FACT');
    ok(m2Resolution.fact.childTicketId === m2Insert.ticket.id,
      'M2: fact.childTicketId equals the actual child id');
    ok(m2Resolution.fact.parentTicketId === m2Parent.id,
      'M2: fact.parentTicketId equals the actual parent id');
    ok(m2Resolution.fact.kind === RELATIONSHIP_KIND,
      'M2: fact.kind is the frozen workflow-spawn kind');
    ok(String(m2Resolution.fact.originEvent.id) === String(m2Event.id) &&
       m2Resolution.fact.originEvent.position === Number(m2Event.position),
      'M2: originEvent binds the actual event id/position (T4-I7)');

    // 10. Parent-side enumeration contains that exact fact.
    const m2Enumeration = await enumerateChildren(store, m2Parent.id);
    ok(m2Enumeration.state === ENUMERATION_STATES.COMPLETE &&
       m2Enumeration.facts.length === 1,
      'M2: parent-side enumeration is COMPLETE with exactly one fact');
    ok(JSON.stringify(m2Enumeration.facts[0]) === JSON.stringify(m2Resolution.fact),
      'M2: the enumerated fact is byte-identical to the resolved origin binding');

    // N1: the builder uses the caller-supplied execution policy verbatim
    // rather than inventing or replacing it. The fixture marker values
    // (autoRetry true, maxAttempts 3) match no canonical default, so a deep
    // match against the supplied object is load-bearing evidence.
    assert.deepEqual(
      m2Insert.ticket.executionPolicy,
      FIXTURE_SPAWN_EXECUTION_POLICY,
      'N1: builder stamps the caller-supplied execution policy verbatim');
    ok(m2Insert.ticket.executionPolicy.autoRetry === true &&
       m2Insert.ticket.executionPolicy.maxAttempts === 3,
      'N1: caller-supplied policy reached the persisted child (pass-through proven)');

    console.log('frozen predecessor isolation (T4-I8)');

    // Idempotent replay of an accepted production spawn: still ONE record.
    const replaySpec = {
      run: { id: 90010, ticketId: parent.id, agentId: agent.id },
      workflow,
      step: { id: 'step-replay' },
      planTicket: {
        objective: 'replay probe',
        workflowId: workflow.id,
        workflowInput: {},
        reason: null,
        idempotencyKey: 't4-key-replay'
      },
      spawnPlanId: '90010:t4-parent-workflow:step-replay:transition:0'
    };
    const firstInsert = await spawnViaProductionConstructor(store, replaySpec);
    ok(firstInsert.created === true, 'fixture: replay-probe child first insert');
    const replayAgain = await spawnViaProductionConstructor(store, replaySpec);
    ok(replayAgain.created === false && replayAgain.event === null,
      'idempotent spawn replay appends NO second creation record');
    const replayResolution = await readChildRelation(store, replayAgain.ticket);
    ok(replayResolution.outcome === 'FACT' &&
       replayResolution.fact.kind === RELATIONSHIP_KIND,
      'replayed child still resolves exactly one derived FACT (T4-I7 stability)');

    // The T2 admissionHold composer path owns admission behavior where its
    // reviewed authority lives; the T4 reader introduces none (T4-I6).
    const heldChild = replayAgain.ticket;
    ok(heldChild.status === 'blocked', 'fixture: spawned child holds BLOCKED status');
    const holdRefusal = await store.rerunAdmitRuns({
      ticketId: heldChild.id,
      runDrafts: [{
        ticketId: heldChild.id, agentId: agent.id,
        status: 'pending', executionMode: 'agent'
      }],
      admissionIntent: 'rerun_terminal'
    }).then(() => null).catch(error => error);
    ok(holdRefusal && (
      holdRefusal.code === 'TICKET_BLOCKER_INTENT_MISMATCH' ||
      holdRefusal.code === 'TICKET_TRIAGE_REQUIRED'),
      'frozen T2 admission behavior unchanged beside the T4 seam (T4-I8)');
  });

  console.log(`postgres owner passed: ${assertions} assertions`);
}

main().catch(error => {
  console.error('FAIL:', error && error.stack ? error.stack : error);
  process.exit(1);
});
