#!/usr/bin/env node
/**
 * TM-2 final report.
 * Scans all runs, classifies mutating_action_limit events using the
 * actual limit value from each event, reports distribution.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SNAP_DIR = path.join(ROOT, '.local-data', 'replay-snapshots');
const SESSION_COOKIE_PATH = path.join(ROOT, '.opercookie');
const BASE_URL = process.env.OPERC_URL || 'http://127.0.0.1:3000';

const MUTATING_OPS = ['createFolder', 'writeFile', 'renamePath', 'deletePath'];

function readCookie() {
  try { return fs.readFileSync(SESSION_COOKIE_PATH, 'utf8').trim(); } catch { return null; }
}

function httpReq(method, url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opt = {
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method, headers: opts.headers || {},
    };
    if (opts.body) opt.headers['Content-Length'] = Buffer.byteLength(opts.body);
    const req = http.request(opt, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function loadSnapshot(run) {
  let snap = null;
  if (run.replaySnapshot) snap = run.replaySnapshot;
  else if (run.replaySnapshotPath) {
    const f = path.resolve(SNAP_DIR, path.basename(run.replaySnapshotPath));
    try { if (fs.existsSync(f)) snap = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  }
  return snap;
}

function classifyResponse(prevOps, nextActions, limit) {
  if (!nextActions || nextActions.length === 0) return 'abandonment';
  const nextMut = nextActions.filter(a => MUTATING_OPS.includes(a.operation));
  const nextMutCount = nextMut.length;
  const prevMutCount = (prevOps || []).filter(a => MUTATING_OPS.includes(a)).length;
  const nextOps = nextActions.map(a => a.operation);
  if (nextMutCount === 0) return 'inspection_fallback';
  if (nextMutCount <= limit) return 'legal_retry';
  if (prevOps && nextOps.join(',') === prevOps.join(',')) return 'repeat_exact_batch';
  if (nextMutCount < prevMutCount) return 'reduced_but_still_oversized';
  return 'other';
}

async function main() {
  console.log('TM-2 Final Suppression Report\n');
  const cookie = readCookie();
  const res = await httpReq('GET', `${BASE_URL}/api/export`, {
    headers: { 'Cookie': `sessionId=${cookie}` }
  });
  if (res.status !== 200) { console.error('Export failed'); process.exit(1); }
  const data = JSON.parse(res.body);
  const runs = (data.runs || []).filter(r => r.replaySnapshot || r.replaySnapshotPath);
  console.log(`Scanning ${runs.length} runs with snapshots...\n`);

  const allEvents = [];

  for (const run of runs) {
    const snap = loadSnapshot(run);
    if (!snap) continue;
    const events = snap.events || [];
    const plans = snap.parsedModelPlans || [];

    for (const evt of events) {
      if (evt.type !== 'model:mutating_action_limit') continue;

      const step = evt.step;
      const mutCount = evt.mutatingActionCount || 0;
      const limit = evt.maxMutatingActionsPerResponse || 2;

      const limitPlan = plans.find(p => p.step === step);
      const suppressedOps = limitPlan ? (limitPlan.actions || []).map(a => a.operation) : [];

      // Find the next model plan after the suppression event
      // It could be at step+1 or at the same step (if model retried at same step number)
      let nextPlan = plans.find(p => p.step === step + 1);
      if (!nextPlan) nextPlan = plans.find(p => p.step === step && p !== limitPlan);
      const nextActions = nextPlan ? (nextPlan.actions || []) : [];

      const classification = classifyResponse(suppressedOps, nextActions, limit);

      const ticket = (data.tickets || []).find(t => t.id === run.ticketId);
      const obj = ticket ? ticket.objective : (snap.ticketObjectiveSnapshot || '');

      allEvents.push({
        runId: run.id, ticketId: run.ticketId, ticketObjective: obj.substring(0, 80),
        step, limit,
        suppressed: suppressedOps.slice(0, 6),
        suppressedCount: suppressedOps.length,
        mutatingCount: mutCount,
        nextOps: nextActions.map(a => a.operation).slice(0, 6),
        classification,
        terminalOutcome: run.status || snap.terminalStatus || '?',
        snapshotCreated: snap.createdAt || '',
        snapshotFinalized: snap.finalizedAt || '',
      });
    }
  }

  allEvents.sort((a, b) => a.runId - b.runId);

  console.log(`Found ${allEvents.length} mutating_action_limit events:\n`);

  // Print table
  console.log('  Run  Tkt Step Suppressed                     Next                             Limit Class   Outcome');
  console.log('  ---- --- ---- ------------------------------ -------------------------------- ----- ------- -------');
  for (const ev of allEvents) {
    const sup = (ev.suppressed.join(',') + ',').substring(0, 30).padEnd(30);
    const nxt = (ev.nextOps.join(',') || '-').substring(0, 32).padEnd(32);
    const cls = ev.classification.substring(0, 7).padEnd(7);
    console.log(`  R${String(ev.runId).padStart(3)} T${String(ev.ticketId).padStart(3)}  ${String(ev.step).padStart(2)}  ${sup} ${nxt} ${ev.limit}    ${cls} ${ev.terminalOutcome.substring(0, 8)}`);
  }

  // Distribution
  console.log('\n' + '-'.repeat(60));
  console.log('Classification Distribution:\n');
  const dist = {};
  for (const ev of allEvents) dist[ev.classification] = (dist[ev.classification] || 0) + 1;
  const sorted = Object.entries(dist).sort((a, b) => b[1] - a[1]);
  for (const [cls, n] of sorted) {
    const pct = ((n / allEvents.length) * 100).toFixed(1);
    console.log(`  ${cls.padEnd(30)} ${n}/${allEvents.length} (${pct}%)`);
  }

  // By phase
  const phases = [
    { label: 'Pre-TM-1 (R1-R91)', filter: e => e.runId > 0 && e.runId <= 91 },
    { label: 'TM-1 baseline (R92-R164)', filter: e => e.runId >= 92 && e.runId < 165 },
    { label: 'TM-1 development (R165-R178)', filter: e => e.runId >= 165 && e.runId < 179 },
    { label: 'Post-TM-1 fresh (R179+)', filter: e => e.runId >= 179 },
  ];

  console.log('\n' + '-'.repeat(60));
  console.log('By Phase:\n');
  for (const { label, filter } of phases) {
    const events = allEvents.filter(filter);
    if (events.length === 0) continue;
    const d = {};
    events.forEach(e => d[e.classification] = (d[e.classification] || 0) + 1);
    console.log(`  ${label} (n=${events.length}):`);
    for (const [c, n] of Object.entries(d).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${c.padEnd(30)} ${n} (${((n/events.length)*100).toFixed(1)}%)`);
    }
    console.log('');
  }

  // Detail per post-TM-1 event
  const post = allEvents.filter(e => e.runId >= 179);
  if (post.length > 0) {
    console.log('-'.repeat(60));
    console.log('Post-TM-1 Detail:\n');
    for (const ev of post) {
      console.log(`  R${ev.runId} step ${ev.step} (limit=${ev.limit}):`);
      console.log(`    Suppressed: [${ev.suppressed.join(', ')}] (${ev.mutatingCount} mutating)`);
      console.log(`    Next:       [${ev.nextOps.join(', ') || '(empty)'}]`);
      console.log(`    Class:      ${ev.classification}`);
      console.log(`    Outcome:    ${ev.terminalOutcome}`);
      console.log('');
    }
  }

  // Save
  const outPath = path.join(ROOT, 'data', 'tm2-report.json');
  fs.writeFileSync(outPath, JSON.stringify({ events: allEvents }, null, 2));
  console.log(`Raw data: ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
