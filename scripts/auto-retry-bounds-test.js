#!/usr/bin/env node
'use strict';
// Bounded automatic retry — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20 / A25 / A26).
//
// Behavioral replacement for the eligibility and bounding half of the JSON-era
// `auto-retry-test.js`. That orphan is NOT retired by this file — see the end of this
// header for the one property that still has no destination.
//
// THE CONTRACT: automatic retry is default-off, policy-gated, bounded, and allowed for
// exactly one failure classification. A retry the operator did not ask for, or one that
// keeps going, is a machine repeating failing work on its own; a retry that never
// happens when the policy asks for it is a feature that lies about being enabled.
//
// ── THE FIXTURE PROBLEM, AND WHY SCENARIO 1 EXISTS ──────────────────────────────────
//
// Eligibility requires a PROSPECTIVE triage reason of exactly `runtime_failed`. That is
// the FALLBACK code in `buildRunTriage`, assigned only when no structured failure kind
// matched — so most convenient ways to fail a run produce something else:
//
//     traversal / protected path  → protected_path      → authority_blocked
//     provider fault              → provider_error      → provider_failed
//     malformed model output      → MODEL_..._VIOLATION → model_contract_failed
//
// A suite that drove auto-retry with any of those would be exercising the INELIGIBLE
// branch while appearing to cover the eligible one, and would pass just as well against
// a runtime where retry never fires at all.
//
// The producer used here is a RUNTIME LIMIT. `createRunLimitError` sets
// `code: 'RUN_LIMIT_EXCEEDED'` and NO `failureKind`, so it matches none of the
// structured branches and falls through to `runtime_failed`, with no workspace mutation.
// Scenario 1 asserts that classification on a control ticket with auto-retry OFF, before
// any eligible-path claim is made. If the fixture ever stops producing `runtime_failed`,
// this suite fails there rather than quietly proving nothing.
//
// ── WHAT THIS SUITE FOUND ───────────────────────────────────────────────────────────
//
// A25: bounded automatic retry had NEVER worked. `runAutoRetryAfterFailureIfPolicyAllows`
// passed a second argument to `createRetryRun` built from an `options` identifier that
// does not exist in its scope, so every eligible retry threw ReferenceError, was
// swallowed by the surrounding catch, and was reported as `retry_creation_failed`. The
// run then fell through to triage exactly as an ineligible one would, so nothing looked
// wrong. Fixed alongside this suite.
//
// A26 (OPEN): the `mutationCount === 0` half of eligibility is inert, so a run that
// already mutated the workspace IS retried. That is the reason the historical suite
// stays orphaned rather than retired — see the register entry.
//
// NO VACUOUS EXIT. No skip path, no NOT_PROVEN, every wait throws on timeout, and the
// floor requires each ticket to have produced runs before any count is trusted:
// "exactly one run" is trivially satisfiable by a runtime that creates none.
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

// `limit` stalls until a runtime limit fires: no failure kind, no mutation.
// `escape` fails on policy, which classifies as authority_blocked.
const CASES = Object.freeze([
  {
    key: 'control', kind: 'limit', expectRuns: 1,
    policy: { autoRetry: false, maxAttempts: 2 },
    why: 'auto-retry off by default'
  },
  {
    key: 'noceiling', kind: 'limit', expectRuns: 1,
    policy: { autoRetry: true, maxAttempts: null },
    why: 'no finite ceiling to bound the retry'
  },
  {
    key: 'eligible', kind: 'limit', expectRuns: 2,
    policy: { autoRetry: true, maxAttempts: 2 },
    why: 'policy on, finite ceiling, retryable classification'
  },
  {
    key: 'authority', kind: 'escape', expectRuns: 1,
    policy: { autoRetry: true, maxAttempts: 2 },
    why: 'a policy refusal is not a runtime failure'
  }
]);

const marker = key => `AUTORETRY${key.toUpperCase()}${STAMP}`;
const byKey = key => CASES.find(item => item.key === key);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function createPreload() {
  const preloadPath = path.join(os.tmpdir(), `auto-retry-preload-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
const CASES = ${JSON.stringify(CASES.map(item => ({ key: item.key, kind: item.kind, marker: marker(item.key) })))};
function ok(plan) {
  return {
    ok: true, status: 200,
    headers: new Map([['x-request-id', 'auto-retry-bounds']]),
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
  const scenario = CASES.find(candidate => raw.includes(candidate.marker));
  if (!scenario) return ok({ message: 'unrelated', actions: [], complete: true });
  if (scenario.kind === 'escape') {
    return ok({ message: 'Reading above the root.',
      actions: [{ operation: 'readFile', args: { path: '../outside.txt' } }], complete: false });
  }
  // Never acts, never completes: the run exhausts a runtime limit with no failure kind
  // and no workspace mutation, which is the only shape auto-retry accepts.
  return ok({ message: 'Still thinking.', actions: [], complete: false });
};
`);
  return preloadPath;
}

async function main() {
  const preloadPath = createPreload();
  try {
    await withHarness('auto retry bounds', async ({ store, startServer }) => {
      const agent = (await store.createConfiguredAgent({
        value: { name: `AutoRetry-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'k' },
        groupIds: [], changedBy: 'auto-retry-bounds-test'
      })).agent;

      const serverEnv = {
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '600000',
        // Small, so the stall reaches a runtime limit quickly. The limit is what
        // produces the fallback classification; its size is not the contract.
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '2',
        AGENT_MAX_EXECUTION_STEPS: '2'
      };
      const server = await startServer(serverEnv);
      const cookie = await server.login();

      for (const scenario of CASES) {
        scenario.objective = `${marker(scenario.key)} exercise the ${scenario.key} retry path`;
        const response = await server.request('POST', '/tickets', {
          cookie,
          form: {
            objective: scenario.objective,
            assignmentTargetType: 'agent',
            assignmentTargetId: String(agent.id),
            assignmentMode: 'individual',
            executionPolicy: JSON.stringify(scenario.policy)
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

      const runsFor = async ticketId => {
        const runs = (await store.listRuns({ limit: 300 })).runs || [];
        return runs.filter(run => run.ticketId === ticketId).sort((a, b) => a.id - b.id);
      };

      // Wait for QUIESCENCE, not for the expected counts. Waiting on the count made
      // every count regression surface as "timed out waiting for the expected run
      // count" — true, and a description of the wait rather than of the defect. A
      // retry is created during its predecessor's terminalization, so "every run
      // terminal" plus a settle window is the honest quiescence condition, and the
      // counts are then asserted where they are the property under test.
      await waitFor(async () => {
        for (const scenario of CASES) {
          const runs = await runsFor(scenario.ticketId);
          if (runs.length === 0) return false;
          if (!runs.every(run => ['completed', 'failed', 'interrupted'].includes(run.status))) return false;
        }
        return true;
      }, 240000, 'every ticket to reach a quiet terminal state');
      await sleep(6000);

      // ── 0. FLOOR — work actually happened ────────────────────────────────────
      scenariosRun += 1;
      for (const scenario of CASES) {
        const runs = await runsFor(scenario.ticketId);
        assert(runs.length >= 1, `0: ${scenario.key} produced at least one run (${runs.length})`);
        assert(runs.every(run => run.status === 'failed'),
          `0: ${scenario.key} runs all failed, so retry eligibility was actually reached (${runs.map(r => r.status).join(',')})`);
      }

      // ── 1. THE FIXTURE IS TRUTHFUL ───────────────────────────────────────────
      // Asserted on the auto-retry-OFF control, so it describes the failure itself
      // rather than anything the retry path did. Every eligible-path claim below
      // depends on this being the retryable classification.
      scenariosRun += 1;
      // Read the classification from the run that actually STOPPED — the last one on
      // the ticket. A retried run deliberately carries no triage, so indexing the
      // first run would report "classification is null" whenever a count regression
      // caused an unexpected retry: true, but a description of the retry rather than
      // of the classification this scenario exists to pin.
      const lastRun = async key => {
        const runs = await runsFor(byKey(key).ticketId);
        return runs[runs.length - 1];
      };
      const control = await lastRun('control');
      assert(control.triage && control.triage.reasonCode === 'runtime_failed',
        `1: the stalled run classifies as runtime_failed, the only retryable reason (${control.triage && control.triage.reasonCode})`);
      assert(/limit|stalled/i.test(String(control.error || '')),
        `1: and it failed on a runtime limit rather than a structured fault (${control.error})`);
      const authority = await lastRun('authority');
      assert(authority.triage && authority.triage.reasonCode === 'authority_blocked',
        `1: the policy refusal classifies differently, so the two are distinguishable (${authority.triage && authority.triage.reasonCode})`);

      // ── 2. DEFAULT OFF ───────────────────────────────────────────────────────
      scenariosRun += 1;
      const controlRuns = await runsFor(byKey('control').ticketId);
      assert(controlRuns.length === 1,
        `2: with auto-retry off, a retryable failure is not retried (${controlRuns.length} runs)`);
      assert(controlRuns[0].triage && controlRuns[0].triage.required === true,
        '2: it stops into triage instead, leaving the decision to a human');

      // ── 3. A CEILING IS REQUIRED ─────────────────────────────────────────────
      // autoRetry alone is not enough: without a finite maxAttempts there is nothing
      // to bound the retries, so the runtime refuses rather than retrying forever.
      scenariosRun += 1;
      const noCeilingRuns = await runsFor(byKey('noceiling').ticketId);
      assert(noCeilingRuns.length === 1,
        `3: auto-retry without a finite ceiling does not retry (${noCeilingRuns.length} runs)`);
      assert(noCeilingRuns[0].triage && noCeilingRuns[0].triage.required === true,
        '3: and stops into triage');

      // ── 4. ELIGIBLE — EXACTLY ONE RETRY, THEN STOP ───────────────────────────
      // The positive control for everything above, and the bound in the same breath:
      // the ceiling is 2, so there is room for one retry and no more.
      scenariosRun += 1;
      const eligibleRuns = await runsFor(byKey('eligible').ticketId);
      assert(eligibleRuns.length === 2,
        `4: an eligible failure is retried exactly once under a ceiling of 2 (${eligibleRuns.length} runs)`);
      const [first, retry] = eligibleRuns;
      assert(retry.delegatedPermissionSource === 'auto_retry',
        `4: the retry records that the runtime created it, not an operator (${retry.delegatedPermissionSource})`);
      assert(first.delegatedPermissionSource !== 'auto_retry',
        `4: and the original does not claim the same provenance (${first.delegatedPermissionSource})`);
      assert(retry.executionPolicySnapshot && retry.executionPolicySnapshot.autoRetry === true,
        '4: the retry carries the policy it was created under');
      assert(!first.triage,
        '4: the retried run does not also raise triage — a retry and a human handoff are alternatives, not both');
      assert(retry.triage && retry.triage.required === true,
        '4: and the run that exhausted the ceiling does stop into triage');
      assert(retry.triage.reasonCode === 'runtime_failed',
        `4: recording why it stopped (${retry.triage.reasonCode})`);

      // ── 5. CLASSIFICATION GATES THE RETRY ────────────────────────────────────
      // The control the whole fixture problem is about: same policy, same ceiling,
      // different failure classification — and no retry.
      scenariosRun += 1;
      const authorityRuns = await runsFor(byKey('authority').ticketId);
      assert(authorityRuns.length === 1,
        `5: a policy refusal is never auto-retried, under the same policy that did retry (${authorityRuns.length} runs)`);
      assert(authorityRuns[0].triage && authorityRuns[0].triage.required === true,
        '5: it stops into triage for a human instead');
      assert(byKey('authority').policy.autoRetry === byKey('eligible').policy.autoRetry &&
             byKey('authority').policy.maxAttempts === byKey('eligible').policy.maxAttempts,
        '5: and the two tickets really did carry identical retry policy, so classification is the only difference');

      // ── 6. RESTART DOES NOT RETRY SETTLED FAILURES ───────────────────────────
      // Auto-retry belongs to the failure path, not to startup convergence. A runtime
      // that retried on boot would multiply every historical failure on every deploy.
      scenariosRun += 1;
      const before = new Map();
      for (const scenario of CASES) before.set(scenario.key, (await runsFor(scenario.ticketId)).length);
      await server.stop();
      const restarted = await startServer(serverEnv);
      await restarted.login();
      await sleep(6000);
      for (const scenario of CASES) {
        const after = (await runsFor(scenario.ticketId)).length;
        assert(after === before.get(scenario.key),
          `6: ${scenario.key} gained no run across a restart (${before.get(scenario.key)} → ${after})`);
      }

      assertScenariosExecuted({
        label: 'auto retry bounds',
        assertions: assert.count(),
        scenarios: scenariosRun,
        minAssertions: 25,
        minScenarios: 7
      });
      console.log(`\nPASS: auto retry bounds — ${scenariosRun} scenarios, ${assert.count()} assertions (PostgreSQL-native)`);
    }, { schemaSlug: 'auto_retry' });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(`\nFAIL: auto retry bounds — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
