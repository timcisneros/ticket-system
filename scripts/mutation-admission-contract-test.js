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

// P4-R2: browser Phase-2 interactions (click/fill/press) are mutation-tier
// receipts and join navigate/screenshot in the mutation-admission set; the
// frozen spread keeps the interaction catalog the single source of membership.
assert.match(server, /const BROWSER_OPERATIONS_REQUIRING_MUTATION_ADMISSION = new Set\(\[\s*'navigate',\s*'screenshot',\s*\.\.\.BROWSER_INTERACTION_OPERATIONS\s*\]\);/);
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

// P6-S2: recoverable admission pressure is CAPACITY, not readiness. The old
// 503-backpressure-as-readiness health reason is expressly removed (the P6
// correction target); health carries `capacity.mutationAdmission` from the
// canonical admission metrics, saturation stays observable, and the
// recoverable refusal code is unchanged on the admission authority itself.
assert.doesNotMatch(server, /reason: 'mutation_admission_capacity'/,
  'backpressure must no longer exist as a readiness-failure health reason');
assert.match(server, /admissionMetrics: mutationAdmission\.getMetrics\(\)/,
  'health capacity is sourced from the canonical admission metrics');
assert.match(server, /require\('\.\/runtime\/health-readiness'\)/,
  'health routes project the frozen readiness semantics through the single owner');
assert.match(server, /isMutationAdmissionBackpressured\(\)/);
assert.match(server, /concurrencyLimits:\s*\{\s*scope: 'deployment'/);
assert.doesNotMatch(server, /process_concurrency_limit|getRunStartBlockReason|activeProcessRuns/,
  'process-local scheduler capacity must not duplicate deployment admission');
assert.doesNotMatch(scheduler, /process_concurrency_limit|getRunStartBlockReason/);

// DRAIN-ADMISSION-A: a terminal, process-local drain flag arms at the FIRST
// SYNCHRONOUS boundary of shutdown — before ANY await — and the single normal
// HTTP mutation-admission owner consults it, refusing every new application
// mutation for the entire drain window. Structural anchors:
//   1. `beginDrain()` is the first shutdown action (before the async drain
//      body's first await);
//   2. the admission hook refuses with the bounded terminal-drain code INSIDE
//      the mutation pre-admission branch, before any token could be acquired;
//   3. no Retry-After on the terminal refusal (retrying never recovers the
//      process);
//   4. only a fresh process clears the flag (not wired to any route, command,
//      or writable control surface).
const shutdownFnStart = server.indexOf('function shutdown(signal)');
assert.ok(shutdownFnStart >= 0, 'the shutdown path exists in server.js');
const shutdownIifeStart = server.indexOf('shutdownPromise = (async () => {', shutdownFnStart);
assert.ok(shutdownIifeStart > shutdownFnStart, 'the shutdown body is present');
const shutdownSyncPrefix = server.slice(shutdownFnStart, shutdownIifeStart);
assert.match(shutdownSyncPrefix, /mutationAdmission\.beginDrain\(\)/,
  'shutdown must arm the terminal drain flag synchronously, before ANY await');
assert.doesNotMatch(shutdownSyncPrefix, /await\s/, 'no await may precede the synchronous drain arming');
const shutdownBody = server.slice(shutdownIifeStart, shutdownFnStart + 4000);
assert.match(shutdownBody, /await runtimeScheduler\.whenIdle\(\)/,
  'the drain window between arming and HTTP close still exists for the live proof');
const hookNeedle = 'request.routeStartedAtNs = process.hrtime.bigint();';
const mutationHookStart = server.indexOf(hookNeedle);
assert.ok(mutationHookStart > 0, 'the normal HTTP mutation-admission hook exists in server.js');
const closingFlagRead = server.indexOf('if (mutationAdmission.closing) {', mutationHookStart);
assert.ok(closingFlagRead > mutationHookStart && closingFlagRead < mutationHookStart + 3000,
  'the admission owner consults the terminal drain flag inside its own onRequest hook');
const closingFlagReadBlock = server.slice(closingFlagRead, server.indexOf('const token = mutationAdmission.tryAcquireAdmission', closingFlagRead));
assert.match(closingFlagReadBlock, /MUTATION_ADMISSION_DRAINING/,
  'the terminal-drain HTTP refusal carries the designed bounded code');
assert.doesNotMatch(closingFlagReadBlock, /Retry-After/,
  'the terminal-drain refusal must not advertise retryability');
assert.ok(closingFlagRead < server.indexOf('const token = mutationAdmission.tryAcquireAdmission', mutationHookStart) &&
  closingFlagRead > mutationHookStart,
  'the terminal-drain refusal stands before any token acquisition in the hook');
assert.doesNotMatch(server, /beginDrain\s*=\s*(function|async)|app\.(get|post)\('[^']*drain/i,
  'no HTTP surface may own or reset the terminal drain flag');

assert.match(store, /pg_advisory_xact_lock\(hashtextextended\('ticket-system:run-admission', 0\)\)/,
  'deployment admission must serialize only its short Postgres decision');
assert.match(store, /active\.total < policy\.max_active_runs/);
assert.match(store, /active\.local_model < policy\.local_model_concurrency/);
assert.match(store, /FOR UPDATE OF pending_run SKIP LOCKED/);

console.log('PASS: mutation admission is recoverable and process-local; Postgres lease admission is deployment-wide');
