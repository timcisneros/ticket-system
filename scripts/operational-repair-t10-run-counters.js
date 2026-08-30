#!/usr/bin/env node
'use strict';

// T10 — narrow run-counter reconciliation candidate (ONE-TIME operational repair).
//
// Authority chain:
//   - runtime_status_counts is a trigger-maintained derived projection (009_operational_status.sql);
//     canonical reconstruction rule = group runs by (status, mod(id, 256)) — the 009 seed rule,
//     reused verbatim by the 041 ticket-counter reseed (041_ticket_five_state_cutover.sql Q5).
//   - Adjudication: current Run reality = 8 (completed 2, failed 5, interrupted 1);
//     run-counter projection = 16 (completed 3, failed 12, interrupted 1); defect = exactly 8
//     excess run-count units; ticket counters coherent; zero-count residue rows are legal
//     lifecycle state (the sixteen run-scope residue rows are removed only by the canonical
//     reseed; the ticket-side residue row is legal and NOT to be tidied); historical cause
//     unresolved; no migration, rollback, restart, or kernel repair.
//   - Consumers: getRuntimeOperationalSummary (persistence/postgres/store.js) reads counters live;
//     scheduling/admission/authority paths do not consume them; no restart is required.
//
// EXACT adjudicated pre-state (readable pins; refusal is exact, not shape-based):
//
//   Positive discrepancy rows (status | shard | counter | reality), exactly, with shard:
//     completed | 7 | 1 | 0
//     failed    | 1 | 2 | 1
//     failed    | 2 | 1 | 0
//     failed    | 3 | 2 | 1
//     failed    | 4 | 1 | 0
//     failed    | 5 | 2 | 1
//     failed    | 6 | 2 | 1
//     failed    | 8 | 1 | 0
//
//   Implied exact Run reality rows at the discrepancy shards (status | shard | count):
//     failed | 1 | 1
//     failed | 3 | 1
//     failed | 5 | 1
//     failed | 6 | 1
//   (shards 2, 4, 7, 8 have NO runs of the discrepancy status: counter-only rows)
//
//   Aggregates: reality completed 2, failed 5, interrupted 1, total 8 (pending/running 0);
//   positive counter completed 3, failed 12, interrupted 1, total 16, plus exactly sixteen
//   legal zero-count residue rows (pending|1..8 and running|1..8, each 0) — canonical lifecycle
//   residue created by decrement-to-zero under the 009 trigger; they are not authority and the
//   canonical reseed (009 seed / 041 Q5 precedent) removes them within its reseeded scope; the
//   unmatched zero-count residue row is on the TICKET side and is legal, untouched state.
//
//   Every (status, shard) not pinned above must have counter == reality exactly (matched
//   remainder derived from authoritative runs). Run ids are immutable and shard = mod(id, 256),
//   so the pinned rows (positive and zero) plus exact aggregates pin membership and status
//   placement: any membership change under the (fence-verified, enabled) trigger changes totals
//   or disturbs a pinned row (refused); any status placement change changes status totals
//   (refused); shard relocation of a run is impossible without a membership change.
//
//   Digest conventions (status|shard|count rows sorted by (status, shard), joined "\n", sha256;
//   discrepancy rows use status|shard|counter|reality): the source pins the discrepancy and
//   implied-reality digests below. The FULL pre-state digests of the reviewed Run
//   reality and run-counter projection must come from the repository-owned authorization record
//   (config/repair-authorization.t10-run-counter-reconciliation-v1.json), written by the
//   authorizing review BEFORE execution; digests observed at execution are recorded as evidence
//   only and are never self-authorizing.
//
// AUTHORIZATION EVIDENCE (repository-owned; no CLI substitution possible):
//   - Execution reads config/repair-authorization.t10-run-counter-reconciliation-v1.json — a
//     committed, machine-readable, repair-specific authorization record. It binds: repair id,
//     authorization state, authorized script sha256, authorized baseline HEAD, expected full
//     Run-reality digest, expected full run-counter digest, exact operational target,
//     reconstruction-rule identity, and the lock relations. The shipped record is a
//     NON-AUTHORIZING contract example (authorizationState "NOT_AUTHORIZED"): it proves the
//     shape and location without granting any authority.
//   - The script validates the record itself and accepts NO authorization values from the
//     command line: script sha256, digests, target, rule, lock relations, baseline HEAD, and
//     authorization state all come from the record; the script supplies only the OBSERVED
//     values it compares against. An executor running preflight to observe digests cannot feed
//     them back through CLI flags — no such flags exist. Substituting different bindings
//     requires committing a modified record to the repository, which changes the tree (the
//     record-bound clean-tree and HEAD==fresh-remote-master checks refuse) or requires pushing
//     to origin/master — the same out-of-band repository-write authority that guards every
//     committed authority in this repository, and the act the authorizing review performs.
//   - FRESH REMOTE MASTER AUTHORITY: before any database contact on --execute, the script
//     queries the CURRENT remote tip with `git ls-remote --exit-code origin refs/heads/master`
//     (non-mutating; it does not modify local tracking refs) and requires exactly one
//     well-formed 40-hex refs/heads/master result equal to HEAD; the record's
//     authorizedBaselineHead must be an ancestor of that freshly queried tip. Any network or
//     remote failure, missing master, malformed line, wrong ref, ambiguous result, or HEAD
//     inequality refuses. The locally cached origin/master tracking ref is DIAGNOSTIC EVIDENCE
//     ONLY and is never the freshness authority: a stale cached ref can neither enable
//     execution nor substitute for the live equality check, and it is not consulted for
//     baseline ancestry. Execution occurs only from a clean repository state byte-identical to
//     the current canonical published master containing the authorization.
//   - Remote-query failures are SANITIZED: git stderr/stdout are never surfaced, because
//     remote transport errors can embed credential-helper material; refusals report only the
//     command shape and exit status. No credentials or tokens appear in any output or evidence.
//   - Occurrence evidence distinguishes, without ambiguity, HEAD, the locally cached
//     origin/master ref (diagnostic), and the freshly queried origin refs/heads/master tip
//     that constituted the freshness authority for the executed repair.
//   - The record is the only authorization input; conversational approval or an arbitrary
//     --authorization-ref string is not authority and is no longer accepted.
//
// Lock doctrine (do not reorder):
//   - Frozen protocol prefix (persistence/postgres/store.js): allocation_plans -> runs ->
//     ticket_attempts -> tickets LAST; 041 H1 extended it with run_consequences, events,
//     diagnostic_logs, runtime_status_counts (all SHARE ROW EXCLUSIVE MODE NOWAIT).
//   - Mutation-transaction relation access, enumerated (pinned by TRANSACTION_ACCESS_MODEL):
//     * Initial explicit locks — the only acquisitions that can block, taken in ONE statement
//       in the canonical relative order runs -> diagnostic_logs -> runtime_status_counts
//       (SHARE ROW EXCLUSIVE MODE NOWAIT, fail-closed 55P03 on contention). They cover every
//       relation the transaction WRITES (runtime_status_counts: DELETE + INSERT of run-scope
//       rows; diagnostic_logs: one occurrence INSERT) and the run-reality read set (runs).
//     * After the initial statement, only ACCESS SHARE reads occur: pg_catalog (trigger
//       check) and schema_migrations (postcondition). ACCESS SHARE conflicts only with ACCESS
//       EXCLUSIVE, and the proven operational boundary excludes ACCESS EXCLUSIVE during an
//       authorized repair window: no migration or DDL runs concurrently (the repair first
//       verifies schema currency read-only and refuses on drift, and the store refuses to run
//       against a partially migrated schema). Under that boundary these reads cannot block on
//       our SRE locks and cannot participate in a cycle with them.
//     * tickets: deliberately NOT locked and NOT read in the mutation transaction. Ticket
//       counter NONCHANGE is proven inside the transaction by digest equality of the ticket
//       counter rows alone (the counter table is locked); ticket-reality coherence is observed
//       by the preflight and re-proven by the separate post-commit verification transaction.
//       This removes the former ACCESS SHARE read of tickets that was acquired after
//       runtime_status_counts.
//     * ticket_attempts, allocation_plans, events, run_consequences: neither read nor written,
//       not locked.
//   - Deadlock/inversion proof: the transaction's only blocking acquisition is the initial
//     NOWAIT statement — on contention it fails closed instead of waiting, and after it the
//     transaction waits for nothing the boundary does not exclude. Canonical run writers take
//     ROW EXCLUSIVE on runs before their trigger can reach the counter table, so they either
//     commit ahead of us (our NOWAIT then refuses) or wait behind us. Server diagnostic writes
//     are single-statement and either wait briefly for commit or arrive after it. tickets is
//     not locked: we neither read nor write it, and the counter-table lock already excludes
//     concurrent ticket-trigger counter writes.
//   - Preflight additionally reads tickets (ACCESS SHARE, after the initial locks, same
//     compatibility-safe class) to observe ticket-reality coherence for the authorizing
//     review. The post-commit verification transaction is a separate transaction: plain
//     ACCESS SHARE reads of runs, runtime_status_counts and tickets — acquired in canonical
//     relative order, tickets before diagnostic_logs — followed by one ordinary diagnostic_logs
//     INSERT (ROW EXCLUSIVE, standard writer semantics, no counter mutation, no explicit locks).
//
// Refusal contract: the repair refuses before any mutation unless the live state still matches
// the adjudicated defect EXACTLY (pinned positive rows with shards, the sixteen pinned
// zero-residue rows, exact aggregates, matched remainder, no zero-count run rows outside those
// sixteen, full-state digests equal to the authorization record's reviewed
// values, enabled trigger, current schema, expected operational target, and a clean
// repository state whose HEAD equals the freshly queried origin refs/heads/master with the
// authorized baseline an ancestor of it, containing a valid AUTHORIZED record). A changed state
// requires a new review; there is no "repair whatever drift exists" path and no adaptation.
// The repair is one transaction: locks -> re-read -> fence -> reconstruct -> postconditions ->
// commit; any discrepancy rolls back with no partial repair, and the occurrence record
// (written inside the transaction) rolls back with it, so a rolled-back repair cannot leave a
// false "repair succeeded" record.
//
// Occurrence evidence: two append-only deployment-scope diagnostic_logs rows (repository-owned
// channel; agentName "System"). Row 1 commits atomically with the repair and records the
// authorization record identity (path, sha256, state, authorizer); row 2 records the
// post-commit read-only verification result. Neither row exists yet; they are created only by
// an authorized execution.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PINNED_BASELINE_HEAD = '1e8dc3e225100f69aa54cd956ef129ec2dda4114';
const REPAIR_ID = 't10-run-counter-reconciliation-v1';
const AUTHORIZATION_RECORD_RELATIVE_PATH =
  'config/repair-authorization.t10-run-counter-reconciliation-v1.json';
const AUTHORIZATION_RECORD_PATH = path.join(ROOT, AUTHORIZATION_RECORD_RELATIVE_PATH);
const RECONSTRUCTION_RULE_ID =
  't10-run-counter-reconciliation-v1: DELETE FROM runtime_status_counts WHERE entity_type = \'run\', ' +
  'then INSERT SELECT \'run\', status, mod(id, 256)::smallint, COUNT(*)::bigint FROM runs ' +
  'GROUP BY status, mod(id, 256) — the 009 seed rule, reused by the 041 Q5 reseed precedent';
const COUNT_DIGEST_FORMAT =
  'sha256 of lines "status|shard|count" for ALL rows of the set, sorted by (status, shard), joined with "\\n"';
const DISCREPANCY_DIGEST_FORMAT =
  'sha256 of lines "status|shard|counter|reality" sorted by (status, shard), joined with "\\n"';

// Exact adjudicated pins (see header for the readable rows).
const PINNED_DISCREPANCY_ROWS = Object.freeze([
  Object.freeze({ status: 'completed', shard: 7, counter: 1, reality: 0 }),
  Object.freeze({ status: 'failed', shard: 1, counter: 2, reality: 1 }),
  Object.freeze({ status: 'failed', shard: 2, counter: 1, reality: 0 }),
  Object.freeze({ status: 'failed', shard: 3, counter: 2, reality: 1 }),
  Object.freeze({ status: 'failed', shard: 4, counter: 1, reality: 0 }),
  Object.freeze({ status: 'failed', shard: 5, counter: 2, reality: 1 }),
  Object.freeze({ status: 'failed', shard: 6, counter: 2, reality: 1 }),
  Object.freeze({ status: 'failed', shard: 8, counter: 1, reality: 0 })
]);
const PINNED_IMPLIED_REALITY_ROWS = Object.freeze([
  Object.freeze({ status: 'failed', shard: 1, count: 1 }),
  Object.freeze({ status: 'failed', shard: 3, count: 1 }),
  Object.freeze({ status: 'failed', shard: 5, count: 1 }),
  Object.freeze({ status: 'failed', shard: 6, count: 1 })
]);
// Exactly sixteen legal zero-count Run residue rows (canonical decrement-to-zero lifecycle
// residue under the 009 trigger; not authority). The fence pins their exact shape: present,
// count exactly 0, pending/running only, shards exactly 1..8, and nothing else zero anywhere.
// They are disjoint by status from the positive discrepancy pins, so a nonzero value at a
// pinned zero position always refuses. Canonical reconstruction removes them (009 seed / 041
// Q5 precedent); post-repair convergence must not expect them.
const PINNED_ZERO_RESIDUE_ROWS = Object.freeze(['pending', 'running'].flatMap(status =>
  [1, 2, 3, 4, 5, 6, 7, 8].map(shard => Object.freeze({ status, shard, count: 0 }))
));
const EXPECTED_REALITY_COUNTS = Object.freeze({ completed: 2, failed: 5, interrupted: 1 });
const EXPECTED_REALITY_TOTAL = 8;
const EXPECTED_COUNTER_COUNTS = Object.freeze({ completed: 3, failed: 12, interrupted: 1 });
const EXPECTED_COUNTER_TOTAL = 16;
const RUN_STATUSES = Object.freeze(['pending', 'running', 'completed', 'failed', 'interrupted']);

// Operational target identity (repository-approved boundary: scripts/dev-environment.js
// bundled target; POSTGRES_SCHEMA default). Non-secret fields only; credentials in
// DATABASE_URL are parsed out and never read into output.
const EXPECTED_TARGET = Object.freeze({
  host: '127.0.0.1',
  port: 5432,
  database: 'ticket_system',
  schema: 'ticket_system'
});

// Canonical relative lock order (041 H1 extension): runs -> diagnostic_logs ->
// runtime_status_counts. The access model below is the complete, pinned relation-access
// contract of each transaction; see the lock-doctrine header for the blocking analysis.
const LOCK_RELATIONS = Object.freeze(['runs', 'diagnostic_logs', 'runtime_status_counts']);
const TRANSACTION_ACCESS_MODEL = Object.freeze({
  initialLockStatement:
    'LOCK TABLE runs, diagnostic_logs, runtime_status_counts IN SHARE ROW EXCLUSIVE MODE NOWAIT',
  writes: Object.freeze(['runtime_status_counts', 'diagnostic_logs']),
  readsUnderInitialLocks: Object.freeze(['runs', 'runtime_status_counts']),
  accessShareReadsAfterInitialLocks: Object.freeze(['pg_catalog', 'schema_migrations']),
  accessShareReadsPreflightOnly: Object.freeze(['tickets']),
  omittedRelations: Object.freeze(['tickets', 'ticket_attempts', 'allocation_plans', 'events', 'run_consequences']),
  postCommitVerification: Object.freeze({
    reads: Object.freeze(['runs', 'runtime_status_counts', 'tickets']),
    writes: Object.freeze(['diagnostic_logs'])
  })
});

// Run-scope convergence query shared by the in-transaction postcondition and the post-commit
// verification. The counter INPUT is filtered to entity_type = 'run' BEFORE the FULL OUTER JOIN
// (migration-041-Q8 input-filtering pattern). Placing the predicate only in the ON clause does
// NOT remove non-run rows from the t-side input: unmatched Ticket counter rows survive the join
// and are counted as Run drift, so a correct repair would refuse to commit / verify. The live
// snapshot contains seven Ticket counter rows (one legal zero residue), which demonstrates the
// failure mode.
const RUN_SCOPE_DRIFT_QUERY = `
  SELECT COUNT(*)::bigint AS drift FROM (
    SELECT r.status, r.shard, r.count AS reality_count, t.count AS counter_count
      FROM (SELECT status, mod(id, 256)::smallint AS shard, COUNT(*)::bigint AS count
              FROM runs GROUP BY status, mod(id, 256)) AS r
      FULL OUTER JOIN (
        SELECT status, shard, count
          FROM runtime_status_counts
         WHERE entity_type = 'run'
      ) AS t
        ON t.status = r.status AND t.shard = r.shard
     WHERE t.count IS DISTINCT FROM r.count
        OR t.count IS NULL OR r.count IS NULL
  ) AS d`;

class RepairRefusalError extends Error {
  constructor(reasons) {
    super(`T10 repair refused: ${reasons.join('; ')}`);
    this.name = 'RepairRefusalError';
    this.code = 'T10_REPAIR_REFUSED';
    this.reasons = Object.freeze([...reasons]);
  }
}

// ── Pure canonicalization / fence logic (self-testable, no database) ──────────

function canonicalCountLines(rows) {
  return [...rows]
    .map(row => ({ status: String(row.status), shard: Number(row.shard), count: Number(row.count) }))
    .sort((a, b) => (a.status < b.status ? -1 : a.status > b.status ? 1 : a.shard - b.shard))
    .map(row => `${row.status}|${row.shard}|${row.count}`);
}

function canonicalDigest(rows) {
  return crypto.createHash('sha256').update(canonicalCountLines(rows).join('\n'), 'utf8').digest('hex');
}

function discrepancyDigestOf(rows) {
  const lines = rows
    .map(row => `${row.status}|${row.shard}|${row.counter}|${row.reality}`)
    .sort();
  return crypto.createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

const PINNED_DISCREPANCY_DIGEST = discrepancyDigestOf(PINNED_DISCREPANCY_ROWS);
const PINNED_IMPLIED_REALITY_DIGEST = canonicalDigest(PINNED_IMPLIED_REALITY_ROWS);

function countByStatus(rows) {
  const totals = {};
  for (const row of rows) totals[row.status] = (totals[row.status] || 0) + Number(row.count);
  return totals;
}

function deepEqual(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

// Exact-state fence. Returns the observed canonical digests or throws RepairRefusalError.
// Pure: pins are in-source; full-set digest comparison against the authorization record's
// reviewed values is performed by assertFullStateDigests (also pure).
function evaluateRunFence(realityRows, counterRows) {
  const reasons = [];
  const reality = new Map(realityRows.map(row => [`${row.status}|${row.shard}`, Number(row.count)]));
  const counter = new Map(counterRows.map(row => [`${row.status}|${row.shard}`, Number(row.count)]));

  const unknownStatuses = [...new Set(realityRows.map(row => row.status))]
    .filter(status => !RUN_STATUSES.includes(status));
  if (unknownStatuses.length > 0) reasons.push(`reality has unknown run status(es) ${unknownStatuses.join(', ')}`);
  if (realityRows.some(row => row.status === 'pending' || row.status === 'running')) {
    reasons.push('reality contains pending/running runs; repair must not run while admission is live');
  }

  const realityTotal = realityRows.reduce((sum, row) => sum + Number(row.count), 0);
  if (realityTotal !== EXPECTED_REALITY_TOTAL) {
    reasons.push(`reality total ${realityTotal} != expected ${EXPECTED_REALITY_TOTAL}`);
  }
  const realityTotals = countByStatus(realityRows);
  for (const status of Object.keys(EXPECTED_REALITY_COUNTS)) {
    if ((realityTotals[status] || 0) !== EXPECTED_REALITY_COUNTS[status]) {
      reasons.push(`reality ${status} ${realityTotals[status] || 0} != expected ${EXPECTED_REALITY_COUNTS[status]}`);
    }
  }
  for (const status of ['pending', 'running']) {
    if ((realityTotals[status] || 0) !== 0) reasons.push(`reality ${status} ${(realityTotals[status] || 0)} != expected 0`);
  }
  if (realityRows.some(row => Number(row.count) < 1)) reasons.push('reality has non-positive grouped count');

  const counterTotal = counterRows.reduce((sum, row) => sum + Number(row.count), 0);
  if (counterTotal !== EXPECTED_COUNTER_TOTAL) {
    reasons.push(`run counter total ${counterTotal} != expected ${EXPECTED_COUNTER_TOTAL}`);
  }
  const counterTotals = countByStatus(counterRows);
  for (const status of Object.keys(EXPECTED_COUNTER_COUNTS)) {
    if ((counterTotals[status] || 0) !== EXPECTED_COUNTER_COUNTS[status]) {
      reasons.push(`run counter ${status} ${counterTotals[status] || 0} != expected ${EXPECTED_COUNTER_COUNTS[status]}`);
    }
  }
  for (const status of ['pending', 'running']) {
    if ((counterTotals[status] || 0) !== 0) reasons.push(`run counter has ${status} rows`);
  }
  if (counterRows.some(row => Number(row.count) < 0)) {
    reasons.push('negative run counter count present (schema CHECK also forbids it)');
  }

  // Exact pinned discrepancy rows: counter count and reality presence/value, per shard.
  for (const pin of PINNED_DISCREPANCY_ROWS) {
    const key = `${pin.status}|${pin.shard}`;
    const observedCounter = counter.has(key) ? counter.get(key) : null;
    if (observedCounter !== pin.counter) {
      reasons.push(`pinned discrepancy row ${key}: counter ${observedCounter === null ? 'absent' : observedCounter} != expected ${pin.counter}`);
    }
    const observedReality = reality.has(key) ? reality.get(key) : 0;
    if (observedReality !== pin.reality) {
      reasons.push(`pinned discrepancy row ${key}: reality ${observedReality} != expected ${pin.reality}`);
    }
  }

  // Exact pinned reality rows at the discrepancy shards (implied by the reviewed state).
  for (const pin of PINNED_IMPLIED_REALITY_ROWS) {
    const key = `${pin.status}|${pin.shard}`;
    const observed = reality.has(key) ? reality.get(key) : null;
    if (observed !== pin.count) {
      reasons.push(`pinned reality row ${key}: ${observed === null ? 'absent' : observed} != expected ${pin.count}`);
    }
  }

  // Exact pinned zero residue: the sixteen adjudicated rows must each be present with count
  // exactly 0, and grouped reality must not contain them (pending/running reality must be 0).
  const pinnedZeroKeys = new Set(PINNED_ZERO_RESIDUE_ROWS.map(pin => `${pin.status}|${pin.shard}`));
  for (const zeroPin of PINNED_ZERO_RESIDUE_ROWS) {
    const key = `${zeroPin.status}|${zeroPin.shard}`;
    const observed = counter.has(key) ? counter.get(key) : null;
    if (observed !== 0) {
      reasons.push(`pinned zero residue row ${key}: ${observed === null ? 'absent' : observed} != expected 0`);
    }
    if (reality.has(key)) {
      reasons.push(`pinned zero residue row ${key} has grouped reality ${reality.get(key)}`);
    }
  }

  // Everything not pinned must be matched exactly; zero-count run rows outside the sixteen
  // pinned zero-residue positions are refused outright (their presence means state changed).
  const pinnedCounterKeys = new Set(PINNED_DISCREPANCY_ROWS.map(pin => `${pin.status}|${pin.shard}`));
  const allKeys = new Set([...reality.keys(), ...counter.keys()]);
  for (const key of allKeys) {
    const r = reality.has(key) ? reality.get(key) : 0;
    const c = counter.has(key) ? counter.get(key) : null;
    if (pinnedZeroKeys.has(key)) continue;
    if (c === 0) {
      reasons.push(`zero-count run counter row ${key} present; only the sixteen adjudicated pending/running shards 1-8 are zero residue — new review required`);
      continue;
    }
    if (pinnedCounterKeys.has(key)) continue;
    if (c === null) {
      reasons.push(`reality row ${key} (count ${r}) missing from the counter projection`);
      continue;
    }
    if (c !== r) {
      reasons.push(`unpinned row ${key}: counter ${c} != reality ${r}`);
    }
  }

  if (reasons.length > 0) throw new RepairRefusalError(reasons);
  return {
    realityDigest: canonicalDigest(realityRows),
    runCounterDigest: canonicalDigest(counterRows)
  };
}

// Full-state digest enforcement: the expected values come from the repository-owned
// authorization record, never from the execution-time observation.
function assertFullStateDigests(observedRealityDigest, observedCounterDigest, expected) {
  const reasons = [];
  if (observedRealityDigest !== expected.realityDigest) {
    reasons.push(`reality digest ${observedRealityDigest} != authorization record's reviewed ${expected.realityDigest}`);
  }
  if (observedCounterDigest !== expected.counterDigest) {
    reasons.push(`run counter digest ${observedCounterDigest} != authorization record's reviewed ${expected.counterDigest}`);
  }
  if (reasons.length > 0) throw new RepairRefusalError(reasons);
}

// Positive-only ticket coherence check: zero-count residue rows are legal and ignored;
// any counter/reality disagreement otherwise is drift. Pure.
function ticketPositiveDrift(realityRows, counterRows) {
  const reality = new Map(realityRows.map(row => [`${row.status}|${row.shard}`, Number(row.count)]));
  const counter = new Map(counterRows.map(row => [`${row.status}|${row.shard}`, Number(row.count)]));
  const keys = new Set([...reality.keys(), ...counter.keys()]);
  let drift = 0;
  for (const key of keys) {
    const r = reality.has(key) ? reality.get(key) : 0;
    const c = counter.has(key) ? counter.get(key) : null;
    const residue = c !== null && c === 0 && r === 0;
    if (!residue && c !== r) drift += 1;
  }
  return drift;
}

// Parses the NON-SECRET connection identity out of a PostgreSQL URL. Credentials are
// dropped here and never surfaced.
function parseConnectionTarget(databaseUrl) {
  let parsed;
  try {
    parsed = new URL(String(databaseUrl));
  } catch (_) {
    throw new TypeError('database URL is not a valid URL');
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new TypeError('database URL must use postgres:// or postgresql://');
  }
  if (!parsed.hostname || !parsed.pathname || parsed.pathname === '/') {
    throw new TypeError('database URL must name a host and database');
  }
  return Object.freeze({
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    database: decodeURIComponent(parsed.pathname.slice(1))
  });
}

function connectionTargetMismatch(observed, expected) {
  const reasons = [];
  if (observed.host !== expected.host) reasons.push(`host ${observed.host} != expected ${expected.host}`);
  if (observed.port !== expected.port) reasons.push(`port ${observed.port} != expected ${expected.port}`);
  if (observed.database !== expected.database) reasons.push(`database ${observed.database} != expected ${expected.database}`);
  return reasons;
}

function buildLockStatement(schema) {
  const qualified = LOCK_RELATIONS.map(relation => `"${String(schema).replace(/"/g, '""')}"."${relation}"`);
  return `LOCK TABLE ${qualified.join(', ')} IN SHARE ROW EXCLUSIVE MODE NOWAIT`;
}

// Pure: canonically quoted, fully qualified relation name (embedded double quotes doubled),
// used as the to_regclass($1) parameter for the trigger lookup. Same quoting convention as
// buildLockStatement.
function qualifiedRelationName(schema, relation) {
  const quote = name => `"${String(name).replace(/"/g, '""')}"`;
  return `${quote(schema)}.${quote(relation)}`;
}

// ── Repository-owned authorization evidence (self-testable, no database) ──────

const AUTHORIZATION_RECORD_KIND = 't10-repair-authorization';
const AUTHORIZED_STATE = 'AUTHORIZED';
const EXPECTED_RECORD_KEYS = Object.freeze([
  'recordKind',
  'recordVersion',
  'repairId',
  'authorizationState',
  'authorizedScriptSha256',
  'authorizedBaselineHead',
  'expectedRealityDigest',
  'expectedCounterDigest',
  'expectedTarget',
  'reconstructionRuleId',
  'lockRelations',
  'authorizedBy',
  'authorizedAtUtc'
]);
const SECRET_LIKE_KEY = /password|secret|token|credential|apikey|api_key/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const COMMIT_HEX = /^[0-9a-f]{40}$/;

// Fresh remote master authority (execute mode only; before any database contact). The
// non-mutating remote-ref query is the ONLY freshness authority; git's stderr/stdout are
// captured and never surfaced (transport errors can embed credential-helper material).
const FRESH_REMOTE_MASTER_ARGS = Object.freeze(
  ['ls-remote', '--exit-code', 'origin', 'refs/heads/master']
);
const FRESH_REMOTE_MASTER_COMMAND = `git ${FRESH_REMOTE_MASTER_ARGS.join(' ')}`;
const LS_REMOTE_MASTER_LINE = /^([0-9a-f]{40})\trefs\/heads\/master$/;

function readAuthorizationRecordRaw() {
  if (!fs.existsSync(AUTHORIZATION_RECORD_PATH)) return null;
  return fs.readFileSync(AUTHORIZATION_RECORD_PATH, 'utf8');
}

// Phase A — shape, identity, and state. Runs before any database contact so a missing,
// malformed, foreign, or non-AUTHORIZED record refuses immediately.
function validateAuthorizationRecordShape(rawJson) {
  if (rawJson === null || rawJson === undefined) {
    throw new RepairRefusalError([
      `authorization record not found at ${AUTHORIZATION_RECORD_RELATIVE_PATH}; execution requires a committed repository-owned authorization record`
    ]);
  }
  let record;
  try {
    record = JSON.parse(rawJson);
  } catch (error) {
    throw new RepairRefusalError([`authorization record is not valid JSON: ${error.message}`]);
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new RepairRefusalError(['authorization record is not a JSON object']);
  }
  const reasons = [];
  const keys = Object.keys(record);
  for (const key of keys) {
    if (SECRET_LIKE_KEY.test(key)) reasons.push(`authorization record has forbidden secret-like field "${key}"`);
  }
  const missing = EXPECTED_RECORD_KEYS.filter(key => !keys.includes(key));
  const extra = keys.filter(key => !EXPECTED_RECORD_KEYS.includes(key));
  if (missing.length > 0) reasons.push(`authorization record missing field(s): ${missing.join(', ')}`);
  if (extra.length > 0) reasons.push(`authorization record has unknown field(s): ${extra.join(', ')}`);
  if (reasons.length > 0) throw new RepairRefusalError(reasons);

  if (record.recordKind !== AUTHORIZATION_RECORD_KIND) {
    reasons.push(`authorization record kind ${JSON.stringify(record.recordKind)} != expected "${AUTHORIZATION_RECORD_KIND}"`);
  }
  if (record.recordVersion !== 1) reasons.push(`authorization record version ${JSON.stringify(record.recordVersion)} != expected 1`);
  if (record.repairId !== REPAIR_ID) {
    reasons.push(`authorization record is for repair ${JSON.stringify(record.repairId)}, not ${JSON.stringify(REPAIR_ID)}`);
  }
  if (record.authorizationState !== AUTHORIZED_STATE) {
    throw new RepairRefusalError([
      `authorization record state is ${JSON.stringify(record.authorizationState)}; execution requires an "${AUTHORIZED_STATE}" record — this repair is NOT authorized`
    ]);
  }
  if (reasons.length > 0) throw new RepairRefusalError(reasons);
  return record;
}

// Phase B — binding equality against observed values. Every compared value (script sha256,
// digests, target, rule, lock relations, baseline, repository state, fresh remote tip) comes
// from the record or from a live observation; the script supplies only observations. Runs
// before mutation, and in execute mode before any database contact.
function assertAuthorizationBindings(record, observations) {
  const reasons = [];
  if (!SHA256_HEX.test(String(record.authorizedScriptSha256))) {
    reasons.push('authorizedScriptSha256 is not a sha256 hex digest');
  } else if (record.authorizedScriptSha256 !== observations.scriptSha256) {
    reasons.push(`authorized script sha256 ${record.authorizedScriptSha256} != observed ${observations.scriptSha256}`);
  }
  if (!COMMIT_HEX.test(String(record.authorizedBaselineHead))) {
    reasons.push('authorizedBaselineHead is not a 40-hex commit id');
  }
  if (!SHA256_HEX.test(String(record.expectedRealityDigest))) {
    reasons.push('expectedRealityDigest is not a sha256 hex digest');
  }
  if (!SHA256_HEX.test(String(record.expectedCounterDigest))) {
    reasons.push('expectedCounterDigest is not a sha256 hex digest');
  }
  if (!deepEqual(record.expectedTarget, EXPECTED_TARGET)) {
    reasons.push(`authorization record expectedTarget ${JSON.stringify(record.expectedTarget)} != pinned operational target ${JSON.stringify(EXPECTED_TARGET)}`);
  }
  if (record.reconstructionRuleId !== RECONSTRUCTION_RULE_ID) {
    reasons.push('authorization record reconstructionRuleId does not match the script reconstruction rule');
  }
  if (!deepEqual(record.lockRelations, [...LOCK_RELATIONS])) {
    reasons.push(`authorization record lockRelations ${JSON.stringify(record.lockRelations)} != canonical ${JSON.stringify([...LOCK_RELATIONS])}`);
  }
  if (typeof record.authorizedBy !== 'string' || record.authorizedBy.trim().length === 0) {
    reasons.push('authorization record authorizedBy must name the authorizing review');
  }
  if (typeof record.authorizedAtUtc !== 'string' || record.authorizedAtUtc.trim().length === 0) {
    reasons.push('authorization record authorizedAtUtc must be recorded');
  }
  if (observations.clean !== true) reasons.push('working tree is not clean; execution requires a clean authoritative repository state');
  // Freshness authority is ONLY the freshly queried origin refs/heads/master tip. The cached
  // origin/master tracking ref (observations.originMaster, when present) is deliberately NOT
  // consulted here: it can be stale and must never enable or substitute for the live check.
  const freshRemoteMaster = String(observations.freshRemoteMaster || '');
  if (!COMMIT_HEX.test(freshRemoteMaster)) {
    reasons.push('freshly queried origin refs/heads/master is missing or malformed; execution requires the current remote master tip');
  } else {
    if (observations.head !== freshRemoteMaster) {
      reasons.push(`repository HEAD ${observations.head} != freshly queried origin refs/heads/master ${freshRemoteMaster}; execution requires the current canonical pushed master`);
    }
    if (observations.baselineIsAncestor !== true) {
      reasons.push(`authorized baseline ${record.authorizedBaselineHead} is not an ancestor of the freshly queried origin refs/heads/master ${freshRemoteMaster}`);
    }
  }
  if (reasons.length > 0) throw new RepairRefusalError(reasons);
  return record;
}

function fileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function scriptSha256() {
  return fileSha256(__filename);
}

function repositoryObservations() {
  // originMaster here is the LOCALLY CACHED tracking ref: diagnostic evidence only, never the
  // freshness authority (see FRESH REMOTE MASTER AUTHORITY in the header).
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const originMaster = execFileSync('git', ['rev-parse', 'origin/master'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  return { head, originMaster, clean: status.trim().length === 0 };
}

// Pure: parses `git ls-remote --exit-code origin refs/heads/master` output. Requires exactly
// one well-formed "<40-hex>\trefs/heads/master" line; empty, malformed, wrong-ref, or
// ambiguous output refuses.
function parseLsRemoteMaster(stdout) {
  const lines = String(stdout)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
  if (lines.length === 0) {
    throw new RepairRefusalError([
      `fresh remote master query returned no refs/heads/master (${FRESH_REMOTE_MASTER_COMMAND})`
    ]);
  }
  const shas = [];
  for (const line of lines) {
    const match = LS_REMOTE_MASTER_LINE.exec(line);
    if (!match) {
      throw new RepairRefusalError([
        `fresh remote master query returned unexpected output and was refused (${FRESH_REMOTE_MASTER_COMMAND})`
      ]);
    }
    shas.push(match[1]);
  }
  if (shas.length > 1) {
    throw new RepairRefusalError([
      `fresh remote master query returned ambiguous refs/heads/master results (${FRESH_REMOTE_MASTER_COMMAND})`
    ]);
  }
  return shas[0];
}

// Operational (execute mode only): live, non-mutating remote-ref query. Fail-closed on any
// network/remote failure or missing master. Error text is sanitized: the child process's
// stderr/stdout are NEVER included, so credential-helper material cannot leak.
function freshRemoteMasterSha() {
  let stdout;
  try {
    stdout = execFileSync('git', [...FRESH_REMOTE_MASTER_ARGS], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    const exitCode = error && typeof error.status === 'number' ? `exit code ${error.status}` : 'failed';
    throw new RepairRefusalError([
      `fresh remote master query ${exitCode}; execution requires the current origin refs/heads/master (${FRESH_REMOTE_MASTER_COMMAND})`
    ]);
  }
  return parseLsRemoteMaster(stdout);
}

// Occurrence/preflight repository evidence: HEAD, the locally cached origin/master tracking
// ref (diagnostic only), and the freshly queried remote tip are always distinguishable; a
// cached tracking ref is never labeled as the fresh remote authority.
function repositoryEvidence(repoObservations, freshRemoteMaster) {
  return {
    head: repoObservations.head,
    localOriginMasterCached: repoObservations.originMaster,
    freshRemoteMaster: freshRemoteMaster || null,
    freshRemoteAuthority: freshRemoteMaster
      ? `${FRESH_REMOTE_MASTER_COMMAND} -> ${freshRemoteMaster}`
      : 'not queried (preflight observes; only --execute establishes fresh remote master authority)',
    clean: repoObservations.clean
  };
}

function baselineIsAncestorOf(baseline, descendant) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', baseline, descendant], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

// ── Self-test (pure, no database, no operational contact) ────────────────────

function selfTest() {
  const cases = [];
  const check = (name, fn) => {
    try {
      fn();
      cases.push({ name, ok: true });
    } catch (error) {
      cases.push({ name, ok: false, error: error.message });
    }
  };
  const assert = (condition, message) => {
    if (!condition) throw new Error(message || 'assertion failed');
  };
  const expectRefusal = (fn, fragment) => {
    try {
      fn();
    } catch (error) {
      assert(error instanceof RepairRefusalError, `wrong error type: ${error.message}`);
      assert(!fragment || error.message.includes(fragment), `refusal lacked "${fragment}": ${error.message}`);
      return;
    }
    assert(false, 'fence should have refused');
  };
  const throws = (fn, ErrorClass, message) => {
    try {
      fn();
    } catch (error) {
      if (ErrorClass && !(error instanceof ErrorClass)) {
        throw new Error(`wrong error type: ${error.message}`);
      }
      return;
    }
    assert(false, message || 'expected a throw');
  };

  // Adjudicated fixture: the four implied reality rows plus the matched remainder that
  // completes the adjudicated aggregates (1 failed, 2 completed, 1 interrupted). The counter
  // fixture additionally carries the sixteen pinned zero residue rows (pending/running
  // shards 1-8), matching the adjudicated 28-row full counter state (12 positive, 16 zero).
  const reality = [
    { status: 'failed', shard: 1, count: 1 },
    { status: 'failed', shard: 3, count: 1 },
    { status: 'failed', shard: 5, count: 1 },
    { status: 'failed', shard: 6, count: 1 },
    { status: 'failed', shard: 200, count: 1 },
    { status: 'completed', shard: 90, count: 1 },
    { status: 'completed', shard: 91, count: 1 },
    { status: 'interrupted', shard: 77, count: 1 }
  ];
  const counters = [
    { status: 'failed', shard: 1, count: 2 },
    { status: 'failed', shard: 2, count: 1 },
    { status: 'failed', shard: 3, count: 2 },
    { status: 'failed', shard: 4, count: 1 },
    { status: 'failed', shard: 5, count: 2 },
    { status: 'failed', shard: 6, count: 2 },
    { status: 'failed', shard: 8, count: 1 },
    { status: 'failed', shard: 200, count: 1 },
    { status: 'completed', shard: 7, count: 1 },
    { status: 'completed', shard: 90, count: 1 },
    { status: 'completed', shard: 91, count: 1 },
    { status: 'interrupted', shard: 77, count: 1 },
    ...PINNED_ZERO_RESIDUE_ROWS.map(zeroPin => ({ ...zeroPin }))
  ];
  const observed = {
    scriptSha256: 'a'.repeat(64),
    realityDigest: canonicalDigest(reality),
    counterDigest: canonicalDigest(counters),
    head: 'b'.repeat(40),
    freshRemoteMaster: 'b'.repeat(40),
    clean: true,
    baselineIsAncestor: true
  };
  const validRecord = {
    recordKind: 't10-repair-authorization',
    recordVersion: 1,
    repairId: REPAIR_ID,
    authorizationState: 'AUTHORIZED',
    authorizedScriptSha256: observed.scriptSha256,
    authorizedBaselineHead: PINNED_BASELINE_HEAD,
    expectedRealityDigest: observed.realityDigest,
    expectedCounterDigest: observed.counterDigest,
    expectedTarget: { ...EXPECTED_TARGET },
    reconstructionRuleId: RECONSTRUCTION_RULE_ID,
    lockRelations: [...LOCK_RELATIONS],
    authorizedBy: 'independent review, T10 candidate authorization',
    authorizedAtUtc: '2026-01-01T00:00:00Z'
  };

  check('source pins match the readable adjudicated rows', () => {
    assert(PINNED_DISCREPANCY_ROWS.length === 8, 'expected 8 pinned discrepancy rows');
    assert(PINNED_IMPLIED_REALITY_ROWS.length === 4, 'expected 4 implied reality rows');
    assert(PINNED_DISCREPANCY_DIGEST === '526d390a6dd72d88f930a523ee6ef3bd23ab71568db1c993b8372d6f4fd7c22d',
      'discrepancy digest pin drifted');
    assert(PINNED_IMPLIED_REALITY_DIGEST === 'd52e4f1f0ca94503e393fd10a678e6e831fcf116d8f8e1998c15a4c928b38cba',
      'implied reality digest pin drifted');
  });

  check('adjudicated fixture passes the exact fence and digest assertion', () => {
    const fence = evaluateRunFence(reality, counters);
    assert(fence.realityDigest === canonicalDigest(reality), 'reality digest mismatch');
    assert(fence.runCounterDigest === canonicalDigest(counters), 'counter digest mismatch');
    assertFullStateDigests(fence.realityDigest, fence.runCounterDigest, {
      realityDigest: fence.realityDigest,
      counterDigest: fence.runCounterDigest
    });
  });

  check('canonicalization is order-independent', () => {
    assert(canonicalDigest(reality) === canonicalDigest([...reality].reverse()), 'digest changed with row order');
    assert(canonicalDigest(counters) === canonicalDigest([...counters].reverse()), 'digest changed with row order');
  });

  check('refuses an excess row relocated to a different shard (same multiset)', () => {
    const mutatedReality = reality.map(row => (row.status === 'failed' && row.shard === 1 ? { ...row, shard: 50 } : row));
    const mutatedCounters = counters.map(row => (row.status === 'failed' && row.shard === 1 ? { ...row, shard: 50 } : row));
    expectRefusal(() => evaluateRunFence(mutatedReality, mutatedCounters), 'pinned discrepancy row failed|1');
    expectRefusal(() => assertFullStateDigests(
      canonicalDigest(mutatedReality), canonicalDigest(mutatedCounters),
      { realityDigest: canonicalDigest(reality), counterDigest: canonicalDigest(counters) }
    ), 'reality digest');
  });

  check('refuses same totals with matched reality on different shards (digest authority)', () => {
    const mutated = reality.map(row => (row.status === 'completed' && row.shard === 90 ? { ...row, shard: 92 } : row));
    const mutatedCounters = counters.map(row => (row.status === 'completed' && row.shard === 90 ? { ...row, shard: 92 } : row));
    const mutatedFence = evaluateRunFence(mutated, mutatedCounters);
    expectRefusal(() => assertFullStateDigests(
      mutatedFence.realityDigest, mutatedFence.runCounterDigest,
      { realityDigest: canonicalDigest(reality), counterDigest: canonicalDigest(counters) }
    ), 'reality digest');
  });

  check('refuses changed status placement of a run', () => {
    const mutated = [
      ...reality.filter(row => !(row.status === 'interrupted' && row.shard === 77)),
      { status: 'completed', shard: 77, count: 1 }
    ];
    expectRefusal(() => evaluateRunFence(mutated, counters), 'reality interrupted 0 != expected 1');
  });

  check('refuses changed counter placement', () => {
    const mutated = counters.map(row => {
      if (row.status === 'failed' && row.shard === 200) return { ...row, status: 'completed', shard: 92 };
      if (row.status === 'completed' && row.shard === 90) return { ...row, status: 'failed', shard: 93 };
      return row;
    });
    expectRefusal(() => evaluateRunFence(reality, mutated), 'unpinned row failed|93');
  });

  check('refuses changed run membership leaving zero residue', () => {
    const mutated = counters.map(row => (row.status === 'completed' && row.shard === 91 ? { ...row, count: 0 } : row));
    const mutatedReality = reality.filter(row => !(row.status === 'completed' && row.shard === 91));
    expectRefusal(() => evaluateRunFence(mutatedReality, mutated), 'zero-count run counter row completed|91');
  });

  check('refuses changed run membership changing totals', () => {
    const mutated = [...reality, { status: 'failed', shard: 300, count: 1 }];
    expectRefusal(() => evaluateRunFence(mutated, counters), 'reality total 9 != expected 8');
  });

  check('refuses negative drift on a matched row', () => {
    const mutated = counters.map(row => (row.status === 'failed' && row.shard === 200 ? { ...row, count: 0 } : row));
    expectRefusal(() => evaluateRunFence(reality, mutated), 'zero-count run counter row failed|200');
  });

  check('refuses pending reality', () => {
    const mutated = [...reality, { status: 'pending', shard: 55, count: 1 }];
    expectRefusal(() => evaluateRunFence(mutated, counters), 'pending/running');
  });

  check('accepts the exact sixteen adjudicated zero residue rows with the full 28-row counter state', () => {
    assert(counters.length === 28, `fixture should carry the adjudicated 28-row counter state, found ${counters.length}`);
    assert(PINNED_ZERO_RESIDUE_ROWS.length === 16, 'expected exactly sixteen pinned zero residue rows');
    const fence = evaluateRunFence(reality, counters);
    assert(fence.realityDigest === canonicalDigest(reality), 'reality digest mismatch');
    assert(fence.runCounterDigest === canonicalDigest(counters), 'counter digest mismatch (full state incl. zeros)');
  });

  check('refuses a missing pinned zero residue row', () => {
    const mutated = counters.filter(row => !(row.status === 'running' && row.shard === 8));
    expectRefusal(() => evaluateRunFence(reality, mutated), 'pinned zero residue row running|8: absent');
  });

  check('refuses an extra zero-count run counter row', () => {
    const mutated = [...counters, { status: 'pending', shard: 9, count: 0 }];
    expectRefusal(() => evaluateRunFence(reality, mutated), 'zero-count run counter row pending|9');
  });

  check('refuses a relocated zero residue row', () => {
    const mutated = counters.map(row =>
      (row.status === 'pending' && row.shard === 8 ? { status: 'pending', shard: 9, count: 0 } : row));
    expectRefusal(() => evaluateRunFence(reality, mutated), 'pinned zero residue row pending|8: absent');
  });

  check('refuses a wrong-status zero residue row', () => {
    const mutated = counters.map(row =>
      (row.status === 'running' && row.shard === 3 ? { status: 'completed', shard: 3, count: 0 } : row));
    expectRefusal(() => evaluateRunFence(reality, mutated), 'pinned zero residue row running|3: absent');
  });

  check('refuses a nonzero value replacing a pinned zero residue row', () => {
    const mutated = counters.map(row =>
      (row.status === 'pending' && row.shard === 5 ? { status: 'pending', shard: 5, count: 1 } : row));
    expectRefusal(() => evaluateRunFence(reality, mutated), 'pinned zero residue row pending|5: 1 != expected 0');
  });

  check('refuses negative run counter counts', () => {
    const mutated = counters.map(row => (row.status === 'failed' && row.shard === 200 ? { ...row, count: -1 } : row));
    expectRefusal(() => evaluateRunFence(reality, mutated), 'negative run counter count');
  });

  check('ticket positive drift ignores legal zero residue and detects real drift', () => {
    const ticketReality = [{ status: 'open', shard: 10, count: 3 }];
    const coherent = [
      { status: 'open', shard: 10, count: 3 },
      { status: 'blocked', shard: 12, count: 0 }
    ];
    assert(ticketPositiveDrift(ticketReality, coherent) === 0, 'residue counted as drift');
    const drifted = [...coherent, { status: 'open', shard: 11, count: 2 }];
    assert(ticketPositiveDrift(ticketReality, drifted) === 1, 'positive drift not detected');
    assert(ticketPositiveDrift(ticketReality, [{ status: 'open', shard: 10, count: 4 }]) === 1, 'mismatch not detected');
  });

  check('lock/access model follows the canonical relative order and covers every write', () => {
    assert(LOCK_RELATIONS.join('->') === 'runs->diagnostic_logs->runtime_status_counts',
      'lock order drifted from canonical doctrine');
    assert(TRANSACTION_ACCESS_MODEL.initialLockStatement ===
      'LOCK TABLE runs, diagnostic_logs, runtime_status_counts IN SHARE ROW EXCLUSIVE MODE NOWAIT',
      'pinned initial lock statement drifted');
    for (const relation of TRANSACTION_ACCESS_MODEL.writes) {
      assert(LOCK_RELATIONS.includes(relation), `written relation ${relation} is not in the initial lock set`);
    }
    for (const relation of TRANSACTION_ACCESS_MODEL.readsUnderInitialLocks) {
      assert(LOCK_RELATIONS.includes(relation), `locked-read relation ${relation} is not in the initial lock set`);
    }
    for (const relation of TRANSACTION_ACCESS_MODEL.omittedRelations) {
      assert(!LOCK_RELATIONS.includes(relation), `omitted relation ${relation} appears in the lock set`);
    }
    assert(!TRANSACTION_ACCESS_MODEL.omittedRelations.includes('runtime_status_counts'),
      'counter table must not be listed as omitted');
    assert(TRANSACTION_ACCESS_MODEL.postCommitVerification.reads.join(',') === 'runs,runtime_status_counts,tickets',
      'post-commit verification read set drifted');
    assert(TRANSACTION_ACCESS_MODEL.postCommitVerification.writes.join(',') === 'diagnostic_logs',
      'post-commit verification write set drifted');
    const statement = buildLockStatement('ticket_system');
    assert(statement === 'LOCK TABLE "ticket_system"."runs", "ticket_system"."diagnostic_logs", "ticket_system"."runtime_status_counts" IN SHARE ROW EXCLUSIVE MODE NOWAIT',
      `lock statement drifted: ${statement}`);
  });

  check('connection-target parsing exposes only non-secret identity fields', () => {
    const parsed = parseConnectionTarget('postgresql://ticket_system:ticket_system@127.0.0.1:5432/ticket_system');
    assert(JSON.stringify(Object.keys(parsed)) === JSON.stringify(['host', 'port', 'database']),
      'parsed target exposed unexpected fields');
    assert(parsed.host === '127.0.0.1' && parsed.port === 5432 && parsed.database === 'ticket_system',
      'bundled target mismatch');
    assert(connectionTargetMismatch(parsed, EXPECTED_TARGET).length === 0, 'bundled target flagged as mismatch');
    assert(connectionTargetMismatch(
      parseConnectionTarget('postgresql://u:p@10.0.0.9:5433/ticket_system'), EXPECTED_TARGET
    ).length === 2, 'foreign host/port not flagged');
    assert(connectionTargetMismatch(
      parseConnectionTarget('postgresql://u:p@127.0.0.1:5432/imposter_ticket_system'), EXPECTED_TARGET
    ).join(' ').includes('imposter_ticket_system'), 'same-name database on foreign cluster not flagged');
    throws(() => parseConnectionTarget('not a url'), TypeError, 'malformed URL accepted');
    throws(() => parseConnectionTarget('mysql://u:p@127.0.0.1:5432/ticket_system'), TypeError, 'foreign scheme accepted');
  });

  check('authorization: missing record refuses', () => {
    expectRefusal(() => validateAuthorizationRecordShape(null), 'authorization record not found');
  });

  check('authorization: malformed record refuses', () => {
    expectRefusal(() => validateAuthorizationRecordShape('{not json'), 'not valid JSON');
    expectRefusal(() => validateAuthorizationRecordShape('[]'), 'not a JSON object');
  });

  check('authorization: record for another repair id refuses', () => {
    const foreign = { ...validRecord, repairId: 'some-other-repair-v9' };
    expectRefusal(() => validateAuthorizationRecordShape(JSON.stringify(foreign)), 'some-other-repair-v9');
  });

  check('authorization: non-AUTHORIZED state refuses (shipped contract example)', () => {
    const example = { ...validRecord, authorizationState: 'NOT_AUTHORIZED' };
    expectRefusal(
      () => validateAuthorizationRecordShape(JSON.stringify(example)),
      'this repair is NOT authorized'
    );
  });

  check('authorization: unknown, missing, or secret-like fields refuse', () => {
    expectRefusal(() => validateAuthorizationRecordShape(JSON.stringify({
      ...validRecord, unexpectedField: true
    })), 'unknown field(s): unexpectedField');
    const missing = { ...validRecord };
    delete missing.authorizedBy;
    expectRefusal(() => validateAuthorizationRecordShape(JSON.stringify(missing)), 'missing field(s): authorizedBy');
    expectRefusal(() => validateAuthorizationRecordShape(JSON.stringify({
      ...validRecord, databasePassword: 'hunter2'
    })), 'forbidden secret-like field');
  });

  check('authorization: script-sha mismatch refuses', () => {
    expectRefusal(() => assertAuthorizationBindings(validRecord, {
      ...observed, scriptSha256: 'c'.repeat(64)
    }), 'authorized script sha256');
  });

  check('authorization: reviewed reality-digest mismatch refuses', () => {
    expectRefusal(() => assertFullStateDigests(
      canonicalDigest([...reality, { status: 'interrupted', shard: 78, count: 1 }]),
      observed.counterDigest,
      { realityDigest: validRecord.expectedRealityDigest, counterDigest: validRecord.expectedCounterDigest }
    ), 'reality digest');
  });

  check('authorization: reviewed counter-digest mismatch refuses', () => {
    expectRefusal(() => assertFullStateDigests(
      observed.realityDigest,
      canonicalDigest([...counters, { status: 'failed', shard: 9, count: 1 }]),
      { realityDigest: validRecord.expectedRealityDigest, counterDigest: validRecord.expectedCounterDigest }
    ), 'run counter digest');
  });

  check('authorization: target mismatch refuses', () => {
    const foreignTarget = { ...validRecord, expectedTarget: { ...EXPECTED_TARGET, host: '10.9.9.9' } };
    expectRefusal(() => assertAuthorizationBindings(foreignTarget, observed), 'expectedTarget');
  });

  check('authorization: repository identity mismatch refuses', () => {
    expectRefusal(() => assertAuthorizationBindings(validRecord, {
      ...observed, clean: false
    }), 'working tree is not clean');
    expectRefusal(() => assertAuthorizationBindings(validRecord, {
      ...observed, freshRemoteMaster: 'd'.repeat(40)
    }), 'freshly queried origin refs/heads/master');
    expectRefusal(() => assertAuthorizationBindings(validRecord, {
      ...observed, baselineIsAncestor: false
    }), 'is not an ancestor of the freshly queried origin refs/heads/master');
  });

  check('authorization: missing or malformed fresh remote tip refuses', () => {
    expectRefusal(() => assertAuthorizationBindings(validRecord, {
      ...observed, freshRemoteMaster: undefined
    }), 'missing or malformed');
    expectRefusal(() => assertAuthorizationBindings(validRecord, {
      ...observed, freshRemoteMaster: 'not-a-sha'
    }), 'missing or malformed');
  });

  check('authorization: HEAD equality uses the fresh remote tip, never the cached tracking ref', () => {
    // A stale/divergent locally cached origin/master neither enables nor blocks authority:
    // it is diagnostic evidence only and is not a binding input.
    assertAuthorizationBindings(validRecord, {
      ...observed, originMaster: 'd'.repeat(40)
    });
    // HEAD == cached origin/master alone is worthless: without live-tip equality it refuses.
    expectRefusal(() => assertAuthorizationBindings(validRecord, {
      ...observed, originMaster: 'b'.repeat(40), freshRemoteMaster: 'd'.repeat(40)
    }), 'freshly queried origin refs/heads/master');
  });

  check('fresh remote master parser accepts exactly one valid refs/heads/master line', () => {
    const sha = 'f'.repeat(40);
    assert(parseLsRemoteMaster(`${sha}\trefs/heads/master\n`) === sha, 'valid line refused');
    assert(parseLsRemoteMaster(`${sha}\trefs/heads/master`) === sha, 'line without trailing newline refused');
  });

  check('fresh remote master parser refuses empty or missing results', () => {
    expectRefusal(() => parseLsRemoteMaster(''), 'no refs/heads/master');
    expectRefusal(() => parseLsRemoteMaster('\n  \n'), 'no refs/heads/master');
  });

  check('fresh remote master parser refuses malformed or wrong-ref lines', () => {
    expectRefusal(() => parseLsRemoteMaster('zz123\trefs/heads/master\n'), 'unexpected output');
    expectRefusal(() => parseLsRemoteMaster(`${'a'.repeat(40)} refs/heads/master\n`), 'unexpected output');
    expectRefusal(() => parseLsRemoteMaster(`${'a'.repeat(40)}\trefs/heads/main\n`), 'unexpected output');
    expectRefusal(() => parseLsRemoteMaster(`${'a'.repeat(40)}\trefs/heads/master extra\n`), 'unexpected output');
  });

  check('fresh remote master parser refuses ambiguous duplicate results', () => {
    const sha = 'f'.repeat(40);
    expectRefusal(() => parseLsRemoteMaster(`${sha}\trefs/heads/master\n${sha}\trefs/heads/master\n`), 'ambiguous');
  });

  check('trigger lookup uses parameterized to_regclass and can never regress to raw expression regclass', () => {
    const source = fs.readFileSync(__filename, 'utf8');
    assert(source.includes('t.tgrelid = to_regclass($1)'),
      'trigger lookup does not use the parameterized to_regclass($1) form');
    const rawRegclassCastNeedle = ':' + ':regclass';
    assert(!source.includes(rawRegclassCastNeedle),
      'raw regclass cast expression present — 42P01 regression (missing FROM-clause entry)');
    assert(qualifiedRelationName('ticket_system', 'runs') === '"ticket_system"."runs"',
      'qualified relation parameter drifted from the canonically quoted form');
    assert(qualifiedRelationName('we"ird', 'runs') === '"we""ird"."runs"',
      'embedded double quotes are not escaped');
    assert(source.includes("[triggerRelationParameter]"),
      'trigger query is not executed with the relation-name parameter');
  });

  check('run-scope drift convergence filters the counter input before the FULL OUTER JOIN (both call sites)', () => {
    const source = fs.readFileSync(__filename, 'utf8');
    const directJoinNeedle = 'FULL OUTER JOIN ' + 'runtime_status_counts';
    const onClauseNeedle = 'ON t.' + "entity_type = 'run'";
    assert(!source.includes(directJoinNeedle),
      'a drift query joins runtime_status_counts directly — non-run rows enter the join t-side');
    assert(!source.includes(onClauseNeedle),
      "entity_type = 'run' sits in an ON clause — it must filter the counter input before the join");
    assert(source.split("WHERE entity_type = 'run'\n      ) AS t").length - 1 === 1,
      'expected exactly one shared input-filtered run-scope drift query definition');
    assert(source.includes("FROM runtime_status_counts\n         WHERE entity_type = 'run'"),
      'the counter input subquery lost its run-scope filter');
    const callSites = source.split('client.query(RUN_SCOPE_' + 'DRIFT_QUERY)').length - 1;
    assert(callSites === 2, `both drift checks must use the shared run-scope query; found ${callSites} call sites`);
  });

  check('authorization: executor cannot substitute bindings via CLI', () => {
    for (const flag of [
      '--authorization-ref',
      '--expected-script-sha256',
      '--expected-reality-digest',
      '--expected-counter-digest',
      '--expected-database',
      '--expected-head'
    ]) {
      throws(() => parseArguments(['node', 'script', '--execute', flag, 'value']), Error,
        `CLI flag ${flag} still accepted`);
    }
  });

  check('authorization: valid AUTHORIZED record binds and parses without secrets', () => {
    const record = validateAuthorizationRecordShape(JSON.stringify(validRecord));
    const bound = assertAuthorizationBindings(record, observed);
    assert(bound.repairId === REPAIR_ID, 'valid record failed to bind');
    assert(JSON.stringify(Object.keys(bound)).includes('password') === false, 'secret-like field survived');
  });

  check('argument parsing refuses incomplete or unknown invocations', () => {
    throws(() => parseArguments(['node', 'script']), Error, 'missing mode accepted');
    const preflight = parseArguments(['node', 'script', '--preflight']);
    assert(preflight.mode === 'preflight', 'preflight mode lost');
    const execute = parseArguments(['node', 'script', '--execute']);
    assert(execute.mode === 'execute', 'execute mode lost');
  });

  const failures = cases.filter(result => !result.ok);
  for (const result of cases) {
    console.log(`${result.ok ? 'ok' : 'FAIL'} - ${result.name}${result.ok ? '' : `: ${result.error}`}`);
  }
  if (failures.length > 0) {
    console.error(`${failures.length} self-test failure(s)`);
    process.exitCode = 1;
    return;
  }
  console.log(`${cases.length} self-test checks passed (no database contacted)`);
}

// ── Operational paths (never reached by --self-test) ─────────────────────────

function parseArguments(argv) {
  const args = { mode: null };
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--self-test') args.mode = 'self-test';
    else if (value === '--preflight') args.mode = 'preflight';
    else if (value === '--execute') args.mode = 'execute';
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!args.mode) throw new Error('mode required: --self-test | --preflight | --execute');
  return args;
}

async function runOperational(mode) {
  const { applyLocalEnv, developmentConfig } = require('./dev-environment');
  applyLocalEnv(process.env);
  const config = developmentConfig(process.env);
  const { PostgresRuntimeStore } = require('../persistence/postgres/store');

  const target = parseConnectionTarget(config.databaseTarget.databaseUrl);
  const preReasons = [...connectionTargetMismatch(target, EXPECTED_TARGET)];
  if (config.postgresSchema !== EXPECTED_TARGET.schema) {
    preReasons.push(`schema ${config.postgresSchema} != expected ${EXPECTED_TARGET.schema}`);
  }
  if (preReasons.length > 0) throw new RepairRefusalError(preReasons);

  const observedScriptSha = scriptSha256();
  const repoObservations = repositoryObservations();
  const authorizationRecordRaw = readAuthorizationRecordRaw();
  let authorizationRecord = null;
  let authorizationRecordSha = null;
  let freshRemoteMaster = null;
  if (mode === 'execute') {
    // Phase A: shape, identity, and authorization state — before any database contact.
    authorizationRecord = validateAuthorizationRecordShape(authorizationRecordRaw);
    authorizationRecordSha = fileSha256(AUTHORIZATION_RECORD_PATH);
    // Fresh remote master authority: the CURRENT origin refs/heads/master tip is established
    // by a live non-mutating query BEFORE any database contact. The cached origin/master
    // tracking ref is diagnostic only; ancestry is evaluated against the fresh tip.
    freshRemoteMaster = freshRemoteMasterSha();
    const baselineIsAncestor = baselineIsAncestorOf(
      authorizationRecord.authorizedBaselineHead, freshRemoteMaster
    );
    // Repository-state and non-digest bindings are enforced before connecting.
    assertAuthorizationBindings(authorizationRecord, {
      scriptSha256: observedScriptSha,
      ...repoObservations,
      freshRemoteMaster,
      baselineIsAncestor
    });
  }

  const store = new PostgresRuntimeStore({
    connectionString: config.databaseTarget.databaseUrl,
    schema: config.postgresSchema
  });
  try {
    // Read-only schema currency verification (REPEATABLE READ READ ONLY inside the store):
    // proves all canonical migrations are applied and no migration identity changed, without
    // running any migration.
    await store.prepareRuntimePersistence();

    const lockStatement = buildLockStatement(config.postgresSchema);
    const runRealityReads = `
      SELECT status, mod(id, 256)::smallint AS shard, COUNT(*)::bigint AS count
        FROM runs GROUP BY status, mod(id, 256) ORDER BY 1, 2`;
    const runCounterReads = `
      SELECT status, shard, count FROM runtime_status_counts
       WHERE entity_type = 'run' ORDER BY status, shard`;
    const ticketCounterReads = `
      SELECT status, shard, count FROM runtime_status_counts
       WHERE entity_type = 'ticket' ORDER BY status, shard`;
    const ticketRealityReads = `
      SELECT status, mod(id, 256)::smallint AS shard, COUNT(*)::bigint AS count
        FROM tickets GROUP BY status, mod(id, 256) ORDER BY 1, 2`;
    const identityReads = `
      SELECT current_database() AS database_name,
             current_setting('server_version') AS server_version,
             pg_postmaster_start_time() AS postmaster_start_time,
             to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS utc_now`;
    // Trigger lookup uses the store's established parameterized to_regclass($1) pattern with a
    // canonically quoted, fully qualified relation name as the parameter. A raw schema-qualified
    // relation expression cast to regclass is INVALID in expression context (PostgreSQL parses
    // it as a qualified column reference and raises 42P01 missing-FROM) and must never reappear;
    // search_path is not relied on.
    const triggerRelationParameter = qualifiedRelationName(config.postgresSchema, 'runs');
    const triggerReads = `
      SELECT t.tgname, t.tgenabled
        FROM pg_trigger AS t
       WHERE t.tgrelid = to_regclass($1)
         AND t.tgname = 'runs_runtime_status_count'`;

    const result = await store.withTransaction(async client => {
      // The only blocking acquisition of this transaction: canonical relative order
      // (runs -> diagnostic_logs -> runtime_status_counts), NOWAIT fail-closed. Everything
      // written below is covered by this statement; afterward only compatibility-safe
      // ACCESS SHARE catalog/schema_migrations reads occur (see TRANSACTION_ACCESS_MODEL).
      await client.query(lockStatement);

      const dbIdentity = (await client.query(identityReads)).rows[0];
      if (dbIdentity.database_name !== EXPECTED_TARGET.database) {
        throw new RepairRefusalError([
          `on-contact database "${dbIdentity.database_name}" != expected "${EXPECTED_TARGET.database}"`
        ]);
      }
      const triggerRows = (await client.query(triggerReads, [triggerRelationParameter])).rows;
      if (triggerRows.length !== 1 || triggerRows[0].tgenabled !== 'O') {
        throw new RepairRefusalError([
          'runs_runtime_status_count trigger missing or not enabled (tgenabled != O); reconstruction would re-drift'
        ]);
      }

      const realityRows = (await client.query(runRealityReads)).rows;
      const runCounterRows = (await client.query(runCounterReads)).rows;
      const ticketCounterRows = (await client.query(ticketCounterReads)).rows;
      const ticketCounterDigest = canonicalDigest(ticketCounterRows);

      let ticketDriftObservation = null;
      if (mode === 'preflight') {
        // Observation only (preflight): reads tickets (ACCESS SHARE, compatibility-safe class)
        // so the authorizing review can verify ticket-reality coherence before pinning the
        // record. The mutation path never reads tickets.
        const ticketRealityRows = (await client.query(ticketRealityReads)).rows;
        ticketDriftObservation = ticketPositiveDrift(ticketRealityRows, ticketCounterRows);
        if (ticketDriftObservation !== 0) {
          throw new RepairRefusalError(['ticket counters show positive drift; adjudicated pre-state has coherent ticket counters']);
        }
      }

      const fence = evaluateRunFence(realityRows, runCounterRows);

      if (mode === 'preflight') {
        return {
          mode: 'preflight',
          semantics: 'NON-MUTATING LOCKING PREFLIGHT: acquires the same NOWAIT share-row-exclusive locks (brief writer contention possible, fails closed on contention), mutates nothing',
          database: dbIdentity.database_name,
          serverVersion: dbIdentity.server_version,
          repository: repositoryEvidence(repoObservations, null),
          authorizationRecord: {
            path: AUTHORIZATION_RECORD_RELATIVE_PATH,
            present: authorizationRecordRaw !== null,
            state: authorizationRecordRaw === null ? null : (() => {
              try {
                const parsed = JSON.parse(authorizationRecordRaw);
                return typeof parsed.authorizationState === 'string' ? parsed.authorizationState : null;
              } catch (_) {
                return 'MALFORMED';
              }
            })()
          },
          scriptSha256: observedScriptSha,
          digests: {
            format: COUNT_DIGEST_FORMAT,
            observedRealityDigest: fence.realityDigest,
            observedRunCounterDigest: fence.runCounterDigest,
            note: 'observed values are evidence only; the authorizing review pins them in the authorization record'
          },
          ticketDriftRows: ticketDriftObservation,
          ticketCounterDigest
        };
      }

      // Phase B: the reviewed full-state digests come ONLY from the authorization record;
      // observed digests are compared, never adopted.
      assertFullStateDigests(fence.realityDigest, fence.runCounterDigest, {
        realityDigest: authorizationRecord.expectedRealityDigest,
        counterDigest: authorizationRecord.expectedCounterDigest
      });

      // ── Reconstruction (adjudicated rule; run scope only) ──
      const deleteResult = await client.query(`DELETE FROM runtime_status_counts WHERE entity_type = 'run'`);
      const insertResult = await client.query(`
        INSERT INTO runtime_status_counts (entity_type, status, shard, count)
        SELECT 'run', status, mod(id, 256)::smallint, COUNT(*)::bigint
          FROM runs
         GROUP BY status, mod(id, 256)`);

      // ── Postconditions (same transaction; any failure rolls back everything) ──
      const postRealityRows = (await client.query(runRealityReads)).rows;
      if (canonicalDigest(postRealityRows) !== fence.realityDigest) {
        throw new RepairRefusalError(['reality changed inside the repair transaction']);
      }
      const postRunCounterRows = (await client.query(runCounterReads)).rows;
      const strictDrift = (await client.query(RUN_SCOPE_DRIFT_QUERY)).rows[0].drift;
      if (Number(strictDrift) !== 0) {
        throw new RepairRefusalError([`run counter drift after reconstruction: ${strictDrift} row(s)`]);
      }
      if (canonicalDigest(postRunCounterRows) !== canonicalDigest(postRealityRows)) {
        throw new RepairRefusalError(['post-state run counter digest != reality digest']);
      }
      const postTicketCounterRows = (await client.query(ticketCounterReads)).rows;
      if (canonicalDigest(postTicketCounterRows) !== ticketCounterDigest) {
        throw new RepairRefusalError(['ticket counter rows changed; ticket scope must remain untouched']);
      }
      const postMigration = (await client.query(
        `SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1`
      )).rows[0];
      if (postMigration.version !== '042_objective_revision_baseline.sql') {
        throw new RepairRefusalError([`latest migration is ${postMigration.version}; expected 042 (schema state changed)`]);
      }
      if (deleteResult.rowCount !== runCounterRows.length || insertResult.rowCount !== realityRows.length) {
        throw new RepairRefusalError([
          `affected row counts unexpected (deleted ${deleteResult.rowCount}, expected ${runCounterRows.length}; inserted ${insertResult.rowCount}, expected ${realityRows.length})`
        ]);
      }

      const occurrence = {
        repairId: REPAIR_ID,
        reconstructionRuleId: RECONSTRUCTION_RULE_ID,
        lockStatement,
        authorizationRecord: {
          path: AUTHORIZATION_RECORD_RELATIVE_PATH,
          sha256: authorizationRecordSha,
          state: authorizationRecord.authorizationState,
          authorizedBy: authorizationRecord.authorizedBy,
          authorizedAtUtc: authorizationRecord.authorizedAtUtc,
          authorizedBaselineHead: authorizationRecord.authorizedBaselineHead
        },
        repository: repositoryEvidence(repoObservations, freshRemoteMaster),
        scriptSha256: observedScriptSha,
        databaseIdentity: {
          host: target.host,
          port: target.port,
          name: dbIdentity.database_name,
          serverVersion: dbIdentity.server_version,
          postmasterStartTime: new Date(dbIdentity.postmaster_start_time).toISOString(),
          schema: config.postgresSchema
        },
        digestFormat: COUNT_DIGEST_FORMAT,
        discrepancyFormat: DISCREPANCY_DIGEST_FORMAT,
        pinnedDiscrepancyDigest: PINNED_DISCREPANCY_DIGEST,
        preState: {
          realityDigest: fence.realityDigest,
          expectedRealityDigest: authorizationRecord.expectedRealityDigest,
          runCounterDigest: fence.runCounterDigest,
          expectedCounterDigest: authorizationRecord.expectedCounterDigest,
          ticketCounterDigest
        },
        postState: {
          realityDigest: canonicalDigest(postRealityRows),
          runCounterDigest: canonicalDigest(postRunCounterRows),
          ticketCounterDigest: canonicalDigest(postTicketCounterRows)
        },
        affectedRows: { deleted: deleteResult.rowCount, inserted: insertResult.rowCount },
        executedAtUtc: dbIdentity.utc_now
      };
      const occurrenceRow = await store.appendSystemLog({
        type: 'operational:run_counter_reconciliation',
        message: `T10 run-counter reconciliation committed (${occurrence.affectedRows.deleted} deleted, ${occurrence.affectedRows.inserted} inserted)`,
        metadata: occurrence
      }, { client });
      return {
        mode: 'execute',
        database: dbIdentity.database_name,
        serverVersion: dbIdentity.server_version,
        repository: repositoryEvidence(repoObservations, freshRemoteMaster),
        scriptSha256: observedScriptSha,
        affectedRows: occurrence.affectedRows,
        occurrenceDiagnosticLogId: occurrenceRow.id,
        preTicketCounterDigest: ticketCounterDigest,
        postCommitVerification: null
      };
    });

    if (mode === 'execute') {
      // Post-commit read-only verification of the same predicates, recorded as a second
      // append-only deployment-scope diagnostic row referencing the occurrence row. This
      // separate transaction takes no explicit locks: ACCESS SHARE reads of runs, counters
      // and tickets in canonical relative order (tickets before diagnostic_logs), then one
      // ordinary diagnostic_logs INSERT.
      const verification = await store.withTransaction(async client => {
        const realityRows = (await client.query(runRealityReads)).rows;
        const runCounterRows = (await client.query(runCounterReads)).rows;
        const ticketCounterRows = (await client.query(ticketCounterReads)).rows;
        const ticketRealityRows = (await client.query(ticketRealityReads)).rows;
        const drift = Number((await client.query(RUN_SCOPE_DRIFT_QUERY)).rows[0].drift);
        const passed = drift === 0
          && canonicalDigest(runCounterRows) === canonicalDigest(realityRows)
          && canonicalDigest(ticketCounterRows) === result.preTicketCounterDigest
          && ticketPositiveDrift(ticketRealityRows, ticketCounterRows) === 0
          && Number(realityRows.reduce((sum, row) => sum + Number(row.count), 0)) === EXPECTED_REALITY_TOTAL;
        const record = {
          repairId: REPAIR_ID,
          verifiedOccurrenceDiagnosticLogId: result.occurrenceDiagnosticLogId,
          passed,
          runCounterDriftRows: drift,
          realityDigest: canonicalDigest(realityRows),
          runCounterDigest: canonicalDigest(runCounterRows),
          ticketCounterDigest: canonicalDigest(ticketCounterRows),
          ticketDriftRows: ticketPositiveDrift(ticketRealityRows, ticketCounterRows),
          realityTotals: countByStatus(realityRows),
          verifiedAtUtc: new Date().toISOString()
        };
        await store.appendSystemLog({
          type: 'operational:run_counter_reconciliation_verified',
          message: `T10 run-counter post-commit verification ${passed ? 'PASSED' : 'FAILED'}`,
          metadata: record
        }, { client });
        return record;
      });
      result.postCommitVerification = {
        passed: verification.passed,
        runCounterDriftRows: verification.runCounterDriftRows,
        ticketDriftRows: verification.ticketDriftRows,
        realityTotals: verification.realityTotals
      };
      if (!verification.passed) process.exitCode = 1;
    }

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await store.close().catch(() => {});
  }
}

async function main() {
  const args = parseArguments(process.argv);
  if (args.mode === 'self-test') {
    selfTest();
    return;
  }
  try {
    await runOperational(args.mode);
  } catch (error) {
    const refusal = error instanceof RepairRefusalError
      ? { refused: true, reasons: error.reasons }
      : { refused: false, error: error.message, code: error.code || null };
    console.error(JSON.stringify(refusal, null, 2));
    process.exitCode = error instanceof RepairRefusalError ? 2 : 1;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
