#!/usr/bin/env node
'use strict';

// Tranche 5 — the production writer, proved through the real spawned server.
//
// Other suites prove components. This proves the WIRING: a canonically admitted
// governed structured leaf Run is claimed by the real scheduler, answered by a
// hermetically controlled provider, executes a real workspace mutation, commits
// a real operation receipt, and has canonical post-batch evidence written by
// PRODUCTION. This file creates none of those records.
//
// HERMETIC, and asserted rather than assumed. The governed transport sends bytes
// with `https.request`; overriding `global.fetch` does not intercept it. The
// preload binds the documented `httpsRequest` seam, makes any non-localhost
// request throw, and prints a proof-of-life line — which is asserted here,
// because a preload that silently fails to load protects nothing. The harness
// strips developer credentials from the child; only a fixed sentinel is
// tolerated, and no credential value is read or logged.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withHarness } = require('./postgres-test-harness');
const {
  seedGovernedStructuredTicket,
  progressControlPolicy
} = require('./governed-structured-fixture');
const { eligibleExecutionFacts } = require('../runtime/governed-eligible-facts');

const STAMP = `gfr-${Date.now()}`;
const ACTOR = 'governed-leaf-first-response-test';
const PRELOAD = path.join(__dirname, 'fixtures', 'hermetic-governed-transport-preload.js');
const FIXTURE_RESPONSE_IDENTITY = 'fixture-governed-response-1';
const SENTINEL = 'test-only-sentinel-not-a-real-credential';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  await withHarness('governed leaf first response PostgreSQL',
    async ({ store, workspaceRoot, startServer }) => {
      // TWO eligible facts, so first verified progress cannot also satisfy the
      // whole completion authority — otherwise "advanced" and "finished" would
      // be indistinguishable below.
      const seeded = await seedGovernedStructuredTicket(store, {
        stamp: STAMP,
        actor: ACTOR,
        workspaceRoot,
        agentApiKey: SENTINEL,
        progressPolicy: progressControlPolicy({
          maximumConsecutiveNoProgressWindows: 1
        }),
        // ONE governed request, bounded by the Run's own admitted limits. The
        // worker would otherwise legitimately prepare a second, and because a
        // governed request is now persisted BEFORE transport, that attempt
        // durably records a second providerRequests item even though the fixture
        // refuses to answer it. The limit lives in the admission-captured limits
        // snapshot, not the environment, so it is set where the Run reads it.
        runtimeLimits: {
          maxExecutionSteps: 6,
          maxModelRequestsPerRun: 1,
          maxWorkspaceOperationsPerRun: 40,
          maxRuntimeDurationMs: 600_000,
          maxAttempts: 3,
          maxProcessOperationsPerRun: 5,
          maxBrowserOperationsPerRun: 5,
          maxOutputArtifactBytes: 1_048_576,
          maxOutputArtifactBytesPerRun: 1_048_576
        },
        leafPostconditions: (item, owned) => [
          { type: 'folder_exists', path: `${owned}/alpha` },
          { type: 'folder_exists', path: `${owned}/beta` }
        ]
      });
      const runId = seeded.runIds[0];
      const run = await store.getRun(runId);
      const facts = eligibleExecutionFacts(run);
      assert.equal(facts.length, 2, 'the Run admits exactly two eligible facts');
      const factA = facts.find(f => f.criterion.path.endsWith('/alpha'));
      const factB = facts.find(f => f.criterion.path.endsWith('/beta'));
      assert.ok(factA && factB);

      // Deterministic initial workspace state: the owned parent exists, the two
      // declared folders do not. `createFolder` is non-recursive in production,
      // so a scenario that omits the parent tests mkdir semantics rather than
      // governed progress.
      fs.mkdirSync(path.join(workspaceRoot, path.dirname(factA.criterion.path)),
        { recursive: true });

      assert.equal(fs.existsSync(path.join(workspaceRoot, factA.criterion.path)), false);
      assert.equal(fs.existsSync(path.join(workspaceRoot, factB.criterion.path)), false);
      assert.equal((await store.readGovernedPostconditionEvidence(runId)).length, 0,
        'NO EVIDENCE EXISTS BEFORE PRODUCTION RUNS — this suite writes none');

      const FIXTURE_PLAN = {
        message: 'Creating the first declared folder.',
        actions: [{ operation: 'createFolder', args: { path: factA.criterion.path } }],
        complete: false
      };
      const capturePath = path.join(os.tmpdir(), `gfr-cap-${process.pid}-${STAMP}.jsonl`);
      const responsePath = path.join(os.tmpdir(), `gfr-res-${process.pid}-${STAMP}.json`);
      fs.writeFileSync(capturePath, '');
      fs.writeFileSync(responsePath, JSON.stringify({
        // Addressed to this Run: sibling leaf Runs share the fixture.
        // The leaf's declared path, not the folder the planner also names.
        match: 'reports/planner/alpha',
        statusCode: 200,
        body: JSON.stringify({
          id: FIXTURE_RESPONSE_IDENTITY,
          output_text: JSON.stringify(FIXTURE_PLAN),
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        })
      }));

      // The env object is the FIRST argument. Passing `{ env: {...} }` nests it
      // one level too deep, NODE_OPTIONS never applies, and the preload silently
      // does not run — which is exactly how an uncontrolled provider response
      // once reached this harness.
      const server = await startServer({ env: {
        NODE_OPTIONS: `--require ${PRELOAD}`,
        OPENAI_API_KEY: SENTINEL,
        HERMETIC_TRANSPORT_CAPTURE: capturePath,
        HERMETIC_TRANSPORT_RESPONSE: responsePath,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '60000',
        AGENT_MAX_EXECUTION_STEPS: '4',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '4'
      } });

      try {
        let receipts = [];
        let evidence = [];
        for (let attempt = 0; attempt < 120; attempt += 1) {
          receipts = (await store.pool.query(
            `SELECT id, step_id, operation, outcome, workspace_path, ticket_id, run_id
               FROM ${store.table('operation_receipts')}
              WHERE run_id = $1 ORDER BY id`, [runId])).rows;
          evidence = await store.readGovernedPostconditionEvidence(runId);
          if (evidence.some(row => row.evaluationKind === 'post_batch')) break;
          await sleep(500);
        }

        // ── HERMETICITY, asserted before anything is interpreted ──────────
        assert.ok(String(server.output()).includes('HERMETIC_PRELOAD_ACTIVE=true'),
          'the hermetic preload actually ran inside the spawned server');
        const captured = fs.readFileSync(capturePath, 'utf8').trim()
          .split('\n').filter(Boolean).map(line => JSON.parse(line))
          .filter(entry => String(entry.body || '').includes('reports/planner/alpha'));
        assert.equal(captured.length, 1,
          'the injected transport received exactly one request');
        assert.equal(captured[0].hostname, 'api.openai.com');
        assert.equal(captured[0].path, '/v1/responses');
        assert.equal(captured[0].method, 'POST');
        assert.equal(captured[0].hasAuthorization, true,
          'a credential header was formed (its value is never inspected)');

        const replay = await store.readRunReplay(runId);
        const snapshot = (replay && replay.snapshot) || {};
        const modelResponses = snapshot.modelResponses || [];
        const parsedPlans = snapshot.parsedModelPlans || [];

        // Provider-request replay must exist and precede the response. Governed
        // dispatch returned a requestEvidenceKey for evidence it never wrote, so
        // a correct Run reported "1 response, 0 requests" and read as an anomaly.
        const providerRequests = snapshot.providerRequests || [];
        assert.equal(providerRequests.length, 1, 'one provider-request replay item');
        assert.equal(providerRequests[0].governed, true);
        assert.equal(providerRequests[0].method, 'POST');
        assert.equal(providerRequests[0].url, 'https://api.openai.com/v1/responses');
        assert.equal('headers' in providerRequests[0], false,
          'no request headers — and therefore no credential — reach replay');
        assert.ok(providerRequests[0].body && providerRequests[0].body.input,
          'the canonical request body is durable');

        assert.equal(modelResponses.length, 1, 'one model-response replay item');
        assert.equal(JSON.stringify(modelResponses[0]).includes('resp_'), false,
          'no uncontrolled external response identity appears');
        assert.ok(parsedPlans.length >= 1, 'the plan was parsed');
        assert.deepEqual(parsedPlans[0].actions, FIXTURE_PLAN.actions,
          'normalization retained exactly the fixture mutation');

        // ── The mutation really happened ──────────────────────────────────
        assert.equal(fs.existsSync(path.join(workspaceRoot, factA.criterion.path)), true,
          'the declared folder exists on disk');
        assert.equal(fs.existsSync(path.join(workspaceRoot, factB.criterion.path)), false,
          'the second declared folder does NOT exist');

        const mutation = receipts.find(row =>
          row.operation === 'createFolder' && row.outcome === 'succeeded');
        assert.ok(mutation, 'a real operation receipt committed');
        assert.equal(Number(mutation.run_id), runId);
        assert.equal(Number(mutation.ticket_id), run.ticketId);
        assert.ok(mutation.step_id !== null);
        assert.ok(String(mutation.workspace_path).includes('alpha'));

        // ── PRODUCTION WROTE THE EVIDENCE ─────────────────────────────────
        const baseline = evidence.filter(r => r.evaluationKind === 'baseline');
        const postBatch = evidence.filter(r => r.evaluationKind === 'post_batch');
        assert.equal(baseline.length, 2, 'one baseline row per admitted fact');
        for (const row of baseline) {
          assert.equal(row.satisfied, false, 'both facts unsatisfied before execution');
        }
        assert.equal(postBatch.length, 2,
          'the production writer appended one COMPLETE atomic post-batch set');
        const postA = postBatch.find(r => r.declaredFactIdentity === factA.declaredFactIdentity);
        const postB = postBatch.find(r => r.declaredFactIdentity === factB.declaredFactIdentity);
        assert.ok(postA && postB, 'both admitted facts were evaluated');
        assert.equal(postA.satisfied, true, 'A is recorded satisfied');
        assert.equal(postB.satisfied, false, 'B is recorded unsatisfied');
        assert.equal(postA.batchStepId, String(mutation.step_id),
          'evidence binds the real request window');
        assert.equal(postA.requestSourceIdentity,
          `model-request:agent:${mutation.step_id}:provider`);
        assert.equal(postA.throughOperationReceiptId, Number(mutation.id),
          'and the real committed through-receipt anchor');

        // No credential value anywhere in durable state.
        const durable = JSON.stringify({ evidence, receipts, snapshot });
        assert.equal(durable.includes(SENTINEL), false,
          'the fixture credential never reaches replay, receipts or evidence');

        const finalRun = await store.getRun(runId);
        assert.notEqual(finalRun.status, 'completed',
          'the Run has NOT completed, because B remains unsatisfied');
      } finally {
        await server.stop();
        fs.rmSync(capturePath, { force: true });
        fs.rmSync(responsePath, { force: true });
      }

      console.log('  ok governed leaf first response');
    });

  // ── No-shortcut source boundary ─────────────────────────────────────────
  //
  // The names are assembled from fragments rather than written whole: a literal
  // list of forbidden identifiers is itself executable source, so the scan would
  // match its own definition and fail a suite that takes no shortcut.
  const forbidden = [
    ['appendGovernedPostcondition', 'Evidence'],
    ['appendGovernedPostcondition', 'EvidenceSet'],
    ['INSERT ', 'INTO'],
    ['evaluateGovernedRun', 'Progress'],
    ['readGovernedFact', 'Transitions'],
    ['reserveEconomic', 'Request'],
    ['recordOperation', 'Receipt'],
    ['recordRun', 'Consequence'],
    ['reconcileStructuredAllocationLeaf', 'Items']
  ].map(parts => parts.join(''));

  const executable = fs.readFileSync(__filename, 'utf8').split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter(line => !/^\s*\['/.test(line))
    .join('\n');
  for (const name of forbidden) {
    assert.equal(executable.includes(name), false,
      `the suite never calls ${name} — production creates these records`);
  }

  console.log('governed leaf first response PostgreSQL test passed');
}

main().catch(error => { console.error(error); process.exit(1); });
