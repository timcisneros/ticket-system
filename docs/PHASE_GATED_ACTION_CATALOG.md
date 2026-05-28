# Phase-Gated Action Catalog

## Overview

The runtime exposes a phase-gated action catalog to the model. The catalog restricts which operations are available based on the current execution phase, reducing invalid next-action choices after inspection.

## Phase Catalog

| Phase | Exposed Operations | Purpose |
|-------|-------------------|---------|
| planning | listDirectory, readFile, createFolder, writeFile, renamePath, deletePath | All ops available (no prior context) |
| inspection | listDirectory, readFile | Bounded workspace discovery |
| mutation | createFolder, writeFile, renamePath, deletePath | Bounded operation batches |
| verification | listDirectory, readFile | Post-mutation confirmation |
| terminalization | (none) | Run complete/failed |

## Catalog Behavior

- **Default:** The model receives only the operations appropriate to the current phase.
- **Intersection:** The phase catalog is intersected with the agent's base allowed operations. If a workflow draft operation is disabled for an agent, it is excluded even in the mutation phase.
- **Forward only:** Phases advance forward (planning → inspection → mutation → verification → terminalization). The runtime only records forward phase transitions.

## Model Guidance in Prompt

The prompt includes:

- `runtimeEnvelope.currentPhase` — the current phase name
- The explicit list of phase-allowed operations
- A reminder not to repeat inspection in mutation phase

Example prompt excerpt:

> Your current execution phase is mutation. In this phase, the allowed operations are: createFolder, writeFile, renamePath, deletePath.
> If you already performed inspection (listDirectory or readFile) and are now in the mutation phase, do not emit listDirectory or readFile again unless you are explicitly verifying results.

## Transition Guidance

After a successful inspection-only response, the prompt also injects:

> Previous inspection is complete. You already have the directory entries in previousActionResults.
> Do not call listDirectory or readFile again for discovery.
> Use those entries now to emit up to runtimeEnvelope.maxMutatingActionsPerResponse exact mutation operations, or fail explicitly if no valid mutation can be determined.

## What Changed in Runtime Semantics

- `buildPhaseGatedCatalog(currentPhase, baseAllowedOps)` filters operations by phase
- `runtimeEnvelope.currentPhase` is exposed to the model
- Prompt uses phase-gated operation list instead of full `AGENT_DIRECT_OPERATIONS`

## What Changed Only in Prompt Semantics

- Explicit phase name included in prompt
- Phase-allowed operation list included in prompt
- Transition guidance (already existed) remains active

## Invariants

- The catalog does not add new runtime operations. It only filters the existing `AGENT_DIRECT_OPERATIONS` set.
- No limits were raised.
- No-progress detection remains unchanged.
- Phase transitions remain forward-only.
