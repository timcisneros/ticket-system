# Authority & Durability

Purpose: Record where live ticket/run state actually lives, what survives a restart,
and what projection rebuild does — so the "policy/triage isn't event-sourced" caveat
stops resurfacing as a suspected defect.

Decision: **Option A** (from the durability audits). The materialized JSON files are
authoritative for live state; projection rebuild is diagnostic tooling, not a restore
path. Policy and triage annotations are intentionally **not** event-sourced at this
time. Two read-only audits found no blocker.

---

## 1. Authoritative files

| File | Authoritative for |
| ---- | ----------------- |
| `data/tickets.json` | Live ticket state: status, `executionPolicy` (incl. `maxAttempts`), ticket-level `triage` and its resolution annotation |
| `data/runs.json` | Live run state: status, `executionPolicySnapshot`, `verificationContractSnapshot`, run-level `triage` and its resolution annotation, `runEvaluation` |
| `data/logs.json` | Audit trail for operator annotation/control changes (e.g. `ticket:max_attempts_change`, `ticket:triage_resolve`, `run:triage_resolve`, status/assignment changes) |
| `data/events.jsonl` | Append-only lifecycle/event log (run lifecycle, verification verdicts, `ticket.blocked`, `run.triage_created`, status changes). **Not** the live read path. |
| `data/replay-snapshots/run-<id>.json` | Per-run execution evidence (replay snapshot), referenced by `run.replaySnapshotPath` |

The running server reads and writes the JSON files directly (`readTickets`/`writeTickets`,
`readRuns`/`writeRuns`). It does **not** reconstruct live state by replaying
`events.jsonl`.

## 2. What survives a normal restart

All of the following are persisted in the authoritative JSON above and are preserved
across process restart and startup reconciliation:

- `executionPolicy` (initial value)
- `maxAttempts` edits (operator control)
- ticket-level triage and run-level triage
- triage resolution annotations (`required: false`, `resolvedAt`, `resolvedBy`,
  `resolution`) — never overwritten: `persistRunTriage` returns early when a triage
  already exists, and reconciliation only builds triage when none is present
- system logs (`logs.json`)
- replay snapshots (`replay-snapshots/*.json`)

Normal JSON persistence is sufficient for normal operation. Manual completion gates
(ticket triage, latest-run status, run triage, verification) are evaluated live from
`tickets.json`/`runs.json` at request time.

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
server never restores live state from it.

## 4. Warning

> Projection rebuild output is a reduced status/lifecycle view. It MUST NOT be used as
> a lossy restore of live state (it would drop `executionPolicy`/`maxAttempts`, triage,
> and triage resolution) unless a future tranche first teaches the rebuilder to
> **preserve** policy and triage annotations rather than reset them.

If such a restore path is ever introduced, it must fold these annotations from the
authoritative JSON (and from existing `ticket.blocked` / `run.triage_created` events),
never default them away. Note also that `scripts/projection-integrity-audit.js` proves
status/lifecycle from events only; it does not currently cover policy/triage fields.

## 5. Current decision

Do **not** event-source policy or triage annotations until projection rebuild becomes a
real restore path. There is no operational need today: the JSON files are authoritative,
restart-durable, and the worst case of a hypothetical lossy restore is fail-safe
(`maxAttempts` resets to unlimited *manual* reruns — no automation; lost triage is
advisory and the independent status/verification completion gates still block). This is
a documentation/architecture record only — no code, tests, or runtime behavior change.
