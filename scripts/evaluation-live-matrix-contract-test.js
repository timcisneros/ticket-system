#!/usr/bin/env node
'use strict';

// Tranche 6 — the live matrix executor's contract, proved without a server.
//
// The 120-slot acceptance run proves the executor can drive the real product
// path. This suite proves the things that run cannot: the refusals. A corpus is
// only evidence if the executor REFUSES a second corpus in the same directory,
// refuses a rewritten journal, refuses to accept a slot twice, refuses to score
// a corpus with a hole in it, and refuses to let a harness proof be mistaken for
// product evidence. Those are the paths a successful run never touches, which
// is exactly why they need their own proof.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  LiveJournalError, acceptedSlots, appendJournal, readJournal, unresolvedReservations
} = require('./fixtures/evaluation-live-run-journal');
const {
  COMPLETE_VERDICT, LiveCorpusError, SYNTHETIC_ACCEPTANCE_LABEL,
  assertScorableLiveCorpus, auditLiveCorpus
} = require('./fixtures/evaluation-live-corpus-integrity');
const { trialIdFor } = require('./structured-allocation-evaluation-scored-runner');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config',
  'structured-allocation-evaluation-live-v1.json'), 'utf8'));

let passed = 0;
function ok(condition, message) {
  assert.equal(condition, true, message);
  passed += 1;
  console.log(`  ok ${message}`);
}
function refuses(fn) { try { fn(); return null; } catch (error) { return error; } }
function freshRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'live-matrix-')); }

const HEADER = Object.freeze({
  runHeaderHash: 'run-header-hash-1',
  manifestHash: manifest.manifestHash,
  repositoryCommit: 'commit-1',
  syntheticAcceptance: false
});
const bind = {
  runHeaderHash: HEADER.runHeaderHash, manifestHash: HEADER.manifestHash
};

// Writes a complete, internally consistent corpus for `count` slots.
function seedCorpus(root, count, overrides = {}) {
  fs.mkdirSync(path.join(root, 'trials'), { recursive: true });
  fs.mkdirSync(path.join(root, 'exclusions'), { recursive: true });
  for (const slot of manifest.slots.slice(0, count)) {
    const id = trialIdFor(slot);
    fs.writeFileSync(path.join(root, 'trials', `${id}.json`), JSON.stringify({
      scoredRunHash: HEADER.runHeaderHash,
      manifestHash: HEADER.manifestHash,
      sourceCommit: HEADER.repositoryCommit,
      mode: 'live',
      armId: slot.armId,
      repetition: slot.repetition,
      seed: slot.stochasticIdentity,
      ticketReport: { secondReadIdentical: true },
      ...overrides
    }));
    appendJournal(root, { ...bind, event: 'reservation_committed', trialId: id, slotOrdinal: slot.slot });
    appendJournal(root, { ...bind, event: 'trial_started', trialId: id, slotOrdinal: slot.slot });
    appendJournal(root, { ...bind, event: 'artifact_committed', trialId: id, slotOrdinal: slot.slot });
    appendJournal(root, { ...bind, event: 'slot_accepted', trialId: id, slotOrdinal: slot.slot });
  }
}

function main() {
  console.log('evaluation live matrix contract');

  // ── THE JOURNAL ──────────────────────────────────────────────────────
  {
    const root = freshRoot();
    const id = trialIdFor(manifest.slots[0]);
    appendJournal(root, { ...bind, event: 'reservation_committed', trialId: id, slotOrdinal: 1 });
    appendJournal(root, { ...bind, event: 'slot_accepted', trialId: id, slotOrdinal: 1 });
    ok(acceptedSlots(root).get(id) === 'slot_accepted',
      'an accepted slot is recorded once and readable back');

    // ONE ACCEPTANCE, FOREVER. This is what stops a 121st result appearing.
    const duplicate = refuses(() =>
      appendJournal(root, { ...bind, event: 'slot_accepted', trialId: id, slotOrdinal: 1 }));
    ok(duplicate instanceof LiveJournalError &&
       duplicate.code === 'LIVE_JOURNAL_DUPLICATE_ACCEPTANCE',
    'a slot can never be accepted twice');
    // Nor may an exclusion replace an accepted trial.
    ok(refuses(() => appendJournal(root, { ...bind, event: 'infrastructure_excluded',
      trialId: id, slotOrdinal: 1 })) !== null,
    'an accepted slot cannot later be replaced by an exclusion');

    ok(refuses(() => appendJournal(root, { ...bind, event: 'invented_event', trialId: id })) !== null,
      'an unknown journal event refuses rather than being recorded');
    ok(refuses(() => appendJournal(root, { manifestHash: 'm', event: 'assigned', trialId: id })) !== null,
      'a journal entry that binds no run header refuses');

    // A REWRITTEN HISTORY BREAKS THE CHAIN.
    const file = path.join(root, 'live-run-journal.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const tampered = JSON.parse(lines[0]); tampered.slotOrdinal = 99;
    fs.writeFileSync(file, [JSON.stringify(tampered), ...lines.slice(1)].join('\n') + '\n');
    const rewritten = refuses(() => readJournal(root));
    ok(rewritten instanceof LiveJournalError &&
       ['LIVE_JOURNAL_REWRITTEN', 'LIVE_JOURNAL_CHAIN_BROKEN'].includes(rewritten.code),
    'an edited journal refuses to be read rather than misreporting the corpus');
    fs.rmSync(root, { recursive: true, force: true });
  }

  // A reservation with no acceptance is visible, so recovery can resolve it
  // through the canonical contract rather than guessing.
  {
    const root = freshRoot();
    const id = trialIdFor(manifest.slots[0]);
    appendJournal(root, { ...bind, event: 'reservation_committed', trialId: id, slotOrdinal: 1 });
    ok(unresolvedReservations(root).has(id),
      'a committed reservation with no acceptance is surfaced for recovery');
    appendJournal(root, { ...bind, event: 'slot_accepted', trialId: id, slotOrdinal: 1 });
    ok(unresolvedReservations(root).size === 0,
      'and stops being unresolved once its slot is accepted');
    fs.rmSync(root, { recursive: true, force: true });
  }

  // ── THE CORPUS GATE ──────────────────────────────────────────────────
  {
    const root = freshRoot();
    seedCorpus(root, manifest.slots.length);
    const audit = auditLiveCorpus({ manifest, header: HEADER, outputRoot: root, trialIdFor });
    ok(audit.complete === true && audit.verdict === COMPLETE_VERDICT,
      `a complete corpus passes: ${audit.verdict}`);
    ok(audit.assignedCount === 120 && audit.accountedForCount === 120,
      '120 assigned, 120 accounted for');
    ok(assertScorableLiveCorpus(audit) === true,
      'and a product corpus that is complete may be scored');
    fs.rmSync(root, { recursive: true, force: true });
  }

  // A MISSING SLOT IS NOT A ROUNDING ERROR.
  {
    const root = freshRoot();
    seedCorpus(root, manifest.slots.length - 1);
    const audit = auditLiveCorpus({ manifest, header: HEADER, outputRoot: root, trialIdFor });
    ok(audit.complete === false &&
       audit.failures.some(f => f.code === 'SLOT_NOT_ACCOUNTED_FOR'),
    'a corpus missing one slot REFUSES, naming the slot');
    ok(refuses(() => assertScorableLiveCorpus(audit)) instanceof LiveCorpusError,
      'and the scorer will not touch it');
    fs.rmSync(root, { recursive: true, force: true });
  }

  // AN EXTRA SLOT IS NOT A BONUS.
  {
    const root = freshRoot();
    seedCorpus(root, manifest.slots.length);
    appendJournal(root, { ...bind, event: 'slot_accepted', trialId: 'not-an-assigned-slot', slotOrdinal: 999 });
    const audit = auditLiveCorpus({ manifest, header: HEADER, outputRoot: root, trialIdFor });
    ok(audit.failures.some(f => f.code === 'SLOT_NOT_ASSIGNED'),
      'a slot that is not in the frozen manifest REFUSES the corpus');
    fs.rmSync(root, { recursive: true, force: true });
  }

  // ONE SOURCE, ONE MANIFEST, ONE RUN.
  for (const [field, value, code] of [
    ['sourceCommit', 'another-commit', 'ARTIFACT_FOREIGN_COMMIT'],
    ['manifestHash', 'another-manifest', 'ARTIFACT_FOREIGN_MANIFEST'],
    ['scoredRunHash', 'another-run', 'ARTIFACT_FOREIGN_RUN'],
    ['mode', 'fixture', 'FIXTURE_LIVE_MIXING'],
    ['ticketReport', { secondReadIdentical: false }, 'ZERO_DRIFT_UNPROVEN']]) {
    const root = freshRoot();
    seedCorpus(root, 2);
    // Corrupt the first artifact only.
    const id = trialIdFor(manifest.slots[0]);
    const file = path.join(root, 'trials', `${id}.json`);
    const artifact = JSON.parse(fs.readFileSync(file, 'utf8'));
    artifact[field] = value;
    fs.writeFileSync(file, JSON.stringify(artifact));
    const audit = auditLiveCorpus({ manifest, header: HEADER, outputRoot: root, trialIdFor });
    ok(audit.failures.some(f => f.code === code),
      `an artifact with the wrong ${field} REFUSES the corpus (${code})`);
    fs.rmSync(root, { recursive: true, force: true });
  }

  // AN EXCLUSION KEEPS ITS SLOT AND GAINS NO REPLACEMENT.
  {
    const root = freshRoot();
    fs.mkdirSync(path.join(root, 'exclusions'), { recursive: true });
    fs.mkdirSync(path.join(root, 'trials'), { recursive: true });
    const slot = manifest.slots[0];
    const id = trialIdFor(slot);
    const write = extra => fs.writeFileSync(path.join(root, 'exclusions', `${id}.json`),
      JSON.stringify({
        assignedSlot: { slot: slot.slot, armId: slot.armId, repetition: slot.repetition,
          seed: slot.stochasticIdentity },
        frozenReason: 'provider 429 before useful inference',
        replacementSlot: null, ...extra
      }));
    write({});
    appendJournal(root, { ...bind, event: 'infrastructure_excluded', trialId: id, slotOrdinal: slot.slot });
    let audit = auditLiveCorpus({ manifest, header: HEADER, outputRoot: root, trialIdFor });
    ok(!audit.failures.some(f => f.trialId === id),
      'a well-formed exclusion preserves its assigned slot and passes');
    ok(audit.exclusionCount === 1 && audit.accountedForCount === 1,
      'and the excluded slot still COUNTS as accounted for — 120 stays 120');
    write({ replacementSlot: { slot: 121 } });
    audit = auditLiveCorpus({ manifest, header: HEADER, outputRoot: root, trialIdFor });
    ok(audit.failures.some(f => f.code === 'EXCLUSION_REPLACED'),
      'an exclusion carrying a replacement slot REFUSES');
    write({ frozenReason: '' });
    audit = auditLiveCorpus({ manifest, header: HEADER, outputRoot: root, trialIdFor });
    ok(audit.failures.some(f => f.code === 'EXCLUSION_UNREASONED'),
      'and an exclusion naming no frozen predicate reason REFUSES');
    fs.rmSync(root, { recursive: true, force: true });
  }

  // ── THE SYNTHETIC CORPUS IS NOT PRODUCT EVIDENCE ─────────────────────
  {
    const root = freshRoot();
    seedCorpus(root, manifest.slots.length);
    const syntheticHeader = { ...HEADER, syntheticAcceptance: true };
    // It is judged against its own run header, so it is internally complete.
    const audit = auditLiveCorpus({
      manifest, header: syntheticHeader, outputRoot: root, trialIdFor });
    ok(audit.complete === true,
      'the synthetic acceptance corpus can be internally complete');
    const refusal = refuses(() => assertScorableLiveCorpus(audit));
    ok(refusal instanceof LiveCorpusError &&
       refusal.code === 'LIVE_CORPUS_SYNTHETIC_NOT_PRODUCT_EVIDENCE',
    'and is REFUSED as live product evidence anyway — complete is not the same as real');
    ok(SYNTHETIC_ACCEPTANCE_LABEL.includes('NOT PRODUCT EVIDENCE'),
      'the label says so in terms');
    fs.rmSync(root, { recursive: true, force: true });
  }

  // ── CRASH BOUNDARIES ─────────────────────────────────────────────────
  //
  // A crash is not a special case; it is the ordinary case at scale. The four
  // boundaries below are the ones where recovery could plausibly duplicate
  // provider exposure, duplicate an accepted artifact, release liability that
  // was really incurred, or lose a slot entirely. Each is proved against the
  // durable records a crashed process would actually leave behind.
  const slot = manifest.slots[0];
  const id = trialIdFor(slot);

  // A. reservation committed, process died BEFORE the trial started.
  {
    const root = freshRoot();
    appendJournal(root, { ...bind, event: 'reservation_committed', trialId: id, slotOrdinal: slot.slot });
    ok(unresolvedReservations(root).has(id),
      'A: a reservation with no trial is surfaced, not silently dropped');
    ok(acceptedSlots(root).has(id) === false,
      'A: and the slot is NOT accepted, so it still owes execution');
    // The liability stays committed. Releasing it would require proof of no
    // provider contact, which a crashed process cannot supply about itself.
    ok(readJournal(root).records.every(r => r.event !== 'slot_accepted'),
      'A: nothing was accepted on the strength of a reservation alone');
    fs.rmSync(root, { recursive: true, force: true });
  }

  // B. trial started, process died BEFORE the artifact was committed.
  {
    const root = freshRoot();
    appendJournal(root, { ...bind, event: 'reservation_committed', trialId: id, slotOrdinal: slot.slot });
    appendJournal(root, { ...bind, event: 'trial_started', trialId: id, slotOrdinal: slot.slot });
    ok(acceptedSlots(root).has(id) === false,
      'B: a started trial with no artifact is not accepted');
    ok(unresolvedReservations(root).has(id),
      'B: its liability remains committed — delivery is ambiguous, not proven absent');
    fs.rmSync(root, { recursive: true, force: true });
  }

  // C. artifact committed, process died BEFORE slot_accepted was journalled.
  //    The provider was already paid, so the artifact must be ADOPTED, never
  //    re-run — re-running would spend twice for one slot.
  {
    const root = freshRoot();
    fs.mkdirSync(path.join(root, 'trials'), { recursive: true });
    fs.writeFileSync(path.join(root, 'trials', `${id}.json`), JSON.stringify({
      scoredRunHash: HEADER.runHeaderHash, manifestHash: HEADER.manifestHash,
      sourceCommit: HEADER.repositoryCommit, mode: 'live', armId: slot.armId,
      repetition: slot.repetition, seed: slot.stochasticIdentity,
      ticketReport: { secondReadIdentical: true }
    }));
    appendJournal(root, { ...bind, event: 'reservation_committed', trialId: id, slotOrdinal: slot.slot });
    appendJournal(root, { ...bind, event: 'trial_started', trialId: id, slotOrdinal: slot.slot });
    appendJournal(root, { ...bind, event: 'artifact_committed', trialId: id, slotOrdinal: slot.slot });
    ok(acceptedSlots(root).has(id) === false,
      'C: an artifact without acceptance is not yet in the corpus');
    ok(fs.existsSync(path.join(root, 'trials', `${id}.json`)),
      'C: but the immutable artifact survives, so recovery adopts rather than repeats');
    // Adoption is exactly one acceptance, and a second is impossible.
    appendJournal(root, { ...bind, event: 'slot_accepted', trialId: id,
      slotOrdinal: slot.slot, recoveredArtifact: true });
    ok(acceptedSlots(root).get(id) === 'slot_accepted',
      'C: adoption accepts it once');
    ok(refuses(() => appendJournal(root, { ...bind, event: 'slot_accepted',
      trialId: id, slotOrdinal: slot.slot })) !== null,
    'C: and a second acceptance is refused, so recovery cannot duplicate it');
    fs.rmSync(root, { recursive: true, force: true });
  }

  // D. slot accepted, process died BEFORE advancing to the next slot.
  {
    const root = freshRoot();
    seedCorpus(root, 2);
    const first = trialIdFor(manifest.slots[0]);
    const second = trialIdFor(manifest.slots[1]);
    const third = trialIdFor(manifest.slots[2]);
    ok(acceptedSlots(root).has(first) && acceptedSlots(root).has(second),
      'D: accepted slots survive the crash');
    ok(acceptedSlots(root).has(third) === false,
      'D: the next assigned slot is untouched and still owed');
    ok(refuses(() => appendJournal(root, { ...bind, event: 'slot_accepted',
      trialId: second, slotOrdinal: 2 })) !== null,
    'D: and an accepted slot can never be accepted again on resume');
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`\nevaluation live matrix contract test passed — ${passed} assertions`);
  console.log('EXTERNAL PROVIDER CALLS: 0');
}

main();
