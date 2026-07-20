#!/usr/bin/env node
// Operational session helper — interact with the running server
const http = require('http');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3099';

function dim(s) { return `\x1b[2m${s}\x1b[0m`; }
function green(s) { return `\x1b[32m${s}\x1b[0m`; }
function red(s) { return `\x1b[31m${s}\x1b[0m`; }
function yellow(s) { return `\x1b[33m${s}\x1b[0m`; }

const args = process.argv.slice(2);
const cmd = args[0];

function req(m, p, o = {}) {
  return new Promise((res, rej) => {
    const body = o.form ? new URLSearchParams(o.form).toString() : o.json ? JSON.stringify(o.json) : null;
    const ct = o.json ? 'application/json' : (body ? 'application/x-www-form-urlencoded' : null);
    const h = {};
    if (body) { h['Content-Type'] = ct; h['Content-Length'] = Buffer.byteLength(body); }
    if (o.cookie) h['Cookie'] = o.cookie;
    const r = http.request(BASE + p, { method: m, headers: h }, resp => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => {
        const c = (resp.headers['set-cookie'] || []).map(x => x.split(';')[0]).join('; ');
        res({ status: resp.statusCode, headers: resp.headers, body: d, cookie: c });
      });
    });
    r.on('error', rej);
    if (body) r.write(body);
    r.end();
  });
}

async function login() {
  const r = await req('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
  return r.cookie;
}

async function listRuns(cookie) {
  const runs = [];
  let cursor = null;
  while (true) {
    const query = new URLSearchParams({ domain: 'runs', limit: '100' });
    if (cursor !== null) query.set('cursor', String(cursor));
    const response = await req('GET', `/api/export?${query}`, { cookie });
    if (response.status !== 200) throw new Error(`Failed to fetch runs (HTTP ${response.status})`);
    const page = JSON.parse(response.body);
    runs.push(...(page.items || []));
    if (page.nextCursor === null || page.nextCursor === undefined) return runs;
    if (String(page.nextCursor) === String(cursor)) throw new Error('Run export returned a non-advancing cursor');
    cursor = page.nextCursor;
  }
}

async function main() {
  const cookie = await login();

  if (cmd === 'create-ticket') {
    const objective = args.slice(1).join(' ');
    if (!objective) { console.error('Usage: op-session create-ticket <objective>'); process.exit(1); }
    console.error(dim(`[remote substrate: ${BASE}]`));
    const r = await req('POST', '/tickets', { form: { objective, assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual' }, cookie });
    if (r.status === 302) {
      // Fetch ticket list to find the newly created ticket
      const listRes = await req('GET', '/api/tickets', { cookie });
      if (listRes.status === 200) {
        try {
          const tickets = JSON.parse(listRes.body).tickets || JSON.parse(listRes.body);
          if (tickets.length > 0) {
            const created = tickets.reduce((a, b) => (a.id > b.id ? a : b));
            const statusLabel = created.status === 'completed' ? green(created.status) : created.status === 'failed' ? red(created.status) : yellow(created.status);
            console.log(`  ${green('✓')} Ticket T${created.id} created on ${BASE} (${statusLabel})`);
            return created.id;
          }
        } catch (e) { /* fall through */ }
      }
      console.log(`  ${green('✓')} Ticket created on ${BASE} (HTTP ${r.status})`);
    } else {
      console.log(`  ${red('✗')} Failed (HTTP ${r.status})`);
    }
    return null;
  }

  if (cmd === 'list-tickets') {
    console.error(dim(`[remote substrate: ${BASE}]`));
    const r = await req('GET', '/api/tickets', { cookie });
    console.log(r.body);
  }

  if (cmd === 'list-runs' || cmd === 'run-status') {
    console.error(dim(`[PostgreSQL runtime: ${BASE}]`));
    const runs = await listRuns(cookie);
    console.log(JSON.stringify(runs.map(run => ({ id: run.id, ticketId: run.ticketId, status: run.status, agent: run.agentName })), null, 2));
  }

  if (cmd === 'wait') {
    const ticketId = parseInt(args[1]);
    if (!ticketId) { console.error('Usage: op-session wait <ticketId>'); process.exit(1); }
    console.log(dim(`[PostgreSQL runtime: ${BASE}]`));
    console.log('Waiting for ticket', ticketId, '...');
    for (let i = 0; i < 60; i++) {
      const response = await req('GET', `/api/tickets/${ticketId}/runtime`, { cookie });
      if (response.status === 404) {
        console.log(red(`  ✗ Ticket T${ticketId} not found on server.`));
        return;
      }
      if (response.status === 200) {
        const data = JSON.parse(response.body);
        const ticket = data.ticket;
        const run = data.latestRun || data.currentRun || null;
        if (ticket && ['completed', 'failed'].includes(ticket.status)) {
          const statusLabel = ticket.status === 'completed' ? green(ticket.status) : red(ticket.status);
          console.log('  Ticket', ticketId, 'status:', statusLabel);
          if (run) console.log('    Run', run.id, 'status:', run.status, run.error ? '- ERROR: ' + run.error.substring(0, 100) : '');
          return;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    console.log(red('  ✗ Timeout waiting for ticket'), ticketId);
  }

  if (!cmd || cmd === 'help') {
    console.log(`
  op-session — operational session helper

  ${dim('[remote substrate:')} ${BASE}${dim(']')}

  Commands:
    create-ticket <objective>   Create a ticket on the server
    list-tickets                List all tickets (JSON, via API)
    list-runs                   List all runs (JSON, via API)
    run-status                  Show run statuses (from PostgreSQL via API)
    wait <ticketId>              Poll API until ticket completes/fails
    help                         This help
    `);
  }
}

main().catch(e => console.error(e));
