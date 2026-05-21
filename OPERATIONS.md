# Operations Guide

This document captures operational findings from repeated experimentation with
the ticket-system harness. It is not architecture documentation. It is not a
specification. It is a set of learned practices for operating a bounded,
runtime-enforced execution system.

---

## Ground Truth: What the Substrate Guarantees

Before operational discipline matters, understand what is already enforced by
the runtime:

| Guarantee | How | What it means |
|---|---|---|
| Bounded execution | Step limit, operation limit, request limit, timeout | No runaway agents |
| No-progress detection | Repeated list-only triggers stalled warning then step limit | Model cannot stall indefinitely |
| Action limit enforcement | >8 actions in one response → retry with warning | Model cannot exceed per-step capacity |
| Ownership enforcement | Writes outside owned path → blocked with error | Allocated agents stay in their lane |
| Mutation accounting | Every create/write/rename/delete is recorded | Full audit trail |
| Protected path blocking | Application files (config, data, etc.) are read-only | System files cannot be overwritten |
| Replay/history | Every run has a replay snapshot + operation history | Recovery is possible |
| Interruption/recovery | Run can be stopped and retried | Operator can intervene |
| Truthful step-limit failure | Model exhausts budget → "did not signal completion" | Not harness instability |

These are **infrastructure guarantees**. They are not negotiable through
prompt changes and they do not need workarounds.

**Important: All guarantees above describe recorded operations, not
workspace materialization.** Replay, history, and mutation accounting
tell you what the model *requested* and what the substrate *recorded*.
They do not guarantee the file currently exists on disk. A writeFile
recorded in run R7 means "the substrate accepted a writeFile request
for path X in run R7." It does not mean "path X is on disk right now."
The two layers can drift — across server instances, after workspace
resets, or due to external filesystem changes. The substrate surfaces
this drift honestly (ENOENT, stat mismatch). It does not silently
reconcile.

Everything below the line in this document is **operational authoring
discipline** — practices that make tickets perform well within the bounded
runtime. They are not infrastructure. They are operator skill.

---

## 1. Ticket Sizing Heuristics

The default budget is 4 execution steps, 32 workspace operations, 4 model
requests. Within this budget, real throughput follows a consistent pattern:

### Per-step throughput

- **Folder creates**: ~8 per step (action limit is the bottleneck)
- **File writes**: ~8 per step
- **Mixed work**: ~6-8 ops per step (model needs some reasoning overhead)
- **Inspection steps**: 0 mutations (pure list operations)

### Reliable ticket sizes

| Size | Ops | Steps needed | Default budget works? |
|---|---|---|---|
| Small | ≤ 8 | 1-2 | **Yes** — clean converge |
| Medium | 9-16 | 2-3 | **Yes** — reliable |
| Large | 17-28 | 3-4 | **No** — progress tracking fails at step 3 |
| X-Large | > 28 | 5+ | **No** — must split |

### The 2-step progress tracking limit

The model can reliably track progress across **at most 2 productive**
**mutation steps**. After step 2, the model loses track of which items
it has already created and either re-attempts already-existent items
(no-op waste) or lists to re-discover state. This is a model-level
limitation, not a budget constraint. It applies regardless of enumeration
precision, completion criteria, or "do not recreate" instructions.

**Empirical finding**: 16 successful mutations is the reliable ceiling
per ticket (2 steps × 8 ops). Any ticket requiring more than ~16 mutations
will truthfully exhaust the budget without completing the remaining items.

### Transactional rule of thumb

> One step can create ~8 folders or write ~8 files.
> The model can sustain at most 2 productive mutation steps before
> progress tracking degrades (~16 mutations per ticket).
> Continuation tickets handle the rest.

**If a ticket requires more than 16 mutations, split it into multiple
tickets.** Do not raise the budget. The budget limit is a feature — it
forces tractable ticket boundaries.

---

## 2. Good vs Bad Ticket Examples

### Good fresh ticket

```
Inside project-alpha, create folders named ModuleA, ModuleB, and ModuleC.
```

- 4 ops. Completed in 2 steps (1 list + 3 creates). No ambiguity.
- The model knows exactly what to create and where.

### Bad fresh ticket (too large)

```
Create a full documentation site with folders for each of 12 months.
Inside each month, create subfolders named Reports, Analysis, and Notes.
In each Notes folder, add notes.md with 3 bullet points.
```

- 73 ops. Needs 9+ steps. Will hit the 4-step limit at ~18% completion.
- **Fix**: Split into multiple tickets. First: month folders. Second: subfolders.
  Third: files.

### Bad fresh ticket (ambiguous scope)

```
Continue the project setup.
```

- Zero specificity. The model will list everything, then list more, then
  either do nothing or guess wrong.
- **Fix**: Enumerate exactly what remains.

---

## 3. Continuation Formatting Patterns

Continuation ticket quality is the single highest-leverage operational
variable. A precise continuation converges in 1-2 steps. A vague one burns
the entire budget on inspection.

### What succeeds

```
Remaining work after previous run:

Missing folders:
- project/data/July
- project/data/August

Missing files:
- project/data/June/report.md
- project/data/June/summary.csv

Create only these items. Do not inspect existing structure first.
Once all 5 items exist, set complete:true.
```

### What fails

```
Continue work. Inspect the existing structure first.
Create only the missing folders/files.
Do not recreate existing items.
```

This triggers an inspection spiral. The model interprets "inspect first" as
a directive to list everything, then lists again to verify, burning all 4
steps on listing alone.

### Continuation formatting rules

1. **Enumerate every missing item by full path.** Do not use ranges or
   patterns like "all remaining months." List each one.
2. **State what already exists.** A brief summary ("January-June exist,
   July-December missing") prevents the model from needing to discover this.
3. **Do NOT say "inspect first."** Replace with explicit enumeration.
4. **Do NOT say "do not inspect first"** — this also triggers odd behavior.
   Instead: enumerate what to create and add "List only if a create fails."
5. **Include completion criteria.** "Once all N items exist, set complete:true."

---

## 4. Allocation Subtask Templates

Allocation subtasks behave like continuation tickets — they are the primary
behavioral cue for scoping.

### Vague subtask (baseline — triggers no-op churn)

```
Produce your allocated output for ticket N inside your owned path only.
```

This causes the model to re-attempt creating folders that already exist
because it has no completion criteria. Observed: 40% no-op rate.

### Explicit subtask (tested — eliminates no-op churn)

```
[owned path]: allocated/ticket-N/agent-M/

Create January through December folders.
Do not recreate existing folders.
List only if a create fails.
Once all 12 folders exist, set complete:true.
Total expected work: 12 folder creates.
```

Observed: 0% no-op rate, zero waste, completed in 2 steps.

### Allocation subtask template

```
[owned path]: {ownedPath}

Required output:
{one item per line, each with a fully-qualified path}

Do not create anything outside the owned path.
List only if a create/write fails.
Once all {N} items exist, set complete:true.
Total expected work: {N} {folder creates/file writes/etc}.
```

### Key points

- State the **owned path** explicitly (it is already in the runtime envelope,
  but repetition helps)
- **Enumerate every item.** "Create the required subfolders" is not enough.
- **Tell the model when to stop.** "Once all 12 folders exist" eliminates
  redundant re-attempts.
- **Use "List only if a create fails"** — this provides a recovery path
  without triggering defensive inspection.

---

## 5. Enumeration Guidelines

Enumeration precision determines whether the model can act without
defensive inspection.

### Good enumeration

```
Missing:
- project/reports/July/report.md
- project/reports/July/data.csv
- project/reports/August/report.md
- project/reports/August/data.csv
```

The model can execute these directly. No listing needed.

### Bad enumeration

```
Create all remaining monthly report files.
```

The model does not know which months are "remaining." It must list to
discover this. It will list, compute the diff, then create — consuming 1-2
steps on discovery alone.

### Enumeration rules

1. **Use fully-qualified paths.** Relative paths require the model to
   resolve them against workspace state, which may trigger inspection.
2. **One item per line.** Dense paragraph formatting increases parsing
   errors.
3. **Prefix with "Missing:" or "Create exactly these:"** — this signals
   scope to the model.
4. **Include both folders and files.** If a folder already exists but a
   file does not, list the file. Do not assume the model infers files from
   folder existence.
5. **State the total count.** "Total expected work: 12 items" helps the
   model allocate budget.
6. **List new or short branches before long sequences.** If a continuation
   needs items in different directory branches, list the new or compact
   branch first. The model creates items in listed order — a side branch
   listed early gets created alongside the first batch of the main work.
   A side branch listed last may be skipped entirely.

---

## 6. When to Split Tickets

Split criteria:

1. **Estimated operations > 16.** The model's cross-step progress tracking
   degrades after 2 productive mutation steps (~16 operations at 8/step).
   Beyond this threshold, the model loses track of what it has created and
   either re-attempts already-existent items or lists to re-discover state.
   This is a model-level limitation, not a budget constraint.

2. **Work requires multiple phases.** If the output of phase 1 determines
   what phase 2 creates, they should be separate tickets. The continuation
   ticket explicitly enumerates remaining work.

3. **Work crosses ownership boundaries.** Different owned paths mean
   different allocation items.

4. **A ticket fails with "step limit" AND the mutation count is > 0.**
   This is truthful budget exhaustion. The model did useful work but ran
   out of steps. Create a continuation ticket enumerating the remaining
   items.

### Continuation vs fresh ticket

Use a **continuation ticket** (same workspace, same base path) when:
- Previous run did partial work
- The new work is additive (create missing items)
- Enumeration is feasible (≤ 16 remaining ops)

Use a **fresh ticket** (new workspace or new base path) when:
- The prior workspace state is unreliable
- Work exceeds 16 remaining ops (split further)
- A fresh start is simpler than enumerating partial state

---

## 7. Step-Budget Expectations

### What 1 step can do

- **Best case**: 8 folder creates or 8 file writes
- **Typical**: 6-8 operations (some reasoning overhead)
- **Worst case**: 0 operations (inspection step)

### What 4 steps (full budget) can do

| Pattern | Expected outcome |
|---|---|
| 2 create steps (no list) | ~16 folder creates (reliable — all items created, may not finalize) |
| 1 list + 2 create steps | ~16 folder creates (reliable ceiling — step 3 loses progress) |
| 1 list + 3 create steps | ~16 folder creates (step 3 is a list or no-op — progress lost) |
| 4 list-only steps | 0 folder creates (inspection spiral — intervention needed) |

**The 2-step productive ceiling is the single most important operational**
**constraint.** The model can create ~16 items across 2 productive steps.
Step 3 (if it follows 2 create steps) will be a list operation or
re-attempts of already-created items. The model does not resume
productive work after step 2.

This means any ticket requiring more than ~16 mutations must be split
into at least 2 tickets. Continuation tickets enumerate the remaining
items and reset the progress tracking window. (Continuation tickets
with explicit enumeration complete in 1-2 steps, staying within the
reliable window.)

### What step limits mean

If a run fails with "exceeded execution step limit of N":

- **Mutation count = 0**: The model inspected but never acted. The ticket
  likely triggered an inspection spiral. (See anti-patterns.)
- **Mutation count > 0 but task incomplete**: Truthful budget exhaustion.
  The model did useful work but could not finish. Create a continuation
  ticket.
- **Mutation count complete but no completion signal**: The model did all
  the work but did not set complete:true before the limit. This is the
  healthiest failure mode — the work is done; the model just ran out of
  protocol steps.

---

## 8. Optimistic Execution Guidance

### Core principle

```
optimistic mutation + explicit enumeration + truthful runtime recovery
>
preventative defensive inspection
```

This has been validated across:
- Allocation (disjoint owned paths, folder creation)
- Continuation (partial state, folder creation)
- Overlapping partial state (mixed existing/new files and folders)
- File creation + preservation scenarios

### How it works

1. **Enumerate exactly** what to create (paths, count, completion criteria)
2. **Default to create/write** — do not inspect first
3. **Add a conditional recovery fallback**: "List only if a create/write
   fails"
4. **The runtime surfaces errors truthfully** — if a write fails (ENOENT,
   ownership violation, protected path), the model sees the error and can
   recover

### Why it works

The runtime substrate is now trustworthy enough that the model does not
need to pre-audit the workspace. The system already provides:
- Truthful runtime failures
- Owned-path enforcement
- Bounded execution
- Replay/history
- Mutation visibility

Inspection becomes **conditional recovery behavior** instead of
**proactive defensive behavior**.

### When NOT to use optimistic execution

- The task requires **content-dependent decisions** (e.g., "update files
  based on their current content"). Enumeration cannot fully describe what
  to write.
- The enumeration is **infeasibly large** (> 16 items). The model's
  progress tracking degrades after 2 productive mutation steps. Even
  with optimistic execution, items beyond the 16th will not be created.
  Split the ticket into ≤ 16-item chunks.
- The workspace state is **truly unknown** and cannot be described in the
  ticket. (This should be rare — it means the operator does not know what
  exists.)

### The "List only if a create fails" pattern

This is the key phrasing. It is NOT an anti-inspection instruction. It is
a **conditional fallback**:

- Creates/writes default to proceed
- If a create/write fails (directory missing, ownership violation, etc.),
  the model has permission to list and recover
- Since folder creates rarely fail, the conditional never triggers
- Since file writes fail only on structural issues (missing parent
  directory, protected path), the conditional is a safety net, not a
  code path

This works because "List only if X fails" preserves a recovery path while
defaulting to action. Compare with "Do not list first" which denies a
recovery path and causes the model to compensate with redundant work
(worse than the defensive baseline).

---

## 9. Failure Interpretation Guidance

Not all failures are equal. Interpret them before intervening.

### Truthful budget exhaustion (most common)

```
Agent run exceeded execution step limit of 4
The model performed N successful workspace mutations
but did not signal completion before the limit was reached.
```

**Meaning**: The model did useful work (N mutations) but ran out of steps.
Check N against the 16-mutation ceiling:

- **N ≤ 16 and all items exist on disk**: This is protocol-finalization
  overhead. The work is done but the model wasted its final step(s) on
  re-attempts rather than signaling completion. Verify items on disk and
  close the ticket. Do not re-run.

- **N ≤ 16 and items remain on disk**: This is truthful budget exhaustion
  from the 2-step productive ceiling. Create a continuation ticket
  enumerating the remaining items.

- **N > 16**: (Rare — only possible without the initial list step.)
  Create a continuation ticket for the remainder.

**Action**: Create a continuation ticket enumerating the remaining items
(if any). Do not raise the budget. Do not re-run the same ticket.

### Inspection spiral

```
Agent run exceeded execution step limit of 4
(no mutation count message — or mutation count is 0)
```

**Meaning**: The model spent all steps listing. The ticket likely said
"inspect first" or used vague continuation wording.

**Action**: Rewrite the ticket with explicit path enumeration and
optimistic execution guidance. Do not re-run the same wording.

### False completion

```
The model set complete:true but required items are missing.
```

**Meaning**: The model declared the task done without completing it.

**Action**: This usually occurs when the model conflates folder existence
with file existence (e.g., a folder exists so it assumes files are inside).
Create a precise continuation ticket listing each missing file by path.
If this happens repeatedly, check enumeration precision — the model may
not have known what exactly was expected.

### Ownership violation

```
Workspace operation blocked outside owned output paths:
createFolder some/outside/path
```

**Meaning**: The model tried to write outside its owned path. The
enforcement blocked it correctly. This is the runtime working as designed.

**Action**: Check if the owned path is correct. If yes, the model tried
to drift. The ticket may lack owned-path guidance. If the work legitimately
needs to write outside the owned path, it needs a different ticket type.

### No-progress stall

```
Model stalled twice with complete:false and no workspace actions
```

**Meaning**: The model returned empty actions without completing. This is
a transient model behavior issue.

**Action**: Re-run the same ticket. If it happens repeatedly, the ticket
may be confusing the model — simplify the wording.

### Classification table

| Symptom | Actual problem | Action |
|---|---|---|
| Step limit, N mutations done, N ≤ 16 | Ticket sized within reliable window | Continuation ticket (all work done, just needs finalization) |
| Step limit, N mutations done, N < 16 but items remain | Progress tracking lost after step 2 | Continuation ticket enumerating remaining items explicitly |
| Step limit, N mutations done, N = 16 | Budget exhausted at 2-step ceiling | Continuation ticket enumerating remaining items |
| Step limit, 0 mutations | Inspection spiral | Rewrite with enumeration |
| complete:true, work missing | False completion | Continuation with explicit paths |
| Ownership violation | Model path drift | Check owned path or ticket type |
| Empty actions stall | Transient model behavior | Re-run |
| No-op churn | Vague allocation/continuation wording | Add completion criteria |

---

## 10. Anti-Patterns Discovered During Experiments

These are patterns that were tested and produced worse outcomes than the
alternatives.

### "Inspect existing structure first"

**Do not use in tickets.** This triggers an inspection spiral regardless
of context. The model interprets it as a directive to list everything,
then lists again to confirm, then runs out of steps.

**Tested in**: single-agent continuation, allocated continuation.
**Result**: 0 mutations at step limit in worst cases; 40%+ budget on
listing in best cases.

### "Do not list first" / "Do not inspect first"

**Do not use.** Despite the intent to prevent inspection spirals, this
produces worse behavior than either the optimistic or defensive baseline.
The model interprets it as a restriction, then compensates with redundant
create attempts or false completions.

**Tested**: In allocation subtask.
**Result**: Increased no-op churn (12 vs 8 in one test) and false
completions (model set complete:true without creating anything).

**Replace with**: "List only if a create/write fails."

### Vague allocation subtask

```
Produce your allocated output for ticket N inside your owned path only.
```

**Tested**: In allocated multi-agent ticket for folder creation.
**Result**: 40% no-op rate. The model created 12 folders + 8 redundant
re-attempts because it had no completion criteria.

**Replace with**: Explicit subtask template (see Section 4).

### Vague continuation

```
Continue work inside existing path. Create only missing items.
```

**Tested**: Medium-sized continuation.
**Result**: All 4 steps consumed by listing. Zero mutations.

**Replace with**: Explicit path enumeration (see Section 3).

### Single ticket with > 16 mutations (cross-step progress tracking)

**Do not rely on the model tracking progress across 3+ mutation steps.**
After 2 productive steps (~16 operations), the model loses track of which
items it has created. Step 3 will be a list operation or re-attempts of
already-created items. Items beyond the 16th are never created.

**Tested**: 16-folders, 24-folders, and 28-folders tickets with full
guidance (enumeration, "do not recreate", completion criteria, "list
only if a create fails").
**Result**: All 4 variants failed at 16/24 or 16/28 folders. Step
breakdown showed consistent pattern: step 1 = 8 creates, step 2 = 8
creates with position loss on 8th item, step 3 = list or re-attempts.

**Fix**: Keep each ticket to ≤ 16 mutations. Use continuation tickets
for remaining items. Continuation tickets reset the progress tracking
window — the model creates ≤ 16 items from a list in 1-2 steps and
completes.

### Protocol-finalization overhead

**All work done but complete:true not set.** Even when the model creates
all 16 items within the 2-step productive window, it may waste step 3
on re-attempts or listing instead of signaling completion. The mutations
are recorded, the items exist on disk, but the run is marked "failed"
because the step limit was hit before the model said complete:true.

**Tested**: 16-folders ticket with full guidance. All 16 folders created
across steps 1-2, step 3 wasted on 8 no-op re-attempts, step limit hit
at step 4. Work done, no completion signal.

**Fix**: Keep tickets to ≤ 16 mutations. If the run fails with
"performed N successful workspace mutations but did not signal
completion" and N = 16 (or close to 16), the work is fully done. Mark
the ticket as completed and move on. Do not re-run or create a
continuation ticket.

### Side branch omission in continuation tickets

**Continuation tickets with items in different directory branches may**
**skip the secondary branch.** When a continuation lists multiple items
at different depths or in different parts of the tree, the model focuses
on the first pattern it identifies and may skip items that don't fit
that pattern.

**Tested**: Continuation ticket listing 2 deep-path items (levels 8, 9
extending a/ tree) plus 1 side-branch item (x/y/z in a new root-level
path). The model created both deep items but entirely skipped the
side branch — x/ directory did not exist at all.

**Root cause**: Scope comprehension failure, not progress tracking. The
model interpreted the work as "extend the existing deep path" and did
not register the side branch as a separate work item.

**Fix**: List new or shorter branches FIRST in continuation tickets.
The model creates items in listed order; when a side branch appears
early, it creates it before focusing on the main branch sequence.
Alternatively, separate tickets for each branch.

### Single ticket for > 28 operations

**Tested**: 73-ops ticket (12 months × 4 subfolders + files).
**Result**: 13/73 ops completed before step limit. 18% completion rate.

**Fix**: Split into separate tickets before running.

### Adding orchestration to fix allocation overlap

**Tested conceptually**: The owned-path enforcement already handles path
conflicts. The remaining "overlap" concerns were enumeration precision
issues, not coordination issues. No orchestration layer needed.

**Evidence**: Explicit subtask eliminated 100% of allocation no-op churn
without any coordination machinery.

---

## Summary: The Operational Law

```
optimistic mutation + explicit enumeration + truthful runtime recovery
>
preventative defensive inspection
```

This holds across:
- Allocation (disjoint paths)
- Continuation (partial state)
- Overlapping partial state (mixed files/folders)
- File creation + preservation scenarios

The system performs best when:
- The operator enumerates intended work precisely
- The model executes optimistically (create/write first)
- Failures surface truthfully from the runtime
- The operator writes precise continuation tickets

This is **operational authoring discipline**, not infrastructure capability.
The runtime provides the guarantees. The operator provides the precision.
They are not interchangeable.
