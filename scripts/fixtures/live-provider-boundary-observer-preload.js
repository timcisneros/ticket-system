'use strict';

// Tranche 6 — TEST-ONLY observation of the REAL uncaptured provider boundary.
//
// WHY THIS IS NOT THE FINAL-HOP CAPTURE. `live-transport-capture-preload`
// answers requests with synthetic responses, and the runner treats its presence
// as "captured live", which switches the spawned server to a sentinel
// credential. Both of those are exactly what hid the ungoverned defect: three
// arms could reach a replaced transport under a sentinel and never exercise the
// configuration a real run uses.
//
// This preload changes NOTHING about the branch under test. The server still
// takes the real uncaptured live path, with the real credential resolution, the
// real provider selection and the real request builder. At the last possible
// moment — the outbound call itself — it records what would have gone on the
// wire and then REFUSES, so no byte leaves the machine and no response is
// invented for the product to consume.
//
// A test asserts on the recorded request. The trial that produced it will fail
// afterwards, and that is correct: the point is to prove the boundary was
// REACHED with the right controls, not to let the product continue on a
// fabricated answer.

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

const OBSERVATION_PATH = process.env.LIVE_PROVIDER_BOUNDARY_OBSERVATION || null;
// OPTIONAL REAL-SHAPED RESPONSE. When set, the boundary answers with a
// controlled response in the ACTUAL provider envelope — output[].content[] with
// type output_text — instead of refusing. Everything downstream stays
// production: extraction, parsing, action validation, workspace execution,
// receipts, terminalization. The old final-hop capture cannot serve this
// purpose because it answers with a top-level `output_text` the real API never
// returns, so it never exercised real-envelope handling.
const RESPONSE_PATH = process.env.LIVE_PROVIDER_BOUNDARY_RESPONSE || null;

function realShapedResponse() {
  const workerText = fs.readFileSync(RESPONSE_PATH, 'utf8');
  return JSON.stringify({
    id: 'resp_boundary_controlled',
    object: 'response',
    status: 'completed',
    model: 'gpt-4o-mini-2024-07-18',
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: workerText }]
    }],
    usage: { input_tokens: 1737, output_tokens: 77, total_tokens: 1814 }
  });
}
const TRIAL_ID = process.env.LIVE_PROVIDER_BOUNDARY_TRIAL_ID || null;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

const BOUNDARY_REFUSAL = 'LIVE_PROVIDER_BOUNDARY_OBSERVED_NO_NETWORK';

function record(entry) {
  if (!OBSERVATION_PATH) return;
  fs.appendFileSync(OBSERVATION_PATH,
    `${JSON.stringify({ trialId: TRIAL_ID, ...entry, at: Date.now() })}\n`);
}

function isLocal(hostname) {
  return LOCAL_HOSTS.has(String(hostname).replace(/:\d+$/, ''));
}

// ── The ungoverned boundary: global fetch ───────────────────────────────────
const realFetch = globalThis.fetch;
globalThis.fetch = async function observedFetch(input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  let hostname = null;
  try { hostname = new URL(url).hostname; } catch (_) { hostname = null; }
  if (hostname && isLocal(hostname)) return realFetch.call(this, input, init);

  const headers = (init && init.headers) || {};
  record({
    boundary: 'fetch',
    transport: 'ungoverned',
    url,
    hostname,
    method: (init && init.method) || 'GET',
    headerNames: Object.keys(headers).sort(),
    // PRESENCE ONLY. The value is never recorded.
    hasAuthorization: Boolean(headers.Authorization || headers.authorization),
    body: init && typeof init.body === 'string' ? init.body : ''
  });
  if (RESPONSE_PATH) {
    const payload = realShapedResponse();
    // The real platform Response, for the same reason: production consumes
    // more of this interface than a hand-written stub tends to provide.
    return new Response(payload, {
      status: 200,
      statusText: 'OK',
      headers: {
        'x-request-id': 'req_boundary_controlled',
        'content-type': 'application/json'
      }
    });
  }
  // STOP BEFORE THE NETWORK. No response is synthesized: the product must not
  // continue on an answer this seam invented.
  const error = new Error(BOUNDARY_REFUSAL);
  error.code = BOUNDARY_REFUSAL;
  throw error;
};

// ── The governed boundary: https.request ────────────────────────────────────
const realHttpsRequest = https.request;
https.request = function observedHttpsRequest(options, onResponse) {
  const hostname = typeof options === 'string'
    ? new URL(options).hostname : options.hostname || options.host;
  if (isLocal(hostname)) return realHttpsRequest.apply(this, arguments);

  const chunks = [];
  const request = {
    on() { return request; },
    setTimeout() { return request; },
    destroy() { return request; },
    write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      record({
        boundary: 'https.request',
        transport: 'governed',
        hostname,
        path: options.path,
        method: options.method,
        headerNames: Object.keys(options.headers || {}).sort(),
        hasAuthorization: Boolean(options.headers && options.headers.Authorization),
        body: Buffer.concat(chunks).toString('utf8')
      });
      const error = new Error(BOUNDARY_REFUSAL);
      error.code = BOUNDARY_REFUSAL;
      throw error;
    }
  };
  return request;
};

// Nothing may escape by a third route.
const realHttpRequest = http.request;
http.request = function guardedHttpRequest(options, ...rest) {
  const hostname = typeof options === 'string'
    ? new URL(options).hostname : options.hostname || options.host;
  if (!isLocal(hostname)) {
    throw new Error(`LIVE_BOUNDARY_ESCAPE http.request to ${hostname}`);
  }
  return realHttpRequest.call(this, options, ...rest);
};

console.log('LIVE_PROVIDER_BOUNDARY_OBSERVER_ACTIVE');
