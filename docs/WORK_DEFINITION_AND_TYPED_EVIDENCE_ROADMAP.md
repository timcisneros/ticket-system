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

### Capability claim

An explicitly admitted closed typed criterion may participate in the existing
deterministic completion decision only when its exact authority was frozen at
admission and it can be evaluated solely from durable, bounded,
integrity-checked evidence.

### Existing criterion inventory

Tranche 3 introduces no new criterion family. The complete supported
vocabulary and its authority are:

| Criterion | Admission source | Immutable authority | Durable evaluation evidence |
| --- | --- | --- | --- |
| `folder_exists` | deterministic objective contract | `completionAuthoritySnapshot.objectiveContract.directPostconditions` | finalized replay `run:postcondition_completed` checked-path evidence |
| `path_absent` | deterministic objective contract | `completionAuthoritySnapshot.objectiveContract.directPostconditions` | finalized replay checked-path evidence |
| `file_content_equals` | deterministic direct objective check | `completionAuthoritySnapshot.objectiveContract.directPostconditions` | finalized replay checked-path evidence, content bound by SHA-256 |
| `fileExists` | workflow definition | `verificationContractSnapshot.postconditions` | one durable `run.postconditions_checked` result |
| `fileContains` | workflow definition | `verificationContractSnapshot.postconditions` | one durable `run.postconditions_checked` result |
| `jsonPathEquals` | workflow definition | `verificationContractSnapshot.postconditions` | one durable `run.postconditions_checked` result |
| `outputFieldEquals` | workflow definition | `verificationContractSnapshot.postconditions` | frozen workflow output followed by one durable postcondition result |
| `processOperationExists` | workflow definition | `verificationContractSnapshot.postconditions` | canonical `runProcess` receipt through `processOperations` plus process evidence integrity |
| `processTerminalOutcomeEquals` | workflow definition | `verificationContractSnapshot.postconditions` | receipt terminal outcome plus matching process-terminal evidence |
| `processArtifactEquals` | workflow definition | `verificationContractSnapshot.postconditions` | immutable artifact metadata plus matching process-artifact evidence |

Direct postconditions and workflow postconditions remain separate established
authorities. The completion decision already binds the direct objective
contract hash and the frozen workflow declaration hash. Existing evaluators and
completion-decision hashes are unchanged.

### Declared/completion authority binding

Every `typed-postcondition` in an available `declaredWorkSnapshot` must match
exactly one criterion in the run's immutable completion authority before the run
can be admitted:

```text
stable criterion identity
+ criterion type
+ canonical normalized declaration
+ criterion SHA-256
+ source-compatible provenance
+ exact deterministic evidence requirement
```

The supported provenance binding is closed:

```text
deterministic-objective-contract → completionAuthoritySnapshot
workflow-defined                → verificationContractSnapshot
```

Missing, extra, contradictory, differently typed, differently normalized, or
differently hashed authority fails with
`DECLARED_COMPLETION_AUTHORITY_MISMATCH`. Textual criteria are excluded from
this binding and remain explicitly unevaluated. Produced operations, receipts,
artifacts, browser observations, model claims, and final consequences cannot
create criteria retroactively.

Historical runs without declared work retain
`declaredWorkAvailability: historical-unavailable` and continue under their
existing completion authority and decision. Current ticket or workflow state is
never used to reconstruct missing declarations.

### Rejected additions

Browser receipts and bounded browser evidence are durable integrity inputs, but
the repository has no explicit immutable browser-criterion admission source.
Consequently no browser predicate is added. Evidence presence alone remains
insufficient for semantic completion. Arbitrary page-text matching, selector
evaluation, live page checks, screenshot interpretation, generic operation
success, and universal evidence predicates remain prohibited.

Process criteria require no addition: the existing workflow postconditions,
generic process receipt, process consequence, immutable artifact metadata, and
terminal/artifact evidence already form a closed deterministic path. Process
exit zero by itself remains insufficient.

### Scope boundary

Do not broaden the frozen natural-language grammar or make model interpretation
hard completion authority. This tranche adds an admission and reconstruction
integrity invariant plus read-only presentation. It does not add an evaluator,
completion engine, persistence object, migration, predicate language, browser
criterion, Work Primitive, playbook, Target, or registry.

## Tranche 4 — Mixed-family validation and product decision

### Capability claim

The repository demonstrates, through representative product scenarios, that
workspace, browser, and process work can contribute truthful typed
declarations, operations, evidence, consequences, and completion decisions
without flattening their semantics. The resulting evidence is sufficient to
decide whether a reusable Work Primitive/playbook should become a distinct
product and persistence contract.

### Mixed-family definitions

The tranche distinguishes single-family runs, multi-family runs, multi-run
tickets, workflow composition, and evidence aggregation. Projection of several
typed families is not evidence that one generic executor can lawfully dispatch
them together.

Current composition is deliberately asymmetric:

- browser runs are exclusive and use only bounded browser operations;
- non-browser direct runs may use workspace operations and, when separately
  admitted, `runProcess`;
- workflows execute their existing bounded workspace/model-control action
  graph and do not receive process grants;
- tickets aggregate typed run facts while preserving each run's authority,
  status, receipt type, evidence type, and artifact origin.

### Scenario result

Workspace direct work, workflow workspace work, process-authorized direct work,
browser work, historical compatibility, reruns, restart reconstruction, and
multi-run ticket aggregation remain truthful under the Tranches 1–3 contracts.
Process exit zero and browser evidence alone remain insufficient for semantic
completion. Process artifacts remain process artifacts unless a separate
workspace mutation proves publication.

The existing closed process postconditions are immutable and deterministically
evaluable, but an ordinary Workflow cannot dispatch `runProcess` and receives no
process grants. Enabling that composition would require a new authority,
budgeting, recovery, and product-ordering contract. It is documented as
unsupported composition rather than being silently generalized in this
tranche.

No qualifying production defect was found. Tranche 4 adds scenario evidence and
the product decision only; it changes no runtime or persistence authority.

### Product decision

The accepted decision is Option A: retain Ticket and Workflow as the product
primitives. Workflow remains the reusable, versioned work definition and each
Run binds immutable declared-work and completion authority.

Option B—improving Workflow's presentation as a reusable playbook—is the first
future direction to evaluate if user evidence demonstrates reuse pressure.
Option C—a distinct reusable Work Primitive/playbook entity—is not validated.
It would duplicate authority and add lifecycle, migration, API/UI,
authorization, and compatibility cost without a demonstrated product need.

The complete scenario matrix, candidate composition analysis, A/B/C comparison,
recommendation, and explicit future decision triggers are recorded in
[`decision-memo-mixed-family-work-model.md`](decision-memo-mixed-family-work-model.md).

### Scope boundary

No generic operation router, universal operation language, browser predicate,
new process/workflow composition, reusable Work Primitive entity, playbook
registry, table, migration, or UI is authorized.

## Roadmap status

```text
Tranche 1: COMPLETE
Tranche 2: COMPLETE
Tranche 3: COMPLETE
Tranche 4: COMPLETE
```
