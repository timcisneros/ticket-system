#!/usr/bin/env node
'use strict';

// T3 — objective-revision kernel CONTRACT owner (deterministic, no database).
//
// Covers the frozen pure semantics: requested-outcome normalization
// (trim/non-empty objective with NO kernel maximum; absent/null/empty/
// whitespace acceptanceCriteria collapse to null), content-hash BINDING of
// stored canonical content, provenance-specific event validation
// (creation / t3_activation_baseline / revision), the pure revision-guard
// decision table, and the canonical identity register.

const assert = require('node:assert/strict');
const {
  EVENT_TYPE,
  PROVENANCES,
  REASON_CODES,
  ADMISSION_INTEGRITY_ERROR_CODE,
  NOOP_ERROR_CODE,
  canonicalObjective,
  canonicalAcceptanceCriteria,
  canonicalRevisionContent,
  revisionContentHash,
  normalizeRevisionEventPayload,
  buildCreationRevisionPayload,
  buildRevisionPayload,
  validatePointer,
  evaluateRevisionGuards,
  IDENTITY_REGISTER
} = require('../runtime/ticket-objective-revision-contract');

let assertions = 0;
const ok = (condition, message) => {
  assert.ok(condition, message);
  assertions += 1;
};
const throwsCode = (fn, code, message) => {
  try {
    fn();
  } catch (error) {
    ok(error.code === code || String(error.message).includes(code),
      `${message} (got ${error.code || error.message})`);
    return;
  }
  ok(false, `${message} — expected throw ${code}`);
};

// ── normalization ────────────────────────────────────────────────────────────
ok(canonicalObjective('  Fix the login bug  ') === 'Fix the login bug', 'objective trims');
throwsCode(() => canonicalObjective('   '), 'T3_OBJECTIVE_REVISION_INVALID', 'empty objective refused');
throwsCode(() => canonicalObjective(undefined), 'T3_OBJECTIVE_REVISION_INVALID', 'missing objective refused');
throwsCode(() => canonicalObjective(42), 'T3_OBJECTIVE_REVISION_INVALID', 'non-string objective refused');
{
  const huge = 'x'.repeat(25000);
  ok(canonicalObjective(huge) === huge,
    'NO kernel maximum objective length (25k accepted; subsystem limits stay subsystem-specific)');
}
ok(canonicalAcceptanceCriteria(undefined) === null, 'criteria absent -> null');
ok(canonicalAcceptanceCriteria(null) === null, 'criteria null -> null');
ok(canonicalAcceptanceCriteria('') === null, 'criteria empty -> null');
ok(canonicalAcceptanceCriteria('   ') === null, 'criteria whitespace -> null');
ok(canonicalAcceptanceCriteria('  done means tests pass  ') === 'done means tests pass',
  'criteria trims');
throwsCode(() => canonicalAcceptanceCriteria(7), 'T3_OBJECTIVE_REVISION_INVALID', 'non-string criteria refused');

// ── hash binds stored canonical content ─────────────────────────────────────
const contentA = canonicalRevisionContent({ objective: 'A', acceptanceCriteria: null });
const contentA2 = canonicalRevisionContent({ acceptanceCriteria: null, objective: 'A' });
ok(revisionContentHash(contentA) === revisionContentHash(contentA2),
  'content hash is key-order deterministic');
ok(revisionContentHash(contentA) !==
    revisionContentHash(canonicalRevisionContent({ objective: 'A', acceptanceCriteria: 'now tested' })),
  'criteria change changes revision identity');
ok(revisionContentHash(contentA) ===
    revisionContentHash(canonicalRevisionContent({ objective: 'A ', acceptanceCriteria: null })),
  'padded objective is canonically the SAME identity (trim rule; surfaces as no-op refusal)');
ok(revisionContentHash(contentA) !==
    revisionContentHash(canonicalRevisionContent({ objective: 'B', acceptanceCriteria: null })),
  'objective change changes revision identity');
throwsCode(() => normalizeRevisionEventPayload({
  number: 1, provenance: 'creation',
  content: contentA, contentHash: '0'.repeat(64),
  previous: null, actor: 'u', reasonCode: 'creation', reason: null, capturedAt: new Date()
}), 'T3_OBJECTIVE_REVISION_INVALID', 'hash must bind the stored canonical content');

// ── provenance-specific event validation ────────────────────────────────────
ok(EVENT_TYPE === 'ticket.objective_revised', 'event type pinned');
ok(PROVENANCES.join(',') === 'creation,t3_activation_baseline,revision', 'provenances pinned');
ok(REASON_CODES.includes('clarification') && REASON_CODES.includes('correction'),
  'bounded revision reason vocabulary');
{
  const payload = buildCreationRevisionPayload({
    objective: 'A', acceptanceCriteria: null, actor: 'alice', capturedAt: new Date()
  });
  ok(payload.number === 1 && payload.provenance === 'creation' &&
     payload.previous === null && payload.reasonCode === 'creation' && payload.reason === null,
    'creation shape');
  throwsCode(() => buildCreationRevisionPayload({
    objective: 'A', acceptanceCriteria: null, actor: 'alice',
    reason: 'trying to fabricate history', capturedAt: new Date()
  }), 'T3_OBJECTIVE_REVISION_INVALID', 'creation must not fabricate a human reason');

  const baseline = normalizeRevisionEventPayload({
    number: 1, provenance: 't3_activation_baseline',
    content: contentA, contentHash: revisionContentHash(contentA),
    previous: null, actor: 'migration:042_objective_revision_baseline',
    reasonCode: 'legacy_baseline', reason: null, capturedAt: '2026-08-24T00:00:00.000Z'
  });
  ok(baseline.actor === 'migration:042_objective_revision_baseline' && baseline.reason === null,
    'baseline shape: migration actor, activation-time fact, no fabricated reason');
  throwsCode(() => normalizeRevisionEventPayload({
    number: 1, provenance: 't3_activation_baseline', content: contentA,
    contentHash: revisionContentHash(contentA), previous: null,
    actor: 'migration', reasonCode: 'creation', reason: null, capturedAt: new Date()
  }), 'T3_OBJECTIVE_REVISION_INVALID', 'baseline reasonCode pinned to legacy_baseline');

  const rev2 = buildRevisionPayload({
    number: 2, previous: { number: 1, hash: revisionContentHash(contentA) },
    objective: 'B', acceptanceCriteria: 'tested', actor: 'bob',
    reasonCode: 'clarification', reason: 'operator clarified scope',
    capturedAt: new Date()
  });
  ok(rev2.number === 2 && rev2.previous.number === 1 && rev2.reason === 'operator clarified scope',
    'revision shape carries exact previous pointer and required operator reason');
  throwsCode(() => normalizeRevisionEventPayload({
    number: 2, provenance: 'revision', content: contentA,
    contentHash: revisionContentHash(contentA),
    previous: { number: 2, hash: revisionContentHash(contentA) },
    actor: 'bob', reasonCode: 'clarification', reason: 'r', capturedAt: new Date()
  }), 'T3_OBJECTIVE_REVISION_INVALID', 'previous.number must be N-1');
  throwsCode(() => normalizeRevisionEventPayload({
    number: 2, provenance: 'revision', content: contentA,
    contentHash: revisionContentHash(contentA),
    previous: { number: 1, hash: revisionContentHash(contentA) },
    actor: 'bob', reasonCode: 'not_in_vocabulary', reason: 'r', capturedAt: new Date()
  }), 'T3_OBJECTIVE_REVISION_INVALID', 'reasonCode vocabulary bounded');
  throwsCode(() => normalizeRevisionEventPayload({
    number: 2, provenance: 'revision', content: contentA,
    contentHash: revisionContentHash(contentA),
    previous: { number: 1, hash: revisionContentHash(contentA) },
    actor: 'bob', reasonCode: 'clarification', reason: '   ', capturedAt: new Date()
  }), 'T3_OBJECTIVE_REVISION_INVALID', 'revision reason required');
  throwsCode(() => normalizeRevisionEventPayload({
    number: 1, provenance: 'revision', content: contentA,
    contentHash: revisionContentHash(contentA), previous: null,
    actor: 'bob', reasonCode: 'clarification', reason: 'r', capturedAt: new Date()
  }), 'T3_OBJECTIVE_REVISION_INVALID', 'revision numbering starts at 2');
  throwsCode(() => normalizeRevisionEventPayload({
    number: 1, provenance: 'time_travel', content: contentA,
    contentHash: revisionContentHash(contentA), previous: null,
    actor: 'x', reasonCode: 'creation', reason: null, capturedAt: new Date()
  }), 'T3_OBJECTIVE_REVISION_INVALID', 'unknown provenance refused');
}

// ── pointer validation ───────────────────────────────────────────────────────
ok(validatePointer({ number: 3, hash: 'a'.repeat(64) }).number === 3, 'pointer validates');
throwsCode(() => validatePointer({ number: 0, hash: 'a'.repeat(64) }),
  'T3_OBJECTIVE_REVISION_INVALID', 'pointer number positive');
throwsCode(() => validatePointer({ number: 1, hash: 'zz' }),
  'T3_OBJECTIVE_REVISION_INVALID', 'pointer hash format');

// ── guard decision table ─────────────────────────────────────────────────────
const baseGuards = {
  status: 'open',
  hasUnsettledAttempt: false,
  cancellationCommitted: false,
  hasStructuredAllocationAuthority: false,
  expectedGenericRevisionMatches: true,
  chainCoherent: true,
  canonicalNoOp: false
};
ok(evaluateRevisionGuards(baseGuards).ok === true, 'clean guards allow revision');
throwsCode(() => {
  const result = evaluateRevisionGuards({ ...baseGuards, expectedGenericRevisionMatches: false });
  if (!result.ok) throw Object.assign(new Error(result.code), { code: result.code });
}, 'TICKET_TRANSITION_CONFLICT', 'stale expected revision conflicts');
for (const [mutation, code] of [
  [{ hasUnsettledAttempt: true }, 'TICKET_ATTEMPT_UNSETTLED'],
  [{ status: 'completed' }, 'TICKET_OBJECTIVE_REVISION_STATE_INVALID'],
  [{ status: 'canceled' }, 'TICKET_OBJECTIVE_REVISION_STATE_INVALID'],
  [{ status: 'in_progress' }, 'TICKET_OBJECTIVE_REVISION_STATE_INVALID'],
  [{ cancellationCommitted: true }, 'TICKET_CANCELLATION_COMMITTED'],
  [{ hasStructuredAllocationAuthority: true }, 'STRUCTURED_ALLOCATION_OBJECTIVE_IMMUTABLE'],
  [{ chainCoherent: false }, ADMISSION_INTEGRITY_ERROR_CODE],
  [{ canonicalNoOp: true }, NOOP_ERROR_CODE]
]) {
  const result = evaluateRevisionGuards({ ...baseGuards, ...mutation });
  throwsCode(() => {
    if (!result.ok) throw Object.assign(new Error(result.code), { code: result.code });
  }, code, `guard refuses ${JSON.stringify(mutation)} with ${code}`);
}

// ── identity register ────────────────────────────────────────────────────────
for (const key of [
  'OBJECTIVE_REVISION_CONTENT_HASH',
  'DECLARED_WORK_CONTRACT_HASH',
  'COMPLETION_OBJECTIVE_HASH',
  'GENERIC_TICKET_REVISION',
  'TICKET_ATTEMPT_IDENTITY',
  'ALLOCATION_PLAN_IDENTITY'
]) {
  ok(typeof IDENTITY_REGISTER[key] === 'object' && typeof IDENTITY_REGISTER[key].binds === 'string',
    `identity register distinguishes ${key}`);
}
ok(IDENTITY_REGISTER.GENERIC_TICKET_REVISION.scope.includes('NOT an objective identity'),
  'register explicitly separates generic revision from objective identity');
ok(IDENTITY_REGISTER.COMPLETION_OBJECTIVE_HASH.scope.includes('PRESERVED'),
  'register preserves completion objectiveHash semantics verbatim');

console.log(`\nPASS: T3 objective-revision kernel contract — ${assertions} assertions`);
