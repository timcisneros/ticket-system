#!/usr/bin/env node
'use strict';
// Bounded workspace transitions — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A10).
//
// Contract under test: a single model response may propose at most
// `maxMutatingActionsPerResponse` mutating actions. An oversized batch is rejected
// WHOLE — no partial prefix reaches the workspace — and the cap is enforced per
// response, so a batch sitting exactly at the cap still executes.
//
// REPAIRED WITH TWO SCENARIOS RE-EXPRESSED, because the runtime moved underneath
// them. Both retired assertions are recorded here rather than quietly dropped:
//
//   * The JSON-era suite expected a mixed inspection+mutation batch to execute and
//     record four workspace operations. That batch shape is now rejected by the
//     EXECUTION PHASE gate (`execution.phase_violation`, "actions belong to
//     different execution phases"), which did not exist when the suite was written.
//     Nothing is executed. Asserting the old outcome would assert dead behavior, so
//     the scenario now proves the two gates are DISTINCT: the mutating cap accepts
//     the batch (`model:action_contract_passed`) and the phase gate then rejects it.
//     The at-cap same-phase case that the old assertion was really reaching for is
//     covered separately below.
//
//   * The JSON-era suite pinned the failure to a bespoke "Model repeatedly proposed
//     too many mutating actions" string and a `run:mutating_action_limit` event.
//     Neither exists: the mutating-action gate was folded into the unified
//     action-contract streak (runtime/action-contract-streak.js), which terminates
//     through MODEL_RESPONSE_CONTRACT_VIOLATION. The live structured classification
//     is asserted instead.
//
// Scope boundary: the streak SEMANTICS (how many consecutive violations terminate,
// how the streak survives recovery) belong to model-contract-violation-test.js and
// action-contract-streak-test.js. What this suite owns is that the MUTATING cap is
// the gate that fires, that rejection is whole-batch, and where the cap's boundary
// actually sits.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter, sleep } = require('./postgres-test-harness');

const STAMP = Date.now();
const assert = createAsserter();

function createFakeOpenAIPreload() {
  const preloadPath = path.join(os.tmpdir(), `bounded-transition-openai-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
function okResponse(plan) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'fake-bounded-transition']]),
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
  const input = Array.isArray(body.input) ? body.input : [];
  const combined = input.map(item => item && item.content ? String(item.content) : '').join('\\n');

  // Three mutating actions against a cap of two: rejected whole, every time it is
  // proposed, so the repeated-violation stop is what ends the run.
  if (combined.includes('bounded-transition-too-many')) {
    return okResponse({
      message: 'Attempting too many mutations.',
      actions: [
        { operation: 'writeFile', args: { path: 'too-many-a-${STAMP}.txt', content: 'a' } },
        { operation: 'writeFile', args: { path: 'too-many-b-${STAMP}.txt', content: 'b' } },
        { operation: 'writeFile', args: { path: 'too-many-c-${STAMP}.txt', content: 'c' } }
      ],
      complete: false
    });
  }

  // Exactly at the mutating cap, single phase: the batch the cap is supposed to let
  // through.
  if (combined.includes('bounded-transition-at-cap')) {
    return okResponse({
      message: 'A bounded transition at the cap.',
      actions: [
        { operation: 'writeFile', args: { path: 'at-cap-a-${STAMP}.txt', content: 'a' } },
        { operation: 'writeFile', args: { path: 'at-cap-b-${STAMP}.txt', content: 'b' } }
      ],
      complete: true
    });
  }

  // Two inspections plus two mutations: WITHIN the mutating cap, so the
  // action-count gate accepts it; the phase gate is what rejects it.
  if (combined.includes('bounded-transition-mixed-phase')) {
    return okResponse({
      message: 'Inspecting and mutating in one response.',
      actions: [
        { operation: 'listDirectory', args: { path: '' } },
        { operation: 'readFile', args: { path: 'seed-${STAMP}.txt' } },
        { operation: 'writeFile', args: { path: 'mixed-a-${STAMP}.txt', content: 'a' } },
        { operation: 'writeFile', args: { path: 'mixed-b-${STAMP}.txt', content: 'b' } }
      ],
      complete: true
    });
  }

  return okResponse({
    message: 'Single mutation.',
    actions: [
      { operation: 'writeFile', args: { path: 'single-write-${STAMP}.txt', content: 'ok' } }
    ],
    complete: true
  });
};
`);
  return preloadPath;
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const preloadPath = createFakeOpenAIPreload();
  try {
    await withHarness('bounded transition', async ({ store, workspaceRoot, startServer }) => {
      const agent = (await store.createConfiguredAgent({
        value: {
          name: `BoundedTransition-${STAMP}`,
          provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key-bounded-transition'
        },
        groupIds: [], changedBy: 'bounded-transition-test'
      })).agent;

      fs.writeFileSync(path.join(workspaceRoot, `seed-${STAMP}.txt`), 'seed\n');

      const server = await startServer({
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '60000'
      });
      const cookie = await server.login();

      async function terminalRunFor(objective, expectedStatus) {
        const created = await server.request('POST', '/tickets', {
          cookie,
          form: {
            objective,
            assignmentTargetType: 'agent',
            assignmentTargetId: String(agent.id),
            assignmentMode: 'individual'
          }
        });
        assert(created.statusCode === 302, `ticket create for "${objective}" redirected`);

        const ticket = await waitFor(async () => {
          const { tickets } = await store.listTickets({ limit: 200 });
          return tickets.find(t => t.objective === objective) || null;
        }, 30000, `ticket "${objective}"`);

        const run = await waitFor(async () => {
          const { runs } = await store.listRunsForTicket({ ticketId: ticket.id, limit: 20 });
          return runs[0] || null;
        }, 30000, `run dispatch for "${objective}"`);

        const terminal = await waitFor(async () => {
          const current = await store.getRun(run.id);
          return current && current.status === expectedStatus ? current : null;
        }, 90000, `${expectedStatus} run for "${objective}"`);

        // The replay snapshot is a separate durable record in PostgreSQL, not an
        // inline field on the run row. It is finalized alongside terminalization.
        const replay = await waitFor(async () => {
          const record = await store.readRunReplay(terminal.id);
          const snapshot = record && record.snapshot ? record.snapshot : null;
          return snapshot && snapshot.terminalStatus === expectedStatus ? snapshot : null;
        }, 30000, `replay snapshot for run ${terminal.id}`);

        return { run: terminal, replay };
      }

      const exists = rel => fs.existsSync(path.join(workspaceRoot, rel));
      const typesOf = replay => (replay.events || []).map(event => event && event.type);

      // ── 1. Oversized mutating batch: rejected whole ──────────────────────────
      const tooMany = await terminalRunFor(`bounded-transition-too-many ${STAMP}`, 'failed');

      // The strongest evidence in this suite: the workspace itself. A prefix-executing
      // runtime would leave the first one or two files behind even while recording
      // zero accepted operations.
      assert(!exists(`too-many-a-${STAMP}.txt`), '1: oversized batch wrote no first file');
      assert(!exists(`too-many-b-${STAMP}.txt`), '1: oversized batch wrote no second file');
      assert(!exists(`too-many-c-${STAMP}.txt`), '1: oversized batch wrote no third file');

      assert(tooMany.replay.runtimeEnvelope
        && tooMany.replay.runtimeEnvelope.maxMutatingActionsPerResponse === 2,
        '1: the runtime envelope records the mutating cap the run was held to');

      const limitEvents = (tooMany.replay.events || [])
        .filter(event => event && event.type === 'model:mutating_action_limit');
      assert(limitEvents.length === 2,
        `1: a repeated oversized batch stops after 2 rejections (got ${limitEvents.length})`);
      assert(limitEvents.every(e => e.mutatingActionCount === 3 && e.maxMutatingActionsPerResponse === 2),
        '1: each rejection records the proposed mutating count against the cap that rejected it');
      assert(limitEvents[0].consecutiveViolationCount === 1 && limitEvents[1].consecutiveViolationCount === 2,
        '1: the rejections are recorded as a consecutive streak');
      assert(!typesOf(tooMany.replay).includes('model:action_contract_passed'),
        '1: an oversized batch never records an action-contract pass');
      assert((tooMany.replay.parsedModelPlans || []).length === 2,
        '1: the run stopped on the repeat rather than exhausting the step budget');

      assert(tooMany.replay.failure && tooMany.replay.failure.code === 'MODEL_RESPONSE_CONTRACT_VIOLATION',
        '1: the failure is classified as a model-response contract violation');
      assert(tooMany.replay.failure.kind === 'no_progress',
        '1: the violation is classified as no-progress, not a provider or timeout failure');
      assert(tooMany.replay.failure.detail
        && tooMany.replay.failure.detail.lastMutatingActionCount === 3
        && tooMany.replay.failure.detail.maxMutatingActionsPerResponse === 2,
        '1: the failure detail names the mutating cap as the gate that rejected the batch');
      assert(tooMany.run.error === tooMany.replay.failureReason,
        '1: the run error and the replay failure reason agree');

      assert((tooMany.replay.workspaceOperations || []).length === 0,
        '1: a rejected mutating batch executes no workspace operations at all');
      assert(tooMany.replay.mutationCount === 0, '1: a rejected mutating batch records zero mutations');
      const tooManyOps = await store.listRunOperations(tooMany.run.id, { limit: 100 });
      assert((tooManyOps.operations || tooManyOps).length === 0,
        '1: a rejected mutating batch leaves no operation receipts');

      // ── 2. At the cap, single phase: executes ────────────────────────────────
      // The cap bounds a batch; it does not forbid one. Without this, scenario 1
      // would also pass against a runtime that rejected every mutating batch.
      const atCap = await terminalRunFor(`bounded-transition-at-cap ${STAMP}`, 'completed');
      assert(exists(`at-cap-a-${STAMP}.txt`), '2: an at-cap batch wrote its first file');
      assert(exists(`at-cap-b-${STAMP}.txt`), '2: an at-cap batch wrote its second file');
      assert((atCap.replay.workspaceOperations || []).length === 2,
        '2: both mutations at the cap boundary were accepted and recorded');
      assert(typesOf(atCap.replay).includes('model:action_contract_passed'),
        '2: a batch at the cap records an explicit action-contract pass');
      assert((atCap.replay.parsedModelPlans || []).length === 1,
        '2: an at-cap batch completes in a single response');

      // ── 3. Mixed-phase batch: the OTHER gate rejects it ──────────────────────
      // Two inspections plus two mutations is within the mutating cap, so this
      // separates the two gates. The mutating cap accepts; the phase gate refuses.
      const mixed = await terminalRunFor(`bounded-transition-mixed-phase ${STAMP}`, 'failed');
      assert(typesOf(mixed.replay).includes('model:action_contract_passed'),
        '3: the mutating cap ACCEPTS a mixed batch that sits within it');
      assert(!typesOf(mixed.replay).includes('model:mutating_action_limit'),
        '3: the mutating cap is not what rejected the mixed batch');
      assert(typesOf(mixed.replay).includes('execution.phase_violation'),
        '3: the execution phase gate is what rejected it');
      assert((mixed.replay.workspaceOperations || []).length === 0,
        '3: a phase-rejected batch executes no operations either');
      assert(!exists(`mixed-a-${STAMP}.txt`) && !exists(`mixed-b-${STAMP}.txt`),
        '3: a phase-rejected batch reaches the workspace no more than an oversized one does');

      // ── 4. A single mutation is unaffected ───────────────────────────────────
      await terminalRunFor(`bounded-transition-single ${STAMP}`, 'completed');
      assert(exists(`single-write-${STAMP}.txt`), '4: a single mutating action still works');

      console.log(`\nPASS: bounded workspace transitions — ${assert.count()} assertions (PostgreSQL-native)`);
    }, { schemaSlug: 'bounded_transition' });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(`\nFAIL: bounded workspace transitions — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
