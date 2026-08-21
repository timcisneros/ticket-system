# T2 Implementation Tranche 4

## Zero-Mutation Five-State Historical Classifier

This tranche implements and proves the read-only historical Ticket classifier.
It does not create migration 041, change Ticket lifecycle behavior, expose a
product cancellation path, or inspect the operational database.

## Classifier Contract

`runtime/ticket-history-classifier-contract.js` is pure. It consumes Ticket,
Attempt, Run, allocation-plan, consequence, event, and diagnostic-log facts and
returns one deterministic result per Ticket:

```json
{
  "ticketId": 1,
  "legacyStatus": "closed",
  "classification": "migratable|ambiguous|integrity_contradiction",
  "proposedLifecycle": "open|in_progress|blocked|completed|canceled|null",
  "authorityReferences": {},
  "closedClassification": "proven_canceled|proven_not_canceled|ambiguous|null",
  "historicalCancellationAuthority": null,
  "reasons": [{ "code": "...", "references": {} }]
}
```

Legacy status is consistency evidence only. CLOSED classification reconstructs
durable authority before `closeAt`, excludes the close operation and its
consequences, derives the frozen lifecycle, then applies the CLOSED matrix.
FAILED is demoted first. Identical reconstructed authority and close evidence
classify identically regardless of legacy status.

## V2 and As-of Ordering

`aggregateDecision.decidedAt` and `allocation_plans.updated_at` describe only
the mutable current projection. Reconciliation events preserve partial
observations, not complete aggregate history. The classifier therefore derives
historical v2 completion from immutable leaf membership and append-only Run
terminal/completion evidence ordered before `closeAt`. Missing or unorderable
plan/evidence facts produce refusal or ambiguity.

## Zero-Mutation Command

`scripts/t2-five-state-classifier.js` uses raw `SELECT` statements only. It
starts `BEGIN READ ONLY`, verifies `transaction_read_only=on`, optionally
verifies `current_database()` with `--expected-database`, classifies, rolls
back, and emits stable JSON with a SHA-256 `reportHash`. It does not call
reconciliation or event-writing store methods and has no `DATABASE_URL`
fallback.

Future operational invocation must use an explicitly supplied, separately
verified connection environment variable and expected database name:

```sh
node scripts/t2-five-state-classifier.js \
  --database-url-env T2_CLASSIFIER_OPERATIONAL_DATABASE_URL \
  --expected-database ticket_system \
  --schema public \
  --report /secure/preflight/t2-five-state-classifier.json
```

The operator must verify the intended target out-of-band, use a read-only role
or transaction, inspect the report, and run no migration. Credentials and
connection strings are never written to the report.

## Synthetic Proof

The pure matrix covers valid and invalid OPEN, IN_PROGRESS, COMPLETED, FAILED
demotion, BLOCKED, CLOSED completion/cancellation, missing/conflicting close
evidence, operator/timestamp gaps, matched/partial interruption, cancellation
authority, post-close evidence, v2 completion, insufficient v2 evidence, and
legacy-status equivalence.

The PostgreSQL fixture creates repository-owned legacy traces in an isolated
schema, runs the classifier twice in separate READ ONLY transactions, compares
byte-identical reports, and snapshots tickets, attempts, runs, plans,
consequences, replay snapshots, receipts, events, and diagnostic logs before
and after classification.

## Results

- Pure classifier contract: 28 assertions passed.
- PostgreSQL classifier/report proof: 10 assertions passed per run.
- Three independent PostgreSQL runs passed.
- Reports and hashes were byte-identical on repeated classification.
- All snapshotted tables were logically unchanged during classifier phases.
- Build/syntax passed.

## Remaining Boundary

The next operation is the separately authorized operational read-only preflight.
It must enumerate every Ticket and refuse ambiguous or contradictory rows.
Only after a zero-ambiguity report may migration 041 be designed and executed.
