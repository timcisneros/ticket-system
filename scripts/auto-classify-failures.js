#!/usr/bin/env node
/**
 * Automatic failure classification over real failed runs.
 *
 * Composition of existing primitives only: scans data/runs.json for terminal
 * failed runs, builds a failure dossier per run (run record + replay snapshot
 * + workflow policy), creates an ordinary `failure-classification` workflow
 * ticket via the server API (Agent 1 = cheap tier), and applies the validated
 * escalation rule — confidence != High OR dossier carries discriminator-arm
 * evidence — by re-running the same workflow on Agent 2 (gpt-5.5 tier).
 *
 * Usage:
 *   node scripts/auto-classify-failures.js scan          # classify all unclassified failed runs, exit
 *   node scripts/auto-classify-failures.js watch [secs]  # scan loop (default every 60s)
 *
 * Assumes the server is running (PORT env or 3000). Results:
 *   workspace-root/failure-classification/run-<id>/classification.json
 *   workspace-root/failure-classification/register.json   (rolling summary)
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
require('dotenv').config(); // same resolution chain as server.js: explicit env > .env > repo defaults
const PORT = process.env.PORT || 3000;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const WS = process.env.WORKSPACE_ROOT ? path.resolve(process.env.WORKSPACE_ROOT) : path.join(ROOT, 'workspace-root');
console.log(`DATA_DIR=${DATA_DIR}`);
console.log(`WORKSPACE_ROOT=${WS}`);
console.log(`repo-store=${DATA_DIR === path.join(ROOT, 'data')}`);
const FC_DIR = path.join(WS, 'failure-classification');
const REGISTER = path.join(FC_DIR, 'register.json');
const CHEAP_AGENT = '1';
const STRONG_AGENT = '2';

let cookie = '';
function httpReq(method, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE_URL + urlPath);
    const options = { hostname: u.hostname, port: u.port, path: u.pathname + (u.search || ''), method, headers: { ...opts.headers } };
    if (opts.body) options.headers['Content-Length'] = Buffer.byteLength(opts.body);
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
async function login() {
  const body = `username=admin&password=${encodeURIComponent('admin123')}`;
  const res = await httpReq('POST', '/login', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const sc = res.headers['set-cookie'];
  const m = (Array.isArray(sc) ? sc[0] : sc || '').match(/sessionId=([^;]+)/);
  if (!m) throw new Error('login failed: ' + res.status);
  cookie = `sessionId=${m[1]}`;
}
async function createTicket(objective, input, agentId) {
  const form = new URLSearchParams({
    objective, capabilityType: 'workflow', executionMode: 'workflow',
    workflowId: 'failure-classification', workflowInput: JSON.stringify(input),
    assignmentTargetType: 'agent', assignmentTargetId: agentId, assignmentMode: 'individual',
  });
  const res = await httpReq('POST', '/tickets', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie }, body: form.toString(),
  });
  if (res.status !== 302) throw new Error('create ticket failed: ' + res.status + ' ' + res.body.slice(0, 150));
  const list = JSON.parse((await httpReq('GET', '/api/tickets', { headers: { Cookie: cookie } })).body);
  return (list.tickets || list).reduce((a, b) => (a.id > b.id ? a : b)).id;
}
function readJson(fp, fallback) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return fallback; }
}
async function waitForComplete(ticketId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const runs = readJson(path.join(DATA_DIR, 'runs.json'), []).filter((r) => r.ticketId === ticketId);
    const run = runs[runs.length - 1];
    if (run && ['completed', 'failed', 'interrupted'].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

function readPostconditionFailures() {
  // runId -> [failed postcondition payloads] from run.postcondition_failed events
  const byRun = {};
  let raw = '';
  try { raw = fs.readFileSync(path.join(DATA_DIR, 'events.jsonl'), 'utf8'); } catch { return byRun; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'run.postcondition_failed' && ev.runId != null) {
        (byRun[ev.runId] = byRun[ev.runId] || []).push(ev.payload || {});
      }
    } catch {}
  }
  return byRun;
}

function buildDossier(run, pcFailures) {
  const snapPath = path.join(DATA_DIR, 'replay-snapshots', `run-${run.id}.json`);
  const snap = readJson(snapPath, null);
  let policy = '(policy text not preserved for this run)';
  let observed = '(no model output preserved)';
  let caseFacts = null;
  if (snap) {
    try {
      const user = JSON.parse(snap.providerRequests[0].body.input[1].content);
      policy = (user.instruction.split('Policy:\n')[1] || user.instruction);
      if (user.input && typeof user.input === 'object') {
        caseFacts = JSON.stringify(user.input, null, 1).slice(0, 12000);
      }
    } catch {}
    try {
      observed = (snap.modelResponses || []).map((m) => String(m.text).slice(0, 1500)).join('\n---\n') || observed;
    } catch {}
  }
  const failure = run.error || (snap && snap.failureReason) || '(none recorded)';
  const failureObj = (snap && snap.failure) || run.failure || null;
  let verifierSection;
  let expectedSection;
  if (pcFailures && pcFailures.length) {
    expectedSection =
      'The run completed, but content-aware postconditions on its output failed:\n' +
      pcFailures
        .map((p) => {
          const pc = p.postcondition || {};
          return `- ${pc.id || pc.type}: expected ${JSON.stringify(pc.expected)}, actual ${JSON.stringify(pc.actual)}`;
        })
        .join('\n');
    verifierSection = `run.postcondition_failed events (run terminal status remains "completed"):\n${JSON.stringify(pcFailures).slice(0, 1500)}\nNo runtime error code — this is a content disagreement, not an execution failure.`;
  } else {
    expectedSection =
      'The run was expected to reach terminal status "completed" with its postconditions satisfied. No business-level oracle is attached to this run record.';
    verifierSection = `Failure reason: ${failure}\n${failureObj ? `Typed failure record: code=${failureObj.code || 'n/a'}, kind=${failureObj.kind || 'n/a'}` : 'No typed failure record.'}`;
  }
  return `# Failure Dossier: run-${run.id}

## Case ID
run-${run.id} (ticket ${run.ticketId}, workflow ${run.workflowId || run.capabilityId || 'unknown'})

## Expected Output (verifier oracle)
${expectedSection}

## Observed Output(s)
Terminal status: ${run.status}.
Last model output (truncated):
${observed.slice(0, 2000)}

## Verifier Output
${verifierSection}

## Policy Text In Force During The Failing Runs
\`\`\`
${String(policy).slice(0, 6000)}
\`\`\`

## Case Input
${caseFacts || `See workflow input: ${JSON.stringify(run.workflowInput || {}).slice(0, 500)}`}
`;
}

function escalationRequired(verdict, dossierMd, source) {
  if (source === 'postcondition_failed') return true; // content disagreements always go to the strong tier
  if (!verdict || !verdict.classification) return true; // unparseable -> escalate
  if ((verdict.confidence || '') !== 'High') return true;
  if (verdict.needsDiscriminatorArms === true || verdict.classification === 'NEEDS_ARMS') return true;
  if (dossierMd.includes('Discriminator Arm Results')) return true;
  return false;
}

async function classifyRun(run, pcFailures, source) {
  const caseDir = path.join(FC_DIR, `run-${run.id}`);
  fs.mkdirSync(caseDir, { recursive: true });
  const dossierMd = buildDossier(run, pcFailures);
  fs.writeFileSync(path.join(caseDir, 'dossier.md'), dossierMd);
  const rel = path.relative(WS, caseDir);

  const ticketId = await createTicket(`Classify failure of run-${run.id}`, { basePath: rel }, CHEAP_AGENT);
  await waitForComplete(ticketId, 180000);
  let verdict = readJson(path.join(caseDir, 'classification.json'), null);
  let tier = 'cheap';

  if (escalationRequired(verdict, dossierMd, source)) {
    const escDir = path.join(caseDir, 'escalated');
    fs.mkdirSync(escDir, { recursive: true });
    fs.writeFileSync(path.join(escDir, 'dossier.md'), dossierMd);
    const escTicket = await createTicket(`Escalated classification of run-${run.id}`, { basePath: path.relative(WS, escDir) }, STRONG_AGENT);
    await waitForComplete(escTicket, 300000);
    const escVerdict = readJson(path.join(escDir, 'classification.json'), null);
    if (escVerdict) { verdict = escVerdict; tier = 'escalated'; }
  }
  return { runId: run.id, ticketId: run.ticketId, tier, verdict };
}

async function scanOnce() {
  const register = readJson(REGISTER, { classified: {} });
  const runs = readJson(path.join(DATA_DIR, 'runs.json'), []);
  const pcByRun = readPostconditionFailures();
  const failed = runs.filter(
    (r) => r.status === 'failed' && r.workflowId !== 'failure-classification' && !register.classified[`run-${r.id}`],
  );
  // Completed runs whose content-aware postconditions failed: same intake, run stays completed.
  const contentDisagreements = runs.filter(
    (r) =>
      r.status === 'completed' &&
      r.workflowId !== 'failure-classification' &&
      pcByRun[r.id] &&
      pcByRun[r.id].length &&
      !register.classified[`run-${r.id}`],
  );
  const work = [
    ...failed.map((r) => ({ run: r, pc: null, source: 'terminal_failure' })),
    ...contentDisagreements.map((r) => ({ run: r, pc: pcByRun[r.id], source: 'postcondition_failed' })),
  ];
  if (!work.length) { console.log('no unclassified failed runs'); return; }
  for (const { run, pc, source } of work) {
    console.log(`classifying run-${run.id} [${source}] (${run.error ? String(run.error).slice(0, 60) : run.status})...`);
    try {
      const result = await classifyRun(run, pc, source);
      register.classified[`run-${run.id}`] = { ...result, source, at: new Date().toISOString() };
      const v = result.verdict || {};
      console.log(`  -> ${v.classification || 'UNPARSEABLE'} (${v.confidence || '-'}, tier=${result.tier}) ${String(v.remediation || '').slice(0, 70)}`);
    } catch (e) {
      console.log(`  -> error: ${String(e).slice(0, 160)}`);
    }
    fs.mkdirSync(FC_DIR, { recursive: true });
    fs.writeFileSync(REGISTER, JSON.stringify(register, null, 2));
  }
}

async function main() {
  const mode = process.argv[2] || 'scan';
  await login();
  if (mode === 'scan') return scanOnce();
  if (mode === 'watch') {
    const interval = (parseInt(process.argv[3], 10) || 60) * 1000;
    console.log(`watching for failed runs every ${interval / 1000}s`);
    for (;;) { await scanOnce(); await new Promise((r) => setTimeout(r, interval)); }
  }
  throw new Error('usage: auto-classify-failures.js scan|watch [secs]');
}
main().catch((e) => { console.error(e); process.exit(1); });
