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

### Capability claim

Every admitted run carries the smallest immutable, reconstructable declaration
of the work it was authorized to attempt: its objective, explicitly declared
expected outputs, success criteria, and evidence requirements.

### Contract

The version-1 `declaredWorkSnapshot` is immutable run authority:

```text
version
objective
expectedOutputs
successCriteria
evidenceRequirements
contractHash
```

It is stored in the existing PostgreSQL run body and in run-created and replay
authority. No new table, registry, product entity, or migration is involved.
The hash covers canonical, locale-independent serialization of the declaration
and every field's provenance. Unknown fields, unknown versions, invalid
provenance, malformed declarations, contradictory equal-authority criteria,
and hash mismatches fail closed.

The closed provenance vocabulary, in descending authority order, is:

```text
ticket-authored
workflow-defined
deterministic-objective-contract
validated-model-contract
legacy-compatibility
absent
```

Precedence is field-specific rather than a merge of unlike facts:

- the ticket-authored objective is the admitted objective;
- ticket-authored acceptance criteria remain textual declarations;
- a workflow run takes expected-output declarations from its frozen verifier
  contract and typed criteria from its frozen workflow postconditions;
- a direct run takes only the existing deterministic objective postconditions;
- workflow postconditions and direct objective postconditions are never merged;
- model output is not an admission source today and cannot override ticket,
  workflow, or deterministic authority.

Equal-authority declarations with the same established identity must agree.
They otherwise fail admission with `DECLARED_WORK_AUTHORITY_CONFLICT`.
Empty arrays mean the corresponding declaration was absent; actions, process
profiles, browser targets, produced artifacts, and observed evidence never
become declarations by inference.

### Declaration versus results

The snapshot records admitted declarations. It does not say that an output was
produced, evidence exists, a textual criterion was evaluated, or an objective
completed. Existing deterministic postconditions remain the only hard typed
success predicates, and the Tranche 6 completion-decision authority from the
Process Execution Roadmap remains unchanged. Typed interpretation of additional
declared criteria belongs to Tranche 3.

Planning and model context receive one bounded projection of the admitted
snapshot. Compatibility objective and acceptance-criteria prompt fields are
derived from that projection for current runs. They do not read later mutable
ticket or workflow values. The projection adds no actions and changes no
workspace, browser, or process dispatch.

### Historical compatibility

Runs admitted before this contract remain readable as
`historical-unavailable` with a null snapshot. Current ticket or workflow state
is never synthesized as historical declared-work authority. Existing
historical completion decisions and execution compatibility are not
reinterpreted.

Workflow remains the currently validated work primitive. The declared-work
snapshot extends Ticket, Workflow, and Run authority; it is not a reusable Work
Primitive or playbook entity. Whether such an entity has product value remains
an evidence-dependent future decision.

### Scope boundary

This tranche admits and projects declarations only. It does not evaluate new
criteria, change completion or terminalization, generalize the workspace,
browser, or process operation families, or add a Work Primitive, playbook,
Target, capability, or execution ontology.

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
Tranche 2: COMPLETE
Tranche 3: NOT STARTED — NEXT
Tranche 4: NOT STARTED
```
