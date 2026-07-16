#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function routeOptions(method, route) {
  const marker = `fastify.${method}('${route}',`;
  const start = source.indexOf(marker);
  assert(start >= 0, `route registration not found: ${method.toUpperCase()} ${route}`);
  const handlerStart = source.indexOf('async (request, reply)', start);
  assert(handlerStart >= 0, `route handler not found: ${method.toUpperCase()} ${route}`);
  return source.slice(start, handlerStart);
}

const journalDependentRoutes = [
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
  ['post', '/api/runs/:id/retry']
];

for (const [method, route] of journalDependentRoutes) {
  assert(
    /eventJournalAdmission:\s*true/.test(routeOptions(method, route)),
    `journal-dependent route lacks explicit admission: ${method.toUpperCase()} ${route}`
  );
}

const journalIndependentUnsafeRoutes = [
  ['post', '/login'],
  ['post', '/api/work-contexts'],
  ['post', '/api/connectors/:id/read'],
  ['post', '/api/tickets/shape-objective'],
  ['post', '/api/tickets/:id/execution-policy/max-attempts'],
  ['post', '/api/workspace/folder'],
  ['post', '/admin/users']
];

for (const [method, route] of journalIndependentUnsafeRoutes) {
  assert(
    !/eventJournalAdmission:\s*true/.test(routeOptions(method, route)),
    `journal-independent route consumes event admission: ${method.toUpperCase()} ${route}`
  );
}

assert(
  /return Boolean\(config && config\.eventJournalAdmission === true\);/.test(source),
  'unsafe HTTP routes do not default to explicit journal-admission opt-in'
);
assert(!/eventJournalAdmission:\s*false/.test(source), 'obsolete route-level admission opt-outs remain');

console.log('PASS: event journal admission is explicit and limited to journal-dependent HTTP routes');
