'use strict';

// ── Production-owned executeTicketPlan child construction seam ──────────────
//
// This module is the ONE repository definition of the bytes that the
// sanctioned workflow-spawn producer writes: the child Ticket draft and the
// append-only `ticket.created` event payload emitted by
// createChildWorkflowTicketFromPlan -> store.createTicketWithEvent.
//
// Why it exists. The T4 relationship kernel reads spawn authority from those
// event bytes, so a test fixture that re-describes them would be a SECOND
// producer definition free to drift from production — exactly the defect
// class implementation review flagged (M2). Server code and tests therefore
// both consume this builder; neither owns its own copy of the shape.
//
// Scope discipline: this is an extraction, not a redesign. The bytes below
// are moved verbatim from the pre-extraction producer body; no field is
// added, dropped, reordered semantically, or recomputed. Persistence stays in
// the existing createTicketWithEvent writer; there is NO new writer and NO
// persistence authority here. Execution-policy semantics remain owned by the
// existing canonical Ticket execution-policy normalization: this builder does
// NOT derive, copy or freeze any default — it receives the already-resolved
// policy from its caller and stamps that supplied value into the draft
// unchanged. Relationship/event construction owns no policy defaults, so a
// legitimate future change to the canonical normalizer automatically flows
// into newly spawned workflow children exactly as it did before extraction.
//
// The spawned child keeps status 'blocked' with zero attempts: admission-hold
// authority remains exactly where the frozen T2 composer owns it.

function requiredSpawnPlanId(value) {
  // Both durable shapes the runtime lineage has emitted are accepted here:
  // the legacy positive integer and the non-blank composite reference.
  if (typeof value === 'string' && value.length > 0) return value;
  if (Number.isSafeInteger(value) && value > 0) return value;
  throw new TypeError('spawnPlanId must be a non-blank string or positive safe integer');
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} is required for child workflow ticket construction`);
  }
  return value;
}

function requiredId(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer for child workflow ticket construction`);
  }
  return value;
}

// Pure derivation of one production spawn's durable bytes.
//
//   run        — { id, ticketId, agentId }      (the admitted parent Run)
//   workflow   — { id }                         (the parent workflow catalog row)
//   step       — { id }                         (the spawning workflow step)
//   planTicket — { objective, workflowId, workflowInput, reason, idempotencyKey }
//                (the validated accepted plan item)
//   spawnPlanId — composite `${run.id}:${workflow.id}:${step.id}:transition:${n}`
//   executionPolicy — the ALREADY-RESOLVED Ticket execution policy, resolved by
//                the caller through the canonical normalizer. This builder is
//                not a policy owner and stamps the supplied value verbatim.
function buildChildWorkflowTicketCreation({
  run,
  workflow,
  step,
  planTicket,
  spawnPlanId,
  executionPolicy
}) {
  if (!run || typeof run !== 'object') throw new TypeError('run is required');
  if (!workflow || typeof workflow !== 'object') throw new TypeError('workflow is required');
  if (!step || typeof step !== 'object') throw new TypeError('step is required');
  if (!planTicket || typeof planTicket !== 'object') throw new TypeError('planTicket is required');

  const parentRunId = requiredId(run.id, 'run.id');
  const parentTicketId = requiredId(run.ticketId, 'run.ticketId');
  const assignmentTargetId = requiredId(run.agentId, 'run.agentId');
  const parentWorkflowId = requiredString(workflow.id, 'workflow.id');
  const spawnedByStepId = requiredString(step.id, 'step.id');
  const objective = requiredString(planTicket.objective, 'planTicket.objective');
  const childWorkflowId = requiredString(planTicket.workflowId, 'planTicket.workflowId');
  const spawnIdempotencyKey = requiredString(planTicket.idempotencyKey, 'planTicket.idempotencyKey');
  const planReference = requiredSpawnPlanId(spawnPlanId);
  void planReference;

  const now = new Date().toISOString();
  const ticketDraft = {
    objective,
    status: 'blocked',
    blockedReason: 'Created by executeTicketPlan; child workflow execution is not automatic in v1.',
    assignmentTargetType: 'agent',
    assignmentTargetId,
    assignmentMode: 'individual',
    executionMode: 'workflow',
    workflowId: childWorkflowId,
    workflowInput: planTicket.workflowInput,
    capabilityType: 'workflow',
    capabilityId: childWorkflowId,
    capabilityInput: planTicket.workflowInput,
    executionPolicy,
    parentTicketId,
    parentRunId,
    parentWorkflowId,
    spawnedByStepId,
    spawnPlanId,
    spawnIdempotencyKey,
    spawnReason: planTicket.reason || null,
    createdBy: 'workflow:' + parentWorkflowId,
    createdAt: now,
    updatedAt: now
  };

  const eventPayload = {
    objective: ticketDraft.objective,
    assignmentTargetType: ticketDraft.assignmentTargetType,
    assignmentTargetId: ticketDraft.assignmentTargetId,
    assignmentMode: ticketDraft.assignmentMode,
    executionMode: ticketDraft.executionMode,
    workflowId: ticketDraft.workflowId,
    blockedReason: ticketDraft.blockedReason || null,
    parentTicketId: ticketDraft.parentTicketId,
    parentRunId: ticketDraft.parentRunId,
    parentWorkflowId: ticketDraft.parentWorkflowId,
    spawnedByStepId: ticketDraft.spawnedByStepId,
    spawnPlanId: ticketDraft.spawnPlanId,
    spawnIdempotencyKey: ticketDraft.spawnIdempotencyKey,
    createdBy: ticketDraft.createdBy
  };

  return { ticketDraft, eventPayload };
}

module.exports = {
  buildChildWorkflowTicketCreation
};
