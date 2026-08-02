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

      const createTicket = async objective => {
        const response = await server.request('POST', '/tickets', {
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
        if (response.statusCode !== 302) {
          const shown = /(rejected|required|missing|invalid|Owned-scope)[^<]{0,300}/i.exec(response.body);
          assert.fail(`ticket creation failed (${response.statusCode}): ${shown ? shown[0].trim() : response.body.slice(-600)}`);
        }
        const ticket = (await store.listTickets({ limit: 500 })).tickets
          .find(candidate => candidate.objective === objective);
        assert(ticket, `ticket for ${objective} was created`);
        return ticket;
      };

      const plansFor = async ticketId =>
        (await store.listAllocationPlans({ ticketId, limit: 20 })).plans;
      const runsFor = async ticketId =>
        (await store.listRunsForTicket({ ticketId, limit: 20 })).runs;

      // ── Success: the full live orchestration ────────────────────────────
      // ── Tranche 4 cutover ────────────────────────────────────────────────
      //
      // This suite formerly proved the Tranche 2B live path: an Ollama planner
      // answered a local stub, a v2 plan was admitted, and Tranche 3 turned it
      // into leaf Runs. That path no longer exists.
      //
      // Structured planning now dispatches ONLY through governed capture, and
      // governed capture requires an immutable dispatch target. Ollama has no
      // immutable target seam — a tag is a moving reference, not an artifact —
      // so an Ollama planner can no longer be captured, priced or reserved.
      // The correct behaviour is therefore ZERO provider contact, and that is
      // what this suite now proves against the real server.
      //
      // The end-to-end HTTP coverage this file used to provide is not replaced
      // here: reproducing it would require either a real paid OpenAI request or
      // a configurable OpenAI base URL, and both are forbidden. The equivalent
      // sequence is proven in-process by
      // `governed-planner-production-path-postgres-test.js`.

      stub.reset();
      stub.setResponder((req, res) => {
        // Deliberately willing to answer. Nothing must ever ask.
        respondWithContent(res, JSON.stringify({ version: 1, items: [] }));
      });

      const ticket = await createTicket(`Create cutover planner reports ${STAMP}`);

      assert.equal(stub.requests.length, 0,
        'an ungoverned planner route issues no provider request after the cutover');

      const blocked = await store.getTicket(ticket.id);
      assert.equal(blocked.status, 'blocked',
        'the ticket is blocked rather than planned');

      const attempt = blocked.structuredAllocationPlanningAttempt;
      assert.equal(attempt.state, 'failed', 'the attempt records a truthful failure');
      assert.equal(attempt.failureReason, 'planner_route_unavailable',
        'the failure names the governed capture refusal, not a provider error');
      assert.equal(attempt.responseStatus, null,
        'no response status is claimed for a request that was never issued');
      assert.equal(attempt.requestHash, null,
        'no request hash is recorded because no request was prepared');
      assert.equal(attempt.governedExecution ?? null, null,
        'a refused capture attaches no governed state');

      // No fallback of any kind.
      assert.deepEqual(await plansFor(ticket.id), [],
        'a refused capture creates no allocation plan');
      assert.deepEqual(await runsFor(ticket.id), [],
        'a refused capture creates no Runs and no v1 allocation fallback');

      // No economic side effects: nothing was accounted for a request that was
      // never prepared.
      const accounts = await store.pool.query(
        `SELECT 1 FROM ${store.table('ticket_economic_accounts')} WHERE ticket_id = $1`,
        [ticket.id]);
      assert.equal(accounts.rowCount, 0, 'no economic account is admitted');
      const reservations = await store.pool.query(
        `SELECT 1 FROM ${store.table('economic_request_reservations')} WHERE ticket_id = $1`,
        [ticket.id]);
      assert.equal(reservations.rowCount, 0, 'no reservation is created');

      // Re-driving the ticket must not retry the provider either.
      stub.reset();
      await createTicket(`Create cutover planner reports again ${STAMP}`).catch(() => null);
      assert.equal(stub.requests.length, 0,
        'a second structured ticket also issues no ungoverned provider request');
    });
  } finally {
    await stub.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
