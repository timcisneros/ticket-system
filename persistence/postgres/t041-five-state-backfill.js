'use strict';

// T2 Tranche 5 — migration 041 backfill/classification hook.
//
// Runs INSIDE the migration transaction BEFORE the 041 SQL file executes
// (same client, same transaction — the repository's 039 hook precedent).
// Sequence, mechanically compatible with store.migrate():
//
//   runner BEGIN (READ COMMITTED)
//   runner SET LOCAL search_path
//   THIS HOOK:
//     H1  LOCK TABLE <eight relations> IN SHARE ROW EXCLUSIVE MODE NOWAIT
//         (first statement; fail-fast — any conflicting writer aborts the
//          whole migration immediately instead of waiting into a cycle)
//     H2  load the locked seven-relation fact set
//     H3  classify EVERY Ticket through the amended pure contract
//     H4  build the complete DESIRED projection (status + cancellation
//         authority) and refuse any ambiguous/integrity-contradiction row
//     H5  record source digests into a TEMP identity table
//   041 SQL FILE consumes the projection, cuts over constraints/counters,
//   validates convergence; the runner then records the ledger row and COMMITS.
//
// Nothing outside the migration transaction is trusted: external report
// artifacts gate scheduling only, never data.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  classifyTicketHistory
} = require('../../runtime/ticket-history-classifier-contract');
const {
  normalizeCancellationAuthority
} = require('../../runtime/ticket-cancellation-authority-contract');

const ROOT = path.join(__dirname, '..', '..');

function sourceDigests() {
  // The FULL file-level relative-require closure of this hook's semantic
  // roots (scripts/t041-semantic-closure-test.js derives exactly this set by
  // walking require edges and refuses any drift). Binding the whole closure —
  // including modules whose current symbols sit outside the classification
  // path (declared-work, allocation-plan, authority-paths,
  // postcondition-criterion-evaluator) — is deliberate over-binding: it can
  // only widen drift detection, never narrow it.
  //   - this hook (classification + projection + authority reconstruction);
  //   - ticket-history-classifier-contract.js (EVERY-Ticket classification);
  //   - ticket-blocking-authority-composer.js (blocking authority + policy
  //     chain + refusal supersession shared with the live writers);
  //   - ticket-lifecycle-contract.js (canonical projection precedence);
  //   - ticket-attempt-completion-contract.js (attempt completion proof);
  //   - structured-allocation-leaf-run-contract.js (leaf binding/disposition
  //     derivation inside v2 completion reconstruction);
  //   - ticket-attempt-contract.js (deriveTicketAttemptDisposition — the
  //     aggregate disposition authority behind COMPLETED eligibility);
  //   - completion-decision-contract.js (COMPLETION_DISPOSITIONS legality in
  //     leaf decision evaluation);
  //   - declared-work-contract.js / allocation-plan-contract.js /
  //     authority-paths.js / postcondition-criterion-evaluator.js
  //     (contract-family siblings of the leaf-run module; symbol-inert on the
  //     classification path today, bound so they cannot become semantic
  //     without re-binding).
  // The 041 SQL embeds these digests as literals and refuses on drift, so no
  // semantic source can silently redefine what "running 041" means.
  const files = [
    path.join(__dirname, 't041-five-state-backfill.js'),
    path.join(ROOT, 'runtime', 'allocation-plan-contract.js'),
    path.join(ROOT, 'runtime', 'authority-paths.js'),
    path.join(ROOT, 'runtime', 'completion-decision-contract.js'),
    path.join(ROOT, 'runtime', 'declared-work-contract.js'),
    path.join(ROOT, 'runtime', 'postcondition-criterion-evaluator.js'),
    path.join(ROOT, 'runtime', 'structured-allocation-leaf-run-contract.js'),
    path.join(ROOT, 'runtime', 'ticket-attempt-completion-contract.js'),
    path.join(ROOT, 'runtime', 'ticket-attempt-contract.js'),
    path.join(ROOT, 'runtime', 'ticket-blocking-authority-composer.js'),
    path.join(ROOT, 'runtime', 'ticket-cancellation-authority-contract.js'),
    path.join(ROOT, 'runtime', 'ticket-history-classifier-contract.js'),
    path.join(ROOT, 'runtime', 'ticket-lifecycle-contract.js')
  ];
  return files.map(file => ({
    label: path.basename(file),
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  }));
}

function fail(message) {
  const error = new Error(`041_ticket_five_state_cutover: ${message}`);
  error.code = 'T041_BACKFILL_REFUSED';
  throw error;
}

async function inspectTicketFiveStateBackfill(store, { client } = {}) {
  if (!client) throw new Error('041 hook requires the migration transaction client');

  // H1 — fail-fast quiesce of the full read+write set. Listed order extends
  // the frozen protocol prefix (plans -> runs -> attempts -> tickets); every
  // remaining relation is one writers touch only after holding an
  // earlier-listed one.
  await client.query(`
    LOCK TABLE allocation_plans, runs, ticket_attempts, tickets,
               run_consequences, events, diagnostic_logs, runtime_status_counts
    IN SHARE ROW EXCLUSIVE MODE NOWAIT
  `);

  // H2 — locked fact set (mirrors scripts/t2-five-state-classifier.js).
  const table = name => `${store.schema}.${name}`;
  const tickets = (await client.query(
    `SELECT id, status, cancellation_authority, body, created_at, updated_at
     FROM ${table('tickets')} ORDER BY id`)).rows;
  const attempts = (await client.query(
    `SELECT id, ticket_id, ordinal, member_count, disposition, admitted_at, settled_at
     FROM ${table('ticket_attempts')} ORDER BY ticket_id, ordinal`)).rows;
  const runs = (await client.query(
    `SELECT id, ticket_id, ticket_attempt_id, status, body, created_at, completed_at
     FROM ${table('runs')} ORDER BY ticket_id, id`)).rows;
  const consequences = (await client.query(
    `SELECT run_id, ticket_id, consequence, recorded_at
     FROM ${table('run_consequences')} ORDER BY ticket_id, run_id`)).rows;
  const plans = (await client.query(
    `SELECT id, ticket_id, status, body, revision, created_at, updated_at
     FROM ${table('allocation_plans')} ORDER BY ticket_id, id`)).rows;
  const events = (await client.query(
    `SELECT id, position, ticket_id, run_id, type, ts, payload
     FROM ${table('events')} ORDER BY position`)).rows;
  const logs = (await client.query(
    `SELECT id, ticket_id, run_id, context_ticket_id, context_run_id, type, occurred_at, body
     FROM ${table('diagnostic_logs')} ORDER BY id`)).rows;

  // Run-counter baseline: Q5 must not disturb run counters at all; Q8 proves it.
  await client.query(`
    -- Snapshot the ACTUAL run counter rows (including zero-count leftovers
    -- maintained historically by the trigger) so the SQL validation can prove
    -- none of them moved.
    CREATE TEMP TABLE t041_run_counter_baseline ON COMMIT DROP AS
    SELECT status, shard, count
    FROM ${table('runtime_status_counts')}
    WHERE entity_type = 'run'
  `);

  const iso = value => new Date(value).toISOString();
  const ms = value => (value === null || value === undefined ? null : new Date(value).getTime());

  // H3/H4 — classify EVERY Ticket; derive the DESIRED post-migration row.
  await client.query(`
    CREATE TEMP TABLE t041_ticket_lifecycle_projection (
      ticket_id BIGINT PRIMARY KEY,
      desired_status TEXT NOT NULL,
      desired_cancellation_authority JSONB,
      classification TEXT NOT NULL,
      closed_classification TEXT,
      authority_references JSONB NOT NULL,
      reasons JSONB NOT NULL
    ) ON COMMIT DROP
  `);

  for (const ticketRow of tickets) {
    const ticketId = Number(ticketRow.id);
    const ticketFacts = {
      id: ticketId,
      status: ticketRow.status,
      body: ticketRow.body || {},
      createdAt: iso(ticketRow.created_at),
      updatedAt: iso(ticketRow.updated_at),
      cancellationAuthority: ticketRow.cancellation_authority || null
    };
    let result;
    try {
      result = classifyTicketHistory({
        ticket: ticketFacts,
        attempts: attempts.filter(row => Number(row.ticket_id) === ticketId).map(row => ({
          id: Number(row.id),
          ordinal: Number(row.ordinal),
          memberCount: Number(row.member_count),
          disposition: row.disposition,
          admittedAt: ms(row.admitted_at),
          settledAt: ms(row.settled_at)
        })),
        runs: runs.filter(row => Number(row.ticket_id) === ticketId).map(row => ({
          id: Number(row.id),
          ticketAttemptId: Number(row.ticket_attempt_id),
          status: row.status,
          body: row.body || {},
          createdAt: iso(row.created_at),
          completedAt: row.completed_at ? iso(row.completed_at) : null,
          updatedAt: row.completed_at ? iso(row.completed_at) : iso(row.created_at)
        })),
        consequences: consequences.filter(row => Number(row.ticket_id) === ticketId).map(row => ({
          runId: Number(row.run_id),
          recordedAt: ms(row.recorded_at),
          consequence: row.consequence || {}
        })),
        plans: plans.filter(row => Number(row.ticket_id) === ticketId).map(row => ({
          id: Number(row.id),
          status: row.status,
          body: row.body || {},
          createdAt: iso(row.created_at)
        })),
        events: events.filter(row => Number(row.ticket_id) === ticketId).map(row => ({
          id: String(row.id),
          position: Number(row.position),
          type: row.type,
          ts: iso(row.ts),
          payload: row.payload || {},
          ticketId: Number(row.ticket_id),
          runId: row.run_id === null ? null : Number(row.run_id)
        })),
        logs: logs.filter(row => Number(row.ticket_id) === ticketId ||
          Number(row.context_ticket_id) === ticketId).map(row => ({
          id: String(row.id),
          ticketId: row.ticket_id === null ? null : Number(row.ticket_id),
          type: row.type,
          timestamp: row.occurred_at ? iso(row.occurred_at) : null,
          body: row.body || {}
        }))
      });
    } catch (error) {
      fail(`ticket ${ticketId} classification threw: ${error.code || ''} ${error.message}`);
    }
    if (result.classification !== 'migratable') {
      fail(
        `ticket ${ticketId} is ${result.classification} ` +
        `(legacyStatus=${result.legacyStatus}, ` +
        `reasons=${JSON.stringify(result.reasons)})`);
    }
    if (!LIFECYCLE_ALLOWED.has(result.proposedLifecycle)) {
      fail(`ticket ${ticketId} proposed lifecycle ${result.proposedLifecycle} is not canonical`);
    }

    // Desired cancellation authority:
    //   A. existing valid authority           -> preserve verbatim
    //   B. none + proven historical authority -> populate exact reconstruction
    //   C. neither                            -> NULL
    // A non-null existing authority is NEVER replaced or cleared.
    let desiredAuthority = null;
    if (ticketRow.cancellation_authority !== null && ticketRow.cancellation_authority !== undefined) {
      desiredAuthority = ticketRow.cancellation_authority;
      try {
        normalizeCancellationAuthority(desiredAuthority, { expectedTicketId: ticketId });
      } catch (error) {
        fail(`ticket ${ticketId} has malformed existing cancellation authority: ${error.message}`);
      }
      if (result.proposedLifecycle !== 'canceled') {
        fail(`ticket ${ticketId} owns cancellation authority but projects ${result.proposedLifecycle}`);
      }
    } else if (result.historicalCancellationAuthority) {
      desiredAuthority = result.historicalCancellationAuthority;
    }
    if ((result.proposedLifecycle === 'canceled') !== (desiredAuthority !== null)) {
      fail(`ticket ${ticketId}: canceled status and cancellation authority disagree`);
    }

    await client.query(
      `INSERT INTO t041_ticket_lifecycle_projection
         (ticket_id, desired_status, desired_cancellation_authority,
          classification, closed_classification, authority_references, reasons)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        ticketId,
        result.proposedLifecycle,
        desiredAuthority === null ? null : JSON.stringify(desiredAuthority),
        result.classification,
        result.closedClassification,
        JSON.stringify(result.authorityReferences || {}),
        JSON.stringify(result.reasons || [])
      ]
    );
  }

  // H5 — bind the exact source identities to this migration. The SQL file
  // embeds these digests as literals and refuses on drift; the ledger pins
  // the SQL bytes, so helper/contract drift cannot silently redefine 041.
  await client.query(`
    CREATE TEMP TABLE t041_identity (
      label TEXT PRIMARY KEY,
      actual_sha256 TEXT NOT NULL
    ) ON COMMIT DROP
  `);
  for (const digest of sourceDigests()) {
    await client.query(
      'INSERT INTO t041_identity (label, actual_sha256) VALUES ($1, $2)',
      [digest.label, digest.sha256]
    );
  }
}

const LIFECYCLE_ALLOWED = new Set(['open', 'in_progress', 'blocked', 'completed', 'canceled']);

module.exports = { inspectTicketFiveStateBackfill, sourceDigests };
