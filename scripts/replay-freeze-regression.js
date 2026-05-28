#!/usr/bin/env node
// Replay Freeze Regression Suite
// Verifies golden fixtures are deterministic and pass the verifier.
// Generates fresh fixtures, exports them, runs verifier, asserts clean pass.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function generateFixture(scenario) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(ROOT, 'scripts', 'replay-fixture-generator.js'),
      scenario
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`Fixture generator exited ${code}: ${stderr}`));
        return;
      }
      const match = stdout.match(/FIXTURE_DIR=(.+)/);
      if (!match) {
        reject(new Error('No FIXTURE_DIR in output'));
        return;
      }
      resolve(match[1].trim());
    });
  });
}

function runVerifier(dataDir, runId, mode) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.join(ROOT, 'scripts', 'replay-verifier.js'),
      '--data-dir', dataDir,
      '--run-id', String(runId),
      '--mode', mode
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.on('close', () => {
      try { resolve(JSON.parse(stdout)); } catch (e) { resolve(null); }
    });
  });
}

function exportReplay(dataDir, runId, outputDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(ROOT, 'scripts', 'replay-export.js'),
      '--data-dir', dataDir,
      '--run-id', String(runId),
      '--output', outputDir
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('close', code => {
      if (code !== 0) reject(new Error(`Export failed: ${stderr}`));
      else resolve(outputDir);
    });
  });
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  console.log('Replay Freeze Regression Suite');

  const scenarios = ['simple', 'multiStep'];
  const results = [];

  for (const scenario of scenarios) {
    console.log(`\n--- Scenario: ${scenario} ---`);

    // 1. Generate fixture
    const fixtureDir = await generateFixture(scenario);
    const manifestPath = path.join(fixtureDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const runId = manifest.runId;
    console.log(`  Fixture: ${fixtureDir}`);
    console.log(`  Run: ${runId}, Events: ${manifest.expectedEventCount}, Mutations: ${manifest.expectedMutationCount}`);

    // 2. Verify with strict mode
    const strictResult = await runVerifier(fixtureDir, runId, 'strict');
    const strictPass = strictResult && strictResult.identityPassed && strictResult.failed === 0;
    console.log(`  Strict mode: ${strictPass ? '✓ PASS' : '✗ FAIL'}`);

    // 3. Verify with forensic-diff mode
    const diffResult = await runVerifier(fixtureDir, runId, 'forensic-diff');
    const diffPass = diffResult && diffResult.identityPassed && diffResult.failed === 0;
    console.log(`  Forensic-diff mode: ${diffPass ? '✓ PASS' : '✗ FAIL'}`);

    // 4. Export and re-verify
    const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), `replay-freeze-${scenario}-`));
    await exportReplay(fixtureDir, runId, exportDir);
    console.log(`  Exported to: ${exportDir}`);

    // The export directory has a different structure (no runs.json), so
    // copy the runs.json from the fixture to the export for verification
    fs.copyFileSync(path.join(fixtureDir, 'runs.json'), path.join(exportDir, 'runs.json'));
    fs.mkdirSync(path.join(exportDir, 'replay-snapshots'), { recursive: true });
    fs.copyFileSync(
      path.join(exportDir, 'replay-snapshot.json'),
      path.join(exportDir, 'replay-snapshots', `run-${runId}.json`)
    );

    const exportVerify = await runVerifier(exportDir, runId, 'strict');
    const exportPass = exportVerify && exportVerify.identityPassed && exportVerify.failed === 0;
    console.log(`  Export re-verification: ${exportPass ? '✓ PASS' : '✗ FAIL'}`);

    results.push({
      scenario,
      strictPass,
      diffPass,
      exportPass,
      fixtureDir,
      exportDir,
      manifest
    });

    // Cleanup
    try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(exportDir, { recursive: true, force: true }); } catch (e) {}
  }

  // ── Report ──────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(60)}`);
  console.log('Replay Freeze Regression Results');
  console.log(`${'='.repeat(60)}`);

  let passed = 0;
  let failed = 0;
  for (const r of results) {
    const allPass = r.strictPass && r.diffPass && r.exportPass;
    if (allPass) passed++; else failed++;
    const status = allPass ? '✓ PASS' : '✗ FAIL';
    console.log(`  ${status}: ${r.scenario} (strict=${r.strictPass}, diff=${r.diffPass}, export=${r.exportPass})`);
  }

  console.log(`\nTotal: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
  const durationMs = Date.now() - startedAt;
  console.log(`Duration: ${durationMs}ms`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
