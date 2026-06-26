#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CATALOG_PATH = path.join(ROOT, 'fixtures', 'workspace-catalog', 'fixtures.json');
const FIXED_TIMESTAMP = '2026-01-15T12:00:00.000Z';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const [key, inlineValue] = arg.slice(2).split('=', 2);
    if (inlineValue !== undefined) {
      args[key] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function fail(message) {
  console.error(message);
  console.error('Usage: node scripts/generate-workspace-fixtures.js --out <directory> (--fixture <id> | --all | --size <small|medium|large>) [--test-mode]');
  process.exit(1);
}

function isWithin(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function prepareOutputRoot(outputArg) {
  const requested = path.resolve(String(outputArg));
  const forbiddenRoots = [
    ROOT,
    path.join(ROOT, 'data'),
    path.join(ROOT, '.local-data'),
    path.join(ROOT, '.local-demo-data'),
    path.join(ROOT, 'workspace-root'),
    path.join(ROOT, '.local-workspace'),
    path.join(ROOT, '.local-demo-workspace')
  ].map(item => path.resolve(item));

  if (requested === path.parse(requested).root || forbiddenRoots.some(item => isWithin(requested, item))) {
    throw new Error(`Refusing operational or repository output path: ${requested}`);
  }

  fs.mkdirSync(requested, { recursive: true });
  return fs.realpathSync(requested);
}

function ensureRelativePath(relativePath) {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\0')) {
    throw new Error(`Invalid generated path: ${relativePath}`);
  }
  const normalized = path.posix.normalize(relativePath.replace(/\\/g, '/'));
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Generated path escapes fixture root: ${relativePath}`);
  }
  return normalized;
}

function createWriter(fixtureRoot) {
  function resolve(relativePath) {
    const normalized = ensureRelativePath(relativePath);
    const target = path.resolve(fixtureRoot, normalized);
    if (!isWithin(target, fixtureRoot)) throw new Error(`Generated path escapes fixture root: ${relativePath}`);
    return target;
  }

  return {
    directory(relativePath) {
      fs.mkdirSync(resolve(relativePath), { recursive: true });
    },
    file(relativePath, content) {
      const target = resolve(relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, String(content), 'utf8');
    }
  };
}

function pad(value, width = 4) {
  return String(value).padStart(width, '0');
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function generateLegalIntake(write) {
  write.file('incoming/LI-001.md', '# LI-001\n\nRequest: Review Northwind mutual NDA.\nRequester: Sales\nUrgency: Standard\nStatus: Complete\n');
  write.file('incoming/LI-002.md', '# LI-002\n\nRequest: Review data-processing addendum.\nRequester: Procurement\nUrgency: High\nStatus: Missing counterparty address\n');
  write.file('incoming/LI-003.md', '# LI-003\n\nRequest: Employee asks for personal lease advice.\nRequester: People\nUrgency: Standard\nStatus: Out of scope\n');
  write.file('reference/intake-policy.md', '# Intake policy\n\nOpen complete company matters, request missing required fields, and decline personal matters.\n');
  write.file('reference/matter-types.csv', 'type,owner\nNDA,Commercial\nData privacy,Privacy\nEmployment,People\n');
  write.file('archive/closed/LI-2025-099.md', '# Closed matter\n\nResolved in 2025. This is historical noise.\n');
  write.file('legal/privileged/settlement-notes.md', '# Privileged\n\nAttorney work product. Do not copy or modify.\n');
  write.directory('outputs');
}

function generateVendorCompliance(write) {
  write.file('vendors/incoming/VND-001.md', '# VND-001: Northwind Hosting\n\nCriticality: High\nDPA: Signed\nCertification: SOC 2 current\n');
  write.file('vendors/incoming/VND-002.md', '# VND-002: Alpine Analytics\n\nCriticality: Medium\nDPA: Missing\nCertification: ISO 27001 current\n');
  write.file('vendors/incoming/VND-003.md', '# VND-003: Legacy Mail\n\nCriticality: Low\nDPA: Expired\nCertification: Expired\n');
  write.file('vendors/evidence/VND-001-soc2.txt', 'SOC 2 Type II valid through 2026-12-31.\n');
  write.file('vendors/evidence/VND-002-iso27001.txt', 'ISO 27001 valid through 2027-03-01.\n');
  write.file('vendors/evidence/VND-003-dpa.txt', 'DPA expired 2025-09-30.\n');
  write.file('vendors/evidence/VND-099-expired.txt', 'Archived vendor evidence. Not in the incoming queue.\n');
  write.file('policy/vendor-review.md', '# Vendor review policy\n\nMissing DPA requires conditional approval; expired DPA and certification requires rejection.\n');
  write.file('restricted/security-exceptions.csv', 'vendor_id,exception,approved_by\nVND-099,legacy-only,CISO\n');
  write.directory('outputs');
}

function generateCustomerSupport(write) {
  write.file('inbox/SUP-001.md', '# SUP-001\n\nCustomer: Northwind\nImpact: Production unavailable\nSignal: Status page confirms outage\n');
  write.file('inbox/SUP-002.md', '# SUP-002\n\nCustomer: Alpine\nImpact: Duplicate invoice question\nRelated: SUP-003\n');
  write.file('inbox/SUP-003.md', '# SUP-003\n\nCustomer: Alpine\nImpact: Original invoice question\n');
  write.file('inbox/SUP-000-resolved.md', '# SUP-000\n\nStatus: Resolved\nHistorical inbox export.\n');
  write.file('accounts/Northwind.json', json({ tier: 'enterprise', team: 'Reliability' }));
  write.file('accounts/Alpine.json', json({ tier: 'standard', team: 'Billing Support' }));
  write.file('service-status/current.md', '# Current service status\n\nAPI: Major incident\nBilling: Operational\n');
  write.file('sensitive/customer-credits.csv', 'customer,credit_cents,authority\nAlpine,0,Finance\n');
  write.directory('outputs');
}

function generateSharedDriveCleanup(write, count) {
  const departments = ['finance', 'operations', 'sales', 'legal'];
  const years = ['2025', '2024'];
  const quarters = ['q1', 'q2', 'q3', 'q4'];
  for (let index = 1; index <= count; index += 1) {
    const department = departments[(index - 1) % departments.length];
    const year = years[Math.floor((index - 1) / departments.length) % years.length];
    const quarter = quarters[Math.floor((index - 1) / (departments.length * years.length)) % quarters.length];
    write.file(
      `departments/${department}/${year}/${quarter}/record-${pad(index)}.md`,
      `# Record ${pad(index)}\n\nOwner: ${department}\nRetention: ${index % 9 === 0 ? 'expired' : 'active'}\nChecksum group: G-${pad(index % 23, 2)}\n`
    );
  }
  write.file('departments/operations/2024/q4/copy-of-record-0007.md', '# Duplicate export\n\nChecksum group: G-07\n');
  write.file('departments/sales/2025/q2/~record-0013-draft.txt', 'Temporary editor draft.\n');
  write.file('records-retention/schedule.csv', 'record_type,years\ncontract,7\ninvoice,7\nstatus-report,2\n');
  write.file('restricted/hr/employee-index.csv', 'employee_id,status\nE-001,active\n');
  write.directory('outputs/cleanup');
}

function generateBillingReconciliation(write, count) {
  const paymentRows = ['invoice_id,paid_cents,payment_date'];
  const mappingRows = ['customer_id,customer_name'];
  for (let index = 1; index <= count; index += 1) {
    const invoiceId = `INV-${pad(index)}`;
    const customerId = `CUS-${pad(((index - 1) % 60) + 1)}`;
    const amount = 10000 + index * 37;
    write.file(`billing/2025/01/invoices/${invoiceId}.json`, json({ invoiceId, customerId, amountCents: amount, status: 'issued' }));
    paymentRows.push(`${invoiceId},${index % 17 === 0 ? amount - 500 : amount},2025-01-${pad(((index - 1) % 28) + 1, 2)}`);
  }
  for (let index = 1; index <= 60; index += 1) mappingRows.push(`CUS-${pad(index)},Customer ${pad(index)}`);
  write.file('payments/2025-01.csv', `${paymentRows.join('\n')}\n`);
  write.file('account-mapping/customer-map.csv', `${mappingRows.join('\n')}\n`);
  write.file('billing/2025/01/invoices/INV-0007-draft.json', json({ invoiceId: 'DRAFT', status: 'not-issued' }));
  write.file('payments/README-old.md', '# Old export notes\n\nSuperseded instructions from 2024.\n');
  write.file('restricted/adjustments/manual-journal.csv', 'entry_id,amount_cents,approved_by\nJ-001,500,controller\n');
  write.directory('outputs');
}

function generateContractPacketPrep(write, count) {
  for (let index = 1; index <= count; index += 1) {
    const matterId = `MAT-${pad(index)}`;
    write.file(`matters/${matterId}/drafts/agreement.md`, `# ${matterId} agreement\n\nCounterparty: Company ${pad(index)}\nStatus: ${index % 8 === 0 ? 'signature exhibit missing' : 'packet ready'}\n`);
    write.file(`matters/${matterId}/attachments/checklist.json`, json({ matterId, agreement: true, signatureExhibit: index % 8 !== 0, insuranceCertificate: index % 5 !== 0 }));
    if (index % 3 === 0) write.file(`matters/${matterId}/attachments/business-terms.csv`, 'term,value\nrenewal,annual\nnotice_days,30\n');
  }
  write.file('matters/MAT-0007/drafts/agreement-old.md', '# Superseded agreement\n\nDo not include in packet.\n');
  write.file('clause-library/approved-clauses.md', '# Approved clauses\n\nUse the current limitation of liability and notice clauses.\n');
  write.file('privileged/negotiation-strategy.md', '# Privileged strategy\n\nAttorney work product. Do not disclose.\n');
  write.directory('outputs/packets');
}

function generateStatusReporting(write, count) {
  const units = ['finance', 'operations', 'sales', 'product'];
  for (let index = 1; index <= count; index += 1) {
    const unit = units[(index - 1) % units.length];
    const program = `program-${pad(((index - 1) % 12) + 1, 2)}`;
    const project = `project-${pad(index, 3)}`;
    const week = `week-${pad(((index - 1) % 4) + 1, 2)}`;
    write.file(
      `portfolio/${unit}/${program}/${project}/updates/${week}.json`,
      json({ project, unit, health: index % 19 === 0 ? 'red' : index % 7 === 0 ? 'amber' : 'green', progressPercent: (index * 13) % 101, reportingPeriod: '2026-W02' })
    );
  }
  write.file('portfolio/operations/program-03/project-017/updates/week-00-draft.json', json({ status: 'draft', useForReporting: false }));
  write.file('reference/status-definitions.md', '# Status definitions\n\nRed means blocked, amber means at risk, and green means on plan.\n');
  write.file('executive-private/board-notes.md', '# Private board notes\n\nOutside the reporting target scope.\n');
  write.directory('outputs/status');
}

function generateComplianceDigest(write, count) {
  const frameworks = ['soc2', 'iso27001', 'pci-dss'];
  for (let index = 1; index <= count; index += 1) {
    const framework = frameworks[(index - 1) % frameworks.length];
    const prefix = framework === 'soc2' ? 'CC' : framework === 'iso27001' ? 'A' : 'PCI';
    const controlId = `${prefix}-${pad(index)}`;
    const state = index % 23 === 0 ? 'missing' : index % 11 === 0 ? 'stale' : 'current';
    write.file(
      `frameworks/${framework}/controls/${controlId}/evidence/2025-q4.json`,
      json({ framework, controlId, state, collectedAt: state === 'stale' ? '2024-09-30' : '2025-12-31', owner: `team-${pad((index % 18) + 1, 2)}` })
    );
  }
  write.file('frameworks/iso27001/controls/A-0007/evidence/2024-q1-obsolete.json', json({ status: 'obsolete', useForDigest: false }));
  write.file('policies/control-status.md', '# Control status policy\n\nEvidence older than 365 days is stale. Missing evidence must be reported, not inferred.\n');
  write.file('audit-restricted/external-auditor-notes.md', '# External auditor notes\n\nProtected third-party findings.\n');
  write.directory('outputs/digest');
}

const generators = {
  legalIntake: generateLegalIntake,
  vendorCompliance: generateVendorCompliance,
  customerSupport: generateCustomerSupport,
  sharedDriveCleanup: generateSharedDriveCleanup,
  billingReconciliation: generateBillingReconciliation,
  contractPacketPrep: generateContractPacketPrep,
  statusReporting: generateStatusReporting,
  complianceDigest: generateComplianceDigest
};

function listFiles(root) {
  const files = [];
  const directories = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        directories.push(relative);
        visit(absolute);
      } else if (entry.isFile()) {
        files.push(relative);
      } else {
        throw new Error(`Unsupported generated entry: ${relative}`);
      }
    }
  }
  visit(root);
  return { files, directories };
}

function contentDigest(root, files) {
  const hash = crypto.createHash('sha256');
  for (const relative of files) {
    hash.update(relative);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(root, relative)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function generateFixture(outputRoot, fixture, testMode) {
  const fixtureRoot = path.join(outputRoot, fixture.id);
  fs.mkdirSync(fixtureRoot);
  const write = createWriter(fixtureRoot);
  const count = testMode ? fixture.generation.testRecordCount : fixture.generation.fullRecordCount;
  const generator = generators[fixture.generation.profile];
  if (!generator) throw new Error(`No generator profile for ${fixture.id}`);
  generator(write, count);

  const beforeManifest = listFiles(fixtureRoot);
  const generatedManifest = {
    schemaVersion: 1,
    fixtureId: fixture.id,
    domain: fixture.domain,
    sizeClass: fixture.sizeClass,
    mode: testMode ? 'test' : 'full',
    generatedAt: FIXED_TIMESTAMP,
    recordCount: count,
    fileCount: beforeManifest.files.length + 1,
    directoryCount: beforeManifest.directories.length,
    sourceContentSha256: contentDigest(fixtureRoot, beforeManifest.files),
    allowedMutationZones: fixture.allowedMutationZones,
    forbiddenMutationZones: fixture.forbiddenMutationZones,
    expectedArtifacts: fixture.expectedArtifacts
  };
  write.file('fixture-manifest.json', json(generatedManifest));
  return generatedManifest;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error.message);
  }
  if (!args.out || args.out === true) fail('Missing required --out directory.');

  const selectors = [args.fixture !== undefined, args.all !== undefined, args.size !== undefined].filter(Boolean).length;
  if (selectors !== 1) fail('Choose exactly one of --fixture, --all, or --size.');
  if (args.all !== undefined && args.all !== true && args.all !== 'true') fail('--all does not accept a value.');
  if (args['test-mode'] !== undefined && args['test-mode'] !== true && args['test-mode'] !== 'true') fail('--test-mode does not accept a value.');

  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  let selected;
  if (args.fixture !== undefined) {
    selected = catalog.fixtures.filter(fixture => fixture.id === String(args.fixture));
    if (selected.length === 0) fail(`Unknown fixture id: ${args.fixture}`);
  } else if (args.size !== undefined) {
    const size = String(args.size);
    if (!['small', 'medium', 'large'].includes(size)) fail(`Unknown size class: ${size}`);
    selected = catalog.fixtures.filter(fixture => fixture.sizeClass === size);
  } else {
    selected = catalog.fixtures;
  }

  try {
    const outputRoot = prepareOutputRoot(args.out);
    for (const fixture of selected) {
      const destination = path.join(outputRoot, fixture.id);
      if (fs.existsSync(destination)) throw new Error(`Refusing to overwrite existing fixture: ${destination}`);
    }
    const manifests = selected.map(fixture => generateFixture(outputRoot, fixture, args['test-mode'] === true || args['test-mode'] === 'true'));
    for (const manifest of manifests) {
      console.log(`${manifest.fixtureId}: ${manifest.fileCount} files, ${manifest.directoryCount} directories (${manifest.mode})`);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

main();
