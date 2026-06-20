// Release/demo checkpoint runner for the v0.1.x internal-demo baseline.
//
// Runs the documented checkpoint checks sequentially, prints each command before
// running it, and stops on the first failure with a nonzero exit. Failures are
// not swallowed. Requires no external services (some checks start a local
// Fastify server on localhost; that may need normal port-binding permission in
// sandboxed environments). Does not print secrets.
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// Ensure node_modules resolves whether run from the main repo or a detached
// worktree (where node_modules may be a symlink at ./node_modules).
const childEnv = { ...process.env, NODE_PATH: process.env.NODE_PATH || path.join(ROOT, 'node_modules') };

// Each entry: a human-facing command label + the node argv to execute.
const checks = [
  { label: 'node --check server.js', args: ['--check', 'server.js'] },
  ...[
    'catalog-consistency-test.js',
    'page-render-regression-test.js',
    'artifact-prediction-capture-test.js',
    'ticket-feasibility-gate-test.js',
    'moving-goalpost-regression-test.js',
    'complete-flag-truncation-guard-test.js',
    'direct-folder-postcondition-completeness-test.js',
    'debug-reset-contamination-test.js',
    'run-state-inconsistency-warning-test.js',
    'run-detail-evidence-clarity-test.js',
    'run-timeout-attribution-clarity-test.js',
    'ticket-execution-state-clarity-test.js',
    'oquery-cli-parity-test.js',
    'health-live-paths-test.js',
    'no-tracked-provider-keys-test.js'
  ].map(name => ({ label: `NODE_PATH=./node_modules node scripts/${name}`, args: [path.join('scripts', name)] }))
];

console.log(`Release checkpoint: ${checks.length} checks\n`);

let passed = 0;
for (const check of checks) {
  console.log(`\n$ ${check.label}`);
  const result = spawnSync(process.execPath, check.args, { cwd: ROOT, env: childEnv, stdio: 'inherit' });
  if (result.error) {
    console.error(`\nCHECKPOINT FAILED (could not run): ${check.label}\n${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\nCHECKPOINT FAILED: ${check.label} (exit ${result.status})`);
    console.error(`${passed}/${checks.length} checks passed before the failure.`);
    process.exit(result.status || 1);
  }
  passed += 1;
}

console.log(`\nRELEASE CHECKPOINT PASSED: ${passed}/${checks.length} checks`);
