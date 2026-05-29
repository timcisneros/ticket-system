# Actual Ticket Usage Analysis

## Scope

All 82 tickets in `data/tickets.json` were analyzed.

---

## Execution Mode Distribution

| Mode | Count | Percentage |
|---|---|---|
| **Agent direct-action** | 60 | 73% |
| **Workflow execution** | 22 | 27% |

**Observation:** Workflow execution is more prevalent in actual usage (27%) than the research model predicted (20%). This is driven by 20 batch legal-intake workflow tickets (IDs 62-80).

---

## Implied Business Work Definitions

### By Objective Pattern

| Work Type | Count | Percentage | Example |
|---|---|---|---|
| **File creation / modification** | 18 | 22% | "create file mike-simple...", "write cli-proof.md" |
| **Batch workflow execution** | 20 | 24% | "Legal intake 1-10", "Batch legal 1-10" |
| **Workspace inspection / report** | 14 | 17% | "Inspect workspace files and write reports/workspace-status-report.md" |
| **File reorganization** | 10 | 12% | "Move all .txt files to archive", "Create folders A and B and organize" |
| **Diagnosis / analysis** | 8 | 10% | "Diagnose which test assertions are incorrect", "Analyze timeout causes" |
| **Workflow draft creation** | 5 | 6% | "Create a simple flat workflow draft" |
| **Handoff task creation** | 7 | 9% | "Create handoff task for Mike to write..." |
| **Vague / test objectives** | 5 | 6% | "improve the project", "wal-test-objective", "Delete everything" |

**Observation:** The dominant work types are procedural, not cognitive. 58% of tickets (file creation + batch workflows + file reorganization) are procedural operations. Only 27% involve inspection, diagnosis, or reporting.

---

## Dominant Cognitive Primitives (Actual Usage)

| Primitive | Frequency | Context |
|---|---|---|
| **Execute** | ~70% | Most tickets are direct file operations or workflow step execution |
| **Observe** | ~20% | Report and diagnosis tickets involve listDirectory/readFile |
| **Verify** | ~15% | Some tickets include explicit verification steps |
| **Diagnose** | ~10% | Test diagnosis, timeout analysis, security risk identification |
| **Synthesize** | ~15% | Report writing requires synthesis of inspection findings |
| **Plan** | ~5% | Rare; most tickets have predefined steps |
| **Scope** | ~2% | Only "improve the project" is truly unscoped |
| **Arbitrate** | 0% | No tickets require conflict resolution |
| **Commit** | ~10% | Handoff tasks represent delegation/commitment |
| **Repair** | ~5% | "Repair recommendation" tickets |

**Observation:** The actual usage is dominated by **Execute** and **Observe**, not the full cognitive grammar. Complex primitives (Arbitrate, Scope, Plan, Repair) appear rarely or not at all.

---

## Classification: Research Model vs. Actual Usage

### Research Model Prediction

| Category | Predicted % |
|---|---|
| Workflow-first | 20% |
| Agent-first | 25% |
| Hybrid | 55% |

### Actual Usage

| Category | Actual % | Count | Evidence |
|---|---|---|---|
| **Workflow-first** | 27% | 22 | All batch legal intake (20) + deterministic workflow tests (2) |
| **Agent-first (procedural)** | 46% | 38 | File creation, file moves, handoff tasks with explicit step-by-step instructions |
| **Agent-first (cognitive)** | 8% | 7 | "improve the project", vague test objectives, "Delete everything" |
| **Hybrid** | 19% | 15 | Workspace reports, diagnosis, security analysis, repair recommendations |

**Key discrepancy:** The research model predicted 55% hybrid work (structured phases with adaptive reasoning). Actual usage shows only 19% hybrid. The majority (46%) is **procedural agent work** — tickets with explicit step-by-step instructions that require no adaptive reasoning.

---

## Workload Profile Mapping

### Profile Detection Results (Agent-Mode Tickets Only, n=60)

| Profile | Count | Percentage | Example Tickets |
|---|---|---|---|
| **report** | 12 | 20% | Workspace status reports, repair recommendations, implementation recommendations |
| **diagnosis** | 6 | 10% | Test diagnosis, timeout analysis, diagnostic note writing |
| **refactor** | 7 | 12% | File moves, folder organization, archive creation |
| **recommendation** | 2 | 3% | Implementation recommendation, security risk analysis |
| **bulk-inventory** | 1 | 2% | "List all files in workspace root and subdirectories" |
| **No match** | 32 | 53% | File creation, handoff tasks, workflow drafts, vague objectives |

**Observation:** 53% of agent-mode tickets do not match any Workload Profile. The profile system only classifies 47% of actual agent work. The dominant work types (file creation, handoff tasks) are invisible to the profile detector.

---

## Tickets That Don't Fit the Model

### Category 1: Procedural File Operations (18 tickets)

**Examples:**
- ID 1: "create file mike-simple-20260524.txt containing exactly hello from Mike"
- ID 41: "Create 2 txt files named 1 and 2 and put today's date in 1 and tomorrow's date in 2"
- ID 47: "Delete everything"
- ID 55: "Create a folder named archive/ and move the files test-a.txt and test-b.txt into it"

**Why they don't fit:** These are pure substrate operations. They have no business-level success criteria, no evidence requirements, and no need for cognitive decomposition. The Business Work Primitive model has no category for "create two text files."

### Category 2: Handoff Task Creation (7 tickets)

**Examples:**
- ID 33: "Create a createHandoffTask for Mike to write workspace-root/status-handoff.md"
- ID 36: "Create a createHandoffTask for Mike to write workspace-root/next-operational-step.md"

**Why they don't fit:** These are meta-workflow operations. They create delegation structures, not business deliverables. The model's 20 primitives don't include "delegate task to another agent."

### Category 3: Workflow Draft Creation (5 tickets)

**Examples:**
- ID 17: "Create a simple workflow draft that writes status-note.txt with content: Status: ok"
- ID 19: "Create a branching workflow draft" (failed)

**Why they don't fit:** These create orchestration definitions, not work products. The model doesn't include "author workflow" as a Business Work Primitive.

### Category 4: Vague / Test Objectives (5 tickets)

**Examples:**
- ID 2: "improve the project"
- ID 43: "wal-test-objective 1779914899613"
- ID 61: "Test workflow run"

**Why they don't fit:** These are development/test tickets with no clear business objective. They don't map to any of the 20 primitives.

---

## Frequency Distribution Summary

### Actual Work Types vs. Research Model

| Work Type | Actual % | Model Category |
|---|---|---|
| Procedural file operations | 22% | Not in model |
| Batch workflow execution | 24% | Workflow-first |
| Procedural agent instructions | 46% | Not in model (predicted as Hybrid) |
| Inspection / report / diagnosis | 19% | Hybrid / Agent-first |
| Meta-work (drafts, handoffs) | 12% | Not in model |
| Vague / test | 6% | Agent-first |

### Cognitive Primitive Usage vs. Research Model

| Primitive | Actual Frequency | Model Assumption |
|---|---|---|
| Execute | ~70% | One of ten equal primitives |
| Observe | ~20% | One of ten equal primitives |
| Verify | ~15% | One of ten equal primitives |
| Diagnose | ~10% | Frequently used (in Investigate, Remediate, etc.) |
| Synthesize | ~15% | Frequently used (in Draft Policy, Synthesize Intelligence) |
| Plan | ~5% | Frequently used (in Scope, Plan, Coordinate) |
| Scope | ~2% | Core primitive |
| Arbitrate | 0% | Core primitive |
| Repair | ~5% | Core primitive (in Remediate) |
| Commit | ~10% | Final step in most primitives |

---

## Common Work Types (Actual Usage)

1. **File Creation** — "Create X file with Y content" (18 tickets)
2. **Batch Workflow Execution** — "Run legal intake workflow for N clients" (20 tickets)
3. **Workspace Reporting** — "Inspect files, write report" (14 tickets)
4. **File Reorganization** — "Move files, create folders, organize" (10 tickets)
5. **Diagnosis** — "Read code, identify problems" (8 tickets)

---

## Common Cognitive Patterns (Actual Usage)

1. **Execute-only** — Direct file operations with no inspection or reasoning (38 tickets, 46%)
2. **Observe → Synthesize → Execute** — Inspect workspace, write report (14 tickets, 17%)
3. **Observe → Diagnose → Execute** — Read code, identify problems, write findings (8 tickets, 10%)
4. **Workflow step execution** — Execute pre-defined workflow steps (22 tickets, 27%)

---

## Determination: Does the Model Explain Actual Usage?

### Partially, with significant gaps.

**What the model explains:**
- The 19% hybrid work (reports, diagnosis, recommendations) maps cleanly to the research primitives.
- The 27% workflow execution maps to the workflow-first category.
- The 8% vague agent work maps to the agent-first category.

**What the model does not explain:**
- **46% procedural agent work** — Tickets with explicit step-by-step instructions ("Create folder X, then move file Y to Z") were predicted as hybrid but are actually pure execution with no adaptive reasoning.
- **12% meta-work** — Workflow draft creation and handoff task creation have no place in the 20 primitives.
- **22% file creation** — Simple file operations are substrate actions, not business work primitives.

**The mismatch:**
The research model was built from 20 sophisticated Business Work Primitives (Investigate Anomaly, Draft Operational Policy, Assess Operational Risk, etc.). Actual usage is dominated by simple procedural tasks (file creation, batch workflows, file moves) that are one or two substrate actions with no cognitive decomposition.

**Conclusion:** The model explains the **most complex** work in the system but misses the **most common** work. The system is used more as a procedural automation tool than as a cognitive reasoning platform.

---

## Implications for the Latent BWD Layer

The Workload Profiles (5 types: report, diagnosis, refactor, recommendation, bulk-inventory) only classify 47% of agent work. The remaining 53% (file creation, handoff tasks, workflow drafts, vague objectives) is invisible to the profile system.

This means the latent BWD layer is **even more incomplete** than the research suggested. It not only lacks semantic metadata; it also fails to recognize the dominant work patterns in actual usage.
