'use strict';

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
//   real uncaptured live     -> the explicitly authorized credential, forwarded
//                               into the env override, which the harness applies
//                               AFTER stripping and therefore wins.
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

// Returns ONLY the credential portion of the server env override. The caller
// merges it with the rest; keeping it separate is what makes the rule auditable
// in one place instead of inside a large object literal.
function buildEvaluationServerCredentialEnv({
  mode, liveTransportCapture, env = process.env
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
    return Object.freeze({
      serverMode,
      credentialPresent: true,
      usesRealCredential: false,
      env: Object.freeze({ OPENAI_API_KEY: SENTINEL_CREDENTIAL })
    });
  }

  // REAL UNCAPTURED LIVE. The harness has already stripped the inherited
  // credential; this override is applied after it and therefore restores it.
  const credential = env.OPENAI_API_KEY;
  if (typeof credential !== 'string' || credential.trim().length === 0) {
    // REFUSE BEFORE SPAWN. A live server with no credential would fail every
    // trial at its first request and could produce 120 authentication failures
    // from one configuration mistake.
    throw new EvaluationServerEnvError(
      'a real uncaptured live trial requires OPENAI_API_KEY in the environment ' +
      'it inherits; refusing to spawn a server that cannot authenticate',
      { code: 'REAL_LIVE_CREDENTIAL_ABSENT' });
  }
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
  EVALUATION_SERVER_MODES,
  EvaluationServerEnvError,
  FORWARDED_CREDENTIAL_KEYS,
  SENTINEL_CREDENTIAL,
  buildEvaluationServerCredentialEnv,
  classifyEvaluationServerMode,
  describeEvaluationServerCredential
};
