#!/usr/bin/env node
'use strict';

const { buildObjectiveContractFromCompiled } = require('../objective-contract');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const nested = buildObjectiveContractFromCompiled({
  intent: 'create_folders',
  targetRoot: 'parent/nested',
  targets: ['A', 'B']
});
assert(nested.recognized === true, `Safe nested root was rejected: ${JSON.stringify(nested)}`);
assert(JSON.stringify(nested.allowedMutations) === JSON.stringify([
  { operation: 'createFolder', path: 'parent/nested/A' },
  { operation: 'createFolder', path: 'parent/nested/B' }
]), 'Nested-root mutations were not normalized correctly');

for (const targetRoot of ['../escape', '.hidden', 'safe/../escape', '/absolute']) {
  const contract = buildObjectiveContractFromCompiled({ intent: 'create_folders', targetRoot, targets: ['A'] });
  assert(contract.recognized === false, `Unsafe target root was accepted: ${targetRoot}`);
}

for (const target of ['../escape', '.hidden', 'nested/A', 'A\\B']) {
  const contract = buildObjectiveContractFromCompiled({ intent: 'create_folders', targetRoot: '', targets: [target] });
  assert(contract.recognized === false, `Unsafe target was accepted: ${target}`);
}

for (const incompleteIntent of ['write_files', 'rename_paths']) {
  const contract = buildObjectiveContractFromCompiled({ intent: incompleteIntent, targetRoot: '', targets: ['A'] });
  assert(contract.recognized === false, `Incomplete ${incompleteIntent} schema should fall back to model-driven execution`);
}

const deduped = buildObjectiveContractFromCompiled({
  intent: 'delete_paths',
  targetRoot: 'archive',
  targets: ['A', 'A']
});
assert(deduped.recognized === true && deduped.allowedMutations.length === 1, 'Compiled targets were not deduplicated');

const extraFields = buildObjectiveContractFromCompiled({
  intent: 'create_folders',
  targetRoot: '',
  targets: ['A'],
  explanation: 'ignore this'
});
assert(extraFields.recognized === false, 'Compiled contract with unknown fields was accepted');
assert(extraFields.notes.includes('compiled_contract_unknown_fields'), 'Unknown-field rejection reason was not preserved');

console.log('PASS: objective contract compiler validates exact schema, roots, targets, supported intents, and deduplication');
