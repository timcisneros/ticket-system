'use strict';

// Tranche 6 — how fixture and live evidence combine into ONE final decision.
//
// The two are separate evidence classes and their trials are never pooled into
// one denominator: fixture is architecture and integrity evidence, live is
// task-performance evidence. Combining raw denominators would let 200 hermetic
// trials outvote 120 live ones on a question hermetic trials cannot answer.
//
// This contract was written BEFORE any live result existed.

const VETO = 'hard_disqualifier_veto';

function combineEvidence({ fixture, live }) {
  if (!fixture) throw new Error('fixture evidence is required');

  const vetoes = [];
  // A fixture hard disqualifier is a VETO that live evidence may not rescue.
  if (fixture.hardDisqualifierTriggered === true) {
    vetoes.push({ source: 'fixture', kind: VETO });
  }
  if (live && live.hardDisqualifierTriggered === true) {
    vetoes.push({ source: 'live', kind: VETO });
  }
  if (vetoes.length > 0) {
    return Object.freeze({
      finalProductDecision: 'STOP',
      rationale: 'a hard disqualifier triggered; ordinary gains cannot rescue it',
      vetoes: Object.freeze(vetoes),
      reversalConditionStatus: 'not_applicable_under_veto'
    });
  }

  // NOT EVALUABLE is neither a veto nor a clearance. It is carried forward as
  // an explicit gap rather than being read as either.
  const notEvaluable = [
    ...(fixture.hardDisqualifiersNotEvaluable || []).map(s => ({ source: 'fixture', statement: s })),
    ...((live && live.hardDisqualifiersNotEvaluable) || []).map(s => ({ source: 'live', statement: s }))
  ];

  // The live corpus must be COMPLETE before any final decision.
  if (!live) {
    return Object.freeze({
      finalProductDecision: 'NOT YET DECIDABLE',
      rationale: 'live evidence is mandatory before the final product decision, ' +
        'and no live corpus exists',
      vetoes: Object.freeze([]),
      notEvaluable: Object.freeze(notEvaluable),
      reversalConditionStatus: 'live_evidence_absent'
    });
  }
  if (live.corpusComplete !== true) {
    return Object.freeze({
      finalProductDecision: 'NOT YET DECIDABLE',
      rationale: 'the live corpus is incomplete; a final decision may not be ' +
        'computed from a partial corpus',
      vetoes: Object.freeze([]),
      notEvaluable: Object.freeze(notEvaluable),
      reversalConditionStatus: 'live_corpus_incomplete'
    });
  }

  // With no veto, the LIVE ordinary result decides — including reversing a
  // fixture ordinary STOP, but only through the SAME frozen RETAIN rule. There
  // is no lower bar just because the fixture corpus was non-discriminating.
  const liveOrdinary = live.ordinaryDecision;
  const reversal = fixture.ordinaryDecision === 'STOP' && liveOrdinary === 'RETAIN'
    ? 'fixture ordinary STOP reversed by live evidence satisfying the frozen RETAIN rule'
    : 'no reversal applied';
  return Object.freeze({
    finalProductDecision: liveOrdinary,
    rationale: 'no hard disqualifier; the live corpus is task-performance ' +
      'evidence and its ordinary result applies the already-frozen rules',
    vetoes: Object.freeze([]),
    notEvaluable: Object.freeze(notEvaluable),
    reversalConditionStatus: reversal,
    // The two metric tables stay separate in the report; nothing here merges them.
    metricReporting: 'fixture and live metrics are reported separately and never pooled'
  });
}

module.exports = { VETO, combineEvidence };
