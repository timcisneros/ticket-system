#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function exists(relativePath) {
  return fs.existsSync(path.join(ROOT, relativePath)) ? 'present' : 'missing';
}

const sections = [
  ['Architecture Summary', [
    'Fastify server-rendered ticket system in server.js.',
    'Ticket -> Agent -> Capability -> Actions -> Environment.',
    'Capabilities are direct actions or enabled workflow JSON definitions.',
    'Execution is single-process with JSON persistence and append-only events.',
    'Mutations go through authority checks, replay, operation history, recovery, evaluation, and consequence recording.'
  ]],
  ['Important Runtime Files', [
    `server.js (${exists('server.js')})`,
    `views/ (${exists('views')})`,
    `data/tickets.json (${exists('data/tickets.json')})`,
    `data/runs.json (${exists('data/runs.json')})`,
    `data/events.jsonl (${exists('data/events.jsonl')})`,
    `data/workflows.json (${exists('data/workflows.json')})`,
    `data/replay-snapshots/ (${exists('data/replay-snapshots')})`,
    `workspace-root/ (${exists('workspace-root')})`
  ]],
  ['Verification Commands', [
    'npm run build',
    'npm run test:workflow',
    'npm run test:postcondition',
    'npm run benchmark:operational-endurance',
    'node scripts/page-render-regression-test.js',
    'node scripts/catalog-consistency-test.js'
  ]],
  ['Benchmark Commands', [
    'npm run benchmark:workflow-drafts',
    'npm run benchmark:workflow-repair',
    'npm run benchmark:ambiguous-operational',
    'REAL_MODEL_BENCHMARK=1 npm run benchmark:workflow-drafts',
    'REAL_MODEL_BENCHMARK=1 npm run benchmark:workflow-repair',
    'REAL_MODEL_BENCHMARK=1 npm run benchmark:ambiguous-operational',
    'npm run experiment:workflow-schema-teaching'
  ]],
  ['Tracing Commands', [
    'npm run codex:trace -- --run <id>',
    'node scripts/oquery.js replay <id>',
    'node scripts/oquery.js failures --run <id> --json',
    'curl -s http://localhost:3000/api/runs/<id>/state',
    'curl -s http://localhost:3000/api/runs/<id>/events'
  ]],
  ['Evidence Locations', [
    'data/events.jsonl: append-only event records',
    'data/runs.json: run records, leases, runEvaluation, runConsequence',
    'data/replay-snapshots/run-<id>.json: provider requests, model responses, parsed actions, workflow actions, authority checks',
    'data/operation-history.json: workspace mutation history and recovery source',
    'data/logs.json: run and system logs',
    'data/benchmark-results.jsonl: real-model benchmark evidence'
  ]],
  ['Operational Rules', [
    'Inspect evidence before changing code.',
    'Keep mocked mode deterministic and fail-hard.',
    'Keep real mode observational and append JSONL evidence.',
    'Do not weaken validation to produce green benchmarks.',
    'Do not add ontology systems, semantic graphs, broad DSLs, approval workflows, or new orchestration infrastructure.'
  ]],
  ['Safe Debugging Order', [
    '1. Inspect evidence.',
    '2. Trace one failed run.',
    '3. Verify runtime assumptions.',
    '4. Isolate model vs runtime failure.',
    '5. Reproduce minimally.',
    '6. Change code only after evidence identifies a runtime bug.',
    '7. Re-run deterministic verification.'
  ]]
];

for (const [title, lines] of sections) {
  console.log(`\n## ${title}`);
  lines.forEach(line => console.log(`- ${line}`));
}
