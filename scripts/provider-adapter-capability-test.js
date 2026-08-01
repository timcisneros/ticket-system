#!/usr/bin/env node
'use strict';

// Tranche 4 deterministic suite for runtime/provider-adapter-capability.
//
// The load-bearing claim in that module is `outputCapSerialized`. If it could be
// set without changing the adapter, the runtime would advertise a hard cost
// bound it does not enforce. This suite proves the claim two ways:
//
//   1. against the ACTUAL outgoing request body, built by the same canonical
//      builder the adapter serializes — no credentials, no network, no request;
//   2. against the adapter SOURCE, proving server.js sends exactly that body and
//      that the cap field is written in one place only.
//
// It also proves the inverse: an ungoverned call still sends the pre-Tranche-4
// body, byte for byte.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ADAPTER_CAPABILITIES,
  CAPABILITY_REFUSALS,
  INPUT_BOUND_PROOFS,
  PROVIDER_ADAPTERS,
  ProviderAdapterCapabilityError,
  adapterIdForProvider,
  assertAdapterSupportsGovernedDispatch,
  assertGovernedOutputCapSerialized,
  assertInputBoundProofApplies,
  capabilityHash,
  MODEL_CAPABILITIES,
  assertOutputCapWithinModel,
  getAdapterCapability,
  getInputBoundProof,
  modelCapabilityHash,
  proofHash,
  resolveInputBoundProof,
  resolveModelCapability
} = require('../runtime/provider-adapter-capability');

const ROOT = path.resolve(__dirname, '..');

function refusalReason(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ProviderAdapterCapabilityError);
    assert.equal(error.code, 'PROVIDER_ADAPTER_CAPABILITY_REFUSED');
    assert.equal(CAPABILITY_REFUSALS.includes(error.reason), true,
      `${error.reason} is in the closed vocabulary`);
    return error.reason;
  }
  return assert.fail('expected an adapter-capability refusal');
}

// ── Capability records are coherent and runtime-owned ───────────────────────

for (const [adapterId, capability] of Object.entries(ADAPTER_CAPABILITIES)) {
  assert.equal(capability.adapterId, adapterId);
  assert.ok(capability.outputCapField.length > 0);
  assert.equal(Object.isFrozen(capability), true, 'capability records are immutable');
  // Every chargeable output category must be covered by the cap, or the record
  // is internally inconsistent.
  for (const category of capability.chargeableOutputCategories) {
    assert.equal(capability.outputCapCoversCategories.includes(category), true,
      `${adapterId} cap must cover chargeable category ${category}`);
  }
  for (const proofId of capability.inputBoundProofIds) {
    assert.equal(INPUT_BOUND_PROOFS[proofId].adapterId, adapterId,
      `${proofId} must describe ${adapterId}`);
  }
  assert.match(capabilityHash(capability), /^[0-9a-f]{64}$/);
}
assert.equal(capabilityHash(ADAPTER_CAPABILITIES['openai.responses.v1']),
  capabilityHash(ADAPTER_CAPABILITIES['openai.responses.v1']),
  'capability hashing is deterministic');
assert.notEqual(capabilityHash(ADAPTER_CAPABILITIES['openai.responses.v1']),
  capabilityHash(ADAPTER_CAPABILITIES['ollama.chat.v1']));

assert.equal(adapterIdForProvider('openai'), 'openai.responses.v1');
assert.equal(adapterIdForProvider('ollama'), 'ollama.chat.v1');
assert.equal(refusalReason(() => adapterIdForProvider('anthropic')),
  'adapter_capability_unknown',
  'an undeclared provider inherits no other adapter guarantees');
assert.equal(refusalReason(() => getAdapterCapability('made.up.v1')),
  'adapter_capability_unknown');
assert.equal(refusalReason(() => getInputBoundProof('made.up/proof/v1')),
  'input_bound_proof_unknown');

// OpenAI bills reasoning inside the output-token total; the record must say so.
assert.equal(
  ADAPTER_CAPABILITIES['openai.responses.v1'].chargeableOutputCategories.includes('reasoning'),
  true,
  'reasoning tokens are declared chargeable for OpenAI Responses'
);

// ── Input-bound proofs are route-specific, not provider-wide ────────────────

for (const [proofId, proof] of Object.entries(INPUT_BOUND_PROOFS)) {
  assert.equal(proof.proofId, proofId);
  assert.ok(proof.apiOperation.length > 0, 'the proof names the exact API operation');
  assert.ok(proof.requestShape.length > 0, 'the proof names the exact request shape');
  assert.ok(proof.chargeableInputFields.length > 0);
  assert.ok(proof.tokenizerFamily.length > 0);
  assert.equal(Number.isSafeInteger(proof.framingAllowanceTokens), true);
  // The allowance must say what it covers, field by field, so an uncovered
  // category is visible rather than implied.
  assert.equal(typeof proof.framingCoverage.serverSidePromptTemplate, 'boolean');
  assert.equal(typeof proof.framingCoverage.autoInsertedControlTokens, 'boolean');
  // A proof is only a monetary bound if EVERY framing category is covered.
  const uncovered = Object.values(proof.framingCoverage).some(covered => !covered);
  assert.equal(proof.framingBoundProven, !uncovered,
    `${proofId} framingBoundProven must follow its own coverage`);
  // Proofs bind exact model identities, never a whole provider or adapter.
  assert.ok(proof.models.length > 0, `${proofId} names exact models`);
  assert.ok(proof.excludedRequestFeatures.length > 0,
    'the proof states what it does NOT cover');
  assert.ok(proof.statement.length > 0);
  // Everything the provider bills as input must be inside the shape the proof
  // measured.
  for (const field of proof.chargeableInputFields) {
    assert.equal(proof.requestShape.includes(field), true,
      `${proofId} bills ${field} but did not account for it`);
  }
}
assert.notEqual(
  INPUT_BOUND_PROOFS['openai.responses.v1/byte-ceiling-bpe/o200k/v1'].proofId,
  INPUT_BOUND_PROOFS['ollama.chat.v1/byte-ceiling-bpe/llama/v1'].proofId,
  'the same bound technique yields distinct per-route proofs'
);

// ── Model capability registry: exact limits and complete provenance ────────

assert.deepEqual(
  Object.fromEntries(Object.entries(MODEL_CAPABILITIES).map(([id, capability]) =>
    [id, [capability.contextWindowTokens, capability.maxOutputTokens]])),
  {
    'gpt-4.1-2025-04-14': [1_047_576, 32_768],
    'gpt-4.1-mini-2025-04-14': [1_047_576, 32_768],
    'gpt-4o-mini-2024-07-18': [128_000, 16_384]
  },
  'the registered context and output limits are exactly the admitted values'
);
for (const [modelId, capability] of Object.entries(MODEL_CAPABILITIES)) {
  assert.equal(capability.modelId, modelId);
  assert.equal(capability.isMutableAlias, false,
    'no mutable alias is admitted as hard-bound authority');
  // Provenance for an administrator-reviewed runtime fact.
  assert.ok(capability.contextLimitSourceIdentity.length > 0,
    `${modelId} names its evidence source`);
  assert.match(capability.evidenceCapturedAt, /^\d{4}-\d{2}-\d{2}$/,
    `${modelId} records when that evidence was admitted`);
  assert.equal(Number.isSafeInteger(capability.capabilityVersion), true);
  assert.equal(capability.boundMethod, 'model_context_window_ceiling');
  assert.deepEqual(capability.supportedModalities, ['text'],
    'only text modality is admitted; anything else would add unpriced input');
  assert.equal(capability.supportedRequestShape.includes('truncation'), true);
  assert.equal(capability.supportedRequestShape.includes('max_output_tokens'), true);
  assert.match(modelCapabilityHash(capability), /^[0-9a-f]{64}$/);
}
// Registry drift changes the capability hash, so a captured authority that
// embeds it cannot be silently re-based onto new limits.
assert.notEqual(
  modelCapabilityHash(MODEL_CAPABILITIES['gpt-4o-mini-2024-07-18']),
  modelCapabilityHash({
    ...MODEL_CAPABILITIES['gpt-4o-mini-2024-07-18'], contextWindowTokens: 256_000
  })
);
assert.equal(
  refusalReason(() => resolveModelCapability({
    adapterId: 'ollama.chat.v1', model: 'gpt-4o-mini-2024-07-18'
  })),
  'model_capability_unknown',
  'a snapshot declared for one adapter is not authority on another'
);
assert.equal(
  assertOutputCapWithinModel(MODEL_CAPABILITIES['gpt-4o-mini-2024-07-18'], 16_384),
  16_384
);
assert.equal(
  refusalReason(() => assertOutputCapWithinModel(
    MODEL_CAPABILITIES['gpt-4o-mini-2024-07-18'], 16_385)),
  'output_cap_exceeds_model_maximum'
);

// ── Proofs are model-scoped, and unknown models fail closed ────────────────

assert.equal(
  resolveInputBoundProof({ adapterId: 'openai.responses.v1', model: 'gpt-4.1-mini' }).proofId,
  'openai.responses.v1/byte-ceiling-bpe/o200k/v1'
);
assert.equal(
  refusalReason(() => resolveInputBoundProof({
    adapterId: 'openai.responses.v1', model: 'gpt-5-turbo'
  })),
  'input_bound_proof_unknown',
  'an unknown OpenAI model inherits no tokenizer proof from its provider'
);
assert.equal(
  refusalReason(() => resolveInputBoundProof({
    adapterId: 'ollama.chat.v1', model: 'some-custom-gguf'
  })),
  'input_bound_proof_unknown',
  'an arbitrary Ollama model has no paid input-bound proof'
);
assert.equal(
  refusalReason(() => resolveInputBoundProof({
    adapterId: 'ollama.chat.v1', model: 'gpt-4.1-mini'
  })),
  'input_bound_proof_unknown',
  'a model proven on one adapter is not proven on another'
);
assert.match(proofHash(getInputBoundProof('openai.responses.v1/byte-ceiling-bpe/o200k/v1')),
  /^[0-9a-f]{64}$/);

const openAiProof = getInputBoundProof('openai.responses.v1/byte-ceiling-bpe/o200k/v1');
const governedOpenAiBody = {
  model: 'gpt-4o-mini-2024-07-18',
  input: [{ role: 'user', content: 'hello' }],
  text: { format: { type: 'json_object' } },
  max_output_tokens: 256,
  truncation: 'disabled'
};
assert.equal(assertInputBoundProofApplies(openAiProof, governedOpenAiBody).proofId,
  openAiProof.proofId, 'the governed body is inside the proof shape');

// Any newly chargeable input category invalidates the proof.
for (const feature of [
  'tools', 'images', 'files', 'previous_response_id', 'instructions', 'prompt', 'reasoning'
]) {
  assert.equal(
    refusalReason(() => assertInputBoundProofApplies(openAiProof, {
      ...governedOpenAiBody, [feature]: 'x'
    })),
    'input_bound_proof_request_shape_violation',
    `${feature} must invalidate the input bound rather than be silently unpriced`
  );
}
// A nested unsupported feature invalidates it too.
const ollamaProof = getInputBoundProof('ollama.chat.v1/byte-ceiling-bpe/llama/v1');
assert.equal(
  refusalReason(() => assertInputBoundProofApplies(ollamaProof, {
    model: 'm', messages: [], stream: false, format: 'json',
    options: { num_predict: 10, images: ['x'] }
  })),
  'input_bound_proof_unsupported_feature'
);

// ── Capability/pricing agreement ────────────────────────────────────────────

const openAiCapability = getAdapterCapability('openai.responses.v1');
const agreeing = {
  provider: 'openai',
  adapterId: 'openai.responses.v1',
  inputBoundProofId: 'openai.responses.v1/byte-ceiling-bpe/o200k/v1'
};
// A PAID dispatch requires a proven framing bound. Neither shipped proof has
// one, so paid dispatch refuses today — the byte ceiling bounds only the bytes
// this runtime sends, not what the provider or model template adds.
assert.equal(
  refusalReason(() => assertAdapterSupportsGovernedDispatch({
    capability: openAiCapability, proof: openAiProof, pricingEntry: agreeing
  })),
  'provider_path_not_hard_boundable',
  'an unproven framing allowance cannot authorize a paid dispatch'
);
assert.equal(openAiProof.framingBoundProven, false);
// With a proven framing bound the same route would be admissible; this proves
// the gate is the proof, not the provider name.
assert.equal(
  assertAdapterSupportsGovernedDispatch({
    capability: openAiCapability,
    proof: { ...openAiProof, framingBoundProven: true },
    pricingEntry: agreeing
  }).outputCapField,
  'max_output_tokens'
);
assert.equal(
  refusalReason(() => assertAdapterSupportsGovernedDispatch({
    capability: openAiCapability, proof: openAiProof,
    pricingEntry: { ...agreeing, provider: 'ollama' }
  })),
  'adapter_capability_pricing_disagreement'
);
assert.equal(
  refusalReason(() => assertAdapterSupportsGovernedDispatch({
    capability: openAiCapability, proof: openAiProof,
    pricingEntry: { ...agreeing, inputBoundProofId: 'ollama.chat.v1/byte-ceiling-bpe/llama/v1' }
  })),
  'adapter_capability_pricing_disagreement'
);
assert.equal(
  refusalReason(() => assertAdapterSupportsGovernedDispatch({
    capability: openAiCapability, proof: ollamaProof, pricingEntry: agreeing
  })),
  'input_bound_proof_not_applicable',
  'a proof for another adapter cannot authorize this one'
);
// A capability that does not serialize its cap can never authorize a governed
// dispatch, whatever the catalog says.
assert.equal(
  refusalReason(() => assertAdapterSupportsGovernedDispatch({
    capability: { ...openAiCapability, outputCapSerialized: false },
    proof: openAiProof,
    pricingEntry: agreeing
  })),
  'adapter_output_cap_not_serialized'
);
assert.equal(
  refusalReason(() => assertAdapterSupportsGovernedDispatch({
    capability: { ...openAiCapability, outputCapCoversCategories: ['output_text'] },
    proof: openAiProof,
    pricingEntry: agreeing
  })),
  'adapter_output_cap_incomplete',
  'a cap that misses reasoning tokens is not a complete output bound'
);

// ── The pre-network gate ────────────────────────────────────────────────────

// The pre-network gate proves BOTH governed fields.
const gate = assertGovernedOutputCapSerialized('openai.responses.v1', governedOpenAiBody, 256);
assert.equal(gate.serializedMaxOutputTokens, 256);
assert.equal(gate.serializedTruncation, 'disabled',
  'truncation is proven, never assumed from a provider default');
assert.equal(
  refusalReason(() => assertGovernedOutputCapSerialized('openai.responses.v1',
    { ...governedOpenAiBody, truncation: 'auto' }, 256)),
  'governed_truncation_not_disabled',
  'an altered truncation value refuses before the network'
);
assert.equal(
  refusalReason(() => assertGovernedOutputCapSerialized('openai.responses.v1',
    (({ truncation, ...rest }) => rest)(governedOpenAiBody), 256)),
  'governed_truncation_not_disabled',
  'a missing truncation value refuses before the network'
);
assert.equal(
  refusalReason(() => assertGovernedOutputCapSerialized('openai.responses.v1', {
    model: 'gpt-test', input: [], text: {}
  })),
  'adapter_output_cap_not_serialized',
  'a governed body without the cap refuses before the network'
);
assert.equal(
  refusalReason(() => assertGovernedOutputCapSerialized('openai.responses.v1',
    { ...governedOpenAiBody, max_output_tokens: 999 }, 256)),
  'adapter_output_cap_incomplete',
  'a serialized cap that differs from the authorized one refuses'
);
assert.equal(
  assertGovernedOutputCapSerialized('ollama.chat.v1', {
    model: 'm', messages: [], stream: false, format: 'json', options: { num_predict: 64 }
  }, 64).outputCapField,
  'options.num_predict',
  'the nested Ollama cap field is read by its declared path'
);
assert.equal(
  refusalReason(() => assertGovernedOutputCapSerialized('ollama.chat.v1', {
    model: 'm', messages: [], stream: false, format: 'json', options: {}
  })),
  'adapter_output_cap_not_serialized'
);

// ── The ACTUAL outgoing request body ────────────────────────────────────────
//
// server.js serializes exactly what these builders return (proven by the source
// assertions below), so inspecting a builder's output is inspecting the bytes
// that go on the wire. No credentials, no network, no paid request.

const {
  buildOllamaChatBody,
  buildOpenAiResponsesBody
} = require('../runtime/provider-request-body');

// Governed: the cap is physically present in the body.
const governedOpenAi = buildOpenAiResponsesBody({
  model: 'gpt-test',
  input: [{ role: 'user', content: 'hello' }],
  options: { governed: true, maxOutputTokens: 256 }
});
assert.equal(governedOpenAi.max_output_tokens, 256,
  'the governed OpenAI body physically contains max_output_tokens');
assert.equal(governedOpenAi.truncation, 'disabled',
  'the governed OpenAI body physically contains truncation=disabled');
assertGovernedOutputCapSerialized('openai.responses.v1', governedOpenAi, 256);

const governedOllama = buildOllamaChatBody({
  model: 'local-test',
  messages: [{ role: 'user', content: 'hello' }],
  options: { governed: true, maxOutputTokens: 64 }
});
assert.equal(governedOllama.options.num_predict, 64,
  'the governed Ollama body physically contains options.num_predict');
assertGovernedOutputCapSerialized('ollama.chat.v1', governedOllama, 64);
assertInputBoundProofApplies(ollamaProof, governedOllama);

// Ungoverned: byte-for-byte the pre-Tranche-4 body.
const ungovernedOpenAi = buildOpenAiResponsesBody({
  model: 'gpt-test',
  input: [{ role: 'user', content: 'hello' }],
  options: {}
});
assert.deepEqual(Object.keys(ungovernedOpenAi).sort(), ['input', 'model', 'text'],
  'an ungoverned OpenAI request is unchanged by this tranche');
for (const field of ['max_output_tokens', 'truncation']) {
  assert.equal(Object.prototype.hasOwnProperty.call(ungovernedOpenAi, field), false,
    `an ungoverned request carries no ${field}`);
}

const ungovernedOllama = buildOllamaChatBody({
  model: 'local-test',
  messages: [{ role: 'user', content: 'hello' }],
  options: {}
});
assert.deepEqual(Object.keys(ungovernedOllama).sort(),
  ['format', 'messages', 'model', 'stream'],
  'an ungoverned Ollama request is unchanged by this tranche');
assert.equal(Object.prototype.hasOwnProperty.call(ungovernedOllama, 'options'), false);

// A governed dispatch with no authorized cap refuses while building the body —
// before any caller could serialize or send it.
assert.equal(
  refusalReason(() => buildOpenAiResponsesBody({
    model: 'gpt-test', input: [], options: { governed: true }
  })),
  'adapter_output_cap_not_serialized',
  'a governed OpenAI call without a provable cap refuses before network contact'
);
assert.equal(
  refusalReason(() => buildOllamaChatBody({
    model: 'local-test', messages: [], options: { governed: true }
  })),
  'adapter_output_cap_not_serialized'
);
// A malformed cap is refused rather than dropped, which would silently
// downgrade a governed dispatch to an unbounded one.
for (const bad of [0, -1, 1.5, '256', Number.NaN]) {
  assert.throws(
    () => buildOpenAiResponsesBody({
      model: 'gpt-test', input: [], options: { governed: true, maxOutputTokens: bad }
    }),
    error => error.code === 'GOVERNED_OUTPUT_CAP_INVALID' ||
      error.code === 'PROVIDER_ADAPTER_CAPABILITY_REFUSED',
    `maxOutputTokens ${String(bad)} must not silently become an uncapped request`
  );
}

// ── Source-level proof of the serialize chain ───────────────────────────────
//
// The builder is only the real body if server.js sends exactly it.
const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
assert.match(serverSource, /const responseBody = buildOpenAiResponsesBody\(/,
  'the OpenAI adapter builds its body through the canonical builder');
assert.match(serverSource, /const responseBody = buildOllamaChatBody\(/,
  'the Ollama adapter builds its body through the canonical builder');
assert.match(serverSource, /body: JSON\.stringify\(responseBody\)/,
  'the adapter serializes exactly the built body');
// The cap field is written in exactly one place, and it is the builder.
const builderSource = fs.readFileSync(
  path.join(ROOT, 'runtime', 'provider-request-body.js'), 'utf8');
assert.match(builderSource, /body\.max_output_tokens = cap/);
assert.match(builderSource, /num_predict: cap/);
assert.equal(serverSource.includes('max_output_tokens'), false,
  'the adapter does not write the cap field itself; the builder owns it');
assert.equal(serverSource.includes('num_predict'), false,
  'the adapter does not write the cap field itself; the builder owns it');
// The capability record and the adapter must move together.
assert.equal(ADAPTER_CAPABILITIES['openai.responses.v1'].outputCapSerialized, true);
assert.equal(ADAPTER_CAPABILITIES['ollama.chat.v1'].outputCapSerialized, true);

console.log('provider adapter capability test passed');
