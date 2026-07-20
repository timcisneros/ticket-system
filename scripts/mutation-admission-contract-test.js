#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const scheduler = fs.readFileSync(path.join(root, 'runtime', 'scheduler.js'), 'utf8');
const store = fs.readFileSync(path.join(root, 'persistence', 'postgres', 'store.js'), 'utf8');

function routeOptions(method, route) {
  const marker = `fastify.${method}('${route}',`;
  const start = server.indexOf(marker);
  assert.ok(start >= 0, `route registration not found: ${method.toUpperCase()} ${route}`);
  const handler = server.indexOf('async (request, reply)', start);
  assert.ok(handler > start, `route handler not found: ${method.toUpperCase()} ${route}`);
  return server.slice(start, handler);
}

for (const [method, route] of [
  ['post', '/tickets'],
  ['post', '/api/watcher-proposals/:id/approve'],
  ['post', '/api/process-templates/:id/trigger'],
  ['post', '/api/process-templates/scheduler/tick'],
  ['post', '/api/runtime-limits'],
  ['post', '/admin/runtime-limits'],
  ['post', '/api/tickets/:id/handoff'],
  ['patch', '/api/tickets/:id/assignment'],
  ['patch', '/api/tickets/:id/status'],
  ['post', '/api/tickets/:id/rerun'],
  ['post', '/api/runs/:id/stop'],
  ['post', '/api/runs/:id/retry'],
  ['post', '/api/tickets/:id/triage/resolve'],
  ['post', '/api/runs/:id/triage/resolve'],
  ['post', '/api/tickets/:id/execution-policy/max-attempts']
]) {
  assert.match(routeOptions(method, route), /mutationAdmission:\s*true/,
    `evidence-producing route lacks mutation admission: ${method.toUpperCase()} ${route}`);
}

for (const [method, route] of [
  ['post', '/login'],
  ['post', '/api/connectors/:id/read'],
  ['post', '/api/tickets/shape-objective']
]) {
  assert.doesNotMatch(routeOptions(method, route), /mutationAdmission:\s*true/,
    `non-mutating route consumes mutation admission: ${method.toUpperCase()} ${route}`);
}

assert.match(server, /return Boolean\(config && config\.mutationAdmission === true\);/);
assert.doesNotMatch(server, /eventJournalAdmission|EVENT_ADMISSION_BACKPRESSURED|event_journal_capacity/);

const inboxStart = server.indexOf("fastify.post('/api/inbox/threads/:id/resolve'");
const inboxEnd = server.indexOf("fastify.get('/api/work-types'", inboxStart);
const inbox = server.slice(inboxStart, inboxEnd);
assert.match(inbox, /if \(thread\.kind === 'blocker'\) \{[\s\S]*runWithNewMutationAdmission\(/,
  'blocker resolution must acquire mutation admission before triage mutation');
assert.doesNotMatch(routeOptions('post', '/api/inbox/threads/:id/resolve'), /mutationAdmission:\s*true/,
  'deliverable acknowledgement must not reserve the mixed route as if it emitted triage evidence');

assert.match(server, /const BROWSER_OPERATIONS_REQUIRING_MUTATION_ADMISSION = new Set\(\['navigate', 'screenshot'\]\);/);
assert.match(server, /isBrowserRun\(run\) && BROWSER_OPERATIONS_REQUIRING_MUTATION_ADMISSION\.has\(proposedOperation\)/);

const appendStart = server.indexOf('async function appendEvent(event = {})');
const appendEnd = server.indexOf('\nasync function getRunEvents(', appendStart);
assert.ok(appendStart >= 0 && appendEnd > appendStart);
const append = server.slice(appendStart, appendEnd);
assert.match(append, /await postgresRuntimeStore\.appendEvent\(/,
  'events must append through PostgreSQL');
assert.match(append, /POSTGRES_RECORD_TOO_LARGE[\s\S]*statusCode\) error\.statusCode = 413/,
  'oversized records must remain request-scoped');
assert.match(append, /evidencePersistenceFailure = error[\s\S]*serverReady = false/,
  'actual event persistence failure must fail closed for the current process');
assert.doesNotMatch(append, /events\.jsonl|FileHandle|fsync|sync\(/);

assert.match(server, /reason: 'mutation_admission_capacity'/,
  'recoverable admission pressure must have a distinct health reason');
assert.match(server, /isMutationAdmissionBackpressured\(\)/);
assert.match(server, /concurrencyLimits:\s*\{\s*scope: 'deployment'/);
assert.doesNotMatch(server, /process_concurrency_limit|getRunStartBlockReason|activeProcessRuns/,
  'process-local scheduler capacity must not duplicate deployment admission');
assert.doesNotMatch(scheduler, /process_concurrency_limit|getRunStartBlockReason/);

assert.match(store, /pg_advisory_xact_lock\(hashtextextended\('ticket-system:run-admission', 0\)\)/,
  'deployment admission must serialize only its short Postgres decision');
assert.match(store, /active\.total < policy\.max_active_runs/);
assert.match(store, /active\.local_model < policy\.local_model_concurrency/);
assert.match(store, /FOR UPDATE OF pending_run SKIP LOCKED/);

console.log('PASS: mutation admission is recoverable and process-local; Postgres lease admission is deployment-wide');
