'use strict';

// T3 activation baseline — sanctioned migration-time establishment of
// objective-revision revision-1 authority for every pre-T3 Ticket.
//
// WHAT THIS IS. A present-day ACTIVATION FACT appended at its real event
// position with activation-time capturedAt: "at T3 activation, this Ticket's
// requested outcome was exactly this canonical content." It is explicitly NOT
// retroactive creation history — provenance `t3_activation_baseline` and the
// migration actor make that machine-distinguishable from `creation`.
//
// WHY EVENT APPEND IS TRUTHFUL HERE. The events table is append-only runtime
// authority; no earlier migration needed to record a PRESENT-TENSE system
// fact. The T3 baseline does: without it, pre-T3 Tickets would carry mutable
// projection with no durable intent identity and admission integrity could
// not exist. The mechanism is bounded to exactly this migration, this event
// type, this provenance — not a general backfill facility.
//
// ATOMICITY / CLASSIFICATION. Runs inside the canonical migration transaction
// (runner BEGIN -> hook -> SQL -> ledger -> COMMIT). The hook classifies EVERY
// Ticket BEFORE any mutation:
//   - objective absent ........ ACTIVATION PRECONDITION FAILURE — refused with
//     T042_OBJECTIVE_REVISION_BASELINE_REQUIRED. Objective-less Tickets are
//     valid pre-T3 legacy state, but T3 cannot truthfully fabricate requested-
//     outcome revision content for them; they are never skipped, repaired, or
//     left pointerless by a successful migration.
//   - present but noncanonical . refused (T042_BASELINE_REFUSED).
//   - pointer/event ambiguity .. refused (T042_BASELINE_REFUSED).
// Only after every Ticket is proven migratable does mutation proceed.
// Successful 042 therefore leaves EVERY Ticket with coherent revision
// authority; the runner's ledger row gates re-entry (a pointer/event-bearing
// database reaching this hook means out-of-band drift and refuses). Any
// failure rolls back leaving zero partial baselines.
//
// GENERIC tickets.revision IS PRESERVED. Pointer installation materializes
// already-existing content under migration authority; it is not an
// operator-visible state change (mechanism precedent: migration 039's narrow
// runs_revision_guard suspension). tickets_revision_guard is disabled ONLY
// around the pointer UPDATE statements and restored + verified on the
// successful path before COMMIT; any failure rolls the DDL back with the
// transaction.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  EVENT_TYPE,
  buildActivationBaselinePayload,
  normalizeRevisionEventPayload,
  validatePointer,
  canonicalObjective,
  canonicalAcceptanceCriteria
} = require('../../runtime/ticket-objective-revision-contract');

const ROOT = path.join(__dirname, '..', '..');
const MIGRATION_ACTOR = 'migration:042_objective_revision_baseline';
const BASELINE_REQUIRED_CODE = 'T042_OBJECTIVE_REVISION_BASELINE_REQUIRED';
const MAX_LISTED_FAILURES = 20;

function refuse(detail, code = 'T042_BASELINE_REFUSED') {
  const error = new Error(`042_objective_revision_baseline refused: ${detail}`);
  error.code = code;
  throw error;
}

// Source-identity authority for this migration's semantic surface. The SQL
// file pins these digests as literals and fails closed on drift.
function sourceDigests() {
  const files = [
    path.join(__dirname, 't042-objective-revision-baseline.js'),
    path.join(ROOT, 'runtime', 'ticket-objective-revision-contract.js'),
    path.join(ROOT, 'runtime', 'declared-work-contract.js')
  ];
  return files.map(file => ({
    label: path.basename(file),
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  }));
}

async function inspectObjectiveRevisionBaseline(store, { client } = {}) {
  if (!client) throw new Error('042 baseline requires the migration transaction client');
  const ticketsTable = store.table('tickets');
  const eventsTable = store.table('events');

  // Source-identity binding: drift in this hook or its normalization/hashing
  // authority cannot silently redefine what "activation baseline" means.
  await client.query(`
    CREATE TEMP TABLE t042_identity (
      label TEXT PRIMARY KEY,
      actual_sha256 TEXT NOT NULL
    ) ON COMMIT DROP
  `);
  for (const digest of sourceDigests()) {
    await client.query(
      'INSERT INTO t042_identity (label, actual_sha256) VALUES ($1, $2)',
      [digest.label, digest.sha256]
    );
  }

  const allTickets = (await client.query(
    `SELECT id, body FROM ${ticketsTable} ORDER BY id`
  )).rows;

  const existingEvents = (await client.query(
    `SELECT ticket_id, count(*)::bigint AS n
       FROM ${eventsTable}
      WHERE type = $1
      GROUP BY ticket_id`,
    [EVENT_TYPE]
  )).rows;
  const eventCountByTicket = new Map(existingEvents.map(row =>
    [Number(row.ticket_id), Number(row.n)]));

  // No Ticket may carry partial T3 state before activation.
  for (const row of allTickets) {
    const body = row.body || {};
    if (body.objectiveRevision !== undefined && body.objectiveRevision !== null) {
      refuse(`ticket ${row.id} already carries an objectiveRevision projection pointer`);
    }
    if (eventCountByTicket.has(Number(row.id))) {
      refuse(`ticket ${row.id} already carries ${eventCountByTicket.get(Number(row.id))} objective-revision event(s)`);
    }
  }

  // EVERY-Ticket classification BEFORE any mutation. Deterministic order
  // (ascending id). One normalized classification result per Ticket drives
  // both the refusal report and the later mutation/convergence passes.
  //
  //   A. canonical requested-outcome objective exists -> baseline candidate.
  //   B. objective absent -> ACTIVATION PRECONDITION FAILURE (refuses the
  //      whole activation: T3 cannot truthfully fabricate revision content).
  //   C. present but noncanonical/malformed -> refused.
  //   D. unexpected pointer/event history -> refused.
  const failures = [];
  const baselines = [];
  for (const row of allTickets) {
    const ticketId = Number(row.id);
    const body = row.body || {};
    if (body.objectiveRevision !== undefined && body.objectiveRevision !== null) {
      failures.push({ ticketId, class: 'D', detail: 'unexpected objectiveRevision projection pointer' });
    }
    if (eventCountByTicket.has(ticketId)) {
      failures.push({
        ticketId,
        class: 'D',
        detail: `unexpected objective-revision event history (${eventCountByTicket.get(ticketId)} event(s))`
      });
    }
    const hasObjectiveKey = Object.prototype.hasOwnProperty.call(body, 'objective');
    if (!hasObjectiveKey || body.objective === null || body.objective === undefined) {
      // Valid pre-T3 legacy state — but an ACTIVATION PRECONDITION failure:
      // T3 cannot truthfully establish revision authority for content that
      // does not exist. Never skipped; never repaired; never left pointerless.
      failures.push({ ticketId, class: 'B', detail: 'requested-outcome objective absent' });
      continue;
    }
    const hasCriteriaKey = Object.prototype.hasOwnProperty.call(body, 'acceptanceCriteria');
    const rawCriteria = hasCriteriaKey ? body.acceptanceCriteria : null;
    let canonical;
    try {
      canonical = {
        objective: canonicalObjective(body.objective),
        acceptanceCriteria: canonicalAcceptanceCriteria(rawCriteria)
      };
    } catch (error) {
      failures.push({ ticketId, class: 'C', detail: error.message });
      continue;
    }
    if (body.objective !== canonical.objective) {
      failures.push({ ticketId, class: 'C', detail: 'objective is not canonically trimmed' });
      continue;
    }
    if (rawCriteria !== null && rawCriteria !== canonical.acceptanceCriteria) {
      failures.push({
        ticketId,
        class: 'C',
        detail: 'acceptanceCriteria is not canonically normalized'
      });
      continue;
    }
    baselines.push({
      ticketId,
      content: canonical,
      payload: buildActivationBaselinePayload({
        objective: canonical.objective,
        acceptanceCriteria: canonical.acceptanceCriteria,
        actor: MIGRATION_ACTOR,
        capturedAt: new Date()
      })
    });
  }

  if (failures.length > 0) {
    const listed = failures.slice(0, MAX_LISTED_FAILURES)
      .map(item => `ticket ${item.ticketId}: ${item.detail}`)
      .join('; ');
    const suffix = failures.length > MAX_LISTED_FAILURES
      ? ` (+${failures.length - MAX_LISTED_FAILURES} more)`
      : '';
    const preconditionFailures = failures.filter(item => item.class === 'B').length;
    refuse(
      `activation precondition failed for ${failures.length} Ticket(s): ${listed}${suffix}` +
      ` [precondition(absent-objective)=${preconditionFailures}]` +
      ' — zero mutations occurred; resolve under separate authority before T3 activation',
      failures.some(item => item.class === 'B')
        ? BASELINE_REQUIRED_CODE
        : 'T042_BASELINE_REFUSED'
    );
  }

  // Re-entry through the runner cannot occur after a successful application
  // (the ledger gates 042). Zero candidates with zero failures therefore
  // means activation over an empty database.
  if (baselines.length === 0) return { established: 0 };

  // Generic revisions unchanged by baseline installation.
  const revisionsBefore = (await client.query(
    `SELECT id, revision FROM ${ticketsTable} ORDER BY id`
  )).rows;

  await client.query('ALTER TABLE tickets DISABLE TRIGGER tickets_revision_guard');
  let guardRestored = false;
  try {
    for (const baseline of baselines) {
      // Re-validate through the contract authority immediately before write:
      // hashes BIND stored canonical content.
      const validated = normalizeRevisionEventPayload(baseline.payload);
      await client.query(
        `INSERT INTO ${eventsTable}
           (id, schema_version, ts, type, ticket_id, payload)
         VALUES (md5(random()::text || clock_timestamp()::text)::uuid, 1,
                 clock_timestamp(), $1, $2, $3::jsonb)`,
        [EVENT_TYPE, baseline.ticketId, JSON.stringify(validated)]
      );
      await client.query(
        `UPDATE ${ticketsTable}
            SET body = jsonb_set(body, '{objectiveRevision}', $2::jsonb, true)
          WHERE id = $1`,
        [baseline.ticketId, JSON.stringify({
          number: validated.number,
          hash: validated.contentHash
        })]
      );
    }
    await client.query('ALTER TABLE tickets ENABLE TRIGGER tickets_revision_guard');
    guardRestored = true;
  } finally {
    if (!guardRestored) {
      await client.query('ALTER TABLE tickets ENABLE TRIGGER tickets_revision_guard');
    }
  }

  // Restoration proof: the guard must be origin-enabled again.
  const disabledGuards = (await client.query(
    `SELECT count(*)::int AS n FROM pg_trigger
      WHERE tgname = 'tickets_revision_guard'
        AND tgrelid = 'tickets'::regclass
        AND tgenabled <> 'O'`
  )).rows[0].n;
  if (disabledGuards !== 0) refuse('tickets_revision_guard was not restored');

  // Generic revisions unchanged by baseline installation.
  const revisionsAfter = (await client.query(
    `SELECT id, revision FROM ${ticketsTable} ORDER BY id`
  )).rows;
  const beforeById = new Map(revisionsBefore.map(row => [Number(row.id), Number(row.revision)]));
  for (const row of revisionsAfter) {
    if (beforeById.get(Number(row.id)) !== Number(row.revision)) {
      refuse(`ticket ${row.id} generic revision moved during baseline installation`);
    }
  }

  // Convergence: every Ticket carries exactly one baseline event whose
  // number/hash equal its projection pointer.
  for (const row of allTickets) {
    const body = (await client.query(
      `SELECT body FROM ${ticketsTable} WHERE id = $1`, [row.id])).rows[0].body;
    const pointer = validatePointer((body || {}).objectiveRevision);
    const head = (await client.query(
      `SELECT payload FROM ${eventsTable}
        WHERE ticket_id = $1 AND type = $2
        ORDER BY position DESC LIMIT 1`, [row.id, EVENT_TYPE])).rows[0];
    const payload = normalizeRevisionEventPayload(head.payload);
    if (pointer.number !== payload.number || pointer.hash !== payload.contentHash) {
      refuse(`ticket ${row.id} pointer/head divergence after baseline installation`);
    }
    if (payload.provenance !== 't3_activation_baseline') {
      refuse(`ticket ${row.id} baseline provenance invalid`);
    }
  }

  return { established: baselines.length };
}

module.exports = { inspectObjectiveRevisionBaseline, MIGRATION_ACTOR };
