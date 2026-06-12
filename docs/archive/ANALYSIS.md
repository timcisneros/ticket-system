# Analysis

## Goal
- Codify operational guidance from experimental evidence across allocation, continuation, overlapping-state, progress-tracking, nesting, update, and content-dependent scenarios.
- All experiments use gpt-4.1-mini with default 4-step budget unless noted.

## Constraints & Preferences
- Do NOT turn findings into orchestration machinery, autonomous decomposition, planners, or coordination layers.
- Do not modify infrastructure, prompts, or runtime behavior.
- Only vary operational wording in experiments — not model, budget, action limits, or workload shape.
- Distinguish clearly between substrate guarantees and operational authoring discipline.
- Present operational practice as learned operator discipline, not infrastructure magic.

---

## Progress

### Done — 13 experiments complete

1. **Allocation subtask** (vague vs explicit): Explicit subtask eliminated 40% no-op rate → 0%.
2. **Inspection necessity** (3 variants A/B/C): "List only if a create fails" won (2 steps, 0 no-ops). "Do not list first" backfired — worse than defensive baseline.
3. **Continuation strategy** (defensive vs optimistic): Optimistic (1 step, 0 lists, 6 creates) vs defensive (4 steps, incomplete).
4. **Overlapping state** (mixed existing/new files): Optimistic (2 steps, 0 overwrites, all 9 files) vs defensive (4 steps, failed, 7/9 files).
5. **Cross-step progress tracking** (24 folders, 4 budgets): Consistent pattern — 2 productive mutation steps then lists. 16-item ceiling with default 4-step budget.
6. **Continuation resets window** (Phase 1: 24 fails at 16 → Phase 2: continuation creates remaining 8 in 1 step, complete:true).
7. **Mixed folders + files at boundary** (8 folders + 8 files in continuation): 2 steps, 0 lists, 0 no-ops, all 16 items created.
8. **File content verification** (Phase 1: create wiki sections with specific content → Phase 2: add more sections): Content written correctly, preserved across continuation, not overwritten.
9. **Deep nesting** (3, 5, 7, 8, 9 levels): All folders and files created correctly. Continuation extending existing deep paths works. New side branches in continuation tickets may be skipped.
10. **Side branch ordering** (deep path + new branch, order swapped): Side branch listed FIRST → both branches complete (2 steps). Deep listed FIRST → both complete (4 steps, high no-op churn). Side branch in continuation goes last → skipped entirely.
11. **Update/modify operations** (read existing files, append content): Model reads before writing even without explicit guidance. Content correctly appended, originals preserved. "Read then modify" guidance adds version increment; "direct write" guidance still reads first.
12. **Budget experiment** (4 vs 5 vs 6 step budgets, 24 folders): 4-step = 16/24. **5-step = 24/24** (all created but no complete:true). 6-step = 24/24 (all created but no complete:true). Consistent pattern: list → 8 creates → 8 creates → list (recovers) → 8 creates → list (verifies). The model always needs a recovery list after 2 consecutive mutation steps.
13. **Content-dependent continuation** (read 4 wiki files, write summary): 4 steps, 5 lists (minimum for 5 directories), 4 reads, 1 write, complete:true. Summary accurately captured all sections and topics. No inspection spiral.

---

## Key Findings Summary

- **The 2-step productive ceiling** is the single most important operational constraint. After 2 consecutive mutation steps (~16 ops), the model MUST list to re-establish context. This is predictable and consistent across all experiments.
- **With 5+ step budget**, the model recovers and completes all items (24/24 in 5 steps). But it still doesn't signal completion — uses final step for verification.
- **Continuation tickets reset the progress tracking window.** ≤ 16 items in a continuation completes cleanly in 1-2 steps.
- **Side branches in continuation should be listed first.** Otherwise they may be skipped.
- **Content-dependent operations work** with the optimistic pattern. Model discovers, reads, synthesizes, writes — no spiral.
- **Update operations are safe.** Model reads before writing even without explicit guidance.
- **File content is written correctly and preserved across continuations.**

---

## Operational Law

```
optimistic mutation + explicit enumeration + truthful runtime recovery
>
preventative defensive inspection
```

This holds across all tested domains:
- Allocation (disjoint paths)
- Continuation (partial state)
- Overlapping partial state (mixed files/folders)
- File creation + preservation
- File content writing and modification
- Content-dependent synthesis (read then write)
- Deeply nested structures
- Cross-step progress tracking recovery

---

## Documents

- **OPERATIONS.md**: Complete operational guidance with 10 sections, updated with all experimental findings including the 16-item ceiling, 2-step productive limit, continuation resets window, side branch ordering, update operations, and content-dependent continuation.

---

## Next Steps

- (none — all experiments complete)
