#!/usr/bin/env node
// Lifecycle Invariant Test — enforces the canonical lifecycle event contract.
//
// Invariants checked:
// 1. run.execution_completed alone → isTerminal=false, hasExecutionCompleted=true
// 2. run.snapshot_finalized without run.terminalized → isTerminal=false
// 3. run.evaluation_completed without run.terminalized → isTerminal=false
// 4. run.consequence_recorded without run.terminalized → isTerminal=false
// 5. run.terminalized → isTerminal=true, safeToResume=false

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { sealCurrentRunEventChains } = require('./current-event-fixture');

const ROOT = path.resolve(__dirname, '..');
const ANALYZER = path.join(ROOT, 'scripts', 'resume-analyzer.js');

// ── helpers ───────────────────────────────────────────────────────

function makeEvent(seq, type, payload = {}) {
  return { type, runId: 1, ticketId: 1, seq, ts: new Date().toISOString(), payload };
}

function writeDataDir(dir, events) {
  fs.mkdirSync(dir, { recursive: true });
  const run = {
    id: 1, ticketId: 1, status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify([run], null, 2));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'operation-history.json'), JSON.stringify([], null, 2));
}

function runAnalyzer(dir, runId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ANALYZER, '--data-dir', dir, '--run-id', String(runId)], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.on('close', code => {
      if (code !== 0) return reject(new Error('analyzer exit ' + code));
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
  });
}

function assert(value, msg) {
  if (!value) throw new Error(`ASSERTION FAILED: ${msg}`);
}

// ── test cases ────────────────────────────────────────────────────

async function testCase(name, events, checks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lifecycle-inv-${name}-`));
  try {
    writeDataDir(dir, sealCurrentRunEventChains(events));
    const report = await runAnalyzer(dir, 1);
    const analysis = report.analyses && report.analyses[0];
    if (!analysis) throw new Error(`${name}: no analysis returned`);

    let passed = true;
    const msgs = [];
    for (const [field, expected, desc] of checks) {
      const actual = analysis[field];
      if (actual !== expected) {
        passed = false;
        msgs.push(`${desc}: expected ${expected}, got ${actual}`);
      }
    }

    if (passed) {
      console.log(`  ✓ PASS: ${name}`);
    } else {
      console.log(`  ✗ FAIL: ${name}`);
      for (const m of msgs) console.log(`    ${m}`);
    }

    return { name, passed, analysis };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ── scenarios ─────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  console.log('Lifecycle Invariant Test Suite');
  console.log('=' .repeat(70));

  // Minimal starter events used by every scenario
  const starter = [
    makeEvent(0, 'run.created'),
    makeEvent(1, 'run.started')
  ];

  const results = [];

  // ── Invariant 1: run.execution_completed alone is NOT terminal ──
  results.push(await testCase('execution_completed_not_terminal',
    [...starter, makeEvent(2, 'run.execution_completed')],
    [
      ['isTerminal', false, 'isTerminal'],
      ['hasExecutionCompleted', true, 'hasExecutionCompleted'],
      ['safeToResume', false, 'safeToResume (execution done)']
    ]
  ));

  // ── Invariant 2: run.snapshot_finalized without run.terminalized is NOT terminal ──
  results.push(await testCase('snapshot_finalized_not_terminal',
    [...starter,
      makeEvent(2, 'run.execution_completed'),
      makeEvent(3, 'run.snapshot_finalized')
    ],
    [
      ['isTerminal', false, 'isTerminal'],
      ['safeToResume', false, 'safeToResume (execution done)']
    ]
  ));

  // ── Invariant 3: run.evaluation_completed without run.terminalized is NOT terminal ──
  results.push(await testCase('evaluation_completed_not_terminal',
    [...starter,
      makeEvent(2, 'run.execution_completed'),
      makeEvent(3, 'run.snapshot_finalized'),
      makeEvent(4, 'run.evaluation_completed')
    ],
    [
      ['isTerminal', false, 'isTerminal'],
      ['safeToResume', false, 'safeToResume (execution done)']
    ]
  ));

  // ── Invariant 4: run.consequence_recorded without run.terminalized is NOT terminal ──
  results.push(await testCase('consequence_recorded_not_terminal',
    [...starter,
      makeEvent(2, 'run.execution_completed'),
      makeEvent(3, 'run.snapshot_finalized'),
      makeEvent(4, 'run.evaluation_completed'),
      makeEvent(5, 'run.consequence_recorded')
    ],
    [
      ['isTerminal', false, 'isTerminal'],
      ['safeToResume', false, 'safeToResume (execution done)']
    ]
  ));

  // ── Invariant 5: run.terminalized IS terminal ──
  results.push(await testCase('terminalized_is_terminal',
    [...starter,
      makeEvent(2, 'run.execution_completed'),
      makeEvent(3, 'run.snapshot_finalized'),
      makeEvent(4, 'run.evaluation_completed'),
      makeEvent(5, 'run.consequence_recorded'),
      makeEvent(6, 'run.terminalized', { status: 'completed' })
    ],
    [
      ['isTerminal', true, 'isTerminal'],
      ['safeToResume', false, 'safeToResume (terminal)'],
      ['hasExecutionCompleted', true, 'hasExecutionCompleted']
    ]
  ));

  // ── Report ──────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(70));
  let passed = 0, failed = 0;
  for (const r of results) {
    if (r.passed) passed++; else failed++;
  }
  console.log(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`Duration: ${Date.now() - startedAt}ms`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
