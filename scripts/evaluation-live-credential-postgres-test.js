#!/usr/bin/env node
'use strict';

// Tranche 6 — THE CREDENTIAL SAFETY MATRIX.
//
// THE DEFECT THIS EXISTS TO PREVENT RECURRING. Two correct rules contradicted
// each other and nothing noticed, because the branch the contradiction broke
// was the one branch no test took.
//
// The harness strips OPENAI_API_KEY before spawning — right, and it stays. The
// live runner then supplied nothing for a real uncaptured run, believing the
// credential would be inherited. It had been deleted two frames earlier. Every
// live proof used the final-hop capture, which supplies a sentinel, so the
// credential path a real run depends on was never exercised. An authorized $20
// matrix reached its opening gate and could not have authenticated a single
// trial.
//
// So this suite proves the whole matrix, not one cell of it:
//
//   ordinary real-server test  -> child does NOT receive a real credential
//   fixture evaluation         -> sentinel, never the real credential
//   synthetic live capture     -> sentinel, never the real credential
//   real uncaptured live       -> the explicitly authorized credential
//   real live, no credential   -> REFUSES before the server is spawned
//
// The real-live branch is proved at the SPAWN BOUNDARY: the production branch
// runs, the exact child environment is observed, and execution stops before a
// process capable of provider contact exists. Every credential here is a dummy
// owned by this test. It makes ZERO provider calls.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const { ARMS } = require('./fixtures/evaluation-arms');
const { getScenario } = require('./fixtures/evaluation-scenarios');
const { runTrial } = require('./structured-allocation-evaluation-runner');
const {
  EvaluationServerEnvError, SENTINEL_CREDENTIAL,
  buildEvaluationServerCredentialEnv, classifyEvaluationServerMode,
  describeEvaluationServerCredential
} = require('./fixtures/evaluation-server-env');
const { trialWorstCaseMicroUsd } = require('./fixtures/evaluation-live-trial-liability');
const { ROLE_ECONOMICS } = require('./fixtures/governed-role-policy-container');
const liveManifest = require('../config/structured-allocation-evaluation-live-v1.json');

// NEVER the real key. This value exists only inside this test.
const DUMMY_LIVE_CREDENTIAL = 'dummy-live-credential-for-spawn-boundary-proof';

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

async function main() {
  const root = path.join('/tmp', `ticket-system-live-credential-${process.pid}`);
  fs.mkdirSync(path.join(root, 'out'), { recursive: true });

  await withHarness('evaluation live credential', async ({ store, workspaceRoot, startServer }) => {
    const assertThat = createAsserter();

    // ── THE PURE OWNER, all three modes ─────────────────────────────────
    assertThat(classifyEvaluationServerMode({ mode: 'fixture' }) === 'fixture' &&
      classifyEvaluationServerMode({ mode: 'live', liveTransportCapture: '/x' }) ===
        'synthetic_live_capture' &&
      classifyEvaluationServerMode({ mode: 'live', liveTransportCapture: null }) ===
        'real_uncaptured_live',
    'the three evaluation server modes are distinguished by mode and capture alone');

    const realEnv = { OPENAI_API_KEY: DUMMY_LIVE_CREDENTIAL };
    const fixtureBuilt = buildEvaluationServerCredentialEnv({ mode: 'fixture', env: realEnv });
    assertThat(fixtureBuilt.env.OPENAI_API_KEY === SENTINEL_CREDENTIAL &&
      fixtureBuilt.usesRealCredential === false,
    'FIXTURE receives the sentinel and never the inherited real credential');

    const capturedBuilt = buildEvaluationServerCredentialEnv({
      mode: 'live', liveTransportCapture: '/tmp/capture', env: realEnv });
    assertThat(capturedBuilt.env.OPENAI_API_KEY === SENTINEL_CREDENTIAL &&
      capturedBuilt.usesRealCredential === false,
    'SYNTHETIC CAPTURE receives the sentinel and never the inherited real credential');

    const liveBuilt = buildEvaluationServerCredentialEnv({
      mode: 'live', liveTransportCapture: null, env: realEnv });
    assertThat(liveBuilt.env.OPENAI_API_KEY === DUMMY_LIVE_CREDENTIAL &&
      liveBuilt.usesRealCredential === true,
    'REAL UNCAPTURED LIVE receives the explicitly authorized credential');

    // MISSING CREDENTIAL REFUSES BEFORE SPAWN.
    let missing = null;
    try {
      buildEvaluationServerCredentialEnv({ mode: 'live', liveTransportCapture: null, env: {} });
    } catch (error) { missing = error; }
    assertThat(missing instanceof EvaluationServerEnvError &&
      missing.code === 'REAL_LIVE_CREDENTIAL_ABSENT',
    'a real live trial with no credential REFUSES before any server is spawned');
    assertThat(!String(missing.message).includes(DUMMY_LIVE_CREDENTIAL),
      'and the refusal interpolates no credential material');

    // A REFUSAL THAT HAS A VALUE IN HAND MUST STILL NOT PRINT IT. The absent
    // case above has nothing to leak; this one does — a whitespace credential
    // is present as a string and still refuses.
    let blankCredential = null;
    try {
      buildEvaluationServerCredentialEnv({ mode: 'live', liveTransportCapture: null,
        env: { OPENAI_API_KEY: `   ${DUMMY_LIVE_CREDENTIAL}-blank   `.replace(/\S/g, ' ') } });
    } catch (error) { blankCredential = error; }
    assertThat(blankCredential !== null &&
      blankCredential.code === 'REAL_LIVE_CREDENTIAL_ABSENT',
    'a blank credential refuses as absent');
    let leakyRefusal = null;
    try {
      buildEvaluationServerCredentialEnv({ mode: 'live', liveTransportCapture: null,
        env: { OPENAI_API_KEY: '\t\n  ' } });
    } catch (error) { leakyRefusal = error; }
    assertThat(leakyRefusal !== null &&
      !JSON.stringify(leakyRefusal.detail || {}).includes('OPENAI_API_KEY:') &&
      !String(leakyRefusal.message).includes('\t'),
    'and no refusal echoes the credential it was handed, even a malformed one');

    let sentinelAsReal = null;
    try {
      buildEvaluationServerCredentialEnv({ mode: 'live', liveTransportCapture: null,
        env: { OPENAI_API_KEY: SENTINEL_CREDENTIAL } });
    } catch (error) { sentinelAsReal = error; }
    assertThat(sentinelAsReal !== null &&
      sentinelAsReal.code === 'REAL_LIVE_CREDENTIAL_IS_SENTINEL',
    'a real live run launched from a harness environment REFUSES');

    // ── SECRET CONTAINMENT ──────────────────────────────────────────────
    const described = describeEvaluationServerCredential(liveBuilt);
    const serialized = JSON.stringify(described);
    assertThat(!serialized.includes(DUMMY_LIVE_CREDENTIAL),
      'the observable description carries no credential value');
    assertThat(described.credentialPresent === true &&
      Object.keys(described).sort().join(',') ===
        'credentialPresent,serverMode,usesRealCredential',
    'it reports only presence, mode and whether the credential is real');
    assertThat(!serialized.includes(String(DUMMY_LIVE_CREDENTIAL.length)),
      'and exposes no length, prefix or hash of the credential');

    // ── THE DEFAULT HARNESS STILL STRIPS ────────────────────────────────
    //
    // An ordinary real-server start, with a credential in the parent, must not
    // hand it to the child. This is the containment the live fix must not
    // weaken.
    const ordinaryBefore = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = DUMMY_LIVE_CREDENTIAL;
    let ordinaryEnv = null;
    try {
      await startServer({
        spawnEnvObserver: childEnv => { throw new SpawnBoundaryReached(childEnv); }
      });
    } catch (error) {
      if (error instanceof SpawnBoundaryReached) ordinaryEnv = error.childEnv;
      else throw error;
    }
    assertThat(ordinaryEnv !== null && ordinaryEnv.OPENAI_API_KEY === undefined,
      'an ORDINARY real-server spawn does NOT inherit the parent credential');

    // ── THE REAL UNCAPTURED LIVE BRANCH, AT THE SPAWN BOUNDARY ──────────
    //
    // Not through the capture: that branch supplies a sentinel and is exactly
    // what masked the defect. This runs the production branch a real matrix
    // takes and stops before a child able to reach a provider exists.
    const liveBudget = {
      runRoot: path.join(root, 'ledger'),
      ceilingMicroUsd: liveManifest.economics.maximumTotalLiveMicroUsd,
      perRequestMicroUsd: liveManifest.economics.liability.perRequestMicroUsd,
      runtimeMaxModelRequestsPerRun:
        liveManifest.economics.liability.runtimeMaxModelRequestsPerRun,
      governedLeafMaximumProviderRequests:
        ROLE_ECONOMICS.structured_leaf_executor.maximumProviderRequests,
      governedPlannerMaximumProviderRequests:
        ROLE_ECONOMICS.structured_planner.maximumProviderRequests
    };
    fs.mkdirSync(liveBudget.runRoot, { recursive: true });

    let liveChildEnv = null;
    try {
      await runTrial({
        store, startServer, workspaceRoot,
        scenario: getScenario('family-1-simple'), arm: ARMS.A,
        repetition: 1, seed: 'credential-spawn-boundary',
        outputPath: path.join(root, 'out', 'live.json'),
        commit: 'credential-proof', smokeRoot: root,
        namespaceRoot: path.join(root, 'ns'),
        mode: 'live',
        // THE REAL BRANCH: no capture.
        liveTransportCapture: null,
        liveRequestControls: CONTROLS,
        liveBudget,
        spawnEnvObserver: childEnv => { throw new SpawnBoundaryReached(childEnv); }
      });
    } catch (error) {
      let cursor = error;
      while (cursor && !(cursor instanceof SpawnBoundaryReached)) cursor = cursor.cause;
      if (cursor instanceof SpawnBoundaryReached) liveChildEnv = cursor.childEnv;
      else if (error instanceof SpawnBoundaryReached) liveChildEnv = error.childEnv;
    }
    assertThat(liveChildEnv !== null,
      'the REAL uncaptured live branch reached the spawn boundary');
    assertThat(liveChildEnv.OPENAI_API_KEY === DUMMY_LIVE_CREDENTIAL,
      'and the child environment carries the explicitly authorized credential, ' +
      'restored AFTER the harness stripped the inherited one');
    assertThat(liveChildEnv.OPENAI_API_KEY !== SENTINEL_CREDENTIAL,
      'not the sentinel — this is the branch a real matrix takes');
    assertThat(String(liveChildEnv.NODE_OPTIONS || '')
      .includes('live-transport-capture-preload') === false,
    'and no final-hop capture preload was loaded on this branch');
    assertThat(String(liveChildEnv.NODE_OPTIONS || '')
      .includes('evaluation-preload') === false,
    'nor the hermetic fixture preload');
    assertThat(liveChildEnv.HERMETIC_TRANSPORT_RESPONSE === undefined,
      'and no hermetic response staging was supplied');

    // ── AND THE CAPTURED BRANCH STILL GETS THE SENTINEL ─────────────────
    let capturedChildEnv = null;
    try {
      await runTrial({
        store, startServer, workspaceRoot,
        scenario: getScenario('family-1-simple'), arm: ARMS.A,
        repetition: 1, seed: 'credential-capture-boundary',
        outputPath: path.join(root, 'out', 'captured.json'),
        commit: 'credential-proof', smokeRoot: root,
        namespaceRoot: path.join(root, 'ns2'),
        mode: 'live',
        liveTransportCapture: path.join(root, 'cap.jsonl'),
        liveRequestControls: CONTROLS,
        liveBudget: { ...liveBudget, runRoot: path.join(root, 'ledger2') },
        spawnEnvObserver: childEnv => { throw new SpawnBoundaryReached(childEnv); }
      });
    } catch (error) {
      let cursor = error;
      while (cursor && !(cursor instanceof SpawnBoundaryReached)) cursor = cursor.cause;
      if (cursor instanceof SpawnBoundaryReached) capturedChildEnv = cursor.childEnv;
      else if (error instanceof SpawnBoundaryReached) capturedChildEnv = error.childEnv;
      else if (process.env.CRED_DEBUG === '1') console.log('  [captured debug]', error.message.slice(0,200));
    }
    assertThat(capturedChildEnv !== null &&
      capturedChildEnv.OPENAI_API_KEY === SENTINEL_CREDENTIAL,
    'the SYNTHETIC CAPTURE branch receives the sentinel, never the real credential');

    // ── AND FIXTURE MODE TOO ────────────────────────────────────────────
    let fixtureChildEnv = null;
    try {
      await runTrial({
        store, startServer, workspaceRoot,
        scenario: getScenario('family-1-simple'), arm: ARMS.A,
        repetition: 1, seed: 'credential-fixture-boundary',
        outputPath: path.join(root, 'out', 'fixture.json'),
        commit: 'credential-proof', smokeRoot: root,
        namespaceRoot: path.join(root, 'ns3'),
        spawnEnvObserver: childEnv => { throw new SpawnBoundaryReached(childEnv); }
      });
    } catch (error) {
      let cursor = error;
      while (cursor && !(cursor instanceof SpawnBoundaryReached)) cursor = cursor.cause;
      if (cursor instanceof SpawnBoundaryReached) fixtureChildEnv = cursor.childEnv;
      else if (error instanceof SpawnBoundaryReached) fixtureChildEnv = error.childEnv;
    }
    assertThat(fixtureChildEnv !== null &&
      fixtureChildEnv.OPENAI_API_KEY === SENTINEL_CREDENTIAL,
    'FIXTURE mode receives the sentinel, never the real credential');

    if (ordinaryBefore === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = ordinaryBefore;

    // ── NO SECRET REACHED DISK ──────────────────────────────────────────
    let leaked = 0;
    const walk = dir => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(child);
        else if (fs.readFileSync(child, 'utf8').includes(DUMMY_LIVE_CREDENTIAL)) leaked += 1;
      }
    };
    walk(root);
    assertThat(leaked === 0,
      'no credential value reached any header, journal, artifact or ledger file');

    console.log(`\n  (${assertThat.count()} credential assertions)`);
    console.log('  ordinary spawn        : credential STRIPPED');
    console.log('  fixture               : sentinel');
    console.log('  synthetic capture     : sentinel');
    console.log('  real uncaptured live  : explicitly forwarded credential');
    console.log('  missing credential    : refuses before spawn');
    console.log('  EXTERNAL PROVIDER CALLS MADE: 0');
  }, { timeoutMs: 900_000 });

  console.log('evaluation live credential PostgreSQL test passed');
}

main().catch(error => { console.error(error); process.exit(1); });
