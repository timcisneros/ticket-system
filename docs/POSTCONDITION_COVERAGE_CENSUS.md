# Workflow Postcondition Coverage Census

Date: 2026-06-12. Measurement only; sources: `data/workflows.json` (14 definitions),
`data/events.jsonl` (33 postcondition-check events, 1 failure ever recorded),
closed failure record (`docs/FAILURE_TAXONOMY.md`).

Content-aware = `fileContains`, `jsonPathEquals`, or `outputFieldEquals`.
"Can emit on completed run": a `fileExists` check is effectively unfailable on a
completed run (if the write failed, the run is already `failed`; observed: 0
fileExists failures in all recorded checks). Only content-aware checks produce
the completed-run disagreement signal that feeds NEEDS_ARMS.

## Coverage table

| Workflow | Postconds | Types | Content-aware | Can emit pc_failed (completed run) | Feeds NEEDS_ARMS | Gap: disagreement that currently disappears |
|---|---|---|---|---|---|---|
| demo-agent-write-if-approved | 0 | — | no | no | no | wrong gate decision or wrong note content — no check of any kind |
| **legal-intake** | 3 | fileExists ×2, **fileContains** | **YES** | **yes** | **yes** | partially covered: the one invariant only checks that *some* "Request Information" row exists; a misdisposition in a register that contains an RI row elsewhere still disappears |
| customer-support-triage | 2 | fileExists | no | no | no | the entire observed CS failure cluster (SUP-2026-001/003/005 incl. the 6/6 deterministic miss) — all such runs completed silently |
| customer-support-triage-ticket-plan | 0 | — | no | no | no | wrong child-ticket plans — nothing checked at all |
| customer-support-triage-chunk | 1 | fileExists | no | no | no | per-chunk misclassifications |
| customer-support-triage-aggregate | 2 | fileExists | no | no | no | wrong aggregation of chunk results |
| vendor-compliance | 2 | fileExists | no | no | no | the original 8 S1 failures and data_localization — all completed |
| vendor-remediation-plan | 2 | fileExists | no | no | no | remediation built on wrong upstream dispositions (propagation errors) |
| vendor-remediation-failure-handoff | 2 | fileExists | no | no | no | same propagation class |
| vendor-compliance-ticket-plan | 0 | — | no | no | no | wrong plan decomposition — nothing checked |
| vendor-compliance-medium-chunk | 1 | fileExists | no | no | no | vendor-041/049's S2 flapping happened here: 10 of 12 runs completed carrying it |
| vendor-compliance-medium-aggregate | 2 | fileExists | no | no | no | wrong final register/summary |
| shared-drive-cleanup | 2 | fileExists | no | no | no | wrong archive/preserve decisions — the highest-blast-radius silent class (deletion intent) |
| failure-classification | 1 | fileExists | no | no | no | a wrong classification passes its own check — observed: run-47's cheap-tier S1-for-S3 verdict completed cleanly (meta-gap) |

## Aggregates

- Workflows with any postconditions: **11/14 (79%)**
- Workflows with content-aware postconditions: **1/14 (7%)** — legal-intake, and that one carries a single narrow demo invariant, not a general disposition check
- Workflows invisible to S1–S4 detection: **13/14 (93%)** fully invisible; the 14th (legal-intake) is partially visible
- Empirical confirmation of the fileExists ceiling: 33 check events, 0 fileExists failures ever; the sole `run.postcondition_failed` in system history is run-47's `fileContains`

## Conclusion

The current NEEDS_ARMS rate (1 case, 7.1% of classifications) is a **coverage
artifact, not a failure rate**: it measures one narrow invariant on one workflow
— while the closed record shows S1–S4 failures occurred in at least four of the
thirteen workflows that are currently incapable of reporting them.
