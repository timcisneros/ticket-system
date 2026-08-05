'use strict';

// Tranche 6 — the family-4 coupling observation.
//
// THE PROBLEM THIS CLOSES. Family 4 is "apparently separable but actually
// tightly coupled": a consumer must use an artifact the producer created. Raw
// final state alone cannot decide it. If the consumer wrote a plausible-looking
// output without ever reading the producer's artifact, the final files can look
// exactly like a correct run. Scoring that as success would manufacture the very
// false-positive the evaluation exists to detect, so family 4 was recorded
// BLOCKED rather than weakened.
//
// THE OBSERVATION THAT RESOLVES IT. Three independent raw facts, none of them
// product authority:
//
//   1. the producer artifact is derived from the TRIAL SEED, so its content is
//      unpredictable before the trial and cannot be hard-coded into a response;
//   2. the fixture-owned access log records that the consumer READ that exact
//      artifact, by hash — written by the fixture workspace, not the Ticket
//      runtime;
//   3. the consumer's final output BINDS the producer artifact hash, so the
//      output cannot be produced without having seen it.
//
// Required distinction, exactly as the protocol states it:
//
//   correct dependency use                                 -> PASS
//   final files look correct with no consumer read         -> FAIL
//   insufficient fixture evidence to decide                -> REFUSED
//
// LIKE THE BASE ORACLE, THIS CONSULTS NO PRODUCT AUTHORITY. It reads the
// filesystem and the fixture's own access log. It imports nothing from
// `runtime/`, takes no store, and has no arm parameter.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class CouplingOracleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CouplingOracleError';
  }
}

// The producer artifact content is a pure function of the trial seed. Because
// the seed is chosen per trial and recorded, a consumer cannot emit the correct
// binding without having actually read the artifact.
function expectedProducerBytes(seed) {
  if (typeof seed !== 'string' || !seed) {
    throw new CouplingOracleError('a trial seed is required');
  }
  const nonce = crypto.createHash('sha256').update(`producer:${seed}`).digest('hex');
  return `PRODUCER-NONCE ${nonce}\n`;
}

function hashBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// Evaluate the coupling. `accessLog` is the fixture-owned record; it is passed
// in rather than read from a product table, which is what keeps this
// independent.
function evaluateCoupling({
  workspaceRoot,
  seed,
  producerPath,
  consumerPath,
  consumerReaderId,
  accessLog
}) {
  for (const [value, label] of [
    [workspaceRoot, 'workspaceRoot'], [seed, 'seed'],
    [producerPath, 'producerPath'], [consumerPath, 'consumerPath'],
    [consumerReaderId, 'consumerReaderId']
  ]) {
    if (typeof value !== 'string' || !value) {
      throw new CouplingOracleError(`${label} is required`);
    }
  }
  if (!Array.isArray(accessLog)) {
    throw new CouplingOracleError('accessLog must be an array of fixture records');
  }

  const observations = [];
  const producerAbsolute = path.join(workspaceRoot, producerPath);
  const consumerAbsolute = path.join(workspaceRoot, consumerPath);

  // 1. The producer artifact must exist and carry the seed-derived nonce.
  let producerBytes = null;
  try {
    producerBytes = fs.readFileSync(producerAbsolute);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return refused(observations, 'producer artifact could not be read');
    }
  }
  if (producerBytes === null) {
    observations.push({ fact: 'producer_artifact', verdict: 'fail', detail: 'absent' });
    return decide(observations);
  }
  const expected = expectedProducerBytes(seed);
  const producerHash = hashBytes(producerBytes);
  const producerMatches = producerBytes.toString('utf8') === expected;
  observations.push({
    fact: 'producer_artifact',
    verdict: producerMatches ? 'pass' : 'fail',
    detail: producerMatches ? producerHash : 'producer content is not the seed-derived nonce'
  });
  if (!producerMatches) return decide(observations);

  // 2. The fixture's own access log must record the consumer reading THAT hash.
  //    A read of some other file, or of the right path with the wrong bytes,
  //    does not count.
  const reads = accessLog.filter(entry =>
    entry && entry.reader === consumerReaderId &&
    entry.artifactPath === producerPath);
  if (reads.length === 0) {
    observations.push({
      fact: 'consumer_read',
      verdict: 'fail',
      detail: 'the fixture access log records no consumer read of the producer artifact'
    });
    // Deliberately NOT a refusal: the access log exists and is readable, and it
    // says the read did not happen. That is evidence, not absence of evidence.
    return decide(observations);
  }
  const readMatchingHash = reads.some(entry => entry.artifactHash === producerHash);
  observations.push({
    fact: 'consumer_read',
    verdict: readMatchingHash ? 'pass' : 'fail',
    detail: readMatchingHash
      ? `consumer read the producer artifact (${producerHash})`
      : 'consumer read a different version of the artifact than the one on disk'
  });
  if (!readMatchingHash) return decide(observations);

  // 3. The consumer's final output must BIND the producer hash.
  let consumerBytes = null;
  try {
    consumerBytes = fs.readFileSync(consumerAbsolute);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return refused(observations, 'consumer output could not be read');
    }
  }
  if (consumerBytes === null) {
    observations.push({ fact: 'consumer_output', verdict: 'fail', detail: 'absent' });
    return decide(observations);
  }
  const binds = consumerBytes.toString('utf8').includes(producerHash);
  observations.push({
    fact: 'consumer_output',
    verdict: binds ? 'pass' : 'fail',
    detail: binds
      ? 'consumer output binds the exact producer artifact hash'
      : 'consumer output does not bind the producer artifact hash'
  });
  return decide(observations);
}

function refused(observations, detail) {
  observations.push({ fact: 'observation', verdict: 'refused', detail });
  return Object.freeze({
    verdict: 'refused',
    observations: Object.freeze(observations),
    authority: 'independent_raw_state_and_fixture_access_log'
  });
}

function decide(observations) {
  const refusedCount = observations.filter(o => o.verdict === 'refused').length;
  const failed = observations.filter(o => o.verdict === 'fail').length;
  return Object.freeze({
    verdict: refusedCount > 0 ? 'refused' : (failed > 0 ? 'fail' : 'pass'),
    observations: Object.freeze(observations),
    authority: 'independent_raw_state_and_fixture_access_log'
  });
}

// When the fixture namespace itself is missing, the oracle cannot decide and
// must say so rather than treating absent evidence as a failed read.
function evaluateCouplingWithFixture({ workspaceRoot, seed, producerPath, consumerPath,
  consumerReaderId, accessLogAvailable, accessLog }) {
  if (!accessLogAvailable) {
    return refused([], 'the fixture access log is unavailable, so consumer reads ' +
      'cannot be observed at all');
  }
  return evaluateCoupling({
    workspaceRoot, seed, producerPath, consumerPath, consumerReaderId, accessLog });
}

module.exports = {
  CouplingOracleError,
  expectedProducerBytes,
  evaluateCoupling,
  evaluateCouplingWithFixture
};
