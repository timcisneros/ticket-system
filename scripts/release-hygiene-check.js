#!/usr/bin/env node
// Release hygiene check (r1.32) — a small, READ-ONLY git inspection helper. It NEVER mutates git
// state: it does not push, tag, merge, reset, checkout, or write anything. It only runs read-only
// git plumbing and prints a report, so an operator can eyeball release readiness before shipping.
//
// Usage:
//   node scripts/release-hygiene-check.js [tagPattern]
//   (e.g. node scripts/release-hygiene-check.js 'r1.32*')
//
// It is informational: it exits 0 normally and only exits nonzero if git itself cannot be queried.
// It does not gate the build and is not part of the checkpoint.

const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (error) {
    return null;
  }
}

const tagPattern = process.argv[2] || null;
// Backup branches intentionally preserved from a prior reconciliation — they must NOT be part of a
// release. We only OBSERVE them; we never touch them.
const KNOWN_BACKUP_BRANCHES = [
  'backup/local-master-with-foreign-and-r1.28',
  'backup/foreign-stack-before-r1.28',
  'backup/r1.28-commit-caec9a6'
];

const status = git(['status', '--short']);
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
const head = git(['rev-parse', '--short', 'HEAD']);
const headFull = git(['rev-parse', 'HEAD']);
const diffFiles = git(['diff', '--name-only', 'HEAD^', 'HEAD']);

console.log('Release hygiene (read-only):');
console.log(`  branch:        ${branch || '(unknown)'}`);
console.log(`  HEAD:          ${head || '(unknown)'}`);
console.log(`  working tree:  ${status === '' ? 'clean' : 'DIRTY'}`);
if (status) console.log(status.split('\n').map(l => `    ${l}`).join('\n'));
console.log('  HEAD^..HEAD files:');
console.log((diffFiles || '(none)').split('\n').map(l => `    ${l}`).join('\n'));

if (tagPattern) {
  const tags = git(['tag', '--list', tagPattern]);
  console.log(`  tags matching ${tagPattern}: ${tags ? tags.replace(/\n/g, ', ') : '(none)'}`);
}

// Observe (do not modify) backup-branch isolation: warn if any known backup branch commit is an
// ancestor of HEAD, which would mean preserved foreign work leaked into the release line.
const leaked = [];
for (const b of KNOWN_BACKUP_BRANCHES) {
  const exists = git(['rev-parse', '--verify', '--quiet', b]);
  if (!exists) continue;
  // Is HEAD an ancestor-descendant of this backup's tip? (merge-base --is-ancestor backup HEAD)
  let isAncestor = false;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', b, 'HEAD'], { cwd: ROOT });
    isAncestor = true;
  } catch (_) { isAncestor = false; }
  if (isAncestor) leaked.push(b);
}
if (leaked.length > 0) {
  console.log(`  WARNING: backup branch(es) appear merged into HEAD: ${leaked.join(', ')}`);
} else {
  console.log('  backup branches: isolated (not ancestors of HEAD)');
}

// Informational only — always exit 0 unless git itself was unavailable.
if (branch === null && head === null) {
  console.error('release hygiene: git unavailable');
  process.exit(2);
}
