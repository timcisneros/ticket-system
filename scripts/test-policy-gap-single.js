#!/usr/bin/env node
/**
 * Focused single-vendor policy-gap reproduction test.
 * Creates 8 vendor files (1 policy-gap + 7 straight-through controls),
 * runs the vendor-compliance workflow, checks the result.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 3099;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(ROOT, 'data');
const SERVER_SCRIPT = path.join(ROOT, 'server.js');

const TEST_WORKSPACE = path.join('/tmp', 'opencode', 'policy-gap-single-test');
const VENDORS_DIR = path.join(TEST_WORKSPACE, 'incoming');

let cookie = '';
let serverProcess = null;

function writeFile(fp, content) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content.trimEnd() + '\n');
}

function httpReq(method, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE_URL + urlPath);
    const options = {
      hostname: u.hostname, port: u.port,
      path: u.pathname + (u.search || ''),
      method, headers: { ...opts.headers }
    };
    if (opts.body) options.headers['Content-Length'] = Buffer.byteLength(opts.body);
    const req = http.request(options, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function login() {
  const body = `username=admin&password=${encodeURIComponent('admin123')}`;
  const res = await httpReq('POST', '/login', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  });
  if (res.status === 302) {
    const setCookie = res.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const match = cookieStr && cookieStr.match(/sessionId=([^;]+)/);
    if (match) { cookie = `sessionId=${match[1]}`; return; }
  }
  console.error('Login failed:', res.status, res.body);
  process.exit(1);
}

async function createTicket(objective, workflowId, input) {
  const form = new URLSearchParams({
    objective, capabilityType: 'workflow', executionMode: 'workflow',
    workflowId, workflowInput: JSON.stringify(input || {}),
    assignmentTargetType: 'agent', assignmentTargetId: '1', assignmentMode: 'individual'
  });
  const res = await httpReq('POST', '/tickets', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: form.toString()
  });
  if (res.status !== 302) throw new Error('Create ticket failed: ' + res.status);
  const listRes = await httpReq('GET', '/api/tickets', { headers: { Cookie: cookie } });
  const data = JSON.parse(listRes.body);
  const tickets = data.tickets || data;
  const ticket = tickets.reduce((a, b) => (a.id > b.id ? a : b));
  console.log(`  Created ticket #${ticket.id}`);
  return ticket.id;
}

function readJsonSync(fp) {
  if (!fs.existsSync(fp)) return [];
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

async function waitForComplete(ticketId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ticket = readJsonSync(path.join(DATA_DIR, 'tickets.json')).find(t => t.id === ticketId);
    if (!ticket) { await new Promise(r => setTimeout(r, 500)); continue; }
    const runs = readJsonSync(path.join(DATA_DIR, 'runs.json')).filter(r => r.ticketId === ticketId);
    const run = runs[runs.length - 1];
    const terminal = new Set(['completed', 'failed', 'interrupted']);
    if (run && terminal.has(run.status)) return { ticket, run };
    await new Promise(r => setTimeout(r, 1000));
  }
  return { ticket: null, run: null };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [SERVER_SCRIPT], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(PORT), DATA_DIR,
        WORKSPACE_ROOT: TEST_WORKSPACE }
    });
    serverProcess = proc;
    let started = false;
    let output = '';
    proc.stdout.on('data', d => {
      output += d;
      if (!started && output.includes('localhost:' + PORT)) { started = true; resolve(); }
    });
    proc.stderr.on('data', d => {
      output += d;
      if (!started && output.includes('localhost:' + PORT)) { started = true; resolve(); }
    });
    proc.on('error', reject);
    setTimeout(() => { if (!started) resolve(); }, 15000);
  });
}

function stopServer() {
  if (serverProcess) { serverProcess.kill('SIGTERM'); serverProcess = null; }
}

function clearData() {
  for (const f of ['tickets.json', 'runs.json', 'events.jsonl', 'logs.json', 'operation-history.json', 'workflows.json']) {
    const fp = path.join(DATA_DIR, f);
    if (fs.existsSync(fp)) {
      if (f.endsWith('.jsonl')) fs.writeFileSync(fp, '');
      else fs.writeFileSync(fp, '[]');
    }
  }
}

// ─── Straight-through vendor template (no edge case) ─────────

function renderStraightVendor(id, name, criticality, spend, dpa, access, cert, certExpiry, incidents) {
  return `# Vendor Compliance Packet

## Vendor ID
${id}

## Vendor Name
${name}

## Service
Standard ${name.toLowerCase()} services

## Criticality
${criticality}

## Annual Spend
${spend}

## Data Access
${access}

## Data Processing Agreement
${dpa}

## Security Certification
${cert}

## Certification Expiry Date
${certExpiry}

## Certification Status
Current

## Incident Status
${incidents}

## Evidence Notes
Use this packet as the vendor source of truth. Apply the workflow policy to decide Approve, Conditional Approve, or Reject.`;
}

// ─── Policy-gap vendor variants ──────────────────────────────

const policyGapVariants = {
  children: {
    name: 'KinderSafe Analytics',
    service: 'Educational analytics platform for K-12 school districts',
    criticality: 'High',
    spend: '$240K',
    dpa: 'Signed and current',
    access: 'Student personal data for children under 13',
    cert: 'SOC 2 Type II',
    certExpiry: '2027-10-31',
    incidents: 'None reported',
    note: 'KinderSafe Analytics provides educational analytics services to K-12 school districts, processing student assessment data and behavioral metrics. The DPA is signed and current, the SOC 2 Type II certification is valid through October 2027, and no security incidents have been reported. Policy has no provisions for children\'s data protection. The vendor processes data for students under 13 years of age.'
  },
  biometric: {
    name: 'BioVerify Identity',
    service: 'Biometric identity verification platform',
    criticality: 'High',
    spend: '$380K',
    dpa: 'Signed and current',
    access: 'Fingerprint, facial recognition, and voiceprint templates',
    cert: 'SOC 2 Type II',
    certExpiry: '2027-06-30',
    incidents: 'None reported',
    note: 'BioVerify Identity provides biometric identity verification for physical access control. The DPA is signed and current, the SOC 2 Type II certification is valid through June 2027, and no security incidents have been reported. The platform processes fingerprint, facial recognition, and voiceprint templates. Policy has no provisions for biometric data protection under current compliance framework (BIPA scope not addressed).'
  },
  geolocation: {
    name: 'GeoRoute Insights',
    service: 'Real-time GPS location analytics',
    criticality: 'Medium',
    spend: '$175K',
    dpa: 'Signed and current',
    access: 'Real-time precise GPS location data',
    cert: 'SOC 2 Type II',
    certExpiry: '2027-05-15',
    incidents: 'None reported',
    note: 'GeoRoute Insights provides real-time GPS location analytics. The DPA is signed and current, the SOC 2 Type II certification is valid through May 2027, and no security incidents have been reported. The vendor processes real-time location data from company-issued mobile devices. Policy has no provisions for precise geolocation tracking data protections.'
  },
  ai_decisions: {
    name: 'AutoDecide Systems',
    service: 'AI-powered automated employee decision platform',
    criticality: 'High',
    spend: '$420K',
    dpa: 'Signed and current',
    access: 'Employee screening, performance, and promotion data',
    cert: 'SOC 2 Type II',
    certExpiry: '2027-08-30',
    incidents: 'None reported',
    note: 'AutoDecide Systems operates an AI-driven platform that makes automated employee screening, performance, and promotion determinations. The DPA is signed and current, the SOC 2 Type II certification is valid through August 2027, and no security incidents have been reported. Policy has no provisions for automated decision-making governance. The system operates without human review of individual decisions.'
  },
  genetic: {
    name: 'GeneLink Diagnostics',
    service: 'Genetic testing and DNA analysis',
    criticality: 'Critical',
    spend: '$560K',
    dpa: 'Signed and current',
    access: 'Genetic test results and health information',
    cert: 'SOC 2 Type II',
    certExpiry: '2027-12-31',
    incidents: 'None reported',
    note: 'GeneLink Diagnostics provides genetic testing services for employee wellness programs. The DPA is signed and current, the SOC 2 Type II certification is valid through December 2027, and no security incidents have been reported. Policy has no provisions for genetic data protections (GINA compliance not addressed in standard privacy framework). The vendor processes genetic test results linked to employee identities.'
  },
  wellness: {
    name: 'WellTrack Employee Health',
    service: 'Employee wellness program management',
    criticality: 'Medium',
    spend: '$150K',
    dpa: 'Signed and current',
    access: 'Health risk assessments and biometric screening data',
    cert: 'SOC 2 Type II',
    certExpiry: '2027-04-30',
    incidents: 'None reported',
    note: 'WellTrack Employee Health administers the corporate wellness program. The DPA is signed and current, the SOC 2 Type II certification is valid through April 2027, and no security incidents have been reported. Policy has no provisions for employment-context health data protections (ADA/EEOC considerations not addressed). The vendor manages health risk assessments and biometric screening for employees.'
  }
};

function renderPolicyGapVendor(id, v) {
  return `# Vendor Compliance Packet

## Vendor ID
${id}

## Vendor Name
${v.name}

## Service
${v.service}

## Criticality
${v.criticality}

## Annual Spend
${v.spend}

## Data Access
${v.access}

## Data Processing Agreement
${v.dpa}

## Security Certification
${v.cert}

## Certification Expiry Date
${v.certExpiry}

## Certification Status
Current

## Incident Status
${v.incidents}

${v.note}

## Evidence Notes
Use this packet as the vendor source of truth. Apply the workflow policy to decide Approve, Conditional Approve, or Reject.`;
}

// ─── Main test ───────────────────────────────────────────────

async function main() {
  const variantKey = process.argv[2];
  if (!variantKey || !policyGapVariants[variantKey]) {
    console.error('Usage: node scripts/test-policy-gap-single.js <variant>');
    console.error('Variants: ' + Object.keys(policyGapVariants).join(', '));
    process.exit(1);
  }
  const variant = policyGapVariants[variantKey];
  console.log(`Policy-Gap Single-Vendor Reproduction Test\n`);
  console.log(`Variant: ${variantKey} (${variant.name})`);

  // Setup workspace
  if (fs.existsSync(TEST_WORKSPACE)) fs.rmSync(TEST_WORKSPACE, { recursive: true });
  fs.mkdirSync(VENDORS_DIR, { recursive: true });
  fs.writeFileSync(path.join(TEST_WORKSPACE, '.fixture-workspace'), 'policy-gap-test');

  // Write vendor files (vendor-001 = policy gap, rest = straight-through)
  const nameGen = (i) => ['CloudHost', 'DataSync', 'SecureMail', 'AnalyticsPro', 'InfraServe', 'LogiStack', 'ShieldOps', 'PolicyCore'][i - 1];
  const criticalities = ['Critical', 'High', 'High', 'Medium', 'Low', 'Low', 'High', 'Medium'];
  const spends = ['$1.2M', '$890K', '$520K', '$380K', '$150K', '$120K', '$450K', '$280K'];
  const accesses = ['Cloud infrastructure data', 'Data synchronization logs', 'Email security metadata', 'Analytics platform data', 'Infrastructure logs', 'Log management data', 'Security operations data', 'Policy documentation'];
  const certs = ['SOC 2 Type II', 'ISO 27001', 'FedRAMP', 'SOC 2 Type II', 'ISO 27001', 'SOC 2 Type II', 'FedRAMP', 'ISO 27001'];
  const certExpiries = ['2027-12-31', '2027-11-30', '2027-10-15', '2027-09-30', '2027-08-31', '2027-07-31', '2027-06-30', '2027-05-31'];
  const dpas = ['Signed and current', 'Signed and current', 'Signed and current', 'Signed and current', 'Signed and current', 'Signed and current', 'Signed and current', 'Signed and current'];

  for (let i = 1; i <= 8; i++) {
    const vid = `vendor-00${i}`;
    if (i === 1) {
      writeFile(path.join(VENDORS_DIR, `${vid}.md`), renderPolicyGapVendor(vid, variant));
    } else {
      writeFile(path.join(VENDORS_DIR, `${vid}.md`),
        renderStraightVendor(vid, nameGen(i), criticalities[i-1], spends[i-1],
          dpas[i-1], accesses[i-1], certs[i-1], certExpiries[i-1], 'None reported'));
    }
  }

  // Write fixture-manifest
  const manifest = {
    fixture: 'vendor-compliance', version: 1, seed: 99999,
    evaluationDate: new Date().toISOString().slice(0, 10),
    parameters: { vendorCount: 8 },
    expectedDecisionSet: {
      files: [
        { vendorId: 'vendor-001', vendorName: variant.name, sourcePath: 'incoming/vendor-001.md',
          expectedDisposition: 'Conditional Approve', acceptableDispositions: ['Conditional Approve'],
          reasonCode: 'policy_gap', expectedNextActionKind: 'remediation' }
      ].concat(
        Array.from({ length: 7 }, (_, i) => {
          const idx = i + 2;
          const vid = `vendor-00${idx}`;
          return { vendorId: vid, vendorName: nameGen(idx), sourcePath: `incoming/${vid}.md`,
            expectedDisposition: 'Approve', acceptableDispositions: ['Approve'],
            reasonCode: 'current_cert_no_incident', expectedNextActionKind: 'approve' };
        })
      )
    }
  };
  writeFile(path.join(TEST_WORKSPACE, 'fixture-manifest.json'), JSON.stringify(manifest, null, 2));

  // Start server
  console.log('\nStarting server...');
  clearData();
  await startServer();
  console.log('  Server ready on port ' + PORT);
  await sleep(1000);

  // Login
  console.log('\nLogging in...');
  await login();

  // Create ticket
  console.log('\nCreating vendor-compliance ticket for 8 vendors...');
  const ticketId = await createTicket(
    'Classify 8 vendor compliance packets',
    'vendor-compliance',
    { basePath: '.' }
  );
  console.log(`  Ticket #${ticketId} created`);

  // Wait for completion
  console.log('\nWaiting for completion...');
  const result = await waitForComplete(ticketId, 300000);
  if (!result.run || result.run.status !== 'completed') {
    console.error(`  Run failed: status=${result.run ? result.run.status : 'none'}`);
    stopServer();
    process.exit(1);
  }
  console.log(`  Run #${result.run.id} completed`);

  // Read CSV output
  await sleep(1000);
  const csvPath = path.join(TEST_WORKSPACE, 'vendor-decision-register.csv');
  if (!fs.existsSync(csvPath)) {
    console.error('\nERROR: vendor-decision-register.csv not found');
    stopServer();
    process.exit(1);
  }

  const csvContent = fs.readFileSync(csvPath, 'utf8');
  const lines = csvContent.trim().split('\n');

  console.log('\n=== RESULTS ===\n');

  // Try to parse CSV (may or may not have headers)
  let rows;
  if (lines[0].includes('vendor_id')) {
    rows = lines.slice(1);
  } else {
    rows = lines;
  }

  for (const line of rows) {
    const cols = line.split(',');
    if (cols.length >= 3) {
      const id = cols[0].trim();
      const name = cols[1].trim();
      const disp = cols[2].trim();
      const reason = cols.slice(3, 5).join(', ').replace(/,/g, ' |');
      const arrow = id === 'vendor-001' ? '>>>' : '   ';
      const pass = id === 'vendor-001'
        ? (disp === 'Conditional Approve' ? '✓ PASS' : '✗ FAIL')
        : (disp === 'Approve' ? '✓ OK' : (disp === 'Conditional Approve' ? '✓ OK' : '✗ UNEXPECTED'));
      console.log(`${arrow} ${id} ${name}: ${disp} ${pass}`);
      if (id === 'vendor-001') {
        console.log(`    Reason: ${reason}`);
      }
    }
  }

  // Summary
  const vendor1Line = rows.find(l => l.startsWith('vendor-001'));
  const vendor1Disp = vendor1Line ? vendor1Line.split(',')[2].trim() : '(missing)';
  const passed = vendor1Disp === 'Conditional Approve';

  console.log('\n=== VERDICT ===');
  if (passed) {
    console.log(`RESULT: PASS — ${variantKey} correctly identified as Conditional Approve`);
    console.log('The policy-gap failure did NOT reproduce in single-vendor review.');
  } else {
    console.log(`RESULT: FAIL — ${variantKey} got "${vendor1Disp}" instead of Conditional Approve`);
    console.log('The policy-gap failure REPRODUCES in single-vendor review.');
  }

  stopServer();
}

main().catch(err => { console.error(err); stopServer(); process.exit(1); });
