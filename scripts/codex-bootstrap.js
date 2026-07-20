#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const migrations = fs.readdirSync(path.join(root, 'persistence', 'postgres', 'migrations'))
  .filter(name => name.endsWith('.sql'))
  .sort();

const sections = [
  ['Runtime', [
    'Fastify/EJS server: server.js',
    'Structured state, evidence, sessions, leases, and coordination: PostgreSQL only',
    `PostgreSQL migrations: ${migrations.length} (${migrations[0]} through ${migrations[migrations.length - 1]})`,
    'Filesystem state: execution workspace and replaceable browser artifacts only',
    'Run admission: deployment-wide PostgreSQL policy; mutation admission: recoverable process-local pressure'
  ]],
  ['Required startup environment', [
    'DATABASE_URL=postgresql://...',
    'SESSION_SECRET=<stable high-entropy secret>',
    'POSTGRES_SCHEMA=ticket_system (optional)',
    'WORKSPACE_ROOT=.local-workspace (optional)',
    'ARTIFACT_ROOT=.local-artifacts (optional)'
  ]],
  ['Verification', [
    'npm run build',
    'TEST_DATABASE_URL=postgresql://... npm run test:persistence:postgres',
    'TEST_DATABASE_URL=postgresql://... npm run test:cutover:postgres',
    'TEST_DATABASE_URL=postgresql://... npm run checkpoint:release'
  ]],
  ['Operator flow', [
    'node scripts/oquery.js login --url http://127.0.0.1:3099',
    'node scripts/oquery.js create-ticket --url http://127.0.0.1:3099 --agent <id|name> --wait --json "<objective>"',
    'npm run codex:trace -- --run <id>'
  ]],
  ['Evidence inspection', [
    'GET /api/runs/:id/state',
    'GET /api/runs/:id/events',
    'GET /api/runs/:id/decision-graph',
    'GET /api/event-journal (bounded filters)',
    'GET /api/runtime/status'
  ]]
];

for (const [title, lines] of sections) {
  console.log(`\n## ${title}`);
  for (const line of lines) console.log(`- ${line}`);
}
