#!/usr/bin/env node
'use strict';

// Tranche 5 — governed OpenAI traffic in tests is provably local.
//
// THE INCIDENT THIS ENCODES. A real-server harness stubbed `global.fetch` and
// was believed offline. The governed transport does not use `fetch` — it sends
// bytes with `https.request` to a hard-coded `api.openai.com` — so the stub
// intercepted nothing, while the spawned server inherited `process.env` and
// could carry a developer credential. The mistake was invisible because a
// plausible-looking response came back and the run simply continued.
//
// Two independent guarantees are asserted here, because either alone can be
// bypassed by a future change:
//
//   INJECTION   the documented `httpsRequest` seam is bound to a deterministic
//               stub before the server loads the module;
//   KILL SWITCH the real `https.request` / `http.request` throw for any
//               non-localhost host, so a bypass fails loudly.
//
// No credential value is read, printed, or asserted on anywhere in this file.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createOpenAiGovernedTransport,
  GOVERNED_OPENAI_ENDPOINT
} = require('../runtime/governed-openai-transport');

const PRELOAD = path.join(__dirname, 'fixtures', 'hermetic-governed-transport-preload.js');
const FIXTURE_RESPONSE_IDENTITY = 'fixture-governed-response-1';

// ── The preload exists and states the incident boundary ─────────────────────
const preloadSource = fs.readFileSync(PRELOAD, 'utf8');
for (const [label, needle] of [
  ['fetch is insufficient', 'Overriding `global.fetch` is NOT sufficient'],
  ['transport uses https.request', 'https.request'],
  ['kill switch', 'UNEXPECTED_EXTERNAL_NETWORK_REQUEST'],
  ['credential guard', 'HERMETIC_VIOLATION']
]) {
  assert.ok(preloadSource.includes(needle),
    `the hermetic preload records: ${label}`);
}
assert.equal(/console\.(log|error)\([^)]*apiKey/i.test(preloadSource), false,
  'the preload never logs a credential');

async function main() {
// ── The injection seam is real and is what production would use ─────────────
{
  const calls = [];
  const transport = createOpenAiGovernedTransport({
    httpsRequest(options, onResponse) {
      calls.push(options);
      const stream = new (require('node:stream').PassThrough)();
      stream.statusCode = 200;
      stream.headers = {};
      const req = {
        on() { return req; }, setTimeout() { return req; }, destroy() { return req; },
        write() { return true; },
        end() {
          setImmediate(() => {
            onResponse(stream);
            stream.end(JSON.stringify({
              id: FIXTURE_RESPONSE_IDENTITY,
              output_text: '{"actions":[],"complete":false}'
            }));
          });
          return req;
        }
      };
      return req;
    }
  });

  const result = await transport({
    endpointIdentity: GOVERNED_OPENAI_ENDPOINT,
    serializedRequest: JSON.stringify({ model: 'm', input: [] }),
    credentials: { apiKey: 'test-only-sentinel' },
    timeoutMs: 5_000,
    maxResponseBytes: 65_536
  });

  assert.equal(calls.length, 1, 'the injected stub received exactly one request');
  assert.equal(calls[0].hostname, 'api.openai.com',
    'the transport still addresses the official host — injection cannot redirect it');
  assert.equal(calls[0].path, '/v1/responses');
  assert.equal(calls[0].method, 'POST');
  assert.ok(calls[0].headers.Authorization,
    'a credential header is formed (its value is never inspected)');
  assert.ok(String(result.text).includes(FIXTURE_RESPONSE_IDENTITY) ||
    String(result.body || '').includes(FIXTURE_RESPONSE_IDENTITY) ||
    JSON.stringify(result).includes(FIXTURE_RESPONSE_IDENTITY),
  'the response is the fixture response, not an uncontrolled external one');
}

// ── The endpoint cannot be redirected ───────────────────────────────────────
{
  const transport = createOpenAiGovernedTransport({
    httpsRequest() { throw new Error('must not be reached'); }
  });
  let refused = null;
  try {
    await transport({
      endpointIdentity: 'https://example.invalid/v1/responses',
      serializedRequest: '{}',
      credentials: { apiKey: 'test-only-sentinel' },
      timeoutMs: 1000,
      maxResponseBytes: 1024
    });
  } catch (error) { refused = error; }
  assert.ok(refused && /refuses endpoint/.test(refused.message),
    'a non-official endpoint is refused before any transport call');
}

// ── A missing credential refuses before transport ───────────────────────────
{
  let reached = false;
  const transport = createOpenAiGovernedTransport({
    httpsRequest() { reached = true; throw new Error('must not be reached'); }
  });
  let refused = null;
  try {
    await transport({
      endpointIdentity: GOVERNED_OPENAI_ENDPOINT,
      serializedRequest: '{}',
      credentials: null,
      timeoutMs: 1000,
      maxResponseBytes: 1024
    });
  } catch (error) { refused = error; }
  assert.ok(refused, 'no credential refuses');
  assert.equal(reached, false, 'and refuses BEFORE any socket work');
}

// ── The kill switch throws for external hosts and permits localhost ─────────
{
  const child = require('node:child_process').spawnSync(process.execPath, [
    '-e',
    `require(${JSON.stringify(PRELOAD)});
     const https = require('node:https');
     let external = null;
     try { https.request({ hostname: 'api.openai.com', path: '/v1/responses' }); }
     catch (e) { external = e.message; }
     let local = 'threw';
     try { const r = http_or_noop(); local = 'allowed'; } catch (e) { local = 'threw:' + e.message; }
     function http_or_noop() {
       const http = require('node:http');
       const req = http.request({ hostname: '127.0.0.1', port: 1, path: '/' });
       req.on('error', () => {});
       req.destroy();
       return req;
     }
     console.log(JSON.stringify({ external, local }));`
  ], {
    encoding: 'utf8',
    env: { ...process.env, OPENAI_API_KEY: '', HERMETIC_TRANSPORT_CAPTURE: '' }
  });
  const out = JSON.parse(String(child.stdout).trim().split('\n').pop());
  assert.match(String(out.external), /UNEXPECTED_EXTERNAL_NETWORK_REQUEST/,
    'the kill switch throws for a real external host');
  assert.equal(out.local, 'allowed',
    'localhost traffic is still permitted, so the harness itself works');
}

// ── The credential guard fires when a key would be inherited ────────────────
{
  const child = require('node:child_process').spawnSync(process.execPath, [
    '-e', `try { require(${JSON.stringify(PRELOAD)}); console.log('LOADED'); }
           catch (e) { console.log('REFUSED:' + e.message); }`
  ], {
    encoding: 'utf8',
    // A non-empty sentinel; its value is meaningless and is never inspected.
    env: { ...process.env, OPENAI_API_KEY: 'x' }
  });
  assert.match(String(child.stdout), /REFUSED:HERMETIC_VIOLATION/,
    'a child that would inherit a credential refuses to start');
}
{
  const child = require('node:child_process').spawnSync(process.execPath, [
    '-e', `try { require(${JSON.stringify(PRELOAD)}); console.log('LOADED'); }
           catch (e) { console.log('REFUSED:' + e.message); }`
  ], { encoding: 'utf8', env: (() => {
    const clean = { ...process.env };
    delete clean.OPENAI_API_KEY;
    return clean;
  })() });
  assert.match(String(child.stdout), /LOADED/,
    'a child with no credential loads normally');
}

  console.log('governed openai transport hermetic test passed');
}

main().catch(error => { console.error(error); process.exit(1); });
