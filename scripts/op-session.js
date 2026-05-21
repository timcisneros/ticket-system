#!/usr/bin/env node
// Operational session helper — interact with the running server
const http = require('http');
const path = require('path');
const fs = require('fs');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3099';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

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

  if (cmd === 'list-runs') {
    console.error(dim(`[remote substrate: ${BASE}]`));
    const r = await req('GET', '/api/export', { cookie });
    if (r.status === 200) {
      try {
        const data = JSON.parse(r.body);
        const runs = (data.runs || []).map(run => ({ id: run.id, ticketId: run.ticketId, status: run.status, agent: run.agentName }));
        console.log(JSON.stringify(runs, null, 2));
      } catch (e) {
        console.log(red('Failed to parse run data.'));
      }
    } else {
      console.log(red(`Failed to fetch runs (HTTP ${r.status})`));
    }
  }

  if (cmd === 'run-status') {
    console.log(dim(`[local substrate: ${DATA_DIR}]`));
    const runsData = fs.readFileSync(path.join(DATA_DIR, 'runs.json'), 'utf8');
    const runs = JSON.parse(runsData);
    console.log(JSON.stringify(runs.map(r => ({ id: r.id, ticketId: r.ticketId, status: r.status, agent: r.agentName })), null, 2));
  }

  if (cmd === 'wait') {
    const ticketId = parseInt(args[1]);
    if (!ticketId) { console.error('Usage: op-session wait <ticketId>'); process.exit(1); }
    console.log(dim(`[remote substrate: ${BASE}]`));
    console.log('Waiting for ticket', ticketId, '...');

    // Check ticket exists
    const check = await req('GET', `/api/tickets`, { cookie });
    if (check.status === 200) {
      try {
        const tickets = JSON.parse(check.body).tickets || JSON.parse(check.body);
        if (!tickets.some(t => t.id === ticketId)) {
          console.log(red(`  ✗ Ticket T${ticketId} not found on server.`));
          return;
        }
      } catch (e) { /* fall through to polling */ }
    }

    for (let i = 0; i < 60; i++) {
      const listRes = await req('GET', '/api/tickets', { cookie });
      if (listRes.status === 200) {
        try {
          const tickets = JSON.parse(listRes.body).tickets || JSON.parse(listRes.body);
          const t = tickets.find(item => item.id === ticketId);
          if (t && (t.status === 'completed' || t.status === 'failed')) {
            const statusLabel = t.status === 'completed' ? green(t.status) : red(t.status);
            console.log('  Ticket', ticketId, 'status:', statusLabel);
            // Fetch run details
            const exportRes = await req('GET', '/api/export', { cookie });
            if (exportRes.status === 200) {
              const data = JSON.parse(exportRes.body);
              const runs = (data.runs || []).filter(r => r.ticketId === ticketId);
              runs.forEach(r => console.log('    Run', r.id, 'status:', r.status, r.error ? '- ERROR: ' + r.error.substring(0, 100) : ''));
            }
            return;
          }
        } catch (e) { /* retry */ }
      }
      await new Promise(r => setTimeout(r, 2000));
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
    run-status                  Show run statuses (from local data file)
    wait <ticketId>              Poll API until ticket completes/fails
    help                         This help
    `);
  }
}

main().catch(e => console.error(e));
