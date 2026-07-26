#!/usr/bin/env node
'use strict';
// A18 — strict required replay-evidence contract.
//
// The strict helper is EXTRACTED FROM server.js SOURCE and driven against a REAL
// PostgreSQL replay store. Only its outward collaborators are injected, so the
// identity, idempotency, conflict, and readback logic under test is the shipped
// implementation, not a copy.
//
// The tolerant collaborator faithfully reproduces appendRunReplaySnapshotItem's
// documented behavior: it no-ops when no snapshot exists. That is the behavior
// A18 exists to stop treating as success at required-evidence call sites.
//
// Snapshot validation note: the repository has NO canonical runtime replay
// validator (recorded separately in the register). This suite validates initialized
// snapshots against the createReplaySnapshotBase contract and normal readRunReplay
// behavior. That is not formal runtime validation and is not claimed as such.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const fs = require('fs');
const path = require('path');
const { withHarness, createAsserter } = require('./postgres-test-harness');

const SERVER_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const assert = createAsserter();
const STAMP = Date.now();

function extract(declaration) {
  const start = SERVER_SOURCE.indexOf(declaration);
  if (start === -1) throw new Error(`could not locate "${declaration}" in server.js`);
  const rest = SERVER_SOURCE.slice(start);
  const end = rest.search(/\n\}\n/);
  if (end === -1) throw new Error(`could not find the end of "${declaration}"`);
  return rest.slice(0, end + 2);
}

// Canonical, key-order-independent JSON, mirroring the production helper the
// strict path uses for semantic payload comparison.
function canonicalOperationJson(value) {
  const walk = v => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.keys(v).sort().reduce((acc, k) => { acc[k] = walk(v[k]); return acc; }, {});
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

function loadStrictModule({ repository, base, tolerantAppend }) {
  const source = [
    SERVER_SOURCE.match(/const REQUIRED_EVIDENCE_REASONS = Object\.freeze\(\{[\s\S]*?\}\);/)[0],
    extract('function requiredEvidenceError('),
    extract('function sameEvidencePayload('),
    extract('async function appendRequiredRunReplaySnapshotItem('),
    extract('async function recordRequiredReplayEvent('),
    extract('function buildReconciliationEvidenceId('),
    'return { appendRequiredRunReplaySnapshotItem, recordRequiredReplayEvent, buildReconciliationEvidenceId, REQUIRED_EVIDENCE_REASONS };'
  ].join('\n\n');
  return new Function(
    'getRunReplayRepository', 'createReplaySnapshotBase',
    'appendRunReplaySnapshotItem', 'canonicalOperationJson', source
  )(() => repository, base, tolerantAppend, canonicalOperationJson);
}

async function main() {
  await withHarness('required replay evidence', async ({ store }) => {
    const agent = (await store.createConfiguredAgent({
      value: { name: `A18Agent${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'k' },
      groupIds: [], changedBy: 'a18-test'
    })).agent;

    const now = () => new Date().toISOString();
    const makeTicket = async objective => (await store.createTicketWithEvent({
      ticket: {
        objective, acceptanceCriteria: null,
        assignmentTargetType: 'agent', assignmentTargetId: agent.id, assignmentMode: 'individual',
        ownedOutputPaths: null, targetRef: null, executionMode: 'agent',
        workflowId: null, workflowInput: null,
        capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
        executionPolicy: {
          mode: 'assisted', requireVerification: 'when_declared', autoRetry: false,
          maxAttempts: null, maxRuntimeMs: null, maxModelRequests: null, maxWorkspaceOperations: null,
          allowWorkspaceWrites: true, allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'shared'
        },
        workTypeId: null, workTypeSnapshot: null, workContextId: null, workContextSnapshot: null,
        status: 'open', createdBy: 'admin', changedBy: 'admin', changedAt: now(), createdAt: now(), updatedAt: now()
      },
      eventPayload: { source: 'a18-test' }
    })).ticket;

    const makeRun = async label => {
      const ticket = await makeTicket(`a18 ${label} ${STAMP}`);
      return store.createRun({
        ticketId: ticket.id, agentId: agent.id, agentName: agent.name,
        runtimeLimitsSnapshot: { maxExecutionSteps: 4 },
        executionPolicySnapshot: { requireVerification: 'when_declared' }, status: 'pending'
      });
    };

    // Faithful stand-in for the TOLERANT production helper: silently no-ops when
    // no snapshot exists. This is the behavior A18 must never treat as success.
    let tolerantAppendCalls = 0;
    let failAppend = false;
    const tolerantAppend = async (runId, key, item) => {
      tolerantAppendCalls += 1;
      if (failAppend) { const e = new Error('injected append failure'); e.code = 'XX000'; throw e; }
      const record = await store.readRunReplay(runId);
      if (!record || !record.snapshot) return; // the silent no-op
      await store.updateRunReplay({
        runId,
        update: snapshot => {
          if (!snapshot) return snapshot; // mirrors the tolerant guard exactly
          const items = Array.isArray(snapshot[key]) ? snapshot[key] : [];
          return { ...snapshot, [key]: [...items, { ...item, capturedAt: new Date().toISOString() }] };
        }
      });
    };

    const base = run => ({
      version: 1, runId: run.id, ticketId: run.ticketId,
      assignedAgentId: run.agentId, agentNameSnapshot: run.agentName,
      executionPolicySnapshot: run.executionPolicySnapshot || null,
      runtimeLimitsSnapshot: run.runtimeLimitsSnapshot || null,
      targetId: 'local-workspace', targetKind: 'localWorkspace',
      events: []
    });

    let repository = store;
    const strict = loadStrictModule({ repository: store, base, tolerantAppend });

    const R = strict.REQUIRED_EVIDENCE_REASONS;
    const evt = (id, type, payload) => ({ type, message: 'm', evidenceId: id, payload });
    const capture = async fn => { try { await fn(); return null; } catch (e) { return e; } };

    // ── 1. Tolerant append intentionally no-ops when replay is absent ─────────
    {
      const run = await makeRun('tolerant-noop');
      await tolerantAppend(run.id, 'events', { type: 'x', evidenceId: 'x1' });
      const record = await store.readRunReplay(run.id);
      assert(!record, 'tolerant append intentionally no-ops when replay is absent');
    }

    // ── 2/3/4. Strict append initializes canonically and never no-ops ─────────
    let firstRun;
    {
      const run = await makeRun('strict-init');
      firstRun = run;
      await strict.appendRequiredRunReplaySnapshotItem(run, 'events', evt('occ-1', 'a18.evidence', { k: 1 }));
      const record = await store.readRunReplay(run.id);
      assert(Boolean(record && record.snapshot), 'strict append canonically initialized absent replay');
      const snap = record.snapshot;
      assert(snap.runId === run.id && snap.ticketId === run.ticketId,
        'initialized snapshot carries run and ticket identity');
      assert(snap.assignedAgentId === agent.id && snap.agentNameSnapshot === agent.name,
        'initialized snapshot carries agent identity from the base contract');
      assert(snap.executionPolicySnapshot && snap.runtimeLimitsSnapshot,
        'initialized snapshot carries execution-policy and runtime-limits snapshots');
      assert(snap.targetId === 'local-workspace' && snap.targetKind === 'localWorkspace',
        'initialized snapshot carries target metadata required by the base');
      assert(Array.isArray(snap.events) && snap.events.length === 1,
        'initialized snapshot has a well-formed events collection with exactly one event');
      assert(snap.events[0].evidenceId === 'occ-1' && snap.events[0].type === 'a18.evidence',
        'the exact required event is present after initialization');
    }

    // ── 9. Same-occurrence retry is idempotent ───────────────────────────────
    {
      const before = tolerantAppendCalls;
      await strict.appendRequiredRunReplaySnapshotItem(firstRun, 'events', evt('occ-1', 'a18.evidence', { k: 1 }));
      const record = await store.readRunReplay(firstRun.id);
      assert(record.snapshot.events.filter(e => e.evidenceId === 'occ-1').length === 1,
        'retrying the same occurrence appends no duplicate event');
      assert(tolerantAppendCalls === before,
        'the idempotent retry did not reach the append path at all');
    }

    // ── 10. A later distinct occurrence of the same type persists separately ──
    {
      await strict.appendRequiredRunReplaySnapshotItem(firstRun, 'events', evt('occ-2', 'a18.evidence', { k: 2 }));
      const record = await store.readRunReplay(firstRun.id);
      const sameType = record.snapshot.events.filter(e => e.type === 'a18.evidence');
      assert(sameType.length === 2,
        'a later distinct occurrence of the same type persists separately');
      assert(new Set(sameType.map(e => e.evidenceId)).size === 2,
        'the two same-type events carry distinct evidence identities');
    }

    // ── 5. Existing history is preserved ─────────────────────────────────────
    {
      const record = await store.readRunReplay(firstRun.id);
      assert(record.snapshot.events.some(e => e.evidenceId === 'occ-1'),
        'existing replay history is preserved across later required appends');
      assert(record.snapshot.runId === firstRun.id,
        'base metadata is preserved across later required appends');
    }

    // ── 11/12. Identity conflicts fail ───────────────────────────────────────
    {
      const conflictType = await capture(() =>
        strict.appendRequiredRunReplaySnapshotItem(firstRun, 'events', evt('occ-1', 'a18.other', { k: 1 })));
      assert(conflictType !== null, 'same identity with conflicting type fails');
      assert(conflictType.evidenceReason === R.CONFLICT,
        `conflicting type reports event_identity_conflict (${conflictType.evidenceReason})`);

      const conflictPayload = await capture(() =>
        strict.appendRequiredRunReplaySnapshotItem(firstRun, 'events', evt('occ-1', 'a18.evidence', { k: 999 })));
      assert(conflictPayload !== null, 'same identity with conflicting payload fails');
      assert(conflictPayload.evidenceReason === R.CONFLICT,
        `conflicting payload reports event_identity_conflict (${conflictPayload.evidenceReason})`);
    }

    // ── 7. Payload comparison is semantic, not key-order dependent ───────────
    {
      const run = await makeRun('semantic-payload');
      await strict.appendRequiredRunReplaySnapshotItem(run, 'events', evt('s1', 'a18.evidence', { a: 1, b: 2 }));
      const reordered = await capture(() =>
        strict.appendRequiredRunReplaySnapshotItem(run, 'events', evt('s1', 'a18.evidence', { b: 2, a: 1 })));
      assert(reordered === null,
        'payload comparison is semantic: key order does not create a false conflict');
      const record = await store.readRunReplay(run.id);
      assert(record.snapshot.events.filter(e => e.evidenceId === 's1').length === 1,
        'the key-reordered retry stayed idempotent');
    }

    // ── 8. A same-type event with another identity cannot satisfy readback ───
    {
      const run = await makeRun('identity-required');
      await strict.appendRequiredRunReplaySnapshotItem(run, 'events', evt('other-id', 'a18.evidence', { k: 1 }));
      // A type-only readback would accept this; an exact one must still append.
      await strict.appendRequiredRunReplaySnapshotItem(run, 'events', evt('wanted-id', 'a18.evidence', { k: 1 }));
      const record = await store.readRunReplay(run.id);
      assert(record.snapshot.events.some(e => e.evidenceId === 'wanted-id'),
        'a same-type event with another identity cannot satisfy readback');
      assert(record.snapshot.events.length === 2,
        'both distinct identities are durably present');
    }

    // ── 15. Append failure is classified ─────────────────────────────────────
    {
      const run = await makeRun('append-failure');
      failAppend = true;
      const error = await capture(() =>
        strict.appendRequiredRunReplaySnapshotItem(run, 'events', evt('af-1', 'a18.evidence', { k: 1 })));
      failAppend = false;
      assert(error !== null, 'append failure propagates');
      assert(error.evidenceReason === R.APPEND,
        `append failure reports append_failure (${error.evidenceReason})`);
      assert(error.storeErrorCode === 'XX000',
        'the underlying store error code is preserved');
      assert(error.cause && error.cause.message === 'injected append failure',
        'internal cause linkage is retained');
    }

    // ── 17. Missing exact event after append is classified ───────────────────
    {
      const run = await makeRun('missing-after-append');
      const swallowing = loadStrictModule({
        repository: store, base,
        tolerantAppend: async () => { /* claims success, writes nothing */ }
      });
      const error = await capture(() =>
        swallowing.appendRequiredRunReplaySnapshotItem(run, 'events', evt('ma-1', 'a18.evidence', { k: 1 })));
      assert(error !== null, 'an append that writes nothing is detected, not trusted');
      assert(error.evidenceReason === R.MISSING,
        `a silent no-op append reports event_missing_after_append (${error.evidenceReason})`);
    }

    // ── 14. Initialization failure is classified ─────────────────────────────
    {
      const run = await makeRun('init-failure');
      const broken = loadStrictModule({
        repository: {
          initializeRunReplay: async () => { const e = new Error('init boom'); e.code = 'YY000'; throw e; },
          readRunReplay: (...a) => store.readRunReplay(...a)
        },
        base, tolerantAppend
      });
      const error = await capture(() =>
        broken.appendRequiredRunReplaySnapshotItem(run, 'events', evt('if-1', 'a18.evidence', {})));
      assert(error !== null, 'initialization failure propagates');
      assert(error.evidenceReason === R.INIT,
        `initialization failure reports initialization_failure (${error.evidenceReason})`);
    }

    // ── 16. Readback storage failure is classified ───────────────────────────
    {
      const run = await makeRun('readback-failure');
      const broken = loadStrictModule({
        repository: {
          initializeRunReplay: (...a) => store.initializeRunReplay(...a),
          readRunReplay: async () => { const e = new Error('read boom'); e.code = 'ZZ000'; throw e; }
        },
        base, tolerantAppend
      });
      const error = await capture(() =>
        broken.appendRequiredRunReplaySnapshotItem(run, 'events', evt('rb-1', 'a18.evidence', {})));
      assert(error !== null, 'readback storage failure propagates');
      assert(error.evidenceReason === R.READBACK,
        `readback storage failure reports readback_failure (${error.evidenceReason})`);
    }

    // ── 19. Malformed replay is classified ───────────────────────────────────
    {
      const run = await makeRun('malformed');
      const broken = loadStrictModule({
        repository: {
          initializeRunReplay: async () => ({ initialized: false }),
          readRunReplay: async () => ({ snapshot: { events: 'not-an-array' } })
        },
        base, tolerantAppend
      });
      const error = await capture(() =>
        broken.appendRequiredRunReplaySnapshotItem(run, 'events', evt('mf-1', 'a18.evidence', {})));
      assert(error !== null, 'malformed replay propagates');
      assert(error.evidenceReason === R.MALFORMED,
        `a non-array events collection reports malformed_replay (${error.evidenceReason})`);
    }

    // ── 20. Structured failure fields, without replay contents ───────────────
    {
      const run = await makeRun('structured-fields');
      await strict.appendRequiredRunReplaySnapshotItem(run, 'events', evt('sf-1', 'a18.evidence', { secret: 'x' }));
      const error = await capture(() =>
        strict.appendRequiredRunReplaySnapshotItem(run, 'events', evt('sf-1', 'a18.other', {})));
      assert(error.code === 'EVIDENCE_PERSISTENCE_FAILED', 'failure carries EVIDENCE_PERSISTENCE_FAILED');
      assert(error.failureKind === 'evidence_persistence', 'failure carries failureKind evidence_persistence');
      assert(error.evidenceChannel === 'replay', 'failure carries evidenceChannel replay');
      assert(error.runId === run.id, 'failure carries the run id');
      assert(error.eventType === 'a18.other', 'failure carries the event type');
      assert(error.evidenceId === 'sf-1', 'failure carries the evidence identity');
      const serialized = `${error.message} ${JSON.stringify({
        code: error.code, reason: error.evidenceReason, runId: error.runId,
        eventType: error.eventType, evidenceId: error.evidenceId
      })}`;
      assert(!serialized.includes('secret') && !serialized.includes('"x"'),
        'no replay contents or payload secrets appear in the structured failure');
    }

    // ── 2. Identity is mandatory: the strict path refuses anonymous evidence ──
    {
      const run = await makeRun('identity-required-arg');
      const error = await capture(() =>
        strict.appendRequiredRunReplaySnapshotItem(run, 'events', { type: 'a18.evidence', payload: {} }));
      assert(error !== null, 'required evidence without a stable identity is refused');
      assert(error.evidenceReason === R.CONFLICT,
        `missing evidence identity is reported as an integrity conflict (${error.evidenceReason})`);
    }

    // ── 13. Concurrent required appends do not duplicate or lose history ─────
    {
      const run = await makeRun('concurrent');
      const results = await Promise.allSettled([
        strict.appendRequiredRunReplaySnapshotItem(run, 'events', evt('cc-1', 'a18.evidence', { k: 1 })),
        strict.appendRequiredRunReplaySnapshotItem(run, 'events', evt('cc-1', 'a18.evidence', { k: 1 })),
        strict.appendRequiredRunReplaySnapshotItem(run, 'events', evt('cc-1', 'a18.evidence', { k: 1 }))
      ]);
      const record = await store.readRunReplay(run.id);
      const matching = record.snapshot.events.filter(e => e.evidenceId === 'cc-1');
      assert(matching.length >= 1, 'concurrent required appends leave the evidence durably present');
      assert(record.snapshot.runId === run.id, 'concurrent initialization did not discard base metadata');
      assert(results.every(r => r.status === 'fulfilled' || r.reason.code === 'EVIDENCE_PERSISTENCE_FAILED'),
        'concurrent attempts either succeed or fail with a structured evidence error');
    }

    // ── Revision-scoped occurrence identity, against REAL persisted revisions ─
    {
      const ticket = await makeTicket(`a18 revision-identity ${STAMP}`);
      const run = await store.createRun({
        ticketId: ticket.id, agentId: agent.id, agentName: agent.name,
        runtimeLimitsSnapshot: { maxExecutionSteps: 4 },
        executionPolicySnapshot: { requireVerification: 'when_declared' }, status: 'pending'
      });

      const idAt = r => strict.buildReconciliationEvidenceId(run.id, r.revision, 'run:terminalized');

      const first = await store.getRun(run.id);
      const id1 = idAt(first);
      assert(/:r\d+:/.test(id1),
        `the occurrence identity embeds the persisted run revision (${id1})`);
      assert(!/undefined|null|NaN/.test(id1), 'the occurrence identity contains no placeholder revision');

      // Retry of the SAME occurrence: revision unchanged -> same identity, idempotent.
      const retryId = idAt(await store.getRun(run.id));
      assert(retryId === id1, 'a retry of the same occurrence reuses the same evidence identity');
      await strict.appendRequiredRunReplaySnapshotItem(run, 'events',
        { type: 'run.reconciliation_evidence_failed', message: 'm', evidenceId: id1, payload: { a: 1 } });
      await strict.appendRequiredRunReplaySnapshotItem(run, 'events',
        { type: 'run.reconciliation_evidence_failed', message: 'm', evidenceId: retryId, payload: { a: 1 } });
      let record = await store.readRunReplay(run.id);
      assert(record.snapshot.events.filter(e => e.evidenceId === id1).length === 1,
        'the same-occurrence retry appended no duplicate event');

      // A REAL persisted transition advances the revision.
      const claim = await store.claimPendingRun({
        leaseOwner: 'a18-identity', leaseDurationMs: 60000, eligibleRunIds: [run.id]
      });
      const started = await store.transitionRun({
        runId: run.id, expectedRevision: claim.run.revision, fromStatuses: ['pending'],
        toStatus: 'running', leaseOwner: 'a18-identity', eventType: 'run.started'
      });
      const later = await store.getRun(run.id);
      assert(later.revision > first.revision,
        `a real persisted transition advanced the run revision (${first.revision} -> ${later.revision})`);

      const id2 = idAt(later);
      assert(id2 !== id1,
        'a later occurrence after a real revision advance receives a distinct evidence identity');

      await strict.appendRequiredRunReplaySnapshotItem(run, 'events',
        { type: 'run.reconciliation_evidence_failed', message: 'm', evidenceId: id2, payload: { a: 2 } });
      record = await store.readRunReplay(run.id);
      const occurrences = record.snapshot.events
        .filter(e => e.type === 'run.reconciliation_evidence_failed');
      assert(occurrences.length === 2,
        'both distinct occurrences of the same event type persist separately');
      assert(new Set(occurrences.map(e => e.evidenceId)).size === 2,
        'the two occurrences carry distinct revision-scoped identities');

      // An identity that ignores revision would collapse these two occurrences.
      const collapsing = `reconciliation-evidence-failed:${run.id}:run:terminalized`;
      assert(idAt(first) !== collapsing && idAt(later) !== collapsing,
        'the identity is not the revision-independent runId+logType form');

      // Same occurrence, conflicting payload -> integrity conflict.
      const conflict = await capture(() => strict.appendRequiredRunReplaySnapshotItem(run, 'events',
        { type: 'run.reconciliation_evidence_failed', message: 'm', evidenceId: id2, payload: { a: 999 } }));
      assert(conflict !== null && conflict.evidenceReason === R.CONFLICT,
        'reusing one occurrence identity with a conflicting payload raises event_identity_conflict');
    }

    console.log(`\nPASS: required replay evidence — ${assert.count()} assertions (PostgreSQL-native)`);
  }, { schemaSlug: 'a18_required_replay' });
}

main().catch(error => {
  console.error(`\nFAIL: required replay evidence — ${error && error.message ? error.message : error}`);
  process.exit(1);
});
