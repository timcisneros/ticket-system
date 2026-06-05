#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

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
const COUNT = parseInt(args.count, 10) || 10;
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
    matterType: 'NDA Review',
    requestingParty: 'Beta Industries',
    contactEmail: 'procurement@beta.example.com',
    jurisdiction: 'California, USA',
    businessUnit: 'Procurement',
    description: 'Review mutual NDA for vendor evaluation and product roadmap discussions.',
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

const CUSTOMER_TIERS = ['Standard', 'Premium', 'Enterprise'];
const TICKET_CATEGORIES = ['Bug', 'Question', 'Feature Request', 'Incident'];
const TEAMS = ['Engineering', 'Customer Success', 'Product', 'Security', 'On-Call'];

const TICKET_TITLES = {
  'Bug': [
    'Login button unresponsive on Safari',
    'Export CSV missing column headers',
    'Dashboard widget not loading data',
    'Email notification sending duplicate alerts',
    'Search results return stale cached entries'
  ],
  'Question': [
    'How do I reset my API key?',
    'What is the rate limit for the public API?',
    'Can you explain the billing cycle?',
    'How do I invite team members to my workspace?',
    'What file formats are supported for import?'
  ],
  'Feature Request': [
    'Add dark mode support',
    'Webhook integration for Slack notifications',
    'Batch operations in the admin panel',
    'Export to PDF with custom templates',
    'Role-based access control for reports'
  ],
  'Incident': [
    'Service is down for all users in EU region',
    'Possible data leak in audit logs',
    'Payment processing failing intermittently',
    'Login page returns 502 error',
    'Customer data not persisting after save'
  ]
};

function buildSupportTicket(index, rand) {
  const category = pick(TICKET_CATEGORIES, rand);
  const tier = pick(CUSTOMER_TIERS, rand);
  const isEnterprise = tier === 'Enterprise';
  const isP1 = category === 'Incident' || (isEnterprise && rand() < 0.4);
  const title = pick(TICKET_TITLES[category], rand);

  const lines = [
    `# Support Ticket`,
    ``,
    `## Title`,
    title,
    ``,
    `## Category`,
    category,
    ``,
    `## Customer Tier`,
    tier,
    ``,
    `## Description`,
    generateTicketDescription(category, title, rand),
    ``,
    `## Reported By`,
    pick(['end-user@client.com', 'tech-lead@client.com', 'ops-manager@client.com', 'ceo@enterprise-client.com'], rand),
    ``,
    `## Timestamp`,
    toIsoFromEvaluation(-Math.floor(rand() * 86400000 * 7))
  ];

  const expectedPriority = isP1 ? 'P1' : (category === 'Bug' ? 'P2' : 'P3');
  const expectedTeam = isP1 ? 'On-Call' :
    category === 'Bug' ? 'Engineering' :
    category === 'Question' ? 'Customer Success' : 'Product';
  const needsEscalation = isP1;

  return {
    title,
    category,
    tier,
    priority: expectedPriority,
    team: expectedTeam,
    needsEscalation,
    content: lines.join('\n')
  };
}

function generateTicketDescription(category, title, rand) {
  if (category === 'Bug') {
    return `Steps to reproduce:\n1. Go to ${pick(['settings page', 'dashboard', 'reports tab'], rand)}\n2. Click ${pick(['save', 'submit', 'export', 'refresh'], rand)}\n3. Error message appears: "${pick(['Internal error', 'Timeout', 'Access denied', 'Invalid response'], rand)}"\n\nExpected: Action completes successfully.\nActual: ${pick(['Nothing happens', 'Wrong data displayed', 'Page crashes', 'Spinner spins forever'], rand)}.`;
  }
  if (category === 'Question') {
    return `I've looked through the docs but couldn't find clear guidance on this. Can you help? We're on the ${pick(['Professional', 'Enterprise', 'Starter'], rand)} plan.`;
  }
  if (category === 'Feature Request') {
    return `This would greatly improve our workflow. Our team of ${Math.floor(rand() * 100 + 5)} users would benefit from this capability. Happy to join a beta.`;
  }
  return `Impact: ${pick(['All users affected', 'Partial outage (EU region)', 'Single customer', 'Degraded performance'], rand)}.\n\nCurrent status: ${pick(['Investigating', 'Not yet reproducible', 'Ongoing', 'Newly reported'], rand)}.\n\n${isP1Indicator(title) ? 'URGENT: This appears to affect customer-facing functionality.' : 'Please advise on next steps.'}`;
}

function isP1Indicator(title) {
  return /down|data leak|502|fail|not persist|outage/i.test(title);
}

function generateSupportFixtures() {
  const fixtureDir = path.join(WORKSPACE_ROOT, 'support-inbox');
  planMkdir(fixtureDir);

  const rand = seededRandom(SEED);
  const tickets = [];
  for (let i = 1; i <= COUNT; i++) {
    const ticket = buildSupportTicket(i, rand);
    const filename = `ticket-${pad(i, 3)}.md`;
    const filepath = path.join(fixtureDir, filename);
    planWriteFile(filepath, ticket.content);
    tickets.push({ filename, ...ticket });
  }

  const manifest = buildManifest(
    'customer-support',
    { count: COUNT },
    {
      files: tickets.map(t => ({
        sourcePath: path.join('support-inbox', t.filename),
        expectedPriority: t.priority,
        expectedTeam: t.team,
        needsEscalation: t.needsEscalation
      })),
      summary: {
        p1: tickets.filter(t => t.priority === 'P1').length,
        p2: tickets.filter(t => t.priority === 'P2').length,
        p3: tickets.filter(t => t.priority === 'P3').length
      }
    },
    {
      prioritySet: ['P1', 'P2', 'P3'],
      sourcePreservation: true,
      note: 'Content scenarios are not yet fully aligned with BUSINESS_FIXTURE_SPEC.md edge-case requirements.'
    },
    ARTIFACT_SCHEMAS['customer-support']
  );

  const manifestPath = path.join(fixtureDir, 'fixture-manifest.json');
  writeManifest(manifestPath, manifest);

  return manifest;
}

// ── Vendor Compliance Fixture ──

const VENDOR_NAMES = [
  'CloudHost Inc', 'DataSync Corp', 'SecureMail Ltd', 'AnalyticsPro',
  'InfraServe', 'LogiStack', 'CertiVault', 'NetBridge', 'ComplyFirst', 'ZenData'
];

const CERT_TYPES = ['SOC2 Type II', 'ISO 27001', 'HIPAA', 'PCI DSS', 'FedRAMP'];

function generateVendorFixtures() {
  const fixtureDir = path.join(WORKSPACE_ROOT, 'vendors');
  const incomingDir = path.join(fixtureDir, 'incoming');
  const policiesDir = path.join(fixtureDir);
  planMkdir(incomingDir);

  const rand = seededRandom(SEED);

  const vendorResults = [];

  for (let i = 0; i < COUNT && i < VENDOR_NAMES.length; i++) {
    const vendorDir = path.join(incomingDir, `vendor-${pad(i + 1, 3)}`);
    planMkdir(vendorDir);

    const vendorName = VENDOR_NAMES[i];
    const hasCert = rand() < COMPLETE_RATE;
    const certExpired = hasCert && rand() < 0.3;
    const hasIncident = rand() < 0.15;
    const certType = pick(CERT_TYPES, rand);

    const profile = [
      `# Vendor Profile: ${vendorName}`,
      ``,
      `## Legal Name`,
      `${vendorName}`,
      ``,
      `## DBA`,
      pick([vendorName, `${vendorName} Technologies`, `${vendorName} Global`], rand),
      ``,
      `## Tax ID`,
      `${pad(Math.floor(rand() * 100000000), 9)}`,
      ``,
      `## Services`,
      pick([
        'Cloud infrastructure, managed hosting, CDN',
        'Data pipeline, ETL, analytics storage',
        'Email security, encryption, archiving',
        'Business intelligence, dashboards, reporting',
        'IT infrastructure monitoring and alerting'
      ], rand),
      ``,
      `## Point of Contact`,
      `${pick(['Alice', 'Bob', 'Carol', 'David', 'Eve'], rand)} ${pick(['Johnson', 'Williams', 'Brown', 'Jones', 'Garcia'], rand)}`,
      ``,
      `## Contact Email`,
      `vendor-ops@${vendorName.toLowerCase().replace(/[^a-z]/g, '')}.com`,
      ``,
      `## Vendor Since`,
      `${2018 + Math.floor(rand() * 6)}-${pad(1 + Math.floor(rand() * 12), 2)}-01`,
      ``,
      `## Annual Spend`,
      `$${Math.floor(rand() * 500 + 50)}K`
    ].join('\n');

    const dpa = [
      `# Data Processing Agreement`,
      ``,
      `## Parties`,
      `Customer (Controller) and ${vendorName} (Processor)`,
      ``,
      `## Effective Date`,
      `${2020 + Math.floor(rand() * 4)}-${pad(1 + Math.floor(rand() * 12), 2)}-01`,
      ``,
      `## Data Categories`,
      `Customer name, email, organization, usage logs, billing history`,
      ``,
      `## Processing Location`,
      pick(['US-East', 'EU-West', 'US-West, EU-West', 'APAC-Southeast', 'Global (multi-region)'], rand),
      ``,
      `## Subprocessors`,
      pick([
        'AWS, GCP',
        'Azure, DigitalOcean',
        'AWS only',
        'None listed',
        'AWS, GCP, Cloudflare'
      ], rand),
      ``,
      `## Security Measures`,
      `Encryption at rest (AES-256), encryption in transit (TLS 1.3), quarterly penetration testing, SOC2 annual audit`
    ].join('\n');

    let certContent = '# Security Certification\n\nNot provided.\n';
    let certExpiry = null;
    if (hasCert) {
      const issueYear = 2022 + Math.floor(rand() * 3);
      const expiryYear = certExpired ? 2024 + Math.floor(rand() * 2) : 2026 + Math.floor(rand() * 2);
      certExpiry = `${expiryYear}-${pad(1 + Math.floor(rand() * 12), 2)}-${pad(1 + Math.floor(rand() * 28), 2)}`;
      certContent = [
        `# Security Certification: ${certType}`,
        ``,
        `## Issued By`,
        pick(['A-LIGN', 'Bureau Veritas', 'Schellman', 'Coalfire', 'Prescient Security'], rand),
        ``,
        `## Issue Date`,
        `${issueYear}-${pad(1 + Math.floor(rand() * 12), 2)}-01`,
        ``,
        `## Expiry Date`,
        certExpiry,
        ``,
        `## Scope`,
        pick([
          'All systems and services',
          'Core platform and API',
          'Infrastructure and data storage',
          'Customer-facing applications'
        ], rand),
        ``,
        `## Status`,
        certExpired ? 'Expired' : 'Active'
      ].join('\n');
    }

    let incidentContent = null;
    if (hasIncident) {
      incidentContent = [
        `# Security Incident Report`,
        ``,
        `## Date Discovered`,
        `${2025}-${pad(1 + Math.floor(rand() * 12), 2)}-${pad(1 + Math.floor(rand() * 28), 2)}`,
        ``,
        `## Severity`,
        pick(['Low', 'Medium', 'High'], rand),
        ``,
        `## Description`,
        pick([
          'Unauthorized access to staging environment by external IP scan',
          'Employee credentials found in public code repository',
          'Misconfigured S3 bucket exposed test data',
          'Phishing campaign targeting vendor employees'
        ], rand),
        ``,
        `## Status`,
        pick(['Resolved', 'In Progress', 'Under Review'], rand),
        ``,
        `## Remediation`,
        pick([
          'Access revoked, environment hardened, monitoring added',
          'Credentials rotated, repo scanned, employee training updated',
          'Bucket locked, access logs reviewed, no customer data exposed',
          'Campaign blocked, affected accounts notified, filters updated'
        ], rand)
      ].join('\n');
    }

    const isComplete = hasCert && !certExpired && !hasIncident;
    const expectedDisposition = !hasCert ? 'Reject (missing security certification)' :
      certExpired ? 'Conditional Approve (certification expired)' :
      hasIncident ? 'Conditional Approve (active security incident under review)' :
      'Approve';

    const files = { 'vendor-profile.md': profile, 'dpa.md': dpa, 'security-cert.md': certContent };
    if (incidentContent) {
      files['incident-report.md'] = incidentContent;
    }

    for (const [fname, fcontent] of Object.entries(files)) {
      planWriteFile(path.join(vendorDir, fname), fcontent);
    }

    vendorResults.push({
      vendorId: `vendor-${pad(i + 1, 3)}`,
      vendorName,
      hasCert,
      certExpired,
      hasIncident,
      isComplete,
      expectedDisposition
    });
  }

  const policyContent = [
    `# Vendor Onboarding Policy`,
    ``,
    `## Required Documents`,
    `1. Vendor profile (vendor-profile.md)`,
    `2. Data Processing Agreement (dpa.md)`,
    `3. Security certification (security-cert.md) — must be valid and current`,
    ``,
    `## Approval Rules`,
    ``,
    `### Approve`,
    `All required documents present, certification is current (not expired), and no active security incidents.`,
    ``,
    `### Conditional Approve`,
    `- Certification is expired but all other documents present → recommend recertification within 90 days`,
    `- Active security incident under review → approve with monitoring condition`,
    `- Minor documentation gaps → approve subject to remediation`,
    ``,
    `### Reject`,
    `- Missing required document(s)`,
    `- Major compliance gap (no certification, no DPA)`,
    `- Vendor declined to provide required documentation`,
    ``,
    `## Review Period`,
    `Standard: 30 days. Conditional approvals: 90 day remediation window.`
  ].join('\n');
  planWriteFile(path.join(policiesDir, 'vendor-onboarding-policy.md'), policyContent);

  const manifest = buildManifest(
    'vendor-compliance',
    { vendorCount: COUNT, completeRate: COMPLETE_RATE },
    {
      files: vendorResults.map(v => ({
        sourcePath: path.join('vendors', 'incoming', v.vendorId),
        vendorId: v.vendorId,
        vendorName: v.vendorName,
        expectedDisposition: v.expectedDisposition,
        isComplete: v.isComplete,
        hasCert: v.hasCert,
        certExpired: v.certExpired,
        hasIncident: v.hasIncident
      }))
    },
    {
      policyFiles: ['vendors/vendor-onboarding-policy.md'],
      dispositionSet: ['Approve', 'Conditional Approve', 'Reject'],
      sourcePreservation: true,
      note: 'Content scenarios are not yet fully aligned with BUSINESS_FIXTURE_SPEC.md policy and edge-case requirements.'
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

function generateSharedDrive() {
  const drivePath = path.join(WORKSPACE_ROOT, 'shared-drive');
  const rand = seededRandom(SEED);
  const fileCount = parseInt(args['file-count'], 10) || 500;
  const duplicateRate = parseFloat(args['duplicate-rate']) || 0.15;
  const staleRate = parseFloat(args['stale-rate']) || 0.2;
  const namingIssueRate = parseFloat(args['naming-rate']) || 0.1;

  // Build cumulative weight table for dir selection
  const totalWeight = DRIVE_DIRS.reduce((s, d) => s + d.weight, 0);
  let cumWeight = 0;
  for (const dir of DRIVE_DIRS) {
    cumWeight += dir.weight;
    dir.cumWeight = cumWeight / totalWeight;
  }
  function pickDir(r) {
    for (const dir of DRIVE_DIRS) {
      if (r <= dir.cumWeight) return dir.name;
    }
    return DRIVE_DIRS[DRIVE_DIRS.length - 1].name;
  }

  // Create directory structure
  for (const dir of DRIVE_DIRS) {
    planMkdir(path.join(drivePath, dir.name));
  }

  // Generate files
  const fileTemplates = Object.keys(FILE_TEMPLATES);
  const allFiles = [];

  for (let i = 0; i < fileCount; i++) {
    const dir = pickDir(rand());
    const type = pick(fileTemplates, rand);
    const nameBase = pick(FILE_NAMES[type] || ['file'], rand);
    const ext = pick(['.md', '.txt', '.md'], rand);

    const contentFn = FILE_TEMPLATES[type];
    const projectNames = ['alpha', 'beta', 'gamma', 'delta', 'platform', 'mobile', 'api', 'web'];
    const topicNames = ['Design Review', 'Sprint Planning', 'Architecture Sync', 'Bug Triage', 'Release Planning',
      'Customer Research', 'Technical Spec', 'Performance Review'];
    const reportTypes = ['Quarterly', 'Monthly', 'Annual', 'Operational'];

    const project = pick(projectNames, rand);
    const topic = pick(topicNames, rand);
    const reportType = pick(reportTypes, rand);
    const component = pick(['Header', 'Footer', 'Sidebar', 'Search', 'Dashboard', 'Settings', 'Profile'], rand);

    let content;
    if (type === 'status-report') content = contentFn(i, project);
    else if (type === 'meeting-notes') content = contentFn(i, topic);
    else if (type === 'report') content = contentFn(i, reportType);
    else if (type === 'design-doc') content = contentFn(i, component);
    else content = contentFn(i, topic);

    // Determine if this file is stale
    const isStale = rand() < staleRate;
    const isDuplicateSource = !isStale && rand() < duplicateRate;
    const hasNamingIssue = !isStale && !isDuplicateSource && rand() < namingIssueRate;

    let filename = `${nameBase}-${pad(i + 1, 4)}${ext}`;
    if (hasNamingIssue) {
      const issueFn = pick(NAMING_ISSUES, rand);
      filename = `${issueFn(nameBase)}-${pad(i + 1, 4)}${ext}`;
    }

    // For stale files, use dated filenames
    const staleDate = `${2023 + Math.floor(rand() * 2)}-${pad(1 + Math.floor(rand() * 12), 2)}-${pad(1 + Math.floor(rand() * 28), 2)}`;
    if (isStale) {
      filename = `${staleDate}_${filename}`;
    }

    const filepath = path.join(drivePath, dir, filename);
    planWriteFile(filepath, content);

    // Set mtime for stale files to >12 months ago
    if (isStale) {
      const pastDate = evaluationDateAtOffset(-365 - Math.floor(rand() * 365));
      planUtimes(filepath, pastDate);
    }

    allFiles.push({
      dir,
      type,
      filename,
      nameBase,
      content,
      isStale,
      isDuplicateSource,
      hasNamingIssue,
      filepath
    });
  }

  // Create duplicates (same content, different names)
  const duplicateTargets = allFiles.filter(f => f.isDuplicateSource);
  const duplicates = [];
  for (const source of duplicateTargets) {
    const dupName = `${source.nameBase}-copy-${pad(Math.floor(rand() * 9999), 4)}.md`;
    const dupDir = pickDir(rand());
    const dupPath = path.join(drivePath, dupDir, dupName);
    planWriteFile(dupPath, source.content);
    duplicates.push({
      sourceDir: source.dir,
      sourceFilename: source.filename,
      dupDir,
      dupFilename: dupName
    });
  }

  const manifest = buildManifest(
    'shared-drive-cleanup',
    { fileCount, duplicateRate, staleRate, namingIssueRate },
    {
      files: allFiles.map(f => ({
        sourcePath: path.join('shared-drive', f.dir, f.filename),
        type: f.type,
        isStale: f.isStale,
        isDuplicateSource: f.isDuplicateSource,
        hasNamingIssue: f.hasNamingIssue
      })),
      duplicates,
      activeFiles: allFiles.filter(f => f.dir === 'active' && !f.isStale).map(f => ({
        path: path.join('shared-drive', f.dir, f.filename)
      })),
      summary: {
        total: allFiles.length,
        stale: allFiles.filter(f => f.isStale).length,
        hasNamingIssue: allFiles.filter(f => f.hasNamingIssue).length,
        duplicatePairs: duplicates.length
      }
    },
    {
      directories: DRIVE_DIRS.map(d => d.name),
      canonicalFileSelection: 'first generated source file is canonical for each duplicate pair',
      staleThreshold: 'mtime before evaluationDate minus 365 days',
      duplicateHandling: 'duplicate copies are candidates for duplicates folder; source files are canonical',
      namingPolicy: 'normalize selected naming variants to kebab-case when the cleanup task requests mutation',
      allowedMutationSet: ['createFolder', 'renamePath'],
      exactFilesInScope: allFiles.map(f => path.join('shared-drive', f.dir, f.filename)).concat(duplicates.map(d => path.join('shared-drive', d.dupDir, d.dupFilename))),
      note: 'Content scenarios are not yet fully aligned with BUSINESS_FIXTURE_SPEC.md scale and policy requirements.'
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
