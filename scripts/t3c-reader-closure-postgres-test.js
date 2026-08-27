#!/usr/bin/env node
'use strict';

// T3-c — immutable executed-intent READER closure owner.
//
// Proves post-admission production READERS consume each Run's immutable
// declared-work requested outcome {objective, acceptanceCriteria} rather than
// mutable current Ticket intent, through the real runtime seams:
//
//   1.  Run N retains objective N after Ticket revision N+1 (row + replay).
//   2.  Run N retains acceptanceCriteria N (declared ticket-authored criterion).
//   3.  New Run N+1 consumes objective/criteria N+1 (admission + live prompt).
//   4.  Interrupted replay of old Run remains N
//       (ensureInterruptedRunReplaySnapshot seam on a snapshot-less Run).
//   6.  createRunReplaySnapshot remains N.
//   7.  Changed post-admission behavioral readers observe Run-bound content:
//       completion evidence events carry each Run's OWN objective paths while
//       the model prompt itself was produced from the admitted projection.
//   8.  Missing / malformed post-T3 immutable authority FAILS CLOSED through
//       the stop boundary: missing declared work, malformed declared work, and
//       a PRESENT-but-malformed objectiveRevision pointer each refuse with no
//       fabricated replay evidence, no terminal state, and no legacy
//       historical-unavailable misclassification.
//   9.  Legacy Runs (no objectiveRevision) follow the recovered compatibility
//       rule: executed intent is historically unavailable; the interrupted
//       replay captures then-current Ticket intent at write time and never
//       re-reads it retroactively.
//  10.  Pre-admission/current-Ticket readers still see current intent
//       (the revision surface response reflects revised content).
//
// Provider-free: a NODE_OPTIONS preload stubs global.fetch with canned plans so
// real runs execute through runAgentTicket against a disposable PostgreSQL 17
// schema from scripts/postgres-test-harness.js.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withHarness, createAsserter } = require('./postgres-test-harness');

const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`;
const SCHEDULER_PAUSED_MS = '3600000';
const WAIT_TIMEOUT_MS = 90000;

let assertions = 0;
function ok(condition, message) {
  if (!condition) throw new Error(`T3-C FAILED: ${message}`);
  assertions += 1;
  console.log(`  ok ${message}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(fn, label, timeoutMs = WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(250);
  }
  throw new Error(`T3-C timed out waiting for ${label} (last=${JSON.stringify(last)})`);
}

async function latestRun(store, ticketId) {
  const page = await store.listRunsForTicket({ ticketId, limit: 50 });
  return page.runs.slice().sort((left, right) => right.id - left.id)[0] || null;
}

async function firstRun(store, ticketId) {
  const page = await store.listRunsForTicket({ ticketId, limit: 50 });
  return page.runs.slice().sort((left, right) => left.id - right.id)[0] || null;
}

// Run terminalization commits before its Ticket-attempt settlement. A caller
// that will consume the Ticket revision must first observe the exact Run's
// write-once attempt disposition, then read the Ticket afterwards so the row it
// returns is necessarily post-settlement. The disposition itself is not
// prescribed here: this fixture truthfully settles blocked.
async function waitForSettledTicketForRun(store, runId, label) {
  return waitFor(async () => {
    const run = await store.getRun(runId);
    if (!run || run.status !== 'completed') return null;

    const attempt = await store.getCurrentTicketAttempt(run.ticketId);
    if (!attempt || attempt.id !== run.ticketAttemptId ||
        attempt.disposition === null || attempt.settledAt === null) {
      return null;
    }

    const ticket = await store.getTicket(run.ticketId);
    if (!ticket) return null;
    return { run, attempt, ticket };
  }, label);
}

async function ticketByObjective(store, objective) {
  const page = await store.listTickets({ limit: 400 });
  return page.tickets.find(ticket => ticket.objective === objective) || null;
}

function declaredTextCriterion(snapshot) {
  const criterion = (snapshot.successCriteria || [])
    .find(item => item.kind === 'text' && item.provenance === 'ticket-authored');
  return criterion ? criterion.declaration : null;
}

// Reader-level proof: some durable replay event of this Run records the
// expected path inside the completion-evidence fields written by the changed
// readers (workspace.objective_satisfied -> objectivePaths,
//  run:postcondition_completed -> checkedPaths).
async function assertCompletionEvidenceMentionsPath(store, runId, expectedPath, label) {
  const hit = await waitFor(async () => {
    const record = await store.readRunReplay(runId);
    const events = record && record.snapshot && Array.isArray(record.snapshot.events)
      ? record.snapshot.events : [];
    return events.some(event =>
      (event.type === 'workspace.objective_satisfied' ||
       event.type === 'run:postcondition_completed') &&
      JSON.stringify(event).includes(expectedPath)) || null;
  }, `${label} completion evidence naming ${expectedPath}`);
  ok(Boolean(hit), `${label}: completion reader observed Run-bound path ${expectedPath}`);
}

async function replaySnapshotOrThrow(store, runId, label) {
  const record = await store.readRunReplay(runId);
  ok(record && record.snapshot, `${label}: replay snapshot exists`);
  return record.snapshot;
}

async function createPendingTicket(server, store, objective, criteria, agentId) {
  const cookie = await server.login();
  const response = await server.request('POST', '/tickets', {
    cookie,
    form: {
      objective,
      acceptanceCriteria: criteria,
      assignmentTargetType: 'agent',
      assignmentTargetId: String(agentId),
      assignmentMode: 'individual'
    }
  });
  if (response.statusCode !== 302) {
    throw new Error(`ticket creation failed (${response.statusCode}): ${response.body.slice(0, 300)}`);
  }
  const ticket = await ticketByObjective(store, objective);
  if (!ticket) throw new Error('created ticket not found');
  const run = await firstRun(store, ticket.id);
  if (!run) throw new Error('creation auto-admitted no Run');
  return { cookie, ticket, run };
}

async function main() {
  const preloadPath = path.join(os.tmpdir(), `t3c-openai-stub-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
function t3cOk(plan) {
  return {
    ok: true, status: 200,
    headers: new Map([['x-request-id', 't3c-reader-closure']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify(plan),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
}
global.fetch = async function(_url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const combined = (Array.isArray(body.input) ? body.input : [])
    .map(item => item && item.content ? String(item.content) : '').join('\\n');
  const marker = combined.match(/T3C-MARKER-(OLD|NEW)-[a-z0-9]+/);
  if (marker) {
    const branch = marker[1].toLowerCase();
    return t3cOk({
      message: 'Writing the requested file.',
      actions: [{ operation: 'writeFile', args: { path: 't3c' + branch + '-${STAMP}.txt', content: branch + 'evidence' } }],
      complete: false
    });
  }
  return t3cOk({ message: 'No T3-c marker in prompt.', actions: [], complete: false });
};
`);

  const assert = createAsserter();

  await withHarness('t3c reader closure postgres', async ({ store, schema, startServer }) => {
    const agent = (await store.createConfiguredAgent({
      value: { name: `T3C Runner ${STAMP}`, provider: 'openai', model: 'gpt-test', apiKey: 'test-key' },
      groupIds: [],
      changedBy: 't3c-reader-closure-postgres-test'
    })).agent;

    const oldObjective = `T3C-MARKER-OLD-${STAMP} create file t3cold-${STAMP}.txt containing exactly oldevidence`;
    const oldCriteria = `Old criteria ${STAMP}.`;
    const newObjective = `T3C-MARKER-NEW-${STAMP} create file t3cnew-${STAMP}.txt containing exactly newevidence`;
    const newCriteria = `New criteria ${STAMP}.`;

    // ══ Phase 1: live execution server ════════════════════════════════════
    const live = await startServer({ env: {
      TEST_SKIP_STARTUP_RUN_RECOVERY: 'true',
      RUNTIME_SCHEDULER_INTERVAL_MS: '500',
      NODE_OPTIONS: `--require ${preloadPath}`
    } });
    const adminCookie = await live.login();

    // ── S1: admission identity + createRunReplaySnapshot reader ──────────
    console.log('  ── S1: Run N admission identity + initial replay reader');
    const seeded = await createPendingTicket(live, store, oldObjective, oldCriteria, agent.id);
    const runN = seeded.run;
    ok(runN.objectiveRevision && runN.objectiveRevision.number === 1,
      'S1: Run N is stamped with objectiveRevision 1');
    ok(runN.declaredWorkSnapshot &&
       runN.declaredWorkSnapshot.objective.text === oldObjective,
      'S1: Run N declared work carries objective N');
    ok(declaredTextCriterion(runN.declaredWorkSnapshot) === oldCriteria,
      'S1: Run N declared work carries acceptanceCriteria N');

    const replayN = await waitFor(async () => {
      const record = await store.readRunReplay(runN.id);
      return record && record.snapshot ? record.snapshot : null;
    }, 'S1 initial replay snapshot');
    ok(replayN.ticketObjectiveSnapshot === oldObjective,
      'S1: createRunReplaySnapshot wrote the immutable objective N');
    ok(replayN.declaredWorkSnapshot &&
       replayN.declaredWorkSnapshot.contractHash === runN.declaredWorkSnapshot.contractHash,
      'S1: replay carries the Run declared-work contract hash');
    const settledN = await waitForSettledTicketForRun(
      store, runN.id, 'S1 Run N durable attempt/Ticket settlement');
    await assertCompletionEvidenceMentionsPath(store, runN.id, `t3cold-${STAMP}.txt`, "S1 Run N");

    // ── S2/S3: revision N+1; new Run consumes NEW; old Run unchanged ──────
    console.log('  ── S2: revision N+1 and new-Run consumption');
    const beforeRevisionRunRow = JSON.parse(JSON.stringify(
      (await store.getRun(runN.id)).declaredWorkSnapshot));
    const beforeRevisionReplay = JSON.parse(JSON.stringify(replayN));

    const currentTicket = settledN.ticket;
    const revised = await store.reviseTicketObjective({
      ticketId: seeded.ticket.id,
      expectedRevision: Number(currentTicket.revision),
      objective: newObjective,
      acceptanceCriteria: newCriteria,
      reasonCode: 'clarification',
      reason: 'T3-c reader closure scenario',
      actor: 't3c-reader-closure-postgres-test'
    });
    ok(revised.objectiveRevision.number === 2, 'S2: Ticket revised to revision 2');
    ok(revised.ticket.objective === newObjective && revised.ticket.acceptanceCriteria === newCriteria,
      'S2: current-Ticket/pre-admission readers see revised intent (surface truth)');

    const rerunResponse = await live.request(
      'POST', `/api/tickets/${seeded.ticket.id}/rerun`, { cookie: adminCookie, body: {} });
    ok(rerunResponse.statusCode === 200, `rerun accepted (${rerunResponse.statusCode})`);
    const runN1 = await latestRun(store, seeded.ticket.id);
    ok(runN1.id !== runN.id, 'S2: rerun admitted a NEW Run');
    ok(runN1.objectiveRevision && runN1.objectiveRevision.number === 2,
      'S2: Run N+1 binds objectiveRevision 2');
    ok(runN1.declaredWorkSnapshot.objective.text === newObjective,
      'S2: Run N+1 declared work carries objective N+1');
    ok(declaredTextCriterion(runN1.declaredWorkSnapshot) === newCriteria,
      'S2: Run N+1 declared work carries acceptanceCriteria N+1');
    const replayN1 = await waitFor(async () => {
      const record = await store.readRunReplay(runN1.id);
      return record && record.snapshot ? record.snapshot : null;
    }, 'S2 rerun replay snapshot');
    ok(replayN1.ticketObjectiveSnapshot === newObjective,
      'S2: Run N+1 replay snapshot carries objective N+1');
    await waitFor(() => store.getRun(runN1.id).then(run => run && run.status === 'completed' ? run : null),
      'S2 Run N+1 completion');
    await assertCompletionEvidenceMentionsPath(store, runN1.id, `t3cnew-${STAMP}.txt`, "S2 Run N+1");

    // Old Run row + replay remain byte-exact AFTER the revision and rerun.
    const runNAfter = await store.getRun(runN.id);
    ok(JSON.stringify(runNAfter.declaredWorkSnapshot) === JSON.stringify(beforeRevisionRunRow),
      'S3: Run N declared work byte-exact after revision N+1 and rerun');
    const replayNAfter = await store.readRunReplay(runN.id);
    ok(replayNAfter.snapshot.ticketObjectiveSnapshot === beforeRevisionReplay.ticketObjectiveSnapshot,
      'S3: Run N replay objective still N after revision N+1');

    await live.stop();

    // ══ Phase 2: paused scheduler server for pending-Run scenarios ═══════
    const paused = await startServer({ env: {
      TEST_SKIP_STARTUP_RUN_RECOVERY: 'true',
      RUNTIME_SCHEDULER_INTERVAL_MS: SCHEDULER_PAUSED_MS
    } });
    const pausedCookie = await paused.login();

    // ── S4: interrupted replay of a snapshot-less pending Run stays N ─────
    console.log('  ── S4: interrupted replay binds executed intent');
    const intObjective = `T3C-INT-${STAMP} Create folder t3cint-${STAMP}`;
    const intCriteria = `Interrupted criteria ${STAMP}.`;
    const intSeed = await createPendingTicket(paused, store, intObjective, intCriteria, agent.id);
    ok(intSeed.run.status === 'pending', 'S4: auto-admitted Run is pending under paused scheduler');
    ok(!(await store.readRunReplay(intSeed.run.id)),
      'S4: pending Run has no replay snapshot before interruption');

    const stopResponse = await paused.request(
      'POST', `/api/runs/${intSeed.run.id}/stop`, { cookie: pausedCookie, body: {} });
    ok(stopResponse.statusCode === 200, `operator stop accepted (${stopResponse.body.slice(0, 200)})`);
    const interruptedReplay = await replaySnapshotOrThrow(store, intSeed.run.id, 'S4');
    ok(interruptedReplay.ticketObjectiveSnapshot === intObjective,
      'S4: ensureInterruptedRunReplaySnapshot captured executed objective N');
    ok(interruptedReplay.declaredWorkSnapshot &&
       interruptedReplay.declaredWorkSnapshot.contractHash ===
         intSeed.run.declaredWorkSnapshot.contractHash,
      'S4: interrupted replay carries the Run immutable declared work');

    const intCurrent = await store.getTicket(intSeed.ticket.id);
    const intRevised = await store.reviseTicketObjective({
      ticketId: intSeed.ticket.id,
      expectedRevision: Number(intCurrent.revision),
      objective: `T3C-INT2-${STAMP} Revised far away objective`,
      acceptanceCriteria: `Revised interrupted criteria ${STAMP}.`,
      reasonCode: 'correction',
      reason: 'T3-c interrupted-replay isolation scenario',
      actor: 't3c-reader-closure-postgres-test'
    });
    ok(intRevised.objectiveRevision.number === 2, 'S4: Ticket revised after interruption');
    const interruptedReplayAfterRevision = await store.readRunReplay(intSeed.run.id);
    ok(interruptedReplayAfterRevision.snapshot.ticketObjectiveSnapshot === intObjective,
      'S4: interrupted replay STILL objective N after Ticket moved to N+1');

    // ── S5: missing post-T3 authority fails closed at the stop boundary ───
    console.log('  ── S5: missing immutable authority refuses (fail closed)');
    const missObjective = `T3C-MISS-${STAMP} Create folder t3cmiss-${STAMP}`;
    const missSeed = await createPendingTicket(paused, store, missObjective, `Missing criteria ${STAMP}.`, agent.id);
    await store.pool.query(
      `UPDATE "${schema}".runs
          SET body = body - 'declaredWorkSnapshot', revision = revision + 1
        WHERE id = $1`,
      [missSeed.run.id]);
    const missStop = await paused.request(
      'POST', `/api/runs/${missSeed.run.id}/stop`, { cookie: pausedCookie, body: {} });
    ok(missStop.statusCode >= 400,
      `S5: stop refused for revision-bound Run without declared work (${missStop.statusCode})`);
    ok((missStop.body || '').includes('DECLARED_WORK_AUTHORITY_REQUIRED'),
      'S5: refusal surfaces the declared-work integrity code');
    const missRunAfter = await store.getRun(missSeed.run.id);
    ok(missRunAfter.status === 'pending',
      'S5: refused Run was NOT terminalized behind fabricated evidence');
    ok(!(await store.readRunReplay(missSeed.run.id)),
      'S5: NO replay snapshot was fabricated from current Ticket intent');

    // ── S6: malformed post-T3 authority fails closed ──────────────────────
    console.log('  ── S6: malformed immutable authority refuses (fail closed)');
    const badObjective = `T3C-BAD-${STAMP} Create folder t3cbad-${STAMP}`;
    const badSeed = await createPendingTicket(paused, store, badObjective, `Bad criteria ${STAMP}.`, agent.id);
    await store.pool.query(
      `UPDATE "${schema}".runs
          SET body = jsonb_set(body, '{declaredWorkSnapshot,contractHash}',
                               to_jsonb($2::text), true), revision = revision + 1
        WHERE id = $1`,
      [badSeed.run.id, 'f'.repeat(64)]);
    const badStop = await paused.request(
      'POST', `/api/runs/${badSeed.run.id}/stop`, { cookie: pausedCookie, body: {} });
    ok(badStop.statusCode >= 400,
      `S6: stop refused for malformed declared-work hash (${badStop.statusCode})`);
    ok(!(await store.readRunReplay(badSeed.run.id)),
      'S6: NO replay snapshot was fabricated from malformed authority');
    const badRunAfter = await store.getRun(badSeed.run.id);
    ok(badRunAfter.status === 'pending', 'S6: malformed-authority Run not terminalized');

    // ── S6b: present-but-malformed objectiveRevision is corruption, not legacy
    console.log('  ── S6b: malformed revision authority refuses (fail closed)');
    const badRevObjective = `T3C-BADREV-${STAMP} Create folder t3cbadrev-${STAMP}`;
    const badRevSeed = await createPendingTicket(
      paused, store, badRevObjective, `Bad revision criteria ${STAMP}.`, agent.id);
    // The exact bypass shape found in review: the pointer is PRESENT but cannot
    // represent valid revision authority while declared work is absent. The old
    // presence heuristic treated this as a pre-T3 legacy Run and fabricated
    // replay evidence from current Ticket intent.
    await store.pool.query(
      `UPDATE "${schema}".runs
          SET body = jsonb_set(body - 'declaredWorkSnapshot',
                               '{objectiveRevision}', to_jsonb($2::jsonb), true),
              revision = revision + 1
        WHERE id = $1`,
      [badRevSeed.run.id, JSON.stringify({ number: 'two' })]);
    const badRevStop = await paused.request(
      'POST', `/api/runs/${badRevSeed.run.id}/stop`, { cookie: pausedCookie, body: {} });
    ok(badRevStop.statusCode >= 400,
      `S6b: stop refused for malformed revision authority (${badRevStop.statusCode})`);
    ok((badRevStop.body || '').includes('DECLARED_WORK_REVISION_AUTHORITY_MALFORMED'),
      'S6b: refusal surfaces the malformed-revision-authority integrity code');
    ok(!(await store.readRunReplay(badRevSeed.run.id)),
      'S6b: NO replay snapshot was fabricated from current Ticket intent');
    const badRevRunAfter = await store.getRun(badRevSeed.run.id);
    ok(badRevRunAfter.status === 'pending',
      'S6b: corrupted Run NOT terminalized behind fabricated evidence');
    ok(!((badRevStop.body || '').includes('historical-unavailable')),
      'S6b: malformed authority NOT reported as legacy historical-unavailable');

    // ── S7: legacy Run compatibility rule ─────────────────────────────────
    console.log('  ── S7: legacy Run (no objectiveRevision) compatibility rule');
    const legacyObjective = `T3C-LEGACY-${STAMP} Create folder t3clegacy-${STAMP}`;
    const legacySeed = await createPendingTicket(
      paused, store, legacyObjective, `Legacy criteria ${STAMP}.`, agent.id);
    await store.pool.query(
      `UPDATE "${schema}".runs
          SET body = body - 'declaredWorkSnapshot' - 'objectiveRevision',
              revision = revision + 1
        WHERE id = $1`,
      [legacySeed.run.id]);
    const legacyStop = await paused.request(
      'POST', `/api/runs/${legacySeed.run.id}/stop`, { cookie: pausedCookie, body: {} });
    ok(legacyStop.statusCode === 200,
      `S7: legacy Run interruption succeeds through compatibility rule (${legacyStop.body.slice(0, 200)})`);
    const legacyReplay = await replaySnapshotOrThrow(store, legacySeed.run.id, 'S7');
    ok(legacyReplay.ticketObjectiveSnapshot === legacyObjective,
      'S7: legacy interrupted replay captured then-current Ticket intent');
    ok(legacyReplay.declaredWorkSnapshot === null &&
       legacyReplay.declaredWorkAvailability === 'historical-unavailable',
      'S7: legacy replay marks executed intent historically unavailable');

    const legacyCurrent = await store.getTicket(legacySeed.ticket.id);
    await store.reviseTicketObjective({
      ticketId: legacySeed.ticket.id,
      expectedRevision: Number(legacyCurrent.revision),
      objective: `T3C-LEGACY2-${STAMP} Revised legacy objective`,
      acceptanceCriteria: `Revised legacy criteria ${STAMP}.`,
      reasonCode: 'correction',
      reason: 'T3-c legacy compatibility scenario',
      actor: 't3c-reader-closure-postgres-test'
    });
    const legacyReplayAfterRevision = await store.readRunReplay(legacySeed.run.id);
    ok(legacyReplayAfterRevision.snapshot.ticketObjectiveSnapshot === legacyObjective,
      'S7: legacy replay is write-once; later revisions never rewrite it');

    await paused.stop();
    fs.rmSync(preloadPath, { force: true });

    console.log(`\nPASS: T3-c reader closure — ${assertions} assertions`);
  }, { schemaSlug: 't3c_reader_closure' });
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
