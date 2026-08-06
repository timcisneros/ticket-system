'use strict';

// Tranche 6 — ONE shared, test-only, per-trial observation sink.
//
// THE DEFECT THIS EXISTS TO CLOSE. The spawned server carried two disconnected
// test channels: the ungoverned fetch fixture wrote the evaluation trial
// namespace, while the governed transport preload used its own staging and
// wrote `governed-capture.jsonl`. Nothing observed the real read at all. So a
// governed served-call count read as zero even when requests occurred, and the
// consumer access log was empty even when the product may genuinely have read
// an artifact.
//
// THAT IS NOT A WEAK OBSERVATION, IT IS AN INVERTED ONE. "The log is empty"
// means "the consumer did not read" only if an observer was actually watching.
// If none was, the same emptiness means "nothing was observed", and reporting it
// as a negative finding fabricates evidence. Every consumer of this module
// therefore reads `completeness` before it reads a count.
//
// WHAT THIS MODULE IS. A bounded, append-only, per-trial JSONL sink with three
// typed streams. It describes what happened; it never decides anything, never
// alters a value it observes, and never sees an arm label.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const OBSERVATION_SINK_VERSION = 1;

// The three observation kinds, closed. A fourth is a design change, not an
// extension point.
const OBSERVATION_KINDS = Object.freeze([
  'provider_transport',
  'consumer_artifact_read',
  'external_effect'
]);

// Completeness is a first-class answer, not the absence of one.
const COMPLETENESS = Object.freeze(['complete', 'incomplete', 'unavailable']);

// Transport boundaries, named for what ACTUALLY happened rather than for what
// was intended. `refused_before_transport` means no bytes left; `bytes_sent`
// means bytes left and no durable response came back; `response_durable` means
// a response was received and can be replayed.
const TRANSPORT_BOUNDARIES = Object.freeze([
  'refused_before_transport',
  'bytes_sent',
  'response_durable'
]);

class ObservationSinkError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ObservationSinkError';
    this.detail = detail;
  }
}

function hashBytes(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// ── The immutable per-trial descriptor ──────────────────────────────────────
//
// One serialized environment value carries this into the spawned server. Every
// field is required: an observation that cannot say which trial produced it is
// worse than no observation, because it can be attributed to the wrong one.
const DESCRIPTOR_FIELDS = Object.freeze([
  'protocolVersion', 'trialId', 'namespaceDir', 'scenarioId', 'variantId',
  'repetition', 'seed', 'fixtureTableHash'
]);

function normalizeDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ObservationSinkError('an observation descriptor object is required');
  }
  const unknown = Object.keys(value).filter(key => !DESCRIPTOR_FIELDS.includes(key));
  if (unknown.length > 0) {
    throw new ObservationSinkError(
      `observation descriptor contains unknown field(s): ${unknown.sort().join(', ')}`);
  }
  for (const field of DESCRIPTOR_FIELDS) {
    // `variantId` is legitimately null for a single-variant scenario; every
    // other field must be present and non-empty.
    if (field === 'variantId') continue;
    if (value[field] === undefined || value[field] === null || value[field] === '') {
      throw new ObservationSinkError(`observation descriptor field ${field} is required`);
    }
  }
  if (!path.isAbsolute(value.namespaceDir)) {
    throw new ObservationSinkError('namespaceDir must be an absolute path');
  }
  if (value.namespaceDir.split(path.sep).includes('..')) {
    throw new ObservationSinkError('namespaceDir must not escape its root');
  }
  if (!Number.isSafeInteger(value.repetition) || value.repetition <= 0) {
    throw new ObservationSinkError('repetition must be a positive integer');
  }
  return Object.freeze({
    protocolVersion: value.protocolVersion,
    trialId: String(value.trialId),
    namespaceDir: value.namespaceDir,
    scenarioId: String(value.scenarioId),
    variantId: value.variantId === null ? null : String(value.variantId),
    repetition: value.repetition,
    seed: String(value.seed),
    fixtureTableHash: String(value.fixtureTableHash)
  });
}

function streamPathFor(namespaceDir, kind) {
  if (!OBSERVATION_KINDS.includes(kind)) {
    throw new ObservationSinkError(`unknown observation kind: ${String(kind)}`);
  }
  return path.join(namespaceDir, `observations-${kind.replace(/_/g, '-')}.jsonl`);
}

// ── Writing ─────────────────────────────────────────────────────────────────
//
// Append-only by construction: there is no update, no delete and no rewrite in
// this module's surface. Order is owned by the sink — a monotonic per-stream
// sequence — rather than by a timestamp that two processes could tie on.
function createObservationSink(descriptorInput) {
  const descriptor = normalizeDescriptor(descriptorInput);
  fs.mkdirSync(descriptor.namespaceDir, { recursive: true });
  const sequences = new Map();

  function append(kind, record) {
    const target = streamPathFor(descriptor.namespaceDir, kind);
    const next = (sequences.get(kind) || countLines(target)) + 1;
    sequences.set(kind, next);
    const line = {
      observationSinkVersion: OBSERVATION_SINK_VERSION,
      kind,
      sequence: next,
      trialId: descriptor.trialId,
      scenarioId: descriptor.scenarioId,
      variantId: descriptor.variantId,
      ...record
    };
    fs.appendFileSync(target, `${JSON.stringify(line)}\n`);
    return Object.freeze(line);
  }

  return Object.freeze({
    descriptor,

    // ── Provider transport ────────────────────────────────────────────
    //
    // Written by BOTH transport adapters, so a governed and an ungoverned
    // request are described identically and can never be told apart by which
    // file they landed in.
    // `injected` distinguishes a boundary the SCENARIO staged from a refusal
    // the fixture issued because nothing was staged at all. Both are honest
    // refusals, but only the first is the boundary a variant is testing —
    // counting them together would credit an unplanned request as the injected
    // failure.
    recordTransport({
      logicalRequestId, role, ordinal, requestHash, responseIdentity = null,
      responseHash = null, boundary, deliveredToExecution = null, injected = false,
      reason = null
    }) {
      if (!TRANSPORT_BOUNDARIES.includes(boundary)) {
        throw new ObservationSinkError(`unknown transport boundary: ${String(boundary)}`);
      }
      return append('provider_transport', {
        logicalRequestId: logicalRequestId || null,
        role: role || null,
        ordinal: Number.isSafeInteger(ordinal) ? ordinal : null,
        requestHash: requestHash || null,
        responseIdentity,
        responseHash,
        boundary,
        injected: Boolean(injected),
        // Why this boundary was reached, when the transport can say. An
        // unexpected request records `no_staged_response`; a staged boundary
        // records none, because the boundary itself is the reason.
        reason: reason || null,
        // Delivery to EXECUTION is a product fact the transport cannot see, so
        // it stays null here rather than being guessed. Family 7 reads it from
        // canonical product evidence.
        deliveredToExecution
      });
    },

    // ── Consumer artifact read ────────────────────────────────────────
    //
    // ONLY called after the real read operation has returned. The caller passes
    // the exact bytes it is about to hand back, so the recorded hash is the
    // hash of what the product actually received — never of what the file
    // contains when someone looks later.
    recordConsumerRead({ readerTaskId, requestedPath, returnedBytes, producerArtifactId = null }) {
      if (returnedBytes === undefined || returnedBytes === null) {
        throw new ObservationSinkError(
          'a consumer read observation requires the exact returned bytes');
      }
      return append('consumer_artifact_read', {
        readerTaskId: readerTaskId || null,
        requestedPath,
        contentHash: hashBytes(returnedBytes),
        byteLength: Buffer.isBuffer(returnedBytes)
          ? returnedBytes.length : Buffer.byteLength(String(returnedBytes), 'utf8'),
        producerArtifactId
      });
    },

    // ── External effect ───────────────────────────────────────────────
    recordExternalEffect({ effectId, attemptId, committed }) {
      return append('external_effect', {
        effectId, attemptId: attemptId || null, committed: Boolean(committed)
      });
    }
  });
}

function countLines(target) {
  if (!fs.existsSync(target)) return 0;
  return fs.readFileSync(target, 'utf8').split('\n').filter(Boolean).length;
}

// ── Reading ─────────────────────────────────────────────────────────────────

function readStream(namespaceDir, kind) {
  const target = streamPathFor(namespaceDir, kind);
  if (!fs.existsSync(target)) return [];
  return fs.readFileSync(target, 'utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line));
}

// THE QUESTION EVERY CONSUMER MUST ASK FIRST.
//
// `complete` means an observer was installed for the whole trial and its
// streams are readable — so a count of zero is a real negative finding.
// `unavailable` means no observer ran, and a count of zero means nothing at
// all. Confusing the two is precisely the defect this module was built for.
function readObservations(namespaceDir) {
  const installedMarker = path.join(namespaceDir, 'observation-sink.json');
  if (!fs.existsSync(namespaceDir) || !fs.existsSync(installedMarker)) {
    return Object.freeze({
      completeness: 'unavailable',
      reason: 'no observation sink was installed for this trial, so an empty ' +
        'stream means nothing was observed rather than nothing happened',
      transport: Object.freeze([]),
      consumerReads: Object.freeze([]),
      externalEffects: Object.freeze([]),
      streamIdentities: Object.freeze({})
    });
  }
  let descriptor = null;
  try {
    descriptor = JSON.parse(fs.readFileSync(installedMarker, 'utf8'));
  } catch (error) {
    return Object.freeze({
      completeness: 'incomplete',
      reason: `the observation sink marker could not be read: ${error.message}`,
      transport: Object.freeze([]),
      consumerReads: Object.freeze([]),
      externalEffects: Object.freeze([]),
      streamIdentities: Object.freeze({})
    });
  }
  const transport = readStream(namespaceDir, 'provider_transport');
  const consumerReads = readStream(namespaceDir, 'consumer_artifact_read');
  const externalEffects = readStream(namespaceDir, 'external_effect');
  const streamIdentities = {};
  for (const kind of OBSERVATION_KINDS) {
    const target = streamPathFor(namespaceDir, kind);
    streamIdentities[kind] = fs.existsSync(target)
      ? hashBytes(fs.readFileSync(target)) : hashBytes('');
  }
  // Observations from two trials must never mix. The descriptor is written once
  // at install time, so any line naming a different trial is a contamination
  // this reader refuses to average over.
  const foreign = [...transport, ...consumerReads, ...externalEffects]
    .filter(entry => entry.trialId !== descriptor.trialId);
  if (foreign.length > 0) {
    return Object.freeze({
      completeness: 'incomplete',
      reason: `${foreign.length} observation(s) belong to another trial`,
      transport: Object.freeze(transport),
      consumerReads: Object.freeze(consumerReads),
      externalEffects: Object.freeze(externalEffects),
      streamIdentities: Object.freeze(streamIdentities)
    });
  }
  return Object.freeze({
    completeness: 'complete',
    reason: null,
    descriptor: Object.freeze(descriptor),
    transport: Object.freeze(transport),
    consumerReads: Object.freeze(consumerReads),
    externalEffects: Object.freeze(externalEffects),
    streamIdentities: Object.freeze(streamIdentities)
  });
}

// Written once, by the preload, when the sink is installed. Its presence is
// what distinguishes "observed nothing" from "was not observing".
function markSinkInstalled(descriptor) {
  const normalized = normalizeDescriptor(descriptor);
  const marker = path.join(normalized.namespaceDir, 'observation-sink.json');
  if (fs.existsSync(marker)) {
    throw new ObservationSinkError(
      'an observation sink is already installed for this trial namespace; ' +
      'reuse would mix two trials into one set of streams',
      { namespaceDir: normalized.namespaceDir });
  }
  fs.writeFileSync(marker, JSON.stringify({
    observationSinkVersion: OBSERVATION_SINK_VERSION, ...normalized
  }, null, 2));
  return normalized;
}

// ── The real-read observer ──────────────────────────────────────────────────
//
// Extracted so its contract can be exercised DIRECTLY rather than simulated. It
// wraps one `fs` module's `readFileSync` and is the only place a consumer read
// observation originates in a spawned server.
//
// THE CONTRACT, in order:
//
//   1. call the real operation FIRST and let it settle;
//   2. on a throw, re-throw the original error untouched and record NOTHING —
//      a failed read is not an access;
//   3. on success, hash the exact returned value and append one observation;
//   4. return the EXACT original value, never a copy or a re-read.
//
// A sink write that itself fails must never change what production returns, so
// the observation is best-effort while the value and the error never are.
function installReadObserver({ fsModule, sink, workspaceRoot, pathModule = path }) {
  if (!fsModule || !sink || !workspaceRoot) {
    throw new ObservationSinkError(
      'a read observer needs an fs module, a sink and a workspace root');
  }
  const realReadFileSync = fsModule.readFileSync;
  const observedRoot = pathModule.resolve(workspaceRoot);
  fsModule.readFileSync = function observedReadFileSync(target, ...rest) {
    // 1 & 2. The real call, and its errors, are authoritative. No catch here:
    // a throw propagates untouched and never reaches the recording below.
    const value = realReadFileSync.call(this, target, ...rest);
    try {
      if (typeof target === 'string') {
        const resolved = pathModule.resolve(target);
        if (resolved === observedRoot ||
            resolved.startsWith(`${observedRoot}${pathModule.sep}`)) {
          // 3. The exact returned value is what is hashed — not the file as it
          // may look when someone looks later.
          sink.recordConsumerRead({
            readerTaskId: null,
            requestedPath: pathModule.relative(observedRoot, resolved),
            returnedBytes: value
          });
        }
      }
    } catch (_) { /* an observation may never alter production, including by failing */ }
    // 4. The original value, unchanged.
    return value;
  };
  return () => { fsModule.readFileSync = realReadFileSync; };
}

module.exports = {
  installReadObserver,
  COMPLETENESS,
  DESCRIPTOR_FIELDS,
  OBSERVATION_KINDS,
  OBSERVATION_SINK_VERSION,
  ObservationSinkError,
  TRANSPORT_BOUNDARIES,
  createObservationSink,
  hashBytes,
  markSinkInstalled,
  normalizeDescriptor,
  readObservations,
  streamPathFor
};
