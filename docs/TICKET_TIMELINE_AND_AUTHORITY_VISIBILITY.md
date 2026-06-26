# Ticket Timeline and Authority Visibility

## Purpose

r1.18 adds a read-only ticket timeline assembled from existing state and evidence at request time. It does not create a timeline ledger, rewrite source records, or change ticket execution.

The timeline is available through:

- `GET /api/tickets/:id/timeline`
- the **Timeline** section on `/tickets/:id`

Both surfaces require the existing `ticket:read` permission.

## Sources And Precedence

The projection follows the source-of-truth model in `RUN_EVIDENCE_AUTHORITY_SOURCE_OF_TRUTH_AUDIT.md`:

1. `tickets.json` and `runs.json` provide current live state.
2. `operation-history.json` provides committed mutation records and mutation receipts.
3. `events.jsonl` provides lifecycle chronology, authority decisions, workspace observations, verification, and reconciliation evidence.
4. Replay snapshots provide evidence details that are absent from stronger sources.
5. `logs.json` contributes only selected operator narrative and is labeled `diagnostic_log`.
6. Ticket source fields and the existing template-trigger ledger provide process-template and schedule provenance.

Committed mutations always use operation history when a history id exists. Event and replay copies are suppressed as separate entries and retained as supporting source references. A denied mutation without a history record is displayed as an attempted, uncommitted operation and may be folded into its `authority.denied` entry.

## Source Labels

Every entry includes a `sourceRole`:

- `live_state`
- `append_only_event`
- `operation_history`
- `replay_snapshot`
- `embedded_receipt`
- `diagnostic_log`
- `provenance`

The entry also includes `sourceType` and `sourceRef` so consumers can identify the exact backing surface. These labels describe evidence strength; they do not create new authority or lifecycle semantics.

## Visible Evidence

The timeline can show:

- ticket creation, assignment, and current status;
- process-template name/version, trigger kind/token, and scheduled time;
- legacy generated tickets whose source has no version;
- run attempts, lifecycle, current status/error, and replay snapshot path;
- verification-required or verification-not-required context;
- authority allowed/denied decisions, including protected and owned-path rules;
- permissioned cross-ticket delete audits and conflict references;
- target reads with target id/kind and receipt metadata/hash;
- committed target mutations with history id, target identity, before/after metadata, and receipt summary;
- failed or denied target mutation attempts explicitly marked uncommitted;
- postcondition, verification, violation, evaluation, and consequence summaries;
- unresolved and resolved ticket/run triage;
- selected triage-resolution logs labeled as diagnostic narrative.

## Deliberate Summarization

The projection does not include:

- full file contents from reads;
- mutation input content;
- full pre-mutation content;
- full provider request or response bodies;
- full replay snapshot payloads;
- general run-log noise.

Paths, operation names, hashes, counts, result status, authority rules, receipt ids, errors, and bounded metadata are retained. The existing detailed operation/replay views remain separate from the timeline.

## API Shape

The endpoint returns:

- `ticketId`
- `generatedAt`
- `sourceSummary`
- deterministically ordered `entries`

Entries contain stable ids, timestamps, type/title/summary, source labels, ticket/run ids, status/severity, deduplication key, and safe structured details. Ordering is chronological with stable source, run, and id tie-breakers.

The endpoint returns `404` for a missing ticket and does not mutate tickets, runs, events, logs, operation history, replay snapshots, or provenance ledgers.

## Replay And Logs

Replay snapshots remain evidence bundles, not executable replay plans. Their presence does not prove that a target is unchanged or that replaying a mutation is safe.

Logs remain human-readable diagnostics. Timeline log entries are explicitly labeled `diagnostic_log`; they do not override structured state, events, or receipts. Triage resolution is shown from authoritative ticket/run state, with its existing system log as supporting operator narrative.

## Non-Goals

r1.18 adds no runtime execution behavior, connector, Work Context, watcher, ambient behavior, model routing, workflow builder, scheduler change, scheduled-token change, target-provider change, process-template/version change, verification change, triage change, or auto-retry change.
