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

console.log('[1] Resetting shared-drive workspace...');

for (const f of ['migration-report.md', 'cleanup-log.csv']) {
  const fp = path.join(SD, f);
  if (fs.existsSync(fp)) { fs.unlinkSync(fp); console.log('  Removed', f); }
}

for (const dir of ['archive', 'duplicates', 'normalized']) {
  const dirPath = path.join(SD, dir);
  if (fs.existsSync(dirPath)) {
    for (const f of fs.readdirSync(dirPath)) {
      const src = path.join(dirPath, f);
      const dst = path.join(INCOMING, f);
      fs.renameSync(src, dst);
      console.log('  Restored', dir + '/' + f);
    }
    fs.rmdirSync(dirPath);
    console.log('  Removed', dir);
  }
}

// Workflow expects Team_Status_FINAL.md, not the normalized team-status.md
if (fs.existsSync(path.join(INCOMING, 'team-status.md')) && !fs.existsSync(path.join(INCOMING, 'Team_Status_FINAL.md'))) {
  fs.renameSync(path.join(INCOMING, 'team-status.md'), path.join(INCOMING, 'Team_Status_FINAL.md'));
  console.log('  Renamed team-status.md → Team_Status_FINAL.md');
}

if (!fs.existsSync(INCOMING)) fs.mkdirSync(INCOMING, { recursive: true });

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
    console.log('  MISSING:', f);
  }
}

console.log('\n[2] Writing replacement files...');

// Replacement 1: active-support-runbook.md → Cross-referenced stale runbook
// File: stale content (mtime >365d) but actively referenced from incident response wiki
writeFile(path.join(INCOMING, 'active-support-runbook.md'), `# Shared Drive Source File

File ID: active-003
Source Path: shared-drive/incoming/active-support-runbook.md
Title: Production Incident Response Runbook (Legacy)
Business Area: Operations
Status: active
Last Modified: 2024-11-20
Active Reference: incident response wiki (linked from runbook-index.md)
Duplicate Group: none
Canonical File: no
Naming Status: ok
Last Reviewed: 2024-11-20
Owner: Mike Torres (Support) — no longer with company

Content:
# Incident Response Runbook — Production Outages

## P1 Outage Response (Legacy — pre-dates current SRE team)
1. Identify affected service via Grafana dashboard (legacy: grafana.internal:3000 — decommissioned).
2. Check status page at status.example.com for known incidents.
3. If database-related, run /scripts/db-health.sh on db-master-01 (server decommissioned Q1 2025).
4. Escalate to on-call engineer via PagerDuty schedule (current schedule uses OpsGenie — migration completed 2025-03).
5. Post-mortem template at /templates/postmortem-template.md (directory restructured 2025-06).

NOTE: This runbook has not been updated since the SRE team reorganization and tooling migration in Q1-Q2 2025. The procedures reference decommissioned servers, deprecated tooling, and an outdated escalation path. However, this file is linked from the current incident response wiki as a "historical reference" for pre-SRE incident patterns. The SRE team maintains the current runbook in Confluence.

## Quick Reference (Outdated)
- DB health: ssh db-master-01 → /scripts/db-health.sh (SERVER DECOMMISSIONED)
- Grafana: grafana.internal:3000 (MIGRATED to grafana.cloud.internal)
- PagerDuty: pd.example.com/escalation (MIGRATED to OpsGenie)
- Slack: #incidents channel (still active — this is correct)

Status: active (historical reference — linked from active documentation).`);

// Replacement 2: vendor-review.md → Truncated canonical with external reference
// File: designated canonical, but content is minimal stub
writeFile(path.join(INCOMING, 'vendor-review.md'), `# Shared Drive Source File

File ID: duplicate-003
Source Path: shared-drive/incoming/vendor-review.md
Title: Vendor Compliance Review — DataGuard Technologies
Business Area: Compliance
Status: current
Last Modified: 2026-03-01
Active Reference: vendor packet index (canonical source)
Duplicate Group: vendor-review
Canonical File: yes
Naming Status: ok
Last Reviewed: 2026-03-01
Owner: Compliance Team (shared mailbox)

Content:
# Vendor Review: DataGuard Technologies

## Status: IN PROGRESS — Full review document located in compliance-shared/vendors/dataguard-2026/

This file is a stub record that serves as the canonical pointer for the vendor-review duplicate group. The actual vendor review document is maintained in the compliance team's shared directory at the path above.

### Key Facts
- Vendor: DataGuard Technologies Inc.
- Review period: Q1 2026
- Review lead: James Chen (Compliance)
- Current status: Pending security questionnaire response

### Notes
The duplicate copy (vendor-review-copy.md) contains a snapshot of the full review from a different date. This stub is the canonical source because it is registered in the compliance system.`);

console.log('\n[3] Setting file modification times...');
const mtimes = {
  'active-roadmap.md': '2024-09-15',
  'active-support-runbook.md': '2024-11-20',
  '2024-01-15-retired-launch-plan.md': '2024-01-15',
  '2024-03-02-old-budget-notes.md': '2025-06-15',
  'vendor-review.md': '2026-03-01',
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

console.log('\n[4] Updating fixture manifest...');
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

const hashes = {};
for (const f of expectedFiles) {
  const fp = path.join(INCOMING, f);
  if (fs.existsSync(fp)) hashes[f] = sha256(fp);
}

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

  if (fname === 'active-support-runbook.md') {
    entry.expectedAction = 'preserve';
    entry.targetPath = null;
    entry.contentHash = hashes[fname];
    entry.shouldRemainInPlace = true;
    entry.lastModified = '2024-11-20';
    entry.activeReference = 'incident response wiki';
    entry.owner = 'Mike Torres (Support)';
    entry.references = 'Linked from incident response wiki runbook-index.md';
    entry.lastReviewed = '2024-11-20';
    entry.bodyPreview = 'Legacy Incident Response Runbook — pre-SRE';
  }

  if (fname === '2024-01-15-retired-launch-plan.md') {
    entry.expectedAction = 'move_to_archive';
    entry.targetPath = 'shared-drive/archive/2024-01-15-retired-launch-plan.md';
    entry.contentHash = hashes[fname];
    entry.shouldRemainInPlace = false;
    entry.lastModified = '2024-01-15';
    entry.owner = 'former-employee@company.example.com (no longer active)';
    entry.references = null;
    entry.lastReviewed = '2024-01-15';
    entry.bodyPreview = 'Launch Plan: Winter 2024 Campaign';
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

  if (fname === 'vendor-review.md') {
    entry.expectedAction = 'preserve';
    entry.targetPath = null;
    entry.contentHash = hashes[fname];
    entry.shouldRemainInPlace = true;
    entry.lastModified = '2026-03-01';
    entry.activeReference = 'vendor packet index';
    entry.owner = 'Compliance Team (shared mailbox)';
    entry.references = 'Active vendor packet index (canonical source)';
    entry.lastReviewed = '2026-03-01';
    entry.bodyPreview = 'Vendor Compliance Review stub — full review elsewhere';
  }

  if (fname === 'vendor-review-copy.md') {
    entry.expectedAction = 'move_duplicate';
    entry.targetPath = 'shared-drive/duplicates/vendor-review-copy.md';
    entry.contentHash = hashes[fname];
    entry.shouldRemainInPlace = false;
    entry.lastModified = '2026-06-07';
    entry.owner = 'Compliance Team';
    entry.references = null;
    entry.lastReviewed = null;
    entry.bodyPreview = 'Vendor Compliance Review: DataGuard Technologies';
  }

  if (fname === 'Team_Status_FINAL.md') {
    entry.expectedAction = 'normalize_name';
    entry.targetPath = 'shared-drive/normalized/team-status.md';
    entry.contentHash = hashes[fname];
    entry.shouldRemainInPlace = false;
    entry.lastModified = '2026-06-07';
    entry.namingStatus = 'needs kebab-case normalization';
    entry.owner = 'Operations Team';
    entry.references = null;
    entry.lastReviewed = '2026-06-07';
    entry.bodyPreview = 'Team Status Report — Sprint 2026-12';
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

for (const mut of manifest.expectedDecisionSet.expectedMutations) {
  const fname = path.basename(mut.originalPath);
  if (hashes[fname]) mut.contentHash = hashes[fname];
}

manifest.expectedDecisionSet.expectedPreserved = [
  'shared-drive/incoming/active-roadmap.md',
  'shared-drive/incoming/active-support-runbook.md',
  'shared-drive/incoming/vendor-review.md',
  'shared-drive/incoming/reference-checklist.md'
];

manifest.fixturePolicy.edgeCaseNotes = {
  ...manifest.fixturePolicy.edgeCaseNotes,
  'cross_referenced_stale_file': 'active-support-runbook.md: Content references decommissioned servers and deprecated tooling (mtime >365d), but actively linked from incident response wiki. Tests whether model preserves files with active external references despite stale content.',
  'truncated_canonical_pointer': 'vendor-review.md: Designated canonical for vendor-review duplicate group, but content is minimal stub that points to full review elsewhere. Tests whether model preserves canonical status despite minimal file content.'
};

const newEcs = ['cross_referenced_stale_file', 'truncated_canonical_pointer'];
for (const ec of newEcs) {
  if (!manifest.fixturePolicy.seededEdgeCases.includes(ec)) {
    manifest.fixturePolicy.seededEdgeCases.push(ec);
  }
}

fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
console.log('  Updated fixture-manifest.json');

console.log('\n[5] Expected outcomes:');
console.log('  active-roadmap.md → preserve (contradictory: Status=active, project done)');
console.log('  active-support-runbook.md → preserve (cross-referenced stale file)');
console.log('  2024-01-15-retired-launch-plan.md → move_to_archive (unchanged)');
console.log('  2024-03-02-old-budget-notes.md → move_to_archive (stale, forward-looking content)');
console.log('  vendor-review.md → preserve (truncated canonical pointer)');
console.log('  vendor-review-copy.md → move_duplicate (unchanged)');
console.log('  Team_Status_FINAL.md → normalize_name (unchanged)');
console.log('  reference-checklist.md → no_action (orphaned current file)');
console.log('\nReady. Run: node scripts/run-shared-drive-test.js');
