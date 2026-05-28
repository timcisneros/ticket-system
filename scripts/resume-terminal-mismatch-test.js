#!/usr/bin/env node
// Proves a run with terminal events + status=running is NOT resumed.
// Server startup must interrupt (not requeue) it, because
// safeToResumeExecution=false → interruptStaleRunsOnStartup calls interruptAgentRun.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const PORT = 3450;

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, v) { fs.writeFileSync(p, JSON.stringify(v, null, 2)); }
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const file of fs.readdirSync(src)) {
    const s = path.join(src, file);
    const d = path.join(dst, file);
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
    let stdout = '';
    child.stdout.on('data', c => { stdout += c.toString(); });
    child.on('close', code => {
      if (code !== 0) reject(new Error('Fixture generator failed'));
      else {
        const m = stdout.match(/FIXTURE_DIR=(.+)/);
        resolve(m ? m[1].trim() : null);
      }
    });
  });
}

function analyzeDir(dataDir, runId) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.join(ROOT, 'scripts', 'resume-analyzer.js'),
      '--data-dir', dataDir,
      '--run-id', String(runId),
      '--include-terminal'
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', c => { stdout += c.toString(); });
    child.on('close', () => {
      try { resolve(JSON.parse(stdout)); } catch (e) { resolve(null); }
    });
  });
}

function startServer(dataDir, workspaceRoot) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      WORKSPACE_ROOT: workspaceRoot,
      RUNTIME_SCHEDULER_INTERVAL_MS: '200',
      AGENT_MAX_EXECUTION_STEPS: '6',
      RUNTIME_MAX_MODEL_REQUESTS: '6',
      RUNTIME_MAX_WORKSPACE_OPERATIONS: '10',
      OPERC_USERNAME: 'admin',
      OPERC_PASSWORD: 'admin123'
    };
    const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT, env, stdio: ['ignore', 'ignore', 'ignore']
    });
    proc.on('error', reject);
    const deadline = Date.now() + 10000;
    const poll = () => {
      http.get(`http://127.0.0.1:${PORT}/api/health`, (res) => {
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

async function main() {
  const startedAt = Date.now();
  console.log('Test: terminal-reached/running-status does not resume execution');
  console.log('='.repeat(70));

  // 1. Generate clean terminal fixture
  console.log('\n[1] Generating multi-step fixture...');
  const cleanFixture = await generateFixture();
  const manifest = readJson(path.join(cleanFixture, 'manifest.json'));
  const runId = manifest.runId;
  console.log(`    Fixture: ${cleanFixture}`);
  console.log(`    Run: ${runId}, Terminal: ${manifest.expectedTerminalStatus}`);

  // 2. Copy and force status mismatch
  console.log('\n[2] Forcing run.status → running (terminal events intact)...');
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-running-'));
  copyDir(cleanFixture, testDir);
  const runs = readJson(path.join(testDir, 'runs.json'));
  const run = runs.find(r => r.id === runId);
  run.status = 'running';
  delete run.completedAt;
  writeJson(path.join(testDir, 'runs.json'), runs);
  console.log(`    status= running`);

  // Verify terminal event exists
  const raw = fs.readFileSync(path.join(testDir, 'events.jsonl'), 'utf8');
  const hasTerminal = raw.split('\n').some(l => {
    try { const e = JSON.parse(l); return e.runId === runId && (['run.completed','run.failed','run.interrupted','run.terminalized'].includes(e.type)); }
    catch(_) { return false; }
  });
  console.log(`    terminal event present: ${hasTerminal}`);

  // 3. Analyze before server touches it
  console.log('\n[3] Running analyzer (before server)...');
  const report = await analyzeDir(testDir, runId);
  const analysis = report && report.analyses && report.analyses[0];
  if (!analysis) throw new Error('Analyzer returned no result');

  console.log(`    safeToResume (analyzer):  ${analysis.safeToResume}`);
  console.log(`    terminalStateReached:     ${analysis.terminalStateReached}`);
  console.log(`    hashChainIntact:          ${analysis.hashChainIntact}`);

  // 4. Verify: safeToResume is false (analyzer uses old field, should be false for terminal)
  if (analysis.safeToResume !== false) {
    console.log(`    ✗ FAIL: analyzer reports safeToResume=${analysis.safeToResume}, expected false`);
    process.exit(1);
  }
  console.log(`    ✓ analyzer correctly reports safeToResume=false`);

  // 5. Start server — interruptStaleRunsOnStartup runs during boot
  console.log('\n[4] Starting server...');
  let serverProc;
  try {
    serverProc = await startServer(testDir, testDir);
    console.log('    Server started');
  } catch (e) {
    console.log(`    ✗ Server start failed: ${e.message}`);
    process.exit(1);
  }

  // Wait for startup processing to complete
  await sleep(2000);

  // 6. Check run status
  const runsAfter = readJson(path.join(testDir, 'runs.json'));
  const runAfter = runsAfter.find(r => r.id === runId);
  console.log(`\n[5] Run status after boot: ${runAfter ? runAfter.status : 'NOT FOUND'}`);

  let passed = true;
  if (!runAfter) {
    console.log('    ✗ FAIL: run record not found');
    passed = false;
  } else if (runAfter.status === 'interrupted') {
    console.log('    ✓ PASS: status=interrupted (not resumed)');
  } else if (runAfter.status === 'pending') {
    console.log('    ✗ FAIL: status=pending — run WAS requeued (wrong)');
    passed = false;
  } else if (runAfter.status === 'running') {
    console.log('    ✗ FAIL: status=running — run was not processed');
    passed = false;
  } else if (['completed', 'failed'].includes(runAfter.status)) {
    console.log(`    ✓ PASS: status=${runAfter.status} (terminal, not resumed)`);
  } else {
    console.log(`    ✗ FAIL: unexpected status ${runAfter.status}`);
    passed = false;
  }

  // 7. Verify ticket did NOT get a new run
  const tickets = readJson(path.join(testDir, 'tickets.json')) || [];
  const runsList = readJson(path.join(testDir, 'runs.json')) || [];
  const ticketRuns = runsList.filter(r => r.ticketId === manifest.ticketId);
  console.log(`    Runs for ticket: ${ticketRuns.length} (expected 1)`);
  if (ticketRuns.length !== 1) {
    console.log('    ✗ FAIL: extra run was created');
    passed = false;
  }

  // Cleanup
  if (serverProc) { try { serverProc.kill('SIGTERM'); } catch (_) {} }
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(cleanFixture, { recursive: true, force: true }); } catch (_) {}

  console.log(`\n${'='.repeat(70)}`);
  console.log(`Result: ${passed ? 'PASSED' : 'FAILED'}`);
  console.log(`Duration: ${Date.now() - startedAt}ms`);
  process.exit(passed ? 0 : 1);
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
