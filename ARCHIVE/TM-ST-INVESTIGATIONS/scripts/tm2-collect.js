#!/usr/bin/env node
/**
 * TM-2 suppression event collector.
 * Scans ALL runs for mutating_action_limit events and classifies them.
 *
 * Usage: node scripts/tm2-collect.js
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getExport() {
  const cookie = readCookie();
  const res = await httpReq('GET', `${BASE_URL}/api/export`, {
    headers: { 'Cookie': `sessionId=${cookie}` }
  });
  if (res.status !== 200) throw new Error(`Export failed: HTTP ${res.status}`);
  return JSON.parse(res.body);
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

function classifyResponse(prevOps, nextActions) {
  if (!nextActions || nextActions.length === 0) return 'abandonment';
  const nextMut = nextActions.filter(a => MUTATING_OPS.includes(a.operation));
  const nextMutCount = nextMut.length;
  const prevMutCount = (prevOps || []).filter(a => MUTATING_OPS.includes(a)).length;
  const nextOps = nextActions.map(a => a.operation);
  if (nextMutCount === 0) return 'inspection_fallback';
  if (nextMutCount <= 2) return 'legal_retry';
  if (prevOps && nextOps.join(',') === prevOps.join(',')) return 'repeat_exact_batch';
  if (nextMutCount < prevMutCount) return 'reduced_but_still_oversized';
  return 'other';
}

function collectSuppression(run, data) {
  const snap = loadSnapshot(run);
  if (!snap) return [];

  const events = snap.events || [];
  const plans = snap.parsedModelPlans || [];
  const limitEvents = events.filter(e => e.type === 'model:mutating_action_limit');
  const results = [];

  for (const evt of limitEvents) {
    const step = evt.step;
    const mutCount = evt.mutatingActionCount || 0;
    const limit = evt.maxMutatingActionsPerResponse || 2;

    const limitPlan = plans.find(p => p.step === step);
    const suppressedOps = limitPlan ? (limitPlan.actions || []).map(a => a.operation) : [];

    let nextPlan = plans.find(p => p.step === step + 1);
    // For step 0 limit, also check if a plan at step 0 exists (model retried at same step)
    if (!nextPlan && step === 0) {
      nextPlan = plans.find(p => p.step === 0);
    }
    const nextActions = nextPlan ? (nextPlan.actions || []) : [];

    const classification = classifyResponse(suppressedOps, nextActions);

    const ticket = (data.tickets || []).find(t => t.id === run.ticketId);
    const obj = ticket ? ticket.objective : (snap.ticketObjectiveSnapshot || '');

    results.push({
      runId: run.id, ticketId: run.ticketId, ticketObjective: obj.substring(0, 80),
      step, suppressedOps, mutatingCount: mutCount, limit,
      nextOps: nextActions.map(a => a.operation),
      classification,
      terminalOutcome: run.status || snap.terminalStatus || '?',
      snapshotCreated: snap.createdAt || '',
      snapshotFinalized: snap.finalizedAt || '',
    });
  }
  return results;
}

async function main() {
  console.log('TM-2 Suppression Event Collector\n');
  const data = await getExport();
  const runs = (data.runs || []).filter(r => r.replaySnapshot || r.replaySnapshotPath);
  console.log(`Scanning ${runs.length} runs with snapshots...\n`);

  const allEvents = [];

  for (const run of runs) {
    const events = collectSuppression(run, data);
    for (const ev of events) allEvents.push(ev);
  }

  // Sort by runId
  allEvents.sort((a, b) => a.runId - b.runId);

  console.log(`Found ${allEvents.length} mutating_action_limit events:\n`);

  for (const ev of allEvents) {
    const clsTag = ev.classification === 'legal_retry' ? 'LEGAL' :
      ev.classification === 'repeat_exact_batch' ? 'REPEAT' :
      ev.classification === 'reduced_but_still_oversized' ? 'REDUCED' :
      ev.classification === 'inspection_fallback' ? 'INSPECT' :
      ev.classification === 'abandonment' ? 'ABANDON' : 'OTHER';
    console.log(`  R${String(ev.runId).padStart(3)} T${String(ev.ticketId).padStart(3)} step ${ev.step}: [${ev.suppressedOps.slice(0,4).join(',')}${ev.suppressedOps.length>4?',...':''}] mut=${ev.mutatingCount}/${ev.limit} → [${ev.nextOps.slice(0,4).join(',')}${ev.nextOps.length>4?',...':''}] [${clsTag}] ${ev.terminalOutcome}`);
  }

  // Distribution
  console.log('\n' + '-'.repeat(50));
  console.log('Classification Distribution:\n');
  const dist = {};
  for (const ev of allEvents) dist[ev.classification] = (dist[ev.classification] || 0) + 1;
  const sorted = Object.entries(dist).sort((a, b) => b[1] - a[1]);
  for (const [cls, n] of sorted) {
    const pct = ((n / allEvents.length) * 100).toFixed(1);
    console.log(`  ${cls.padEnd(30)} ${n}/${allEvents.length} (${pct}%)`);
  }

  // By run timeframe
  const preTM1 = allEvents.filter(e => e.runId < 165);
  const duringTM1 = allEvents.filter(e => e.runId >= 165 && e.runId < 179);
  const postTM1 = allEvents.filter(e => e.runId >= 179);

  console.log('\n' + '-'.repeat(50));
  console.log('By TM-1 Phase:\n');
  if (preTM1.length > 0) {
    const d = {};
    preTM1.forEach(e => d[e.classification] = (d[e.classification] || 0) + 1);
    console.log(`  Pre-TM-1 (R<165, n=${preTM1}):`);
    for (const [c, n] of Object.entries(d)) console.log(`    ${c.padEnd(30)} ${n}`);
  }
  if (duringTM1.length > 0) {
    const d = {};
    duringTM1.forEach(e => d[e.classification] = (d[e.classification] || 0) + 1);
    console.log(`  TM-1 development (R165-178, n=${duringTM1.length}):`);
    for (const [c, n] of Object.entries(d)) console.log(`    ${c.padEnd(30)} ${n}`);
  }
  if (postTM1.length > 0) {
    const d = {};
    postTM1.forEach(e => d[e.classification] = (d[e.classification] || 0) + 1);
    console.log(`  Post-TM-1 (R>=179, n=${postTM1.length}):`);
    for (const [c, n] of Object.entries(d)) console.log(`    ${c.padEnd(30)} ${n}`);
    console.log('\n  Individual events:');
    for (const ev of postTM1) {
      const nextOps = ev.nextOps.length > 0 ? ev.nextOps.join(',') : '(empty)';
      console.log(`    R${ev.runId} step ${ev.step}: suppressed [${ev.suppressedOps.join(',')}] next [${nextOps}] → ${ev.classification}`);
    }
  }

  // Save
  const outPath = path.join(ROOT, 'data', 'tm2-events-final.json');
  fs.writeFileSync(outPath, JSON.stringify({ events: allEvents, preTM1, duringTM1, postTM1, distribution: dist }, null, 2));
  console.log(`\nRaw data: ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
