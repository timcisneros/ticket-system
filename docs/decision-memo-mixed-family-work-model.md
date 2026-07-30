# Decision Memo: Mixed-Family Work Model

## Decision

Keep Ticket and Workflow as the product primitives. Do not introduce a distinct
reusable Work Primitive or playbook entity.

The validated product model remains:

```text
Ticket
→ Run
→ Workflow or direct execution
→ workspace / browser / process operations
→ typed receipts and evidence
→ run consequence
→ deterministic completion decision
```

Workflow is the existing reusable, versioned work definition. A
`declaredWorkSnapshot` is immutable admitted-run authority, not a reusable
product object. If later product evidence demonstrates that Workflow cannot
represent a stable reusable definition without distortion, that decision
requires a separately authorized roadmap.

## Meaning of mixed-family

This decision uses five distinct terms:

- **Single-operation-family run:** one run executes workspace, browser, or
  process operations, but not more than one family.
- **Multi-family run:** one run executes operations from more than one family.
- **Multi-run ticket:** separate runs under one ticket retain separate authority
  and may contribute different operation families.
- **Workflow composition:** one frozen workflow lawfully dispatches more than one
  operation family.
- **Evidence aggregation:** a run or ticket projects facts from more than one
  family without flattening them or routing execution through a generic switch.

Evidence aggregation does not prove that the corresponding operations could
lawfully execute together in one run.

## Validated scenario matrix

| Scenario | Supported behavior | Authority and evidence | Completion behavior | Limitation |
| --- | --- | --- | --- | --- |
| Workspace direct work | Supported | Ticket objective, direct completion authority, declared-work snapshot, workspace receipts, checked-path evidence, workspace consequence | Existing deterministic direct postconditions may complete the objective | Frozen objective grammar remains intentionally narrow |
| Workflow workspace work | Supported | Frozen Workflow version, verifier declarations, workflow postconditions, workspace receipts, `run.postconditions_checked` | All required workflow postconditions must pass | Workflow remains a bounded action graph |
| Process-authorized direct work | Supported | Frozen process policy/profile grants, runtime capability, generic `runProcess` receipt, process terminal/artifact evidence | Process exit zero alone is incomplete | Direct tickets do not admit process predicates |
| Workflow process postcondition | Contract and evaluator supported; ordinary execution composition unsupported | Workflow can freeze the three closed process predicates and the evaluator can consume matching durable process authority | Exact evidence can be evaluated; missing same-run evidence fails closed | Ordinary workflows cannot invoke `runProcess` and receive no process grants |
| Browser work | Supported as an intentionally exclusive run kind | Frozen browser target/origin/action limits, browser receipts, bounded browser evidence | Evidence is projected but does not establish semantic completion | No browser criterion admission source exists |
| Historical run | Read compatible | Its own persisted authority and existing decision | No current ticket or workflow state is synthesized | Declared work remains explicitly historical-unavailable |
| Rerun/restart | Supported | Each attempt freezes its own declared work and completion authority | Reconstruction preserves each attempt and hash | Later authority does not rewrite predecessors |
| Multi-run ticket | Supported | Receipts, evidence, declarations, and decisions remain run-scoped; ticket artifacts retain family and originating run | Existing ticket projection rules remain unchanged | A later successful run changes current ticket status but does not erase earlier runs |

The process-postcondition row is an explicit unsupported-composition finding.
Making it executable would require workflow process grants, phase and profile
selection, budget and recovery integration, and a product rule for operation
ordering. No current product requirement justifies that extension. Accepting an
immutable criterion into the evaluator is not a generic execution promise.

## Candidate composition decisions

| Candidate | One run today | Other supported route | New authority/complexity required | Decision |
| --- | --- | --- | --- | --- |
| Workspace edit followed by local validation process | A direct non-browser run may select both families when process authority is admitted | Separate attempts also retain their own facts | A hard process success criterion for direct tickets would need a new admitted input surface | Do not add one |
| Browser observation followed by workspace report creation | No; browser execution is exclusive | Separate specialized work may be requested explicitly | Cross-run evidence transfer, browser-to-workspace authority, recovery and completion rules | No demonstrated need |
| Process artifact followed by workspace publication | No automatic import; a direct run may separately perform workspace work but cannot treat process output as a workspace mutation | An explicit authorized workspace operation may publish known content | A safe artifact-import operation and ownership policy | Preserve the boundary |
| Browser action followed by process execution | No | Separate specialized work | Browser/process authority composition, budgeting, recovery, privacy and completion | No demonstrated need |
| Separate specialized runs under one ticket | Supported where the ticket's existing execution shape admits those runs | Existing rerun/attempt and ticket projections | No generic router | Retain |

Process input remains:

```text
workspace snapshot
→ trusted materialization
→ process execution
```

Process output remains immutable process artifacts until a separately authorized
workspace mutation occurs.

## Product options

### Option A — Keep Ticket and Workflow as the product primitives

- **Demonstrated need:** fully covers the current scenarios.
- **User model:** Ticket requests work; Workflow provides reusable bounded
  structure; Run is one attempt.
- **Authority owner:** Ticket author and versioned Workflow authority.
- **Versioning:** Workflow versions plus immutable admitted run snapshots.
- **Relationship:** no additional entity or lifecycle.
- **Benefits:** lowest mental and operational overhead; preserves proven
  authority boundaries.
- **Costs/failure modes:** direct tickets can repeat prose and cannot reuse
  structure outside Workflow; pressure must be measured rather than assumed.
- **Evidence strength:** strong repository implementation and test evidence.

### Option B — Promote Workflow as the reusable playbook surface

- **Demonstrated need:** not yet shown, but Workflow already supplies the closest
  valid contract.
- **User model:** present approved Workflow versions as reusable playbooks without
  changing their authority.
- **Authority owner:** existing Workflow author/administrator.
- **Versioning:** existing Workflow revision/version rules.
- **Relationship:** Ticket selects a Workflow; Run freezes the selected authority.
- **Benefits:** avoids a parallel registry and can improve discoverability.
- **Costs/failure modes:** product presentation and governance work; risk of
  implying composition that the Workflow executor does not support.
- **Evidence strength:** moderate architectural fit, insufficient user-demand
  evidence.

### Option C — Add a distinct reusable Work Primitive/playbook entity

- **Demonstrated need:** none.
- **User model:** another definition selected before Ticket or Run admission.
- **Authority owner/versioning:** would require new authoring, approval,
  immutable-version, authorization, and historical contracts.
- **Relationship:** risks overlapping both Workflow and Ticket.
- **Benefits:** possible separation of reusable semantic requirements from
  execution structure.
- **Costs/failure modes:** new persistence, migrations, API/UI, lifecycle,
  compatibility, ambiguity, and framework gravity.
- **Evidence strength:** speculative.

## Recommendation

Choose Option A. Keep Option B as the first direction to evaluate if reusable
presentation becomes necessary because it extends an already validated
authority. Reject Option C unless repository-backed product evidence proves
that Ticket and Workflow distort a stable reusable semantic definition.

No production runtime defect was found in the supported scenario matrix, so
Tranche 4 changes no execution, authority, evidence, consequence, completion,
terminalization, persistence, API, or UI behavior.

## Future decision triggers

Revisit the decision only when measured product evidence shows one or more of:

- users repeatedly author materially identical declared outputs and criteria;
- reuse errors remain after using existing Workflow definitions;
- stable semantic requirements must be shared across multiple execution
  structures and Workflow cannot express them without distortion;
- users deliberately need to select, inspect, approve, and version such a
  definition;
- a supported scenario requires a specific cross-family sequence and separate
  runs materially reduce reliability or usability;
- a closed authority, budget, recovery, evidence, and completion contract for
  that sequence can be stated without a universal operation language.

Conceivable integrations, architectural symmetry, and the existence of several
operation families are not sufficient triggers.
