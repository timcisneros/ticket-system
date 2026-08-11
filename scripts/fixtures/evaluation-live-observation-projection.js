'use strict';

// Tranche 6 — the LIVE FAILURE OBSERVATION PROJECTION.
//
// WHY IT EXISTS. A live trial runs against an ephemeral database. When the run
// is over the database is gone, and everything an operator can ever ask about
// that trial has to have survived in its artifact. What survived until now was
// a set of COUNTS — worker requests, receipts, terminal statuses — and counts
// answer the wrong question. "0 worker requests, 0 receipts, Run failed" is
// consistent with a provider that was never called, a provider that answered
// something unparseable, a model response that was refused by product authority,
// and a workspace refusal. Those are four different findings and the artifact
// could not tell them apart.
//
// ── THIS IS A PROJECTION, NOT AN AUTHORITY ──────────────────────────────────
//
// Every field below is derived from a durable event or record that production
// wrote for its own reasons. Nothing here decides anything, nothing here
// recomputes a product judgement, and nothing here invents a fact that the
// durable record does not carry. Each field names the authority it read, so a
// reader can go back to the source when the source still exists.
//
// ── UNKNOWN IS A VALUE ──────────────────────────────────────────────────────
//
// The hard rule of this module is that absence is never converted into a
// negative finding. Specifically, and each of these was a real way to be wrong:
//
//   * zero governed reservations does NOT mean transport was not invoked —
//     the ungoverned arms hold no reservations at all and still call providers;
//   * no `provider.response.persisted` does NOT mean transport was not invoked;
//   * zero operation receipts does NOT mean no provider was called;
//   * a failed Run does NOT mean the model response was malformed.
//
// Those non-implications are carried in the projection itself, beside the
// values, so a consumer that reads a count cannot lose the rule that governs
// how to read it.

const PROJECTION_VERSION = 1;

const UNKNOWN = 'UNKNOWN';

const {
  PROVIDER_TRANSPORT_INVOKED_EVENT,
  PROVIDER_TRANSPORT_INVOKED_STRENGTH,
  TRANSPORT_INVOCATION_ROLES
} = require('../../runtime/provider-transport-observation');

// The extraction outcome is knowable EXACTLY, and only from these. Production
// refuses an empty extraction with its own stable code before persisting the
// response as a success, so the persisted response outcome IS the extraction
// result — it is not inferred from a later terminal state.
const EXTRACTION_FAILURE_CODES = Object.freeze(['OPENAI_NO_OUTPUT']);

// The parser's stable refusal code. Distinct, deliberately, from every code
// that means the response was structurally fine and refused for another reason.
const PARSER_REFUSAL_CODE = 'MODEL_MALFORMED_JSON';

// The per-response action-limit refusal, at its canonical durable owner. This
// is NOT the parser: the response was valid JSON, carried well-formed canonical
// actions, and was refused because there were too many mutating ones.
const ACTION_LIMIT_REASON = 'mutating_action_limit';
const TOTAL_ACTION_LIMIT_REASON = 'action_limit';

const NON_IMPLICATIONS = Object.freeze([
  'workerRequestCount = 0 does not imply transport was not invoked',
  'no provider.response.persisted does not imply transport was not invoked',
  'operationReceiptCount = 0 does not imply no provider was called',
  'a failed Run does not imply the model response was malformed',
  'an economic reservation is not a transport attempt'
]);

function payloadOf(event) {
  return (event && event.payload) || {};
}

function byType(events, type) {
  return events.filter(event => event && event.type === type);
}

function tally(values) {
  const counts = {};
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const key = String(value);
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.freeze(counts);
}

// ── The projection ──────────────────────────────────────────────────────────
//
// `events` are the Ticket's canonical events with payloads, in sequence order.
// `receipts` are operation receipt rows. `reservations` are economic reservation
// rows. Nothing else is read, and none of it is written.

function projectLiveDurableObservation({
  events = [], receipts = [], reservations = [], runs = []
} = {}) {
  const requestPersisted = byType(events, 'provider.request.persisted');
  const economicStarted = byType(events, 'ticket.economic_request_started');
  const transportInvoked = byType(events, PROVIDER_TRANSPORT_INVOKED_EVENT);
  const responsePersisted = byType(events, 'provider.response.persisted');
  const planParsed = byType(events, 'model.plan.parsed');
  const suppressed = byType(events, 'action.suppressed');
  const truncated = byType(events, 'action.truncated');
  const workspaceOperations = byType(events, 'workspace.operation');
  const authorityDenied = byType(events, 'authority.denied');
  const executionCompleted = byType(events, 'run.execution_completed');
  const terminalized = byType(events, 'run.terminalized');

  // ── 1. Dispatch authorized ──────────────────────────────────────────────
  //
  // Both authorities are counted separately rather than summed: the governed
  // roles win dispatch authority through the economic start transition, the
  // ungoverned worker through request admission, and conflating them would
  // report a number that describes neither.
  const dispatchAuthorized = Object.freeze({
    state: requestPersisted.length + economicStarted.length > 0 ? 'YES' : UNKNOWN,
    requestAdmissions: requestPersisted.length,
    economicStarts: economicStarted.length,
    source: 'provider.request.persisted + ticket.economic_request_started'
  });

  // ── 2. Request evidence persisted ───────────────────────────────────────
  const requestEvidence = Object.freeze({
    count: requestPersisted.length,
    // The bytes were durable at this point and NOT YET SENT. Stated here so a
    // reader cannot mistake this count for a count of provider contacts.
    meaning: 'a provider request became durable after admission and BEFORE any ' +
      'byte left; it is not evidence that transport was reached',
    source: 'provider.request.persisted'
  });

  // ── 3. Transport invoked ────────────────────────────────────────────────
  //
  // The only field that answers "was the provider actually called?", and the
  // only one entitled to. Absence stays UNKNOWN.
  const invocationRoles = {};
  for (const role of TRANSPORT_INVOCATION_ROLES) {
    invocationRoles[role] = transportInvoked
      .filter(event => payloadOf(event).role === role).length;
  }
  const transport = Object.freeze({
    state: transportInvoked.length > 0 ? 'INVOKED' : UNKNOWN,
    count: transportInvoked.length,
    byRole: Object.freeze(invocationRoles),
    proves: PROVIDER_TRANSPORT_INVOKED_STRENGTH.proves,
    doesNotProve: PROVIDER_TRANSPORT_INVOKED_STRENGTH.doesNotProve,
    absenceMeans: PROVIDER_TRANSPORT_INVOKED_STRENGTH.absenceMeans,
    source: PROVIDER_TRANSPORT_INVOKED_EVENT
  });

  // ── 4–5. Provider response persisted, and its identity ──────────────────
  const succeededResponses = responsePersisted.filter(event =>
    payloadOf(event).outcome === 'succeeded');
  const failedResponses = responsePersisted.filter(event =>
    payloadOf(event).outcome === 'failed');
  const providerRequestIds = [...new Set(responsePersisted
    .map(event => payloadOf(event).requestId)
    .filter(value => typeof value === 'string' && value.length > 0))];
  const governedRunIds = new Set(runs
    .filter(run => run && run.governed_leaf === true)
    .map(run => Number(run.id)));
  const responseRoles = Object.fromEntries(
    TRANSPORT_INVOCATION_ROLES.map(role => [role, 0]));
  for (const event of responsePersisted) {
    const payload = payloadOf(event);
    let role = TRANSPORT_INVOCATION_ROLES.includes(payload.role) ? payload.role : null;
    if (role === null && event.run_id === null && payload.governed === true) {
      role = 'structured_planner';
    } else if (role === null && event.run_id !== null) {
      role = governedRunIds.has(Number(event.run_id))
        ? 'governed_leaf_worker' : 'ungoverned_worker';
    }
    if (role !== null) responseRoles[role] += 1;
  }
  const response = Object.freeze({
    state: responsePersisted.length > 0 ? 'PERSISTED' : UNKNOWN,
    count: responsePersisted.length,
    succeeded: succeededResponses.length,
    failed: failedResponses.length,
    byRole: Object.freeze(responseRoles),
    failureCodes: tally(failedResponses.map(event => payloadOf(event).code)),
    httpStatuses: tally(responsePersisted.map(event => payloadOf(event).status)),
    // Non-secret provider correlation identity, retained because it is the only
    // handle a provider-side investigation has once the database is gone.
    providerRequestIds: Object.freeze(providerRequestIds),
    source: 'provider.response.persisted'
  });

  // ── 6. Extraction ───────────────────────────────────────────────────────
  //
  // A CANONICAL FACT, not an inference. Production refuses an empty extraction
  // with OPENAI_NO_OUTPUT before it can persist a successful response, so a
  // persisted success IS a successful extraction and a persisted failure under
  // that code IS an extraction failure. Everything else leaves it UNKNOWN
  // rather than guessing from a later state.
  const extractionFailures = failedResponses.filter(event =>
    EXTRACTION_FAILURE_CODES.includes(payloadOf(event).code));
  let extractionState = UNKNOWN;
  if (succeededResponses.length > 0) extractionState = 'SUCCEEDED';
  if (extractionFailures.length > 0) {
    extractionState = succeededResponses.length > 0 ? 'MIXED' : 'FAILED';
  }
  const extraction = Object.freeze({
    state: extractionState,
    succeeded: succeededResponses.length,
    failed: extractionFailures.length,
    failureCodes: Object.freeze([...EXTRACTION_FAILURE_CODES]),
    meaning: 'a persisted successful provider response is reached only after a ' +
      'non-empty extraction; an empty one is refused as OPENAI_NO_OUTPUT',
    source: 'provider.response.persisted outcome + code'
  });

  // ── 7–8. Parser acceptance and its stable refusal code ──────────────────
  const parserRefusals = executionCompleted.filter(event =>
    payloadOf(event).failure && payloadOf(event).failure.code === PARSER_REFUSAL_CODE);
  const parser = Object.freeze({
    accepted: planParsed.length,
    acceptedActionCounts: tally(planParsed.map(event => payloadOf(event).actionCount)),
    refused: parserRefusals.length,
    refusalCode: parserRefusals.length > 0 ? PARSER_REFUSAL_CODE : null,
    state: planParsed.length > 0
      ? 'ACCEPTED'
      : (parserRefusals.length > 0 ? 'REFUSED' : UNKNOWN),
    source: 'model.plan.parsed + run.execution_completed failure.code'
  });

  // ── 9. Per-response action-limit refusal ────────────────────────────────
  //
  // ITS OWN FIELD, because it is the finding most easily mistaken for a parser
  // failure. The response was structurally valid and was refused because it
  // exceeded the per-response mutating-action authority.
  const limitRefusals = [...suppressed, ...truncated].filter(event =>
    [ACTION_LIMIT_REASON, TOTAL_ACTION_LIMIT_REASON].includes(payloadOf(event).reason));
  const mutatingLimitRefusals = limitRefusals.filter(event =>
    payloadOf(event).reason === ACTION_LIMIT_REASON);
  const actionLimit = Object.freeze({
    state: limitRefusals.length > 0 ? 'REFUSED' : UNKNOWN,
    refusals: limitRefusals.length,
    mutatingRefusals: mutatingLimitRefusals.length,
    reasons: tally(limitRefusals.map(event => payloadOf(event).reason)),
    // The cap the response was measured against and the counts it presented.
    limits: tally(limitRefusals.map(event => payloadOf(event).limit)),
    mutatingCounts: tally(mutatingLimitRefusals.map(event => payloadOf(event).mutatingCount)),
    proposedCounts: tally(limitRefusals.map(event => payloadOf(event).proposedCount)),
    classification: limitRefusals.length > 0 ? 'product_model_response_authority' : null,
    meaning: 'the response was STRUCTURALLY VALID and exceeded the per-response ' +
      'action authority; this is model/product data, not a parser or runtime defect',
    source: 'action.suppressed / action.truncated reason + limit'
  });

  // ── 10–11. Workspace actions and their stable refusal codes ─────────────
  const acceptedOperations = receipts.filter(row => row.outcome === 'succeeded');
  const refusedOperations = receipts.filter(row => row.outcome !== 'succeeded');
  const workspace = Object.freeze({
    operationEvents: workspaceOperations.length,
    accepted: acceptedOperations.length,
    refused: refusedOperations.length,
    // The stable code lives on the receipt, not in the human-readable message.
    refusalCodes: tally(refusedOperations.map(row =>
      row.receipt && row.receipt.error ? row.receipt.error.code : null)),
    refusalKinds: tally(refusedOperations.map(row =>
      row.receipt && row.receipt.error ? row.receipt.error.failureKind : null)),
    // Authority denials are a separate durable owner with their own stable rule.
    authorityDenials: authorityDenied.length,
    authorityDenialRules: tally(authorityDenied.map(event => payloadOf(event).rule)),
    state: receipts.length > 0 || authorityDenied.length > 0
      ? (refusedOperations.length + authorityDenied.length > 0 ? 'REFUSED' : 'ACCEPTED')
      : UNKNOWN,
    source: 'workspace.operation + operation_receipts + authority.denied'
  });

  // ── 12. Operation receipts ──────────────────────────────────────────────
  const operationReceipts = Object.freeze({
    count: receipts.length,
    operations: tally(receipts.map(row => row.operation)),
    meaning: 'a receipt count of zero says nothing about whether a provider was ' +
      'called; it says only that no workspace operation was committed',
    source: 'operation_receipts'
  });

  // ── 13. Response delivered into execution ───────────────────────────────
  const delivered = Object.freeze({
    state: executionCompleted.length > 0 ? 'COMPLETED' : UNKNOWN,
    count: executionCompleted.length,
    source: 'run.execution_completed'
  });

  // ── 14. Terminal result ─────────────────────────────────────────────────
  const terminal = Object.freeze({
    state: terminalized.length > 0 ? 'TERMINALIZED' : UNKNOWN,
    statuses: tally(terminalized.map(event => payloadOf(event).status)),
    failureCodes: tally(executionCompleted.map(event =>
      payloadOf(event).failure ? payloadOf(event).failure.code : null)),
    failureKinds: tally(executionCompleted.map(event =>
      payloadOf(event).failure ? payloadOf(event).failure.kind : null)),
    source: 'run.terminalized + run.execution_completed failure'
  });

  // The economic record, carried so a reader can SEE that reservations and
  // transport invocations are different numbers rather than having to trust it.
  const economics = Object.freeze({
    reservations: reservations.length,
    reservationStates: tally(reservations.map(row => row.state)),
    meaning: 'reservations bound spend; they are not transport attempts, and the ' +
      'ungoverned arms hold none while still invoking transport',
    source: 'economic_request_reservations'
  });

  return Object.freeze({
    version: PROJECTION_VERSION,
    dispatchAuthorized,
    requestEvidence,
    transport,
    response,
    extraction,
    parser,
    actionLimit,
    workspace,
    operationReceipts,
    delivered,
    terminal,
    economics,
    nonImplications: NON_IMPLICATIONS,
    projection: 'derived entirely from durable events and records; this object ' +
      'is not an authority and decides nothing'
  });
}

module.exports = {
  ACTION_LIMIT_REASON,
  EXTRACTION_FAILURE_CODES,
  NON_IMPLICATIONS,
  PARSER_REFUSAL_CODE,
  PROJECTION_VERSION,
  TOTAL_ACTION_LIMIT_REASON,
  UNKNOWN,
  projectLiveDurableObservation
};
