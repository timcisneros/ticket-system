#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INCOMING = path.join(ROOT, 'workspace-root', 'legal-intake', 'incoming');
const MANIFEST_PATH = path.join(ROOT, 'workspace-root', 'legal-intake', 'fixture-manifest.json');

function writeFile(fp, content) {
  fs.writeFileSync(fp, content.trim() + '\n');
  console.log('  Wrote', path.relative(path.join(ROOT, 'workspace-root'), fp));
}

// ─── Remove stale output artifacts ─────────────────────────────────────────

for (const f of ['intake-register.csv', 'matter-summary.md']) {
  const fp = path.join(ROOT, 'workspace-root', 'legal-intake', f);
  if (fs.existsSync(fp)) { fs.unlinkSync(fp); console.log('  Removed', f); }
}

// ─── Replacement intakes ───────────────────────────────────────────────────

// Replace intake-2026-001: Contradictory Evidence (EU data, no jurisdiction)
writeFile(path.join(INCOMING, 'intake-2026-001.md'), `# Legal Intake Form

## Intake ID
intake-2026-001

## Matter Type
Contract Review

## Requesting Party
Acme Corporation

## Contact Email
legal@acme.example.com

## Jurisdiction
Not specified

## Business Unit
Sales

## Description
Review data processing agreement renewal with Northwind Cloud Services. The agreement covers EU customer data processing and requires GDPR compliance assessment. Data transfers between US and EU entities need Standard Contractual Clauses verification. Acme needs legal review before the renewal deadline of next month. Existing agreement expires in 45 days.

## Urgency
Standard

## Duplicate Group`);

// Replace intake-2026-004: Acquisition Legacy Contract
writeFile(path.join(INCOMING, 'intake-2026-004.md'), `# Legal Intake Form

## Intake ID
intake-2026-004

## Matter Type
Contract Review

## Requesting Party
Epsilon Health (acquired by Omega Healthcare Group)

## Contact Email
legal@epsilon.example.com

## Jurisdiction
California, USA

## Business Unit
Legal

## Description
Review customer contracts of Epsilon Health following acquisition by Omega Healthcare Group in Q1 2026. Epsilon Health continues to operate as a separate legal entity but contracts need review for assignment clauses, change-of-control provisions, and continuity of service obligations. Approximately 12 enterprise customer contracts need assessment. All pre-acquisition contracts were signed under Epsilon Health's legal name.

## Urgency
Standard

## Duplicate Group`);

// Replace intake-2026-005: Urgent but Incomplete
writeFile(path.join(INCOMING, 'intake-2026-005.md'), `# Legal Intake Form

## Intake ID
intake-2026-005

## Matter Type
Compliance Question

## Requesting Party
Zeta Financial

## Contact Email

## Jurisdiction
Delaware, USA

## Business Unit
Finance

## Description
Regulatory filing deadline in 48 hours for SEC disclosure requirements. Need urgent legal review of filing obligations under new reporting guidelines. The compliance team has prepared draft disclosures but needs legal sign-off before submission.

## Urgency
Critical - same day

## Duplicate Group`);

// ─── Update fixture manifest ──────────────────────────────────────────────

console.log('\nUpdating fixture manifest...');
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const files = manifest.expectedDecisionSet.files;

for (const entry of files) {
  if (entry.intakeId === 'intake-2026-001') {
    entry.expectedDisposition = 'Request Information';
    entry.acceptableDispositions = ['Request Information'];
    entry.reasonCode = 'missing_jurisdiction';
    entry.expectedNextActionKind = 'request_jurisdiction';
    entry.sourceFields.jurisdiction = 'Not specified';
    entry.sourceFields.matterType = 'Contract Review';
  }
  if (entry.intakeId === 'intake-2026-004') {
    entry.expectedDisposition = 'Open Matter';
    entry.acceptableDispositions = ['Open Matter'];
    entry.reasonCode = 'acquisition_contract_review';
    entry.expectedNextActionKind = 'assign';
    entry.sourceFields.matterType = 'Contract Review';
    entry.sourceFields.requestingParty = 'Epsilon Health (acquired by Omega Healthcare Group)';
    entry.sourceFields.contactEmail = 'legal@epsilon.example.com';
    entry.sourceFields.jurisdiction = 'California, USA';
    entry.sourceFields.businessUnit = 'Legal';
    entry.sourceFields.urgency = 'Standard';
  }
  if (entry.intakeId === 'intake-2026-005') {
    entry.expectedDisposition = 'Request Information';
    entry.acceptableDispositions = ['Request Information'];
    entry.reasonCode = 'missing_contact_email_urgent';
    entry.expectedNextActionKind = 'request_email';
    entry.sourceFields.matterType = 'Compliance Question';
    entry.sourceFields.contactEmail = '';
    entry.sourceFields.urgency = 'Critical - same day';
  }
}

// Update summary counts
const counts = {};
for (const entry of files) {
  const d = entry.expectedDisposition;
  counts[d] = (counts[d] || 0) + 1;
}
manifest.expectedDecisionSet.summary = { total: 8, ...counts };

// Add new edge case notes
manifest.fixturePolicy.edgeCaseNotes = {
  ...manifest.fixturePolicy.edgeCaseNotes,
  'contradictory_jurisdiction': 'intake-001: Contract review for EU GDPR data processing but Jurisdiction is "Not specified." Tests whether model detects that GDPR matter without jurisdiction info requires information request rather than opening as complete intake.',
  'acquisition_contract_review': 'intake-004: Customer contracts of recently acquired entity need review. All fields present. Tests whether model correctly opens a legitimate business matter despite acquisition context.',
  'urgent_missing_email': 'intake-005: Critical urgency (48h regulatory deadline) but Contact Email is missing. Tests whether model follows policy (missing email → Request Information) or lets urgency override the missing-field rule.'
};

// Add to seeded edge cases
const newEcs = ['contradictory_jurisdiction', 'acquisition_contract_review', 'urgent_missing_email'];
for (const ec of newEcs) {
  if (!manifest.fixturePolicy.seededEdgeCases.includes(ec)) {
    manifest.fixturePolicy.seededEdgeCases.push(ec);
  }
}

fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
console.log('  Updated fixture-manifest.json');

// ─── Summary ───────────────────────────────────────────────────────────────

console.log('\nExpected outcomes:');
console.log('  intake-2026-001 → Request Information (EU GDPR data, no jurisdiction)');
console.log('  intake-2026-002 → Request Information (missing email — unchanged)');
console.log('  intake-2026-003 → Decline (missing requesting party — unchanged)');
console.log('  intake-2026-004 → Open Matter (acquisition contract review)');
console.log('  intake-2026-005 → Request Information (critical urgency but missing email)');
console.log('  intake-2026-006 → Open Matter (jurisdiction mismatch — unchanged)');
console.log('  intake-2026-007 → Open Matter (duplicate primary — unchanged)');
console.log('  intake-2026-008 → Duplicate (duplicate secondary — unchanged)');
console.log(`\nDisposition summary: ${JSON.stringify(counts)}`);
console.log('\nReady. Run: node scripts/run-legal-intake-test.js');
