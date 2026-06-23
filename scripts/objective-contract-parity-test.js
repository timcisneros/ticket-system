#!/usr/bin/env node
// Objective-contract parity test (test-only, provider-free, side-effect-free).
//
// Verifies buildObjectiveContract() produces the documented contract for each
// currently supported deterministic objective form and returns recognized:false
// for unsupported/free-form objectives. Also includes a drift guard: the regexes
// mirrored into objective-contract.js must still match the source-of-truth literals
// in server.js, so the two cannot silently diverge before the runtime is wired to
// consume the contract.
//
// No server, no workspace, no events, no temp dirs — pure function calls + reading
// two source files as text.

const fs = require('fs');
const path = require('path');
const { buildObjectiveContract } = require('../objective-contract.js');

let failures = 0;
function assert(name, condition, detail) {
  if (condition) { console.log(`  · ${name}: PASS`); }
  else { failures += 1; console.log(`  ✗ ${name}: FAIL${detail ? ' — ' + detail : ''}`); }
  return condition;
}

function hasPostcondition(c, type, p) {
  return Array.isArray(c.postconditions) && c.postconditions.some(x => x && x.type === type && x.path === p);
}
function hasMutation(c, operation, p) {
  return Array.isArray(c.allowedMutations) && c.allowedMutations.some(x => x && x.operation === operation && x.path === p);
}

console.log('Objective-contract parity test');
console.log('='.repeat(60));

// ── Delete forms (exact target identity) ─────────────────────────────
const deleteForms = [
  'Delete CD', 'delete CD', 'delete file CD', 'delete folder CD',
  'delete directory CD', 'delete path CD',
  'Remove CD', 'remove file CD', 'Remove folder CD', 'remove directory CD', 'remove path CD'
];
for (const obj of deleteForms) {
  const c = buildObjectiveContract(obj);
  assert(`delete form "${obj}" → intent delete, target CD`,
    c.recognized === true && c.intent === 'delete' && c.targetPath === 'CD' &&
    hasPostcondition(c, 'path_absent', 'CD') &&
    hasMutation(c, 'deletePath', 'CD') &&
    c.completionPolicy === 'idempotent_if_already_satisfied',
    JSON.stringify(c));
}

// ── ensure folder ─────────────────────────────────────────────────
{
  const c = buildObjectiveContract('ensure folder Reports exists');
  assert('ensure folder Reports exists → ensure_folder + folder_exists Reports',
    c.recognized === true && c.intent === 'ensure_folder' &&
    hasPostcondition(c, 'folder_exists', 'Reports') &&
    c.completionPolicy === 'idempotent_if_already_satisfied',
    JSON.stringify(c));
}

// ── create folder ─────────────────────────────────────────────────
{
  const c = buildObjectiveContract('create folder Reports');
  assert('create folder Reports → create_folder + createFolder + folder_exists Reports',
    c.recognized === true && c.intent === 'create_folder' &&
    hasMutation(c, 'createFolder', 'Reports') &&
    hasPostcondition(c, 'folder_exists', 'Reports'),
    JSON.stringify(c));
}

// ── ensure vs create distinction preserved ─────────────────────────
{
  const ensure = buildObjectiveContract('ensure folder Reports exists');
  const create = buildObjectiveContract('create folder Reports');
  assert('ensure_folder and create_folder remain distinct intents',
    ensure.intent === 'ensure_folder' && create.intent === 'create_folder');
}

// ── report / summary profile ───────────────────────────────────────
{
  const c = buildObjectiveContract('Write a summary report of the workspace');
  assert('report objective → intent report, runtimeProfile report, model_required, no postconditions/mutations',
    c.recognized === true && c.intent === 'report' && c.runtimeProfile === 'report' &&
    c.completionPolicy === 'model_required' &&
    c.postconditions.length === 0 && c.allowedMutations.length === 0,
    JSON.stringify(c));
}

// ── unsupported / free-form ────────────────────────────────────────
{
  const c = buildObjectiveContract('Refactor the auth module and improve coverage');
  assert('unsupported objective → recognized false, model_driven, empty postconditions/mutations',
    c.recognized === false && c.intent === 'model_driven' &&
    c.completionPolicy === 'model_required' &&
    c.postconditions.length === 0 && c.allowedMutations.length === 0,
    JSON.stringify(c));
}
{
  const c = buildObjectiveContract('');
  assert('empty objective → recognized false', c.recognized === false && c.intent === 'model_driven');
}
{
  // multi-target / connective delete must NOT be treated as a simple delete
  const c = buildObjectiveContract('Delete CD and EF');
  assert('"Delete CD and EF" is not a simple delete (recognized false)', c.recognized === false, JSON.stringify(c));
}

// ── source shape sanity ────────────────────────────────────────────
{
  const c = buildObjectiveContract('Delete CD');
  assert('contract carries source=objective-contract and notes array',
    c.source === 'objective-contract' && Array.isArray(c.notes));
}

// ── Migration guard (v0.1.28): delete grammar is wired to the contract ──
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const contractSrc = fs.readFileSync(path.join(__dirname, '..', 'objective-contract.js'), 'utf8');

const deleteFragment = '(?:please\\s+)?(?:delete|remove)\\s+(?:the\\s+)?(?:file|folder|directory|path)?\\s*([A-Za-z0-9._/-]+)\\s*\\.?$';
// The delete grammar now lives ONLY in objective-contract.js; server.js no longer
// carries the duplicated regex and instead delegates through the wrapper.
assert('migration: objective-contract.js remains the delete grammar source',
  contractSrc.includes(deleteFragment));
assert('migration: server.js no longer duplicates the delete regex',
  !serverSrc.includes(deleteFragment));
assert('migration: server.js imports buildObjectiveContract',
  /require\(['"]\.\/objective-contract['"]\)/.test(serverSrc) && /buildObjectiveContract/.test(serverSrc));
assert('migration: extractSimpleDeleteTargets still exists as the compatibility wrapper',
  /function extractSimpleDeleteTargets\s*\(/.test(serverSrc));
assert('migration: extractSimpleDeleteTargets calls buildObjectiveContract',
  /function extractSimpleDeleteTargets[\s\S]*?buildObjectiveContract\(objective\)[\s\S]*?\n}/.test(serverSrc));

// Drift guard for the helpers NOT yet migrated (still mirrored in both files).
const stillMirroredFragments = [
  '\\bensure folder\\s+([A-Za-z0-9._/-]+)\\s+exists\\b',
  '\\b(report|summary|synthesis|overview|analysis|status|audit)\\b'
];
for (const frag of stillMirroredFragments) {
  assert('drift guard (unmigrated): server.js + objective-contract.js share ' + JSON.stringify(frag.slice(0, 24) + '…'),
    serverSrc.includes(frag) && contractSrc.includes(frag),
    `server=${serverSrc.includes(frag)} contract=${contractSrc.includes(frag)}`);
}

console.log('\n' + (failures === 0 ? 'PASS' : 'FAIL') + `: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
