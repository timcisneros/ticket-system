#!/usr/bin/env node
/**
 * Focused legal-impossibility replication test.
 * Creates 8 vendor files (1 legal impossibility + 7 straight-through controls),
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

const TEST_WORKSPACE = path.join('/tmp', 'opencode', 'legal-impossibility-test');
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

// Straight-through vendor (no edge case)
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

// Legal impossibility vendors
const legalImpossibilityVariants = {
  data_localization: {
    name: 'GlobalVault Data Services',
    service: 'Cloud data storage and analytics from data centers in Country X',
    criticality: 'High',
    spend: '$130K',
    dpa: 'Signed — Section 3.1 promises no third-party access. This is legally impossible under Country X National Data Access Act.',
    access: 'Product analytics and account metadata, including personally identifiable information',
    cert: 'SOC 2 Type II',
    certExpiry: '2027-05-04',
    incidents: 'None reported',
    note: '## Legal Conflict Note\nGlobalVault operates from Country X where the National Data Access Act grants government data access rights. The signed DPA Section 3.1 promises no third-party access — a term the vendor cannot legally comply with while operating from Country X. All certifications are current and the DPA is signed, but the DPA contains terms that are legally impossible to fulfill under local law. Policy does not address legal impossibility of contractual compliance. Expected: Reject — compliance is legally impossible under current jurisdiction.'
  },
  encryption_law: {
    name: 'SecureChannel Communications',
    service: 'Secure enterprise messaging and encrypted communications platform',
    criticality: 'High',
    spend: '$340K',
    dpa: 'Signed — Section 4.2 promises no decryption capability or backdoor access. This is legally impossible under Country Y Surveillance Act.',
    access: 'Encrypted message content, metadata, and user directory information',
    cert: 'SOC 2 Type II',
    certExpiry: '2027-09-15',
    incidents: 'None reported',
    note: '## Legal Conflict Note\nSecureChannel operates in Country Y where the Surveillance Act mandates lawful decryption capability for communications platforms. The signed DPA Section 4.2 promises no decryption capability — a term the vendor cannot legally comply with. All certifications are current and the DPA is signed, but the DPA contains terms that are legally impossible to fulfill under local surveillance law. Policy does not address encryption law conflicts. Expected: Reject — compliance is legally impossible under Country Y law.'
  },
  cross_border: {
    name: 'GlobalRoute Technologies',
    service: 'Global data routing and content delivery network with backbone in the United States',
    criticality: 'Medium',
    spend: '$180K',
    dpa: 'Signed — Section 2.1 requires US backbone routing for all customer data. This is legally prohibited under Country Z Data Transfer Prohibition Act.',
    access: 'Customer network traffic metadata and cached content',
    cert: 'SOC 2 Type II',
    certExpiry: '2027-11-30',
    incidents: 'None reported',
    note: '## Legal Conflict Note\nGlobalRoute maintains US-based backbone infrastructure. Country Z law prohibits US-bound data transfers. The signed DPA Section 2.1 requires US backbone routing for all customer data — a routing requirement the vendor cannot legally fulfill while operating in Country Z. All certifications are current and the DPA is signed, but the DPA requires a data flow that is legally prohibited. Policy does not address cross-border data transfer prohibitions. Expected: Reject — compliance is legally impossible under Country Z law.'
  }
};

function renderLegalImpossibilityVendor(id, v) {
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

async function main() {
  const variantKey = process.argv[2];
  const passes = parseInt(process.argv[3], 10) || 1;

  if (!variantKey || !legalImpossibilityVariants[variantKey]) {
    console.error('Usage: node scripts/test-legal-impossibility.js <variant> [passes]');
    console.error('Variants: ' + Object.keys(legalImpossibilityVariants).join(', '));
    process.exit(1);
  }

  const variant = legalImpossibilityVariants[variantKey];
  console.log(`Legal Impossibility Replication Test\n`);
  console.log(`Variant: ${variantKey} (${variant.name})`);
  console.log(`Passes: ${passes}\n`);

  const nameGen = (i) => ['CloudHost', 'DataSync', 'SecureMail', 'AnalyticsPro', 'InfraServe', 'LogiStack', 'ShieldOps', 'PolicyCore'][i - 1];
  const criticalities = ['Critical', 'High', 'High', 'Medium', 'Low', 'Low', 'High', 'Medium'];
  const spends = ['$1.2M', '$890K', '$520K', '$380K', '$150K', '$120K', '$450K', '$280K'];
  const accesses = ['Cloud infrastructure data', 'Data synchronization logs', 'Email security metadata', 'Analytics platform data', 'Infrastructure logs', 'Log management data', 'Security operations data', 'Policy documentation'];
  const certs = ['SOC 2 Type II', 'ISO 27001', 'FedRAMP', 'SOC 2 Type II', 'ISO 27001', 'SOC 2 Type II', 'FedRAMP', 'ISO 27001'];
  const certExpiries = ['2027-12-31', '2027-11-30', '2027-10-15', '2027-09-30', '2027-08-31', '2027-07-31', '2027-06-30', '2027-05-31'];
  const dpas = ['Signed and current', 'Signed and current', 'Signed and current', 'Signed and current', 'Signed and current', 'Signed and current', 'Signed and current', 'Signed and current'];

  let totalPass = 0;
  let totalFail = 0;

  for (let pass = 1; pass <= passes; pass++) {
    if (passes > 1) console.log(`\n--- Pass ${pass}/${passes} ---`);

    // Setup workspace
    if (fs.existsSync(TEST_WORKSPACE)) fs.rmSync(TEST_WORKSPACE, { recursive: true });
    fs.mkdirSync(VENDORS_DIR, { recursive: true });
    fs.writeFileSync(path.join(TEST_WORKSPACE, '.fixture-workspace'), 'legal-impossibility-test');

    // Write vendor files
    for (let i = 1; i <= 8; i++) {
      const vid = `vendor-00${i}`;
      if (i === 1) {
        writeFile(path.join(VENDORS_DIR, `${vid}.md`), renderLegalImpossibilityVendor(vid, variant));
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
            expectedDisposition: 'Reject', acceptableDispositions: ['Reject'],
            reasonCode: 'dpa_compliance_legally_impossible', expectedNextActionKind: 'jurisdiction_change_required' }
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
    clearData();
    await startServer();
    await sleep(1000);

    // Login
    await login();

    // Create ticket
    const ticketId = await createTicket(
      'Classify 8 vendor compliance packets',
      'vendor-compliance',
      { basePath: '.' }
    );

    // Wait for completion
    const result = await waitForComplete(ticketId, 300000);
    if (!result.run || result.run.status !== 'completed') {
      console.error(`  Run failed: status=${result.run ? result.run.status : 'none'}`);
      stopServer();
      process.exit(1);
    }

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

    // Parse CSV
    let rows;
    if (lines[0].includes('vendor_id')) {
      rows = lines.slice(1);
    } else {
      rows = lines;
    }

    let vendor1Disp = '(missing)';
    let vendor1Reason = '';

    for (const line of rows) {
      const cols = line.split(',');
      if (cols.length >= 3) {
        const id = cols[0].trim();
        const name = cols[1].trim();
        const disp = cols[2].trim();
        const reason = cols.slice(3, 5).join(', ').replace(/,/g, ' |');
        const arrow = id === 'vendor-001' ? '>>>' : '   ';
        const pass = id === 'vendor-001'
          ? (disp === 'Reject' ? '✓ PASS' : '✗ FAIL')
          : (disp === 'Approve' ? '✓ OK' : (disp === 'Conditional Approve' ? '✓ OK' : '✗ UNEXPECTED'));
        console.log(`${arrow} ${id} ${name}: ${disp} ${pass}`);
        if (id === 'vendor-001') {
          console.log(`    Reason: ${reason}`);
          vendor1Disp = disp;
          vendor1Reason = reason;
        }
      }
    }

    const passed = vendor1Disp === 'Reject';
    if (passed) totalPass++; else totalFail++;

    stopServer();
  }

  console.log('\n=== VERDICT ===');
  if (totalFail === 0) {
    console.log(`RESULT: ${totalPass}/${totalPass} PASS — ${variantKey} correctly Rejected in every pass`);
    console.log('Legal impossibility failure DID NOT reproduce.');
  } else if (totalPass === 0) {
    console.log(`RESULT: ${totalFail}/${totalFail} FAIL — ${variantKey} got Approve instead of Reject in every pass`);
    console.log('Legal impossibility failure REPRODUCES deterministically.');
  } else {
    console.log(`RESULT: ${totalPass}/${totalPass + totalFail} PASS — stochastic behavior`);
  }
}

main().catch(err => { console.error(err); stopServer(); process.exit(1); });
