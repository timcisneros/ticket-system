'use strict';

const crypto = require('crypto');

// ── T4 Workflow-Spawn Relationship Kernel — canonical interpretation seam ───
//
// Registered authority (docs/ARCHITECTURAL_DECISIONS_PENDING.md,
// "T4 Workflow-Spawn Relationship Kernel — semantic freeze", recorded
// 2026-08-26, invariants T4-I1..T4-I8). This module is the ONE canonical pure
// boundary that owns workflow-spawn relationship semantics. It is pure:
// storage, SQL and server mechanics stay outside; callers supply exact
// evidence (the child's COMPLETE creation-provenance set from append-only
// event rows, and which referenced parent identities exist).
//
// Invariant map (what this module must make true):
//
//   T4-I1 Provenance authority. The child's immutable, append-only
//         ticket.created event payload is the sole relationship authority.
//         Nothing here ever reads a Ticket body.
//   T4-I2 Negative non-authority. Mutable/incidental Ticket-body topology can
//         neither grant nor deny the fact. This module structurally accepts
//         no Ticket-body input at all, so body drift is invisible to it.
//   T4-I3 Complete-provenance resolution. The caller supplies the COMPLETE
//         relevant creation-provenance set; no filtered subset may establish
//         truth. An emitted fact requires coherent resolution of that set.
//   T4-I4 Bounded fail-closed corruption. Malformed or multiple applicable
//         provenance refuses required truth; the refusal names evidence and
//         never invents parentage. Corruption scope follows evidence: one
//         child's malformed record widens nothing globally (each result is
//         child-local; callers aggregate without inference).
//   T4-I5 Explicit enumeration completeness. Parent-side enumeration pairs
//         every attributable candidate with its resolution and distinguishes
//         COMPLETE from INCOMPLETE in the typed result itself.
//   T4-I6 Kind non-authority. The kind below carries zero lifecycle,
//         admission, waiting, ordering or execution semantics. It is a label
//         on a derived fact only.
//   T4-I7 Derived identity. No independent relationship identity exists: the
//         originating ticket.created event identity/position IS carried as
//         the fact's origin. No writer is introduced here.
//   T4-I8 Frozen predecessor isolation. The frozen T2 blocking-authority
//         composer remains an intentionally INDEPENDENT consumer of the same
//         provenance predicate; this module deliberately re-states the
//         accepted durable shapes instead of importing composer internals,
//         so neither consumer can reroute or silently change the other.
//
// P5-R2 extension (delegated spawn identity). The same kernel owns the
// delegated logical-unit identity derivation (DELEGATION_SCHEME,
// buildDelegatedSpawnIdempotencyKey, isLiteralUnitKey) and the coherent
// delegated creation-relation resolution (resolveDelegatedSpawnRelation).
// The extension re-uses the base complete-provenance resolution unchanged
// (T4-I1..T4-I8 all apply) and adds only the delegation-block coherence
// proof on top; the composer's own predicate is untouched (T4-I8).
//
// Accepted durable provenance shapes mirror what production has emitted
// through createChildWorkflowTicketFromPlan -> createTicketWithEvent:
//   - parentTicketId: positive safe integer, or digit string /^[1-9]\d*$/
//     (both shapes are durable in historical rows);
//   - spawnIdempotencyKey: non-blank string;
//   - spawnPlanId: positive safe integer, or non-blank composite string
//     `${run.id}:${workflow.id}:${step.id}:transition:${n}`.
//
// Applicability (what makes a record a spawn-provenance ATTEMPT): any of the
// six workflow-spawn topology fields carries a claimed value (non-null,
// non-undefined, non-empty). A record whose only claims leave the parent
// binding incoherent is attempted-but-malformed => fail closed. Plain
// records (no claims at all) establish truthful absence.

const RELATIONSHIP_KIND = Object.freeze('workflow-spawn');

const SPAWN_PROVENANCE_FIELDS = Object.freeze([
  'parentTicketId',
  'parentRunId',
  'parentWorkflowId',
  'spawnedByStepId',
  'spawnPlanId',
  'spawnIdempotencyKey'
]);

const REFUSAL_REASONS = Object.freeze({
  MALFORMED_SPAWN_PROVENANCE: 'MALFORMED_SPAWN_PROVENANCE',
  MULTIPLE_APPLICABLE_PROVENANCE: 'MULTIPLE_APPLICABLE_PROVENANCE',
  PARENT_TICKET_NOT_FOUND: 'PARENT_TICKET_NOT_FOUND'
});

// ── P5-R2 delegated-unit identity (CHILD-RERUN-A / UNITKEY-A) ────────────────
//
// A delegated logical unit's spawn identity is derived canonically from
// Ticket-stable, workflow-authored facts only:
//
//   ticket:{parentTicketId}:{parentWorkflowId}:{spawnedByStepId}:{childWorkflowId}:{unitKey}
//
// The authoritative delegated-unit key set comes from LITERAL `unitKey`
// values present in the operator-owned workflow definition BEFORE template
// resolution. The runtime/model may never create, replace, template or widen
// `unitKey`; this module owns the one canonical derivation so the server, the
// store and tests cannot drift. The existing non-delegated key derivation
// (server buildTicketPlanIdempotencyKey) stays byte-for-byte unchanged.
const DELEGATION_SCHEME = Object.freeze('workflow_delegation_v1');

// The spawn key must never be re-parsed: components live in the delegation
// block, the key itself is only ever derived and compared.
function buildDelegatedSpawnIdempotencyKey({ parentTicketId, parentWorkflowId, spawnedByStepId, childWorkflowId, unitKey }) {
  const parent = assertPositiveSafeInteger(parentTicketId, 'parentTicketId');
  const parentWorkflow = isNonBlankString(parentWorkflowId) ? parentWorkflowId : null;
  const step = isNonBlankString(spawnedByStepId) ? spawnedByStepId : null;
  const childWorkflow = isNonBlankString(childWorkflowId) ? childWorkflowId : null;
  const unit = isNonBlankString(unitKey) ? unitKey : null;
  if (parentWorkflow === null) throw new TypeError('parentWorkflowId must be a non-blank string');
  if (step === null) throw new TypeError('spawnedByStepId must be a non-blank string');
  if (childWorkflow === null) throw new TypeError('childWorkflowId must be a non-blank string');
  if (unit === null) throw new TypeError('unitKey must be a non-blank string');
  return ['ticket', String(parent), parentWorkflow, step, childWorkflow, unit].join(':');
}

// A literal operator-authored unit key: a non-blank string carrying no
// workflow template expression. A template-authored key can never be literal
// authority — the resolved value would be derived from mutable workflow input.
function isLiteralUnitKey(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (value.includes('{{') || value.includes('}}')) return false;
  return true;
}

// Delegated-refusal codes are SEPARATE from the base spawn-refusal map: the
// frozen base map is untouched, and these name only the delegated-block
// defects a delegated release can observe.
const DELEGATED_REFUSAL_REASONS = Object.freeze({
  MALFORMED_DELEGATION_PROVENANCE: 'MALFORMED_DELEGATION_PROVENANCE',
  DELEGATED_PROVENANCE_KEY_CONFLICT: 'DELEGATED_PROVENANCE_KEY_CONFLICT',
  DELEGATED_SPAWN_KEY_MISMATCH: 'DELEGATED_SPAWN_KEY_MISMATCH'
});

function parseDelegationId(value) {
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  if (Number.isSafeInteger(value) && value > 0) return value;
  return null;
}

function delegatedRefusal(reason, childTicketId, detail) {
  return {
    outcome: 'REFUSED',
    reason,
    childTicketId,
    detail: detail || null
  };
}

// Coherent delegated creation relation (T4-I1 complete-provenance semantics).
//
// The child's COMPLETE relevant ticket.created provenance set must resolve
// through the base spawn kernel to exactly ONE coherent parent relation, and
// the winning record must additionally carry a coherent P5 delegation block
// whose components re-derive the exact spawn identity. Absence of the block
// means the child is NOT a delegated child (historical rows and ordinary
// executeTicketPlan children have none) and a delegated release refuses.
//
//   expectedSpawnIdempotencyKey — when supplied, the resolved logical spawn
//     identity must equal it (leg 2 of the delegated-release authority: the
//     released child is the unit the CURRENT parent run re-derived).
function resolveDelegatedSpawnRelation({
  childTicketId,
  records,
  existingParentTicketIds,
  expectedSpawnIdempotencyKey = null
}) {
  assertPositiveSafeInteger(childTicketId, 'childTicketId');
  if (!(existingParentTicketIds instanceof Set)) {
    throw new TypeError('existingParentTicketIds must be a Set of positive safe integers');
  }
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  if (expectedSpawnIdempotencyKey !== null && !isNonBlankString(expectedSpawnIdempotencyKey)) {
    throw new TypeError('expectedSpawnIdempotencyKey must be a non-blank string or null');
  }

  const base = resolveChildSpawnRelation({ childTicketId, records, existingParentTicketIds });
  if (base.outcome !== 'FACT') {
    // Complete-set base refusals (malformed/multiple/missing parent) pass
    // through with their own typed reasons; no delegated fact can be built
    // on an incoherent base relation.
    return {
      outcome: 'REFUSED',
      reason: base.reason,
      childTicketId,
      originEvent: base.originEvent || null,
      detail: base.detail || null
    };
  }

  const winningPosition = base.fact.originEvent.position;
  const winningIndex = records.findIndex(record => normalizeProvenanceRecord(record).position === winningPosition);
  const winningRecord = winningIndex >= 0 ? records[winningIndex] : null;
  const recordPayload = winningRecord && typeof winningRecord.payload === 'object' && winningRecord.payload !== null
    ? winningRecord.payload
    : {};
  const delegation = typeof recordPayload.delegation === 'object' && recordPayload.delegation !== null &&
    !Array.isArray(recordPayload.delegation)
    ? recordPayload.delegation
    : null;

  const malformed = detail => delegatedRefusal(
    DELEGATED_REFUSAL_REASONS.MALFORMED_DELEGATION_PROVENANCE,
    childTicketId,
    { ...detail, originEvent: base.fact.originEvent }
  );

  if (!delegation) {
    return malformed({ missing: 'delegation' });
  }
  if (delegation.scheme !== DELEGATION_SCHEME) {
    return malformed({ field: 'delegation.scheme', received: delegation.scheme === undefined ? null : String(delegation.scheme) });
  }
  const delegationParentTicketId = parseDelegationId(delegation.parentTicketId);
  if (delegationParentTicketId === null || delegationParentTicketId !== base.fact.parentTicketId) {
    return malformed({ field: 'delegation.parentTicketId' });
  }
  const delegationParentRunId = parseDelegationId(delegation.parentRunId);
  if (delegationParentRunId === null) {
    return malformed({ field: 'delegation.parentRunId' });
  }
  for (const field of ['parentWorkflowId', 'spawnedByStepId', 'spawnPlanId', 'spawnIdempotencyKey']) {
    if (!isNonBlankString(delegation[field])) {
      return malformed({ field: `delegation.${field}` });
    }
  }
  if (!isLiteralUnitKey(delegation.unitKey)) {
    return malformed({ field: 'delegation.unitKey' });
  }
  if (delegation.parentExecutionPolicyHash !== null && delegation.parentExecutionPolicyHash !== undefined &&
      !/^[0-9a-f]{64}$/.test(delegation.parentExecutionPolicyHash)) {
    return malformed({ field: 'delegation.parentExecutionPolicyHash' });
  }

  // The block must agree with the outer provenance payload it rides (one
  // event, one truth; divergence is corruption, not a parallel authority).
  if (delegation.parentWorkflowId !== recordPayload.parentWorkflowId ||
      delegation.spawnedByStepId !== recordPayload.spawnedByStepId ||
      delegation.spawnIdempotencyKey !== recordPayload.spawnIdempotencyKey) {
    return delegatedRefusal(
      DELEGATED_REFUSAL_REASONS.DELEGATED_PROVENANCE_KEY_CONFLICT,
      childTicketId,
      { originEvent: base.fact.originEvent, field: 'delegation-block-vs-payload' }
    );
  }

  // Canonical re-derivation from Ticket-stable components only. The spawn key
  // is the delegated logical identity; every component must cohere.
  const childWorkflowId = isNonBlankString(recordPayload.workflowId) ? recordPayload.workflowId : null;
  if (childWorkflowId === null) {
    return malformed({ field: 'workflowId' });
  }
  let derivedKey;
  try {
    derivedKey = buildDelegatedSpawnIdempotencyKey({
      parentTicketId: base.fact.parentTicketId,
      parentWorkflowId: delegation.parentWorkflowId,
      spawnedByStepId: delegation.spawnedByStepId,
      childWorkflowId,
      unitKey: delegation.unitKey
    });
  } catch (_) {
    return malformed({ field: 'delegation-key-components' });
  }
  if (derivedKey !== delegation.spawnIdempotencyKey || derivedKey !== recordPayload.spawnIdempotencyKey) {
    return delegatedRefusal(
      DELEGATED_REFUSAL_REASONS.DELEGATED_PROVENANCE_KEY_CONFLICT,
      childTicketId,
      { originEvent: base.fact.originEvent, derivedKey }
    );
  }

  if (expectedSpawnIdempotencyKey !== null && derivedKey !== expectedSpawnIdempotencyKey) {
    return delegatedRefusal(
      DELEGATED_REFUSAL_REASONS.DELEGATED_SPAWN_KEY_MISMATCH,
      childTicketId,
      { originEvent: base.fact.originEvent, expectedSpawnIdempotencyKey, resolvedSpawnIdempotencyKey: derivedKey }
    );
  }

  return {
    outcome: 'FACT',
    fact: base.fact,
    delegation: {
      scheme: delegation.scheme,
      parentTicketId: delegationParentTicketId,
      parentRunId: delegationParentRunId,
      parentWorkflowId: delegation.parentWorkflowId,
      spawnedByStepId: delegation.spawnedByStepId,
      spawnPlanId: delegation.spawnPlanId,
      spawnIdempotencyKey: delegation.spawnIdempotencyKey,
      unitKey: delegation.unitKey,
      parentExecutionPolicyHash: delegation.parentExecutionPolicyHash === undefined
        ? null
        : delegation.parentExecutionPolicyHash
    }
  };
}

// ── P5-R2 correction: durable current-action delegated-plan authorization ────
//
// The delegated-release admission may not trust caller knowledge of a valid
// spawn key: a never-acting Run (or a terminal Run whose immutable snapshot
// said allowChildTickets: true) otherwise passes the store's legs while never
// having canonically validated or re-derived the unit at all. The correction
// closes that hole with ONE narrow R2 evidence type recorded on the ACTING
// parent Run's OWN append-only hash-chained evidence chain:
//
//   workflow.delegated_plan_authorized
//
// recorded by the executing `executeTicketPlan` action ONLY after every
// canonical plan-validation acceptance requirement has passed (literal-unitKey
// proof, workflow-definition validation, workflow input validation,
// allowedWorkflowIds, maxTickets, recursive-child prohibition, child-workflow
// validation at plan time) and BEFORE any delegated child is created/adopted
// or released. It carries the exact finite delegated-unit set this action
// authorized. The store's atomic release transaction then INDEPENDENTLY
// consumes this durable fact — the authority chain is:
//
//   operator workflow definition
//     → canonical current-action validation
//     → durable immutable validation evidence
//     → atomic store verification
//     → delegated release
//
// The evidence identity is Run-stable across safe resume/replay (the
// lease-recovery execution-attempt counter never takes part), so a replayed
// action re-records and reuses the SAME durable authorization fact; a
// divergent re-derivation fails closed through the existing idempotency
// semantics. Raw model prose is never evidence: the item is derived
// exclusively from validated canonical facts.
const DELEGATED_PLAN_AUTHORIZATION_EVENT_TYPE = Object.freeze('workflow.delegated_plan_authorized');
const DELEGATED_PLAN_AUTHORIZATION_REPLAY_KEY = Object.freeze('delegatedPlanAuthorizations');

// The evidence identity is owned by the persisted Run and the Run-scoped
// execution reference (spawnPlanId = `${run.id}:${workflow.id}:${step.id}:transition:${n}`)
// alone — fixed namespace + sha256 slot, exactly the P5-R1 invocation-identity
// convention. NEVER the lease-recovery attempt counter, wall-clock, random ids
// or transient process identity.
function buildDelegatedPlanAuthorizationEvidenceKey({ parentRunId, spawnPlanId }) {
  const runId = assertPositiveSafeInteger(parentRunId, 'parentRunId');
  const plan = isNonBlankString(spawnPlanId) ? spawnPlanId : null;
  if (plan === null) throw new TypeError('spawnPlanId must be a non-blank string');
  const slotHash = crypto.createHash('sha256')
    .update(`delegated-plan-authorization:${plan}`)
    .digest('hex');
  return `delegated-plan-authorization:run:${runId}:slot:${slotHash}`;
}

// The ONE production definition of the validated delegated-plan authorization
// item bytes, shared by the server writer and the suites so neither can drift.
// Every field is a canonical validated fact; the delegated unit entries are
// re-derived against the canonical delegated spawn key so a divergent entry
// refuses here rather than reaching the store.
//
//   run             — the ACTING admitted parent Run ({ id, ticketId })
//   workflow        — the parent workflow catalog row ({ id, ... })
//   step            — the spawning step ({ id, action }) — action must be
//                     exactly 'executeTicketPlan'
//   spawnPlanId     — the Run-scoped execution reference of this action
//   planBounds      — { allowedWorkflowIds: [string], maxTickets: integer }
//                     the validated plan bounds of THIS action
//   delegatedUnits  — the EXACT finite accepted delegated unit set
//                     ({ unitKey, childWorkflowId, spawnIdempotencyKey })
//   workflowContract— optional buildWorkflowContractEvidence(workflow) facts
//                     (definition identity/version/hash recorded UNDER the
//                     identity, same doctrine as the R1 invocation evidence)
function buildDelegatedPlanAuthorizationEvidence({
  run,
  workflow,
  step,
  spawnPlanId,
  planBounds,
  delegatedUnits,
  workflowContract = null
}) {
  if (!run || typeof run !== 'object') throw new TypeError('run is required');
  if (!workflow || typeof workflow !== 'object') throw new TypeError('workflow is required');
  if (!step || typeof step !== 'object') throw new TypeError('step is required');
  if (step.action !== 'executeTicketPlan') {
    throw new TypeError('delegated-plan authorization evidence requires the executeTicketPlan action');
  }
  const parentRunId = assertPositiveSafeInteger(run.id, 'run.id');
  const parentTicketId = assertPositiveSafeInteger(run.ticketId, 'run.ticketId');
  const parentWorkflowId = isNonBlankString(workflow.id) ? workflow.id : null;
  if (parentWorkflowId === null) throw new TypeError('workflow.id must be a non-blank string');
  const stepId = isNonBlankString(step.id) ? step.id : null;
  if (stepId === null) throw new TypeError('step.id must be a non-blank string');
  const plan = isNonBlankString(spawnPlanId) ? spawnPlanId : null;
  if (plan === null) throw new TypeError('spawnPlanId must be a non-blank string');
  const bounds = planBounds && typeof planBounds === 'object' && !Array.isArray(planBounds)
    ? planBounds
    : null;
  if (!bounds) throw new TypeError('planBounds is required');
  const allowedWorkflowIds = Array.isArray(bounds.allowedWorkflowIds)
    ? bounds.allowedWorkflowIds.filter(id => isNonBlankString(id))
    : null;
  if (!allowedWorkflowIds || allowedWorkflowIds.length !== bounds.allowedWorkflowIds.length) {
    throw new TypeError('planBounds.allowedWorkflowIds must be an array of non-blank strings');
  }
  const maxTickets = assertPositiveSafeInteger(bounds.maxTickets, 'planBounds.maxTickets');

  if (!Array.isArray(delegatedUnits) || delegatedUnits.length === 0) {
    throw new TypeError('delegatedUnits must be a non-empty array');
  }
  if (delegatedUnits.length > maxTickets) {
    throw new TypeError('delegated unit set exceeds planBounds.maxTickets');
  }
  const units = delegatedUnits.map(unit => {
    if (!unit || typeof unit !== 'object' || Array.isArray(unit)) {
      throw new TypeError('delegatedUnits entries must be objects');
    }
    if (!isLiteralUnitKey(unit.unitKey)) {
      throw new TypeError('delegated unit entries require a literal unitKey');
    }
    const childWorkflowId = isNonBlankString(unit.childWorkflowId) ? unit.childWorkflowId : null;
    if (childWorkflowId === null) {
      throw new TypeError('delegated unit entries require a non-blank childWorkflowId');
    }
    const spawnIdempotencyKey = isNonBlankString(unit.spawnIdempotencyKey)
      ? unit.spawnIdempotencyKey
      : null;
    if (spawnIdempotencyKey === null) {
      throw new TypeError('delegated unit entries require a non-blank spawnIdempotencyKey');
    }
    // The recorded set is re-derived against the canonical delegated identity
    // so the durable fact is self-coherent before it can authorize anything.
    const derivedKey = buildDelegatedSpawnIdempotencyKey({
      parentTicketId,
      parentWorkflowId,
      spawnedByStepId: stepId,
      childWorkflowId,
      unitKey: unit.unitKey
    });
    if (derivedKey !== spawnIdempotencyKey) {
      throw new TypeError(
        `delegated unit entry diverges from the canonical delegated spawn identity: ${derivedKey}`);
    }
    return { unitKey: unit.unitKey, childWorkflowId, spawnIdempotencyKey };
  });

  const evidenceKey = buildDelegatedPlanAuthorizationEvidenceKey({ parentRunId, spawnPlanId: plan });
  return {
    evidenceKey,
    parentTicketId,
    parentRunId,
    parentWorkflowId,
    action: 'executeTicketPlan',
    stepId,
    spawnPlanId: plan,
    planBounds: { allowedWorkflowIds, maxTickets },
    delegatedUnits: units,
    ...(workflowContract && typeof workflowContract === 'object' && !Array.isArray(workflowContract)
      ? { workflowContract }
      : {})
  };
}

const ENUMERATION_STATES = Object.freeze({
  COMPLETE: 'COMPLETE',
  INCOMPLETE: 'INCOMPLETE'
});

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function isClaimedProvenanceValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  return true;
}

// Digit-string parent identity counts as claimed AND parseable, mirroring the
// accepted composer input shapes.
function parseParentTicketId(value) {
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  if (Number.isSafeInteger(value) && value > 0) return value;
  return null;
}

function isNonBlankString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// One record's classification within the child's complete provenance set.
//   PLAIN      — no spawn topology claim anywhere (truthful-absence evidence)
//   COHERENT   — full accepted spawn binding, resolvable to one parent id
//   MALFORMED  — at least one claim, but not the full accepted binding shape
function classifySpawnProvenanceRecord(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('provenance payload must be an object');
  }
  let malformedFields = [];
  let hasAnyClaim = false;
  for (const field of SPAWN_PROVENANCE_FIELDS) {
    if (isClaimedProvenanceValue(payload[field])) hasAnyClaim = true;
  }
  if (!hasAnyClaim) return { state: 'PLAIN' };

  const parentTicketId = parseParentTicketId(payload.parentTicketId);
  if (isClaimedProvenanceValue(payload.parentTicketId) && parentTicketId === null) {
    malformedFields.push('parentTicketId');
  } else if (parentTicketId === null) {
    malformedFields.push('parentTicketId:absent');
  }
  if (!isNonBlankString(payload.spawnIdempotencyKey)) {
    malformedFields.push(payload.spawnIdempotencyKey == null ||
      payload.spawnIdempotencyKey === ''
      ? 'spawnIdempotencyKey:absent'
      : 'spawnIdempotencyKey:blank-or-invalid');
  }
  const spawnPlanId = payload.spawnPlanId;
  const spawnPlanIdCoherent = typeof spawnPlanId === 'string'
    ? isNonBlankString(spawnPlanId)
    : Number.isSafeInteger(spawnPlanId) && spawnPlanId > 0;
  if (!spawnPlanIdCoherent) {
    malformedFields.push(spawnPlanId == null || spawnPlanId === ''
      ? 'spawnPlanId:absent'
      : 'spawnPlanId:blank-or-invalid');
  }

  if (malformedFields.length > 0) {
    return { state: 'MALFORMED', malformedFields };
  }
  return { state: 'COHERENT', parentTicketId };
}

// Validated view of one provenance record. `position` is the append-only
// event position (identity-grade, T4-I7); `id` is the originating event UUID.
function normalizeProvenanceRecord(record) {
  if (!record || typeof record !== 'object') {
    throw new TypeError('provenance record must be an object');
  }
  const position = record.position;
  if (!Number.isSafeInteger(position) || position <= 0) {
    throw new TypeError(`provenance record position must be a positive safe integer (${JSON.stringify(position)})`);
  }
  const id = typeof record.id === 'string' && record.id.length > 0 ? record.id : null;
  const classification = classifySpawnProvenanceRecord(record.payload);
  return { position, id, classification };
}

// Child-specific authoritative relationship resolution.
//
// Inputs:
//   childTicketId            — positive safe integer
//   records                  — the child's COMPLETE relevant provenance set
//                              (all its ticket.created records), ascending by
//                              position is enforced; duplicates refused
//   existingParentTicketIds  — Set of parent Ticket ids PROVEN to exist;
//                              required (never optional) so "does not exist"
//                              is always an explicit caller-provided fact
function resolveChildSpawnRelation({
  childTicketId,
  records,
  existingParentTicketIds
}) {
  assertPositiveSafeInteger(childTicketId, 'childTicketId');
  if (!(existingParentTicketIds instanceof Set)) {
    throw new TypeError('existingParentTicketIds must be a Set of positive safe integers');
  }
  if (!Array.isArray(records)) throw new TypeError('records must be an array');

  const seenPositions = new Set();
  const normalized = [];
  for (const record of records) {
    const entry = normalizeProvenanceRecord(record);
    if (seenPositions.has(entry.position)) {
      throw new TypeError(`duplicate provenance position ${entry.position}`);
    }
    seenPositions.add(entry.position);
    normalized.push(entry);
  }

  // Refusal precedence is fixed for determinism: malformed evidence outranks
  // multiplicity — refuse-not-choice before disambiguation is meaningful.
  const malformedEntries = normalized.filter(r => r.classification.state === 'MALFORMED');
  if (malformedEntries.length > 0) {
    const first = malformedEntries[0];
    return {
      outcome: 'REFUSED',
      reason: REFUSAL_REASONS.MALFORMED_SPAWN_PROVENANCE,
      childTicketId,
      originEvent: first.id === null ? { position: first.position } : { id: first.id, position: first.position },
      detail: { malformedFields: first.classification.malformedFields },
      applicableRecords: malformedEntries.map(r => ({ position: r.position }))
    };
  }

  const coherentEntries = normalized.filter(r => r.classification.state === 'COHERENT');
  if (coherentEntries.length > 1) {
    return {
      outcome: 'REFUSED',
      reason: REFUSAL_REASONS.MULTIPLE_APPLICABLE_PROVENANCE,
      childTicketId,
      originEvent: coherentEntries[0].id === null
        ? { position: coherentEntries[0].position }
        : { id: coherentEntries[0].id, position: coherentEntries[0].position },
      detail: {
        applicablePositions: coherentEntries.map(entry => entry.position)
      },
      applicableRecords: coherentEntries.map(r => ({ position: r.position }))
    };
  }

  if (coherentEntries.length === 0) {
    return { outcome: 'ABSENT', childTicketId };
  }

  const entry = coherentEntries[0];
  const parentTicketId = entry.classification.parentTicketId;
  if (!existingParentTicketIds.has(parentTicketId)) {
    return {
      outcome: 'REFUSED',
      reason: REFUSAL_REASONS.PARENT_TICKET_NOT_FOUND,
      childTicketId,
      parentTicketId,
      originEvent: entry.id === null ? { position: entry.position } : { id: entry.id, position: entry.position },
      applicableRecords: [{ position: entry.position }]
    };
  }

  // T4-I7: no identity is minted; the originating record supplies it.
  return {
    outcome: 'FACT',
    fact: {
      childTicketId,
      parentTicketId,
      kind: RELATIONSHIP_KIND,
      originEvent: entry.id === null ? { position: entry.position } : { id: entry.id, position: entry.position }
    }
  };
}

// Coherent parents referenced by a provenance set — the exact evidence a
// caller needs to batch a parent-existence query before resolving. Returns
// de-duplicated positive integer ids in ascending order.
function coherentProvenanceParentIds(records) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  const ids = [];
  for (const record of records) {
    const entry = normalizeProvenanceRecord(record);
    if (entry.classification.state === 'COHERENT') {
      ids.push(entry.classification.parentTicketId);
    }
  }
  return [...new Set(ids)].sort((a, b) => a - b);
}

// ── Parent-side enumeration composition (T4-I5) ──────────────────────────────
//
// PURE combination step. Caller pipeline (repository-owned):
//   1. candidate discovery — parent-indexed query over IMMUTABLE event
//      payloads (filtering only; candidates confer no authority);
//   2. per-candidate complete provenance retrieval + resolveChildSpawnRelation
//      against batched parent-existence evidence;
//   3. this combinator.
//
// COMPLETE means every attributable candidate resolved coherently (fact for
// the requested parent); any typed refusal flips the whole enumeration to
// INCOMPLETE while still carrying the proven facts alongside the refused
// child identities. Completeness lives HERE, not in callers noticing a
// non-empty refusal array.
//
// A resolution with outcome ABSENT is an impossible pipeline contradiction,
// not a domain state: combineSpawnEnumeration receives resolutions ONLY for
// children already discovered as candidates, and clean absence is expressed
// by the caller passing an empty candidate list — never by a discovered
// child "resolving" to absent. Encountering one means discovery and
// resolution disagreed about what was attributable, so this refuses loudly
// (a deterministic TypeError, NOT a new domain refusal code and NOT an
// INCOMPLETE corruption class). Legitimate no-children enumeration is
// represented by resolutions=[] producing COMPLETE with zero candidates.
function combineSpawnEnumeration({ parentTicketId, resolutions }) {
  assertPositiveSafeInteger(parentTicketId, 'parentTicketId');
  if (!Array.isArray(resolutions)) throw new TypeError('resolutions must be an array');

  const facts = [];
  const refused = [];
  let candidateCount = 0;

  for (const resolution of resolutions) {
    if (!resolution || typeof resolution !== 'object') {
      throw new TypeError('each resolution must be a resolver output object');
    }
    if (resolution.outcome === undefined &&
        resolution.fact && resolution.fact.childTicketId) {
      throw new TypeError('resolutions must come from resolveChildSpawnRelation outputs');
    }
    if (resolution.outcome === 'ABSENT') {
      // Pipeline contradiction: an undiscoverable child cannot appear inside
      // its own discovery. See the combinator contract above.
      throw new TypeError(
        'combineSpawnEnumeration received outcome ABSENT for child ' +
        `${resolution.childTicketId ?? '<unknown>'}: a discovered candidate can ` +
        'never resolve to absent; pass an empty candidate list instead');
    }
    if (resolution.outcome === 'FACT') {
      const fact = resolution.fact;
      if (!fact || fact.kind !== RELATIONSHIP_KIND) {
        throw new TypeError('resolution fact is not a T4 workflow-spawn fact');
      }
      assertPositiveSafeInteger(fact.childTicketId, 'fact.childTicketId');
      if (fact.parentTicketId !== parentTicketId) {
        // Unreachable when discovery attributes candidates by parent text
        // equality and resolutions used the same existence evidence. A miss
        // here is a caller bug, not a domain refusal: refuse loudly rather
        // than silently rename membership.
        throw new TypeError(
          `enumeration fact binds parent ${fact.parentTicketId}, requested ${parentTicketId}`);
      }
      candidateCount += 1;
      facts.push(fact);
      continue;
    }
    if (resolution.outcome === 'REFUSED') {
      const reason = resolution.reason;
      if (!Object.values(REFUSAL_REASONS).includes(reason)) {
        throw new TypeError(`unknown enumeration refusal reason: ${reason}`);
      }
      candidateCount += 1;
      refused.push({
        childTicketId: assertPositiveSafeInteger(resolution.childTicketId, 'refusal.childTicketId'),
        reason
      });
      continue;
    }
    throw new TypeError(`unknown resolution outcome: ${String(resolution.outcome)}`);
  }

  facts.sort((a, b) => a.childTicketId - b.childTicketId);
  refused.sort((a, b) => a.childTicketId - b.childTicketId);

  return {
    kind: RELATIONSHIP_KIND,
    parentTicketId,
    state: refused.length === 0 ? ENUMERATION_STATES.COMPLETE : ENUMERATION_STATES.INCOMPLETE,
    candidateCount,
    facts,
    refused
  };
}

module.exports = {
  RELATIONSHIP_KIND,
  SPAWN_PROVENANCE_FIELDS,
  REFUSAL_REASONS,
  ENUMERATION_STATES,
  classifySpawnProvenanceRecord,
  resolveChildSpawnRelation,
  coherentProvenanceParentIds,
  combineSpawnEnumeration,
  DELEGATION_SCHEME,
  DELEGATED_REFUSAL_REASONS,
  buildDelegatedSpawnIdempotencyKey,
  isLiteralUnitKey,
  resolveDelegatedSpawnRelation,
  DELEGATED_PLAN_AUTHORIZATION_EVENT_TYPE,
  DELEGATED_PLAN_AUTHORIZATION_REPLAY_KEY,
  buildDelegatedPlanAuthorizationEvidenceKey,
  buildDelegatedPlanAuthorizationEvidence
};
