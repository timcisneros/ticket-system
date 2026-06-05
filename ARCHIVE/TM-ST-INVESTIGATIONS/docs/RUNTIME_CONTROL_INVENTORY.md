# Runtime Control Inventory

Ranked by actual observed outcome impact across 171 runs (167 execution_completed events: 136 completed, 24 failed, 7 unaccounted from run.resumed duplication).

---

## Tier 1: Terminated runs (operational weight confirmed)

### 1. Protected path authority
| Field | Value |
|---|---|
| Current value | `.git`, `.env`, `.env.*`, `node_modules`, `package.json`, `pnpm-lock.yaml` |
| Triggered | 9 authority.denied events, 9 terminal failures |
| Example runs | 10 (writeFile .env), 16/21/26/31/36/41/46 (writeFile package.json), 56 (createFolder package.json) |
| Outcome | All 9 runs terminated immediately on denial. No recovery mechanism exists — denied mutation is terminal. |
| Prevents bad run? | Yes. Prevents writing to `.env` (credentials leak) and `package.json` (project config corruption). |
| Causes good run to fail? | Possibly — no retry mechanism means a model that attempts the wrong path once is dead. |

### 2. No-progress detection (repeated inspection)
| Field | Value |
|---|---|
| Current value | 2 repeated inspection-only responses → warning; 3 → termination |
| Triggered | 6 terminal failures |
| Example runs | 165, 166, 168, 169, 170, 171 |
| Outcome | Model emitted only listDirectory/readFile across 3+ consecutive steps. Termination prevented infinite inspection loop. |
| Prevents bad run? | Yes. Catches model stuck in discovery phase. |
| Causes good run to fail? | Yes for runs 165–171 — models attempted 3-mutation batches (createFolder + 2x renamePath) that were truncated to ≤2 by mutating_action_limit, then fell back to inspection, triggering no-progress after truncation prevented progress. |

### 3. Conflicting mutation detection
| Field | Value |
|---|---|
| Current value | Rejects writeFile when same path was already committed at same historyId |
| Triggered | 4 terminal failures |
| Example runs | 17, 22, 27, 32 |
| Outcome | All 4 are benchmark artifact-accuracy tests. Model tries to writeFile to a path that conflicts with a previously committed mutation at the same replay step. |
| Prevents bad run? | Yes in benchmark context — ensures deterministic replay fidelity. |
| Causes good run to fail? | Arguably — the model produced a correct final workspace but was penalized for intermediate write conflicts during multi-step work. |

### 4. Max execution steps (maxExecutionSteps)
| Field | Value |
|---|---|
| Current value | 4 |
| Triggered | 2 terminal failures |
| Example runs | 5, 92 |
| Outcome | Run 5: model performed 4 mutations across 4 steps but never set `complete: true`. Run 92: model performed 2 mutations then got stuck. Both terminated at step 4. |
| Prevents bad run? | Yes. Caps unbounded execution. |
| Causes good run to fail? | Yes for run 5 — model did the work but forgot to signal completion. For run 92, model was genuinely stuck. |

### 5. Runtime duration limit (maxRuntimeDurationMs)
| Field | Value |
|---|---|
| Current value | 120000ms (2 min) |
| Triggered | 1 terminal failure |
| Example runs | 167 |
| Outcome | Run timed out. Model (gemma3:latest, local) was too slow to respond within the budget. |
| Prevents bad run? | Frees scheduler slot from hung run. |
| Causes good run to fail? | Yes for run 167 — the model was working but slow; timeout killed it before it could finish. |

### 6. Path traversal check
| Field | Value |
|---|---|
| Current value | All paths must resolve within workspace root |
| Triggered | 1 terminal failure |
| Example runs | 55 |
| Outcome | Model attempted to write outside workspace root. Run terminated. |
| Prevents bad run? | Yes. Security isolation boundary. |
| Causes good run to fail? | Not in observed data — escape was legitimate violation. |

---

## Tier 2: Triggered but never terminated a run

### 7. Max mutating actions per response (MAX_MUTATING_ACTIONS_PER_RESPONSE)
| Field | Value |
|---|---|
| Current value | 2 |
| Triggered | 12 action.suppressed events across 11 runs |
| Example runs | 1, 2, 3, 92, 105, 165, 166, 168, 169, 170, 171 |
| Outcome | Non-terminal. Model proposed 3+ mutating actions; excess dropped, agent continues with ≤2. 4 runs with suppression completed successfully (1, 2, 3, 105). 7 runs with suppression failed for other reasons (no-progress or step limit — not the suppression itself). |
| Prevents bad run? | Indirectly — limits per-response mutation blast radius. |
| Causes good run to fail? | Indirectly — in runs 165–171, suppression truncated the essential 3-mutation batch down to 0 (createFolder + 2x renamePath = 3 > 2 → ALL dropped), the model fell back to listDirectory, and no-progress detection then terminated the run. The suppression was the first domino in a causal chain that led to termination via a different control. |

---

## Tier 3: Never triggered in 171 runs

### 8. Max actions per response (MAX_AGENT_ACTIONS_PER_RESPONSE)
| Value | 8 |
| Triggered | 0 events, 0 failures |
| Reason | No model response ever contained 9+ actions. |

### 9. Max model requests per run (maxModelRequestsPerRun)
| Value | 4 |
| Triggered | 0 events, 0 failures |
| Reason | No run ever made 5+ model requests. All runs completed or failed within 1-4 requests. |

### 10. Max workspace operations per run (maxWorkspaceOperationsPerRun)
| Value | 32 |
| Triggered | 0 events (0 `action.rejected` events), 0 failures |
| Reason | No run ever performed 33+ workspace operations. Max observed: 3-4 per run. |

### 11. Workload profile numeric limits
| Fields | executionStepLimit (12), modelRequestLimit (8), maxWorkspaceOperations (32), maxListDirectory (3), maxReadFile (8) |
| Triggered | 0 events, 0 failures |
| Reason | All profile values pre-capped by Math.min against smaller base values or never approached by any run. |

---

## Tier 4: Non-enforcement (guidance / aggregation only)

### 12. Phase transitions
| Field | Value |
|---|---|
| Current value | See PHASE_OPERATIONS and ALLOWED_PHASE_TRANSITIONS maps |
| Triggered | 201 events, 0 failures |
| Outcome | Agents always respected phase rules. Never enforced as a limit — only observed/inferred. |

### 13. Postcondition completion check
| Field | Value |
|---|---|
| Current value | See checkPostconditionCompletion (line 5044) |
| Triggered | 0 failures |
| Outcome | Evaluates whether mutations satisfy postconditions. Never triggered a failure when objective was truly met. |

### 14. Repeated mutating action limit violation escalation
| Field | Value |
|---|---|
| Current value | Counter tracked; model receives warning on repeat suppression |
| Triggered | Never reached escalation threshold |
| Outcome | `repeatedMutatingActionLimitViolations` counter exists but none hit the level that would escalate from suppression to termination. |

---

## Summary: Which controls carry real weight

| Rank | Control | Runs terminated | Operationally real? |
|------|---------|:-:|:-:|
| 1 | Protected path authority | 8 | **Yes** — single most impactful |
| 2 | No-progress detection | 6 | **Yes** — but 6/6 cases were secondary to `mutating_action_limit` suppression |
| 3 | Conflicting mutation | 4 | **Benchmark only** — 0 operational tickets hit this |
| 4 | Max execution steps | 2 | **Yes** — but rare; only 2 in 160 runs |
| 5 | Runtime duration | 1 | **Yes** — secondary to slow local model |
| 6 | Path traversal | 1 | **Yes** — critical isolation boundary |
| — | API error (Run 97) | 1 | **Not a control** — OpenAI server error |
| 7 | Max mutating actions/response | 0 direct | **Secondary** — first domino in 6/6 no-progress failures |
| 8-11 | All remaining numeric limits | 0 | **Theoretical** — never approached |
| 12-14 | Guidance / aggregation | 0 | **Theoretical** — never enforced |
