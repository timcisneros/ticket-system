'use strict';

// Tranche 6 — the gate a live corpus must pass before anything scores it.
//
// WRITTEN BEFORE THE EVIDENCE EXISTS, deliberately. A completeness check
// authored after looking at results is a check shaped to the results it found.
// This one is written while the corpus is still empty, so every condition comes
// from the frozen manifest and the run header rather than from what a run
// happened to produce.
//
// IT ANSWERS ONE QUESTION: are these 120 accounted-for slots the frozen
// experiment, executed once each, from one source, under one manifest, in one
// run — or are they something else? Anything else must not be scored, because a
// score computed over a corpus that quietly lost a slot, gained a duplicate, or
// mixed two runs is a number with no referent.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { acceptedSlots, readJournal } = require('./evaluation-live-run-journal');

const COMPLETE_VERDICT = 'LIVE CORPUS COMPLETE AND INTERNALLY CONSISTENT';

// The synthetic acceptance corpus wears this label. The scorer refuses it, so
// a harness proof can never be mistaken for product evidence.
const SYNTHETIC_ACCEPTANCE_LABEL =
  'LIVE EXECUTOR ACCEPTANCE — SYNTHETIC FINAL-TRANSPORT CAPTURE — NOT PRODUCT EVIDENCE';

class LiveCorpusError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'LiveCorpusError';
    this.code = detail.code || 'LIVE_CORPUS_INCONSISTENT';
    this.detail = detail;
  }
}

function readArtifact(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function auditLiveCorpus({ manifest, header, outputRoot, trialIdFor }) {
  const failures = [];
  const fail = (code, message, detail = {}) =>
    failures.push({ code, message, ...detail });

  const assigned = manifest.slots;
  const assignedIds = assigned.map(trialIdFor);
  const bySlotId = new Map(assigned.map(slot => [trialIdFor(slot), slot]));

  // ── 120 assigned, 120 accounted for ──────────────────────────────────
  if (assigned.length !== manifest.totalAssignedTrials) {
    fail('ASSIGNED_COUNT_MISMATCH',
      `manifest enumerates ${assigned.length} slots but declares ` +
      `${manifest.totalAssignedTrials}`);
  }
  const accepted = acceptedSlots(outputRoot);
  for (const id of assignedIds) {
    if (!accepted.has(id)) fail('SLOT_NOT_ACCOUNTED_FOR', `slot ${id} was never accepted`, { trialId: id });
  }
  for (const id of accepted.keys()) {
    if (!bySlotId.has(id)) {
      fail('SLOT_NOT_ASSIGNED', `accepted slot ${id} is not in the frozen manifest`, { trialId: id });
    }
  }

  // ── Exactly one record per slot, no duplicates, no replacements ──────
  const seen = new Map();
  for (const record of readJournal(outputRoot).records) {
    if (record.event !== 'slot_accepted' && record.event !== 'infrastructure_excluded') continue;
    if (seen.has(record.trialId)) {
      fail('DUPLICATE_ACCEPTANCE', `slot ${record.trialId} was accepted more than once`,
        { trialId: record.trialId });
    }
    seen.set(record.trialId, record);
    if (record.runHeaderHash !== header.runHeaderHash) {
      fail('JOURNAL_FOREIGN_RUN', `journal record for ${record.trialId} binds another run header`,
        { trialId: record.trialId });
    }
    if (record.manifestHash !== header.manifestHash) {
      fail('JOURNAL_FOREIGN_MANIFEST', `journal record for ${record.trialId} binds another manifest`,
        { trialId: record.trialId });
    }
  }

  // ── Every artifact binds one source, one manifest, one run header ────
  const artifacts = [];
  const exclusions = [];
  for (const [id, how] of accepted.entries()) {
    const slot = bySlotId.get(id);
    if (!slot) continue;
    if (how === 'infrastructure_excluded') {
      const file = path.join(outputRoot, 'exclusions', `${id}.json`);
      const parsed = readArtifact(file);
      if (!parsed) { fail('EXCLUSION_ARTIFACT_MISSING', `no exclusion artifact for ${id}`, { trialId: id }); continue; }
      // AN EXCLUSION KEEPS ITS SLOT. No substitute seed, no replacement trial.
      for (const [field, expected] of [['armId', slot.armId], ['repetition', slot.repetition],
        ['seed', slot.stochasticIdentity], ['slot', slot.slot]]) {
        if (parsed.assignedSlot?.[field] !== expected) {
          fail('EXCLUSION_SLOT_MISMATCH',
            `exclusion ${id} does not preserve its assigned ${field}`, { trialId: id });
        }
      }
      if (typeof parsed.frozenReason !== 'string' || parsed.frozenReason.length === 0) {
        fail('EXCLUSION_UNREASONED', `exclusion ${id} names no frozen predicate reason`, { trialId: id });
      }
      if (parsed.replacementSlot !== null && parsed.replacementSlot !== undefined) {
        fail('EXCLUSION_REPLACED', `exclusion ${id} carries a replacement slot`, { trialId: id });
      }
      exclusions.push(parsed);
      continue;
    }
    const file = path.join(outputRoot, 'trials', `${id}.json`);
    const parsed = readArtifact(file);
    if (!parsed) { fail('ARTIFACT_MISSING', `no trial artifact for ${id}`, { trialId: id }); continue; }
    if (parsed.scoredRunHash !== header.runHeaderHash) {
      fail('ARTIFACT_FOREIGN_RUN', `artifact ${id} binds run ${parsed.scoredRunHash}`, { trialId: id });
    }
    if (parsed.manifestHash !== header.manifestHash) {
      fail('ARTIFACT_FOREIGN_MANIFEST', `artifact ${id} binds another manifest`, { trialId: id });
    }
    if (parsed.sourceCommit !== header.repositoryCommit) {
      fail('ARTIFACT_FOREIGN_COMMIT', `artifact ${id} was produced from another commit`, { trialId: id });
    }
    if (parsed.mode !== 'live') {
      fail('FIXTURE_LIVE_MIXING', `artifact ${id} is not a live-mode artifact`, { trialId: id });
    }
    // The assigned identity must be the one that ran.
    for (const [field, expected] of [['armId', slot.armId], ['repetition', slot.repetition],
      ['seed', slot.stochasticIdentity]]) {
      if (parsed[field] !== undefined && parsed[field] !== expected) {
        fail('ARTIFACT_SLOT_MISMATCH', `artifact ${id} ran with ${field}=${parsed[field]}, ` +
          `assigned ${expected}`, { trialId: id });
      }
    }
    // ZERO-DRIFT. A report that cannot reproduce itself is not evidence.
    if (parsed.reportZeroDrift !== true) {
      fail('ZERO_DRIFT_UNPROVEN', `artifact ${id} carries no zero-drift proof`, { trialId: id });
    }
    artifacts.push(parsed);
  }

  // ── The ceiling was never exceeded ───────────────────────────────────
  if (typeof header.economics?.maximumTotalLiveMicroUsd === 'number') {
    const committed = Number(header.economics.committedMicroUsd || 0);
    if (committed > header.economics.maximumTotalLiveMicroUsd) {
      fail('CEILING_EXCEEDED',
        `committed ${committed} exceeds the ceiling ${header.economics.maximumTotalLiveMicroUsd}`);
    }
  }

  const corpusHash = crypto.createHash('sha256').update(JSON.stringify({
    runHeaderHash: header.runHeaderHash,
    manifestHash: header.manifestHash,
    repositoryCommit: header.repositoryCommit,
    accepted: [...accepted.entries()].sort()
  })).digest('hex');

  const complete = failures.length === 0;
  return Object.freeze({
    verdict: complete ? COMPLETE_VERDICT : 'LIVE CORPUS INCONSISTENT',
    complete,
    assignedCount: assigned.length,
    accountedForCount: accepted.size,
    artifactCount: artifacts.length,
    exclusionCount: exclusions.length,
    corpusHash,
    // A synthetic acceptance corpus is marked here so the scorer can refuse it
    // by contract rather than by convention.
    syntheticAcceptance: header.syntheticAcceptance === true,
    failures: Object.freeze(failures)
  });
}

// THE SCORER'S DOOR. It refuses an inconsistent corpus, and it refuses the
// synthetic acceptance corpus even when that corpus is internally perfect —
// being complete is not the same as being product evidence.
function assertScorableLiveCorpus(audit) {
  if (audit.syntheticAcceptance === true) {
    throw new LiveCorpusError(
      'this corpus is the synthetic final-transport acceptance run and is NOT ' +
      'product evidence; it may never be scored as live results',
      { code: 'LIVE_CORPUS_SYNTHETIC_NOT_PRODUCT_EVIDENCE' });
  }
  if (!audit.complete) {
    throw new LiveCorpusError(
      `refusing to score: ${audit.failures.length} integrity failure(s)`,
      { code: 'LIVE_CORPUS_INCONSISTENT', failures: audit.failures.slice(0, 10) });
  }
  return true;
}

module.exports = {
  COMPLETE_VERDICT,
  LiveCorpusError,
  SYNTHETIC_ACCEPTANCE_LABEL,
  assertScorableLiveCorpus,
  auditLiveCorpus
};
