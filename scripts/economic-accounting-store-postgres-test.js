#!/usr/bin/env node
'use strict';

// Tranche 4 PostgreSQL suite for the store-owned economic-accounting
// transactions.
//
// This proves the STORE's transactional behaviour: exact-request persistence,
// one-winner dispatch authority, concurrency under a shared account,
// idempotency, and recovery classification. Fixture pricing only; no provider,
// no network, no credentials.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { withHarness } = require('./postgres-test-harness');
const {
  buildEconomicAuthority,
  buildEconomicPolicy
} = require('../runtime/economic-authority-contract');
const {
  buildRoleRoutingDecision,
  buildRoleRoutingPolicy
} = require('../runtime/role-routing-contract');
const { buildPricingCatalog, findPricingEntry } = require('../runtime/model-pricing-catalog');
const {
  governedRequestBytes,
  prepareGovernedProviderRequest
} = require('../runtime/governed-provider-request-contract');
const {
  buildSettlementReceipt
} = require('../runtime/economic-settlement-receipt-contract');
const { buildOpenAiResponsesBody } = require('../runtime/provider-request-body');
const { hashCanonical } = require('../runtime/declared-work-contract');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');

const ACTOR = 'economic-accounting-store-postgres-test';
const STAMP = `${Date.now()}-${process.pid}`;
const WORKER_ROLE = 'structured_leaf_executor';
const OPENAI_ADAPTER = 'openai.responses.v1';
const SNAPSHOT = 'gpt-4o-mini-2024-07-18';
const ENDPOINT = 'https://api.openai.com/v1/responses';
const AT = '2026-08-01T00:00:00.000Z';
const CAP = 2_048;

// Illustrative fixture rates. NOT production authority.
function catalogOf(catalogId = 'fixture-catalog') {
  return buildPricingCatalog({
    catalogId,
    entries: [{
      provider: 'openai',
      model: SNAPSHOT,
      adapterId: OPENAI_ADAPTER,
      chargingUnit: 'token',
      inputMicroUsdPerMillionTokens: 150_000,
      outputMicroUsdPerMillionTokens: 600_000,
      requestMicroUsd: 0,
      boundMethod: 'model_context_window_ceiling'
    }]
  });
}

function ticketBody(group, objective, ownedOutputPaths, status = 'open') {
  const now = new Date().toISOString();
  return {
    objective,
    acceptanceCriteria: 'Review the explicit reports.',
    assignmentTargetType: 'group',
    assignmentTargetId: group.id,
    assignmentMode: 'allocated',
    ownedOutputPaths,
    targetRef: null,
    executionMode: 'agent',
    workflowId: null,
    workflowInput: null,
    capabilityType: 'directAction',
    capabilityId: 'agent-selected-actions',
    capabilityInput: null,
    executionPolicy: {
      mode: 'assisted', requireVerification: 'when_declared', autoRetry: false,
      maxAttempts: null, maxRuntimeMs: null, maxModelRequests: null,
      maxWorkspaceOperations: null, allowWorkspaceWrites: true,
      allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'owned_paths'
    },
    status,
    blockedReason: null,
    createdBy: ACTOR,
    changedBy: ACTOR,
    changedAt: now,
    createdAt: now,
    updatedAt: now
  };
}

function decisionOf(ticketId, runId) {
  const policy = buildRoleRoutingPolicy({
    policyId: 'routing-policy-1',
    rolePolicies: [{
      role: WORKER_ROLE,
      primaryRoute: { adapterId: OPENAI_ADAPTER, provider: 'openai', model: SNAPSHOT },
      fallbackRoute: null,
      authorizedFallbackReasons: []
    }]
  });
  return buildRoleRoutingDecision({
    policy,
    role: WORKER_ROLE,
    ticketId,
    subjectKind: 'run',
    subjectId: runId,
    actingAgentId: 12,
    decidedAt: AT
  });
}

function policyOf(catalog, authorizedMicroUsd = 500_000, maximumProviderRequests = 8) {
  return buildEconomicPolicy({
    policyId: 'economic-policy-1',
    role: WORKER_ROLE,
    authorizedMicroUsd,
    maximumProviderRequests,
    maximumOutputTokensPerRequest: CAP,
    pricingCatalogId: catalog.catalogId,
    pricingCatalogHash: catalog.catalogHash,
    fallbackLiabilityAuthorized: false,
    fallbackProviderRequests: 0,
    capturedAt: AT
  });
}

function entryOf(catalog) {
  return findPricingEntry(catalog, { provider: 'openai', model: SNAPSHOT });
}

function prepareOf({
  catalog, ticketId, runId, ordinal = 1, prompt = 'hello', authorizedMicroUsd = 500_000,
  maximumProviderRequests = 8
}) {
  const decision = decisionOf(ticketId, runId);
  const authority = buildEconomicAuthority({
    policy: policyOf(catalog, authorizedMicroUsd, maximumProviderRequests),
    routingDecision: decision,
    pricingCatalog: catalog,
    capturedAt: AT
  });
  const entry = findPricingEntry(catalog, { provider: 'openai', model: SNAPSHOT });
  const preparedRequest = prepareGovernedProviderRequest({
    routingDecision: decision,
    economicAuthority: authority,
    modelRequestOrdinal: ordinal,
    endpointIdentity: ENDPOINT,
    canonicalBody: buildOpenAiResponsesBody({
      model: SNAPSHOT,
      input: [{ role: 'user', content: prompt }],
      options: { governed: true, maxOutputTokens: CAP }
    }),
    authorizedOutputTokens: CAP,
    truncationMode: 'disabled',
    pricingEntryHash: hashCanonical(entry),
    maximumLiabilityMicroUsd: authority.maximumPerRequestMicroUsd,
    preparedAt: AT
  });
  return { decision, authority, preparedRequest, pricingEntry: entry };
}

async function code(promise, expected, why, { state = undefined } = {}) {
  await assert.rejects(() => promise, error => {
    assert.equal(error.code, expected, `${why} (got ${error.code}: ${error.message})`);
    if (state !== undefined) {
      // Recovery must be able to tell WHICH state blocked the transition. A
      // refusal that only says "no" cannot distinguish a reservation that never
      // started from one that was already charged.
      assert.equal(error.detail && error.detail.state, state,
        `${why} reports the blocking state`);
    }
    return true;
  }, why);
}

async function main() {
  await withHarness('economic accounting store PostgreSQL', async ({ store }) => {
    const catalog = catalogOf();

    const group = (await store.createGroup({
      value: { name: `Economics ${STAMP}`, permissions: [], canReceiveTickets: true },
      changedBy: ACTOR
    })).group;
    const worker = (await store.createConfiguredAgent({
      value: { name: `Worker ${STAMP}`, provider: 'openai', model: 'gpt-worker-test', apiKey: '' },
      groupIds: [group.id],
      changedBy: ACTOR
    })).agent;
    const ownedOutputPaths = { [worker.id]: 'reports/worker/' };

    const newTicketWithRuns = async (objective, runCount = 1) => {
      const ticket = (await store.createTicketWithEvent({
        ticket: ticketBody(group, `${objective} ${STAMP}`, ownedOutputPaths),
        eventPayload: { source: ACTOR }
      })).ticket;
      const started = await store.createRunsAndStartTicket({
        ticketId: ticket.id,
        runDrafts: Array.from({ length: runCount },
          () => ({ ticketId: ticket.id, agentId: worker.id }))
      });
      return { ticket, runIds: started.runs.map(run => run.id), runId: started.runs[0].id };
    };
    const newTicketWithRun = objective => newTicketWithRuns(objective, 1);

    // ── Account admission is idempotent, and policy changes refuse ──────────

    const { ticket, runId } = await newTicketWithRun('Account admission');
    const policy = policyOf(catalog);
    const admitted = await store.admitTicketEconomicAccount({
      ticketId: ticket.id, role: WORKER_ROLE, economicPolicy: policy
    });
    assert.equal(admitted.admitted, true, 'the account is admitted once');
    assert.equal(Number(admitted.account.authorized_micro_usd), 500_000);

    const readmitted = await store.admitTicketEconomicAccount({
      ticketId: ticket.id, role: WORKER_ROLE, economicPolicy: policy
    });
    assert.equal(readmitted.admitted, false,
      're-admitting the same policy is a no-op, not a second authorization');
    assert.equal(Number(readmitted.account.id), Number(admitted.account.id));

    await code(
      store.admitTicketEconomicAccount({
        ticketId: ticket.id, role: WORKER_ROLE,
        economicPolicy: policyOf(catalog, 999_999)
      }),
      'ECONOMIC_POLICY_CONFLICT',
      'a different policy cannot silently re-authorize an account with live reservations');

    // ── Exact-request persistence ──────────────────────────────────────────

    const { preparedRequest, authority } = prepareOf({
      catalog, ticketId: ticket.id, runId
    });
    const reservation = await store.reserveEconomicRequest({
      preparedRequest, economicAuthority: authority, pricingEntry: entryOf(catalog)
    });
    assert.equal(reservation.state, 'reserved');
    assert.equal(reservation.exactRequestHash, preparedRequest.requestHash);

    // THE POINT: the bytes themselves survive, not merely a hash of them.
    const expectedBytes = governedRequestBytes(preparedRequest).serializedRequest;
    assert.equal(reservation.serializedRequest, expectedBytes,
      'the exact serialized request is durably persisted');
    assert.equal(reservation.serializedRequestByteCount,
      Buffer.byteLength(expectedBytes, 'utf8'),
      'the persisted byte count matches the persisted bytes');
    assert.equal(reservation.preparedRequestHash, preparedRequest.preparedRequestHash);
    assert.equal(reservation.preparedRequest.requestHash, preparedRequest.requestHash,
      'the complete prepared request is recoverable from storage alone');

    // Reading it back in a FRESH read proves the bytes are in the database, not
    // in this process's memory.
    const reread = await store.getEconomicReservation(reservation.id);
    assert.equal(reread.serializedRequest, expectedBytes,
      'a process that lost its memory can still recover the authorized bytes');

    // The account reserved exactly the captured per-request maximum.
    const afterReserve = await store.pool.query(
      `SELECT * FROM ${store.table('ticket_economic_accounts')} WHERE id = $1`,
      [reservation.accountId]);
    assert.equal(Number(afterReserve.rows[0].reserved_micro_usd),
      authority.maximumPerRequestMicroUsd,
      'the reserve equals the captured per-request maximum');
    assert.equal(Number(afterReserve.rows[0].settled_micro_usd), 0);

    // ── Reservation idempotency ────────────────────────────────────────────

    await code(
      store.reserveEconomicRequest({
      preparedRequest, economicAuthority: authority, pricingEntry: entryOf(catalog)
    }),
      'ECONOMIC_RESERVATION_DUPLICATE',
      'the same subject cannot reserve the same request ordinal twice');
    const stillOne = await store.pool.query(
      `SELECT reserved_micro_usd FROM ${store.table('ticket_economic_accounts')} WHERE id = $1`,
      [reservation.accountId]);
    assert.equal(Number(stillOne.rows[0].reserved_micro_usd),
      authority.maximumPerRequestMicroUsd,
      'a refused duplicate reservation charges the account nothing');

    // ── One-winner dispatch authority ──────────────────────────────────────

    const contenders = await Promise.allSettled([
      store.markEconomicRequestStarted({ reservationId: reservation.id }),
      store.markEconomicRequestStarted({ reservationId: reservation.id }),
      store.markEconomicRequestStarted({ reservationId: reservation.id }),
      store.markEconomicRequestStarted({ reservationId: reservation.id })
    ]);
    const winners = contenders.filter(result => result.status === 'fulfilled');
    assert.equal(winners.length, 1,
      'exactly one concurrent caller receives dispatch authority');
    for (const loser of contenders.filter(result => result.status === 'rejected')) {
      assert.equal(loser.reason.code, 'ECONOMIC_REQUEST_ALREADY_STARTED',
        'every other caller is refused with the one-winner code');
    }
    assert.equal(winners[0].value.serializedRequest, expectedBytes,
      'the winner receives the bytes that were priced, from storage');

    const startEvents = (await store.listTicketEvents(ticket.id)).events
      .filter(event => event.type === 'ticket.economic_request_started');
    assert.equal(startEvents.length, 1,
      'exactly one start is journalled, matching the single winner');
    assert.equal(Object.prototype.hasOwnProperty.call(startEvents[0].payload, 'serializedRequest'),
      false, 'the journal carries identities and hashes, never the request body');
    assert.equal(startEvents[0].payload.exactRequestHash, preparedRequest.requestHash);

    // A started request can never be released.
    await code(
      store.releaseUndispatchedEconomicReservation({
        reservationId: reservation.id, reason: 'operator_cancelled'
      }),
      'ECONOMIC_RESERVATION_NOT_RELEASABLE',
      'a started request may have reached the provider and can never be released',
      { state: 'request_started' });

    // ── Corrupted bytes never reach a provider ─────────────────────────────
    //
    // The reserved hash is the authority; the stored bytes are the payload. If
    // storage ever returns bytes that disagree with the hash they were priced
    // under, dispatch must refuse rather than send something nobody authorized.

    const corrupt = await newTicketWithRun('Corrupt bytes');
    await store.admitTicketEconomicAccount({
      ticketId: corrupt.ticket.id, role: WORKER_ROLE, economicPolicy: policy
    });
    const corruptPrepared = prepareOf({
      catalog, ticketId: corrupt.ticket.id, runId: corrupt.runId
    });
    const corruptReservation = await store.reserveEconomicRequest({
      preparedRequest: corruptPrepared.preparedRequest,
      economicAuthority: corruptPrepared.authority,
      pricingEntry: corruptPrepared.pricingEntry
    });
    const tampered = JSON.stringify({ tampered: true, padding: 'x'.repeat(64) });
    await store.pool.query(
      `UPDATE ${store.table('economic_request_reservations')}
       SET serialized_request = $2, serialized_request_byte_count = octet_length($2),
           revision = revision + 1
       WHERE id = $1`,
      [corruptReservation.id, tampered]
    );
    await code(
      store.markEconomicRequestStarted({ reservationId: corruptReservation.id }),
      'ECONOMIC_REQUEST_BYTES_CORRUPT',
      'bytes that disagree with the reserved hash are refused before dispatch');

    // ── Response persistence and settlement ────────────────────────────────

    const responseIdentity = 'resp_fixture_0001';
    const responseHash = hashCanonical({ response: responseIdentity });
    const persisted = await store.markEconomicResponsePersisted({
      reservationId: reservation.id, responseIdentity, responseHash
    });
    assert.equal(persisted.state, 'response_persisted');
    assert.equal(persisted.responseHash, responseHash);

    const receipt = buildSettlementReceipt({
      preparedRequest,
      authority,
      pricingCatalog: catalog,
      reservedMaximumMicroUsd: reservation.reservedMaxMicroUsd,
      responseIdentity,
      responseHash,
      usage: { source: 'provider_reported', inputTokens: 1_000, outputTokens: 500 },
      settledAt: AT
    });
    assert.equal(receipt.settledMicroUsd, 450);

    const settled = await store.settleEconomicRequest({
      reservationId: reservation.id,
      usage: { source: 'provider_reported', inputTokens: 1_000, outputTokens: 500 }
    });
    assert.equal(settled.state, 'settled');
    assert.equal(settled.settledMicroUsd, 450);

    const afterSettle = await store.pool.query(
      `SELECT * FROM ${store.table('ticket_economic_accounts')} WHERE id = $1`,
      [reservation.accountId]);
    assert.equal(Number(afterSettle.rows[0].reserved_micro_usd), 0,
      'settlement releases the whole reserve');
    assert.equal(Number(afterSettle.rows[0].settled_micro_usd), 450,
      'settlement charges only the actual cost');

    // Settling twice is refused, so one dispatch is never charged twice.
    await code(
      store.settleEconomicRequest({
        reservationId: reservation.id,
        usage: { source: 'provider_reported', inputTokens: 1_000, outputTokens: 500 }
      }),
      'ECONOMIC_RESERVATION_ALREADY_SETTLED',
      'a settled reservation cannot be settled again');
    const afterDouble = await store.pool.query(
      `SELECT settled_micro_usd FROM ${store.table('ticket_economic_accounts')} WHERE id = $1`,
      [reservation.accountId]);
    assert.equal(Number(afterDouble.rows[0].settled_micro_usd), 450,
      'a refused double settlement charges nothing further');

    // ── A receipt for other bytes cannot close a reservation ───────────────

    const second = await newTicketWithRun('Foreign receipt');
    await store.admitTicketEconomicAccount({
      ticketId: second.ticket.id, role: WORKER_ROLE, economicPolicy: policy
    });
    const foreign = prepareOf({
      catalog, ticketId: second.ticket.id, runId: second.runId, prompt: 'a different prompt'
    });
    const foreignReservation = await store.reserveEconomicRequest({
      preparedRequest: foreign.preparedRequest, economicAuthority: foreign.authority,
      pricingEntry: foreign.pricingEntry
    });
    await store.markEconomicRequestStarted({ reservationId: foreignReservation.id });
    await store.markEconomicResponsePersisted({
      reservationId: foreignReservation.id, responseIdentity, responseHash
    });
    await code(
      store.settleEconomicRequest({
        reservationId: foreignReservation.id,
        usage: { source: 'provider_reported', inputTokens: 10, outputTokens: CAP + 1 }
      }),
      'SETTLEMENT_REFUSED',
      'usage exceeding the transmitted cap cannot close this reservation');
    const untouched = await store.getEconomicReservation(foreignReservation.id);
    assert.equal(untouched.state, 'response_persisted',
      'the refused settlement left the reservation open');

    // A conservative settlement closes it: the response was persisted, but its
    // usage is unknown, so the FULL reserve is charged.
    const conservativelySettled = await store.settleEconomicRequest({
      reservationId: foreignReservation.id,
      usage: { source: 'authorized_maximum_assumed' }
    });
    assert.equal(conservativelySettled.settledMicroUsd,
      foreignReservation.reservedMaxMicroUsd,
      'an unmetered response settles the full reserve, never zero');

    // ── Concurrency against one shared account ─────────────────────────────
    //
    // Sibling workers contend for one role account. The authority is set so that
    // exactly two of four concurrent reservations can fit.

    // Sibling worker Runs share ONE role account. Each Run carries its own
    // economic authority under the same policy, so oversubscription is a
    // cross-subject condition — which is exactly how it arises in practice.
    const shared = await newTicketWithRuns('Shared account', 4);
    const perRequest = prepareOf({
      catalog, ticketId: shared.ticket.id, runId: shared.runId
    }).authority.maximumPerRequestMicroUsd;
    // Room for exactly two of the four siblings.
    const sharedAuthorized = perRequest * 2;
    await store.admitTicketEconomicAccount({
      ticketId: shared.ticket.id,
      role: WORKER_ROLE,
      economicPolicy: policyOf(catalog, sharedAuthorized, 2)
    });
    const attempts = await Promise.allSettled(shared.runIds.map(siblingRunId => {
      const prepared = prepareOf({
        catalog,
        ticketId: shared.ticket.id,
        runId: siblingRunId,
        authorizedMicroUsd: sharedAuthorized,
        maximumProviderRequests: 2
      });
      return store.reserveEconomicRequest({
        preparedRequest: prepared.preparedRequest,
        economicAuthority: prepared.authority,
        pricingEntry: prepared.pricingEntry
      });
    }));
    const accepted = attempts.filter(result => result.status === 'fulfilled');
    assert.equal(accepted.length, 2,
      'exactly as many concurrent sibling reservations are admitted as the account authorizes');
    for (const refused of attempts.filter(result => result.status === 'rejected')) {
      assert.equal(refused.reason.code, 'ECONOMIC_AUTHORITY_EXCEEDED',
        'over-authority reservations are governed refusals, not constraint violations');
    }
    const sharedAccount = await store.pool.query(
      `SELECT * FROM ${store.table('ticket_economic_accounts')}
       WHERE ticket_id = $1 AND role = $2`,
      [shared.ticket.id, WORKER_ROLE]);
    assert.equal(Number(sharedAccount.rows[0].reserved_micro_usd), sharedAuthorized,
      'the account is fully reserved and never oversubscribed');
    assert.ok(
      Number(sharedAccount.rows[0].reserved_micro_usd) +
      Number(sharedAccount.rows[0].settled_micro_usd) <=
      Number(sharedAccount.rows[0].authorized_micro_usd),
      'reserved plus settled never exceeds authorized');

    // ── Release restores authority ─────────────────────────────────────────

    const releasable = accepted[0].value;
    const released = await store.releaseUndispatchedEconomicReservation({
      reservationId: releasable.id, reason: 'preflight_refused'
    });
    assert.equal(released.state, 'released');
    const afterRelease = await store.pool.query(
      `SELECT reserved_micro_usd FROM ${store.table('ticket_economic_accounts')}
       WHERE ticket_id = $1 AND role = $2`,
      [shared.ticket.id, WORKER_ROLE]);
    assert.equal(Number(afterRelease.rows[0].reserved_micro_usd), perRequest,
      'releasing an undispatched reservation returns its authority in full');
    await code(
      store.releaseUndispatchedEconomicReservation({
        reservationId: releasable.id, reason: 'preflight_refused'
      }),
      'ECONOMIC_RESERVATION_NOT_RELEASABLE',
      'a released reservation cannot be released twice');

    // ── Recovery classification ────────────────────────────────────────────

    const recovery = await newTicketWithRun('Recovery classification');
    await store.admitTicketEconomicAccount({
      ticketId: recovery.ticket.id, role: WORKER_ROLE, economicPolicy: policy
    });
    const never = prepareOf({ catalog, ticketId: recovery.ticket.id, runId: recovery.runId,
      ordinal: 1 });
    const uncertain = prepareOf({ catalog, ticketId: recovery.ticket.id, runId: recovery.runId,
      ordinal: 2 });
    const awaiting = prepareOf({ catalog, ticketId: recovery.ticket.id, runId: recovery.runId,
      ordinal: 3 });
    const neverRow = await store.reserveEconomicRequest({
      preparedRequest: never.preparedRequest, economicAuthority: never.authority,
      pricingEntry: never.pricingEntry });
    const uncertainRow = await store.reserveEconomicRequest({
      preparedRequest: uncertain.preparedRequest, economicAuthority: uncertain.authority,
      pricingEntry: uncertain.pricingEntry });
    const awaitingRow = await store.reserveEconomicRequest({
      preparedRequest: awaiting.preparedRequest, economicAuthority: awaiting.authority,
      pricingEntry: awaiting.pricingEntry });
    await store.markEconomicRequestStarted({ reservationId: uncertainRow.id });
    await store.markEconomicRequestStarted({ reservationId: awaitingRow.id });
    await store.markEconomicResponsePersisted({
      reservationId: awaitingRow.id, responseIdentity, responseHash });

    const recoverable = await store.listRecoverableEconomicReservations({
      ticketId: recovery.ticket.id, role: WORKER_ROLE
    });
    const byId = new Map(recoverable.map(row => [row.id, row]));
    assert.equal(byId.get(neverRow.id).classification, 'never_dispatched');
    assert.equal(byId.get(neverRow.id).releasable, true,
      'a reservation that provably never reached a provider may be released');
    assert.equal(byId.get(uncertainRow.id).classification, 'dispatch_uncertain');
    assert.equal(byId.get(uncertainRow.id).releasable, false,
      'a started request must settle, never be released');
    assert.equal(byId.get(awaitingRow.id).classification, 'awaiting_settlement');
    assert.equal(byId.get(awaitingRow.id).releasable, false);

    // Recovery CLASSIFIES; it does not act. Nothing moved.
    for (const [id, expected] of [[neverRow.id, 'reserved'], [uncertainRow.id, 'request_started'],
      [awaitingRow.id, 'response_persisted']]) {
      assert.equal((await store.getEconomicReservation(id)).state, expected,
        'listing recoverable reservations changes no state');
    }
    // Every recoverable reservation still carries its authorized bytes, which is
    // what makes recovery possible without caller memory.
    for (const row of recoverable) {
      assert.equal(typeof row.serializedRequest, 'string');
      assert.ok(row.serializedRequest.length > 0,
        'a recoverable reservation retains the bytes it authorized');
      assert.equal(
        crypto.createHash('sha256').update(Buffer.from(row.serializedRequest, 'utf8'))
          .digest('hex'),
        row.exactRequestHash,
        'the recovered bytes hash to the reserved request hash');
    }

    // Settled and released reservations are not recoverable work.
    const closed = await store.listRecoverableEconomicReservations({ ticketId: ticket.id });
    assert.equal(closed.length, 0, 'a settled reservation is not recoverable work');

    // ── Settlement runs on durable captured facts alone ────────────────────
    //
    // Everything below settles requests reserved under `catalog`, while the
    // catalog itself drifts, disappears, or is replaced by the caller. None of
    // it may change what an already-reserved request costs.

    const basisTicket = await newTicketWithRuns('Captured basis', 4);
    await store.admitTicketEconomicAccount({
      ticketId: basisTicket.ticket.id, role: WORKER_ROLE, economicPolicy: policy
    });
    const basisReservation = async runIndex => {
      const prepared = prepareOf({
        catalog, ticketId: basisTicket.ticket.id, runId: basisTicket.runIds[runIndex]
      });
      const row = await store.reserveEconomicRequest({
        preparedRequest: prepared.preparedRequest,
        economicAuthority: prepared.authority,
        pricingEntry: prepared.pricingEntry
      });
      await store.markEconomicRequestStarted({ reservationId: row.id });
      await store.markEconomicResponsePersisted({
        reservationId: row.id, responseIdentity, responseHash });
      return row;
    };

    // The reservation retains the complete authority and the exact entry.
    const driftRow = await basisReservation(0);
    assert.equal(typeof driftRow.economicAuthority, 'object',
      'the complete normalized economic authority is durably retained');
    assert.equal(typeof driftRow.pricingEntrySnapshot, 'object',
      'the exact pricing entry is durably retained');
    assert.equal(hashCanonical(driftRow.pricingEntrySnapshot),
      driftRow.pricingEntryHash,
      'the stored entry hashes to the identity it was reserved under');
    for (const rule of ['inputMicroUsdPerMillionTokens', 'outputMicroUsdPerMillionTokens',
      'requestMicroUsd', 'chargingUnit', 'boundMethod']) {
      assert.ok(driftRow.pricingEntrySnapshot[rule] !== undefined,
        `the stored basis preserves ${rule}`);
    }

    // Catalog drift: the administrator re-prices tenfold. Settlement is
    // unaffected, because the current catalog is never consulted.
    const drifted = buildPricingCatalog({
      catalogId: 'fixture-catalog',
      entries: [{
        provider: 'openai', model: SNAPSHOT, adapterId: OPENAI_ADAPTER, chargingUnit: 'token',
        inputMicroUsdPerMillionTokens: 1_500_000,
        outputMicroUsdPerMillionTokens: 6_000_000,
        requestMicroUsd: 0, boundMethod: 'model_context_window_ceiling'
      }]
    });
    assert.notEqual(drifted.catalogHash, catalog.catalogHash, 'the fixture catalog really drifted');
    const driftSettled = await store.settleEconomicRequest({
      reservationId: driftRow.id,
      usage: { source: 'provider_reported', inputTokens: 1_000, outputTokens: 500 },
      // Deliberately smuggled: there is no parameter that accepts rates, so a
      // caller-supplied replacement catalog changes nothing.
      pricingCatalog: drifted,
      pricingEntry: drifted.entries[0]
    });
    assert.equal(driftSettled.settledMicroUsd, 450,
      'settlement uses the captured rates, not the drifted catalog or caller-supplied rates');

    // Catalog deletion: nothing in the process still holds a catalog, and
    // settlement proceeds anyway.
    const deletedRow = await basisReservation(1);
    const deletedSettled = await store.settleEconomicRequest({
      reservationId: deletedRow.id,
      usage: { source: 'provider_reported', inputTokens: 1_000, outputTokens: 500 }
    });
    assert.equal(deletedSettled.settledMicroUsd, 450,
      'deleting current catalog configuration cannot prevent settlement');

    // Restart: a brand-new store instance with no memory of this process
    // settles from the row alone.
    const restarted = new PostgresRuntimeStore({
      connectionString: process.env.TEST_DATABASE_URL, schema: store.schema
    });
    try {
      const restartRow = await basisReservation(2);
      const restartSettled = await restarted.settleEconomicRequest({
        reservationId: restartRow.id,
        usage: { source: 'provider_reported', inputTokens: 1_000, outputTokens: 500 }
      });
      assert.equal(restartSettled.settledMicroUsd, 450,
        'a restarted process settles from durable captured facts alone');
      assert.equal(restartSettled.settlementReceipt.pricingEntryHash,
        restartRow.pricingEntryHash,
        'the restarted settlement is bound to the captured entry');
    } finally {
      await restarted.close();
    }

    // Tampered stored pricing refuses rather than settling at rates nobody
    // authorized.
    const tamperedRow = await basisReservation(3);
    await store.pool.query(
      `UPDATE ${store.table('economic_request_reservations')}
       SET pricing_entry_snapshot = jsonb_set(pricing_entry_snapshot,
             '{outputMicroUsdPerMillionTokens}', '1'),
           revision = revision + 1
       WHERE id = $1`,
      [tamperedRow.id]
    );
    await code(
      store.settleEconomicRequest({
        reservationId: tamperedRow.id,
        usage: { source: 'provider_reported', inputTokens: 1_000, outputTokens: 500 }
      }),
      'SETTLEMENT_REFUSED',
      'tampered stored pricing refuses instead of settling');
    assert.equal((await store.getEconomicReservation(tamperedRow.id)).state,
      'response_persisted', 'the refused settlement charged nothing');

    // ── Terminal states reject further transitions ─────────────────────────

    // A reservation that never started has no provider liability, so settling it
    // must be refused as a state conflict rather than reported as an already
    // charged request.
    await code(
      store.settleEconomicRequest({
        reservationId: neverRow.id,
        usage: { source: 'provider_reported', inputTokens: 1, outputTokens: 1 }
      }),
      'ECONOMIC_RESERVATION_STATE_CONFLICT',
      'a reservation that never started cannot be settled',
      { state: 'reserved' });
    await code(
      store.settleEconomicRequest({
        reservationId: reservation.id, settlementReceipt: receipt, pricingCatalog: catalog
      }),
      'ECONOMIC_RESERVATION_ALREADY_SETTLED',
      'an already settled reservation reports that it was charged',
      { state: 'settled' });

    await code(
      store.markEconomicResponsePersisted({
        reservationId: neverRow.id, responseIdentity, responseHash
      }),
      'ECONOMIC_RESERVATION_STATE_CONFLICT',
      'a response cannot be persisted against a request that never started');
    await code(
      store.markEconomicRequestStarted({ reservationId: releasable.id }),
      'ECONOMIC_REQUEST_ALREADY_STARTED',
      'a released reservation can never be started');
  });
  console.log('economic accounting store PostgreSQL test passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
