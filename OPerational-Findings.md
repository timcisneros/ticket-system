# Operational Findings — First Pass

## Status: Observation Synthesis
Not architecture. Not implementation. Drawn from 6+ real runs against gpt-4.1-mini with default budget (4 steps, 32 ops, 4 requests).

---

## 1. Ticket Sizing

### Runs by size

| Ticket | Required ops | Budget  | Result | Mutation rate |
|--------|------------|---------|--------|---------------|
| test-small (3 folders) | 4 | 4 steps / 32 ops | **completed** | 4/4 (100%) |
| test-medium (7 days + 3 subdirs + 7 files) | 36 | 4 steps / 32 ops | **failed — step limit** | 24/36 (67%) |
| test-large (12 months + 4 subdirs + 12 files) | 73 | 4 steps / 32 ops | **failed — step limit** | 13/73 (18%) |

### What converges naturally
- Tickets requiring **≤ 8 mutating operations** converge in 1-2 steps.
- The model reliably batches 8 operations per response (the action limit).
- 4-step budget accommodates **~24-28 folder creates** before exhaustion.

### What repeatedly hits step limits
- Any ticket requiring **> 24 mutations reliably exhausts 4-step budget**.
- The model does NOT estimate remaining work and self-abort — it always tries, always hits the limit, and the failure is truthful.
- Run 3 (large) was particularly wasteful: spent a full step creating just the 13 month folders (8 on step 1, 5 on step 2), then started listing instead of subfolder work on step 3.

### Heuristic
- **1-step tickets**: ≤ 8 ops. Converge cleanly.
- **2-step tickets**: 9-16 ops. Reliable with clean continuation.
- **4-step tickets**: 17-28 ops. Possible but risky — inspection overhead eats budget.
- **> 28 ops**: **Must be split into multiple tickets**. The 4-step default cannot absorb any inspection waste.

### Relevance to budget defaults
The current 4-step / 4-request / 32-op default was validated as adequate for small tickets but insufficient for medium+ tasks. This is correct behavior — the harness is not designed to complete arbitrarily large tasks in one run.

---

## 2. Continuation Tickets

### What succeeds
- Tightly scoped continuations with **explicit missing-work enumeration**.
- Continuation tickets that name specific paths remaining ("create Saturday/Bills, Saturday/Cool Facts, write cool_facts.txt for Saturday and Sunday").
- Continuations where the remaining work fits in ≤ 2 steps.

### What spirals into inspection
- Vague continuation tickets: "Complete the remaining folders/files."
- Continuations that ask the model to "inspect first" without limiting inspection scope.
- Run 4 burned all 4 steps listing already-existing structure. The ticket said "Inspect the existing structure first" — the model took this literally and never mutated.

### Continuation specificity matters more than prompt sophistication
- The ticket objective is the model's primary behavioral cue for scoping.
- A vague continuation ticket triggers the model's safety/inspection reflex.
- A precise continuation ticket ("Create only: these 5 folders, then set complete:true") converges in 1-2 steps.

### Good continuation wording
```
Continue work in test-medium. The day folders (Mon-Sun) exist.
Invoices and Bills folders exist for Mon-Fri.
Missing: Saturday/Bills, Saturday/Cool Facts, Sunday/Invoices, Sunday/Bills, Sunday/Cool Facts.
Missing in all 7 day Cool Facts folders: cool_facts.txt files.
Create only these missing items. Do not re-inspect existing structure.
```

### Bad continuation wording
```
Continue work inside test-medium only. Inspect the existing structure first.
Create only the missing folders/files. Do not recreate existing items.
Complete the remaining Invoices, Bills, Cool Facts folders and all missing cool_facts.txt files.
```

This triggered 4 steps of pure listing (Run 4).

### Finding
**Continuation ticket quality is the single highest-leverage operational lever.** A precise continuation ticket converges in 1-2 steps. A vague one burns the entire budget on inspection. No prompt change can fully compensate for this gap.

---

## 3. Allocation Usefulness

### Where allocation works
- Clear ownership boundaries (disjoint output paths).
- Each agent has a well-defined subtask with no overlap.
- Subtask fits comfortably within the execution budget.
- Example: Ticket 5 "Allocated multi-agent" — each agent created 12 month folders in its own path. Both completed successfully.

### Where allocation produces churn
- **Overlapping or poorly partitioned work** causes duplicate attempts and no-op writes.
- Run 5 (Agent 1): 12 folders successfully created, but steps 2 and 3 produced 12 redundant createFolder attempts ("already_exists_noop"). The model re-attempted existing work.
- **No-op churn wastes budget**: those 12 no-ops consumed 2 steps with zero new mutations.
- The model has no awareness of what other agents did — it cannot distinguish "this path was allocated to me" from "this path already has content from another agent."

### Allocation subtask granularity
- Current subtask: "Produce your allocated output for ticket N inside your owned path only."
- This is minimal and vague. The model knows its owned path but not what specifically to create there.
- Better subtask: "Inside [owned path], create January through December folders. Do not recreate existing folders."

### Allocation ergonomic gaps
1. **No cross-agent awareness**: Agent cannot see what other agents produced.
2. **No completion signal**: Agent cannot tell if its output is supposed to be exclusive or additive.
3. **No overlap detection**: Agent may re-create work another agent already did.
4. **No budget guidance per agent**: Each agent has the same 4-step default, even if subtask needs only 1 step.

### When to use allocation
- Work is cleanly partitionable into disjoint paths.
- Each partition fits in ≤ 2 steps.
- The total work across all agents justifies the allocation overhead.
- Avoid if subtasks overlap or require coordination.

### When to avoid allocation
- Work requires shared awareness.
- Subtasks are smaller than ~4 operations each.
- The coordination overhead exceeds the parallelization benefit.
- Single-ticket (unallocated) with precise continuation is simpler and produces fewer failure modes.

---

## 4. Per-Agent Subtask Ergonomics

### Current subtask format
```
Produce your allocated output for ticket N inside your owned path only.
```

### Problems
- Specifies **where** to write but not **what** to write.
- No completion criteria.
- No verification guidance.
- No explicit continuation handling.

### Better subtask format (hypothesized)
```
[owned path]: allocated/ticket-5/agent-1/
Required output: Create folders January through December.
Do not create anything outside the owned path.
Once all 12 folders exist, set complete:true.
Do not re-list existing folders unless a create returns an error.
```

This would eliminate the no-op re-attempt pattern (step 2-3 in Run 5).

### Finding
The allocation subtask is the continuation ticket of the allocation system. Like continuation tickets, its quality determines whether the run converges or churns. Currently the subtask is a one-liner with no actionable guidance.

---

## 5. Operator Intervention Patterns

### When operators need to intervene

1. **Step limit exhaustion** — most common. Ticket was too large. Split into smaller tickets.
2. **False completion** — model declared complete:true with unfinished work. Create a precise continuation ticket.
3. **Over-inspection** — model burned all steps listing. Create a continuation ticket that explicitly enumerates remaining mutations and limits inspection scope.
4. **No-op churn in allocation** — model re-attempted existing work. Sharpen the allocation subtask with explicit completion criteria.

### What runtime enforcement already handles
- Action limit exceeded → warning + retry (works cleanly)
- Empty actions with complete:false → stalled warning + retry (works cleanly)
- Repeated list-only → no_progress warning then step limit (works cleanly)
- Write outside owned path → blocked with error (works cleanly)
- Step limit → truthful failure with mutation count (works correctly)
- Recovery from interrupted run → replay + divergence detection (verified working)

### What runtime enforcement does not handle (and should not)
- Ticket too large for budget → hit step limit (correct behavior)
- Vague continuation ticket → over-inspection (operator should fix ticket)
- Model inferred false completion → verification guidance in prompt (line 2548) is adequate
- Allocation duplicate work → sharper subtask needed (operator practice)

### Heuristic for intervention classification
Ask: "Would fixing this require new substrate code?"
- If yes → it is an operational practice problem disguised as an infrastructure gap.
- If no → it is actually an infrastructure gap (rare at this point).

---

## 6. Execution Budget Realities (Default: 4 steps, 32 ops, 4 requests)

### Real throughput
- **Folder creates**: ~8 per step (limited by action limit). ~24-28 in 4 steps.
- **File writes**: ~8 per step. ~24-28 in 4 steps.
- **Mixed inspection + mutation**: Expect 1 inspection step + 3 mutation steps = ~20-24 ops.

### Safe ticket sizing
- **Small**: ≤ 8 ops. Single run. No continuation needed.
- **Medium**: 9-24 ops. May fit in 1-2 runs with tight continuation.
- **Large**: > 24 ops. **Must be multiple tickets** or accept step limit as truthful failure.

### Continuation budget
- A continuation ticket should expect to need 1-2 steps max.
- If the remaining work exceeds ~16 ops, split further.

---

## 7. Good Ticket Examples

### Good fresh ticket (converged cleanly)
```
Inside test-small, create 3 folders named Alpha, Beta, and Gamma.
```
- 4 ops. Completed in 2 steps (1 list + 4 creates). No ambiguity.

### Good continuation ticket (hypothesized, based on patterns)
```
Remaining work in test-medium after previous run:
Missing folders: Saturday/Bills, Saturday/Cool Facts, Sunday/Invoices, Sunday/Bills, Sunday/Cool Facts
Missing files: cool_facts.txt in all 7 day Cool Facts folders
Do not list existing structure. Create and write only the missing items.
```
- 12 ops. Would converge in 2 steps (8 + 4).
- Eliminates the "inspect first" trap.

### Good allocation subtask (hypothesized)
```
[owned path]: allocated/ticket-5/agent-1/
Create January through December folders in the owned path.
Do not recreate existing folders.
Once all 12 exist, set complete:true.
Total work: 12 folder creates.
```
- Gives the model: scope, completion criteria, action limit awareness.

---

## 8. Bad Ticket Examples

### Bad fresh ticket (too large for default budget)
```
Inside test-large, create folders for all 12 months. Inside each month folder, create subfolders named Invoices, Bills, Cool Facts, and Notes. In each Cool Facts folder, add cool_facts.txt with 3 facts.
```
- 73 ops. Would need 9+ steps. Hit 4-step limit at 13 ops. **Split into multiple tickets.**

### Bad continuation ticket (triggers over-inspection)
```
Continue work inside test-medium only. Inspect the existing structure first. Create only the missing folders/files. Do not recreate existing items. Complete the remaining Invoices, Bills, Cool Facts folders and all missing cool_facts.txt files.
```
- Run 4 burned all 4 steps listing. The "Inspect first" instruction is dangerous in continuation tickets.

### Bad allocation subtask (triggers no-op churn)
```
Produce your allocated output for ticket N inside your owned path only.
```
- Run 5 produced 12 no-op re-attempts (2 steps wasted). The model didn't know what to create or when to stop.

---

## 9. Key Operational Distinctions

| Appears to be a bug | Actually is | Handle with |
|----|----|----|
| Model hit step limit | Ticket too large for budget | Split into smaller tickets |
| Model over-inspected on continuation | Continuation ticket too vague | Make continuation precise |
| Model declared false complete | Model assumed folder→file exists | Verification guidance (line 2548) |
| Model re-attempted existing operations | Allocation subtask too vague | Sharpen subtask with completion criteria |
| Model created/overwrote wrong paths | No action needed | Harness correctly enforces owned paths |
| Model stalled with empty actions | Transient model behavior | Stalled warning + retry works |

---

## 10. Next Observation Targets

Priority order:
1. Run continuation tickets with precise (enumerated) wording — does it eliminate over-inspection?
2. Run continuation tickets without the "inspect first" instruction — does the model still inspect?
3. Run allocation subtasks with explicit completion criteria — does it reduce no-op churn?
4. Run medium tickets (20-24 ops) with the simplified prompt — does oscillation decrease?
5. Test the prompt simplification pass against the over-inspection pattern (Run 4 reproduction).
