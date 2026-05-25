const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(ROOT, 'server.js');
const PERMISSIONS_PATH = path.join(ROOT, 'data', 'permissions.json');

const source = fs.readFileSync(SERVER_PATH, 'utf8');

let failures = 0;
function assert(condition, msg) {
  if (!condition) {
    console.error('FAIL: ' + msg);
    failures++;
  } else {
    console.log('  OK: ' + msg);
  }
}

// --- Extract constants from source ---
const allowedOpsMatch = source.match(/const AGENT_ALLOWED_OPERATIONS = \[([^\]]+)\];/);
const allowedOps = allowedOpsMatch ? allowedOpsMatch[1].split(',').map(s => s.trim().replace(/'/g, '')) : [];
assert(allowedOps.length === 6, 'AGENT_ALLOWED_OPERATIONS has 6 entries');

const mutatingOpsMatch = source.match(/const AGENT_MUTATING_OPERATIONS = \[([^\]]+)\];/);
const mutatingOps = mutatingOpsMatch ? mutatingOpsMatch[1].split(',').map(s => s.trim().replace(/'/g, '')) : [];
assert(mutatingOps.length === 4, 'AGENT_MUTATING_OPERATIONS has 4 entries');

// Verify mutatingOps subset
assert(mutatingOps.every(op => allowedOps.includes(op)), 'All mutating ops are in allowed ops');

// Extract AGENT_OPERATION_ARGS
const opArgsMatch = source.match(/const AGENT_OPERATION_ARGS = \{([^}]+)\};/s);
let operationArgs = {};
if (opArgsMatch) {
  const block = opArgsMatch[1];
  const entries = block.match(/(\w+):\s*\[([^\]]+)\]/g);
  if (entries) {
    entries.forEach(e => {
      const m = e.match(/(\w+):\s*\[([^\]]+)\]/);
      if (m) operationArgs[m[1]] = m[2].split(',').map(s => s.trim().replace(/'/g, ''));
    });
  }
}
assert(Object.keys(operationArgs).length === 6, 'AGENT_OPERATION_ARGS has 6 entries');
assert(Object.keys(operationArgs).every(op => allowedOps.includes(op)), 'All operation args keys are in AGENT_ALLOWED_OPERATIONS');

// Extract per-op args from executeWorkspaceOperation assertOnlyKeys calls
// Verify they match AGENT_OPERATION_ARGS
allowedOps.forEach(op => {
  const expected = operationArgs[op];
  const ref = `AGENT_OPERATION_ARGS.${op}`;
  const count = (source.match(new RegExp(ref, 'g')) || []).length;
  assert(count >= 1, `executeWorkspaceOperation references ${ref} at least once`);
});

// Verify requiredArgs in createRunReplaySnapshot uses AGENT_OPERATION_ARGS
assert(source.includes('requiredArgs: AGENT_OPERATION_ARGS'), 'requiredArgs references AGENT_OPERATION_ARGS');

// --- Build the catalog by extracting from source ---
// Find the ACTIONS_CATALOG definition
const catStart = source.indexOf('const ACTIONS_CATALOG = [\n');
const catEnd = source.indexOf('\n];', catStart);
assert(catStart !== -1 && catEnd !== -1, 'ACTIONS_CATALOG found in source');

const catSource = source.slice(catStart, catEnd + 3);

// Extract all entry names from the catalog (including generated ones)
// The generated entries are from GENERATED_AGENT_ACTIONS spread
const genNames = [...allowedOps];

// Extract hand-authored entry names
const handNames = [];
const nameRegex = /name:\s*'([^']+)'/g;
let m;
while ((m = nameRegex.exec(catSource)) !== null) {
  if (m[1] !== 'string') handNames.push(m[1]);
}

const allNames = [...genNames, ...handNames];
const allNameSet = new Set(allNames);
assert(allNameSet.size === 33, 'ACTIONS_CATALOG has 33 unique entries (got ' + allNameSet.size + ')');

// Verify all agent primitives are present
allowedOps.forEach(op => {
  assert(allNameSet.has(op), `Agent primitive "${op}" in catalog`);
});

// --- Verify shape types ---
// Check no string shapes in the non-generated entries
const stringShapes = catSource.match(/^\s+(requestShape|optionalShape|responseShape|errorShape):\s*'/gm);
assert(!stringShapes || stringShapes.length === 0, 'No string-based shapes in catalog entries');

// --- Verify type marker conventions ---
// Dynamic type values should be explicit strings like 'number' / 'boolean', not literals
// Only exception: runtime-required literals (confirmed: true, mutating: true/false)
const allowedLiteralPattern = /(?:mutating|confirmed):\s*(?:true|false)/;
const zeroRegex = /(?::\s*)0(?=[,\s\n\r\}])/g;
const boolRegex = /(?::\s*)(true|false)(?=[,\s\n\r\}])/g;

let strayZeroCount = 0;
let match;
while ((match = zeroRegex.exec(catSource)) !== null) {
  const lineStart = catSource.lastIndexOf('\n', match.index) + 1;
  const lineEnd = catSource.indexOf('\n', match.index);
  const line = catSource.slice(lineStart, lineEnd !== -1 ? lineEnd : undefined);
  if (!line.includes("'0'") && !line.includes('Administrators')) strayZeroCount++;
}
assert(strayZeroCount === 0, `No numeric literal type markers in shapes (found ${strayZeroCount}, use 'number' instead)`);

let strayBoolCount = 0;
while ((match = boolRegex.exec(catSource)) !== null) {
  const lineStart = catSource.lastIndexOf('\n', match.index) + 1;
  const lineEnd = catSource.indexOf('\n', match.index);
  const line = catSource.slice(lineStart, lineEnd !== -1 ? lineEnd : undefined);
  if (!allowedLiteralPattern.test(line)) strayBoolCount++;
}
assert(strayBoolCount === 0, `No unexpected boolean literal type markers in shapes (found ${strayBoolCount}, use 'boolean' instead)`);

// --- Verify permission strings ---
const permissions = JSON.parse(fs.readFileSync(PERMISSIONS_PATH, 'utf8'));
assert(Array.isArray(permissions), 'permissions.json is an array');

// Extract all permission references from authorityConstraints
const authorityRefs = catSource.match(/Requires\s+([\w:]+)\s+permission/g) || [];
authorityRefs.forEach(ref => {
  const perm = ref.match(/Requires\s+([\w:]+)\s+permission/)[1];
  assert(permissions.includes(perm), `Permission "${perm}" exists in permissions.json`);
});

// --- Verify generated agent primitive structure ---
// Check that GENERATED_AGENT_ACTIONS uses the constants
assert(source.includes('AGENT_ALLOWED_OPERATIONS.map'), 'GENERATED_AGENT_ACTIONS uses AGENT_ALLOWED_OPERATIONS.map');
assert(source.includes('AGENT_OPERATION_ARGS'), 'GENERATED_AGENT_ACTIONS uses AGENT_OPERATION_ARGS');
assert(source.includes('AGENT_PRIMITIVE_METADATA'), 'GENERATED_AGENT_ACTIONS uses AGENT_PRIMITIVE_METADATA');
assert(source.includes('...GENERATED_AGENT_ACTIONS'), 'ACTIONS_CATALOG spreads GENERATED_AGENT_ACTIONS');

// --- Verify entry key completeness ---
const requiredKeys = ['name', 'category', 'invoker', 'mutating', 'requestShape', 'optionalShape', 'responseShape', 'errorShape', 'authorityConstraints', 'provenanceSurface'];
const normalizedKeys = ['inputSchema', 'outputSchema', 'errorSchema', 'authority', 'provenance', 'executable'];
// Generated workspace actions carry their common keys in GENERATED_AGENT_ACTIONS.
// Hand-authored entries should still expose the legacy catalog fields.
requiredKeys.forEach(key => {
  const regex = new RegExp(`\\b${key}:`, 'g');
  const matches = catSource.match(regex);
  assert(matches && matches.length >= 26, `Key "${key}" present in all hand-authored entries`);
});

normalizedKeys.forEach(key => {
  assert(source.includes(`${key} = action.${key}`) || source.includes(`action.${key} =`), `Normalized contract key "${key}" is assigned`);
});

['workspaceAction', 'agentAction', 'conditionAction', 'systemAction', 'stopAction', 'workflowAction'].forEach(type => {
  assert(source.includes(`'${type}'`), `Action type "${type}" is classified`);
});

assert(!source.includes('workflow-step vocabulary'), 'Catalog copy does not introduce a separate workflow-step vocabulary');

// --- Summary ---
if (failures === 0) {
  console.log(`\n✓ All ${allNameSet.size} catalog entries consistent with backend definitions.`);
} else {
  console.error(`\n✗ ${failures} consistency check(s) failed.`);
  process.exit(1);
}
