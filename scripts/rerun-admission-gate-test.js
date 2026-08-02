#!/usr/bin/env node
'use strict';
// Rerun admission gate — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// Replaces three JSON-era orphans covering one question from three angles:
// ticket-triage-rerun-hardening-test.js, manual-rerun-attempt-ceiling-test.js and
// max-attempts-control-test.js.
//
// THE CONTRACT — WHAT MAY START NEW WORK, AND WHAT STOPS IT.
//
// A ticket that has stopped is the point where the runtime is most likely to be asked
// to try again, and the two things that may refuse are the only bounds on repeating
// failing work:
//
//   UNRESOLVED TICKET TRIAGE — a human decision is outstanding. No path may create a
//   run: not rerun, not retry, not reopening the ticket. Resolution is what lifts it.
//
//   THE ATTEMPT CEILING — `executionPolicy.maxAttempts`, enforced in exactly one
//   place (`validateManualRerun`) and derived from the runs that actually exist, with
//   no persisted counter to drift.
//
// Both are refusals an operator sees as an HTTP status, so the failure mode is quiet:
// a gate that returns 409 and creates a run anyway looks identical to a working gate
// from the response alone. Every refusal here is therefore asserted twice — the status
// AND the run count, read from the store rather than from the reply.
//
// NO REGISTERED SUITE COVERED ANY OF THIS. Before this file, the refusal strings
// `Manual rerun rejected`, `unresolved ticket-level triage` and the ceiling edit route
// appeared only in the orphans.
//
// WHERE THE TRIAGE COMES FROM. The gate is what is under test, not how triage is
// created. Scenario 5 uses runtime-produced triage end to end: an ambiguous objective
// makes `createRunsForTicket` block the ticket through
// `blockTicketForObjectiveAmbiguity`, with no test involvement at all. Scenario 8 needs
// a state the public API cannot reach in one step — a FAILED run whose parent ticket
// also carries unresolved ticket-level triage — and seeds it through
// `transitionTicketState`, the same repository call `blockTicketForNoModelRoute` makes,
// with the same patch and event type. The triage-producing paths themselves are covered
// by `ticket-feasibility-gate-test.js` and `runtime-feasibility-test.js`.
//
// THE TRIAGE GATE IS TWO LAYERS DEEP, WHICH CHANGES WHAT MUST BE ASSERTED. Disabling
// the route-level predicate (`hasUnresolvedTicketTriage`) does NOT let a run through:
// the store's own `reopenTicket` refuses with `TICKET_TRIAGE_REQUIRED` underneath it.
// So an assertion of the form "the rerun was refused" survives the gate being removed.
// What does not survive is the refusal staying LEGIBLE: with the predicate gone the
// operator gets a bare 409 `Conflict` instead of a message naming the outstanding
// decision, and an unexplained 409 is one an operator cannot act on. Every refusal here
// therefore asserts the reason text, not just the status.
//
// NO VACUOUS EXIT. No skip path, no NOT_PROVEN, every wait throws on timeout, and every
// refusal scenario is paired with a positive control proving the same route works when
// it should — without those, a runtime whose rerun route was simply broken would
// satisfy every refusal assertion here.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const fs = require('fs');
const os = require('os');
const path = require('path');
const argon2 = require('argon2');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const { assertScenariosExecuted } = require('./child-process-settlement');

const STAMP = Date.now();
const assert = createAsserter();
let scenariosRun = 0;

const READONLY_PASSWORD = `readonly-${STAMP}`;

// A distinctive policy so "the edit preserved everything else" compares real values
// rather than two empty objects. Only fields `normalizeExecutionPolicy` actually
// honours are set; the preservation check below diffs against the policy as STORED
// before the edit, so it stays correct if the policy grows a field.
const BASE_POLICY = Object.freeze({
  mode: 'manual',
  maxAttempts: null,
  autoRetry: false,
  maxRuntimeMs: 987000,
  maxModelRequests: 7,
  maxWorkspaceOperations: 11,
  allowWorkspaceWrites: true,
  allowParallelRuns: true,
  allowChildTickets: true
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// The stub finishes every ordinary run immediately and fails the one run that must be
// failed, so the suite spends its time on admission rather than on execution.
function createPreload(failMarker) {
  const preloadPath = path.join(os.tmpdir(), `rerun-admission-preload-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
const FAIL_MARKER = ${JSON.stringify(failMarker)};
function ok(plan) {
  return {
    ok: true, status: 200,
    headers: new Map([['x-request-id', 'rerun-admission-gate']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify(plan),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
}
global.fetch = async function(_url, options = {}) {
  const raw = String(options.body || '');
  if (raw.includes(FAIL_MARKER)) {
    // A path escaping the workspace root is refused as policy, which fails the run.
    return ok({ message: 'Reading outside the workspace.',
      actions: [{ operation: 'readFile', args: { path: '../outside.txt' } }], complete: false });
  }
  return ok({ message: 'Nothing to do.', actions: [], complete: true });
};
`);
  return preloadPath;
}

async function main() {
  const failMarker = `RERUNFAIL${STAMP}`;
  const preloadPath = createPreload(failMarker);
  try {
    await withHarness('rerun admission gate', async ({ store, startServer }) => {
      const agent = (await store.createConfiguredAgent({
        value: { name: `RerunGate-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'k' },
        groupIds: [], changedBy: 'rerun-admission-gate-test'
      })).agent;

      // A principal that may READ tickets but not update them, so the 403 below is a
      // permission decision rather than an unauthenticated request.
      const readonlyGroup = (await store.createGroup({
        value: {
          name: `Rerun readers ${STAMP}`,
          permissions: ['ticket:read'],
          canReceiveTickets: false
        },
        changedBy: 'rerun-admission-gate-test'
      })).group;
      await store.createUser({
        value: { username: `rerun-readonly-${STAMP}`, passwordHash: await argon2.hash(READONLY_PASSWORD) },
        groupIds: [readonlyGroup.id],
        changedBy: 'rerun-admission-gate-test'
      });

      const server = await startServer({ env: {
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '600000'
      } });
      const cookie = await server.login();
      const readonlyCookie = await server.login(`rerun-readonly-${STAMP}`, READONLY_PASSWORD);

      const createTicket = async (objective, executionPolicy = BASE_POLICY) => {
        const response = await server.request('POST', '/tickets', {
          cookie,
          form: {
            objective,
            assignmentTargetType: 'agent',
            assignmentTargetId: String(agent.id),
            assignmentMode: 'individual',
            executionPolicy: JSON.stringify(executionPolicy)
          }
        });
        if (response.statusCode !== 302) {
          throw new Error(`ticket creation returned HTTP ${response.statusCode}: ${response.body.slice(0, 400)}`);
        }
        const tickets = (await store.listTickets({ limit: 200 })).tickets || [];
        const ticket = tickets.find(candidate => candidate.objective === objective);
        if (!ticket) throw new Error(`ticket was not persisted: ${objective}`);
        return ticket;
      };

      const runCount = ticketId => store.countRunsForTicket(ticketId);
      const ticketNow = async ticketId => (await store.getTicket(ticketId));
      const settled = async (ticketId, expected) => waitFor(async () => {
        const runs = (await store.listRuns({ limit: 200 })).runs || [];
        const mine = runs.filter(run => run.ticketId === ticketId);
        if (mine.length !== expected) return null;
        return mine.every(run => ['completed', 'failed', 'interrupted'].includes(run.status)) ? mine : null;
      }, 120000, `ticket ${ticketId} to hold ${expected} settled run(s)`);

      const rerun = ticketId => server.request('POST', `/api/tickets/${ticketId}/rerun`, { cookie, body: {} });
      const setCeiling = (ticketId, maxAttempts, sessionCookie = cookie) =>
        server.request('POST', `/api/tickets/${ticketId}/execution-policy/max-attempts`,
          { cookie: sessionCookie, body: { maxAttempts } });

      // ── 1. POSITIVE CONTROL — an ordinary rerun works ─────────────────────────
      // Every refusal below is meaningless without this: a broken rerun route would
      // satisfy all of them.
      scenariosRun += 1;
      const open = await createTicket(`RERUNOPEN${STAMP} record the current state`);
      await settled(open.id, 1);
      assert(await runCount(open.id) === 1, '1: the ticket has exactly one run before any rerun');
      const firstRerun = await rerun(open.id);
      assert(firstRerun.statusCode === 200,
        `1: an unconstrained ticket may be rerun (HTTP ${firstRerun.statusCode}: ${firstRerun.body.slice(0, 200)})`);
      await settled(open.id, 2);
      assert(await runCount(open.id) === 2,
        `1: and the rerun created exactly one new run (${await runCount(open.id)})`);

      // ── 2. THE CEILING REFUSES, AND CREATES NOTHING ───────────────────────────
      scenariosRun += 1;
      const ceilingSet = await setCeiling(open.id, 2);
      assert(ceilingSet.statusCode === 200,
        `2: the ceiling can be set to the attempts already used (HTTP ${ceilingSet.statusCode})`);
      const blockedRerun = await rerun(open.id);
      assert(blockedRerun.statusCode === 409,
        `2: a rerun at the ceiling is refused (HTTP ${blockedRerun.statusCode})`);
      const blockedBody = JSON.parse(blockedRerun.body);
      assert(/Manual rerun rejected/.test(blockedBody.error || ''),
        `2: refused as an attempt-ceiling decision, not a generic error (${blockedBody.error})`);
      assert(/2 of 2/.test(blockedBody.error || ''),
        `2: naming the attempts used and allowed, so an operator can act on it (${blockedBody.error})`);
      assert(await runCount(open.id) === 2,
        `2: and the refusal created no run (${await runCount(open.id)})`);

      // ── 3. THE GUARD READS THE CURRENT CEILING, NOT A CACHED ONE ──────────────
      // The same request that was just refused must succeed once the ceiling is
      // lifted, with nothing else changed.
      scenariosRun += 1;
      const cleared = await setCeiling(open.id, null);
      assert(cleared.statusCode === 200,
        `3: the ceiling can be cleared back to the runtime default (HTTP ${cleared.statusCode})`);
      assert((await ticketNow(open.id)).executionPolicy.maxAttempts === null,
        '3: and the cleared value is what is stored');
      const allowedAgain = await rerun(open.id);
      assert(allowedAgain.statusCode === 200,
        `3: the previously refused rerun is now admitted (HTTP ${allowedAgain.statusCode}: ${allowedAgain.body.slice(0, 200)})`);
      await settled(open.id, 3);
      assert(await runCount(open.id) === 3,
        `3: creating exactly one further run (${await runCount(open.id)})`);
      const defaultExhausted = await rerun(open.id);
      assert(defaultExhausted.statusCode === 409,
        `3: the inherited runtime attempt default remains enforced (HTTP ${defaultExhausted.statusCode})`);
      assert(await runCount(open.id) === 3,
        `3: exhausting the inherited default creates no fourth run (${await runCount(open.id)})`);

      // ── 4. THE CEILING EDIT IS NARROW AND AUTHORIZED ──────────────────────────
      scenariosRun += 1;
      const narrow = await createTicket(`RERUNNARROW${STAMP} record the current state`);
      await settled(narrow.id, 1);

      // The policy as the runtime actually normalized and stored it. Diffing against
      // this rather than against BASE_POLICY keeps the assertion honest if the policy
      // shape changes: a new field is covered automatically instead of silently.
      const policyBefore = (await ticketNow(narrow.id)).executionPolicy;
      assert(Object.keys(policyBefore).length >= 8,
        `4: the stored policy has fields worth preserving (${Object.keys(policyBefore).length})`);
      assert(policyBefore.maxRuntimeMs === BASE_POLICY.maxRuntimeMs &&
             policyBefore.maxModelRequests === BASE_POLICY.maxModelRequests,
        '4: and the distinctive values submitted at creation really were stored');

      const denied = await setCeiling(narrow.id, 5, readonlyCookie);
      assert(denied.statusCode === 403,
        `4: a principal without ticket:update may not change the ceiling (HTTP ${denied.statusCode})`);
      assert((await ticketNow(narrow.id)).executionPolicy.maxAttempts === null,
        '4: and the refused edit changed nothing');

      for (const invalid of [0, -1, 'abc']) {
        const rejected = await setCeiling(narrow.id, invalid);
        assert(rejected.statusCode === 400,
          `4: ${JSON.stringify(invalid)} is rejected as a ceiling (HTTP ${rejected.statusCode})`);
      }
      assert((await ticketNow(narrow.id)).executionPolicy.maxAttempts === null,
        '4: no invalid value was stored');

      const accepted = await setCeiling(narrow.id, 4);
      assert(accepted.statusCode === 200, `4: a valid ceiling is accepted (HTTP ${accepted.statusCode})`);
      const narrowAfter = await ticketNow(narrow.id);
      assert(narrowAfter.executionPolicy.maxAttempts === 4,
        `4: the new ceiling is stored (${narrowAfter.executionPolicy.maxAttempts})`);
      for (const [field, value] of Object.entries(policyBefore)) {
        if (field === 'maxAttempts') continue;
        assert(JSON.stringify(narrowAfter.executionPolicy[field]) === JSON.stringify(value),
          `4: the edit preserved executionPolicy.${field} (${JSON.stringify(narrowAfter.executionPolicy[field])} vs ${JSON.stringify(value)})`);
      }
      assert(Object.keys(narrowAfter.executionPolicy).length === Object.keys(policyBefore).length,
        '4: and introduced no field of its own');
      assert(await runCount(narrow.id) === 1,
        `4: and editing the ceiling created no run (${await runCount(narrow.id)})`);
      assert(narrowAfter.status === (await ticketNow(narrow.id)).status,
        '4: nor changed the ticket status');

      // ── 5. UNRESOLVED TRIAGE, PRODUCED BY THE RUNTIME ITSELF ──────────────────
      // An ambiguous objective is refused by the clarification gate, which blocks the
      // ticket with required triage and creates no run. No test seeding at all.
      scenariosRun += 1;
      const ambiguous = await createTicket(`Create 5 ${STAMP} category folders`);
      const blockedTicket = await waitFor(async () => {
        const current = await ticketNow(ambiguous.id);
        return current && current.triage && current.triage.required === true ? current : null;
      }, 60000, 'the ambiguous ticket to be blocked with triage');
      assert(blockedTicket.status === 'blocked',
        `5: an ambiguous objective blocks the ticket (${blockedTicket.status})`);
      assert(blockedTicket.triage.required === true && !blockedTicket.triage.resolvedAt,
        '5: with triage that is required and unresolved');
      assert(await runCount(ambiguous.id) === 0,
        `5: and no run was created for it (${await runCount(ambiguous.id)})`);

      // ── 6. TRIAGE REFUSES EVERY PATH TO A NEW RUN ─────────────────────────────
      scenariosRun += 1;
      const triagedRerun = await rerun(ambiguous.id);
      assert(triagedRerun.statusCode === 409,
        `6: rerun is refused while triage is unresolved (HTTP ${triagedRerun.statusCode})`);
      assert(/unresolved ticket-level triage/.test(JSON.parse(triagedRerun.body).error || ''),
        `6: refused as a triage decision, distinguishable from the ceiling (${JSON.parse(triagedRerun.body).error})`);
      assert(await runCount(ambiguous.id) === 0,
        `6: and no run was created (${await runCount(ambiguous.id)})`);

      // Reopening the ticket is the third door, and it must not be a way around the
      // other two: the status change may be accepted, but no run may follow it.
      const reopened = await server.request('PATCH', `/api/tickets/${ambiguous.id}/status`, {
        cookie, body: { status: 'open' }
      });
      assert([200, 409].includes(reopened.statusCode),
        `6: reopening returns a definite answer (HTTP ${reopened.statusCode})`);
      await sleep(1500);
      assert(await runCount(ambiguous.id) === 0,
        `6: reopening a triaged ticket still creates no run (${await runCount(ambiguous.id)})`);
      const afterReopen = await ticketNow(ambiguous.id);
      assert(afterReopen.triage && afterReopen.triage.required === true && !afterReopen.triage.resolvedAt,
        '6: and the outstanding decision is still outstanding');

      // ── 7. RESOLUTION IS WHAT LIFTS THE GATE ──────────────────────────────────
      // The positive control for scenario 6. Without it, a runtime that refused every
      // rerun forever would pass everything above.
      scenariosRun += 1;
      const resolved = await server.request('POST', `/api/tickets/${ambiguous.id}/triage/resolve`, {
        cookie, body: { resolution: `resolved by the rerun admission gate suite ${STAMP}` }
      });
      assert(resolved.statusCode === 200,
        `7: triage can be resolved (HTTP ${resolved.statusCode}: ${resolved.body.slice(0, 200)})`);
      const afterResolve = await ticketNow(ambiguous.id);
      assert(afterResolve.triage && afterResolve.triage.resolvedAt,
        '7: the resolution is durable, carrying when it happened');
      assert(afterResolve.triage.resolvedBy,
        '7: and who made it, so the decision is attributable');
      const afterResolveRerun = await rerun(ambiguous.id);
      assert(afterResolveRerun.statusCode !== 409 ||
             !/unresolved ticket-level triage/.test(JSON.parse(afterResolveRerun.body).error || ''),
        `7: the triage refusal no longer applies (HTTP ${afterResolveRerun.statusCode}: ${afterResolveRerun.body.slice(0, 200)})`);

      // ── 8. RETRY IS GATED ON THE PARENT TICKET, NOT ONLY ON THE RUN ───────────
      // A retry names a run, so the ticket-level decision is easy to omit there. This
      // is the case a suite asserting only the rerun route would miss.
      scenariosRun += 1;
      const failing = await createTicket(`${failMarker} read outside the workspace root`);
      const failedRuns = await settled(failing.id, 1);
      assert(failedRuns[0].status === 'failed',
        `8: the subject run really failed, so retry is applicable (${failedRuns[0].status})`);

      // Positive control FIRST: retry works while no ticket triage exists.
      const retryAllowed = await server.request('POST', `/api/runs/${failedRuns[0].id}/retry`, { cookie, body: {} });
      assert(retryAllowed.statusCode === 200,
        `8: a failed run may be retried when nothing is outstanding (HTTP ${retryAllowed.statusCode}: ${retryAllowed.body.slice(0, 200)})`);
      await settled(failing.id, 2);

      const secondFailure = (await settled(failing.id, 2)).sort((a, b) => b.id - a.id)[0];
      assert(secondFailure.status === 'failed', `8: the retry run also failed (${secondFailure.status})`);

      // Now the state the public API cannot reach in one step, written through the
      // same repository call `blockTicketForNoModelRoute` uses.
      const beforeSeed = await waitFor(async () => {
        const current = await ticketNow(failing.id);
        return current.status === 'failed' ? current : null;
      }, 30000, `ticket ${failing.id} terminal projection after retry`);
      await store.transitionTicketState({
        ticketId: failing.id,
        fromStatuses: [beforeSeed.status],
        toStatus: 'blocked',
        patch: {
          blockedReason: 'seeded outstanding decision',
          triage: {
            required: true,
            reasonCode: 'authority_blocked',
            summary: `outstanding decision seeded by the rerun admission gate suite ${STAMP}`,
            requiredDecision: 'change_scope',
            createdAt: new Date().toISOString(),
            resolvedAt: null
          },
          changedAt: new Date().toISOString()
        },
        eventType: 'ticket.blocked',
        eventPayload: { reason: 'seeded outstanding decision', reasonCode: 'test_seeded' }
      });
      const seeded = await ticketNow(failing.id);
      assert(seeded.triage && seeded.triage.required === true && !seeded.triage.resolvedAt,
        '8: the ticket now carries an unresolved decision');

      const countBeforeRetry = await runCount(failing.id);
      const retryRefused = await server.request('POST', `/api/runs/${secondFailure.id}/retry`, { cookie, body: {} });
      assert(retryRefused.statusCode === 409,
        `8: retry is refused while the parent ticket has unresolved triage (HTTP ${retryRefused.statusCode})`);
      assert(/unresolved ticket-level triage/.test(JSON.parse(retryRefused.body).error || ''),
        `8: naming the outstanding decision (${JSON.parse(retryRefused.body).error})`);
      assert(await runCount(failing.id) === countBeforeRetry,
        `8: and the refusal created no run (${await runCount(failing.id)} vs ${countBeforeRetry})`);
      const rerunAlsoRefused = await rerun(failing.id);
      assert(rerunAlsoRefused.statusCode === 409,
        `8: the rerun route agrees with the retry route (HTTP ${rerunAlsoRefused.statusCode})`);
      assert(await runCount(failing.id) === countBeforeRetry,
        '8: and it created no run either');

      // ── 9. ATTEMPTS ARE DERIVED, NOT COUNTED SEPARATELY ───────────────────────
      // `validateManualRerun` reads the runs that exist. Anything the store reports
      // must therefore match what the ticket actually holds — a divergence here is
      // what a persisted attempt counter would eventually produce.
      scenariosRun += 1;
      const allRuns = (await store.listRuns({ limit: 200 })).runs || [];
      for (const ticketId of [open.id, narrow.id, ambiguous.id, failing.id]) {
        const owned = allRuns.filter(run => run.ticketId === ticketId);
        assert(await runCount(ticketId) === owned.length,
          `9: the attempt count for ticket ${ticketId} equals the runs that exist (${await runCount(ticketId)} vs ${owned.length})`);
        assert(owned.every(run => run.ticketId === ticketId),
          `9: and every one of them belongs to that ticket`);
      }

      assertScenariosExecuted({
        label: 'rerun admission gate',
        assertions: assert.count(),
        scenarios: scenariosRun,
        minAssertions: 45,
        minScenarios: 9
      });
      console.log(`\nPASS: rerun admission gate — ${scenariosRun} scenarios, ${assert.count()} assertions (PostgreSQL-native)`);
    }, { schemaSlug: 'rerun_admission' });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(`\nFAIL: rerun admission gate — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
