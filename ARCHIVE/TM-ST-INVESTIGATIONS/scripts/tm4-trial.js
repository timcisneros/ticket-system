const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const PORT = process.env.PORT || '3099';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AGENT_ID = process.env.TM4_AGENT_ID || '1';
const TICKET_COUNT = parseInt(process.env.TM4_TICKET_COUNT || '30', 10);
const RUN_WAIT_TIMEOUT_MS = parseInt(process.env.TM4_WAIT_TIMEOUT_MS || '120000', 10);

const LEGAL_FILES = Array.from({ length: 15 }, (_, i) => `intake-2026-${String(i + 1).padStart(3, '0')}.md`);
const SUPPORT_FILES = Array.from({ length: 15 }, (_, i) => `ticket-${String(i + 1).padStart(3, '0')}.md`);

const OBJECTIVES = [
  // Legal intake: individual file processing (15 tickets)
  ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => ({
    text: `Read workspace-root/legal-intake/incoming/${LEGAL_FILES[i]}, determine if the intake form is complete, and write a summary to workspace-root/legal-intake/processed/summary-${LEGAL_FILES[i]}`,
    category: 'legal-single'
  })),
  // Customer support: individual triage (10 tickets)
  ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => ({
    text: `Read workspace-root/support-inbox/${SUPPORT_FILES[i]}, classify its priority, and write a triage note to workspace-root/support-inbox/triaged/triage-${SUPPORT_FILES[i]}`,
    category: 'support-single'
  })),
  // Batch tasks that may trigger truncation (5 tickets)
  { text: `Read all files in workspace-root/legal-intake/incoming/, categorize each by matter type and urgency, and write a comprehensive intake-register.csv to workspace-root/legal-intake/`, category: 'legal-batch-csv' },
  { text: `Read all files in workspace-root/legal-intake/incoming/, create an urgent-action-plan.md for critical items, a standard-processing.md for normal items, and a summary report`, category: 'legal-batch-reports' },
  { text: `Read all files in workspace-root/support-inbox/, prioritize by severity, and write triage-plan.md, escalation-list.md for P1 items, and queue-status.csv`, category: 'support-batch-triage' },
  { text: `List workspace-root/legal-intake/incoming/, read the first 3 intake files, write a status report summarizing their matter types and completeness`, category: 'legal-small-batch' },
  { text: `List workspace-root/support-inbox/, read the first 3 ticket files, write a priority summary with recommended actions for each`, category: 'support-small-batch' },
];

function request(method, urlPath, options = {}) {
  const body = options.form
    ? new URLSearchParams(options.form).toString()
    : options.body
      ? JSON.stringify(options.body)
      : null;

  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${urlPath}`, {
      method,
      headers: {
        ...(options.form ? {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body)
        } : {}),
        ...(options.body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function cookieFrom(response) {
  return (response.headers['set-cookie'] || []).map(cookie => cookie.split(';')[0]).join('; ');
}

async function waitForServer(maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await request('GET', '/login');
      if (res.statusCode === 200) return true;
    } catch (_) {}
    try {
      const res = await request('GET', '/');
      if (res.statusCode === 302 || res.statusCode === 200) return true;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function login(cookie) {
  const res = await request('POST', '/login', {
    form: { username: 'admin', password: 'admin123' },
    cookie
  });
  if (res.statusCode !== 302 && res.statusCode !== 200) {
    throw new Error(`Login failed: HTTP ${res.statusCode}`);
  }
  return cookieFrom(res);
}

async function createTicket(cookie, objective) {
  const form = {
    objective,
    assignmentTargetType: 'agent',
    assignmentTargetId: AGENT_ID,
    assignmentMode: 'individual'
  };
  const res = await request('POST', '/tickets', { form, cookie });
  if (res.statusCode !== 302) {
    return { error: `HTTP ${res.statusCode}`, body: res.body };
  }
  const location = res.headers.location || '';
  const match = location.match(/\/tickets\/(\d+)/);
  const ticketId = match ? parseInt(match[1], 10) : null;
  return { ticketId, location };
}

async function pollRun(cookie, ticketId, timeoutMs = RUN_WAIT_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await request('GET', '/api/export', { cookie });
    if (res.statusCode === 200) {
      try {
        const data = JSON.parse(res.body);
        const ticket = (data.tickets || []).find(t => t.id === ticketId);
        if (ticket) {
          const run = (data.runs || []).find(r => r.ticketId === ticketId);
          if (run && ['completed', 'failed', 'interrupted', 'resumable_pending'].includes(run.status)) {
            return { ticket, run, allTickets: data.tickets, allRuns: data.runs, events: data.events || [] };
          }
          if (run && run.status === 'running') {
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
          if (!run) {
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
        }
      } catch (_) {}
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return { timeout: true, ticketId };
}

function countEvents(events, type) {
  return (events || []).filter(e => e.type === type).length;
}

function countRunEvents(runId, events, type) {
  return (events || []).filter(e => e.type === type && (e.runId === runId || e.runId === String(runId) || e.runId === runId)).length;
}

function extractPhaseViolations(runId, events) {
  return (events || []).filter(e => e.type === 'execution.phase_violation' && (e.runId === runId || e.runId === String(runId) || e.runId === runId)).length;
}

async function main() {
  console.log('TM-4 Controlled Runtime Trial');
  console.log('============================\n');

  const serverProcess = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT,
      ENABLE_PREFIX_TRUNCATION: 'true',
      AGENT_MAX_RUNTIME_DURATION_MS: '60000',
      NODE_ENV: 'development'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  serverProcess.stderr.on('data', d => process.stderr.write('[server] ' + d));

  console.log(`Starting server on port ${PORT}...`);
  const ready = await waitForServer(20000);
  if (!ready) {
    console.error('Server failed to start within 20s');
    serverProcess.kill();
    process.exit(1);
  }
  console.log('Server ready.\n');

  let cookie = '';
  try {
    cookie = await login('');
  } catch (e) {
    console.error('Login failed:', e.message);
    serverProcess.kill();
    process.exit(1);
  }
  console.log('Logged in as admin.\n');

  const results = [];
  const useObjectives = OBJECTIVES.slice(0, TICKET_COUNT);

  for (let i = 0; i < useObjectives.length; i++) {
    const obj = useObjectives[i];
    process.stdout.write(`[${i + 1}/${useObjectives.length}] ${obj.category}: "${obj.text.slice(0, 60)}..." `);

    try {
      const created = await createTicket(cookie, obj.text);
      if (created.error) {
        console.log(`CREATE FAILED (${created.error})`);
        results.push({ index: i, category: obj.category, status: 'create_failed', error: created.error });
        continue;
      }

      const polled = await pollRun(cookie, created.ticketId);

      if (polled.timeout) {
        console.log('TIMEOUT');
        results.push({ index: i, category: obj.category, status: 'timeout', ticketId: created.ticketId });
        continue;
      }

      const runId = polled.run ? polled.run.id : null;
      const truncatedCount = runId ? countRunEvents(runId, polled.events, 'action.truncated') : 0;
      const suppressedCount = runId ? countRunEvents(runId, polled.events, 'action.suppressed') : 0;
      const phaseViolations = runId ? extractPhaseViolations(runId, polled.events) : 0;
      const hasInspection = runId ? (polled.run.evaluation || '').toLowerCase().includes('inspect') || (polled.run.consequence || '').toLowerCase().includes('inspect') : false;

      const runStatus = polled.run ? polled.run.status : 'unknown';
      const statusTag = runStatus === 'completed' ? '✓' : '✗';
      console.log(`${statusTag} run=R${runId} status=${runStatus} trunc=${truncatedCount} supp=${suppressedCount} phaseV=${phaseViolations}`);

      results.push({
        index: i,
        category: obj.category,
        objective: obj.text,
        ticketId: created.ticketId,
        runId,
        status: runStatus,
        truncatedCount,
        suppressedCount,
        phaseViolations,
        hasInspectionFallback: hasInspection
      });
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      results.push({ index: i, category: obj.category, status: 'error', error: e.message });
    }
  }

  console.log('\n========================================');
  console.log('TM-4 TRIAL SUMMARY');
  console.log('========================================\n');

  const total = results.length;
  const completed = results.filter(r => r.status === 'completed').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const timeouts = results.filter(r => r.status === 'timeout').length;
  const errors = results.filter(r => r.status === 'create_failed' || r.status === 'error').length;

  const totalTruncated = results.reduce((sum, r) => sum + (r.truncatedCount || 0), 0);
  const totalSuppressed = results.reduce((sum, r) => sum + (r.suppressedCount || 0), 0);
  const ticketsWithTruncation = results.filter(r => (r.truncatedCount || 0) > 0).length;
  const ticketsWithSuppression = results.filter(r => (r.suppressedCount || 0) > 0).length;
  const ticketsWithPhaseViolations = results.filter(r => (r.phaseViolations || 0) > 0).length;

  const categories = {};
  for (const r of results) {
    const cat = r.category || 'unknown';
    if (!categories[cat]) categories[cat] = { total: 0, completed: 0, failed: 0, truncated: 0, suppressed: 0 };
    categories[cat].total++;
    if (r.status === 'completed') categories[cat].completed++;
    if (r.status === 'failed') categories[cat].failed++;
    if (r.truncatedCount > 0) categories[cat].truncated++;
    if (r.suppressedCount > 0) categories[cat].suppressed++;
  }

  const truncResults = results.filter(r => r.truncatedCount > 0);
  const repeatTruncation = truncResults.filter((r, i, arr) =>
    arr.some((rr, ii) => ii !== i && rr.category === r.category && rr.status !== 'completed')
  );
  const uniqueRepeatTruncation = new Set(repeatTruncation.map(r => r.category));

  console.log(`Total tickets:    ${total}`);
  console.log(`Completed:        ${completed} (${(completed / total * 100).toFixed(1)}%)`);
  console.log(`Failed:           ${failed} (${(failed / total * 100).toFixed(1)}%)`);
  console.log(`Timeout:          ${timeouts} (${(timeouts / total * 100).toFixed(1)}%)`);
  console.log(`Create errors:    ${errors}\n`);

  console.log('Truncation events:');
  console.log(`  Total action.truncated:  ${totalTruncated}`);
  console.log(`  Tickets w/ truncation:   ${ticketsWithTruncation}`);
  console.log(`  Tickets w/ suppression:  ${ticketsWithSuppression}`);
  console.log(`  Tickets w/ phase viol:   ${ticketsWithPhaseViolations}\n`);

  console.log('By category:');
  for (const [cat, stats] of Object.entries(categories)) {
    const pct = stats.total > 0 ? (stats.completed / stats.total * 100).toFixed(0) : '0';
    console.log(`  ${cat.padEnd(20)} ${stats.total} tickets  ${stats.completed}/${stats.failed} done/fail  ${stats.truncated} truncated  ${stats.suppressed} suppressed  (${pct}% complete)`);
  }

  console.log(`\nTruncated ticket details (${truncResults.length} total):`);
  for (const r of truncResults) {
    console.log(`  R${r.runId} T${r.ticketId} ${r.category} ${r.status} trunc=${r.truncatedCount}`);
  }

  const detailedPath = path.join(DATA_DIR, 'tm4-results.json');
  fs.writeFileSync(detailedPath, JSON.stringify(results, null, 2));
  console.log(`\nDetailed results: ${detailedPath}`);

  console.log('\n========================================');
  console.log('TM-4 Report');
  console.log('========================================\n');

  const TM2_COMPLETION_RATE = 0;
  const TM2_FAILURE_RATE = 100;

  const completionDelta = completed / total * 100 - TM2_COMPLETION_RATE;
  const failureDelta = failed / total * 100 - TM2_FAILURE_RATE;

  console.log(`Completion rate:  ${(completed / total * 100).toFixed(1)}% (vs TM-2 ~0%) → Δ+${completionDelta.toFixed(1)}%`);
  console.log(`Failure rate:     ${(failed / total * 100).toFixed(1)}% (vs TM-2 ~100%) → Δ${failureDelta.toFixed(1)}%`);
  console.log(`Truncation used:  ${ticketsWithTruncation}/${total} tickets (${totalTruncated} events)`);
  console.log(`Suppression used: ${ticketsWithSuppression}/${total} tickets (${totalSuppressed} events)${totalSuppressed > 0 ? ' [SUPPRESSION LEAKED]' : ''}`);
  console.log(`Phase violations: ${ticketsWithPhaseViolations}/${total} tickets`);

  const newFailureModes = [];
  if (timeouts > 0) newFailureModes.push(`runtime timeout (${timeouts} tickets)`);
  if (errors > 0) newFailureModes.push(`create/API errors (${errors} tickets)`);

  console.log(`\nNew failure modes: ${newFailureModes.length > 0 ? newFailureModes.join(', ') : 'none observed'}`);
  console.log(`Repeat truncation (same category recurring): ${uniqueRepeatTruncation.size > 0 ? Array.from(uniqueRepeatTruncation).join(', ') : 'none'}`);

  const recommendation = completed > total * 0.5 ? 'keep' : 'revise';
  console.log(`\nRecommendation: ${recommendation}`);
  console.log('  (Provisional — based on single trial)');

  serverProcess.kill();
  console.log('\nServer stopped.');
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
