'use strict';

// Tranche 6 — the fixture-owned observation that a consumer actually READ a
// producer artifact.
//
// WHY THIS IS NEEDED AND WHY IT CANNOT BE INFERRED FROM FILES.
//
// Families 3 and 4 ask whether a dependent task genuinely consumed a sibling's
// output. Final files cannot answer that: a consumer summary can name the
// correct producer hash because the product really read it, or because the
// staged response already contained it. Those two worlds have identical final
// state, and calling both PASS would report luck as coupling.
//
// So the observation is taken at the ONE place a read is externally visible:
// the moment the fixture serves a request. If the producer's exact seed-derived
// bytes — or their hash — appear in the OUTGOING request, then the product
// itself gathered the producer's output and carried it into the consumer's
// context. That is real product behaviour, observed from outside the product,
// and it is identical across arms.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It never inspects allocation plans, block
// authority, completion decisions or any product table. It reads one request
// body and one seed. A request that does not carry the producer's bytes records
// nothing — absence of evidence is recorded as absence, never as a read.

const fs = require('node:fs');
const crypto = require('node:crypto');
const { expectedProducerBytes } = require('./evaluation-coupling-oracle');

// The consumer's request must carry the producer's CONTENT, not merely its
// path: a path proves the consumer was told where to look, not that anything
// was read. The hash is accepted too, because a product that summarizes an
// artifact by its digest has still demonstrably read it.
function observeArtifactRead({
  accessLogPath, requestBody, seed, reader, artifactPath
}) {
  if (!accessLogPath || typeof requestBody !== 'string' || !seed || !reader) return null;
  let producerBytes;
  try {
    producerBytes = expectedProducerBytes(seed);
  } catch (_) {
    return null;
  }
  const artifactHash = crypto.createHash('sha256').update(producerBytes).digest('hex');
  // The request body is JSON, so the bytes appear escaped. Both forms are
  // checked rather than assuming an encoding.
  const escaped = JSON.stringify(producerBytes).slice(1, -1);
  const carriesBytes = requestBody.includes(producerBytes) || requestBody.includes(escaped);
  const carriesHash = requestBody.includes(artifactHash);
  if (!carriesBytes && !carriesHash) return null;

  const record = {
    reader,
    artifactPath: artifactPath || null,
    artifactHash,
    observedVia: carriesBytes ? 'request_carried_artifact_bytes' : 'request_carried_artifact_hash',
    at: Date.now()
  };
  fs.appendFileSync(accessLogPath, `${JSON.stringify(record)}\n`);
  return record;
}

module.exports = { observeArtifactRead };
