#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_MARKER = '.fixture-workspace';

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    if (body.includes('=')) {
      const [k, ...rest] = body.split('=');
      parsed[k] = rest.join('=') || true;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      parsed[body] = next;
      i++;
    } else {
      parsed[body] = true;
    }
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));

function failUsage(message) {
  console.error(message);
  console.error('Usage: node scripts/fixture-generator.js --fixture=<name> --seed=<integer> --workspace=<fixture-root> --evaluation-date=<YYYY-MM-DD> [--dry-run] [--overwrite]');
  process.exit(1);
}

for (const required of ['fixture', 'seed', 'workspace', 'evaluation-date']) {
  if (args[required] === undefined || args[required] === true || String(args[required]).trim() === '') {
    failUsage('Missing required --' + required);
  }
}

const FIXTURE = String(args.fixture);
const parsedSeed = Number(args.seed);
if (!Number.isInteger(parsedSeed)) {
  failUsage('--seed must be an integer');
}
const SEED = parsedSeed;
const WORKSPACE_ROOT = path.resolve(String(args.workspace));
const EVALUATION_DATE = String(args['evaluation-date']);
const EVALUATION_BASE_MS = Date.parse(EVALUATION_DATE + 'T00:00:00.000Z');
if (!/^\d{4}-\d{2}-\d{2}$/.test(EVALUATION_DATE) || Number.isNaN(EVALUATION_BASE_MS)) {
  failUsage('--evaluation-date must be YYYY-MM-DD');
}
const DRY_RUN = args['dry-run'] === true || args['dry-run'] === 'true';
const OVERWRITE = args.overwrite === true || args.overwrite === 'true';
const COUNT = parseInt(args.count, 10) || (['legal-intake', 'vendor-compliance', 'shared-drive', 'customer-support'].includes(FIXTURE) ? 8 : 10);
const COMPLETE_RATE = parseFloat(args['complete-rate']) || 0.6;
const CRITICAL_RATE = parseFloat(args['critical-urgency-rate']) || 0.2;

function toIsoFromEvaluation(offsetMs = 0) {
  return new Date(EVALUATION_BASE_MS + offsetMs).toISOString();
}

function evaluationDateAtOffset(offsetDays) {
  return new Date(EVALUATION_BASE_MS + offsetDays * 86400000);
}

function relativeWorkspacePath(filepath) {
  const resolved = path.resolve(filepath);
  const rel = path.relative(WORKSPACE_ROOT, resolved);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    return rel || '.';
  }
  throw new Error('Refusing path outside fixture workspace: ' + filepath);
}

function ensureWorkspaceSafety() {
  const forbidden = [
    ROOT,
    path.join(ROOT, 'workspace-root'),
    path.join(ROOT, '.local-workspace'),
    path.join(ROOT, 'data'),
    path.join(ROOT, '.local-data')
  ].map(p => path.resolve(p));
  if (forbidden.includes(WORKSPACE_ROOT)) {
    throw new Error('Refusing operational workspace root: ' + WORKSPACE_ROOT);
  }
  const marker = path.join(WORKSPACE_ROOT, FIXTURE_MARKER);
  if (!fs.existsSync(marker) || !fs.statSync(marker).isFile()) {
    throw new Error('Fixture workspace marker missing: ' + marker);
  }
}

const plannedPaths = [];
function recordPlan(type, target) {
  plannedPaths.push({ type, path: relativeWorkspacePath(target) });
}

function planMkdir(dir) {
  relativeWorkspacePath(dir);
  recordPlan('directory', dir);
  if (!DRY_RUN) fs.mkdirSync(dir, { recursive: true });
}

function planWriteFile(filepath, content) {
  relativeWorkspacePath(filepath);
  if (!OVERWRITE && fs.existsSync(filepath)) {
    throw new Error('Refusing to overwrite existing file without --overwrite: ' + relativeWorkspacePath(filepath));
  }
  recordPlan('file', filepath);
  if (!DRY_RUN) fs.writeFileSync(filepath, content);
}

function writeManifest(filepath, manifest) {
  relativeWorkspacePath(filepath);
  if (!OVERWRITE && fs.existsSync(filepath)) {
    throw new Error('Refusing to overwrite existing file without --overwrite: ' + relativeWorkspacePath(filepath));
  }
  recordPlan('file', filepath);
  manifest.generatedPaths = uniqueGeneratedPaths();
  if (!DRY_RUN) fs.writeFileSync(filepath, JSON.stringify(manifest, null, 2));
}

function planUtimes(filepath, date) {
  relativeWorkspacePath(filepath);
  recordPlan('mtime', filepath);
  if (!DRY_RUN) {
    try { fs.utimesSync(filepath, date, date); } catch (e) { /* ignore */ }
  }
}

function uniqueGeneratedPaths() {
  const seen = new Set();
  return plannedPaths.filter(entry => {
    const key = entry.type + ':' + entry.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function seededRandom(seed) {
  let s = seed;
  return function () {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function pick(arr, rand) {
  return arr[Math.floor(rand() * arr.length)];
}

function pad(n, width) {
  return String(n).padStart(width, '0');
}

// ── Legal Intake Fixture ──

const BUSINESS_UNITS = ['Sales', 'Procurement', 'Product', 'People', 'Finance', 'Security'];
const MATTER_TYPES = [
  'Contract Review', 'NDA Review', 'IP Assessment', 'Employment Agreement',
  'Compliance Question', 'Policy Review', 'Dispute', 'Data Privacy Assessment'
];
const LEGAL_DISPOSITIONS = ['Open Matter', 'Request Information', 'Decline', 'Duplicate'];

const LEGAL_FILLER = [
  {
    matterType: 'Contract Review',
    requestingParty: 'Acme Corporation',
    contactEmail: 'legal@acme.example.com',
    jurisdiction: 'Delaware, USA',
    businessUnit: 'Sales',
    description: 'Review SaaS subscription agreement renewal, including liability cap and data processing terms.',
    urgency: 'Standard',
    expectedDisposition: 'Open Matter',
    reasonCode: 'complete_intake',
    expectedNextActionKind: 'assign'
  },
  {
    matterType: 'Compliance Question',
    requestingParty: 'Gamma Tech',
    contactEmail: '',
    jurisdiction: 'New York, USA',
    businessUnit: 'Security',
    description: 'Can customer analytics data be shared with a new subprocesser for retention analysis?',
    urgency: 'Standard',
    expectedDisposition: 'Request Information',
    reasonCode: 'missing_contact_email',
    expectedNextActionKind: 'request_email'
  },
  {
    matterType: 'Dispute',
    requestingParty: '[MISSING]',
    contactEmail: 'ops@delta.example.com',
    jurisdiction: 'Texas, USA',
    businessUnit: 'Finance',
    description: 'Invoice dispute involving professional services scope and delivery dates.',
    urgency: 'Standard',
    expectedDisposition: 'Decline',
    reasonCode: 'missing_requesting_party',
    expectedNextActionKind: 'decline_or_request_resubmission'
  },
  {
    matterType: 'Personal Legal Advice',
    requestingParty: 'Epsilon Health',
    contactEmail: 'people@epsilon.example.com',
    jurisdiction: 'California, USA',
    businessUnit: 'People',
    description: 'Employee asks company legal team to review a personal apartment lease.',
    urgency: 'Standard',
    expectedDisposition: 'Decline',
    reasonCode: 'out_of_scope',
    expectedNextActionKind: 'decline'
  },
  {
    matterType: 'Contract Review',
    requestingParty: 'Zeta Financial',
    contactEmail: 'sales@zeta.example.com',
    jurisdiction: 'Delaware, USA',
    businessUnit: 'Sales',
    description: 'Help with contract.',
    urgency: 'Standard',
    expectedDisposition: 'Request Information',
    reasonCode: 'vague_description',
    expectedNextActionKind: 'request_details'
  },
  {
    matterType: 'Policy Review',
    requestingParty: 'Eta Energy',
    contactEmail: 'policy@eta.example.com',
    jurisdiction: 'California, USA',
    businessUnit: 'Product',
    description: 'Review updated acceptable use policy for AI-generated content in customer workspaces. Company records list the requesting entity as Delaware-based.',
    urgency: 'Standard',
    expectedDisposition: 'Open Matter',
    reasonCode: 'jurisdiction_mismatch_note',
    expectedNextActionKind: 'open_with_note'
  },
  {
    matterType: 'NDA Review',
    requestingParty: 'Theta Media',
    contactEmail: 'partnerships@theta.example.com',
    jurisdiction: 'New York, USA',
    businessUnit: 'Sales',
    description: 'Review mutual NDA for Project Atlas partnership talks with Northstar Labs.',
    urgency: 'Critical - same day',
    duplicateGroup: 'project-atlas-nda',
    expectedDisposition: 'Open Matter',
    reasonCode: 'duplicate_group_primary',
    expectedNextActionKind: 'open_primary'
  },
  {
    matterType: 'NDA Review',
    requestingParty: 'Theta Media',
    contactEmail: 'partnerships@theta.example.com',
    jurisdiction: 'New York, USA',
    businessUnit: 'Sales',
    description: 'Duplicate submission: Review mutual NDA for Project Atlas partnership talks with Northstar Labs.',
    urgency: 'Critical - same day',
    duplicateGroup: 'project-atlas-nda',
    expectedDisposition: 'Duplicate',
    reasonCode: 'duplicate_matter',
    expectedNextActionKind: 'link_to_primary'
  },
  {
    matterType: 'Data Privacy Assessment',
    requestingParty: 'Iota Pharma',
    contactEmail: 'privacy@iota.example.com',
    jurisdiction: '',
    businessUnit: 'Security',
    description: 'Assess privacy implications for exporting customer health analytics to an EU data warehouse.',
    urgency: 'Critical - same day',
    expectedDisposition: 'Request Information',
    reasonCode: 'missing_jurisdiction',
    expectedNextActionKind: 'request_jurisdiction'
  }
];

function cloneLegalCase(source) {
  return JSON.parse(JSON.stringify(source));
}

function buildRandomLegalCase(index, rand) {
  const matterType = pick(MATTER_TYPES, rand);
  const businessUnit = pick(BUSINESS_UNITS, rand);
  const requestingParty = pick(['Kappa Manufacturing', 'Lambda Logistics', 'Mu Retail', 'Nu Foods', 'Omicron Software'], rand);
  const jurisdiction = pick(['Delaware, USA', 'California, USA', 'New York, USA', 'London, UK'], rand);
  const contactEmail = 'legal-' + index + '@example.com';
  const urgency = rand() < CRITICAL_RATE ? 'Critical - same day' : 'Standard';
  const missingKind = rand() < COMPLETE_RATE ? 'none' : pick(['contactEmail', 'jurisdiction', 'description'], rand);
  const item = {
    matterType,
    requestingParty,
    contactEmail,
    jurisdiction,
    businessUnit,
    description: 'Review ' + matterType.toLowerCase() + ' request for ' + businessUnit + ' team with defined business context and requested legal outcome.',
    urgency,
    expectedDisposition: 'Open Matter',
    reasonCode: 'complete_intake',
    expectedNextActionKind: 'assign'
  };
  if (missingKind === 'contactEmail') {
    item.contactEmail = '';
    item.expectedDisposition = 'Request Information';
    item.reasonCode = 'missing_contact_email';
    item.expectedNextActionKind = 'request_email';
  } else if (missingKind === 'jurisdiction') {
    item.jurisdiction = '';
    item.expectedDisposition = 'Request Information';
    item.reasonCode = 'missing_jurisdiction';
    item.expectedNextActionKind = 'request_jurisdiction';
  } else if (missingKind === 'description') {
    item.description = '';
    item.expectedDisposition = 'Request Information';
    item.reasonCode = 'missing_description';
    item.expectedNextActionKind = 'request_details';
  }
  return item;
}

function renderLegalIntakeForm(intakeId, item) {
  return [
    '# Legal Intake Form',
    '',
    '## Intake ID',
    intakeId,
    '',
    '## Matter Type',
    item.matterType || '',
    '',
    '## Requesting Party',
    item.requestingParty || '',
    '',
    '## Contact Email',
    item.contactEmail || '',
    '',
    '## Jurisdiction',
    item.jurisdiction || '',
    '',
    '## Business Unit',
    item.businessUnit || '',
    '',
    '## Description',
    item.description || '',
    '',
    '## Urgency',
    item.urgency || 'Standard',
    '',
    '## Duplicate Group',
    item.duplicateGroup || ''
  ].join('\n');
}

function buildLegalIntakeCases(count, rand) {
  const seeded = LEGAL_FILLER.slice(0, Math.min(count, LEGAL_FILLER.length)).map(cloneLegalCase);
  for (let i = seeded.length + 1; i <= count; i++) {
    seeded.push(buildRandomLegalCase(i, rand));
  }
  return seeded;
}

function generateLegalIntake() {
  const fixtureDir = path.join(WORKSPACE_ROOT, 'legal-intake');
  const incomingDir = path.join(fixtureDir, 'incoming');
  planMkdir(incomingDir);

  const rand = seededRandom(SEED);
  const cases = buildLegalIntakeCases(COUNT, rand);
  const forms = [];
  for (let i = 1; i <= cases.length; i++) {
    const item = cases[i - 1];
    const intakeId = 'intake-2026-' + pad(i, 3);
    const filename = intakeId + '.md';
    const filepath = path.join(incomingDir, filename);
    const content = renderLegalIntakeForm(intakeId, item);
    planWriteFile(filepath, content);
    forms.push({ intakeId, filename, content, ...item });
  }

  const manifest = buildManifest(
    'legal-intake',
    { count: COUNT, criticalRate: CRITICAL_RATE },
    {
      dispositions: LEGAL_DISPOSITIONS,
      files: forms.map(f => ({
        intakeId: f.intakeId,
        sourcePath: path.join('legal-intake', 'incoming', f.filename),
        expectedDisposition: f.expectedDisposition,
        acceptableDispositions: [f.expectedDisposition],
        reasonCode: f.reasonCode,
        expectedNextActionKind: f.expectedNextActionKind,
        duplicateGroup: f.duplicateGroup || null,
        sourceFields: {
          matterType: f.matterType,
          requestingParty: f.requestingParty,
          contactEmail: f.contactEmail,
          jurisdiction: f.jurisdiction,
          businessUnit: f.businessUnit,
          urgency: f.urgency
        }
      })),
      summary: LEGAL_DISPOSITIONS.reduce((acc, disposition) => {
        acc[disposition] = forms.filter(f => f.expectedDisposition === disposition).length;
        return acc;
      }, { total: forms.length })
    },
    {
      dispositionSet: LEGAL_DISPOSITIONS,
      sourcePreservation: true,
      requiredSourceFields: ['Matter Type', 'Requesting Party', 'Contact Email', 'Jurisdiction', 'Business Unit', 'Description', 'Urgency'],
      seededEdgeCases: ['duplicate_matter', 'vague_description', 'jurisdiction_mismatch_note', 'out_of_scope', 'missing_contact_email', 'missing_jurisdiction', 'missing_requesting_party'],
      duplicateRule: 'Later intake in the same duplicateGroup should be marked Duplicate when it repeats the same matter.',
      vagueDescriptionRule: 'A vague description should be Request Information unless other fixture policy states it can proceed.',
      outOfScopeRule: 'Personal legal advice or other non-company legal work should be Decline.',
      jurisdictionMismatchRule: 'Jurisdiction mismatch should remain Open Matter when all required fields exist, with the mismatch noted in reason or next action.'
    },
    ARTIFACT_SCHEMAS['legal-intake']
  );

  const manifestPath = path.join(fixtureDir, 'fixture-manifest.json');
  writeManifest(manifestPath, manifest);

  return manifest;
}

// ── Customer Support Fixture ──

const SUPPORT_CASES = [
  {
    ticketId: 'SUP-2026-001',
    filename: 'ticket-001.md',
    subject: 'Checkout service down for all EU customers',
    customerName: 'Acme Retail',
    customerTier: 'Enterprise',
    reportedOffsetMinutes: -45,
    issueType: 'Incident',
    impact: 'All EU storefront checkout requests return 503. Revenue-impacting production outage.',
    description: 'Customer reports that every EU shopper receives a 503 during checkout. Their status page and synthetic monitor confirm the failure started after the 09:00 UTC deploy.',
    escalationSignals: 'Production outage; all users in region affected; enterprise customer; revenue impact.',
    duplicateGroup: 'none',
    expectedPriority: 'P1',
    expectedTeam: 'On-Call',
    expectedEscalation: 'Yes',
    expectedSla: '15 minutes',
    expectedNextActionKind: 'page_on_call'
  },
  {
    ticketId: 'SUP-2026-002',
    filename: 'ticket-002.md',
    subject: 'Intermittent dashboard latency for enterprise admin users',
    customerName: 'Northstar Bank',
    customerTier: 'Enterprise',
    reportedOffsetMinutes: -95,
    issueType: 'Bug',
    impact: 'Admin dashboard intermittently takes 20-30 seconds to load for finance users. Core transaction processing is unaffected.',
    description: 'Enterprise admin users see slow dashboard loading during month-end reporting. The customer is asking whether this should block their finance close process.',
    escalationSignals: 'Enterprise tier; ambiguous severity; high business impact but partial feature degradation.',
    duplicateGroup: 'none',
    expectedPriority: 'P2',
    expectedTeam: 'Engineering',
    expectedEscalation: 'Yes',
    expectedSla: '1 hour',
    expectedNextActionKind: 'engineering_triage_enterprise'
  },
  {
    ticketId: 'SUP-2026-003',
    filename: 'ticket-003.md',
    subject: 'CSV export missing February invoices',
    customerName: 'Bluebird Logistics',
    customerTier: 'Premium',
    reportedOffsetMinutes: -130,
    issueType: 'Bug',
    impact: 'One reporting export omits February invoices for a single account. UI totals are correct.',
    description: 'The customer can view invoices in the UI, but CSV export excludes February rows. Reproducible with account BL-443.',
    escalationSignals: 'Single account; workaround available through UI; no data loss indicated.',
    duplicateGroup: 'csv-export-february',
    expectedPriority: 'P2',
    expectedTeam: 'Engineering',
    expectedEscalation: 'No',
    expectedSla: '4 business hours',
    expectedNextActionKind: 'bug_triage'
  },
  {
    ticketId: 'SUP-2026-004',
    filename: 'ticket-004.md',
    subject: 'Duplicate report: CSV export missing February invoices',
    customerName: 'Bluebird Logistics',
    customerTier: 'Premium',
    reportedOffsetMinutes: -120,
    issueType: 'Bug',
    impact: 'Same export problem as SUP-2026-003, reported by a second user on the same account.',
    description: 'Another user from Bluebird reports February invoices missing from the CSV export for account BL-443. This appears to duplicate SUP-2026-003.',
    escalationSignals: 'Duplicate of SUP-2026-003; same customer, account, and symptom.',
    duplicateGroup: 'csv-export-february',
    expectedPriority: 'P2',
    expectedTeam: 'Engineering',
    expectedEscalation: 'No',
    expectedSla: '4 business hours',
    expectedNextActionKind: 'link_duplicate_to_sup_2026_003'
  },
  {
    ticketId: 'SUP-2026-005',
    filename: 'ticket-005.md',
    subject: 'Possible unauthorized API token access',
    customerName: 'Cedar Health',
    customerTier: 'Enterprise',
    reportedOffsetMinutes: -35,
    issueType: 'Security Concern',
    impact: 'Customer security team observed API calls from an unfamiliar ASN using a production token.',
    description: 'The customer has not confirmed data exposure, but requests immediate review of access logs and token revocation guidance.',
    escalationSignals: 'Potential security incident; enterprise customer; production token involved.',
    duplicateGroup: 'none',
    expectedPriority: 'P1',
    expectedTeam: 'Security',
    expectedEscalation: 'Yes',
    expectedSla: '15 minutes',
    expectedNextActionKind: 'security_escalation'
  },
  {
    ticketId: 'SUP-2026-006',
    filename: 'ticket-006.md',
    subject: 'Request for saved dashboard templates',
    customerName: 'Delta Manufacturing',
    customerTier: 'Standard',
    reportedOffsetMinutes: -300,
    issueType: 'Feature Request',
    impact: 'Would reduce manual reporting setup for a 25-person operations team. No current production issue.',
    description: 'Customer asks whether dashboard layouts can be saved and reused across teams. They are willing to discuss beta participation.',
    escalationSignals: 'Feature request; no outage; no SLA risk.',
    duplicateGroup: 'none',
    expectedPriority: 'P3',
    expectedTeam: 'Product',
    expectedEscalation: 'No',
    expectedSla: '2 business days',
    expectedNextActionKind: 'product_feedback'
  },
  {
    ticketId: 'SUP-2026-007',
    filename: 'ticket-007.md',
    subject: 'How do I rotate a service account API key?',
    customerName: 'Evergreen Studios',
    customerTier: 'Standard',
    reportedOffsetMinutes: -260,
    issueType: 'Question',
    impact: 'Administrator needs guidance before scheduled maintenance. No product malfunction reported.',
    description: 'Customer asks for steps to rotate a service account API key without interrupting their nightly import job.',
    escalationSignals: 'How-to request; no incident; no customer outage.',
    duplicateGroup: 'none',
    expectedPriority: 'P3',
    expectedTeam: 'Customer Success',
    expectedEscalation: 'No',
    expectedSla: '1 business day',
    expectedNextActionKind: 'send_key_rotation_steps'
  },
  {
    ticketId: 'SUP-2026-008',
    filename: 'ticket-008.md',
    subject: 'Internal QA note about staging banner color',
    customerName: 'Internal QA',
    customerTier: 'Internal',
    reportedOffsetMinutes: -420,
    issueType: 'Internal',
    impact: 'Staging-only banner color does not match design review screenshot. No customer impact.',
    description: 'Internal QA noticed a visual mismatch in staging. This is not customer-reported and should not enter customer escalation.',
    escalationSignals: 'Internal-only; staging environment; no customer impact.',
    duplicateGroup: 'none',
    expectedPriority: 'P4',
    expectedTeam: 'Internal Triage',
    expectedEscalation: 'No',
    expectedSla: 'Backlog',
    expectedNextActionKind: 'route_internal_backlog'
  }
];

function buildGeneratedSupportCase(index) {
  const ticketId = 'SUP-2026-' + pad(index, 3);
  const filename = 'ticket-' + pad(index, 3) + '.md';
  const base = {
    ticketId,
    filename,
    customerName: 'Customer ' + pad(index, 2),
    customerTier: index % 5 === 0 ? 'Enterprise' : (index % 3 === 0 ? 'Premium' : 'Standard'),
    reportedOffsetMinutes: -60 - index * 11,
    duplicateGroup: 'none',
    expectedEscalation: 'No',
    expectedSla: '2 business days',
    expectedNextActionKind: 'product_feedback'
  };

  const special = {
    9: {
      subject: 'US API service down for checkout callbacks', customerName: 'Meridian Foods', customerTier: 'Premium', issueType: 'Incident',
      impact: 'Checkout callback API returns 500 for most US requests.', description: 'Customer says orders are stuck because callback delivery fails after payment capture.', escalationSignals: 'Production outage; order processing blocked.', duplicateGroup: 'us-callback-outage',
      expectedPriority: 'P1', expectedTeam: 'On-Call', expectedEscalation: 'Yes', expectedSla: '15 minutes', expectedNextActionKind: 'page_on_call'
    },
    10: {
      subject: 'Conflicting report: US callback failures only on retries', customerName: 'Meridian Foods', customerTier: 'Premium', issueType: 'Incident',
      impact: 'Second report says first callback sometimes succeeds but retries fail.', description: 'Conflicts with SUP-2026-009 on scope, but points to the same production incident window.', escalationSignals: 'Conflicting incident report; same customer and service as SUP-2026-009.', duplicateGroup: 'us-callback-outage',
      expectedPriority: 'P1', expectedTeam: 'On-Call', expectedEscalation: 'Yes', expectedSla: '15 minutes', expectedNextActionKind: 'page_on_call'
    },
    11: {
      subject: 'Admin export timeout for enterprise renewal report', customerName: 'Aster Telecom', customerTier: 'Enterprise', issueType: 'Bug',
      impact: 'Renewal operations team cannot export quarterly account report.', description: 'Enterprise customer reports export timeout for a report needed by the renewal desk today.', escalationSignals: 'Enterprise tier; revenue renewal deadline; degraded business-critical workflow.',
      expectedPriority: 'P2', expectedTeam: 'Engineering', expectedEscalation: 'Yes', expectedSla: '1 hour', expectedNextActionKind: 'engineering_triage_enterprise'
    },
    12: {
      subject: 'Billing contact cannot update invoice address', customerName: 'Harbor Robotics', customerTier: 'Standard', issueType: 'Billing',
      impact: 'Invoice address update fails before monthly billing close.', description: 'Customer billing admin cannot save the new invoice address and needs help before close.', escalationSignals: 'Account and billing issue; no service outage.',
      expectedPriority: 'P3', expectedTeam: 'Customer Success', expectedEscalation: 'No', expectedSla: '1 business day', expectedNextActionKind: 'billing_account_followup'
    },
    13: {
      subject: 'Possible session cookie exposure in shared browser', customerName: 'Kestrel Legal', customerTier: 'Enterprise', issueType: 'Security Concern',
      impact: 'User reports seeing another employee account after using a shared kiosk browser.', description: 'Customer cannot confirm data exposure but requests security review and session invalidation guidance.', escalationSignals: 'Possible security issue; enterprise customer; session data involved.',
      expectedPriority: 'P1', expectedTeam: 'Security', expectedEscalation: 'Yes', expectedSla: '15 minutes', expectedNextActionKind: 'security_escalation'
    },
    14: {
      subject: 'Need custom fields on saved views', customerName: 'Juniper Supply', customerTier: 'Standard', issueType: 'Feature Request',
      impact: 'Would reduce manual filtering for account managers.', description: 'Customer requests custom fields on saved list views and is willing to discuss roadmap fit.', escalationSignals: 'Feature request; no incident.',
      expectedPriority: 'P3', expectedTeam: 'Product', expectedEscalation: 'No', expectedSla: '2 business days', expectedNextActionKind: 'product_feedback'
    },
    15: {
      subject: 'Question about webhook retry schedule', customerName: 'Lakeview Apps', customerTier: 'Premium', issueType: 'Question',
      impact: 'Developer needs retry timing before integration launch.', description: 'Customer asks how often failed webhooks retry and whether retries can be paused.', escalationSignals: 'How-to request; no malfunction.',
      expectedPriority: 'P3', expectedTeam: 'Customer Success', expectedEscalation: 'No', expectedSla: '1 business day', expectedNextActionKind: 'send_how_to_guidance'
    },
    16: {
      subject: 'Bug maybe in reports', customerName: 'Monarch Labs', customerTier: 'Premium', issueType: 'Bug',
      impact: 'Reporter says numbers look wrong but provides no report ID or reproduction steps.', description: 'Partial bug report with vague evidence. Needs report name, time range, and expected value before engineering can act.', escalationSignals: 'Partial bug report; missing reproduction details.',
      expectedPriority: 'P3', expectedTeam: 'Customer Success', expectedEscalation: 'No', expectedSla: '1 business day', expectedNextActionKind: 'request_reproduction_details'
    },
    17: {
      subject: 'asdf urgent please call me', customerName: 'Unknown Sender', customerTier: 'Unknown', issueType: 'Noisy',
      impact: 'No product, account, or customer impact stated.', description: 'Short noisy request without actionable support context.', escalationSignals: 'No customer or product evidence.',
      expectedPriority: 'P4', expectedTeam: 'Internal Triage', expectedEscalation: 'No', expectedSla: 'Backlog', expectedNextActionKind: 'request_customer_context'
    },
    18: {
      subject: 'Enterprise sandbox import failed before demo', customerName: 'Orion Energy', customerTier: 'Enterprise', issueType: 'Bug',
      impact: 'Sandbox import failed before executive demo; production unaffected.', description: 'Ambiguous escalation case because the account is enterprise but impact is a sandbox demo, not production.', escalationSignals: 'Enterprise tier; executive demo; non-production environment.',
      expectedPriority: 'P2', expectedTeam: 'Engineering', expectedEscalation: 'Yes', expectedSla: '1 hour', expectedNextActionKind: 'engineering_triage_enterprise'
    },
    19: {
      subject: 'Duplicate 1: webhook signature mismatch', customerName: 'Pioneer Media', customerTier: 'Premium', issueType: 'Bug',
      impact: 'Webhook validation fails in production for one integration.', description: 'Primary report for webhook signature mismatch in integration PM-72.', escalationSignals: 'Single integration; reproducible customer-impacting bug.', duplicateGroup: 'webhook-signature-chain',
      expectedPriority: 'P2', expectedTeam: 'Engineering', expectedEscalation: 'No', expectedSla: '4 business hours', expectedNextActionKind: 'bug_triage'
    },
    20: {
      subject: 'Duplicate 2: webhook signature mismatch', customerName: 'Pioneer Media', customerTier: 'Premium', issueType: 'Bug',
      impact: 'Same integration failure as SUP-2026-019.', description: 'Second user reports same webhook signature mismatch for integration PM-72.', escalationSignals: 'Duplicate chain member for webhook-signature-chain.', duplicateGroup: 'webhook-signature-chain',
      expectedPriority: 'P2', expectedTeam: 'Engineering', expectedEscalation: 'No', expectedSla: '4 business hours', expectedNextActionKind: 'link_duplicate_to_primary'
    },
    21: {
      subject: 'Duplicate 3: webhook signature mismatch', customerName: 'Pioneer Media', customerTier: 'Premium', issueType: 'Bug',
      impact: 'Third report for same integration failure.', description: 'Third duplicate report for webhook signature mismatch in integration PM-72.', escalationSignals: 'Duplicate chain member for webhook-signature-chain.', duplicateGroup: 'webhook-signature-chain',
      expectedPriority: 'P2', expectedTeam: 'Engineering', expectedEscalation: 'No', expectedSla: '4 business hours', expectedNextActionKind: 'link_duplicate_to_primary'
    }
  };
  if (special[index]) return { ...base, ...special[index] };

  const cycle = index % 6;
  if (cycle === 0) {
    return { ...base, subject: 'Saved report needs additional filter option', issueType: 'Feature Request', impact: 'Would improve account workflow but no current failure.', description: 'Customer requests an enhancement to saved reports for operational convenience.', escalationSignals: 'Feature request; no outage.', expectedPriority: 'P3', expectedTeam: 'Product', expectedEscalation: 'No', expectedSla: '2 business days', expectedNextActionKind: 'product_feedback' };
  }
  if (cycle === 1) {
    return { ...base, subject: 'How to invite contractors with limited permissions', issueType: 'Question', impact: 'Admin needs configuration guidance.', description: 'Customer asks how to invite contractors without granting billing access.', escalationSignals: 'How-to request; no product failure.', expectedPriority: 'P3', expectedTeam: 'Customer Success', expectedEscalation: 'No', expectedSla: '1 business day', expectedNextActionKind: 'send_how_to_guidance' };
  }
  if (cycle === 2) {
    return { ...base, subject: 'Search results slow for archived projects', issueType: 'Bug', impact: 'Archived project search takes 12 seconds for one workspace.', description: 'Customer can complete work but search latency affects archived projects.', escalationSignals: 'Non-enterprise degraded workflow; workaround available.', expectedPriority: 'P2', expectedTeam: 'Engineering', expectedEscalation: 'No', expectedSla: '4 business hours', expectedNextActionKind: 'bug_triage' };
  }
  if (cycle === 3) {
    return { ...base, subject: 'Internal sales note sent to support queue', customerName: 'Internal Sales', customerTier: 'Internal', issueType: 'Internal', impact: 'Internal routing note only; no customer request.', description: 'Sales team accidentally forwarded a CRM note into support.', escalationSignals: 'Internal-only; no customer impact.', expectedPriority: 'P4', expectedTeam: 'Internal Triage', expectedEscalation: 'No', expectedSla: 'Backlog', expectedNextActionKind: 'route_internal_backlog' };
  }
  if (cycle === 4) {
    return { ...base, subject: 'Enterprise scheduled import delayed', customerTier: 'Enterprise', issueType: 'Bug', impact: 'Scheduled import finished 40 minutes late for a business review.', description: 'Enterprise account reports delayed import completion but no data loss.', escalationSignals: 'Enterprise tier; business-critical workflow degradation.', expectedPriority: 'P2', expectedTeam: 'Engineering', expectedEscalation: 'Yes', expectedSla: '1 hour', expectedNextActionKind: 'engineering_triage_enterprise' };
  }
  return { ...base, subject: 'Account owner needs billing role changed', issueType: 'Billing', impact: 'Billing admin needs role update for renewal paperwork.', description: 'Customer requests help changing billing owner before renewal paperwork is sent.', escalationSignals: 'Billing/account issue; no service failure.', expectedPriority: 'P3', expectedTeam: 'Customer Success', expectedEscalation: 'No', expectedSla: '1 business day', expectedNextActionKind: 'billing_account_followup' };
}

function buildSupportCases(count) {
  const cases = [];
  for (let index = 1; index <= count; index++) {
    cases.push(SUPPORT_CASES[index - 1] || buildGeneratedSupportCase(index));
  }
  return cases;
}

function buildSupportExpectation(item) {
  const expectation = {
    ticketId: item.ticketId,
    sourcePath: path.join('support-inbox', item.filename),
    customerName: item.customerName,
    customerTier: item.customerTier,
    issueType: item.issueType,
    duplicateGroup: item.duplicateGroup,
    expectedPriority: item.expectedPriority,
    expectedTeam: item.expectedTeam,
    expectedEscalation: item.expectedEscalation,
    expectedSla: item.expectedSla,
    expectedNextActionKind: item.expectedNextActionKind
  };

  const isArchivedSearchSlowdown = item.subject === 'Search results slow for archived projects';
  if (isArchivedSearchSlowdown) {
    expectation.acceptablePriority = ['P2', 'P3'];
    expectation.acceptableTeam = ['Engineering', 'Customer Success'];
    expectation.acceptableSla = ['4 business hours', '1 business day'];
    expectation.acceptableNextActionKind = ['bug_triage', 'request_reproduction_details'];
  }

  if (item.ticketId === 'SUP-2026-003') {
    expectation.acceptablePriority = ['P2', 'P3'];
    expectation.acceptableTeam = ['Engineering', 'Customer Success'];
    expectation.acceptableSla = ['4 business hours', '1 business day'];
    expectation.acceptableNextActionKind = ['bug_triage', 'request_reproduction_details'];
  }

  if (item.ticketId === 'SUP-2026-004') {
    expectation.acceptablePriority = ['P2', 'P3'];
    expectation.acceptableTeam = ['Engineering', 'Customer Success'];
    expectation.acceptableSla = ['4 business hours', '1 business day'];
  }

  if (['SUP-2026-010', 'SUP-2026-020', 'SUP-2026-021'].includes(item.ticketId)) {
    expectation.acceptableNextActionKind = [item.expectedNextActionKind, 'bug_triage', 'page_on_call', 'link_duplicate_to_primary'];
  }

  if (item.ticketId === 'SUP-2026-018') {
    expectation.acceptableEscalation = ['Yes', 'No'];
    expectation.acceptableSla = ['1 hour', '4 business hours'];
    expectation.acceptableNextActionKind = ['engineering_triage_enterprise', 'bug_triage'];
  }

  return expectation;
}

function renderSupportTicket(item) {
  return [
    '# Support Ticket',
    '',
    'Ticket ID: ' + item.ticketId,
    'Subject: ' + item.subject,
    'Customer: ' + item.customerName,
    'Customer Tier: ' + item.customerTier,
    'Reported Time: ' + toIsoFromEvaluation(item.reportedOffsetMinutes * 60000),
    'Issue Type: ' + item.issueType,
    'Impact: ' + item.impact,
    'Description: ' + item.description,
    'Escalation Signals: ' + item.escalationSignals,
    'Duplicate Group: ' + item.duplicateGroup
  ].join('\n');
}

function generateSupportFixtures() {
  const fixtureDir = path.join(WORKSPACE_ROOT, 'support-inbox');
  planMkdir(fixtureDir);

  const selected = buildSupportCases(COUNT);
  for (const item of selected) {
    planWriteFile(path.join(fixtureDir, item.filename), renderSupportTicket(item));
    planUtimes(path.join(fixtureDir, item.filename), evaluationDateAtOffset(-1));
  }

  const manifest = buildManifest(
    'customer-support',
    { count: selected.length },
    {
      files: selected.map(buildSupportExpectation),
      expectedEscalationTicketIds: selected
        .map(buildSupportExpectation)
        .filter(item => (item.acceptableEscalation || [item.expectedEscalation]).length === 1 && (item.acceptableEscalation || [item.expectedEscalation])[0] === 'Yes')
        .map(item => item.ticketId),
      duplicateGroups: selected
        .filter(item => item.duplicateGroup && item.duplicateGroup !== 'none')
        .reduce((groups, item) => {
          groups[item.duplicateGroup] = [...(groups[item.duplicateGroup] || []), item.ticketId];
          return groups;
        }, {})
    },
    {
      prioritySet: ['P1', 'P2', 'P3', 'P4'],
      escalationValues: ['Yes', 'No'],
      sourcePreservation: true,
      noWorkspacePolicyArtifacts: true,
      decisionRules: [
        'P1: production outage or potential security incident; escalate immediately.',
        'P2: customer-impacting bug, enterprise ambiguity, or degraded business-critical workflow.',
        'P3: feature request, how-to question, partial bug, or low-impact bug with workaround available.',
        'P4: internal-only or non-customer work without customer impact.'
      ]
    },
    ARTIFACT_SCHEMAS['customer-support']
  );

  writeManifest(path.join(fixtureDir, 'fixture-manifest.json'), manifest);
  return manifest;
}

// ── Vendor Compliance Fixture ──

const VENDOR_CASES = [
  { vendorName: 'CloudHost Inc', service: 'Cloud infrastructure hosting and CDN for customer-facing applications', criticality: 'Critical', annualSpend: '$420K', dpaStatus: 'Signed and current', certification: 'SOC2 Type II', certificationExpiry: '2027-06-30', certificationStatus: 'Current', incidentStatus: 'None reported', dataAccess: 'Customer account data and usage logs', expectedDisposition: 'Approve', reasonCode: 'current_cert_no_incident', expectedNextActionKind: 'approve' },
  { vendorName: 'DataSync Corp', service: 'Data pipeline and analytics storage for product telemetry', criticality: 'High', annualSpend: '$260K', dpaStatus: 'Signed and current', certification: 'ISO 27001', certificationExpiry: '2024-11-15', certificationStatus: 'Expired', incidentStatus: 'None reported', dataAccess: 'Product analytics and account metadata', expectedDisposition: 'Conditional Approve', reasonCode: 'expired_certification', expectedNextActionKind: 'recertification_90_days' },
  { vendorName: 'SecureMail Ltd', service: 'Email security, encryption, and archiving', criticality: 'High', annualSpend: '$180K', dpaStatus: 'Signed and current', certification: 'SOC2 Type II', certificationExpiry: '2027-03-31', certificationStatus: 'Current', incidentStatus: 'Open high severity phishing infrastructure incident under review', dataAccess: 'Employee email headers and quarantine metadata', expectedDisposition: 'Conditional Approve', reasonCode: 'active_incident', expectedNextActionKind: 'monitoring_condition' },
  { vendorName: 'AnalyticsPro', service: 'Business intelligence dashboards and reporting', criticality: 'Medium', annualSpend: '$95K', dpaStatus: 'Signed and current', certification: 'Not provided', certificationExpiry: 'Not applicable', certificationStatus: 'Missing', incidentStatus: 'None reported', dataAccess: 'Aggregated sales reporting data', expectedDisposition: 'Reject', reasonCode: 'missing_security_certification', expectedNextActionKind: 'request_certification_before_approval' },
  { vendorName: 'InfraServe', service: 'Infrastructure monitoring and alerting', criticality: 'Critical', annualSpend: '$310K', dpaStatus: 'Missing', certification: 'SOC2 Type II', certificationExpiry: '2027-08-15', certificationStatus: 'Current', incidentStatus: 'None reported', dataAccess: 'Infrastructure metrics and hostnames', expectedDisposition: 'Reject', reasonCode: 'missing_dpa', expectedNextActionKind: 'obtain_dpa_before_approval' },
  { vendorName: 'LogiStack', service: 'Log aggregation and search for application diagnostics', criticality: 'High', annualSpend: '$205K', dpaStatus: 'Signed and current', certification: 'ISO 27001', certificationExpiry: '2026-12-01', certificationStatus: 'Current', incidentStatus: 'Resolved medium severity credential rotation event', dataAccess: 'Application logs with limited customer identifiers', expectedDisposition: 'Approve', reasonCode: 'resolved_incident_current_cert', expectedNextActionKind: 'approve_with_audit_note' },
  { vendorName: 'CertiVault', service: 'Certificate lifecycle management', criticality: 'Medium', annualSpend: '$120K', dpaStatus: 'Signed and current', certification: 'SOC2 Type II', certificationExpiry: '2025-01-10', certificationStatus: 'Expired', incidentStatus: 'None reported', dataAccess: 'Certificate metadata and service owner contacts', expectedDisposition: 'Conditional Approve', reasonCode: 'expired_certification', expectedNextActionKind: 'recertification_90_days' },
  { vendorName: 'NetBridge', service: 'Network peering and secure connectivity', criticality: 'Critical', annualSpend: '$375K', dpaStatus: 'Signed and current', certification: 'FedRAMP', certificationExpiry: '2027-10-20', certificationStatus: 'Current', incidentStatus: 'None reported', dataAccess: 'Network routing metadata only', expectedDisposition: 'Approve', reasonCode: 'current_cert_no_incident', expectedNextActionKind: 'approve' }
];

function renderVendorPacket(vendorId, item) {
  return [
    '# Vendor Compliance Packet',
    '',
    '## Vendor ID', vendorId,
    '',
    '## Vendor Name', item.vendorName,
    '',
    '## Service', item.service,
    '',
    '## Criticality', item.criticality,
    '',
    '## Annual Spend', item.annualSpend,
    '',
    '## Data Access', item.dataAccess,
    '',
    '## Data Processing Agreement', item.dpaStatus,
    '',
    '## Security Certification', item.certification,
    '',
    '## Certification Expiry Date', item.certificationExpiry,
    '',
    '## Certification Status', item.certificationStatus,
    '',
    '## Incident Status', item.incidentStatus,
    '',
    '## Evidence Notes',
    'Use this packet as the vendor source of truth. Apply the workflow policy to decide Approve, Conditional Approve, or Reject.'
  ].join('\n');
}

function generateVendorFixtures() {
  const fixtureDir = path.join(WORKSPACE_ROOT, 'vendors');
  const incomingDir = path.join(fixtureDir, 'incoming');
  planMkdir(incomingDir);

  const selected = VENDOR_CASES.slice(0, Math.min(COUNT, VENDOR_CASES.length));
  const vendorResults = selected.map((item, index) => {
    const vendorId = 'vendor-' + pad(index + 1, 3);
    const packetPath = path.join(incomingDir, vendorId + '.md');
    planWriteFile(packetPath, renderVendorPacket(vendorId, item));
    return {
      vendorId,
      vendorName: item.vendorName,
      sourcePath: path.join('vendors', 'incoming', vendorId + '.md'),
      expectedDisposition: item.expectedDisposition,
      acceptableDispositions: [item.expectedDisposition],
      reasonCode: item.reasonCode,
      expectedNextActionKind: item.expectedNextActionKind,
      sourceFields: { criticality: item.criticality, annualSpend: item.annualSpend, dpaStatus: item.dpaStatus, certification: item.certification, certificationExpiry: item.certificationExpiry, certificationStatus: item.certificationStatus, incidentStatus: item.incidentStatus, dataAccess: item.dataAccess }
    };
  });

  const manifest = buildManifest(
    'vendor-compliance',
    { vendorCount: selected.length },
    {
      dispositions: ['Approve', 'Conditional Approve', 'Reject'],
      files: vendorResults,
      summary: {
        total: vendorResults.length,
        Approve: vendorResults.filter(v => v.expectedDisposition === 'Approve').length,
        'Conditional Approve': vendorResults.filter(v => v.expectedDisposition === 'Conditional Approve').length,
        Reject: vendorResults.filter(v => v.expectedDisposition === 'Reject').length
      }
    },
    {
      dispositionSet: ['Approve', 'Conditional Approve', 'Reject'],
      sourcePreservation: true,
      requiredSourceFields: ['Vendor ID', 'Vendor Name', 'Criticality', 'Data Processing Agreement', 'Security Certification', 'Certification Expiry Date', 'Certification Status', 'Incident Status'],
      seededEdgeCases: ['missing_security_certification', 'missing_dpa', 'expired_certification', 'active_incident', 'resolved_incident_current_cert'],
      policyLocation: 'workflow metadata',
      note: 'Policy is intentionally not emitted into the workspace.'
    },
    ARTIFACT_SCHEMAS['vendor-compliance']
  );

  writeManifest(path.join(fixtureDir, 'fixture-manifest.json'), manifest);
  return manifest;
}

// ── Shared Drive Cleanup Fixture ──

const DRIVE_DIRS = [
  { name: 'active', weight: 0.10, desc: 'current active project files' },
  { name: 'projects/alpha', weight: 0.10, desc: 'alpha project files' },
  { name: 'projects/beta', weight: 0.08, desc: 'beta project files' },
  { name: 'projects/gamma', weight: 0.07, desc: 'gamma project files' },
  { name: 'projects/archived/2024', weight: 0.06, desc: '2024 project archives' },
  { name: 'projects/archived/2023', weight: 0.05, desc: '2023 project archives' },
  { name: 'reports/quarterly', weight: 0.08, desc: 'quarterly business reports' },
  { name: 'reports/monthly', weight: 0.10, desc: 'monthly status reports' },
  { name: 'meetings/standup', weight: 0.10, desc: 'daily standup notes' },
  { name: 'meetings/sprint', weight: 0.08, desc: 'sprint planning and retro notes' },
  { name: 'meetings/quarterly-review', weight: 0.05, desc: 'quarterly review presentations' },
  { name: 'design/mockups', weight: 0.05, desc: 'UI mockups and wireframes' },
  { name: 'design/specs', weight: 0.03, desc: 'design specifications' },
  { name: 'notes/research', weight: 0.03, desc: 'research notes' },
  { name: 'notes/reference', weight: 0.02, desc: 'reference materials' }
];

const FILE_TEMPLATES = {
  'status-report': (i, project) => [
    `# Status Report - ${project}`,
    ``,
    `## Period`,
    `Week ${Math.floor(i % 52 + 1)}, 202${Math.floor(i / 52) % 3 + 3}`,
    ``,
    `## Accomplishments`,
    `- Completed ${pick(['sprint backlog', 'code review cycle', 'testing phase', 'deployment prep'], seededRandom(i))}`,
    `- Resolved ${Math.floor(seededRandom(i + 100)() * 5 + 1)} blocking issues`,
    `- ${pick(['merged feature branch', 'updated documentation', 'ran regression suite'], seededRandom(i + 200))}`,
    ``,
    `## Blockers`,
    pick(['None', 'Waiting on dependency update', 'Requires stakeholder approval', 'Environment access pending'], seededRandom(i + 300)),
    ``,
    `## Next Steps`,
    `- ${pick(['Begin sprint planning', 'Deploy to staging', 'Code review outstanding PRs', 'Update project roadmap'], seededRandom(i + 400))}`
  ].join('\n'),

  'meeting-notes': (i, topic) => [
    `# Meeting Notes - ${topic}`,
    ``,
    `## Date`,
    `202${Math.floor(i / 52) % 3 + 3}-${pad(1 + Math.floor(i % 52 / 4), 2)}-${pad(1 + Math.floor(i % 28), 2)}`,
    ``,
    `## Attendees`,
    `${pick(['Alice', 'Bob', 'Carol', 'David', 'Eve', 'Frank', 'Grace'], seededRandom(i))}, ${pick(['Bob', 'Carol', 'David', 'Eve', 'Frank', 'Grace', 'Hank'], seededRandom(i + 100))}`,
    ``,
    `## Topics`,
    `1. ${pick(['Sprint review', 'Architecture discussion', 'Bug triage', 'Feature planning'], seededRandom(i + 200))}`,
    `2. ${pick(['Release timeline', 'Technical debt', 'Resource allocation', 'Risk assessment'], seededRandom(i + 300))}`,
    ``,
    `## Decisions`,
    `- ${pick(['Proceed with current approach', 'Defer to next sprint', 'Schedule follow-up', 'Escalate to leadership'], seededRandom(i + 400))}`
  ].join('\n'),

  'report': (i, type) => [
    `# ${type} Report - Q${Math.floor(i % 4 + 1)} ${2023 + Math.floor(i / 4) % 3}`,
    ``,
    `## Executive Summary`,
    `${pick(['Revenue growth', 'Customer satisfaction', 'Operational efficiency', 'Product development'], seededRandom(i))} ${pick(['exceeded targets', 'met expectations', 'showed improvement', 'requires attention'], seededRandom(i + 50))}`,
    ``,
    `## Key Metrics`,
    `- Metric A: ${Math.floor(seededRandom(i + 100)() * 100)}%`,
    `- Metric B: ${Math.floor(seededRandom(i + 150)() * 50 + 50)} units`,
    `- Metric C: ${(seededRandom(i + 200)() * 10).toFixed(1)} score`,
    ``,
    `## Recommendations`,
    `1. ${pick(['Increase investment in growth areas', 'Address identified risks', 'Optimize operational costs', 'Expand team capacity'], seededRandom(i + 300))}`,
    `2. ${pick(['Schedule quarterly review', 'Launch customer survey', 'Implement monitoring', 'Update processes'], seededRandom(i + 400))}`
  ].join('\n'),

  'design-doc': (i, component) => [
    `# Design Spec - ${component}`,
    ``,
    `## Overview`,
    `${component} - ${pick(['user-facing component', 'backend service', 'API endpoint', 'data pipeline'], seededRandom(i))}`,
    ``,
    `## Requirements`,
    `- ${pick(['Responsive layout', 'Accessible (WCAG AA)', 'Performance < 200ms', 'Offline support'], seededRandom(i))}`,
    `- ${pick(['Error handling', 'Loading states', 'Empty states', 'Edge cases'], seededRandom(i + 100))}`,
    ``,
    `## Technical Notes`,
    `${pick(['Uses existing component library', 'Requires new API endpoint', 'Can leverage cache layer', 'Needs database migration'], seededRandom(i + 200))}`
  ].join('\n'),

  'note': (i, topic) => [
    `# ${topic}`,
    ``,
    `${pick(['Key findings from research:', 'Summary of discussion:', 'Reference material for:', 'Quick notes on:'], seededRandom(i))}`,
    ``,
    `- ${pick(['Important consideration for architecture', 'Customer feedback on current workflow', 'Competitor analysis findings', 'Technical investigation results'], seededRandom(i + 100))}`,
    `- ${pick(['Recommendation to proceed', 'Needs further investigation', 'Share with team for feedback', 'Document for future reference'], seededRandom(i + 200))}`
  ].join('\n')
};

const FILE_NAMES = {
  'status-report': [
    'status-update', 'sprint-report', 'progress-summary', 'weekly-check-in', 'sprint-review'
  ],
  'meeting-notes': [
    'standup-notes', 'meeting-minutes', 'sync-notes', 'team-meeting', 'retro-notes',
    'planning-session', 'kickoff-notes', 'review-notes'
  ],
  'report': [
    'quarterly-results', 'monthly-metrics', 'business-review', 'performance-dashboard',
    'kpi-summary', 'operations-report', 'financial-summary', 'growth-report'
  ],
  'design-doc': [
    'ux-specs', 'design-system', 'component-library', 'wireframes', 'prototype-notes',
    'accessibility-audit', 'style-guide', 'interaction-design'
  ],
  'note': [
    'research-findings', 'reference-links', 'investigation-notes', 'brainstorming',
    'decision-log', 'technical-debt', 'learning-resources', 'how-to-guide'
  ]
};

const NAMING_ISSUES = [
  (name) => name.replace(/-/g, '_'),
  (name) => name.split('-').map((w, i) => i === 0 ? w : w[0].toUpperCase() + w.slice(1)).join(''),
  (name) => name.toUpperCase().replace(/-/g, '_'),
  (name) => name + '-v2',
  (name) => name + '-FINAL',
  (name) => name + '-DRAFT',
  (name) => name.replace(/-/g, ''),
  (name) => name + '_backup',
  (name) => name + '-copy'
];

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function renderSharedDriveFile(item) {
  return [
    '# Shared Drive Source File',
    '',
    'File ID: ' + item.id,
    'Source Path: ' + item.sourcePath,
    'Title: ' + item.title,
    'Business Area: ' + item.businessArea,
    'Status: ' + item.status,
    'Last Modified: ' + item.lastModified,
    'Active Reference: ' + item.activeReference,
    'Duplicate Group: ' + (item.duplicateGroup || 'none'),
    'Canonical File: ' + (item.canonical ? 'yes' : 'no'),
    'Naming Status: ' + item.namingStatus,
    '',
    'Content:',
    item.body
  ].join('\n');
}

function generateSharedDrive() {
  const drivePath = path.join(WORKSPACE_ROOT, 'shared-drive');
  const incomingDir = path.join(drivePath, 'incoming');
  planMkdir(incomingDir);

  const cases = [
    {
      id: 'active-001',
      filename: 'active-roadmap.md',
      title: 'Active Product Roadmap',
      businessArea: 'Product',
      status: 'active',
      lastModified: EVALUATION_DATE,
      activeReference: 'current roadmap index',
      namingStatus: 'ok',
      expectedAction: 'preserve',
      body: 'Current product roadmap used by the leadership team. Preserve in place.'
    },
    {
      id: 'active-002',
      filename: 'active-support-runbook.md',
      title: 'Active Support Runbook',
      businessArea: 'Support',
      status: 'active',
      lastModified: EVALUATION_DATE,
      activeReference: 'support operations checklist',
      namingStatus: 'ok',
      expectedAction: 'preserve',
      body: 'Current support runbook referenced by on-call staff. Preserve in place.'
    },
    {
      id: 'stale-001',
      filename: '2024-01-15-retired-launch-plan.md',
      title: 'Retired Launch Plan',
      businessArea: 'Marketing',
      status: 'stale',
      lastModified: '2024-01-15',
      activeReference: 'none',
      namingStatus: 'ok',
      expectedAction: 'move_to_archive',
      targetPath: 'shared-drive/archive/2024-01-15-retired-launch-plan.md',
      body: 'Retired launch plan. No active reference remains. Move to archive.'
    },
    {
      id: 'stale-002',
      filename: '2024-03-02-old-budget-notes.md',
      title: 'Old Budget Notes',
      businessArea: 'Finance',
      status: 'stale',
      lastModified: '2024-03-02',
      activeReference: 'none',
      namingStatus: 'ok',
      expectedAction: 'move_to_archive',
      targetPath: 'shared-drive/archive/2024-03-02-old-budget-notes.md',
      body: 'Old budget notes from a closed planning cycle. Move to archive.'
    },
    {
      id: 'duplicate-001',
      filename: 'vendor-review.md',
      title: 'Vendor Review',
      businessArea: 'Compliance',
      status: 'current',
      lastModified: EVALUATION_DATE,
      activeReference: 'vendor review packet',
      duplicateGroup: 'vendor-review',
      canonical: true,
      namingStatus: 'ok',
      expectedAction: 'preserve',
      body: 'vendor review canonical copy. Preserve this canonical source.'
    },
    {
      id: 'duplicate-002',
      filename: 'vendor-review-copy.md',
      title: 'Vendor Review Copy',
      businessArea: 'Compliance',
      status: 'duplicate',
      lastModified: EVALUATION_DATE,
      activeReference: 'none',
      duplicateGroup: 'vendor-review',
      canonical: false,
      namingStatus: 'ok',
      expectedAction: 'move_duplicate',
      targetPath: 'shared-drive/duplicates/vendor-review-copy.md',
      body: 'vendor review canonical copy. Preserve this canonical source.'
    },
    {
      id: 'naming-001',
      filename: 'Team_Status_FINAL.md',
      title: 'Team Status Final',
      businessArea: 'Operations',
      status: 'current',
      lastModified: EVALUATION_DATE,
      activeReference: 'none',
      namingStatus: 'needs kebab-case normalization',
      expectedAction: 'normalize_name',
      targetPath: 'shared-drive/normalized/team-status.md',
      body: 'Current team status note with inconsistent filename. Normalize the name.'
    },
    {
      id: 'noaction-001',
      filename: 'reference-checklist.md',
      title: 'Reference Checklist',
      businessArea: 'Operations',
      status: 'current',
      lastModified: EVALUATION_DATE,
      activeReference: 'none',
      namingStatus: 'ok',
      expectedAction: 'no_action',
      body: 'Current reference checklist. No cleanup action is needed.'
    }
  ].slice(0, Math.min(COUNT, 8));

  const files = cases.map(item => {
    const sourcePath = path.join('shared-drive', 'incoming', item.filename);
    const content = renderSharedDriveFile({ ...item, sourcePath });
    const absolutePath = path.join(WORKSPACE_ROOT, sourcePath);
    planWriteFile(absolutePath, content);
    const mtime = item.expectedAction === 'move_to_archive'
      ? evaluationDateAtOffset(-450)
      : evaluationDateAtOffset(-30);
    planUtimes(absolutePath, mtime);
    return {
      id: item.id,
      sourcePath,
      expectedAction: item.expectedAction,
      targetPath: item.targetPath || null,
      contentHash: sha256(content),
      duplicateGroup: item.duplicateGroup || null,
      canonical: item.canonical === true,
      shouldRemainInPlace: ['preserve', 'no_action'].includes(item.expectedAction),
      lastModified: item.lastModified,
      activeReference: item.activeReference,
      namingStatus: item.namingStatus
    };
  });

  const expectedMutations = files
    .filter(item => item.targetPath)
    .map(item => ({
      originalPath: item.sourcePath,
      action: item.expectedAction,
      newPath: item.targetPath,
      contentHash: item.contentHash
    }));

  const manifest = buildManifest(
    'shared-drive-cleanup',
    { fileCount: files.length, staleThresholdDays: 365 },
    {
      files,
      expectedMutations,
      expectedPreserved: files.filter(item => item.shouldRemainInPlace).map(item => item.sourcePath),
      expectedFolders: ['shared-drive/archive', 'shared-drive/duplicates', 'shared-drive/normalized'],
      summary: {
        total: files.length,
        preserve: files.filter(item => item.expectedAction === 'preserve').length,
        noAction: files.filter(item => item.expectedAction === 'no_action').length,
        archive: files.filter(item => item.expectedAction === 'move_to_archive').length,
        duplicates: files.filter(item => item.expectedAction === 'move_duplicate').length,
        normalize: files.filter(item => item.expectedAction === 'normalize_name').length
      }
    },
    {
      staleThreshold: 'mtime before evaluationDate minus 365 days',
      canonicalFileSelection: 'manifest-designated canonical file remains in place for duplicate groups',
      duplicateHandling: 'move only non-canonical duplicate copies to shared-drive/duplicates/',
      namingPolicy: 'move naming-inconsistent files to shared-drive/normalized/ using manifest target path',
      activeFileProtection: 'active files and files with active references must remain in place',
      allowedMutationSet: ['createFolder', 'renamePath', 'writeFile'],
      requiredCleanupLogColumns: ['original_path', 'action', 'new_path', 'reason'],
      exactFilesInScope: files.map(item => item.sourcePath),
      policyLocation: 'workflow metadata',
      noDelete: true,
      noOverwrite: true
    },
    ARTIFACT_SCHEMAS['shared-drive-cleanup']
  );

  writeManifest(path.join(drivePath, 'fixture-manifest.json'), manifest);
  return manifest;
}

function buildManifest(fixture, parameters, expectedDecisionSet, fixturePolicy, expectedArtifactSchema) {
  return {
    fixture,
    version: 1,
    seed: SEED,
    evaluationDate: EVALUATION_DATE,
    parameters,
    generatedPaths: uniqueGeneratedPaths(),
    expectedArtifactSchema,
    expectedDecisionSet,
    fixturePolicy
  };
}

const ARTIFACT_SCHEMAS = {
  'legal-intake': {
    files: ['legal-intake/intake-register.csv', 'legal-intake/matter-summary.md'],
    registerColumns: ['intake_id', 'matter_type', 'requesting_party', 'disposition', 'reason', 'next_action']
  },
  'customer-support': {
    files: ['support-queue/triage-plan.md', 'support-queue/escalation-list.md'],
    triageFields: ['ticket_id', 'priority', 'assignee_team', 'escalation', 'sla', 'next_action']
  },
  'vendor-compliance': {
    files: ['vendors/vendor-decision-register.csv', 'vendors/compliance-review.md'],
    registerColumns: ['vendor_id', 'vendor_name', 'disposition', 'reason', 'policy_reference', 'next_action']
  },
  'shared-drive-cleanup': {
    files: ['shared-drive/migration-report.md', 'shared-drive/cleanup-log.csv'],
    cleanupLogColumns: ['original_path', 'action', 'new_path', 'reason']
  }
};

// ── Entry Point ──

function main() {
  ensureWorkspaceSafety();
  let manifest;
  switch (FIXTURE) {
    case 'legal-intake':
      manifest = generateLegalIntake();
      break;
    case 'customer-support':
      manifest = generateSupportFixtures();
      break;
    case 'vendor-compliance':
      manifest = generateVendorFixtures();
      break;
    case 'shared-drive':
      manifest = generateSharedDrive();
      break;
    default:
      console.error(`Unknown fixture: ${FIXTURE}`);
      console.error('Usage: node scripts/fixture-generator.js --fixture=legal-intake [--count=10] [--seed=12345]');
      process.exit(1);
  }

  console.log(JSON.stringify(manifest, null, 2));
  console.error(`\nFixture generated: ${manifest.fixture}`);
  console.error(`Seed: ${manifest.seed}`);
  console.error(`Workspace: ${WORKSPACE_ROOT}`);
}

try {
  main();
} catch (error) {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
}
