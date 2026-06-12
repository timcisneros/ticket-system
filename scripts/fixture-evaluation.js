#!/usr/bin/env node
// Fixture Evaluation — measurement only. Scores already-produced workflow artifacts against the
// known expected answers in each fixture-manifest.json. Reads nothing but manifests + produced
// artifacts; writes nothing; runs no model and no workflow. Three metrics per domain:
//   artifact success     — required output files exist
//   structural success   — required columns present, every expected case has a well-formed row
//   business correctness — the decision values match the manifest's acceptable set
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const WS = path.join(ROOT, 'workspace-root');

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }
function exists(rel) { return fs.existsSync(path.join(WS, rel)); }
function readLines(rel) {
  try { return fs.readFileSync(path.join(WS, rel), 'utf8').split('\n').filter(l => l.trim().length); }
  catch (_) { return null; }
}
function splitCsv(line) { return line.split(',').map(s => s.trim()); }
function splitMd(line) { return line.replace(/^\||\|$/g, '').split('|').map(s => s.trim()); }

function scoreCsvDomain({ name, dir, register, columns, idCol, decisionCol, oracle, idKey }) {
  const out = { name, artifact: {}, structural: {}, business: {}, failures: [] };
  // artifact
  const files = ['vendors/vendor-decision-register.csv'];
  out.artifact = { filesExpected: register.files.length, filesPresent: register.files.filter(exists).length };
  const lines = readLines(`${dir}/${register.primary}`);
  if (!lines) { out.note = 'register not produced'; return out; }
  const header = splitCsv(lines[0]);
  const rows = lines.slice(1).map(l => ({ raw: l, cells: splitCsv(l) }));
  const colsOk = columns.every(c => header.includes(c));
  const di = header.indexOf(decisionCol), ii = header.indexOf(idCol);

  let rowsWellFormed = 0, malformed = 0, businessOk = 0, missing = 0;
  for (const exp of oracle) {
    const id = exp[idKey];
    const row = rows.find(r => r.cells[ii] === id);
    if (!row) { missing++; out.failures.push({ id, category: 'STRUCTURAL:missing_row' }); continue; }
    const wellFormed = row.cells.length === header.length;
    if (wellFormed) rowsWellFormed++; else { malformed++; out.failures.push({ id, category: 'STRUCTURAL:malformed_row', detail: `cols=${row.cells.length}/${header.length}` }); }
    const decision = row.cells[di];
    const acceptable = exp.acceptableDispositions || [exp.expectedDisposition];
    if (acceptable.includes(decision)) businessOk++;
    else out.failures.push({ id, category: 'BUSINESS:wrong_decision', got: decision, expected: acceptable.join('|') });
  }
  const n = oracle.length;
  out.structural = { expectedColumns: colsOk, rowsPresent: n - missing, rowsWellFormed, malformed, total: n,
    rate: ((rowsWellFormed) / n * 100).toFixed(1) + '%' };
  out.business = { correct: businessOk, total: n, rate: (businessOk / n * 100).toFixed(1) + '%' };
  return out;
}

function scoreCsDomain(oracle, schema) {
  const out = { name: 'customer-support', artifact: {}, structural: {}, business: {}, failures: [], perDimension: {} };
  out.artifact = { filesExpected: schema.files.length, filesPresent: schema.files.filter(exists).length };
  const lines = readLines('support-queue/triage-plan.md');
  if (!lines) { out.note = 'triage-plan not produced'; return out; }
  const tableLines = lines.filter(l => l.includes('|') && !/^\s*\|[-\s|]+\|\s*$/.test(l));
  const header = splitMd(tableLines[0]);
  const dataRows = tableLines.slice(1).map(l => { const c = splitMd(l); const o = {}; header.forEach((h, i) => o[h] = c[i]); return o; });
  const colsOk = schema.triageFields.every(c => header.includes(c));
  const dims = [['priority', 'acceptablePriority'], ['assignee_team', 'acceptableTeam'], ['escalation', 'acceptableEscalation'], ['sla', 'acceptableSla'], ['next_action', 'acceptableNextActionKind']];
  const dimHit = {}; dims.forEach(([d]) => dimHit[d] = 0);
  let rowsPresent = 0, businessOk = 0;
  for (const exp of oracle) {
    const row = dataRows.find(r => r.ticket_id === exp.ticketId);
    if (!row) { out.failures.push({ id: exp.ticketId, category: 'STRUCTURAL:missing_row' }); continue; }
    rowsPresent++;
    let allOk = true; const bad = [];
    for (const [col, key] of dims) {
      const acceptable = exp[key] || [];
      if (acceptable.includes(row[col])) dimHit[col]++;
      else { allOk = false; bad.push(`${col}=${row[col]}∉[${acceptable.join('|')}]`); }
    }
    if (allOk) businessOk++; else out.failures.push({ id: exp.ticketId, category: 'BUSINESS:wrong_decision', detail: bad.join(', ') });
  }
  const n = oracle.length;
  out.structural = { expectedColumns: colsOk, rowsPresent, total: n, rate: (rowsPresent / n * 100).toFixed(1) + '%' };
  out.business = { correct: businessOk, total: n, rate: (businessOk / n * 100).toFixed(1) + '%' };
  dims.forEach(([d]) => out.perDimension[d] = `${dimHit[d]}/${n} (${(dimHit[d] / n * 100).toFixed(0)}%)`);
  return out;
}

const results = [];
// Vendor
{
  const m = readJson(path.join(WS, 'vendors/fixture-manifest.json'));
  results.push(scoreCsvDomain({ name: 'vendor-compliance', dir: 'vendors',
    register: { files: m.expectedArtifactSchema.files, primary: 'vendor-decision-register.csv' },
    columns: m.expectedArtifactSchema.registerColumns, idCol: 'vendor_id', decisionCol: 'disposition',
    oracle: m.expectedDecisionSet.files, idKey: 'vendorId' }));
}
// Legal
{
  const m = readJson(path.join(WS, 'legal-intake/fixture-manifest.json'));
  results.push(scoreCsvDomain({ name: 'legal-intake', dir: 'legal-intake',
    register: { files: m.expectedArtifactSchema.files, primary: 'intake-register.csv' },
    columns: m.expectedArtifactSchema.registerColumns, idCol: 'intake_id', decisionCol: 'disposition',
    oracle: m.expectedDecisionSet.files, idKey: 'intakeId' }));
}
// Customer support
{
  const m = readJson(path.join(WS, 'support-inbox/fixture-manifest.json'));
  results.push(scoreCsDomain(m.expectedDecisionSet.files, m.expectedArtifactSchema));
}

for (const r of results) {
  console.log(`\n===== ${r.name} =====`);
  if (r.note) { console.log('  ', r.note); continue; }
  console.log(`  Artifact success   : ${r.artifact.filesPresent}/${r.artifact.filesExpected} files present`);
  console.log(`  Structural success : ${r.structural.rate} (cols ok=${r.structural.expectedColumns}, well-formed rows=${r.structural.rowsWellFormed ?? r.structural.rowsPresent}/${r.structural.total}, malformed=${r.structural.malformed ?? 0})`);
  console.log(`  Business correct   : ${r.business.rate} (${r.business.correct}/${r.business.total})`);
  if (r.perDimension) { console.log('  Per-dimension      :'); for (const [d, v] of Object.entries(r.perDimension)) console.log(`      ${d.padEnd(14)} ${v}`); }
  const cat = {};
  r.failures.forEach(f => cat[f.category] = (cat[f.category] || 0) + 1);
  console.log('  Failure categories :', JSON.stringify(cat));
  r.failures.forEach(f => console.log(`      - ${f.id} [${f.category}] ${f.detail || f.got ? (f.detail || ('got=' + f.got + ' exp=' + f.expected)) : ''}`));
}
