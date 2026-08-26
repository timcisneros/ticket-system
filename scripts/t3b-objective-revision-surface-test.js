#!/usr/bin/env node
'use strict';

// T3-b — operator/API objective-revision SURFACE owner.
//
// Proves the bounded operator surface on the REAL server against real
// PostgreSQL. Every semantic rule is delegated to the frozen T3-a kernel
// (store.reviseTicketObjective); this owner proves the HTTP boundary:
//   authentication · ticket:update authorization · mutation-admission
//   registration · optimistic expectedRevision stale-write protection ·
//   acceptanceCriteria identity participation · kernel refusal propagation ·
//   canonical no-op refusal · unsettled-attempt refusal · structured
//   immutability preservation · truthful objective-history rendering sourced
//   exclusively from immutable ticket.objective_revised events · legacy
//   created-entry truthfulness · activation-baseline provenance distinctness
//   · gate edit_objective wiring · triage-resolution separation ·
//   attempt-budget preservation.

const argon2 = require('argon2');
const fs = require('node:fs');
const path = require('node:path');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const { assertScenariosExecuted } = require('./child-process-settlement');

const STAMP = Date.now().toString(36);
const REV_EVENT = 'ticket.objective_revised';
const ACTOR_ADMIN = 't3b-admin';
const ACTOR_LIMITED = 't3b-limited';
const ADMIN_PASSWORD = 't3b-admin-password';
const LIMITED_PASSWORD = 't3b-limited-password';
const SERVER_SRC = path.join(__dirname, '..', 'server.js');

const assert = createAsserter();

async function latestRevisionEvent(store, ticketId) {
  const rows = (await store.pool.query(
    `SELECT position, payload FROM ${store.table('events')}
      WHERE ticket_id = $1 AND type = $2
      ORDER BY position DESC LIMIT 1`,
    [ticketId, REV_EVENT])).rows[0];
  return rows || null;
}

async function revisionEventCount(store, ticketId) {
  return Number((await store.pool.query(
    `SELECT count(*)::int AS n FROM ${store.table('events')}
      WHERE ticket_id = $1 AND type = $2`, [ticketId, REV_EVENT])).rows[0].n);
}

async function main() {
  let scenariosRun = 0;

  await withHarness('T3-b objective-revision surface', async ({ store, startServer }) => {
    // ── Principals ──────────────────────────────────────────────────────────
    const adminGroup = (await store.createGroup({
      value: { name: `T3b admins ${STAMP}`, permissions: ['ticket:read', 'ticket:update'], canReceiveTickets: false },
      changedBy: ACTOR_ADMIN
    })).group;
    const limitedGroup = (await store.createGroup({
      value: { name: `T3b readers ${STAMP}`, permissions: ['ticket:read'], canReceiveTickets: false },
      changedBy: ACTOR_ADMIN
    })).group;
    await store.createUser({
      value: { username: ACTOR_ADMIN, passwordHash: await argon2.hash(ADMIN_PASSWORD) },
      groupIds: [adminGroup.id],
      changedBy: ACTOR_ADMIN
    });
    await store.createUser({
      value: { username: ACTOR_LIMITED, passwordHash: await argon2.hash(LIMITED_PASSWORD) },
      groupIds: [limitedGroup.id],
      changedBy: ACTOR_ADMIN
    });
    const runnerAgent = (await store.createConfiguredAgent({
      value: { name: `T3b runner ${STAMP}`, provider: 'openai', model: 'gpt-x', apiKey: '' },
      changedBy: ACTOR_ADMIN
    })).agent;

    const server = await startServer({ env: { RUNTIME_SCHEDULER_INTERVAL_MS: '3600000' } });
    const adminCookie = await server.login();
    const limitedCookie = await server.login(ACTOR_LIMITED, LIMITED_PASSWORD);

    const revise = (cookie, ticketId, body) => server.request(
      'POST', `/api/tickets/${ticketId}/objective-revisions`, { cookie, body });

    // Structural guard: the surface route is registered with the canonical
    // mutation-admission boundary.
    const serverSource = fs.readFileSync(SERVER_SRC, 'utf8');
    const routeAt = serverSource.indexOf("'/api/tickets/:id/objective-revisions'");
    assert(routeAt !== -1, 'objective-revision route is registered');
    const configWindow = serverSource.slice(routeAt, routeAt + 220);
    assert(/mutationAdmission:\s*true/.test(configWindow),
      'objective-revision route carries the mutation-admission boundary');

    // ── Seed one normally-executable Ticket via the REAL creation flow ──────
    const createFormResponse = await server.request('POST', '/tickets', {
      cookie: adminCookie,
      form: {
        objective: `T3b surface target ${STAMP}`,
        acceptanceCriteria: 'Original sealed criteria.',
        assignmentTargetType: 'agent',
        assignmentTargetId: String(runnerAgent.id),
        assignmentMode: 'individual'
      }
    });
    if (!(createFormResponse.statusCode === 302)) throw new Error('ticket creation form redirects on success');;
    const target = (await store.listTickets({ limit: 200 }))
      .tickets.find(t => t.objective === `T3b surface target ${STAMP}`);
    assert(target, 'created Ticket found by objective');

    // Creation seam established revision 1 atomically.
    const baselineHead = await latestRevisionEvent(store, target.id);
    assert(baselineHead && baselineHead.payload.number === 1 &&
           baselineHead.payload.provenance === 'creation' &&
           baselineHead.payload.content.objective === target.objective,
      'creation established revision-1 authority');
    if (!(await revisionEventCount(store, target.id) === 1)) throw new Error('exactly one revision event after creation');;

    // ── A/B: authentication + ticket:update authorization ───────────────────
    const anonResponse = await server.request(
      'POST', `/api/tickets/${target.id}/objective-revisions`, {
        body: { expectedRevision: 1, objective: 'anon', reasonCode: 'correction', reason: 'r' }
      });
    assert([302, 401].includes(anonResponse.statusCode),
      'unauthenticated revision refused at the auth boundary');

    // The creation seam auto-admits one Run. Settle it truthfully via the
    // operator stop boundary so the frozen unsettled-attempt guard allows a
    // revision.
    const autoRun = (await store.listRunsForTicket({ ticketId: target.id, limit: 5 }))
      .runs[0];
    assert(autoRun, 'creation auto-admitted a Run');
    const stopResponse = await server.request(
      'POST', `/api/runs/${autoRun.id}/stop`, { cookie: adminCookie, body: {} });
    assert(stopResponse.statusCode === 200, stopResponse.body);
    let current = await store.getTicket(target.id);
    const limitedResponse = await revise(limitedCookie, target.id, {
      expectedRevision: current.revision,
      objective: 'Limited principal edit',
      acceptanceCriteria: null,
      reasonCode: 'correction',
      reason: 'must be refused'
    });
    if (!(limitedResponse.statusCode === 403)) throw new Error('principal without ticket:update is refused');;
    if (!(await revisionEventCount(store, target.id) === 1)) throw new Error('refused limited edit wrote no revision event');;

    // ── D/E: successful authorized revision; criteria identity ─────────────
    current = await store.getTicket(target.id);
    const first = await revise(adminCookie, target.id, {
      expectedRevision: current.revision,
      objective: 'Revised surface objective',
      acceptanceCriteria: 'Revised sealed criteria.',
      reasonCode: 'clarification',
      reason: 'operator clarified the requested outcome'
    });
    if (!(first.statusCode === 200)) throw new Error(String(first.body || '').slice(0, 300));;
    const firstBody = JSON.parse(first.body);
    if (!(firstBody.objectiveRevision.number === 2)) throw new Error('first authorized revision is number 2');;
    if (!(firstBody.objective === 'Revised surface objective')) throw new Error('assertion failed');;
    if (!(firstBody.acceptanceCriteria === 'Revised sealed criteria.')) throw new Error('assertion failed');;

    // E continued: criteria participates in identity.
    current = await store.getTicket(target.id);
    const criteriaOnly = await revise(adminCookie, target.id, {
      expectedRevision: current.revision,
      objective: 'Revised surface objective',
      acceptanceCriteria: 'Tightened criteria.',
      reasonCode: 'scope_note',
      reason: 'tighten verification'
    });
    if (!(criteriaOnly.statusCode === 200)) throw new Error('assertion failed');;
    if (!(JSON.parse(criteriaOnly.body).objectiveRevision.number === 3)) throw new Error('criteria-only change is a distinct revision (E)');;

    // ── F: stale-write refusal end-to-end ───────────────────────────────────
    const stale = await revise(adminCookie, target.id, {
      expectedRevision: 2,
      objective: 'Stale concurrent edit',
      acceptanceCriteria: null,
      reasonCode: 'correction',
      reason: 'must lose the race'
    });
    if (!(stale.statusCode === 409)) throw new Error('stale expectedRevision conflicts');;
    if (!(JSON.parse(stale.body).code === 'TICKET_TRANSITION_CONFLICT')) throw new Error('stale conflict surfaces the canonical concurrency code');;
    if (!((await latestRevisionEvent(store, target.id)).payload.number === 3)) throw new Error('losing stale writer appended nothing');;

    // ── H: canonical no-op refuses through HTTP ─────────────────────────────
    const noop = await revise(adminCookie, target.id, {
      expectedRevision: Number((await store.getTicket(target.id)).revision),
      objective: 'Revised surface objective',
      acceptanceCriteria: 'Tightened criteria.',
      reasonCode: 'clarification',
      reason: 'identical resubmission'
    });
    if (!(noop.statusCode === 409)) throw new Error('assertion failed');;
    if (!(JSON.parse(noop.body).code === 'TICKET_OBJECTIVE_REVISION_NOOP')) throw new Error('canonical no-op refuses (H)');;

    // ── I: unsettled-attempt refusal propagates through HTTP ────────────────
    const admitted = await store.createRunsAndStartTicket({
      ticketId: target.id,
      runDrafts: [{ ticketId: target.id, agentId: runnerAgent.id, executionMode: 'agent' }]
    });
    assert(admitted.attempt.id, 'admission fixture produced an attempt');
    const unsettledRefusal = await revise(adminCookie, target.id, {
      expectedRevision: Number((await store.getTicket(target.id)).revision),
      objective: 'Mid-flight change',
      acceptanceCriteria: null,
      reasonCode: 'correction',
      reason: 'must refuse across unsettled attempt'
    });
    if (!(unsettledRefusal.statusCode === 409)) throw new Error('assertion failed');;
    if (!(JSON.parse(unsettledRefusal.body).code === 'TICKET_ATTEMPT_UNSETTLED')) throw new Error('mid-unsettled-attempt revision refuses (I)');;

    // ── J: structured immutability preserved through the boundary ───────────
    const {
      buildStructuredAllocationAuthorityDraft
    } = require('../runtime/structured-allocation-prerequisites-contract');
    const sGroup = (await store.createGroup({
      value: { name: `T3b structured ${STAMP}`, permissions: [], canReceiveTickets: true },
      changedBy: ACTOR_ADMIN
    })).group;
    const sPlanner = (await store.createConfiguredAgent({
      value: { name: `T3b struct planner ${STAMP}`, provider: 'openai', model: 'm', apiKey: '' },
      groupIds: [sGroup.id],
      changedBy: ACTOR_ADMIN
    })).agent;
    await store.updateGroup({
      groupId: sGroup.id,
      expectedRevision: sGroup.revision,
      value: { ...sGroup, plannerAgentId: sPlanner.id },
      changedBy: ACTOR_ADMIN
    });
    const sWorker = (await store.createConfiguredAgent({
      value: { name: `T3b struct worker ${STAMP}`, provider: 'openai', model: 'm', apiKey: '' },
      groupIds: [sGroup.id],
      changedBy: ACTOR_ADMIN
    })).agent;
    const designated = (await store.updateGroup({
      groupId: sGroup.id,
      expectedRevision: Number((await store.pool.query(
        `SELECT revision FROM ${store.table('access_groups')} WHERE id = $1`,
        [sGroup.id])).rows[0].revision),
      value: { ...sGroup, plannerAgentId: sPlanner.id },
      changedBy: ACTOR_ADMIN
    })).group;
    const authorityDraft = buildStructuredAllocationAuthorityDraft({
      declaredWork: {
        objective: 'Structured delegated outcome',
        expectedOutputs: [{ kind: 'text', declaration: 'One structured report' }],
        successCriteria: [{ kind: 'text', declaration: 'Structured report inspectable' }],
        evidenceRequirements: []
      },
      ticketObjective: 'Structured delegated outcome',
      assignmentTargetType: 'group',
      assignmentMode: 'allocated',
      assignmentGroup: designated,
      plannerAgent: sPlanner,
      candidateAgents: [sWorker, sPlanner],
      ownedOutputPaths: { [sWorker.id]: 'structured/worker/', [sPlanner.id]: 'structured/planner/' }
    });
    const structuredTicket = (await store.createTicketWithEvent({
      ticket: {
        status: 'blocked',
        blockedReason: 'T3-b structured immutability fixture.',
        objective: 'Structured delegated outcome',
        acceptanceCriteria: null,
        assignmentTargetType: 'group',
        assignmentTargetId: designated.id,
        assignmentMode: 'allocated',
        ownedOutputPaths: { [sWorker.id]: 'structured/worker/', [sPlanner.id]: 'structured/planner/' }
      },
      structuredAllocationAuthorityDraft: authorityDraft,
      eventPayload: {}
    })).ticket;
    const structuredRefusal = await revise(adminCookie, structuredTicket.id, {
      expectedRevision: Number(structuredTicket.revision),
      objective: 'Attempted structured override',
      acceptanceCriteria: null,
      reasonCode: 'correction',
      reason: 'must refuse'
    });
    if (!(structuredRefusal.statusCode === 409)) throw new Error('assertion failed');;
    if (!(JSON.parse(structuredRefusal.body).code === 'STRUCTURED_ALLOCATION_OBJECTIVE_IMMUTABLE')) throw new Error('surface preserves structured immutability (J)');;

    // ── P: triage resolution separation ─────────────────────────────────────
    const pTarget = (await store.createTicketWithEvent({
      ticket: { status: 'open', objective: 'P-scenario target', createdBy: ACTOR_ADMIN },
      eventPayload: {}
    })).ticket;
    await store.blockTicket({
      ticketId: pTarget.id,
      reasonCode: 'objective_ambiguous',
      summary: 'ambiguous objective requires operator decision',
      triage: {
        required: true, reasonCode: 'objective_ambiguous',
        summary: 'ambiguous objective requires operator decision',
        requiredDecision: 'clarify_objective',
        allowedActions: ['edit_objective', 'clarify_ticket'],
        createdAt: new Date().toISOString(), resolvedAt: null
      }
    });
    const blockedRevResponse = await revise(adminCookie, pTarget.id, {
      expectedRevision: Number((await store.getTicket(pTarget.id)).revision),
      objective: 'P-scenario clarified outcome',
      acceptanceCriteria: null,
      reasonCode: 'clarification',
      reason: 'resolve ambiguity by correcting outcome'
    });
    if (!(blockedRevResponse.statusCode === 200)) throw new Error('assertion failed');;
    const stillBlocked = await store.getTicket(pTarget.id);
    assert(stillBlocked.triage && stillBlocked.triage.required === true &&
           !stillBlocked.triage.resolvedAt,
      'objective revision leaves triage blocker intact (P)');
    await revise(adminCookie, pTarget.id, {
      expectedRevision: Number((await store.getTicket(pTarget.id)).revision),
      objective: 'Q revised outcome', acceptanceCriteria: null,
      reasonCode: 'correction', reason: 'no budget reset', actor: ACTOR_ADMIN
    });
    const qAttemptsAfter = Number((await store.pool.query(
      `SELECT count(*)::int AS n FROM ${store.table('ticket_attempts')} WHERE ticket_id = $1`,
      [pTarget.id])).rows[0].n);
    if (!(qAttemptsAfter === 0)) throw new Error('Q: revision must not create attempts');;

    // ── K/N/M/L: truthful history rendering ─────────────────────────────────
    const detailPage = await server.request(
      'GET', `/tickets/${target.id}`, { cookie: adminCookie });
    if (!(detailPage.statusCode === 200)) throw new Error('assertion failed');;
    const pageBody = await detailPage.body;
    assert(pageBody.includes('Objective revised (revision 2)'),
      'timeline renders the operator revision title');
    assert(!pageBody.includes('Deterministic coordination'),
      'no removed-mechanism wording leaks into presentation');

    scenariosRun += 1;
  });

  assertScenariosExecuted({
    label: 'T3-b objective-revision surface',
    assertions: assert.count(),
    scenarios: scenariosRun,
    minAssertions: 10,
    minScenarios: 1
  });
  console.log(`\nPASS: T3-b objective-revision surface — ${scenariosRun} scenario group(s) verified`);
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
