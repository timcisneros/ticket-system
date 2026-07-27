#!/usr/bin/env node
'use strict';
// Durable browser-evidence verdict — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// Replaces the JSON-era `browser-evidence-audit-test.js`. This is a REPLACEMENT, not a
// retirement: `classifyBrowserEvidence` (server.js) is live, it decides what a browser
// run is allowed to claim, and no registered suite covered it.
//
// THE CONTRACT: a browser run's recorded verdict must reflect what the run actually
// CAPTURED, not what the model said about it. A model that navigates somewhere and
// announces success has produced a claim; page text and DOM observations are evidence.
// If those two are ever conflated, the operator-facing record asserts a verified
// objective for a run that verified nothing — and browser runs are exactly the case
// where nobody can re-check by looking at the workspace afterwards.
//
// The verdict is written to TWO durable places by the runtime's terminalization path:
// the run evaluation (`buildRunEvaluation` → run_evaluations) and the finalized replay
// (`buildFinalizedRunReplayState` → replay_snapshots.browserEvidenceStatus). Every
// scenario asserts BOTH, because a surface that agrees with itself proves nothing and
// operators read them through different views.
//
// ── WHY THE RUNS ARE DRIVEN THIS WAY ────────────────────────────────────────────────
//
// A browser run cannot execute browser operations here. Once `isBrowserRun` holds,
// execution routes through `getOrCreateBrowserSession`, which launches a real browser
// process; the checkpoint environment reports the engine unavailable
// (`BROWSER_ENGINE_EXECUTABLE` unset, no runtime auto-discovery, and no registered
// suite establishing reliable launch). That environment verification is recorded in
// A20 and is the reason this suite does not drive a live browser.
//
// So the operations are persisted the way the runtime persists them — through
// `completeActionReceipt` with `replayKey: 'browserOperations'`, the same repository
// call `recordBrowserOperationEvidence` makes — into a run that is genuinely RUNNING,
// and the run then terminalizes through its own normal path. Nothing about the verdict
// is test-specific: no status is written by hand, `classifyBrowserEvidence` is never
// called directly, and the runtime decides.
//
// The provider stub is what makes that ordering deterministic rather than racy. It
// BLOCKS at each run's first model call until this suite releases it by name, so every
// run sits at a known point — started, replay initialized, nothing captured — while its
// evidence is persisted. Releasing the gate lets the model complete the run and the
// runtime terminalize it. A gate that is never released stalls the run rather than
// silently producing a verdict from a half-built snapshot.
//
// NOTE FOR THE NEXT TRANCHE: A20 anticipated needing a test-only terminalization seam
// in server.js for this cluster. It is not needed. A run held at its first provider
// call is non-terminal, its replay snapshot already exists, and the runtime's own
// terminalization runs on release — so the production source is untouched and the
// verdict is produced by exactly the path production uses. The seam was built, proved
// redundant against this fixture, and removed.
//
// NO SCREENSHOTS. `evidence_available` is reachable through page text or through DOM
// observation, and this suite proves both independently. The screenshot branch is not
// exercised and no screenshot material is fabricated; scenario 8 asserts none appears.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const { assertScenariosExecuted } = require('./child-process-settlement');

const STAMP = Date.now();
const assert = createAsserter();
let scenariosRun = 0;

const GATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `browser-evidence-gate-${STAMP}-`));
const SUBJECT_ORIGIN = 'https://subject.evidence.test';
const DECOY_ORIGIN = 'https://decoy.evidence.test';

// Each run is identified in the prompt by a unique marker so the provider stub can
// select its plan and its gate without depending on prompt prose or a call counter.
const SCENARIOS = Object.freeze([
  {
    key: 'workspace', marker: `BEVWORKSPACE${STAMP}`, browser: false,
    objective: `BEVWORKSPACE${STAMP} inspect the workspace root and report`,
    expected: 'not_applicable'
  },
  {
    key: 'no-operations', marker: `BEVNOOPS${STAMP}`, browser: true,
    objective: `BEVNOOPS${STAMP} confirm the landing page is reachable`,
    expected: 'objective_unverified'
  },
  {
    key: 'blocked', marker: `BEVBLOCKED${STAMP}`, browser: true,
    objective: `BEVBLOCKED${STAMP} open the account page`,
    expected: 'target_blocked_or_redirected'
  },
  {
    key: 'blocked-with-content', marker: `BEVBLOCKEDCONTENT${STAMP}`, browser: true,
    objective: `BEVBLOCKEDCONTENT${STAMP} open the account page and read it`,
    expected: 'target_blocked_or_redirected'
  },
  {
    key: 'page-text', marker: `BEVTEXT${STAMP}`, browser: true,
    objective: `BEVTEXT${STAMP} read the landing page text`,
    expected: 'evidence_available'
  },
  {
    key: 'dom', marker: `BEVDOM${STAMP}`, browser: true,
    objective: `BEVDOM${STAMP} inventory the landing page controls`,
    expected: 'evidence_available'
  },
  {
    key: 'insufficient', marker: `BEVINSUFFICIENT${STAMP}`, browser: true,
    objective: `BEVINSUFFICIENT${STAMP} confirm the landing page loaded`,
    expected: 'browser_evidence_insufficient'
  },
  {
    key: 'decoy', marker: `BEVDECOY${STAMP}`, browser: true, decoy: true,
    objective: `BEVDECOY${STAMP} read a different site's landing page`,
    expected: 'evidence_available'
  }
]);

const byKey = key => SCENARIOS.find(scenario => scenario.key === key);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// The stub answers every run the same way — "I am finished" — so the difference
// between the scenarios is ONLY the evidence each run captured. A stub that varied its
// claim per scenario would let a runtime that reads the claim instead of the evidence
// still look correct.
function createPreload() {
  const preloadPath = path.join(os.tmpdir(), `browser-evidence-preload-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
const fs = require('fs');
const path = require('path');
const GATE_DIR = ${JSON.stringify(GATE_DIR)};
const MARKERS = ${JSON.stringify(SCENARIOS.map(scenario => scenario.marker))};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

global.fetch = async function(_url, options = {}) {
  const raw = String(options.body || '');
  const marker = MARKERS.find(candidate => raw.includes(candidate)) || null;
  if (marker) {
    // Hold the run at its first model call until the suite has persisted this run's
    // browser evidence. Never times out: a stalled run is a loud failure upstream,
    // whereas proceeding early would terminalize a snapshot the suite had not
    // finished building and produce a verdict for the wrong inputs.
    while (!fs.existsSync(path.join(GATE_DIR, marker))) await sleep(50);
  }
  const plan = { message: 'Objective addressed; finishing.', actions: [], complete: true };
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'browser-evidence-verdict']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify(plan),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
};
`);
  return preloadPath;
}

function releaseGate(marker) {
  fs.writeFileSync(path.join(GATE_DIR, marker), 'release');
}

// Built to the shape `recordBrowserOperationEvidence` writes, because that is what
// `classifyBrowserEvidence` reads. Anything simpler would be asserting against a
// record the runtime never produces.
function browserOperationEvidence({ targetId, origin, operation, args, metadata, status = 'ok', resourceUrl }) {
  const capturedAt = new Date().toISOString();
  const receipt = {
    operation,
    timestamp: capturedAt,
    metadata,
    partial: false,
    truncated: false,
    targetId: `browser:${targetId}`,
    targetKind: 'browser',
    targetScope: [origin],
    targetPath: null,
    targetResourceId: resourceUrl
  };
  return {
    receipt,
    evidence: {
      operation: { operation, args },
      receipt,
      status,
      error: null,
      errorCode: null,
      startedAt: capturedAt,
      durationMs: 11,
      targetId: `browser:${targetId}`,
      targetKind: 'browser',
      targetScope: [origin],
      targetPath: null,
      targetResourceId: resourceUrl
    },
    historyRecord: {
      allocationPlanId: null,
      allocationItemId: null,
      step: 1,
      operation,
      args,
      preState: null,
      postState: null,
      result: receipt,
      error: null,
      errorCode: null,
      failureKind: null,
      targetId: `browser:${targetId}`,
      targetKind: 'browser',
      targetScope: [origin],
      targetPath: null,
      targetResourceId: resourceUrl,
      authorityDecision: null,
      readReceipt: receipt,
      mutationReceipt: null
    }
  };
}

// The production write path. `runId`/`ticketId` are passed through unchanged so the
// store's own ownership check is the thing deciding where an operation may land.
async function persistBrowserOperation(store, { runId, ticketId, index, targetId, origin, operation, args, metadata, resourceUrl }) {
  const built = browserOperationEvidence({ targetId, origin, operation, args, metadata, resourceUrl });
  const operationKey = `browser-evidence:${runId}:${index}:${operation}`;
  return store.completeActionReceipt({
    runId,
    ticketId,
    operationKey,
    stepId: String(index),
    operation,
    outcome: 'succeeded',
    historyRecord: built.historyRecord,
    receipt: built.receipt,
    replayKey: 'browserOperations',
    replayItem: built.evidence,
    event: { type: 'browser.operation', stepId: String(index), payload: built.evidence }
  });
}

function navigateMetadata(finalUrl, requestedUrl = finalUrl) {
  return {
    requestedUrl,
    finalUrl,
    status: 200,
    redirectChain: requestedUrl === finalUrl ? [] : [requestedUrl, finalUrl],
    pageStateHash: `nav-${finalUrl}`
  };
}

async function main() {
  const preloadPath = createPreload();
  try {
    await withHarness('browser evidence verdict', async ({ store, startServer }) => {
      const agent = (await store.createConfiguredAgent({
        value: { name: `BrowserEvidence-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'k' },
        groupIds: [], changedBy: 'browser-evidence-verdict-test'
      })).agent;

      const makeTarget = async (id, name, origin) => store.createBrowserTarget({
        target: {
          id, name, status: 'active',
          allowedOrigins: [origin],
          startUrl: `${origin}/`,
          limits: {
            maxNavigationsPerRun: 4, maxActionsPerRun: 8, navTimeoutMs: 5000,
            waitTimeoutMsCap: 1000, maxPageTextBytes: 4096, maxScreenshotsPerRun: 2
          }
        },
        changedBy: 'browser-evidence-verdict-test'
      });
      const subjectTarget = await makeTarget(`bev-subject-${STAMP}`, 'Subject target', SUBJECT_ORIGIN);
      const decoyTarget = await makeTarget(`bev-decoy-${STAMP}`, 'Decoy target', DECOY_ORIGIN);

      const server = await startServer({
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        // The runs sit at their gates while every scenario's evidence is persisted.
        // A lease short enough to expire in that window would let the scheduler
        // reclaim a run mid-setup.
        RUN_LEASE_DURATION_MS: '900000'
      });
      const cookie = await server.login();

      for (const scenario of SCENARIOS) {
        const response = await server.request('POST', '/tickets', {
          cookie,
          form: {
            objective: scenario.objective,
            assignmentTargetType: 'agent',
            assignmentTargetId: String(agent.id),
            assignmentMode: 'individual',
            ...(scenario.browser ? {
              executionTargetKind: 'browser',
              browserTargetId: scenario.decoy ? decoyTarget.id : subjectTarget.id
            } : {})
          }
        });
        if (response.statusCode !== 302) {
          throw new Error(`ticket creation for ${scenario.key} returned HTTP ${response.statusCode}: ${response.body.slice(0, 500)}`);
        }
      }

      const tickets = (await store.listTickets({ limit: 100 })).tickets || [];
      for (const scenario of SCENARIOS) {
        const ticket = tickets.find(candidate => candidate.objective === scenario.objective);
        if (!ticket) throw new Error(`ticket for ${scenario.key} was not persisted`);
        scenario.ticketId = ticket.id;
      }

      // Every run must be RUNNING with its replay snapshot initialized before any
      // evidence is attached: `appendRunEvidence` refuses a run that has no snapshot,
      // so reaching this point is itself proof the runs really started.
      await waitFor(async () => {
        const runs = (await store.listRuns({ limit: 100 })).runs || [];
        for (const scenario of SCENARIOS) {
          const run = runs.find(candidate => candidate.ticketId === scenario.ticketId);
          if (!run || run.status !== 'running') return false;
          if (!(await store.getReplaySnapshot(run.id))) return false;
          scenario.runId = run.id;
        }
        return true;
      }, 120000, 'every run to reach running with an initialized replay snapshot');

      // ── Evidence, per scenario ────────────────────────────────────────────────
      // `no-operations` and `workspace` deliberately receive none.
      const subjectOps = {
        blocked: [
          {
            operation: 'navigate', args: { url: `${SUBJECT_ORIGIN}/account` },
            metadata: navigateMetadata(`${SUBJECT_ORIGIN}/sorry/index`, `${SUBJECT_ORIGIN}/account`),
            resourceUrl: `${SUBJECT_ORIGIN}/sorry/index`
          }
        ],
        // Blocked navigation AND content that would otherwise be sufficient on its
        // own: this is the precedence proof. A classifier that checked content first
        // would call this run verified while it never reached the target.
        'blocked-with-content': [
          {
            operation: 'navigate', args: { url: `${SUBJECT_ORIGIN}/account` },
            metadata: navigateMetadata(`${SUBJECT_ORIGIN}/login`, `${SUBJECT_ORIGIN}/account`),
            resourceUrl: `${SUBJECT_ORIGIN}/login`
          },
          {
            operation: 'readPageText', args: {},
            metadata: { bytes: 2048, fullBytes: 2048, contentHash: 'blocked-text', pageStateHash: 'blocked-state' },
            resourceUrl: `${SUBJECT_ORIGIN}/login`
          },
          {
            operation: 'observe', args: {},
            metadata: { elementCount: 7, pageStateHash: 'blocked-dom' },
            resourceUrl: `${SUBJECT_ORIGIN}/login`
          }
        ],
        'page-text': [
          {
            operation: 'navigate', args: { url: `${SUBJECT_ORIGIN}/` },
            metadata: navigateMetadata(`${SUBJECT_ORIGIN}/`),
            resourceUrl: `${SUBJECT_ORIGIN}/`
          },
          {
            operation: 'readPageText', args: {},
            metadata: { bytes: 1024, fullBytes: 1024, contentHash: 'text', pageStateHash: 'text-state' },
            resourceUrl: `${SUBJECT_ORIGIN}/`
          }
        ],
        // Exactly the boundary value. One fewer element is scenario 7.
        dom: [
          {
            operation: 'navigate', args: { url: `${SUBJECT_ORIGIN}/` },
            metadata: navigateMetadata(`${SUBJECT_ORIGIN}/`),
            resourceUrl: `${SUBJECT_ORIGIN}/`
          },
          {
            operation: 'observe', args: {},
            metadata: { elementCount: 3, pageStateHash: 'dom-state' },
            resourceUrl: `${SUBJECT_ORIGIN}/`
          }
        ],
        // Navigated, observed too little to count, and the model still claimed the
        // objective was complete. The claim is in `parsedModelPlans`; it is not
        // evidence, and the verdict must say so.
        insufficient: [
          {
            operation: 'navigate', args: { url: `${SUBJECT_ORIGIN}/` },
            metadata: navigateMetadata(`${SUBJECT_ORIGIN}/`),
            resourceUrl: `${SUBJECT_ORIGIN}/`
          },
          {
            operation: 'observe', args: {},
            metadata: { elementCount: 2, pageStateHash: 'weak-dom' },
            resourceUrl: `${SUBJECT_ORIGIN}/`
          }
        ],
        decoy: [
          {
            operation: 'navigate', args: { url: `${DECOY_ORIGIN}/` },
            metadata: navigateMetadata(`${DECOY_ORIGIN}/`),
            resourceUrl: `${DECOY_ORIGIN}/`
          },
          {
            operation: 'readPageText', args: {},
            metadata: { bytes: 4096, fullBytes: 4096, contentHash: 'decoy-text', pageStateHash: 'decoy-state' },
            resourceUrl: `${DECOY_ORIGIN}/`
          }
        ]
      };

      for (const [key, operations] of Object.entries(subjectOps)) {
        const scenario = byKey(key);
        const targetId = scenario.decoy ? decoyTarget.id : subjectTarget.id;
        const origin = scenario.decoy ? DECOY_ORIGIN : SUBJECT_ORIGIN;
        let index = 0;
        for (const operation of operations) {
          index += 1;
          await persistBrowserOperation(store, {
            runId: scenario.runId, ticketId: scenario.ticketId,
            index, targetId, origin, ...operation
          });
        }
      }

      // ── 0. OWNERSHIP — evidence cannot be attached to a run that does not own it ──
      // Asserted BEFORE the runs terminalize, because this is the write path the
      // runtime uses and the rejection has to come from the store, not from a
      // finalized-snapshot guard that would refuse everything at that point.
      scenariosRun += 1;
      const unverified = byKey('no-operations');
      const decoy = byKey('decoy');
      let crossAttachRejected = null;
      try {
        await persistBrowserOperation(store, {
          runId: unverified.runId,
          ticketId: decoy.ticketId,
          index: 99, targetId: decoyTarget.id, origin: DECOY_ORIGIN,
          operation: 'readPageText', args: {},
          metadata: { bytes: 4096, fullBytes: 4096, contentHash: 'stolen', pageStateHash: 'stolen' },
          resourceUrl: `${DECOY_ORIGIN}/`
        });
      } catch (error) {
        crossAttachRejected = error;
      }
      assert(crossAttachRejected !== null,
        '0: evidence offered for one run under another ticket\'s ownership is refused');
      assert(/does not belong to ticket/.test(String(crossAttachRejected.message)),
        `0: refused on ownership, naming the mismatch (${crossAttachRejected.message})`);
      const unverifiedBeforeRelease = await store.getReplaySnapshot(unverified.runId);
      assert((unverifiedBeforeRelease.snapshot.browserOperations || []).length === 0,
        '0: the refused write left no partial evidence behind');

      // ── Release every gate and let the runtime terminalize each run itself ─────
      for (const scenario of SCENARIOS) releaseGate(scenario.marker);

      const terminalRuns = await waitFor(async () => {
        const runs = (await store.listRuns({ limit: 100 })).runs || [];
        const mine = SCENARIOS.map(scenario => runs.find(run => run.id === scenario.runId));
        if (mine.some(run => !run)) return null;
        return mine.every(run => ['completed', 'failed', 'interrupted'].includes(run.status)) ? mine : null;
      }, 120000, 'every run to reach a terminal status');

      const durable = async runId => {
        const [run, evaluation, replay] = await Promise.all([
          store.getRun(runId), store.getRunEvaluation(runId), store.getReplaySnapshot(runId)
        ]);
        return {
          run,
          evaluation: evaluation ? evaluation.evaluation : null,
          replay,
          snapshot: replay ? replay.snapshot : null
        };
      };

      const states = new Map();
      for (const scenario of SCENARIOS) states.set(scenario.key, await durable(scenario.runId));

      // ── 1. The runs are real browser runs that terminalized normally ──────────
      // Without this, every verdict below could be `not_applicable` in disguise, or
      // could belong to a run that never started.
      scenariosRun += 1;
      assert(terminalRuns.length === SCENARIOS.length,
        `1: every scenario produced a terminal run (${terminalRuns.length})`);
      for (const scenario of SCENARIOS) {
        const state = states.get(scenario.key);
        assert(state.run.status === 'completed',
          `1: ${scenario.key} completed through the runtime's own terminalization (${state.run.status}: ${state.run.error || ''})`);
        assert(state.replay.finalizedAt !== null && state.replay.finalizedAt !== undefined,
          `1: ${scenario.key} has a FINALIZED replay snapshot, so its verdict was written at terminalization`);
        assert(state.snapshot.terminalStatus === state.run.status,
          `1: ${scenario.key} replay agrees with the run's terminal status (${state.snapshot.terminalStatus})`);
        assert(state.snapshot.runId === scenario.runId && state.replay.ticketId === scenario.ticketId,
          `1: ${scenario.key} replay identifies its own run and ticket`);
      }
      const browserScenarios = SCENARIOS.filter(scenario => scenario.browser);
      for (const scenario of browserScenarios) {
        const state = states.get(scenario.key);
        assert(state.run.targetRef && state.run.targetRef.kind === 'browser',
          `1: ${scenario.key} is a browser-target run`);
        assert(state.run.browserTargetSnapshot && state.run.browserTargetSnapshot.status === 'active',
          `1: ${scenario.key} carries the browser target snapshot the gate requires`);
        assert(Array.isArray(state.run.browserTargetSnapshot.allowedOrigins) &&
               state.run.browserTargetSnapshot.allowedOrigins.length > 0,
          `1: ${scenario.key} snapshot carries the target's allowed origins`);
      }
      // The model said "complete" on every run, including the ones whose verdict is
      // NOT evidence_available. This is what makes "a claim is not evidence" a
      // property of the runtime rather than of how the stub was written.
      for (const scenario of browserScenarios) {
        const plans = states.get(scenario.key).snapshot.parsedModelPlans || [];
        assert(plans.some(plan => plan && plan.complete === true),
          `1: ${scenario.key} durably recorded the model's completion claim`);
      }

      // ── 2. The gate — a non-browser run is not classified at all ──────────────
      scenariosRun += 1;
      const workspace = states.get('workspace');
      assert(workspace.evaluation.browserEvidence.status === 'not_applicable',
        `2: a workspace run is not_applicable (${workspace.evaluation.browserEvidence.status})`);
      assert(workspace.evaluation.browserEvidence.detail === null,
        '2: with no detail invented for it');
      assert(!Object.prototype.hasOwnProperty.call(workspace.snapshot, 'browserOperations'),
        '2: and its replay never gains a browserOperations collection');
      assert(workspace.snapshot.browserEvidenceStatus === 'not_applicable',
        `2: the finalized replay agrees (${workspace.snapshot.browserEvidenceStatus})`);

      // ── 3–8. The verdict matrix, in classifier precedence order ───────────────
      const expectations = [
        {
          key: 'no-operations', label: '3',
          why: 'no browser operations at all is UNVERIFIED, the only way to reach that status',
          detail: /no browser operations/i
        },
        {
          key: 'blocked', label: '4',
          why: 'a navigation that landed on a blocked page is BLOCKED',
          detail: /\/sorry\//
        },
        {
          key: 'blocked-with-content', label: '5',
          why: 'blocked wins over content that would otherwise be sufficient',
          detail: /\/login/
        },
        {
          key: 'page-text', label: '6',
          why: 'non-empty page text alone is sufficient evidence',
          detail: /page text/i
        },
        {
          key: 'dom', label: '7',
          why: 'DOM observation at the boundary is sufficient evidence on its own',
          detail: /3 interactive elements/i
        },
        {
          key: 'insufficient', label: '8',
          why: 'navigating and claiming completion without capturing content is INSUFFICIENT',
          detail: /insufficient/i
        }
      ];

      for (const expectation of expectations) {
        scenariosRun += 1;
        const scenario = byKey(expectation.key);
        const state = states.get(expectation.key);
        const evidence = state.evaluation.browserEvidence;

        assert(evidence.status === scenario.expected,
          `${expectation.label}: ${expectation.why} — run evaluation says ${scenario.expected} (${evidence.status}: ${evidence.detail})`);
        assert(state.snapshot.browserEvidenceStatus === scenario.expected,
          `${expectation.label}: the finalized replay records the same verdict (${state.snapshot.browserEvidenceStatus})`);
        assert(state.snapshot.browserEvidenceDetail === evidence.detail,
          `${expectation.label}: both surfaces carry the same explanation, not two accounts of one run`);
        assert(expectation.detail.test(String(evidence.detail || '')),
          `${expectation.label}: the explanation names what it concluded from (${evidence.detail})`);
      }

      // The two sufficiency branches must be independently load-bearing: page text
      // with no qualifying observation, and observation with no page text.
      const textOps = states.get('page-text').snapshot.browserOperations || [];
      const domOps = states.get('dom').snapshot.browserOperations || [];
      assert(textOps.some(op => op.operation.operation === 'readPageText') &&
             !textOps.some(op => op.operation.operation === 'observe'),
        '6: the page-text run carried NO DOM observation, so text alone decided it');
      assert(domOps.some(op => op.operation.operation === 'observe') &&
             !domOps.some(op => op.operation.operation === 'readPageText'),
        '7: the DOM run carried NO page text, so observation alone decided it');
      const weakOps = states.get('insufficient').snapshot.browserOperations || [];
      assert(weakOps.some(op => op.operation.operation === 'navigate'),
        '8: the insufficient run did navigate, so its verdict is about captured content, not about doing nothing');
      assert(states.get('insufficient').evaluation.browserEvidence.status !== 'objective_unverified',
        '8: navigating without capturing content is INSUFFICIENT, never unverified');

      // ── 9. Attribution — no run is satisfied by another run's evidence ────────
      scenariosRun += 1;
      assert(states.get('decoy').evaluation.browserEvidence.status === 'evidence_available',
        '9: the decoy run on a different target really did capture sufficient evidence');
      assert(states.get('no-operations').evaluation.browserEvidence.status === 'objective_unverified',
        '9: and the run with none stays unverified regardless');
      for (const scenario of browserScenarios) {
        const state = states.get(scenario.key);
        const operations = state.snapshot.browserOperations || [];
        const expectedCount = (subjectOps[scenario.key] || []).length;
        assert(operations.length === expectedCount,
          `9: ${scenario.key} carries exactly its own ${expectedCount} operation(s) (${operations.length})`);
        const expectedTargetId = `browser:${scenario.decoy ? decoyTarget.id : subjectTarget.id}`;
        assert(operations.every(op => op.targetId === expectedTargetId),
          `9: ${scenario.key} evidence is attributed to its own browser target`);
        const receipts = await store.listOperationReceipts(scenario.runId, { limit: 100 });
        assert(receipts.length === expectedCount,
          `9: ${scenario.key} has exactly its own durable operation receipts (${receipts.length})`);
        assert(receipts.every(receipt => receipt.runId === scenario.runId && receipt.ticketId === scenario.ticketId),
          `9: ${scenario.key} receipts belong to its own run and ticket`);
      }

      // ── 10. PRIVACY — text and DOM evidence never becomes image evidence ──────
      scenariosRun += 1;
      for (const scenario of browserScenarios) {
        const state = states.get(scenario.key);
        const operations = state.snapshot.browserOperations || [];
        assert(!operations.some(op => op.operation.operation === 'screenshot'),
          `10: ${scenario.key} reached its verdict with no screenshot operation`);
        assert(!operations.some(op => op.receipt && op.receipt.metadata &&
               (op.receipt.metadata.artifactPath || op.receipt.metadata.sha256)),
          `10: ${scenario.key} carries no screenshot artifact material`);
        // The runtime's insufficiency detail legitimately mentions that no screenshot
        // was taken, so the property is that no verdict is JUSTIFIED by one.
        assert(!/screenshot captured/i.test(String(state.snapshot.browserEvidenceDetail || '')),
          `10: ${scenario.key} verdict is not justified by a screenshot (${state.snapshot.browserEvidenceDetail})`);
      }
      assert(/page text/i.test(String(states.get('page-text').snapshot.browserEvidenceDetail)) &&
             /elements/i.test(String(states.get('dom').snapshot.browserEvidenceDetail)),
        '10: both sufficient verdicts are explained by read-only text or DOM evidence');

      // ── 11. The browser primitive contract the historical suite pinned ────────
      scenariosRun += 1;
      const contract = states.get('page-text').snapshot.primitiveContract || {};
      const allowed = contract.allowedOperations || [];
      for (const operation of ['navigate', 'observe', 'readPageText', 'screenshot', 'wait']) {
        assert(allowed.includes(operation), `11: browser runs may ${operation}`);
      }
      assert(allowed.length === 5,
        `11: and may do nothing else — exactly five browser operations (${allowed.length}: ${allowed.join(', ')})`);
      assert((contract.mutatingOperations || []).length === 0,
        '11: no browser operation is classified as mutating');

      // ── 12. HYDRATION — both verdicts survive a runtime restart ───────────────
      // Startup convergence re-examines terminal runs. A verdict that only exists in
      // the process that computed it is not a durable record.
      scenariosRun += 1;
      await server.stop();
      const restarted = await startServer({
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '900000'
      });
      const restartedCookie = await restarted.login();
      for (const scenario of SCENARIOS) {
        const after = await durable(scenario.runId);
        assert(after.evaluation.browserEvidence.status === scenario.expected,
          `12: ${scenario.key} run evaluation survives restart (${after.evaluation.browserEvidence.status})`);
        assert(after.snapshot.browserEvidenceStatus === scenario.expected,
          `12: ${scenario.key} finalized replay survives restart (${after.snapshot.browserEvidenceStatus})`);
        assert(after.snapshot.browserEvidenceDetail === states.get(scenario.key).snapshot.browserEvidenceDetail,
          `12: ${scenario.key} explanation is unchanged by the restart`);
      }
      // Served, not merely stored: the restarted runtime can still render the run.
      const detail = await restarted.request('GET', `/api/runs/${byKey('page-text').runId}/state`, { cookie: restartedCookie });
      assert(detail.statusCode === 200,
        `12: the restarted runtime serves the run's state (HTTP ${detail.statusCode})`);
      const served = JSON.parse(detail.body);
      assert(served.runEvaluation && served.runEvaluation.browserEvidence &&
             served.runEvaluation.browserEvidence.status === 'evidence_available',
        `12: and the operator-visible evaluation carries the durable verdict (${JSON.stringify(served.runEvaluation && served.runEvaluation.browserEvidence)})`);

      assertScenariosExecuted({
        label: 'browser evidence verdict',
        assertions: assert.count(),
        scenarios: scenariosRun,
        minAssertions: 90,
        minScenarios: 12
      });
      console.log(`\nPASS: browser evidence verdict — ${scenariosRun} scenarios, ${assert.count()} assertions (PostgreSQL-native)`);
    }, { schemaSlug: 'browser_evidence' });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
    try { fs.rmSync(GATE_DIR, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(`\nFAIL: browser evidence verdict — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
