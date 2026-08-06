#!/usr/bin/env node
'use strict';

// Tranche 6 — the governed UNEXPECTED-REQUEST negative control, through a real
// spawned server.
//
// WHY THIS SUITE EXISTS SEPARATELY. Every request in the scenario matrix is
// staged, so production never emits an unexpected governed request there. A
// mutation that made the governed transport record an unexpected request as a
// SUCCESS therefore survived the whole matrix — not because the matrix was
// weak, but because the path was never executed.
//
// The fix is not to bend a product scenario into emitting an unplanned request.
// It is to build one deliberate negative control: a real trial, through the real
// governed transport, with exactly ONE expected worker response removed from the
// staged table. The real server then makes a governed request for a logical
// identity nothing staged, and this suite asserts what must happen.
//
// THIS IS NOT PART OF THE SCORED OR UNSCORED MATRIX. It produces no comparable
// artifact and is never aggregated. It exists to prove a refusal.

const fs = require('node:fs');
const path = require('node:path');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const { ARMS } = require('./fixtures/evaluation-arms');
const { getScenario } = require('./fixtures/evaluation-scenarios');
const { runTrial } = require('./structured-allocation-evaluation-runner');
const { readObservations } = require('./fixtures/evaluation-observation-sink');

// Family 7 is structured-only, so its worker request necessarily goes through
// the GOVERNED transport — which is the transport under test.
const SCENARIO_ID = 'family-7-no-progress';
const OMITTED_TASK = 'alpha';

async function main() {
  const root = path.join('/tmp', `ticket-system-governed-negative-${process.pid}`);
  fs.mkdirSync(path.join(root, 'fixture'), { recursive: true });

  await withHarness('governed evaluation negative path',
    async ({ store, workspaceRoot, startServer }) => {
      const assertThat = createAsserter();
      const outputPath = path.join(root, 'fixture', 'negative-control.json');

      let artifact = null;
      let failure = null;
      try {
        artifact = await runTrial({
          store, startServer, workspaceRoot,
          scenario: getScenario(SCENARIO_ID), arm: ARMS.B, variant: '7A',
          repetition: 1, seed: 'governed-negative-control',
          outputPath, commit: 'negative-control',
          smokeRoot: root, namespaceRoot: path.join(root, 'ns'),
          // EXACTLY ONE expected governed worker response is removed.
          omitStagedLogicalTasks: [OMITTED_TASK]
        });
      } catch (error) { failure = error; }

      // The trial itself must still be OBSERVABLE. A harness that cannot run the
      // negative control proves nothing about the refusal.
      assertThat(failure === null,
        `the negative-control trial executed and was observed` +
        (failure ? ` — ${failure.stack}` : ''));
      if (failure) return;

      // ── THE OBSERVATION SINK ────────────────────────────────────────────
      // Found by its INSTALL MARKER rather than by an assumed directory depth:
      // the marker is what distinguishes an observed namespace from any other
      // directory, and it is the same fact the completeness contract reads.
      const findNamespace = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const child = path.join(dir, entry.name);
          if (fs.existsSync(path.join(child, 'observation-sink.json'))) return child;
          const nested = findNamespace(child);
          if (nested) return nested;
        }
        return null;
      };
      const namespaceDir = findNamespace(path.join(root, 'ns')) || path.join(root, 'ns');
      const observations = readObservations(namespaceDir);
      assertThat(observations.completeness === 'complete',
        'the observation sink ran for the whole negative-control trial');

      const workerTransports = observations.transport.filter(
        entry => entry.role === 'worker');
      const unexpected = observations.transport.filter(
        entry => entry.reason === 'no_staged_response');

      // 1. The unstaged request was REFUSED, and the refusal is recorded.
      assertThat(unexpected.length > 0,
        `a governed request for the unstaged ${OMITTED_TASK} identity was refused ` +
        `(${unexpected.length} recorded)`);
      assertThat(unexpected.every(entry =>
        entry.boundary === 'refused_before_transport'),
      'an unexpected request refuses BEFORE transport — no bytes left');

      // 2. NO successful served observation for it. This is the assertion the
      //    surviving mutation violates: recording success for a request nothing
      //    staged would invent a delivery that never happened.
      assertThat(unexpected.every(entry => entry.boundary !== 'response_durable'),
        'no unexpected request is recorded as a durable response');
      assertThat(unexpected.every(entry => entry.responseIdentity === null),
        'and no fake response identity is invented for it');
      assertThat(unexpected.every(entry => entry.responseHash === null),
        'and no response hash is invented for it');

      // 3. An unexpected request is NOT an injected boundary. The scenario
      //    staged no failure here; the fixture refused for want of a response,
      //    and the two must stay distinguishable.
      assertThat(unexpected.every(entry => entry.injected === false),
        'an unexpected request is never recorded as a staged failure boundary');

      // 4. The OMITTED identity produced no durable worker response, while the
      //    responses that WERE staged still served normally — so the refusal is
      //    specific, not a collapse of the whole transport.
      const durableWorker = workerTransports.filter(
        entry => entry.boundary === 'response_durable');
      assertThat(durableWorker.every(entry =>
        !String(entry.responseIdentity || '').includes(`-${OMITTED_TASK}-`)),
      `no durable response was served for the omitted ${OMITTED_TASK} identity`);

      // 5. Product truth stays fail-closed: the Ticket did not complete.
      assertThat(artifact.pathProof.ticketResultStatus !== 'completed',
        'the Ticket did not complete on a refused governed request ' +
        `(status ${artifact.pathProof.ticketResultStatus})`);
      assertThat(artifact.observationCompleteness === 'complete',
        'the artifact records that observation was complete throughout');

      // 6. No live network. The hermetic guard is what makes every assertion
      //    above a statement about the fixture rather than about the internet.
      const transcriptHosts = observations.transport
        .map(entry => entry.logicalRequestId).filter(Boolean);
      assertThat(transcriptHosts.every(id => !String(id).startsWith('http')),
        'no observation names an external endpoint — nothing escaped to a network');

      console.log(`\n  (${assertThat.count()} negative-control assertions)`);
    }, { timeoutMs: 900_000 });

  console.log('governed evaluation negative path PostgreSQL test passed');
}

main().catch(error => { console.error(error); process.exit(1); });
