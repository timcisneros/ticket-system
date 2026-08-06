'use strict';

// Tranche 6 — the fetch-side hermetic adapter for the UNGOVERNED arms.
//
// WHY IT EXISTS. The two provider paths use different transports. The governed
// path (arms B and C) has a documented `httpsRequest` injection seam. The
// ungoverned path — `server.js` `callOpenAI`, which arms A, A2a and A2b
// exercise — issues `fetch('https://api.openai.com/v1/responses', …)`. Without
// this adapter those three arms cannot execute hermetically at all: the
// preload's guard correctly refuses the request, so they would fail closed
// rather than run.
//
// ONE FIXTURE PROVIDER SERVES EVERY ARM. Responses come from the same shared
// table as the governed arms, keyed by protocol version, scenario, logical
// task, seed, role and request ordinal — and NEVER by the arm label. The arm
// still legitimately changes which requests are made; what must never happen is
// the same logical request receiving different bytes because of the arm that
// issued it.
//
// A MINIMUM RESPONSE, NOT A FETCH IMPLEMENTATION. Only the surface
// `callOpenAI` and `readFetchBodyBounded` actually consume is provided:
// `ok`, `status`, `statusText`, `headers.entries()`, `text()` and a
// `body.getReader()` that streams once. Implementing more would be inventing a
// contract nobody reads.
//
// ROUTING, in order:
//
//   localhost                     -> the real fetch, untouched
//   the recognized provider URL   -> the shared evaluation fixture provider
//   any other non-localhost URL   -> refused before any network access
//
// TEST-ONLY. Installed by a preload in a spawned test server; production source
// is unchanged and reads no environment variable added here.

const fs = require('node:fs');
const path = require('node:path');

const PROVIDER_URL = 'https://api.openai.com/v1/responses';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);

class EvaluationFetchFixtureError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'EvaluationFetchFixtureError';
    this.detail = detail;
  }
}

// The minimum Response the production reader consumes.
function buildFixtureResponse({ status = 200, statusText = 'OK', headers = {}, body }) {
  const bytes = Buffer.from(body, 'utf8');
  let streamed = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: {
      entries() { return Object.entries(headers)[Symbol.iterator](); },
      get(name) {
        const key = Object.keys(headers)
          .find(candidate => candidate.toLowerCase() === String(name).toLowerCase());
        return key === undefined ? null : headers[key];
      }
    },
    async text() { return bytes.toString('utf8'); },
    // `readFetchBodyBounded` reads incrementally and cancels past the limit, so
    // a single-chunk stream is enough and keeps the size check meaningful.
    get body() {
      return {
        getReader() {
          return {
            async read() {
              if (streamed) return { done: true, value: undefined };
              streamed = true;
              return { done: false, value: new Uint8Array(bytes) };
            },
            async cancel() { streamed = true; },
            releaseLock() {}
          };
        }
      };
    }
  };
}

function hostOf(target) {
  const url = typeof target === 'string' ? target
    : (target && typeof target.url === 'string' ? target.url : null);
  if (!url) return null;
  try { return new URL(url).hostname; } catch (_) { return null; }
}

function urlOf(target) {
  return typeof target === 'string' ? target
    : (target && typeof target.url === 'string' ? target.url : '');
}

// Select the staged response for an ungoverned request.
//
// The logical task is recovered from what production actually SENT — each
// staged entry carries a `match` marker that the scenario placed in the
// objective or owned path, so it appears in the prompt. That is arm-independent
// by construction: the adapter never sees an arm and never asks for one.
function selectStaged(table, requestBody, servedCounts) {
  const candidates = Object.values(table)
    .filter(entry => entry.role === 'worker')
    .filter(entry => !entry.match || String(requestBody).includes(entry.match))
    .sort((left, right) => left.ordinal - right.ordinal);
  for (const candidate of candidates) {
    const served = servedCounts.get(candidate.key) || 0;
    if (served === 0) return candidate;
  }
  return null;
}

// Install the guarded fetch. Returns a restore function for symmetry; the
// spawned server never calls it, but the focused test does.
function installEvaluationFetchFixture({ namespaceDir, providerUrl = PROVIDER_URL }) {
  if (!namespaceDir || !fs.existsSync(namespaceDir)) {
    throw new EvaluationFetchFixtureError(
      'a staged fixture namespace directory is required', { namespaceDir });
  }
  const stagedPath = path.join(namespaceDir, 'staged.json');
  const transcriptPath = path.join(namespaceDir, 'transcript.jsonl');
  const realFetch = globalThis.fetch;
  const servedCounts = new Map();

  globalThis.fetch = async function evaluationFetch(input, init) {
    const host = hostOf(input);
    const bare = host ? String(host).replace(/:\d+$/, '') : null;

    // 1. localhost passes through untouched — the harness's own HTTP.
    if (bare && LOCAL_HOSTS.has(bare)) return realFetch.call(this, input, init);

    // 2. the recognized provider URL is served from the shared fixture.
    if (urlOf(input) === providerUrl) {
      const table = JSON.parse(fs.readFileSync(stagedPath, 'utf8'));
      const requestBody = init && typeof init.body === 'string' ? init.body : '';
      const staged = selectStaged(table, requestBody, servedCounts);

      if (!staged) {
        fs.appendFileSync(transcriptPath, `${JSON.stringify({
          transport: 'fetch', served: false, refused: 'no_staged_response',
          at: Date.now()
        })}\n`);
        throw new EvaluationFetchFixtureError(
          'no staged fixture response matches this ungoverned request — refusing ' +
          'rather than inventing one');
      }
      if (staged.failureBoundary === 'before_transport') {
        fs.appendFileSync(transcriptPath, `${JSON.stringify({
          transport: 'fetch', key: staged.key, served: false,
          refused: 'before_transport', at: Date.now()
        })}\n`);
        throw new EvaluationFetchFixtureError('injected pre-transport provider failure');
      }

      servedCounts.set(staged.key, (servedCounts.get(staged.key) || 0) + 1);
      fs.appendFileSync(transcriptPath, `${JSON.stringify({
        transport: 'fetch', key: staged.key, served: true,
        responseIdentity: staged.responseIdentity,
        requestBytes: requestBody.length,
        inputTokens: staged.inputTokens, outputTokens: staged.outputTokens,
        at: Date.now()
      })}\n`);

      if (staged.failureBoundary === 'after_transport_before_response') {
        throw new EvaluationFetchFixtureError('injected post-transport response loss');
      }

      return buildFixtureResponse({
        headers: { 'content-type': 'application/json', 'x-request-id': staged.responseIdentity },
        body: JSON.stringify({
          id: staged.responseIdentity,
          output_text: staged.body,
          usage: {
            input_tokens: staged.inputTokens,
            output_tokens: staged.outputTokens,
            total_tokens: staged.inputTokens + staged.outputTokens
          }
        })
      });
    }

    // 3. anything else non-localhost is refused before touching the network.
    throw new EvaluationFetchFixtureError(
      `UNEXPECTED_EXTERNAL_NETWORK_REQUEST via fetch to ${bare || 'unknown host'}`);
  };

  return function restore() { globalThis.fetch = realFetch; };
}

// A trial fails when the scenario staged a response production never asked for.
// An unconsumed response means the path did not do what the scenario described,
// and scoring it would report a comparison of something else.
function assertAllWorkerResponsesConsumed(namespaceDir) {
  const table = JSON.parse(
    fs.readFileSync(path.join(namespaceDir, 'staged.json'), 'utf8'));
  const transcriptPath = path.join(namespaceDir, 'transcript.jsonl');
  const served = new Set(
    (fs.existsSync(transcriptPath)
      ? fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean)
        .map(line => JSON.parse(line))
      : [])
      .filter(entry => entry.served).map(entry => entry.key));
  const unconsumed = Object.values(table)
    .filter(entry => entry.role === 'worker' && !served.has(entry.key))
    .map(entry => entry.key);
  if (unconsumed.length > 0) {
    throw new EvaluationFetchFixtureError(
      `the trial staged ${unconsumed.length} worker response(s) production never ` +
      `requested: ${unconsumed.join(', ')}`, { unconsumed });
  }
  return true;
}

module.exports = {
  PROVIDER_URL,
  LOCAL_HOSTS,
  EvaluationFetchFixtureError,
  buildFixtureResponse,
  selectStaged,
  installEvaluationFetchFixture,
  assertAllWorkerResponsesConsumed
};
