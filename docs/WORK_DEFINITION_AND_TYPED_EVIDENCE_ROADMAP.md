# Work Definition and Typed Evidence Roadmap

## Source of truth

This document is the authoritative roadmap for correcting filesystem-centric
generic work projections and, in later tranches, adding justified structured
work-definition authority. It builds above the completed Process Execution
Roadmap and does not reopen that roadmap.

The universal Target framework is rejected. Workflow is the currently validated
work primitive in this repository. A broader reusable Business Work Primitive
or playbook remains an unvalidated future product decision and is not a
persistent entity in this roadmap.

The current validated execution hierarchy is:

```text
Ticket
→ Run
→ Workflow or direct execution
→ workspace / browser / process operations
→ typed receipts and evidence
→ run consequence
→ deterministic completion decision
```

Workspace, browser, and process remain distinct operation families. Filesystem
mutation is one typed consequence family, not the definition of all work.

## Tranche 1 — Typed projection parity

### Capability claim

Existing durable workspace, browser, and process execution facts are represented
truthfully in generic run and ticket projections without flattening their
semantics or changing execution, authority, verification, completion, or
terminalization behavior.

### Required work

- Preserve the existing workspace mutation consequence categories.
- Preserve the existing closed process-operation consequence.
- Add a bounded browser-operation consequence from durable receipts and evidence.
- Add typed workspace, browser, and process projections to the generic Work Receipt.
- Include immutable process artifacts, and only contract-defined browser artifacts,
  in ticket artifact views without representing either as workspace paths.
- Make fallback summaries distinguish no workspace mutation from no work consequence.
- Report workspace operations, workspace mutations, browser operations, and process
  operations separately.
- Scope path coverage and filesystem artifact accuracy explicitly to workspace work.
- Show typed consequence sections in existing run and ticket surfaces.
- Preserve all execution, authority, verification, completion, terminalization,
  schema, and historical-compatibility contracts.

### Scope boundary

This tranche changes derived projections only. It adds no database migration,
operation language, execution router, completion predicate, Target framework, or
Work Primitive/playbook entity.

## Tranche 2 — Declared work snapshot

### Outcome

Add the smallest immutable admitted-run representation of explicitly declared
expected outputs, success criteria, and evidence requirements through existing
Ticket, Workflow, and Run authority.

### Scope boundary

Do not add a new Work Primitive entity.

## Tranche 3 — Typed criteria and completion

### Outcome

Bind only justified closed typed criteria to the existing completion authority
and completion-decision system.

### Scope boundary

Do not broaden the frozen natural-language grammar or make model interpretation
hard completion authority.

## Tranche 4 — Mixed-family validation and product decision

### Outcome

Validate browser, process, workspace, and justified mixed-operation work against
the completed projection and completion model.

Only after that evidence exists, decide whether reusable Work Primitives or
playbooks merit a separate product and persistence contract.

## Roadmap status

```text
Tranche 1: COMPLETE
Tranche 2: NOT STARTED — NEXT
Tranche 3: NOT STARTED
Tranche 4: NOT STARTED
```
