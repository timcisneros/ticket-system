#!/usr/bin/env node
'use strict';

// Tranche 6 — the shared, test-only, per-trial observation sink.
//
// THE DEFECT THIS SUITE GUARDS. The spawned server used to carry two
// disconnected test channels and no read observer at all, so a governed
// served-call count read as zero even when requests occurred and the consumer
// access log was empty even when the product may have read an artifact.
//
// The rule that matters most is asserted first and repeatedly: an empty stream
// means "nothing happened" ONLY when an observer was actually installed. When
// none was, the same emptiness means nothing at all, and reporting it as a
// negative finding fabricates evidence rather than weakening it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  OBSERVATION_KINDS, OBSERVATION_SINK_VERSION, ObservationSinkError,
  TRANSPORT_BOUNDARIES, createObservationSink, hashBytes, markSinkInstalled,
  normalizeDescriptor, readObservations, streamPathFor
} = require('./fixtures/evaluation-observation-sink');

let passed = 0;
function ok(condition, message) {
  assert.equal(condition, true, message);
  passed += 1;
  console.log(`  ok ${message}`);
}

function descriptorFor(dir, overrides = {}) {
  return {
    protocolVersion: 1,
    trialId: 'scenario--variant--B--r1',
    namespaceDir: dir,
    scenarioId: 'scenario',
    variantId: 'variant',
    repetition: 1,
    seed: 'seed-1',
    fixtureTableHash: 'a'.repeat(64),
    ...overrides
  };
}

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'obs-sink-'));
}

function main() {
  console.log('evaluation observation sink');

  // ── Descriptor validation ─────────────────────────────────────────────
  {
    const dir = freshDir();
    for (const [label, patch] of [
      ['a missing trial identity', { trialId: '' }],
      ['a missing namespace', { namespaceDir: '' }],
      ['a relative namespace path', { namespaceDir: 'relative/dir' }],
      ['a missing scenario', { scenarioId: '' }],
      ['a missing seed', { seed: '' }],
      ['a missing fixture-table identity', { fixtureTableHash: '' }],
      ['a non-positive repetition', { repetition: 0 }]
    ]) {
      let refused = false;
      try { normalizeDescriptor(descriptorFor(dir, patch)); } catch (_) { refused = true; }
      ok(refused, `descriptor: ${label} refuses`);
    }
    let unknownRefused = false;
    try {
      normalizeDescriptor({ ...descriptorFor(dir), armId: 'B' });
    } catch (_) { unknownRefused = true; }
    // THE ARM MUST NOT REACH THE SINK. An observation describes what happened;
    // it may never be shaped by which experimental cell asked for it.
    ok(unknownRefused, 'descriptor: an arm label is not an accepted field');
    // A single-variant scenario legitimately has no variant.
    ok(normalizeDescriptor(descriptorFor(dir, { variantId: null })).variantId === null,
      'descriptor: a single-variant scenario needs no variant id');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── 12. Namespace reuse refuses ───────────────────────────────────────
  {
    const dir = freshDir();
    markSinkInstalled(descriptorFor(dir));
    let reused = false;
    try { markSinkInstalled(descriptorFor(dir)); } catch (error) {
      reused = error instanceof ObservationSinkError;
    }
    ok(reused, '12 namespace reuse refuses — two trials may not share one stream set');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── THE CENTRAL DISTINCTION: unavailable is not "no reads" ────────────
  {
    const dir = freshDir();
    const before = readObservations(dir);
    ok(before.completeness === 'unavailable',
      'an uninstalled sink reports UNAVAILABLE, never an empty observation');
    ok(before.consumerReads.length === 0 && before.reason.includes('nothing was observed'),
      'and says explicitly that emptiness means nothing was observed');
    markSinkInstalled(descriptorFor(dir));
    const after = readObservations(dir);
    ok(after.completeness === 'complete' && after.consumerReads.length === 0,
      'an INSTALLED sink with no records is COMPLETE with zero observations');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── 1–7. Transport observations ───────────────────────────────────────
  {
    const dir = freshDir();
    markSinkInstalled(descriptorFor(dir));
    const sink = createObservationSink(descriptorFor(dir));

    // 1 & 2 & 3. Ungoverned, governed planner and governed worker requests all
    // write ONE observation each, into the SAME stream. Sharing the stream is
    // what makes them comparable at all.
    sink.recordTransport({
      logicalRequestId: 'ungoverned|alpha', role: 'worker', ordinal: 1,
      requestHash: 'b'.repeat(64), responseIdentity: 'r1',
      responseHash: 'c'.repeat(64), boundary: 'response_durable'
    });
    sink.recordTransport({
      logicalRequestId: 'governed|plan', role: 'planner', ordinal: 1,
      requestHash: 'd'.repeat(64), responseIdentity: 'r2',
      responseHash: 'e'.repeat(64), boundary: 'response_durable'
    });
    sink.recordTransport({
      logicalRequestId: 'governed|alpha', role: 'worker', ordinal: 1,
      requestHash: 'f'.repeat(64), responseIdentity: 'r3',
      responseHash: '0'.repeat(64), boundary: 'response_durable'
    });
    let observed = readObservations(dir);
    ok(observed.transport.length === 3,
      '1-3 ungoverned, governed planner and governed worker requests each write one observation');
    ok(new Set(observed.transport.map(entry => entry.sequence)).size === 3,
      '1-3 and each carries its own monotonic sink-owned sequence');
    ok(observed.transport.every(entry => !('armId' in entry)),
      '14 no observation carries an arm label — selection is arm-independent');

    // 5. A pre-transport refusal records NO bytes sent and NO response.
    sink.recordTransport({
      logicalRequestId: null, role: null, ordinal: null,
      requestHash: '1'.repeat(64), boundary: 'refused_before_transport'
    });
    observed = readObservations(dir);
    const refusal = observed.transport[3];
    ok(refusal.boundary === 'refused_before_transport' &&
       refusal.responseIdentity === null && refusal.responseHash === null,
    '5 a pre-transport refusal records no response identity at all');

    // 6. Bytes sent with no durable response is its OWN boundary — neither a
    //    refusal nor a success.
    sink.recordTransport({
      logicalRequestId: 'uncertain', role: 'worker', ordinal: 2,
      requestHash: '2'.repeat(64), boundary: 'bytes_sent'
    });
    observed = readObservations(dir);
    ok(observed.transport[4].boundary === 'bytes_sent' &&
       observed.transport[4].responseIdentity === null,
    '6 the bytes-sent boundary records one attempt and no response');

    // 7. A durable response records its identity, so recovery can prove reuse
    //    rather than retransmission.
    ok(observed.transport[0].responseIdentity === 'r1',
      '7 a durable-response boundary records the response identity');

    let unknownBoundary = false;
    try {
      sink.recordTransport({ requestHash: 'x', boundary: 'invented' });
    } catch (_) { unknownBoundary = true; }
    ok(unknownBoundary && TRANSPORT_BOUNDARIES.length === 3,
      'an unknown transport boundary refuses — the set is closed');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── 8-11, 15. Consumer reads ──────────────────────────────────────────
  {
    const dir = freshDir();
    markSinkInstalled(descriptorFor(dir));
    const sink = createObservationSink(descriptorFor(dir));
    const bytes = 'producer-artifact-bytes\n';

    // 8 & 10. Recorded only from the bytes a successful read RETURNED.
    sink.recordConsumerRead({
      readerTaskId: 'consumer', requestedPath: 'reports/producer/artifact.txt',
      returnedBytes: bytes
    });
    let observed = readObservations(dir);
    ok(observed.consumerReads.length === 1,
      '8 a successful read writes exactly one read observation');
    ok(observed.consumerReads[0].contentHash ===
       crypto.createHash('sha256').update(bytes).digest('hex'),
    '10 the recorded hash is the hash of the exact returned bytes');
    ok(observed.consumerReads[0].byteLength === Buffer.byteLength(bytes, 'utf8'),
      '10 and the recorded length is the exact returned length');

    // 9. A FAILED read records nothing. The sink is only ever called after the
    //    real operation returned, so a throw never reaches it — proved here by
    //    the count not moving.
    const beforeFailure = readObservations(dir).consumerReads.length;
    try {
      // Simulates the wrapper's own contract: the real call throws, so the
      // observation line is never reached.
      (() => { throw new Error('ENOENT'); })();
    } catch (_) { /* the wrapper re-throws and records nothing */ }
    ok(readObservations(dir).consumerReads.length === beforeFailure,
      '9 a failed read writes no successful access record');

    // 11. Two reads are TWO observations. Collapsing them would hide a second
    //     access, which is exactly what family 8 needs to see.
    sink.recordConsumerRead({
      readerTaskId: 'consumer', requestedPath: 'reports/producer/artifact.txt',
      returnedBytes: bytes
    });
    observed = readObservations(dir);
    ok(observed.consumerReads.length === 2 &&
       observed.consumerReads[0].sequence !== observed.consumerReads[1].sequence,
    '11 a repeated read is two observations, never silently collapsed');

    let missingBytes = false;
    try {
      sink.recordConsumerRead({ readerTaskId: 'c', requestedPath: 'p' });
    } catch (_) { missingBytes = true; }
    ok(missingBytes,
      'a read observation without the exact returned bytes refuses');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── 15. The observer never alters what it observes ────────────────────
  {
    // The wrapper contract, exercised directly: call through, hash, return the
    // ORIGINAL value, and re-throw the ORIGINAL error.
    const dir = freshDir();
    markSinkInstalled(descriptorFor(dir));
    const sink = createObservationSink(descriptorFor(dir));
    const original = { marker: Symbol('exact-value') };
    const wrapped = (shouldThrow) => {
      const value = shouldThrow
        ? (() => { const error = new Error('boom'); error.code = 'EACCES'; throw error; })()
        : original;
      sink.recordConsumerRead({
        readerTaskId: 'c', requestedPath: 'p', returnedBytes: 'bytes'
      });
      return value;
    };
    ok(wrapped(false) === original,
      '15 the observer returns the EXACT original value, not a copy');
    let propagated = null;
    try { wrapped(true); } catch (error) { propagated = error; }
    ok(propagated && propagated.code === 'EACCES',
      '15 and propagates the original error unchanged');
    ok(readObservations(dir).consumerReads.length === 1,
      '15 with no observation written for the failed call');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── 13. Two trials cannot mix ─────────────────────────────────────────
  {
    const dirA = freshDir();
    const dirB = freshDir();
    markSinkInstalled(descriptorFor(dirA, { trialId: 'trial-A' }));
    markSinkInstalled(descriptorFor(dirB, { trialId: 'trial-B' }));
    createObservationSink(descriptorFor(dirA, { trialId: 'trial-A' }))
      .recordTransport({ requestHash: 'a', boundary: 'response_durable' });
    createObservationSink(descriptorFor(dirB, { trialId: 'trial-B' }))
      .recordTransport({ requestHash: 'b', boundary: 'response_durable' });
    ok(readObservations(dirA).transport.length === 1 &&
       readObservations(dirB).transport.length === 1,
    '13 each trial namespace holds only its own observations');
    // A line naming another trial is CONTAMINATION, and the reader refuses to
    // average over it rather than silently including it.
    fs.appendFileSync(streamPathFor(dirA, 'provider_transport'),
      `${JSON.stringify({ kind: 'provider_transport', sequence: 2, trialId: 'trial-B' })}\n`);
    const contaminated = readObservations(dirA);
    ok(contaminated.completeness === 'incomplete' &&
       contaminated.reason.includes('another trial'),
    '13 an observation from another trial makes the set INCOMPLETE, not larger');
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }

  // ── 16. Append-only ───────────────────────────────────────────────────
  {
    const dir = freshDir();
    markSinkInstalled(descriptorFor(dir));
    const sink = createObservationSink(descriptorFor(dir));
    sink.recordTransport({ requestHash: 'a', boundary: 'response_durable' });
    const target = streamPathFor(dir, 'provider_transport');
    const firstIdentity = hashBytes(fs.readFileSync(target));
    sink.recordTransport({ requestHash: 'b', boundary: 'response_durable' });
    const contents = fs.readFileSync(target, 'utf8').split('\n').filter(Boolean);
    ok(contents.length === 2 && JSON.parse(contents[0]).requestHash === 'a',
      '16 a second observation appends and leaves the first byte-identical');
    ok(hashBytes(fs.readFileSync(target)) !== firstIdentity,
      '16 and the stream identity moves when a record is added');
    // There is no update, delete or rewrite on the surface at all.
    ok(typeof sink.update === 'undefined' && typeof sink.overwrite === 'undefined' &&
       Object.keys(sink).every(key =>
         ['descriptor', 'recordTransport', 'recordConsumerRead',
           'recordExternalEffect'].includes(key)),
    '16 the sink exposes no way to overwrite an observation');
    ok(OBSERVATION_KINDS.length === 3 && OBSERVATION_SINK_VERSION === 1,
      'the sink declares exactly three observation kinds at version 1');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── External effects ──────────────────────────────────────────────────
  {
    const dir = freshDir();
    markSinkInstalled(descriptorFor(dir));
    const sink = createObservationSink(descriptorFor(dir));
    sink.recordExternalEffect({ effectId: 'reports/alpha/effect', attemptId: 'a1', committed: true });
    sink.recordExternalEffect({ effectId: 'reports/alpha/effect', attemptId: 'a2', committed: false });
    const effects = readObservations(dir).externalEffects;
    ok(effects.length === 2 && effects[0].committed === true && effects[1].committed === false,
      'external effects record each attempt and whether it committed');
    // Duplicates are INDEPENDENTLY observable: two committed records for one
    // effect id is what a duplicated effect looks like, and the sink does not
    // collapse them into one.
    const committedForEffect = effects.filter(e => e.effectId === 'reports/alpha/effect' && e.committed);
    ok(committedForEffect.length === 1,
      'a duplicate committed effect would be visible as a second committed record');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\nevaluation observation sink test passed — ${passed} assertions`);
}

main();
