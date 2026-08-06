'use strict';

// Tranche 6 — the deterministic provider fixture shared by all five arms.
//
// WHY ONE FIXTURE FOR EVERY ARM. If each arm got its own response source, a
// difference between arms could come from the fixture rather than from the
// product. So there is exactly one response table, and it is keyed by facts the
// PRODUCTION path genuinely varies — protocol version, scenario, logical task,
// seed, role and request ordinal — and never by the experimental arm label.
//
// The arm still legitimately changes which requests are MADE: only the
// structured arms send a planner request at all, and the legacy/structured arms
// send one worker request per owned item where the direct arm sends one. That
// is the product behaving differently, which is the thing being measured. What
// must never happen is the same logical request receiving different content
// because of the arm it was issued under.
//
// REFUSAL, NOT GENERIC SUCCESS. An unexpected request is refused. A fixture
// that answered anything plausibly would silently repair a product that asked
// for the wrong thing, and the evaluation would score the fixture's competence
// instead of the product's.
//
// RAW STATE IS EXPOSED OUTSIDE COMPLETION AUTHORITY. The transcript and the
// external access log are written to plain files under a per-trial namespace,
// readable by the independent oracle without consulting any product record.
// That is what makes the family-4 coupling observation possible at all.

const fs = require('node:fs');
const path = require('node:path');
const { observeArtifactRead } = require('./evaluation-artifact-observer');
const crypto = require('node:crypto');

const FIXTURE_ROLES = Object.freeze(['planner', 'worker']);

// Controlled failure boundaries, named so a scenario states its interruption
// point rather than relying on timing.
const FAILURE_BOUNDARIES = Object.freeze([
  'none',
  // Refuse before any byte is served: models a pre-transport failure.
  'before_transport',
  // Serve the bytes, then make the transport appear to fail: models a request
  // that reached the provider with no durable response.
  'after_transport_before_response',
  // Serve normally; the scenario interrupts downstream.
  'after_response'
]);

class FixtureProviderError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'FixtureProviderError';
    this.detail = detail;
  }
}

// The response key. Deliberately does NOT include the arm.
function responseKey({ protocolVersion, scenarioId, logicalTaskId, seed, role, ordinal }) {
  if (!FIXTURE_ROLES.includes(role)) {
    throw new FixtureProviderError(`unsupported fixture role: ${role}`);
  }
  return [protocolVersion, scenarioId, logicalTaskId, seed, role, ordinal].join('|');
}

// A per-trial namespace. Every trial gets its own directory, so no transcript,
// access log or staged response can leak between trials or between arms.
function createFixtureNamespace(rootDir, trialId) {
  const namespace = path.join(rootDir, `fixture-${trialId}`);
  if (fs.existsSync(namespace)) {
    throw new FixtureProviderError(
      `fixture namespace for trial ${trialId} already exists — refusing to reuse ` +
      'state from an earlier trial', { trialId });
  }
  fs.mkdirSync(namespace, { recursive: true });
  return Object.freeze({
    trialId,
    dir: namespace,
    transcriptPath: path.join(namespace, 'transcript.jsonl'),
    accessLogPath: path.join(namespace, 'access-log.jsonl'),
    stagedPath: path.join(namespace, 'staged.json')
  });
}

// Stage the deterministic responses for one trial. Written once; a second stage
// for the same namespace refuses, because a re-stage mid-trial would make the
// transcript describe two different response sets.
function stageResponses(namespace, responses) {
  if (fs.existsSync(namespace.stagedPath)) {
    throw new FixtureProviderError(
      'responses are already staged for this trial', { trialId: namespace.trialId });
  }
  const table = {};
  for (const response of responses) {
    const key = responseKey(response);
    if (table[key]) {
      throw new FixtureProviderError(`duplicate staged response for ${key}`);
    }
    if (!FAILURE_BOUNDARIES.includes(response.failureBoundary || 'none')) {
      throw new FixtureProviderError(
        `unsupported failure boundary: ${response.failureBoundary}`);
    }
    table[key] = {
      key,
      role: response.role,
      ordinal: response.ordinal,
      body: response.body,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      failureBoundary: response.failureBoundary || 'none',
      // Carried so the fixture can take its own read observation when it serves
      // this request. The seed derives the producer bytes; the logical task
      // names the reader.
      seed: response.seed || null,
      logicalTaskId: response.logicalTaskId || null,
      producerPath: response.producerPath || null,
      // Stable identity, independent of arrival order.
      responseIdentity: `fixture-${crypto.createHash('sha256')
        .update(key).digest('hex').slice(0, 16)}`
    };
  }
  fs.writeFileSync(namespace.stagedPath, JSON.stringify(table, null, 2));
  return table;
}

// Serve one request. Called by the in-process preload that decorates the
// transport; see `evaluation-fixture-preload.js`.
function serveRequest(namespace, request) {
  const table = JSON.parse(fs.readFileSync(namespace.stagedPath, 'utf8'));
  const key = responseKey(request);
  const staged = table[key];

  // REFUSAL rather than a generic success.
  if (!staged) {
    appendTranscript(namespace, { key, served: false, refused: 'no_staged_response' });
    throw new FixtureProviderError(
      `no staged fixture response for ${key} — refusing rather than inventing one`,
      { key });
  }

  const alreadyServed = readTranscript(namespace)
    .filter(entry => entry.key === key && entry.served).length;

  if (staged.failureBoundary === 'before_transport') {
    appendTranscript(namespace, { key, served: false, refused: 'before_transport' });
    throw new FixtureProviderError('injected pre-transport provider failure', { key });
  }

  // FIXTURE-OWNED READ OBSERVATION, taken from the OUTGOING request before the
  // response is served. See `evaluation-artifact-observer`.
  observeArtifactRead({
    accessLogPath: namespace.accessLogPath,
    requestBody: typeof request.body === 'string' ? request.body : JSON.stringify(request),
    seed: staged.seed,
    reader: staged.logicalTaskId,
    artifactPath: staged.producerPath || null
  });

  appendTranscript(namespace, {
    key,
    served: true,
    repeat: alreadyServed,
    responseIdentity: staged.responseIdentity,
    requestHash: crypto.createHash('sha256')
      .update(String(request.body || '')).digest('hex'),
    inputTokens: staged.inputTokens,
    outputTokens: staged.outputTokens
  });

  if (staged.failureBoundary === 'after_transport_before_response') {
    // The bytes left; the caller must not receive a durable response. This is
    // the delivery-uncertainty boundary, and the transcript records that the
    // transport DID occur so the report can tell it apart from "no effect".
    throw new FixtureProviderError('injected post-transport response loss', { key });
  }

  return {
    text: staged.body,
    identity: staged.responseIdentity,
    usage: { input_tokens: staged.inputTokens, output_tokens: staged.outputTokens }
  };
}

function appendTranscript(namespace, entry) {
  fs.appendFileSync(namespace.transcriptPath,
    `${JSON.stringify({ ...entry, at: Date.now() })}\n`);
}

function readTranscript(namespace) {
  if (!fs.existsSync(namespace.transcriptPath)) return [];
  return fs.readFileSync(namespace.transcriptPath, 'utf8')
    .split('\n').filter(Boolean).map(line => JSON.parse(line));
}

// ── EXTERNAL, FIXTURE-OWNED ACCESS LOG ─────────────────────────────────────
//
// The family-4 observation. It is written by the fixture workspace itself, not
// by the Ticket runtime, so the oracle can establish that a consumer actually
// READ a producer artifact rather than inferring it from final files that might
// look right by luck.
function recordArtifactRead(namespace, { reader, artifactPath, artifactHash }) {
  fs.appendFileSync(namespace.accessLogPath,
    `${JSON.stringify({ reader, artifactPath, artifactHash, at: Date.now() })}\n`);
}

function readAccessLog(namespace) {
  if (!fs.existsSync(namespace.accessLogPath)) return [];
  return fs.readFileSync(namespace.accessLogPath, 'utf8')
    .split('\n').filter(Boolean).map(line => JSON.parse(line));
}

// Hashes carried into the trial artifact so a result can be tied to the exact
// fixture state that produced it.
function transcriptHash(namespace) {
  const entries = readTranscript(namespace)
    .map(({ at, ...rest }) => rest);
  return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function externalStateHash(namespace) {
  const entries = readAccessLog(namespace)
    .map(({ at, ...rest }) => rest);
  return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

// Counts the report uses to distinguish no effect / uncertain delivery /
// durable reuse / duplicate effect.
function transportSummary(namespace) {
  const entries = readTranscript(namespace);
  const served = entries.filter(entry => entry.served);
  const byKey = new Map();
  for (const entry of served) byKey.set(entry.key, (byKey.get(entry.key) || 0) + 1);
  return {
    requestsObserved: entries.length,
    transportsServed: served.length,
    refusals: entries.filter(entry => !entry.served).length,
    duplicateTransports: [...byKey.values()].filter(count => count > 1).length,
    distinctKeys: byKey.size
  };
}

module.exports = {
  FIXTURE_ROLES,
  FAILURE_BOUNDARIES,
  FixtureProviderError,
  responseKey,
  createFixtureNamespace,
  stageResponses,
  serveRequest,
  readTranscript,
  recordArtifactRead,
  readAccessLog,
  transcriptHash,
  externalStateHash,
  transportSummary
};
