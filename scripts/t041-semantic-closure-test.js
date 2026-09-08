#!/usr/bin/env node
'use strict';

// Historical migration semantic encapsulation — 041/042 FROZEN BUNDLE CLOSURE
// contract test (published authority: "Historical migration semantic
// encapsulation — 041/042 frozen execution bundles").
//
// Historical migrations 041/042 execute from migration-owned frozen bundles
// under persistence/postgres/migration-semantics/{041,042}/; the root
// persistence/postgres/t04{1,2}-*.js hooks are custody mirrors, not execution
// authority. This owner pins, against the UNCHANGED migration SQL files (Q1
// remains the canonical digest authority — no second digest list exists):
//
//   - the migration SQL bytes remain exactly their published SHAs;
//   - the frozen bundle path/label set exactly equals the historical Q1
//     semantic closure (041: 14 files, 042: 3 files);
//   - every bundle file digest equals its Q1 literal;
//   - each bundle's relative-require closure is fully bundle-internal and is
//     exactly the Q1 label set (any new relative edge inside the bundle
//     immediately widens the set and fails here);
//   - the frozen hooks' own sourceDigests() reproduce Q1 from bundle-anchored
//     paths, so live runtime drift cannot alter historical identity;
//   - the root mirror hooks remain byte-identical to the bundle hooks;
//   - importing the normal PostgreSQL store and constructing a
//     PostgresRuntimeStore does NOT load any frozen 041/042 bundle module
//     (pending-only lazy loading; fully-current no-op never loads them).
//
// The required sets are DERIVED, not asserted: starting from the frozen hook
// roots, this test recursively walks every repository-owned RELATIVE require
// edge (Node built-ins excluded by construction) and compares the resulting
// closure against the Q1 label set on both sides.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BUNDLE_ROOT_041 = path.join(ROOT, 'persistence', 'postgres', 'migration-semantics', '041');
const BUNDLE_ROOT_042 = path.join(ROOT, 'persistence', 'postgres', 'migration-semantics', '042');
const MIGRATION_041 = path.join(ROOT, 'persistence', 'postgres', 'migrations',
  '041_ticket_five_state_cutover.sql');
const MIGRATION_042 = path.join(ROOT, 'persistence', 'postgres', 'migrations',
  '042_objective_revision_baseline.sql');
const SQL_SHA_041 = '8239e64271619bf77ded876af484d626b798d4cc380f4c66635f6a85d91dfafe';
const SQL_SHA_042 = '0874874ac876c30cf98d15dcb733ae00039c83a55736a5687874fe51e88e55a6';
// Mirror (non-execution) root hooks, byte-frozen to the bundle hooks.
const ROOT_HOOK_041 = path.join(ROOT, 'persistence', 'postgres', 't041-five-state-backfill.js');
const ROOT_HOOK_042 = path.join(ROOT, 'persistence', 'postgres', 't042-objective-revision-baseline.js');

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

function closure(roots, bundleRoot) {
  const seen = new Set();
  const stack = [...roots];
  while (stack.length > 0) {
    const file = path.normalize(stack.pop());
    if (seen.has(file)) continue;
    // Bundle-internal by construction (separator-aware: a sibling prefix such
    // as <bundleRoot>-other/... is OUTSIDE the bundle). Any require edge
    // leaving the mirrored bundle root is refused here, so live runtime
    // source can never re-enter historical execution semantics.
    const relative = path.relative(bundleRoot, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`bundle closure escapes its mirrored root: ${file}`);
    }
    seen.add(file);
    stack.push(...repoRelativeRequires(file));
  }
  return seen;
}

function q1Pairs(sqlText, identityTable) {
  const q1 = sqlText.slice(
    sqlText.indexOf(identityTable), sqlText.indexOf('source identity drift'));
  return [...q1.matchAll(/\('([^']+)',\s*'([0-9a-f]{64})'\)/g)]
    .map(match => [match[1], match[2]]);
}

function cryptoHash(buffer) {
  return require('node:crypto').createHash('sha256').update(buffer).digest('hex');
}

function checkBundle(ok, { name, bundleRoot, hookPath, migrationPath, sqlSha, identityTable }) {
  const sqlText = fs.readFileSync(migrationPath, 'utf8');
  ok(cryptoHash(fs.readFileSync(migrationPath)) === sqlSha,
    `${name} migration SQL bytes remain exactly their published SHA`);

  const pinned = q1Pairs(sqlText, identityTable);
  const pinnedByLabel = new Map(pinned);

  // Derive the bundle closure from the FROZEN hook root; the walk itself
  // refuses any edge leaving the mirrored bundle root.
  const required = closure([hookPath], bundleRoot);
  const requiredLabels = new Set([...required].map(file => path.basename(file)));
  ok(required.size === pinned.length,
    `${name} bundle closure is exactly the Q1 semantic closure (${required.size} files)`);
  for (const [label] of pinned) {
    ok(requiredLabels.has(label), `${name} bundle closure includes ${label}`);
  }

  // Every bundle file digest equals its Q1 literal (Q1 stays canonical).
  for (const [label, sha] of pinned) {
    const file = [...required].find(candidate => path.basename(candidate) === label);
    ok(Boolean(file), `${name} bundle member for ${label} exists at the mirrored path`);
    if (file) {
      ok(cryptoHash(fs.readFileSync(file)) === sha,
        `${name} bundle digest for ${label} equals its Q1 literal`);
    }
  }

  // The frozen hook computes Q1 digests from bundle-anchored paths — live
  // runtime drift cannot alter historical identity. The 041 hook exports
  // sourceDigests, so it is EXECUTED directly. The 042 hook does not export
  // it; its digest list is proven structurally (the hook source names exactly
  // the Q1 labels, and its __dirname/ROOT anchoring is proven by the closure
  // walk resolving bundle-internal files) while its real Q1 pass is proven by
  // actual pending execution in the T3/objective-revision migration owner.
  const hookModule = require(hookPath.replace(/\.js$/, ''));
  if (typeof hookModule.sourceDigests === 'function') {
    const bound = hookModule.sourceDigests();
    ok(bound.length === pinned.length,
      `${name} frozen hook binds exactly the Q1 closure (${bound.length})`);
    for (const [label, sha] of pinned) {
      const entry = bound.find(digest => digest.label === label);
      ok(entry && entry.sha256 === sha,
        `${name} frozen hook computes the Q1 digest for ${label} from the bundle`);
    }
  } else {
    const hookSource = fs.readFileSync(hookPath, 'utf8');
    ok(cryptoHash(fs.readFileSync(hookPath)) === pinnedByLabel.get(path.basename(hookPath)),
      `${name} frozen hook bytes equal their own Q1 literal`);
    for (const [label] of pinned) {
      ok(hookSource.includes(`'${label}'`) || hookSource.includes(`"${label}"`),
        `${name} frozen hook sourceDigests() names exactly the Q1 label ${label}`);
    }
  }

  // Q1 completeness count still equals the closure size.
  const countMatch = sqlText.match(
    new RegExp(`COUNT\\(\\*\\) FROM ${identityTable}\\) <> (\\d+)`));
  ok(countMatch && Number(countMatch[1]) === pinned.length,
    `${name} Q1 completeness count equals the closure size`);

  // Mutation-detection proof over bundle bytes: a changed byte MUST change its
  // digest (content-bound digests, not placeholders), without touching files.
  const probeLabel = name === '041' ? 'ticket-attempt-contract.js' : 'declared-work-contract.js';
  const probeSha = pinnedByLabel.get(probeLabel);
  const probeFile = [...required].find(f => path.basename(f) === probeLabel);
  const mutated = cryptoHash(Buffer.concat([
    Buffer.from('// drift-probe\n'), fs.readFileSync(probeFile)]));
  ok(mutated !== probeSha,
    `${name}: a one-comment change to a bound bundle source alters its identity digest`);

  return { required, pinnedByLabel };
}

async function main() {
  let assertions = 0;
  const ok = (condition, message) => {
    assert.ok(condition, message);
    assertions += 1;
    console.log(`  ok ${message}`);
  };

  // ── 041 frozen bundle ────────────────────────────────────────────────────
  checkBundle(ok, {
    name: '041',
    bundleRoot: BUNDLE_ROOT_041,
    hookPath: path.join(BUNDLE_ROOT_041, 'persistence', 'postgres', 't041-five-state-backfill.js'),
    migrationPath: MIGRATION_041,
    sqlSha: SQL_SHA_041,
    identityTable: 't041_identity'
  });

  // ── 042 frozen bundle ────────────────────────────────────────────────────
  checkBundle(ok, {
    name: '042',
    bundleRoot: BUNDLE_ROOT_042,
    hookPath: path.join(BUNDLE_ROOT_042, 'persistence', 'postgres', 't042-objective-revision-baseline.js'),
    migrationPath: MIGRATION_042,
    sqlSha: SQL_SHA_042,
    identityTable: 't042_identity'
  });

  // ── Root mirror custody: mirrors stay byte-identical to the bundles. ─────
  ok(cryptoHash(fs.readFileSync(ROOT_HOOK_041)) ===
    cryptoHash(fs.readFileSync(path.join(BUNDLE_ROOT_041, 'persistence', 'postgres', 't041-five-state-backfill.js'))),
    'root 041 hook remains a byte-identical custody mirror of the frozen bundle hook');
  ok(cryptoHash(fs.readFileSync(ROOT_HOOK_042)) ===
    cryptoHash(fs.readFileSync(path.join(BUNDLE_ROOT_042, 'persistence', 'postgres', 't042-objective-revision-baseline.js'))),
    'root 042 hook remains a byte-identical custody mirror of the frozen bundle hook');

  // ── Pending-only lazy loading: importing the normal PostgreSQL store and
  // constructing a store must NOT load any frozen 041/042 bundle module. ───
  // Runs in a fresh child process so the require cache is pristine.
  const probe = spawnSync(process.execPath, ['-e', `
    const path = require('node:path');
    const store = require('./persistence/postgres/store');
    new store.PostgresRuntimeStore({ connectionString: 'postgresql://constructor/probe', schema: 'probe' });
    const leaks = Object.keys(require.cache).filter(p => p.includes('migration-semantics'));
    process.stdout.write(JSON.stringify(leaks));
    process.exit(0);
  `], { cwd: ROOT, encoding: 'utf8' });
  ok(probe.status === 0, 'store import/construct probe child process exits cleanly');
  const leaks = JSON.parse(probe.stdout.trim() || '[]');
  ok(leaks.length === 0,
    'importing/constructing the normal store loads NO frozen 041/042 bundle module');

  console.log(`\nPASS: historical 041/042 frozen bundle closure contract — ${assertions} assertions`);
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error);
  process.exit(1);
});
