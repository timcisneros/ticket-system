#!/usr/bin/env node
// Reconciliation Flow Test Suite — 4 terminal-reconciliation scenarios.
//
// Scenarios simulate a crash by removing post-terminal events and resetting
// run.status to 'running'. The server's reconciliation path must redo only
// the missing steps and bring the run to a clean terminal state.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const PORT_BASE = 3470;

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, v) { fs.writeFileSync(p, JSON.stringify(v, null, 2)); }
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const s = path.join(src, f), d = path.join(dst, f);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function generateFixture() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(ROOT, 'scripts', 'replay-fixture-generator.js'), 'multiStep'
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let s = '';
    child.stdout.on('data', c => { s += c.toString(); });
    child.on('close', code => {
      if (code !== 0) reject(new Error('Fixture generator failed'));
      else { const m = s.match(/FIXTURE_DIR=(.+)/); resolve(m ? m[1].trim() : null); }
    });
  });
}

function startServer(dataDir, wsRoot, port) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: String(port), DATA_DIR: dataDir, WORKSPACE_ROOT: wsRoot,
      RUNTIME_SCHEDULER_INTERVAL_MS: '200', AGENT_MAX_EXECUTION_STEPS: '6',
      RUNTIME_MAX_MODEL_REQUESTS: '6', RUNTIME_MAX_WORKSPACE_OPERATIONS: '10',
      OPERC_USERNAME: 'admin', OPERC_PASSWORD: 'admin123' };
    const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore','ignore','ignore'] });
    proc.on('error', reject);
    const deadline = Date.now() + 10000;
    const poll = () => {
      http.get(`http://127.0.0.1:${port}/api/health`, res => {
        if (res.statusCode === 200) resolve(proc);
        else if (Date.now() > deadline) reject(new Error('Server timeout'));
        else setTimeout(poll, 200);
      }).on('error', () => {
        if (Date.now() > deadline) reject(new Error('Server timeout'));
        else setTimeout(poll, 200);
      });
    };
    setTimeout(poll, 500);
  });
}

function getRunEvents(dataDir, runId) {
  const raw = fs.readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8');
  return raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch(_) { return null; } }).filter(Boolean).filter(e => e.runId === runId);
}

function getEventTypes(dataDir, runId) {
  return new Set(getRunEvents(dataDir, runId).map(e => e.type));
}

// Keep events of a run only up to (and including) the LAST event of the given type.
// All later events from that run are removed. Events from other runs are preserved.
function truncateRunEventsAt(dataDir, runId, lastTypeToKeep) {
  const raw = fs.readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8');
  const allLines = raw.split('\n').filter(Boolean);
  const runLines = [];
  const otherLines = [];
  for (const line of allLines) {
    try {
      const ev = JSON.parse(line);
      if (ev.runId === runId) runLines.push({ line, ev });
      else otherLines.push(line);
    } catch (_) { otherLines.push(line); }
  }
  // Find last occurrence of target type
  let lastIdx = -1;
  for (let i = 0; i < runLines.length; i++) {
    if (runLines[i].ev.type === lastTypeToKeep) lastIdx = i;
  }
  const keepLines = lastIdx >= 0 ? runLines.slice(0, lastIdx + 1) : runLines;
  const newLines = [...otherLines, ...keepLines.map(x => x.line)];
  fs.writeFileSync(path.join(dataDir, 'events.jsonl'), newLines.join('\n') + '\n');
}

function resetRunToRunning(dataDir, runId) {
  const runs = readJson(path.join(dataDir, 'runs.json'));
  const r = runs.find(x => x.id === runId);
  if (r) {
    r.status = 'running';
    delete r.completedAt;
    delete r.runEvaluation;
    delete r.runConsequence;
    writeJson(path.join(dataDir, 'runs.json'), runs);
  }
}

function setStaleLease(dataDir, runId) {
  const runs = readJson(path.join(dataDir, 'runs.json'));
  const r = runs.find(x => x.id === runId);
  if (r) {
    r.leaseOwner = 'crashed-process:dead-lease';
    r.leaseExpiresAt = new Date(Date.now() - 120000).toISOString();
    writeJson(path.join(dataDir, 'runs.json'), runs);
  }
}

/// ── Scenario builders ──────────────────────────────────────────

function scenario1(dir, runId) {
  truncateRunEventsAt(dir, runId, 'run.snapshot_finalized');
  resetRunToRunning(dir, runId);
  setStaleLease(dir, runId);
}

function scenario2(dir, runId) {
  truncateRunEventsAt(dir, runId, 'run.evaluation_completed');
  resetRunToRunning(dir, runId);
  setStaleLease(dir, runId);
}

function scenario3(dir, runId) {
  // Same as scenario 1: strip to snapshot finalized
  truncateRunEventsAt(dir, runId, 'run.snapshot_finalized');
  resetRunToRunning(dir, runId);
  setStaleLease(dir, runId);
}

function scenario4(dir, runId) {
  // All evidence and projections are intact. Startup must leave them untouched.
}

async function main() {
  const startedAt = Date.now();
  console.log('Reconciliation Flow Test Suite');
  console.log('='.repeat(70));

  // Generate clean fixture once
  console.log('\n[Setup] Generating clean multi-step fixture...');
  const cleanFixture = await generateFixture();
  const manifest = readJson(path.join(cleanFixture, 'manifest.json'));
  const runId = manifest.runId;
  const cleanStatus = manifest.expectedTerminalStatus;
  console.log(`  Fixture: ${cleanFixture}`);
  console.log(`  Run: ${runId}, Terminal: ${cleanStatus}`);

  const scenarios = [
    {
      name: '1-crash-after-terminal-before-consequence',
      desc: 'Crash after snapshot finalized, no evaluation/consequence',
      run: scenario1,
      initialCheck: (types) => !types.has('run.evaluation_completed') && !types.has('run.consequence_recorded'),
      afterCheck: (types) => types.has('run.evaluation_completed') && types.has('run.consequence_recorded'),
      needsSecondStart: false
    },
    {
      name: '2-crash-after-eval-before-consequence',
      desc: 'Crash after run.evaluation_completed, no consequence',
      run: scenario2,
      initialCheck: (types) => types.has('run.evaluation_completed') && !types.has('run.consequence_recorded'),
      afterCheck: (types) => types.has('run.consequence_recorded'),
      needsSecondStart: false
    },
    {
      name: '3-duplicate-reconciliation',
      desc: 'Duplicate startup reconciliation attempts',
      run: scenario3,
      initialCheck: (types) => !types.has('run.evaluation_completed') && !types.has('run.consequence_recorded'),
      afterCheck: (types) => types.has('run.evaluation_completed') && types.has('run.consequence_recorded'),
      needsSecondStart: true
    },
    {
      name: '4-reconciliation-idempotency',
      desc: 'All events and projections present, startup is a no-op',
      run: scenario4,
      initialCheck: (types) => types.has('run.evaluation_completed') && types.has('run.consequence_recorded') && types.has('run.snapshot_finalized'),
      afterCheck: (types, beforeCount, afterCount) => afterCount === beforeCount,
      needsSecondStart: false
    }
  ];

  const results = [];

  for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i];
    const port = PORT_BASE + i;
    console.log(`\n[${s.name}] ${s.desc}`);
    console.log(`  Port: ${port}`);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `reconcile-${i}-`));
    copyDir(cleanFixture, dir);
    s.run(dir, runId);

    const initialTypes = getEventTypes(dir, runId);
    const initialCount = getRunEvents(dir, runId).length;
    console.log(`  Events: ${initialCount}, types: ${[...initialTypes].join(', ') || 'none'}`);

    let pass = true;
    let detail = '';

    if (s.initialCheck && !s.initialCheck(initialTypes)) {
      pass = false;
      detail = 'initial state mismatch';
    }

    if (pass) {
      // Start server
      let serverProc;
      try {
        serverProc = await startServer(dir, dir, port);
      } catch (e) {
        console.log(`  ✗ Server start: ${e.message}`);
        results.push({ name: s.name, pass: false, detail: `server: ${e.message}` });
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
        continue;
      }
      await sleep(2500);

      // Check run status
      const runs = readJson(path.join(dir, 'runs.json'));
      const run = runs.find(x => x.id === runId);
      const finalTypes = getEventTypes(dir, runId);
      const finalCount = getRunEvents(dir, runId).length;

      console.log(`  Status: ${run ? run.status : 'N/A'}`);
      if (!run || !['completed', 'failed', 'interrupted'].includes(run.status)) {
        pass = false;
        detail = `status=${run ? run.status : 'N/A'}, expected terminal`;
      } else {
        detail = `status=${run.status}`;
      }

      // For scenario 4: check idempotency
      if (pass && s.name === '4-reconciliation-idempotency') {
        if (finalCount !== initialCount) {
          pass = false;
          detail += `, events ${initialCount}→${finalCount} (expected unchanged)`;
        } else {
          detail += ', no events added (idempotent)';
        }
      }

      // Check reconciliation produced required events
      if (pass && s.afterCheck) {
        if (s.name === '4-reconciliation-idempotency') {
          if (!s.afterCheck(finalTypes, initialCount, finalCount)) {
            pass = false;
            detail += ', events changed unexpectedly';
          }
        } else if (!s.afterCheck(finalTypes)) {
          pass = false;
          detail += ', missing required post-reconciliation events';
        } else {
          detail += ', events present as expected';
        }
      }

      // Scenario 3: restart server again
      if (pass && s.needsSecondStart) {
        console.log('  [2nd start] Restarting server...');
        try { serverProc.kill('SIGTERM'); } catch (_) {}
        await sleep(500);

        const before2nd = getRunEvents(dir, runId).length;
        try {
          serverProc = await startServer(dir, dir, port + 100);
        } catch (e) {
          console.log(`  ✗ 2nd start: ${e.message}`);
          results.push({ name: s.name, pass: false, detail: `2nd start: ${e.message}` });
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
          continue;
        }
        await sleep(2500);

        const after2nd = getRunEvents(dir, runId).length;
        const runs2 = readJson(path.join(dir, 'runs.json'));
        const run2 = runs2.find(x => x.id === runId);

        console.log(`  [2nd start] Events: ${before2nd} → ${after2nd}, status: ${run2 ? run2.status : 'N/A'}`);

        if (after2nd !== before2nd) {
          pass = false;
          detail += `, 2nd start added ${after2nd - before2nd} events`;
        }
        if (run2 && !['completed', 'failed', 'interrupted'].includes(run2.status)) {
          pass = false;
          detail += `, 2nd start status=${run2.status}`;
        }
      }

      try { serverProc.kill('SIGTERM'); } catch (_) {}
    }

    console.log(`  ${pass ? '✓ PASS' : '✗ FAIL'}: ${detail}`);
    results.push({ name: s.name, pass, detail });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  try { fs.rmSync(cleanFixture, { recursive: true, force: true }); } catch (_) {}

  console.log(`\n${'='.repeat(70)}`);
  console.log('Reconciliation Flow Test Results');
  console.log(`${'='.repeat(70)}`);
  let passed = 0, failed = 0;
  for (const r of results) {
    console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}: ${r.detail}`);
    if (r.pass) passed++; else failed++;
  }
  console.log(`\nTotal: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`Duration: ${Date.now() - startedAt}ms`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err.stack || err.message); process.exit(1); });
