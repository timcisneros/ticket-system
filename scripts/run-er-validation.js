#!/usr/bin/env node
/**
 * Evidence Reconciliation Hypothesis Validation
 *
 * Tests whether evidence reconciliation failures are a genuine model weakness
 * or a fixture artifact by systematically varying:
 *   - counter-evidence position (prominence)
 *   - counter-evidence format (structured vs prose)
 *   - surface signal strength (urgency dampening)
 *   - evidence ordering (which signal comes first)
 *   - corroborating source count (single vs multiple)
 *
 * Each CS case modifies ONE ticket. All other 7 tickets remain identical
 * to the V2 fixture. Each case runs 3x for determinism measurement.
 *
 * VC cases modify specific vendor files and run the full pipeline once.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const PORT = 3099;
const DATA_DIR = path.join(ROOT, 'data');
const WORKSPACE_ROOT = path.join(ROOT, 'workspace-root');
const INBOX = path.join(WORKSPACE_ROOT, 'support-inbox');
const VENDOR_DIR = path.join(WORKSPACE_ROOT, 'vendors', 'incoming');
const RESULTS = [];

let serverProcess = null;
let cookie = null;

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function httpReq(method, urlPath, opts) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, `http://127.0.0.1:${PORT}`);
    const headers = { ...(opts ? opts.headers : {}) };
    const req = http.request(url, { method, headers }, (res) => {
      let body = '';
      res.on('data', d => body += d.toString());
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts && opts.body) req.write(opts.body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Server lifecycle ────────────────────────────────────────────────────────

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['server.js'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(PORT), DATA_DIR, WORKSPACE_ROOT }
    });
    serverProcess = proc;
    let started = false;
    let output = '';
    proc.stdout.on('data', d => { output += d.toString(); if (!started && output.includes('localhost:' + PORT)) { started = true; resolve(); } });
    proc.stderr.on('data', d => { output += d.toString(); if (!started && output.includes('localhost:' + PORT)) { started = true; resolve(); } });
    proc.on('error', reject);
    setTimeout(() => { if (!started) { started = true; resolve(); } }, 30000);
  });
}

function stopServer() { if (serverProcess) { serverProcess.kill('SIGTERM'); serverProcess = null; } }

function seedDataDir() {
  const files = {
    'agents.json': JSON.parse(fs.readFileSync(path.join(ROOT, '.local-data', 'agents.json'), 'utf8')).slice(0, 4),
    'permissions.json': ['ticket:create', 'ticket:read', 'ticket:update'],
    'groups.json': [
      { id: 1, name: 'Administrators', permissions: ['ticket:create', 'ticket:read', 'ticket:update'], canReceiveTickets: false },
      { id: 2, name: 'Agent Support', permissions: ['ticket:create', 'ticket:read', 'ticket:update'], canReceiveTickets: true }
    ],
    'memberships.json': [
      { id: 1, principalType: 'user', principalId: 1, groupId: 1 },
      { id: 2, principalType: 'user', principalId: 1, groupId: 2 }
    ],
    'tickets.json': [],
    'runs.json': [],
    'logs.json': [],
    'events.jsonl': '',
    'operation-history.json': []
  };
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const fp = path.join(DATA_DIR, name);
    fs.writeFileSync(fp, typeof content === 'string' ? content : JSON.stringify(content));
  }
  const snapshotsDir = path.join(DATA_DIR, 'replay-snapshots');
  if (fs.existsSync(snapshotsDir)) fs.rmSync(snapshotsDir, { recursive: true, force: true });
}

async function login() {
  const res = await httpReq('POST', '/login', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=admin&password=admin123'
  });
  const setCookie = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'].join('; ') : (res.headers['set-cookie'] || '');
  const match = setCookie.match(/sessionId=([^;]+)/);
  if (!match) throw new Error('Login failed');
  cookie = `sessionId=${match[1]}`;
}

async function createWorkflowTicket(objective, workflowId, workflowInput) {
  const form = new URLSearchParams({
    objective, capabilityType: 'workflow', executionMode: 'workflow',
    workflowId, workflowInput: JSON.stringify(workflowInput || {}),
    assignmentTargetType: 'agent', assignmentTargetId: '1', assignmentMode: 'individual'
  });
  const res = await httpReq('POST', '/tickets', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookie },
    body: form.toString()
  });
  if (res.status !== 302) throw new Error(`Create ticket failed: HTTP ${res.status}`);
  const listRes = await httpReq('GET', '/api/tickets', { headers: { 'Cookie': cookie } });
  const ticketData = JSON.parse(listRes.body);
  const tickets = ticketData.tickets || ticketData;
  const matching = tickets.filter(t => t.objective === objective);
  const ticket = matching.length > 0 ? matching.reduce((a, b) => (a.id > b.id ? a : b)) : tickets.reduce((a, b) => (a.id > b.id ? a : b), null);
  if (!ticket) throw new Error('Could not find created ticket');
  return ticket.id;
}

async function waitForTicketComplete(ticketId, timeoutMs) {
  timeoutMs = timeoutMs || 300000;
  const started = Date.now();
  const terminal = new Set(['completed', 'failed', 'interrupted']);
  while (Date.now() - started < timeoutMs) {
    const tickets = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tickets.json'), 'utf8'));
    const ticket = tickets.find(t => t.id === ticketId);
    if (!ticket) { await sleep(500); continue; }
    const runs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'runs.json'), 'utf8'));
    const latestRun = runs.filter(r => r.ticketId === ticketId).sort((a,b) => b.id - a.id)[0];
    if (latestRun && terminal.has(latestRun.status)) return { ticket, run: latestRun };
    await sleep(1000);
  }
  const tickets = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tickets.json'), 'utf8'));
  const ticket = tickets.find(t => t.id === ticketId);
  const runs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'runs.json'), 'utf8'));
  const latestRun = runs.filter(r => r.ticketId === ticketId).sort((a,b) => b.id - a.id)[0];
  return { ticket, run: latestRun };
}

// ─── Fixture generation ───────────────────────────────────────────────────────

function generateSupportFixture() {
  const tmpDir = path.join(require('os').tmpdir(), 'opencode-validate-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.fixture-workspace'), '');

  const gen = spawn('node', [
    'scripts/fixture-generator.js',
    '--fixture=customer-support',
    '--count=8',
    '--seed=42',
    `--workspace=${tmpDir}`,
    '--evaluation-date=2026-06-07',
    '--overwrite'
  ], {
    cwd: ROOT,
    stdio: ['inherit', 'pipe', 'pipe'],
    env: { ...process.env, WORKSPACE_ROOT: tmpDir }
  });

  return new Promise((resolve, reject) => {
    let err = '';
    gen.stderr.on('data', d => err += d.toString());
    gen.on('close', code => {
      if (code !== 0) return reject(new Error('fixture-generator failed: ' + err.substring(0, 300)));
      const srcInbox = path.join(tmpDir, 'support-inbox');
      const dstInbox = path.join(WORKSPACE_ROOT, 'support-inbox');
      fs.mkdirSync(dstInbox, { recursive: true });
      for (const f of fs.readdirSync(srcInbox)) {
        fs.copyFileSync(path.join(srcInbox, f), path.join(dstInbox, f));
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve();
    });
  });
}

function expandSupportFixture() {
  require(path.join(ROOT, 'scripts', 'expand-support-fixture.js'));
}

// ─── Run one CS workflow ──────────────────────────────────────────────────────

async function runOneCSTest(label) {
  seedDataDir();
  await startServer();
  await login();
  const ticketId = await createWorkflowTicket(
    'Triage 8 support tickets from support-inbox/ according to policy',
    'customer-support-triage',
    { sourcePath: 'support-inbox', outputPath: 'support-queue' }
  );
  const result = await waitForTicketComplete(ticketId, 600000);
  const runStatus = result.run ? result.run.status : 'unknown';
  const runId = result.run ? result.run.id : null;

  // Run verifier and capture output
  await sleep(500);
  const verifierOutput = await runVerifierAndCapture('customer-support');
  stopServer();

  // Extract pass/fail from verifier output
  const passMatch = verifierOutput.match(/(\d+) PASS(?:ED|ES?)/i) || verifierOutput.match(/Passed\s+(\d+)/i);
  const failMatch = verifierOutput.match(/(\d+) FAIL(?:ED|URE)?/i) || verifierOutput.match(/Failed\s+(\d+)/i);
  const passed = passMatch ? parseInt(passMatch[1]) : 0;
  const failed = failMatch ? parseInt(failMatch[1]) : 0;

  // Find specific failures from verifier output
  const failureLines = verifierOutput.split('\n').filter(l => l.includes('FAIL') || l.includes('✗') || l.includes('fail'));

  const entry = {
    label,
    runStatus,
    runId,
    verifierPassed: failed === 0,
    passed,
    failed,
    failureLines: failureLines.slice(0, 10),
    rawOutput: verifierOutput.substring(0, 2000)
  };
  RESULTS.push(entry);
  console.log(`  → ${label}: ${passed}/${passed+failed} PASS (${failed} fails) — run #${runId}`);
  return entry;
}

function runVerifierAndCapture(fixture) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['scripts/fixture-verifier.js', `--fixture=${fixture}`], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, WORKSPACE_ROOT, DATA_DIR }
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => {
      resolve(out + err);
    });
  });
}

// ─── Modified Ticket Content ──────────────────────────────────────────────────

// CS-ER-001: Counter-evidence position - change ticket moved to FIRST
// (SUP-2026-005: security false positive; change ticket at top instead of bottom)
const TICKET_005_POSITION = `# Support Ticket

Ticket ID: SUP-2026-005
Subject: Suspicious API activity detected from unfamiliar IP range
Customer: Cedar Health
Customer Tier: Enterprise
Reported Time: 2026-06-07T12:00:00.000Z
Issue Type: Security Concern
Impact: Potential unauthorized API access detected by SOC. Detailed logs show read-only requests to patient demographics endpoint from unfamiliar ASN.
Description: CHANGE TICKET CHG-2026-0607-042 documents a "scheduled read-only data migration for analytics platform integration" approved by Cedar Health's security officer on 2026-06-05. The change ticket specifies: "Migration vendor: CloudMove Inc. Source IP range: 52.168.117.0/24 (Azure US East). Duration: 2026-06-07 08:00-16:00 UTC. Data accessed: patient demographics (read-only)." The service token used matches the one issued for this integration per the change ticket. ALL API ACTIVITY IS AUTHORIZED per the change management record. SEPARATELY, Cedar Health SOC reports API calls to their patient-demographics endpoint originating from AS8075 (Microsoft Azure US East, IP 52.168.117.24) using a valid read-only service token. The SOC team provides detailed access logs with timestamps, request patterns, and affected endpoints. The logs show 2,347 GET requests over 4 hours to /api/v2/patients/demographics — all read-only, no mutations. The SOC team either was not notified or overlooked the change ticket. Despite the alarming logs, all activity appears authorized per the change management record.
Escalation Signals: Detailed suspicious activity logs; read-only access only; change ticket confirms scheduled authorized migration; SOC may not have been notified; enterprise healthcare with HIPAA data.
Duplicate Group: none`;

// CS-ER-002: Structured counter-evidence - change ticket as structured block
const TICKET_005_FORMAT = `# Support Ticket

Ticket ID: SUP-2026-005
Subject: Suspicious API activity detected from unfamiliar IP range
Customer: Cedar Health
Customer Tier: Enterprise
Reported Time: 2026-06-07T12:00:00.000Z
Issue Type: Security Concern
Impact: Potential unauthorized API access detected by SOC. Detailed logs show read-only requests to patient demographics endpoint from unfamiliar ASN.
Description: Cedar Health SOC reports API calls to their patient-demographics endpoint originating from AS8075 (Microsoft Azure US East, IP 52.168.117.24) using a valid read-only service token. The SOC team provides detailed access logs with timestamps, request patterns, and affected endpoints. The logs show 2,347 GET requests over 4 hours to /api/v2/patients/demographics — all read-only, no mutations.

[CHANGE TICKET CHG-2026-0607-042]
Purpose: Scheduled read-only data migration for analytics platform integration
Approved by: Cedar Health Security Officer (2026-06-05)
Migration vendor: CloudMove Inc.
Source IP range: 52.168.117.0/24 (Azure US East)
Duration: 2026-06-07 08:00-16:00 UTC
Data accessed: patient demographics (read-only)
Service token: Matches SOC-observed token

The SOC team either was not notified or overlooked the change ticket. Despite the alarming logs, all activity appears authorized per the change management record.
Escalation Signals: Detailed suspicious activity logs; read-only access only; change ticket confirms scheduled authorized migration; SOC may not have been notified; enterprise healthcare with HIPAA data.
Duplicate Group: none`;

// CS-ER-003: Surface signal dampened - CEO urgency reduced
const TICKET_001_DAMPENED = `# Support Ticket

Ticket ID: SUP-2026-001
Subject: Possible payment processing issue — investigating with customer
Customer: Riverdale Medical
Customer Tier: Enterprise
Reported Time: 2026-06-07T13:15:00.000Z
Issue Type: Incident
Impact: Customer is reporting payment processing issues. Internal monitoring shows 99.97% success rate and passing health checks. Impact is disputed.
Description: Riverdale Medical CEO reports "some payment transactions may be failing — customers are reporting errors." They are requesting escalation. HOWEVER, internal monitoring data from the same period tells a different story: payment gateway health check is PASSING (response time 45ms, within SLA), aggregate transaction success rate over the last hour is 99.97% (12,403 succeeded, 4 failed), and no other customers sharing this gateway report issues. The customer's own technical contact (IT Operations Lead) adds a conflicting note: "We are seeing intermittent errors on our network segment — I cannot confirm this is on your side. Our internal network has been unstable since overnight maintenance." Two authoritative sources within the same ticket: CEO (claims payment issues) and IT Lead (suggests customer-side network issue). Internal monitoring provides objective third source contradicting the outage claim. The ticket also includes a link to the customer's status page showing "All Systems Operational."
Escalation Signals: Conflicting internal vs external reporting; CEO requesting escalation; IT contact says likely customer-side; monitoring confirms no platform outage; no other customers affected.
Duplicate Group: none`;

// CS-ER-004: Evidence ordering - audit all-clear FIRST
const TICKET_003_ORDERED = `# Support Ticket

Ticket ID: SUP-2026-003
Subject: Security audit completed — no breach confirmed — customer has questions about charges
Customer: Northstar Bank
Customer Tier: Enterprise
Reported Time: 2026-06-07T14:00:00.000Z
Issue Type: Security Concern
Impact: Customer reports unfamiliar transactions in account. Internal security audit confirms all activity is legitimate. No security incident occurred.
Description: The internal security audit (referenced in this ticket, audit ID: AUD-2026-0607-089) was automatically triggered and completed within 2 minutes. The audit confirms: all account access in the last 30 days originated from the customer's known IP range (192.168.45.0/24), the "unfamiliar" transactions match subscription service charges for "CloudAnalytics Pro" (a service the customer signed up for on 2026-03-15 via the account portal — confirmed by portal audit log), and no unauthorized API calls or privilege escalations were detected. The security team added a note: "No security incident. Customer appears unaware of their own subscription. Recommend Customer Success outreach to explain the charges." SEPARATELY, the customer reports seeing "unfamiliar recurring transactions" in their business account and is requesting a P1 Security investigation and account freeze. Despite the Security Concern issue type and the customer's breach concerns, the audit evidence clearly shows no unauthorized access.
Escalation Signals: Security Concern issue type; customer concerned about data breach; detailed internal audit confirms no incident; enterprise customer; no actual security impact.
Duplicate Group: none`;

// CS-ER-005: Multiple corroborating sources
const TICKET_001_CORROBORATED = `# Support Ticket

Ticket ID: SUP-2026-001
Subject: Complete payment processing failure — monitoring data contradicts customer report
Customer: Riverdale Medical
Customer Tier: Enterprise
Reported Time: 2026-06-07T13:15:00.000Z
Issue Type: Incident
Impact: Customer reports 100% payment processing failure. Internal monitoring shows 99.97% success rate and passing health checks. Impact is disputed.
Description: Riverdale Medical CEO reports "complete payment processing failure — all transactions returning errors." Requesting immediate P1 escalation. HOWEVER, internal monitoring data from the same period tells a different story: payment gateway health check is PASSING (response time 45ms, within SLA), aggregate transaction success rate over the last hour is 99.97% (12,403 succeeded, 4 failed), and no other customers sharing this gateway report issues. The customer's own technical contact (IT Operations Lead) adds a conflicting note: "We are seeing intermittent errors on our network segment — I cannot confirm this is on your side. Our internal network has been unstable since overnight maintenance." Two authoritative sources within the same ticket: CEO (claims P1 outage) and IT Lead (suggests customer-side network issue). Internal monitoring provides objective third source contradicting the outage claim. The ticket also includes a link to the customer's status page showing "All Systems Operational." Additionally, automated health check logs from the payment gateway show zero downtime in the past 24 hours, and the infrastructure team confirms no changes, alerts, or incidents on the payment platform during the reported timeframe.
Escalation Signals: Conflicting internal vs external reporting; CEO demanding P1 escalation; IT contact says likely customer-side; monitoring confirms no platform outage; no other customers affected; infrastructure team confirms no platform incidents.
Duplicate Group: none`;

// ─── CS Validation Runner ─────────────────────────────────────────────────────

async function runCSValidationCases() {
  const cases = [
    { label: 'CS-ER-001: Counter-evidence position (ticket-005, change ticket FIRST)', ticket: 'ticket-005.md', content: TICKET_005_POSITION, runs: 2 },
    { label: 'CS-ER-002: Structured counter-evidence (ticket-005, change ticket as table)', ticket: 'ticket-005.md', content: TICKET_005_FORMAT, runs: 2 },
    { label: 'CS-ER-003: Dampened urgency (ticket-001, CEO language reduced)', ticket: 'ticket-001.md', content: TICKET_001_DAMPENED, runs: 2 },
    { label: 'CS-ER-004: Evidence reordered (ticket-003, audit all-clear FIRST)', ticket: 'ticket-003.md', content: TICKET_003_ORDERED, runs: 2 },
    { label: 'CS-ER-005: Multiple corroborating sources (ticket-001, infra team confirms)', ticket: 'ticket-001.md', content: TICKET_001_CORROBORATED, runs: 2 },
  ];

  // Backup original tickets that will be modified
  const originals = {};
  for (const c of cases) {
    const fp = path.join(INBOX, c.ticket);
    if (!originals[c.ticket]) originals[c.ticket] = fs.readFileSync(fp, 'utf8');
  }

  for (const c of cases) {
    console.log(`\n─── ${c.label} ───`);
    for (let run = 1; run <= c.runs; run++) {
      console.log(`\n--- Run ${run}/${c.runs} ---`);

      // Regenerate fixture from scratch
      console.log('[gen] Generating support fixture...');
      await generateSupportFixture();

      console.log('[gen] Expanding with edge cases...');
      expandSupportFixture();

      // Override specific ticket
      const fp = path.join(INBOX, c.ticket);
      fs.writeFileSync(fp, c.content);
      console.log(`[mod] Overwrote ${c.ticket}`);

      // Run the test
      await runOneCSTest(`${c.label} (run ${run})`);

      // Clean output artifacts
      for (const f of ['triage-plan.md', 'escalation-list.md']) {
        const fp = path.join(WORKSPACE_ROOT, 'support-queue', f);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      }
    }
    // Restore original
    const fp = path.join(INBOX, c.ticket);
    fs.writeFileSync(fp, originals[c.ticket]);
    console.log(`[restore] Restored ${c.ticket}`);
  }
}

// ─── Modified Vendor Content ──────────────────────────────────────────────────

// VC-ER-001: Explicit contradiction formatting (vendor-036)
// Already has Documentation Alert; make it bolder with explicit header
const VENDOR_036_BOLD = `# Vendor Compliance Packet

## Vendor ID
vendor-036

## Vendor Name
CertWall

## Service
Certificate lifecycle management and PKI services

## Criticality
Critical

## Annual Spend
$350K

## Data Access
Certificate metadata and public key material

## Data Processing Agreement
Signed and current

## Security Certification
SOC2 Type II

## Certification Expiry Date
2025-08-01

## Certification Issue Date
2026-01-15

## Certification Status
Expired

## Incident Status
None reported

## !!! DATA INTEGRITY ALERT: CHRONOLOGICALLY IMPOSSIBLE DATES !!!
The certification expiry date (2025-08-01) PRECEDES the certification issue date (2026-01-15) by approximately 5 months. A certificate CANNOT expire before it was issued. This is a chronological impossibility that indicates corrupted, fabricated, or misattributed documentation. The certification status is listed as "Expired" but even that is suspect given the date contradiction. Policy requires trustworthy evidence for approval — this evidence fails basic data integrity checks.

## Evidence Notes
Use this packet as the vendor source of truth. Apply the workflow policy to decide Approve, Conditional Approve, or Reject.`;

// VC-ER-002: Authoritative source prominence (vendor-032)
// Move signed DPA to top
const VENDOR_032_DPA = `# Vendor Compliance Packet

## Vendor ID
vendor-032

## Vendor Name
DataCert

## Service
Data certification and validation services

## VALID EXECUTED DATA PROCESSING AGREEMENT ON FILE
The DPA is signed and current. This is the primary compliance document required for processing. All other fields below are supplementary and do not block conditional processing.

## Criticality
Not specified

## Annual Spend
Not provided

## Data Access
Not provided

## Data Processing Agreement
Signed and current

## Security Certification
Not specified

## Certification Expiry Date
Not provided

## Certification Status
Current

## Incident Status
None reported

## Incomplete Packet Note
This vendor submission is severely incomplete. The Criticality, Annual Spend, and Data Access fields were not provided. The certification type is not specified, and the certification expiry date is missing. It is unclear whether this is a deliberate omission or an administrative error. The DPA is signed and current, but without complete risk assessment fields and certification details, a full compliance determination cannot be made.

## Evidence Notes
Use this packet as the vendor source of truth. Apply the workflow policy to decide Approve, Conditional Approve, or Reject.`;

// VC-ER-003: Conflicting cert prominence (vendor-024)
// Move ISO expiration into main cert section
const VENDOR_024_CONFLICT = `# Vendor Compliance Packet

## Vendor ID
vendor-024

## Vendor Name
PolicyStream

## Service
Data policy management and compliance tracking

## Criticality
High

## Annual Spend
$180K

## Data Access
Policy configuration metadata and audit logs

## Data Processing Agreement
Signed and current

## Security Certification (Primary)
SOC2 Type II — Current, expires 2027-06-01

## Security Certification (Secondary)
ISO 27001 — EXPIRED 2025-03-15, no renewal evidence

## Certification Expiry Date
2027-06-01 (SOC2); 2025-03-15 (ISO 27001 — expired)

## Certification Status
Current (SOC2); Expired (ISO 27001)

## Incident Status
None reported

## Documentation Alert
This vendor holds two security certifications with conflicting statuses: SOC2 Type II (current, expires 2027-06-01) AND ISO 27001 (expired 2025-03-15). The vendor packet lists SOC2 Type II as the primary certification with "Current" status, but a secondary certification (ISO 27001) was found in the vendor's historical records with an expiry date of 2025-03-15 and no renewal evidence. Policy requires all relevant certifications to be current for full approval.

## Evidence Notes
Use this packet as the vendor source of truth. Apply the workflow policy to decide Approve, Conditional Approve, or Reject.`;

// ─── VC Validation Runner ─────────────────────────────────────────────────────

async function runVCValidationCases() {
  console.log(`\n─── VC Evidence Reconciliation Validation ───`);

  // Backup originals
  const vcOriginals = {};
  for (const v of ['vendor-024.md', 'vendor-032.md', 'vendor-036.md']) {
    const fp = path.join(VENDOR_DIR, v);
    vcOriginals[v] = fs.readFileSync(fp, 'utf8');
  }

  // Write modified vendor files
  fs.writeFileSync(path.join(VENDOR_DIR, 'vendor-036.md'), VENDOR_036_BOLD);
  fs.writeFileSync(path.join(VENDOR_DIR, 'vendor-032.md'), VENDOR_032_DPA);
  fs.writeFileSync(path.join(VENDOR_DIR, 'vendor-024.md'), VENDOR_024_CONFLICT);
  console.log('[mod] Overwrote vendor-024, vendor-032, vendor-036 with validation variants');

  // Run the full pipeline using the existing VC1 pipeline script
  console.log('\n[run] Starting VC pipeline (this will take a while)...');
  
  const pipeline = spawn('node', ['scripts/run-vc1-pipeline.js'], {
    cwd: ROOT,
    stdio: ['inherit', 'pipe', 'pipe'],
    env: { ...process.env, WORKSPACE_ROOT, DATA_DIR }
  });

  let out = '';
  let err = '';
  pipeline.stdout.on('data', d => { out += d.toString(); process.stdout.write(d); });
  pipeline.stderr.on('data', d => { err += d.toString(); process.stderr.write(d); });

  await new Promise((resolve, reject) => {
    pipeline.on('close', code => {
      console.log(`\n[run] VC pipeline completed with exit code ${code}`);
      resolve();
    });
  });

  // Extract verifier results from output
  const passCount = (out.match(/PASS(?:ED|ES)?/gi) || []).length;
  const failCount = (out.match(/FAIL(?:ED|URE)?/gi) || []).length;
  
  // Get specific vendor results by checking output for vendor mentions
  const vendorResults = {};
  for (const v of ['vendor-024', 'vendor-032', 'vendor-036']) {
    const lines = out.split('\n').filter(l => l.includes(v));
    vendorResults[v] = lines;
  }

  RESULTS.push({
    label: 'VC-ER validation (all 3 vendors modified)',
    runStatus: 'completed',
    verifierPassed: failCount === 0,
    passed: passCount,
    failed: failCount,
    pipelineOutput: out.substring(0, 3000) + err.substring(0, 1000),
    vendorResults
  });

  // Restore originals
  for (const v of ['vendor-024.md', 'vendor-032.md', 'vendor-036.md']) {
    fs.writeFileSync(path.join(VENDOR_DIR, v), vcOriginals[v]);
  }
  console.log('[restore] Restored original vendor files');
}

// ─── Report ───────────────────────────────────────────────────────────────────

function printReport() {
  console.log('\n\n========================================');
  console.log('   EVIDENCE RECONCILIATION VALIDATION');
  console.log('========================================\n');

  for (const r of RESULTS) {
    console.log(`${r.verifierPassed ? 'PASS' : 'FAIL'} | ${r.label}`);
    if (r.failures && r.failures.length > 0) {
      for (const f of r.failures) console.log(`      ${f}`);
    }
    if (r.vendorResults) {
      for (const [v, lines] of Object.entries(r.vendorResults)) {
        console.log(`      ${v}: ${lines.length ? lines.join('; ') : 'no explicit mention'}`);
      }
    }
  }

  console.log('\n--- Summary ---');
  const totalCS = RESULTS.filter(r => r.label.startsWith('CS'));
  const totalVC = RESULTS.filter(r => r.label.startsWith('VC'));
  console.log(`CS validation runs: ${totalCS.length}`);
  console.log(`  Passed: ${totalCS.filter(r => r.verifierPassed).length}`);
  console.log(`  Failed: ${totalCS.filter(r => !r.verifierPassed).length}`);
  console.log(`VC validation runs: ${totalVC.length}`);
  console.log(`  Verifier passed: ${totalVC.filter(r => r.verifierPassed).length}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60));
  console.log('EVIDENCE RECONCILIATION HYPOTHESIS VALIDATION');
  console.log('='.repeat(60));

  // Clean workspace output
  for (const dir of ['support-queue', 'vendors/chunks', 'vendors']) {
    const d = path.join(WORKSPACE_ROOT, dir);
    if (fs.existsSync(d)) {
      for (const f of fs.readdirSync(d)) {
        const fp = path.join(d, f);
        if (f.endsWith('.csv') || f.endsWith('.md')) {
          fs.unlinkSync(fp);
          console.log(`Cleaned: ${dir}/${f}`);
        }
      }
    }
  }

  // Run CS validation
  console.log('\n>>> CUSTOMER SUPPORT VALIDATION <<<');
  await runCSValidationCases();

  // Run VC validation
  console.log('\n>>> VENDOR COMPLIANCE VALIDATION <<<');
  await runVCValidationCases();

  printReport();

  console.log('\nDone.');
}

main().catch(err => { console.error('\nFATAL:', err.message, err.stack); process.exit(1); });
