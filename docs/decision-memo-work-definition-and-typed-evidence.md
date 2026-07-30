# Decision Memo: Work Definition and Typed Evidence

## Decision

Do not introduce a universal Target framework.

The repository validates Workflow as its current reusable work structure and
validates workspace, browser, and process as separate typed operation families.
They share bounded runtime infrastructure—operation identity, authority,
budgets, receipts, evidence, consequence participation, and completion
participation—but not a universal operation language or identity registry.

The demonstrated defect is projection asymmetry: generic receipt, consequence,
artifact, summary, metric, review, and UI surfaces have retained filesystem/path
assumptions even though durable browser and process facts already exist.

## Rationale

A Target registry or universal read/write/execute language would duplicate
existing domain identities, add migration and authority risk, and solve no
demonstrated execution defect. The smallest operationally useful correction is
to preserve each operation family's semantics while admitting its existing
durable facts into generic derived projections.

Filesystem workspace remains legitimate mutable work state. Path validation,
workspace snapshots, mutation boundaries, and file receipts remain
workspace-specific. Process input remains:

```text
workspace snapshot
→ trusted materialization
→ process execution
```

Process output remains an immutable process artifact until a separately
authorized filesystem operation imports or publishes it into a workspace.
Browser evidence is not automatically an artifact, and neither process success
nor browser evidence establishes semantic objective completion.

## Deferred decisions

Structured expected outputs, success criteria, and evidence requirements are
deferred to the declared-work snapshot tranche. A broader reusable Business Work
Primitive or playbook is an unvalidated future product decision; no user-facing
or persistent entity is authorized now.
