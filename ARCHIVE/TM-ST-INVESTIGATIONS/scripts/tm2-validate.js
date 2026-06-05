#!/usr/bin/env node
/**
 * TM-2 operational validation tranche.
 *
 * Creates 4 exercise tickets, runs them through the patched runtime,
 * collects every mutating_action_limit suppression event, classifies
 * the model's next response, and reports the post-TM-1 distribution.
 *
 * Usage: node scripts/tm2-validate.js
 * Requires: server running at http://127.0.0.1:3000, valid session cookie in .opercookie
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const SESSION_COOKIE_PATH = path.join(ROOT, '.opercookie');
const BASE_URL = process.env.OPERC_URL || 'http://127.0.0.1:3000';

const MUTATING_OPS = ['createFolder', 'writeFile', 'renamePath', 'deletePath'];

// ── Helpers ──

function readCookie() {
  try { return fs.readFileSync(SESSION_COOKIE_PATH, 'utf8').trim(); } catch (e) { return null; }
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

// ── API wrappers ──

async function checkHealth() {
  try {
    const res = await httpReq('GET', `${BASE_URL}/api/health`);
    return res.status === 200;
  } catch { return false; }
}

async function createTicket(objective, agentId = 1) {
  const cookie = readCookie();
  if (!cookie) throw new Error('No session cookie. Run oquery login first.');

  const body = `objective=${encodeURIComponent(objective)}&assignmentTargetType=agent&assignmentTargetId=${agentId}&assignmentMode=individual`;
  const res = await httpReq('POST', `${BASE_URL}/tickets`, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': `sessionId=${cookie}`,
    },
    body
  });

  if (res.status !== 302) {
    throw new Error(`Ticket creation failed: HTTP ${res.status}\n${res.body.slice(0, 300)}`);
  }

  // Fetch ticket list to find our ticket
  await sleep(1000);
  return await findTicketByObjective(objective);
}

async function findTicketByObjective(objective, cookie) {
  const cookie2 = cookie || readCookie();
  const exportRes = await httpReq('GET', `${BASE_URL}/api/export`, {
    headers: { 'Cookie': `sessionId=${cookie2}` }
  });
  if (exportRes.status !== 200) return null;
  const data = JSON.parse(exportRes.body);
  const tickets = (data.tickets || []).filter(t => t.objective === objective);
  if (tickets.length === 0) return null;
  return tickets.reduce((a, b) => (a.id > b.id ? a : b));
}

async function getExport() {
  const cookie = readCookie();
  const res = await httpReq('GET', `${BASE_URL}/api/export`, {
    headers: { 'Cookie': `sessionId=${cookie}` }
  });
  if (res.status !== 200) throw new Error(`Export failed: HTTP ${res.status}`);
  return JSON.parse(res.body);
}

async function waitForTicketCompletion(ticketId, timeoutMs = 600000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const data = await getExport();
    const ticket = (data.tickets || []).find(t => t.id === ticketId);
    if (!ticket) { await sleep(2000); continue; }
    const runs = (data.runs || []).filter(r => r.ticketId === ticketId).sort((a, b) => (a.id || 0) - (b.id || 0));
    const lastRun = runs.length > 0 ? runs[runs.length - 1] : null;

    if (ticket.status === 'completed' || ticket.status === 'failed') {
      return { ticket, runs, data };
    }
    await sleep(2000);
  }
  throw new Error(`Timeout waiting for ticket ${ticketId}`);
}

async function getRunEvents(runId) {
  const cookie = readCookie();
  const res = await httpReq('GET', `${BASE_URL}/api/export`, {
    headers: { 'Cookie': `sessionId=${cookie}` }
  });
  if (res.status !== 200) return [];
  const data = JSON.parse(res.body);
  const run = (data.runs || []).find(r => r.id === runId);
  if (!run) return [];

  // Try to load replay snapshot for events
  if (run.replaySnapshot) {
    return run.replaySnapshot.events || [];
  }
  if (run.replaySnapshotPath) {
    const snapPath = path.resolve(DATA_DIR, run.replaySnapshotPath);
    if (fs.existsSync(snapPath)) {
      try {
        const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
        return snap.events || [];
      } catch {}
    }
  }
  return [];
}

// ── Classification ──

function classifyResponse(prevSuppressedOps, nextActions) {
  if (!nextActions || nextActions.length === 0) return 'abandonment';

  const nextMutating = nextActions.filter(a => MUTATING_OPS.includes(a.operation));
  const nextMutCount = nextMutating.length;
  const prevMutCount = (prevSuppressedOps || []).filter(a => MUTATING_OPS.includes(a)).length;
  const nextOps = nextActions.map(a => a.operation);

  // inspection_fallback: all non-mutating
  if (nextMutCount === 0) return 'inspection_fallback';

  // legal_retry: within limit (2)
  if (nextMutCount <= 2) return 'legal_retry';

  // repeat_exact_batch: identical operation sequence
  if (prevSuppressedOps && nextOps.join(',') === prevSuppressedOps.join(',')) return 'repeat_exact_batch';

  // reduced_but_still_oversized: fewer mutating than before but still > 2
  if (nextMutCount < prevMutCount) return 'reduced_but_still_oversized';

  // other: different ops but still oversized
  return 'other';
}

// ── Main ──

async function main() {
  console.log('TM-2 Operational Validation Tranche\n');
  console.log(`Server: ${BASE_URL}`);

  if (!readCookie()) {
    console.error('ERROR: No session cookie. Run: oquery login --url ' + BASE_URL);
    process.exit(1);
  }

  const healthy = await checkHealth();
  if (!healthy) {
    console.error('ERROR: Server not reachable at ' + BASE_URL);
    process.exit(1);
  }
  console.log('Server: healthy\n');

  const TICKETS = [
    'put items 1-5 in a folder called A',
    'put items 1-10 in a folder called A',
    'delete timestamped files except allowlist',
    'create folder batch-X and create 5 files',
  ];

  // Create tickets
  const created = [];
  console.log('Creating tickets...');
  for (const objective of TICKETS) {
    try {
      // Check if ticket already exists
      const existing = await findTicketByObjective(objective);
      if (existing) {
        console.log(`  T${existing.id}: "${objective.substring(0, 50)}..." (already exists, status=${existing.status})`);
        created.push(existing);
        continue;
      }
      const ticket = await createTicket(objective);
      if (ticket) {
        console.log(`  T${ticket.id}: "${objective.substring(0, 50)}..."`);
        created.push(ticket);
      }
    } catch (e) {
      console.error(`  FAILED: ${e.message}`);
    }
    await sleep(500);
  }

  if (created.length === 0) {
    console.error('No tickets were created. Aborting.');
    process.exit(1);
  }

  console.log(`\nWaiting for ${created.length} tickets to complete...\n`);

  // Collect suppression events
  const suppressionEvents = [];

  for (const ticket of created) {
    console.log(`  Monitoring T${ticket.id}...`);
    try {
      const { ticket: completedTicket, runs, data } = await waitForTicketCompletion(ticket.id);
      const lastRun = runs[runs.length - 1];
      console.log(`    Completed: T${ticket.id} → ${completedTicket.status}, run R${lastRun?.id} (${lastRun?.status})`);
      console.log(`    ${runs.length} run(s)`);

      // Each run may have multiple steps with suppression events
      for (const run of runs) {
        // Load snapshot for events
        let events = [];
        let parsedPlans = [];

        if (run.replaySnapshot) {
          events = run.replaySnapshot.events || [];
          parsedPlans = run.replaySnapshot.parsedModelPlans || [];
        } else if (run.replaySnapshotPath) {
          const snapPath = path.resolve(DATA_DIR, run.replaySnapshotPath);
          if (fs.existsSync(snapPath)) {
            try {
              const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
              events = snap.events || [];
              parsedPlans = snap.parsedModelPlans || [];
            } catch {}
          }
        }

        // Find mutating_action_limit events
        const limitEvents = events.filter(e => e.type === 'model:mutating_action_limit');
        console.log(`    R${run.id}: ${limitEvents.length} suppression event(s)`);

        for (const evt of limitEvents) {
          const step = evt.step;
          const mutCount = evt.mutatingActionCount;
          const limit = evt.maxMutatingActionsPerResponse || 2;
          const repeatedViolations = evt.repeatedViolationCount || 1;

          // Get suppressed batch (from the plan at this step)
          const limitPlan = parsedPlans.find(p => p.step === step);
          const suppressedActions = limitPlan ? (limitPlan.actions || []) : [];
          const suppressedOps = suppressedActions.map(a => a.operation);
          const suppressedMutating = suppressedActions.filter(a => MUTATING_OPS.includes(a.operation));
          const suppressedMutCount = suppressedMutating.length;

          // Get next response (plan at step+1)
          const nextPlan = parsedPlans.find(p => p.step === step + 1);
          const nextActions = nextPlan ? (nextPlan.actions || []) : [];

          const classification = classifyResponse(suppressedOps, nextActions);

          const entry = {
            runId: run.id,
            ticketId: ticket.id,
            ticketObjective: ticket.objective,
            step,
            suppressedBatch: suppressedOps,
            mutatingCount: suppressedMutCount,
            limit,
            repeatedViolations,
            nextResponse: nextActions.map(a => ({ operation: a.operation, path: a.args?.path })),
            nextResponseOps: nextActions.map(a => a.operation),
            classification,
            terminalOutcome: completedTicket.status,
          };

          suppressionEvents.push(entry);

          const clsTag = classification === 'legal_retry' ? 'LEGAL_RETRY' :
            classification === 'repeat_exact_batch' ? 'REPEAT_BATCH' :
            classification === 'reduced_but_still_oversized' ? 'REDUCED_OVERSIZED' :
            classification === 'inspection_fallback' ? 'INSPECTION' :
            classification === 'abandonment' ? 'ABANDON' : 'OTHER';

          console.log(`      step ${step}: [${suppressedOps.slice(0, 5).join(', ')}${suppressedOps.length > 5 ? ',...' : ''}] mut=${suppressedMutCount} lim=${limit} → [${nextActions.map(a => a.operation).slice(0, 5).join(',')}${nextActions.length > 5 ? ',...' : ''}] [${clsTag}]`);
        }
      }
      console.log('');
    } catch (e) {
      console.error(`    ERROR: ${e.message}`);
    }
  }

  // ── Report ──
  console.log('\n' + '='.repeat(60));
  console.log('TM-2 SUPPRESSION EVENT REPORT');
  console.log('='.repeat(60));

  if (suppressionEvents.length === 0) {
    console.log('\nNo mutating_action_limit events recorded.');
    return;
  }

  // Per-event detail
  console.log(`\n${suppressionEvents.length} suppression event(s) recorded:\n`);
  for (const ev of suppressionEvents) {
    console.log(`  R${ev.runId} | T${ev.ticketId} | step ${ev.step} | mut=${ev.mutatingCount}/${ev.limit} | violations=${ev.repeatedViolations}`);
    console.log(`    Objective: ${ev.ticketObjective.substring(0, 80)}`);
    console.log(`    Suppressed: [${ev.suppressedBatch.slice(0, 8).join(', ')}${ev.suppressedBatch.length > 8 ? ',...' : ''}]`);
    console.log(`    Next:       [${ev.nextResponseOps.slice(0, 8).join(', ')}${ev.nextResponseOps.length > 8 ? ',...' : ''}]`);
    console.log(`    Classification: ${ev.classification}`);
    console.log(`    Outcome: ${ev.terminalOutcome}`);
    console.log('');
  }

  // Distribution
  console.log('-'.repeat(40));
  console.log('Classification Distribution:\n');
  const dist = {};
  for (const ev of suppressionEvents) {
    dist[ev.classification] = (dist[ev.classification] || 0) + 1;
  }
  const sorted = Object.entries(dist).sort((a, b) => b[1] - a[1]);
  for (const [cls, count] of sorted) {
    const pct = ((count / suppressionEvents.length) * 100).toFixed(1);
    console.log(`  ${cls.padEnd(30)} ${count}/${suppressionEvents.length} (${pct}%)`);
  }

  // By-ticket summary
  console.log('\n' + '-'.repeat(40));
  console.log('By Ticket:\n');
  const tickets = {};
  for (const ev of suppressionEvents) {
    if (!tickets[ev.ticketId]) {
      tickets[ev.ticketId] = { objective: ev.ticketObjective, events: [] };
    }
    tickets[ev.ticketId].events.push(ev);
  }
  for (const [tid, info] of Object.entries(tickets)) {
    const tDist = {};
    info.events.forEach(e => { tDist[e.classification] = (tDist[e.classification] || 0) + 1; });
    console.log(`  T${tid}: ${info.objective.substring(0, 60)}`);
    console.log(`    ${info.events.length} event(s)`);
    for (const [cls, count] of Object.entries(tDist)) {
      console.log(`      ${cls}: ${count}`);
    }
    console.log('');
  }

  // ── Raw JSON output for further analysis ──
  const outPath = path.join(ROOT, 'data', 'tm2-suppression-events.json');
  fs.writeFileSync(outPath, JSON.stringify(suppressionEvents, null, 2));
  console.log(`\nRaw data saved to ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
