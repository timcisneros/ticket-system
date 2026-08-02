#!/usr/bin/env node
'use strict';
// Rerun-mode prior-failure evidence — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A13).
//
// RELOCATED COVERAGE. This is the one live assertion inside
// `scripts/execution-semantics-test.js`, which A13 retires: *reassess mode injects
// structured prior-failure context; retry does not.* The original proved it by
// reading `server.js` as text and substring-matching field names, so it would have
// passed against a `buildPriorFailureContext` that was never called, and failed on a
// harmless rename. It is re-expressed here as behavior.
//
// THE CONTRACT, and why both halves matter:
//
//   reassess — the operator is explicitly asking the model to reconsider in light of
//              what already failed, so the prompt carries the prior run's id, terminal
//              status, failure reason and what it had already done.
//
//   retry    — the default. The prompt must carry NO prior-failure context. This half
//              is the load-bearing one: silently injecting a previous failure into
//              every rerun would make "retry" a different operation than it claims to
//              be, and would leak a prior run's evidence into a run that never asked
//              for it.
//
// The provider stub records every prompt it is asked to complete, so both halves are
// asserted against what the model actually received rather than against source text.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter, sleep } = require('./postgres-test-harness');

const STAMP = Date.now();
const assert = createAsserter();

function encodeActions(plan) {
  return Buffer.from(JSON.stringify(plan), 'utf8').toString('base64url');
}

// Records each prompt to a JSONL file so the suite can inspect exactly what the model
// was given, per provider call.
function createRecordingStub(promptLog) {
  const preloadPath = path.join(os.tmpdir(), `rerun-mode-stub-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
const fs = require('fs');
function okResponse(plan) {
  return { ok: true, status: 200, headers: new Map([['x-request-id', 'fake-rerun-mode']]),
    async text() { return JSON.stringify({ output_text: JSON.stringify(plan), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }); } };
}
global.fetch = async function(_url, options = {}) {
  let combined = '';
  try {
    const body = JSON.parse(options.body || '{}');
    const input = Array.isArray(body.input) ? body.input : [];
    combined = input.map(i => i && i.content ? String(i.content) : '').join('\\n');
  } catch (_) {}
  try { fs.appendFileSync(${JSON.stringify(promptLog)}, JSON.stringify({ prompt: combined }) + '\\n'); } catch (_) {}
  const m = combined.match(/#ACTIONS=([A-Za-z0-9_-]+=*)/);
  if (!m) return okResponse({ message: 'noop', actions: [], complete: true });
  let plan;
  try { plan = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch (_) { plan = { actions: [], complete: true }; }
  return okResponse({ message: plan.message || 'stubbed', actions: plan.actions || [], complete: plan.complete !== false });
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
  const promptLog = path.join(os.tmpdir(), `rerun-mode-prompts-${process.pid}-${STAMP}.jsonl`);
  fs.writeFileSync(promptLog, '');
  const preloadPath = createRecordingStub(promptLog);

  try {
    await withHarness('rerun mode evidence', async ({ store, workspaceRoot, startServer }) => {
      const agents = [];
      for (let i = 0; i < 2; i += 1) {
        agents.push((await store.createConfiguredAgent({
          value: { name: `RerunMode Agent ${i} ${STAMP}`, provider: 'openai', model: `fake-openai-${i}`, apiKey: `fake-key-rerun-${i}` },
          groupIds: [], changedBy: 'rerun-mode-evidence-test'
        })).agent.id);
      }

      const server = await startServer({ env: {
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '60000'
      } });
      const cookie = await server.login();

      const objectiveWith = (tag, plan) => `rerun-mode ${tag} ${STAMP} #ACTIONS=${encodeActions(plan)}`;
      const promptsSince = offset => fs.readFileSync(promptLog, 'utf8')
        .split('\n').filter(Boolean).slice(offset).map(line => JSON.parse(line).prompt);
      const promptCount = () => fs.readFileSync(promptLog, 'utf8').split('\n').filter(Boolean).length;

      async function runTicket(agentId, objective) {
        const created = await server.request('POST', '/tickets', {
          cookie, form: { objective, assignmentTargetType: 'agent', assignmentTargetId: String(agentId), assignmentMode: 'individual' }
        });
        if (created.statusCode !== 302) throw new Error(`ticket create returned HTTP ${created.statusCode}`);
        const ticket = await waitFor(async () => {
          const { tickets } = await store.listTickets({ limit: 300 });
          return tickets.find(t => t.objective === objective) || null;
        }, 30000, 'ticket persistence');
        const run = await waitFor(async () => {
          const { runs } = await store.listRunsForTicket({ ticketId: ticket.id, limit: 10 });
          return runs[0] || null;
        }, 30000, `run dispatch for ticket ${ticket.id}`);
        const terminal = await waitFor(async () => {
          const current = await store.getRun(run.id);
          return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
        }, 90000, `terminal run ${run.id}`);
        return { ticket, run: terminal };
      }

      // A ticket whose run FAILS, so there is prior-failure evidence to inject.
      // A cross-ticket write conflict is the most deterministic way to fail a run
      // while still producing a real error and real prior evidence.
      const contested = `rerun-mode/contested-${STAMP}.txt`;
      const owner = await runTicket(agents[0], objectiveWith('owner', {
        actions: [{ operation: 'writeFile', args: { path: contested, content: 'OWNED' } }], complete: true
      }));
      assert(owner.run.status === 'completed', `setup: the owner run completed (${owner.run.status})`);

      const failing = await runTicket(agents[1], objectiveWith('failing', {
        actions: [{ operation: 'writeFile', args: { path: contested, content: 'INTRUDER' } }], complete: true
      }));
      assert(failing.run.status === 'failed', `setup: the contested run failed (${failing.run.status})`);
      assert(/conflict|previously produced/i.test(String(failing.run.error || '')),
        'setup: the failure carries a real error the reassess prompt could cite');

      async function rerunAndCapture(ticketId, body, label) {
        const before = promptCount();
        const priorRunIds = new Set((await store.listRunsForTicket({ ticketId, limit: 50 })).runs.map(r => r.id));
        const response = await server.request('POST', `/api/tickets/${ticketId}/rerun`, { cookie, body });
        assert(response.statusCode === 200, `${label}: the rerun was accepted (HTTP ${response.statusCode})`);
        const newRun = await waitFor(async () => {
          const { runs } = await store.listRunsForTicket({ ticketId, limit: 50 });
          const created = runs.find(r => !priorRunIds.has(r.id));
          return created && ['completed', 'failed', 'interrupted'].includes(created.status) ? created : null;
        }, 90000, `${label} rerun to terminalize`);
        const prompts = promptsSince(before);
        assert(prompts.length > 0, `${label}: the rerun issued at least one provider call`);
        return { run: newRun, firstPrompt: prompts[0] };
      }

      // ── reassess: the prior failure is in the prompt ────────────────────────
      const reassess = await rerunAndCapture(failing.ticket.id, { mode: 'reassess' }, 'reassess');
      assert(reassess.run.rerunMode === 'reassess',
        `reassess: the mode is recorded on the run (got ${reassess.run.rerunMode})`);
      assert(reassess.firstPrompt.includes('priorRunId'),
        'reassess: the prompt carries the prior run id field');
      assert(reassess.firstPrompt.includes(String(failing.run.id)),
        'reassess: the prompt names the run that actually failed');
      assert(reassess.firstPrompt.includes('recoveryClassification'),
        'reassess: the prompt classifies how the prior run ended');
      assert(/"status"\s*:\s*"failed"/.test(reassess.firstPrompt),
        'reassess: the prompt states the prior terminal status');
      assert(/conflict|previously produced/i.test(reassess.firstPrompt),
        'reassess: the prompt cites the real failure reason rather than a placeholder');
      assert(reassess.firstPrompt.includes('mutationsCompleted'),
        'reassess: the prompt reports what the prior run had already committed');

      // ── retry (the default): no prior failure leaks in ─────────────────────
      // Asserted on a SEPARATE failed ticket, so this cannot pass merely because the
      // reassess rerun above already consumed the prior-failure evidence.
      const contested2 = `rerun-mode/contested2-${STAMP}.txt`;
      const owner2 = await runTicket(agents[0], objectiveWith('owner2', {
        actions: [{ operation: 'writeFile', args: { path: contested2, content: 'OWNED' } }], complete: true
      }));
      assert(owner2.run.status === 'completed', `setup: the second owner run completed (${owner2.run.status})`);
      const failing2 = await runTicket(agents[1], objectiveWith('failing2', {
        actions: [{ operation: 'writeFile', args: { path: contested2, content: 'INTRUDER' } }], complete: true
      }));
      assert(failing2.run.status === 'failed', `setup: the second contested run failed (${failing2.run.status})`);

      const retry = await rerunAndCapture(failing2.ticket.id, {}, 'retry');
      assert(retry.run.rerunMode !== 'reassess',
        `retry: the default mode is not reassess (got ${retry.run.rerunMode})`);
      assert(!retry.firstPrompt.includes('priorRunId'),
        'retry: no prior run id reaches the prompt');
      assert(!retry.firstPrompt.includes('recoveryClassification'),
        'retry: no prior-run classification reaches the prompt');
      assert(!retry.firstPrompt.includes('mutationsCompleted'),
        'retry: no prior mutation count reaches the prompt');
      // Deliberately NOT `includes(String(runId))`: run ids are small integers and
      // would match coincidentally anywhere in the prompt. The failure REASON is a
      // distinctive string, so its absence is real evidence that nothing leaked.
      assert(!/previously produced by ticket/i.test(retry.firstPrompt),
        'retry: the prior failure reason never reaches the model');

      // The two prompts must actually differ, which rules out both assertions
      // passing against some third prompt shape that contains neither.
      assert(reassess.firstPrompt !== retry.firstPrompt,
        'the two modes produce genuinely different prompts');

      console.log(`\nPASS: rerun-mode prior-failure evidence — ${assert.count()} assertions (PostgreSQL-native)`);
    }, { schemaSlug: 'rerun_mode_evidence' });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
    try { fs.unlinkSync(promptLog); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(`\nFAIL: rerun-mode prior-failure evidence — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
