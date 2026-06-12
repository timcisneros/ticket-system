#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SD = path.join(ROOT, 'workspace-root', 'shared-drive');
const INCOMING = path.join(SD, 'incoming');
const MANIFEST_PATH = path.join(SD, 'fixture-manifest.json');

function sha256(filepath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filepath)).digest('hex');
}

function writeFile(fp, content) {
  fs.writeFileSync(fp, content.trim() + '\n');
  console.log('  Wrote', path.relative(SD, fp));
}

// ─── Step 1: Reset workspace ───────────────────────────────────────────────

console.log('[1] Resetting shared-drive workspace...');

// Remove output artifacts
for (const f of ['migration-report.md', 'cleanup-log.csv']) {
  const fp = path.join(SD, f);
  if (fs.existsSync(fp)) { fs.unlinkSync(fp); console.log('  Removed', f); }
}

// Move files back from subdirectories to incoming/
for (const dir of ['archive', 'duplicates', 'normalized']) {
  const dirPath = path.join(SD, dir);
  if (fs.existsSync(dirPath)) {
    for (const f of fs.readdirSync(dirPath)) {
      const src = path.join(dirPath, f);
      const dst = path.join(INCOMING, f);
      fs.renameSync(src, dst);
      console.log('  Restored', dir + '/' + f, '→ incoming/');
    }
    fs.rmdirSync(dirPath);
    console.log('  Removed', dir, 'directory');
  }
}

// Ensure incoming/ exists
if (!fs.existsSync(INCOMING)) fs.mkdirSync(INCOMING, { recursive: true });

// Also restore the already-existing incoming files that we haven't moved
// (they're already there)

// ─── Step 2: Verify all 8 files exist ──────────────────────────────────────

const expectedFiles = [
  'active-roadmap.md',
  'active-support-runbook.md',
  '2024-01-15-retired-launch-plan.md',
  '2024-03-02-old-budget-notes.md',
  'vendor-review.md',
  'vendor-review-copy.md',
  'Team_Status_FINAL.md',
  'reference-checklist.md'
];

for (const f of expectedFiles) {
  const fp = path.join(INCOMING, f);
  if (!fs.existsSync(fp)) {
    console.log('  MISSING:', f, '— creating from backup...');
    // These files might have been lost; recreate them with basic content
  }
}

// ─── Step 3: Replace 3 files with new edge case content ────────────────────

console.log('\n[2] Writing replacement files...');

// Replacement 1: active-roadmap.md → Contradictory Status/Evidence
// Status: active, but project completed Q3 2024, mtime >365d, no references
writeFile(path.join(INCOMING, 'active-roadmap.md'), `# Shared Drive Source File

File ID: active-001
Source Path: shared-drive/incoming/active-roadmap.md
Title: Legacy Integration Roadmap
Business Area: Product
Status: active
Last Modified: 2024-09-15
Active Reference: none
Duplicate Group: none
Canonical File: no
Naming Status: ok
Last Reviewed: 2024-09-15
Owner: Sarah Chen (Product)

Content:
# CRM-Billing Integration — Post-Mortem

## Project Summary
Completed Q3 2024. CRM-to-billing integration went live September 2024.

## Key Outcomes
- Automated invoice generation from CRM opportunities: Deployed.
- Billing sync latency reduced from 24h to 5min: Achieved.
- Error rate < 0.1% for 6+ months: Maintained.

## Post-Launch Notes
No active projects reference this integration roadmap. The integration is stable and fully operational. This document is historical — the integration team has been reassigned.

Status: active (this was the project tracking document; no automated status system).`);

// Replacement 2: 2024-03-02-old-budget-notes.md → Forward-looking stale file
// Status: stale, but content discusses "next fiscal year" and "upcoming initiatives"
writeFile(path.join(INCOMING, '2024-03-02-old-budget-notes.md'), `# Shared Drive Source File

File ID: stale-002
Source Path: shared-drive/incoming/2024-03-02-old-budget-notes.md
Title: FY2025 Budget Planning Notes
Business Area: Finance
Status: stale
Last Modified: 2025-06-15
Active Reference: none
Duplicate Group: none
Canonical File: no
Naming Status: ok
Last Reviewed: 2025-06-15
Owner: Finance Team (former)

Content:
# FY2025 Budget Planning — Draft Notes

## Revenue Projections (Draft)
- Subscription revenue: $12.5M (projected)
- Professional services: $3.2M (projected)
- Total: ~$15.7M

## Headcount Requests
- Engineering: +5 FTE (backend, platform)
- Sales: +3 FTE (enterprise)
- Support: +2 FTE (tier 2)

## Next Fiscal Year Initiatives (Draft)
- Data center migration (estimated $450K)
- SOC2 Type II recertification ($85K)
- New EU region launch ($320K)

## Status Note
This was a draft budget for FY2025. FY2025 has since concluded and FY2026 budget has been finalized. These draft notes were superseded by the approved FY2025 budget. The Finance Team members who authored this have moved to new roles.

Status: stale — historical planning document, replaced by approved budget.`);

// Replacement 3: reference-checklist.md → Orphaned current file
// Status: current, no owner, no references, no active reference
writeFile(path.join(INCOMING, 'reference-checklist.md'), `# Shared Drive Source File

File ID: noaction-001
Source Path: shared-drive/incoming/reference-checklist.md
Title: Infrastructure Migration Worksheet
Business Area: Operations
Status: current
Last Modified: 2026-01-20
Active Reference: none
Duplicate Group: none
Canonical File: no
Naming Status: ok
Last Reviewed: 2026-01-20
Owner: Unassigned (department restructuring)

Content:
# Infrastructure Migration Worksheet

## Server Inventory (Pre-Migration)
- web-01.example.com (active)
- web-02.example.com (active)
- db-01.example.com (active)
- cache-01.example.com (active)
- monitoring.example.com (active)

## Migration Checklist
- [ ] Complete server inventory audit
- [ ] Verify network segmentation requirements
- [ ] Confirm backup strategy for each workload
- [ ] Schedule maintenance windows with stakeholders
- [ ] Test rollback procedures
- [ ] Update DNS records post-migration
- [ ] Decommission old infrastructure

## Notes
Migration was postponed indefinitely in Q1 2026 due to scope changes. This worksheet documents the pre-migration state but no migration is currently active or scheduled. The worksheet owner has not been reassigned following department restructuring.`);

// ─── Step 4: Update mtimes to match Last Modified fields ───────────────────

console.log('\n[3] Setting file modification times...');
const mtimes = {
  'active-roadmap.md': '2024-09-15',
  'active-support-runbook.md': '2026-06-07',
  '2024-01-15-retired-launch-plan.md': '2024-01-15',
  '2024-03-02-old-budget-notes.md': '2025-06-15',
  'vendor-review.md': '2026-06-07',
  'vendor-review-copy.md': '2026-06-07',
  'Team_Status_FINAL.md': '2026-06-07',
  'reference-checklist.md': '2026-01-20'
};
for (const [f, dateStr] of Object.entries(mtimes)) {
  const fp = path.join(INCOMING, f);
  if (fs.existsSync(fp)) {
    const ts = new Date(dateStr + 'T12:00:00Z').getTime() / 1000;
    fs.utimesSync(fp, ts, ts);
  }
}

// ─── Step 5: Read manifest and update ──────────────────────────────────────

console.log('\n[4] Updating fixture manifest...');
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

// Compute content hashes for all files
const hashes = {};
for (const f of expectedFiles) {
  const fp = path.join(INCOMING, f);
  if (fs.existsSync(fp)) {
    hashes[f] = sha256(fp);
  }
}

// Update file entries in expectedDecisionSet.files
const fileEntries = manifest.expectedDecisionSet.files;
for (const entry of fileEntries) {
  const fname = path.basename(entry.sourcePath);

  if (fname === 'active-roadmap.md') {
    entry.expectedAction = 'preserve';
    entry.targetPath = null;
    entry.contentHash = hashes[fname];
    entry.shouldRemainInPlace = true;
    entry.lastModified = '2024-09-15';
    entry.activeReference = 'none';
    entry.owner = 'Sarah Chen (Product)';
    entry.references = null;
    entry.lastReviewed = '2024-09-15';
    entry.bodyPreview = 'CRM-Billing Integration — Post-Mortem';
  }

  if (fname === '2024-03-02-old-budget-notes.md') {
    entry.expectedAction = 'move_to_archive';
    entry.targetPath = 'shared-drive/archive/2024-03-02-old-budget-notes.md';
    entry.contentHash = hashes[fname];
    entry.shouldRemainInPlace = false;
    entry.lastModified = '2025-06-15';
    entry.owner = 'Finance Team (former)';
    entry.references = null;
    entry.lastReviewed = '2025-06-15';
    entry.bodyPreview = 'FY2025 Budget Planning Notes';
  }

  if (fname === 'reference-checklist.md') {
    entry.expectedAction = 'no_action';
    entry.targetPath = null;
    entry.contentHash = hashes[fname];
    entry.shouldRemainInPlace = true;
    entry.lastModified = '2026-01-20';
    entry.activeReference = 'none';
    entry.owner = 'Unassigned (department restructuring)';
    entry.references = null;
    entry.lastReviewed = '2026-01-20';
    entry.bodyPreview = 'Infrastructure Migration Worksheet';
  }
}

// Update expectedMutations (unchanged structure, update content hashes)
for (const mut of manifest.expectedDecisionSet.expectedMutations) {
  const fname = path.basename(mut.originalPath);
  if (hashes[fname]) mut.contentHash = hashes[fname];
}

// Update expectedPreserved
manifest.expectedDecisionSet.expectedPreserved = [
  'shared-drive/incoming/active-roadmap.md',
  'shared-drive/incoming/active-support-runbook.md',
  'shared-drive/incoming/vendor-review.md',
  'shared-drive/incoming/reference-checklist.md'
];

// Update edge case notes
manifest.fixturePolicy.edgeCaseNotes = {
  ...manifest.fixturePolicy.edgeCaseNotes,
  'contradictory_status_vs_evidence': 'active-roadmap.md: Status says "active" but project completed Q3 2024, mtime >365d, no active references. Tests whether model follows explicit Status field over content and mtime signals.',
  'stale_with_forward_looking_content': '2024-03-02-old-budget-notes.md: Status says "stale" but content discusses "next fiscal year" and "upcoming initiatives." Tests whether explicit stale status overrides forward-looking content language.',
  'orphaned_current_file': 'reference-checklist.md: Status says "current" but owner is unassigned, no active references, last reviewed months ago. Tests whether model preserves current-status files despite incomplete ownership metadata.'
};

// Add new edge cases to seededEdgeCases list if not present
const newEcs = ['contradictory_status_vs_evidence', 'stale_with_forward_looking_content', 'orphaned_current_file'];
if (!manifest.fixturePolicy.seededEdgeCases) manifest.fixturePolicy.seededEdgeCases = [];
for (const ec of newEcs) {
  if (!manifest.fixturePolicy.seededEdgeCases.includes(ec)) {
    manifest.fixturePolicy.seededEdgeCases.push(ec);
  }
}

// ─── Write updated manifest ────────────────────────────────────────────────

fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
console.log('  Updated fixture-manifest.json');

// ─── Verifier summary ──────────────────────────────────────────────────────

console.log('\n[5] Expected outcomes:');
console.log('  active-roadmap.md → preserve (contradictory: Status=active, project done)');
console.log('  active-support-runbook.md → preserve (unchanged)');
console.log('  2024-01-15-retired-launch-plan.md → move_to_archive (unchanged)');
console.log('  2024-03-02-old-budget-notes.md → move_to_archive (stale, forward-looking content)');
console.log('  vendor-review.md → preserve (unchanged)');
console.log('  vendor-review-copy.md → move_duplicate (unchanged)');
console.log('  Team_Status_FINAL.md → normalize_name (unchanged)');
console.log('  reference-checklist.md → no_action (orphaned current file)');
console.log('\nReady. Now run: node scripts/run-shared-drive-test.js');
