# Evidence Memo: Evidence Reconciliation Mechanism

## Status: UNRESOLVED

Mechanism has not been isolated. Evidence points in conflicting directions.

---

## Evidence Supporting Presentation Sensitivity

### CS-ER-001 (position change)
- Baseline SUP-2026-005: 0/3 PASS
- Change ticket moved from bottom to top of Description (same content, different position)
- Result: 2/3 PASS
- No confound — only position changed.

### CS-ER-002 (structured block)
- Baseline SUP-2026-005: 0/3 PASS
- Change ticket formatted as structured block (same facts, different format)
- Result: 3/3 PASS
- No confound — content preserved, format changed.

These two results, from the same fixture, same workflow, same verifier, same model, varying only presentation, suggest:

- The model CAN produce the correct classification under some presentation variants.
- Presentation appears to influence outcomes.

## Evidence Complicating the Picture

Later replication attempts modified ticket content (single-line Description flattening, structural changes) in addition to presentation. These produced:

- CS-ER-001 re-run (altered content + position): 0/3
- CS-ER-002 re-run (altered content + structured block): 0/3

These are NOT directly comparable to the original because the content was altered — a confound. They neither confirm nor refute the original findings.

## What Is Supported

| Claim | Support |
|---|---|
| Presentation appears to influence outcomes | Yes — original CS-ER-001 (2/3) and CS-ER-002 (3/3) |
| Model CAN produce correct classification under some presentations | Yes — CS-ER-002 3/3 shows it is possible |
| Evidence reconciliation is the dominant observed failure cluster | Yes — 53.8% of all failures |
| The original CS-ER-002 result might be non-deterministic | Unclear — replications changed content, not directly comparable |

## What Is Not Supported

| Claim | Support |
|---|---|
| Primacy (read-order) is the mechanism | Not proven. Position helped but non-deterministically. |
| Formatting alone is the mechanism | Not proven. Block format helped but replications were confounded. |
| Reasoning inability is the mechanism | Not proven. Model CAN pass under some conditions. |
| Attention failure is the mechanism | Not proven. Mechanism unresolved. |

## Next Step (if investigation continues)

A clean replication of CS-ER-002 with ONLY the structured block changed and all other content verbatim — using the exact same expander output as baseline, modifying only the Description field of ticket-005, preserving all other ticket content unchanged.

## Current Priority

Business realism accumulation across all four domains remains the primary tranche. Evidence-reconciliation mechanism investigation is secondary until a clean replicated result exists.

---

Date: June 8, 2026
Model: gpt-4.1-mini (OpenAI API)
Workflow: customer-support-triage (unchanged across all runs)
