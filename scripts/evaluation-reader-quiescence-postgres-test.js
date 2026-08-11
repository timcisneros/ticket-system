#!/usr/bin/env node
'use strict';

// Owner-109 regression: the evaluator's read-only report may begin only after
// every legitimate runtime writer has settled. This drives the actual REAL
// runner through a captured production provider boundary and deliberately
// blocks the post-terminal human-readable log. Before the fix, the parent
// Ticket could become terminal while that INSERT remained in flight, so
// observeQuiescence returned true and the report's before/after fingerprint
// blamed the reader for the background write.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { withHarness, createAsserter } = require('./postgres-test-harness');
const { ARMS } = require('./fixtures/evaluation-arms');
const { getScenario } = require('./fixtures/evaluation-scenarios');
const {
  observeQuiescence
} = require('./fixtures/evaluation-quiescence');
const {
  collectTrialObservations, durableFingerprint
} = require('./structured-allocation-evaluation-report');
const {
  runTrial
} = require('./structured-allocation-evaluation-runner');
const {
  resolveRealLiveCredentialAuthority
} = require('./fixtures/evaluation-server-env');
const {
  ROLE_ECONOMICS
} = require('./fixtures/governed-role-policy-container');
const {
  trialIdForLiveAssignment
} = require('./fixtures/evaluation-live-scoring');
const {
  liveManifest
} = require('./evaluation-live-scoring-dress-rehearsal-test');

const DUMMY_CREDENTIAL = 'test-only-reader-quiescence-credential';
const SERVER_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const CORRECTION_SOURCE = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: path.join(__dirname, '..'), encoding: 'utf8'
}).trim();
for (const boundary of [
  "await appendRunLog(interruptedRun, 'run:interrupted'",
  "await appendRunLog(failedRun, autoRetry.retried ? 'run:failed_auto_retried' : 'run:failed'",
  "await appendRunLog(failedRun, 'run:verification_failed'",
  "await appendRunLog(completedRun, 'run:completed'"
]) {
  if (!SERVER_SOURCE.includes(boundary)) {
    throw new Error(`terminal evidence settlement boundary is missing: ${boundary}`);
  }
}
const CONTROLS = Object.freeze({
  temperature: liveManifest.sampling.temperature,
  topP: liveManifest.sampling.topP,
  maxOutputTokens: liveManifest.maximumOutputTokensPerRequest
});
const PRICING = Object.freeze({
  provider: 'openai', model: 'gpt-4o-mini-2024-07-18',
  authorizedOutputTokens: 2048, boundInputTokens: 128000
});

const slot = liveManifest.slots.find(entry => entry.repetition === 3 &&
  entry.scenarioId === 'family-5-ownership-known' && entry.armId === 'B');
if (!slot || trialIdForLiveAssignment(slot) !== '03-013-family-5_5A-B') {
  throw new Error('owner-109 successor trial identity changed');
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx', mode: 0o600
  });
}

function readJsonLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}

async function waitForCondition(label, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaluation-reader-quiescence-'));
  const assertThat = createAsserter();
  try {
    await withHarness('evaluation reader quiescence', async ({
      store, schema, workspaceRoot, startServer
    }) => {
      const gateIdentity = `owner109-terminal-log:${schema}`;
      const gateClient = await store.pool.connect();
      let trialPromise = null;
      let trialArtifact = null;
      let trialError = null;
      try {
        await store.pool.query(`
          CREATE FUNCTION ${store.table('owner109_gate_terminal_log')}()
          RETURNS trigger LANGUAGE plpgsql AS $function$
          BEGIN
            IF NEW.type IN (
              'run:completed', 'run:verification_failed', 'run:failed',
              'run:failed_auto_retried', 'run:interrupted'
            ) THEN
              PERFORM pg_advisory_xact_lock(hashtextextended('${gateIdentity}', 0));
            END IF;
            RETURN NEW;
          END
          $function$;
          CREATE TRIGGER owner109_gate_terminal_log
          BEFORE INSERT ON ${store.table('diagnostic_logs')}
          FOR EACH ROW EXECUTE FUNCTION ${store.table('owner109_gate_terminal_log')}();
        `);
        await gateClient.query('BEGIN');
        await gateClient.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [gateIdentity]);

        const resolved = await resolveRealLiveCredentialAuthority({
          store: { getConfiguredAgentById: async () => ({
            id: 901, revision: 1, provider: 'openai',
            model: 'credential-authority-only', apiKey: DUMMY_CREDENTIAL
          }) },
          credentialAuthority: { kind: 'configured_agent', configuredAgentId: 901 },
          expectedProvider: 'openai'
        });
        const responsePath = path.join(root, 'captured-response.json');
        const observationPath = path.join(root, 'provider-boundary.jsonl');
        const outputPath = path.join(root, 'unscored-trial.json');
        const budgetRoot = path.join(root, 'budget');
        fs.mkdirSync(budgetRoot);
        writeJson(responsePath, { kind: 'role-aware-structured-success' });

        trialPromise = runTrial({
          store, startServer, workspaceRoot,
          scenario: getScenario(slot.scenarioId),
          arm: ARMS[slot.armId],
          variant: slot.variantId,
          repetition: slot.repetition,
          seed: slot.stochasticIdentity,
          outputPath,
          commit: CORRECTION_SOURCE,
          smokeRoot: root,
          namespaceRoot: path.join(root, 'namespaces'),
          mode: 'live',
          resolvedLiveCredentialAuthority: resolved,
          liveRequestControls: CONTROLS,
          liveProviderBoundaryObservation: observationPath,
          liveProviderBoundaryResponse: responsePath,
          liveBudget: {
            runRoot: budgetRoot,
            ceilingMicroUsd: liveManifest.economics.maximumTotalLiveMicroUsd,
            perRequestMicroUsd: liveManifest.economics.liability.perRequestMicroUsd,
            runtimeMaxModelRequestsPerRun:
              liveManifest.economics.liability.runtimeMaxModelRequestsPerRun,
            governedLeafMaximumProviderRequests:
              ROLE_ECONOMICS.structured_leaf_executor.maximumProviderRequests,
            governedPlannerMaximumProviderRequests:
              ROLE_ECONOMICS.structured_planner.maximumProviderRequests
          }
        }).then(
          artifact => { trialArtifact = artifact; },
          error => { trialError = error; }
        );

        const blocked = await waitForCondition('post-terminal log writer', async () => {
          const ticket = (await store.pool.query(
            `SELECT id, status FROM ${store.table('tickets')} ORDER BY id DESC LIMIT 1`
          )).rows[0];
          if (!ticket) return null;
          const blockedLogs = Number((await store.pool.query(
            `SELECT count(*)::int AS n
               FROM pg_stat_activity
              WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'
                AND query LIKE $1`,
            [`%INSERT INTO "${schema}"."diagnostic_logs"%`])).rows[0].n);
          if (blockedLogs === 0) return null;
          return {
            ticketId: Number(ticket.id), ticketStatus: ticket.status, blockedLogs,
            quiescence: await observeQuiescence(store, Number(ticket.id))
          };
        });

        assertThat(blocked.blockedLogs >= 1,
          'a legitimate post-terminal diagnostic writer is deliberately pending');
        assertThat(blocked.quiescence.quiescent === false,
          'the runner cannot report quiescence while that writer remains pending');
        assertThat(blocked.ticketStatus === 'in_progress',
          'the parent Ticket remains the authoritative non-quiescent projection');
        assertThat(!fs.existsSync(outputPath),
          'the runner has not accepted an artifact or invoked its report boundary');
        const blockedFingerprint = await durableFingerprint(store, blocked.ticketId);

        await gateClient.query('COMMIT');
        await trialPromise;
        if (trialError) throw trialError;
        const artifact = trialArtifact;
        const finalQuiescence = await observeQuiescence(store, blocked.ticketId);
        assertThat(finalQuiescence.quiescent === true,
          'quiescence becomes authoritative after the terminal writer settles');
        assertThat(fs.existsSync(outputPath) && artifact.artifactHash,
          'the actual runner accepts its artifact only after settlement');

        const before = await durableFingerprint(store, blocked.ticketId);
        const firstReport = await collectTrialObservations(store, {
          ticketId: blocked.ticketId, armId: slot.armId, pricingInputs: PRICING
        });
        const between = await durableFingerprint(store, blocked.ticketId);
        const secondReport = await collectTrialObservations(store, {
          ticketId: blocked.ticketId, armId: slot.armId, pricingInputs: PRICING
        });
        const after = await durableFingerprint(store, blocked.ticketId);
        assertThat(JSON.stringify(before) === JSON.stringify(between) &&
          JSON.stringify(between) === JSON.stringify(after),
        'both report reads leave the settled durable fingerprint unchanged');
        assertThat(JSON.stringify(firstReport) === JSON.stringify(secondReport),
          'both report reads return the same settled projection');
        assertThat(Number(before.logs) > Number(blockedFingerprint.logs),
          'the gated terminal log committed before the report boundary');

        const boundary = readJsonLines(observationPath);
        assertThat(boundary.length > 0 &&
          boundary.every(row => row.hostname === 'api.openai.com'),
        'the controlled final boundary intercepted every provider target');
        console.log(`PASS: owner-109 reader quiescence — ${assertThat.count()} assertions; ` +
          'provider calls 0');
      } finally {
        try { await gateClient.query('ROLLBACK'); } catch (_) {}
        if (trialPromise) {
          try { await trialPromise; } catch (_) {}
        }
        gateClient.release();
      }
    }, { timeoutMs: 120_000, schemaSlug: 'evaluation_reader_quiescence' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
