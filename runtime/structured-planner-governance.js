'use strict';

// Tranche 4 — governed capture for the structured planner.
//
// This module runs BEFORE any provider contact and produces the immutable
// facts a planner dispatch is authorized by. It performs the capture sequence
// in one fixed order, and every step refuses rather than substituting:
//
//   current policy documents          (administrator configuration)
//     -> immutable routing decision   (which exact route, captured)
//     -> immutable dispatch target    (which exact artifact will run)
//     -> immutable economic authority (how much that route may cost)
//     -> role account admitted        (where the money lives)
//     -> exact prepared request       (serialized once, hashed, frozen)
//     -> durable reservation          (the bytes and the basis, persisted)
//
// NOTHING HERE CONTACTS A PROVIDER. By the time this module returns, the whole
// question "may this request run, and at what maximum cost" has been answered
// and written down, so a crash at any point leaves a truthful durable record
// rather than an unknown.
//
// The planner is limited to EXACTLY ONE provider request. That is not a policy
// knob here: the request ordinal is always 1, and the economic policy's request
// ceiling is what bounds it.

const { hashCanonical } = require('./declared-work-contract');
const {
  buildParentPolicyReference, readGovernedPolicySource
} = require('./governed-policy-source');
const {
  buildRoleRoutingDecision
} = require('./role-routing-contract');
const {
  buildEconomicAuthority
} = require('./economic-authority-contract');
const {
  findPricingEntry
} = require('./model-pricing-catalog');
const {
  prepareGovernedProviderRequest
} = require('./governed-provider-request-contract');
const { buildOpenAiResponsesBody } = require('./provider-request-body');

const PLANNER_ROLE = 'structured_planner';
// The planner gets one request. Not "at most one by convention" — one.
const PLANNER_REQUEST_ORDINAL = 1;

const PLANNER_GOVERNANCE_REFUSALS = Object.freeze([
  'planner_policy_unavailable',
  'planner_route_uncapturable',
  'planner_authority_unavailable',
  'planner_account_unavailable',
  'planner_request_unpreparable',
  'planner_reservation_refused',
  'planner_credentials_unavailable'
]);

class PlannerGovernanceError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'PlannerGovernanceError';
    this.code = code;
    this.detail = detail;
  }
}

function refuse(reason, message, cause = null) {
  if (!PLANNER_GOVERNANCE_REFUSALS.includes(reason)) {
    throw new PlannerGovernanceError('PLANNER_GOVERNANCE_INVALID',
      `Unsupported planner governance refusal: ${String(reason)}`);
  }
  throw new PlannerGovernanceError('PLANNER_GOVERNANCE_REFUSED', message, {
    reason,
    cause: cause ? (cause.detail && cause.detail.reason) || cause.code || null : null
  });
}

// ── Capture ─────────────────────────────────────────────────────────────────
//
// Returns everything needed to reserve, plus the documents the attempt must
// retain. It does NOT reserve: reservation is a store transaction, and keeping
// it out of here means this whole function is pure and independently testable.

function capturePlannerGovernance({
  ticketId,
  planningAttemptId,
  plannerAgentId,
  policyContainer,
  plannerInput,
  endpointIdentity,
  capturedAt
}) {
  // 1. The current closed administrator documents. Missing routing, economic or
  //    pricing configuration refuses here, before anything is captured.
  let source;
  try {
    source = readGovernedPolicySource(policyContainer, { role: PLANNER_ROLE });
  } catch (error) {
    refuse('planner_policy_unavailable',
      `governed planner policy is unavailable: ${error.message}`, error);
  }

  // 2. The immutable routing decision, which also resolves and freezes the
  //    dispatch target. A mutable alias or unresolvable target refuses here.
  let routingDecision;
  try {
    routingDecision = buildRoleRoutingDecision({
      policy: source.roleRoutingPolicy,
      role: PLANNER_ROLE,
      ticketId,
      subjectKind: 'planning_attempt',
      subjectId: planningAttemptId,
      actingAgentId: plannerAgentId,
      decidedAt: capturedAt
    });
  } catch (error) {
    refuse('planner_route_uncapturable',
      `no immutable planner route could be captured: ${error.message}`, error);
  }

  // 3. The immutable economic authority over THAT captured route. An
  //    unboundable paid route, an unknown capability or an unpriced entry
  //    refuses here — still before any provider contact.
  let economicAuthority;
  try {
    economicAuthority = buildEconomicAuthority({
      policy: source.economicPolicy,
      routingDecision,
      pricingCatalog: source.pricingCatalog,
      capturedAt
    });
  } catch (error) {
    refuse('planner_authority_unavailable',
      `no economic authority could be captured for the planner route: ${error.message}`, error);
  }

  // The exact entry the authority priced against, captured for durable
  // settlement. Resolved from the captured catalog, never from a current one.
  const pricingEntry = findPricingEntry(source.pricingCatalog, {
    provider: economicAuthority.provider,
    model: economicAuthority.dispatchTarget,
    adapterId: economicAuthority.adapterId
  });

  // 4. The exact request. The model comes from the CAPTURED dispatch target,
  //    never from the planner agent row or an environment default, and the cap
  //    and truncation come from the captured authority.
  let preparedRequest;
  try {
    const canonicalBody = buildOpenAiResponsesBody({
      model: economicAuthority.dispatchTarget,
      input: plannerInput,
      options: {
        governed: true,
        maxOutputTokens: economicAuthority.maximumOutputTokensPerRequest
      }
    });
    preparedRequest = prepareGovernedProviderRequest({
      routingDecision,
      economicAuthority,
      modelRequestOrdinal: PLANNER_REQUEST_ORDINAL,
      endpointIdentity,
      canonicalBody,
      authorizedOutputTokens: economicAuthority.maximumOutputTokensPerRequest,
      truncationMode: 'disabled',
      pricingEntryHash: hashCanonical(pricingEntry),
      maximumLiabilityMicroUsd: economicAuthority.maximumPerRequestMicroUsd,
      preparedAt: capturedAt
    });
  } catch (error) {
    refuse('planner_request_unpreparable',
      `the governed planner request could not be prepared: ${error.message}`, error);
  }

  return Object.freeze({
    source,
    routingDecision,
    economicAuthority,
    pricingEntry,
    preparedRequest
  });
}

// The captured block the attempt retains. Built only from documents that
// already exist, so it can never disagree with them.
function buildGovernedExecutionState({
  capture,
  economicAccountId,
  reservationId,
  economicState,
  settlementReceiptHash = null
}) {
  return {
    version: 2,
    role: PLANNER_ROLE,
    roleRoutingPolicyHash: capture.source.roleRoutingPolicyHash,
    economicPolicyHash: capture.source.economicPolicyHash,
    pricingCatalogHash: capture.source.pricingCatalogHash,
    // The container revision this planner authority was selected from. Every
    // leaf Run admitted from the resulting plan must bind the same one.
    parentPolicyReference: buildParentPolicyReference(capture.source),
    routingDecisionHash: capture.routingDecision.decisionHash,
    economicAuthorityHash: capture.economicAuthority.authorityHash,
    dispatchTarget: capture.economicAuthority.dispatchTarget,
    targetEvidenceHash: capture.economicAuthority.targetEvidenceHash,
    economicAccountId,
    reservationId,
    preparedRequestHash: capture.preparedRequest.preparedRequestHash,
    exactRequestHash: capture.preparedRequest.requestHash,
    settlementReceiptHash,
    economicState
  };
}

// ── Usage derivation ────────────────────────────────────────────────────────
//
// Turns a provider's reported usage into a settlement usage claim, and refuses
// to guess. Anything unknown, absent, malformed or unsupported becomes the
// conservative maximum — never zero, and never a partial count treated as
// complete.

function derivePlannerSettlementUsage(reportedUsage) {
  if (!reportedUsage || typeof reportedUsage !== 'object' || Array.isArray(reportedUsage)) {
    return { source: 'authorized_maximum_assumed' };
  }
  const input = reportedUsage.input_tokens;
  const output = reportedUsage.output_tokens;
  // BOTH counts must be present and sane. A response reporting only one of them
  // does not tell us what was consumed, and charging the half we can see would
  // understate the bill.
  if (!Number.isSafeInteger(input) || input < 0 ||
      !Number.isSafeInteger(output) || output < 0) {
    return { source: 'authorized_maximum_assumed' };
  }
  return { source: 'provider_reported', inputTokens: input, outputTokens: output };
}

module.exports = {
  PLANNER_GOVERNANCE_REFUSALS,
  PLANNER_REQUEST_ORDINAL,
  PLANNER_ROLE,
  PlannerGovernanceError,
  buildGovernedExecutionState,
  capturePlannerGovernance,
  derivePlannerSettlementUsage,
  refusePlannerGovernance: refuse
};
