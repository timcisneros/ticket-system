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
const {
  assertLiveProductArtifactScorable
} = require('./evaluation-live-artifact-domain');

const COMPLETE_VERDICT = 'LIVE CORPUS COMPLETE AND INTERNALLY CONSISTENT';
const SCORING_INPUT_COMPLETE_VERDICT = 'LIVE SCORING INPUT DOMAIN COMPLETE';

// The synthetic acceptance corpus wears this label. The scorer refuses it, so
// a harness proof can never be mistaken for product evidence.
const SYNTHETIC_ACCEPTANCE_LABEL =
  'LIVE EXECUTOR ACCEPTANCE — SYNTHETIC FINAL-TRANSPORT CAPTURE — NOT PRODUCT EVIDENCE';

// REAL product evidence has its own identity. Fixture branding previously
// leaked into real artifacts, which made a downstream scorer unable to tell the
// two evidence classes apart without trusting directory names.
const REAL_LIVE_ARTIFACT_LABEL =
  'REAL LIVE PRODUCT EVIDENCE — FROZEN PROTOCOL V1';

// ── ABORTED RUNS ────────────────────────────────────────────────────────────
//
// The identity and the predicate live in `evaluation-aborted-runs`, which has
// no filesystem or scoring dependency, precisely so the SAME rule can be
// enforced at this gate, at the scorer's door and at the final
// evidence-combination contract. A rule enforced at one of three doors is a
// rule that can be walked around.
const {
  ABORTED_LABEL, PERMANENTLY_ABORTED_RUNS, abortedRunDetail, isAbortedRunHeader
} = require('./evaluation-aborted-runs');

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

// THE EXCLUSION ARTIFACT'S SHAPE IS A CONTRACT, so it lives here as a function
// rather than inline in the executor loop. An exclusion is the only way a slot
// leaves the corpus, and the two rules that make that safe — it keeps its
// assigned identity, and it gains no replacement — must be checkable without
// first provoking a provider outage.
function buildExclusionArtifact({ label, trialId, header, slot, classified }) {
  return Object.freeze({
    label,
    trialId,
    scoredRunHash: header.runHeaderHash,
    manifestHash: header.manifestHash,
    sourceCommit: header.repositoryCommit,
    // NO SUBSTITUTE SEED, NO REPLACEMENT TRIAL. The slot is preserved exactly
    // as assigned, so 120 assigned stays 120 accounted for.
    assignedSlot: Object.freeze({
      slot: slot.slot,
      armId: slot.armId,
      scenarioId: slot.scenarioId,
      variantId: slot.variantId || null,
      repetition: slot.repetition,
      seed: slot.stochasticIdentity
    }),
    frozenReason: classified.reason,
    classification: classified.classification,
    evidence: classified.evidence,
    replacementSlot: null,
    at: new Date().toISOString()
  });
}

function auditLiveCorpus({ manifest, header, outputRoot, trialIdFor }) {
  const failures = [];
  const fail = (code, message, detail = {}) =>
    failures.push({ code, message, ...detail });

  // ── An aborted run is refused before anything else is measured ───────
  //
  // First, because every count below would otherwise describe a corpus that
  // may not exist. A partially executed run can be internally consistent over
  // the slots it reached, and consistency is exactly what must not be mistaken
  // for completeness here.
  const aborted = isAbortedRunHeader(header);
  if (aborted) {
    // RETURN BEFORE READING THE JOURNAL OR ANY OUTCOME ARTIFACT. Quarantine is
    // an identity decision, not an aggregation result; no fact from an aborted
    // prefix may influence compatibility logic or future score design.
    const detail = Object.freeze(abortedRunDetail(header));
    return Object.freeze({
      verdict: 'LIVE CORPUS ABORTED — NOT DECISION EVIDENCE',
      complete: false,
      assignedCount: Array.isArray(manifest && manifest.slots)
        ? manifest.slots.length : 0,
      accountedForCount: 0,
      artifactCount: 0,
      exclusionCount: 0,
      corpusHash: null,
      syntheticAcceptance: header && header.syntheticAcceptance === true,
      aborted: true,
      abortedDetail: detail,
      failures: Object.freeze([Object.freeze({
        code: 'LIVE_CORPUS_ABORTED_NOT_DECISION_EVIDENCE',
        message: 'this run is marked ABORTED — NOT DECISION EVIDENCE and may ' +
          'never be imported into a valid corpus',
        aborted: detail
      })])
    });
  }

  const assigned = manifest.slots;
  const assignedIds = assigned.map(trialIdFor);
  const bySlotId = new Map(assigned.map(slot => [trialIdFor(slot), slot]));
  const cells = new Map((manifest.cells || []).map(cell => [cell.cellKey, cell]));

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
    const expectedLabel = header.syntheticAcceptance === true
      ? SYNTHETIC_ACCEPTANCE_LABEL : REAL_LIVE_ARTIFACT_LABEL;
    if (parsed.label !== expectedLabel) {
      fail('LIVE_ARTIFACT_IDENTITY_MISMATCH',
        `artifact ${id} does not carry the expected live evidence identity`,
        { trialId: id });
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
    //
    // The proof is the runner's own: it collects the read-only report TWICE and
    // records whether the second read was identical. This gate reads that field
    // rather than a field of its own naming — an integrity check that invents
    // the name of the thing it verifies proves nothing about the artifact.
    if (parsed.ticketReport?.secondReadIdentical !== true) {
      fail('ZERO_DRIFT_UNPROVEN',
        `artifact ${id} carries no zero-drift proof (ticketReport.secondReadIdentical)`,
        { trialId: id });
    }
    const cell = cells.get(slot.cellKey);
    try {
      assertLiveProductArtifactScorable({
        artifact: parsed,
        manifest,
        trial: {
          trialId: id,
          expectedOracleAuthority: cell && cell.expectedOracleAuthority,
          expectedQuiescence: cell && cell.expectedQuiescence
        }
      });
    } catch (error) {
      fail(error.code || 'LIVE_ARTIFACT_OUTSIDE_SCORING_DOMAIN',
        `artifact ${id} is outside the frozen live scoring-input domain`,
        { trialId: id, disposition: 'refuse_before_product_evidence' });
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
    scoringInputDomainComplete: complete,
    scoringInputDomainVerdict: complete ? SCORING_INPUT_COMPLETE_VERDICT
      : 'LIVE SCORING INPUT DOMAIN INCOMPLETE',
    assignedCount: assigned.length,
    accountedForCount: accepted.size,
    artifactCount: artifacts.length,
    exclusionCount: exclusions.length,
    corpusHash,
    // A synthetic acceptance corpus is marked here so the scorer can refuse it
    // by contract rather than by convention.
    syntheticAcceptance: header.syntheticAcceptance === true,
    // Carried as its own field rather than only as a failure, so a consumer
    // that never looks at `failures` still cannot score it.
    aborted,
    abortedDetail: aborted ? Object.freeze(abortedRunDetail(header)) : null,
    failures: Object.freeze(failures)
  });
}

// THE SCORER'S DOOR. It refuses an inconsistent corpus, and it refuses the
// synthetic acceptance corpus even when that corpus is internally perfect —
// being complete is not the same as being product evidence.
function assertScorableLiveCorpus(audit) {
  // FIRST, AND BEFORE COMPLETENESS. An aborted corpus that happens to be
  // internally perfect over the slots it reached must still be refused: being
  // consistent is not the same as being the experiment.
  if (audit && audit.aborted === true) {
    throw new LiveCorpusError(
      'this corpus belongs to a run marked ABORTED — NOT DECISION EVIDENCE; ' +
      'it may never be scored and may never be imported into a valid corpus',
      { code: 'LIVE_CORPUS_ABORTED_NOT_DECISION_EVIDENCE',
        aborted: audit.abortedDetail || null });
  }
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
  if (audit.scoringInputDomainComplete !== true ||
      audit.scoringInputDomainVerdict !== SCORING_INPUT_COMPLETE_VERDICT) {
    throw new LiveCorpusError(
      'refusing to score: the accepted product-artifact domain is incomplete',
      { code: 'LIVE_SCORING_INPUT_DOMAIN_INCOMPLETE' });
  }
  return true;
}

module.exports = {
  ABORTED_LABEL,
  COMPLETE_VERDICT,
  SCORING_INPUT_COMPLETE_VERDICT,
  PERMANENTLY_ABORTED_RUNS,
  buildExclusionArtifact,
  LiveCorpusError,
  REAL_LIVE_ARTIFACT_LABEL,
  SYNTHETIC_ACCEPTANCE_LABEL,
  abortedRunDetail,
  assertScorableLiveCorpus,
  auditLiveCorpus,
  isAbortedRunHeader
};
