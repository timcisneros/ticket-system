#!/usr/bin/env node
'use strict';

// Tranche 4 direct proof for runtime/governed-openai-transport.
//
// The removed Ollama HTTP scenario was never a test of this route. This suite
// tests the production transport itself by substituting `https.request` — the
// Node function, not a URL — so every option, header and byte the module
// produces is observable. The host and path remain constants inside the module
// and are asserted here; nothing injected can redirect them.
//
// No network, no credentials, no provider.

// Set BEFORE the module is required. The host and path are module-load
// constants, so an edit that computed either from the environment would be
// baked in at require time and invisible to any assertion made afterwards.
const HOST_ENV_VARS = ['OPENAI_HOST', 'OPENAI_BASE_URL', 'OPENAI_API_BASE', 'OPENAI_API_HOST'];
const PRIOR_HOST_ENV = HOST_ENV_VARS.map(name => [name, process.env[name]]);
for (const name of HOST_ENV_VARS) process.env[name] = 'evil.example';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const {
  GOVERNED_OPENAI_ENDPOINT,
  GOVERNED_OPENAI_HOSTNAME,
  GOVERNED_OPENAI_PATH,
  createOpenAiGovernedTransport
} = require('../runtime/governed-openai-transport');

const MAX_RESPONSE_BYTES = 65_536;
const BYTES = JSON.stringify({
  model: 'gpt-4o-mini-2024-07-18',
  input: [{ role: 'user', content: 'héllo — multibyte' }],
  max_output_tokens: 2_048,
  truncation: 'disabled'
});

// A fake `https.request`. It records the options and the written bytes, and
// drives the response the test wants.
function fakeHttps({ chunks = ['{"output_text":"{}"}'], statusCode = 200,
  emitTimeout = false, emitError = null } = {}) {
  const seen = { options: null, written: [], destroyed: null, ended: false };
  const factory = (options, onResponse) => {
    seen.options = options;
    const request = new EventEmitter();
    request.end = payload => {
      seen.written.push(payload);
      seen.ended = true;
      if (emitError) { setImmediate(() => request.emit('error', emitError)); return; }
      if (emitTimeout) { setImmediate(() => request.emit('timeout')); return; }
      const response = new EventEmitter();
      response.statusCode = statusCode;
      response.destroy = () => { seen.responseDestroyed = true; };
      setImmediate(() => {
        onResponse(response);
        for (const chunk of chunks) response.emit('data', Buffer.from(chunk, 'utf8'));
        response.emit('end');
      });
      return request;
    };
    request.destroy = error => { seen.destroyed = error; request.emit('error', error); };
    return request;
  };
  factory.seen = seen;
  return factory;
}

function callWith(https, overrides = {}) {
  const transport = createOpenAiGovernedTransport({ httpsRequest: https });
  return transport({
    endpointIdentity: GOVERNED_OPENAI_ENDPOINT,
    serializedRequest: BYTES,
    credentials: { apiKey: 'fixture-key' },
    timeoutMs: 60_000,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    ...overrides
  });
}

async function main() {
  // ── Fixed host, path, method ─────────────────────────────────────────────

  const https = fakeHttps();
  const result = await callWith(https);
  const options = https.seen.options;

  assert.equal(options.hostname, 'api.openai.com', 'the fixed official hostname is used');
  assert.equal(options.hostname, GOVERNED_OPENAI_HOSTNAME);
  assert.equal(options.path, '/v1/responses', 'the governed Responses path is used');
  assert.equal(options.path, GOVERNED_OPENAI_PATH);
  assert.equal(options.method, 'POST');
  assert.equal(options.protocol, 'https:');
  assert.equal(options.port, 443);

  // ── Headers ──────────────────────────────────────────────────────────────

  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.equal(options.headers.Authorization, 'Bearer fixture-key',
    'authorization comes only from the separately resolved credential');
  assert.equal(options.headers['Content-Length'], Buffer.byteLength(BYTES, 'utf8'),
    'content length is the exact persisted UTF-8 byte length');
  // The body is multibyte, so a character count would differ from a byte count.
  assert.notEqual(BYTES.length, Buffer.byteLength(BYTES, 'utf8'),
    'the fixture is genuinely multibyte, so this distinguishes bytes from characters');

  // ── Exact bytes ──────────────────────────────────────────────────────────

  assert.equal(https.seen.written.length, 1, 'the body is written exactly once');
  assert.ok(Buffer.isBuffer(https.seen.written[0]), 'the body is written as bytes');
  assert.equal(https.seen.written[0].toString('utf8'), BYTES,
    'the exact persisted bytes are written');
  assert.equal(https.seen.written[0].byteLength, options.headers['Content-Length'],
    'the declared length equals the written length');

  // ── The module holds no route knobs ──────────────────────────────────────

  const source = fs.readFileSync(
    path.join(__dirname, '..', 'runtime', 'governed-openai-transport.js'), 'utf8');
  assert.equal(/JSON\.stringify/.test(source), false,
    'the transport never serializes anything');
  for (const knob of ['OPENAI_BASE_URL', 'OPENAI_API_BASE', 'baseUrl', 'OPENAI_MODEL',
    'max_output_tokens', 'truncation']) {
    assert.equal(source.includes(knob), false,
      `the transport has no ${knob} it could apply or override`);
  }
  // Its request signature accepts no model, body object, cap or route.
  const signature = source.slice(source.indexOf('return async function openAiGovernedTransport({'),
    source.indexOf('}) {', source.indexOf('return async function openAiGovernedTransport({')));
  for (const forbidden of ['model', 'body', 'canonicalBody', 'maxOutputTokens', 'route']) {
    assert.equal(new RegExp(`\\b${forbidden}\\b`).test(signature), false,
      `the transport accepts no ${forbidden} parameter`);
  }

  // A captured request naming another endpoint refuses rather than being sent.
  const redirected = fakeHttps();
  await assert.rejects(
    () => callWith(redirected, { endpointIdentity: 'https://evil.example/v1/responses' }),
    /refuses endpoint/,
    'a non-official endpoint identity refuses');
  assert.equal(redirected.seen.options, null, 'a refused endpoint opens no request');

  // Credentials cannot redirect anything.
  const credentialAttack = fakeHttps();
  await callWith(credentialAttack, {
    credentials: {
      apiKey: 'k', hostname: 'evil.example', path: '/x',
      model: 'gpt-other', baseUrl: 'https://evil.example'
    }
  });
  assert.equal(credentialAttack.seen.options.hostname, GOVERNED_OPENAI_HOSTNAME,
    'a credential object cannot redirect the host');
  assert.equal(credentialAttack.seen.options.path, GOVERNED_OPENAI_PATH,
    'a credential object cannot redirect the path');
  assert.equal(credentialAttack.seen.written[0].toString('utf8'), BYTES,
    'a credential object cannot alter the request bytes');

  // Those host variables were already polluted before the require above, so
  // the literal assertions at the top of this suite already prove that neither
  // the host nor the path was computed from the environment at load time.
  assert.equal(GOVERNED_OPENAI_HOSTNAME, 'api.openai.com',
    'the host constant is a literal, not an environment read');
  assert.equal(GOVERNED_OPENAI_PATH, '/v1/responses',
    'the path constant is a literal, not an environment read');
  const envHost = fakeHttps();
  await callWith(envHost);
  assert.equal(envHost.seen.options.hostname, 'api.openai.com',
    'no environment variable can redirect the governed host');
  assert.equal(envHost.seen.options.path, '/v1/responses',
    'no environment variable can redirect the governed path');
  for (const [name, value] of PRIOR_HOST_ENV) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  // Environment model drift cannot influence the request.
  const priorModel = process.env.OPENAI_MODEL;
  process.env.OPENAI_MODEL = 'gpt-env-override';
  const envHttps = fakeHttps();
  await callWith(envHttps);
  assert.equal(envHttps.seen.written[0].toString('utf8'), BYTES,
    'an environment model default cannot influence the request');
  if (priorModel === undefined) delete process.env.OPENAI_MODEL;
  else process.env.OPENAI_MODEL = priorModel;

  // Missing credentials refuse before a request is opened.
  const noCredential = fakeHttps();
  await assert.rejects(() => callWith(noCredential, { credentials: null }),
    /no OpenAI credential/, 'a missing credential refuses');
  assert.equal(noCredential.seen.options, null, 'a missing credential opens no request');

  // ── Response handling ────────────────────────────────────────────────────

  assert.equal(result.text, '{}', 'the model text is extracted');

  const withUsage = await callWith(fakeHttps({
    chunks: ['{"output_text":"{}","usage":{"input_tokens":5,"output_tokens":7},"id":"resp_1"}']
  }));
  assert.deepEqual(withUsage.usage, { input_tokens: 5, output_tokens: 7 },
    'usage is passed through uninterpreted');
  assert.equal(withUsage.identity, 'resp_1');

  const empty = await callWith(fakeHttps({ chunks: ['{"output_text":""}'] }));
  assert.equal(empty.text, '', 'an empty response yields empty text for the caller to refuse');

  await assert.rejects(() => callWith(fakeHttps({ chunks: ['not json at all'] })),
    /not valid JSON/,
    'a malformed body refuses instead of being handed on as a proposal');

  for (const statusCode of [400, 401, 429, 500, 503]) {
    await assert.rejects(
      () => callWith(fakeHttps({ statusCode, chunks: ['{"error":"nope"}'] })),
      new RegExp(`status ${statusCode}`),
      `HTTP ${statusCode} is classified truthfully as a failure`);
  }

  // ── The 65,536-byte bound aborts before unbounded buffering ──────────────

  const oversized = fakeHttps({
    chunks: ['x'.repeat(40_000), 'y'.repeat(40_000), 'z'.repeat(40_000)]
  });
  await assert.rejects(() => callWith(oversized),
    error => {
      assert.equal(error.responseTooLarge, true, 'the overflow is classified');
      assert.match(error.message, /exceeded 65536 bytes/);
      return true;
    },
    'an oversized response refuses');
  assert.equal(oversized.seen.responseDestroyed, true,
    'the response is destroyed rather than buffered to completion');

  // Exactly at the bound is accepted.
  const atBound = await callWith(fakeHttps({
    chunks: [`{"output_text":"${'a'.repeat(MAX_RESPONSE_BYTES - 20)}"}`]
  }));
  assert.ok(atBound.text.length > 0, 'a response within the bound is accepted');

  // ── Timeout aborts ───────────────────────────────────────────────────────

  const timedOut = fakeHttps({ emitTimeout: true });
  await assert.rejects(() => callWith(timedOut),
    error => {
      assert.equal(error.name, 'AbortError', 'a timeout aborts rather than hanging');
      return true;
    },
    'a timeout is surfaced as an abort');
  assert.ok(timedOut.seen.destroyed, 'the request socket is destroyed on timeout');
  assert.equal(https.seen.options.timeout, 60_000, 'the caller timeout is applied');

  // Transport errors propagate.
  await assert.rejects(
    () => callWith(fakeHttps({ emitError: new Error('connection reset') })),
    /connection reset/,
    'a socket error propagates truthfully');

  finished = true;
  console.log('governed OpenAI transport test passed');
}

// A promise that never settles lets Node drain its event loop and exit 0, which
// would report an unfinished suite as a passing one. This makes silent
// non-completion a failure.
let finished = false;
process.on('exit', code => {
  if (code === 0 && !finished) {
    console.error('governed OpenAI transport test did not run to completion');
    process.exitCode = 1;
  }
});

main().catch(error => {
  console.error(error);
  process.exit(1);
});
