#!/usr/bin/env node
// Deterministic runtime policy test.
// Tests whether a fixed action batch is suppressed under given limits.
// No model calls. Readable and idempotent.

const path = require('path');

// ── Runtime constants (copied from server.js for isolation) ─────────
const AGENT_MUTATING_OPERATIONS = ['createFolder', 'writeFile', 'renamePath', 'deletePath'];

function countMutatingActions(actions) {
  return (actions || []).filter(action =>
    action && typeof action === 'object' && AGENT_MUTATING_OPERATIONS.includes(action.operation)
  ).length;
}

function normalizeActionPathForBundle(value) {
  const normalized = path.posix.normalize(String(value || '').replace(/\\/g, '/').trim()).replace(/^\/+/, '');
  if (!normalized || normalized === '.' || normalized.includes('\0')) return null;
  if (normalized.split('/').some(segment => segment === '..')) return null;
  return normalized;
}

function isAllowedFolderWriteBundle(actions) {
  if (!Array.isArray(actions) || actions.length !== 3) return false;
  const createActions = actions.filter(action => action && action.operation === 'createFolder');
  const writeActions = actions.filter(action => action && action.operation === 'writeFile');
  if (createActions.length !== 1 || writeActions.length !== 2) return false;

  const folderPath = normalizeActionPathForBundle(createActions[0].args && createActions[0].args.path);
  if (!folderPath) return false;
  const folderPrefix = folderPath.endsWith('/') ? folderPath : folderPath + '/';

  return writeActions.every(action => {
    const writePath = normalizeActionPathForBundle(action.args && action.args.path);
    return Boolean(writePath && writePath.startsWith(folderPrefix));
  });
}

// ── Test fixture: exact model plan from Run 165 Step 2 ──────────────
const RUN165_STEP2_ACTIONS = [
  { operation: 'createFolder', args: { path: 'items/A' } },
  { operation: 'renamePath', args: { path: 'items/item-01.txt', nextPath: 'items/A/item-01.txt' } },
  { operation: 'renamePath', args: { path: 'items/item-02.txt', nextPath: 'items/A/item-02.txt' } }
];

const limits = [2, 3];

console.log('========================================');
console.log('Deterministic Runtime Policy Test');
console.log('========================================');
console.log();
console.log('Test fixture: Run 165 Step 2 model plan');
console.log(`  createFolder("items/A")`);
console.log(`  renamePath("items/item-01.txt" → "items/A/item-01.txt")`);
console.log(`  renamePath("items/item-02.txt" → "items/A/item-02.txt")`);
console.log();

const mutatingCount = countMutatingActions(RUN165_STEP2_ACTIONS);
console.log(`Mutating action count: ${mutatingCount}`);
console.log(`isAllowedFolderWriteBundle: ${isAllowedFolderWriteBundle(RUN165_STEP2_ACTIONS)}`);
console.log();

console.log('--- Test Results ---');
for (const limit of limits) {
  const suppressed = mutatingCount > limit && !isAllowedFolderWriteBundle(RUN165_STEP2_ACTIONS);
  console.log(`limit=${limit}: mutatingCount=${mutatingCount} > ${limit} = ${mutatingCount > limit}, bundle=${isAllowedFolderWriteBundle(RUN165_STEP2_ACTIONS)} → ${suppressed ? 'SUPPRESSED' : 'ALLOWED'}`);
}

console.log();
console.log('--- Bundle exception analysis ---');
console.log(`Bundle requires exactly: createFolder + writeFile × 2 into created folder`);
console.log(`Bundle checks: actions.length === 3 : ${RUN165_STEP2_ACTIONS.length === 3}`);
console.log(`Bundle checks: 1 createFolder : ${RUN165_STEP2_ACTIONS.filter(a => a.operation === 'createFolder').length === 1}`);
console.log(`Bundle checks: 2 writeFile   : ${RUN165_STEP2_ACTIONS.filter(a => a.operation === 'writeFile').length === 2}`);
console.log(`Bundle checks: actual ops    : ${RUN165_STEP2_ACTIONS.map(a => a.operation).join(', ')}`);
console.log(`Conclusion: bundle exception does NOT apply because actions use renamePath, not writeFile.`);
