# Authority & Durability

Purpose: Record where live ticket/run state actually lives, what survives a restart,
and what projection rebuild does — so the "policy/triage isn't event-sourced" caveat
stops resurfacing as a suspected defect.

Status: The JSON live-state and storage descriptions in the sections below describe the
**retired JSON runtime adapter** and are kept as a decision record. PostgreSQL is the
sole current runtime authority. Canonical current authority: `docs/POSTGRES_CUTOVER.md`
and `docs/RUN_EVIDENCE_AUTHORITY_SOURCE_OF_TRUTH.md`. The `data/*.json` paths named
below are not live runtime persistence.

Decision (recorded under the retired JSON adapter): **Option A** (from the durability
audits). The materialized JSON files were authoritative for live state under that
adapter; projection rebuild is diagnostic tooling, not a restore path. Policy and
triage annotations are intentionally **not** event-sourced at this time. Two read-only
audits found no blocker.

---

## 1. Authoritative files under the retired JSON adapter

| File | Authoritative for |
| ---- | ----------------- |
| `data/tickets.json` | Live ticket state: status, `executionPolicy` (incl. `maxAttempts`), ticket-level `triage` and its resolution annotation |
| `data/runs.json` | Live run state: status, `executionPolicySnapshot`, `verificationContractSnapshot`, run-level `triage` and its resolution annotation, `runEvaluation` |
| `data/logs.json` | Audit trail for operator annotation/control changes (e.g. `ticket:max_attempts_change`, `ticket:triage_resolve`, `run:triage_resolve`, status/assignment changes) |
| `data/events.jsonl` | Append-only lifecycle/event log (run lifecycle, verification verdicts, `ticket.blocked`, `run.triage_created`, status changes). **Not** the live read path. |
| `data/replay-snapshots/run-<id>.json` | Per-run execution evidence (replay snapshot), referenced by `run.replaySnapshotPath` |

Under that adapter the running server read and wrote the JSON files directly
(`readTickets`/`writeTickets`, `readRuns`/`writeRuns`); it did not reconstruct live
state by replaying `events.jsonl`. Current runtime state is read and written through
the PostgreSQL-backed runtime store (`persistence/postgres/store.js`); the JSON files
are not live runtime persistence, and event reconstruction remains diagnostic and
reduced rather than a live read path.

## 2. What survives a normal restart

Under the retired adapter, all of the following were persisted in the authoritative
JSON above and preserved across process restart and startup reconciliation:

- `executionPolicy` (initial value)
- `maxAttempts` edits (operator control)
- ticket-level triage and run-level triage
- triage resolution annotations (`required: false`, `resolvedAt`, `resolvedBy`,
  `resolution`) — never overwritten: `persistRunTriage` returns early when a triage
  already exists, and reconciliation only builds triage when none is present
- system logs (`logs.json`)
- replay snapshots (`replay-snapshots/*.json`)

Under the current PostgreSQL authority, these same state classes are durable in the
database (see `docs/RUN_EVIDENCE_AUTHORITY_SOURCE_OF_TRUTH.md`).

Normal persistence through the runtime store is sufficient for normal operation.
Manual completion gates (ticket triage, latest-run status, run triage, verification)
are evaluated live from the authoritative Ticket/Run state — the PostgreSQL
`tickets`/`runs` relations under the current runtime — at request time.

## 3. What projection rebuild does

Projection rebuild is implemented by `scripts/projection-rebuilder.js` and its
consumers (`scripts/rebuild-tickets-projection.js`, `scripts/rebuild-runs-projection.js`,
`scripts/create-snapshot.js`, `scripts/projection-integrity-audit.js`,
`scripts/verify-snapshot.js`). It:

- **reads** `events.jsonl` (and the data files only in `--compare` mode);
- **compares / audits / emits** a reconstructed *status and lifecycle* projection to
  stdout, or writes a separate snapshot/manifest file;
- **does not** overwrite `tickets.json` or `runs.json`;
- **does not** rebuild or restore `executionPolicy`, `maxAttempts` edits, ticket/run
  triage, or triage resolution (the rebuilder has no references to these fields);
- **does not** regenerate replay snapshot files.

It is **diagnostic / compare / integrity tooling** — invoked by CLI/tests only. It is
**not** wired into server startup and is **not** an operational recovery path. The
server never restores live state from it. These scripts consume the disposable JSON
corpus under `data/` (retired diagnostic input), not current runtime authority.

## 4. Warning

> Projection rebuild output is a reduced status/lifecycle view. It MUST NOT be used as
> a lossy restore of live state (it would drop `executionPolicy`/`maxAttempts`, triage,
> and triage resolution) unless a future tranche first teaches the rebuilder to
> **preserve** policy and triage annotations rather than reset them.

If such a restore path is ever introduced, it must fold these annotations from the
authoritative state records (and from existing `ticket.blocked` / `run.triage_created`
events), never default them away. Note also that `scripts/projection-integrity-audit.js` proves
status/lifecycle from events only; it does not currently cover policy/triage fields.

## 5. Current decision

Do **not** use the reduced projection as a policy or triage restore path. PostgreSQL is
the runtime authority, and a lossy reconstruction would not be fail-safe:
`maxAttempts: null` means inherit the runtime default when a new run is admitted, and
`autoRetry: true` remains active under that effective bound. Any future restore path must
preserve the original policy and immutable admitted budget snapshot rather than inventing
an unlimited or inactive policy. This is a documentation/architecture record only — no
runtime behavior change.
