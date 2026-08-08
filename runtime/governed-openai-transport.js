'use strict';

// Tranche 4 — the production OpenAI governed transport.
//
// It sends bytes. That is the whole responsibility, and the deliberate
// narrowness is the point:
//
//   * the endpoint is the fixed official one, not configurable;
//   * the body is the persisted string, written to the socket as-is;
//   * nothing is serialized, re-serialized, merged or defaulted here.
//
// There is NO configurable base URL. A test injects a different transport
// function rather than pointing this one somewhere else, so no configuration
// value can ever redirect a real governed request.

const https = require('node:https');
const {
  observeProviderTransportInvocation
} = require('./provider-transport-observation');

const GOVERNED_OPENAI_HOSTNAME = 'api.openai.com';
const GOVERNED_OPENAI_PATH = '/v1/responses';
const GOVERNED_OPENAI_ENDPOINT = `https://${GOVERNED_OPENAI_HOSTNAME}${GOVERNED_OPENAI_PATH}`;

// Creates the transport function the orchestration calls. Everything it needs
// arrives per-request from the reservation; the factory itself holds no route,
// model or credential.
//
// `httpsRequest` is a DEPENDENCY SEAM, not configuration. It is the Node
// `https.request` function itself, and substituting it lets a test observe the
// exact options, headers and bytes this module produces. It cannot redirect
// anything: the host and path are constants below and are asserted per request,
// so no injected factory — and no configuration value that could ever reach one
// — can point a governed request somewhere else.
function createOpenAiGovernedTransport({ httpsRequest = https.request } = {}) {
  return async function openAiGovernedTransport({
    endpointIdentity,
    serializedRequest,
    credentials,
    timeoutMs,
    maxResponseBytes,
    // APPEND-ONLY EVIDENCE, supplied per request. It is invoked AFTER the
    // platform call below, never before it, so the fact it records is one that
    // already happened. It cannot influence the endpoint, the bytes, the
    // credential, the timeout or the outcome: it receives none of them, it
    // cannot throw, and its return value is discarded.
    observeTransportInvocation = null,
    transportInvocationIdentity = null,
    // Bounded diagnostic for an evidence write that did not land. Never awaited
    // on the provider path and never able to fail it.
    reportObservationFailure = null
  }) {
    // The endpoint is verified rather than trusted: a captured request whose
    // endpoint is not the official one is refused instead of being sent
    // somewhere else.
    if (endpointIdentity !== GOVERNED_OPENAI_ENDPOINT) {
      throw new Error(
        `governed OpenAI dispatch refuses endpoint ${String(endpointIdentity)}`);
    }
    const apiKey = credentials && credentials.apiKey;
    if (!apiKey) throw new Error('no OpenAI credential was resolved');

    // The bytes, measured once, sent once.
    const payload = Buffer.from(serializedRequest, 'utf8');

    // THE PLATFORM CALL HAPPENS INSIDE THIS EXECUTOR, SYNCHRONOUSLY.
    //
    // `new Promise` runs its executor before it returns, so by the time
    // `settled` exists, `httpsRequest` has been invoked and `request.end` has
    // handed it the payload. That is what makes the observation below a record
    // of an invocation that ALREADY OCCURRED rather than one about to be
    // attempted — and it is why the promise is hoisted out of the `return`
    // instead of being awaited in place.
    //
    // Nothing about the request itself changed: the same options, the same
    // listeners, the same `end(payload)`, in the same order.
    const settled = new Promise((resolve, reject) => {
      const request = httpsRequest({
        // Spelled as discrete options rather than a URL string so a test can
        // read back exactly what production sends.
        protocol: 'https:',
        hostname: GOVERNED_OPENAI_HOSTNAME,
        port: 443,
        path: GOVERNED_OPENAI_PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.byteLength,
          Authorization: `Bearer ${apiKey}`
        },
        timeout: timeoutMs
      }, response => {
        const statusCode = response.statusCode;
        const chunks = [];
        let received = 0;
        let overflowed = false;
        response.on('data', chunk => {
          received += chunk.length;
          // The existing response bound, enforced on the wire so an oversized
          // body is abandoned rather than buffered.
          if (received > maxResponseBytes) {
            overflowed = true;
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (overflowed) {
            const error = new Error(
              `governed response exceeded ${maxResponseBytes} bytes`);
            error.responseTooLarge = true;
            reject(error);
            return;
          }
          const text = Buffer.concat(chunks).toString('utf8');
          // A provider status failure is a failure, not a response. Resolving
          // it as one would let an error page be parsed as a proposal and
          // settled as a successful request.
          if (typeof statusCode !== 'number' || statusCode < 200 || statusCode > 299) {
            reject(new Error(
              `governed OpenAI request failed with status ${String(statusCode)}`));
            return;
          }
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch (_) {
            // A body that is not JSON is not a governed response. Passing the
            // raw bytes through would hand unvalidated text to the proposal
            // parser as though the provider had answered.
            reject(new Error('governed OpenAI response was not valid JSON'));
            return;
          }
          resolve({
            // The model text, extracted the same way the ungoverned adapter
            // does, so response handling downstream is unchanged.
            text: extractResponseText(parsed),
            // Passed through uninterpreted; the settlement contract decides
            // whether it is trustworthy.
            usage: parsed && parsed.usage ? parsed.usage : undefined,
            identity: parsed && typeof parsed.id === 'string' ? parsed.id : undefined
          });
        });
        response.on('error', reject);
      });
      request.on('timeout', () => {
        const error = new Error('governed request timed out');
        error.name = 'AbortError';
        request.destroy(error);
      });
      request.on('error', reject);
      request.end(payload);
    });

    // The settlement promise is already live and may reject before the await
    // below reaches it. Marking it handled here is not a swallow: the rejection
    // is still delivered by `await settled`, and without this an early socket
    // error during the observation write would surface as an unhandled
    // rejection and take the process down.
    settled.catch(() => {});

    // THE OBSERVATION, WITH THE REQUEST ALREADY IN FLIGHT.
    //
    // ITS RESULT IS DELIBERATELY DISCARDED. The bytes were handed to the
    // platform above; whether the fact of that reached the database is a
    // question about evidence, not about this request. The seam cannot throw,
    // so there is no path by which a failed evidence write discards the
    // provider's answer, settles the reservation at its authorized maximum, or
    // turns a successful model interaction into a failed Run.
    //
    // If the write failed the durable record simply cannot prove invocation,
    // and the projection says UNKNOWN — which the frozen rule already permits,
    // and which is true.
    await observeProviderTransportInvocation(observeTransportInvocation, {
      ...(transportInvocationIdentity || {}),
      endpointIdentity,
      method: 'POST',
      requestByteCount: payload.byteLength
    }, { reportObservationFailure });

    return await settled;
  };
}

// Mirrors the existing OpenAI Responses extraction. Kept here rather than
// imported from the server so this module has no dependency on it.
function extractResponseText(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  if (typeof parsed.output_text === 'string' && parsed.output_text) return parsed.output_text;
  const output = Array.isArray(parsed.output) ? parsed.output : [];
  const pieces = [];
  for (const item of output) {
    const content = Array.isArray(item && item.content) ? item.content : [];
    for (const part of content) {
      if (part && typeof part.text === 'string') pieces.push(part.text);
    }
  }
  return pieces.join('');
}

module.exports = {
  GOVERNED_OPENAI_ENDPOINT,
  GOVERNED_OPENAI_HOSTNAME,
  GOVERNED_OPENAI_PATH,
  createOpenAiGovernedTransport,
  extractResponseText
};
