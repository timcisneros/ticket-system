#!/usr/bin/env node
'use strict';

// T2 Tranche 5 — migration-041 SEMANTIC IDENTITY CLOSURE contract test.
//
// F1 invariant: adding or changing a repository-owned semantic dependency of
// migration 041's classification/backfill path must fail this contract until
// the new source is explicitly bound by BOTH:
//   - persistence/postgres/t041-five-state-backfill.js sourceDigests(), and
//   - the Q1 literal table inside migrations/041_ticket_five_state_cutover.sql.
//
// The required set is DERIVED, not asserted: starting from the explicit
// migration semantic roots, this test recursively walks every repository-owned
// RELATIVE require edge (require('./…') / require('../…')) and compares the
// resulting closure against the bound sets on both sides. Node built-ins are
// excluded by construction. The hook deliberately over-binds the full
// file-level closure (including symbol-inert siblings such as declared-work /
// allocation-plan / authority-paths / postcondition-criterion-evaluator), so
// the file-level walk is exactly the right derivation: any NEW relative edge
// anywhere in the closure immediately widens the required set and fails here.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(ROOT, 'persistence', 'postgres', 't041-five-state-backfill.js');
const MIGRATION = path.join(ROOT, 'persistence', 'postgres', 'migrations',
  '041_ticket_five_state_cutover.sql');

// Explicit migration semantic roots: the entry modules whose behavior defines
// what "running 041" means. The walk below closes over everything they reach.
const SEMANTIC_ROOTS = [
  HOOK,
  path.join(ROOT, 'runtime', 'ticket-history-classifier-contract.js')
];

function repoRelativeRequires(file) {
  const text = fs.readFileSync(file, 'utf8');
  const specs = [...text.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)]
    .map(match => match[1]);
  const resolved = [];
  for (const spec of specs) {
    const base = path.resolve(path.dirname(file), spec);
    for (const candidate of [base, `${base}.js`]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        resolved.push(path.normalize(candidate));
        break;
      }
    }
  }
  return resolved;
}

function closure(roots) {
  const seen = new Set();
  const stack = [...roots];
  while (stack.length > 0) {
    const file = path.normalize(stack.pop());
    if (seen.has(file)) continue;
    if (!file.startsWith(ROOT)) continue;
    seen.add(file);
    stack.push(...repoRelativeRequires(file));
  }
  return seen;
}

async function main() {
  let assertions = 0;
  const ok = (condition, message) => {
    assert.ok(condition, message);
    assertions += 1;
    console.log(`  ok ${message}`);
  };

  // ── 1. Derive the required closure. ──────────────────────────────────────
  const required = closure(SEMANTIC_ROOTS);
  const requiredLabels = new Set([...required]
    .map(file => path.basename(file)));
  ok(required.size >= 9,
    `derived closure covers the known semantic family (${required.size} modules)`);
  for (const mustHave of [
    't041-five-state-backfill.js',
    'ticket-history-classifier-contract.js',
    'ticket-blocking-authority-composer.js',
    'ticket-lifecycle-contract.js',
    'ticket-attempt-completion-contract.js',
    'structured-allocation-leaf-run-contract.js',
    'ticket-cancellation-authority-contract.js',
    'ticket-attempt-contract.js',
    'completion-decision-contract.js'
  ]) {
    ok(requiredLabels.has(mustHave), `closure includes ${mustHave}`);
  }

  // ── 2. The hook binds EXACTLY that set, with live digests. ───────────────
  const { sourceDigests } = require('../persistence/postgres/t041-five-state-backfill');
  const bound = sourceDigests();
  const boundByLabel = new Map(bound.map(digest => [digest.label, digest.sha256]));
  ok(bound.length === required.size,
    `hook binds exactly the derived closure (${bound.length} of ${required.size})`);
  for (const label of requiredLabels) {
    ok(boundByLabel.has(label), `hook binds ${label}`);
  }
  for (const digest of bound) {
    const file = [...required].find(candidate =>
      path.basename(candidate) === digest.label);
    ok(Boolean(file), `${digest.label} is a closure member (no invented bindings)`);
    if (file) {
      const actual = require('node:crypto').createHash('sha256')
        .update(fs.readFileSync(file)).digest('hex');
      ok(actual === digest.sha256, `${digest.label} digest matches current bytes`);
    }
  }

  // ── 3. Q1 pins exactly the same labels and digests. ──────────────────────
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const q1 = sql.slice(sql.indexOf('Q1'), sql.indexOf('-- ── Q2'));
  const pinned = new Map([...q1.matchAll(/\('([^']+)',\s*'([0-9a-f]{64})'\)/g)]
    .map(match => [match[1], match[2]]));
  ok(pinned.size === required.size,
    `Q1 pins exactly the derived closure (${pinned.size})`);
  for (const [label, sha] of pinned) {
    ok(boundByLabel.get(label) === sha,
      `Q1 literal for ${label} equals the hook's computed digest`);
  }
  ok(/COUNT\(\*\) FROM t041_identity\) <> (\d+)/.test(q1) &&
    Number(q1.match(/COUNT\(\*\) FROM t041_identity\) <> (\d+)/)[1]) === required.size,
    'the Q1 completeness count equals the derived closure size');

  // ── 4. Mutation-detection proof: a changed byte MUST change its digest. ──
  // Proves the digests are content-bound (not placeholders) without touching
  // repository files: recompute one digest over altered bytes in memory.
  const probe = bound.find(digest => digest.label === 'ticket-attempt-contract.js');
  const probeFile = [...required].find(f => path.basename(f) === probe.label);
  const original = fs.readFileSync(probeFile);
  const mutated = cryptoHash(Buffer.concat([
    Buffer.from('// drift-probe\n'), original]));
  ok(mutated !== probe.sha256,
    'a one-comment change to a bound semantic source alters its identity digest');

  console.log(`\nPASS: migration-041 semantic closure contract — ${assertions} assertions`);
}

function cryptoHash(buffer) {
  return require('node:crypto').createHash('sha256').update(buffer).digest('hex');
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error);
  process.exit(1);
});
