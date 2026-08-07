'use strict';

// Tranche 6 — the single canonical authority for live provider request controls.
//
// WHY THIS EXISTS. The Responses body carried no sampling controls and, on the
// ungoverned path, no output cap either. Both defaults are invisible in the
// request evidence and unreproducible afterwards. A hermetic fixture never
// reaches a provider, so it did not matter there; a live evaluation whose
// manifest freezes `temperature 0`, `top_p 1` and a 2,048-token output cap
// cannot tolerate it — and the economic bound is only real if the cap the
// liability model assumes is the cap that actually goes on the wire.
//
// THE CONTRACT, and the reason it is one function rather than three:
//
//   * there is NO ambient default. Absent configuration returns null, the body
//     builder adds nothing, and the request is byte-identical to what it has
//     always been. That is what keeps every completed fixture artifact valid;
//   * when configuration IS present it must be exact and complete. A partial or
//     malformed value refuses rather than falling back, because a silent
//     fallback is precisely the ambient default this module exists to remove;
//   * every role reads THIS function. Planner, governed leaf and ungoverned
//     worker cannot diverge, because there is only one place to read from.
//
// THE OUTPUT CAP IS NOT AN OVERRIDE. A governed role already carries an
// authorized `maximumOutputTokensPerRequest` from its economic policy, and that
// authorization wins — a request may never be enlarged by this module. The cap
// here is what the UNGOVERNED path lacks entirely, and for governed roles it is
// the value their authorization is checked to agree with. See
// `assertOutputCapAgrees`.
//
// The value is supplied per process by the live runner. It can change request
// controls and nothing else: it names no host, no model, no credential and no
// route, so it cannot redirect a request anywhere.

const CONTROLS_ENV = 'EVALUATION_LIVE_REQUEST_CONTROLS';
const REQUIRED_KEYS = 'maxOutputTokens,temperature,topP';

function exactNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${CONTROLS_ENV}.${field} must be an exact number`);
  }
  return value;
}

function resolveLiveRequestControls(env = process.env) {
  const raw = env[CONTROLS_ENV];
  if (raw === undefined || raw === null || raw === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TypeError(
      `${CONTROLS_ENV} is present but not valid JSON; live request controls must ` +
      'be exact, and an unparseable value is refused rather than defaulted');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`${CONTROLS_ENV} must be an object`);
  }
  const keys = Object.keys(parsed).sort();
  if (keys.join(',') !== REQUIRED_KEYS) {
    throw new TypeError(
      `${CONTROLS_ENV} must carry exactly ${REQUIRED_KEYS}, not ${keys.join(', ')}`);
  }
  exactNumber(parsed.temperature, 'temperature');
  exactNumber(parsed.topP, 'topP');
  if (!Number.isSafeInteger(parsed.maxOutputTokens) || parsed.maxOutputTokens <= 0) {
    throw new TypeError(
      `${CONTROLS_ENV}.maxOutputTokens must be a positive safe integer`);
  }
  return Object.freeze({
    sampling: Object.freeze({
      temperature: parsed.temperature,
      topP: parsed.topP
    }),
    maxOutputTokens: parsed.maxOutputTokens
  });
}

// The sampling half, for callers that only serialize sampling.
function resolveProviderSampling(env = process.env) {
  const controls = resolveLiveRequestControls(env);
  return controls ? controls.sampling : null;
}

// The output cap for a role that has NO economic authority of its own. A
// governed role must not call this — its authorized cap is the authority.
function resolveUngovernedOutputCap(env = process.env) {
  const controls = resolveLiveRequestControls(env);
  return controls ? controls.maxOutputTokens : null;
}

// THE AGREEMENT CHECK. A governed role's authorized cap and the live control
// must be the same number, because the liability model prices every request at
// one cap. If they diverged, the wire would carry one bound while the money was
// reserved against another — the exact condition that made the previous
// liability claim false for the ungoverned arms.
function assertOutputCapAgrees(authorizedCap, env = process.env) {
  const controls = resolveLiveRequestControls(env);
  if (controls === null) return authorizedCap;
  if (authorizedCap !== controls.maxOutputTokens) {
    const error = new Error(
      `authorized output cap ${authorizedCap} disagrees with the frozen live ` +
      `control ${controls.maxOutputTokens}; the wire cap and the priced cap ` +
      'must be one number');
    error.code = 'LIVE_OUTPUT_CAP_DISAGREEMENT';
    throw error;
  }
  return authorizedCap;
}

module.exports = {
  CONTROLS_ENV,
  resolveLiveRequestControls,
  resolveProviderSampling,
  resolveUngovernedOutputCap,
  assertOutputCapAgrees
};
