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

      const server = await startServer({
        TEST_SKIP_STARTUP_RUN_RECOVERY: 'true',
        RUNTIME_SCHEDULER_INTERVAL_MS: '3600000',
        // Only shortens the contract bound; it can never widen it.
        STRUCTURED_PLANNER_REQUEST_TIMEOUT_MS: '1500'
      });
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
      let capturedCandidates = null;
      stub.reset();
      stub.setResponder((req, res, body) => {
        // Derive the proposal from the request the server actually sent, so the
        // stub cannot accidentally agree with a context the server never built.
        const context = JSON.parse(body.messages[1].content);
        capturedCandidates = context.candidates;
        respondWithContent(res, JSON.stringify(proposalFor(context.candidates)));
      });

      const ticket = await createTicket(`Create live planner admission reports ${STAMP}`);

      // Exactly one provider request.
      assert.equal(stub.requests.length, 1, 'exactly one planner provider request is issued');
      const request = stub.requests[0];
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/api/chat');

      // The snapshotted provider and model were used, with no fallback.
      const snapshot = ticket.structuredAllocationAuthority.planningAuthoritySnapshot;
      assert.equal(snapshot.planner.provider, 'ollama');
      assert.equal(snapshot.planner.model, 'planner-stub-model');
      assert.equal(request.body.model, snapshot.planner.model,
        'the request used the snapshotted model');
      assert.notEqual(request.body.model, worker.model,
        'no candidate model was substituted for the planner model');
      assert.equal(request.body.stream, false);

      // The request context carries no credentials or host paths.
      const wire = JSON.stringify(request.body);
      for (const forbidden of ['apiKey', 'api_key', 'Bearer', 'authorization', workspaceRoot]) {
        assert.equal(wire.includes(forbidden), false,
          `the planner request must not disclose ${forbidden}`);
      }
      assert.equal(request.headers.authorization, undefined,
        'no authorization header is sent to the snapshotted provider');
      assert.equal(capturedCandidates.length, 2,
        'the context carried both captured candidates');

      // Exactly one v2 allocation plan, and Tranche 3 leaf admission has turned
      // it into exactly one initial Run per immutable item.
      const plans = await plansFor(ticket.id);
      assert.equal(plans.length, 1, 'exactly one v2 allocation plan exists');
      const plan = plans[0];
      assert.equal(plan.version, 2);
      assert.equal(plan.items.length, 2);
      const leafRuns = await runsFor(ticket.id);
      assert.equal(leafRuns.length, plan.items.length,
        'live admission is followed by exactly one leaf run per allocation item');
      assert.deepEqual(
        leafRuns.map(run => run.allocationItemId).sort((a, b) => a - b),
        plan.items.map(item => item.allocationItemId).sort((a, b) => a - b),
        'every item is bound exactly once'
      );
      for (const run of leafRuns) {
        const item = plan.items.find(candidate =>
          candidate.allocationItemId === run.allocationItemId);
        const binding = normalizeLeafRunBinding(run.leafRunBinding, {
          expectedRunId: run.id,
          expectedTicketId: ticket.id,
          expectedPlanId: plan.id,
          expectedPlanHash: plan.planHash,
          expectedAllocationItemId: item.allocationItemId
        });
        assert.equal(run.agentId, item.assignedAgentId,
          'the worker principal is the agent the item admitted');
        assert.deepEqual(binding.ownedOutputPaths, item.ownedOutputPaths);
        assert.equal(run.declaredWorkSnapshot.contractHash, binding.itemDeclaredWorkHash);
        assert.equal(run.declaredWorkSnapshot.objective.text, item.objective.text,
          'the leaf declares its allocation item, not the parent ticket');
        assert.equal(run.allocationSubtask ?? null, null,
          'no generic v1 allocation subtask is produced');
        assert.equal(run.status, 'pending');
      }

      // Provenance and admission binding came from the real route.
      assert.equal(plan.planningProvenance.provider, 'ollama');
      assert.equal(plan.planningProvenance.model, 'planner-stub-model');
      assert.equal(plan.planningProvenance.planHash, plan.planHash);
      assert.equal(typeof plan.planningProvenance.admissionHash, 'string');

      // Leaf admission started the ticket and made every leaf visible together.
      // No completion is claimed: the plan has no aggregate decision yet.
      const admitted = await store.getTicket(ticket.id);
      assert.equal(admitted.status, 'in_progress',
        'leaf admission starts the ticket through the canonical transition');
      assert.equal(admitted.structuredAllocationPlanningAttempt.state, 'plan_admitted');
      const pending = await store.listPendingRuns({ limit: 100 });
      const visible = (pending.runs || []).filter(run => run.ticketId === ticket.id);
      assert.equal(visible.length, leafRuns.length,
        'every leaf run becomes scheduler-visible together');
      assert.equal(visible.every(run => Boolean(run.leafRunBinding)), true,
        'no leaf run is scheduler-visible without its immutable binding');
      assert.equal(plan.aggregateDecision ?? null, null,
        'admission alone makes no completion claim');
      assert.notEqual(admitted.status, 'completed');

      // The complete response is durable and reparses to the admitted proposal.
      const attempt = admitted.structuredAllocationPlanningAttempt;
      assert.equal(attempt.responseTruncated, false);
      assert.equal(attempt.responseBytes, Buffer.byteLength(attempt.responseText, 'utf8'));
      assert.equal(
        require('node:crypto').createHash('sha256')
          .update(attempt.responseText, 'utf8').digest('hex'),
        attempt.responseHash,
        'the stored response hash covers exactly the stored bytes'
      );

      // Rerun and reopen cannot produce a legacy v1 plan.
      stub.reset();
      for (const [label, action] of [
        ['reopen', () => server.request('PATCH', `/api/tickets/${ticket.id}/status`, {
          cookie, json: { status: 'open' }
        })],
        ['rerun', () => server.request('POST', `/api/tickets/${ticket.id}/rerun`, {
          cookie, json: {}
        })]
      ]) {
        await action();
        const after = await plansFor(ticket.id);
        assert.equal(after.length, 1, `${label} must not create a second plan`);
        assert.equal(after[0].version, 2, `${label} must never produce a legacy v1 plan`);
        const afterRuns = await runsFor(ticket.id);
        assert.equal(afterRuns.length, leafRuns.length,
          `${label} must not duplicate the initial item bindings`);
        assert.deepEqual(
          afterRuns.map(run => run.leafRunBinding.bindingHash).sort(),
          leafRuns.map(run => run.leafRunBinding.bindingHash).sort(),
          `${label} must preserve the exact admitted leaf bindings`
        );
      }
      assert.equal(stub.requests.length, 0,
        'rerun and reopen issue no further provider request');

      // ── Malformed JSON: no plan, no runs ────────────────────────────────
      stub.reset();
      stub.setResponder((req, res) => {
        respondWithContent(res, 'Here is your plan:\n```json\n{"version":1}\n```');
      });
      const malformed = await createTicket(`Create malformed planner output reports ${STAMP}`);
      assert.equal(stub.requests.length, 1, 'a malformed response still costs exactly one request');
      assert.deepEqual(await plansFor(malformed.id), [], 'malformed JSON creates no plan');
      assert.deepEqual(await runsFor(malformed.id), [], 'malformed JSON creates no runs');
      const malformedTicket = await store.getTicket(malformed.id);
      assert.equal(malformedTicket.status, 'blocked');
      assert.equal(malformedTicket.structuredAllocationPlanningAttempt.state, 'failed');
      assert.equal(malformedTicket.structuredAllocationPlanningAttempt.failureStage, 'parse');
      assert.equal(malformedTicket.structuredAllocationPlanningAttempt.failureReason,
        'proposal_not_exact_json');

      // ── Provider failure: no plan, no runs ──────────────────────────────
      stub.reset();
      stub.setResponder((req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'stub provider failure' }));
      });
      const failed = await createTicket(`Create planner provider failure reports ${STAMP}`);
      assert.equal(stub.requests.length, 1, 'a provider failure is not retried');
      assert.deepEqual(await plansFor(failed.id), [], 'provider failure creates no plan');
      assert.deepEqual(await runsFor(failed.id), [], 'provider failure creates no runs');
      const failedTicket = await store.getTicket(failed.id);
      assert.equal(failedTicket.status, 'blocked');
      assert.equal(failedTicket.structuredAllocationPlanningAttempt.failureStage, 'response');
      assert.equal(failedTicket.structuredAllocationPlanningAttempt.failureReason,
        'provider_request_failed');

      // ── Timeout aborts ──────────────────────────────────────────────────
      stub.reset();
      let heldResponse = null;
      stub.setResponder((req, res) => { heldResponse = res; });
      const timedOut = await createTicket(`Create planner timeout reports ${STAMP}`);
      if (heldResponse) { try { heldResponse.destroy(); } catch (_) { /* already gone */ } }
      assert.equal(stub.requests.length, 1, 'a timeout is not retried');
      assert.deepEqual(await plansFor(timedOut.id), [], 'a timeout creates no plan');
      assert.deepEqual(await runsFor(timedOut.id), [], 'a timeout creates no runs');
      const timedOutTicket = await store.getTicket(timedOut.id);
      assert.equal(timedOutTicket.status, 'blocked');
      assert.equal(timedOutTicket.structuredAllocationPlanningAttempt.failureStage, 'response');
      assert.equal(timedOutTicket.structuredAllocationPlanningAttempt.failureReason,
        'provider_request_timed_out');
      assert.equal(timedOutTicket.structuredAllocationPlanningAttempt.responseStatus, 'timeout');
      assert.equal(timedOutTicket.structuredAllocationPlanningAttempt.responseText, null,
        'an aborted request persists no response');

      // ── Transport overflow aborts ───────────────────────────────────────
      // The stub streams past the limit and never ends the response. If the
      // bound were post-buffer only, this would hang until the timeout and
      // report a timeout; a transport bound refuses on size instead.
      stub.reset();
      let overflowSocketClosed = false;
      stub.setResponder((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.on('close', () => { overflowSocketClosed = true; });
        const chunk = 'x'.repeat(16_384);
        const pump = () => {
          if (res.writableEnded || res.destroyed) return;
          for (let index = 0; index < 8; index += 1) res.write(chunk);
          setTimeout(pump, 5);
        };
        pump();
      });
      const oversized = await createTicket(`Create planner overflow reports ${STAMP}`);
      assert.equal(stub.requests.length, 1, 'an oversized response is not retried');
      assert.deepEqual(await plansFor(oversized.id), [], 'an oversized response creates no plan');
      assert.deepEqual(await runsFor(oversized.id), [], 'an oversized response creates no runs');
      const oversizedTicket = await store.getTicket(oversized.id);
      assert.equal(oversizedTicket.status, 'blocked');
      const oversizedAttempt = oversizedTicket.structuredAllocationPlanningAttempt;
      assert.equal(oversizedAttempt.failureStage, 'response');
      assert.equal(oversizedAttempt.failureReason, 'provider_response_too_large',
        'overflow is refused on size, not reported as a timeout — proving a transport bound');
      assert.equal(oversizedAttempt.responseStatus, 'response_too_large');
      assert.equal(oversizedAttempt.responseText, null,
        'an oversized response is never persisted');
      assert.equal(overflowSocketClosed, true,
        'the request is aborted rather than drained');
      assert.match(oversizedAttempt.failureDetail, new RegExp(String(MAX_PLANNER_RESPONSE_BYTES)));

      console.log('structured allocation planner provider tests passed');
    });
  } finally {
    await stub.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
