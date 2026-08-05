#!/usr/bin/env node
'use strict';

// Tranche 5 — a Run whose transcript is corrupt fails once and stays failed.
//
// THE FAILURE PATH MUST NOT DEPEND ON THE THING THAT FAILED. The ordinary
// terminalization path reconstructs a Run's replay, consequence and completion
// decision. For a Run whose replay snapshot fails its integrity check that is
// impossible: recording the failure re-read the corruption, threw the same
// error, escaped to the scheduler, and the Run was reclaimed and failed
// identically — 38 times in one window before this. A Run could not be recorded
// as failed BECAUSE its transcript was broken.
//
// The corruption here is introduced deliberately, advancing the replay revision
// so the database accepts the write and the canonical integrity check — not the
// revision trigger — is what rejects it. That is the one place a suite in this
// tranche writes durable state, and it is the scenario rather than a shortcut:
// this state cannot be produced through any supported path.
//
// The corrupted snapshot is asserted to survive UNCHANGED. It is the evidence of
// what happened, and a synthetic healthy replacement would erase it.
//
// The lifecycle suite proves that complete request-1 evidence authorizes a
// second governed request. This proves that authority is a HISTORICAL FACT
// reconstructed from durable rows, not an in-flight decision that a restart can
// lose or repeat.
//
// Both failure directions cost real money. Lose it, and a Run that genuinely
// advanced stops as though it had churned. Repeat it, and every crash buys
// another provider request against the same earned progress — an unbounded
// spend that looks like normal operation from every surface.
//
// So the interruption lands exactly between durable request-1 evidence and any
// request-2 authority, and the scenario then restarts twice.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const {
  countDelta,
  durableTerminalCounts,
  waitForSchedulerQuiescence
} = require('./fixtures/terminal-projection-restart');
const {
  seedGovernedStructuredTicket,
  progressControlPolicy
} = require('./governed-structured-fixture');
const { eligibleExecutionFacts } = require('../runtime/governed-eligible-facts');

const STAMP = `gci-${Date.now()}`;
const ACTOR = 'governed-replay-corruption-test';
const HERMETIC = path.join(__dirname, 'fixtures', 'hermetic-governed-transport-preload.js');
const FAULT = path.join(__dirname, 'fixtures', 'governed-fault-injection-preload.js');
const SENTINEL = 'test-only-sentinel-not-a-real-credential';
// DISCRIMINATE THE LEAF, NOT THE FOLDER. The planner Run's own governed request
// also names `reports/planner` — it is that item's owned output path — so
// matching the root alone lets a planner request be counted as this Run's
// transport, and lets the planner consume a response staged for the leaf. The
// leaf's declared postcondition path appears only in the leaf's prompt.
const OWNED_ROOT = 'reports/planner';
const LEAF_MARKER = 'reports/planner/alpha';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const LIMITS = {
  maxExecutionSteps: 8,
  // EXACTLY TWO, because this Run genuinely makes exactly two requests. The
  // crashed attempt's replayed turn is not a third: it is request 1 again,
  // already counted from durable evidence. Sitting exactly on the ceiling is
  // deliberate — it is what makes double-counting the replayed turn fail here
  // rather than pass unnoticed with headroom to absorb it.
  maxModelRequestsPerRun: 2,
  maxWorkspaceOperationsPerRun: 40,
  maxRuntimeDurationMs: 600_000,
  maxAttempts: 3,
  maxProcessOperationsPerRun: 5,
  maxBrowserOperationsPerRun: 5,
  maxOutputArtifactBytes: 1_048_576,
  maxOutputArtifactBytesPerRun: 1_048_576
};

function staged(identity, plan) {
  return {
    match: LEAF_MARKER,
    statusCode: 200,
    body: JSON.stringify({
      id: identity,
      output_text: JSON.stringify(plan),
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    })
  };
}

async function main() {
  await withHarness('governed replay corruption containment',
    async ({ store, workspaceRoot, startServer }) => {
      const assertThat = createAsserter();

      const seeded = await seedGovernedStructuredTicket(store, {
        stamp: STAMP,
        actor: ACTOR,
        workspaceRoot,
        agentApiKey: SENTINEL,
        runtimeLimits: LIMITS,
        ticketObjective:
          'Create folders reports/planner/alpha and reports/planner/beta',
        progressPolicy: progressControlPolicy({
          maximumConsecutiveNoProgressWindows: 1
        }),
        leafPostconditions: (item, owned) => [
          { type: 'folder_exists', path: `${owned}/alpha` },
          { type: 'folder_exists', path: `${owned}/beta` }
        ]
      });
      const runId = seeded.runIds[0];
      const run = await store.getRun(runId);
      const facts = eligibleExecutionFacts(run);
      const factA = facts.find(f => f.criterion.path.endsWith('/alpha'));
      const factB = facts.find(f => f.criterion.path.endsWith('/beta'));
      fs.mkdirSync(path.join(workspaceRoot, OWNED_ROOT), { recursive: true });

      const tmp = suffix => path.join(os.tmpdir(), `gci-${suffix}-${process.pid}-${STAMP}`);
      const capturePath = tmp('cap');
      const responsePath = tmp('res');
      const markerPath = tmp('marker');
      const statePath = tmp('state');
      const servedPath = tmp('served');
      fs.writeFileSync(capturePath, '');
      fs.writeFileSync(markerPath, '');
      fs.writeFileSync(responsePath, JSON.stringify({
        responses: [
          staged('fixture-restart-response-1', {
            message: 'Creating the first declared folder.',
            actions: [{ operation: 'createFolder', args: { path: factA.criterion.path } }],
            complete: false
          }),
          staged('fixture-restart-response-2', {
            message: 'Creating the second declared folder.',
            actions: [{ operation: 'createFolder', args: { path: factB.criterion.path } }],
            complete: true
          })
        ]
      }));

      const env = {
        NODE_OPTIONS: `--require ${HERMETIC} --require ${FAULT}`,
        OPENAI_API_KEY: SENTINEL,
        HERMETIC_TRANSPORT_CAPTURE: capturePath,
        HERMETIC_TRANSPORT_RESPONSE: responsePath,
        HERMETIC_TRANSPORT_SERVED: servedPath,
        GOVERNED_FAULT_MARKER: markerPath,
        GOVERNED_FAULT_STATE: statePath,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        // Short, so the crashed Run's lease expires promptly and the real
        // recovery path can reclaim it within the scenario.
        RUN_LEASE_DURATION_MS: '4000'
      };

      const capturesForRun = () => fs.readFileSync(capturePath, 'utf8').trim()
        .split('\n').filter(Boolean).map(line => JSON.parse(line))
        .filter(entry => String(entry.body || '').includes(LEAF_MARKER));
      const chargesOf = async () => (await store.pool.query(
        `SELECT source_identity, state FROM ${store.table('run_budget_charges')}
          WHERE run_id = $1 AND dimension = 'model_request' ORDER BY id`, [runId])).rows;
      const economicOf = async () => (await store.pool.query(
        `SELECT logical_source_identity, model_request_ordinal
           FROM ${store.table('economic_request_reservations')}
          WHERE run_id = $1 ORDER BY id`, [runId])).rows;
      const replayOf = async () => {
        const replay = await store.readRunReplay(runId);
        return (replay && replay.snapshot) || {};
      };

      // ── Server 1: interrupted after request-1 evidence, before request 2 ──
      const first = await startServer({
        env: { ...env, GOVERNED_FAULT_BOUNDARY: 'before_next_request_reservation' }
      });
      try {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          if (fs.readFileSync(markerPath, 'utf8').includes('BOUNDARY_B_REACHED')) break;
          await sleep(500);
        }
        assertThat(fs.readFileSync(markerPath, 'utf8').includes('BOUNDARY_B_REACHED'),
          'the EXACT boundary was reached: request-2 authority was about to be created');
        await sleep(3000);
      } finally {
        // The child crashed at the boundary; stopping a dead child is fine.
        try { await first.stop(); } catch (_) { /* already gone */ }
      }

      // ── Durable state after the interruption ────────────────────────────
      const evidenceBefore = await store.readGovernedPostconditionEvidence(runId);
      const postBatchBefore = evidenceBefore.filter(r => r.evaluationKind === 'post_batch');
      assertThat(postBatchBefore.length === 2,
        'request 1 durably committed its COMPLETE evidence set');
      const verdictBefore = fact => postBatchBefore
        .find(r => r.declaredFactIdentity === fact.declaredFactIdentity).satisfied;
      assertThat(verdictBefore(factA) === true && verdictBefore(factB) === false,
        'the durable request-1 evidence is A=true, B=false');
      assertThat(capturesForRun().length === 1, 'exactly one transport call so far');
      assertThat((await chargesOf()).length === 1, 'exactly one budget charge so far');
      assertThat((await economicOf()).length === 1, 'exactly one economic reservation so far');

      const transitionsBefore = await store.readGovernedFactTransitions(runId);
      const baselineIdsBefore = evidenceBefore
        .filter(r => r.evaluationKind === 'baseline').map(r => r.evidenceId).sort();

      // ── CORRUPT THE TRANSCRIPT, ADVANCING THE REVISION ──────────────────
      const replayRow = await store.readRunReplay(runId);
      const originalSnapshotJson = JSON.stringify(replayRow.snapshot);
      const tampered = JSON.parse(originalSnapshotJson);
      tampered.modelResponses = (tampered.modelResponses || []).map(item => ({
        ...item, text: JSON.stringify({ message: 'tampered', actions: [], complete: false })
      }));
      const tamperedJson = JSON.stringify(tampered);
      await store.pool.query(
        `UPDATE ${store.table('replay_snapshots')}
            SET snapshot = $2::jsonb, revision = revision + 1
          WHERE run_id = $1`, [runId, tamperedJson]);

      const runRow = async () => (await store.pool.query(
        `SELECT status, lease_owner, revision, completed_at IS NOT NULL AS done,
                body->>'integrityFailureCode' AS code,
                body->>'integrityFailureAt' AS at,
                body->>'error' AS reason
           FROM ${store.table('runs')} WHERE id = $1`, [runId])).rows[0];
      const integrityEvents = async () => (await store.pool.query(
        `SELECT count(*)::int AS n FROM ${store.table('events')}
          WHERE run_id = $1 AND type = 'run.integrity_terminalized'`, [runId])).rows[0].n;
      const storedSnapshot = async () => (await store.pool.query(
        `SELECT snapshot FROM ${store.table('replay_snapshots')} WHERE run_id = $1`,
        [runId])).rows[0].snapshot;

      let revisionAfterTerminalFinal = null;
      const second = await startServer({ env });
      try {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const current = await store.getRun(runId);
          if (['completed', 'failed', 'blocked', 'cancelled'].includes(current.status)) break;
          await sleep(500);
        }
        await sleep(2000);

        const evidenceAfter = await store.readGovernedPostconditionEvidence(runId);
        const baselineIdsAfter = evidenceAfter
          .filter(r => r.evaluationKind === 'baseline').map(r => r.evidenceId).sort();
        assertThat(JSON.stringify(baselineIdsAfter) === JSON.stringify(baselineIdsBefore),
          'the SAME baseline rows are read — none re-appended');
        const window1After = evidenceAfter.filter(r =>
          r.evaluationKind === 'post_batch' &&
          r.batchStepId === postBatchBefore[0].batchStepId);
        assertThat(window1After.length === 2,
          'request-1 evidence is unchanged — no duplicate row was appended');

        const transitionsAfter = await store.readGovernedFactTransitions(runId);
        const creditedA = transitionsAfter.creditedInBatch[factA.declaredFactIdentity];
        assertThat(creditedA === transitionsBefore.creditedInBatch[factA.declaredFactIdentity],
          'the SAME cutoff-bounded A false-to-true transition is derived after restart');
        assertThat(transitionsAfter.windows
          .filter(w => w.newlySatisfiedFactIdentities.includes(factA.declaredFactIdentity))
          .length === 1,
        'A is credited EXACTLY ONCE across the restart');

        let row = await runRow();
        for (let i = 0; i < 45 && row.status !== 'failed'; i += 1) {
          await sleep(1000); row = await runRow();
        }
        await sleep(5000);
        row = await runRow();

        // ── ONE STABLE TERMINAL DISPOSITION ─────────────────────────────
        assertThat(row.status === 'failed',
          'the Run reaches the existing terminal failed status');
        assertThat(row.code === 'POSTGRES_REPLAY_INTEGRITY_FAILURE',
          'the exact stable integrity code is persisted');
        assertThat(typeof row.at === 'string' && Number.isFinite(Date.parse(row.at)),
          'a database-generated terminal timestamp is persisted');
        assertThat(row.done === true, 'completed_at is set');
        assertThat(row.lease_owner === null, 'lease authority is cleared');
        assertThat(/integrity/i.test(String(row.reason || '')),
          'the operator-facing reason names the integrity failure');
        assertThat(await integrityEvents() === 1,
          'exactly ONE canonical integrity event exists');

        // ── NOT SCHEDULER-ELIGIBLE, AND NOT LOOPING ─────────────────────
        const revisionAfterTerminal = row.revision;
        await sleep(4000);
        const settled = await runRow();
        assertThat(settled.revision === revisionAfterTerminal,
          'the Run is no longer claimed — its revision stops advancing');
        assertThat(settled.lease_owner === null, 'and no lease is re-acquired');
        assertThat(await integrityEvents() === 1,
          'no duplicate integrity event is appended');

        // ── NOTHING WAS SPENT OR EXECUTED ON THE CORRUPT TRANSCRIPT ─────
        assertThat(capturesForRun().length === 1, 'no provider call after corruption');
        assertThat((await economicOf()).length === 1, 'no new economic reservation');
        assertThat((await chargesOf()).length === 1, 'no new runtime-budget charge');
        assertThat(!(await store.getRun(runId)).governedProgressBlock,
          'no progress block was created');

        // ── THE CORRUPTION SURVIVES AS EVIDENCE ─────────────────────────
        assertThat(JSON.stringify(await storedSnapshot()) === tamperedJson,
          'the corrupted replay is NOT rewritten, repaired, or replaced');
        assertThat(JSON.stringify(await storedSnapshot()) !== originalSnapshotJson,
          'and it is still the corrupted content, not the original');
        revisionAfterTerminalFinal = settled.revision;
      } finally {
        await second.stop();
      }

      // ── A FRESH SERVER STARTS, AND THE TICKET PROJECTS ─────────────────
      //
      // This is a real second process against the same database, not a store
      // read. It previously could not start at all: the projector demanded a
      // completion decision from a leaf that truthfully has none, so one corrupt
      // leaf made the whole Ticket unserviceable and took its siblings with it.
      let uncontainedRunId = null;
      const third = await startServer({ env });
      try {
        assertThat(true, 'a fresh server STARTS against a Ticket holding a failed leaf');

        const rowAfterRestart = await runRow();
        assertThat(rowAfterRestart.status === 'failed' &&
          rowAfterRestart.code === 'POSTGRES_REPLAY_INTEGRITY_FAILURE',
        'the failed Run is still terminal after a real restart');
        assertThat(rowAfterRestart.revision === revisionAfterTerminalFinal,
          'the restart does not reclaim it — its revision is untouched');
        assertThat(rowAfterRestart.lease_owner === null,
          'and it acquires no lease: it is not scheduler-eligible');
        assertThat(await integrityEvents() === 1,
          'the restart appends no second integrity event');

        // ── The Ticket and Run project truthfully ────────────────────────
        const cookie = await third.login();
        const ticketPage = await third.request('GET', `/tickets/${run.ticketId}`, { cookie });
        assertThat(ticketPage.statusCode === 200,
          'the Ticket projection renders over the failed leaf');
        assertThat(!/COMPLETION_EVIDENCE_MISSING/.test(String(ticketPage.body || '')),
          'with no COMPLETION_EVIDENCE_MISSING refusal');
        const runPage = await third.request('GET', `/runs/${runId}`, { cookie });
        assertThat(runPage.statusCode === 200,
          'the Run detail page renders — the failure is inspectable');
        const runBody = String(runPage.body || '');
        assertThat(!/POSTGRES_REPLAY_INTEGRITY_FAILURE/.test(runBody.slice(0, 400)),
          'and it is a page, not an error envelope');

        // ── THE REPLAY-AVAILABILITY CONTRACT IS OPERATOR-VISIBLE ─────────
        //
        // Asserted on the surface, not just on the seam: a status code alone
        // would pass even if the page silently showed the Run as if its
        // transcript were fine. The operator must be able to see WHY there is
        // nothing to read.
        assertThat(runBody.includes('replay_unavailable_integrity_failure'),
          'the Run page states replay is unavailable due to integrity failure');
        assertThat(runBody.includes('POSTGRES_REPLAY_INTEGRITY_FAILURE'),
          'and names the exact stable integrity code');
        assertThat(!runBody.includes('tampered'),
          'while exposing no corrupted replay content');

        // ── The runtime API projects the failure truthfully ──────────────
        // Every Run surface reads through the same authority seam, so proving
        // one API that consumes it proves the seam rather than one handler.
        const runApi = await third.request('GET', `/api/runs/${runId}/claim-receipt`,
          { cookie });
        assertThat(runApi.statusCode === 200,
          'a runtime Run API returns its normal successful status');
        const apiBody = String(runApi.body || '');
        assertThat(!apiBody.includes('POSTGRES_REPLAY_INTEGRITY_FAILURE'),
          'it is a projection, not an error envelope');
        assertThat(!apiBody.includes('tampered'),
          'no corrupted replay content is exposed');
        const eventsApi = await third.request('GET', `/api/runs/${runId}/events`,
          { cookie });
        assertThat(eventsApi.statusCode === 200,
          'the Run events API also projects over the failed Run');

        // ── UNCONTAINED CORRUPTION STILL FAILS CLOSED ────────────────────
        //
        // The tolerance above is for corruption that has already been
        // terminalized and recorded. A Run whose transcript is corrupt but whose
        // integrity failure has NOT been recorded is live damage, and reporting
        // it as a tidy "replay unavailable" would hide a new fault behind an old
        // explanation. A sibling Run — never integrity-terminalized — is
        // corrupted here to prove the distinction is the disposition, not merely
        // the presence of corruption.
        const siblingWithReplay = (await store.pool.query(
          `SELECT run_id FROM ${store.table('replay_snapshots')}
            WHERE run_id <> $1 LIMIT 1`, [runId])).rows[0];
        if (siblingWithReplay) {
          const siblingId = Number(siblingWithReplay.run_id);
          const siblingReplay = await store.readRunReplay(siblingId);
          const siblingTampered = JSON.parse(JSON.stringify(siblingReplay.snapshot));
          siblingTampered.modelResponses = [{ text: 'uncontained corruption' }];
          await store.pool.query(
            `UPDATE ${store.table('replay_snapshots')}
                SET snapshot = $2::jsonb, revision = revision + 1
              WHERE run_id = $1`, [siblingId, JSON.stringify(siblingTampered)]);
            const siblingPage = await third.request('GET', `/runs/${siblingId}`, { cookie });
          assertThat(siblingPage.statusCode !== 200,
            'a Run with UNRECORDED corruption still fails closed — it is not hidden');
          uncontainedRunId = siblingId;
        }

        // ── No completion decision was required OR fabricated ────────────
        const decisions = (await store.pool.query(
          `SELECT consequence FROM ${store.table('run_consequences')} WHERE run_id = $1`,
          [runId])).rows.filter(r => r.consequence && r.consequence.completionDecision);
        assertThat(decisions.length === 0,
          'NO completion decision exists — and none was fabricated for it');

        // ── Siblings are not punished for this leaf ──────────────────────
        //
        // Siblings may fail for their OWN reasons — this fixture starves them of
        // staged responses. What must never happen is a sibling failing because
        // THIS leaf has no completion decision, which is what the projector's
        // old requirement caused.
        const siblings = (await store.pool.query(
          `SELECT id, status, body->>'error' AS reason FROM ${store.table('runs')}
            WHERE ticket_id = $1 AND id <> $2`, [run.ticketId, runId])).rows;
        assertThat(siblings.every(sibling =>
          !/COMPLETION_EVIDENCE_MISSING|without a completion decision/
            .test(String(sibling.reason || ''))),
        'no sibling fails because THIS leaf lacks completion authority');

        // ── EXACT REASONS, NOT ONLY STATUSES ─────────────────────────────
        //
        // A sibling may fail for its own reasons — this fixture stages no
        // response for one — and that is unremarkable. What must never happen
        // is a sibling inheriting THIS leaf's missing completion evidence, so
        // each sibling's reason is reported and required to be its own.
        for (const sibling of siblings) {
          const reason = String(sibling.reason || '');
          assertThat(reason === '' || !reason.includes(`Run ${runId} `),
            `sibling ${sibling.id} does not name run ${runId} as its cause ` +
            `(reason: ${reason.slice(0, 80) || 'none'})`);
        }

        // ── AN ORDINARY UNSUCCESSFUL LEAF IS NOT A GOVERNED BLOCK ───────
        //
        // The counterpart to the governed-block rows. These siblings failed for
        // their own reasons and hold NO durable governed block, so
        // reconciliation must keep calling them generically unsuccessful.
        // Without this, making every incomplete decision "blocked" — or
        // reconstructing a block from a replay-integrity failure — would look
        // like an improvement while erasing the distinction the block reasons
        // exist to carry.
        {
          const cookie2 = await third.login();
          const runtime = JSON.parse((await third.request(
            'GET', `/api/tickets/${run.ticketId}/runtime`, { cookie: cookie2 })).body);
          const items = (runtime.structuredAllocationLeafExecution || {}).items || [];
          assertThat(items.length > 0, 'the Ticket runtime reports leaf items');
          for (const item of items) {
            const blocked = await store.getRun(Number(item.runId));
            if (blocked && blocked.governedProgressBlock) continue;
            assertThat(item.dispositionReason !== 'governed_progress_blocked' &&
              item.dispositionReason !== 'governed_sibling_dependency_blocked',
            `run ${item.runId} holds no durable block, so its item reason is ` +
            `not a governed block reason (${item.dispositionReason})`);
          }
          const corruptItem = items.find(i => Number(i.runId) === Number(runId));
          assertThat(Boolean(corruptItem), 'the corrupt leaf appears as an item');
          assertThat(corruptItem.dispositionReason !== 'governed_progress_blocked',
            `a replay-integrity failure is never reconstructed as a governed ` +
            `block (${corruptItem.dispositionReason})`);
          const plainSibling = items.find(i => Number(i.runId) !== Number(runId) &&
            i.dispositionReason === 'completion_unsuccessful');
          assertThat(Boolean(plainSibling),
            'an ordinary unsuccessful sibling keeps completion_unsuccessful');
        }

        // ── THE AGGREGATE FOLLOWS TRANCHE 3 FAILED-CHILD RULES ───────────
        const plan = await store.getAllocationPlanForTicket(run.ticketId);
        const items = (plan && plan.aggregateDecision && plan.aggregateDecision.items) || [];
        const failedLeafItem = items.find(item =>
          Number(item.runId) === Number(runId));
        assertThat(Boolean(failedLeafItem),
          'the corrupt leaf appears in the aggregate decision');
        assertThat(failedLeafItem.itemStatus !== 'completed',
          'the corrupt leaf never projects as completed');
        assertThat(failedLeafItem.completionDecisionHash === null ||
          failedLeafItem.completionDecisionHash === undefined,
        'and carries no completion decision hash — none was fabricated for it');
        assertThat(items.every(item => item.itemStatus !== 'completed') ||
          items.some(item => item.itemStatus !== 'completed'),
        'the aggregate reflects a failed child rather than reporting success');

        const ticketRow = (await store.pool.query(
          `SELECT status FROM ${store.table('tickets')} WHERE id = $1`,
          [run.ticketId])).rows[0];
        assertThat(ticketRow.status !== 'completed',
          'the parent Ticket cannot project completed over a failed leaf');

        // ── Nothing was spent or retried by the restart ──────────────────
        assertThat(capturesForRun().length === 1, 'the restart makes no provider call');
        assertThat((await economicOf()).length === 1, 'no new economic reservation');
        assertThat((await chargesOf()).length === 1, 'no new runtime-budget charge');
        assertThat(JSON.stringify(await storedSnapshot()) === tamperedJson,
          'and the corrupted replay is still untouched');
      } finally {
        await third.stop();
      }

      // ── UNCONTAINED CORRUPTION, READ BY A PROCESS THAT NEVER SAW IT ─────
      //
      // Above, the uncontained corruption was applied and read inside ONE
      // server. That proves the refusal, but not that it survives a restart —
      // and a refusal that depends on the corrupting process still being alive
      // would be a cache, not an authority. Here a fourth server starts against
      // a database it has never read, with a Run whose transcript is corrupt
      // and whose integrity failure was never recorded.
      //
      // The distinction under test is the DISPOSITION, not the presence of
      // corruption: the contained leaf stays failed-and-inspectable, while the
      // uncontained one refuses closed. A restart must not blur them, and must
      // not quietly terminalize the uncontained Run into the tidy contained
      // shape.
      if (uncontainedRunId !== null) {
        const beforeUncontained = await durableTerminalCounts(store, run.ticketId);
        const uncontainedRowBefore = (await store.pool.query(
          `SELECT status, lease_owner, revision FROM ${store.table('runs')} WHERE id = $1`,
          [uncontainedRunId])).rows[0];

        const fourth = await startServer({ env });
        try {
          await waitForSchedulerQuiescence(store, run.ticketId);
          const cookie = await fourth.login();

          const page = await fourth.request('GET', `/runs/${uncontainedRunId}`, { cookie });
          assertThat(page.statusCode !== 200,
            `a fresh process still refuses the uncontained Run closed ` +
            `(status ${page.statusCode})`);
          const body = String(page.body || '');
          assertThat(!body.includes('uncontained corruption'),
            'and exposes none of the corrupt replay content');
          assertThat(!body.includes('replay_unavailable_integrity_failure'),
            'it does not borrow the CONTAINED integrity-failure vocabulary');
          assertThat(!body.includes('replay_available'),
            'and does not claim replay is available');
          // THE REFUSAL MAY NAME THE INTEGRITY CODE. That is what it is
          // refusing about, and naming it is honest reporting — it is the
          // CONTAINED vocabulary above that would be a fabrication, because no
          // containment was ever recorded for this Run. What the refusal must
          // not do is RECORD one, which the durable checks below cover.
          assertThat(page.statusCode === 500,
            `the refusal is a closed server-side refusal (${page.statusCode})`);
          assertThat(body.includes('POSTGRES_REPLAY_INTEGRITY_FAILURE'),
            'and names the integrity code it is refusing about');
          assertThat(/integrity check failed/i.test(body),
            'with a sanitized reason rather than replay content');

          // The contained leaf is unaffected by the neighbouring uncontained
          // damage — the two dispositions stay separate after restart.
          const containedPage = await fourth.request('GET', `/runs/${runId}`, { cookie });
          assertThat(containedPage.statusCode === 200,
            'while the CONTAINED failure remains inspectable in the same process');
          assertThat(String(containedPage.body || '')
            .includes('replay_unavailable_integrity_failure'),
          'and still states its own containment authority');

          // The refusal is not a terminalization: nothing was repaired,
          // rewritten or recorded to make the page renderable.
          const uncontainedRowAfter = (await store.pool.query(
            `SELECT status, lease_owner, revision FROM ${store.table('runs')} WHERE id = $1`,
            [uncontainedRunId])).rows[0];
          assertThat(uncontainedRowAfter.status === uncontainedRowBefore.status,
            'the refusing read does not terminalize the uncontained Run');
          assertThat(Number(uncontainedRowAfter.revision) ===
            Number(uncontainedRowBefore.revision),
          'and does not advance its revision');
          assertThat(uncontainedRowAfter.lease_owner === null,
            'and takes no lease on it');
          assertThat(await integrityEvents() === 1,
            'and records no second integrity event to explain itself');

          const afterUncontained = await durableTerminalCounts(store, run.ticketId);
          const drift = countDelta(beforeUncontained, afterUncontained);
          assertThat(drift.length === 0,
            `restart and refusing reads create no durable facts (${drift.join(', ')})`);
        } finally {
          await fourth.stop();
        }
      }

      console.log(`  (${assertThat.count()} corruption containment assertions)`);
      for (const file of [capturePath, responsePath, markerPath, statePath, servedPath]) {
        fs.rmSync(file, { force: true });
      }
    });

  const forbidden = [
    ['appendGovernedPostcondition', 'Evidence'],
    ['INSERT ', 'INTO'],
    ['DELETE ', 'FROM'],
    ['reserveEconomic', 'Request'],
    ['terminalizeRunForReplay', 'IntegrityFailure']
  ].map(parts => parts.join(''));
  const executable = fs.readFileSync(__filename, 'utf8').split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter(line => !/^\s*\['/.test(line))
    .join('\n');
  for (const name of forbidden) {
    assert.equal(executable.includes(name), false,
      `the suite never calls ${name} — production creates and recovers these records`);
  }

  console.log('governed replay corruption containment PostgreSQL test passed');
}

main().catch(error => { console.error(error); process.exit(1); });
