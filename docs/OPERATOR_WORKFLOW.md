# Operator Workflow

## Overview

This document describes the operator loop for managing tickets through the system. A human operator creates tickets, observes run progress, inspects failures, decides on remediation, and confirms outcomes.

> Companion: root `OPERATIONS.md` holds the sizing heuristics, ticket-quality guidance, and learned practices behind this procedure.

## Operator Loop

### 1. Create a Ticket

The operator creates a ticket with a clear objective and assigns it to an agent.

**CLI:**
```bash
node scripts/oquery.js create-ticket --url http://127.0.0.1:3000 --agent 1 --json "Create a workspace status report named status.md"
```

**API:**
```bash
curl -X POST http://127.0.0.1:3000/tickets \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "Cookie: sessionId=<session>" \
  -d "objective=Create+a+workspace+status+report" \
  -d "assignmentTargetType=agent" \
  -d "assignmentTargetId=1"
```

**Expected response:** `{ ticketId: N, runId: M, status: "pending" }`

### 2. Observe Run Status

The operator polls the run status until it reaches a terminal state.

**CLI:**
```bash
node scripts/oquery.js runs --url http://127.0.0.1:3000 --id <runId> --json --api
```

**API:**
```bash
curl http://127.0.0.1:3000/api/runs/<runId>/state \
  -H "Cookie: sessionId=<session>"
```

**Expected response:** Includes `status`, `currentPhase`, `mutationCount`, `replaySummary`, and `error` if failed.

### 3. Inspect Failure Reason

If the run failed, the operator inspects the failure reason.

**CLI:**
```bash
node scripts/oquery.js replay --url http://127.0.0.1:3000 --api <runId>
```

**API:**
```bash
curl http://127.0.0.1:3000/api/runs/<runId>/events \
  -H "Cookie: sessionId=<session>"
```

**What to look for:**
- `replaySummary.failureReason` — human-readable failure cause
- `replaySummary.failure.kind` — classification: `timeout`, `step`, `operation`, `provider_error`, etc.
- `replaySummary.failure.detail` — limit values, step counts, etc.
- Event log — `execution.phase_violation`, `authority.denied`, `action.suppressed`

### 4. Choose Remediation

Based on the failure, the operator chooses one of three actions:

#### A. Retry (default)
Use when the objective was valid but the model got stuck or the run timed out. Creates a new run with a clean slate. No prior failure context is injected.

**CLI:**
```bash
node scripts/oquery.js rerun --url http://127.0.0.1:3000 --id <ticketId> --json
```

**API:**
```bash
curl -X POST http://127.0.0.1:3000/api/tickets/<ticketId>/rerun \
  -H "Content-Type: application/json" \
  -H "Cookie: sessionId=<session>" \
  -d '{}'
```

#### B. Reassess
Use when the model failed with a specific error and the operator wants the next run to see the prior failure context. Injects `priorFailureContext` into the first model request.

**API:**
```bash
curl -X POST http://127.0.0.1:3000/api/tickets/<ticketId>/rerun \
  -H "Content-Type: application/json" \
  -H "Cookie: sessionId=<session>" \
  -d '{"mode":"reassess"}'
```

#### C. Revise (close old ticket, create new)
Use when the objective itself was too broad or ambiguous. The operator closes the old ticket and creates a new one with a narrower objective.

**CLI:**
```bash
node scripts/oquery.js create-ticket --url http://127.0.0.1:3000 --agent 1 --json "Narrower objective here"
```

### 5. Inspect Final Artifact

After the run completes, the operator checks the workspace for the expected artifact.

**CLI:**
```bash
ls workspace-root/
cat workspace-root/<artifact-name>.md
```

**Evidence:** The artifact path can also be found in the operation history:
```bash
grep 'writeFile' data/operation-history.json | grep <runId>
```

### 6. Confirm Telemetry

The operator regenerates the telemetry report to confirm the outcome is recorded.

**CLI:**
```bash
node scripts/telemetry-report.js
cat data/telemetry-report.md
```

**What to verify:**
- The run appears in the summary with correct status
- The profile metrics reflect the ticket class
- Failure metrics are accurate if the run failed
- Artifact metrics include the generated file

## Decision Matrix

| Failure Kind | Symptom | Remediation |
|--------------|---------|-------------|
| `timeout` | Model took too long | Retry with same agent, or use faster model |
| `step` / `no_progress` | Model stalled in loops | Revise objective to be more specific |
| `operation` / limit exhaustion | Exceeded listDirectory/readFile limit | Revise objective to scope down |
| `provider_error` | Model OOM or API error | Retry, or switch agent/model |
| `phase_violation` | Mixed-phase response | Retry (guidance should prevent this) |
| `unsupported_objective` | Model said it cannot complete | Revise objective to use allowed operations |

## Example Session

```bash
# 1. Create ticket
$ node scripts/oquery.js create-ticket --agent 1 --json "List all files"
{ "ticketId": 49, "runId": 60, "status": "pending" }

# 2. Wait and check status
$ node scripts/oquery.js runs --id 60 --json --api
[ { "status": "failed", "error": "Agent run exceeded listDirectory limit of 3" } ]

# 3. Inspect failure
$ node scripts/oquery.js replay --api 60
# Shows: agent listed root, then src, then config, then hit limit before moving any files

# 4. Decide: objective was too broad. Revise.
$ node scripts/oquery.js create-ticket --agent 1 --json "List the workspace root and create status.md"
{ "ticketId": 54, "runId": 65, "status": "pending" }

# 5. Check completion
$ node scripts/oquery.js runs --id 65 --json --api
[ { "status": "completed" } ]
$ ls workspace-root/status.md
workspace-root/status.md

# 6. Confirm telemetry
$ node scripts/telemetry-report.js
# Report shows: report profile 1 completed, 0 phase violations, 1 artifact generated
```

## Operator Invariants

1. Every ticket creates at least one run.
2. Every terminal run has a `replaySummary` with a `failure.kind` or `terminalStatus === 'completed'`.
3. The rerun endpoint always accepts `mode` (defaults to `retry`).
4. Reassess mode injects `priorFailureContext` only on the first model request of the new run.
5. Telemetry is deterministic: the same ledger always produces the same report.
6. Artifacts are inspectable directly in `workspace-root/`.
