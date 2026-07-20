# Operator Workflow

## Overview

This document describes the operator loop for managing tickets through the system. A human operator creates tickets, observes run progress, inspects failures, decides on remediation, and confirms outcomes.

> Companion: `docs/OPERATIONS.md` holds the sizing heuristics, ticket-quality guidance, and learned practices behind this procedure.

## Operator Loop

### 1. Create a Ticket

The operator creates a ticket with a clear objective and assigns it to an agent.

**CLI:**
```bash
node scripts/oquery.js login --url http://127.0.0.1:3099
node scripts/oquery.js agents --url http://127.0.0.1:3099
node scripts/oquery.js create-ticket --url http://127.0.0.1:3099 --agent 'Developer Agent' --json "Create a workspace status report named status.md"
```

**API:**
```bash
curl -X POST http://127.0.0.1:3099/tickets \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "Cookie: sessionId=<session>" \
  -d "objective=Create+a+workspace+status+report" \
  -d "assignmentTargetType=agent" \
  -d "assignmentTargetId=1"
```

**Expected response:** the browser route redirects to the created ticket. Prefer the CLI with `--json` when ticket and run IDs are needed by automation.

### 2. Observe Run Status

The operator polls the run status until it reaches a terminal state.

**CLI:**
```bash
node scripts/oquery.js runs --url http://127.0.0.1:3099 --id <runId> --json --api
```

**API:**
```bash
curl http://127.0.0.1:3099/api/runs/<runId>/state \
  -H "Cookie: sessionId=<session>"
```

**Expected response:** Includes `status`, `currentPhase`, `mutationCount`, `replaySummary`, and `error` if failed.

### 3. Inspect Failure Reason

If the run failed, the operator inspects the failure reason.

**CLI:**
```bash
pnpm codex:trace -- --run <runId>
```

**API:**
```bash
curl http://127.0.0.1:3099/api/runs/<runId>/events \
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
node scripts/oquery.js rerun --url http://127.0.0.1:3099 --id <ticketId> --json
```

**API:**
```bash
curl -X POST http://127.0.0.1:3099/api/tickets/<ticketId>/rerun \
  -H "Content-Type: application/json" \
  -H "Cookie: sessionId=<session>" \
  -d '{}'
```

#### B. Reassess
Use when the model failed with a specific error and the operator wants the next run to see the prior failure context. Injects `priorFailureContext` into the first model request.

**API:**
```bash
curl -X POST http://127.0.0.1:3099/api/tickets/<ticketId>/rerun \
  -H "Content-Type: application/json" \
  -H "Cookie: sessionId=<session>" \
  -d '{"mode":"reassess"}'
```

#### C. Revise (close old ticket, create new)
Use when the objective itself was too broad or ambiguous. The operator closes the old ticket and creates a new one with a narrower objective.

**CLI:**
```bash
node scripts/oquery.js create-ticket --url http://127.0.0.1:3099 --agent 'Developer Agent' --json "Narrower objective here"
```

### 5. Inspect Final Artifact

After the run completes, the operator checks the workspace for the expected artifact.

**CLI/API:**
```bash
node scripts/oquery.js workspace --url http://127.0.0.1:3099 ls
node scripts/oquery.js workspace --url http://127.0.0.1:3099 cat <artifact-name>.md
```

**Evidence:** Trace the run to inspect its persisted events, operations, evaluation, and consequence:
```bash
pnpm codex:trace -- --run <runId>
```

### 6. Confirm Runtime Evidence

Confirm the terminal state and its PostgreSQL-backed runtime evidence.

**CLI:**
```bash
node scripts/oquery.js runs --url http://127.0.0.1:3099 --id <runId> --json --api
pnpm codex:trace -- --run <runId>
```

**What to verify:**
- The run has the expected terminal status
- Events and operations correspond to the run
- `runEvaluation` and `runConsequence` reflect the outcome
- The expected artifact is visible through the workspace API

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
$ node scripts/oquery.js create-ticket --agent "Developer Agent" --json "List all files"
{ "ticketId": 49, "runId": 60, "status": "pending" }

# 2. Wait and check status
$ node scripts/oquery.js runs --id 60 --json --api
[ { "status": "failed", "error": "Agent run exceeded listDirectory limit of 3" } ]

# 3. Inspect failure
$ pnpm codex:trace -- --run 60
# Shows: agent listed root, then src, then config, then hit limit before moving any files

# 4. Decide: objective was too broad. Revise.
$ node scripts/oquery.js create-ticket --agent "Developer Agent" --json "List the workspace root and create status.md"
{ "ticketId": 54, "runId": 65, "status": "pending" }

# 5. Check completion
$ node scripts/oquery.js runs --id 65 --json --api
[ { "status": "completed" } ]
$ node scripts/oquery.js workspace cat status.md
<file contents>

# 6. Confirm persisted evidence
$ pnpm codex:trace -- --run 65
# Trace shows the terminal run, operations, evaluation, and consequence
```

## Operator Invariants

1. Every ticket creates at least one run.
2. Every terminal run has a `replaySummary` with a `failure.kind` or `terminalStatus === 'completed'`.
3. The rerun endpoint always accepts `mode` (defaults to `retry`).
4. Reassess mode injects `priorFailureContext` only on the first model request of the new run.
5. Terminal evidence remains queryable from PostgreSQL through the trace and API surfaces.
6. Artifacts are inspectable through the workspace API and CLI.
