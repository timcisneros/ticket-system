# Decision Log

## Objective Interpretation Direction (2026-07-17)

The deterministic objective grammar is frozen at its current scope (existing recognizers to be
audited, not grandfathered); the model contract compiler continues under the rule **inference
may self-bind and escalate; only explicit claims, observed facts, and deterministic guards may
produce hard outcomes**. Model-sourced contracts are permanently advisory — corroboration or
human confirmation produces a new separately sourced record (`deterministic_corroboration` /
`human_confirmed`) rather than upgrading provenance in place. Completion always requires
verifier-evaluated postcondition evidence. Full rationale, source-authority table, and
benchmark gating: `decision-memo-objective-interpretation-direction.md`.

## Branching Workflow Generation

Branching and conditional workflow generation is a separate capability from flat workflow draft intent. Do not treat branching objectives as `createWorkflowDraftIntent` failures unless that capability envelope changes.
