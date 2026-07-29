#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter, sleep } = require('./postgres-test-harness');

const STAMP = Date.now();
const assert = createAsserter();

function preload() {
  const preloadPath = path.join(os.tmpdir(), `completion-decision-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
function response(plan) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'completion-decision-fixture']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify(plan),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
}
global.fetch = async function(_url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const prompt = (Array.isArray(body.input) ? body.input : [])
    .map(item => item && item.content ? String(item.content) : '')
    .join('\\n');
  if (prompt.includes('t6-model-claim-${STAMP}')) {
    return response({
      message: 'MODEL-PROSE-MUST-NOT-BECOME-AUTHORITY',
      actions: [],
      complete: true
    });
  }
  if (prompt.includes('t6-model-incomplete-${STAMP}')) {
    return response({
      message: 'creating the deterministically declared folder',
      actions: [{ operation: 'createFolder', args: { path: 't6-model-incomplete-${STAMP}' } }],
      complete: false
    });
  }
  return response({
    message: 'creating the deterministically declared folder',
    actions: [{ operation: 'createFolder', args: { path: 't6-complete-${STAMP}' } }],
    complete: true
  });
};
`);
  return preloadPath;
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

async function main() {
  const preloadPath = preload();
  try {
    await withHarness('completion decision PostgreSQL', async ({ store, startServer }) => {
      const agent = (await store.createConfiguredAgent({
        value: {
          name: `CompletionDecision-${STAMP}`,
          provider: 'openai',
          model: 'gpt-4.1-mini',
          apiKey: 'fixture'
        },
        groupIds: [],
        changedBy: 'completion-decision-postgres-test'
      })).agent;
      const server = await startServer({
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '100',
        PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS: '3600000'
      });
      const cookie = await server.login();

      async function createTicket(objective) {
        const response = await server.request('POST', '/tickets', {
          cookie,
          form: {
            objective,
            assignmentTargetType: 'agent',
            assignmentTargetId: String(agent.id),
            assignmentMode: 'individual'
          }
        });
        assert(response.statusCode === 302, `ticket admission succeeds for ${objective}`);
        return waitFor(async () => {
          const page = await store.listTickets({ limit: 200 });
          return page.tickets.find(ticket => ticket.objective === objective) || null;
        }, 15000, `ticket ${objective}`);
      }

      async function waitForDecision(ticket) {
        return waitFor(async () => {
          const runs = (await store.listRunsForTicket({ ticketId: ticket.id, limit: 20 })).runs;
          const run = runs[0] || null;
          if (!run || !['completed', 'failed', 'interrupted'].includes(run.status)) return null;
          const consequence = await store.getRunConsequence(run.id);
          if (!consequence || !consequence.consequence.completionDecision) return null;
          const projectedTicket = await store.getTicket(ticket.id);
          if (!projectedTicket || projectedTicket.status === 'in_progress') return null;
          return { run, consequence: consequence.consequence, ticket: projectedTicket };
        }, 45000, `completion decision for ticket ${ticket.id}`);
      }

      const completed = await waitForDecision(await createTicket(`Create folder t6-complete-${STAMP}`));
      const completedDecision = completed.consequence.completionDecision;
      assert(completed.run.completionAuthoritySnapshot &&
        completed.run.completionAuthoritySnapshot.objectiveContract.directPostconditions.length === 1,
      'new run admits one immutable deterministic completion authority snapshot');
      assert(completedDecision.executionDisposition === 'succeeded',
        'completed objective records successful execution separately');
      assert(completedDecision.verificationDisposition === 'passed',
        'completed objective records passed deterministic verification separately');
      assert(completedDecision.completionDisposition === 'completed',
        'completed objective records objective completion separately');
      assert(completed.ticket.status === 'completed',
        'ticket completion follows the persisted completed decision');

      const completedEvents = (await store.listRunEvents(completed.run.id, { limit: 400 }));
      const consequenceEvent = completedEvents.find(event => event.type === 'run.consequence_recorded');
      const decisionEvent = completedEvents.find(event => event.type === 'run.completion_decided');
      const terminalEvent = completedEvents.find(event => event.type === 'run.terminalized');
      assert(Boolean(consequenceEvent && decisionEvent && terminalEvent),
        'consequence, completion decision, and terminal lifecycle evidence are durable');
      assert(consequenceEvent.seq < decisionEvent.seq && decisionEvent.seq < terminalEvent.seq,
        'completion evidence is ordered before terminal lifecycle evidence');
      assert(decisionEvent.payload.decisionHash === completedDecision.decisionHash,
        'completion evidence binds the exact immutable decision');
      assert(!JSON.stringify(completedDecision).includes('creating the deterministically declared folder'),
        'model prose is absent from completion authority');
      const completedPage = await server.request('GET', `/runs/${completed.run.id}`, { cookie });
      assert(completedPage.statusCode === 200 &&
        completedPage.body.includes('Canonical completion decision') &&
        completedPage.body.includes('<code>succeeded</code>') &&
        completedPage.body.includes('<code>passed</code>') &&
        completedPage.body.includes('<code>completed</code>'),
      'run detail renders execution, verification, and completion as distinct facts');

      const replayed = await store.getRunConsequence(completed.run.id);
      assert(replayed.consequence.completionDecision.decisionHash === completedDecision.decisionHash,
        'ordinary PostgreSQL replay reconstructs the same decision hash');
      const duplicateTransition = await store.transitionTicketAfterRun({ runId: completed.run.id });
      assert(duplicateTransition.changed === false &&
        duplicateTransition.ticket.status === 'completed',
      'ticket projection replay is idempotent');

      let updateRejected = false;
      try {
        await store.pool.query(
          `UPDATE ${store.table('run_consequences')}
           SET consequence = consequence || '{"tampered":true}'::jsonb
           WHERE run_id = $1`,
          [completed.run.id]
        );
      } catch (error) {
        updateRejected = /append-only/i.test(String(error.message));
      }
      assert(updateRejected, 'completion decisions cannot be mutated after persistence');
      let deleteRejected = false;
      try {
        await store.pool.query(
          `DELETE FROM ${store.table('run_consequences')} WHERE run_id = $1`,
          [completed.run.id]
        );
      } catch (error) {
        deleteRejected = /append-only/i.test(String(error.message));
      }
      assert(deleteRejected, 'completion decisions cannot be deleted');

      const modelOnly = await waitForDecision(await createTicket(`Review semantic result t6-model-claim-${STAMP}`));
      assert(modelOnly.run.status === 'completed',
        'operation loop may finish while objective completion remains separately undecided');
      assert(modelOnly.consequence.completionDecision.executionDisposition === 'succeeded',
        'model-only run retains truthful successful execution');
      assert(modelOnly.consequence.completionDecision.verificationDisposition === 'not_required',
        'when_declared with no declaration is explicitly not required');
      assert(modelOnly.consequence.completionDecision.completionDisposition === 'incomplete',
        'bare model complete claim cannot establish objective completion');
      assert(modelOnly.ticket.status !== 'completed',
        'ticket projection refuses model-only completion');
      assert(modelOnly.consequence.completionDecision.modelClaim.complete === true &&
        modelOnly.consequence.completionDecision.modelClaim.authority === false,
      'model complete claim is explicitly non-authoritative');
      const incompletePage = await server.request('GET', `/runs/${modelOnly.run.id}`, { cookie });
      assert(incompletePage.statusCode === 200 &&
        incompletePage.body.includes('<code>not_required</code>') &&
        incompletePage.body.includes('<code>incomplete</code>'),
      'run detail renders operation-successful objective-incomplete distinctly');

      const modelIncomplete = await waitForDecision(
        await createTicket(`Create folder t6-model-incomplete-${STAMP}`)
      );
      assert(modelIncomplete.consequence.completionDecision.modelClaim.complete === false,
        'model incomplete claim is retained');
      assert(modelIncomplete.consequence.completionDecision.completionDisposition === 'completed',
        'deterministic postconditions override a model incomplete belief');
      assert(modelIncomplete.ticket.status === 'completed',
        'deterministically completed objective projects the ticket complete');

      const decisionEventsAfterReplay = await store.listRunEvents(completed.run.id, { limit: 400 });
      assert(decisionEventsAfterReplay.filter(event => event.type === 'run.completion_decided').length === 1,
        'repeated projection creates no duplicate completion evidence');

      try { await server.stop(); } catch (_) { /* best effort */ }
      console.log(`PASS: completion decision PostgreSQL (${assert.count()} assertions)`);
    });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
