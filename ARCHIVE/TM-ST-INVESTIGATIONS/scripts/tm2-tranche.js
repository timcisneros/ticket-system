#!/usr/bin/env node
/**
 * TM-2 aggressive validation tranche.
 *
 * Creates N tickets for each of 4 exercise patterns, collects every
 * mutating_action_limit suppression event, classifies the model's
 * next response, and reports the post-TM-1 distribution.
 *
 * Usage: node scripts/tm2-tranche.js [--count 12]
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
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
    const options = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: opts.headers || {},
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getExport() {
  const cookie = readCookie();
  const res = await httpReq('GET', `${BASE_URL}/api/export`, {
    headers: { 'Cookie': `sessionId=${cookie}` }
  });
  if (res.status !== 200) throw new Error(`Export failed: HTTP ${res.status}`);
  return JSON.parse(res.body);
}

async function createTicket(objective, agentId = 1) {
  const cookie = readCookie();
  const body = `objective=${encodeURIComponent(objective)}&assignmentTargetType=agent&assignmentTargetId=${agentId}&assignmentMode=individual`;
  const res = await httpReq('POST', `${BASE_URL}/tickets`, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': `sessionId=${cookie}`,
    },
    body
  });
  if (res.status !== 302) {
    throw new Error(`Creation failed: HTTP ${res.status}`);
  }
}

async function waitForTicket(ticketId, timeoutMs = 600000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const data = await getExport();
    const ticket = (data.tickets || []).find(t => t.id === ticketId);
    if (!ticket) { await sleep(2000); continue; }
    const runs = (data.runs || []).filter(r => r.ticketId === ticketId).sort((a, b) => (a.id || 0) - (b.id || 0));
    if (ticket.status === 'completed' || ticket.status === 'failed') {
      return { ticket, runs };
    }
    await sleep(2000);
  }
  throw new Error(`Timeout T${ticketId}`);
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
  let snap = null;
  if (run.replaySnapshot) snap = run.replaySnapshot;
  else if (run.replaySnapshotPath) {
    const f = path.resolve(SNAP_DIR, path.basename(run.replaySnapshotPath));
    try { if (fs.existsSync(f)) snap = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  }
  if (!snap) return [];

  const events = snap.events || [];
  const plans = snap.parsedModelPlans || [];
  const limitEvents = events.filter(e => e.type === 'model:mutating_action_limit');
  const results = [];

  for (const evt of limitEvents) {
    const step = evt.step;
    const mutCount = evt.mutatingActionCount;
    const limit = evt.maxMutatingActionsPerResponse || 2;
    const repeated = evt.repeatedViolationCount || 1;

    const limitPlan = plans.find(p => p.step === step);
    const suppressedOps = limitPlan ? (limitPlan.actions || []).map(a => a.operation) : [];
    const suppressedMut = limitPlan ? (limitPlan.actions || []).filter(a => MUTATING_OPS.includes(a.operation)) : [];

    const nextPlan = plans.find(p => p.step === step + 1);
    const nextActions = nextPlan ? (nextPlan.actions || []) : [];
    const classification = classifyResponse(suppressedOps, nextActions);

    // Get ticket objective from snapshot
    const ticket = (data.tickets || []).find(t => t.id === run.ticketId);
    const obj = ticket ? ticket.objective : (snap.ticketObjectiveSnapshot || '');

    results.push({
      runId: run.id, ticketId: run.ticketId, ticketObjective: obj,
      step, suppressedOps, mutatingCount: mutCount, limit, repeatedViolations: repeated,
      nextOps: nextActions.map(a => a.operation), nextActions: nextActions.map(a => ({ operation: a.operation, path: a.args?.path })),
      classification, terminalOutcome: run.status || snap.terminalStatus || '?',
      snapshotFinalized: snap.finalizedAt
    });
  }
  return results;
}

async function main() {
  const count = parseInt(process.argv[2] || '10', 10);

  console.log(`TM-2 Tranche: creating ${count} exercise tickets\n`);

  const cookie = readCookie();
  if (!cookie) { console.error('No session cookie. Run oquery login first.'); process.exit(1); }

  const patterns = [
    (i) => `move items 1-5 into folder ALPHA-${i}`,
    (i) => `move items 1-10 into folder BETA-${i}`,
    (i) => `create folder PROJECT-${i} and in it create files task-1.txt, task-2.txt, task-3.txt, task-4.txt, task-5.txt each containing their filename`,
    (i) => `list root, check items/ directory, then move all items from items/ into folder GAMMA-${i}`,
  ];

  // Also create timestamped files for potential delete ticket
  const ts = Date.now().toString(36);
  const ws = path.resolve(ROOT, 'workspace-root');
  for (let i = 0; i < 8; i++) {
    try { fs.writeFileSync(path.join(ws, `log-${ts}-${i}.tmp`), `stale file ${i}`); } catch {}
  }

  const created = [];

  for (let i = 0; i < count; i++) {
    for (const makeObj of patterns) {
      const objective = makeObj(i);
      try {
        await createTicket(objective);
        // Find the ticket
        await sleep(1500);
        const data = await getExport();
        const ticket = (data.tickets || []).filter(t => t.objective === objective)
          .reduce((a, b) => (a.id > b.id ? a : b), null);
        if (ticket) {
          created.push(ticket);
          console.log(`T${ticket.id}: ${objective.substring(0, 55)}...`);
        }
      } catch (e) {
        // Collision is fine
      }
      await sleep(200);
    }
  }

  console.log(`\nCreated ${created.length} tickets. Waiting for completion...\n`);

  const allEvents = [];

  for (const ticket of created) {
    try {
      const { ticket: ct, runs } = await waitForTicket(ticket.id);
      console.log(`T${ticket.id} ${ct.status} (${runs.length} runs)`);
      const data = await getExport();
      for (const run of runs) {
        const events = collectSuppression(run, data);
        for (const ev of events) allEvents.push(ev);
        if (events.length > 0) {
          console.log(`  R${run.id}: ${events.length} suppression(s)` +
            events.map(e => ` step ${e.step}=[${e.classification}]`).join(''));
        }
      }
    } catch (e) {
      console.log(`T${ticket.id}: ${e.message}`);
    }
  }

  // ── Report ──
  console.log('\n' + '='.repeat(60));
  console.log('TM-2 SUPPRESSION EVENT REPORT');
  console.log(`Fresh events: ${allEvents.length} (target 20-30)`);
  console.log('='.repeat(60));

  if (allEvents.length === 0) {
    console.log('\nNo mutating_action_limit events recorded.');
    return;
  }

  // Include existing events too
  const existing = [];
  const data = await getExport();
  for (const run of data.runs || []) {
    if (!allEvents.some(e => e.runId === run.id)) {
      existing.push(...collectSuppression(run, data));
    }
  }
  const totalEvents = [...allEvents, ...existing];

  console.log(`\n${allEvents.length} fresh + ${existing.length} existing = ${totalEvents.length} total\n`);

  const dist = {};
  for (const ev of totalEvents) {
    dist[ev.classification] = (dist[ev.classification] || 0) + 1;
  }
  const sorted = Object.entries(dist).sort((a, b) => b[1] - a[1]);
  console.log('Classification Distribution:');
  for (const [cls, n] of sorted) {
    console.log(`  ${cls.padEnd(30)} ${n}/${totalEvents.length} (${((n/totalEvents.length)*100).toFixed(1)}%)`);
  }

  console.log('\nFresh-only Distribution:');
  const freshDist = {};
  for (const ev of allEvents) freshDist[ev.classification] = (freshDist[ev.classification] || 0) + 1;
  for (const [cls, n] of Object.entries(freshDist).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cls.padEnd(30)} ${n}/${allEvents.length} (${((n/allEvents.length)*100).toFixed(1)}%)`);
  }

  // Save
  const outPath = path.join(DATA_DIR, 'tm2-events.json');
  fs.writeFileSync(outPath, JSON.stringify({ fresh: allEvents, existing, total: totalEvents }, null, 2));
  console.log(`\nRaw data: ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
