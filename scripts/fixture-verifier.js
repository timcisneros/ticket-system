#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_ROOT || path.join(ROOT, 'workspace-root'));

const args = {};
process.argv.slice(2).forEach(arg => {
  if (arg.startsWith('--')) {
    const [k, v] = arg.slice(2).split('=');
    args[k] = v || true;
  }
});

function loadManifest(fixturePath) {
  const mf = path.join(fixturePath, 'fixture-manifest.json');
  if (!fs.existsSync(mf)) return null;
  return JSON.parse(fs.readFileSync(mf, 'utf8'));
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"') {
      current += '"';
      i++;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  values.push(current.trim());
  return values.map(value => value.replace(/^['"]|['"]$/g, ''));
}

function readCSV(filepath) {
  if (!fs.existsSync(filepath)) return null;
  const content = fs.readFileSync(filepath, 'utf8').trim();
  if (!content) return { headers: [], rows: [] };

  const lines = content.split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase().replace(/["']/g, ''));
  const rows = lines.slice(1).map(line => {
    const vals = parseCsvLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
    return obj;
  });

  return { headers, rows };
}

function sha256File(filepath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filepath)).digest('hex');
}

// ── Legal Intake Verifier ──

function verifyLegalIntake() {
  const fixturePath = path.join(WORKSPACE_ROOT, 'legal-intake');
  const manifest = loadManifest(fixturePath);
  if (!manifest) return fail('No fixture-manifest.json found in legal-intake/');

  const passed = [];
  const failed = [];

  // Check intake-register.csv exists
  const register = readCSV(path.join(fixturePath, 'intake-register.csv'));
  if (!register) {
    failed.push('Missing intake-register.csv');
    return { passed: false, checks: failed.map(f => ({ status: 'fail', message: f })), count: { passed: 0, failed: failed.length } };
  }

  // Check required columns
  const requiredColumns = ['intake_id', 'matter_type', 'requesting_party', 'disposition', 'reason', 'next_action'];
  const missingCols = requiredColumns.filter(c => !register.headers.includes(c));
  if (missingCols.length > 0) {
    failed.push(`Missing columns in CSV: ${missingCols.join(', ')}`);
  } else {
    passed.push('All required columns present');
  }

  // Check all source files are covered in CSV
  const incomingFiles = fs.readdirSync(path.join(fixturePath, 'incoming'))
    .filter(f => f.endsWith('.md'));
  const csvIntakeIds = register.rows.map(r => r.intake_id).filter(Boolean);
  const uncovered = incomingFiles.filter(f => !csvIntakeIds.some(id => f.includes(id)));
  if (uncovered.length > 0) {
    failed.push(`Source files not found in CSV: ${uncovered.join(', ')}`);
  } else {
    passed.push(`All ${incomingFiles.length} source files covered in CSV`);
  }

  // Check matter-summary.md exists
  const summaryPath = path.join(fixturePath, 'matter-summary.md');
  if (!fs.existsSync(summaryPath)) {
    failed.push('Missing matter-summary.md');
  } else {
    const summaryContent = fs.readFileSync(summaryPath, 'utf8');
    if (summaryContent.length < 100) {
      failed.push('matter-summary.md too short (likely insufficient detail)');
    } else {
      passed.push(`matter-summary.md present (${summaryContent.length} chars)`);
    }
  }

  // Compare dispositions against manifest expectations
  const expectedItems = manifest.expectedDecisionSet && Array.isArray(manifest.expectedDecisionSet.files)
    ? manifest.expectedDecisionSet.files
    : (Array.isArray(manifest.files) ? manifest.files.map(item => ({
      intakeId: item.filename ? item.filename.replace(/\.md$/, '') : item.intakeId,
      sourcePath: item.filename ? path.join('legal-intake', 'incoming', item.filename) : item.sourcePath,
      expectedDisposition: item.expectedDisposition,
      acceptableDispositions: item.expectedDisposition ? [item.expectedDisposition] : []
    })) : []);

  let dispositionMatches = 0;
  let dispositionMismatches = 0;
  for (const expected of expectedItems) {
    const expectedId = expected.intakeId || path.basename(expected.sourcePath || '', '.md');
    const match = register.rows.find(r => r.intake_id === expectedId || (r.intake_id && expectedId.includes(r.intake_id)));
    if (!match) {
      dispositionMismatches++;
      failed.push(expectedId + ': missing from intake register');
      continue;
    }
    const acceptable = expected.acceptableDispositions || [expected.expectedDisposition].filter(Boolean);
    if (!acceptable.includes(match.disposition)) {
      dispositionMismatches++;
      failed.push(expectedId + ': expected one of "' + acceptable.join(', ') + '", got "' + (match.disposition || '(missing)') + '"');
    } else {
      dispositionMatches++;
    }
  }

  if (dispositionMismatches === 0) {
    passed.push('All ' + dispositionMatches + ' dispositions match manifest expectations');
  }

  return {
    passed: failed.length === 0,
    checks: [...passed.map(p => ({ status: 'pass', message: p })), ...failed.map(f => ({ status: 'fail', message: f }))],
    count: { passed: passed.length, failed: failed.length }
  };
}

// ── Customer Support Verifier ──

function verifyCustomerSupport() {
  const fixturePath = path.join(WORKSPACE_ROOT, 'support-inbox');
  const manifest = loadManifest(fixturePath);
  if (!manifest) return fail('No fixture-manifest.json found in support-inbox/');

  const passed = [];
  const failed = [];

  // Check triage-plan.md exists
  const triagePath = path.join(fixturePath, '..', 'support-queue', 'triage-plan.md');
  const triageAlt = path.join(WORKSPACE_ROOT, 'support-queue', 'triage-plan.md');
  const triageFile = fs.existsSync(triagePath) ? triagePath :
    fs.existsSync(triageAlt) ? triageAlt : null;

  if (!triageFile) {
    failed.push('Missing support-queue/triage-plan.md');
  } else {
    const content = fs.readFileSync(triageFile, 'utf8');
    passed.push(`triage-plan.md present (${content.length} chars)`);
  }

  // Check escalation-list.md exists (for P1 tickets)
  const escPath = path.join(fixturePath, '..', 'support-queue', 'escalation-list.md');
  const escAlt = path.join(WORKSPACE_ROOT, 'support-queue', 'escalation-list.md');
  const escFile = fs.existsSync(escPath) ? escPath :
    fs.existsSync(escAlt) ? escAlt : null;

  if (!escFile) {
    if (manifest.p1Count > 0) {
      failed.push(`Missing escalation-list.md (${manifest.p1Count} P1 tickets expected escalation)`);
    } else {
      passed.push('No escalation-list.md needed (no P1 tickets)');
    }
  } else {
    const content = fs.readFileSync(escFile, 'utf8');
    passed.push(`escalation-list.md present (${content.length} chars)`);
  }

  // Check coverage in triage plan
  if (triageFile) {
    const content = fs.readFileSync(triageFile, 'utf8').toLowerCase();
    const incomingFiles = fs.readdirSync(fixturePath).filter(f => f.endsWith('.md') && f !== 'fixture-manifest.json');
    const uncovered = incomingFiles.filter(f => {
      const id = f.replace(/\.md$/, '');
      return !content.includes(id);
    });
    if (uncovered.length > 0) {
      failed.push(`Tickets not mentioned in triage plan: ${uncovered.join(', ')}`);
    } else {
      passed.push(`All ${incomingFiles.length} tickets covered in triage plan`);
    }
  }

  return {
    passed: failed.length === 0,
    checks: [...passed.map(p => ({ status: 'pass', message: p })), ...failed.map(f => ({ status: 'fail', message: f }))],
    count: { passed: passed.length, failed: failed.length }
  };
}

// ── Vendor Compliance Verifier ──

function verifyVendorCompliance() {
  const fixturePath = path.join(WORKSPACE_ROOT, 'vendors');
  const manifest = loadManifest(fixturePath);
  if (!manifest) return fail('No fixture-manifest.json found in vendors/');

  const passed = [];
  const failed = [];

  // Check vendor-decision-register.csv exists
  const register = readCSV(path.join(fixturePath, 'vendor-decision-register.csv'));
  if (!register) {
    failed.push('Missing vendor-decision-register.csv');
    return { passed: false, checks: failed, count: { passed: 0, failed: 1 } };
  }

  // Check required columns
  const requiredColumns = ['vendor_id', 'vendor_name', 'disposition', 'reason', 'policy_reference', 'next_action'];
  const missingCols = requiredColumns.filter(c => !register.headers.includes(c));
  if (missingCols.length > 0) {
    failed.push(`Missing columns in CSV: ${missingCols.join(', ')}`);
  } else {
    passed.push('All required columns present');
  }

  // Check compliance-review.md exists
  const reviewPath = path.join(fixturePath, 'compliance-review.md');
  if (!fs.existsSync(reviewPath)) {
    failed.push('Missing compliance-review.md');
  } else {
    const content = fs.readFileSync(reviewPath, 'utf8');
    if (content.length < 200) {
      failed.push('compliance-review.md too short (likely insufficient detail)');
    } else {
      passed.push(`compliance-review.md present (${content.length} chars)`);
    }
  }

  // Compare dispositions against manifest expectations
  const expectedItems = manifest.expectedDecisionSet && Array.isArray(manifest.expectedDecisionSet.files)
    ? manifest.expectedDecisionSet.files
    : (Array.isArray(manifest.files) ? manifest.files : []);
  let checked = 0;
  let matched = 0;
  for (const expected of expectedItems) {
    const match = register.rows.find(r =>
      r.vendor_id === expected.vendorId || r.vendor_name === expected.vendorName
    );
    if (match) {
      checked++;
      const agentDisp = match.disposition ? match.disposition.toLowerCase() : '';
      const expectedDisp = expected.expectedDisposition.toLowerCase();

      if (agentDisp.includes('approve') && expectedDisp.includes('approve') && !expectedDisp.includes('conditional')) {
        matched++;
      } else if (agentDisp.includes('conditional') && expectedDisp.includes('conditional')) {
        matched++;
      } else if (agentDisp.includes('reject') && expectedDisp.includes('reject')) {
        matched++;
      } else {
        failed.push(`${expected.vendorName}: expected "${expected.expectedDisposition}", got "${match.disposition || '(missing)'}"`);
      }
    } else {
      failed.push(`${expected.vendorName}: not found in register`);
    }
  }

  if (checked > 0 && matched === checked) {
    passed.push(`All ${checked} vendor dispositions match expected pattern`);
  }

  if (args.chain) {
    verifyVendorRemediationChain(fixturePath, manifest, register, passed, failed);
  }

  return {
    passed: failed.length === 0,
    checks: [...passed.map(p => ({ status: 'pass', message: p })), ...failed.map(f => ({ status: 'fail', message: f }))],
    count: { passed: passed.length, failed: failed.length }
  };
}

function verifyVendorRemediationChain(fixturePath, manifest, register, passed, failed) {
  const remediationPlanPath = path.join(fixturePath, 'remediation-plan.md');
  if (!fs.existsSync(remediationPlanPath)) {
    failed.push('Missing remediation-plan.md');
  } else {
    const content = fs.readFileSync(remediationPlanPath, 'utf8');
    if (content.length < 200) failed.push('remediation-plan.md too short (likely insufficient detail)');
    else passed.push('remediation-plan.md present (' + content.length + ' chars)');
  }

  const remediationTasks = readCSV(path.join(fixturePath, 'remediation-tasks.csv'));
  if (!remediationTasks) {
    failed.push('Missing remediation-tasks.csv');
    return;
  }

  const requiredColumns = ['vendor_id', 'vendor_name', 'disposition', 'remediation_action', 'due_days', 'owner'];
  const missingColumns = requiredColumns.filter(column => !remediationTasks.headers.includes(column));
  if (missingColumns.length) {
    failed.push('Missing columns in remediation-tasks.csv: ' + missingColumns.join(', '));
  } else {
    passed.push('remediation-tasks.csv has required columns');
  }

  const expectedItems = manifest.expectedDecisionSet && Array.isArray(manifest.expectedDecisionSet.files)
    ? manifest.expectedDecisionSet.files
    : [];
  const expectedRemediation = expectedItems.filter(item =>
    item.expectedDisposition === 'Conditional Approve' || item.expectedDisposition === 'Reject'
  );
  const expectedApprove = expectedItems.filter(item => item.expectedDisposition === 'Approve');
  const rowsByVendorId = new Map(remediationTasks.rows.map(row => [row.vendor_id, row]));

  for (const expected of expectedRemediation) {
    const row = rowsByVendorId.get(expected.vendorId);
    if (!row) {
      failed.push(expected.vendorName + ': missing remediation task');
      continue;
    }
    if (row.disposition !== expected.expectedDisposition) {
      failed.push(expected.vendorName + ': expected remediation disposition ' + expected.expectedDisposition + ', got ' + (row.disposition || '(missing)'));
    }
    const action = String(row.remediation_action || '').toLowerCase();
    if (expected.reasonCode === 'expired_certification' && !action.includes('recert')) {
      failed.push(expected.vendorName + ': expected recertification remediation action');
    }
    if (expected.reasonCode === 'active_incident' && !(action.includes('monitor') || action.includes('incident'))) {
      failed.push(expected.vendorName + ': expected monitoring or incident remediation action');
    }
    if (expected.reasonCode === 'missing_security_certification' && !(action.includes('certification') || action.includes('cert'))) {
      failed.push(expected.vendorName + ': expected security certification remediation action');
    }
    if (expected.reasonCode === 'missing_dpa' && !(action.includes('dpa') || action.includes('data processing'))) {
      failed.push(expected.vendorName + ': expected DPA remediation action');
    }
    if (!row.due_days || !/^\d+$/.test(String(row.due_days))) {
      failed.push(expected.vendorName + ': due_days must be numeric');
    }
    if (!row.owner || row.owner.length < 3) {
      failed.push(expected.vendorName + ': owner missing or too short');
    }
  }

  for (const expected of expectedApprove) {
    if (rowsByVendorId.has(expected.vendorId)) {
      failed.push(expected.vendorName + ': Approve vendor should not have remediation task');
    }
  }

  if (remediationTasks.rows.length !== expectedRemediation.length) {
    failed.push('Expected ' + expectedRemediation.length + ' remediation tasks, found ' + remediationTasks.rows.length);
  } else if (expectedRemediation.length) {
    passed.push('Exact remediation task count matched: ' + expectedRemediation.length);
  }

  const snapshot = readReplaySnapshotFromEnv();
  const requireReplay = process.env.REQUIRE_REPLAY_EVIDENCE === '1' || process.env.REQUIRE_REPLAY_EVIDENCE === 'true';
  if (snapshot) {
    const invocation = (snapshot.workflowInvocation || []).find(item => item.workflowId === 'vendor-remediation-plan');
    if (!invocation) failed.push('Replay missing vendor-remediation-plan workflow invocation');
    else {
      const missing = ['workflowVersion', 'policyId', 'policyVersion', 'policyTextHash', 'verifierContractId', 'verifierContractVersion']
        .filter(key => !invocation[key]);
      if (missing.length) failed.push('Replay vendor remediation invocation missing metadata: ' + missing.join(', '));
      else passed.push('Replay vendor remediation workflow/policy/verifier metadata present');
    }
  } else if (requireReplay) {
    failed.push('Replay evidence required but DATA_DIR/RUN_ID snapshot was not available');
  }
}

// ── Shared Drive Cleanup Verifier ──

function readReplaySnapshotFromEnv() {
  const dataDir = process.env.DATA_DIR;
  const runId = process.env.RUN_ID;
  if (!dataDir || !runId) return null;
  const snapshotPath = path.join(dataDir, 'replay-snapshots', 'run-' + runId + '.json');
  if (!fs.existsSync(snapshotPath)) return null;
  return JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
}

function normalizePathValue(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function verifySharedDrive() {
  const drivePath = path.join(WORKSPACE_ROOT, 'shared-drive');
  const manifest = loadManifest(drivePath);
  if (!manifest) return fail('No fixture-manifest.json found in shared-drive/');

  const passed = [];
  const failed = [];
  const expected = manifest.expectedDecisionSet || {};
  const expectedMutations = Array.isArray(expected.expectedMutations) ? expected.expectedMutations : [];
  const expectedPreserved = Array.isArray(expected.expectedPreserved) ? expected.expectedPreserved : [];
  const expectedFolders = Array.isArray(expected.expectedFolders) ? expected.expectedFolders : [];
  const expectedFiles = Array.isArray(expected.files) ? expected.files : [];

  const reportPath = path.join(drivePath, 'migration-report.md');
  if (!fs.existsSync(reportPath)) {
    failed.push('Missing migration-report.md');
  } else {
    const content = fs.readFileSync(reportPath, 'utf8');
    if (content.length < 200) failed.push('migration-report.md too short (likely insufficient detail)');
    else passed.push('migration-report.md present (' + content.length + ' chars)');
  }

  const logPath = path.join(drivePath, 'cleanup-log.csv');
  const cleanupLog = readCSV(logPath);
  if (!cleanupLog) {
    failed.push('Missing cleanup-log.csv');
  } else {
    const requiredColumns = ['original_path', 'action', 'new_path', 'reason'];
    const missingColumns = requiredColumns.filter(column => !cleanupLog.headers.includes(column));
    if (missingColumns.length) failed.push('Missing columns in cleanup-log.csv: ' + missingColumns.join(', '));
    else passed.push('cleanup-log.csv has required columns');
  }

  for (const folder of expectedFolders) {
    const folderPath = path.join(WORKSPACE_ROOT, folder);
    if (fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory()) {
      passed.push('Expected folder exists: ' + folder);
    } else {
      failed.push('Missing expected folder: ' + folder);
    }
  }

  const logRows = cleanupLog ? cleanupLog.rows : [];
  const expectedByOriginal = new Map(expectedMutations.map(item => [normalizePathValue(item.originalPath), item]));
  const seenExpected = new Set();
  for (const row of logRows) {
    const originalPath = normalizePathValue(row.original_path);
    if (!expectedByOriginal.has(originalPath)) {
      failed.push('Unexpected cleanup-log mutation: ' + originalPath + ' -> ' + normalizePathValue(row.new_path));
      continue;
    }
    const mutation = expectedByOriginal.get(originalPath);
    seenExpected.add(originalPath);
    if (row.action !== mutation.action) {
      failed.push(originalPath + ': expected action ' + mutation.action + ', got ' + (row.action || '(missing)'));
    }
    if (normalizePathValue(row.new_path) !== normalizePathValue(mutation.newPath)) {
      failed.push(originalPath + ': expected new_path ' + mutation.newPath + ', got ' + (row.new_path || '(missing)'));
    }
    if (!row.reason || row.reason.length < 8) {
      failed.push(originalPath + ': cleanup log reason is missing or too short');
    }
  }

  for (const mutation of expectedMutations) {
    const originalPath = normalizePathValue(mutation.originalPath);
    const newPath = normalizePathValue(mutation.newPath);
    if (!seenExpected.has(originalPath)) {
      failed.push('Missing cleanup-log mutation for ' + originalPath);
    }
    const originalAbs = path.join(WORKSPACE_ROOT, originalPath);
    const newAbs = path.join(WORKSPACE_ROOT, newPath);
    if (fs.existsSync(originalAbs)) {
      failed.push('Moved source path still exists: ' + originalPath);
    }
    if (!fs.existsSync(newAbs)) {
      failed.push('Expected moved file missing: ' + newPath);
    } else if (mutation.contentHash && sha256File(newAbs) !== mutation.contentHash) {
      failed.push('Moved file content hash mismatch: ' + newPath);
    }
  }

  for (const preservedPath of expectedPreserved.map(normalizePathValue)) {
    const abs = path.join(WORKSPACE_ROOT, preservedPath);
    if (!fs.existsSync(abs)) {
      failed.push('Preserve/no-action file moved or missing: ' + preservedPath);
      continue;
    }
    const fileRecord = expectedFiles.find(item => normalizePathValue(item.sourcePath) === preservedPath);
    if (fileRecord && fileRecord.contentHash && sha256File(abs) !== fileRecord.contentHash) {
      failed.push('Preserve/no-action file content changed: ' + preservedPath);
    }
  }
  if (expectedPreserved.length) {
    passed.push('Preserve/no-action files checked: ' + expectedPreserved.length);
  }

  if (expectedMutations.length && logRows.length === expectedMutations.length) {
    passed.push('Exact expected mutation count matched: ' + expectedMutations.length);
  } else if (expectedMutations.length || logRows.length) {
    failed.push('Expected ' + expectedMutations.length + ' cleanup-log mutations, found ' + logRows.length);
  }

  const snapshot = readReplaySnapshotFromEnv();
  const requireReplay = process.env.REQUIRE_REPLAY_EVIDENCE === '1' || process.env.REQUIRE_REPLAY_EVIDENCE === 'true';
  if (snapshot) {
    const invocation = (snapshot.workflowInvocation || []).find(item => item.workflowId === 'shared-drive-cleanup');
    if (!invocation) failed.push('Replay missing shared-drive-cleanup workflow invocation');
    else {
      const missing = ['workflowVersion', 'policyId', 'policyVersion', 'policyTextHash', 'verifierContractId', 'verifierContractVersion']
        .filter(key => !invocation[key]);
      if (missing.length) failed.push('Replay workflow invocation missing metadata: ' + missing.join(', '));
      else passed.push('Replay workflow/policy/verifier metadata present');
    }

    const replayRenames = new Set((snapshot.workspaceOperations || [])
      .filter(item => item.operation && item.operation.operation === 'renamePath')
      .map(item => normalizePathValue(item.operation.args && item.operation.args.path) + '->' + normalizePathValue(item.operation.args && item.operation.args.nextPath)));
    let replayRenameMatches = 0;
    for (const mutation of expectedMutations) {
      const key = normalizePathValue(mutation.originalPath) + '->' + normalizePathValue(mutation.newPath);
      if (!replayRenames.has(key)) failed.push('Replay missing renamePath evidence: ' + key);
      else replayRenameMatches++;
    }
    if (expectedMutations.length && replayRenameMatches === expectedMutations.length) {
      passed.push('Replay renamePath evidence checked: ' + expectedMutations.length);
    }

    const replayWrites = new Set((snapshot.workspaceOperations || [])
      .filter(item => item.operation && item.operation.operation === 'writeFile')
      .map(item => normalizePathValue(item.operation.args && item.operation.args.path)));
    for (const artifactPath of ['shared-drive/migration-report.md', 'shared-drive/cleanup-log.csv']) {
      if (!replayWrites.has(artifactPath)) failed.push('Replay missing writeFile evidence: ' + artifactPath);
    }
  } else if (requireReplay) {
    failed.push('Replay evidence required but DATA_DIR/RUN_ID snapshot was not available');
  }

  if (failed.length === 0) {
    passed.push('Shared Drive Cleanup strict verification passed');
  }

  return {
    passed: failed.length === 0,
    checks: [...passed.map(p => ({ status: 'pass', message: p })), ...failed.map(f => ({ status: 'fail', message: f }))],
    count: { passed: passed.length, failed: failed.length }
  };
}

// ── Helpers and Entry Point ──

function fail(msg) {
  return { passed: false, checks: [{ status: 'fail', message: msg }], count: { passed: 0, failed: 1 } };
}

function main() {
  const fixture = args.fixture || 'legal-intake';
  let result;

  switch (fixture) {
    case 'legal-intake':
      result = verifyLegalIntake();
      break;
    case 'customer-support':
      result = verifyCustomerSupport();
      break;
    case 'vendor-compliance':
      result = verifyVendorCompliance();
      break;
    case 'shared-drive':
      result = verifySharedDrive();
      break;
    default:
      console.error(`Unknown fixture: ${fixture}`);
      process.exit(1);
  }

  const summary = result.passed ? 'PASS' : 'FAIL';
  console.log(`${'='.repeat(50)}`);
  console.log(`Fixture Verifier: ${fixture}`);
  console.log(`Result: ${summary}`);
  console.log(`Checks: ${result.count.passed} passed, ${result.count.failed} failed`);
  console.log(`${'='.repeat(50)}`);

  for (const check of result.checks) {
    const icon = check.status === 'pass' ? '  ✓' : '  ✗';
    console.log(`${icon} ${check.message}`);
  }

  process.exit(result.passed ? 0 : 1);
}

main();
