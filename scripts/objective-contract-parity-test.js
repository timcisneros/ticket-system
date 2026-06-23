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
const { buildObjectiveContract, isReportObjective, getReportRuntimeLimits } = require('../objective-contract.js');

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

// ── Migration guard (v0.1.29): ensure/create folder-list grammar wired to contract ──
const folderBlocklistFragment = 'for|named|called|with|inside|containing|write|file|note|summary|report|then|after|before|into|under';
assert('migration: objective-contract.js is the ensure/create folder-list grammar source',
  contractSrc.includes(folderBlocklistFragment));
assert('migration: server.js no longer duplicates the folder-list parser grammar',
  !serverSrc.includes(folderBlocklistFragment));
assert('migration: objective-contract.js exports parseSimpleFolderListObjective',
  /module\.exports\s*=\s*\{[\s\S]*parseSimpleFolderListObjective[\s\S]*\}/.test(contractSrc));
assert('migration: server.js imports the contract folder parser (aliased)',
  /parseSimpleFolderListObjective:\s*contractParseSimpleFolderListObjective/.test(serverSrc));
assert('migration: parseSimpleFolderListObjective still exists as the compatibility wrapper',
  /function parseSimpleFolderListObjective\s*\(/.test(serverSrc));
assert('migration: parseSimpleFolderListObjective delegates to the contract parser',
  /function parseSimpleFolderListObjective[\s\S]*?contractParseSimpleFolderListObjective\(text, command\)[\s\S]*?\n}/.test(serverSrc));

// Compatibility wrapper output shape (folder list parser): exact historical shape.
const folderParse = require('../objective-contract.js').parseSimpleFolderListObjective;
assert('folder wrapper: ensure folder Reports exists (ensure) -> ["Reports"]',
  JSON.stringify(folderParse('ensure folder Reports exists', 'ensure')) === JSON.stringify(['Reports']));
assert('folder wrapper: create folder Reports (create) -> ["Reports"]',
  JSON.stringify(folderParse('create folder Reports', 'create')) === JSON.stringify(['Reports']));
assert('folder wrapper: create folders a a (create) dedups -> ["a"]',
  JSON.stringify(folderParse('create folders a a', 'create')) === JSON.stringify(['a']));
assert('folder wrapper: unsupported/empty -> null (historical no-match shape)',
  folderParse('Refactor things', 'create') === null && folderParse('', 'ensure') === null);

// ── Migration guard (v0.1.30): single "ensure folder X exists" wired to contract ──
const singleEnsureFragment = '\\bensure folder\\s+([A-Za-z0-9._/-]+)\\s+exists\\b';
assert('migration: objective-contract.js is the single ensure-folder grammar source',
  contractSrc.includes(singleEnsureFragment));
assert('migration: server.js no longer duplicates the single ensure-folder regex',
  !serverSrc.includes(singleEnsureFragment));
assert('migration: buildObviousPostconditionChecks still exists',
  /function buildObviousPostconditionChecks\s*\(/.test(serverSrc));
assert('migration: buildObviousPostconditionChecks delegates the single ensure recognizer to buildObjectiveContract',
  /function buildObviousPostconditionChecks[\s\S]*?buildObjectiveContract\(text\)[\s\S]*?ensure_folder[\s\S]*?\n}/.test(serverSrc));
// Shape preservation: the single-ensure delegation must be scoped to the ensure_folder
// intent, consume only folder_exists postconditions, and produce checks via the
// unchanged addFolderPostconditionChecks helper (which yields { type:'folder', path, satisfied }).
assert('shape: single-ensure delegation is scoped to ensure_folder + folder_exists and routes through addFolderPostconditionChecks',
  /ensureContract\.intent === 'ensure_folder'[\s\S]*?pc\.type === 'folder_exists'[\s\S]*?addFolderPostconditionChecks\(checks, ensureFolderPaths\)/.test(serverSrc));
assert('shape: addFolderPostconditionChecks still produces { type: "folder", path, satisfied }',
  /function addFolderPostconditionChecks[\s\S]*?type:\s*'folder'[\s\S]*?path:\s*folderPath[\s\S]*?satisfied:\s*\(\)[\s\S]*?\n}/.test(serverSrc));
// Contract recognizes the single ensure-folder forms with the historical paths.
{
  const a = buildObjectiveContract('ensure folder Reports exists');
  assert('contract: ensure folder Reports exists -> ensure_folder, folder_exists Reports',
    a.recognized === true && a.intent === 'ensure_folder' && a.targetPath === 'Reports' && hasPostcondition(a, 'folder_exists', 'Reports'));
  const b = buildObjectiveContract('ensure folder report exists');
  assert('contract: ensure folder report exists -> ensure_folder, folder_exists report (single regex, no blocklist)',
    b.recognized === true && b.intent === 'ensure_folder' && hasPostcondition(b, 'folder_exists', 'report'));
  const c = buildObjectiveContract('ensure folders Reports exists');
  assert('contract: ensure folders Reports exists -> ensure_folder, folder_exists Reports (list form)',
    c.recognized === true && c.intent === 'ensure_folder' && hasPostcondition(c, 'folder_exists', 'Reports'));
}

// ── Migration guard (v0.1.31): report detection + report runtime limits wired ──
const reportFragment = 'report|summary|synthesis|overview|analysis|status|audit';
assert('migration: objective-contract.js is the report detection source',
  contractSrc.includes(reportFragment));
// isReportObjective is now a compatibility wrapper that delegates (its body no longer
// carries the keyword regex).
const isReportFnMatch = serverSrc.match(/function isReportObjective[\s\S]*?\n}/);
assert('migration: server.js isReportObjective still exists as the compatibility wrapper',
  !!isReportFnMatch);
assert('migration: server.js isReportObjective no longer duplicates the report regex',
  !!isReportFnMatch && !isReportFnMatch[0].includes(reportFragment));
assert('migration: server.js isReportObjective delegates to the contract',
  !!isReportFnMatch && /contractIsReportObjective\(objective\)/.test(isReportFnMatch[0]));
// getReportRuntimeLimits is now a compatibility wrapper that delegates.
const getLimitsFnMatch = serverSrc.match(/function getReportRuntimeLimits[\s\S]*?\n}/);
assert('migration: server.js getReportRuntimeLimits still exists as the compatibility wrapper',
  !!getLimitsFnMatch);
assert('migration: server.js getReportRuntimeLimits delegates to the contract',
  !!getLimitsFnMatch && /contractGetReportRuntimeLimits\(baseLimits\)/.test(getLimitsFnMatch[0]));
assert('migration: objective-contract.js exports isReportObjective and getReportRuntimeLimits',
  /isReportObjective/.test(contractSrc.slice(contractSrc.indexOf('module.exports'))) &&
  /getReportRuntimeLimits/.test(contractSrc.slice(contractSrc.indexOf('module.exports'))));
// The only remaining report-keyword copy in server.js is detectWorkloadProfile, a
// separate workload-profile classifier intentionally NOT consolidated in this slice.
const serverReportOccurrences = (serverSrc.match(/report\|summary\|synthesis\|overview\|analysis\|status\|audit/g) || []).length;
assert('migration: only the intentionally non-consolidated detectWorkloadProfile copy remains in server.js',
  serverReportOccurrences === 1 && /function detectWorkloadProfile[\s\S]*?report\|summary\|synthesis/.test(serverSrc));

// Report detection behavior matches historical server.js (standalone keyword test,
// case-insensitive, no intent precedence). Legacy reference reproduced inline.
function legacyIsReportObjective(objective) {
  const text = String(objective || '').toLowerCase();
  return /\b(report|summary|synthesis|overview|analysis|status|audit)\b/.test(text);
}
const reportCases = [
  'Write a weekly report', 'make a SUMMARY of X', 'synthesis of findings', 'project overview',
  'do an analysis', 'status update', 'security audit', 'create folder audit-summary',
  'Refactor the auth module', '', null, 'weekly  report'
];
for (const obj of reportCases) {
  assert(`report detection parity: ${JSON.stringify(obj)}`,
    isReportObjective(obj) === legacyIsReportObjective(obj),
    `contract=${isReportObjective(obj)} legacy=${legacyIsReportObjective(obj)}`);
}

// Report runtime limits match historical server.js exactly (caps via Math.min, fixed
// list/read caps, base passthrough). Legacy reference reproduced inline.
function legacyGetReportRuntimeLimits(baseLimits) {
  return {
    ...baseLimits,
    maxExecutionSteps: Math.min(baseLimits.maxExecutionSteps, 12),
    maxModelRequestsPerRun: Math.min(baseLimits.maxModelRequestsPerRun, 8),
    maxListDirectoryPerRun: 3,
    maxReadFilePerRun: 8
  };
}
for (const base of [
  { maxExecutionSteps: 99, maxModelRequestsPerRun: 99, maxListDirectoryPerRun: 99, maxReadFilePerRun: 99, extra: 7 },
  { maxExecutionSteps: 5, maxModelRequestsPerRun: 4, maxListDirectoryPerRun: 1, maxReadFilePerRun: 2 }
]) {
  assert(`report runtime-limit parity: base maxExecutionSteps=${base.maxExecutionSteps}`,
    JSON.stringify(getReportRuntimeLimits(base)) === JSON.stringify(legacyGetReportRuntimeLimits(base)));
}

// ── Closure audit (v0.1.32): the initial v0.1.26 consolidation arc is complete ──
// Source-level facts only (no new runtime behavior). All four objective-semantics
// helper families now delegate to objective-contract.js; no mirrored-grammar drift
// list remains; detectWorkloadProfile stays a separate, non-consolidated helper.
assert('closure: delete extraction wrapper delegates to objective-contract.js',
  /function extractSimpleDeleteTargets[\s\S]*?buildObjectiveContract\(objective\)[\s\S]*?\n}/.test(serverSrc));
assert('closure: folder-list wrapper delegates to objective-contract.js',
  /function parseSimpleFolderListObjective[\s\S]*?contractParseSimpleFolderListObjective\(text, command\)[\s\S]*?\n}/.test(serverSrc));
assert('closure: single ensure-folder recognizer delegates to objective-contract.js',
  /function buildObviousPostconditionChecks[\s\S]*?buildObjectiveContract\(text\)[\s\S]*?ensure_folder[\s\S]*?\n}/.test(serverSrc));
assert('closure: report detection wrapper delegates to objective-contract.js',
  /function isReportObjective[\s\S]*?contractIsReportObjective\(objective\)[\s\S]*?\n}/.test(serverSrc));
assert('closure: report runtime-limit wrapper delegates to objective-contract.js',
  /function getReportRuntimeLimits[\s\S]*?contractGetReportRuntimeLimits\(baseLimits\)[\s\S]*?\n}/.test(serverSrc));
const parityTestSrc = fs.readFileSync(__filename, 'utf8');
assert('closure: no "still mirrored objective-semantics" guard/list remains',
  !/stillMirroredFragments\s*=/.test(parityTestSrc));
// detectWorkloadProfile is intentionally separate: it still carries its own report
// keyword copy in server.js and is NOT one of the consolidated wrappers.
assert('closure: detectWorkloadProfile stays separate (own report-keyword copy, not consolidated)',
  /function detectWorkloadProfile[\s\S]*?report\|summary\|synthesis/.test(serverSrc) &&
  !/function detectWorkloadProfile[\s\S]*?buildObjectiveContract/.test(serverSrc));

console.log('\n' + (failures === 0 ? 'PASS' : 'FAIL') + `: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
