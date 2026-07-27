#!/usr/bin/env node
'use strict';
// Provider-input privacy boundary — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A24).
//
// THE CONTRACT: what leaves this machine carries workspace-RELATIVE paths. What stays
// on it keeps the host truth.
//
// A run's model requests go to an external provider. Everything in them is disclosed:
// prompt fields, carried evidence, error text. The workspace root is a host filesystem
// location — under a developer's home directory, a deployment path, or a temporary
// directory — and the model needs none of it. It needs to know WHICH relative path it
// asked for, WHAT went wrong as a stable code, and HOW that is classified, so it can
// correct itself on the next turn.
//
// WHAT WAS ACTUALLY WRONG, MEASURED RATHER THAN ASSUMED. The defect was reported as
// "recoverable filesystem errors carry the raw Node message". That is true and it is
// the narrow case. A probe of real provider requests found the absolute root in FOUR
// fields on EVERY request, before any error occurred:
//
//     runtimeEnvelope.workspaceRoot
//     runtimeEnvelope.mainWorkspaceRoot
//     initialWorkspaceSnapshot.targetScope.root
//     currentWorkspaceSnapshot.targetScope.root
//
// plus previousActionResults[].error once a filesystem operation failed. Sanitizing the
// error message alone would have fixed one field in five and left the disclosure fully
// intact. So the redaction is applied at the SEND boundary — `redactProviderInput` in
// `callModelProviderWithRunEvidence`, the last point before the wire and the same value
// the provider-request evidence is recorded from — and scenario 2 asserts the property
// over whole captured request bodies rather than over the fields anyone remembered to
// name.
//
// MEANING IS PRESERVED, NOT TRADED AWAY. The root is replaced with a stable readable
// placeholder rather than deleted, because the prompt contract refers to
// `runtimeEnvelope.workspaceRoot` by name when telling the model never to use it in a
// path. And the carried failure now includes `errorCode` and `failureKind`, which it did
// not before: a missing file and a wrong path type must stay distinguishable however the
// message is worded, and after redaction the message is no longer the only thing
// carrying that distinction.
//
// OPERATOR DIAGNOSTICS ARE NOT TOUCHED. Scenario 7 requires the durable replay to still
// hold the raw message including the real absolute path. That evidence is local, behind
// the operator's session, and it is what someone diagnosing a path fault needs. A fix
// that quietly blinded the operator too would be a different defect, not a smaller one.
//
// NO VACUOUS EXIT. No skip path, no NOT_PROVEN, every wait throws on timeout, and the
// floor requires the conversation to have happened before any absence is trusted —
// "the root does not appear" is trivially true of a request that was never sent.
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

const CAPTURE = path.join(os.tmpdir(), `provider-privacy-capture-${process.pid}-${STAMP}.jsonl`);
const ROOT_TOKEN = '<workspace-root>';

const SEED_DIR = 'seeded-folder';
const MISSING_PATH = `absent-${STAMP}.txt`;
const RECOVERY_PATH = `recovered-${STAMP}.txt`;
const OUTSIDE_NAME = `outside-secret-${STAMP}.txt`;

const CASES = Object.freeze([
  {
    key: 'missing', turns: 2, terminal: false,
    objective: `PRIVMISSING${STAMP} read a file that is not there, then recover`,
    attempt: { operation: 'readFile', args: { path: MISSING_PATH } },
    expectCode: 'WORKSPACE_FS_ENOENT',
    expectKind: 'workspace_error'
  },
  {
    key: 'typeconflict', turns: 2, terminal: false,
    objective: `PRIVTYPE${STAMP} read a directory as a file, then recover`,
    attempt: { operation: 'readFile', args: { path: SEED_DIR } },
    expectCode: 'WORKSPACE_PATH_TYPE_CONFLICT',
    expectKind: 'workspace_error'
  },
  {
    key: 'escape', turns: 1, terminal: true,
    objective: `PRIVESCAPE${STAMP} read a file above the workspace root`,
    attempt: { operation: 'readFile', args: { path: `../${OUTSIDE_NAME}` } },
    expectCode: 'WORKSPACE_PATH_TRAVERSAL',
    expectKind: 'protected_path'
  }
]);

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

function createPreload() {
  const preloadPath = path.join(os.tmpdir(), `provider-privacy-preload-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
const fs = require('fs');
const CAPTURE = ${JSON.stringify(CAPTURE)};
const CASES = ${JSON.stringify(CASES.map(item => ({
    key: item.key, objective: item.objective, attempt: item.attempt
  })))};
const RECOVERY_PATH = ${JSON.stringify(RECOVERY_PATH)};

function ok(plan) {
  return {
    ok: true, status: 200,
    headers: new Map([['x-request-id', 'provider-input-privacy']]),
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
  // The WHOLE request body is captured. The disclosure assertion is made over this,
  // not over the fields the suite author thought to inspect.
  fs.appendFileSync(CAPTURE, JSON.stringify({ raw }) + '\\n');

  let body = {};
  try { body = JSON.parse(raw); } catch (_) {}
  let context = null;
  for (const item of (body.input || [])) {
    if (!item || typeof item.content !== 'string') continue;
    try {
      const parsed = JSON.parse(item.content);
      if (parsed && typeof parsed === 'object' && parsed.ticketObjective !== undefined) context = parsed;
    } catch (_) { /* system prose */ }
  }
  const objective = context ? String(context.ticketObjective || '') : '';
  const prior = context && Array.isArray(context.previousActionResults) ? context.previousActionResults : [];

  const scenario = CASES.find(candidate => objective === candidate.objective);
  if (!scenario) return ok({ message: 'unrelated', actions: [], complete: true });

  if (prior.length === 0) {
    return ok({ message: 'Attempting the read.', actions: [scenario.attempt], complete: false });
  }
  // Recovery is emitted only when the carried evidence names the operation that
  // failed, so "the model can still recover" cannot pass on a runtime that reports
  // nothing usable.
  const reported = prior.find(entry =>
    entry && entry.action && entry.action.operation === scenario.attempt.operation);
  if (!reported) return ok({ message: 'nothing usable', actions: [], complete: false });
  return ok({
    message: 'Correcting.',
    actions: [{ operation: 'writeFile', args: { path: scenario.key + '-' + RECOVERY_PATH, content: 'recovered' } }],
    complete: true
  });
};
`);
  return preloadPath;
}

async function main() {
  const preloadPath = createPreload();
  fs.writeFileSync(CAPTURE, '');
  try {
    await withHarness('provider input privacy', async ({ store, workspaceRoot, startServer }) => {
      const agent = (await store.createConfiguredAgent({
        value: { name: `ProviderPrivacy-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'k' },
        groupIds: [], changedBy: 'provider-input-privacy-test'
      })).agent;

      fs.mkdirSync(path.join(workspaceRoot, SEED_DIR), { recursive: true });

      // A real file immediately outside the workspace, at a path nothing may echo.
      const outsideAbsolute = path.join(path.dirname(workspaceRoot), OUTSIDE_NAME);
      fs.writeFileSync(outsideAbsolute, `outside-content-${STAMP}`);

      const server = await startServer({
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '600000'
      });
      const cookie = await server.login();

      try {
        for (const scenario of CASES) {
          const response = await server.request('POST', '/tickets', {
            cookie,
            form: {
              objective: scenario.objective,
              assignmentTargetType: 'agent',
              assignmentTargetId: String(agent.id),
              assignmentMode: 'individual'
            }
          });
          if (response.statusCode !== 302) {
            throw new Error(`ticket creation for ${scenario.key} returned HTTP ${response.statusCode}`);
          }
        }

        const tickets = (await store.listTickets({ limit: 100 })).tickets || [];
        for (const scenario of CASES) {
          const ticket = tickets.find(candidate => candidate.objective === scenario.objective);
          if (!ticket) throw new Error(`ticket for ${scenario.key} was not persisted`);
          scenario.ticketId = ticket.id;
        }

        await waitFor(async () => {
          const runs = (await store.listRuns({ limit: 100 })).runs || [];
          for (const scenario of CASES) {
            const run = runs.find(candidate => candidate.ticketId === scenario.ticketId);
            if (!run || !['completed', 'failed', 'interrupted'].includes(run.status)) return false;
            scenario.runId = run.id;
          }
          return true;
        }, 180000, 'every run to reach a terminal status');

        const states = new Map();
        for (const scenario of CASES) {
          const [run, replay] = await Promise.all([
            store.getRun(scenario.runId), store.getReplaySnapshot(scenario.runId)
          ]);
          states.set(scenario.key, {
            run, replay,
            operations: (replay && replay.snapshot.workspaceOperations) || []
          });
        }

        const captured = fs.readFileSync(CAPTURE, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
        const promptContexts = [];
        for (const entry of captured) {
          let body = {};
          try { body = JSON.parse(entry.raw); } catch (_) { continue; }
          for (const item of (body.input || [])) {
            if (!item || typeof item.content !== 'string') continue;
            try {
              const parsed = JSON.parse(item.content);
              if (parsed && typeof parsed === 'object') promptContexts.push(parsed);
            } catch (_) { /* system prose */ }
          }
        }
        const contextFor = scenario => promptContexts.filter(ctx => ctx.ticketObjective === scenario.objective);

        // ── 0. FLOOR — the conversation happened ─────────────────────────────
        // Absence assertions are worthless without this: a request never sent
        // contains no workspace root either.
        scenariosRun += 1;
        assert(captured.length > 0, '0: provider requests were captured at all');
        for (const scenario of CASES) {
          const turns = contextFor(scenario);
          assert(turns.length === scenario.turns,
            `0: ${scenario.key} produced exactly ${scenario.turns} model turn(s) (${turns.length})`);
        }
        // The placeholder check belongs with "meaning preserved" (scenario 3), NOT
        // here. As a floor it fired before the disclosure assertion, so a mutation
        // restoring raw host paths failed with "the placeholder is missing" — true,
        // and a description of the repair rather than of the leak.

        // ── 1. THE RUNS STILL WORK ───────────────────────────────────────────
        // Asserted before the privacy property so a regression in redaction fails on
        // the disclosure, not on a run that never got going.
        scenariosRun += 1;
        for (const scenario of CASES.filter(item => !item.terminal)) {
          const state = states.get(scenario.key);
          assert(state.run.status === 'completed',
            `1: ${scenario.key} recovered and completed (${state.run.status}: ${state.run.error || ''})`);
          const recovery = path.join(workspaceRoot, `${scenario.key}-${RECOVERY_PATH}`);
          assert(fs.existsSync(recovery) && fs.readFileSync(recovery, 'utf8') === 'recovered',
            `1: ${scenario.key} performed its corrective write on the next turn`);
        }

        // ── 2. NO ABSOLUTE HOST LOCATION LEAVES THE MACHINE ──────────────────
        // Over whole request bodies, so a field nobody named is covered too.
        scenariosRun += 1;
        const offenders = captured.filter(entry => entry.raw.includes(workspaceRoot));
        assert(offenders.length === 0,
          `2: no provider request contains the absolute workspace root (${offenders.length}/${captured.length} did)`);
        const outsideOffenders = captured.filter(entry => entry.raw.includes(outsideAbsolute));
        assert(outsideOffenders.length === 0,
          `2: no provider request echoes the absolute path of the file outside the workspace (${outsideOffenders.length})`);
        const homeOffenders = captured.filter(entry => entry.raw.includes(os.homedir()));
        assert(homeOffenders.length === 0,
          `2: no provider request contains the host home directory (${homeOffenders.length})`);

        // ── 3. THE MODEL STILL KNOWS WHICH PATH IT ASKED FOR ─────────────────
        // Redaction that removed the path along with the prefix would be a different
        // defect: the model cannot correct a mistake it can no longer identify.
        scenariosRun += 1;
        for (const scenario of CASES.filter(item => !item.terminal)) {
          const second = contextFor(scenario)[1];
          const reported = second.previousActionResults.find(entry =>
            entry && entry.action && entry.action.operation === scenario.attempt.operation);
          assert(reported, `3: ${scenario.key} carried the failed operation forward`);
          assert(reported.action.args.path === scenario.attempt.args.path,
            `3: ${scenario.key} names the workspace-relative path it attempted (${reported.action.args.path})`);
          assert(String(reported.error).includes(scenario.attempt.args.path),
            `3: ${scenario.key} explanation still identifies that path (${reported.error})`);
          assert(!String(reported.error).includes(workspaceRoot),
            `3: ${scenario.key} explanation carries no host location (${reported.error})`);
        }
        assert(captured.some(entry => entry.raw.includes(ROOT_TOKEN)),
          '3: the root was replaced by a readable placeholder, not silently dropped');
        const envelope = promptContexts.find(ctx => ctx.runtimeEnvelope);
        assert(envelope && envelope.runtimeEnvelope.workspaceRoot === ROOT_TOKEN,
          `3: the envelope still names a workspace root, as a stable placeholder (${envelope && envelope.runtimeEnvelope.workspaceRoot})`);
        assert(envelope.runtimeEnvelope.mainWorkspaceRoot === ROOT_TOKEN,
          `3: and so does the main workspace root (${envelope.runtimeEnvelope.mainWorkspaceRoot})`);

        // ── 4. THE TWO ENVIRONMENTAL FAILURES REMAIN DISTINGUISHABLE ─────────
        // The whole point of carrying a stable code: after redaction the prose is no
        // longer the only thing telling these apart, and it must not become so.
        scenariosRun += 1;
        const codes = new Map();
        for (const scenario of CASES.filter(item => !item.terminal)) {
          const second = contextFor(scenario)[1];
          const reported = second.previousActionResults.find(entry =>
            entry && entry.action && entry.action.operation === scenario.attempt.operation);
          assert(reported.errorCode === scenario.expectCode,
            `4: ${scenario.key} carries its stable error code (${reported.errorCode})`);
          assert(reported.failureKind === scenario.expectKind,
            `4: ${scenario.key} carries its failure classification (${reported.failureKind})`);
          codes.set(scenario.key, reported.errorCode);
        }
        assert(codes.get('missing') !== codes.get('typeconflict'),
          `4: a missing file and a wrong path type are different codes (${codes.get('missing')} vs ${codes.get('typeconflict')})`);

        // ── 5. POLICY REFUSAL IS STILL TERMINAL, AND STILL ATTRIBUTED ────────
        scenariosRun += 1;
        const escape = CASES.find(item => item.key === 'escape');
        const escapeState = states.get('escape');
        assert(escapeState.run.status === 'failed',
          `5: a path escaping the workspace still fails the run (${escapeState.run.status})`);
        assert(contextFor(escape).length === 1,
          `5: and is granted no further turn (${contextFor(escape).length})`);
        const refused = escapeState.operations.filter(op =>
          op.operation && op.operation.operation === 'readFile');
        assert(refused.length === 1, `5: the refusal is recorded once (${refused.length})`);
        assert(refused[0].blocked === true,
          `5: recorded as a policy refusal, not an environmental failure (blocked=${refused[0].blocked})`);
        assert(typeof refused[0].error === 'string' && refused[0].error.length > 0,
          `5: naming the rule it violated (${refused[0].error})`);
        assert(!Object.prototype.hasOwnProperty.call(refused[0], 'result'),
          '5: and manufacturing no result for it');

        // ── 6. AN OUT-OF-WORKSPACE PATH IS NOT NORMALIZED BACK AT THE MODEL ──
        // The refused path must not be echoed as the host location it would have
        // resolved to — the one case where redaction and refusal must agree.
        scenariosRun += 1;
        const escapeTurn = contextFor(escape)[0];
        assert(JSON.stringify(escapeTurn).indexOf(outsideAbsolute) === -1,
          '6: the refused request never told the model where that path actually points');
        assert(fs.existsSync(outsideAbsolute) &&
               fs.readFileSync(outsideAbsolute, 'utf8') === `outside-content-${STAMP}`,
          '6: and the file outside the workspace was neither read away nor modified');
        assert(!captured.some(entry => entry.raw.includes(`outside-content-${STAMP}`)),
          '6: its contents never reached the provider either');

        // ── 7. OPERATOR DIAGNOSTICS ARE UNCHANGED ────────────────────────────
        // The privacy boundary is provider input, not the durable record. Someone
        // diagnosing a path fault still needs the real location.
        scenariosRun += 1;
        const missingState = states.get('missing');
        const durable = missingState.operations.find(op =>
          op.operation && op.operation.operation === 'readFile' &&
          op.operation.args && op.operation.args.path === MISSING_PATH);
        assert(durable, '7: the failed read is in the durable replay');
        assert(String(durable.error).includes(workspaceRoot),
          `7: and the durable record keeps the real host path for the operator (${durable.error})`);
        assert(!String(durable.error).includes(ROOT_TOKEN),
          '7: the durable record is not redacted, so nothing was taken from the operator');
        assert(durable.workspaceRoot === workspaceRoot,
          `7: durable evidence still states the real workspace root (${durable.workspaceRoot})`);

        assertScenariosExecuted({
          label: 'provider input privacy',
          assertions: assert.count(),
          scenarios: scenariosRun,
          minAssertions: 30,
          minScenarios: 8
        });
        console.log(`\nPASS: provider input privacy — ${scenariosRun} scenarios, ${assert.count()} assertions (PostgreSQL-native)`);
      } finally {
        try { fs.unlinkSync(path.join(path.dirname(workspaceRoot), OUTSIDE_NAME)); } catch (_) { /* best effort */ }
      }
    }, { schemaSlug: 'provider_privacy' });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
    try { fs.unlinkSync(CAPTURE); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(`\nFAIL: provider input privacy — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
