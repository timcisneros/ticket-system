#!/usr/bin/env node
'use strict';

// Tranche 6 — the UNGOVERNED PIPELINE, against the REAL provider envelope.
//
// WHAT WAS MISSING. Every acceptance proof to date answered the ungoverned
// worker with a top-level `output_text` and a hand-written Response clone. The
// real Responses API returns neither: it returns `output[].content[]` with type
// `output_text`, on a platform Response whose headers production ITERATES with
// `headers.entries()`. So production had never been observed consuming what the
// provider actually sends, and a fixture defect was once reported as a product
// runtime defect because of it.
//
// This suite closes that gap permanently, and it separates two findings that
// were previously confused with each other:
//
//   A ONE ACTION    — a valid single createFolder response traverses the WHOLE
//                     production ungoverned pipeline: real envelope, extraction,
//                     parse, per-response action authority, workspace execution,
//                     durable receipt, truthful completion.
//
//   A FOUR ACTIONS  — four canonical createFolder mutations are STRUCTURALLY
//                     VALID and are refused by the per-response mutating-action
//                     authority. That is PRODUCT/MODEL DATA, not a harness or
//                     runtime defect, and the two must never be reported as the
//                     same thing.
//
// A2a AND A2b ARE PROVED INDEPENDENTLY. They are different production paths —
// legacy v1 group allocation with operator and with system-derived ownership —
// and arm A cannot stand in for either. Each runs its own trial and its own
// worker Runs through the real-envelope pipeline.
//
// NO EXTERNAL CALL IS POSSIBLE. The trials run on the REAL uncaptured live
// branch, so the credential resolution, provider selection and request builder
// are all production. The boundary observer replaces the last hop only: it
// records what would have gone on the wire and answers with the controlled
// real-envelope response. Nothing reaches a network, and the suite installs its
// own throwaway credential so a developer key is never forwarded.

const fs = require('node:fs');
const path = require('node:path');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const { ARMS } = require('./fixtures/evaluation-arms');
const { getScenario } = require('./fixtures/evaluation-scenarios');
const { runTrial } = require('./structured-allocation-evaluation-runner');
const { ROLE_ECONOMICS } = require('./fixtures/governed-role-policy-container');
const {
  resolveRealLiveCredentialAuthority
} = require('./fixtures/evaluation-server-env');
const {
  PROVIDER_TRANSPORT_INVOKED_EVENT
} = require('../runtime/provider-transport-observation');
const liveManifest = require('../config/structured-allocation-evaluation-live-v2.json');

// Never the developer's key. This suite takes the real uncaptured live branch
// precisely so that branch is exercised, and that branch forwards whatever
// OPENAI_API_KEY it inherits — so the suite supplies one that cannot buy
// anything.
const DUMMY_LIVE_CREDENTIAL = 'test-only-ungoverned-envelope-suite-credential';

const CONTROLS = Object.freeze({
  temperature: liveManifest.sampling.temperature,
  topP: liveManifest.sampling.topP,
  maxOutputTokens: liveManifest.maximumOutputTokensPerRequest
});

// The child folder every one-action trial creates. Absent before dispatch in
// every arm: the runner pre-creates only the allocated ROOTS, never a child
// inside one.
const ONE_ACTION_CHILD = 'one-action-child';

// The target for each allocated root the ungoverned arms actually produce,
// read from the request's own runtime envelope by the boundary fixture. The
// mapping lives HERE because which folder an allocated agent should produce is
// knowledge about the scenario, not about the transport boundary.
//
//   ''                  arm A — individual execution, no allocated ownership
//   'reports/alpha/'    A2a  — operator-allocated roots
//   'reports-b/beta/'
//   'reports/'          A2b  — system-derived roots
//   'reports-b/'
const ONE_ACTION_BY_OWNED_ROOT = Object.freeze({
  '': `reports/${ONE_ACTION_CHILD}`,
  'reports/alpha/': `reports/alpha/${ONE_ACTION_CHILD}`,
  'reports-b/beta/': `reports-b/beta/${ONE_ACTION_CHILD}`,
  'reports/': `reports/${ONE_ACTION_CHILD}`,
  'reports-b/': `reports-b/${ONE_ACTION_CHILD}`
});

// FOUR CANONICAL MUTATIONS. Structurally valid, every one of them: the same
// operation, the same argument shape and the same paths a single accepted
// action uses. The only thing wrong with this response is that there are four
// of them.
const FOUR_MUTATION_PATHS = Object.freeze([
  'reports/over-limit-1', 'reports/over-limit-2',
  'reports/over-limit-3', 'reports/over-limit-4'
]);

function writeSpec(target, spec) {
  fs.writeFileSync(target, JSON.stringify(spec, null, 2));
  return target;
}

function boundaryObservations(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

// ── Durable readers. Every assertion below reads one of these ───────────────

async function ticketFacts(store, ticketId) {
  const events = (await store.pool.query(
    `SELECT type, run_id, seq, payload FROM ${store.table('events')}
      WHERE ticket_id = $1 ORDER BY seq`, [ticketId])).rows;
  const runs = (await store.pool.query(
    `SELECT id, status FROM ${store.table('runs')} WHERE ticket_id = $1 ORDER BY id`,
    [ticketId])).rows;
  const receipts = (await store.pool.query(
    `SELECT run_id, operation, outcome, workspace_path, receipt
       FROM ${store.table('operation_receipts')} WHERE ticket_id = $1 ORDER BY id`,
    [ticketId])).rows;
  const snapshots = (await store.pool.query(
    `SELECT replay.run_id, replay.snapshot FROM ${store.table('replay_snapshots')} AS replay
       JOIN ${store.table('runs')} AS run ON run.id = replay.run_id
      WHERE run.ticket_id = $1 ORDER BY replay.run_id`, [ticketId])).rows;
  return { events, runs, receipts, snapshots };
}

// The persisted provider response body, as production stored it. This is the
// canonical proof of WHICH ENVELOPE production consumed — not a claim by the
// fixture about what it sent.
function persistedResponseBodies(facts) {
  const bodies = [];
  for (const row of facts.snapshots) {
    for (const response of row.snapshot.modelResponses || []) {
      const body = response.providerResponsePayload && response.providerResponsePayload.body;
      if (body) bodies.push(body);
    }
  }
  return bodies;
}

function eventsOfType(facts, type) {
  return facts.events.filter(event => event.type === type);
}

// The per-turn execution decisions. These are recorded by `recordRunEvent`,
// which writes the run's replay snapshot rather than the event chain, so the
// pass/refusal decision for a response is read from there.
function replayDecisions(facts, type) {
  const decisions = [];
  for (const row of facts.snapshots) {
    for (const event of row.snapshot.events || []) {
      if (event && event.type === type) decisions.push(event);
    }
  }
  return decisions;
}

async function main() {
  const root = path.join('/tmp', `ticket-system-ungoverned-envelope-${process.pid}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'fixture'), { recursive: true });

  const oneActionSpec = writeSpec(path.join(root, 'one-action-spec.json'), {
    kind: 'one-action-createFolder-by-owned-root',
    message: 'Creating the declared output folder.',
    complete: true,
    byOwnedRoot: ONE_ACTION_BY_OWNED_ROOT
  });
  const fourActionSpec = writeSpec(path.join(root, 'four-action-spec.json'), {
    kind: 'literal',
    text: JSON.stringify({
      message: 'Creating four folders.',
      actions: FOUR_MUTATION_PATHS.map(target =>
        ({ operation: 'createFolder', args: { path: target } })),
      complete: true
    })
  });

  await withHarness('ungoverned real envelope pipeline',
      async ({ store, workspaceRoot, startServer }) => {
        const assertThat = createAsserter();
        const resolvedLiveCredentialAuthority =
          await resolveRealLiveCredentialAuthority({
            store: { getConfiguredAgentById: async () => ({
              id: 83, revision: 1, provider: 'openai',
              model: 'not-authoritative', apiKey: DUMMY_LIVE_CREDENTIAL
            }) },
            credentialAuthority: {
              kind: 'configured_agent', configuredAgentId: 83
            },
            expectedProvider: 'openai'
          });

        const budgetRoot = path.join(root, 'budget');
        fs.mkdirSync(budgetRoot, { recursive: true });
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

        // Runs one trial on the REAL uncaptured live branch, with the boundary
        // answering in the real provider envelope. Returns the durable facts.
        const runOne = async ({ label, armId, responseSpec, observationFault = null }) => {
          const observation = path.join(root, `boundary-${label}.jsonl`);
          const before = (await store.pool.query(
            `SELECT COALESCE(max(id), 0) AS id FROM ${store.table('tickets')}`)).rows[0].id;
          let harnessError = null;
          try {
            await runTrial({
              store, startServer, workspaceRoot,
              scenario: getScenario('family-1-simple'), arm: ARMS[armId],
              repetition: 1, seed: `real-envelope-${label}`,
              outputPath: path.join(root, 'fixture', `${label}.json`),
              commit: 'real-envelope-proof', smokeRoot: root,
              namespaceRoot: path.join(root, `ns-${label}`),
              mode: 'live',
              resolvedLiveCredentialAuthority,
              liveRequestControls: CONTROLS,
              // NO final-hop capture: this is the real uncaptured branch.
              liveTransportCapture: null,
              liveProviderBoundaryObservation: observation,
              liveProviderBoundaryResponse: responseSpec,
              // TEST-ONLY. Arms a failure at the store method that writes the
              // durable transport observation.
              liveProviderTransportObservationFault: observationFault,
              liveBudget
            });
          } catch (error) { harnessError = error; }
          const ticketId = Number((await store.pool.query(
            `SELECT COALESCE(max(id), 0) AS id FROM ${store.table('tickets')}
              WHERE id > $1`, [before])).rows[0].id);
          return {
            label,
            armId,
            harnessError,
            ticketId,
            observations: boundaryObservations(observation),
            facts: await ticketFacts(store, ticketId)
          };
        };

        // ── A — ONE ACTION ────────────────────────────────────────────────
        const oneAction = await runOne({
          label: 'A-one-action', armId: 'A', responseSpec: oneActionSpec });

        assertThat(oneAction.observations.length >= 1,
          'A one action: the real uncaptured live branch reached the provider ' +
          `transport boundary (${oneAction.observations.length} observation(s))`);
        assertThat(oneAction.observations.every(entry => entry.transport === 'ungoverned'),
          'A one action: every observation is the ungoverned fetch transport');

        // THE ENVELOPE PRODUCTION ACTUALLY CONSUMED, from its own durable
        // record — not a claim by the fixture about what it answered.
        const oneBodies = persistedResponseBodies(oneAction.facts);
        assertThat(oneBodies.length >= 1,
          'A one action: production persisted the provider response body it consumed');
        assertThat(oneBodies.every(body =>
          Array.isArray(body.output) && body.output[0] &&
          Array.isArray(body.output[0].content) &&
          body.output[0].content[0].type === 'output_text' &&
          typeof body.output[0].content[0].text === 'string'),
        'A one action: it is the REAL Responses envelope — output[].content[] ' +
        'with type output_text');
        assertThat(oneBodies.every(body => body.output_text === undefined),
          'A one action: and carries NO top-level output_text, which the real API ' +
          'never returns');

        // Parser accepted.
        const parsed = eventsOfType(oneAction.facts, 'model.plan.parsed');
        assertThat(parsed.length >= 1,
          'A one action: the parser ACCEPTED the extracted text (model.plan.parsed)');
        assertThat(parsed.every(event => event.payload.actionCount === 1 &&
          event.payload.operations.join(',') === 'createFolder'),
        'A one action: the accepted plan is exactly one createFolder');
        assertThat(eventsOfType(oneAction.facts, 'model:malformed').length === 0,
          'A one action: no malformed-response refusal was recorded');

        // One mutation is inside the cap, and the durable pass decision says so.
        const passed = replayDecisions(oneAction.facts, 'model:action_contract_passed');
        assertThat(passed.length >= 1 && passed.every(decision =>
          decision.mutatingActionCount === 1 &&
          decision.maxMutatingActionsPerResponse === 2),
        'A one action: the durable pass decision records 1 mutation against the ' +
        'per-response cap of 2');
        assertThat(eventsOfType(oneAction.facts, 'action.suppressed').length === 0,
          'A one action: the per-response action authority refused NOTHING');

        // The workspace operation was reached and its receipt is durable.
        assertThat(eventsOfType(oneAction.facts, 'workspace.operation').length >= 1,
          'A one action: production reached the workspace operation');
        const created = oneAction.facts.receipts.filter(row =>
          row.operation === 'createFolder' && row.outcome === 'succeeded');
        assertThat(created.length === 1,
          `A one action: exactly one durable createFolder receipt (${created.length})`);
        assertThat(created[0].workspace_path === ONE_ACTION_BY_OWNED_ROOT[''],
          `A one action: the receipt names the declared child ${created[0].workspace_path}`);

        // ABSENT BEFORE, PRESENT AFTER — from the receipt's own captured states,
        // which are the durable record of the workspace immediately around the
        // mutation rather than a filesystem read taken at another time.
        const receipt = created[0].receipt || {};
        assertThat(receipt.before && receipt.before.existed === false,
          'A one action: the child was ABSENT immediately before the mutation');
        assertThat(receipt.after && receipt.after.existed === true,
          'A one action: and EXISTS immediately after it');
        assertThat(fs.existsSync(path.join(workspaceRoot, ONE_ACTION_BY_OWNED_ROOT[''])),
          'A one action: the folder is really on disk in the trial workspace');

        // Truthful completion.
        assertThat(oneAction.facts.runs.length === 1 &&
          oneAction.facts.runs[0].status === 'completed',
        `A one action: the Run truthfully completes (${oneAction.facts.runs
          .map(run => run.status).join(',')})`);
        assertThat(oneAction.harnessError === null,
          'A one action: the trial produced its artifact without a harness error');

        // The transport observation exists for this request.
        assertThat(eventsOfType(oneAction.facts, PROVIDER_TRANSPORT_INVOKED_EVENT)
          .length >= 1,
        'A one action: the durable transport-invocation observation was recorded');

        // ── A — FOUR ACTIONS ──────────────────────────────────────────────
        const fourAction = await runOne({
          label: 'A-four-actions', armId: 'A', responseSpec: fourActionSpec });

        const fourBodies = persistedResponseBodies(fourAction.facts);
        assertThat(fourBodies.length >= 1 && fourBodies.every(body =>
          Array.isArray(body.output) &&
          body.output[0].content[0].type === 'output_text'),
        'A four actions: the same REAL Responses envelope was consumed');

        // THE PARSER ACCEPTED IT. This is the finding that must not be lost:
        // the response is structurally valid model output.
        const fourParsed = eventsOfType(fourAction.facts, 'model.plan.parsed');
        assertThat(fourParsed.length >= 1,
          'A four actions: the parser ACCEPTED the response — it is structurally valid');
        assertThat(fourParsed.every(event => event.payload.actionCount === 4 &&
          event.payload.operations.every(operation => operation === 'createFolder')),
        'A four actions: four canonical createFolder actions were parsed');
        assertThat(eventsOfType(fourAction.facts, 'model:malformed').length === 0,
          'A four actions: NOT a parser/malformed refusal');

        // AND THE PER-RESPONSE MUTATION AUTHORITY REFUSED THE RESPONSE.
        const suppressed = eventsOfType(fourAction.facts, 'action.suppressed');
        assertThat(suppressed.length >= 1,
          'A four actions: the per-response action authority REFUSED the response');
        assertThat(suppressed.every(event =>
          event.payload.reason === 'mutating_action_limit'),
        'A four actions: under the stable code reason=mutating_action_limit');
        assertThat(suppressed.every(event => event.payload.mutatingCount === 4 &&
          event.payload.limit === 2),
        'A four actions: 4 mutations against the per-response limit of 2');
        const refusalDecisions =
          replayDecisions(fourAction.facts, 'model:mutating_action_limit');
        assertThat(refusalDecisions.length >= 1 && refusalDecisions.every(decision =>
          decision.violationType === 'mutating_action' &&
          decision.mutatingActionCount === 4 &&
          decision.maxMutatingActionsPerResponse === 2),
        'A four actions: the durable per-turn decision names the mutating-action ' +
        'violation and the cap it exceeded');
        assertThat(replayDecisions(fourAction.facts, 'model:action_contract_passed')
          .length === 0,
        'A four actions: no response was ever recorded as passing the gates');

        // ZERO OPERATIONS FROM THE REFUSED RESPONSE.
        assertThat(fourAction.facts.receipts.length === 0,
          `A four actions: the refused response produced ZERO operations ` +
          `(${fourAction.facts.receipts.length} receipt(s))`);
        for (const target of FOUR_MUTATION_PATHS) {
          assertThat(!fs.existsSync(path.join(workspaceRoot, target)),
            `A four actions: ${target} was never created`);
        }

        // PRODUCT/MODEL BEHAVIOUR — not a harness or runtime defect. The
        // distinguishing evidence is which vocabulary owns the refusal.
        const runtimeDefectCodes = ['OPENAI_TRANSPORT_ERROR', 'OPENAI_MALFORMED_RESPONSE',
          'OPENAI_NO_OUTPUT', 'MODEL_MALFORMED_JSON',
          'LIVE_PROVIDER_BOUNDARY_OBSERVED_NO_NETWORK',
          'PROVIDER_TRANSPORT_OBSERVATION_NOT_PERSISTED'];
        const codesSeen = new Set(fourAction.facts.events
          .map(event => event.payload && event.payload.code).filter(Boolean));
        assertThat(runtimeDefectCodes.every(code => !codesSeen.has(code)),
          'A four actions: no transport, extraction, parser or harness failure code ' +
          `appears (${[...codesSeen].join(',') || 'none'})`);
        assertThat(eventsOfType(fourAction.facts, PROVIDER_TRANSPORT_INVOKED_EVENT)
          .length >= 1,
        'A four actions: transport was invoked — the refusal is downstream of it');

        // ── A2a AND A2b, PROVED INDEPENDENTLY ─────────────────────────────
        for (const armId of ['A2a', 'A2b']) {
          // INDEPENDENCE FIRST, and from the frozen arm definitions rather than
          // from whatever this loop happens to be handed. Arm A is a different
          // production path with a different Run cardinality, so substituting it
          // here must fail immediately and for the stated reason — not later, on
          // whichever downstream assertion happens to notice.
          assertThat(ARMS[armId].expectedPath === 'legacy_v1' &&
            ARMS[armId].expectedRunCardinality === 'per_agent' &&
            ARMS[armId].expectedGoverned === false,
          `${armId}: this proof runs the legacy v1 per-agent ungoverned path — ` +
          `arm A (${ARMS.A.expectedPath}, ${ARMS.A.expectedRunCardinality}) ` +
          'cannot stand in for it');

          const trial = await runOne({
            label: `${armId}-one-action`, armId, responseSpec: oneActionSpec });

          assertThat(trial.observations.length >= 1,
            `${armId}: its OWN worker Runs reached the provider transport boundary ` +
            `(${trial.observations.length})`);
          const bodies = persistedResponseBodies(trial.facts);
          assertThat(bodies.length >= 1 && bodies.every(body =>
            Array.isArray(body.output) &&
            body.output[0].content[0].type === 'output_text' &&
            body.output_text === undefined),
          `${armId}: its worker Runs consumed the REAL Responses envelope`);
          assertThat(eventsOfType(trial.facts, 'model.plan.parsed').length >= 1,
            `${armId}: the parser accepted the real-envelope response`);
          const receipts = trial.facts.receipts.filter(row =>
            row.operation === 'createFolder' && row.outcome === 'succeeded');
          assertThat(receipts.length >= 1,
            `${armId}: durable createFolder receipt(s) were produced (${receipts.length})`);
          assertThat(receipts.every(row => row.receipt &&
            row.receipt.before && row.receipt.before.existed === false &&
            row.receipt.after && row.receipt.after.existed === true),
          `${armId}: every created child was absent before and exists after`);
          assertThat(trial.facts.runs.length >= 1 &&
            trial.facts.runs.every(run => run.status === 'completed'),
          `${armId}: its Runs truthfully complete ` +
            `(${trial.facts.runs.map(run => run.status).join(',')})`);
          assertThat(eventsOfType(trial.facts, PROVIDER_TRANSPORT_INVOKED_EVENT).length >=
            trial.facts.runs.length,
          `${armId}: a durable transport-invocation observation per worker Run`);
          // A2a AND A2b ARE NOT ARM A. Their production path is the one being
          // proved, and the durable record says which path ran.
          assertThat(trial.facts.runs.length >= 2,
            `${armId}: the legacy v1 group path produced per-agent Runs, not one ` +
            `(${trial.facts.runs.length})`);
        }

        // ── AN OBSERVATION THAT DOES NOT PERSIST CHANGES NOTHING ──────────
        //
        // THE INVARIANT, PROVED AGAINST THE REAL PIPELINE. The fault is armed at
        // the store method that writes the transport observation, so everything
        // above it is production: the seam, callOpenAI, the worker loop, parsing,
        // the action authority, workspace execution, settlement, terminalization.
        //
        // The proof is an EQUIVALENCE against the identical trial run above. If
        // an evidence write could cancel a provider result — as it once could —
        // the two would differ in the Run status, in the receipt, or in whether
        // the response was consumed at all.
        const faultMarker = path.join(root, 'observation-fault.log');
        const faulted = await runOne({
          label: 'A-observation-write-fails', armId: 'A',
          responseSpec: oneActionSpec, observationFault: faultMarker });

        assertThat(fs.existsSync(faultMarker) &&
          fs.readFileSync(faultMarker, 'utf8').includes('observation_write_refused'),
        'observation fault: the durable transport-observation write really did fail');
        assertThat(eventsOfType(faulted.facts, PROVIDER_TRANSPORT_INVOKED_EVENT)
          .length === 0,
        'observation fault: and NO transport-invocation event is durable');

        // Everything the provider interaction produced is unchanged.
        const faultedBodies = persistedResponseBodies(faulted.facts);
        assertThat(faultedBodies.length === oneBodies.length &&
          JSON.stringify(faultedBodies) === JSON.stringify(oneBodies),
        'observation fault: the provider response was still consumed and persisted, ' +
        'byte-identically to the run whose observation succeeded');
        assertThat(eventsOfType(faulted.facts, 'model.plan.parsed').length ===
          eventsOfType(oneAction.facts, 'model.plan.parsed').length,
        'observation fault: response parsing is unchanged');
        const faultedReceipts = faulted.facts.receipts.filter(row =>
          row.operation === 'createFolder' && row.outcome === 'succeeded');
        assertThat(faultedReceipts.length === 1 &&
          faultedReceipts[0].workspace_path === created[0].workspace_path,
        'observation fault: the same single createFolder receipt was committed');
        assertThat(faulted.facts.runs.length === oneAction.facts.runs.length &&
          faulted.facts.runs.every(row => row.status === 'completed'),
        `observation fault: the Run still truthfully completes ` +
        `(${faulted.facts.runs.map(row => row.status).join(',')})`);
        assertThat(faulted.harnessError === null,
          'observation fault: the trial still produced its artifact');

        // NO RETRY, NO DUPLICATE REQUEST, NO ECONOMIC DIFFERENCE.
        assertThat(faulted.observations.length === oneAction.observations.length,
          `observation fault: exactly the same number of provider requests ` +
          `(${faulted.observations.length}) — no retry, no duplicate`);
        const reservationsFor = async ticketId => (await store.pool.query(
          `SELECT count(*)::int AS n FROM ${store.table('economic_request_reservations')}
            WHERE ticket_id = $1`, [ticketId])).rows[0].n;
        assertThat(await reservationsFor(faulted.ticketId) ===
          await reservationsFor(oneAction.ticketId),
        'observation fault: identical economic reservation count — settlement ' +
        'cannot have differed');

        // AND THE FAILURE WAS NOTICED, without touching the product path.
        const noticed = (await store.pool.query(
          `SELECT count(*)::int AS n FROM ${store.table('diagnostic_logs')}
            WHERE type = 'provider:transport_observation_unrecorded'`)).rows[0].n;
        assertThat(noticed >= 1,
          `observation fault: the unrecorded observation was reported through the ` +
          `bounded diagnostic channel (${noticed})`);

        // THE PROJECTION SAYS UNKNOWN — never NOT INVOKED.
        const faultedArtifact = JSON.parse(fs.readFileSync(
          path.join(root, 'fixture', 'A-observation-write-fails.json'), 'utf8'));
        const projected = faultedArtifact.ticketReport.durableObservation;
        assertThat(projected.transport.state === 'UNKNOWN',
          'observation fault: the artifact projects transport UNKNOWN');
        assertThat(!/NOT_INVOKED/i.test(JSON.stringify(projected)),
          'and never NOT_INVOKED — the record cannot prove invocation, which is ' +
          'a different statement from proving non-invocation');
        assertThat(projected.response.state === 'PERSISTED' &&
          projected.operationReceipts.count === 1 &&
          projected.terminal.statuses.completed === 1,
        'while the rest of the projection is complete and truthful — one field ' +
        'degraded, the record intact');

        console.log(`\n  (${assertThat.count()} ungoverned real-envelope assertions)`);
        console.log('  EXTERNAL PROVIDER CALLS MADE: 0');
      }, { timeoutMs: 1_800_000 });

  console.log('ungoverned real envelope pipeline PostgreSQL test passed');
}

main().catch(error => { console.error(error); process.exit(1); });
