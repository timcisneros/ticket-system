# Decision Log

## Mixed-Family Work Model (2026-07-29)

Keep Ticket and Workflow as the product primitives. Workspace, browser, and process remain
separate operation families; evidence aggregation does not authorize a generic cross-family
router. The current scenario evidence does not justify a distinct reusable Work Primitive or
playbook entity. Reuse pressure should first be evaluated through the existing versioned Workflow
authority. Full scenario matrix, unsupported-composition findings, option comparison, and future
decision triggers: `decision-memo-mixed-family-work-model.md`.

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
