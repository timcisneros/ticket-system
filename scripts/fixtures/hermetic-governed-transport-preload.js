'use strict';

// Test-only hermetic boundary for real-server governed OpenAI tests.
//
// WHY THIS EXISTS. A real-server harness previously stubbed `global.fetch` and
// believed it was offline. The governed OpenAI transport does not use `fetch`:
// `runtime/governed-openai-transport.js` sends bytes with `https.request` to a
// hard-coded `api.openai.com`. The stub therefore intercepted nothing, and the
// spawned server — which inherits `process.env` — could reach the real API with
// a developer credential. Overriding `global.fetch` is NOT sufficient, and this
// file exists so that fact is enforced rather than remembered.
//
// Two independent guarantees, because one is not enough:
//
//   1. INJECTION — the documented `httpsRequest` seam on
//      `createOpenAiGovernedTransport` is bound to a deterministic stub before
//      server.js requires the module. Production source is unchanged; no
//      environment variable can redirect a real request.
//
//   2. KILL SWITCH — Node's real `https.request` and `http.request` throw for
//      any non-localhost host. If injection is ever bypassed, the test fails
//      loudly instead of silently going online.
//
// Credentials are never read or logged here. The harness strips them from the
// child environment; this file only asserts a Boolean.

const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const CAPTURE_PATH = process.env.HERMETIC_TRANSPORT_CAPTURE || null;
const RESPONSE_PATH = process.env.HERMETIC_TRANSPORT_RESPONSE || null;

// The fixture is a BOUNDED SEQUENCE, read fresh each time so a suite can stage
// a multi-request scenario. A file holding one response object still means "one
// response"; `{ responses: [...] }` means the Nth governed request receives the
// Nth entry. There is no wrap-around and no default beyond the end: a request
// the scenario did not plan for is a refusal, never an improvised answer.
function loadFixtureResponses() {
  if (!RESPONSE_PATH) {
    return [{ statusCode: 200, body: JSON.stringify({ output_text: '{}' }) }];
  }
  const parsed = JSON.parse(require('node:fs').readFileSync(RESPONSE_PATH, 'utf8'));
  return Array.isArray(parsed.responses) ? parsed.responses : [parsed];
}

function record(entry) {
  if (!CAPTURE_PATH) return;
  require('node:fs').appendFileSync(CAPTURE_PATH, `${JSON.stringify(entry)}\n`);
}

// ── 1. Inject through the documented seam ───────────────────────────────────
const transportModulePath = path.join(
  __dirname, '..', '..', 'runtime', 'governed-openai-transport.js');
const transportModule = require(transportModulePath);
const realCreate = transportModule.createOpenAiGovernedTransport;

// DIAGNOSTIC ONLY. This counts every call the fixture saw, including refused
// ones, so it can never stand for a Run's request ordinal. It appears in the
// capture record and the x-request-id and decides nothing.
let fixtureRequestCount = 0;

// SERVED STATE MUST SURVIVE A RESTART.
//
// Held only in memory, a restarted server starts again at the first staged
// response — so a scenario that crashes and recovers silently receives its
// FIRST answer a second time. That is indistinguishable from a real agent
// repeating itself: the replayed answer advances no declared fact, the Run is
// correctly blocked for churn, and the scenario appears to prove a recovery
// defect that does not exist. The path is optional; without it the fixture
// keeps its single-process behaviour.
const SERVED_PATH = process.env.HERMETIC_TRANSPORT_SERVED || null;
// Fault-state file shared with the store decorator, so a crash fires once.
const SERVED_STATE = process.env.GOVERNED_FAULT_STATE || null;
const FAULT_STATE = process.env.GOVERNED_FAULT_STATE || null;

function loadServed() {
  if (!SERVED_PATH) return new Set();
  try {
    return new Set(JSON.parse(require('node:fs').readFileSync(SERVED_PATH, 'utf8')));
  } catch (_) {
    return new Set();
  }
}

function saveServed(served) {
  if (!SERVED_PATH) return;
  require('node:fs').writeFileSync(SERVED_PATH, JSON.stringify([...served]));
}

const memoryServed = new Set();
const servedIndexes = {
  has: index => (SERVED_PATH ? loadServed() : memoryServed).has(index),
  add(index) {
    if (!SERVED_PATH) { memoryServed.add(index); return; }
    const served = loadServed();
    served.add(index);
    saveServed(served);
  }
};

function fixtureHttpsRequest(options, onResponse) {
  // A bounded fixture answers only the requests its scenario staged. The worker
  // may legitimately ask again after finishing the last one; refusing keeps an
  // unplanned response out of the run, and the refusal is an expected boundary
  // rather than a failure of the requests that were answered.
  fixtureRequestCount += 1;
  const staged = loadFixtureResponses();
  // The transport spells its options discretely so a test can read back exactly
  // what production sends. Assert the destination here too: a stub that accepts
  // any host would hide a redirect defect rather than catch it.
  if (options.hostname !== 'api.openai.com' || options.path !== '/v1/responses' ||
      options.method !== 'POST') {
    throw new Error(
      `UNEXPECTED_GOVERNED_ENDPOINT ${options.method} ` +
      `${options.hostname}${options.path}`);
  }
  const chunks = [];
  const response = new (require('node:stream').PassThrough)();

  const request = {
    on() { return request; },
    setTimeout() { return request; },
    destroy() { return request; },
    write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      // ADDRESSED BY CONTENT, NOT BY ARRIVAL ORDER.
      //
      // A governed Ticket has sibling leaf Runs, and they execute concurrently
      // against this one fixture. Serving the Nth staged response to the Nth
      // arriving request therefore hands one Run's answer to another, which is
      // a race the scenario never wrote down. A staged response carries a
      // `match` string that must appear in the request bytes, so each Run can
      // only ever receive answers written for it, and a Run the scenario did
      // not stage for is refused rather than improvised at.
      const candidate = staged.find((entry, index) =>
        !servedIndexes.has(index) &&
        (!entry.match || body.includes(entry.match)));
      if (!candidate) {
        throw new Error(
          `HERMETIC_FIXTURE_UNPLANNED_REQUEST_${fixtureRequestCount}: ` +
          'no staged response matches these request bytes');
      }
      // ── BOUNDARIES BELONG TO A REQUEST, NOT TO AN ARRIVAL POSITION ───
      //
      // Crash selection used to compare a process-global arrival counter that
      // advanced even for REFUSED calls. The structured planner's governed
      // request is refused here for want of a staged response and still moved
      // the boundary, so "crash on request 2" could land on the leaf's FIRST
      // request whenever the planner reached the transport first. The scenario
      // then asserted against a state it had not created.
      //
      // A boundary now belongs to the staged response that OWNS the request —
      // the same content ownership that decides which answer it receives — so a
      // call nobody staged for cannot move it.
      const crashState = require('node:fs');
      const alreadyCrashed = path =>
        Boolean(path) && crashState.existsSync(path);

      if (candidate.crashBeforeTransport && !alreadyCrashed(FAULT_STATE)) {
        // Nothing has been sent and nothing is recorded: from production's
        // durable state this is a request that may or may not have left. The
        // staged response is deliberately NOT consumed, so a legitimate retry
        // of the same request can still be answered.
        const detail = 'BOUNDARY_PRE_TRANSPORT_REACHED ' +
          `match=${candidate.match || 'any'}`;
        if (FAULT_STATE) crashState.writeFileSync(FAULT_STATE, detail);
        if (CAPTURE_PATH) {
          crashState.appendFileSync(`${CAPTURE_PATH}.marker`, `${detail}\n`);
        }
        process.exit(70);
      }

      servedIndexes.add(staged.indexOf(candidate));
      response.statusCode = candidate.statusCode || 200;
      response.headers = {
        'x-request-id': `fixture-governed-request-${fixtureRequestCount}`
      };
      // Headers are captured WITHOUT the Authorization value: the test needs to
      // know a credential header was formed, never what it contained.
      record({
        requestOrdinal: fixtureRequestCount,
        hostname: options.hostname,
        path: options.path,
        method: options.method,
        headerNames: Object.keys(options.headers || {}).sort(),
        hasAuthorization: Boolean(options.headers && options.headers.Authorization),
        body
      });
      // ── POST-TRANSPORT CRASH BOUNDARY ─────────────────────────────────
      //
      // The request HAS been received — the capture above proves the test
      // reached this point — and the process dies before the response can be
      // persisted. Production must not use that knowledge: from its durable
      // state this is indistinguishable from the pre-transport case, which is
      // exactly why both must fail closed the same way.
      //
      // Owned by the staged response, for the same reason as above.
      if (candidate.crashAfterTransport && !alreadyCrashed(SERVED_STATE)) {
        const detail = 'BOUNDARY_POST_TRANSPORT_REACHED ' +
          `match=${candidate.match || 'any'}`;
        if (SERVED_STATE) crashState.writeFileSync(SERVED_STATE, detail);
        if (CAPTURE_PATH) {
          crashState.appendFileSync(`${CAPTURE_PATH}.marker`, `${detail}\n`);
        }
        process.exit(71);
      }

      setImmediate(() => {
        onResponse(response);
        response.end(candidate.body);
      });
      return request;
    }
  };
  return request;
}

transportModule.createOpenAiGovernedTransport = function hermeticCreate(options = {}) {
  return realCreate({ ...options, httpsRequest: fixtureHttpsRequest });
};

// ── 2. Kill switch on the real implementations ──────────────────────────────
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);

function guard(realFn, label) {
  return function guarded(...args) {
    const target = args[0];
    const host = typeof target === 'string'
      ? (() => { try { return new URL(target).hostname; } catch (_) { return null; } })()
      : (target && (target.hostname || target.host)) || null;
    const bare = host ? String(host).replace(/:\d+$/, '') : null;
    if (bare && !LOCAL_HOSTS.has(bare)) {
      throw new Error(
        `UNEXPECTED_EXTERNAL_NETWORK_REQUEST via ${label} to ${bare}`);
    }
    return realFn.apply(this, args);
  };
}

https.request = guard(https.request, 'https.request');
https.get = guard(https.get, 'https.get');
http.request = guard(http.request, 'http.request');
http.get = guard(http.get, 'http.get');

// A credential must never reach a hermetic child. Boolean only — the value is
// never read, printed, or recorded.
// The governed transport refuses to build a request without a non-empty key, so
// a hermetic run still needs one — but ONLY this fixed sentinel is tolerated.
// Any other value means a developer credential was inherited and the child
// refuses to start. The comparison is against a constant; the value is never
// read for any other purpose, printed, or recorded.
const HERMETIC_SENTINEL_KEY = 'test-only-sentinel-not-a-real-credential';
if (process.env.OPENAI_API_KEY &&
    process.env.OPENAI_API_KEY !== HERMETIC_SENTINEL_KEY) {
  throw new Error(
    'HERMETIC_VIOLATION: the test server inherited a non-sentinel OPENAI_API_KEY');
}
// Proof-of-life the spawned server can be asserted on: if this line is absent
// from server output, the preload did not run and nothing here is protecting it.
console.log('HERMETIC_PRELOAD_ACTIVE=true');
