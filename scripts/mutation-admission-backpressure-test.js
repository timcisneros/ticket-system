#!/usr/bin/env node
'use strict';
// Mutation admission backpressure and recovery — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// Replaces the JSON-era `event-journal-admission-recovery-test.js`, which drove a
// `.sync-control` file to stall `FileHandle.sync()` on `events.jsonl`. That mechanism is
// gone; the contract it guarded is live under PostgreSQL names —
// `EVENT_ADMISSION_BACKPRESSURED` became `MUTATION_ADMISSION_BACKPRESSURED`, and the
// journal metrics became `mutationAdmission.getMetrics()`.
//
// THE LOAD-BEARING DISTINCTION, and it is the mirror of the one in
// `event-record-limit-containment-test.js` on the admission side rather than the append
// side. Two refusals share a status code and mean opposite things:
//
//   BACKPRESSURE (503, `MUTATION_ADMISSION_BACKPRESSURED`, `Retry-After: 1`)
//     The deployment is healthy and momentarily full. The caller should retry. Work is
//     refused BEFORE any side effect, and capacity returns on its own.
//
//   LATCHED FAILURE (503, `EVENT_PERSISTENCE_UNAVAILABLE`, no Retry-After)
//     The deployment cannot record evidence. Retrying is futile and the operator needs
//     to intervene. Recovery is not automatic.
//
// Telling an operator to "retry after 1 second" when the deployment needs a restart is
// the failure this suite exists to prevent — and the reverse, treating momentary
// fullness as a fatal outage, would take down a healthy system under load. The runtime
// checks the fatal condition FIRST, and scenario 6 pins that precedence.
//
// CAPACITY IS SET THROUGH THE EXISTING `MUTATION_ADMISSION_MAX_OUTSTANDING` ENV, which
// production already exposes. No configuration surface was added to make this testable
// — contrast the record-size limit, which is not env-configurable and is therefore
// covered directly at the store (see A20).
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const { withHarness, createAsserter } = require('./postgres-test-harness');
const { assertScenariosExecuted } = require('./child-process-settlement');

const STAMP = Date.now();
const assert = createAsserter();
let scenariosRun = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function parse(body) {
  try { return JSON.parse(body); } catch (_) { return {}; }
}

async function main() {
  await withHarness('mutation admission backpressure', async ({ store, startServer, schema }) => {
    const agent = (await store.createConfiguredAgent({
      value: { name: `Admission-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'k' },
      groupIds: [], changedBy: 'mutation-admission-backpressure-test'
    })).agent;

    // Capacity of one: any genuine overlap must be refused. The scheduler is idled so
    // admission pressure comes from this suite's own requests and nothing else.
    const server = await startServer({ env: {
      MUTATION_ADMISSION_MAX_OUTSTANDING: '1',
      RUNTIME_SCHEDULER_INTERVAL_MS: '3600000'
    } });
    const cookie = await server.login();

    const createTicket = objective => server.request('POST', '/tickets', {
      cookie,
      form: {
        objective,
        assignmentTargetType: 'agent', assignmentTargetId: String(agent.id), assignmentMode: 'individual'
      }
    });
    const ticketExists = async objective =>
      ((await store.listTickets({ limit: 300 })).tickets || []).some(t => t.objective === objective);

    // ── 1. POSITIVE CONTROL — ordinary work is admitted and persists ────────
    // Everything below is a refusal assertion, and a server that refused every mutation
    // would satisfy all of them. This is what makes them mean something.
    scenariosRun += 1;
    const baseline = `admission baseline ${STAMP}`;
    const admitted = await createTicket(baseline);
    assert(admitted.statusCode === 302,
      `1: an uncontended evidence-dependent mutation is admitted (HTTP ${admitted.statusCode})`);
    assert(await waitFor(() => ticketExists(baseline), 15000, '1: the baseline ticket'),
      '1: and it actually persisted');

    // ── 2. Genuine overlap is refused, recoverably and before side effects ──
    scenariosRun += 1;
    const burst = Array.from({ length: 14 }, (_, index) => `admission burst ${index} ${STAMP}`);
    const responses = await Promise.all(burst.map(createTicket));

    const refusals = responses.filter(response => response.statusCode === 503);
    assert(refusals.length > 0,
      `2: concurrent work beyond capacity is refused (${responses.filter(r => r.statusCode === 302).length} admitted, 0 refused)`);
    assert(refusals.every(response => parse(response.body).code === 'MUTATION_ADMISSION_BACKPRESSURED'),
      `2: every refusal carries the RECOVERABLE admission code, not a fatal one ` +
      `(${[...new Set(refusals.map(r => parse(r.body).code))].join(', ')})`);
    assert(refusals.every(response => response.headers['retry-after'] === '1'),
      '2: every refusal tells the caller to retry, which is what makes it recoverable');
    assert(responses.some(response => response.statusCode === 302),
      '2: capacity was not simply closed — admitted work still got through');

    // ── 3. A refused mutation left NO state behind ──────────────────────────
    // Refusal happens in the onRequest hook, before any handler runs. If a refused
    // objective existed, the request would have been admitted and then reported as
    // refused — the worst possible outcome, since the caller would retry and duplicate.
    scenariosRun += 1;
    const refusedObjectives = burst.filter((_, index) => responses[index].statusCode === 503);
    const admittedObjectives = burst.filter((_, index) => responses[index].statusCode === 302);
    await sleep(500);
    const leaked = [];
    for (const objective of refusedObjectives) {
      if (await ticketExists(objective)) leaked.push(objective);
    }
    assert(leaked.length === 0,
      `3: refused mutations changed no state (${leaked.length} of ${refusedObjectives.length} leaked)`);
    const lost = [];
    for (const objective of admittedObjectives) {
      if (!await ticketExists(objective)) lost.push(objective);
    }
    assert(lost.length === 0,
      `3: admitted mutations were not lost to the pressure (${lost.length} of ${admittedObjectives.length} lost)`);

    // ── 4. Capacity returns on its own — no restart, no operator action ─────
    scenariosRun += 1;
    const afterDrain = `admission after drain ${STAMP}`;
    const recovered = await waitFor(async () => {
      const response = await createTicket(afterDrain);
      return response.statusCode === 302 ? response : null;
    }, 20000, '4: admission to recover after the burst drains');
    assert(recovered.statusCode === 302,
      '4: mutation admission resumes automatically once producers finish');
    assert(await waitFor(() => ticketExists(afterDrain), 15000, '4: the post-recovery ticket'),
      '4: and post-recovery work persists normally');

    const health = await server.request('GET', '/health');
    assert(health.statusCode === 200 && parse(health.body).ready === true,
      `4: the deployment reports itself healthy again (${health.statusCode} ${health.body})`);

    // ── 5. Backpressure is scoped to evidence-dependent mutations ───────────
    // Only routes declaring `config.mutationAdmission` are gated. Session login and
    // read-only diagnostics must survive pressure, or an operator loses the ability to
    // log in and inspect a system precisely when it is under load.
    scenariosRun += 1;
    const underPressure = burst.map(objective => createTicket(`${objective} second wave`));
    const loginDuringPressure = await server.request('POST', '/login', {
      form: { username: 'admin', password: 'admin123' }
    });
    const diagnosticsDuringPressure = await server.request('GET', '/api/runtime/status', { cookie });
    await Promise.all(underPressure);

    assert(loginDuringPressure.statusCode === 302,
      `5: session login is not classified as evidence-dependent work (HTTP ${loginDuringPressure.statusCode})`);
    assert(diagnosticsDuringPressure.statusCode === 200,
      `5: read-only diagnostics stay available under pressure (HTTP ${diagnosticsDuringPressure.statusCode})`);
    const metrics = parse(diagnosticsDuringPressure.body).mutationAdmission;
    assert(metrics && metrics.role === 'mutation_admission',
      '5: diagnostics expose the admission controller');
    assert(metrics.backend === 'postgres',
      `5: and report the PostgreSQL backend rather than a journal (${metrics.backend})`);
    assert(metrics.current && Number.isInteger(metrics.current.outstanding) &&
           Number.isInteger(metrics.current.availableSlots),
      '5: the bounded reservation is observable, not merely a boolean');
    assert(metrics.status === 'available' || metrics.status === 'backpressured',
      `5: the controller reports a live status (${metrics.status})`);

    // ── 6. THE DISTINCTION — a latched failure is NOT reported as backpressure ─
    // The negative control for every assertion above. Both refusals are 503; conflating
    // them tells an operator to retry in one second when the deployment needs a restart.
    // The runtime checks the fatal condition first, and this pins that precedence.
    scenariosRun += 1;
    await store.pool.query(
      `CREATE OR REPLACE FUNCTION "${schema}".break_admission_evidence() RETURNS trigger AS $$
       BEGIN
         IF NEW.type = 'run.postconditions_checked' THEN
           RAISE EXCEPTION 'injected evidence persistence failure';
         END IF;
         RETURN NEW;
       END; $$ LANGUAGE plpgsql;`);
    await store.pool.query(
      `CREATE TRIGGER break_admission_evidence_trg BEFORE INSERT ON "${schema}".events
       FOR EACH ROW EXECUTE FUNCTION "${schema}".break_admission_evidence();`);

    const workflowId = `admission-wf-${STAMP}`;
    await store.createWorkflow({
      value: {
        id: workflowId, name: 'Admission latch', version: '1', enabled: true, inputSchema: {},
        actions: [
          { id: 'write', action: 'writeFile', input: { path: `admission-${STAMP}.txt`, content: 'x' }, next: 'done' },
          { id: 'done', action: 'stop', input: { result: {} } }
        ],
        postconditions: [{ id: 'pc', type: 'fileContains', path: `admission-${STAMP}.txt`, contains: 'x' }],
        verifierContract: null
      },
      changedBy: 'mutation-admission-backpressure-test'
    });

    // DEFAULT capacity here on purpose. Scenario 6 is about which CODE a refusal
    // carries, so the latched server must not also be under admission pressure — with
    // capacity 1 the health probe below caught `backpressured` before the latch landed,
    // which is precisely the confusion this scenario exists to rule out.
    const latched = await startServer({ env: { RUNTIME_SCHEDULER_INTERVAL_MS: '200' } });
    const latchedCookie = await latched.login();
    assert(parse((await latched.request('GET', '/health')).body).ready === true,
      '6: the second server starts healthy, so the degradation below is caused by the injection');

    await latched.request('POST', '/tickets', {
      cookie: latchedCookie,
      form: {
        objective: `admission latch trigger ${STAMP}`,
        capabilityType: 'workflow', workflowId, workflowInput: '{}',
        assignmentTargetType: 'agent', assignmentTargetId: String(agent.id), assignmentMode: 'individual'
      }
    });

    // Wait for DEGRADED specifically. "Any non-200" would accept transient
    // backpressure and prove nothing about the latch.
    const degraded = await waitFor(async () => {
      const response = await latched.request('GET', '/health');
      return parse(response.body).status === 'degraded' ? response : null;
    }, 45000, '6: the deployment to latch on the injected evidence failure');
    const degradedBody = parse(degraded.body);
    assert(degradedBody.status === 'degraded',
      `6: a latched deployment reports DEGRADED, not backpressured (${degraded.body})`);
    assert(degradedBody.status !== 'backpressured',
      '6: momentary fullness and permanent failure are never conflated in health');

    const refusedAfterLatch = await latched.request('POST', '/tickets', {
      cookie: latchedCookie,
      form: {
        objective: `admission after latch ${STAMP}`,
        assignmentTargetType: 'agent', assignmentTargetId: String(agent.id), assignmentMode: 'individual'
      }
    });
    assert(refusedAfterLatch.statusCode === 503,
      `6: work is refused once latched (HTTP ${refusedAfterLatch.statusCode})`);
    assert(parse(refusedAfterLatch.body).code === 'EVENT_PERSISTENCE_UNAVAILABLE',
      `6: the refusal carries the FATAL code, not the recoverable one ` +
      `(${parse(refusedAfterLatch.body).code})`);
    assert(refusedAfterLatch.headers['retry-after'] === undefined,
      '6: and does NOT tell the caller to retry — retrying a latched deployment is futile');
    assert(!await ticketExists(`admission after latch ${STAMP}`),
      '6: the refused work was not silently performed behind the degraded status');

    // Provenance must name the operation, so the outage is diagnosable.
    const latchedStatus = await latched.request('GET', '/api/runtime/status', { cookie: latchedCookie });
    assert(latchedStatus.statusCode === 200,
      '6: diagnostics remain readable when latched, or the outage cannot be investigated');
    const persistence = parse(latchedStatus.body).eventPersistence;
    assert(persistence && persistence.latched === true && persistence.firstFailure,
      '6: the latch records which operation caused it');
    assert(persistence.firstFailure.channel === 'event_append' &&
           typeof persistence.firstFailure.code === 'string',
      `6: with a channel and a PostgreSQL code (${JSON.stringify(persistence.firstFailure && persistence.firstFailure.channel)})`);

    assertScenariosExecuted({
      label: 'mutation admission backpressure',
      assertions: assert.count(),
      scenarios: scenariosRun,
      minAssertions: 24,
      minScenarios: 6
    });
    console.log(`\nPASS: mutation admission backpressure — ${scenariosRun} scenarios, ${assert.count()} assertions (PostgreSQL-native)`);
  }, { schemaSlug: 'admission_pressure' });
}

main().catch(error => {
  console.error(`\nFAIL: mutation admission backpressure — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
