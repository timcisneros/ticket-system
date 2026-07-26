#!/usr/bin/env node
'use strict';
// Workflow prompt composition — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// Replaces `conditional-workflow-prompt-test.js`. A20's first pass recommended
// retiring that suite because it asserted `run.replaySnapshotPath`; reading the rest of
// it showed the coupling was confined to a single three-line helper while the
// properties were live and uncovered. A dead mechanism in one helper is not evidence
// that the contract is dead.
//
// THE CONTRACT: the model is told what applies to THIS run, and nothing else.
//
// No registered suite asserts prompt content at all.
// `postcondition-completion-test.js` covers draft-intent and handoff BEHAVIOR — whether
// an intent is recorded, whether a handoff is created — but asserts nothing about what
// the model was instructed to do, so it is not a successor for any of this.
//
// THE NEGATIVE CONTROLS ARE THE POINT. Guidance leaking into runs it does not apply to
// is not cosmetic: it teaches the model to emit workflow-shaped output on an ordinary
// ticket, and that output then has to be rejected somewhere downstream. The positive
// assertions alone would pass against a runtime that shipped every instruction to
// every run.
//
// `allowedOperations` is asserted separately from guidance, because those two must be
// allowed to disagree: an operation stays *available* on an ordinary run even when its
// step-by-step guidance is withheld. A suite that conflated them would force the
// runtime to either leak the guidance or lie about the capability.
//
// The prompt is read from `systemInstructionSnapshot` on the durable replay snapshot —
// the instruction the runtime actually sent, recorded by the runtime itself, not
// reconstructed by the test. The retired `replaySnapshotPath` helper is not ported.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter, sleep } = require('./postgres-test-harness');
const { assertScenariosExecuted } = require('./child-process-settlement');

const STAMP = Date.now();
const assert = createAsserter();
let scenariosRun = 0;
let promptsCaptured = 0;

// Verbatim from the retired suite: these are the exact strings the runtime emits.
const MARKERS = Object.freeze({
  branchingGuidance: 'For branching canonical workflows, use a condition step with trueNext and falseNext as siblings of input.',
  canonicalEnabled: 'Trusted canonical workflow draft mode is enabled.',
  intentProse: 'If the ticket asks to create, draft, define, or repair a simple workflow that writes files',
  intentExample: 'Minimal valid createWorkflowDraftIntent example:',
  handoffProse: 'To hand one bounded write task to another agent, emit createHandoffTask.'
});

function createFetchStub() {
  const preloadPath = path.join(os.tmpdir(), `prompt-composition-stub-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
global.fetch = async function() {
  return {
    ok: true, status: 200, headers: new Map([['x-request-id', 'fake-prompt-composition']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify({ message: 'done', actions: [], complete: true }),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
};
`);
  return preloadPath;
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const preloadPath = createFetchStub();
  try {
    await withHarness('workflow prompt composition', async ({ store, startServer }) => {
      const agent = (await store.createConfiguredAgent({
        value: { name: `PromptComposition-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key-prompt' },
        groupIds: [], changedBy: 'workflow-prompt-composition-test'
      })).agent;

      const server = await startServer({
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '60000',
        AGENT_ALLOW_CANONICAL_WORKFLOW_DRAFT: '1'
      });
      const cookie = await server.login();

      // Returns the instruction the runtime actually sent for this run.
      async function promptFor(label, form) {
        scenariosRun += 1;
        const objective = `prompt-composition ${label} ${STAMP}`;
        const created = await server.request('POST', '/tickets', {
          cookie,
          form: {
            objective, assignmentTargetType: 'agent',
            assignmentTargetId: String(agent.id), assignmentMode: 'individual', ...form
          }
        });
        assert(created.statusCode === 302, `${label}: ticket created (HTTP ${created.statusCode})`);
        const ticket = await waitFor(async () => {
          const { tickets } = await store.listTickets({ limit: 300 });
          return tickets.find(t => t.objective === objective) || null;
        }, 30000, `${label} ticket`);
        const run = await waitFor(async () => {
          const { runs } = await store.listRunsForTicket({ ticketId: ticket.id, limit: 10 });
          return runs[0] || null;
        }, 30000, `${label} run dispatch`);
        await waitFor(async () => {
          const current = await store.getRun(run.id);
          return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
        }, 120000, `${label} terminal run`);
        const snapshot = await waitFor(async () => {
          const record = await store.readRunReplay(run.id);
          return record && record.snapshot ? record.snapshot : null;
        }, 30000, `${label} replay snapshot`);
        const prompt = snapshot.systemInstructionSnapshot;
        // Zero captured prompts must fail, never pass vacuously.
        assert(typeof prompt === 'string' && prompt.length > 100,
          `${label}: a system instruction was actually captured (${typeof prompt}, ${String(prompt || '').length} chars)`);
        promptsCaptured += 1;
        return { prompt, snapshot, run };
      }

      // ── 1. An ordinary run receives NO workflow-only guidance ───────────────
      const ordinary = await promptFor('ordinary', {});
      assert(!ordinary.prompt.includes(MARKERS.branchingGuidance),
        '1: branching guidance does not leak into an ordinary run');
      assert(!ordinary.prompt.includes(MARKERS.canonicalEnabled),
        '1: canonical-workflow guidance does not leak into an ordinary run');
      assert(!ordinary.prompt.includes(MARKERS.intentProse),
        '1: draft-intent prose does not leak into an ordinary run');
      assert(!ordinary.prompt.includes(MARKERS.intentExample),
        '1: the draft-intent example does not leak into an ordinary run');
      assert(!ordinary.prompt.includes(MARKERS.handoffProse),
        '1: handoff guidance does not leak into an unrelated run');

      // ── 2. …while the CAPABILITY stays truthful ────────────────────────────
      // Guidance and availability are different claims. Withholding the guidance must
      // not make the prompt lie about what the run may do.
      assert(ordinary.prompt.includes('createWorkflowDraftIntent'),
        '2: allowedOperations still names createWorkflowDraftIntent on an ordinary run');
      assert(ordinary.prompt.includes('createHandoffTask'),
        '2: allowedOperations still names createHandoffTask on an ordinary run');

      // ── 3. A workflow-shaped objective DOES receive the guidance ───────────
      // The positive control. Without it every assertion above also passes against a
      // runtime that emits no guidance to anyone.
      const workflowShaped = await promptFor(
        'draft a workflow that writes files for quarterly reporting', {}
      );
      const gotGuidance = workflowShaped.prompt.includes(MARKERS.intentProse)
        || workflowShaped.prompt.includes(MARKERS.intentExample)
        || workflowShaped.prompt.includes(MARKERS.canonicalEnabled)
        || workflowShaped.prompt.includes(MARKERS.branchingGuidance);
      assert(gotGuidance,
        '3: a workflow-shaped objective receives workflow guidance the ordinary run did not');
      assert(workflowShaped.prompt !== ordinary.prompt,
        '3: the two prompts genuinely differ, so the negative assertions are meaningful');

      // ── 4. The prompts differ ONLY where they should ───────────────────────
      // Both runs used the same agent and the same capability set, so the operation
      // list must be identical even though the guidance is not.
      assert(workflowShaped.prompt.includes('createWorkflowDraftIntent')
        && workflowShaped.prompt.includes('createHandoffTask'),
        '4: the workflow run advertises the same operations as the ordinary run');

      assertScenariosExecuted({
        label: 'workflow prompt composition',
        assertions: assert.count(),
        scenarios: scenariosRun,
        minAssertions: 14,
        minScenarios: 2
      });
      assert(promptsCaptured >= 2,
        `zero-prompt guard: ${promptsCaptured} prompts were captured and compared`);
      console.log(`\nPASS: workflow prompt composition — ${scenariosRun} scenarios, ${promptsCaptured} prompts, ${assert.count()} assertions (PostgreSQL-native)`);
    }, { schemaSlug: 'prompt_composition' });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(`\nFAIL: workflow prompt composition — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
