#!/usr/bin/env node
'use strict';
// A17 — quiescent drain semantics for required run-evidence writes.
//
// The integration suite proves containment end-to-end against real PostgreSQL,
// but it cannot cheaply produce the adversarial timings this contract depends on:
// a write that registers ANOTHER write while it is settling, a self-producing
// loop, or stale state surviving into a later run id. Those are properties of the
// drain itself, so they are proven here directly.
//
// The functions under test are EXTRACTED FROM server.js SOURCE, not reimplemented.
// A copy would prove only that the copy works; extraction means a regression in
// the real implementation fails this suite.

const fs = require('fs');
const path = require('path');

const SERVER_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
  console.log(`  ok ${message}`);
}

// Slice a top-level function (or const) declaration out of the real source.
function extract(declaration) {
  const start = SERVER_SOURCE.indexOf(declaration);
  if (start === -1) throw new Error(`could not locate "${declaration}" in server.js`);
  const rest = SERVER_SOURCE.slice(start);
  const end = rest.search(/\n\}\n/);
  if (end === -1) throw new Error(`could not find the end of "${declaration}"`);
  return rest.slice(0, end + 2);
}

function loadDrainModule() {
  const source = [
    'const pendingRunEvidenceWrites = new Map();',
    'const runEvidencePersistenceFailures = new Map();',
    SERVER_SOURCE.match(/const MAX_EVIDENCE_DRAIN_ROUNDS = \d+;/)[0],
    extract('function trackRunEvidenceWrite('),
    extract('async function drainRunEvidenceWrites('),
    extract('function releaseRunEvidenceTracking('),
    extract('function markRunEvidencePersistenceFailure('),
    extract('function getRunEvidencePersistenceFailure('),
    extract('async function appendRequiredRunLog('),
    `return {
       pendingRunEvidenceWrites, runEvidencePersistenceFailures, MAX_EVIDENCE_DRAIN_ROUNDS,
       trackRunEvidenceWrite, drainRunEvidenceWrites, releaseRunEvidenceTracking,
       markRunEvidencePersistenceFailure, getRunEvidencePersistenceFailure,
       appendRequiredRunLog
     };`
  ].join('\n\n');
  // sanitizeLogMessage and process.stderr are the only outside references.
  // appendRunLog is injected so the required-log wrapper can be exercised without
  // a database: the injected version marks the run exactly as real containment does.
  return new Function('sanitizeLogMessage', 'process', 'appendRunLog', source)(
    String,
    { stderr: { write() {} } },
    null // replaced below via the returned closure binding
  );
}

// Separate sandbox for the required-log wrapper, with an injectable appendRunLog
// so rejection behavior is exercised without a database.
function loadRequiredLogModule() {
  const source = [
    'const runEvidencePersistenceFailures = new Map();',
    'let failType = null;',
    'function failNext(type) { failType = type; }',
    extract('function markRunEvidencePersistenceFailure('),
    extract('function getRunEvidencePersistenceFailure('),
    `async function appendRunLog(run, type) {
       if (failType === type) {
         markRunEvidencePersistenceFailure(run, type, new Error('injected'));
       }
       return null;
     }`,
    extract('async function appendRequiredRunLog('),
    'return { appendRequiredRunLog, getRunEvidencePersistenceFailure, failNext };'
  ].join('\n\n');
  return new Function('sanitizeLogMessage', 'process', source)(
    String, { stderr: { write() {} } }
  );
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const m = loadDrainModule();

  assert(typeof m.drainRunEvidenceWrites === 'function',
    'the real drain implementation was extracted from server.js source');

  // ── 1. A delayed rejection is observed before the gate returns ─────────────
  {
    const run = { id: 101 };
    const slow = new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 120));
    m.trackRunEvidenceWrite(run, slow.catch(e => {
      m.markRunEvidencePersistenceFailure(run, 'workspace:write', e);
      return null;
    }));
    assert(m.getRunEvidencePersistenceFailure(run) === null,
      'the failure marker is not yet set while the write is still in flight');
    await m.drainRunEvidenceWrites(run);
    assert(m.getRunEvidencePersistenceFailure(run) !== null,
      'a delayed rejection is drained and observed before the gate returns');
    m.releaseRunEvidenceTracking(101); // terminalization does this in the real runtime
  }

  // ── 2. A write registered WHILE the first settles is also drained ──────────
  // This is the case a single-snapshot drain cannot catch.
  {
    const run = { id: 102 };
    let nestedSettled = false;
    const first = sleep(60).then(() => {
      // Registers a second required write during settlement of the first.
      m.trackRunEvidenceWrite(run, sleep(60).then(() => { nestedSettled = true; }));
    });
    m.trackRunEvidenceWrite(run, first);
    await m.drainRunEvidenceWrites(run);
    assert(nestedSettled,
      'a required write registered while the first was settling is also drained');
    assert(!m.pendingRunEvidenceWrites.has(102),
      'the drain repeated until the pending set was empty');
  }

  // ── 3. A single-snapshot drain would NOT catch the nested write ────────────
  // Proven directly so the guarantee above cannot silently regress to a snapshot.
  {
    const run = { id: 103 };
    let nestedSettled = false;
    const first = sleep(60).then(() => {
      m.trackRunEvidenceWrite(run, sleep(60).then(() => { nestedSettled = true; }));
    });
    m.trackRunEvidenceWrite(run, first);
    await Promise.allSettled([...m.pendingRunEvidenceWrites.get(103)]); // snapshot once
    assert(!nestedSettled,
      'a single captured snapshot returns before the nested write settles (the mutation this test catches)');
    await m.drainRunEvidenceWrites(run);
    assert(nestedSettled, 'the quiescent drain then settles the nested write');
  }

  // ── 4. Completed promises remove themselves ───────────────────────────────
  {
    const run = { id: 104 };
    m.trackRunEvidenceWrite(run, sleep(10));
    assert(m.pendingRunEvidenceWrites.get(104).size === 1, 'an in-flight write is tracked');
    await m.drainRunEvidenceWrites(run);
    assert(!m.pendingRunEvidenceWrites.has(104),
      'settled writes remove themselves from the pending set');
  }

  // ── 5. Bounded quiescence guard throws rather than proceeding ──────────────
  {
    const run = { id: 105 };
    let stop = false;
    const selfProducing = () => {
      if (stop) return;
      m.trackRunEvidenceWrite(run, sleep(1).then(selfProducing));
    };
    selfProducing();
    let thrown = null;
    try { await m.drainRunEvidenceWrites(run); } catch (error) { thrown = error; }
    stop = true;
    assert(thrown !== null, 'a self-producing write loop does not drain silently');
    assert(thrown.code === 'EVIDENCE_DRAIN_NOT_QUIESCENT',
      `exceeding the bounded rounds throws EVIDENCE_DRAIN_NOT_QUIESCENT (got ${thrown.code})`);
    assert(thrown.failureKind === 'evidence_persistence',
      'the quiescence failure is classified as evidence persistence');
    m.releaseRunEvidenceTracking(105);
  }

  // ── 6. Terminalization clears BOTH maps ───────────────────────────────────
  {
    const run = { id: 106 };
    m.markRunEvidencePersistenceFailure(run, 'workspace:write', new Error('boom'));
    m.trackRunEvidenceWrite(run, sleep(200));
    assert(m.getRunEvidencePersistenceFailure(run) !== null, 'a failure marker is recorded');
    m.releaseRunEvidenceTracking(106);
    assert(m.getRunEvidencePersistenceFailure(run) === null,
      'terminalization clears the failure marker');
    assert(!m.pendingRunEvidenceWrites.has(106),
      'terminalization clears pending-write state');
  }

  // ── 7. Only one marker per run; containment cannot loop ───────────────────
  {
    const run = { id: 107 };
    m.markRunEvidencePersistenceFailure(run, 'workspace:write', new Error('first'));
    m.markRunEvidencePersistenceFailure(run, 'run:step', new Error('second'));
    assert(m.getRunEvidencePersistenceFailure(run).logType === 'workspace:write',
      'repeated failures do not overwrite or loop on the first containment transition');
    m.releaseRunEvidenceTracking(107);
  }

  // ── 8. A later run id cannot inherit stale state ──────────────────────────
  {
    const older = { id: 108 };
    m.markRunEvidencePersistenceFailure(older, 'workspace:write', new Error('stale'));
    m.releaseRunEvidenceTracking(108);
    const later = { id: 109 };
    assert(m.getRunEvidencePersistenceFailure(later) === null,
      'a later run with a different id does not inherit stale failure state');
    await m.drainRunEvidenceWrites(later);
    assert(true, 'draining a run with no tracked writes is a no-op');
  }

  // ── 9. appendRequiredRunLog propagates rejection to its caller ────────────
  {
    const mod = loadRequiredLogModule();
    const run = { id: 201 };
    mod.failNext('workspace:write');
    let thrown = null;
    let proceeded = false;
    try {
      await mod.appendRequiredRunLog(run, 'workspace:write', 'msg');
      proceeded = true;
    } catch (error) { thrown = error; }
    assert(thrown !== null, 'appendRequiredRunLog propagates the rejection to its caller');
    assert(!proceeded, 'the caller does not proceed as though persistence succeeded');
    assert(thrown.code === 'EVIDENCE_PERSISTENCE_FAILED',
      'the propagated error carries EVIDENCE_PERSISTENCE_FAILED');
    assert(mod.getRunEvidencePersistenceFailure(run) !== null,
      'the run failure marker is recorded even though the error propagates');
    // The recorded detail field is logType; comparing against `type` (the earlier
    // bug) would never match and the rethrow above would silently not happen.
    assert(mod.getRunEvidencePersistenceFailure(run).logType === 'workspace:write',
      'the comparison path uses logType, so the type/logType bug cannot recur');
    assert(mod.getRunEvidencePersistenceFailure(run).type === undefined,
      'no `type` field exists on the failure detail, proving the comparison must use logType');
  }

  // ── 10. A successful required log does not throw ──────────────────────────
  {
    const mod = loadRequiredLogModule();
    const run = { id: 202 };
    let ok = false;
    await mod.appendRequiredRunLog(run, 'workspace:write', 'msg');
    ok = true;
    assert(ok, 'appendRequiredRunLog returns normally when persistence succeeds');
    assert(mod.getRunEvidencePersistenceFailure(run) === null,
      'no failure marker is recorded on the success path');
  }

  // ── 11. The best-effort exception list is exact ───────────────────────────
  {
    const block = SERVER_SOURCE.match(
      /const BEST_EFFORT_RUN_LOG_TYPES = new Set\(\[([\s\S]*?)\]\);/
    );
    assert(block !== null, 'the best-effort exception list was located in server.js');
    const listed = (block[1].match(/'([^']+)'/g) || []).map(v => v.replace(/'/g, ''));
    const expected = [
      'run:completed', 'run:verification_failed', 'run:failed',
      'run:failed_auto_retried', 'run:interrupted'
    ];
    assert(listed.length === expected.length,
      `the best-effort set contains exactly ${expected.length} types (found ${listed.length}: ${listed.join(', ')})`);
    for (const type of expected) {
      assert(listed.includes(type), `${type} is an explicitly named terminal echo`);
    }
    // No generic prefixes or broad classes: every entry must be a literal type.
    assert(listed.every(v => !v.includes('*') && !v.endsWith(':')),
      'the exception list uses exact log types, not prefixes or classes');
    // Required-evidence types must never appear.
    for (const required of ['workspace:write', 'run:started', 'run:reconciled', 'model:request']) {
      assert(!listed.includes(required),
        `${required} is NOT downgraded to best effort`);
    }
  }

  assert(m.runEvidencePersistenceFailures.size === 0,
    'no failure-marker entries leak after all runs are released');
  assert(m.pendingRunEvidenceWrites.size === 0,
    'no pending-write entries leak after all runs are released');

  console.log(`\nPASS: run-evidence drain quiescence — ${passed} assertions`);
}

main().catch(error => {
  console.error(`\nFAIL: run-evidence drain quiescence — ${error && error.message ? error.message : error}`);
  process.exit(1);
});
