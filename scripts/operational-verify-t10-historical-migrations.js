#!/usr/bin/env node
'use strict';

// T10 — read-only operational compensating verifier for the historical
// migration 041 / 042 governance adjudication.
//
// PURPOSE. The T10 prevention sub-item is durably CLOSED and published. The
// remaining historical 041/042 adjudication requires bounded compensating
// verification of CURRENT operational convergence; the evidence-sufficiency
// review found exactly four missing proof classes:
//   1. migration-041 amended fact-assembly classifier run TWICE over the
//      CURRENT operational Ticket history with byte-identical canonical
//      results, zero ambiguity, zero contradiction, zero non-migratable rows;
//   2. current T2 five-state/cancellation invariants on operational rows;
//   3. current T3/migration-042 revision coherence on operational rows
//      (pointer, chain, contiguity, provenance, content-hash binding, guard);
//   4. a source-bound writer census proving zero current T2/T3 bypass.
// This verifier proves exactly those classes and emits ONE canonical bounded
// result object (with resultSha256) suitable for durable registration in the
// canonical T10 register. It is NOT a migration runner, repair tool, cutover
// tool, release framework, authority layer, scheduler, or auditing subsystem,
// and it never mutates operational state.
//
// WHAT IT REUSES (no duplicated authority):
//   - scripts/dev-environment.js — the repository-owned DATABASE_URL/env
//     boundary (applyLocalEnv/developmentConfig); target identity is parsed
//     there with credentials dropped, and the operational target is pinned to
//     the repository-approved bundled boundary (host 127.0.0.1, port 5432,
//     database ticket_system, schema ticket_system) — the same pin the
//     published T10 run-counter record established.
//   - persistence/postgres/store.js — PostgresRuntimeStore (pool,
//     schema quoting, canonicalJson for canonical serialization). The store's
//     prepareRuntimePersistence is deliberately NOT called by --verify: it
//     opens its own pool client/transaction, which would split the proof
//     across two snapshots; its migration/identity checks are performed
//     predecessor-equivalently INSIDE the single snapshot instead, and its
//     remaining contributions (required relations/triggers) are narrowed to
//     what historical 041/042 adjudication actually reads.
//   - persistence/postgres/migration-authority.js — observeAppliedMigrationState
//     (the prevention module's own read-only ledger observation).
//   - runtime/ticket-history-classifier-facts.js — the SHARED persistence-row
//     -> classifier-fact boundary (the amended classifier authority; the 041
//     hook consumes exactly these builders).
//   - runtime/ticket-history-classifier-contract.js — classifyTicketHistory
//     (the corrected 041 classifier) and LIFECYCLES (the frozen five-state
//     vocabulary).
//   - runtime/ticket-cancellation-authority-contract.js —
//     normalizeCancellationAuthority (the cancellation authority contract).
//   - runtime/ticket-objective-revision-contract.js — EVENT_TYPE, PROVENANCES,
//     validatePointer, normalizeRevisionEventPayload, canonicalRevisionContent,
//     revisionContentHash (the T3 revision authority).
//   The 041/042 migration hooks themselves are NOT called: they acquire
//   SHARE ROW EXCLUSIVE locks and create temp tables (migration-transaction
//   machinery), which a READ ONLY verification transaction must not do. The
//   verifier composes the hooks' READ path (the same canonical fact builders
//   and classifiers) without their migration-transaction machinery.
//
// READ-ONLY DOCTRINE (--verify). Exactly ONE database transaction total:
//   BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY
//   SET LOCAL search_path ...; SET LOCAL statement_timeout/lock_timeout.
// Every database fact consumed by the final verdict — target identity,
// migration ledger/head state, byte-exact migration identity SHAs, the 041
// classifier double run, T2 current state, and T3/042 revision coherence — is
// observed inside that one coherent snapshot. No helper called by --verify
// opens any other database transaction (the store's prepareRuntimePersistence
// and withTransaction are deliberately NOT used: the former opens its own
// pool client/transaction, which would make the proof depend on two
// snapshots). Every statement is a plain SELECT or catalog read; no advisory
// locks, no FOR UPDATE, no DDL, no temp tables, no diagnostic_logs writes, no
// writes of any kind. Any uncertainty, mismatch, or refusal -> ROLLBACK,
// non-zero exit, no PASS verdict. Unlike the run-counter repair, NO
// occurrence/evidence row is written: durability comes from the published
// verifier bytes, the exact source/target binding, the read-only result
// object, and a subsequent independently reviewed tracked register entry.
//
// SOURCE/PUBLICATION BINDING (--verify, before any database contact):
//   branch master; clean worktree; nothing staged; the verifier file tracked
//   (committed); fresh `git ls-remote --exit-code origin refs/heads/master`
//   returning exactly one well-formed 40-hex refs/heads/master equal to HEAD
//   (the cached origin/master tracking ref is diagnostic only); and the
//   prevention closure commit 05efb8957582941ab08f0a407cde77d8493c64f9 an
//   ancestor of HEAD. Git transport failures are sanitized (exit codes only).
//   No verification result is ever accepted from unpublished verifier bytes:
//   a dirty or uncommitted tree refuses before any database contact.
//
// TARGET BINDING. The parsed non-secret target identity (host, port,
// database, schema) must equal the repository-approved bundled boundary, and
// an on-contact `current_database()` equality check runs inside the snapshot
// before any substantive query. Credentials are parsed then dropped and never
// appear in output, results, or refusals. If target identity cannot be proven
// mechanically, the verifier fails closed.
//
// COMMAND SURFACE: --self-test | --preflight | --verify. There is NO --execute,
// --repair, --migrate, --write, or --fix mode, and no CLI flag or environment
// value can disable the read-only contract. --self-test and --preflight never
// contact any database; --preflight additionally performs the source-bound
// writer census and target-identity checks without connection. --verify is the
// eventual live read-only verification and requires separate authorization.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  PostgresRuntimeStore,
  canonicalJson
} = require('../persistence/postgres/store');
const { observeAppliedMigrationState } = require('../persistence/postgres/migration-authority');
const {
  ticketFact,
  attemptFact,
  runFact,
  consequenceFact,
  planFact,
  eventFact,
  logFact,
  factsForTicket
} = require('../runtime/ticket-history-classifier-facts');
const {
  classifyTicketHistory,
  LIFECYCLES
} = require('../runtime/ticket-history-classifier-contract');
const {
  normalizeCancellationAuthority
} = require('../runtime/ticket-cancellation-authority-contract');
const {
  EVENT_TYPE,
  PROVENANCES,
  validatePointer,
  normalizeRevisionEventPayload,
  canonicalRevisionContent,
  revisionContentHash
} = require('../runtime/ticket-objective-revision-contract');

const ROOT = path.join(__dirname, '..');
const VERIFIER_VERSION = 't10-historical-migrations-verify-v1';
const VERIFIER_RELATIVE_PATH = 'scripts/operational-verify-t10-historical-migrations.js';
// The published prevention closure commit (T10 prevention sub-item CLOSED).
const PREVENTION_CLOSURE_COMMIT = '05efb8957582941ab08f0a407cde77d8493c64f9';
// The repository-approved bundled operational boundary (existing contract:
// see the published T10 run-counter authorization record and register entry).
const EXPECTED_TARGET = Object.freeze({
  host: '127.0.0.1',
  port: 5432,
  database: 'ticket_system',
  schema: 'ticket_system'
});
const MIGRATION_HEAD = '042_objective_revision_baseline.sql';
const MIGRATION_VERSION_PATTERN = /^[0-9]{3}_[a-z0-9_]+\.sql$/;
const READ_ONLY_BEGIN = 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY';

class VerificationRefusalError extends Error {
  constructor(reasons) {
    super(`T10 historical-migration verification refused: ${reasons.join('; ')}`);
    this.name = 'VerificationRefusalError';
    this.code = 'T10_HISTORICAL_VERIFICATION_REFUSED';
    this.reasons = Object.freeze([...reasons]);
  }
}

// ── Pure helpers (self-testable; no database/network) ────────────────────────

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fileSha256(absolutePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');
}

// Non-secret connection-target identity. Credentials are dropped here and are
// never surfaced in results, refusals, or evidence.
function parseConnectionTarget(connectionString) {
  if (typeof connectionString !== 'string' || !connectionString.trim()) {
    throw new VerificationRefusalError(['connection target identity is unavailable']);
  }
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch (_) {
    throw new VerificationRefusalError(['connection target is not a valid URL']);
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new VerificationRefusalError(['connection target must use postgres:// or postgresql://']);
  }
  if (!parsed.hostname || !parsed.pathname || parsed.pathname === '/') {
    throw new VerificationRefusalError(['connection target must name a host and database']);
  }
  return Object.freeze({
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    database: decodeURIComponent(parsed.pathname.slice(1))
  });
}

function connectionTargetMismatch(target, expected) {
  const reasons = [];
  if (target.host !== expected.host) reasons.push(`target host ${target.host} != expected ${expected.host}`);
  if (target.port !== expected.port) reasons.push(`target port ${target.port} != expected ${expected.port}`);
  if (target.database !== expected.database) {
    reasons.push(`target database ${target.database} != expected ${expected.database}`);
  }
  return reasons;
}

// Evidence-only enumeration of the canonical migration files. The exact
// "ledger complete / identities byte-exact" validation runs INSIDE the one
// coherent verification snapshot (evaluateMigrationIdentityState) against
// these files' real bytes; this listing only binds the observed evidence to
// the canonical repository file set and must agree with it.
function canonicalMigrationFileList(migrationsDir) {
  const files = fs.readdirSync(migrationsDir)
    .filter(name => name.endsWith('.sql'))
    .sort();
  if (files.length === 0 ||
      files.some(name => !MIGRATION_VERSION_PATTERN.test(name)) ||
      new Set(files.map(name => name.slice(0, 3))).size !== files.length) {
    throw new VerificationRefusalError(['migration file enumeration is not canonical']);
  }
  return files;
}

function runGitSanitized(args) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    // Sanitized: git stderr/stdout are never surfaced — remote transport and
    // credential-helper errors can embed secret material; refusals report
    // only the command shape and exit status.
    const detail = error && typeof error.status === 'number'
      ? `exit code ${error.status}`
      : 'failed';
    throw new VerificationRefusalError([`git ${args[0]} ${detail} — repository authority could not be established`]);
  }
}

const FRESH_REMOTE_LINE = /^([0-9a-f]{40})\trefs\/heads\/master$/;

function parseFreshRemoteOutput(stdout) {
  const lines = String(stdout)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
  if (lines.length === 0) {
    throw new VerificationRefusalError(['fresh canonical master query returned no refs/heads/master']);
  }
  const shas = [];
  for (const line of lines) {
    const match = FRESH_REMOTE_LINE.exec(line);
    if (!match) {
      throw new VerificationRefusalError(['fresh canonical master query returned unexpected output']);
    }
    shas.push(match[1]);
  }
  if (shas.length > 1) {
    throw new VerificationRefusalError(['fresh canonical master query returned ambiguous results']);
  }
  return shas[0];
}

function freshRemoteMasterSha() {
  const stdout = runGitSanitized(['ls-remote', '--exit-code', 'origin', 'refs/heads/master']);
  return parseFreshRemoteOutput(stdout);
}

// Phase-A repository/source/publication authority. `mode` 'preflight' performs
// every check that needs no database; 'verify' requires the full binding.
function repositoryAuthority({ requirePublishedVerifier }) {
  const reasons = [];
  const branch = runGitSanitized(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (branch !== 'master') reasons.push(`branch ${branch} != master`);
  const head = runGitSanitized(['rev-parse', 'HEAD']).trim();
  if (!/^[0-9a-f]{40}$/.test(head)) reasons.push('repository HEAD is not a 40-hex commit id');
  const status = runGitSanitized(['status', '--porcelain']);
  if (status.trim().length > 0) {
    reasons.push('repository worktree is not clean (verifier must be committed and unmodified)');
  }
  let verifierTracked = true;
  try {
    runGitSanitized(['ls-files', '--error-unmatch', '--', VERIFIER_RELATIVE_PATH]);
  } catch (error) {
    if (error instanceof VerificationRefusalError) {
      verifierTracked = false;
      reasons.push(`verifier is not tracked at ${VERIFIER_RELATIVE_PATH}`);
    } else {
      throw error;
    }
  }
  let freshRemoteMaster = null;
  if (requirePublishedVerifier) {
    freshRemoteMaster = freshRemoteMasterSha();
    if (head !== freshRemoteMaster) {
      reasons.push(`repository HEAD ${head} != freshly queried origin refs/heads/master ${freshRemoteMaster}`);
    }
    let closureIsAncestor = true;
    try {
      runGitSanitized(['merge-base', '--is-ancestor', PREVENTION_CLOSURE_COMMIT, head]);
    } catch (error) {
      if (error instanceof VerificationRefusalError) {
        closureIsAncestor = false;
        reasons.push(`prevention closure commit ${PREVENTION_CLOSURE_COMMIT} is not an ancestor of HEAD`);
      } else {
        throw error;
      }
    }
  }
  if (reasons.length > 0) throw new VerificationRefusalError(reasons);
  return Object.freeze({
    branch,
    head,
    clean: true,
    verifierTracked,
    freshRemoteMaster
  });
}

// Canonical serialization of one ticket's adjudication-relevant classifier
// result. Bounded: identifiers, canonical classes, sorted reason codes, and
// reference keys only — never ticket bodies, reasons' raw payloads, or
// user-owned content.
function canonicalizeClassifierResult(result) {
  return {
    ticketId: result.ticketId,
    classification: result.classification,
    proposedLifecycle: result.proposedLifecycle,
    closedClassification: result.closedClassification,
    reasonCodes: [...(result.reasons || [])].map(reason => reason.code).sort(),
    authorityReferenceKeys: Object.keys(result.authorityReferences || {}).sort()
  };
}

function canonicalizeClassifierRun(perTicketResults) {
  const tickets = perTicketResults
    .map(canonicalizeClassifierResult)
    .sort((left, right) => left.ticketId - right.ticketId);
  const counts = { migratable: 0, ambiguous: 0, integrity_contradiction: 0 };
  for (const ticket of tickets) {
    if (!Object.prototype.hasOwnProperty.call(counts, ticket.classification)) {
      counts[ticket.classification] = 0;
    }
    counts[ticket.classification] += 1;
  }
  const materializationMismatchCount = tickets.filter(ticket =>
    ticket.reasonCodes.includes('HISTORY_CLASSIFIER_LEGACY_STATUS_MATERIALIZATION_MISMATCH')).length;
  const proposedLifecycleMismatchCount = tickets.filter(ticket =>
    ticket.classification === 'migratable' &&
    ticket.proposedLifecycle !== null &&
    ticket.reasonCodes.includes('HISTORY_CLASSIFIER_LEGACY_STATUS_MATERIALIZATION_MISMATCH')).length;
  return Object.freeze({
    ticketCount: tickets.length,
    classificationCounts: counts,
    ambiguityCount: counts.ambiguous,
    contradictionCount: counts.integrity_contradiction,
    nonMigratableCount: tickets.length - counts.migratable,
    materializationMismatchCount,
    proposedLifecycleMismatchCount,
    tickets
  });
}

// The repository-defined successful classifier condition (the corrected 041
// classifier contract / hook semantics): EVERY Ticket classifies 'migratable'
// with a canonical proposed lifecycle; anything else (ambiguous,
// integrity_contradiction, thrown classifier error, non-canonical lifecycle)
// is a failure. Materialization-mismatch REASONS are recorded exactly and are
// not failures by themselves — the authority-first model records divergence.
function evaluateClassifierRun(run) {
  const reasons = [];
  if (run.ambiguityCount !== 0) reasons.push(`classifier ambiguity count ${run.ambiguityCount} != 0`);
  if (run.contradictionCount !== 0) {
    reasons.push(`classifier contradiction count ${run.contradictionCount} != 0`);
  }
  if (run.nonMigratableCount !== 0) {
    reasons.push(`classifier non-migratable count ${run.nonMigratableCount} != 0`);
  }
  return { ok: reasons.length === 0, reasons };
}

function evaluateT2CurrentState(t2) {
  const reasons = [];
  if (t2.outsideVocabularyTicketCount !== 0) {
    reasons.push(`T2: ${t2.outsideVocabularyTicketCount} Ticket status value(s) outside the frozen five-state vocabulary`);
  }
  if (t2.failedTicketCount !== 0) {
    reasons.push(`T2: ${t2.failedTicketCount} Ticket row(s) carry Run-only status failed`);
  }
  if (t2.malformedCancellationAuthorityCount !== 0) {
    reasons.push(`T2: ${t2.malformedCancellationAuthorityCount} Ticket(s) carry malformed cancellation authority`);
  }
  if (t2.cancellationDisagreementCount !== 0) {
    reasons.push(`T2: ${t2.cancellationDisagreementCount} Ticket(s) disagree between canceled status and cancellation authority (canonical 041 hook rule)`);
  }
  if (!t2.cancellationShapeConstraintInstalled) {
    reasons.push('T2: tickets_cancellation_authority_shape constraint is missing or not validated');
  }
  return { ok: reasons.length === 0, reasons };
}

function evaluateT3RevisionCoherence(t3) {
  const reasons = [];
  for (const [failureClass, count] of Object.entries(t3.failureCounts)) {
    if (count !== 0) reasons.push(`T3/042: ${count} Ticket(s) with ${failureClass}`);
  }
  if (!t3.revisionGuardEnabled) {
    reasons.push('T3/042: tickets_revision_guard is missing or not origin-enabled');
  }
  return { ok: reasons.length === 0, reasons };
}

// Exact in-snapshot migration state evaluation (predecessor-equivalent to the
// store's runtime-start migration/identity checks, performed INSIDE the one
// coherent verification snapshot). The verdict 'exact' requires:
//   - the schema and ledger exist (canonical prevention-module observation);
//   - the ledger version ORDER equals the canonical repository file order
//     exactly (no missing, no stray/future version, no reorder);
//   - the identity version set equals the canonical repository file set
//     exactly (no missing, no stray identity row);
//   - EVERY stored identity SHA256 byte-equals the SHA256 of the corresponding
//     canonical repository migration SQL file (byte-exact source custody);
//   - the current head is exactly 042_objective_revision_baseline.sql.
function evaluateMigrationIdentityState({
  observeState,
  expectedFiles,
  fileShaByVersion,
  ledgerRows,
  identityRows
}) {
  const failureClasses = {};
  const note = failureClass => {
    failureClasses[failureClass] = (failureClasses[failureClass] || 0) + 1;
  };
  const ledgerVersions = ledgerRows.map(row => row.version);
  const identityVersions = identityRows.map(row => row.version);
  if (!observeState.schemaExists) note('schemaMissing');
  if (!observeState.ledgerExists) note('ledgerMissing');
  if (observeState.schemaExists && observeState.ledgerExists) {
    if (ledgerVersions.length !== expectedFiles.length) note('ledgerCountMismatch');
    for (let index = 0; index < Math.max(ledgerVersions.length, expectedFiles.length); index += 1) {
      if (ledgerVersions[index] !== expectedFiles[index]) {
        note(ledgerVersions[index] === undefined ? 'missingLedgerVersion' : 'strayOrReorderedLedgerVersion');
      }
    }
    const ledgerSet = new Set(ledgerVersions);
    for (const expected of expectedFiles) {
      if (!ledgerSet.has(expected)) note('missingLedgerVersion');
    }
    for (const actual of ledgerVersions) {
      if (!expectedFiles.includes(actual)) note('strayOrFutureLedgerVersion');
    }
    if (identityVersions.length !== expectedFiles.length) note('identityCountMismatch');
    const identityByVersion = new Map(identityRows.map(row => [row.version, row.sha256]));
    for (const expected of expectedFiles) {
      const stored = identityByVersion.get(expected);
      if (stored === undefined) note('missingIdentityRow');
      else if (stored !== fileShaByVersion.get(expected)) note('storedShaMismatch');
    }
    for (const actual of identityVersions) {
      if (!expectedFiles.includes(actual)) note('strayIdentityRow');
    }
  }
  const head = ledgerVersions.length > 0 ? ledgerVersions[ledgerVersions.length - 1] : null;
  if (head !== MIGRATION_HEAD) note('wrongHead');
  const evidence = {
    migrationFileCount: expectedFiles.length,
    migrationIdentityCount: identityRows.length,
    migrationLedgerDigest: sha256Hex(canonicalJson(ledgerVersions)),
    migrationIdentityDigest: sha256Hex(canonicalJson(
      [...identityRows].sort((left, right) => left.version.localeCompare(right.version))
        .map(row => ({ version: row.version, sha256: row.sha256 })))),
    head
  };
  const verdict = Object.keys(failureClasses).length === 0 ? 'exact' : 'drift';
  return { verdict, failureClasses, evidence };
}

// Canonical result-shape validation. A malformed/partial result object can
// never be emitted as PASS evidence.
function validateResultShape(result) {
  const required = [
    'verifierVersion', 'repositoryCommit', 'freshRemoteMaster', 'nonSecretTargetIdentity',
    'transactionIsolation', 'transactionReadOnly', 'migrationHead', 'migrationIdentityVerdict',
    'migrationFileCount', 'migrationIdentityCount', 'migrationIdentityDigest', 'migrationLedgerDigest',
    'classifierRunADigest', 'classifierRunBDigest', 'classifierDeterministic',
    'classifier', 't2CurrentState', 't3RevisionCoherence', 'writerCensus',
    'startedAtUtc', 'completedAtUtc', 'overallPassed', 'failureClasses', 'resultSha256'
  ];
  const keys = Object.keys(result);
  const missing = required.filter(key => !keys.includes(key));
  const extra = keys.filter(key => !required.includes(key));
  const reasons = [];
  if (missing.length > 0) reasons.push(`result missing field(s): ${missing.join(', ')}`);
  if (extra.length > 0) reasons.push(`result has unknown field(s): ${extra.join(', ')}`);
  if (result.transactionIsolation !== 'REPEATABLE READ') {
    reasons.push('result transactionIsolation must be REPEATABLE READ');
  }
  if (result.transactionReadOnly !== true) {
    reasons.push('result transactionReadOnly must be true');
  }
  if (result.verifierVersion !== VERIFIER_VERSION) {
    reasons.push(`result verifierVersion must be ${VERIFIER_VERSION}`);
  }
  if (typeof result.resultSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(result.resultSha256)) {
    reasons.push('result resultSha256 must be a lowercase sha256 digest');
  }
  if (reasons.length > 0) throw new VerificationRefusalError(reasons);
  return result;
}

function canonicalResultDigest(result) {
  const { resultSha256, ...rest } = result;
  if (resultSha256 !== undefined) {
    throw new VerificationRefusalError(['resultSha256 must be computed, never supplied']);
  }
  return sha256Hex(canonicalJson(rest));
}

// ── Source-bound writer census (pure; binds the verified published bytes) ────
//
// The census binds the exact published HEAD being verified. Sanctioned
// production Ticket writers are the store's canonical methods (each
// enumerated below with the enforcement tokens that must remain present).
// Any OTHER tracked production file issuing Ticket-table SQL or touching
// objectiveRevision content is a bypass. Tests, fixtures, and migration SQL
// (historical transformation machinery) are out of scope by contract.

const SANCTIONED_TICKET_WRITERS = Object.freeze([
  { file: 'persistence/postgres/store.js', symbol: 'async _createTicketRecord(' },
  { file: 'persistence/postgres/store.js', symbol: 'async createTicket(' },
  { file: 'persistence/postgres/store.js', symbol: 'async createTicketWithEvent(' },
  { file: 'persistence/postgres/store.js', symbol: 'async createRunsAndStartTicket(' },
  { file: 'persistence/postgres/store.js', symbol: 'async transitionTicket(' },
  { file: 'persistence/postgres/store.js', symbol: 'async transitionTicketState(' },
  { file: 'persistence/postgres/store.js', symbol: 'async reviseTicketObjective(' },
  { file: 'persistence/postgres/store.js', symbol: '_appendCreationObjectiveRevisionEvent(' },
  { file: 'persistence/postgres/store.js', symbol: '_buildInitialObjectiveRevision(' }
]);

const TICKET_ENFORCEMENT_TOKENS = Object.freeze([
  { file: 'persistence/postgres/store.js', token: "new Set(['open', 'in_progress', 'blocked', 'completed', 'canceled'])", why: 'frozen five-state vocabulary' },
  { file: 'persistence/postgres/store.js', token: 'ADMISSION_INTEGRITY_ERROR_CODE', why: 'admission integrity enforcement' },
  { file: 'persistence/postgres/store.js', token: 'TICKET_OBJECTIVE_REVISION_REQUIRED', why: 'generic transition content lock' },
  { file: 'persistence/postgres/store.js', token: 'STRUCTURED_ALLOCATION_OBJECTIVE_IMMUTABLE', why: 'structured-objective immutability' }
]);

// Historical transformation machinery is excluded from the census by
// contract (the T10 prevention entry and the frozen migration hooks): the
// migration-time backfill hooks ran exactly once under migration authority
// and are not reachable production writer paths.
const WRITER_CENSUS_EXCLUDED_FILES = Object.freeze([
  'persistence/postgres/t039-ticket-attempt-backfill.js',
  'persistence/postgres/t041-five-state-backfill.js',
  'persistence/postgres/t042-objective-revision-baseline.js',
  'persistence/postgres/ticket-attempt-backfill.js'
]);

const PRODUCTION_SCAN_ROOTS = Object.freeze(['persistence', 'runtime', 'server.js']);
// Single-line Ticket-table SQL write pattern (SQL statements in production
// source are single-line strings; the newline exclusion prevents prose/HTML
// false positives spanning lines).
const TICKET_SQL_WRITE_PATTERN = /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)[^;'"`\n]*\btickets\b/i;

function listProductionFiles(repoRoot) {
  const files = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  for (const root of PRODUCTION_SCAN_ROOTS) {
    const full = path.join(repoRoot, root);
    if (fs.statSync(full).isDirectory()) walk(full);
    else files.push(full);
  }
  return files;
}

function computeWriterCensus(repoRoot) {
  const bypasses = [];
  const missing = [];
  for (const writer of SANCTIONED_TICKET_WRITERS) {
    const source = fs.readFileSync(path.join(repoRoot, writer.file), 'utf8');
    if (!source.includes(writer.symbol)) missing.push(`${writer.file}: ${writer.symbol}`);
  }
  for (const enforcement of TICKET_ENFORCEMENT_TOKENS) {
    const source = fs.readFileSync(path.join(repoRoot, enforcement.file), 'utf8');
    if (!source.includes(enforcement.token)) {
      missing.push(`${enforcement.file}: enforcement token absent (${enforcement.why})`);
    }
  }
  for (const absolute of listProductionFiles(repoRoot)) {
    const relative = path.relative(repoRoot, absolute).split(path.sep).join('/');
    if (relative === 'persistence/postgres/store.js') continue;
    if (WRITER_CENSUS_EXCLUDED_FILES.includes(relative)) continue;
    const source = fs.readFileSync(absolute, 'utf8');
    // Every Ticket state/intent mutation is Ticket-table SQL somewhere in
    // production source. The scan proves only the sanctioned store writers
    // (and the excluded historical migration machinery) can issue it; the
    // asserted enforcement tokens prove content/state authority is locked
    // inside those writers. Reader-only occurrences of revision fields are
    // not writers and are deliberately not scanned.
    if (TICKET_SQL_WRITE_PATTERN.test(source)) {
      bypasses.push(relative);
    }
  }
  const manifestSource = canonicalJson({
    writers: SANCTIONED_TICKET_WRITERS,
    enforcement: TICKET_ENFORCEMENT_TOKENS.map(entry => ({ file: entry.file, token: entry.token, why: entry.why })),
    scanRoots: PRODUCTION_SCAN_ROOTS
  });
  return {
    writerCount: SANCTIONED_TICKET_WRITERS.length,
    writerCensusDigest: sha256Hex(manifestSource),
    bypassCount: bypasses.length,
    bypasses,
    missing
  };
}

function evaluateWriterCensus(census) {
  const reasons = [];
  if (census.missing.length > 0) reasons.push(`writer census: sanctioned writer(s) absent: ${census.missing.join('; ')}`);
  if (census.bypassCount !== 0) reasons.push(`writer census: ${census.bypassCount} production bypass file(s): ${census.bypasses.join(', ')}`);
  return { ok: reasons.length === 0, reasons };
}

// ── Self-test (pure; no database, no network) ────────────────────────────────

function selfTest() {
  const cases = [];
  const ok = (condition, message) => cases.push({ condition, message });

  // Canonical result serialization/digest stability.
  const base = {
    verifierVersion: VERIFIER_VERSION,
    repositoryCommit: 'a'.repeat(40),
    freshRemoteMaster: 'a'.repeat(40),
    nonSecretTargetIdentity: { host: '127.0.0.1', port: 5432, database: 'ticket_system', schema: 'ticket_system' },
    transactionIsolation: 'REPEATABLE READ',
    transactionReadOnly: true,
    migrationHead: MIGRATION_HEAD,
    migrationIdentityVerdict: 'exact',
    migrationFileCount: 42,
    migrationIdentityCount: 42,
    migrationIdentityDigest: 'c'.repeat(64),
    migrationLedgerDigest: 'd'.repeat(64),
    classifierRunADigest: 'b'.repeat(64),
    classifierRunBDigest: 'b'.repeat(64),
    classifierDeterministic: true,
    classifier: { ticketCount: 0 },
    t2CurrentState: { outsideVocabularyTicketCount: 0 },
    t3RevisionCoherence: { failureCounts: {}, revisionGuardEnabled: true },
    writerCensus: { writerCount: 9, bypassCount: 0 },
    startedAtUtc: '2026-08-31T00:00:00.000Z',
    completedAtUtc: '2026-08-31T00:00:01.000Z',
    overallPassed: true,
    failureClasses: []
  };
  const digestOne = canonicalResultDigest(base);
  const reordered = { ...base };
  ok(digestOne === canonicalResultDigest(reordered), 'result digest is stable under key order');

  // Malformed/partial result refusal.
  let shapeThrew = false;
  try {
    validateResultShape({ ...base, resultSha256: digestOne, unexpected: true });
  } catch (_) { shapeThrew = true; }
  ok(shapeThrew, 'result with unknown field is refused');
  shapeThrew = false;
  try {
    validateResultShape({ ...base, transactionReadOnly: false, resultSha256: digestOne });
  } catch (_) { shapeThrew = true; }
  ok(shapeThrew, 'non-read-only result is refused');
  shapeThrew = false;
  try {
    canonicalResultDigest({ ...base, resultSha256: digestOne });
  } catch (_) { shapeThrew = true; }
  ok(shapeThrew, 'self-supplied resultSha256 is refused');

  // Secret redaction: credentials parsed then dropped.
  const target = parseConnectionTarget('postgresql://ticket_system:secret-password@127.0.0.1:5432/ticket_system');
  ok(target.host === '127.0.0.1' && target.port === 5432 && target.database === 'ticket_system',
    'target parses to non-secret identity');
  ok(!canonicalJson(target).includes('secret-password'), 'serialized target never contains credentials');
  ok(connectionTargetMismatch(target, EXPECTED_TARGET).length === 0, 'bundled target matches the pinned boundary');
  ok(connectionTargetMismatch({ ...target, database: 'other' }, EXPECTED_TARGET).length === 1,
    'foreign database target is detected');

  // Read-only transaction contract construction.
  ok(READ_ONLY_BEGIN === 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'snapshot begin statement is exactly REPEATABLE READ READ ONLY');

  // Classifier canonicalization + evaluation over the REAL classifier with
  // synthetic fact fixtures (contract-level, no database).
  const classifierFacts = ticketId => ({
    ticket: {
      id: ticketId, status: 'open', cancellationAuthority: null,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
    },
    attempts: [], runs: [], consequences: [], plans: [], events: [], logs: []
  });
  const cleanRun = classifyTicketHistory(classifierFacts(1));
  const canonicalRun = canonicalizeClassifierRun([cleanRun]);
  ok(canonicalRun.classificationCounts.migratable === 1 && canonicalRun.ambiguityCount === 0,
    'clean synthetic ticket classifies migratable with zero ambiguity');
  ok(evaluateClassifierRun(canonicalRun).ok, 'canonical successful classifier condition holds');

  // Ambiguity refusal: two legacy close operations on one ticket -> ambiguous
  // (the classifier requires exactly one close event/log operation pair).
  // Synthetic raw rows are routed through the REAL shared fact-assembly
  // builders, so the fixture exercises the amended fact boundary + classifier
  // exactly as the 041 hook does.
  const closeEvent = (position, ts) => ({
    id: position, position, type: 'ticket.updated', ticket_id: 2, run_id: null, ts,
    payload: { status: 'closed', previousStatus: 'open', changedBy: 'operator' }
  });
  const closeLog = (id, ts) => ({
    id, ticket_id: 2, run_id: null, context_ticket_id: null, context_run_id: null,
    type: 'ticket:status_change', occurred_at: ts,
    body: { ticketId: 2, fromStatus: 'open', toStatus: 'closed', changedBy: 'operator' }
  });
  const ambiguousFacts = {
    ...classifierFacts(2),
    ticket: { ...classifierFacts(2).ticket, status: 'closed' },
    events: [closeEvent(1, '2026-01-02T00:00:00.000Z'), closeEvent(2, '2026-01-03T00:00:00.000Z')].map(eventFact),
    logs: [closeLog(1, '2026-01-02T00:00:01.000Z'), closeLog(2, '2026-01-03T00:00:01.000Z')].map(logFact)
  };
  const ambiguousRun = canonicalizeClassifierRun([classifyTicketHistory(ambiguousFacts)]);
  ok(ambiguousRun.ambiguityCount === 1, 'two legacy close operations classify ambiguous');
  ok(!evaluateClassifierRun(ambiguousRun).ok, 'ambiguous classification refuses the successful condition');

  // Contradiction refusal: malformed cancellation authority.
  const contradictionFacts = {
    ...classifierFacts(3),
    ticket: { ...classifierFacts(3).ticket, cancellationAuthority: { nope: true } }
  };
  const contradictionRun = canonicalizeClassifierRun([classifyTicketHistory(contradictionFacts)]);
  ok(contradictionRun.contradictionCount === 1, 'malformed cancellation authority classifies integrity_contradiction');
  ok(!evaluateClassifierRun(contradictionRun).ok, 'integrity contradiction refuses the successful condition');

  // Deterministic double-run inequality refusal.
  const digestA = sha256Hex(canonicalJson(canonicalRun));
  const digestB = sha256Hex(canonicalJson(ambiguousRun));
  const doubleRunEvaluation = digestA === digestB
    ? { ok: true, reasons: [] }
    : { ok: false, reasons: ['classifier double-run digests differ'] };
  ok(!doubleRunEvaluation.ok, 'differing double-run digests refuse deterministicEquality');

  // T2 evaluation refusals.
  ok(!evaluateT2CurrentState({
    outsideVocabularyTicketCount: 1, failedTicketCount: 0, malformedCancellationAuthorityCount: 0,
    cancellationDisagreementCount: 0, cancellationShapeConstraintInstalled: true
  }).ok, 'outside-vocabulary ticket status refuses T2');
  ok(!evaluateT2CurrentState({
    outsideVocabularyTicketCount: 0, failedTicketCount: 2, malformedCancellationAuthorityCount: 0,
    cancellationDisagreementCount: 0, cancellationShapeConstraintInstalled: true
  }).ok, 'ticket status failed refuses T2 (FAILED remains Run-only)');
  ok(!evaluateT2CurrentState({
    outsideVocabularyTicketCount: 0, failedTicketCount: 0, malformedCancellationAuthorityCount: 1,
    cancellationDisagreementCount: 0, cancellationShapeConstraintInstalled: true
  }).ok, 'malformed cancellation authority refuses T2');
  ok(!evaluateT2CurrentState({
    outsideVocabularyTicketCount: 0, failedTicketCount: 0, malformedCancellationAuthorityCount: 0,
    cancellationDisagreementCount: 1, cancellationShapeConstraintInstalled: true
  }).ok, 'canceled/authority disagreement refuses T2');
  ok(!evaluateT2CurrentState({
    outsideVocabularyTicketCount: 0, failedTicketCount: 0, malformedCancellationAuthorityCount: 0,
    cancellationDisagreementCount: 0, cancellationShapeConstraintInstalled: false
  }).ok, 'missing cancellation shape constraint refuses T2');
  ok(evaluateT2CurrentState({
    outsideVocabularyTicketCount: 0, failedTicketCount: 0, malformedCancellationAuthorityCount: 0,
    cancellationDisagreementCount: 0, cancellationShapeConstraintInstalled: true
  }).ok, 'clean T2 summary passes');

  // T3/042 evaluation refusals through the REAL contract functions.
  const pointerCheck = (pointer, events, currentContent) => {
    try {
      const validatedPointer = validatePointer(pointer);
      const normalized = events.map(normalizeRevisionEventPayload).sort((l, r) => l.number - r.number);
      for (let index = 0; index < normalized.length; index += 1) {
        if (normalized[index].number !== index + 1) return 'nonContiguousChain';
        if (index > 0 && normalized[index].previous.hash !== normalized[index - 1].contentHash) return 'brokenChainHash';
      }
      const head = normalized[normalized.length - 1];
      if (!head || head.number !== validatedPointer.number || head.contentHash !== validatedPointer.hash) {
        return 'pointerHeadDivergence';
      }
      if (revisionContentHash(canonicalRevisionContent(currentContent)) !== validatedPointer.hash) {
        return 'contentHashBindingBroken';
      }
      return null;
    } catch (error) {
      return error.code === 'T3_OBJECTIVE_REVISION_INVALID'
        ? `invalidPayload:${error.message}`
        : `unexpected:${error.message}`;
    }
  };
  const goodContent = { objective: 'Outcome', acceptanceCriteria: null };
  const goodHash = revisionContentHash(canonicalRevisionContent(goodContent));
  const goodPayload = {
    number: 1, provenance: 't3_activation_baseline', content: goodContent, contentHash: goodHash,
    previous: null, actor: 'migration:042_objective_revision_baseline', reasonCode: 'legacy_baseline',
    reason: null, capturedAt: '2026-08-24T00:00:00.000Z'
  };
  ok(pointerCheck({ number: 1, hash: goodHash }, [goodPayload], goodContent) === null,
    'coherent baseline pointer/event chain passes');
  ok(pointerCheck(null, [goodPayload], goodContent) !== null, 'missing pointer refuses');
  ok(pointerCheck({ number: 1, hash: 'z'.repeat(64) }, [goodPayload], goodContent) !== null,
    'malformed pointer hash refuses');
  const nonContiguous = [{
    ...goodPayload, number: 2, provenance: 'revision', previous: { number: 1, hash: goodHash },
    reasonCode: 'correction', reason: 'clarified'
  }];
  ok(pointerCheck({ number: 2, hash: goodHash }, nonContiguous, goodContent) === 'nonContiguousChain',
    'non-contiguous revision chain refuses');
  const badProvenance = [{ ...goodPayload, provenance: 'backfill' }];
  ok(pointerCheck({ number: 1, hash: goodHash }, badProvenance, goodContent) !== null,
    'invalid provenance refuses');
  const brokenHash = [{ ...goodPayload, contentHash: 'a'.repeat(64) }];
  ok(pointerCheck({ number: 1, hash: goodHash }, brokenHash, goodContent) !== null,
    'content-hash binding mismatch refuses');
  ok(pointerCheck({ number: 2, hash: goodHash }, [goodPayload], goodContent) === 'pointerHeadDivergence',
    'pointer/head divergence refuses');
  ok(!evaluateT3RevisionCoherence({
    failureCounts: { missingRevisionPointer: 1 }, revisionGuardEnabled: true
  }).ok, 'T3 summary with missing pointer refuses');
  ok(!evaluateT3RevisionCoherence({
    failureCounts: {}, revisionGuardEnabled: false
  }).ok, 'disabled/missing tickets_revision_guard refuses');
  ok(evaluateT3RevisionCoherence({ failureCounts: {}, revisionGuardEnabled: true }).ok,
    'clean T3 summary passes');

  // Writer census evaluation refusals.
  ok(!evaluateWriterCensus({ writerCount: 9, writerCensusDigest: 'x', bypassCount: 1, bypasses: ['runtime/x.js'], missing: [] }).ok,
    'writer bypass refuses the census');
  ok(!evaluateWriterCensus({ writerCount: 9, writerCensusDigest: 'x', bypassCount: 0, bypasses: [], missing: ['store: createTicket'] }).ok,
    'absent sanctioned writer refuses the census');
  ok(evaluateWriterCensus({ writerCount: 9, writerCensusDigest: 'x', bypassCount: 0, bypasses: [], missing: [] }).ok,
    'clean writer census passes');

  // ── In-snapshot exact migration identity validation ─────────────────────
  const expectedFiles = ['001_a.sql', '002_b.sql', '042_objective_revision_baseline.sql'];
  const fileShaByVersion = new Map(expectedFiles.map(version => [version, sha256Hex(`bytes:${version}`)]));
  const observeState = { schemaExists: true, ledgerExists: true };
  const identityRowsFor = versions => versions.map(version => ({
    version, sha256: fileShaByVersion.get(version) || sha256Hex(`stored:${version}`)
  }));
  const ledgerRowsFor = versions => versions.map(version => ({ version }));
  const cleanIdentity = evaluateMigrationIdentityState({
    observeState,
    expectedFiles,
    fileShaByVersion,
    ledgerRows: ledgerRowsFor(expectedFiles),
    identityRows: identityRowsFor(expectedFiles)
  });
  ok(cleanIdentity.verdict === 'exact' && cleanIdentity.evidence.migrationFileCount === 3 &&
     cleanIdentity.evidence.migrationIdentityCount === 3 &&
     /^[0-9a-f]{64}$/.test(cleanIdentity.evidence.migrationIdentityDigest) &&
     /^[0-9a-f]{64}$/.test(cleanIdentity.evidence.migrationLedgerDigest),
    'exact ledger/identity state validates with bounded evidence digests');

  const expectDrift = (result, failureClass, message) => {
    ok(result.verdict === 'drift' && (result.failureClasses[failureClass] || 0) >= 1, message);
  };
  const shaMismatch = evaluateMigrationIdentityState({
    observeState,
    expectedFiles,
    fileShaByVersion,
    ledgerRows: ledgerRowsFor(expectedFiles),
    identityRows: [{ version: '001_a.sql', sha256: sha256Hex('tampered') }, ...identityRowsFor(expectedFiles).slice(1)]
  });
  expectDrift(shaMismatch, 'storedShaMismatch', 'stored identity SHA != repository migration file bytes refuses');
  expectDrift(evaluateMigrationIdentityState({
    observeState, expectedFiles, fileShaByVersion,
    ledgerRows: ledgerRowsFor(expectedFiles),
    identityRows: identityRowsFor(expectedFiles).slice(1)
  }), 'missingIdentityRow', 'missing identity row refuses');
  expectDrift(evaluateMigrationIdentityState({
    observeState, expectedFiles, fileShaByVersion,
    ledgerRows: ledgerRowsFor(expectedFiles),
    identityRows: [...identityRowsFor(expectedFiles), { version: '999_stray.sql', sha256: sha256Hex('stray') }]
  }), 'strayIdentityRow', 'stray identity row refuses');
  expectDrift(evaluateMigrationIdentityState({
    observeState, expectedFiles, fileShaByVersion,
    ledgerRows: ledgerRowsFor(expectedFiles.slice(1)),
    identityRows: identityRowsFor(expectedFiles)
  }), 'missingLedgerVersion', 'missing ledger version refuses');
  expectDrift(evaluateMigrationIdentityState({
    observeState, expectedFiles, fileShaByVersion,
    ledgerRows: ledgerRowsFor([...expectedFiles, '999_future.sql']),
    identityRows: identityRowsFor(expectedFiles)
  }), 'strayOrFutureLedgerVersion', 'stray/future ledger version refuses');
  expectDrift(evaluateMigrationIdentityState({
    observeState, expectedFiles, fileShaByVersion,
    ledgerRows: ledgerRowsFor([expectedFiles[1], expectedFiles[0], expectedFiles[2]]),
    identityRows: identityRowsFor(expectedFiles)
  }), 'strayOrReorderedLedgerVersion', 'reordered ledger versions refuse (order is authoritative)');
  expectDrift(evaluateMigrationIdentityState({
    observeState, expectedFiles, fileShaByVersion,
    ledgerRows: ledgerRowsFor([...expectedFiles.slice(0, -1), '041_ticket_five_state_cutover.sql']),
    identityRows: identityRowsFor(expectedFiles)
  }), 'wrongHead', 'wrong migration head refuses');
  expectDrift(evaluateMigrationIdentityState({
    observeState: { schemaExists: false, ledgerExists: false },
    expectedFiles, fileShaByVersion,
    ledgerRows: [], identityRows: []
  }), 'schemaMissing', 'missing schema refuses');
  expectDrift(evaluateMigrationIdentityState({
    observeState: { schemaExists: true, ledgerExists: false },
    expectedFiles, fileShaByVersion, ledgerRows: [], identityRows: []
  }), 'ledgerMissing', 'missing ledger refuses');
  ok(evaluateMigrationIdentityState({
    observeState, expectedFiles, fileShaByVersion,
    ledgerRows: ledgerRowsFor(expectedFiles),
    identityRows: identityRowsFor(expectedFiles)
  }).evidence.head === '042_objective_revision_baseline.sql', 'exact evidence carries the 042 head');

  // Static single-transaction contract. The scan runs over the --verify call
  // graph slice (runVerify .. main) so the assertions cannot match their own
  // text: the scanned region contains exactly one transaction-opening
  // statement via the READ_ONLY_BEGIN constant, exactly one client
  // acquisition, and no other transaction opener, locking, or mutating
  // statement. Forbidden identifiers are assembled from fragments so this
  // self-test never embeds the literal it refuses.
  // lastIndexOf: the self-test's own slice-locating literals appear earlier
  // in the file than the real definitions.
  const verifierSource = fs.readFileSync(__filename, 'utf8');
  const sliceStart = verifierSource.lastIndexOf('async function runVerify()');
  const sliceEnd = verifierSource.lastIndexOf('async function main()');
  ok(sliceStart !== -1 && sliceEnd !== -1 && sliceStart < sliceEnd, 'verify call-graph slice is locatable');
  if (sliceStart !== -1 && sliceEnd !== -1 && sliceStart < sliceEnd) {
    const verifySlice = verifierSource.slice(sliceStart, sliceEnd);
    const withoutComments = verifySlice.split('\n')
      .filter(line => !/^\s*\/\//.test(line))
      .join('\n');
    ok((withoutComments.match(/await client\.query\(READ_ONLY_BEGIN\)/g) || []).length === 1,
      'the verify path opens exactly one transaction via READ_ONLY_BEGIN');
    ok((withoutComments.match(/pool\.connect\(/g) || []).length === 1,
      'exactly one database client acquisition exists in the verify path');
    ok(READ_ONLY_BEGIN === 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'the opened transaction is exactly REPEATABLE READ READ ONLY');
    const forbidden = [
      ['prepare', 'RuntimePersistence'], ['with', 'Transaction'],
      ['pg_', 'advisory'], ['FOR ', 'UPDATE'], ['CREATE ', 'TEMP'],
      ['LOCK ', 'TABLE'], ['INSERT ', 'INTO'], ['ALTER ', 'TABLE'],
      ['DELETE ', 'FROM'], ['UPDATE ', 'tickets']
    ].map(parts => parts.join(''));
    for (const token of forbidden) {
      ok(!withoutComments.includes(token), `verify path contains no ${token} statement`);
    }
  }

  const failures = cases.filter(item => !item.condition);
  for (const failure of failures) console.error(`self-test failure: ${failure.message}`);
  if (failures.length > 0) {
    console.error(`${failures.length} self-test failure(s)`);
    process.exit(1);
  }
  console.log(`${cases.length} self-test checks passed (no database or network contacted)`);
}

// ── Operational paths (never reached by --self-test) ─────────────────────────

function parseArguments(argv) {
  const args = { mode: null };
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--self-test') args.mode = 'self-test';
    else if (value === '--preflight') args.mode = 'preflight';
    else if (value === '--verify') args.mode = 'verify';
    else throw new VerificationRefusalError([`unknown argument: ${value}`]);
  }
  if (!args.mode) {
    throw new VerificationRefusalError(['mode required: --self-test | --preflight | --verify']);
  }
  return args;
}

function resolvePinnedTarget() {
  const { applyLocalEnv, developmentConfig } = require('./dev-environment');
  applyLocalEnv(process.env);
  const config = developmentConfig(process.env);
  const target = parseConnectionTarget(config.databaseTarget.databaseUrl);
  const reasons = [...connectionTargetMismatch(target, EXPECTED_TARGET)];
  if (config.postgresSchema !== EXPECTED_TARGET.schema) {
    reasons.push(`schema ${config.postgresSchema} != expected ${EXPECTED_TARGET.schema}`);
  }
  if (reasons.length > 0) throw new VerificationRefusalError(reasons);
  return { config, target };
}

// 041 classifier run over the CURRENT operational fact set, composed from the
// canonical shared fact-assembly boundary and the corrected classifier (the
// same semantic path as the 041 hook's H2/H3, without its migration-transaction
// machinery). One run = one independent fact READ + assembly + classification
// pass inside the coherent snapshot.
async function runClassifierPass(client, store) {
  const tickets = (await client.query(
    `SELECT id, status, cancellation_authority, body, created_at, updated_at
       FROM ${store.table('tickets')} ORDER BY id`)).rows;
  const attempts = (await client.query(
    `SELECT id, ticket_id, ordinal, member_count, disposition, admitted_at, settled_at, revision
       FROM ${store.table('ticket_attempts')} ORDER BY ticket_id, ordinal`)).rows;
  const runs = (await client.query(
    `SELECT id, ticket_id, ticket_attempt_id, status, body, created_at, updated_at, completed_at
       FROM ${store.table('runs')} ORDER BY ticket_id, id`)).rows;
  const consequences = (await client.query(
    `SELECT run_id, ticket_id, consequence, recorded_at
       FROM ${store.table('run_consequences')} ORDER BY ticket_id, run_id`)).rows;
  const plans = (await client.query(
    `SELECT id, ticket_id, status, body, revision, created_at, updated_at
       FROM ${store.table('allocation_plans')} ORDER BY ticket_id, id`)).rows;
  const events = (await client.query(
    `SELECT id, position, ticket_id, run_id, type, ts, payload
       FROM ${store.table('events')} ORDER BY position`)).rows;
  const logs = (await client.query(
    `SELECT id, ticket_id, run_id, context_ticket_id, context_run_id, type, occurred_at, body
       FROM ${store.table('diagnostic_logs')} ORDER BY id`)).rows;
  const facts = {
    tickets: tickets.map(ticketFact),
    attempts: attempts.map(attemptFact),
    runs: runs.map(runFact),
    consequences: consequences.map(consequenceFact),
    plans: plans.map(planFact),
    events: events.map(eventFact),
    logs: logs.map(logFact)
  };
  const results = [];
  const thrownErrors = [];
  for (const ticketRow of tickets) {
    const ticketId = Number(ticketRow.id);
    const owned = factsForTicket(facts, ticketId);
    let result;
    try {
      result = classifyTicketHistory({ ...owned, ticket: owned.ticket });
    } catch (error) {
      thrownErrors.push(`ticket ${ticketId}: ${error.code || ''} ${error.message}`);
      continue;
    }
    results.push(result);
  }
  const run = canonicalizeClassifierRun(results);
  const digest = sha256Hex(canonicalJson(run));
  return { run, digest, thrownErrors };
}

// T2 current-state verification over the snapshot.
async function verifyT2CurrentState(client, store) {
  const tickets = (await client.query(
    `SELECT id, status, cancellation_authority FROM ${store.table('tickets')} ORDER BY id`)).rows;
  let outsideVocabularyTicketCount = 0;
  let failedTicketCount = 0;
  let malformedCancellationAuthorityCount = 0;
  let cancellationDisagreementCount = 0;
  for (const row of tickets) {
    const status = row.status;
    if (!LIFECYCLES.has(status)) outsideVocabularyTicketCount += 1;
    if (status === 'failed') failedTicketCount += 1;
    if (row.cancellation_authority !== null && row.cancellation_authority !== undefined) {
      try {
        normalizeCancellationAuthority(row.cancellation_authority, { expectedTicketId: Number(row.id) });
      } catch (_) {
        malformedCancellationAuthorityCount += 1;
      }
    }
    // Canonical 041 hook rule (H4): canceled status and cancellation authority
    // must agree exactly — a non-null existing authority is never replaced or
    // cleared, and canceled ⟺ authority present.
    if ((status === 'canceled') !== (row.cancellation_authority !== null && row.cancellation_authority !== undefined)) {
      cancellationDisagreementCount += 1;
    }
  }
  const shapeConstraint = (await client.query(
    `SELECT count(*)::int AS n FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      WHERE rel.relname = 'tickets'
        AND nsp.nspname = current_schema()
        AND con.conname = 'tickets_cancellation_authority_shape'
        AND con.convalidated = true`)).rows[0].n;
  const t2 = {
    ticketCount: tickets.length,
    outsideVocabularyTicketCount,
    failedTicketCount,
    malformedCancellationAuthorityCount,
    cancellationDisagreementCount,
    cancellationShapeConstraintInstalled: shapeConstraint === 1
  };
  return t2;
}

// T3/042 revision-coherence verification over the snapshot, composed from the
// canonical T3 contract (validatePointer, normalizeRevisionEventPayload,
// revisionContentHash). Failure classes are bounded; no raw bodies leave the
// transaction.
async function verifyT3RevisionCoherence(client, store) {
  const tickets = (await client.query(
    `SELECT id, body FROM ${store.table('tickets')} ORDER BY id`)).rows;
  const events = (await client.query(
    `SELECT ticket_id, position, payload FROM ${store.table('events')}
      WHERE type = $1 ORDER BY ticket_id, position`, [EVENT_TYPE])).rows;
  const eventsByTicket = new Map();
  for (const row of events) {
    const ticketId = Number(row.ticket_id);
    if (!eventsByTicket.has(ticketId)) eventsByTicket.set(ticketId, []);
    eventsByTicket.get(ticketId).push(row);
  }
  const failureCounts = {
    missingRevisionPointer: 0,
    invalidPointer: 0,
    missingRevisionChain: 0,
    invalidEventPayload: 0,
    nonContiguousChain: 0,
    brokenChainHash: 0,
    pointerHeadDivergence: 0,
    contentHashBindingBroken: 0,
    unexpectedProvenance: 0,
    orphanRevisionEvents: 0
  };
  const guardRow = (await client.query(
    `SELECT t.tgenabled FROM pg_trigger t
      WHERE t.tgrelid = to_regclass($1) AND t.tgname = 'tickets_revision_guard'`,
    [`${store.schemaSql}.tickets`])).rows;
  const revisionGuardEnabled = guardRow.length === 1 && guardRow[0].tgenabled === 'O';
  for (const row of tickets) {
    const ticketId = Number(row.id);
    const body = row.body || {};
    const ticketEvents = eventsByTicket.get(ticketId) || [];
    let pointer;
    try {
      pointer = validatePointer(body.objectiveRevision);
    } catch (_) {
      if (body.objectiveRevision === undefined || body.objectiveRevision === null) {
        failureCounts.missingRevisionPointer += 1;
      } else {
        failureCounts.invalidPointer += 1;
      }
      continue;
    }
    if (ticketEvents.length === 0) {
      failureCounts.missingRevisionChain += 1;
      continue;
    }
    let chain;
    try {
      chain = ticketEvents.map(row2 => normalizeRevisionEventPayload(row2.payload));
    } catch (_) {
      failureCounts.invalidEventPayload += 1;
      continue;
    }
    for (let index = 0; index < chain.length; index += 1) {
      const event = chain[index];
      if (event.number !== index + 1) {
        failureCounts.nonContiguousChain += 1;
        break;
      }
      if (index === 0 && !PROVENANCES.slice(0, 2).includes(event.provenance)) {
        // Revision 1 must be creation or t3_activation_baseline (the canonical
        // provenance set for establishing revision 1).
        failureCounts.unexpectedProvenance += 1;
        break;
      }
      if (index > 0 && (event.previous.hash !== chain[index - 1].contentHash ||
          event.previous.number !== chain[index - 1].number)) {
        failureCounts.brokenChainHash += 1;
        break;
      }
    }
    const head = chain[chain.length - 1];
    if (head && (head.number !== pointer.number || head.contentHash !== pointer.hash)) {
      failureCounts.pointerHeadDivergence += 1;
      continue;
    }
    // The pointer hash BINDS the currently stored canonical requested-outcome
    // content (every sanctioned content change advances the pointer).
    try {
      const currentHash = revisionContentHash(canonicalRevisionContent({
        objective: body.objective,
        acceptanceCriteria: body.acceptanceCriteria === undefined ? null : body.acceptanceCriteria
      }));
      if (currentHash !== pointer.hash) failureCounts.contentHashBindingBroken += 1;
    } catch (_) {
      failureCounts.contentHashBindingBroken += 1;
    }
  }
  for (const ticketId of eventsByTicket.keys()) {
    if (!tickets.some(row => Number(row.id) === ticketId)) failureCounts.orphanRevisionEvents += 1;
  }
  return {
    ticketCount: tickets.length,
    revisionEventTicketCount: eventsByTicket.size,
    failureCounts,
    revisionGuardEnabled
  };
}

async function runVerify() {
  const startedAtUtc = new Date().toISOString();
  const authority = repositoryAuthority({ requirePublishedVerifier: true });
  const { config, target } = resolvePinnedTarget();
  const census = computeWriterCensus(ROOT);
  const censusEvaluation = evaluateWriterCensus(census);
  if (!censusEvaluation.ok) throw new VerificationRefusalError(censusEvaluation.reasons);

  const store = new PostgresRuntimeStore({
    connectionString: config.databaseTarget.databaseUrl,
    schema: config.postgresSchema
  });
  let client;
  let result = null;
  try {
    // ONE coherent verification transaction: every database fact consumed by
    // the final verdict — target identity, migration/ledger/identity state
    // (including byte-exact identity SHAs), the 041 classifier double run,
    // T2 current state, and T3/042 revision coherence — is observed inside
    // this single REPEATABLE READ READ ONLY snapshot. No helper called here
    // opens any other database transaction.
    client = await store.pool.connect();
    await client.query(READ_ONLY_BEGIN);
    await client.query(`SET LOCAL search_path TO ${store.schemaSql}, public`);
    await client.query(`SET LOCAL statement_timeout = '300s'`);
    await client.query(`SET LOCAL lock_timeout = '5s'`);

    const dbIdentity = (await client.query('SELECT current_database() AS name')).rows[0];
    if (dbIdentity.name !== EXPECTED_TARGET.database) {
      throw new VerificationRefusalError([
        `on-contact database "${dbIdentity.name}" != expected "${EXPECTED_TARGET.database}"`
      ]);
    }

    // Migration precondition evidence (inside the same coherent snapshot).
    // Exact predecessor-equivalent migration/identity validation: the verdict
    // depends on the byte-exact version+SHA comparison below.
    const observeState = await observeAppliedMigrationState(client, {
      schema: store.schema,
      schemaSql: store.schemaSql
    });
    const expectedFiles = canonicalMigrationFileList(
      path.join(__dirname, '..', 'persistence', 'postgres', 'migrations'));
    const fileShaByVersion = new Map(expectedFiles.map(version => [
      version,
      fileSha256(path.join(__dirname, '..', 'persistence', 'postgres', 'migrations', version))
    ]));
    const ledgerRows = (await client.query(
      `SELECT version FROM ${store.table('schema_migrations')} ORDER BY version`)).rows;
    const identityRows = (await client.query(
      `SELECT version, sha256 FROM ${store.table('schema_migration_identities')} ORDER BY version`)).rows;
    const migrationIdentity = evaluateMigrationIdentityState({
      observeState,
      expectedFiles,
      fileShaByVersion,
      ledgerRows,
      identityRows
    });
    if (migrationIdentity.verdict !== 'exact') {
      const detail = Object.entries(migrationIdentity.failureClasses)
        .map(([failureClass, count]) => `${failureClass}=${count}`).join(', ');
      throw new VerificationRefusalError([`migration ledger/identity state is not suitable for adjudication: ${detail}`]);
    }

    // Predecessor-equivalent read-set relation existence (the store's
    // runtime-start required-relations check, bounded to the relations this
    // verifier reads; refuse fail-closed with a clear class instead of a raw
    // 42P01 mid-verification).
    const readSetRelations = ['tickets', 'ticket_attempts', 'runs', 'run_consequences',
      'allocation_plans', 'events', 'diagnostic_logs', 'schema_migrations',
      'schema_migration_identities'];
    for (const relation of readSetRelations) {
      const exists = (await client.query(
        'SELECT to_regclass($1) AS name', [`${store.schemaSql}.${relation}`])).rows[0].name;
      if (exists === null) {
        throw new VerificationRefusalError([`required relation is missing: ${relation}`]);
      }
    }

    // 041 amended-classifier double run (independent fact read/assembly/
    // classification passes within one coherent snapshot).
    const runA = await runClassifierPass(client, store);
    const runB = await runClassifierPass(client, store);
    const classifierDeterministic = runA.digest === runB.digest && runA.thrownErrors.length === 0 && runB.thrownErrors.length === 0;
    if (!classifierDeterministic) {
      const reasons = ['classifier double-run digests differ or a classification threw'];
      reasons.push(...runA.thrownErrors, ...runB.thrownErrors);
      throw new VerificationRefusalError(reasons);
    }
    const runAEvaluation = evaluateClassifierRun(runA.run);
    if (!runAEvaluation.ok) throw new VerificationRefusalError(runAEvaluation.reasons);

    // T2 current state.
    const t2 = await verifyT2CurrentState(client, store);
    const t2Evaluation = evaluateT2CurrentState(t2);
    if (!t2Evaluation.ok) throw new VerificationRefusalError(t2Evaluation.reasons);

    // T3/042 revision coherence.
    const t3 = await verifyT3RevisionCoherence(client, store);
    const t3Evaluation = evaluateT3RevisionCoherence(t3);
    if (!t3Evaluation.ok) throw new VerificationRefusalError(t3Evaluation.reasons);

    await client.query('COMMIT');

    result = {
      verifierVersion: VERIFIER_VERSION,
      repositoryCommit: authority.head,
      freshRemoteMaster: authority.freshRemoteMaster,
      nonSecretTargetIdentity: { ...target, schema: config.postgresSchema },
      transactionIsolation: 'REPEATABLE READ',
      transactionReadOnly: true,
      migrationHead: migrationIdentity.evidence.head,
      migrationIdentityVerdict: migrationIdentity.verdict,
      migrationFileCount: migrationIdentity.evidence.migrationFileCount,
      migrationIdentityCount: migrationIdentity.evidence.migrationIdentityCount,
      migrationIdentityDigest: migrationIdentity.evidence.migrationIdentityDigest,
      migrationLedgerDigest: migrationIdentity.evidence.migrationLedgerDigest,
      classifierRunADigest: runA.digest,
      classifierRunBDigest: runB.digest,
      classifierDeterministic,
      classifier: {
        ticketCount: runA.run.ticketCount,
        classificationCounts: runA.run.classificationCounts,
        ambiguityCount: runA.run.ambiguityCount,
        contradictionCount: runA.run.contradictionCount,
        nonMigratableCount: runA.run.nonMigratableCount,
        materializationMismatchCount: runA.run.materializationMismatchCount,
        proposedLifecycleMismatchCount: runA.run.proposedLifecycleMismatchCount
      },
      t2CurrentState: t2,
      t3RevisionCoherence: t3,
      writerCensus: {
        writerCount: census.writerCount,
        writerCensusDigest: census.writerCensusDigest,
        bypassCount: census.bypassCount
      },
      startedAtUtc,
      completedAtUtc: new Date().toISOString(),
      overallPassed: true,
      failureClasses: []
    };
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    const failureClasses = error instanceof VerificationRefusalError
      ? error.reasons
      : [`${error.code || error.name || 'Error'}: ${error.message}`];
    result = {
      verifierVersion: VERIFIER_VERSION,
      repositoryCommit: authority.head,
      freshRemoteMaster: authority.freshRemoteMaster,
      nonSecretTargetIdentity: { ...target, schema: config.postgresSchema },
      transactionIsolation: 'REPEATABLE READ',
      transactionReadOnly: true,
      migrationHead: null,
      migrationIdentityVerdict: 'unverified',
      migrationFileCount: null,
      migrationIdentityCount: null,
      migrationIdentityDigest: null,
      migrationLedgerDigest: null,
      classifierRunADigest: null,
      classifierRunBDigest: null,
      classifierDeterministic: false,
      classifier: null,
      t2CurrentState: null,
      t3RevisionCoherence: null,
      writerCensus: {
        writerCount: census.writerCount,
        writerCensusDigest: census.writerCensusDigest,
        bypassCount: census.bypassCount
      },
      startedAtUtc,
      completedAtUtc: new Date().toISOString(),
      overallPassed: false,
      failureClasses
    };
  } finally {
    if (client) client.release();
    try { await store.close(); } catch (_) {}
  }

  const resultSha256 = canonicalResultDigest(result);
  const complete = Object.freeze({ ...result, resultSha256 });
  validateResultShape(complete);
  console.log(canonicalJson(complete));
  if (!complete.overallPassed) process.exit(1);
}

async function main() {
  const args = parseArguments(process.argv);
  if (args.mode === 'self-test') {
    selfTest();
    return undefined;
  }
  if (args.mode === 'preflight') {
    const authority = repositoryAuthority({ requirePublishedVerifier: false });
    const { target } = resolvePinnedTarget();
    const census = computeWriterCensus(ROOT);
    const censusEvaluation = evaluateWriterCensus(census);
    if (!censusEvaluation.ok) throw new VerificationRefusalError(censusEvaluation.reasons);
    const files = canonicalMigrationFileList(path.join(__dirname, '..', 'persistence', 'postgres', 'migrations'));
    console.log(canonicalJson({
      mode: 'preflight',
      verifierVersion: VERIFIER_VERSION,
      repositoryCommit: authority.head,
      branch: authority.branch,
      verifierTracked: authority.verifierTracked,
      freshRemoteMaster: authority.freshRemoteMaster,
      nonSecretTargetIdentity: target,
      expectedTarget: EXPECTED_TARGET,
      migrationFileCount: files.length,
      migrationHead: files[files.length - 1],
      writerCensus: {
        writerCount: census.writerCount,
        writerCensusDigest: census.writerCensusDigest,
        bypassCount: census.bypassCount
      },
      preflightPassed: true,
      note: 'no database and no git-remote contact occurred during preflight; publication equality is enforced at --verify time'
    }));
    return undefined;
  }
  return runVerify();
}

// Pure surface export (focused review tooling); CLI behavior unchanged.
module.exports = {
  VERIFIER_VERSION,
  PREVENTION_CLOSURE_COMMIT,
  EXPECTED_TARGET,
  MIGRATION_HEAD,
  READ_ONLY_BEGIN,
  sha256Hex,
  parseConnectionTarget,
  connectionTargetMismatch,
  canonicalMigrationFileList,
  parseFreshRemoteOutput,
  canonicalizeClassifierRun,
  evaluateClassifierRun,
  evaluateT2CurrentState,
  evaluateT3RevisionCoherence,
  evaluateMigrationIdentityState,
  validateResultShape,
  canonicalResultDigest,
  computeWriterCensus,
  evaluateWriterCensus
};

if (require.main === module) {
  main().catch(error => {
    const reasons = error instanceof VerificationRefusalError
      ? error.reasons
      : [`${error.code || error.name || 'Error'}: ${error.message}`];
    console.error(`FAIL: ${reasons.join('; ')}`);
    process.exit(1);
  });
}
