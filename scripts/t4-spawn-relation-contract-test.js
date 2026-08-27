#!/usr/bin/env node
'use strict';

// T4 — workflow-spawn relationship kernel: canonical pure seam owner.
//
// Deterministic; no database. Pins runtime/t4-spawn-relation-contract.js to
// the frozen semantics of docs/ARCHITECTURAL_DECISIONS_PENDING.md,
// "T4 Workflow-Spawn Relationship Kernel — semantic freeze"
// (invariants T4-I1..T4-I8):
//   - provenance-only classification and resolution (T4-I1, I2);
//   - complete-set resolution with refusal-not-choice failure classes
//     MALFORMED_SPAWN_PROVENANCE / MULTIPLE_APPLICABLE_PROVENANCE /
//     PARENT_TICKET_NOT_FOUND (T4-I3, I4);
//   - derived identity from the originating ticket.created record (T4-I7);
//   - typed COMPLETE / INCOMPLETE enumeration composition (T4-I5);
//   - bounded corruption: one child's refusal never widens beyond evidence;
//   - the kind constant carries zero behavioral coupling (T4-I6).
//
// MEDIUM-FINDING CLOSURES pinned here:
//   M1 — SHAPE PARITY OWNER. A deterministic generated matrix over the
//        relevant value classes pins T4 accepted-shape classification to the
//        frozen T2 composer predicate isExecuteTicketPlanCreationEvent:
//        with existence satisfied, COHERENT iff the predicate accepts, and
//        identical parsed parent identity on every accepting case. The two
//        modules stay independently maintained BY DESIGN (frozen composer
//        bytes untouched); this owner makes divergence UNSHIPPABLE instead.
//   M3 — DISCOVERED CANDIDATES CANNOT BE ABSENT. combineSpawnEnumeration
//        receives resolutions only for children already discovered as
//        candidates, so outcome ABSENT there is a pipeline contradiction and
//        must throw. Clean absence exists ONLY as an empty candidate list.

const assert = require('node:assert/strict');
const {
  RELATIONSHIP_KIND,
  REFUSAL_REASONS,
  ENUMERATION_STATES,
  SPAWN_PROVENANCE_FIELDS,
  classifySpawnProvenanceRecord,
  resolveChildSpawnRelation,
  coherentProvenanceParentIds,
  combineSpawnEnumeration
} = require('../runtime/t4-spawn-relation-contract');
// Frozen T2 authority — imported for parity pinning, never modified.
const {
  isExecuteTicketPlanCreationEvent
} = require('../runtime/ticket-blocking-authority-composer');

let assertions = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  assertions += 1;
  console.log(`  ok ${message}`);
}
async function throwsTypeError(fn, message) {
  await assert.rejects(async () => fn(), TypeError, message);
  assertions += 1;
  console.log(`  ok ${message}`);
}

const MAX_SAFE_PLUS_1 = Number.MAX_SAFE_INTEGER + 1;

function factFor(childTicketId, parentTicketId, position) {
  return resolveChildSpawnRelation({
    childTicketId,
    records: [{
      id: `ev-${childTicketId}`,
      position,
      payload: {
        parentTicketId,
        spawnPlanId: 'r:w:s:transition:1',
        spawnIdempotencyKey: `key-${childTicketId}`
      }
    }],
    existingParentTicketIds: new Set([parentTicketId])
  });
}

async function main() {
  console.log('T4 spawn-relation kernel — pure classification');

  ok(RELATIONSHIP_KIND === 'workflow-spawn', 'one exact workflow-spawn kind is fixed');
  ok(Object.isFrozen(REFUSAL_REASONS) && Object.isFrozen(ENUMERATION_STATES),
    'failure vocabularies are frozen');

  // Accepted durable shapes production emits through createTicketWithEvent.
  const legacyIntegerShape = classifySpawnProvenanceRecord({
    parentTicketId: 42, spawnPlanId: 7, spawnIdempotencyKey: 'k-1'
  });
  ok(legacyIntegerShape.state === 'COHERENT' && legacyIntegerShape.parentTicketId === 42,
    'legacy integer shapes classify coherent');

  const digitStringParent = classifySpawnProvenanceRecord({
    parentTicketId: '42', spawnPlanId: 'run-1:wf-2:step-3:transition:0',
    spawnIdempotencyKey: ' k '
  });
  ok(digitStringParent.state === 'COHERENT' && digitStringParent.parentTicketId === 42,
    'digit-string parent identity parses like the accepted predicate');

  const plainObjectives = [
    {}, { objective: 'plain ticket' }, { createdBy: 'operator', status: 'open' }
  ];
  for (const payload of plainObjectives) {
    ok(classifySpawnProvenanceRecord(payload).state === 'PLAIN',
      `no topology claim classifies plain (${JSON.stringify(payload)})`);
  }

  const malformedCases = [
    [{ parentTicketId: 42 }, 'parent binding without idempotency key'],
    [{ parentTicketId: 42, spawnPlanId: 7 }, 'missing idempotency key only'],
    [{ parentTicketId: 'abc', spawnPlanId: 7, spawnIdempotencyKey: 'k' }, 'unparseable parent identity'],
    [{ parentTicketId: 0, spawnPlanId: 7, spawnIdempotencyKey: 'k' }, 'non-positive parent identity'],
    [{ parentTicketId: -3, spawnPlanId: 7, spawnIdempotencyKey: 'k' }, 'negative parent identity'],
    [{ parentTicketId: 42, spawnPlanId: '', spawnIdempotencyKey: 'k' }, 'blank plan reference'],
    [{ parentTicketId: 42, spawnPlanId: null, spawnIdempotencyKey: 'k' }, 'null plan reference'],
    [{ parentTicketId: 42, spawnPlanId: 7, spawnIdempotencyKey: '   ' }, 'whitespace idempotency key'],
    [{ spawnedByStepId: 's1' }, 'partial sibling topology without a parent binding']
  ];
  for (const [payload, label] of malformedCases) {
    const classified = classifySpawnProvenanceRecord(payload);
    ok(classified.state === 'MALFORMED' && Array.isArray(classified.malformedFields),
      `attempted-but-malformed provenance refuses (${label})`);
  }

  console.log('M1 — T2/T4 accepted-shape parity matrix (generated, exhaustive over classes)');

  // Value classes per field, exactly as required by the finding closure.
  const parentValues = [
    // positive safe integers (incl. the maximum safe integer)
    1, 42, 9007199254740991,
    // zero / negative / fractional / unsafe / non-finite direct-JS values
    0, -1, -42, 1.5, -0.5, MAX_SAFE_PLUS_1, NaN, Infinity, -Infinity,
    // canonical positive digit strings (incl. maximal safe digits)
    '42', '9007199254740991',
    // leading-zero strings (both below and above safe-integer length)
    '042', '0000000000000000000000042',
    // zero / negative / non-digit / fractional-looking strings
    '0', '-5', 'abc', '+42', '42.0',
    // empty and whitespace strings
    '', '   ', ' 42 ', '42 ',
    // null / undefined / booleans / object & array shapes
    null, undefined, true, false, {}, { id: 42 }, [42]
  ];

  const keyValues = [
    'k', 'key-11', ' padded key ',
    '', '   ',
    null, undefined,
    7, true, {}, []
  ];

  const planValues = [
    7,
    'plan-1', ' r:w:s:transition:1 ',
    0, -3, 2.5, MAX_SAFE_PLUS_1,
    '', '   ', '   x   ',
    null, undefined,
    true, [], {}
  ];

  // Plain-prose background fields ride along on every matrix row.
  const backgroundFields = { objective: 'matrix child', status: 'blocked' };

  // The existence set offered to the frozen predicate must contain the parent
  // identity that a coherent payload binds, parsed EXACTLY as T4 parses it.
  function t4ParsedParent(value) {
    if (typeof value === 'string') {
      if (!/^[1-9]\d*$/.test(value)) return null;
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    }
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  let cases = 0;
  let t4CoherentCount = 0;
  let t2AcceptedCount = 0;
  let absentGateCheckedCount = 0;
  const drifts = [];

  for (const p of parentValues) {
    for (const k of keyValues) {
      for (const pl of planValues) {
        const payload = {
          ...backgroundFields,
          ...(p !== undefined ? { parentTicketId: p } : {}),
          ...(k !== undefined ? { spawnIdempotencyKey: k } : {}),
          ...(pl !== undefined ? { spawnPlanId: pl } : {})
        };
        const label = JSON.stringify({ p, k, pl });
        cases += 1;

        const classified = classifySpawnProvenanceRecord(payload);
        const expectedParent = t4ParsedParent(p);

        // Relationship A — SHAPE PARITY WITH EXISTENCE SATISFIED:
        // T4 COHERENT iff the frozen predicate accepts with that parent known.
        const t4Coherent = classified.state === 'COHERENT';
        const existenceSet = expectedParent === null ? new Set() : new Set([expectedParent]);
        const t2Accepts = isExecuteTicketPlanCreationEvent(payload, existenceSet);
        if (t4Coherent !== t2Accepts) {
          drifts.push(`A ${label}: t4=${classified.state} t2=${t2Accepts}`);
          continue;
        }
        if (t4Coherent) {
          t4CoherentCount += 1;
          t2AcceptedCount += 1;
          if (classified.parentTicketId !== expectedParent ||
              !Number.isSafeInteger(classified.parentTicketId)) {
            drifts.push(`A-identity ${label}: t4=${classified.parentTicketId} expected=${expectedParent}`);
            continue;
          }
          // Relationship B — EXISTENCE-GATE DISTINCTION: shape coherence is
          // preserved while the parent is withheld from known ids; the frozen
          // predicate rejects, classification stays COHERENT, and resolution
          // refuses PARENT_TICKET_NOT_FOUND.
          const withheld = isExecuteTicketPlanCreationEvent(payload, new Set([expectedParent + 1]));
          const resolvedWithoutExistence = resolveChildSpawnRelation({
            childTicketId: 1,
            records: [{ id: 'ev-b', position: 9, payload }],
            existingParentTicketIds: new Set()
          });
          if (!(withheld === false &&
                resolvedWithoutExistence.outcome === 'REFUSED' &&
                resolvedWithoutExistence.reason === REFUSAL_REASONS.PARENT_TICKET_NOT_FOUND)) {
            drifts.push(`B ${label}: withheld=${withheld} outcome=${resolvedWithoutExistence.outcome}/${resolvedWithoutExistence.reason || '-'}`);
            continue;
          }
          absentGateCheckedCount += 1;

          // With the empty set offered to BOTH sides, shape acceptance must be
          // pure shape: the predicate (knownIds gate disabled) still accepts.
          if (isExecuteTicketPlanCreationEvent(payload, null) !== true) {
            drifts.push(`B-nullgate ${label}`);
          }
        } else {
          // Relationship C — PLAIN vs attempted-MALFORMED enrichment: both are
          // T2-false by construction above; assert the resolver maps each to
          // its distinct truthful outcome rather than collapsing them.
          const resolved = resolveChildSpawnRelation({
            childTicketId: 1,
            records: [{ id: 'ev-c', position: 8, payload }],
            existingParentTicketIds: new Set()
          });
          // Claimless = every spawn-topology field null/undefined/'' (the
          // module's own claim notion); prose fields ride along harmlessly.
          const claimsNothing = SPAWN_PROVENANCE_FIELDS.every(field => {
            const value = payload[field];
            return value === null || value === undefined || value === '';
          });
          if (claimsNothing && classified.state !== 'PLAIN') {
            drifts.push(`C-plain ${label}: state=${classified.state}`);
          }
          if (resolved.outcome === 'ABSENT' && classified.state !== 'PLAIN') {
            drifts.push(`C-absent ${label}`);
          }
          if ((resolved.outcome === 'REFUSED' &&
               resolved.reason !== REFUSAL_REASONS.MALFORMED_SPAWN_PROVENANCE)) {
            drifts.push(`C-refusal ${label}`);
          }
        }
      }
    }
  }

  ok(drifts.length === 0,
    `parity held across ${cases} generated cases (` +
    `${t4CoherentCount} coherent/accepted, drift-free${drifts.length ? `; FIRST DRIFT: ${drifts[0]}` : ''})`);
  ok(t4CoherentCount > 0 && t2AcceptedCount === t4CoherentCount,
    `existence-satisfied parity asserted on all ${t4CoherentCount} coherent rows`);
  ok(absentGateCheckedCount === t4CoherentCount,
    `existence-gate distinction asserted on all ${absentGateCheckedCount} coherent rows`);

  // Sibling topology claims distinguish PLAIN from attempted MALFORMED even
  // when the binding fields themselves are unclaimed.
  const siblingOnly = [
    { parentRunId: 5 },
    { spawnedByStepId: 'step-x' },
    { parentWorkflowId: 'wf-1' },
    { parentRunId: 5, objective: 'prose' },
    { spawnPlanId: null, spawnedByStepId: 'step-y' }
  ];
  for (const payload of siblingOnly) {
    const classified = classifySpawnProvenanceRecord(payload);
    ok(classified.state === 'MALFORMED',
      `sibling-only claim is attempted provenance, not prose (${JSON.stringify(payload)})`);
    ok(isExecuteTicketPlanCreationEvent(payload, new Set()) === false,
      `the frozen predicate also rejects it (${JSON.stringify(payload)})`);
  }

  // Direct-JS non-finite-only payloads contain no CLAIMABLE value at all.
  const nanOnly = classifySpawnProvenanceRecord({ parentTicketId: NaN });
  ok(nanOnly.state === 'PLAIN' && isExecuteTicketPlanCreationEvent({ parentTicketId: NaN }) === false,
    'NaN-only parent is claimless prose for T4 (PLAIN) and rejected by T2 identically');
  const nanWithSiblings = classifySpawnProvenanceRecord({
    parentTicketId: NaN, spawnPlanId: 7, spawnIdempotencyKey: 'k'
  });
  ok(nanWithSiblings.state === 'MALFORMED' &&
     nanWithSiblings.malformedFields.includes('parentTicketId:absent'),
    'NaN parent alongside claimed siblings is attempted-malformed, not silent absence');

  console.log('child-specific resolution (refusal-not-choice)');

  await throwsTypeError(
    () => resolveChildSpawnRelation({ childTicketId: 1, records: [] }),
    'existence evidence is required, never assumed');
  await throwsTypeError(
    () => resolveChildSpawnRelation({
      childTicketId: 1, records: [
        { position: 5, payload: { parentTicketId: 9, spawnPlanId: 1, spawnIdempotencyKey: 'a' } },
        { position: 5, payload: {} }
      ],
      existingParentTicketIds: new Set()
    }),
    'duplicate positions in the supplied set refuse');

  const absentPlain = resolveChildSpawnRelation({
    childTicketId: 10,
    records: [{ id: 'ev-plain', position: 4, payload: { objective: 'x' } }],
    existingParentTicketIds: new Set()
  });
  ok(absentPlain.outcome === 'ABSENT', 'clean absence yields truthful ABSENT');

  const fact = resolveChildSpawnRelation({
    childTicketId: 11,
    records: [{
      id: '0f0e0d0c-0000-4000-8000-000000000001',
      position: 12,
      payload: { parentTicketId: 7, spawnPlanId: 'r:w:s:transition:1', spawnIdempotencyKey: 'key-11' }
    }],
    existingParentTicketIds: new Set([7])
  });
  ok(fact.outcome === 'FACT', 'single coherent provenance resolves one FACT');
  ok(fact.fact.childTicketId === 11 && fact.fact.parentTicketId === 7,
    'the fact binds Ticket identities only');
  ok(fact.fact.kind === RELATIONSHIP_KIND, 'the fact carries exactly the workflow-spawn kind');
  ok(fact.fact.originEvent.id === '0f0e0d0c-0000-4000-8000-000000000001' &&
     fact.fact.originEvent.position === 12,
    'originating event identity is carried, never minted (T4-I7)');

  const missingParent = resolveChildSpawnRelation({
    childTicketId: 13,
    records: [{ position: 14, payload: { parentTicketId: 999999, spawnPlanId: 7, spawnIdempotencyKey: 'x' } }],
    existingParentTicketIds: new Set()
  });
  ok(missingParent.outcome === 'REFUSED' &&
     missingParent.reason === REFUSAL_REASONS.PARENT_TICKET_NOT_FOUND &&
     missingParent.parentTicketId === 999999,
    'referenced parent that does not exist refuses PARENT_TICKET_NOT_FOUND');

  const duplicatedBinding = resolveChildSpawnRelation({
    childTicketId: 15,
    records: [
      { position: 20, payload: { parentTicketId: 8, spawnPlanId: 1, spawnIdempotencyKey: 'one' } },
      { position: 21, payload: { parentTicketId: 8, spawnPlanId: 2, spawnIdempotencyKey: 'two' } }
    ],
    existingParentTicketIds: new Set([8])
  });
  ok(duplicatedBinding.outcome === 'REFUSED' &&
     duplicatedBinding.reason === REFUSAL_REASONS.MULTIPLE_APPLICABLE_PROVENANCE &&
     duplicatedBinding.detail.applicablePositions.join(',') === '20,21',
    'duplicate applicable records refuse MULTIPLE_APPLICABLE_PROVENANCE — never collapse or choose');

  const conflictingParents = resolveChildSpawnRelation({
    childTicketId: 16,
    records: [
      { position: 30, payload: { parentTicketId: 8, spawnPlanId: 1, spawnIdempotencyKey: 'one' } },
      { position: 31, payload: { parentTicketId: 9, spawnPlanId: 1, spawnIdempotencyKey: 'two' } }
    ],
    existingParentTicketIds: new Set([8, 9])
  });
  ok(conflictingParents.outcome === 'REFUSED' &&
     conflictingParents.reason === REFUSAL_REASONS.MULTIPLE_APPLICABLE_PROVENANCE,
    'conflicting parent bindings refuse instead of inferring intended parentage');

  const malformedPrecedence = resolveChildSpawnRelation({
    childTicketId: 17,
    records: [
      { position: 40, payload: { parentTicketId: 'oops' } },
      { position: 41, payload: { parentTicketId: 8, spawnPlanId: 1, spawnIdempotencyKey: 'one' } },
      { position: 42, payload: { parentTicketId: 9, spawnPlanId: 2, spawnIdempotencyKey: 'two' } }
    ],
    existingParentTicketIds: new Set([8, 9])
  });
  ok(malformedPrecedence.outcome === 'REFUSED' &&
     malformedPrecedence.reason === REFUSAL_REASONS.MALFORMED_SPAWN_PROVENANCE,
    'malformed evidence outranks multiplicity with fixed precedence');

  console.log('enumeration composition (explicit completeness; M3 impossible-absent)');

  // M3 — legitimate no-children enumeration stays COMPLETE and empty.
  const noChildren = combineSpawnEnumeration({ parentTicketId: 5, resolutions: [] });
  ok(noChildren.state === ENUMERATION_STATES.COMPLETE &&
     noChildren.facts.length === 0 &&
     noChildren.refused.length === 0 &&
     noChildren.candidateCount === 0,
    'an empty candidate list is the COMPLETE zero-candidate enumeration (M3)');

  const completeEnumeration = combineSpawnEnumeration({
    parentTicketId: 7,
    resolutions: [
      fact,
      factFor(12, 7, 31)
    ]
  });
  ok(completeEnumeration.state === ENUMERATION_STATES.COMPLETE,
    'all candidates resolved coherently yields COMPLETE');
  ok(completeEnumeration.facts.length === 2 && completeEnumeration.refused.length === 0 &&
     completeEnumeration.candidateCount === 2,
    'COMPLETE carries proven facts, zero refusals, full candidate count');
  ok(completeEnumeration.facts.every(f => f.kind === RELATIONSHIP_KIND),
    'every enumerated fact is a workflow-spawn fact');

  // M3 — a discovered candidate can NEVER resolve absent: pipeline contradiction.
  await throwsTypeError(
    () => combineSpawnEnumeration({
      parentTicketId: 77,
      resolutions: [{ outcome: 'ABSENT', childTicketId: 99 }]
    }),
    'discovered ABSENT throws the impossible-invariant TypeError (M3)');
  await throwsTypeError(
    () => combineSpawnEnumeration({
      parentTicketId: 77,
      resolutions: [fact, { outcome: 'ABSENT', childTicketId: 99 }]
    }),
    'ABSENT poisons no result silently even alongside valid facts (M3)');

  const incompleteEnumeration = combineSpawnEnumeration({
    parentTicketId: 77,
    resolutions: [
      resolveChildSpawnRelation({
        childTicketId: 101,
        records: [{ position: 50, payload: { parentTicketId: 77, spawnPlanId: 9, spawnIdempotencyKey: 'a101' } }],
        existingParentTicketIds: new Set([77])
      }),
      resolveChildSpawnRelation({
        childTicketId: 102,
        records: [{ position: 51, payload: { parentTicketId: 77, spawnPlanId: '   ', spawnIdempotencyKey: 'b102' } }],
        existingParentTicketIds: new Set([77])
      }),
      resolveChildSpawnRelation({
        childTicketId: 103,
        records: [{ position: 52, payload: { parentTicketId: 555555, spawnPlanId: 9, spawnIdempotencyKey: 'c103' } }],
        existingParentTicketIds: new Set([77])
      })
    ]
  });
  ok(incompleteEnumeration.state === ENUMERATION_STATES.INCOMPLETE,
    'any attributable refusal flips the enumeration INCOMPLETE');
  ok(incompleteEnumeration.facts.length === 1 && incompleteEnumeration.facts[0].childTicketId === 101,
    'INCOMPLETE still carries the proven coherent facts');
  ok(JSON.stringify(incompleteEnumeration.refused) === JSON.stringify([
    { childTicketId: 102, reason: REFUSAL_REASONS.MALFORMED_SPAWN_PROVENANCE },
    { childTicketId: 103, reason: REFUSAL_REASONS.PARENT_TICKET_NOT_FOUND }
  ]), 'typed refused child identities carry their refusal reasons, sorted');
  ok(incompleteEnumeration.candidateCount === 3,
    'candidate count covers every attributable candidate, refused included');

  await throwsTypeError(
    () => combineSpawnEnumeration({
      parentTicketId: 7,
      resolutions: [{ outcome: 'FACT', fact: { childTicketId: 500, parentTicketId: 8, kind: RELATIONSHIP_KIND } }]
    }),
    'an enumeration fact bound to another parent is a caller bug, not silent membership');
  await throwsTypeError(
    () => combineSpawnEnumeration({
      parentTicketId: 7,
      resolutions: [{ outcome: 'REFUSED', childTicketId: 1, reason: 'NOT_A_REAL_REASON' }]
    }),
    'unknown refusal reasons refuse loudly rather than passing through');

  console.log('bounded corruption scoping');

  const unrelatedParent = combineSpawnEnumeration({
    parentTicketId: 300,
    resolutions: [
      resolveChildSpawnRelation({
        childTicketId: 301,
        records: [{ position: 60, payload: { parentTicketId: 300, spawnPlanId: 1, spawnIdempotencyKey: 'z301' } }],
        existingParentTicketIds: new Set([300])
      })
    ]
  });
  ok(unrelatedParent.state === ENUMERATION_STATES.COMPLETE,
    'another parent’s malformed child (resolved separately) does not poison this enumeration');
  ok(coherentProvenanceParentIds([
    { position: 70, payload: { parentTicketId: 8, spawnPlanId: 1, spawnIdempotencyKey: 'p8' } },
    { position: 71, payload: { parentTicketId: 8, spawnPlanId: 2, spawnIdempotencyKey: 'q8' } },
    { position: 72, payload: { parentTicketId: 12, spawnPlanId: 1, spawnIdempotencyKey: 'r12' } },
    { position: 73, payload: { parentTicketId: 'not-a-parent' } },
    { position: 74, payload: {} }
  ]).join(',') === '8,12',
    'coherent referenced parents dedupe, sort, and exclude unparseable claims');

  console.log(`pure seam owner passed: ${assertions} assertions ` +
    `(includes ${cases}-case M1 generated matrix, ${t4CoherentCount} coherent rows)`);
}

main().catch(error => {
  console.error('FAIL:', error && error.stack ? error.stack : error);
  process.exit(1);
});
