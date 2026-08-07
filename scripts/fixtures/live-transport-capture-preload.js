'use strict';

// Tranche 6 — TEST-ONLY capture at the FINAL NETWORK BOUNDARY.
//
// WHAT MAKES THIS DIFFERENT FROM THE HERMETIC EVALUATION FIXTURE. The hermetic
// preload replaces the provider *fixture* layer: it selects a staged response by
// matching request bytes, so a test that passes under it proves the fixture
// table was consulted — not that production would have sent anything.
//
// This preload replaces ONLY the last hop. Everything upstream is the real
// thing: real manifest, real trial construction, real role routing, real
// economic admission, real adapter selection, real request-body construction.
// The outbound bytes recorded here are the exact bytes production would have
// put on the wire.
//
// It exists so a live dispatch path can be proved WITHOUT spending money or
// touching a network, and it is loaded only by tests.

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

const CAPTURE_PATH = process.env.LIVE_TRANSPORT_CAPTURE || null;
// Attribution. A recorded request that names no trial cannot be reconciled
// against the ledger entry that authorized it.
const TRIAL_ID = process.env.LIVE_TRANSPORT_CAPTURE_TRIAL_ID || null;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

function record(entry) {
  if (!CAPTURE_PATH) return;
  fs.appendFileSync(CAPTURE_PATH, `${JSON.stringify({ trialId: TRIAL_ID, ...entry })}\n`);
}

function responsePayload(identity) {
  return JSON.stringify({
    id: identity,
    output_text: JSON.stringify({ message: 'captured', actions: [], complete: false }),
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }
  });
}

// ── 1. The governed boundary: https.request ─────────────────────────────────
const realHttpsRequest = https.request;
let ordinal = 0;

https.request = function capturedHttpsRequest(options, onResponse) {
  const hostname = typeof options === 'string'
    ? new URL(options).hostname : options.hostname || options.host;
  if (LOCAL_HOSTS.has(String(hostname).replace(/:\d+$/, ''))) {
    return realHttpsRequest.apply(this, arguments);
  }
  ordinal += 1;
  const identity = `captured-governed-${ordinal}`;
  const chunks = [];
  const response = new (require('node:stream').PassThrough)();
  const request = {
    on() { return request; },
    setTimeout() { return request; },
    destroy() { return request; },
    write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      // THE EXACT OUTBOUND BYTES production would have sent.
      record({
        boundary: 'https.request',
        transport: 'governed',
        hostname,
        path: options.path,
        method: options.method,
        headerNames: Object.keys(options.headers || {}).sort(),
        hasAuthorization: Boolean(options.headers && options.headers.Authorization),
        body,
        at: Date.now()
      });
      response.statusCode = 200;
      response.headers = { 'x-request-id': identity };
      onResponse(response);
      response.end(responsePayload(identity));
      return request;
    }
  };
  return request;
};

// ── 2. The ungoverned boundary: global fetch ────────────────────────────────
const realFetch = globalThis.fetch;
globalThis.fetch = async function capturedFetch(input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  let hostname = null;
  try { hostname = new URL(url).hostname; } catch (_) { hostname = null; }
  if (hostname && LOCAL_HOSTS.has(hostname)) return realFetch.call(this, input, init);

  ordinal += 1;
  const identity = `captured-ungoverned-${ordinal}`;
  const body = init && typeof init.body === 'string' ? init.body : '';
  record({
    boundary: 'fetch',
    transport: 'ungoverned',
    hostname,
    url,
    method: (init && init.method) || 'GET',
    headerNames: Object.keys((init && init.headers) || {}).sort(),
    hasAuthorization: Boolean(init && init.headers &&
      (init.headers.Authorization || init.headers.authorization)),
    body,
    at: Date.now()
  });
  const payload = responsePayload(identity);
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: name => (name.toLowerCase() === 'x-request-id' ? identity : null) },
    async text() { return payload; },
    async json() { return JSON.parse(payload); }
  };
};

// ── 3. Nothing else may reach a network ─────────────────────────────────────
//
// http.request is not a provider boundary here, and a non-local call through it
// would mean a request escaped the two boundaries above.
const realHttpRequest = http.request;
http.request = function guardedHttpRequest(options, ...rest) {
  const hostname = typeof options === 'string'
    ? new URL(options).hostname : options.hostname || options.host;
  if (!LOCAL_HOSTS.has(String(hostname).replace(/:\d+$/, ''))) {
    throw new Error(`LIVE_CAPTURE_ESCAPE http.request to ${hostname}`);
  }
  return realHttpRequest.call(this, options, ...rest);
};

console.log('LIVE_TRANSPORT_CAPTURE_ACTIVE');
