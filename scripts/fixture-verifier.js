#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

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

function readCSV(filepath) {
  if (!fs.existsSync(filepath)) return null;
  const content = fs.readFileSync(filepath, 'utf8').trim();
  if (!content) return { headers: [], rows: [] };

  const lines = content.split('\n');
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/["']/g, ''));
  const rows = lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim().replace(/["']/g, ''));
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
    return obj;
  });

  return { headers, rows };
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

  return {
    passed: failed.length === 0,
    checks: [...passed.map(p => ({ status: 'pass', message: p })), ...failed.map(f => ({ status: 'fail', message: f }))],
    count: { passed: passed.length, failed: failed.length }
  };
}

// ── Shared Drive Cleanup Verifier ──

function verifySharedDrive() {
  const drivePath = path.join(WORKSPACE_ROOT, 'shared-drive');
  const manifest = loadManifest(drivePath);
  if (!manifest) return fail('No fixture-manifest.json found in shared-drive/');

  const passed = [];
  const failed = [];

  // 1. Check required artifacts exist
  const artifacts = ['migration-report.md', 'cleanup-log.csv'];
  for (const art of artifacts) {
    const ap = path.join(drivePath, art);
    if (fs.existsSync(ap)) {
      const content = fs.readFileSync(ap, 'utf8');
      passed.push(`Artifact ${art} present (${content.length} chars)`);
    } else {
      failed.push(`Missing artifact: ${art}`);
    }
  }

  // 2. Check required folders exist
  const requiredFolders = ['archive', 'duplicates', 'normalized'];
  for (const folder of requiredFolders) {
    const fp = path.join(drivePath, folder);
    if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) {
      passed.push(`Folder ${folder} created`);
    } else {
      failed.push(`Missing folder: ${folder}`);
    }
  }

  // 3. Check active files were not moved
  const activeFiles = manifest.activeFiles || [];
  let activePreserved = 0;
  let activeMoved = 0;
  for (const af of activeFiles) {
    const fp = path.join(drivePath, af.dir, af.filename);
    if (fs.existsSync(fp)) {
      activePreserved++;
    } else {
      activeMoved++;
    }
  }
  if (activeMoved === 0) {
    passed.push(`All ${activePreserved} active files preserved in place`);
  } else {
    failed.push(`${activeMoved} active files were moved`);
  }

  // 4. Check no files were deleted (compare total count)
  function countAllFiles(dir) {
    let count = 0;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const ep = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!['archive', 'duplicates', 'normalized'].includes(entry.name)) {
            count += countAllFiles(ep);
          }
        } else {
          count++;
        }
      }
    } catch (e) { /* skip unreadable dirs */ }
    return count;
  }

  const originalFileCount = manifest.fileSummary.total;
  const remainingFiles = countAllFiles(drivePath);
  const movedToArchive = fs.existsSync(path.join(drivePath, 'archive'))
    ? fs.readdirSync(path.join(drivePath, 'archive')).filter(f => f !== 'fixture-manifest.json').length : 0;
  const movedToDuplicates = fs.existsSync(path.join(drivePath, 'duplicates'))
    ? fs.readdirSync(path.join(drivePath, 'duplicates')).filter(f => f !== 'fixture-manifest.json').length : 0;
  const movedToNormalized = fs.existsSync(path.join(drivePath, 'normalized'))
    ? fs.readdirSync(path.join(drivePath, 'normalized')).filter(f => f !== 'fixture-manifest.json').length : 0;

  const totalNow = remainingFiles + movedToArchive + movedToDuplicates + movedToNormalized;
  if (totalNow >= originalFileCount - 2) {
    passed.push(`File count preserved: ${originalFileCount} original, ~${totalNow} now (margin: 2)`);
  } else {
    failed.push(`Files may have been deleted: ${originalFileCount} original, ${totalNow} now`);
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
