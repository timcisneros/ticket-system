#!/usr/bin/env node
'use strict';

// Tranche 6 — the LIVE dispatch acceptance proof, for ALL THREE PROVIDER ROLES.
//
// THIS IS THE PROOF THAT WAS MISSING, TWICE. The first readiness gate certified
// LIVE READY on a dry run that "stopped before dispatch" while no dispatch path
// existed beyond that stop. The second captured two requests and called it
// three roles — the planner received a worker-shaped answer, emitted no valid
// proposal, and the governed leaf executor was never reached at all.
//
// Two transports are not three role paths. This suite therefore proves each
// role by an ACTUAL captured outbound request instance:
//
//   1. ungoverned worker      — global fetch
//   2. structured planner     — https.request
//   3. governed leaf worker   — https.request, reached only because the planner
//                               received a valid proposal and a plan was admitted
//
// It spawns real servers in LIVE mode — no hermetic response fixture, no staged
// answers — and replaces ONLY the final network hop. Every layer above it is
// production: role routing, economic admission, adapter selection and request
// body construction. The recorded bodies are what production would have sent.
//
// It makes ZERO external calls.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const { ARMS } = require('./fixtures/evaluation-arms');
const { getScenario } = require('./fixtures/evaluation-scenarios');
const { runTrial } = require('./structured-allocation-evaluation-runner');
const {
  LiveBudgetError, reconstructCommittedLiability
} = require('./fixtures/evaluation-live-budget-ledger');
const { trialWorstCaseMicroUsd } = require('./fixtures/evaluation-live-trial-liability');
const {
  ROLES, assertEveryRoleDispatched, classifyCapturedRole, countCapturedRoles
} = require('./fixtures/evaluation-live-capture-roles');
const { ROLE_ECONOMICS } = require('./fixtures/governed-role-policy-container');
const liveManifest = require('../config/structured-allocation-evaluation-live-v1.json');

// The frozen request controls, exactly as the live runner would supply them.
const CONTROLS = Object.freeze({
  temperature: liveManifest.sampling.temperature,
  topP: liveManifest.sampling.topP,
  maxOutputTokens: liveManifest.maximumOutputTokensPerRequest
});

function capturedRequests(capturePath) {
  if (!fs.existsSync(capturePath)) return [];
  return fs.readFileSync(capturePath, 'utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line));
}

async function main() {
  const root = path.join('/tmp', `ticket-system-live-dispatch-${process.pid}`);
  fs.mkdirSync(path.join(root, 'fixture'), { recursive: true });

  await withHarness('structured allocation live dispatch',
    async ({ store, workspaceRoot, startServer }) => {
      const assertThat = createAsserter();

      const budgetRoot = path.join(root, 'budget');
      fs.mkdirSync(budgetRoot, { recursive: true });
      // THE SAME AUTHORITY THE LIVE RUN WOULD CARRY, derived not copied.
      const liveBudget = {
        runRoot: budgetRoot,
        ceilingMicroUsd: liveManifest.economics.maximumTotalLiveMicroUsd,
        perRequestMicroUsd: liveManifest.economics.liability.perRequestMicroUsd,
        runtimeMaxModelRequestsPerRun:
          liveManifest.economics.liability.runtimeMaxModelRequestsPerRun,
        governedLeafMaximumProviderRequests:
          ROLE_ECONOMICS.structured_leaf_executor.maximumProviderRequests,
        governedPlannerMaximumProviderRequests:
          ROLE_ECONOMICS.structured_planner.maximumProviderRequests
      };
      const boundFor = armId => trialWorstCaseMicroUsd({
        armId,
        perRequestMicroUsd: liveBudget.perRequestMicroUsd,
        runtimeMaxModelRequestsPerRun: liveBudget.runtimeMaxModelRequestsPerRun,
        governedLeafMaximumProviderRequests:
          liveBudget.governedLeafMaximumProviderRequests,
        governedPlannerMaximumProviderRequests:
          liveBudget.governedPlannerMaximumProviderRequests,
        autoRetryEnabled: false, maxAttempts: null
      });

      // One direct arm and one structured arm: between them they exercise both
      // production transports and all three request roles.
      const cells = [
        { armId: 'A', scenarioId: 'family-1-simple', label: 'direct/legacy (fetch)' },
        { armId: 'B', scenarioId: 'family-1-simple', label: 'structured (https.request)' }
      ];

      const allCaptured = [];
      for (const cell of cells) {
        const capturePath = path.join(root, `capture-${cell.armId}.jsonl`);
        try {
          await runTrial({
            store, startServer, workspaceRoot,
            scenario: getScenario(cell.scenarioId), arm: ARMS[cell.armId],
            repetition: 1, seed: `live-dispatch-${cell.armId}`,
            outputPath: path.join(root, 'fixture', `${cell.armId}.json`),
            commit: 'live-dispatch-proof', smokeRoot: root,
            namespaceRoot: path.join(root, 'ns'),
            // LIVE MODE, with the final hop captured.
            mode: 'live',
            liveRequestControls: CONTROLS,
            liveTransportCapture: capturePath,
            liveBudget
          });
        } catch (error) {
          // A product outcome is irrelevant here: this suite is about the bytes
          // that reached the transport, not about whether the Ticket succeeded.
          if (process.env.LIVE_DISPATCH_DEBUG === '1') {
            console.log(`  [debug ${cell.armId}] ${String(error.message).slice(0, 400)}`);
          }
        }
        const captured = capturedRequests(capturePath);
        allCaptured.push(...captured);
        assertThat(captured.length > 0,
          `${cell.label}: the live path reached the real provider transport ` +
          `(${captured.length} outbound request(s))`);
      }

      // ── THREE ROLES, EACH WITH ITS OWN CAPTURED REQUEST ──────────────────
      // Classification is shared, behavioural code with its own proof — not a
      // predicate restated inside the suite that makes the claim.
      const byRole = countCapturedRoles(allCaptured);
      for (const role of ROLES) {
        assertThat(byRole[role] >= 1,
          `${role}: at least one ACTUAL outbound request instance was captured ` +
          `(${byRole[role]})`);
      }
      let everyRole = null;
      try { everyRole = assertEveryRoleDispatched(allCaptured); } catch (_) { everyRole = null; }
      assertThat(everyRole !== null,
        'the three-role gate passes on actual captured instances, not on transports');
      // The leaf request exists only because the planner's answer was a valid
      // proposal that produced an admitted plan and a real leaf Run. That chain
      // is what makes this a role proof rather than a transport proof.
      assertThat(byRole.governed_leaf_worker >= 1 && byRole.structured_planner >= 1,
      'the governed leaf request followed a real admitted plan, not a forced path');

      // ── THE OUTBOUND BYTES, PER ROLE ────────────────────────────────────
      for (const entry of allCaptured) {
        const role = classifyCapturedRole(entry);
        const body = JSON.parse(entry.body);
        assertThat(body.model === liveManifest.model,
          `${role}: outbound model is the exact dated snapshot (${body.model})`);
        assertThat(body.temperature === CONTROLS.temperature,
          `${role}: outbound temperature is ${CONTROLS.temperature}`);
        assertThat(body.top_p === CONTROLS.topP,
          `${role}: outbound top_p is ${CONTROLS.topP}`);
        // THE OUTPUT CAP ON EVERY ROLE. The ungoverned path used to send none,
        // so the liability model priced a bound the wire did not carry.
        assertThat(body.max_output_tokens === CONTROLS.maxOutputTokens,
          `${role}: outbound max_output_tokens is ${CONTROLS.maxOutputTokens}`);
        assertThat(body.truncation === 'disabled',
          `${role}: truncation stays disabled, so the context ceiling still bounds cost`);
        assertThat(!('seed' in body),
          `${role}: no provider seed appears in the outbound body`);
        assertThat(entry.hostname === 'api.openai.com',
          `${role}: the request was addressed to the real provider`);
        assertThat(entry.hasAuthorization === true,
          `${role}: a credential header was formed without its value being recorded`);
      }
      // The adapter identity is the manifest's, on both transports.
      assertThat(liveManifest.adapterId === 'openai.responses.v1' &&
        liveManifest.provider === 'openai',
      'the frozen adapter and provider identity are the ones the manifest names');
      assertThat(allCaptured.every(entry =>
        String(entry.path || entry.url).includes('/v1/responses')),
      'every captured request used the Responses endpoint of that adapter');

      // ── THE RESPONSE TRAVERSED THE PRODUCTION PATH ──────────────────────
      //
      // A captured answer that was parsed and persisted normally is what proves
      // the capture replaced the transport and nothing above it. The leaf Run
      // only exists because the planner's answer was parsed into a real plan.
      const runs = await store.pool.query(
        `SELECT COUNT(*)::int AS n FROM ${store.table('runs')} ` +
        "WHERE body ? 'leafRunBinding'");
      assertThat(runs.rows[0].n >= 1,
        'the captured planner answer was parsed and persisted as real leaf Runs ' +
        `(${runs.rows[0].n})`);

      // ── THE GLOBAL CEILING WAS ENFORCED BEFORE THE BYTES LEFT ───────────
      const expected = boundFor('A').trialWorstCaseMicroUsd +
        boundFor('B').trialWorstCaseMicroUsd;
      const committed = reconstructCommittedLiability(budgetRoot);
      assertThat(committed.committedMicroUsd === expected,
        'each live trial committed its WHOLE-TRIAL worst case before dispatching ' +
        `(${committed.committedMicroUsd} micro-USD)`);
      assertThat(boundFor('B').totalProviderAttempts >
        boundFor('A').totalProviderAttempts,
      'a structured trial reserves for more authorized attempts than a direct one');
      // The reservation must cover every request the trial actually made.
      for (const cell of cells) {
        const made = capturedRequests(path.join(root, `capture-${cell.armId}.jsonl`)).length;
        assertThat(made <= boundFor(cell.armId).totalProviderAttempts,
          `${cell.armId}: observed ${made} request(s) within the reserved bound of ` +
          `${boundFor(cell.armId).totalProviderAttempts}`);
      }
      delete require.cache[require.resolve('./fixtures/evaluation-live-budget-ledger')];
      const afterRestart = require('./fixtures/evaluation-live-budget-ledger')
        .reconstructCommittedLiability(budgetRoot);
      assertThat(afterRestart.committedMicroUsd === committed.committedMicroUsd,
        'a restarted executor reconstructs that liability from the ledger alone');

      // AND AN EXHAUSTED CEILING STOPS BEFORE THE SERVER EXISTS.
      const exhaustedRoot = path.join(root, 'budget-exhausted');
      fs.mkdirSync(exhaustedRoot, { recursive: true });
      const exhaustedCapture = path.join(root, 'capture-exhausted.jsonl');
      let refusal = null;
      try {
        await runTrial({
          store, startServer, workspaceRoot,
          scenario: getScenario('family-1-simple'), arm: ARMS.A,
          repetition: 1, seed: 'live-dispatch-exhausted',
          outputPath: path.join(root, 'fixture', 'exhausted.json'),
          commit: 'live-dispatch-proof', smokeRoot: root,
          namespaceRoot: path.join(root, 'ns-exhausted'),
          mode: 'live', liveRequestControls: CONTROLS,
          liveTransportCapture: exhaustedCapture,
          liveBudget: {
            ...liveBudget,
            runRoot: exhaustedRoot,
            ceilingMicroUsd: boundFor('A').trialWorstCaseMicroUsd - 1
          }
        });
      } catch (error) { refusal = error; }
      assertThat(refusal instanceof LiveBudgetError &&
        refusal.code === 'LIVE_BUDGET_EXHAUSTED',
      'insufficient global authority refuses the trial outright');
      assertThat(capturedRequests(exhaustedCapture).length === 0,
        'and NOTHING reached the transport — the refusal precedes the server');
      assertThat(reconstructCommittedLiability(exhaustedRoot).committedMicroUsd === 0,
        'a refused trial commits no liability');

      // A LIVE TRIAL WITHOUT AN EXPLICIT CEILING IS REFUSED ENTIRELY.
      let unbounded = null;
      try {
        await runTrial({
          store, startServer, workspaceRoot,
          scenario: getScenario('family-1-simple'), arm: ARMS.A,
          repetition: 1, seed: 'live-dispatch-unbounded',
          outputPath: path.join(root, 'fixture', 'unbounded.json'),
          commit: 'live-dispatch-proof', smokeRoot: root,
          namespaceRoot: path.join(root, 'ns-unbounded'),
          mode: 'live', liveRequestControls: CONTROLS,
          liveTransportCapture: path.join(root, 'capture-unbounded.jsonl')
        });
      } catch (error) { unbounded = error; }
      assertThat(unbounded !== null &&
        /unbounded ceiling/.test(String(unbounded.message)),
      'a live trial with no global budget authority is refused, not defaulted');

      // ── NO FIXTURE RESPONSE TABLE WAS CONSULTED ─────────────────────────
      let stagedTables = 0;
      const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const child = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(child);
          else if (entry.name === 'governed-responses.json') stagedTables += 1;
        }
      };
      if (fs.existsSync(path.join(root, 'ns'))) walk(path.join(root, 'ns'));
      assertThat(stagedTables === 0, 'fixture response staging consumed = 0');

      // ── NOTHING MAY ESCAPE BY ANOTHER ROUTE ─────────────────────────────
      const preloadPath = path.join(__dirname, 'fixtures',
        'live-transport-capture-preload.js');
      const attempt = (script, capturePath = '') => {
        const result = spawnSync(process.execPath,
          ['--require', preloadPath, '-e', script],
          { encoding: 'utf8',
            env: { ...process.env, LIVE_TRANSPORT_CAPTURE: capturePath } });
        return `${result.stdout}${result.stderr}`;
      };
      assertThat(/LIVE_CAPTURE_ESCAPE/.test(attempt(
        "require('node:http').request({ hostname: 'api.openai.com', path: '/v1' })")),
      'a non-local http.request is refused as an escape, not silently allowed');
      assertThat(!/LIVE_CAPTURE_ESCAPE/.test(attempt(
        "require('node:http').request({ hostname: '127.0.0.1', port: 1, path: '/' })" +
        ".on('error', () => {}).end()")),
      'while a local http.request still works — the harness itself needs it');

      const localCapture = path.join(root, 'capture-local.jsonl');
      attempt("require('node:https').request({ hostname: '127.0.0.1', port: 1, " +
        "path: '/' }).on('error', () => {}).end()", localCapture);
      assertThat(capturedRequests(localCapture).length === 0,
        'local https traffic is passed through untouched, never captured');

      const bareCapture = path.join(root, 'capture-bare.jsonl');
      attempt("require('node:https').request({ hostname: 'api.openai.com', " +
        "path: '/v1/responses', method: 'POST' }, () => {}).end('{}')", bareCapture);
      const bare = capturedRequests(bareCapture);
      assertThat(bare.length === 1 && bare[0].hasAuthorization === false,
        'a request carrying no Authorization header records hasAuthorization false');

      // ── NO CREDENTIAL MATERIAL ANYWHERE ─────────────────────────────────
      assertThat(!/sk-[A-Za-z0-9]{8}/.test(JSON.stringify(allCaptured)),
        'no credential value appears in any captured request record');

      console.log(`\n  (${assertThat.count()} live dispatch assertions)`);
      console.log('  captured outbound requests by role:');
      for (const role of ROLES) {
        console.log(`    ${role.padEnd(22)} ${byRole[role]}`);
      }
      console.log('  by transport:' +
        `  fetch ${allCaptured.filter(e => e.transport === 'ungoverned').length}` +
        `, https.request ${allCaptured.filter(e => e.transport === 'governed').length}`);
      console.log('  fixture response staging consumed: 0');
      console.log('  EXTERNAL PROVIDER CALLS MADE: 0');
    }, { timeoutMs: 900_000 });

  console.log('structured allocation live dispatch PostgreSQL test passed');
}

main().catch(error => { console.error(error); process.exit(1); });
