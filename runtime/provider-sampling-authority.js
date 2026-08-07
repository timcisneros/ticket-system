'use strict';

// Tranche 6 — the single canonical sampling authority.
//
// WHY THIS EXISTS. The Responses body carried no sampling controls, so every
// request inherited whatever the provider chose. That is invisible in the
// request evidence and unreproducible afterwards. A hermetic fixture never
// reaches a provider, so it did not matter there; a live evaluation whose
// manifest freezes `temperature 0` and `top_p 1` cannot tolerate it.
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
// The value is supplied per process by the scored live runner. It can change
// sampling and nothing else: it names no host, no model, no credential and no
// route, so it cannot redirect a request anywhere.

const SAMPLING_ENV = 'EVALUATION_LIVE_SAMPLING';

function resolveProviderSampling(env = process.env) {
  const raw = env[SAMPLING_ENV];
  if (raw === undefined || raw === null || raw === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TypeError(
      `${SAMPLING_ENV} is present but not valid JSON; sampling must be exact, ` +
      'and an unparseable value is refused rather than defaulted');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`${SAMPLING_ENV} must be an object`);
  }
  const keys = Object.keys(parsed).sort();
  if (keys.join(',') !== 'temperature,topP') {
    throw new TypeError(
      `${SAMPLING_ENV} must carry exactly temperature and topP, not ${keys.join(', ')}`);
  }
  if (typeof parsed.temperature !== 'number' || !Number.isFinite(parsed.temperature)) {
    throw new TypeError(`${SAMPLING_ENV}.temperature must be an exact number`);
  }
  if (typeof parsed.topP !== 'number' || !Number.isFinite(parsed.topP)) {
    throw new TypeError(`${SAMPLING_ENV}.topP must be an exact number`);
  }
  return Object.freeze({ temperature: parsed.temperature, topP: parsed.topP });
}

module.exports = { SAMPLING_ENV, resolveProviderSampling };
