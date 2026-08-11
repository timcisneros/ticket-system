#!/usr/bin/env node
'use strict';

// Tranche 2B live provider-path proof.
//
// The PostgreSQL admission suite deliberately contacts no provider: it drives
// the admission transaction directly. This suite proves the OTHER half — that
// the real server orchestration, end to end through `POST /tickets`, issues
// exactly one bounded provider request and admits one Allocation Plan v2 with
// zero worker Runs.
//
// The provider is a local HTTP stub bound to 127.0.0.1, reached through the
// existing configured-agent seam: an `ollama` agent carries a `baseUrl`, and
// `getAgentOllamaConfig` reads it. Nothing in production is stubbed, monkey
// patched, or branched on a test flag — the server makes a genuine HTTP request
// through `callOllama` and `providerHttpJsonRequest`.

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { withHarness } = require('./postgres-test-harness');
const {
  MAX_PLANNER_RESPONSE_BYTES
} = require('../runtime/structured-allocation-planning-contract');
const {
  normalizeLeafRunBinding
} = require('../runtime/structured-allocation-leaf-run-contract');

const STAMP = `${Date.now()}-${process.pid}`;
const ACTOR = 'structured-allocation-planner-provider-test';

// A local stand-in for an Ollama server. It records every request it receives,
// so "exactly one request" and "the snapshotted model was used" are observed
// facts rather than inferences.
function createProviderStub() {
  const requests = [];
  let responder = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (_) {
        body = null;
      }
      requests.push({ url: req.url, method: req.method, headers: req.headers, body });
      responder(req, res, body);
    });
  });
  return {
    server,
    requests,
    setResponder(fn) { responder = fn; },
    reset() { requests.length = 0; },
    async listen() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      await new Promise(resolve => server.close(resolve));
    }
  };
}

function respondWithContent(res, content) {
  const payload = JSON.stringify({
    model: 'planner-stub',
    message: { role: 'assistant', content },
    done: true
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function declaredWork(objective) {
  return {
    objective,
    expectedOutputs: [{ kind: 'text', declaration: 'One review report per assigned folder' }],
    successCriteria: [{ kind: 'text', declaration: 'Every report records concrete findings' }],
    evidenceRequirements: []
  };
}

function proposalFor(candidates) {
  return {
    version: 1,
    sharedConstraints: [{ kind: 'text', declaration: 'Stay inside your own folder' }],
    items: candidates.map(candidate => ({
      assignedAgentId: candidate.agentId,
      objective: `Review ${candidate.ownedOutputPaths[0]} and record concrete findings`,
      expectedOutputs: [{
        kind: 'text',
        declaration: `Findings report for ${candidate.ownedOutputPaths[0]}`
      }],
      successCriteria: [{ kind: 'text', declaration: 'Report names at least one finding' }],
      evidenceRequirements: []
    }))
  };
}

async function main() {
  const stub = createProviderStub();
  const providerBaseUrl = await stub.listen();
  try {
    await withHarness('structured allocation planner provider', async ({
      store, workspaceRoot, startServer
    }) => {
      const group = (await store.createGroup({
        value: { name: `Planner Provider ${STAMP}`, permissions: [], canReceiveTickets: true },
        changedBy: ACTOR
      })).group;
      // The planner route the ticket will snapshot: provider `ollama`, model
      // `planner-stub-model`, pointed at the local stub.
      const planner = (await store.createConfiguredAgent({
        value: {
          name: `Planner ${STAMP}`,
          provider: 'ollama',
          model: 'planner-stub-model',
          baseUrl: providerBaseUrl
        },
        groupIds: [group.id],
        changedBy: ACTOR
      })).agent;
      const worker = (await store.createConfiguredAgent({
        value: {
          name: `Worker ${STAMP}`,
          provider: 'ollama',
          model: 'worker-stub-model',
          baseUrl: providerBaseUrl
        },
        groupIds: [group.id],
        changedBy: ACTOR
      })).agent;
      const designated = (await store.updateGroup({
        groupId: group.id,
        expectedRevision: group.revision,
        value: { ...group, plannerAgentId: planner.id },
        changedBy: ACTOR
      })).group;

      const ownedOutputPaths = {
        [planner.id]: 'reports/planner/',
        [worker.id]: 'reports/worker/'
      };

      const server = await startServer({ env: {
        TEST_SKIP_STARTUP_RUN_RECOVERY: 'true',
        RUNTIME_SCHEDULER_INTERVAL_MS: '3600000',
        // Only shortens the contract bound; it can never widen it.
        STRUCTURED_PLANNER_REQUEST_TIMEOUT_MS: '1500'
      } });
      const cookie = await server.login();
      fs.mkdirSync(path.join(workspaceRoot, 'reports', 'planner'), { recursive: true });
      fs.mkdirSync(path.join(workspaceRoot, 'reports', 'worker'), { recursive: true });

      const requestStructuredTicket = objective =>
        server.request('POST', '/tickets', {
          cookie,
          form: {
            objective,
            acceptanceCriteria: 'Structured planning owns this decomposition.',
            declaredWork: JSON.stringify(declaredWork(objective)),
            assignmentTargetType: 'group',
            assignmentTargetId: String(designated.id),
            assignmentMode: 'allocated',
            capabilityType: 'directAction',
            executionTargetKind: 'workspace',
            ownedOutputPaths: JSON.stringify(ownedOutputPaths)
          }
        });

      // Tranche 6 FINAL STOP retires the product activation boundary before
      // planner routing. The local provider remains deliberately willing to
      // answer so zero transport requests proves the boundary, not provider
      // unavailability. Direct store suites retain historical planner/leaf
      // reconstruction and integrity coverage.

      stub.reset();
      stub.setResponder((req, res) => {
        // Deliberately willing to answer. Nothing must ever ask.
        respondWithContent(res, JSON.stringify({ version: 1, items: [] }));
      });

      const objective = `Create retired planner reports ${STAMP}`;
      const response = await requestStructuredTicket(objective);

      assert.equal(response.statusCode, 400,
        'structured product activation is refused before Ticket creation');
      assert.match(response.body, /first-class structured planner\/leaf product path is retired/i,
        'the refusal names the post-Tranche-6 product boundary');
      assert.equal(stub.requests.length, 0,
        'retired activation reaches no provider transport');
      assert.equal((await store.listTickets({ limit: 500 })).tickets
        .some(candidate => candidate.objective === objective), false,
      'retired activation mints no Ticket');
      assert.equal((await store.listAllocationPlans({ limit: 500 })).plans.length, 0,
        'retired activation admits no plan and performs no v1 fallback');
      assert.equal((await store.listRuns({ limit: 500 })).runs.length, 0,
        'retired activation admits no planner or leaf Run');
    });
  } finally {
    await stub.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
