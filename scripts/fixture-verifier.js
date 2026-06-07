#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"') {
      current += '"';
      i++;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  values.push(current.trim());
  return values.map(value => value.replace(/^['"]|['"]$/g, ''));
}

function readCSV(filepath) {
  if (!fs.existsSync(filepath)) return null;
  const content = fs.readFileSync(filepath, 'utf8').trim();
  if (!content) return { headers: [], rows: [] };

  const lines = content.split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase().replace(/["']/g, ''));
  const rows = lines.slice(1).map(line => {
    const vals = parseCsvLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
    return obj;
  });

  return { headers, rows };
}

function sha256File(filepath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filepath)).digest('hex');
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

function findArtifact(relativePath) {
  const fp = path.join(WORKSPACE_ROOT, relativePath);
  return fs.existsSync(fp) ? fp : null;
}

function listWorkspaceFiles(rootDir) {
  const files = [];
  function visit(dir) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, name);
      const rel = path.relative(rootDir, fullPath).replace(/\\/g, '/');
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) visit(fullPath);
      else files.push(rel);
    }
  }
  visit(rootDir);
  return files;
}

function normalizeCell(value) {
  return String(value || '').trim().toLowerCase();
}

function acceptableValues(expected, fieldName, fallbackFieldName) {
  const values = Array.isArray(expected[fieldName]) && expected[fieldName].length > 0
    ? expected[fieldName]
    : [expected[fallbackFieldName]];
  return values.map(value => String(value || ''));
}

function valueAllowed(actual, allowed) {
  return allowed.includes(String(actual || ''));
}

function nextActionAllowed(actual, allowed) {
  const normalizedActual = normalizeCell(actual);
  return allowed.some(value => normalizedActual.includes(normalizeCell(value)));
}

function verifyCustomerSupport() {
  const fixturePath = path.join(WORKSPACE_ROOT, 'support-inbox');
  const manifest = loadManifest(fixturePath);
  if (!manifest) return fail('No fixture-manifest.json found in support-inbox/');

  const passed = [];
  const failed = [];
  const expectedItems = manifest.expectedDecisionSet && Array.isArray(manifest.expectedDecisionSet.files)
    ? manifest.expectedDecisionSet.files
    : [];

  const triagePath = findArtifact('support-queue/triage-plan.md');
  const escalationPath = findArtifact('support-queue/escalation-list.md');

  if (!triagePath) {
    failed.push('Missing support-queue/triage-plan.md');
  }
  if (!escalationPath) {
    failed.push('Missing support-queue/escalation-list.md');
  }

  const triageContent = triagePath ? fs.readFileSync(triagePath, 'utf8') : '';
  const escalationContent = escalationPath ? fs.readFileSync(escalationPath, 'utf8') : '';
  if (triagePath) passed.push('triage-plan.md present (' + triageContent.length + ' chars)');
  if (escalationPath) passed.push('escalation-list.md present (' + escalationContent.length + ' chars)');

  const triageCsv = readCSV(path.join(WORKSPACE_ROOT, 'support-queue', 'triage-plan.csv'));
  const register = triageCsv || extractSupportRowsFromMarkdown(triageContent);
  const requiredColumns = ['ticket_id', 'customer_name', 'priority', 'assignee_team', 'escalation', 'sla', 'next_action', 'duplicate_of'];
  const missingColumns = requiredColumns.filter(column => !register.headers.includes(column));
  if (missingColumns.length > 0) failed.push('Missing triage columns: ' + missingColumns.join(', '));
  else passed.push('Triage plan has required structured columns');

  const rowsByTicketId = new Map(register.rows.map(row => [row.ticket_id, row]));
  for (const expected of expectedItems) {
    const row = rowsByTicketId.get(expected.ticketId);
    if (!row) {
      failed.push(expected.ticketId + ': missing from triage plan');
      continue;
    }
    if (row.customer_name !== expected.customerName) failed.push(expected.ticketId + ': customer mismatch, expected ' + expected.customerName + ', got ' + (row.customer_name || '(missing)'));
    const allowedPriorities = acceptableValues(expected, 'acceptablePriority', 'expectedPriority');
    const allowedTeams = acceptableValues(expected, 'acceptableTeam', 'expectedTeam');
    const allowedEscalations = acceptableValues(expected, 'acceptableEscalation', 'expectedEscalation');
    const allowedSlas = acceptableValues(expected, 'acceptableSla', 'expectedSla');
    const allowedNextActions = acceptableValues(expected, 'acceptableNextActionKind', 'expectedNextActionKind');
    if (!valueAllowed(row.priority, allowedPriorities)) failed.push(expected.ticketId + ': priority mismatch, expected ' + allowedPriorities.join(' or ') + ', got ' + (row.priority || '(missing)'));
    if (!valueAllowed(row.assignee_team, allowedTeams)) failed.push(expected.ticketId + ': assignee team mismatch, expected ' + allowedTeams.join(' or ') + ', got ' + (row.assignee_team || '(missing)'));
    if (!valueAllowed(row.escalation, allowedEscalations)) failed.push(expected.ticketId + ': escalation mismatch, expected ' + allowedEscalations.join(' or ') + ', got ' + (row.escalation || '(missing)'));
    if (!valueAllowed(row.sla, allowedSlas)) failed.push(expected.ticketId + ': SLA mismatch, expected ' + allowedSlas.join(' or ') + ', got ' + (row.sla || '(missing)'));
    if (!nextActionAllowed(row.next_action, allowedNextActions)) failed.push(expected.ticketId + ': next_action should reference ' + allowedNextActions.join(' or '));
  }

  const sourceTicketIds = new Set(expectedItems.map(item => item.ticketId));
  for (const row of register.rows) {
    if (row.ticket_id && !sourceTicketIds.has(row.ticket_id)) failed.push('Hallucinated ticket ID in triage plan: ' + row.ticket_id);
    const expected = expectedItems.find(item => item.ticketId === row.ticket_id);
    if (expected && row.customer_name && row.customer_name !== expected.customerName) failed.push(row.ticket_id + ': hallucinated customer name ' + row.customer_name);
  }

  if (expectedItems.length > 0 && expectedItems.every(item => rowsByTicketId.has(item.ticketId))) {
    passed.push('All ' + expectedItems.length + ' source tickets accounted for');
  }

  const expectedEscalations = manifest.expectedDecisionSet && Array.isArray(manifest.expectedDecisionSet.expectedEscalationTicketIds)
    ? manifest.expectedDecisionSet.expectedEscalationTicketIds
    : [];
  for (const ticketId of expectedEscalations) {
    if (!escalationContent.includes(ticketId)) failed.push(ticketId + ': missing from escalation list');
  }
  const nonEscalations = expectedItems
    .filter(item => {
      const allowed = acceptableValues(item, 'acceptableEscalation', 'expectedEscalation');
      return allowed.length === 1 && allowed[0] === 'No';
    })
    .map(item => item.ticketId);
  for (const ticketId of nonEscalations) {
    if (escalationContent.includes(ticketId)) failed.push(ticketId + ': non-escalation ticket should not appear in escalation list');
  }
  if (expectedEscalations.length > 0 && expectedEscalations.every(ticketId => escalationContent.includes(ticketId))) {
    passed.push('All escalation tickets present in escalation list');
  }

  const duplicateGroups = manifest.expectedDecisionSet && manifest.expectedDecisionSet.duplicateGroups && typeof manifest.expectedDecisionSet.duplicateGroups === 'object'
    ? manifest.expectedDecisionSet.duplicateGroups
    : {};
  for (const [group, ticketIds] of Object.entries(duplicateGroups)) {
    if (!ticketIds.every(ticketId => triageContent.includes(ticketId))) failed.push('Duplicate group ' + group + ' missing one or more ticket IDs from triage plan');
    if (!normalizeCell(triageContent).includes('duplicate')) failed.push('Duplicate group ' + group + ' not recognized in triage plan');
    const primaryTicketId = ticketIds[0];
    for (const duplicateTicketId of ticketIds.slice(1)) {
      const duplicateRow = rowsByTicketId.get(duplicateTicketId);
      if (!duplicateRow) continue;
      if (duplicateRow.duplicate_of !== primaryTicketId) {
        failed.push(duplicateTicketId + ': expected duplicate_of ' + primaryTicketId + ', got ' + (duplicateRow.duplicate_of || '(blank)'));
      }
    }
  }
  if (Object.keys(duplicateGroups).length > 0 && normalizeCell(triageContent).includes('duplicate')) passed.push('Duplicate chains recognized');

  const workspaceFiles = listWorkspaceFiles(WORKSPACE_ROOT);
  const workspacePolicyArtifacts = workspaceFiles.filter(p => /(^|\/)(policy|verifier|oracle)(\/|\.|-|_)/i.test(p) && p !== 'support-inbox/fixture-manifest.json');
  if (workspacePolicyArtifacts.length > 0) failed.push('Workspace contains policy/verifier artifacts: ' + workspacePolicyArtifacts.join(', '));
  else passed.push('No policy/verifier artifacts in workspace');

  const requireReplay = process.env.REQUIRE_REPLAY_EVIDENCE === '1' || process.env.REQUIRE_REPLAY_EVIDENCE === 'true';
  const snapshots = readReplaySnapshotsFromEnv();
  const snapshot = readReplaySnapshotFromEnv();
  const replaySnapshots = snapshots.length > 0 ? snapshots : (snapshot ? [snapshot] : []);
  if (replaySnapshots.length > 0) {
    const invocations = replaySnapshots.flatMap(item => item.workflowInvocation || []);
    const requiredWorkflowIds = String(process.env.SUPPORT_REQUIRED_WORKFLOW_IDS || 'customer-support-triage')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
    for (const workflowId of requiredWorkflowIds) {
      const invocation = invocations.find(item => item.workflowId === workflowId);
      if (!invocation) {
        failed.push('Replay missing ' + workflowId + ' workflow invocation');
        continue;
      }
      const missing = ['workflowVersion', 'policyId', 'policyVersion', 'policyTextHash', 'verifierContractId', 'verifierContractVersion']
        .filter(field => !invocation[field]);
      if (missing.length > 0) failed.push('Replay missing workflow/policy/verifier metadata for ' + workflowId + ': ' + missing.join(', '));
    }
    if (!requiredWorkflowIds.some(workflowId => !invocations.find(item => item.workflowId === workflowId))) {
      passed.push('Replay workflow/policy/verifier metadata present');
    }
  } else if (requireReplay) {
    failed.push('Replay evidence required but DATA_DIR/RUN_ID snapshot was not available');
  }

  if (failed.length === 0) passed.push('Customer Support strict verification passed');

  return {
    passed: failed.length === 0,
    checks: [...passed.map(p => ({ status: 'pass', message: p })), ...failed.map(f => ({ status: 'fail', message: f }))],
    count: { passed: passed.length, failed: failed.length }
  };
}

function extractSupportRowsFromMarkdown(content) {
  const lines = String(content || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const headerIndex = lines.findIndex(line => /^\|\s*ticket_id\s*\|/i.test(line));
  if (headerIndex < 0) return { headers: [], rows: [] };
  const headers = lines[headerIndex].split('|').map(cell => cell.trim().toLowerCase()).filter(Boolean);
  const rows = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) break;
    const cells = line.split('|').map(cell => cell.trim()).filter((_, index, arr) => index > 0 && index < arr.length - 1);
    if (cells.every(cell => /^-+$/.test(cell.replace(/\s/g, '')))) continue;
    if (cells.length !== headers.length) continue;
    const row = {};
    headers.forEach((header, index) => { row[header] = cells[index] || ''; });
    rows.push(row);
  }
  return { headers, rows };
}

// ── Vendor Compliance Verifier ──

function verifyVendorCompliance() {
  const fixturePath = path.join(WORKSPACE_ROOT, 'vendors');
  const manifest = loadManifest(fixturePath);
  if (!manifest) return fail('No fixture-manifest.json found in vendors/');

  if (args['failure-chain']) {
    return verifyVendorFailureHandoff(fixturePath, manifest);
  }

  if (args['ticket-plan']) {
    return verifyVendorTicketPlan(fixturePath, manifest);
  }

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

  if (args.chain) {
    verifyVendorRemediationChain(fixturePath, manifest, register, passed, failed);
  }

  return {
    passed: failed.length === 0,
    checks: [...passed.map(p => ({ status: 'pass', message: p })), ...failed.map(f => ({ status: 'fail', message: f }))],
    count: { passed: passed.length, failed: failed.length }
  };
}


function readRunRecordFromEnv(runId) {
  const dataDir = process.env.DATA_DIR;
  if (!dataDir || !runId) return null;
  const runsPath = path.join(dataDir, 'runs.json');
  if (!fs.existsSync(runsPath)) return null;
  const runs = JSON.parse(fs.readFileSync(runsPath, 'utf8'));
  return runs.find(run => String(run.id) === String(runId)) || null;
}

function readReplaySnapshotByRunId(runId) {
  const dataDir = process.env.DATA_DIR;
  if (!dataDir || !runId) return null;
  const snapshotPath = path.join(dataDir, 'replay-snapshots', 'run-' + runId + '.json');
  if (!fs.existsSync(snapshotPath)) return null;
  return JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
}


function readTicketsFromEnv() {
  const dataDir = process.env.DATA_DIR;
  if (!dataDir) return [];
  const ticketsPath = path.join(dataDir, 'tickets.json');
  if (!fs.existsSync(ticketsPath)) return [];
  return JSON.parse(fs.readFileSync(ticketsPath, 'utf8'));
}

function verifyVendorTicketPlan(fixturePath, manifest) {
  const passed = [];
  const failed = [];
  const runId = process.env.RUN_ID;
  const expectedItems = manifest.expectedDecisionSet && Array.isArray(manifest.expectedDecisionSet.files)
    ? manifest.expectedDecisionSet.files
    : [];
  const expectedRemediation = expectedItems.filter(item =>
    item.expectedDisposition === 'Conditional Approve' || item.expectedDisposition === 'Reject'
  );
  const expectedApprove = expectedItems.filter(item => item.expectedDisposition === 'Approve');
  const tickets = readTicketsFromEnv();
  const childTickets = tickets.filter(ticket => String(ticket.parentRunId || '') === String(runId || ''));
  const childByVendorId = new Map(childTickets.map(ticket => [ticket.workflowInput && ticket.workflowInput.vendorId, ticket]));

  if (childTickets.length === expectedRemediation.length) {
    passed.push('Child ticket count matched expected remediation vendors: ' + childTickets.length);
  } else {
    failed.push('Expected ' + expectedRemediation.length + ' child tickets, found ' + childTickets.length);
  }

  for (const expected of expectedRemediation) {
    const ticket = childByVendorId.get(expected.vendorId);
    if (!ticket) {
      failed.push(expected.vendorName + ': missing remediation child ticket');
      continue;
    }
    if (ticket.workflowId !== 'vendor-remediation-task') failed.push(expected.vendorName + ': child workflowId mismatch: ' + ticket.workflowId);
    if (!ticket.workflowInput || ticket.workflowInput.vendorId !== expected.vendorId) failed.push(expected.vendorName + ': child workflowInput vendorId mismatch');
    if (!ticket.parentTicketId || !ticket.parentRunId || !ticket.parentWorkflowId || !ticket.spawnedByStepId || !ticket.spawnPlanId) {
      failed.push(expected.vendorName + ': child ticket missing parent/spawn metadata');
    }
    if (!ticket.spawnIdempotencyKey) failed.push(expected.vendorName + ': child ticket missing idempotency key');
  }

  for (const expected of expectedApprove) {
    if (childByVendorId.has(expected.vendorId)) {
      failed.push(expected.vendorName + ': Approve vendor should not have child ticket');
    }
  }

  if (expectedRemediation.length && expectedRemediation.every(item => childByVendorId.has(item.vendorId))) {
    passed.push('All remediation vendor child tickets present');
  }
  if (expectedApprove.length && expectedApprove.every(item => !childByVendorId.has(item.vendorId))) {
    passed.push('No child tickets for Approve vendors');
  }
  if (childTickets.every(ticket => ticket.workflowId === 'vendor-remediation-task')) {
    passed.push('All child tickets use vendor-remediation-task workflow');
  }
  if (childTickets.every(ticket => ticket.parentTicketId && ticket.parentRunId && ticket.parentWorkflowId && ticket.spawnedByStepId && ticket.spawnPlanId)) {
    passed.push('All child tickets record parent metadata');
  }

  const snapshot = readReplaySnapshotFromEnv();
  const requireReplay = process.env.REQUIRE_REPLAY_EVIDENCE === '1' || process.env.REQUIRE_REPLAY_EVIDENCE === 'true';
  if (snapshot) {
    const plan = (snapshot.workflowTicketPlans || []).find(item => item.workflowId === 'vendor-compliance-remediation-ticket-plan');
    if (!plan) failed.push('Replay missing vendor-compliance-remediation-ticket-plan workflowTicketPlans evidence');
    else {
      if (!Array.isArray(plan.proposedTickets) || plan.proposedTickets.length !== expectedRemediation.length) failed.push('Replay proposed ticket count mismatch');
      if (!Array.isArray(plan.acceptedTickets) || plan.acceptedTickets.length !== expectedRemediation.length) failed.push('Replay accepted ticket count mismatch');
      if (Array.isArray(plan.rejectedTickets) && plan.rejectedTickets.length > 0) failed.push('Replay should not contain rejected ticket proposals');
      if (!Array.isArray(plan.createdTicketIds) || plan.createdTicketIds.length !== expectedRemediation.length) failed.push('Replay created ticket count mismatch');
      if (plan.spawnPlanId) passed.push('Replay ticket-plan evidence present');
    }
  } else if (requireReplay) {
    failed.push('Replay evidence required but DATA_DIR/RUN_ID snapshot was not available');
  }

  return {
    passed: failed.length === 0,
    checks: [...passed.map(p => ({ status: 'pass', message: p })), ...failed.map(f => ({ status: 'fail', message: f }))],
    count: { passed: passed.length, failed: failed.length }
  };
}

function verifyVendorFailureHandoff(fixturePath, manifest) {
  const passed = [];
  const failed = [];
  const expectedHeader = 'vendor_id,vendor_name,disposition,remediation_action,due_days,owner';

  if (fs.existsSync(path.join(fixturePath, 'vendor-decision-register.csv'))) {
    failed.push('Stage 1 decision register should be absent for missing-source failure handoff');
  } else {
    passed.push('Stage 1 decision register absent');
  }

  if (fs.existsSync(path.join(fixturePath, 'compliance-review.md'))) {
    failed.push('Stage 1 compliance review should be absent for missing-source failure handoff');
  } else {
    passed.push('Stage 1 compliance review absent');
  }

  const blockersPath = path.join(fixturePath, 'remediation-blockers.md');
  if (!fs.existsSync(blockersPath)) {
    failed.push('Missing remediation-blockers.md');
  } else {
    const content = fs.readFileSync(blockersPath, 'utf8');
    if (content.length < 150) failed.push('remediation-blockers.md too short (likely insufficient detail)');
    if (!/stage\s*1/i.test(content)) failed.push('remediation-blockers.md does not mention Stage 1');
    if (!/failed|failure|not completed/i.test(content)) failed.push('remediation-blockers.md does not state Stage 1 failed or did not complete');
    if (!content.includes('vendors/incoming/vendor-008.md')) failed.push('remediation-blockers.md missing controlled missing source path');
    if (!/cannot|blocked|not proceed|unavailable/i.test(content)) failed.push('remediation-blockers.md does not block completion');
    if (failed.length === 0 || fs.existsSync(blockersPath)) passed.push('remediation-blockers.md present (' + content.length + ' chars)');
  }

  const tasks = readCSV(path.join(fixturePath, 'remediation-tasks.csv'));
  if (!tasks) {
    failed.push('Missing remediation-tasks.csv');
  } else {
    const actualHeader = tasks.headers.join(',');
    if (actualHeader !== expectedHeader) failed.push('remediation-tasks.csv header mismatch: ' + actualHeader);
    else passed.push('remediation-tasks.csv has blocker-mode header');
    if (tasks.rows.length !== 0) failed.push('remediation-tasks.csv should have zero data rows when Stage 1 failed, found ' + tasks.rows.length);
    else passed.push('remediation-tasks.csv has zero data rows');
  }

  const stage1RunId = process.env.STAGE1_RUN_ID;
  const stage1Run = readRunRecordFromEnv(stage1RunId);
  if (!stage1Run) {
    failed.push('Stage 1 run record unavailable');
  } else if (stage1Run.status !== 'failed') {
    failed.push('Expected Stage 1 status failed, got ' + stage1Run.status);
  } else {
    passed.push('Stage 1 run status failed');
  }

  const stage1Snapshot = readReplaySnapshotByRunId(stage1RunId);
  if (!stage1Snapshot) {
    failed.push('Stage 1 replay snapshot unavailable');
  } else {
    const invocation = (stage1Snapshot.workflowInvocation || []).find(item => item.workflowId === 'vendor-compliance');
    if (!invocation) failed.push('Stage 1 replay missing vendor-compliance invocation');
    else passed.push('Stage 1 replay workflow invocation present');
    const failedRead = (stage1Snapshot.workflowActions || []).find(item => item.stepId === 'read_008' && item.error);
    if (!failedRead) failed.push('Stage 1 replay missing failed read_008 evidence');
    else passed.push('Stage 1 replay records failed read_008');
  }

  const stage2Snapshot = readReplaySnapshotFromEnv();
  const requireReplay = process.env.REQUIRE_REPLAY_EVIDENCE === '1' || process.env.REQUIRE_REPLAY_EVIDENCE === 'true';
  if (stage2Snapshot) {
    const invocation = (stage2Snapshot.workflowInvocation || []).find(item => item.workflowId === 'vendor-remediation-failure-handoff');
    if (!invocation) failed.push('Replay missing vendor-remediation-failure-handoff workflow invocation');
    else {
      const missing = ['workflowVersion', 'policyId', 'policyVersion', 'policyTextHash', 'verifierContractId', 'verifierContractVersion']
        .filter(key => !invocation[key]);
      if (missing.length) failed.push('Replay failure handoff invocation missing metadata: ' + missing.join(', '));
      else passed.push('Replay failure handoff workflow/policy/verifier metadata present');
    }
  } else if (requireReplay) {
    failed.push('Replay evidence required but DATA_DIR/RUN_ID snapshot was not available');
  }

  return {
    passed: failed.length === 0,
    checks: [...passed.map(p => ({ status: 'pass', message: p })), ...failed.map(f => ({ status: 'fail', message: f }))],
    count: { passed: passed.length, failed: failed.length }
  };
}

function verifyVendorRemediationChain(fixturePath, manifest, register, passed, failed) {
  const remediationPlanPath = path.join(fixturePath, 'remediation-plan.md');
  if (!fs.existsSync(remediationPlanPath)) {
    failed.push('Missing remediation-plan.md');
  } else {
    const content = fs.readFileSync(remediationPlanPath, 'utf8');
    if (content.length < 200) failed.push('remediation-plan.md too short (likely insufficient detail)');
    else passed.push('remediation-plan.md present (' + content.length + ' chars)');
  }

  const remediationTasks = readCSV(path.join(fixturePath, 'remediation-tasks.csv'));
  if (!remediationTasks) {
    failed.push('Missing remediation-tasks.csv');
    return;
  }

  const requiredColumns = ['vendor_id', 'vendor_name', 'disposition', 'remediation_action', 'due_days', 'owner'];
  const missingColumns = requiredColumns.filter(column => !remediationTasks.headers.includes(column));
  if (missingColumns.length) {
    failed.push('Missing columns in remediation-tasks.csv: ' + missingColumns.join(', '));
  } else {
    passed.push('remediation-tasks.csv has required columns');
  }

  const expectedItems = manifest.expectedDecisionSet && Array.isArray(manifest.expectedDecisionSet.files)
    ? manifest.expectedDecisionSet.files
    : [];
  const expectedRemediation = expectedItems.filter(item =>
    item.expectedDisposition === 'Conditional Approve' || item.expectedDisposition === 'Reject'
  );
  const expectedApprove = expectedItems.filter(item => item.expectedDisposition === 'Approve');
  const rowsByVendorId = new Map(remediationTasks.rows.map(row => [row.vendor_id, row]));

  for (const expected of expectedRemediation) {
    const row = rowsByVendorId.get(expected.vendorId);
    if (!row) {
      failed.push(expected.vendorName + ': missing remediation task');
      continue;
    }
    if (row.disposition !== expected.expectedDisposition) {
      failed.push(expected.vendorName + ': expected remediation disposition ' + expected.expectedDisposition + ', got ' + (row.disposition || '(missing)'));
    }
    const action = String(row.remediation_action || '').toLowerCase();
    if (expected.reasonCode === 'expired_certification' && !action.includes('recert')) {
      failed.push(expected.vendorName + ': expected recertification remediation action');
    }
    if (expected.reasonCode === 'active_incident' && !(action.includes('monitor') || action.includes('incident'))) {
      failed.push(expected.vendorName + ': expected monitoring or incident remediation action');
    }
    if (expected.reasonCode === 'missing_security_certification' && !(action.includes('certification') || action.includes('cert'))) {
      failed.push(expected.vendorName + ': expected security certification remediation action');
    }
    if (expected.reasonCode === 'missing_dpa' && !(action.includes('dpa') || action.includes('data processing'))) {
      failed.push(expected.vendorName + ': expected DPA remediation action');
    }
    if (!row.due_days || !/^\d+$/.test(String(row.due_days))) {
      failed.push(expected.vendorName + ': due_days must be numeric');
    }
    if (!row.owner || row.owner.length < 3) {
      failed.push(expected.vendorName + ': owner missing or too short');
    }
  }

  for (const expected of expectedApprove) {
    if (rowsByVendorId.has(expected.vendorId)) {
      failed.push(expected.vendorName + ': Approve vendor should not have remediation task');
    }
  }

  if (remediationTasks.rows.length !== expectedRemediation.length) {
    failed.push('Expected ' + expectedRemediation.length + ' remediation tasks, found ' + remediationTasks.rows.length);
  } else if (expectedRemediation.length) {
    passed.push('Exact remediation task count matched: ' + expectedRemediation.length);
  }

  const snapshot = readReplaySnapshotFromEnv();
  const requireReplay = process.env.REQUIRE_REPLAY_EVIDENCE === '1' || process.env.REQUIRE_REPLAY_EVIDENCE === 'true';
  if (snapshot) {
    const invocation = (snapshot.workflowInvocation || []).find(item => item.workflowId === 'vendor-remediation-plan');
    if (!invocation) failed.push('Replay missing vendor-remediation-plan workflow invocation');
    else {
      const missing = ['workflowVersion', 'policyId', 'policyVersion', 'policyTextHash', 'verifierContractId', 'verifierContractVersion']
        .filter(key => !invocation[key]);
      if (missing.length) failed.push('Replay vendor remediation invocation missing metadata: ' + missing.join(', '));
      else passed.push('Replay vendor remediation workflow/policy/verifier metadata present');
    }
  } else if (requireReplay) {
    failed.push('Replay evidence required but DATA_DIR/RUN_ID snapshot was not available');
  }
}

// ── Shared Drive Cleanup Verifier ──

function readReplaySnapshotFromEnv() {
  const dataDir = process.env.DATA_DIR;
  const runId = process.env.RUN_ID;
  if (!dataDir || !runId) return null;
  const snapshotPath = path.join(dataDir, 'replay-snapshots', 'run-' + runId + '.json');
  if (!fs.existsSync(snapshotPath)) return null;
  return JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
}

function readReplaySnapshotsFromEnv() {
  const dataDir = process.env.DATA_DIR;
  const runIds = String(process.env.RUN_IDS || '').split(',').map(item => item.trim()).filter(Boolean);
  if (!dataDir || runIds.length === 0) return [];
  return runIds.map(runId => {
    const snapshotPath = path.join(dataDir, 'replay-snapshots', 'run-' + runId + '.json');
    return fs.existsSync(snapshotPath) ? JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) : null;
  }).filter(Boolean);
}

function normalizePathValue(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function verifySharedDrive() {
  const drivePath = path.join(WORKSPACE_ROOT, 'shared-drive');
  const manifest = loadManifest(drivePath);
  if (!manifest) return fail('No fixture-manifest.json found in shared-drive/');

  const passed = [];
  const failed = [];
  const expected = manifest.expectedDecisionSet || {};
  const expectedMutations = Array.isArray(expected.expectedMutations) ? expected.expectedMutations : [];
  const expectedPreserved = Array.isArray(expected.expectedPreserved) ? expected.expectedPreserved : [];
  const expectedFolders = Array.isArray(expected.expectedFolders) ? expected.expectedFolders : [];
  const expectedFiles = Array.isArray(expected.files) ? expected.files : [];

  const reportPath = path.join(drivePath, 'migration-report.md');
  if (!fs.existsSync(reportPath)) {
    failed.push('Missing migration-report.md');
  } else {
    const content = fs.readFileSync(reportPath, 'utf8');
    if (content.length < 200) failed.push('migration-report.md too short (likely insufficient detail)');
    else passed.push('migration-report.md present (' + content.length + ' chars)');
  }

  const logPath = path.join(drivePath, 'cleanup-log.csv');
  const cleanupLog = readCSV(logPath);
  if (!cleanupLog) {
    failed.push('Missing cleanup-log.csv');
  } else {
    const requiredColumns = ['original_path', 'action', 'new_path', 'reason'];
    const missingColumns = requiredColumns.filter(column => !cleanupLog.headers.includes(column));
    if (missingColumns.length) failed.push('Missing columns in cleanup-log.csv: ' + missingColumns.join(', '));
    else passed.push('cleanup-log.csv has required columns');
  }

  for (const folder of expectedFolders) {
    const folderPath = path.join(WORKSPACE_ROOT, folder);
    if (fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory()) {
      passed.push('Expected folder exists: ' + folder);
    } else {
      failed.push('Missing expected folder: ' + folder);
    }
  }

  const logRows = cleanupLog ? cleanupLog.rows : [];
  const expectedByOriginal = new Map(expectedMutations.map(item => [normalizePathValue(item.originalPath), item]));
  const seenExpected = new Set();
  for (const row of logRows) {
    const originalPath = normalizePathValue(row.original_path);
    if (!expectedByOriginal.has(originalPath)) {
      failed.push('Unexpected cleanup-log mutation: ' + originalPath + ' -> ' + normalizePathValue(row.new_path));
      continue;
    }
    const mutation = expectedByOriginal.get(originalPath);
    seenExpected.add(originalPath);
    if (row.action !== mutation.action) {
      failed.push(originalPath + ': expected action ' + mutation.action + ', got ' + (row.action || '(missing)'));
    }
    if (normalizePathValue(row.new_path) !== normalizePathValue(mutation.newPath)) {
      failed.push(originalPath + ': expected new_path ' + mutation.newPath + ', got ' + (row.new_path || '(missing)'));
    }
    if (!row.reason || row.reason.length < 8) {
      failed.push(originalPath + ': cleanup log reason is missing or too short');
    }
  }

  for (const mutation of expectedMutations) {
    const originalPath = normalizePathValue(mutation.originalPath);
    const newPath = normalizePathValue(mutation.newPath);
    if (!seenExpected.has(originalPath)) {
      failed.push('Missing cleanup-log mutation for ' + originalPath);
    }
    const originalAbs = path.join(WORKSPACE_ROOT, originalPath);
    const newAbs = path.join(WORKSPACE_ROOT, newPath);
    if (fs.existsSync(originalAbs)) {
      failed.push('Moved source path still exists: ' + originalPath);
    }
    if (!fs.existsSync(newAbs)) {
      failed.push('Expected moved file missing: ' + newPath);
    } else if (mutation.contentHash && sha256File(newAbs) !== mutation.contentHash) {
      failed.push('Moved file content hash mismatch: ' + newPath);
    }
  }

  for (const preservedPath of expectedPreserved.map(normalizePathValue)) {
    const abs = path.join(WORKSPACE_ROOT, preservedPath);
    if (!fs.existsSync(abs)) {
      failed.push('Preserve/no-action file moved or missing: ' + preservedPath);
      continue;
    }
    const fileRecord = expectedFiles.find(item => normalizePathValue(item.sourcePath) === preservedPath);
    if (fileRecord && fileRecord.contentHash && sha256File(abs) !== fileRecord.contentHash) {
      failed.push('Preserve/no-action file content changed: ' + preservedPath);
    }
  }
  if (expectedPreserved.length) {
    passed.push('Preserve/no-action files checked: ' + expectedPreserved.length);
  }

  if (expectedMutations.length && logRows.length === expectedMutations.length) {
    passed.push('Exact expected mutation count matched: ' + expectedMutations.length);
  } else if (expectedMutations.length || logRows.length) {
    failed.push('Expected ' + expectedMutations.length + ' cleanup-log mutations, found ' + logRows.length);
  }

  const snapshot = readReplaySnapshotFromEnv();
  const requireReplay = process.env.REQUIRE_REPLAY_EVIDENCE === '1' || process.env.REQUIRE_REPLAY_EVIDENCE === 'true';
  if (snapshot) {
    const invocation = (snapshot.workflowInvocation || []).find(item => item.workflowId === 'shared-drive-cleanup');
    if (!invocation) failed.push('Replay missing shared-drive-cleanup workflow invocation');
    else {
      const missing = ['workflowVersion', 'policyId', 'policyVersion', 'policyTextHash', 'verifierContractId', 'verifierContractVersion']
        .filter(key => !invocation[key]);
      if (missing.length) failed.push('Replay workflow invocation missing metadata: ' + missing.join(', '));
      else passed.push('Replay workflow/policy/verifier metadata present');
    }

    const replayRenames = new Set((snapshot.workspaceOperations || [])
      .filter(item => item.operation && item.operation.operation === 'renamePath')
      .map(item => normalizePathValue(item.operation.args && item.operation.args.path) + '->' + normalizePathValue(item.operation.args && item.operation.args.nextPath)));
    let replayRenameMatches = 0;
    for (const mutation of expectedMutations) {
      const key = normalizePathValue(mutation.originalPath) + '->' + normalizePathValue(mutation.newPath);
      if (!replayRenames.has(key)) failed.push('Replay missing renamePath evidence: ' + key);
      else replayRenameMatches++;
    }
    if (expectedMutations.length && replayRenameMatches === expectedMutations.length) {
      passed.push('Replay renamePath evidence checked: ' + expectedMutations.length);
    }

    const replayWrites = new Set((snapshot.workspaceOperations || [])
      .filter(item => item.operation && item.operation.operation === 'writeFile')
      .map(item => normalizePathValue(item.operation.args && item.operation.args.path)));
    for (const artifactPath of ['shared-drive/migration-report.md', 'shared-drive/cleanup-log.csv']) {
      if (!replayWrites.has(artifactPath)) failed.push('Replay missing writeFile evidence: ' + artifactPath);
    }
  } else if (requireReplay) {
    failed.push('Replay evidence required but DATA_DIR/RUN_ID snapshot was not available');
  }

  if (failed.length === 0) {
    passed.push('Shared Drive Cleanup strict verification passed');
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
