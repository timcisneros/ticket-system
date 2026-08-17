'use strict';

// Tranche 6 — TEST-ONLY observation of the REAL uncaptured provider boundary.
//
// WHY THIS IS NOT THE FINAL-HOP CAPTURE. `live-transport-capture-preload`
// answers requests with synthetic responses, and the runner treats its presence
// as "captured live", which switches the spawned server to a sentinel
// credential. Both of those are exactly what hid the ungoverned defect: three
// arms could reach a replaced transport under a sentinel and never exercise the
// configuration a real run uses.
//
// This preload changes NOTHING about the branch under test. The server still
// takes the real uncaptured live path, with the real credential resolution, the
// real provider selection and the real request builder. At the last possible
// moment — the outbound call itself — it records what would have gone on the
// wire and then REFUSES, so no byte leaves the machine and no response is
// invented for the product to consume.
//
// A test asserts on the recorded request. The trial that produced it will fail
// afterwards, and that is correct: the point is to prove the boundary was
// REACHED with the right controls, not to let the product continue on a
// fabricated answer.

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { PassThrough } = require('node:stream');

const OBSERVATION_PATH = process.env.LIVE_PROVIDER_BOUNDARY_OBSERVATION || null;
// OPTIONAL REAL-SHAPED RESPONSE. When set, the boundary answers with a
// controlled response in the ACTUAL provider envelope — output[].content[] with
// type output_text — instead of refusing. Everything downstream stays
// production: extraction, parsing, action validation, workspace execution,
// receipts, terminalization. The old final-hop capture cannot serve this
// purpose because it answers with a top-level `output_text` the real API never
// returns, so it never exercised real-envelope handling.
//
// ── THE RESPONSE SPEC ───────────────────────────────────────────────────────
//
// The file is a JSON SPEC, never raw model text, so that what the boundary
// answers is always declared rather than inferred:
//
//   { "kind": "literal", "text": "<the exact model text>" }
//
//     Answers every request with those exact bytes. Used where the response
//     must be fixed regardless of who asked — an over-limit batch, for
//     instance, is refused before any path is looked at.
//
//   { "kind": "one-action-createFolder-by-owned-root",
//     "message": "...", "complete": true,
//     "byOwnedRoot": { "<ownedOutputPaths[0] or empty>": "<target path>" } }
//
//     Answers with ONE canonical createFolder action, selecting the target from
//     the request's OWN runtime envelope. The mapping lives in the calling test
//     rather than here: which folder each allocated agent should produce is
//     knowledge about the scenario, not about the transport boundary. Selection
//     reads the request and never an arm label, so it cannot force a path.
const RESPONSE_PATH = process.env.LIVE_PROVIDER_BOUNDARY_RESPONSE || null;
const PLANNER_MARKER = 'You are an allocation planner';

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

function plannerContext(body) {
  for (const message of requestMessages(body)) {
    if (message.role !== 'user' || typeof message.content !== 'string') continue;
    try {
      const parsed = JSON.parse(message.content);
      if (Array.isArray(parsed.candidates)) return parsed;
    } catch (_) { /* not the planning context */ }
  }
  return null;
}

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

function objectiveFolderAnswer(body) {
  const text = requestMessages(body).map(message =>
    (typeof message.content === 'string' ? message.content : '')).join('\n');
  const match = text.match(/Create folders ([^\s,"']+) and ([^\s,"']+)/i);
  const folders = match ? [match[1], match[2]] : [];
  return JSON.stringify({
    message: folders.length === 2 ? 'Creating both declared folders.' : 'Objective unavailable.',
    actions: folders.map(folder => ({ operation: 'createFolder', args: { path: folder } })),
    complete: folders.length === 2
  });
}

function workerInspectionAnswer(body) {
  const envelope = runtimeEnvelopeOf(body) || {};
  const owned = Array.isArray(envelope.ownedOutputPaths) && envelope.ownedOutputPaths[0]
    ? envelope.ownedOutputPaths[0] : '';
  return JSON.stringify({
    message: 'Inspecting the controlled owned path without advancing a fact.',
    actions: [{ operation: 'listDirectory', args: { path: owned } }],
    complete: false
  });
}

function ownedRootOf(body) {
  const envelope = runtimeEnvelopeOf(body) || {};
  return Array.isArray(envelope.ownedOutputPaths) && envelope.ownedOutputPaths[0]
    ? String(envelope.ownedOutputPaths[0]) : '';
}

function sameOwnedRoot(left, right) {
  return String(left || '').replace(/\/+$/, '') === String(right || '').replace(/\/+$/, '');
}

let terminalFailureOwnedRoot = null;
let terminalBlockingOwnedRoot = null;

function controlledSiblingReadAnswer() {
  return JSON.stringify({
    message: 'Independently exercising the declared sibling-read authority boundary.',
    actions: [{ operation: 'listDirectory', args: { path: terminalFailureOwnedRoot } }],
    complete: false
  });
}

function terminalMemberBeforeProgressBlockAnswer(body, spec) {
  if (isPlannerRequest(body)) return plannerProposal(body);
  const owned = ownedRootOf(body);
  if (sameOwnedRoot(owned, terminalFailureOwnedRoot)) {
    return JSON.stringify({
      message: 'Attempting one independently controlled out-of-scope mutation.',
      actions: [{ operation: 'createFolder', args: { path: spec.failureTarget } }],
      complete: true
    });
  }
  if (sameOwnedRoot(owned, terminalBlockingOwnedRoot)) {
    return controlledSiblingReadAnswer();
  }
  return workerAnswer(body);
}

function responseGateFor(body) {
  const spec = responseSpec();
  if (spec.kind !== 'role-aware-terminal-member-before-progress-block' || isPlannerRequest(body)) {
    return null;
  }
  if (terminalFailureOwnedRoot === null) {
    terminalFailureOwnedRoot = ownedRootOf(body);
    return null;
  }
  if (sameOwnedRoot(ownedRootOf(body), terminalFailureOwnedRoot)) return null;
  if (terminalBlockingOwnedRoot === null) terminalBlockingOwnedRoot = ownedRootOf(body);
  return spec.gatePath;
}

function afterResponseGate(gatePath, callback) {
  if (!gatePath || fs.existsSync(gatePath)) {
    queueMicrotask(callback);
    return;
  }
  fs.watchFile(gatePath, { interval: 5 }, () => {
    if (!fs.existsSync(gatePath)) return;
    fs.unwatchFile(gatePath);
    callback();
  });
}

function responseSpec() {
  return JSON.parse(fs.readFileSync(RESPONSE_PATH, 'utf8'));
}

// The runtime envelope this request carried. It is the production message the
// worker prompt is built from, so reading it is reading the request itself.
function runtimeEnvelopeOf(body) {
  for (const message of requestMessages(body)) {
    if (typeof message.content !== 'string') continue;
    try {
      const parsed = JSON.parse(message.content);
      if (parsed && parsed.runtimeEnvelope) return parsed.runtimeEnvelope;
    } catch (_) { /* not the envelope message */ }
  }
  return null;
}

function modelTextFor(body) {
  const spec = responseSpec();
  if (spec.kind === 'literal') return spec.text;
  if (spec.kind === 'objective-folders') return objectiveFolderAnswer(body);
  if (spec.kind === 'role-aware-structured-success') {
    return isPlannerRequest(body) ? plannerProposal(body) : workerAnswer(body);
  }
  if (spec.kind === 'role-aware-planner-success-worker-hang') {
    return isPlannerRequest(body) ? plannerProposal(body) : workerAnswer(body);
  }
  if (spec.kind === 'role-aware-structured-inspection') {
    return isPlannerRequest(body) ? plannerProposal(body) : workerInspectionAnswer(body);
  }
  if (spec.kind === 'role-aware-structured-no-evidence-completion') {
    return isPlannerRequest(body) ? plannerProposal(body) : JSON.stringify({
      message: 'Claiming completion without producing the declared output.',
      actions: [],
      complete: true
    });
  }
  if (spec.kind === 'role-aware-terminal-member-before-progress-block') {
    return terminalMemberBeforeProgressBlockAnswer(body, spec);
  }
  if (spec.kind === 'one-action-createFolder-by-owned-root') {
    const envelope = runtimeEnvelopeOf(body) || {};
    const owned = Array.isArray(envelope.ownedOutputPaths) && envelope.ownedOutputPaths[0]
      ? String(envelope.ownedOutputPaths[0])
      : '';
    const target = spec.byOwnedRoot[owned];
    if (!target) {
      throw new Error(
        `LIVE_PROVIDER_BOUNDARY_RESPONSE has no target for owned root ${JSON.stringify(owned)}`);
    }
    return JSON.stringify({
      message: spec.message,
      // THE CANONICAL ACTION SHAPE production accepts: `operation` plus `args`.
      actions: [{ operation: 'createFolder', args: { path: target } }],
      complete: spec.complete === true
    });
  }
  throw new Error(`unsupported boundary response kind: ${String(spec.kind)}`);
}

function shouldHang(body) {
  const kind = responseSpec().kind;
  return kind === 'hang' ||
    (kind === 'role-aware-planner-success-worker-hang' && !isPlannerRequest(body));
}

function realShapedResponse(body) {
  const spec = responseSpec();
  if (spec.kind === 'provider-refusal') {
    return JSON.stringify({
      id: 'resp_boundary_controlled_refusal',
      object: 'response',
      status: 'completed',
      model: 'gpt-4o-mini-2024-07-18',
      output: [{
        type: 'message', role: 'assistant',
        content: [{ type: 'refusal', refusal: 'Controlled provider refusal.' }]
      }],
      usage: { input_tokens: 1737, output_tokens: 7, total_tokens: 1744 }
    });
  }
  return JSON.stringify({
    id: 'resp_boundary_controlled',
    object: 'response',
    status: 'completed',
    model: 'gpt-4o-mini-2024-07-18',
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: modelTextFor(body) }]
    }],
    usage: { input_tokens: 1737, output_tokens: 77, total_tokens: 1814 }
  });
}

function authorizationHeader(headers) {
  if (!headers || typeof headers !== 'object') return null;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'authorization') return String(value);
  }
  return null;
}

function authorizationMatchesProjectedCredential(headers) {
  const projected = process.env.OPENAI_API_KEY;
  return typeof projected === 'string' && projected.length > 0 &&
    authorizationHeader(headers) === `Bearer ${projected}`;
}

function observedRole(body, transport) {
  if (isPlannerRequest(body)) return 'structured_planner';
  return transport === 'governed' ? 'governed_leaf_worker' : 'ungoverned_worker';
}
// TEST-ONLY: a failure at the exact point the durable transport observation is
// written, so a suite can prove that an observation which does not land changes
// nothing about the provider request it was observing. One owner, shared with
// the final-hop capture preload.
require('./transport-observation-fault').armTransportObservationFaultIfRequested();

const TRIAL_ID = process.env.LIVE_PROVIDER_BOUNDARY_TRIAL_ID || null;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

const BOUNDARY_REFUSAL = 'LIVE_PROVIDER_BOUNDARY_OBSERVED_NO_NETWORK';

function record(entry) {
  if (!OBSERVATION_PATH) return;
  fs.appendFileSync(OBSERVATION_PATH,
    `${JSON.stringify({ trialId: TRIAL_ID, ...entry, at: Date.now() })}\n`);
}

function isLocal(hostname) {
  return LOCAL_HOSTS.has(String(hostname).replace(/:\d+$/, ''));
}

// ── The ungoverned boundary: global fetch ───────────────────────────────────
const realFetch = globalThis.fetch;
globalThis.fetch = async function observedFetch(input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  let hostname = null;
  try { hostname = new URL(url).hostname; } catch (_) { hostname = null; }
  if (hostname && isLocal(hostname)) return realFetch.call(this, input, init);

  const headers = (init && init.headers) || {};
  const body = init && typeof init.body === 'string' ? init.body : '';
  record({
    boundary: 'fetch',
    transport: 'ungoverned',
    url,
    hostname,
    method: (init && init.method) || 'GET',
    headerNames: Object.keys(headers).sort(),
    // PRESENCE ONLY. The value is never recorded.
    hasAuthorization: Boolean(headers.Authorization || headers.authorization),
    authorizationMatchesProjectedCredential:
      authorizationMatchesProjectedCredential(headers),
    role: observedRole(body, 'ungoverned'),
    body
  });
  if (RESPONSE_PATH) {
    if (shouldHang(body)) return new Promise((resolve, reject) => {
      void resolve;
      const abort = () => {
        const error = new Error('controlled provider boundary aborted');
        error.name = 'AbortError';
        reject(error);
      };
      if (init && init.signal) {
        if (init.signal.aborted) abort();
        else init.signal.addEventListener('abort', abort, { once: true });
      }
    });
    return new Promise(resolve => afterResponseGate(responseGateFor(body), () => {
      const payload = realShapedResponse(body);
      // The real platform Response, for the same reason: production consumes
      // more of this interface than a hand-written stub tends to provide.
      resolve(new Response(payload, {
        status: 200,
        statusText: 'OK',
        headers: {
          'x-request-id': 'req_boundary_controlled',
          'content-type': 'application/json'
        }
      }));
    }));
  }
  // STOP BEFORE THE NETWORK. No response is synthesized: the product must not
  // continue on an answer this seam invented.
  const error = new Error(BOUNDARY_REFUSAL);
  error.code = BOUNDARY_REFUSAL;
  throw error;
};

// ── The governed boundary: https.request ────────────────────────────────────
const realHttpsRequest = https.request;
https.request = function observedHttpsRequest(options, onResponse) {
  const hostname = typeof options === 'string'
    ? new URL(options).hostname : options.hostname || options.host;
  if (isLocal(hostname)) return realHttpsRequest.apply(this, arguments);

  const chunks = [];
  const response = new PassThrough();
  const listeners = new Map();
  const request = {
    on(name, listener) { listeners.set(name, listener); return request; },
    setTimeout() { return request; },
    destroy(error = null) {
      const listener = listeners.get('error');
      if (listener) queueMicrotask(() => listener(error ||
        new Error('controlled provider boundary destroyed')));
      return request;
    },
    write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      record({
        boundary: 'https.request',
        transport: 'governed',
        hostname,
        path: options.path,
        method: options.method,
        headerNames: Object.keys(options.headers || {}).sort(),
        hasAuthorization: Boolean(options.headers && options.headers.Authorization),
        authorizationMatchesProjectedCredential:
          authorizationMatchesProjectedCredential(options.headers || {}),
        role: observedRole(body, 'governed'),
        body
      });
      if (RESPONSE_PATH) {
        if (shouldHang(body)) return request;
        afterResponseGate(responseGateFor(body), () => {
          response.statusCode = 200;
          response.headers = {
            'x-request-id': 'req_boundary_controlled',
            'content-type': 'application/json'
          };
          onResponse(response);
          response.end(realShapedResponse(body));
        });
        return request;
      }
      const error = new Error(BOUNDARY_REFUSAL);
      error.code = BOUNDARY_REFUSAL;
      throw error;
    }
  };
  return request;
};

// Nothing may escape by a third route.
const realHttpRequest = http.request;
http.request = function guardedHttpRequest(options, ...rest) {
  const hostname = typeof options === 'string'
    ? new URL(options).hostname : options.hostname || options.host;
  if (!isLocal(hostname)) {
    throw new Error(`LIVE_BOUNDARY_ESCAPE http.request to ${hostname}`);
  }
  return realHttpRequest.call(this, options, ...rest);
};

console.log('LIVE_PROVIDER_BOUNDARY_OBSERVER_ACTIVE');
