'use strict';

// Persistent, non-decision evidence for a candidate that the shared live
// artifact domain refused. Trial artifacts and exclusions satisfy corpus
// slots; this record deliberately lives in neither directory and can never do
// so. Its only purpose is to retain the exact projection that explained why a
// paid candidate was refused before acceptance.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DIAGNOSTIC_VERSION = 1;
const DIAGNOSTIC_LABEL = 'DIAGNOSTIC — NOT ACCEPTED PRODUCT EVIDENCE';
const HASH = /^[0-9a-f]{64}$/;

class LiveRejectedCandidateDiagnosticError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'LiveRejectedCandidateDiagnosticError';
    this.code = detail.code || 'LIVE_REJECTED_CANDIDATE_DIAGNOSTIC_INVALID';
    this.detail = detail;
  }
}

function hashRecord(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function safeIdentity(value, label) {
  if (typeof value !== 'string' || value.length === 0 ||
      !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new LiveRejectedCandidateDiagnosticError(`${label} is not a safe path identity`);
  }
  return value;
}

function persistentDiagnosticRootFor(scoredIdentity, repositoryRoot = path.resolve(__dirname, '../..')) {
  const runHash = scoredIdentity &&
    (scoredIdentity.scoredRunHash || scoredIdentity.runHeaderHash);
  if (!HASH.test(String(runHash || ''))) {
    throw new LiveRejectedCandidateDiagnosticError(
      'a persistent rejected-candidate root requires the scored run-header hash');
  }
  return path.join(repositoryRoot, '.local-artifacts',
    'structured-allocation-live-diagnostics', runHash);
}

function persistRejectedLiveCandidate({
  root, artifact, trial, disposition, terminalClass
}) {
  if (!root || !artifact || !trial || !disposition ||
      disposition.disposition !== 'refuse_before_product_evidence') {
    throw new LiveRejectedCandidateDiagnosticError(
      'rejected-candidate persistence requires its complete refusal projection');
  }
  const trialId = safeIdentity(String(trial.trialId || artifact.trialId || ''), 'trialId');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  const withoutHash = {
    diagnosticVersion: DIAGNOSTIC_VERSION,
    label: DIAGNOSTIC_LABEL,
    acceptedProductEvidence: false,
    infrastructureExclusion: false,
    scored: false,
    trialIdentity: {
      trialId,
      trialSlot: artifact.trialSlot,
      scenarioId: artifact.scenarioId,
      armId: artifact.armId,
      repetition: artifact.repetition
    },
    sourceIdentity: {
      sourceCommit: artifact.sourceCommit,
      scoredRunHash: artifact.scoredRunHash,
      manifestHash: artifact.manifestHash
    },
    candidateTerminalState: terminalClass,
    oracle: {
      expectedAuthority: trial.expectedOracleAuthority,
      authority: artifact.oracleResult?.authority || null,
      verdict: artifact.oracleResult?.verdict || null
    },
    observationCompleteness: artifact.observationCompleteness,
    refusal: {
      code: disposition.code,
      message: disposition.message,
      metrics: disposition.detail?.metrics || null
    },
    // The normal artifact projection is safe to persist under the same evidence
    // rules as an accepted artifact. It is wrapped here rather than written to
    // trials/, and its label cannot be mistaken for product evidence.
    candidateProjection: artifact
  };
  const record = { ...withoutHash, diagnosticRecordHash: hashRecord(withoutHash) };
  const target = path.join(root, `${trialId}.json`);
  let handle;
  try {
    handle = fs.openSync(target, 'wx', 0o600);
    fs.writeFileSync(handle, `${JSON.stringify(record, null, 2)}\n`);
    fs.fsyncSync(handle);
  } catch (error) {
    throw new LiveRejectedCandidateDiagnosticError(
      `failed to persist rejected candidate ${trialId}: ${error.message}`,
      { code: 'LIVE_REJECTED_CANDIDATE_DIAGNOSTIC_PERSISTENCE_FAILED', trialId });
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
  return Object.freeze({ target, record: Object.freeze(record) });
}

function readRejectedLiveCandidate(target) {
  const record = JSON.parse(fs.readFileSync(target, 'utf8'));
  const { diagnosticRecordHash, ...withoutHash } = record;
  if (record.label !== DIAGNOSTIC_LABEL || record.acceptedProductEvidence !== false ||
      !HASH.test(String(diagnosticRecordHash || '')) ||
      hashRecord(withoutHash) !== diagnosticRecordHash) {
    throw new LiveRejectedCandidateDiagnosticError(
      'rejected-candidate diagnostic identity or hash is invalid');
  }
  return Object.freeze(record);
}

function persistRejectedLiveCandidateBeforeRefusal(input, refuse) {
  if (typeof refuse !== 'function') {
    throw new LiveRejectedCandidateDiagnosticError('the refusal callback is required');
  }
  persistRejectedLiveCandidate(input);
  // The caller supplies its canonical domain-error constructor. If it ever
  // returns, fail closed rather than letting a rejected candidate continue.
  const returned = refuse();
  void returned;
  throw new LiveRejectedCandidateDiagnosticError(
    'the rejected-candidate refusal callback returned instead of throwing');
}

module.exports = {
  DIAGNOSTIC_LABEL,
  DIAGNOSTIC_VERSION,
  LiveRejectedCandidateDiagnosticError,
  persistRejectedLiveCandidate,
  persistRejectedLiveCandidateBeforeRefusal,
  persistentDiagnosticRootFor,
  readRejectedLiveCandidate
};
