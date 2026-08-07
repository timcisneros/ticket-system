#!/usr/bin/env node
'use strict';

// Tranche 6 — the LIVE dispatch acceptance proof.
//
// THIS IS THE PROOF THAT WAS MISSING. The previous readiness gate certified
// LIVE READY on a dry run that "stopped before dispatch" — while no dispatch
// path existed beyond that stop, and the frozen sampling reached no request.
// A verdict like that cannot be repaired by documentation; it needs a test that
// drives the real path and inspects the bytes that would have left the machine.
//
// So this suite spawns a real server in LIVE mode — no hermetic response
// fixture, no staged answers — and replaces ONLY the final network hop. Every
// layer above it is production: role routing, economic admission, adapter
// selection and request-body construction. The recorded bodies are what
// production would have put on the wire.
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
const liveManifest = require('../config/structured-allocation-evaluation-live-v1.json');

const SAMPLING = Object.freeze({
  temperature: liveManifest.sampling.temperature,
  topP: liveManifest.sampling.topP
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

      // One direct arm and one structured arm: between them they exercise both
      // production transports and all three request roles.
      const cells = [
        { armId: 'A', scenarioId: 'family-1-simple', label: 'direct/legacy (fetch)' },
        { armId: 'B', scenarioId: 'family-1-simple', label: 'structured (https.request)' }
      ];

      // THE GLOBAL CEILING, as the real live run would carry it.
      const budgetRoot = path.join(root, 'budget');
      fs.mkdirSync(budgetRoot, { recursive: true });
      const perTrialMicroUsd = Math.round(liveManifest.economics.liability.perRequestMicroUsd);
      const liveBudget = {
        runRoot: budgetRoot,
        ceilingMicroUsd: liveManifest.economics.maximumTotalLiveMicroUsd,
        maximumTrialLiabilityMicroUsd: perTrialMicroUsd
      };

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
            liveSampling: SAMPLING,
            liveTransportCapture: capturePath,
            liveBudget
          });
        } catch (error) {
          // A product outcome is irrelevant here: this suite is about the bytes
          // that reached the transport, not about whether the Ticket succeeded.
          // A HARNESS failure is different and must be visible.
          if (process.env.LIVE_DISPATCH_DEBUG === '1') {
            console.log(`  [debug ${cell.armId}] ${String(error.message).slice(0, 300)}`);
          }
        }
        const captured = capturedRequests(capturePath);
        allCaptured.push(...captured);
        assertThat(captured.length > 0,
          `${cell.label}: the live path reached the real provider transport ` +
          `(${captured.length} outbound request(s))`);
      }

      // ── THE GLOBAL CEILING WAS ENFORCED BEFORE THE BYTES LEFT ───────────
      //
      // Liability is committed BEFORE the process that could dispatch is
      // spawned, so a request can never precede its own authorization.
      const committed = reconstructCommittedLiability(budgetRoot);
      assertThat(committed.committedMicroUsd === perTrialMicroUsd * cells.length,
        'each live trial committed its worst-case liability before dispatching ' +
        `(${committed.committedMicroUsd} micro-USD)`);
      // RESTART RECONSTRUCTION: a second reader, with no shared memory, derives
      // the same committed total from the durable ledger alone.
      delete require.cache[require.resolve('./fixtures/evaluation-live-budget-ledger')];
      const afterRestart =
        require('./fixtures/evaluation-live-budget-ledger')
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
          mode: 'live', liveSampling: SAMPLING,
          liveTransportCapture: exhaustedCapture,
          liveBudget: {
            runRoot: exhaustedRoot,
            ceilingMicroUsd: perTrialMicroUsd - 1,
            maximumTrialLiabilityMicroUsd: perTrialMicroUsd
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
          mode: 'live', liveSampling: SAMPLING,
          liveTransportCapture: path.join(root, 'capture-unbounded.jsonl')
        });
      } catch (error) { unbounded = error; }
      assertThat(unbounded !== null &&
        /unbounded ceiling/.test(String(unbounded.message)),
      'a live trial with no global budget authority is refused, not defaulted');

      // ── THE OUTBOUND BYTES ──────────────────────────────────────────────
      const governed = allCaptured.filter(entry => entry.transport === 'governed');
      const ungoverned = allCaptured.filter(entry => entry.transport === 'ungoverned');
      assertThat(governed.length > 0,
        'the governed transport (https.request) carried structured requests');
      assertThat(ungoverned.length > 0,
        'the ungoverned transport (fetch) carried direct/legacy requests');

      for (const entry of allCaptured) {
        const body = JSON.parse(entry.body);
        // THE FROZEN MANIFEST VALUES, on the wire.
        assertThat(body.model === liveManifest.model,
          `${entry.transport}: outbound model is the exact dated snapshot ` +
          `(${body.model})`);
        assertThat(body.temperature === SAMPLING.temperature,
          `${entry.transport}: outbound temperature is ${SAMPLING.temperature}`);
        assertThat(body.top_p === SAMPLING.topP,
          `${entry.transport}: outbound top_p is ${SAMPLING.topP}`);
        assertThat(!('seed' in body),
          `${entry.transport}: no provider seed appears in the outbound body`);
        assertThat(entry.hostname === 'api.openai.com',
          `${entry.transport}: the request was addressed to the real provider`);
      }
      // The governed roles additionally carry the frozen output cap.
      for (const entry of governed) {
        const body = JSON.parse(entry.body);
        assertThat(body.max_output_tokens === liveManifest.maximumOutputTokensPerRequest,
          `governed: outbound max_output_tokens is ` +
          `${liveManifest.maximumOutputTokensPerRequest}`);
        assertThat(body.truncation === 'disabled',
          'governed: truncation stays disabled, so the context ceiling still bounds cost');
        assertThat(entry.hasAuthorization === true,
          'governed: a credential header was formed without its value being recorded');
      }

      // ── NO FIXTURE RESPONSE TABLE WAS CONSULTED ─────────────────────────
      //
      // The whole point: these bytes came from production, not from a staged
      // answer selected by matching request text.
      const namespaces = fs.existsSync(path.join(root, 'ns'))
        ? fs.readdirSync(path.join(root, 'ns'), { withFileTypes: true }) : [];
      let stagedTables = 0;
      const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const child = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(child);
          else if (entry.name === 'governed-responses.json') stagedTables += 1;
        }
      };
      if (namespaces.length > 0) walk(path.join(root, 'ns'));
      assertThat(stagedTables === 0,
        'no governed response table was staged for the live run');

      // ── THE REQUESTS ARE DURABLY RECORDED, NOT JUST COUNTED ─────────────
      for (const entry of allCaptured) {
        assertThat(typeof entry.trialId === 'string' && entry.trialId.length > 0,
          `${entry.transport}: the outbound request is attributed to a named trial`);
        assertThat(typeof entry.body === 'string' && entry.body.length > 0,
          `${entry.transport}: the exact outbound body is durably recorded`);
      }

      // ── NOTHING MAY ESCAPE BY ANOTHER ROUTE ─────────────────────────────
      //
      // The capture replaces two boundaries. A request that left through a
      // third would spend real money while this suite reported zero calls, so
      // the guard is proved directly rather than assumed from a run that
      // happens not to exercise it.
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

      // LOCAL TRAFFIC IS NOT A PROVIDER CALL. If the capture intercepted it, the
      // harness would report outbound requests that never existed — and the
      // spawned server's own HTTP would stop working.
      const localCapture = path.join(root, 'capture-local.jsonl');
      attempt("require('node:https').request({ hostname: '127.0.0.1', port: 1, " +
        "path: '/' }).on('error', () => {}).end()", localCapture);
      assertThat(capturedRequests(localCapture).length === 0,
        'local https traffic is passed through untouched, never captured');

      // AND THE CREDENTIAL FLAG IS OBSERVED, NOT ASSERTED. A constant `true`
      // would make the governed assertion above vacuous.
      const bareCapture = path.join(root, 'capture-bare.jsonl');
      attempt("require('node:https').request({ hostname: 'api.openai.com', " +
        "path: '/v1/responses', method: 'POST' }, () => {}).end('{}')", bareCapture);
      const bare = capturedRequests(bareCapture);
      assertThat(bare.length === 1 && bare[0].hasAuthorization === false,
        'a request carrying no Authorization header records hasAuthorization false');

      // ── NO CREDENTIAL MATERIAL ANYWHERE ─────────────────────────────────
      const serialized = JSON.stringify(allCaptured);
      assertThat(!/sk-[A-Za-z0-9]{8}/.test(serialized),
        'no credential value appears in any captured request record');

      console.log(`\n  (${assertThat.count()} live dispatch assertions)`);
      console.log(`  outbound requests captured: ${allCaptured.length} ` +
        `(governed ${governed.length}, ungoverned ${ungoverned.length})`);
      console.log('  EXTERNAL PROVIDER CALLS MADE: 0');
    }, { timeoutMs: 900_000 });

  console.log('structured allocation live dispatch PostgreSQL test passed');
}

main().catch(error => { console.error(error); process.exit(1); });
