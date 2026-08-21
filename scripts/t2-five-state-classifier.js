#!/usr/bin/env node
'use strict';

// Zero-mutation historical Ticket classifier. The classifier phase runs inside
// a PostgreSQL READ ONLY transaction and uses raw SELECTs only; it never calls
// a store method that can reconcile or materialize state.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { Client } = require('pg');
const { classifyTicketHistory } = require('../runtime/ticket-history-classifier-contract');

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const REPORT_VERSION = 1;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}

function parseArguments(argv) {
  const options = {
    databaseUrlEnv: 'TEST_DATABASE_URL',
    schema: 'public',
    expectedDatabase: null,
    reportPath: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--database-url-env') {
      options.databaseUrlEnv = argv[++index];
    } else if (argument === '--schema') {
      options.schema = argv[++index];
    } else if (argument === '--expected-database') {
      options.expectedDatabase = argv[++index];
    } else if (argument === '--report') {
      options.reportPath = argv[++index];
    } else if (argument === '--help') {
      console.log('Usage: node scripts/t2-five-state-classifier.js [--database-url-env ENV] [--schema NAME] [--expected-database NAME] [--report PATH]');
      process.exit(0);
    } else {
      throw new TypeError(`Unsupported argument: ${argument}`);
    }
  }
  if (typeof options.databaseUrlEnv !== 'string' ||
      !/^[A-Z][A-Z0-9_]*$/.test(options.databaseUrlEnv)) {
    throw new TypeError('--database-url-env must be an environment variable name');
  }
  if (typeof options.schema !== 'string' || !IDENTIFIER.test(options.schema)) {
    throw new TypeError('--schema must be a safe PostgreSQL identifier');
  }
  if (options.expectedDatabase !== null &&
      (typeof options.expectedDatabase !== 'string' || !options.expectedDatabase.trim())) {
    throw new TypeError('--expected-database must be a non-empty database name');
  }
  if (options.reportPath !== null &&
      (typeof options.reportPath !== 'string' || !options.reportPath.trim())) {
    throw new TypeError('--report must be a non-empty path');
  }
  return options;
}

function ticketFact(row) {
  return {
    ...((row.body && typeof row.body === 'object' && !Array.isArray(row.body)) ? row.body : {}),
    id: Number(row.id),
    status: row.status,
    cancellationAuthority: row.cancellation_authority,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function attemptFact(row) {
  return {
    id: Number(row.id),
    ticketId: Number(row.ticket_id),
    ordinal: Number(row.ordinal),
    memberCount: Number(row.member_count),
    disposition: row.disposition,
    admittedAt: row.admitted_at.toISOString(),
    settledAt: row.settled_at ? row.settled_at.toISOString() : null,
    revision: Number(row.revision)
  };
}

function runFact(row) {
  return {
    ...((row.body && typeof row.body === 'object' && !Array.isArray(row.body)) ? row.body : {}),
    id: Number(row.id),
    ticketId: Number(row.ticket_id),
    ticketAttemptId: Number(row.ticket_attempt_id),
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null
  };
}

function eventFact(row) {
  return {
    id: row.id,
    position: Number(row.position),
    ticketId: row.ticket_id === null ? null : Number(row.ticket_id),
    runId: row.run_id === null ? null : Number(row.run_id),
    type: row.type,
    ts: row.ts.toISOString(),
    payload: row.payload
  };
}

function logFact(row) {
  return {
    id: Number(row.id),
    ticketId: row.ticket_id === null
      ? (row.context_ticket_id === null ? null : Number(row.context_ticket_id))
      : Number(row.ticket_id),
    runId: row.run_id === null
      ? (row.context_run_id === null ? null : Number(row.context_run_id))
      : Number(row.run_id),
    type: row.type,
    timestamp: row.occurred_at.toISOString(),
    body: row.body
  };
}

function planFact(row) {
  return {
    ...((row.body && typeof row.body === 'object' && !Array.isArray(row.body)) ? row.body : {}),
    id: Number(row.id),
    ticketId: Number(row.ticket_id),
    status: row.status,
    revision: Number(row.revision),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

async function readFacts(client, schema) {
  const table = name => `"${schema}"."${name}"`;
  const tickets = await client.query(
    `SELECT id, status, cancellation_authority, body, created_at, updated_at FROM ${table('tickets')} ORDER BY id`
  );
  const attempts = await client.query(
    `SELECT id, ticket_id, ordinal, member_count, disposition, admitted_at, settled_at, revision FROM ${table('ticket_attempts')} ORDER BY ticket_id, ordinal`
  );
  const runs = await client.query(
    `SELECT id, ticket_id, ticket_attempt_id, status, body, created_at, updated_at, completed_at FROM ${table('runs')} ORDER BY ticket_id, id`
  );
  const consequences = await client.query(
    `SELECT run_id, ticket_id, consequence, recorded_at FROM ${table('run_consequences')} ORDER BY ticket_id, run_id`
  );
  const plans = await client.query(
    `SELECT id, ticket_id, status, body, revision, created_at, updated_at FROM ${table('allocation_plans')} ORDER BY ticket_id, id`
  );
  const events = await client.query(
    `SELECT id, position, ticket_id, run_id, type, ts, payload FROM ${table('events')} ORDER BY position`
  );
  const logs = await client.query(
    `SELECT id, ticket_id, run_id, context_ticket_id, context_run_id, type, occurred_at, body FROM ${table('diagnostic_logs')} ORDER BY id`
  );
  return {
    tickets: tickets.rows.map(ticketFact),
    attempts: attempts.rows.map(attemptFact),
    runs: runs.rows.map(runFact),
    consequences: consequences.rows.map(row => ({
      runId: Number(row.run_id),
      ticketId: Number(row.ticket_id),
      recordedAt: row.recorded_at.toISOString(),
      consequence: row.consequence
    })),
    plans: plans.rows.map(planFact),
    events: events.rows.map(eventFact),
    logs: logs.rows.map(logFact)
  };
}

function buildReport(facts) {
  const tickets = facts.tickets.map(ticket => classifyTicketHistory({
    ticket,
    attempts: facts.attempts.filter(attempt => attempt.ticketId === ticket.id),
    runs: facts.runs.filter(run => run.ticketId === ticket.id),
    consequences: facts.consequences.filter(consequence => consequence.ticketId === ticket.id),
    plans: facts.plans.filter(plan => plan.ticketId === ticket.id),
    events: facts.events.filter(event => event.ticketId === ticket.id),
    logs: facts.logs.filter(log => log.ticketId === ticket.id)
  }));
  const summary = {
    total: tickets.length,
    migratable: tickets.filter(ticket => ticket.classification === 'migratable').length,
    ambiguous: tickets.filter(ticket => ticket.classification === 'ambiguous').length,
    integrityContradictions: tickets.filter(ticket =>
      ticket.classification === 'integrity_contradiction').length,
    proposedLifecycle: Object.fromEntries([
      'open', 'in_progress', 'blocked', 'completed', 'canceled'
    ].map(state => [state, tickets.filter(ticket => ticket.proposedLifecycle === state).length])),
    closedClassification: Object.fromEntries([
      'proven_canceled', 'proven_not_canceled', 'ambiguous'
    ].map(state => [state, tickets.filter(ticket => ticket.closedClassification === state).length]))
  };
  const report = {
    schemaVersion: REPORT_VERSION,
    classifier: 't2-five-state-historical-ticket-classifier',
    summary,
    tickets
  };
  const semantic = stableJson(report);
  return {
    ...report,
    reportHash: crypto.createHash('sha256').update(semantic).digest('hex')
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const databaseUrl = process.env[options.databaseUrlEnv];
  if (!databaseUrl) throw new Error(`${options.databaseUrlEnv} is required`);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const mode = await client.query('SHOW transaction_read_only');
    if (mode.rows[0].transaction_read_only !== 'on') {
      throw new Error('classifier requires transaction_read_only=on');
    }
    if (options.expectedDatabase !== null) {
      const identity = await client.query('SELECT current_database() AS database');
      if (identity.rows[0].database !== options.expectedDatabase) {
        throw new Error(
          `classifier connected to unexpected database ${identity.rows[0].database}`
        );
      }
    }
    const facts = await readFacts(client, options.schema);
    const report = buildReport(facts);
    await client.query('ROLLBACK');
    const output = stableJson(report);
    if (options.reportPath) fs.writeFileSync(options.reportPath, `${output}\n`, 'utf8');
    else process.stdout.write(`${output}\n`);
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    await client.end();
  }
}

module.exports = {
  REPORT_VERSION,
  buildReport,
  readFacts,
  stableJson
};

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}
