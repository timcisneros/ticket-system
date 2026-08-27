'use strict';

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
  combineSpawnEnumeration
};
