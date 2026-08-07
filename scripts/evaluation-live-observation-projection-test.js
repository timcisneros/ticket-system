#!/usr/bin/env node
'use strict';

// Tranche 6 — the LIVE FAILURE OBSERVATION PROJECTION contract.
//
// WHAT THIS EXISTS TO PREVENT. A live trial runs against an ephemeral database.
// When it is gone, the artifact is all there is — and what the artifact carried
// was counts. "0 worker requests, 0 receipts, Run failed" is equally consistent
// with a provider that was never called, a provider that answered something
// unusable, a model response refused by product authority, and a workspace
// refusal. Four different findings, one indistinguishable artifact.
//
// The projection separates them. Every assertion below is about ONE of two
// things: that a distinguishable finding is actually distinguished, or that an
// absent fact stays UNKNOWN instead of being converted into a negative one.
//
// THE SECOND KIND MATTERS MORE. Reading "no transport observation" as "the
// provider was not called" is how a durable gap becomes a false product
// conclusion, and the prohibitions are asserted here individually.

const assert = require('node:assert/strict');
const {
  NON_IMPLICATIONS, PARSER_REFUSAL_CODE, UNKNOWN, projectLiveDurableObservation
} = require('./fixtures/evaluation-live-observation-projection');

let passed = 0;
function ok(condition, message) {
  assert.equal(condition, true, message);
  passed += 1;
  console.log(`  ok ${message}`);
}

const REQUEST = { type: 'provider.request.persisted', payload: { provider: 'openai' } };
const INVOKED = role => ({
  type: 'provider.transport_invoked',
  payload: { role, transportOwner: 'x', endpoint: 'https://api.openai.com/v1/responses' }
});
const RESPONSE = payload => ({ type: 'provider.response.persisted', payload });
const COMPLETED = failure => ({ type: 'run.execution_completed', payload: { failure } });

function main() {
  console.log('live failure observation projection');

  // ── NOTHING IS KNOWN BEYOND WHAT WAS RECORDED ─────────────────────────
  const empty = projectLiveDurableObservation({});
  for (const [field, value] of [
    ['transport', empty.transport.state], ['response', empty.response.state],
    ['extraction', empty.extraction.state], ['parser', empty.parser.state],
    ['actionLimit', empty.actionLimit.state], ['workspace', empty.workspace.state],
    ['delivered', empty.delivered.state], ['terminal', empty.terminal.state],
    ['dispatchAuthorized', empty.dispatchAuthorized.state]
  ]) {
    ok(value === UNKNOWN, `an empty durable record leaves ${field} UNKNOWN`);
  }

  // ── THE FOUR PROHIBITIONS, EACH ASSERTED ──────────────────────────────
  //
  // 1. A request was authorized and its bytes became durable. That is NOT
  //    evidence that anything reached a transport.
  const authorizedOnly = projectLiveDurableObservation({ events: [REQUEST] });
  ok(authorizedOnly.dispatchAuthorized.state === 'YES' &&
     authorizedOnly.requestEvidence.count === 1,
  'a persisted provider request is projected as AUTHORIZED evidence');
  ok(authorizedOnly.transport.state === UNKNOWN,
    'and transport stays UNKNOWN — provider.request.persisted is written BEFORE ' +
    'any byte leaves and can never be projected as a transport attempt');
  ok(!/attempt/i.test(authorizedOnly.requestEvidence.meaning.split('.')[0]) &&
     authorizedOnly.requestEvidence.meaning.includes('BEFORE any'),
  'the request-evidence field states its own ordering, so a reader cannot ' +
  'mistake it for a provider contact');

  // 2. Zero governed reservations does NOT mean transport was not invoked. The
  //    ungoverned arms hold no reservations at all.
  const ungoverned = projectLiveDurableObservation({
    events: [REQUEST, INVOKED('ungoverned_worker')], reservations: []
  });
  ok(ungoverned.economics.reservations === 0 &&
     ungoverned.transport.state === 'INVOKED' && ungoverned.transport.count === 1,
  'zero economic reservations with transport INVOKED — a reservation count can ' +
  'never stand in for a transport count');

  // 3. No persisted response does NOT mean transport was not invoked.
  const noAnswer = projectLiveDurableObservation({
    events: [REQUEST, INVOKED('governed_leaf_worker')]
  });
  ok(noAnswer.transport.state === 'INVOKED' && noAnswer.response.state === UNKNOWN,
    'transport INVOKED with no persisted response — the missing answer is a gap, ' +
    'not a proof that nothing was sent');
  ok(/UNKNOWN/.test(noAnswer.transport.absenceMeans),
    'and the field carries its own rule: ABSENCE of the observation means UNKNOWN');

  // 4. Zero receipts does NOT mean no provider was called, and a failed Run
  //    does NOT mean the model response was malformed.
  const failedNoReceipts = projectLiveDurableObservation({
    events: [REQUEST, INVOKED('ungoverned_worker'),
      RESPONSE({ outcome: 'succeeded', requestId: 'req_1' }),
      COMPLETED({ code: 'RUNTIME_BUDGET_INSUFFICIENT', kind: 'runtime_budget_insufficient' })],
    receipts: []
  });
  ok(failedNoReceipts.operationReceipts.count === 0 &&
     failedNoReceipts.transport.state === 'INVOKED',
  'zero receipts with transport INVOKED — a receipt count says nothing about ' +
  'whether a provider was called');
  ok(failedNoReceipts.parser.refusalCode === null &&
     failedNoReceipts.terminal.failureCodes.RUNTIME_BUDGET_INSUFFICIENT === 1,
  'a failed Run keeps its OWN failure code and is never reported as a malformed ' +
  'model response');
  ok(NON_IMPLICATIONS.length === 5,
    'and all five non-implications travel with the projection itself');

  // ── EXTRACTION IS A CANONICAL FACT, NOT AN INFERENCE ──────────────────
  const extracted = projectLiveDurableObservation({
    events: [RESPONSE({ outcome: 'succeeded', requestId: 'req_ok', status: 200 })]
  });
  ok(extracted.extraction.state === 'SUCCEEDED',
    'a persisted SUCCESSFUL provider response proves extraction succeeded — ' +
    'production refuses an empty extraction before it can reach that state');
  const notExtracted = projectLiveDurableObservation({
    events: [RESPONSE({ outcome: 'failed', code: 'OPENAI_NO_OUTPUT', status: 200 })]
  });
  ok(notExtracted.extraction.state === 'FAILED' &&
     notExtracted.response.failureCodes.OPENAI_NO_OUTPUT === 1,
  'and OPENAI_NO_OUTPUT proves it FAILED, under its own stable code');
  const httpFailure = projectLiveDurableObservation({
    events: [RESPONSE({ outcome: 'failed', code: 'OPENAI_HTTP_ERROR', status: 500 })]
  });
  ok(httpFailure.extraction.state === UNKNOWN,
    'a transport-level failure leaves extraction UNKNOWN rather than claiming it failed');

  // ── PARSER REFUSAL AND ACTION-LIMIT REFUSAL ARE DIFFERENT FINDINGS ────
  //
  // THE DISTINCTION THIS WHOLE FIELD EXISTS FOR. One means the model produced
  // something the runtime could not read; the other means the model produced
  // something perfectly readable that exceeded its per-response authority.
  const malformed = projectLiveDurableObservation({
    events: [COMPLETED({ code: PARSER_REFUSAL_CODE, kind: 'invalid_action' })]
  });
  ok(malformed.parser.state === 'REFUSED' &&
     malformed.parser.refusalCode === PARSER_REFUSAL_CODE,
  'a malformed response projects the parser stable refusal code MODEL_MALFORMED_JSON');
  ok(malformed.actionLimit.state === UNKNOWN,
    'and carries NO action-limit refusal — it never reached that authority');

  const overLimit = projectLiveDurableObservation({
    events: [
      { type: 'model.plan.parsed', payload: { actionCount: 4, operations: ['createFolder'] } },
      { type: 'action.suppressed',
        payload: { reason: 'mutating_action_limit', limit: 2, mutatingCount: 4, proposedCount: 4 } }
    ]
  });
  ok(overLimit.parser.state === 'ACCEPTED' && overLimit.parser.refusalCode === null,
    'four canonical mutations: the parser ACCEPTED the response');
  ok(overLimit.actionLimit.state === 'REFUSED' &&
     overLimit.actionLimit.reasons.mutating_action_limit === 1 &&
     overLimit.actionLimit.limits['2'] === 1 &&
     overLimit.actionLimit.mutatingCounts['4'] === 1,
  'and the per-response action authority refused it, with the cap and the count ' +
  'it presented — not only a human-readable message');
  ok(overLimit.actionLimit.classification === 'product_model_response_authority',
    'classified as PRODUCT/MODEL data rather than a harness or runtime defect');
  ok(overLimit.actionLimit.meaning.includes('STRUCTURALLY VALID'),
    'and says so in terms, so the two findings cannot be conflated downstream');

  // ── WORKSPACE REFUSALS KEEP THEIR OWN STABLE CODES ────────────────────
  const workspaceRefusal = projectLiveDurableObservation({
    events: [{ type: 'authority.denied', payload: { rule: 'owned_output_path' } }],
    receipts: [
      { operation: 'createFolder', outcome: 'succeeded', receipt: {} },
      { operation: 'writeFile', outcome: 'refused',
        receipt: { error: { code: 'WORKSPACE_OWNERSHIP_VIOLATION', failureKind: 'invalid_action' } } }
    ]
  });
  ok(workspaceRefusal.workspace.accepted === 1 && workspaceRefusal.workspace.refused === 1,
    'accepted and refused workspace actions are counted separately');
  ok(workspaceRefusal.workspace.refusalCodes.WORKSPACE_OWNERSHIP_VIOLATION === 1,
    'a refused workspace action projects its stable code from the receipt');
  ok(workspaceRefusal.workspace.authorityDenialRules.owned_output_path === 1,
    'and an authority denial projects its stable rule, its own durable owner');
  ok(workspaceRefusal.operationReceipts.operations.createFolder === 1,
    'the receipt count is broken down by operation');

  // ── THE PROVIDER REQUEST ID IS RETAINED, THE CREDENTIAL IS NOT ────────
  const withIds = projectLiveDurableObservation({
    events: [RESPONSE({ outcome: 'succeeded', requestId: 'req_abc' }),
      RESPONSE({ outcome: 'failed', code: 'OPENAI_HTTP_ERROR', requestId: 'req_abc' })]
  });
  ok(withIds.response.providerRequestIds.length === 1 &&
     withIds.response.providerRequestIds[0] === 'req_abc',
  'the provider request id is retained once — the only handle a provider-side ' +
  'investigation has after the database is gone');
  ok(!/authorization|api[_-]?key|bearer|sk-/i.test(JSON.stringify(withIds)),
    'and no credential material appears anywhere in the projection');

  // ── IT IS A PROJECTION, NOT A SECOND AUTHORITY ────────────────────────
  const projected = projectLiveDurableObservation({ events: [REQUEST] });
  ok(Object.isFrozen(projected) && projected.projection.includes('decides nothing'),
    'the projection is frozen and states that it decides nothing');
  const everyFieldNamesASource = ['dispatchAuthorized', 'requestEvidence', 'transport',
    'response', 'extraction', 'parser', 'actionLimit', 'workspace',
    'operationReceipts', 'delivered', 'terminal', 'economics']
    .every(field => typeof projected[field].source === 'string' &&
      projected[field].source.length > 0);
  ok(everyFieldNamesASource,
    'and every field names the durable authority it was derived from');

  // DETERMINISTIC: the same durable state projects identically.
  const once = projectLiveDurableObservation({ events: [REQUEST, INVOKED('ungoverned_worker')] });
  const twice = projectLiveDurableObservation({ events: [REQUEST, INVOKED('ungoverned_worker')] });
  ok(JSON.stringify(once) === JSON.stringify(twice),
    'the same durable state projects byte-identically twice');

  console.log(`\nlive failure observation projection test passed — ${passed} assertions`);
}

main();
