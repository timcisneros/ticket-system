#!/usr/bin/env node
'use strict';

// Tranche 6 — REAL-live configured-agent credential authority.
//
// Every credential in this test is fake. The provider boundary is replaced in
// the child before a byte can leave the machine. This suite proves that REAL
// live mode resolves one explicitly selected persisted configured-agent row,
// uses that same in-memory result for authenticated preflight and experiment,
// and never copies its secret into temporary trial agents or evidence.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const { ARMS } = require('./fixtures/evaluation-arms');
const { getScenario } = require('./fixtures/evaluation-scenarios');
const {
  EvaluationRunnerError,
  runHistoricalStructuredDispatchRehearsal,
  runTrial
} = require('./structured-allocation-evaluation-runner');
const {
  executeAuthorizedLiveRun,
  executeLiveRun
} = require('./structured-allocation-evaluation-scored-runner');
const {
  EvaluationServerEnvError,
  SENTINEL_CREDENTIAL,
  assertAuthenticatedPreflightAuthority,
  authenticatedRealLivePreflight,
  buildEvaluationServerCredentialEnv,
  classifyEvaluationServerMode,
  describeEvaluationServerCredential,
  resolveRealLiveCredentialAuthority
} = require('./fixtures/evaluation-server-env');
const { ROLE_ECONOMICS } = require('./fixtures/governed-role-policy-container');
const liveManifest = require('../config/structured-allocation-evaluation-live-v3.json');

const DUMMY_LIVE_CREDENTIAL = 'fake-configured-agent-authority-credential';
const DUMMY_OTHER_CREDENTIAL = 'fake-second-configured-agent-authority-credential';
const LIVE_MANIFEST_PATH = path.join(__dirname, '..', 'config',
  'structured-allocation-evaluation-live-v3.json');
const CONTROLS = Object.freeze({
  temperature: liveManifest.sampling.temperature,
  topP: liveManifest.sampling.topP,
  maxOutputTokens: liveManifest.maximumOutputTokensPerRequest
});

class SpawnBoundaryReached extends Error {
  constructor(childEnv) {
    super('SPAWN_BOUNDARY_REACHED');
    this.childEnv = childEnv;
  }
}

const SAFE_DIAGNOSTIC_TOKEN = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/;

function safeDiagnosticToken(value) {
  return typeof value === 'string' && SAFE_DIAGNOSTIC_TOKEN.test(value)
    ? value : null;
}

function safeTrialErrorIdentity(error) {
  return Object.freeze({
    errorName: safeDiagnosticToken(error && error.name) || 'Error',
    errorCode: safeDiagnosticToken(error && (error.code ||
      (error.detail && error.detail.code))) || null,
    repositoryStage: safeDiagnosticToken(error && error.detail && error.detail.stage) || null
  });
}

class EvaluationCredentialRoleTrialFailure extends Error {
  constructor({ armId, phase, error }) {
    const identity = safeTrialErrorIdentity(error);
    const safeArmId = safeDiagnosticToken(armId) || 'unknown-arm';
    const suffix = [identity.errorName, identity.errorCode, identity.repositoryStage]
      .filter(Boolean).join('/');
    super(`credential role ${safeArmId} failed during ${phase}${suffix ? ` (${suffix})` : ''}`);
    this.name = 'EvaluationCredentialRoleTrialFailure';
    this.code = 'EVALUATION_CREDENTIAL_ROLE_TRIAL_FAILED';
    this.detail = Object.freeze({ armId: safeArmId, phase, ...identity });
  }
}

async function runCredentialRoleTrial({
  armId,
  runControlledTrial,
  artifactPresent,
  readBoundaryObservations
}) {
  let artifact;
  try {
    artifact = await runControlledTrial();
  } catch (error) {
    // Never pass the raw Error through this owner. Provider adapters and child
    // processes may attach request or environment detail to arbitrary errors;
    // the owner retains only controlled phase plus bounded repository tokens.
    throw new EvaluationCredentialRoleTrialFailure({
      armId, phase: 'child_runner_execution', error
    });
  }

  let retainedArtifactPresent = false;
  try {
    retainedArtifactPresent = Boolean(artifact) && artifactPresent() === true;
  } catch (error) {
    throw new EvaluationCredentialRoleTrialFailure({
      armId, phase: 'artifact_collection', error
    });
  }
  if (!retainedArtifactPresent) {
    const error = new Error('artifact absent');
    error.name = 'ArtifactMissing';
    error.code = 'EVALUATION_CREDENTIAL_ROLE_ARTIFACT_MISSING';
    throw new EvaluationCredentialRoleTrialFailure({
      armId, phase: 'artifact_collection', error
    });
  }

  try {
    const observations = readBoundaryObservations();
    if (!Array.isArray(observations)) {
      const error = new TypeError('boundary observations must be an array');
      error.code = 'EVALUATION_CREDENTIAL_BOUNDARY_OBSERVATIONS_INVALID';
      throw error;
    }
    return Object.freeze({
      artifact,
      observations: Object.freeze(observations)
    });
  } catch (error) {
    throw new EvaluationCredentialRoleTrialFailure({
      armId, phase: 'provider_boundary_interception', error
    });
  }
}

async function proveCredentialRoleFailureAttribution(assertThat) {
  const untrustedMessage = 'untrusted trial detail must not survive';
  let preBoundaryFailure = null;
  try {
    await runCredentialRoleTrial({
      armId: 'A2b',
      runControlledTrial: async () => {
        const error = new Error(untrustedMessage);
        error.name = 'ControlledPreBoundaryFailure';
        error.code = 'CONTROLLED_PRE_BOUNDARY_FAILURE';
        throw error;
      },
      artifactPresent: () => false,
      readBoundaryObservations: () => []
    });
  } catch (error) { preBoundaryFailure = error; }
  assertThat(preBoundaryFailure instanceof EvaluationCredentialRoleTrialFailure &&
    preBoundaryFailure.code === 'EVALUATION_CREDENTIAL_ROLE_TRIAL_FAILED' &&
    preBoundaryFailure.detail.armId === 'A2b' &&
    preBoundaryFailure.detail.phase === 'child_runner_execution' &&
    preBoundaryFailure.detail.errorName === 'ControlledPreBoundaryFailure' &&
    preBoundaryFailure.detail.errorCode === 'CONTROLLED_PRE_BOUNDARY_FAILURE' &&
    !preBoundaryFailure.message.includes(untrustedMessage) &&
    !preBoundaryFailure.message.includes('final-hop observations'),
  'a controlled pre-boundary failure remains a safe trial failure before credential assertions');

  let wrongCredentialObservation = null;
  try {
    const result = await runCredentialRoleTrial({
      armId: 'A2b',
      runControlledTrial: async () => ({ kind: 'controlled-artifact' }),
      artifactPresent: () => true,
      readBoundaryObservations: () => [{
        hasAuthorization: true,
        authorizationMatchesProjectedCredential: false
      }]
    });
    if (!(result.observations.length > 0 && result.observations.every(item =>
      item.hasAuthorization === true &&
      item.authorizationMatchesProjectedCredential === true))) {
      throw new Error(
        'A2b final-hop observations use the projected configured-agent credential');
    }
  } catch (error) { wrongCredentialObservation = error; }
  assertThat(wrongCredentialObservation instanceof Error &&
    !(wrongCredentialObservation instanceof EvaluationCredentialRoleTrialFailure) &&
    wrongCredentialObservation.message ===
      'A2b final-hop observations use the projected configured-agent credential',
  'a controlled wrong final-hop credential observation still fails the existing credential assertion');
}

function budget(root) {
  fs.mkdirSync(root, { recursive: true });
  return {
    runRoot: root,
    ceilingMicroUsd: liveManifest.economics.maximumTotalLiveMicroUsd,
    perRequestMicroUsd: liveManifest.economics.liability.perRequestMicroUsd,
    runtimeMaxModelRequestsPerRun:
      liveManifest.economics.liability.runtimeMaxModelRequestsPerRun,
    governedLeafMaximumProviderRequests:
      ROLE_ECONOMICS.structured_leaf_executor.maximumProviderRequests,
    governedPlannerMaximumProviderRequests:
      ROLE_ECONOMICS.structured_planner.maximumProviderRequests
  };
}

function readJsonLines(target) {
  if (!fs.existsSync(target)) return [];
  return fs.readFileSync(target, 'utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line));
}

function fileTreeContains(root, needle) {
  if (!fs.existsSync(root)) return false;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (fileTreeContains(target, needle)) return true;
    } else if (fs.readFileSync(target).includes(Buffer.from(needle))) return true;
  }
  return false;
}

async function maxConfiguredAgentId(store) {
  return Number((await store.pool.query(
    `SELECT COALESCE(max(id), 0) AS id FROM ${store.table('configured_agents')}`
  )).rows[0].id);
}

async function configuredAgentsAfter(store, id) {
  return (await store.pool.query(
    `SELECT id, body ? 'apiKey' AS has_credential
       FROM ${store.table('configured_agents')} WHERE id > $1 ORDER BY id`, [id]
  )).rows;
}

async function captureSpawn(operation) {
  try { await operation(); } catch (error) {
    let cursor = error;
    while (cursor && !(cursor instanceof SpawnBoundaryReached)) cursor = cursor.cause;
    if (cursor instanceof SpawnBoundaryReached) return cursor.childEnv;
    if (error instanceof SpawnBoundaryReached) return error.childEnv;
    throw error;
  }
  return null;
}

async function main() {
  const root = path.join('/tmp', `ticket-system-live-credential-${process.pid}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'out'), { recursive: true });
  const roleResponse = path.join(root, 'role-response.json');
  fs.writeFileSync(roleResponse, JSON.stringify({
    kind: 'role-aware-structured-success'
  }));

  await withHarness('evaluation live credential',
    async ({ store, workspaceRoot, startServer }) => {
      const assertThat = createAsserter();

      const authorityAgent = (await store.createConfiguredAgent({
        value: {
          name: 'Explicit evaluation credential authority',
          provider: 'openai',
          // Deliberately differs from the experiment model. The row is
          // credential authority, never execution-target authority.
          model: 'credential-authority-model-is-not-the-matrix-model',
          apiKey: DUMMY_LIVE_CREDENTIAL
        },
        changedBy: 'evaluation-credential-test'
      })).agent;
      const selection = Object.freeze({
        kind: 'configured_agent', configuredAgentId: authorityAgent.id
      });
      const resolved = await resolveRealLiveCredentialAuthority({
        store, credentialAuthority: selection, expectedProvider: liveManifest.provider
      });

      assertThat(resolved.nonSecretIdentity.kind === 'configured_agent' &&
        resolved.nonSecretIdentity.configuredAgentId === authorityAgent.id &&
        resolved.nonSecretIdentity.configuredAgentRevision === authorityAgent.revision &&
        resolved.nonSecretIdentity.provider === 'openai',
      'the resolver binds the explicitly selected configured-agent id, revision and provider');
      assertThat(resolved.nonSecretIdentity.model === undefined &&
        JSON.stringify(resolved).includes(DUMMY_LIVE_CREDENTIAL) === false,
      'the credential-authority row model cannot override the frozen matrix model, ' +
      'and the secret is non-enumerable');

      // ── EXACT MODE MATRIX ─────────────────────────────────────────────
      assertThat(classifyEvaluationServerMode({ mode: 'fixture' }) === 'fixture' &&
        classifyEvaluationServerMode({ mode: 'live', liveTransportCapture: '/capture' }) ===
          'synthetic_live_capture' &&
        classifyEvaluationServerMode({ mode: 'live', liveTransportCapture: null }) ===
          'real_uncaptured_live',
      'fixture, captured live and real uncaptured live are separate modes');

      const fixtureBuilt = buildEvaluationServerCredentialEnv({ mode: 'fixture' });
      const capturedBuilt = buildEvaluationServerCredentialEnv({
        mode: 'live', liveTransportCapture: '/capture'
      });
      const liveBuilt = buildEvaluationServerCredentialEnv({
        mode: 'live', liveTransportCapture: null,
        resolvedLiveCredentialAuthority: resolved
      });
      assertThat(fixtureBuilt.env.OPENAI_API_KEY === SENTINEL_CREDENTIAL &&
        capturedBuilt.env.OPENAI_API_KEY === SENTINEL_CREDENTIAL,
      'fixture and captured-live modes retain the sentinel escape guard');
      assertThat(liveBuilt.env.OPENAI_API_KEY === DUMMY_LIVE_CREDENTIAL &&
        liveBuilt.env.OPENAI_API_KEY !== SENTINEL_CREDENTIAL,
      'real uncaptured live projects the selected configured-agent credential');
      assertThat(!JSON.stringify(describeEvaluationServerCredential(liveBuilt))
        .includes(DUMMY_LIVE_CREDENTIAL),
      'the observable server-credential description contains no secret');

      let missingAuthority = null;
      try {
        buildEvaluationServerCredentialEnv({
          mode: 'live', liveTransportCapture: null
        });
      } catch (error) { missingAuthority = error; }
      assertThat(missingAuthority instanceof EvaluationServerEnvError &&
        missingAuthority.code === 'REAL_LIVE_CREDENTIAL_AUTHORITY_UNRESOLVED',
      'real uncaptured live refuses an unresolved authority before spawn');

      let hermeticAuthority = null;
      try {
        buildEvaluationServerCredentialEnv({
          mode: 'live', liveTransportCapture: '/capture',
          resolvedLiveCredentialAuthority: resolved
        });
      } catch (error) { hermeticAuthority = error; }
      assertThat(hermeticAuthority instanceof EvaluationServerEnvError &&
        hermeticAuthority.code === 'HERMETIC_MODE_REAL_CREDENTIAL_FORBIDDEN',
      'captured live refuses a real authority object rather than risking secret projection');

      for (const [label, fakeAgent, expectedCode] of [
        ['missing row', null, 'REAL_LIVE_CREDENTIAL_AUTHORITY_NOT_FOUND'],
        ['wrong provider', { id: 99, revision: 1, provider: 'ollama', apiKey: 'fake' },
          'REAL_LIVE_CREDENTIAL_AUTHORITY_PROVIDER_MISMATCH'],
        ['missing persisted credential', { id: 99, revision: 1, provider: 'openai' },
          'REAL_LIVE_CREDENTIAL_AUTHORITY_CREDENTIAL_ABSENT']
      ]) {
        let refusal = null;
        try {
          await resolveRealLiveCredentialAuthority({
            store: { getConfiguredAgentById: async () => fakeAgent },
            credentialAuthority: { kind: 'configured_agent', configuredAgentId: 99 },
            expectedProvider: 'openai'
          });
        } catch (error) { refusal = error; }
        assertThat(refusal instanceof EvaluationServerEnvError &&
          refusal.code === expectedCode,
        `${label} refuses through the canonical authority resolver`);
      }

      // ── ONE AUTHORITY OBJECT, TWO CONSUMERS ───────────────────────────
      let preflightCredentialMatched = false;
      let preflightControlsMatched = false;
      const fakePreflightTransport = async ({ credential, body }) => {
        preflightCredentialMatched = credential === DUMMY_LIVE_CREDENTIAL;
        preflightControlsMatched = body.model === liveManifest.model &&
          body.temperature === liveManifest.sampling.temperature &&
          body.top_p === liveManifest.sampling.topP &&
          body.max_output_tokens === liveManifest.maximumOutputTokensPerRequest &&
          body.seed === undefined;
        return {
          ok: true,
          status: 200,
          requestId: 'fake-preflight-request',
          body: {
            model: liveManifest.model,
            usage: { input_tokens: 17, output_tokens: 9, total_tokens: 26 }
          }
        };
      };
      const preflight = await authenticatedRealLivePreflight({
        manifest: liveManifest,
        resolvedLiveCredentialAuthority: resolved,
        transport: fakePreflightTransport
      });
      assertThat(preflightCredentialMatched && preflightControlsMatched,
        'captured authenticated preflight uses the resolved credential and exact frozen controls');
      assertThat(assertAuthenticatedPreflightAuthority({
        preflight,
        resolvedLiveCredentialAuthority: resolved,
        manifestHash: liveManifest.manifestHash
      }) === true,
      'preflight and experiment mechanically share the same resolved authority object');
      assertThat(!JSON.stringify(preflight).includes(DUMMY_LIVE_CREDENTIAL),
        'authenticated-preflight evidence contains no credential or derivative');

      const independentlyResolved = await resolveRealLiveCredentialAuthority({
        store, credentialAuthority: selection, expectedProvider: liveManifest.provider
      });
      let independentlyResolvedRefusal = null;
      try {
        assertAuthenticatedPreflightAuthority({
          preflight,
          resolvedLiveCredentialAuthority: independentlyResolved,
          manifestHash: liveManifest.manifestHash
        });
      } catch (error) { independentlyResolvedRefusal = error; }
      assertThat(independentlyResolvedRefusal instanceof EvaluationServerEnvError &&
        independentlyResolvedRefusal.code ===
          'REAL_LIVE_PREFLIGHT_EXPERIMENT_AUTHORITY_MISMATCH',
      'matching strings from a second resolver call cannot impersonate the preflight authority');

      // ── THE HARNESS STRIPS AMBIENT PARENT CREDENTIALS ─────────────────
      const ambientBefore = process.env.OPENAI_API_KEY;
      const ambientNamespaceBefore = process.env.EVALUATION_FIXTURE_NAMESPACE;
      process.env.OPENAI_API_KEY = DUMMY_OTHER_CREDENTIAL;
      process.env.EVALUATION_FIXTURE_NAMESPACE = 'ambient-authority-must-not-propagate';
      let ordinaryEnv = null;
      try {
        ordinaryEnv = await captureSpawn(() => startServer({
          spawnEnvObserver: childEnv => { throw new SpawnBoundaryReached(childEnv); }
        }));
      } finally {
        if (ambientBefore === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = ambientBefore;
        if (ambientNamespaceBefore === undefined) {
          delete process.env.EVALUATION_FIXTURE_NAMESPACE;
        } else {
          process.env.EVALUATION_FIXTURE_NAMESPACE = ambientNamespaceBefore;
        }
      }
      assertThat(ordinaryEnv && ordinaryEnv.OPENAI_API_KEY === undefined &&
        ordinaryEnv.EVALUATION_FIXTURE_NAMESPACE === undefined,
      'an ordinary server spawn strips ambient credential and historical namespace authority');

      // ── TEMPORARY AGENT MODE BEHAVIOUR AT SPAWN ──────────────────────
      const liveBefore = await maxConfiguredAgentId(store);
      const liveChildEnv = await captureSpawn(() => runTrial({
        store, startServer, workspaceRoot,
        scenario: getScenario('family-1-simple'), arm: ARMS.A,
        repetition: 1, seed: 'real-authority-spawn',
        outputPath: path.join(root, 'out', 'real-spawn.json'),
        commit: 'credential-proof', smokeRoot: root,
        namespaceRoot: path.join(root, 'ns-real-spawn'),
        mode: 'live', liveTransportCapture: null,
        resolvedLiveCredentialAuthority: resolved,
        liveRequestControls: CONTROLS,
        liveBudget: budget(path.join(root, 'budget-real-spawn')),
        spawnEnvObserver: childEnv => { throw new SpawnBoundaryReached(childEnv); }
      }));
      const realTrialAgents = await configuredAgentsAfter(store, liveBefore);
      assertThat(liveChildEnv &&
        liveChildEnv.OPENAI_API_KEY === DUMMY_LIVE_CREDENTIAL &&
        !String(liveChildEnv.NODE_OPTIONS || '').includes('live-transport-capture-preload') &&
        liveChildEnv.EVALUATION_FIXTURE_NAMESPACE === undefined,
      'real uncaptured trial projects the selected credential without capture or historical activation authority');
      assertThat(realTrialAgents.length >= 2 &&
        realTrialAgents.every(row => row.has_credential === false),
      'real temporary trial-agent rows persist no credential and cannot shadow projection');

      const capturedChildEnv = await captureSpawn(() => runTrial({
        store, startServer, workspaceRoot,
        scenario: getScenario('family-1-simple'), arm: ARMS.A,
        repetition: 1, seed: 'captured-authority-spawn',
        outputPath: path.join(root, 'out', 'captured-spawn.json'),
        commit: 'credential-proof', smokeRoot: root,
        namespaceRoot: path.join(root, 'ns-captured-spawn'),
        mode: 'live',
        liveTransportCapture: path.join(root, 'captured-spawn.jsonl'),
        liveRequestControls: CONTROLS,
        liveBudget: budget(path.join(root, 'budget-captured-spawn')),
        spawnEnvObserver: childEnv => { throw new SpawnBoundaryReached(childEnv); }
      }));
      assertThat(capturedChildEnv &&
        capturedChildEnv.OPENAI_API_KEY === SENTINEL_CREDENTIAL &&
        String(capturedChildEnv.NODE_OPTIONS || '').includes('live-transport-capture-preload') &&
        capturedChildEnv.EVALUATION_FIXTURE_NAMESPACE === undefined,
      'transport-captured live retains the sentinel without historical structured activation authority');

      const historicalNamespaceRoot = path.join(root, 'ns-historical-captured-spawn');
      const historicalCapturedChildEnv = await captureSpawn(() =>
        runHistoricalStructuredDispatchRehearsal({
          store, startServer, workspaceRoot,
          scenario: getScenario('family-1-simple'), arm: ARMS.B,
          repetition: 1, seed: 'historical-captured-authority-spawn',
          outputPath: path.join(root, 'out', 'historical-captured-spawn.json'),
          commit: 'credential-proof', smokeRoot: root,
          namespaceRoot: historicalNamespaceRoot,
          mode: 'live',
          liveTransportCapture: path.join(root, 'historical-captured-spawn.jsonl'),
          liveRequestControls: CONTROLS,
          liveBudget: budget(path.join(root, 'budget-historical-captured-spawn')),
          spawnEnvObserver: childEnv => { throw new SpawnBoundaryReached(childEnv); }
        }));
      assertThat(historicalCapturedChildEnv &&
        historicalCapturedChildEnv.OPENAI_API_KEY === SENTINEL_CREDENTIAL &&
        String(historicalCapturedChildEnv.NODE_OPTIONS || '')
          .includes('live-transport-capture-preload') &&
        typeof historicalCapturedChildEnv.EVALUATION_FIXTURE_NAMESPACE === 'string' &&
        historicalCapturedChildEnv.EVALUATION_FIXTURE_NAMESPACE
          .startsWith(`${historicalNamespaceRoot}${path.sep}`),
      'the named provider-free historical rehearsal alone receives its isolated namespace');

      let historicalWithoutCapture = null;
      let historicalServerStarted = false;
      try {
        await runHistoricalStructuredDispatchRehearsal({
          store,
          startServer: async () => {
            historicalServerStarted = true;
            throw new Error('unreachable');
          },
          workspaceRoot,
          scenario: getScenario('family-1-simple'), arm: ARMS.B,
          repetition: 1, seed: 'historical-without-capture',
          outputPath: path.join(root, 'out', 'historical-without-capture.json'),
          commit: 'credential-proof', smokeRoot: root,
          namespaceRoot: path.join(root, 'ns-historical-without-capture'),
          mode: 'live', liveTransportCapture: null,
          liveRequestControls: CONTROLS,
          liveBudget: budget(path.join(root, 'budget-historical-without-capture'))
        });
      } catch (error) { historicalWithoutCapture = error; }
      assertThat(historicalWithoutCapture instanceof EvaluationRunnerError &&
        historicalWithoutCapture.detail.code ===
          'HISTORICAL_STRUCTURED_DISPATCH_CAPTURE_REQUIRED' &&
        historicalServerStarted === false,
      'the historical rehearsal cannot authorize an uncaptured REAL provider run');

      let historicalWithRealAuthority = null;
      try {
        await runHistoricalStructuredDispatchRehearsal({
          mode: 'live',
          liveTransportCapture: path.join(root, 'forbidden-real-authority-capture.jsonl'),
          resolvedLiveCredentialAuthority: resolved
        });
      } catch (error) { historicalWithRealAuthority = error; }
      assertThat(historicalWithRealAuthority instanceof EvaluationRunnerError &&
        historicalWithRealAuthority.detail.code ===
          'HISTORICAL_STRUCTURED_DISPATCH_REAL_AUTHORITY_FORBIDDEN',
      'the historical rehearsal refuses resolved REAL credential authority');

      let forgedHistoricalAuthority = null;
      try {
        await runTrial({
          mode: 'live',
          liveTransportCapture: path.join(root, 'forged-authority-capture.jsonl'),
          historicalStructuredDispatchRehearsalAuthority: Symbol('forged')
        });
      } catch (error) { forgedHistoricalAuthority = error; }
      assertThat(forgedHistoricalAuthority instanceof EvaluationRunnerError &&
        forgedHistoricalAuthority.detail.code ===
          'HISTORICAL_STRUCTURED_DISPATCH_AUTHORITY_INVALID',
      'a generic runner caller cannot forge the named historical authority');

      const fixtureChildEnv = await captureSpawn(() => runTrial({
        store, startServer, workspaceRoot,
        scenario: getScenario('family-1-simple'), arm: ARMS.A,
        repetition: 1, seed: 'fixture-authority-spawn',
        outputPath: path.join(root, 'out', 'fixture-spawn.json'),
        commit: 'credential-proof', smokeRoot: root,
        namespaceRoot: path.join(root, 'ns-fixture-spawn'),
        spawnEnvObserver: childEnv => { throw new SpawnBoundaryReached(childEnv); }
      }));
      assertThat(fixtureChildEnv &&
        fixtureChildEnv.OPENAI_API_KEY === SENTINEL_CREDENTIAL &&
        String(fixtureChildEnv.NODE_OPTIONS || '').includes('evaluation-preload') &&
        typeof fixtureChildEnv.EVALUATION_FIXTURE_NAMESPACE === 'string',
      'fixture mode retains the sentinel, hermetic response preload and historical reconstruction authority');

      // ── EVERY PROVIDER-BEARING ROLE ──────────────────────────────────
      await proveCredentialRoleFailureAttribution(assertThat);
      const roleProof = {};
      for (const armId of ['A', 'A2a', 'A2b', 'B', 'C']) {
        const observation = path.join(root, `role-${armId}.jsonl`);
        const outputPath = path.join(root, 'out', `role-${armId}.json`);
        const before = await maxConfiguredAgentId(store);
        const roleTrial = await runCredentialRoleTrial({
          armId,
          runControlledTrial: () => runTrial({
            store, startServer, workspaceRoot,
            scenario: getScenario('family-1-simple'), arm: ARMS[armId],
            repetition: 1, seed: `credential-role-${armId}`,
            outputPath,
            commit: 'credential-proof', smokeRoot: root,
            namespaceRoot: path.join(root, `ns-role-${armId}`),
            mode: 'live', liveTransportCapture: null,
            resolvedLiveCredentialAuthority: resolved,
            liveProviderBoundaryObservation: observation,
            liveProviderBoundaryResponse: roleResponse,
            liveRequestControls: CONTROLS,
            liveBudget: budget(path.join(root, `budget-role-${armId}`))
          }),
          artifactPresent: () => fs.existsSync(outputPath),
          readBoundaryObservations: () => readJsonLines(observation)
        });
        const observations = roleTrial.observations;
        const tempAgents = await configuredAgentsAfter(store, before);
        roleProof[armId] = { observations };
        assertThat(observations.length > 0,
          `${armId} reaches provider-boundary interception before credential inspection`);
        assertThat(observations.length > 0 && observations.every(item =>
          item.hasAuthorization === true &&
          item.authorizationMatchesProjectedCredential === true),
        `${armId} final-hop observations use the projected configured-agent credential`);
        assertThat(tempAgents.length >= 2 &&
          tempAgents.every(row => row.has_credential === false),
        `${armId} temporary agents persist no credential`);
      }
      for (const armId of ['A', 'A2a', 'A2b']) {
        assertThat(roleProof[armId].observations.every(item =>
          item.role === 'ungoverned_worker' && item.transport === 'ungoverned'),
        `${armId} proves the ungoverned worker credential path`);
      }
      for (const armId of ['B', 'C']) {
        const roles = new Set(roleProof[armId].observations.map(item => item.role));
        assertThat(roles.has('structured_planner') && roles.has('governed_leaf_worker') &&
          roleProof[armId].observations.every(item => item.transport === 'governed'),
        `${armId} proves both structured-planner and governed-leaf credential paths`);
      }

      // Missing real authority refuses before trial state, transport or artifact.
      const beforeMissing = await maxConfiguredAgentId(store);
      let serverStarted = false;
      let missingTrial = null;
      try {
        await runTrial({
          store,
          startServer: async () => { serverStarted = true; throw new Error('unreachable'); },
          workspaceRoot,
          scenario: getScenario('family-1-simple'), arm: ARMS.A,
          repetition: 1, seed: 'missing-real-authority',
          outputPath: path.join(root, 'out', 'missing-authority.json'),
          commit: 'credential-proof', smokeRoot: root,
          namespaceRoot: path.join(root, 'ns-missing-authority'),
          mode: 'live', liveTransportCapture: null,
          liveRequestControls: CONTROLS,
          liveBudget: budget(path.join(root, 'budget-missing-authority'))
        });
      } catch (error) { missingTrial = error; }
      assertThat(missingTrial instanceof EvaluationServerEnvError &&
        missingTrial.code === 'REAL_LIVE_CREDENTIAL_AUTHORITY_UNRESOLVED' &&
        serverStarted === false &&
        await maxConfiguredAgentId(store) === beforeMissing &&
        !fs.existsSync(path.join(root, 'out', 'missing-authority.json')),
      'missing real authority refuses before server, transport, trial rows or artifact');

      // ── REAL HEADER + RESUME REVISION BINDING ─────────────────────────
      const headerRoot = path.join(root, 'real-header-run');
      let authorizedPreflightCalls = 0;
      const authorized = await executeAuthorizedLiveRun({
        manifestPath: LIVE_MANIFEST_PATH,
        outputRoot: headerRoot,
        credentialAuthority: selection,
        authorityStore: store,
        limit: 0,
        preflightTransport: async input => {
          authorizedPreflightCalls += 1;
          return fakePreflightTransport(input);
        }
      });
      assertThat(authorizedPreflightCalls === 1 &&
        authorized.header.credentialAuthority.configuredAgentId === authorityAgent.id &&
        authorized.header.credentialAuthority.configuredAgentRevision ===
          authorityAgent.revision &&
        !JSON.stringify(authorized.header).includes(DUMMY_LIVE_CREDENTIAL),
      'the initial real header binds non-secret configured-agent identity after one preflight');

      const sameRevisionResume = await executeAuthorizedLiveRun({
        manifestPath: LIVE_MANIFEST_PATH,
        outputRoot: headerRoot,
        credentialAuthority: selection,
        authorityStore: store,
        resume: true,
        limit: 0
      });
      assertThat(sameRevisionResume.header.runHeaderHash ===
        authorized.header.runHeaderHash && authorizedPreflightCalls === 1,
      'resume accepts the same id/revision and does not repeat authenticated preflight');

      const otherAgent = (await store.createConfiguredAgent({
        value: {
          name: 'Other explicit evaluation credential authority',
          provider: 'openai', model: '', apiKey: DUMMY_OTHER_CREDENTIAL
        },
        changedBy: 'evaluation-credential-test'
      })).agent;
      let changedId = null;
      try {
        await executeAuthorizedLiveRun({
          manifestPath: LIVE_MANIFEST_PATH,
          outputRoot: headerRoot,
          credentialAuthority: {
            kind: 'configured_agent', configuredAgentId: otherAgent.id
          },
          authorityStore: store,
          resume: true,
          limit: 0
        });
      } catch (error) { changedId = error; }
      assertThat(changedId && changedId.detail &&
        changedId.detail.code === 'REAL_LIVE_CREDENTIAL_AUTHORITY_CHANGED',
      'resume refuses a different configured-agent authority id');

      const updatedAuthority = (await store.updateConfiguredAgent({
        agentId: authorityAgent.id,
        expectedRevision: authorityAgent.revision,
        value: {
          ...authorityAgent,
          model: 'still-not-the-matrix-model',
          apiKey: DUMMY_LIVE_CREDENTIAL
        },
        groupIds: authorityAgent.groupIds,
        changedBy: 'evaluation-credential-test'
      })).agent;
      assertThat(updatedAuthority.revision === authorityAgent.revision + 1,
        'configured-agent edit advances the durable authority revision');
      let changedRevision = null;
      try {
        await executeAuthorizedLiveRun({
          manifestPath: LIVE_MANIFEST_PATH,
          outputRoot: headerRoot,
          credentialAuthority: selection,
          authorityStore: store,
          resume: true,
          limit: 0
        });
      } catch (error) { changedRevision = error; }
      assertThat(changedRevision && changedRevision.detail &&
        changedRevision.detail.code === 'REAL_LIVE_CREDENTIAL_AUTHORITY_CHANGED',
      'resume refuses after the authority-bearing configured-agent revision changes');

      const syntheticRoot = path.join(root, 'synthetic-header-run');
      const synthetic = await executeLiveRun({
        manifestPath: LIVE_MANIFEST_PATH,
        outputRoot: syntheticRoot,
        limit: 0,
        syntheticTransportCapture: path.join(root, 'synthetic-capture')
      });
      assertThat(synthetic.header.syntheticAcceptance === true &&
        synthetic.header.credentialAuthority === null,
      'synthetic acceptance remains separate and requires no real-live authority binding');

      // ── SECRET NON-PERSISTENCE / NON-DISCLOSURE ───────────────────────
      const diagnostics = await store.pool.query(
        `SELECT EXISTS (
           SELECT 1 FROM ${store.table('diagnostic_logs')}
            WHERE body::text LIKE '%' || $1 || '%'
         ) AS leaked`, [DUMMY_LIVE_CREDENTIAL]);
      const tempCredentialCopies = await store.pool.query(
        `SELECT count(*)::integer AS copies
           FROM ${store.table('configured_agents')}
          WHERE id <> $1 AND body ->> 'apiKey' = $2`,
      [authorityAgent.id, DUMMY_LIVE_CREDENTIAL]);
      const observableFailures = JSON.stringify([
        missingAuthority, hermeticAuthority, independentlyResolvedRefusal,
        missingTrial, changedId, changedRevision
      ]);
      assertThat(diagnostics.rows[0].leaked === false &&
        tempCredentialCopies.rows[0].copies === 0,
      'the credential appears only in its selected durable authority row, not ' +
      'temporary agents or diagnostic logs');
      assertThat(!fileTreeContains(root, DUMMY_LIVE_CREDENTIAL) &&
        !observableFailures.includes(DUMMY_LIVE_CREDENTIAL),
      'headers, journals, trial artifacts, corpus metadata, preflight evidence, ' +
      'logs and errors contain no credential');

      console.log(`\n  (${assertThat.count()} credential-authority assertions)`);
      console.log('  authority selection    : explicit configured-agent id/revision');
      console.log('  fixture/captured       : hermetic sentinel');
      console.log('  real temporary agents : credential absent');
      console.log('  all five arms/roles    : projected authority observed');
      console.log('  EXTERNAL PROVIDER CALLS MADE: 0');
    }, { timeoutMs: 1_800_000 });

  console.log('evaluation live credential PostgreSQL test passed');
}

main().catch(error => { console.error(error); process.exit(1); });
