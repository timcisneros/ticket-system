'use strict';

// Tranche 6 — the read-only quiescence contract, and the immutable trial
// artifact.
//
// QUIESCENCE IS NOT "ALL RUNS ARE TERMINAL". A Ticket can have every Run in a
// terminal status while work is still genuinely outstanding: a lease still
// held, a governed request started with no durable response, a reservation
// awaiting reconstructible settlement, a terminalization the startup repair
// would still finish, an aggregate reconciliation not yet applied, or a fixture
// request in flight. Sampling the oracle at that moment measures a half-finished
// system and attributes the difference to the arm.
//
// THE READER MAY OBSERVE QUIESCENCE BUT MAY NOT CREATE IT. Nothing here
// transitions, claims, settles, repairs or retries. It issues SELECT statements
// and reads fixture files, and reports what it finds.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class QuiescenceError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'QuiescenceError';
    this.detail = detail;
  }
}

const TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'interrupted', 'cancelled']);

// Every condition that must be clear. Named individually so a non-quiescent
// result says WHICH fact is still outstanding rather than merely "not ready".
const QUIESCENCE_CONDITIONS = Object.freeze([
  'pending_or_running_runs',
  'active_leases',
  'in_flight_governed_requests',
  'unresolved_delivery_uncertainty',
  'unsettled_reconstructible_reservations',
  'recoverable_terminalization',
  'scheduler_visible_retries',
  'pending_aggregate_reconciliation',
  'active_fixture_requests'
]);

function assertSelectOnly(sql) {
  const normalized = String(sql).trim().toUpperCase();
  if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
    throw new QuiescenceError('the quiescence reader may only issue SELECT statements');
  }
  return sql;
}

// One read-only quiescence test per Ticket.
async function observeQuiescence(store, ticketId, { fixtureNamespace = null } = {}) {
  const rows = (await store.pool.query(assertSelectOnly(
    `SELECT
       (SELECT count(*) FROM ${store.table('runs')}
         WHERE ticket_id = $1 AND status NOT IN ('completed','failed','interrupted','cancelled')
       )::int AS nonterminal_runs,
       (SELECT count(*) FROM ${store.table('runs')}
         WHERE ticket_id = $1 AND lease_owner IS NOT NULL
       )::int AS held_leases,
       (SELECT count(*) FROM ${store.table('economic_request_reservations')}
         WHERE ticket_id = $1 AND state = 'request_started'
       )::int AS started_requests,
       (SELECT count(*) FROM ${store.table('economic_request_reservations')}
         WHERE ticket_id = $1 AND state = 'response_persisted'
       )::int AS unsettled_answered,
       (SELECT count(*) FROM ${store.table('runs')} AS r
         WHERE r.ticket_id = $1
           AND r.status IN ('completed','failed','interrupted')
           AND NOT EXISTS (SELECT 1 FROM ${store.table('run_consequences')} AS c
                            WHERE c.run_id = r.id)
       )::int AS unfinished_terminalization,
       (SELECT count(*) FROM ${store.table('runs')}
         WHERE ticket_id = $1 AND status = 'pending'
       )::int AS scheduler_visible,
       (SELECT status FROM ${store.table('tickets')} WHERE id = $1) AS ticket_status`,
  ), [ticketId])).rows[0];

  // A started request with no durable response is delivery-uncertain; it is a
  // legitimate terminal condition for the Run but must be reported so the trial
  // can record it rather than have it silently look like quiescence.
  const outstanding = {
    pending_or_running_runs: Number(rows.nonterminal_runs),
    active_leases: Number(rows.held_leases),
    in_flight_governed_requests: Number(rows.started_requests),
    unresolved_delivery_uncertainty: Number(rows.started_requests),
    unsettled_reconstructible_reservations: Number(rows.unsettled_answered),
    recoverable_terminalization: Number(rows.unfinished_terminalization),
    scheduler_visible_retries: Number(rows.scheduler_visible),
    pending_aggregate_reconciliation:
      rows.ticket_status === 'in_progress' && Number(rows.nonterminal_runs) === 0 ? 1 : 0,
    active_fixture_requests: 0
  };

  // The fixture's own in-flight count, read from its files rather than from any
  // product table.
  if (fixtureNamespace) {
    const inflight = path.join(fixtureNamespace.dir, 'inflight');
    outstanding.active_fixture_requests = fs.existsSync(inflight)
      ? fs.readFileSync(inflight, 'utf8').split('\n').filter(Boolean).length
      : 0;
  }

  const blocking = QUIESCENCE_CONDITIONS.filter(condition => outstanding[condition] > 0);
  return Object.freeze({
    ticketId,
    quiescent: blocking.length === 0,
    blockingConditions: Object.freeze(blocking),
    outstanding: Object.freeze(outstanding),
    ticketStatus: rows.ticket_status,
    authority: 'read_only_observation'
  });
}

// ── THE IMMUTABLE TRIAL ARTIFACT ───────────────────────────────────────────

const ARTIFACT_SCHEMA_VERSION = 1;
const EXECUTION_MODES = Object.freeze(['fixture', 'live']);

// Mode is mandatory and validated everywhere. A result that did not state its
// mode cannot silently join either score set.
function assertMode(mode) {
  if (!EXECUTION_MODES.includes(mode)) {
    throw new QuiescenceError(
      `execution mode must be one of ${EXECUTION_MODES.join(', ')} — a result ` +
      'that does not state its mode may not be scored', { mode });
  }
  return mode;
}

function buildTrialArtifact(input) {
  const required = [
    'protocolVersion', 'repositoryCommit', 'scenarioId', 'armId',
    'repetition', 'seed', 'mode', 'envelopeHash', 'pathProof',
    'ticketReport', 'oracleResult', 'normalizedCost', 'quiescence'
  ];
  for (const field of required) {
    if (input[field] === undefined || input[field] === null) {
      throw new QuiescenceError(`trial artifact field ${field} is required`);
    }
  }
  assertMode(input.mode);

  const artifact = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    protocolVersion: input.protocolVersion,
    repositoryCommit: input.repositoryCommit,
    // The label the protocol requires on every unscored output.
    label: 'UNSCORED HARNESS SMOKE — NOT PRODUCT EVIDENCE',
    scenarioId: input.scenarioId,
    armId: input.armId,
    repetition: input.repetition,
    seed: input.seed,
    mode: input.mode,
    envelopeHash: input.envelopeHash,
    pathProof: input.pathProof,
    ticketReport: input.ticketReport,
    oracleResult: input.oracleResult,
    couplingResult: input.couplingResult === undefined ? null : input.couplingResult,
    normalizedCost: input.normalizedCost,
    durableGovernedCost: input.durableGovernedCost === undefined
      ? null : input.durableGovernedCost,
    latency: input.latency === undefined ? null : input.latency,
    churn: input.churn === undefined ? null : input.churn,
    quiescence: input.quiescence,
    fixtureTranscriptHash: input.fixtureTranscriptHash || null,
    externalStateHash: input.externalStateHash || null,
    exclusions: input.exclusions || [],
    warnings: input.warnings || []
  };
  artifact.artifactHash = crypto.createHash('sha256')
    .update(JSON.stringify(artifact)).digest('hex');
  return Object.freeze(artifact);
}

// Write once. An existing path is refused rather than overwritten: a result
// that could be rewritten is not evidence.
function writeTrialArtifact(outputPath, artifact) {
  if (fs.existsSync(outputPath)) {
    throw new QuiescenceError(
      `refusing to overwrite an existing trial artifact at ${outputPath}`,
      { outputPath });
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(artifact, null, 2));
  return outputPath;
}

// Fixture and live results live in distinct namespaces AND carry a validated
// mode, so neither containment can be defeated alone.
function artifactPathFor(rootDir, artifact) {
  assertMode(artifact.mode);
  return path.join(rootDir, artifact.mode,
    `${artifact.scenarioId}--${artifact.armId}--r${artifact.repetition}.json`);
}

function assertSingleMode(artifacts) {
  const modes = new Set(artifacts.map(artifact => assertMode(artifact.mode)));
  if (modes.size > 1) {
    throw new QuiescenceError(
      'refusing to combine fixture and live results in one set',
      { modes: [...modes] });
  }
  return true;
}

module.exports = {
  QUIESCENCE_CONDITIONS,
  TERMINAL_STATUSES,
  ARTIFACT_SCHEMA_VERSION,
  EXECUTION_MODES,
  QuiescenceError,
  assertSelectOnly,
  observeQuiescence,
  assertMode,
  buildTrialArtifact,
  writeTrialArtifact,
  artifactPathFor,
  assertSingleMode
};
