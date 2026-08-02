#!/usr/bin/env node
'use strict';
// Event record limits and failure containment — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// Replaces the JSON-era `event-journal-record-rejection-test.js`. Its names are gone —
// `EVENT_JOURNAL_MAX_RECORD_BYTES`, `EVENT_RECORD_TOO_LARGE`, `event.record_rejected`,
// `oversizedRejections` — but the contract survived the cutover under PostgreSQL names,
// so this is a replacement rather than a retirement.
//
// THE LOAD-BEARING DISTINCTION. Two failures look alike from a distance and must not be
// confused, because the correct response to each is the opposite of the other:
//
//   REQUEST-SCOPED VALIDATION REJECTION — the caller sent something the system will not
//   store. The request fails, nothing is written, and the process carries on. Treating
//   this as a persistence failure would let any client take the deployment down.
//
//   INTERNAL EVIDENCE-PERSISTENCE FAILURE — the system cannot record what it is doing.
//   It must fail CLOSED: latch `evidencePersistenceFailure`, stop the schedulers, and
//   refuse further evidence-dependent work. Treating this as request-scoped would let
//   the runtime keep mutating the world while silently unable to record any of it.
//
// Scenarios 4 and 5 are the same server surface with opposite containment, which is what
// makes either one meaningful. A runtime that never latches passes 4 and fails 5; one
// that latches on anything passes 5 and fails 4.
//
// WHY SCENARIOS 2-3 GO DIRECT TO THE STORE. `maxJsonRecordBytes` is 2 MiB and Fastify's
// default body limit is 1 MiB, so a request body is refused a megabyte BEFORE the store
// limit can apply — the 413 an HTTP client sees is `FST_ERR_CTP_BODY_TOO_LARGE`, not
// `POSTGRES_RECORD_TOO_LARGE`. The store limit is still live for records the SERVER
// accumulates (evaluation, consequence and replay documents grow server-side), and that
// is the only truthful way to observe it. Scenario 4 asserts the HTTP boundary for what
// it actually is rather than pretending it reaches the store rule. See A20 for the
// configuration-seam decision: no production config surface was added for this.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const { withHarness, createAsserter } = require('./postgres-test-harness');
const { assertScenariosExecuted } = require('./child-process-settlement');
const { currentRuntimeLimitsSnapshot } = require('./current-run-fixture');

const STAMP = Date.now();
const assert = createAsserter();
let scenariosRun = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  await withHarness('event record limit containment', async ({ store, startServer, schema }) => {
    const agent = (await store.createConfiguredAgent({
      value: { name: `RecordLimit-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'k' },
      groupIds: [], changedBy: 'event-record-limit-containment-test'
    })).agent;

    const now = () => new Date().toISOString();
    const limit = store.maxJsonRecordBytes;
    assert(Number.isSafeInteger(limit) && limit > 0,
      `the store exposes a positive record limit (${limit})`);

    const server = await startServer({ env: { RUNTIME_SCHEDULER_INTERVAL_MS: '3600000' } });
    const cookie = await server.login();

    const createTicket = objective => server.request('POST', '/tickets', {
      cookie,
      form: {
        objective,
        assignmentTargetType: 'agent', assignmentTargetId: String(agent.id), assignmentMode: 'individual'
      }
    });

    // ── 1. A record below the limit succeeds and is durably readable ────────
    // The positive control for everything else: if ordinary evidence did not persist
    // and read back, every rejection assertion below would be trivially satisfied.
    scenariosRun += 1;
    const legalObjective = `record limit legal ${STAMP} ${'z'.repeat(4096)}`;
    const created = await createTicket(legalObjective);
    assert(created.statusCode === 302,
      `1: an ordinary record is accepted (HTTP ${created.statusCode})`);

    const ticket = await waitFor(async () => {
      const page = await store.listTickets({ limit: 100 });
      return (page.tickets || []).find(t => t.objective === legalObjective) || null;
    }, 15000, '1: the accepted ticket to be persisted');

    const ticketEvents = (await store.listTicketEvents(ticket.id, { limit: 100 })).events;
    assert(ticketEvents.length > 0,
      '1: the accepted record left durable evidence');
    assert(ticketEvents.every(event => event.payload && typeof event.payload === 'object'),
      '1: the durable evidence reads back as structured records, not truncated text');

    // ── 2. The oversized-record contract, at the REAL default limit ─────────
    scenariosRun += 1;
    const runFor = async label => {
      const t = (await store.createTicketWithEvent({
        ticket: {
          objective: `record limit ${label} ${STAMP}`, acceptanceCriteria: null,
          assignmentTargetType: 'agent', assignmentTargetId: agent.id, assignmentMode: 'individual',
          ownedOutputPaths: null, targetRef: null, executionMode: 'agent',
          workflowId: null, workflowInput: null,
          capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
          executionPolicy: { mode: 'assisted', requireVerification: 'when_declared' },
          workTypeId: null, workTypeSnapshot: null, workContextId: null, workContextSnapshot: null,
          status: 'in_progress', createdBy: 'admin', changedBy: 'admin',
          changedAt: now(), createdAt: now(), updatedAt: now()
        },
        eventPayload: { source: 'event-record-limit-containment-test' }
      })).ticket;
      const r = await store.createRun({
        ticketId: t.id, agentId: agent.id, agentName: agent.name,
        runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot(),
        executionPolicySnapshot: { requireVerification: 'when_declared' }, status: 'pending'
      });
      return { ticket: t, run: r };
    };

    const { ticket: limitTicket, run: limitRun } = await runFor('boundary');

    // POSITIVE CONTROL FIRST: a large record that is still legal must be ACCEPTED.
    // Without it, "oversized is rejected" would also be satisfied by a store that
    // rejected everything sizeable, and the boundary would be untested.
    const underLimit = await store.appendEvent({
      type: 'record.under_limit', ticketId: limitTicket.id, runId: limitRun.id,
      payload: { blob: 'u'.repeat(Math.floor(limit * 0.75)) }
    });
    assert(underLimit && underLimit.type === 'record.under_limit',
      '2: a large record BELOW the limit is accepted, so the limit is the boundary being enforced');

    let rejection = null;
    try {
      await store.appendEvent({
        type: 'record.over_limit', ticketId: limitTicket.id, runId: limitRun.id,
        payload: { blob: 'o'.repeat(limit + 1024) }
      });
    } catch (error) {
      rejection = error;
    }
    assert(rejection, '2: an oversized record is rejected rather than stored');
    assert(rejection.code === 'POSTGRES_RECORD_TOO_LARGE',
      `2: the rejection carries the current structured code (got ${rejection.code})`);
    assert(rejection instanceof RangeError,
      '2: the rejection is a RangeError, which is what routes it to request-scoped handling');
    assert(Number.isSafeInteger(rejection.recordBytes) && Number.isSafeInteger(rejection.maxRecordBytes),
      '2: the rejection reports the measured size and the enforced boundary');
    assert(rejection.recordBytes > rejection.maxRecordBytes,
      `2: and the reported size actually exceeds the reported limit (${rejection.recordBytes} > ${rejection.maxRecordBytes})`);

    // ── 3. No partial persistence, no misleading success evidence ───────────
    scenariosRun += 1;
    const runEvents = async runId =>
      (await store.listTicketEvents(limitTicket.id, { limit: 200 })).events.filter(e => e.runId === runId);
    const chainTip = async runId => {
      const result = await store.pool.query(
        `SELECT next_seq FROM "${schema}".run_event_chain_tips WHERE run_id = $1`, [runId]);
      return result.rowCount === 1 ? Number(result.rows[0].next_seq) : null;
    };

    const eventsAfterRejection = await runEvents(limitRun.id);
    assert(eventsAfterRejection.every(event => event.type !== 'record.over_limit'),
      '3: the rejected record was not written, not even partially');
    assert(eventsAfterRejection.some(event => event.type === 'record.under_limit'),
      '3: the accepted record before it is still present, so the rollback was scoped to the rejection');

    // A rejected append must not consume a chain position. If it did, the run's event
    // chain would carry a permanent gap that verification could never explain.
    const tipAfterRejection = await chainTip(limitRun.id);
    const accepted = await store.appendEvent({
      type: 'record.after_rejection', ticketId: limitTicket.id, runId: limitRun.id,
      payload: { ok: true }
    });
    const tipAfterAccept = await chainTip(limitRun.id);
    assert(accepted && accepted.type === 'record.after_rejection',
      '3: a valid record appends normally after a rejection');
    assert(tipAfterAccept === tipAfterRejection + 1,
      `3: the rejection consumed no chain position (${tipAfterRejection} → ${tipAfterAccept})`);

    const finalEvents = await runEvents(limitRun.id);
    const seqs = finalEvents.map(event => event.seq).filter(seq => Number.isSafeInteger(seq));
    assert(seqs.length === finalEvents.length,
      '3: every surviving run-scoped record carries a sequence');
    assert(JSON.stringify(seqs) === JSON.stringify(seqs.slice().sort((a, b) => a - b)) &&
           new Set(seqs).size === seqs.length &&
           seqs[seqs.length - 1] - seqs[0] === seqs.length - 1,
      `3: the surviving sequences are contiguous with no gap left by the rejection (${seqs.join(',')})`);

    // ── 4. A request-scoped rejection does not latch or poison later work ───
    scenariosRun += 1;
    const oversizedBody = 'q'.repeat(1024 * 1024 + 8192);
    const refused = await createTicket(oversizedBody);
    assert(refused.statusCode === 413,
      `4: an oversized request is refused with 413 (got ${refused.statusCode})`);

    const health = await server.request('GET', '/health');
    assert(health.statusCode === 200,
      `4: the refusal did not degrade the process (health HTTP ${health.statusCode})`);
    assert(JSON.parse(health.body).ready === true,
      '4: the process remains ready — a client cannot latch an evidence failure');

    // The whole point: later valid work must still be possible.
    const afterObjective = `record limit recovery ${STAMP}`;
    assert((await createTicket(afterObjective)).statusCode === 302,
      '4: a valid request immediately afterwards still succeeds');
    assert(await waitFor(async () => {
      const page = await store.listTickets({ limit: 100 });
      return (page.tickets || []).some(t => t.objective === afterObjective);
    }, 15000, '4: the recovery ticket to persist'),
      '4: and it persisted durably, so the rejection left no poisoned state');

    // Repeating it must stay request-scoped rather than escalating.
    assert((await createTicket(oversizedBody)).statusCode === 413,
      '4: repeating the oversized request stays request-scoped rather than escalating');
    assert(JSON.parse((await server.request('GET', '/health')).body).ready === true,
      '4: the process is still ready after repeated rejections');

    // ── 5. A GENUINE evidence-persistence failure is distinct and fails closed ─
    // The negative control for scenario 4, on the same surface. The injected failure is
    // narrowly scoped to one standalone evidence append — the path that goes through
    // the server's own `appendEvent` wrapper, where the latch lives — so this proves
    // containment behaviour rather than merely breaking the database.
    scenariosRun += 1;
    await store.pool.query(
      `CREATE OR REPLACE FUNCTION "${schema}".break_evidence() RETURNS trigger AS $$
       BEGIN
         IF NEW.type = 'run.postconditions_checked' THEN
           RAISE EXCEPTION 'injected evidence persistence failure';
         END IF;
         RETURN NEW;
       END; $$ LANGUAGE plpgsql;`);
    await store.pool.query(
      `CREATE TRIGGER break_evidence_trg BEFORE INSERT ON "${schema}".events
       FOR EACH ROW EXECUTE FUNCTION "${schema}".break_evidence();`);

    const workflowId = `record-limit-wf-${STAMP}`;
    await store.createWorkflow({
      value: {
        id: workflowId, name: 'Record limit containment', version: '1', enabled: true, inputSchema: {},
        actions: [
          { id: 'write', action: 'writeFile', input: { path: `record-limit-${STAMP}.txt`, content: 'hello' }, next: 'done' },
          { id: 'done', action: 'stop', input: { result: {} } }
        ],
        postconditions: [{ id: 'pc', type: 'fileContains', path: `record-limit-${STAMP}.txt`, contains: 'hello' }],
        verifierContract: null
      },
      changedBy: 'event-record-limit-containment-test'
    });

    const failing = await startServer({ env: { RUNTIME_SCHEDULER_INTERVAL_MS: '200' } });
    const failingCookie = await failing.login();
    assert(JSON.parse((await failing.request('GET', '/health')).body).ready === true,
      '5: the process starts ready, so the degradation below is caused by the injected failure');

    await failing.request('POST', '/tickets', {
      cookie: failingCookie,
      form: {
        objective: `record limit evidence failure ${STAMP}`,
        capabilityType: 'workflow', workflowId, workflowInput: '{}',
        assignmentTargetType: 'agent', assignmentTargetId: String(agent.id), assignmentMode: 'individual'
      }
    });

    const degraded = await waitFor(async () => {
      const response = await failing.request('GET', '/health');
      return response.statusCode !== 200 ? response : null;
    }, 45000, '5: the process to fail closed on an internal evidence-persistence failure');

    assert(degraded.statusCode === 503,
      `5: an internal evidence-persistence failure fails CLOSED (health HTTP ${degraded.statusCode})`);
    const degradedBody = JSON.parse(degraded.body);
    assert(degradedBody.ready === false && degradedBody.status === 'degraded',
      `5: and reports itself degraded rather than merely busy (${degraded.body})`);

    const afterLatch = await failing.request('POST', '/tickets', {
      cookie: failingCookie,
      form: {
        objective: `record limit after latch ${STAMP}`,
        assignmentTargetType: 'agent', assignmentTargetId: String(agent.id), assignmentMode: 'individual'
      }
    });
    assert(afterLatch.statusCode === 503,
      `5: later evidence-dependent work is REFUSED once latched (got ${afterLatch.statusCode})`);
    assert(afterLatch.statusCode !== 413,
      '5: and it is not reported as a client error — this failure is the system\'s, not the caller\'s');
    assert(!(await store.listTickets({ limit: 200 })).tickets
      .some(t => t.objective === `record limit after latch ${STAMP}`),
      '5: the refused work was not silently performed behind the degraded status');

    assertScenariosExecuted({
      label: 'event record limit containment',
      assertions: assert.count(),
      scenarios: scenariosRun,
      minAssertions: 26,
      minScenarios: 5
    });
    console.log(`\nPASS: event record limit containment — ${scenariosRun} scenarios, ${assert.count()} assertions (PostgreSQL-native)`);
  }, { schemaSlug: 'record_limit' });
}

main().catch(error => {
  console.error(`\nFAIL: event record limit containment — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
