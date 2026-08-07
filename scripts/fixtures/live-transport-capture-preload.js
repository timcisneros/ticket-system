'use strict';

// Tranche 6 — TEST-ONLY capture at the FINAL NETWORK BOUNDARY.
//
// WHAT MAKES THIS DIFFERENT FROM THE HERMETIC EVALUATION FIXTURE. The hermetic
// preload replaces the provider *fixture* layer: it selects a staged response by
// matching request bytes, so a test that passes under it proves the fixture
// table was consulted — not that production would have sent anything.
//
// This preload replaces ONLY the last hop. Everything upstream is the real
// thing: real manifest, real trial construction, real role routing, real
// economic admission, real adapter selection, real request-body construction.
// The outbound bytes recorded here are the exact bytes production would have
// put on the wire.
//
// WHY IT ANSWERS BY ROLE. The first version returned one generic worker-shaped
// payload to every request. A planner that receives a worker answer emits no
// valid proposal, so no plan is admitted, no leaf Run is created, and the
// governed leaf executor is never reached — which is precisely how an earlier
// readiness verdict came to rest on two captured requests while claiming three
// roles. Answering in the shape the REQUEST ITSELF asks for is what lets the
// real chain run to its end:
//
//   planner request -> valid proposal -> plan admitted -> leaf Run admitted
//   -> governed leaf executor request -> captured here too.
//
// Selection is by REQUEST CONTENT — the planner contract's own system prompt and
// the candidate list carried in the request. It never branches on an arm label,
// because branching on the arm would force the path the test is supposed to
// observe.
//
// It exists so a live dispatch path can be proved WITHOUT spending money or
// touching a network, and it is loaded only by tests.

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

const CAPTURE_PATH = process.env.LIVE_TRANSPORT_CAPTURE || null;
// Attribution. A recorded request that names no trial cannot be reconciled
// against the ledger entry that authorized it.
const TRIAL_ID = process.env.LIVE_TRANSPORT_CAPTURE_TRIAL_ID || null;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

// The planner contract's own opening line. Matching the contract text is what
// makes this role detection rather than guesswork.
const PLANNER_MARKER = 'You are an allocation planner';

function record(entry) {
  if (!CAPTURE_PATH) return;
  fs.appendFileSync(CAPTURE_PATH, `${JSON.stringify({ trialId: TRIAL_ID, ...entry })}\n`);
}

// ── Role detection, from the request itself ─────────────────────────────────

function requestMessages(body) {
  try {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed.input) ? parsed.input : [];
  } catch (_) { return []; }
}

function isPlannerRequest(body) {
  return requestMessages(body).some(message =>
    typeof message.content === 'string' && message.content.includes(PLANNER_MARKER));
}

// The planning context is the user message: canonical JSON carrying the real
// candidate agents and their owned paths.
function plannerContext(body) {
  for (const message of requestMessages(body)) {
    if (message.role !== 'user' || typeof message.content !== 'string') continue;
    try {
      const parsed = JSON.parse(message.content);
      if (Array.isArray(parsed.candidates)) return parsed;
    } catch (_) { /* not the context message */ }
  }
  return null;
}

// ── The answers ─────────────────────────────────────────────────────────────

// A MINIMUM VALID v2 PROPOSAL, built from the request's OWN candidates. Every
// captured candidate is assigned exactly once — the contract refuses a proposal
// that omits one — and each objective names a distinct folder inside that
// agent's own allocated path, so the item carries an execution-evaluable
// declared fact and the leaf is admissible.
function plannerProposal(body) {
  const context = plannerContext(body);
  const candidates = context ? context.candidates : [];
  const items = candidates.map((candidate, index) => {
    const owned = Array.isArray(candidate.ownedOutputPaths) && candidate.ownedOutputPaths[0]
      ? String(candidate.ownedOutputPaths[0]).replace(/\/+$/, '')
      : `reports/agent-${index}`;
    const folder = `${owned}/out`;
    return {
      assignedAgentId: candidate.agentId,
      objective: `Create the folder ${folder} holding this agent's allocated output`,
      expectedOutputs: [{ kind: 'text', declaration: `The folder ${folder}` }],
      successCriteria: [{ kind: 'text', declaration: `The folder ${folder} exists` }],
      evidenceRequirements: []
    };
  });
  return JSON.stringify({
    version: 1,
    sharedConstraints: [
      { kind: 'text', declaration: 'Write only inside your own allocated path' }
    ],
    items
  });
}

// A worker answer that does real declared work: it creates the folder its own
// objective names, so the leaf executor's normal parse, persistence and
// completion path runs to its end rather than short-circuiting on a refusal.
function workerAnswer(body) {
  const text = requestMessages(body).map(message =>
    (typeof message.content === 'string' ? message.content : '')).join('\n');
  const match = text.match(/Create the folder ([^\s,"']+)/);
  const folder = match ? match[1] : null;
  return JSON.stringify(folder
    ? {
      message: `Creating ${folder}.`,
      actions: [{ type: 'create_folder', path: folder }],
      complete: true
    }
    : { message: 'No declared folder in this objective.', actions: [], complete: true });
}

let ordinal = 0;

function responsePayload(body, transport) {
  ordinal += 1;
  const planner = isPlannerRequest(body);
  const identity = `captured-${transport}-${planner ? 'planner' : 'worker'}-${ordinal}`;
  return {
    identity,
    role: planner ? 'planner' : 'worker',
    payload: JSON.stringify({
      id: identity,
      output_text: planner ? plannerProposal(body) : workerAnswer(body),
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }
    })
  };
}

// ── 1. The governed boundary: https.request ─────────────────────────────────
const realHttpsRequest = https.request;

https.request = function capturedHttpsRequest(options, onResponse) {
  const hostname = typeof options === 'string'
    ? new URL(options).hostname : options.hostname || options.host;
  if (LOCAL_HOSTS.has(String(hostname).replace(/:\d+$/, ''))) {
    return realHttpsRequest.apply(this, arguments);
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
      const answer = responsePayload(body, 'governed');
      // THE EXACT OUTBOUND BYTES production would have sent.
      record({
        boundary: 'https.request',
        transport: 'governed',
        role: answer.role,
        hostname,
        path: options.path,
        method: options.method,
        headerNames: Object.keys(options.headers || {}).sort(),
        hasAuthorization: Boolean(options.headers && options.headers.Authorization),
        body,
        at: Date.now()
      });
      response.statusCode = 200;
      response.headers = { 'x-request-id': answer.identity };
      onResponse(response);
      response.end(answer.payload);
      return request;
    }
  };
  return request;
};

// ── 2. The ungoverned boundary: global fetch ────────────────────────────────
const realFetch = globalThis.fetch;
globalThis.fetch = async function capturedFetch(input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  let hostname = null;
  try { hostname = new URL(url).hostname; } catch (_) { hostname = null; }
  if (hostname && LOCAL_HOSTS.has(hostname)) return realFetch.call(this, input, init);

  const body = init && typeof init.body === 'string' ? init.body : '';
  const answer = responsePayload(body, 'ungoverned');
  record({
    boundary: 'fetch',
    transport: 'ungoverned',
    role: answer.role,
    hostname,
    url,
    method: (init && init.method) || 'GET',
    headerNames: Object.keys((init && init.headers) || {}).sort(),
    hasAuthorization: Boolean(init && init.headers &&
      (init.headers.Authorization || init.headers.authorization)),
    body,
    at: Date.now()
  });
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {
      get: name => (name.toLowerCase() === 'x-request-id' ? answer.identity : null)
    },
    async text() { return answer.payload; },
    async json() { return JSON.parse(answer.payload); }
  };
};

// ── 3. Nothing else may reach a network ─────────────────────────────────────
//
// http.request is not a provider boundary here, and a non-local call through it
// would mean a request escaped the two boundaries above.
const realHttpRequest = http.request;
http.request = function guardedHttpRequest(options, ...rest) {
  const hostname = typeof options === 'string'
    ? new URL(options).hostname : options.hostname || options.host;
  if (!LOCAL_HOSTS.has(String(hostname).replace(/:\d+$/, ''))) {
    throw new Error(`LIVE_CAPTURE_ESCAPE http.request to ${hostname}`);
  }
  return realHttpRequest.call(this, options, ...rest);
};

console.log('LIVE_TRANSPORT_CAPTURE_ACTIVE');
