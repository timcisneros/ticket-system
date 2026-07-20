#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

function runIdFromArgs(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--run') return Number(argv[index + 1]);
    if (/^[1-9]\d*$/.test(argv[index])) return Number(argv[index]);
  }
  return 0;
}

function requestJson(baseUrl, cookie, route) {
  return new Promise((resolve, reject) => {
    const url = new URL(route, baseUrl);
    const request = http.request(url, { headers: { Cookie: `sessionId=${cookie}` } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`${route} returned HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (error) { reject(new Error(`${route} returned invalid JSON: ${error.message}`)); }
      });
    });
    request.on('error', reject);
    request.end();
  });
}

async function main() {
  const runId = runIdFromArgs(process.argv.slice(2));
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error('Usage: npm run codex:trace -- --run <id>');
  const root = path.resolve(__dirname, '..');
  const cookiePath = process.env.OPERC_COOKIE_PATH || path.join(root, '.opercookie');
  let cookie;
  try { cookie = fs.readFileSync(cookiePath, 'utf8').trim(); } catch (_) {}
  if (!cookie) throw new Error(`No operator session at ${cookiePath}; run node scripts/oquery.js login first`);
  const baseUrl = process.env.OPERC_URL || 'http://127.0.0.1:3099';
  const [state, events, decisionGraph, logs] = await Promise.all([
    requestJson(baseUrl, cookie, `/api/runs/${runId}/state`),
    requestJson(baseUrl, cookie, `/api/runs/${runId}/events`),
    requestJson(baseUrl, cookie, `/api/runs/${runId}/decision-graph`),
    requestJson(baseUrl, cookie, `/api/logs?runId=${runId}&limit=100`)
  ]);
  console.log(JSON.stringify({
    runtime: { backend: 'postgres', server: baseUrl },
    state,
    events,
    decisionGraph,
    logs: logs.logs || []
  }, null, 2));
}

main().catch(error => {
  console.error(error && error.message ? error.message : error);
  process.exit(1);
});
