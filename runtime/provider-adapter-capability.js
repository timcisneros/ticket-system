'use strict';

// Tranche 4 — runtime-owned provider adapter capability and input-bound proofs.
//
// WHY THIS IS NOT IN THE PRICING CATALOG
//
// A pricing catalog is administrator-controlled data. If it were allowed to
// declare `transmitsOutputCap: true`, an administrator could make the runtime
// claim a hard cost bound that the adapter does not actually enforce, and the
// word "bounded" would become a lie that no test could catch. Adapter behavior
// is therefore a RUNTIME fact, declared here, adjacent to the adapter it
// describes, and proven by tests that inspect the real outgoing request body.
//
// Nothing here is configurable at runtime. These records change only when the
// adapter changes, in the same commit, with the request-body test updated.

const {
  compareCanonicalText,
  deepFreeze,
  hashCanonical
} = require('./declared-work-contract');

const ADAPTER_CAPABILITY_VERSION = 1;
const INPUT_BOUND_PROOF_VERSION = 1;

// Closed refusals for capability and proof evaluation.
const CAPABILITY_REFUSALS = Object.freeze([
  'adapter_capability_unknown',
  'adapter_output_cap_not_serialized',
  'adapter_output_cap_incomplete',
  'input_bound_proof_unknown',
  'input_bound_proof_not_applicable',
  'input_bound_proof_request_shape_violation',
  'input_bound_proof_unsupported_feature',
  'adapter_capability_pricing_disagreement',
  'model_capability_unknown',
  'model_capability_mutable_alias',
  'output_cap_exceeds_model_maximum',
  'governed_truncation_not_disabled',
  'provider_path_not_hard_boundable'
]);

class ProviderAdapterCapabilityError extends TypeError {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ProviderAdapterCapabilityError';
    this.code = code;
    this.reason = detail.reason || null;
  }
}

function fail(message, code = 'PROVIDER_ADAPTER_CAPABILITY_INVALID', detail = {}) {
  throw new ProviderAdapterCapabilityError(code, message, detail);
}

function refuse(reason, message = null) {
  if (!CAPABILITY_REFUSALS.includes(reason)) {
    fail(`Unsupported adapter-capability refusal reason: ${String(reason)}`);
  }
  fail(message || reason, 'PROVIDER_ADAPTER_CAPABILITY_REFUSED', { reason });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// ── Input-bound proofs ──────────────────────────────────────────────────────
//
// A bound method is NOT a provider-wide assertion. `tokens <= UTF-8 bytes` is
// true of a byte-level BPE vocabulary, but a maximum-liability calculation is
// only sound if it also covers EVERY provider-consumed billable input component
// for that exact API operation and request shape. A proof therefore names the
// operation, the exact request fields it has accounted for, and the features it
// does NOT cover — and evaluation fails closed the moment a request contains
// anything outside that shape.

// A proof is bound to an ADAPTER **and an exact set of model identities**. It is
// never provider-wide and never adapter-wide: two models behind the same API can
// use different tokenizers and different server-side prompt templates, so a bound
// proven for one says nothing about the other. Unknown models fail closed.
//
// `framingBoundProven` is the honest gate. A byte ceiling bounds the tokens of
// the bytes WE send. It says nothing about tokens the provider or the model
// template adds server-side. Unless the runtime can prove a finite upper bound
// for those additions too, the route is NOT monetarily hard-boundable, and a
// paid dispatch on it must refuse. Demonstrating arithmetic with a framing
// allowance does not prove the allowance is sufficient.
const INPUT_BOUND_PROOFS = deepFreeze({
  'openai.responses.v1/byte-ceiling-bpe/o200k/v1': {
    proofId: 'openai.responses.v1/byte-ceiling-bpe/o200k/v1',
    proofVersion: INPUT_BOUND_PROOF_VERSION,
    adapterId: 'openai.responses.v1',
    provider: 'openai',
    apiOperation: 'POST https://api.openai.com/v1/responses',
    requestShape: Object.freeze([
      'model', 'input', 'text', 'max_output_tokens', 'truncation'
    ]),
    chargeableInputFields: Object.freeze(['model', 'input', 'text']),
    tokenizerFamily: 'o200k_base',
    // Closed. A model absent from this list has no proof under this entry.
    models: Object.freeze([
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4o',
      'gpt-4o-mini'
    ]),
    framingAllowanceTokens: 64,
    // What the allowance is claimed to cover, stated field by field so the gap
    // is visible rather than implied.
    framingCoverage: deepFreeze({
      apiEnvelopeTokens: true,
      roleMarkers: true,
      specialTokens: true,
      serverSidePromptTemplate: false,
      autoInsertedControlTokens: false
    }),
    // FALSE, deliberately. The repository has no evidence establishing a finite
    // upper bound on the server-side envelope or any automatically inserted
    // control tokens for this API, so the 64-token allowance is an assertion,
    // not a proof. Until that is established, a PAID route using this proof is
    // classified not hard-boundable and refuses before provider contact.
    framingBoundProven: false,
    excludedRequestFeatures: Object.freeze([
      'tools', 'tool_choice', 'functions', 'image', 'images', 'file', 'files',
      'attachments', 'previous_response_id', 'conversation', 'store', 'prompt',
      'prompt_template', 'instructions', 'include', 'metadata', 'reasoning'
    ]),
    statement:
      'For POST /v1/responses restricted to {model, input, text, ' +
      'max_output_tokens} on the listed o200k_base models, the tokens of the ' +
      'bytes this runtime sends are at most the UTF-8 byte length of the exact ' +
      'serialized body, because every o200k_base token decodes to at least one ' +
      'byte. This bounds OUR bytes only. It does not bound server-side envelope ' +
      'or model-template additions, so framingBoundProven is false and paid ' +
      'dispatch under this proof is refused.'
  },
  'ollama.chat.v1/byte-ceiling-bpe/llama/v1': {
    proofId: 'ollama.chat.v1/byte-ceiling-bpe/llama/v1',
    proofVersion: INPUT_BOUND_PROOF_VERSION,
    adapterId: 'ollama.chat.v1',
    provider: 'ollama',
    apiOperation: 'POST {baseUrl}/api/chat',
    requestShape: Object.freeze(['model', 'messages', 'stream', 'format', 'options']),
    chargeableInputFields: Object.freeze(['model', 'messages', 'format']),
    tokenizerFamily: 'llama-byte-level-bpe',
    models: Object.freeze([
      'llama3',
      'llama3.1',
      'llama3.2'
    ]),
    framingAllowanceTokens: 64,
    framingCoverage: deepFreeze({
      apiEnvelopeTokens: true,
      roleMarkers: true,
      specialTokens: true,
      // The local runner applies the MODEL's own chat template, which varies per
      // model and per tag and is not bounded by anything this runtime controls.
      serverSidePromptTemplate: false,
      autoInsertedControlTokens: false
    }),
    framingBoundProven: false,
    excludedRequestFeatures: Object.freeze([
      'tools', 'images', 'template', 'system', 'context', 'keep_alive'
    ]),
    statement:
      'For POST /api/chat restricted to {model, messages, stream, format, ' +
      'options} on the listed llama-family models, the tokens of the bytes this ' +
      'runtime sends are at most the UTF-8 byte length of the exact serialized ' +
      'body. The local runner additionally applies the model\'s own chat ' +
      'template, whose token count this runtime cannot bound, so ' +
      'framingBoundProven is false and paid dispatch under this proof is refused.'
  }
});

function proofHash(proof) {
  return hashCanonical(proof);
}

// Exact (adapter, model) lookup. There is deliberately no fallback: an unlisted
// model does not inherit a sibling model's tokenizer or template behavior.
function resolveInputBoundProof({ adapterId, model }) {
  const wantedModel = typeof model === 'string' ? model.trim() : '';
  if (!wantedModel) fail('model is required to resolve an input-bound proof');
  const proof = Object.values(INPUT_BOUND_PROOFS).find(candidate =>
    candidate.adapterId === adapterId && candidate.models.includes(wantedModel)) || null;
  if (!proof) {
    refuse('input_bound_proof_unknown',
      `No input-bound proof covers model ${wantedModel} on adapter ${String(adapterId)}`);
  }
  return proof;
}

// ── Bound methods ───────────────────────────────────────────────────────────
//
// The canonical paid method for Tranche 4. All accepted input is subject to the
// model's finite context window, so the context window is itself a valid upper
// bound on billable input tokens — including server-side envelope tokens,
// special tokens and any hidden prompt additions, none of which can push
// accepted input past the ceiling. It therefore needs no framing estimate at
// all, which is exactly why it succeeds where the byte ceiling could not.
//
// It over-reserves, deliberately and substantially. That is the price of a bound
// that is honest without a tokenizer.
const BOUND_METHODS = Object.freeze([
  'model_context_window_ceiling',
  'catalog_maximum_exactly_zero'
]);

// ── Model capability registry ───────────────────────────────────────────────
//
// Exact provider snapshot identities only. A mutable alias ("gpt-4o", "latest")
// can change its limits and prices underneath a captured authority, so it is not
// hard-bound authority unless an administrator has explicitly pinned it — which
// this registry records rather than assumes.
//
// The administrator pricing catalog supplies PRICES. It may not supply or
// override any value here: context window, model maximum output, truncation
// behavior, adapter capability, or tokenizer/framing semantics.
const MODEL_CAPABILITY_VERSION = 1;

const MODEL_CAPABILITIES = deepFreeze({
  'gpt-4.1-2025-04-14': {
    modelId: 'gpt-4.1-2025-04-14',
    adapterId: 'openai.responses.v1',
    provider: 'openai',
    apiOperation: 'POST https://api.openai.com/v1/responses',
    contextWindowTokens: 1_047_576,
    maxOutputTokens: 32_768,
    supportedModalities: Object.freeze(['text']),
    supportedRequestShape: Object.freeze([
      'model', 'input', 'text', 'max_output_tokens', 'truncation'
    ]),
    contextLimitSourceIdentity: 'openai-platform-docs/models/gpt-4.1/2025-04-14',
    // When an administrator reviewed that evidence and admitted these limits.
    // Provenance for a runtime fact — never consulted at dispatch, never fetched.
    evidenceCapturedAt: '2026-08-01',
    capabilityVersion: MODEL_CAPABILITY_VERSION,
    isMutableAlias: false,
    boundMethod: 'model_context_window_ceiling'
  },
  'gpt-4.1-mini-2025-04-14': {
    modelId: 'gpt-4.1-mini-2025-04-14',
    adapterId: 'openai.responses.v1',
    provider: 'openai',
    apiOperation: 'POST https://api.openai.com/v1/responses',
    contextWindowTokens: 1_047_576,
    maxOutputTokens: 32_768,
    supportedModalities: Object.freeze(['text']),
    supportedRequestShape: Object.freeze([
      'model', 'input', 'text', 'max_output_tokens', 'truncation'
    ]),
    contextLimitSourceIdentity: 'openai-platform-docs/models/gpt-4.1-mini/2025-04-14',
    // When an administrator reviewed that evidence and admitted these limits.
    // Provenance for a runtime fact — never consulted at dispatch, never fetched.
    evidenceCapturedAt: '2026-08-01',
    capabilityVersion: MODEL_CAPABILITY_VERSION,
    isMutableAlias: false,
    boundMethod: 'model_context_window_ceiling'
  },
  'gpt-4o-mini-2024-07-18': {
    modelId: 'gpt-4o-mini-2024-07-18',
    adapterId: 'openai.responses.v1',
    provider: 'openai',
    apiOperation: 'POST https://api.openai.com/v1/responses',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    supportedModalities: Object.freeze(['text']),
    supportedRequestShape: Object.freeze([
      'model', 'input', 'text', 'max_output_tokens', 'truncation'
    ]),
    contextLimitSourceIdentity: 'openai-platform-docs/models/gpt-4o-mini/2024-07-18',
    // When an administrator reviewed that evidence and admitted these limits.
    // Provenance for a runtime fact — never consulted at dispatch, never fetched.
    evidenceCapturedAt: '2026-08-01',
    capabilityVersion: MODEL_CAPABILITY_VERSION,
    isMutableAlias: false,
    boundMethod: 'model_context_window_ceiling'
  }
});

function modelCapabilityHash(capability) {
  return hashCanonical(capability);
}

// Exact-identity lookup. An alias, an unlisted snapshot, or a model behind
// another adapter all fail closed rather than borrowing a sibling's limits.
function resolveModelCapability({ adapterId, model }) {
  const wanted = typeof model === 'string' ? model.trim() : '';
  if (!wanted) fail('model is required to resolve a model capability');
  const capability = MODEL_CAPABILITIES[wanted] || null;
  if (!capability) {
    refuse('model_capability_unknown',
      `No model capability is declared for ${wanted}`);
  }
  if (capability.adapterId !== adapterId) {
    refuse('model_capability_unknown',
      `${wanted} is declared for adapter ${capability.adapterId}, not ${String(adapterId)}`);
  }
  if (capability.isMutableAlias) {
    refuse('model_capability_mutable_alias',
      `${wanted} is a mutable alias and is not hard-bound authority`);
  }
  return capability;
}

// The authorized output cap must fit inside what the model actually supports,
// or the "maximum" output cost is not a maximum.
function assertOutputCapWithinModel(capability, maxOutputTokens) {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    fail('maxOutputTokens must be a positive safe integer');
  }
  if (maxOutputTokens > capability.maxOutputTokens) {
    refuse('output_cap_exceeds_model_maximum',
      `${capability.modelId} supports at most ${capability.maxOutputTokens} output tokens, ` +
      `but ${maxOutputTokens} was authorized`);
  }
  return maxOutputTokens;
}

// ── Adapter capabilities ────────────────────────────────────────────────────
//
// `outputCapSerialized` is the single load-bearing claim: it asserts that the
// adapter PHYSICALLY writes the cap field into the outgoing body for a governed
// request. scripts/provider-adapter-capability-test.js proves it by building the
// real body through the adapter seam and inspecting it, and additionally by
// reading the adapter source. Setting it true without changing the adapter makes
// those tests fail.

const ADAPTER_CAPABILITIES = deepFreeze({
  'openai.responses.v1': {
    adapterId: 'openai.responses.v1',
    version: ADAPTER_CAPABILITY_VERSION,
    provider: 'openai',
    apiOperation: 'POST https://api.openai.com/v1/responses',
    outputCapField: 'max_output_tokens',
    outputCapSerialized: true,
    // Governed requests must explicitly disable truncation rather than rely on a
    // provider default. With truncation disabled an over-long request is
    // REJECTED, which is what keeps "accepted input <= context window" true and
    // therefore keeps the context-ceiling bound valid.
    truncationField: 'truncation',
    requiredTruncationValue: 'disabled',
    // OpenAI bills reasoning tokens inside the output-token total, and
    // `max_output_tokens` bounds that same total, so the cap covers every
    // chargeable output category for this operation.
    chargeableOutputCategories: Object.freeze(['output_text', 'reasoning']),
    outputCapCoversCategories: Object.freeze(['output_text', 'reasoning']),
    usageFields: Object.freeze({
      input: 'input_tokens',
      output: 'output_tokens'
    }),
    supportsCancellation: true,
    inputBoundProofIds: Object.freeze(['openai.responses.v1/byte-ceiling-bpe/o200k/v1'])
  },
  'ollama.chat.v1': {
    adapterId: 'ollama.chat.v1',
    version: ADAPTER_CAPABILITY_VERSION,
    provider: 'ollama',
    apiOperation: 'POST {baseUrl}/api/chat',
    outputCapField: 'options.num_predict',
    outputCapSerialized: true,
    truncationField: null,
    requiredTruncationValue: null,
    chargeableOutputCategories: Object.freeze(['eval']),
    outputCapCoversCategories: Object.freeze(['eval']),
    usageFields: Object.freeze({
      input: 'prompt_eval_count',
      output: 'eval_count'
    }),
    supportsCancellation: true,
    inputBoundProofIds: Object.freeze(['ollama.chat.v1/byte-ceiling-bpe/llama/v1'])
  }
});

function capabilityHash(capability) {
  return hashCanonical(capability);
}

function getAdapterCapability(adapterId) {
  const capability = ADAPTER_CAPABILITIES[adapterId] || null;
  if (!capability) {
    refuse('adapter_capability_unknown', `No adapter capability is declared for ${String(adapterId)}`);
  }
  return capability;
}

function getInputBoundProof(proofId) {
  const proof = INPUT_BOUND_PROOFS[proofId] || null;
  if (!proof) {
    refuse('input_bound_proof_unknown', `No input-bound proof is declared for ${String(proofId)}`);
  }
  return proof;
}

// The adapter for a provider. Deliberately explicit rather than derived, so a
// new provider cannot silently inherit another adapter's guarantees.
const PROVIDER_ADAPTERS = deepFreeze({
  openai: 'openai.responses.v1',
  ollama: 'ollama.chat.v1'
});

function adapterIdForProvider(provider) {
  const adapterId = PROVIDER_ADAPTERS[provider] || null;
  if (!adapterId) {
    refuse('adapter_capability_unknown', `No adapter is declared for provider ${String(provider)}`);
  }
  return adapterId;
}

// ── Proof applicability against the ACTUAL request body ─────────────────────
//
// This is where "the proof must fail closed if the adapter gains tools, images,
// files, retained state or templates" is enforced. It inspects the real body
// that is about to be serialized, not a description of it.
function assertInputBoundProofApplies(proof, requestBody) {
  if (!isPlainObject(requestBody)) fail('governed request body must be an object');
  const present = Object.keys(requestBody);
  const outside = present.filter(field => !proof.requestShape.includes(field));
  if (outside.length > 0) {
    refuse('input_bound_proof_request_shape_violation',
      `${proof.proofId} does not cover request field(s): ${outside.sort(compareCanonicalText).join(', ')}`);
  }
  const unsupported = present.filter(field => proof.excludedRequestFeatures.includes(field));
  if (unsupported.length > 0) {
    refuse('input_bound_proof_unsupported_feature',
      `${proof.proofId} is invalidated by request feature(s): ${unsupported.join(', ')}`);
  }
  // Nested unsupported features (e.g. `options.tools` on Ollama) invalidate the
  // proof just as a top-level one does.
  for (const field of present) {
    const value = requestBody[field];
    if (!isPlainObject(value)) continue;
    const nested = Object.keys(value).filter(key => proof.excludedRequestFeatures.includes(key));
    if (nested.length > 0) {
      refuse('input_bound_proof_unsupported_feature',
        `${proof.proofId} is invalidated by nested request feature(s): ${field}.${nested.join(`, ${field}.`)}`);
    }
  }
  return proof;
}

// The adapter must actually be able to enforce the cap this proof's liability
// calculation assumes, and the pricing entry must be describing the same route.
function assertAdapterSupportsGovernedDispatch({ capability, proof, pricingEntry }) {
  if (capability.adapterId !== proof.adapterId) {
    refuse('input_bound_proof_not_applicable',
      `${proof.proofId} does not describe adapter ${capability.adapterId}`);
  }
  if (!capability.inputBoundProofIds.includes(proof.proofId)) {
    refuse('input_bound_proof_not_applicable',
      `${capability.adapterId} does not admit input-bound proof ${proof.proofId}`);
  }
  if (!capability.outputCapSerialized) {
    refuse('adapter_output_cap_not_serialized',
      `${capability.adapterId} does not serialize an output cap`);
  }
  const uncovered = capability.chargeableOutputCategories
    .filter(category => !capability.outputCapCoversCategories.includes(category));
  if (uncovered.length > 0) {
    refuse('adapter_output_cap_incomplete',
      `${capability.adapterId} output cap does not cover: ${uncovered.join(', ')}`);
  }
  if (pricingEntry) {
    if (pricingEntry.provider !== capability.provider) {
      refuse('adapter_capability_pricing_disagreement',
        `pricing entry provider ${pricingEntry.provider} does not match adapter ${capability.provider}`);
    }
    if (pricingEntry.inputBoundProofId !== proof.proofId) {
      refuse('adapter_capability_pricing_disagreement',
        `pricing entry names input-bound proof ${pricingEntry.inputBoundProofId}, ` +
        `not ${proof.proofId}`);
    }
    if (pricingEntry.adapterId !== capability.adapterId) {
      refuse('adapter_capability_pricing_disagreement',
        `pricing entry names adapter ${pricingEntry.adapterId}, not ${capability.adapterId}`);
    }
  }
  // Checked last, so a more specific mismatch is reported first. The byte
  // ceiling bounds only the bytes this runtime sends; without a proven finite
  // bound on server-side envelope and model-template additions the maximum is
  // not an upper bound at all, so a PAID dispatch refuses. Zero-priced routes
  // never reach here — their maximum is exactly zero.
  if (!proof.framingBoundProven) {
    refuse('provider_path_not_hard_boundable',
      `${proof.proofId} does not prove a finite framing bound ` +
      `(uncovered: ${Object.entries(proof.framingCoverage)
        .filter(([, covered]) => !covered).map(([name]) => name).join(', ')})`);
  }
  return deepFreeze({
    adapterId: capability.adapterId,
    adapterCapabilityHash: capabilityHash(capability),
    proofId: proof.proofId,
    inputBoundProofHash: proofHash(proof),
    outputCapField: capability.outputCapField
  });
}

// Read a possibly-dotted capability field path out of an actual request body.
function readBodyPath(requestBody, fieldPath) {
  return String(fieldPath).split('.').reduce(
    (node, key) => (isPlainObject(node) ? node[key] : undefined),
    requestBody
  );
}

// The last gate before the network. A governed dispatch may not proceed unless
// the cap this adapter claims to serialize is PHYSICALLY present in the body
// that is about to be sent, as a positive safe integer. This is what makes
// `outputCapSerialized` a checkable claim rather than a comment.
function assertGovernedOutputCapSerialized(adapterId, requestBody, expectedMaxOutputTokens = null) {
  const capability = getAdapterCapability(adapterId);
  if (!capability.outputCapSerialized) {
    refuse('adapter_output_cap_not_serialized',
      `${adapterId} declares no serialized output cap`);
  }
  const value = readBodyPath(requestBody, capability.outputCapField);
  if (!Number.isSafeInteger(value) || value <= 0) {
    refuse('adapter_output_cap_not_serialized',
      `${adapterId} governed request omits ${capability.outputCapField}`);
  }
  if (expectedMaxOutputTokens !== null && value !== expectedMaxOutputTokens) {
    refuse('adapter_output_cap_incomplete',
      `${adapterId} serialized ${capability.outputCapField}=${value}, ` +
      `but ${expectedMaxOutputTokens} was authorized`);
  }
  // Where the adapter declares a truncation control, a governed request must
  // carry the exact required value. A default is not evidence.
  let serializedTruncation = null;
  if (capability.truncationField !== null) {
    serializedTruncation = readBodyPath(requestBody, capability.truncationField);
    if (serializedTruncation !== capability.requiredTruncationValue) {
      refuse('governed_truncation_not_disabled',
        `${adapterId} governed request must send ` +
        `${capability.truncationField}=${capability.requiredTruncationValue}, ` +
        `got ${String(serializedTruncation)}`);
    }
  }
  return deepFreeze({
    adapterId,
    outputCapField: capability.outputCapField,
    serializedMaxOutputTokens: value,
    truncationField: capability.truncationField,
    serializedTruncation
  });
}

module.exports = {
  BOUND_METHODS,
  MODEL_CAPABILITIES,
  MODEL_CAPABILITY_VERSION,
  assertGovernedOutputCapSerialized,
  assertOutputCapWithinModel,
  modelCapabilityHash,
  resolveModelCapability,
  proofHash,
  resolveInputBoundProof,
  ADAPTER_CAPABILITIES,
  ADAPTER_CAPABILITY_VERSION,
  CAPABILITY_REFUSALS,
  INPUT_BOUND_PROOFS,
  INPUT_BOUND_PROOF_VERSION,
  PROVIDER_ADAPTERS,
  ProviderAdapterCapabilityError,
  adapterIdForProvider,
  assertAdapterSupportsGovernedDispatch,
  assertInputBoundProofApplies,
  capabilityHash,
  getAdapterCapability,
  getInputBoundProof,
  refuseAdapterCapability: refuse
};
