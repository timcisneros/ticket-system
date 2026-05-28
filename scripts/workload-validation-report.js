#!/usr/bin/env node
// Workload Validation Report — verifies the 5 real ticket classes produced artifacts.
//
// Checks:
// 1. Each expected artifact file exists in the workspace
// 2. Each artifact has non-empty content
// 3. The corresponding run reached terminal status (completed/failed)
// 4. Reports summary stats

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WORKSPACE = path.join(ROOT, 'workspace-root');
const DATA_DIR = path.join(ROOT, 'data');

function readJson(name) {
  const fp = path.join(DATA_DIR, name);
  if (!fs.existsSync(fp)) return [];
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { return []; }
}

function readEvents() {
  const fp = path.join(DATA_DIR, 'events.jsonl');
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch (e) { return null; }
  }).filter(Boolean);
}

function assert(value, msg) {
  if (!value) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function assertFileExists(filePath, description) {
  const fullPath = path.join(WORKSPACE, filePath);
  assert(fs.existsSync(fullPath), `${description} should exist at ${filePath}`);
  const stat = fs.statSync(fullPath);
  assert(stat.size > 0, `${description} should have non-empty content`);
  console.log(`  ✓ ${description}: ${filePath} (${stat.size} bytes)`);
}

// ── Expected artifacts from workload validation ──────────────────
const EXPECTED_ARTIFACTS = [
  { path: 'workspace-status-report.md', description: 'Workspace status report' },
  { path: 'risk-report.md', description: 'Codebase risk report' },
  { path: 'test-diagnosis.md', description: 'Failing-test diagnosis report' },
  { path: 'implementation-recommendation.md', description: 'Implementation recommendation' },
];

const EXPECTED_REFACTOR_PATHS = [
  { path: 'archive/test-a.txt', description: 'Refactored test-a.txt' },
  { path: 'archive/test-b.txt', description: 'Refactored test-b.txt' },
];

// ── Main ─────────────────────────────────────────────────────────
function main() {
  console.log('Workload Validation Report');
  console.log('='.repeat(70));

  const runs = readJson('runs.json');
  const tickets = readJson('tickets.json');
  const events = readEvents();

  // Find the 5 workload validation runs by looking for completed runs that
  // match the workload validation objectives (approximate match on keywords)
  const VALIDATION_KEYWORDS = [
    'workspace-status-report',
    'risk-report',
    'test-diagnosis',
    'implementation-recommendation',
    'archive',
    'test-a.txt',
    'test-b.txt'
  ];
  const validationRuns = runs.filter(r => {
    if (r.status !== 'completed') return false;
    const ticket = tickets.find(t => t.id === r.ticketId);
    if (!ticket) return false;
    const obj = ticket.objective.toLowerCase();
    return VALIDATION_KEYWORDS.some(kw => obj.includes(kw.toLowerCase()));
  });

  console.log(`Found ${validationRuns.length} completed validation runs`);
  console.log();

  // Verify artifacts
  console.log('Artifact Verification:');
  console.log('-'.repeat(70));

  let artifactChecks = 0;
  for (const artifact of EXPECTED_ARTIFACTS) {
    assertFileExists(artifact.path, artifact.description);
    artifactChecks++;
  }
  for (const artifact of EXPECTED_REFACTOR_PATHS) {
    assertFileExists(artifact.path, artifact.description);
    artifactChecks++;
  }

  console.log();

  // Report per-run stats
  console.log('Run Statistics:');
  console.log('-'.repeat(70));

  for (const run of validationRuns.sort((a, b) => a.id - b.id)) {
    const runEvents = events.filter(e => e.runId === run.id);
    const modelRequests = runEvents.filter(e => e.type === 'model:request').length;
    const workspaceOps = runEvents.filter(e => e.type === 'workspace.operation');
    const mutations = workspaceOps.filter(e =>
      ['writeFile', 'createFolder', 'renamePath', 'deletePath'].includes(e.payload && e.payload.operation)
    ).length;
    const phaseViolations = runEvents.filter(e => e.type === 'execution.phase_violation').length;
    const phaseTransitions = runEvents.filter(e => e.type === 'execution.phase_transition').length;
    const ticket = tickets.find(t => t.id === run.ticketId);

    console.log(`  Run #${run.id} (Ticket #${run.ticketId}):`);
    console.log(`    Status:      ${run.status}`);
    console.log(`    Agent:       ${run.agentName}`);
    console.log(`    Phase:       ${run.currentPhase || 'planning'}`);
    console.log(`    Model reqs:  ${modelRequests}`);
    console.log(`    Operations:  ${workspaceOps.length} (${mutations} mutations)`);
    console.log(`    Phase trans: ${phaseTransitions}`);
    console.log(`    Phase viol:  ${phaseViolations}`);
    if (ticket) {
      const objectivePreview = ticket.objective.slice(0, 60).replace(/\n/g, ' ');
      console.log(`    Objective:   ${objectivePreview}...`);
    }
  }

  console.log();

  // Check for commit conflicts in all validation runs
  const histories = readJson('operation-history.json');
  const validationRunIds = new Set(validationRuns.map(r => r.id));
  const validationHistories = histories.filter(h => validationRunIds.has(h.runId));

  const fingerprints = new Set();
  let conflicts = 0;
  for (const h of validationHistories) {
    const key = `${h.runId}:${h.operation}:${JSON.stringify(h.args)}`;
    if (fingerprints.has(key)) {
      conflicts++;
    }
    fingerprints.add(key);
  }

  console.log('Commit Integrity:');
  console.log('-'.repeat(70));
  console.log(`  Total validation mutations: ${validationHistories.length}`);
  console.log(`  Duplicate commits: ${conflicts}`);
  console.log(`  Commit conflicts: ${conflicts === 0 ? 'none' : conflicts + ' found'}`);

  console.log();
  console.log('='.repeat(70));
  console.log(`Validation complete: ${artifactChecks} artifacts verified, ${validationRuns.length} runs analyzed`);

  if (artifactChecks === EXPECTED_ARTIFACTS.length + EXPECTED_REFACTOR_PATHS.length &&
      validationRuns.length >= 5 &&
      conflicts === 0) {
    console.log('Result: PASS');
    process.exit(0);
  } else {
    console.log('Result: FAIL');
    process.exit(1);
  }
}

main();
