'use strict';

const {
  buildOpenAiResponsesBody
} = require('../../runtime/provider-request-body');
const {
  computeActualCost
} = require('../../runtime/model-pricing-catalog');

// Tranche 6 — the ONE place an evaluation decides what credential a spawned
// server may see.
//
// WHY THIS EXISTS. Two correct pieces of source contradicted each other, and
// the contradiction was invisible because the branch it broke was the one no
// test took.
//
// `postgres-test-harness` deliberately deletes OPENAI_API_KEY from the
// inherited environment before spawning. That rule is right and stays: a
// real-server suite once stubbed `global.fetch`, believed itself offline, and
// the governed transport uses `https.request` — a developer key could have
// reached the live API. Stripping protects every suite, not just that one.
//
// `runTrial` then supplied nothing for a genuine live run, on the stated
// assumption that it was "inheriting the real credential from normal secret
// configuration". The harness had deleted it two frames earlier. Every live
// proof to date ran through the capture branch, which supplies a sentinel, so
// the credential path a real run depends on was never exercised.
//
// The fix is not to weaken the harness. It is to say, in one auditable place,
// which of exactly three modes is running and what each may receive:
//
//   fixture                  -> sentinel. Never the real credential.
//   synthetic live capture   -> sentinel. The final hop is replaced, so a real
//                               key would be pointless risk.
//   real uncaptured live     -> the explicitly selected configured-agent
//                               credential authority, resolved once from
//                               PostgreSQL and forwarded into the env override,
//                               which the harness applies AFTER stripping and
//                               therefore wins.
//
// THE SECRET PASSES THROUGH, IT IS NEVER DESCRIBED. This module receives the
// value because the child process must inherit it. Nothing here returns it to a
// diagnostic, hashes it, measures it, or interpolates it into an error. The
// only observable fact is `credentialPresent`.

const SENTINEL_CREDENTIAL = 'test-only-sentinel-not-a-real-credential';

// Only OPENAI_API_KEY is forwarded. `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` are
// stripped by the harness too, but production consumes neither — audited in
// server.js `resolveGovernedPlannerCredentials` and `getAgentOpenAIConfig` —
// so forwarding them would add unused secret movement for symmetry alone.
const FORWARDED_CREDENTIAL_KEYS = Object.freeze(['OPENAI_API_KEY']);

const EVALUATION_SERVER_MODES = Object.freeze([
  'fixture', 'synthetic_live_capture', 'real_uncaptured_live'
]);

const RESOLVED_AUTHORITY = Symbol('resolved-real-live-credential-authority');
const PREFLIGHT_AUTHORITY = Symbol('authenticated-preflight-authority');
const OPENAI_RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';
const AUTHORITY_KIND = 'configured_agent';

class EvaluationServerEnvError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'EvaluationServerEnvError';
    this.code = detail.code || 'EVALUATION_SERVER_ENV_INVALID';
    this.detail = detail;
  }
}

function classifyEvaluationServerMode({ mode, liveTransportCapture }) {
  if (mode !== 'live') return 'fixture';
  return liveTransportCapture ? 'synthetic_live_capture' : 'real_uncaptured_live';
}

function normalizeCredentialAuthoritySelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.kind !== AUTHORITY_KIND ||
      !Number.isSafeInteger(value.configuredAgentId) ||
      value.configuredAgentId <= 0) {
    throw new EvaluationServerEnvError(
      'real live evaluation requires credentialAuthority.kind=configured_agent ' +
      'and a positive configuredAgentId',
      { code: 'REAL_LIVE_CREDENTIAL_AUTHORITY_REQUIRED' });
  }
  return Object.freeze({
    kind: AUTHORITY_KIND,
    configuredAgentId: value.configuredAgentId
  });
}

function assertResolvedRealLiveCredentialAuthority(authority) {
  if (!authority || authority[RESOLVED_AUTHORITY] !== true ||
      !authority.nonSecretIdentity ||
      typeof authority.credential !== 'string' ||
      authority.credential.trim().length === 0) {
    throw new EvaluationServerEnvError(
      'real live credential authority was not resolved from the configured-agent repository',
      { code: 'REAL_LIVE_CREDENTIAL_AUTHORITY_UNRESOLVED' });
  }
  return authority;
}

async function resolveRealLiveCredentialAuthority({
  store, credentialAuthority, expectedProvider = 'openai'
}) {
  const selection = normalizeCredentialAuthoritySelection(credentialAuthority);
  if (!store || typeof store.getConfiguredAgentById !== 'function') {
    throw new EvaluationServerEnvError(
      'configured-agent credential authority requires the configured-agent repository',
      { code: 'REAL_LIVE_CREDENTIAL_AUTHORITY_REPOSITORY_REQUIRED' });
  }
  const agent = await store.getConfiguredAgentById(selection.configuredAgentId);
  if (!agent) {
    throw new EvaluationServerEnvError(
      `configured-agent credential authority ${selection.configuredAgentId} does not exist`,
      { code: 'REAL_LIVE_CREDENTIAL_AUTHORITY_NOT_FOUND' });
  }
  if (agent.provider !== expectedProvider) {
    throw new EvaluationServerEnvError(
      `configured-agent credential authority ${selection.configuredAgentId} is not ` +
      `compatible with provider ${expectedProvider}`,
      { code: 'REAL_LIVE_CREDENTIAL_AUTHORITY_PROVIDER_MISMATCH' });
  }
  const credential = typeof agent.apiKey === 'string' ? agent.apiKey.trim() : '';
  if (!credential) {
    throw new EvaluationServerEnvError(
      `configured-agent credential authority ${selection.configuredAgentId} has no ` +
      'persisted OpenAI credential',
      { code: 'REAL_LIVE_CREDENTIAL_AUTHORITY_CREDENTIAL_ABSENT' });
  }
  if (!Number.isSafeInteger(agent.revision) || agent.revision <= 0) {
    throw new EvaluationServerEnvError(
      `configured-agent credential authority ${selection.configuredAgentId} has no ` +
      'valid revision authority',
      { code: 'REAL_LIVE_CREDENTIAL_AUTHORITY_REVISION_INVALID' });
  }

  // THE STORED MODEL IS DELIBERATELY NOT PART OF THIS IDENTITY. This row is
  // selected as credential authority, not as the experiment's execution
  // target. The frozen live manifest remains the sole owner of the model sent
  // by every role. The row revision still makes any authority-bearing edit —
  // including a credential rotation — a resume-visible change.
  const nonSecretIdentity = Object.freeze({
    kind: AUTHORITY_KIND,
    configuredAgentId: selection.configuredAgentId,
    configuredAgentRevision: agent.revision,
    provider: agent.provider
  });
  const resolved = { nonSecretIdentity };
  Object.defineProperty(resolved, 'credential', {
    value: credential,
    enumerable: false,
    writable: false,
    configurable: false
  });
  Object.defineProperty(resolved, RESOLVED_AUTHORITY, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false
  });
  return Object.freeze(resolved);
}

function realLiveCredentialAuthorityIdentity(authority) {
  return assertResolvedRealLiveCredentialAuthority(authority).nonSecretIdentity;
}

function sameCredentialAuthority(left, right) {
  if (!left || !right) return false;
  return left.kind === right.kind &&
    left.configuredAgentId === right.configuredAgentId &&
    left.configuredAgentRevision === right.configuredAgentRevision &&
    left.provider === right.provider;
}

// Returns ONLY the credential portion of the server env override. The caller
// merges it with the rest; keeping it separate is what makes the rule auditable
// in one place instead of inside a large object literal.
function buildEvaluationServerCredentialEnv({
  mode, liveTransportCapture, resolvedLiveCredentialAuthority = null
}) {
  const serverMode = classifyEvaluationServerMode({ mode, liveTransportCapture });
  if (!EVALUATION_SERVER_MODES.includes(serverMode)) {
    throw new EvaluationServerEnvError(`unknown evaluation server mode ${serverMode}`,
      { code: 'EVALUATION_SERVER_MODE_UNKNOWN', serverMode });
  }

  if (serverMode !== 'real_uncaptured_live') {
    // FIXTURE AND CAPTURED LIVE. A sentinel, always — never the inherited real
    // credential. The governed planner refuses to route without SOME credential
    // present, so the sentinel is what lets the real dispatch path run at all
    // while guaranteeing nothing can leave the machine.
    if (resolvedLiveCredentialAuthority !== null &&
        resolvedLiveCredentialAuthority !== undefined) {
      throw new EvaluationServerEnvError(
        'fixture and captured-live modes must not receive real credential authority',
        { code: 'HERMETIC_MODE_REAL_CREDENTIAL_FORBIDDEN' });
    }
    return Object.freeze({
      serverMode,
      credentialPresent: true,
      usesRealCredential: false,
      env: Object.freeze({ OPENAI_API_KEY: SENTINEL_CREDENTIAL })
    });
  }

  // REAL UNCAPTURED LIVE. Ambient OPENAI_API_KEY is not authority. The caller
  // must resolve the explicitly selected configured-agent row once and hand
  // that in-memory result to both authenticated preflight and experiment. The
  // harness strips ambient credentials; this explicit override is applied
  // afterwards and is the only value the child receives.
  const authority = assertResolvedRealLiveCredentialAuthority(
    resolvedLiveCredentialAuthority);
  const credential = authority.credential;
  if (credential === SENTINEL_CREDENTIAL) {
    throw new EvaluationServerEnvError(
      'the inherited credential is the test sentinel; a real live run must not ' +
      'be launched from a harness environment',
      { code: 'REAL_LIVE_CREDENTIAL_IS_SENTINEL' });
  }
  return Object.freeze({
    serverMode,
    credentialPresent: true,
    usesRealCredential: true,
    // The value passes through untouched and is never described.
    env: Object.freeze({ OPENAI_API_KEY: credential })
  });
}

async function defaultAuthenticatedPreflightTransport({ credential, body }) {
  let response;
  try {
    response = await fetch(OPENAI_RESPONSES_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000)
    });
  } catch (_) {
    throw new EvaluationServerEnvError(
      'authenticated live preflight could not reach the OpenAI Responses endpoint',
      { code: 'REAL_LIVE_AUTHENTICATED_PREFLIGHT_TRANSPORT_FAILED' });
  }
  let payload = null;
  try { payload = await response.json(); } catch (_) { /* classified below */ }
  return {
    ok: response.ok,
    status: response.status,
    requestId: response.headers.get('x-request-id') || null,
    body: payload
  };
}

function safeUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const inputTokens = value.input_tokens;
  const outputTokens = value.output_tokens;
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 ||
      !Number.isSafeInteger(outputTokens) || outputTokens < 0) return null;
  return Object.freeze({
    inputTokens,
    outputTokens,
    totalTokens: Number.isSafeInteger(value.total_tokens) && value.total_tokens >= 0
      ? value.total_tokens : inputTokens + outputTokens
  });
}

async function authenticatedRealLivePreflight({
  manifest, resolvedLiveCredentialAuthority,
  transport = defaultAuthenticatedPreflightTransport
}) {
  const authority = assertResolvedRealLiveCredentialAuthority(
    resolvedLiveCredentialAuthority);
  if (!manifest || manifest.mode !== 'live' || manifest.provider !== 'openai' ||
      manifest.adapterId !== 'openai.responses.v1') {
    throw new EvaluationServerEnvError(
      'authenticated live preflight requires the frozen OpenAI Responses live manifest',
      { code: 'REAL_LIVE_AUTHENTICATED_PREFLIGHT_MANIFEST_INVALID' });
  }
  if (authority.nonSecretIdentity.provider !== manifest.provider) {
    throw new EvaluationServerEnvError(
      'authenticated live preflight credential authority does not match the manifest provider',
      { code: 'REAL_LIVE_AUTHENTICATED_PREFLIGHT_AUTHORITY_MISMATCH' });
  }
  const requestControls = Object.freeze({
    temperature: manifest.sampling.temperature,
    topP: manifest.sampling.topP,
    maxOutputTokens: manifest.maximumOutputTokensPerRequest
  });
  const body = buildOpenAiResponsesBody({
    model: manifest.model,
    input: [{
      role: 'user',
      content: 'Return one JSON object with the boolean field ok set to true.'
    }],
    options: {
      sampling: {
        temperature: requestControls.temperature,
        topP: requestControls.topP
      },
      maxOutputTokens: requestControls.maxOutputTokens
    }
  });

  let response;
  try {
    response = await transport({
      endpoint: OPENAI_RESPONSES_ENDPOINT,
      credential: authority.credential,
      body
    });
  } catch (error) {
    if (error instanceof EvaluationServerEnvError) throw error;
    throw new EvaluationServerEnvError(
      'authenticated live preflight transport failed',
      { code: 'REAL_LIVE_AUTHENTICATED_PREFLIGHT_TRANSPORT_FAILED' });
  }
  if (!response || response.ok !== true || response.status !== 200) {
    throw new EvaluationServerEnvError(
      `authenticated live preflight was refused with HTTP ${response && response.status}`,
      { code: 'REAL_LIVE_AUTHENTICATED_PREFLIGHT_REFUSED' });
  }
  const payload = response.body;
  if (!payload || typeof payload !== 'object' || payload.model !== manifest.model) {
    throw new EvaluationServerEnvError(
      'authenticated live preflight did not confirm the exact frozen model',
      { code: 'REAL_LIVE_AUTHENTICATED_PREFLIGHT_MODEL_MISMATCH' });
  }
  const usage = safeUsage(payload.usage);
  const actualCostMicroUsd = usage ? computeActualCost({
    entry: {
      inputMicroUsdPerMillionTokens:
        manifest.pricing.inputMicroUsdPerMillionTokens,
      outputMicroUsdPerMillionTokens:
        manifest.pricing.outputMicroUsdPerMillionTokens,
      requestMicroUsd: 0
    },
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    requestCount: 1
  }) : null;
  const proof = {
    authenticatedPreflightVersion: 1,
    manifestHash: manifest.manifestHash,
    credentialAuthority: authority.nonSecretIdentity,
    provider: manifest.provider,
    adapterId: manifest.adapterId,
    model: manifest.model,
    requestControls,
    requestId: typeof response.requestId === 'string' ? response.requestId : null,
    usage,
    actualCostMicroUsd,
    providerCallsMade: 1
  };
  Object.defineProperty(proof, PREFLIGHT_AUTHORITY, {
    value: authority,
    enumerable: false,
    writable: false,
    configurable: false
  });
  return Object.freeze(proof);
}

function assertAuthenticatedPreflightAuthority({
  preflight, resolvedLiveCredentialAuthority, manifestHash
}) {
  const authority = assertResolvedRealLiveCredentialAuthority(
    resolvedLiveCredentialAuthority);
  if (!preflight || preflight[PREFLIGHT_AUTHORITY] !== authority ||
      preflight.manifestHash !== manifestHash ||
      !sameCredentialAuthority(
        preflight.credentialAuthority, authority.nonSecretIdentity)) {
    throw new EvaluationServerEnvError(
      'authenticated preflight and experiment must consume the same resolved credential authority',
      { code: 'REAL_LIVE_PREFLIGHT_EXPERIMENT_AUTHORITY_MISMATCH' });
  }
  return true;
}

// The observable shape, for run headers, journals and diagnostics. It carries
// no secret and no derivative of one.
function describeEvaluationServerCredential(built) {
  return Object.freeze({
    serverMode: built.serverMode,
    credentialPresent: built.credentialPresent,
    usesRealCredential: built.usesRealCredential
  });
}

module.exports = {
  AUTHORITY_KIND,
  EVALUATION_SERVER_MODES,
  EvaluationServerEnvError,
  FORWARDED_CREDENTIAL_KEYS,
  OPENAI_RESPONSES_ENDPOINT,
  SENTINEL_CREDENTIAL,
  assertAuthenticatedPreflightAuthority,
  authenticatedRealLivePreflight,
  buildEvaluationServerCredentialEnv,
  classifyEvaluationServerMode,
  describeEvaluationServerCredential,
  normalizeCredentialAuthoritySelection,
  realLiveCredentialAuthorityIdentity,
  resolveRealLiveCredentialAuthority,
  sameCredentialAuthority
};
