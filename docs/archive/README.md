# Archived Documentation

Closed investigations, superseded plans, generated validation reports, and early
exploratory documents. **Contents are unmodified** — these are historical records
moved here verbatim on 2026-06-11 to reduce clutter in `docs/`.

Provenance notes:

- File paths cited *inside* these documents refer to the pre-archive flat layout
  (`docs/X.md`, root-level filenames). They were intentionally left stale to keep
  the records byte-identical apart from the move.
- `OPERATIONAL_PRESSURE_VALIDATION.md` and `REAL_MODEL_ADVERSARIAL_VALIDATION.md`
  are frozen 2026-05-28 snapshots; rerunning their generator scripts
  (`scripts/operational-pressure-validation.js`, `scripts/real-model-adversarial-validation.js`)
  writes a fresh report to `docs/`, not here.

## Phase-authority investigation (Runs 77–82, Ticket #59 — closed; conclusions promoted into `docs/SUBSTRATE_DESIGN_PRINCIPLES.md` and `docs/ARCHITECTURE_INVARIANTS.md`)

- `RUN_77_POSTMORTEM.md`, `RUN_104_FAILURE_REVIEW.md`, `RUN_104_CONTRACT_QUESTION.md`, `RUN_104_CLOSURE_REVIEW.md`
- `PHASE_AUTHORITY_OPTIONS.md`, `PHASE_GATED_ENVELOPE_ANALYSIS.md`
- `PROMPT_AUTHORITY_ALIGNMENT.md`, `PROMPT_AUTHORITY_ALIGNMENT_RESULTS.md`, `OPTION_B_RESULTS.md`
- `INSPECTION_TO_MUTATION_ANALYSIS.md`, `INSPECTION_COMPLETION_SEMANTICS.md`
- `INVARIANT_ACCEPTANCE_DECISION.md`, `INVARIANT_PROMOTION_REVIEW.md`, `EVIDENCE_PRESERVATION_DECISION_MATRIX.md`
- `DOCUMENTATION_IMPLEMENTATION_DIVERGENCE.md`

## Business Work Primitive / product investigation (supporting material; the synthesized conclusions live in `docs/PRODUCT_SYNTHESIS.md`, which remains canonical)

- `BWD_CENTER_OF_GRAVITY.md`, `IMPLICIT_BWD_LAYER_ANALYSIS.md`, `IMPLICIT_BWD_LAYER_CHALLENGE.md`
- `METADATA_CATEGORY_CLASSIFICATION.md`, `METADATA_CATEGORY_CHALLENGED_CLASSIFICATION.md`
- `WORK_PRIMITIVE_RESEARCH_FINDINGS.md`, `WORK_PRIMITIVE_TICKET_GAP_ANALYSIS.md`
- `HIGHEST_LEVERAGE_UNVALIDATED_HYPOTHESES.md`, `HYPOTHESIS_IMPACT_RANKING.md`
- `ACTUAL_TICKET_USAGE_ANALYSIS.md`, `SCENARIO_PRODUCT_FIT_EVALUATION.md`, `SCENARIO_PRODUCT_FIT_REEVALUATION.md`

## Adaptive execution / workload profile analyses (implemented; current contract lives in `docs/WORKLOAD_PROFILES.md`)

- `ADAPTIVE_EXECUTION_TRANCHE_DESIGN.md`, `ADAPTIVE_EXECUTION_TRANCHE_PROFILE_PROCEDURES.md`
- `ADAPTIVE_PARAMETERS_VS_SAFETY_LIMITS.md`, `IMPLEMENTATION_PLAN_ADAPTIVE_EXECUTION_TRANCHE.md`
- `EVALUATION_PLAN_ADAPTIVE_EXECUTION.md`
- `WORKLOAD_PROFILE_BEHAVIORAL_TRACE.md`, `WORKLOAD_PROFILE_FIELD_REVIEW.md`, `WORKLOAD_PROFILE_IMPLEMENTATION_ANALYSIS.md`

## Event log reviews (closed; current contract lives in `docs/EVIDENCE_VS_TELEMETRY.md` and `docs/LIFECYCLE_EVENTS.md`; open items remain in `docs/UNRESOLVED_EVENT_LOG_QUESTIONS.md`)

- `EVENT_LOG_INTENT_REVIEW.md`, `SCHEDULER_TICK_REVIEW.md`

## Superseded fixture plans (authoritative spec: `docs/BUSINESS_FIXTURE_SPEC.md`)

- `BUSINESS_FIXTURE_PLAN.md` → superseded by `BUSINESS_FIXTURE_PLAN_V2.md` → superseded by the spec

## Generated validation reports (point-in-time snapshots, 2026-05-28)

- `BATCH_WORKLOAD_VALIDATION.md`, `OPERATIONAL_PRESSURE_VALIDATION.md`
- `REAL_MODEL_ADVERSARIAL_VALIDATION.md`, `CLEAN_VALIDATION_CORPUS_RESET.md`, `WORKLOAD_VALIDATION.md`

## Duplicate-authority consolidation (archived 2026-06-12; one authority per topic)

- `EXECUTION_MODEL_AUDIT.md`, `EXECUTION_MODEL_CONSOLIDATION_AUDIT.md` — point-in-time audits (2026-06-06/07) whose primitives and verdict are distilled in `docs/EXECUTION_MODEL.md` (the sole execution-model authority)
- `CHILD_TICKET_EXECUTION_MILESTONE.md`, `DYNAMIC_ACTION_PLAN_MILESTONE.md` — completed milestone records (WF-5, DX-2/DX-3) consolidated into `docs/EXECUTION_MODEL.md`
- `terminal-classification.md` — strict subset of the frozen point-in-time census at `ARCHIVE/evidence-corpus/anchored-summary.md`
- `SHARED_DRIVE_CLEANUP_DESIGN.md` — closed design review: its recommendation was implemented (small fixture + strict verifier; every gap in its "Implementation Gaps" section now exists in `scripts/fixture-verifier.js`) and validated in the evidence corpus (Shared Drive baseline + v2, 0% failure)
- `UNRESOLVED_EVENT_LOG_QUESTIONS.md` — merged verbatim into `docs/ARCHITECTURAL_DECISIONS_PENDING.md` ("Event Log Stream Semantics"); original preserved here

## Superseded strategy snapshot

- `STRATEGY.md` — transition-to-productization strategy preserved after its development phase ended

## Early exploratory documents (May 2026, pre-productization; operational canon now in `docs/OPERATIONS.md`)

- `ANALYSIS.md` — early experimental guidance synthesis
- `OPerational-Findings.md` — first-pass observation synthesis (filename casing preserved as-committed)
- `ARCHITECTURE_AUDIT.md` — May 24 substrate/runtime architecture audit
