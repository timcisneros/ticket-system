#!/usr/bin/env node
'use strict';
// Browser Phase-2 safe interaction - PostgreSQL-native authority matrix
// (P4-R2; docs/ARCHITECTURAL_DECISIONS_PENDING.md, "P4 - GOVERNED SURFACE
// EXPANSION" section 8, P4-R2 verification matrix).
//
// THE CONTRACT: browser interaction (click/fill/press) is mutation-tier
// authority with a full fail-closed conjunction and no substitutable gate:
// the canonical `browser:interact` permission at ticket creation/configuration,
// the admitted Run execution-policy opt-in (default false, frozen into the
// immutable run snapshot), the active target snapshot, the additive
// interaction/action/browser-operation budgets, canonical element provenance
// minted by a same-Run observe, the restricted press key allowlist, and the
// engine-level origin guard revalidated over interaction effects.
//
// WHY THE RUNS ARE DRIVEN THIS WAY: every scenario drives the REAL run loop
// through the REAL scheduler and a loopback fixture HTTP server whose origin
// is the target only allowed origin; a second loopback origin sits OUTSIDE
// every allowlist and records whether any request ever reaches it. A preload
// stub answers each run model calls with a static plan sequence keyed by a
// per-run marker, so the ONLY variable in every scenario is the authority
// the runtime itself enforces, and every assertion reads durable evidence
// (replay browserOperations / authorityChecks, operation receipts, run rows)
// rather than the stub own claims.
//
// AUTHORITY SPLIT: the permission gate, the default-deny and execution-policy
// refusal scenarios, and the Phase-3 exclusion scenarios are deterministic and
// run everywhere (their refusals happen before any browser session exists).
// The live interaction scenarios require a real Chromium engine
// (BROWSER_ENGINE_EXECUTABLE); when it is absent each live scenario reports
// SKIP with its reason instead of silently passing.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const argon2 = require('argon2');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const { assertScenariosExecuted } = require('./child-process-settlement');

const STAMP = Date.now();
const assert = createAsserter();
let scenariosRun = 0;
let liveScenariosRun = 0;
let liveScenariosSkipped = 0;

const ENGINE_EXECUTABLE = process.env.BROWSER_ENGINE_EXECUTABLE || '/usr/bin/chromium-browser';
const ENGINE_LIVE = (() => {
  try {
    return fs.statSync(ENGINE_EXECUTABLE).isFile();
  } catch (_) {
    return false;
  }
})();

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `browser-interaction-${STAMP}-`));
const GATE_DIR = path.join(WORK_DIR, 'gate');
fs.mkdirSync(GATE_DIR, { recursive: true });

const SENSITIVE_VALUE = 'super-secret-plaintext';
const POSTED_VALUE = 'posted-value';

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

// Loopback fixtures: the fixture origin serves the interactive page (link,
// note field, pin field, select, submit button, no-op button, escape button)
// plus /next as a navigation target. The decoy origin is OUTSIDE every
// allowlist and records whether any request ever reaches it.
function startBrowserFixtures() {
  return new Promise(resolve => {
    const decoyHits = [];
    const submittedHits = [];
    const decoy = http.createServer((req, res) => {
      decoyHits.push(req.url);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><head><title>Decoy origin</title></head><body><p>Decoy body.</p></body></html>');
    });
    decoy.listen(0, '127.0.0.1', () => {
      const decoyOrigin = `http://127.0.0.1:${decoy.address().port}`;
      const fixtureHits = [];
      const fixture = http.createServer((req, res) => {
        fixtureHits.push(req.url);
        if (req.url.startsWith('/submitted')) {
          // The externally observable side effect: one form submission, counted.
          submittedHits.push(req.url);
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (req.url === '/next') {
          res.end('<html><head><title>Next page</title></head><body>' +
            '<a href="/">Back home</a><p>Arrived on the next page.</p></body></html>');
          return;
        }
        if (req.url.startsWith('/submitted')) {
          res.end('<html><head><title>Submitted</title></head><body>' +
            '<p>The form was submitted.</p><a href="/">Back home</a></body></html>');
          return;
        }
        res.end('<html><head><title>Fixture home</title></head><body>' +
          '<script>window.__DECOY_ORIGIN__ = ' + JSON.stringify(decoyOrigin) + ';</script>' +
          '<a href="/next">Go next</a>' +
          '<form action="/submitted" method="get">' +
          '<input type="text" name="note">' +
          '<input type="password" name="pin">' +
          '<select name="choice"><option value="a">A</option><option value="b">B</option></select>' +
          '<button type="submit">Send</button>' +
          '</form>' +
          '<button type="button" id="noop">No-op</button>' +
          '<button type="button" id="escape">Escape</button>' +
          '<script>document.getElementById("escape").addEventListener("click", function () {' +
          'window.location.href = window.__DECOY_ORIGIN__ + "/";});</script>' +
          '</body></html>');
      });
      fixture.listen(0, '127.0.0.1', () => resolve({
        fixtureOrigin: `http://127.0.0.1:${fixture.address().port}`,
        decoyOrigin,
        fixtureHits,
        submittedHits,
        decoyHits,
        close: async () => {
          await new Promise(r => fixture.close(r));
          await new Promise(r => decoy.close(r));
        }
      }));
    });
  });
}

// Model stub: one static plan sequence per scenario marker, served one turn
// at a time. Two park mechanisms make mid-run state deterministic:
//   gate parks (R2-R) hold at their turn until the suite writes `<marker>.go`;
//   hold parks (R2-O crash recovery) hold at their turn while the shared hold
//     file exists, so the suite can SIGKILL a run whose interaction is already
//     committed and let the canonical recovery sweep replay it.
function writePreload(scenarioPlans, parkRules) {
  const preloadPath = path.join(WORK_DIR, `preload-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
const fs = require('fs');
const path = require('path');
const GATE_DIR = ${JSON.stringify(GATE_DIR)};
const PLANS = ${JSON.stringify(scenarioPlans)};
const PARKS = ${JSON.stringify(parkRules)};
const GATE_MARKER = ${JSON.stringify(`BIIMMUTABLE${STAMP}`)};
const RECOVERY_HOLD = path.join(GATE_DIR, 'recovery-hold');
const TURNS = {};

function respond(plan) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'browser-interaction-authority']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify(plan),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
}

global.fetch = async function(_url, options = {}) {
  const raw = String(options.body || '');
  const marker = Object.keys(PLANS).find(candidate => raw.includes(candidate));
  if (!marker) {
    return respond({ message: 'Unexpected run; finishing.', actions: [], complete: true });
  }
  const turn = (TURNS[marker] = (TURNS[marker] || 0) + 1);
  const plans = PLANS[marker] || [];
  const plan = plans[turn - 1] || { message: 'Finishing.', actions: [], complete: true };
  const parkTurn = PARKS[marker];
  if (parkTurn && turn === parkTurn) {
    if (marker === GATE_MARKER) {
      try { fs.writeFileSync(path.join(GATE_DIR, marker + '.atgate'), 'gate'); } catch (_) {}
      while (!fs.existsSync(path.join(GATE_DIR, marker + '.go'))) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    } else {
      try { fs.writeFileSync(path.join(GATE_DIR, marker + '.atgate'), 'gate'); } catch (_) {}
      while (fs.existsSync(RECOVERY_HOLD)) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  }
  return respond(plan);
};
`);
  return preloadPath;
}

// Run driver: creates the ticket through the real product form and returns
// the durable ticket, run, replay snapshot and operation receipts.
async function driveTicket(server, store, { cookie, agentId, targetId, objective, executionPolicy }) {
  const response = await server.request('POST', '/tickets', {
    cookie,
    form: {
      objective,
      assignmentTargetType: 'agent',
      assignmentTargetId: String(agentId),
      assignmentMode: 'individual',
      ...(targetId ? { executionTargetKind: 'browser', browserTargetId: targetId } : {}),
      ...(executionPolicy ? { executionPolicy: JSON.stringify(executionPolicy) } : {})
    }
  });
  if (response.statusCode !== 302) {
    throw new Error(`ticket creation for ${objective} returned HTTP ${response.statusCode}: ${response.body.slice(0, 300)}`);
  }
  const ticket = (await store.listTickets({ limit: 300 })).tickets
    .find(candidate => candidate.objective === objective);
  if (!ticket) throw new Error(`ticket was not persisted: ${objective}`);
  const started = await waitFor(async () => {
    const found = ((await store.listRuns({ limit: 300 })).runs || [])
      .find(candidate => candidate.ticketId === ticket.id);
    return found && found.status !== 'pending' ? found : null;
  }, 120000, `the run to start for ${objective}`);
  const terminal = await waitFor(async () => {
    const found = ((await store.listRuns({ limit: 300 })).runs || [])
      .find(candidate => candidate.id === started.id);
    return found && ['completed', 'failed', 'interrupted'].includes(found.status) ? found : null;
  }, 240000, `the run to terminalize for ${objective}`);
  const snapshot = (await store.getReplaySnapshot(terminal.id)).snapshot;
  const receipts = await store.listOperationReceipts(terminal.id, { limit: 300 });
  return { ticket, run: terminal, snapshot, receipts };
}

// The operator identity owns browser:interact for authorized scenarios and is
// deliberately NOT granted it for the permission-gate scenario. The stamped
// marker strings are embedded in each scenario objective so the provider stub
// can select its plan without depending on prompt prose or a call counter.
const MARKER = name => `${name}${STAMP}`;
const ELEMENT_ID_LINK = 'observed-1';
const ELEMENT_ID_NOTE = 'observed-2';
const ELEMENT_ID_PIN = 'observed-3';
const ELEMENT_ID_SUBMIT = 'observed-5';
const ELEMENT_ID_NOOP = 'observed-6';
const ELEMENT_ID_ESCAPE = 'observed-7';
const GATE_MARKER = MARKER('BIIMMUTABLE');

// R2-N1 refusal-shape helpers: the limiting authority must be the TARGET
// action budget, truthfully named in the refused receipt metadata.
function n1RefusalItem(run) {
  return run.snapshot.browserOperations.find(item =>
    item.operation && item.operation.operation === 'press' && item.status !== 'ok') || null;
}
function n1RefusalCode(run) {
  const item = n1RefusalItem(run);
  return item ? item.errorCode || null : null;
}
function n1RefusalLimit(run) {
  const item = n1RefusalItem(run);
  const metadata = item && item.receipt && item.receipt.metadata ? item.receipt.metadata : {};
  return metadata.configuredLimit === undefined ? null : metadata.configuredLimit;
}
function n1RefusalMatchesActionBudget(run) {
  return n1RefusalCode(run) === 'BROWSER_ACTION_LIMIT_EXCEEDED' &&
    n1RefusalItem(run) !== null &&
    JSON.stringify(n1RefusalItem(run)).includes('Browser action limit');
}
function recoveryEventsIncludeResume(events) {
  return events.some(event => event.type === 'run.resumed' ||
    event.type === 'run.lease_expired' ||
    (event.type === 'run.recovery_claimed'));
}

// Engine-required scenario wrapper: the live interaction scenarios need a real
// Chromium engine. When it is absent each scenario is counted as a SKIP with its
// reason instead of silently passing; the deterministic scenarios (default
// deny, policy gate, permission gate, Phase-3 exclusion) run everywhere.
async function liveScenario(label, body) {
  scenariosRun += 1;
  if (!ENGINE_LIVE) {
    liveScenariosSkipped += 1;
    console.log(`SKIP ${label}: no executable browser engine at BROWSER_ENGINE_EXECUTABLE=${ENGINE_EXECUTABLE}`);
    return null;
  }
  liveScenariosRun += 1;
  return body();
}

async function main() {
  const fixtures = await startBrowserFixtures();
  let preloadPath = null;
  try {
    await withHarness('browser interaction authority', async ({ store, startServer }) => {
      const interactionTarget = await store.createBrowserTarget({
        target: {
          id: `bi-interact-${STAMP}`,
          name: 'Interaction target',
          status: 'active',
          allowedOrigins: [fixtures.fixtureOrigin],
          startUrl: `${fixtures.fixtureOrigin}/`,
          limits: {
            maxNavigationsPerRun: 4, maxActionsPerRun: 12, maxInteractionsPerRun: 4,
            navTimeoutMs: 5000, waitTimeoutMsCap: 1000, maxPageTextBytes: 65536, maxScreenshotsPerRun: 2
          }
        },
        changedBy: 'browser-interaction-authority-test'
      });
      const readOnlyTarget = await store.createBrowserTarget({
        target: {
          id: `bi-readonly-${STAMP}`,
          name: 'Read-only target',
          status: 'active',
          allowedOrigins: [fixtures.fixtureOrigin],
          startUrl: `${fixtures.fixtureOrigin}/`,
          limits: {
            maxNavigationsPerRun: 4, maxActionsPerRun: 10, maxInteractionsPerRun: 2,
            navTimeoutMs: 5000, waitTimeoutMsCap: 1000, maxPageTextBytes: 65536, maxScreenshotsPerRun: 2
          }
        },
        changedBy: 'browser-interaction-authority-test'
      });
      // R2-N1 target: the TARGET ACTION budget is intentionally the smallest
      // ceiling; interactions and the run-level browser-operation budget are
      // deliberately unreachable.
      const n1ActionTarget = await store.createBrowserTarget({
        target: {
          id: `bi-naction-${STAMP}`,
          name: 'Action-budget target',
          status: 'active',
          allowedOrigins: [fixtures.fixtureOrigin],
          startUrl: `${fixtures.fixtureOrigin}/`,
          limits: {
            maxNavigationsPerRun: 4, maxActionsPerRun: 4, maxInteractionsPerRun: 10,
            navTimeoutMs: 5000, waitTimeoutMsCap: 1000, maxPageTextBytes: 65536, maxScreenshotsPerRun: 2
          }
        },
        changedBy: 'browser-interaction-authority-test'
      });
      // R2-N2 target: target budgets are deliberately high; the run-level
      // browser-operation budget (set on the ticket execution policy) limits.
      const n2BrowserOpTarget = await store.createBrowserTarget({
        target: {
          id: `bi-nbop-${STAMP}`,
          name: 'Run-browser-operation-budget target',
          status: 'active',
          allowedOrigins: [fixtures.fixtureOrigin],
          startUrl: `${fixtures.fixtureOrigin}/`,
          limits: {
            maxNavigationsPerRun: 4, maxActionsPerRun: 12, maxInteractionsPerRun: 10,
            navTimeoutMs: 5000, waitTimeoutMsCap: 1000, maxPageTextBytes: 65536, maxScreenshotsPerRun: 2
          }
        },
        changedBy: 'browser-interaction-authority-test'
      });
      // The budget target carries the exact designed budget boundary the R2-M
      // scenario exhausts; every other live scenario uses the larger
      // interaction target so budget exhaustion never masks the positive path.
      const budgetTarget = await store.createBrowserTarget({
        target: {
          id: `bi-budget-${STAMP}`,
          name: 'Budget target',
          status: 'active',
          allowedOrigins: [fixtures.fixtureOrigin],
          startUrl: `${fixtures.fixtureOrigin}/`,
          limits: {
            maxNavigationsPerRun: 4, maxActionsPerRun: 12, maxInteractionsPerRun: 2,
            navTimeoutMs: 5000, waitTimeoutMsCap: 1000, maxPageTextBytes: 65536, maxScreenshotsPerRun: 2
          }
        },
        changedBy: 'browser-interaction-authority-test'
      });

      const agent = (await store.createConfiguredAgent({
        value: { name: `BrowserInteract-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'k' },
        groupIds: [],
        changedBy: 'browser-interaction-authority-test'
      })).agent;

      // Grant the ADMIN the browser:interact permission through a dedicated
      // permission group; the durable row comes from migration 044. The admin
      // identity is the server-bootstrapped one (it exists only after the
      // server starts); authorization is resolved per request from the live
      // catalog, so the grant applies to the next ticket-creation request.
      let interactGroup = null;
      let adminId = null;

      const plans = {
        // R2-A: default-deny ticket (executionPolicy omitted entirely). The
        // click refusal happens before any session exists, so this scenario
        // runs with or without a live engine.
        [MARKER('BIDENY')]: [
          { message: 'Attempt click by default.', actions: [{ operation: 'click', args: { elementId: ELEMENT_ID_LINK } }], complete: true }
        ],
        // R2-C: permission present, execution-policy absent.
        [MARKER('BIPOLICY')]: [
          { message: 'Attempt click without policy.', actions: [{ operation: 'click', args: { elementId: ELEMENT_ID_LINK } }], complete: true }
        ],
        // R2-D/E/F/G: one authorized run exercises the full positive catalog
        // against the live engine, ending on captured evidence.
        [MARKER('BIPOSITIVE')]: [
          { message: 'Read the landing page.', actions: [{ operation: 'navigate', args: { url: `${fixtures.fixtureOrigin}/` } }], complete: false },
          { message: 'Inventory elements.', actions: [{ operation: 'observe', args: {} }], complete: false },
          { message: 'Follow the link.', actions: [{ operation: 'click', args: { elementId: ELEMENT_ID_LINK } }], complete: false },
          { message: 'Return and inventory the form.', actions: [{ operation: 'navigate', args: { url: `${fixtures.fixtureOrigin}/` } }, { operation: 'observe', args: {} }], complete: false },
          { message: 'Fill the note field.', actions: [{ operation: 'fill', args: { elementId: ELEMENT_ID_NOTE, value: POSTED_VALUE } }], complete: false },
          { message: 'Fill the pin field.', actions: [{ operation: 'fill', args: { elementId: ELEMENT_ID_PIN, value: SENSITIVE_VALUE } }], complete: false },
          { message: 'Press Enter.', actions: [{ operation: 'press', args: { key: 'Enter' } }], complete: false },
          { message: 'Capture the final state.', actions: [{ operation: 'observe', args: {} }], complete: true }
        ],
        // R2-H: one authorized run meets the press allowlist refusal.
        [MARKER('BIPRESS')]: [
          { message: 'Read the landing page.', actions: [{ operation: 'navigate', args: { url: `${fixtures.fixtureOrigin}/` } }], complete: false },
          { message: 'Inventory elements.', actions: [{ operation: 'observe', args: {} }], complete: false },
          { message: 'Attempt a disallowed key.', actions: [{ operation: 'press', args: { key: 'F12' } }], complete: true }
        ],
        // R2-I: the unknown-element refusal.
        [MARKER('BIUNKNOWN')]: [
          { message: 'Read the landing page.', actions: [{ operation: 'navigate', args: { url: `${fixtures.fixtureOrigin}/` } }], complete: false },
          { message: 'Inventory elements.', actions: [{ operation: 'observe', args: {} }], complete: false },
          { message: 'Attempt an unknown element.', actions: [{ operation: 'click', args: { elementId: 'observed-999' } }], complete: true }
        ],
        // R2-J/R2-K: the stale-element refusal is recoverable; a fresh observe
        // re-mints provenance and the same elementId then succeeds.
        [MARKER('BISTALE')]: [
          { message: 'Read the landing page.', actions: [{ operation: 'navigate', args: { url: `${fixtures.fixtureOrigin}/` } }], complete: false },
          { message: 'Inventory elements.', actions: [{ operation: 'observe', args: {} }], complete: false },
          { message: 'Navigate to invalidate provenance.', actions: [{ operation: 'navigate', args: { url: `${fixtures.fixtureOrigin}/next` } }], complete: false },
          { message: 'Attempt the now-stale element.', actions: [{ operation: 'click', args: { elementId: ELEMENT_ID_LINK } }], complete: false },
          { message: 'Re-observe to recover.', actions: [{ operation: 'observe', args: {} }], complete: false },
          { message: 'Click with fresh provenance.', actions: [{ operation: 'click', args: { elementId: ELEMENT_ID_LINK } }], complete: true }
        ],
        // R2-L: the escape button navigates to the decoy origin mid-click.
        [MARKER('BIESCAPE')]: [
          { message: 'Read the landing page.', actions: [{ operation: 'navigate', args: { url: `${fixtures.fixtureOrigin}/` } }], complete: false },
          { message: 'Inventory elements.', actions: [{ operation: 'observe', args: {} }], complete: false },
          { message: 'Click the escape button.', actions: [{ operation: 'click', args: { elementId: ELEMENT_ID_ESCAPE } }], complete: true }
        ],
        // R2-M: three presses against a budget of two; the third refuses and
        // terminalizes the run per the existing browser budget classes.
        [MARKER('BIBUDGET')]: [
          { message: 'Read the landing page.', actions: [{ operation: 'navigate', args: { url: `${fixtures.fixtureOrigin}/` } }], complete: false },
          { message: 'Inventory elements.', actions: [{ operation: 'observe', args: {} }], complete: false },
          { message: 'Press Tab (1/2).', actions: [{ operation: 'press', args: { key: 'Tab' } }], complete: false },
          { message: 'Press Tab (2/2).', actions: [{ operation: 'press', args: { key: 'Tab' } }], complete: false },
          { message: 'Press Tab (3/2, must refuse).', actions: [{ operation: 'press', args: { key: 'Tab' } }], complete: true }
        ],
        // R2-N1: the TARGET action budget is the independent limiter. The
        // interaction and run-level browser-operation budgets are deliberately
        // NOT reachable in this scenario.
        [MARKER('BINACTION')]: [
          { message: 'Read the landing page.', actions: [{ operation: 'navigate', args: { url: `${fixtures.fixtureOrigin}/` } }], complete: false },
          { message: 'Inventory elements.', actions: [{ operation: 'observe', args: {} }], complete: false },
          { message: 'Press Tab (interaction 1/3).', actions: [{ operation: 'press', args: { key: 'Tab' } }], complete: false },
          { message: 'Press Tab (interaction 2/3).', actions: [{ operation: 'press', args: { key: 'Tab' } }], complete: false },
          { message: 'Press Tab (interaction 3/3, must hit the action budget).', actions: [{ operation: 'press', args: { key: 'Tab' } }], complete: true }
        ],
        // R2-N2: the RUN-LEVEL browser-operation budget is the independent
        // limiter. Target action and interaction budgets are deliberately NOT
        // reachable in this scenario.
        [MARKER('BINBROWSEROP')]: [
          { message: 'Read the landing page.', actions: [{ operation: 'navigate', args: { url: `${fixtures.fixtureOrigin}/` } }], complete: false },
          { message: 'Inventory elements.', actions: [{ operation: 'observe', args: {} }], complete: false },
          { message: 'Press Tab (browser operation 3/3).', actions: [{ operation: 'press', args: { key: 'Tab' } }], complete: false },
          { message: 'Press Tab (browser operation 4, must hit the run-level budget).', actions: [{ operation: 'press', args: { key: 'Tab' } }], complete: true }
        ],
        // R2-O: the click commits a side effect; the hold parks the run at the
        // next turn so the suite can SIGKILL the server with the interaction
        // already committed, then the canonical recovery sweep replays the run
        // and the SAME operation identity must skip without a second effect.
        [MARKER('BIRECOVERY')]: [
          { message: 'Read the landing page.', actions: [{ operation: 'navigate', args: { url: `${fixtures.fixtureOrigin}/` } }], complete: false },
          { message: 'Inventory elements.', actions: [{ operation: 'observe', args: {} }], complete: false },
          { message: 'Submit the form (committed side effect).', actions: [{ operation: 'click', args: { elementId: ELEMENT_ID_SUBMIT } }], complete: false },
          { message: 'Parked after the committed interaction.', actions: [{ operation: 'observe', args: {} }], complete: false },
          { message: 'Capture the final state.', actions: [{ operation: 'readPageText', args: {} }], complete: true }
        ],
        // R2-P: Phase-1 regression through the same real seam.
        [MARKER('BIREADONLY')]: [
          { message: 'Read the landing page.', actions: [{ operation: 'navigate', args: { url: `${fixtures.fixtureOrigin}/` } }], complete: false },
          { message: 'Inventory elements.', actions: [{ operation: 'observe', args: {} }], complete: false },
          { message: 'Read page text.', actions: [{ operation: 'readPageText', args: {} }], complete: false },
          { message: 'Wait briefly.', actions: [{ operation: 'wait', args: { forMs: 50 } }], complete: true }
        ],
        // R2-R: the gate turn parks this run mid-flight while the suite proves
        // that later operator/target authority mutations cannot rewrite its
        // admitted authority.
        [GATE_MARKER]: [
          { message: 'Read the landing page.', actions: [{ operation: 'navigate', args: { url: `${fixtures.fixtureOrigin}/` } }], complete: false },
          { message: 'Inventory elements.', actions: [{ operation: 'observe', args: {} }], complete: false },
          { message: 'Fill the note before the gate.', actions: [{ operation: 'fill', args: { elementId: ELEMENT_ID_NOTE, value: `before-${STAMP}` } }], complete: false },
          { message: 'Parked at the authority gate.', actions: [{ operation: 'observe', args: {} }], complete: false },
          { message: 'Click after mutations.', actions: [{ operation: 'click', args: { elementId: ELEMENT_ID_LINK } }], complete: true }
        ]
      };
      preloadPath = writePreload(plans, {
        [GATE_MARKER]: 4,
        [MARKER('BIRECOVERY')]: 4
      });

      let server = await startServer({ env: {
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '900000',
        BROWSER_ENGINE_EXECUTABLE: ENGINE_EXECUTABLE
      } });
      const cookie = await server.login();

      interactGroup = (await store.createGroup({
        value: { name: `Interactors-${STAMP}`, permissions: ['browser:interact'], canReceiveTickets: false },
        changedBy: 'browser-interaction-authority-test'
      })).group;
      const adminBootstrap = await store.getUserByUsername('admin');
      adminId = adminBootstrap.id;
      await store.updateUser({
        userId: adminId,
        expectedRevision: adminBootstrap.revision,
        value: { username: adminBootstrap.username, passwordHash: adminBootstrap.passwordHash },
        groupIds: [...(adminBootstrap.groupIds || []), interactGroup.id],
        changedBy: 'browser-interaction-authority-test'
      });

      const createInteractionTicket = async (objective, target, policy) =>
        driveTicket(server, store, {
          cookie, agentId: agent.id, targetId: target ? target.id : null,
          objective,
          // Every scenario's plan is longer than the default 4-step / 4-request
          // budget; raised per-run ceilings keep the authority matrix the only
          // variable under test.
          executionPolicy: {
            maxExecutionSteps: 16,
            maxModelRequests: 16,
            maxRuntimeMs: 900000,
            ...(policy || {})
          }
        });

      // ── R2-P: Phase-1 regression through the same real seam ────────────────
      const readOnlyRun = await liveScenario('R2-P Phase-1 regression', async () =>
        createInteractionTicket(
          `${MARKER('BIREADONLY')} read-only regression ${readOnlyTarget.id}`, readOnlyTarget, {}));
      if (readOnlyRun) {
        assert(readOnlyRun.run.status === 'completed', 'R2-P: the Phase-1 read-only run completes');
        assert(readOnlyRun.snapshot && Array.isArray(readOnlyRun.snapshot.browserOperations),
          'R2-P: the Phase-1 run records a browserOperations replay collection');
        const readOnlyOps = readOnlyRun.snapshot.browserOperations;
        for (const operation of ['navigate', 'observe', 'readPageText', 'wait']) {
          assert(readOnlyOps.some(item => item.operation && item.operation.operation === operation && item.status === 'ok'),
            `R2-P: the Phase-1 run captures a successful ${operation} through the real engine seam`);
        }
        assert(!readOnlyOps.some(item => ['click', 'fill', 'press'].includes(item.operation && item.operation.operation)),
          'R2-P: the Phase-1 run records no interaction operations');
        assert(readOnlyRun.snapshot.browserEvidenceStatus === 'evidence_available',
          'R2-P: the Phase-1 run still earns the durable evidence_available verdict');
      }

      // ── R2-A: default deny (deterministic; runs with or without an engine) ──
      // The unauthorized interaction is refused as a typed authority denial:
      // BROWSER_INTERACTION_NOT_AUTHORIZED with the authority_denied failure
      // kind, a durable authorityChecks denial for exactly this operation key,
      // and a refused browserOperations receipt. Per the accepted Phase-1
      // substrate (browser errors fail the run), the refusal terminalizes the
      // run.
      scenariosRun += 1;
      const denyRun = await createInteractionTicket(
        `${MARKER('BIDENY')} default deny ${interactionTarget.id}`, interactionTarget, {});
      assert(denyRun.run.status === 'failed',
        `R2-A: the default-deny interaction refusal terminalizes the run (${denyRun.run.status})`);
      assert(denyRun.snapshot.failure && denyRun.snapshot.failure.kind === 'authority_denied' &&
        denyRun.snapshot.failure.code === 'BROWSER_INTERACTION_NOT_AUTHORIZED',
        `R2-A: the finalized replay records the typed authority denial (${JSON.stringify(denyRun.snapshot.failure)})`);
      const denyClick = denyRun.snapshot.browserOperations
        .find(item => item.operation && item.operation.operation === 'click');
      assert(denyClick && denyClick.status !== 'ok' && denyClick.errorCode === 'BROWSER_INTERACTION_NOT_AUTHORIZED',
        `R2-A: click refuses as authority denial (${denyClick && denyClick.errorCode})`);
      const denyReceipt = denyRun.receipts.find(receipt =>
        receipt.operation === 'click' && receipt.outcome === 'refused');
      assert(denyReceipt && denyReceipt.receipt && denyReceipt.receipt.failureKind === 'authority_denied',
        `R2-A: the refusal carries the authority_denied failure kind (${denyReceipt && denyReceipt.receipt && denyReceipt.receipt.failureKind})`);
      assert((denyRun.snapshot.authorityChecks || []).some(check =>
        check.status === 'denied' && check.rule === 'browser_interaction' && check.operation === 'click'),
        'R2-A: a durable authority denial is recorded for click');
      assert((await store.listRunEvents(denyRun.run.id, { afterSeq: -1, limit: 500 }))
        .some(event => event.type === 'authority.denied'),
        'R2-A: the authority.denied event is in the run event chain');
      assert(!denyRun.snapshot.browserOperations.some(item =>
        ['click', 'fill', 'press'].includes(item.operation && item.operation.operation) && item.status === 'ok'),
        'R2-A: no interaction operation ever succeeds in the default-deny run');

      // ── R2-B: permission gate at the product surface (deterministic) ────────
      scenariosRun += 1;
      // The unpermitted operator can authenticate and create tickets but holds
      // NO browser:interact permission — the exact one missing leg.
      const baseGroup = (await store.createGroup({
        value: { name: `BaseUsers-${STAMP}`, permissions: ['ticket:create', 'ticket:read'], canReceiveTickets: false },
        changedBy: 'browser-interaction-authority-test'
      })).group;
      const unpermittedUser = (await store.createUser({
        value: { username: `bi-unperm-${STAMP}`, passwordHash: await argon2.hash(`bi-unperm-${STAMP}`) },
        groupIds: [baseGroup.id],
        changedBy: 'browser-interaction-authority-test'
      })).user;
      const unpermittedLogin = await server.request('POST', '/login', {
        form: { username: unpermittedUser.username, password: `bi-unperm-${STAMP}` }
      });
      assert(unpermittedLogin.statusCode === 302, 'R2-B: an unpermitted operator can authenticate');
      const unpermittedCookie = (unpermittedLogin.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
      const unpermittedAttempt = await server.request('POST', '/tickets', {
        cookie: unpermittedCookie,
        form: {
          objective: `${MARKER('BIPERM')} permission gate ${interactionTarget.id}`,
          assignmentTargetType: 'agent',
          assignmentTargetId: String(agent.id),
          assignmentMode: 'individual',
          executionTargetKind: 'browser',
          browserTargetId: interactionTarget.id,
          allowBrowserInteractions: 'on'
        }
      });
      assert(unpermittedAttempt.statusCode === 400 &&
        String(unpermittedAttempt.body).includes('browser:interact'),
        'R2-B: ticket creation with allowBrowserInteractions without browser:interact is refused at the surface');
      const refusedTicket = (await store.listTickets({ limit: 300 })).tickets
        .find(candidate => candidate.objective === `${MARKER('BIPERM')} permission gate ${interactionTarget.id}`);
      assert(!refusedTicket, 'R2-B: the refused ticket creation persists nothing');
      const unpermittedReadonly = await server.request('POST', '/tickets', {
        cookie: unpermittedCookie,
        form: {
          objective: `${MARKER('BIPERMRO')} unpermitted read-only ${interactionTarget.id}`,
          assignmentTargetType: 'agent',
          assignmentTargetId: String(agent.id),
          assignmentMode: 'individual',
          executionTargetKind: 'browser',
          browserTargetId: interactionTarget.id
        }
      });
      assert(unpermittedReadonly.statusCode === 302,
        'R2-B: browser tickets without interaction opt-in need no browser:interact permission');

      // ── R2-C: execution-policy gate (deterministic) ─────────────────────────
      scenariosRun += 1;
      const policyRun = await createInteractionTicket(
        `${MARKER('BIPOLICY')} policy gate ${interactionTarget.id}`, interactionTarget, {});
      assert(policyRun.run.status === 'failed' &&
        policyRun.snapshot.failure && policyRun.snapshot.failure.kind === 'authority_denied',
        'R2-C: the missing execution-policy leg refuses the interaction as authority denial');
      const policyClick = policyRun.snapshot.browserOperations
        .find(item => item.operation && item.operation.operation === 'click');
      assert(policyClick && policyClick.errorCode === 'BROWSER_INTERACTION_NOT_AUTHORIZED',
        'R2-C: click without execution-policy authorization refuses as BROWSER_INTERACTION_NOT_AUTHORIZED');
      assert((policyRun.snapshot.authorityChecks || []).some(check =>
        check.status === 'denied' && check.rule === 'browser_interaction'),
        'R2-C: a durable authority denial is recorded for the policy gate');
      assert((await store.listRunEvents(policyRun.run.id, { afterSeq: -1, limit: 500 }))
        .some(event => event.type === 'authority.denied'),
        'R2-C: the authority.denied event is in the run event chain');

      // ── R2-D/E/F/G: authorized interaction, fill redaction, press ───────────
      const positiveRun = await liveScenario('R2-D/E/F/G authorized interactions', async () =>
        createInteractionTicket(
          `${MARKER('BIPOSITIVE')} authorized interaction ${interactionTarget.id}`,
          interactionTarget,
          { allowBrowserInteractions: true }));
      if (positiveRun) {
        assert(positiveRun.run.status === 'completed',
          `R2-D: the authorized interaction run completes (${positiveRun.run.status})`);
        const ops = positiveRun.snapshot.browserOperations;
        const opBy = (operation, nth = 0) =>
          ops.filter(item => item.operation && item.operation.operation === operation)[nth] || null;
        const clickOp = opBy('click');
        const fillNoteOp = opBy('fill', 0);
        const fillPinOp = opBy('fill', 1);
        const pressOp = opBy('press');
        assert(clickOp && clickOp.status === 'ok',
          `R2-D: the authorized click succeeds through the engine seam (${clickOp && clickOp.status})`);
        assert(clickOp.receipt && clickOp.receipt.metadata && clickOp.receipt.metadata.postPageStateHash &&
          clickOp.receipt.metadata.prePageStateHash,
          'R2-D: the click mutation receipt carries pre/post page-state identity');
        assert(clickOp.receipt.metadata.originContained === true,
          'R2-D: the click records origin containment');
        assert(ops.some(item => item.operation && item.operation.operation === 'observe' && item.status === 'ok'),
          'R2-D: the same-Run observe minted the provenance the click used');
        assert(JSON.stringify(clickOp).includes(ELEMENT_ID_LINK),
          'R2-D: the click evidence preserves the target elementId');

        assert(fillNoteOp && fillNoteOp.status === 'ok',
          `R2-E: the authorized non-sensitive fill succeeds (${fillNoteOp && fillNoteOp.status})`);
        assert(fillNoteOp.receipt.metadata.sensitive === false &&
          fillNoteOp.receipt.metadata.fillValue === POSTED_VALUE,
          `R2-E: the non-sensitive fill value is durable plaintext (got ${JSON.stringify(fillNoteOp.receipt.metadata.fillValue)})`);
        assert(fillPinOp && fillPinOp.status === 'ok', 'R2-F: the authorized sensitive fill succeeds');
        assert(fillPinOp.receipt.metadata.sensitive === true &&
          fillPinOp.receipt.metadata.fillValue &&
          fillPinOp.receipt.metadata.fillValue.redacted === true &&
          /^[0-9a-f]{64}$/.test(fillPinOp.receipt.metadata.fillValue.valueHash || ''),
          `R2-F: the sensitive fill value is stored redacted with a hash (${JSON.stringify(fillPinOp.receipt.metadata.fillValue)})`);
        const positiveEvents = await store.listRunEvents(positiveRun.run.id, { afterSeq: -1, limit: 500 });
        assert(!JSON.stringify(positiveRun.snapshot).includes(SENSITIVE_VALUE),
          'R2-F: the sensitive value never appears in the durable replay snapshot');
        assert(!JSON.stringify(positiveRun.receipts).includes(SENSITIVE_VALUE),
          'R2-F: the sensitive value never appears in any operation receipt');
        assert(!JSON.stringify(positiveEvents).includes(SENSITIVE_VALUE),
          'R2-F: the sensitive value never appears in the run event chain');
        assert(pressOp && pressOp.status === 'ok',
          `R2-G: the authorized press succeeds (${pressOp && pressOp.status})`);
        assert(pressOp.receipt.metadata.requestedKey === 'Enter',
          'R2-G: the press receipt records the requested key');
        assert((positiveRun.snapshot.authorityChecks || []).some(check =>
          check.status === 'allowed' && check.rule === 'browser_interaction'),
          'R2-D: a durable authority allowance is recorded for the authorized interactions');
      }

      // ── R2-H: press allowlist refusal ───────────────────────────────────────
      const pressRun = await liveScenario('R2-H press allowlist', async () =>
        createInteractionTicket(
          `${MARKER('BIPRESS')} press allowlist ${interactionTarget.id}`, interactionTarget,
          { allowBrowserInteractions: true }));
      if (pressRun) {
        const disallowedKey = pressRun.snapshot.browserOperations.find(item =>
          item.operation && item.operation.operation === 'press' && item.status !== 'ok');
        assert(disallowedKey && disallowedKey.errorCode === 'BROWSER_KEY_NOT_ALLOWED',
          `R2-H: a non-allowlisted key refuses (${disallowedKey && disallowedKey.errorCode})`);
        assert(JSON.stringify(disallowedKey).includes('F12'),
          'R2-H: the refusal records the refused key');
        assert(pressRun.run.status === 'failed',
          'R2-H: the disallowed-key refusal terminalizes the run per the invalid-action class');
        assert(!pressRun.snapshot.browserOperations.some(item =>
          item.operation && item.operation.operation === 'press' && item.status === 'ok'),
          'R2-H: no disallowed press ever takes effect');
      }

      // ── R2-I: unknown-element refusal ───────────────────────────────────────
      const unknownRun = await liveScenario('R2-I unknown element', async () =>
        createInteractionTicket(
          `${MARKER('BIUNKNOWN')} unknown element ${interactionTarget.id}`, interactionTarget,
          { allowBrowserInteractions: true }));
      if (unknownRun) {
        const unknownElement = unknownRun.snapshot.browserOperations.find(item =>
          item.operation && item.operation.operation === 'click' && item.status !== 'ok');
        assert(unknownElement && unknownElement.errorCode === 'BROWSER_ELEMENT_NOT_FOUND',
          `R2-I: an unknown elementId refuses (${unknownElement && unknownElement.errorCode})`);
        assert(JSON.stringify(unknownElement).includes('observed-999'),
          'R2-I: the refusal records the unknown elementId');
        assert(unknownRun.run.status === 'failed',
          'R2-I: the unknown-element refusal terminalizes the run per the invalid-action class');
      }

      // ── R2-J/R2-K: staleness refusal and re-observe recovery ───────────────
      const staleRun = await liveScenario('R2-J/K staleness recovery', async () =>
        createInteractionTicket(
          `${MARKER('BISTALE')} staleness recovery ${interactionTarget.id}`, interactionTarget,
          { allowBrowserInteractions: true }));
      if (staleRun) {
        const staleOps = staleRun.snapshot.browserOperations;
        const staleElement = staleOps.find(item =>
          item.operation && item.operation.operation === 'click' &&
          item.status !== 'ok' && item.errorCode === 'BROWSER_ELEMENT_STALE');
        assert(staleElement,
          `R2-J: the stale elementId refuses (${staleElement && staleElement.errorCode})`);
        assert(staleElement.receipt && staleElement.receipt.metadata &&
          staleElement.receipt.metadata.refusedAtPageStateHash,
          'R2-J: the staleness refusal names the page state at refusal');
        const recoveredClick = staleOps.find(item =>
          item.operation && item.operation.operation === 'click' && item.status === 'ok');
        assert(recoveredClick,
          'R2-K: a fresh observe recovers provenance and the same elementId then succeeds');
        assert(staleRun.run.status === 'completed',
          'R2-K: the staleness refusal is recoverable; the run completes on real evidence');
      }

      // ── R2-L: origin containment ────────────────────────────────────────────
      const escapeRun = await liveScenario('R2-L origin containment', async () =>
        createInteractionTicket(
          `${MARKER('BIESCAPE')} origin containment ${interactionTarget.id}`, interactionTarget,
          { allowBrowserInteractions: true }));
      if (escapeRun) {
        const escapeClick = escapeRun.snapshot.browserOperations.find(item =>
          item.operation && item.operation.operation === 'click' && item.status !== 'ok');
        assert(escapeClick && escapeClick.errorCode === 'BROWSER_ORIGIN_BLOCKED',
          `R2-L: the escape click is blocked at the origin boundary (${escapeClick && escapeClick.errorCode})`);
        assert(fixtures.decoyHits.length === 0,
          'R2-L: the decoy origin never received a request');
        assert(escapeClick.receipt && escapeClick.receipt.metadata &&
          escapeClick.receipt.metadata.originContained === false,
          'R2-L: the blocked click records the origin containment failure');
        assert(JSON.stringify(escapeClick).includes(fixtures.decoyOrigin),
          'R2-L: the blocked-click evidence preserves the blocked URL');
        assert(escapeRun.run.status === 'failed',
          'R2-L: the origin escape terminalizes the run per the accepted Phase-1 substrate');
      }

      // ── R2-M: interaction budget exhaustion ─────────────────────────────────
      const budgetRun = await liveScenario('R2-M interaction budget', async () =>
        createInteractionTicket(
          `${MARKER('BIBUDGET')} interaction budget ${budgetTarget.id}`, budgetTarget,
          { allowBrowserInteractions: true }));
      if (budgetRun) {
        const budgetRefusal = budgetRun.snapshot.browserOperations.find(item =>
          item.operation && item.operation.operation === 'press' &&
          item.status !== 'ok' && item.errorCode === 'BROWSER_INTERACTION_LIMIT_EXCEEDED');
        assert(budgetRefusal,
          'R2-M: the third interaction refuses on the interaction budget');
        assert(budgetRefusal.receipt.metadata.configuredLimit === 2,
          'R2-M: the refusal names the configured interaction limit');
        assert(budgetRun.snapshot.browserOperations.filter(item =>
          ['click', 'fill', 'press'].includes(item.operation && item.operation.operation) &&
          item.status === 'ok').length === 2,
          'R2-M: exactly the budgeted two interactions succeeded');
        assert(budgetRun.run.status === 'failed',
          'R2-M: budget exhaustion terminalizes the run per the existing browser budget classes');
      }

      // ── R2-N1: the TARGET maxActionsPerRun independently limits interactions ─
      // The interaction budget (10) and the run-level browser-operation budget
      // (deployment default 32) are deliberately unreachable; the target action
      // budget (4) is the smallest ceiling. The run drives navigate, observe,
      // and three authorized presses; the THIRD press is the fifth action and
      // must refuse through the canonical action-budget mechanism.
      const n1Run = await liveScenario('R2-N1 target action budget', async () =>
        createInteractionTicket(
          `${MARKER('BINACTION')} target action budget ${n1ActionTarget.id}`, n1ActionTarget,
          { allowBrowserInteractions: true }));
      if (n1Run) {
        const n1Ops = n1Run.snapshot.browserOperations;
        const n1OkInteractions = n1Ops.filter(item =>
          ['click', 'fill', 'press'].includes(item.operation && item.operation.operation) &&
          item.status === 'ok').length;
        assert(n1OkInteractions === 2,
          `R2-N1: exactly the allowed action budget of interactions succeeded (${n1OkInteractions})`);
        assert(n1RefusalMatchesActionBudget(n1Run),
          `R2-N1: the next interaction refuses through the action-budget mechanism (${n1RefusalCode(n1Run)})`);
        const n1LastOkIndex = n1Ops.map(item => item.status === 'ok').lastIndexOf(true);
        const n1RefusalIndex = n1Ops.findIndex(item => item.status !== 'ok');
        assert(n1RefusalIndex !== -1 && n1RefusalIndex > n1LastOkIndex &&
          n1Ops.slice(n1RefusalIndex).every(item =>
            item.status !== 'ok' ||
            ['navigate', 'observe'].includes(item.operation && item.operation.operation) === false),
          'R2-N1: no interaction succeeded after the action ceiling was reached');
        assert(n1Run.snapshot.browserOperations.some(item =>
          item.operation && item.operation.operation === 'press' && item.status === 'ok'),
          'R2-N1: the allowed interactions before the ceiling took effect');
        assert(n1Run.receipts.filter(receipt =>
          ['click', 'fill', 'press'].includes(receipt.operation) &&
          receipt.outcome === 'succeeded').length === 2,
          'R2-N1: exactly two interaction receipts committed');
        // The limiting authority is the TARGET action budget, truthfully named.
        assert(n1RefusalCode(n1Run) === 'BROWSER_ACTION_LIMIT_EXCEEDED' &&
          n1RefusalLimit(n1Run) === 4,
          `R2-N1: the refusal names the target action budget (${n1RefusalCode(n1Run)}, limit ${n1RefusalLimit(n1Run)})`);
        // maxInteractionsPerRun was NOT the limiting authority.
        assert(n1RefusalCode(n1Run) !== 'BROWSER_INTERACTION_LIMIT_EXCEEDED' &&
          n1Ops.every(item => item.errorCode !== 'BROWSER_INTERACTION_LIMIT_EXCEEDED'),
          'R2-N1: the interaction budget was not exhausted first');
        // The run-level browser-operation budget was NOT the limiting authority.
        assert((await store.listRunEvents(n1Run.run.id, { afterSeq: -1, limit: 500 }))
          .every(event => !(event.type === 'budget.exhausted' &&
            event.payload && event.payload.dimension === 'browser_operation')),
          'R2-N1: the run-level browser-operation budget was not exhausted first');
        assert(n1Run.snapshot.failure && n1Run.snapshot.failure.kind === 'browser_error',
          `R2-N1: the refusal terminalizes the run per the browser budget classes (${JSON.stringify(n1Run.snapshot.failure)})`);
        // No browser side effect occurs after the action ceiling: the third
        // press never reached the engine, so no third press receipt exists.
        assert(n1Run.receipts.filter(receipt =>
          receipt.operation === 'press' && receipt.outcome === 'refused').length === 1,
          'R2-N1: the refused third press is receipted exactly once as refused');
      }

      // ── R2-N2: the RUN-LEVEL maxBrowserOperationsPerRun independently limits ─
      // Target budgets are deliberately high (12 actions, 10 interactions); the
      // ticket's immutable run budget sets maxBrowserOperations=3. The fourth
      // browser operation must refuse through the runtime-budget controller.
      const n2Run = await liveScenario('R2-N2 run browser-operation budget', async () =>
        createInteractionTicket(
          `${MARKER('BINBROWSEROP')} run browser-operation budget ${n2BrowserOpTarget.id}`, n2BrowserOpTarget,
          { allowBrowserInteractions: true, maxBrowserOperations: 3 }));
      if (n2Run) {
        const n2Ops = n2Run.snapshot.browserOperations;
        assert(n2Ops.length === 3 &&
          n2Ops.every(item => item.status === 'ok'),
          `R2-N2: exactly the budgeted three browser operations executed (${n2Ops.length})`);
        assert(n2Ops.some(item =>
          item.operation && item.operation.operation === 'press' && item.status === 'ok'),
          'R2-N2: the third browser operation was an authorized interaction');
        // The refusal never reached the browser: no fourth operation evidence.
        assert(n2Ops.every(item =>
          item.operation && ['navigate', 'observe', 'press'].includes(item.operation.operation)),
          'R2-N2: no browser operation beyond the run-level budget appears in the evidence');
        // The runtime-budget controller is the authority producing exhaustion.
        assert(n2Run.snapshot.failure && n2Run.snapshot.failure.code === 'RUN_BUDGET_EXHAUSTED' &&
          n2Run.snapshot.failure.kind === 'runtime_budget_exhausted' &&
          n2Run.snapshot.failure.detail && n2Run.snapshot.failure.detail.dimension === 'browser_operation' &&
          n2Run.snapshot.failure.detail.limit === 3,
          `R2-N2: the run failure names the browser_operation dimension (${JSON.stringify(n2Run.snapshot.failure)})`);
        const n2ExhaustedEvent = (await store.listRunEvents(n2Run.run.id, { afterSeq: -1, limit: 500 }))
          .find(event => event.type === 'budget.exhausted');
        assert(n2ExhaustedEvent && n2ExhaustedEvent.payload &&
          n2ExhaustedEvent.payload.dimension === 'browser_operation' &&
          n2ExhaustedEvent.payload.limit === 3,
          'R2-N2: a durable budget.exhausted event names the browser_operation dimension');
        // Neither target budget was the earlier limiting dimension.
        assert(n2Run.receipts.every(receipt => receipt.outcome === 'succeeded'),
          'R2-N2: no target-level interaction or action refusal occurred');
        assert(n2Ops.every(item => item.errorCode !== 'BROWSER_INTERACTION_LIMIT_EXCEEDED' &&
          item.errorCode !== 'BROWSER_ACTION_LIMIT_EXCEEDED'),
          'R2-N2: the target interaction and action budgets were not exhausted');
        // The run-level budget exhausted first, truthfully.
        assert(n2Run.run.status === 'failed',
          `R2-N2: the budget exhaustion terminalizes the run (${n2Run.run.status})`);
      }

      // ── R2-Q: Phase-3 exclusion (deterministic) ─────────────────────────────
      scenariosRun += 1;
      const phase3TargetFields = {
        id: `bi-phase3-${STAMP}`,
        name: 'Phase-3 probe',
        status: 'active',
        allowedOrigins: fixtures.fixtureOrigin,
        startUrl: `${fixtures.fixtureOrigin}/`,
        maxNavigationsPerRun: '4', maxActionsPerRun: '10', maxInteractionsPerRun: '2',
        navTimeoutMs: '5000', waitTimeoutMsCap: '1000', maxPageTextBytes: '65536', maxScreenshotsPerRun: '2'
      };
      for (const field of ['credentialRef', 'sessionMode', 'maxDownloadBytes']) {
        const attempt = await server.request('POST', '/admin/browser-targets', {
          cookie,
          form: { ...phase3TargetFields, [field]: field === 'sessionMode' ? 'persistent' : 'probe' }
        });
        assert(attempt.statusCode === 400 && String(attempt.body).includes(field),
          `R2-Q: the Phase-3 field ${field} remains forbidden in target configuration`);
      }
      const phase3Target = (await store.listBrowserTargets({ limit: 50 })).targets
        .find(candidate => candidate.id === `bi-phase3-${STAMP}`);
      assert(!phase3Target, 'R2-Q: the refused Phase-3 target persists nothing');
      const phase3TicketResponse = await server.request('POST', '/tickets', {
        cookie,
        form: {
          objective: `${MARKER('BIPHASE3')} phase-3 ticket ${interactionTarget.id}`,
          assignmentTargetType: 'agent',
          assignmentTargetId: String(agent.id),
          assignmentMode: 'individual',
          executionTargetKind: 'browser',
          browserTargetId: interactionTarget.id,
          executionPolicy: JSON.stringify({ allowBrowserInteractions: true, allowBrowserDownloads: true })
        }
      });
      assert(phase3TicketResponse.statusCode === 302,
        'R2-Q: the ticket itself is accepted, with unknown authority keys normalized away');
      const phase3TicketRecord = (await store.listTickets({ limit: 300 })).tickets
        .find(candidate => candidate.objective === `${MARKER('BIPHASE3')} phase-3 ticket ${interactionTarget.id}`);
      assert(phase3TicketRecord &&
        phase3TicketRecord.executionPolicy &&
        phase3TicketRecord.executionPolicy.allowBrowserInteractions === true &&
        !Object.prototype.hasOwnProperty.call(phase3TicketRecord.executionPolicy, 'allowBrowserDownloads'),
        'R2-Q: allowBrowserDownloads never enters the persisted execution policy');
      if (positiveRun) {
        assert(positiveRun.snapshot.browserTargetSnapshot &&
          !Object.prototype.hasOwnProperty.call(positiveRun.snapshot.browserTargetSnapshot, 'credentialRef') &&
          !Object.prototype.hasOwnProperty.call(positiveRun.snapshot.browserTargetSnapshot, 'sessionMode'),
          'R2-Q: the admitted target snapshot carries no Phase-3 authority fields');
        assert(positiveRun.snapshot.primitiveContract &&
          !positiveRun.snapshot.primitiveContract.allowedOperations.includes('downloadArtifact'),
          'R2-Q: the admitted primitive contract never includes Phase-3 operations');
      }

      // ── R2-R: admitted-Run authority immutability ───────────────────────────
      const gateMarker = GATE_MARKER;
      const immutableObjective = `${gateMarker} authority immutability ${interactionTarget.id}`;
      let immutableResult = null;
      let immutableTicket = null;
      let immutableRunId = null;
      let immutableRunBefore = null;
      if (!ENGINE_LIVE) {
        scenariosRun += 1;
        liveScenariosSkipped += 1;
        console.log(`SKIP R2-R authority immutability: no executable browser engine at BROWSER_ENGINE_EXECUTABLE=${ENGINE_EXECUTABLE}`);
      } else {
        liveScenariosRun += 1;
        scenariosRun += 1;
        const immutableRunPromise = createInteractionTicket(immutableObjective, interactionTarget,
          { allowBrowserInteractions: true });
        immutableTicket = await waitFor(async () => {
          const found = (await store.listTickets({ limit: 300 })).tickets
            .find(candidate => candidate.objective === immutableObjective);
          return found || null;
        }, 30000, 'the immutability ticket');
        const immutableRuns = await waitFor(async () => {
          const found = ((await store.listRuns({ limit: 300 })).runs || [])
            .filter(candidate => candidate.ticketId === immutableTicket.id);
          return found.length > 0 ? found : null;
        }, 30000, 'the immutability run');
        immutableRunId = immutableRuns[0].id;
        immutableRunBefore = await store.getRun(immutableRunId);
        assert(immutableRunBefore.executionPolicySnapshot &&
          immutableRunBefore.executionPolicySnapshot.allowBrowserInteractions === true,
          'R2-R: the admitted run carries the interaction authorization in its snapshot');

        // Park at the gate, mutate the living authority surfaces, release. The
        // admitted Run's own snapshot is the only authority it can ever use.
        await waitFor(() => fs.existsSync(path.join(GATE_DIR, `${gateMarker}.atgate`)), 120000,
          'the immutability run to reach its gate');
        // (1) Revoke the operator's browser:interact permission group.
        const adminAfterGate = await store.getUserById(adminId);
        await store.updateUser({
          userId: adminId,
          expectedRevision: adminAfterGate.revision,
          value: { username: adminAfterGate.username, passwordHash: adminAfterGate.passwordHash },
          groupIds: (adminAfterGate.groupIds || []).filter(groupId => groupId !== interactGroup.id),
          changedBy: 'browser-interaction-authority-test'
        });
        // (2) Pause the browser target.
        await store.updateBrowserTarget({
          targetId: interactionTarget.id,
          expectedRevision: interactionTarget.revision,
          target: { ...interactionTarget, status: 'inactive' },
          changedBy: 'browser-interaction-authority-test'
        });
        // Forward proof that the revocation is live: a NEW interaction ticket is
        // now refused at the surface while the parked run keeps its admitted one.
        const revokedAttempt = await server.request('POST', '/tickets', {
          cookie,
          form: {
            objective: `${MARKER('BIREVOKED')} post-revocation ${interactionTarget.id}`,
            assignmentTargetType: 'agent',
            assignmentTargetId: String(agent.id),
            assignmentMode: 'individual',
            executionTargetKind: 'browser',
            browserTargetId: interactionTarget.id,
            allowBrowserInteractions: 'on'
          }
        });
        assert(revokedAttempt.statusCode === 400 &&
          String(revokedAttempt.body).includes('browser:interact'),
          'R2-R: after revocation a NEW interaction ticket is refused at the surface');
        fs.writeFileSync(path.join(GATE_DIR, `${gateMarker}.go`), 'go');

        immutableResult = await immutableRunPromise;
        const immutableRunAfter = await store.getRun(immutableRunId);
        assert(JSON.stringify(immutableRunAfter.executionPolicySnapshot) ===
          JSON.stringify(immutableRunBefore.executionPolicySnapshot),
          'R2-R: the admitted executionPolicySnapshot cannot drift after admission');
        const immutableRun = immutableResult.run;
        assert(immutableRun.status === 'completed',
          `R2-R: the parked run completes after release (${immutableRun.status})`);
        const immutableOps = immutableResult.snapshot.browserOperations;
        assert(immutableOps.some(item =>
          item.operation && item.operation.operation === 'fill' && item.status === 'ok'),
          'R2-R: the pre-gate fill under the admitted authority succeeded');
        const immutableClick = immutableOps.filter(item =>
          item.operation && item.operation.operation === 'click')[0];
        assert(immutableClick && immutableClick.status === 'ok',
          `R2-R: the post-mutation click still runs under the admitted authority (${immutableClick && immutableClick.status})`);
      }
      assert(fixtures.decoyHits.length === 0,
        'R2-R: no request ever reached the decoy origin across the whole barrier');

      // ── R2-O: recovery/replay of the SAME committed interaction identity ────
      // The click commits a real form submission; the hold parks the run at the
      // next turn with the interaction already committed; the suite SIGKILLs
      // its server; a fresh server's canonical recovery sweep reclaims the run
      // after lease expiry, reconciles the prepared intent, resumes it, and the
      // resumed run re-enters the SAME committed operation identity — which
      // must skip without a second submission, second receipt, or second event.
      // The scenario runs last, on its own short-lease server pair, so the
      // crashed run's lease expires inside this scenario's own time budget.
      scenariosRun += 1;
      if (!ENGINE_LIVE) {
        liveScenariosSkipped += 1;
        console.log(`SKIP R2-O committed-interaction recovery: no executable browser engine at BROWSER_ENGINE_EXECUTABLE=${ENGINE_EXECUTABLE}`);
      } else {
        liveScenariosRun += 1;
        // The recovery run needs the interaction authority and an active target
        // again; the R2-R scenario deliberately revoked/paused both to prove
        // admitted-Run immutability. Authorization is resolved per request from
        // the live catalog, so the re-grant applies to the next request.
        const adminAfterR2R = await store.getUserById(adminId);
        await store.updateUser({
          userId: adminId,
          expectedRevision: adminAfterR2R.revision,
          value: { username: adminAfterR2R.username, passwordHash: adminAfterR2R.passwordHash },
          groupIds: [...(adminAfterR2R.groupIds || []), interactGroup.id],
          changedBy: 'browser-interaction-authority-test'
        });
        const activeInteractionTarget = await store.getBrowserTarget(interactionTarget.id);
        await store.updateBrowserTarget({
          targetId: interactionTarget.id,
          expectedRevision: activeInteractionTarget.revision,
          target: { ...activeInteractionTarget, status: 'active' },
          changedBy: 'browser-interaction-authority-test'
        });
        const recoveryMarker = MARKER('BIRECOVERY');
        const holdFile = path.join(GATE_DIR, 'recovery-hold');
        fs.writeFileSync(holdFile, 'hold');
        // The side-effect counter is suite-global (earlier scenarios may also
        // legitimately submit the fixture form); this scenario proves its own
        // delta.
        const submittedHitsBeforeRecovery = fixtures.submittedHits.length;

        // Dedicated short-lease server for the pre-crash execution: the
        // canonical lease-expiry recovery sweep must be able to reclaim the
        // crashed run inside this scenario's own time budget.
        await server.stop();
        const preCrashServer = await startServer({ env: {
          NODE_OPTIONS: `--require ${preloadPath}`,
          RUNTIME_SCHEDULER_INTERVAL_MS: '200',
          RUN_LEASE_DURATION_MS: '5000',
          BROWSER_ENGINE_EXECUTABLE: ENGINE_EXECUTABLE
        } });
        const preCrashCookie = await preCrashServer.login();
        const recoveryObjective = `${recoveryMarker} committed-interaction recovery ${interactionTarget.id}`;
        const recoveryResponse = await preCrashServer.request('POST', '/tickets', {
          cookie: preCrashCookie,
          form: {
            objective: recoveryObjective,
            assignmentTargetType: 'agent',
            assignmentTargetId: String(agent.id),
            assignmentMode: 'individual',
            executionTargetKind: 'browser',
            browserTargetId: interactionTarget.id,
            executionPolicy: JSON.stringify({
              allowBrowserInteractions: true, maxExecutionSteps: 16, maxModelRequests: 16, maxRuntimeMs: 900000
            })
          }
        });
        assert(recoveryResponse.statusCode === 302,
          `R2-O: the recovery ticket is accepted (${recoveryResponse.statusCode})`);
        const recoveryTicket = await waitFor(async () => {
          const found = (await store.listTickets({ limit: 300 })).tickets
            .find(candidate => candidate.objective === recoveryObjective);
          return found || null;
        }, 30000, 'the recovery ticket');
        const recoveryRunRow = await waitFor(async () => {
          const found = ((await store.listRuns({ limit: 300 })).runs || [])
            .find(candidate => candidate.ticketId === recoveryTicket.id);
          return found || null;
        }, 30000, 'the recovery run');
        // Parked after the click committed: the durable receipt exists and the
        // fixture counted exactly one submission.
        await waitFor(() => fs.existsSync(path.join(GATE_DIR, `${recoveryMarker}.atgate`)), 120000,
          'the recovery run to park after its committed interaction');
        const committedReceipts = await store.listOperationReceipts(recoveryRunRow.id, { limit: 300 });
        const committedClickReceipts = committedReceipts.filter(receipt => receipt.operation === 'click');
        assert(committedClickReceipts.length === 1 && committedClickReceipts[0].outcome === 'succeeded',
          `R2-O: the first execution commits exactly one successful click receipt (${committedClickReceipts.length})`);
        const committedOperationIdentity = committedClickReceipts[0].idempotencyKey;
        assert(typeof committedOperationIdentity === 'string' &&
          committedOperationIdentity.startsWith(`run:${recoveryRunRow.id}:slot:`),
          `R2-O: the committed interaction has the stable action-slot operation identity (${committedOperationIdentity})`);
        const committedSnapshot = (await store.getReplaySnapshot(recoveryRunRow.id)).snapshot;
        const committedClickItems = (committedSnapshot.browserOperations || [])
          .filter(item => item.operation && item.operation.operation === 'click');
        assert(committedClickItems.length === 1,
          `R2-O: the first execution records exactly one click replay item (${committedClickItems.length})`);
        assert(fixtures.submittedHits.length - submittedHitsBeforeRecovery === 1,
          `R2-O: the external side effect occurred exactly once (${fixtures.submittedHits.length - submittedHitsBeforeRecovery})`);
        const preparedIntentState = await store.getTargetOperation(recoveryRunRow.id, committedOperationIdentity);
        assert(preparedIntentState.intent && preparedIntentState.intent.operation === 'click',
          'R2-O: the interaction prepared its canonical intent before the effect');
        assert(preparedIntentState.receipt && preparedIntentState.receipt.outcome === 'succeeded',
          'R2-O: the committed receipt and the prepared intent share one operation identity');

        // Canonical crash: SIGKILL the server with the interaction committed.
        preCrashServer.child.kill('SIGKILL');
        await preCrashServer.stop();
        // The resumed stub must not park again.
        fs.rmSync(holdFile, { force: true });

        const recoveryServer = await startServer({ env: {
          NODE_OPTIONS: `--require ${preloadPath}`,
          RUNTIME_SCHEDULER_INTERVAL_MS: '200',
          RUN_LEASE_DURATION_MS: '5000',
          BROWSER_ENGINE_EXECUTABLE: ENGINE_EXECUTABLE
        } });
        const recoveredRun = await waitFor(async () => {
          const found = await store.getRun(recoveryRunRow.id);
          return found && ['completed', 'failed', 'interrupted'].includes(found.status) ? found : null;
        }, 300000, 'the recovered run to terminalize');
        assert(recoveredRun.status === 'completed',
          `R2-O: the recovered run completes through the canonical recovery sweep (${recoveredRun.status})`);
        // The canonical recovery seam ran: the lease-expiry sweep claimed the
        // crashed run and the scheduler re-dispatched it.
        const recoveryEvents = await store.listRunEvents(recoveryRunRow.id, { afterSeq: -1, limit: 500 });
        assert(recoveryEventsIncludeResume(recoveryEvents),
          'R2-O: the canonical recovery/resume path re-entered the run (lease-expiry claim/resume evidence)');
        const recoveredSnapshot = (await store.getReplaySnapshot(recoveryRunRow.id)).snapshot;
        // 6/7/8: no second effect, no second receipt, evidence unchanged.
        const recoveredClickItems = (recoveredSnapshot.browserOperations || [])
          .filter(item => item.operation && item.operation.operation === 'click');
        assert(recoveredClickItems.length === 1,
          `R2-O: the replay did not append a second click replay item (${recoveredClickItems.length})`);
        const recoveredReceipts = await store.listOperationReceipts(recoveryRunRow.id, { limit: 300 });
        const recoveredClickReceipts = recoveredReceipts.filter(receipt => receipt.operation === 'click');
        assert(recoveredClickReceipts.length === 1 &&
          recoveredClickReceipts[0].idempotencyKey === committedOperationIdentity,
          `R2-O: the SAME committed operation identity holds exactly one receipt (${recoveredClickReceipts.length})`);
        assert(fixtures.submittedHits.length - submittedHitsBeforeRecovery === 1,
          `R2-O: the recovery/replay did not repeat the browser side effect (${fixtures.submittedHits.length - submittedHitsBeforeRecovery})`);
        // Canonical evidence still truthfully represents the committed interaction.
        assert(recoveredClickItems[0].receipt && recoveredClickItems[0].receipt.metadata &&
          recoveredClickItems[0].receipt.metadata.postPageStateHash,
          'R2-O: the committed interaction evidence remains the truthful durable record');
      }

      const report = assertScenariosExecuted({
        label: 'browser interaction authority',
        assertions: assert.count(),
        scenarios: scenariosRun,
        minAssertions: 18,
        minScenarios: 13
      });
      console.log(`PASS: browser interaction authority — ${report.assertions} assertions, ` +
        `${report.scenarios} scenarios (${liveScenariosRun} live-engine, ${liveScenariosSkipped} skipped)`);
    });
  } finally {
    await fixtures.close();
    if (preloadPath) {
      try { fs.rmSync(preloadPath, { force: true }); } catch (_) { /* best effort */ }
    }
    try { fs.rmSync(WORK_DIR, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error('FAIL: browser interaction authority');
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
