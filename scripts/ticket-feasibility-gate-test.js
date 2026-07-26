#!/usr/bin/env node
'use strict';
// Ticket feasibility gating — PostgreSQL-native (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A10).
//
// Contract under test, unchanged from the JSON-era original: a ticket whose
// objective requires writable roots beyond the authority actually granted by its
// allocation is BLOCKED before any run is created. The block must carry ticket-level
// triage, must record required/granted/missing roots exactly, must not create runs
// or an allocation plan, must not surface as run triage, and must reject a manual
// completion transition.
//
// Repaired, not rewritten: the assertions are the original ones. What changed is
// where state comes from. The JSON-era version seeded data/*.json into a DATA_DIR
// the PostgreSQL server no longer reads, then asserted by re-reading those files.
// Seeding and assertions now go through the same store authority the runtime
// writes to, via scripts/postgres-test-harness.js.

const fs = require('fs');
const path = require('path');
const { withHarness, createAsserter, sleep } = require('./postgres-test-harness');

const OBJECTIVE = 'inside the folders for quarters, put the months for those specific quarters';
const assert = createAsserter();

async function main() {
  await withHarness('ticket feasibility gate', async ({ store, workspaceRoot, startServer }) => {
    // Authority scope: two agents in a ticket-receiving group, granted Q1 and Q2 only.
    const group = (await store.createGroup({
      value: { name: 'Feasibility Gate', permissions: [], canReceiveTickets: true },
      changedBy: 'ticket-feasibility-test'
    })).group;

    const agentA = (await store.createConfiguredAgent({
      value: { name: 'FeasibilityA', provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key-a' },
      groupIds: [group.id], changedBy: 'ticket-feasibility-test'
    })).agent;
    const agentB = (await store.createConfiguredAgent({
      value: { name: 'FeasibilityB', provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key-b' },
      groupIds: [group.id], changedBy: 'ticket-feasibility-test'
    })).agent;

    // The objective references four quarters; authority below grants only two.
    for (const dir of ['Q1', 'Q2', 'Q3', 'Q4']) {
      fs.mkdirSync(path.join(workspaceRoot, dir), { recursive: true });
    }

    const server = await startServer();
    const cookie = await server.login();

    const response = await server.request('POST', '/tickets', {
      cookie,
      form: {
        objective: OBJECTIVE,
        assignmentTargetType: 'group',
        assignmentTargetId: String(group.id),
        assignmentMode: 'allocated',
        ownedOutputPaths: JSON.stringify({ [agentA.id]: 'Q1', [agentB.id]: 'Q2' })
      }
    });
    assert(response.statusCode === 302,
      `ticket create returned HTTP ${response.statusCode}`);

    // Settle the post-create lifecycle before reading persisted state.
    let ticket = null;
    for (let i = 0; i < 40 && !ticket; i += 1) {
      const page = await store.listTickets({ limit: 100 });
      ticket = (page.tickets || page).find
        ? (page.tickets || page).find(t => t.objective === OBJECTIVE)
        : null;
      if (!ticket) await sleep(150);
    }
    assert(Boolean(ticket), 'ticket was persisted');

    // ── The gate itself ────────────────────────────────────────────────────
    assert(ticket.status === 'blocked', `ticket is blocked, got ${ticket.status}`);
    assert(ticket.blockedReason === 'Ticket objective requires paths not granted by authority:\nQ3/\nQ4/',
      'blocked reason lists exactly the ungranted roots');
    assert(JSON.stringify(ticket.feasibility.requiredWritableRoots) === JSON.stringify(['Q1/', 'Q2/', 'Q3/', 'Q4/']),
      'required writable roots were captured');
    assert(JSON.stringify(ticket.feasibility.grantedWritableRoots) === JSON.stringify(['Q1/', 'Q2/']),
      'granted writable roots were captured');
    assert(JSON.stringify(ticket.feasibility.missingAuthorityGrants) === JSON.stringify(['Q3/', 'Q4/']),
      'missing authority grants were captured');

    // ── Ticket-level triage ────────────────────────────────────────────────
    assert(ticket.triage && ticket.triage.required === true,
      'blocked ticket persists required ticket-level triage');
    assert(ticket.triage.reasonCode === 'authority_blocked',
      'missing grants map to authority_blocked triage');
    assert(ticket.triage.requiredDecision === 'change_scope',
      'missing grants require a scope change');
    assert(ticket.triage.allowedActions.includes('edit_ticket'),
      'ticket triage allows editing the ticket');
    assert(ticket.triage.prohibitedActions.includes('start_run_without_scope_change'),
      'ticket triage prohibits starting without a scope change');

    // ── Nothing was started ────────────────────────────────────────────────
    const runs = await store.listRunsForTicket({ ticketId: ticket.id, limit: 50 });
    assert((runs.runs || runs).length === 0, 'blocked ticket created no agent runs');
    const plan = await store.getAllocationPlanForTicket(ticket.id);
    assert(!plan, 'blocked ticket created no allocation plan');

    // The gate must fire before execution, so no runtime ownership rejection
    // should ever have been reached.
    const ticketOps = await store.listTicketOperations(ticket.id, { limit: 100 });
    assert((ticketOps.operations || ticketOps).length === 0,
      'blocked ticket produced no workspace operations');

    // ── Operator surface distinguishes ticket triage from run triage ───────
    const ticketPage = await server.request('GET', `/tickets/${ticket.id}`, { cookie });
    assert(ticketPage.statusCode === 200, `ticket detail returned HTTP ${ticketPage.statusCode}`);
    assert(ticketPage.body.includes('Ticket-Level Triage'),
      'ticket detail identifies pre-run ticket triage');
    assert(ticketPage.body.includes('<code>authority_blocked</code>'),
      'ticket detail shows the triage reason');
    assert(ticketPage.body.includes('<code>change_scope</code>'),
      'ticket detail shows the required decision');
    assert(!ticketPage.body.includes('Latest Run Triage'),
      'pre-run ticket triage is not rendered as latest-run triage');

    // ── Manual completion is refused while triage is unresolved ────────────
    const completeBlocked = await server.request('PATCH', `/api/tickets/${ticket.id}/status`, {
      cookie, body: { status: 'completed' }
    });
    assert(completeBlocked.statusCode === 409,
      'pre-run blocked ticket rejects a manual completed transition');
    assert(JSON.parse(completeBlocked.body).error.includes('ticket-level triage'),
      'rejection explains the required ticket triage');

    console.log(`\nPASS: ticket feasibility gate — ${assert.count()} assertions (PostgreSQL-native)`);
  });
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
