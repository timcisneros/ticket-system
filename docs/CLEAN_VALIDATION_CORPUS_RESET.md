# Clean Validation Corpus Reset Report

## Reset Date
2026-05-28

## What Was Archived

All active operational data was copied to:

```
data/archive/pre-validation-reset-2026-05-28/
```

**Archived files:**
- `tickets.json` (82 tickets, 69,607 bytes)
- `runs.json` (11717 lines, 362,733 bytes)
- `events.jsonl` (60,501 lines, 11,328,839 bytes)
- `logs.json` (17,998 lines, 582,413 bytes)
- `operation-history.json` (2,415 lines, 81,116 bytes)
- `replay-snapshots/` directory (all run artifacts)

**Total archived:** ~12.4 MB

## What Was Reset

Active state files were emptied:

- `data/tickets.json` -> `[]` (empty array)
- `data/runs.json` -> `[]` (empty array)
- `data/events.jsonl` -> empty file (0 bytes)
- `data/logs.json` -> `[]` (empty array)
- `data/operation-history.json` -> `[]` (empty array)
- `data/replay-snapshots/` -> directory cleared

## What Was Preserved

The following were **not** modified or reset:

- **Workflow definitions:** `data/workflows.json` preserved (all existing workflows intact)
- **Workload Profiles:** `server.js` Workload Profiles preserved (report, diagnosis, refactor, recommendation, bulk-inventory)
- **Agent configurations:** `data/agents.json` preserved
- **User/group/permission data:** `users.json`, `groups.json`, `memberships.json`, `permissions.json` preserved
- **Documentation:** All `docs/` files preserved
- **Configuration:** `protected-paths.json`, `allocation-plans.json` preserved
- **Benchmark data:** `benchmark-cases.jsonl`, `benchmark-results.jsonl` preserved
- **Batch traces:** `batch-traces.json`, `batch-ticket-results.json` preserved

## Validation Ticket Categories

25 new tickets were created to test the main uncertainties identified in the investigation.

### Category A: Declarative vs Imperative Requests (Tickets 1-5)

Tests whether the system handles outcome declarations differently from step-by-step instructions.

| ID | Type | Objective Pattern |
|---|---|---|
| 1 | Declarative | "Investigate why the checkout API is returning 500 errors and produce a root cause analysis with cited evidence." |
| 2 | Imperative | "1. Read the checkout service logs... 2. Identify... 3. Write... 4. Set complete:true." |
| 3 | Declarative | "Produce a security audit report for the authentication module..." |
| 4 | Imperative | "1. List the auth directory. 2. Read src/auth.js. 3. Check for hardcoded secrets..." |
| 5 | Declarative | "Ensure the production database backup completed successfully..." |

**Uncertainty tested:** Do users prefer declaring outcomes or prescribing steps?

### Category B: Reusable Work Definitions vs One-Off Objectives (Tickets 6-10)

Tests whether users create repeatable patterns or one-off tasks.

| ID | Type | Objective Pattern |
|---|---|---|
| 6 | One-off | "Write a summary of today's deployment to deploy-summary.md." |
| 7 | Reusable pattern | "Generate the weekly status report: inspect workspace files, summarize changes, write status.md." |
| 8 | One-off | "Fix the broken test assertion in tests/calculator.test.js at line 42." |
| 9 | Workflow (reusable) | "Run the legal intake workflow for client Jane Doe, wrongful termination." |
| 10 | One-off | "Create a file called temp-note.txt with the text 'quick note'." |

**Uncertainty tested:** Will users author and reuse work definitions, or write one-off objectives?

### Category C: Workflow-First vs Agent-First vs Hybrid (Tickets 11-15)

Tests execution mode distribution and hybrid work detection.

| ID | Execution Mode | Classification | Objective Pattern |
|---|---|---|---|
| 11 | Workflow | Workflow-first | "Run the verify-mike-write-file workflow to create validation-output.txt..." |
| 12 | Agent | Agent-first (simple) | "Create validation-output.txt containing 'agent test output'." |
| 13 | Agent | Hybrid | "Investigate the workspace state, identify the most critical file to update, and produce a repair recommendation with cited evidence." |
| 14 | Workflow | Workflow-first | "Run the demo workflow to create a greeting file with content 'hello validation'." |
| 15 | Agent | Hybrid | "Read src/calculator.js and src/database.js. Identify security risks... Create risk-report.md..." |

**Uncertainty tested:** Is hybrid work actually dominant? Do users prefer workflows or agent mode?

### Category D: Success Criteria Clarity (Tickets 16-20)

Tests whether explicit success criteria improve outcomes.

| ID | Criteria Clarity | Objective Pattern |
|---|---|---|
| 16 | Clear | "Write incident-report.md. Success criteria: report contains timeline, impact assessment, and root cause hypothesis with cited evidence." |
| 17 | Vague | "Write a report about the incident." |
| 18 | Clear | "Audit config/settings.json. Success criteria: each security risk is rated high/medium/low with a specific suggested fix." |
| 19 | Vague | "Check config/settings.json for problems." |
| 20 | Clear | "Create validation-test.md. Success criteria: file exists and contains the exact text 'validation complete'." |

**Uncertainty tested:** Do explicit success criteria reduce false completions?

### Category E: Evidence Requirement Clarity (Tickets 21-25)

Tests whether evidence requirements improve output quality.

| ID | Evidence Requirement | Objective Pattern |
|---|---|---|
| 21 | Required | "Investigate the timeout pattern... Cite specific run IDs and error codes..." |
| 22 | Not required | "Investigate why runs are timing out. Write timeout-analysis.md." |
| 23 | Required | "Compare the auth module... Cite specific line numbers for every difference..." |
| 24 | Not required | "Compare the auth implementations and write a comparison." |
| 25 | Required | "Inspect the workspace root... Cite their paths and modification times..." |

**Uncertainty tested:** Do evidence requirements improve trust and output quality?

## Exact Ticket IDs Created

| ID | Category | Execution Mode | Assigned Agent |
|---|---|---|---|
| 1 | Declarative vs Imperative | Agent | Agent 1 |
| 2 | Declarative vs Imperative | Agent | Agent 1 |
| 3 | Declarative vs Imperative | Agent | Agent 1 |
| 4 | Declarative vs Imperative | Agent | Agent 1 |
| 5 | Declarative vs Imperative | Agent | Agent 1 |
| 6 | Reusable vs One-Off | Agent | Agent 1 |
| 7 | Reusable vs One-Off | Agent | Agent 1 |
| 8 | Reusable vs One-Off | Agent | Agent 1 |
| 9 | Reusable vs One-Off | Workflow | Agent 1 |
| 10 | Reusable vs One-Off | Agent | Agent 1 |
| 11 | Execution Mode | Workflow | Agent 1 |
| 12 | Execution Mode | Agent | Agent 1 |
| 13 | Execution Mode | Agent | Agent 1 |
| 14 | Execution Mode | Workflow | Agent 1 |
| 15 | Execution Mode | Agent | Agent 1 |
| 16 | Success Criteria | Agent | Agent 1 |
| 17 | Success Criteria | Agent | Agent 1 |
| 18 | Success Criteria | Agent | Agent 1 |
| 19 | Success Criteria | Agent | Agent 1 |
| 20 | Success Criteria | Agent | Agent 1 |
| 21 | Evidence Requirements | Agent | Agent 1 |
| 22 | Evidence Requirements | Agent | Agent 1 |
| 23 | Evidence Requirements | Agent | Agent 1 |
| 24 | Evidence Requirements | Agent | Agent 1 |
| 25 | Evidence Requirements | Agent | Agent 1 |

**Total: 25 validation tickets**

- Agent mode: 20 tickets (80%)
- Workflow mode: 5 tickets (20%)

## Notes

- Runtime behavior was not modified.
- Workflow definitions were not deleted or changed.
- All documentation was preserved.
- The historical corpus remains accessible in the archive for reference.
- The validation corpus is designed to test the largest uncertainties identified during the investigation, not to represent a desired future state.
