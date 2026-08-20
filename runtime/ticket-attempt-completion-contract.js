'use strict';

// Shared Ticket-attempt completion authority evaluator.
//
// This module extracts the canonical completion / attempt-disposition decision
// logic that currently lives inline inside transitionTicketAfterRun
// (persistence/postgres/store.js). The evaluator is the SHARED RULE between
// future cancellation authority and existing settlement: both paths produce
// exactly the same verdict given the same inputs.
//
// The evaluator is pure: it does not write, it does not lock, it does not
// inspect topology. The inputs are durable evidence already locked by the
// caller.
//
// Decision semantics (preserved verbatim from the inline owner):
//   - per-member projected disposition via evaluateRunCompletionEvidence
//     (not_applicable / valid / missing / stale / authority_mismatch / conflicts_with_run)
//   - aggregate via deriveTicketAttemptDisposition
//     (blocked > failed > interrupted > completed)
//   - non-terminal member -> evaluator returns null (settlement must wait)

const { evaluateRunCompletionEvidence } = require('./structured-allocation-leaf-run-contract');
const { deriveTicketAttemptDisposition } = require('./ticket-attempt-contract');

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'interrupted']);

class AttemptCompletionAuthorityError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'AttemptCompletionAuthorityError';
    this.code = code;
  }
}

function positiveSafeInteger(value, label) {
  const parsed = typeof value === 'string' && /^[1-9]\d*$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AttemptCompletionAuthorityError(
      'ATTEMPT_COMPLETION_AUTHORITY_INVALID',
      `${label} must be a positive safe integer`
    );
  }
  return parsed;
}

// Map a single member Run to its projected disposition using the same rule that
// the inline settlement path uses (store.js:9226-9278). Behavior is preserved
// verbatim.
//
// Inputs:
//   member: { id, ticketId, status, completionAuthoritySnapshot }
//   decision: normalized completion decision (or null)
//
// Returns: 'completed' | 'failed' | 'blocked' | 'interrupted'
// Throws: COMPLETION_EVIDENCE_MISSING when evidence is missing or
//         authority-mismatched (same error code as inline).
function projectedMemberDisposition(member, decision) {
  if (!member || !member.completionAuthoritySnapshot) {
    // Generic Run: no structured completion authority, projection is the
    // materialized status. Matches inline behavior at store.js:9227-9231.
    if (member.status === 'completed') return 'completed';
    if (member.status === 'interrupted') return 'interrupted';
    return 'failed';
  }

  // The shared completion rule is invoked with the run's completion-authority
  // hash. This is exactly what the inline owner passes at store.js:9255-9262.
  const evidence = evaluateRunCompletionEvidence({
    runStatus: member.status,
    runId: member.id,
    runTicketId: member.ticketId,
    runCompletionAuthorityHash:
      member.completionAuthoritySnapshot.objectiveContractHash || null,
    decision: decision || null
  });

  if (evidence.result === 'not_applicable') {
    // A Run that never claimed success is truthfully itself.
    // Matches inline behavior at store.js:9263-9266.
    return member.status === 'interrupted' ? 'interrupted' : 'failed';
  }

  if (evidence.result !== 'valid') {
    // Mirrors inline behavior at store.js:9267-9274.
    const error = new Error(
      `Run ${member.id} cannot project its ticket: ${evidence.reason}`);
    error.code = 'COMPLETION_EVIDENCE_MISSING';
    error.completionEvidenceResult = evidence.result;
    error.completionEvidenceReason = evidence.reason;
    throw error;
  }

  if (decision.completionDisposition === 'completed') return 'completed';
  if (decision.completionDisposition === 'blocked') return 'blocked';
  // Fallback matches inline behavior at store.js:9277.
  return member.status === 'interrupted' ? 'interrupted' : 'failed';
}

// Compute the projected attempt disposition from per-member evidence.
//
// Inputs:
//   memberRuns: array of { id, ticketId, status, completionAuthoritySnapshot }
//   completionDecisionByRunId: Map<runId, normalized completion decision>
//
// Returns:
//   {
//     memberDispositions: array of 'completed'|'failed'|'blocked'|'interrupted'
//     candidateDisposition: 'completed'|'failed'|'blocked'|'interrupted'
//     allTerminal: boolean
//   }
//   OR null when at least one member is not terminal — callers must wait.
//
// Throws: COMPLETION_EVIDENCE_MISSING when a member's evidence is missing or
//         authority-mismatched (semantics preserved from inline).
function evaluateAttemptCompletionAuthority(memberRuns, completionDecisionByRunId) {
  if (!Array.isArray(memberRuns) || memberRuns.length === 0) {
    throw new AttemptCompletionAuthorityError(
      'ATTEMPT_COMPLETION_AUTHORITY_INVALID',
      'evaluateAttemptCompletionAuthority requires a non-empty member array'
    );
  }
  if (!(completionDecisionByRunId instanceof Map)) {
    throw new AttemptCompletionAuthorityError(
      'ATTEMPT_COMPLETION_AUTHORITY_INVALID',
      'completionDecisionByRunId must be a Map<runId, completion decision>'
    );
  }

  // Pre-check: every member must be terminal. Non-terminal members mean
  // settlement must wait. Matches inline guard at store.js:9284-9293.
  const allTerminal = memberRuns.every(member => TERMINAL_RUN_STATUSES.has(member.status));
  if (!allTerminal) {
    return null;
  }

  // Per-member projection. Order matches the input order (the inline owner
  // maps over batchRuns in the order the SQL ORDER BY id produced).
  const memberDispositions = memberRuns.map(member => {
    const decision = completionDecisionByRunId.get(member.id) || null;
    return projectedMemberDisposition(member, decision);
  });

  // Aggregate via the existing derivation.
  const candidateDisposition = deriveTicketAttemptDisposition(memberDispositions);

  return Object.freeze({
    memberDispositions: Object.freeze([...memberDispositions]),
    candidateDisposition,
    allTerminal: true
  });
}

// Validate that one specific routed terminal member can be projected under
// completion authority. The inline owner runs this as a precondition for the
// batch projection (store.js:9283). It throws COMPLETION_EVIDENCE_MISSING
// when the member's evidence is missing or authority-mismatched. Tranche 1
// reuses the same call so existing inline behavior is preserved.
function validateRoutedMemberProjection(member, decision) {
  projectedMemberDisposition(member, decision);
}

module.exports = {
  AttemptCompletionAuthorityError,
  evaluateAttemptCompletionAuthority,
  projectedMemberDisposition,
  validateRoutedMemberProjection
};
