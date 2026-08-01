'use strict';

// Tranche 4 — the single place each provider request body is constructed.
//
// The adapters in server.js serialize EXACTLY what these builders return, so a
// test that inspects a builder's output is inspecting the bytes that go on the
// wire. That is what makes `outputCapSerialized` in provider-adapter-capability
// a checkable claim instead of a comment: the field is written here, asserted
// here, and proven by scripts/provider-adapter-capability-test.js.
//
// Governed and ungoverned dispatch differ in exactly one way. A governed caller
// supplies an authorized `maxOutputTokens`, which is serialized into the
// provider-native cap field and then re-read from the built body before the
// network. An ungoverned caller supplies nothing and receives the byte-for-byte
// pre-Tranche-4 body, so historical ordinary Runs, v1 allocation, workflow,
// simulation and browser/process paths are unaffected.

const {
  assertGovernedOutputCapSerialized
} = require('./provider-adapter-capability');

function governedOutputCap(options) {
  const cap = options && options.maxOutputTokens;
  if (cap === null || cap === undefined) return null;
  if (!Number.isSafeInteger(cap) || cap <= 0) {
    const error = new TypeError('maxOutputTokens must be a positive safe integer');
    error.code = 'GOVERNED_OUTPUT_CAP_INVALID';
    throw error;
  }
  return cap;
}

function buildOpenAiResponsesBody({ model, input, options = {} }) {
  const body = {
    model,
    input,
    text: {
      format: {
        type: 'json_object'
      }
    }
  };
  const cap = governedOutputCap(options);
  if (cap !== null) {
    body.max_output_tokens = cap;
    // Explicit, never a provider default. Truncation disabled is what makes
    // "accepted input <= context window" hold, and the context ceiling is the
    // whole basis of the paid monetary bound.
    body.truncation = 'disabled';
  }
  // A governed dispatch proves the cap is present in THIS body before the
  // caller is allowed to send it. An authorized amount that failed to serialize
  // refuses here, with zero provider contact.
  if (options.governed === true) {
    assertGovernedOutputCapSerialized('openai.responses.v1', body, cap);
  }
  return body;
}

function buildOllamaChatBody({ model, messages, options = {} }) {
  const body = {
    model,
    messages,
    stream: false,
    format: 'json'
  };
  const cap = governedOutputCap(options);
  if (cap !== null) body.options = { num_predict: cap };
  if (options.governed === true) {
    assertGovernedOutputCapSerialized('ollama.chat.v1', body, cap);
  }
  return body;
}

module.exports = {
  buildOllamaChatBody,
  buildOpenAiResponsesBody,
  governedOutputCap
};
