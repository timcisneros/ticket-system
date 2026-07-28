# Bounded process execution contract — Tranche 1

Tranche 1 adds trusted target/profile configuration, exact agent grants, admission-time
resolution, and immutable run snapshots. It does not provide an executor and cannot
start a process.

## Authority

The governing rule is:

> The model requests an existing process profile.
>
> The runtime resolves and enforces authority.
>
> The target configuration grants authority.
>
> Process output is evidence, not authority.

The model cannot expand a target/profile grant. Enabling the contract is not a grant.
The trusted catalog is validated once at runtime startup. At run admission, the runtime
resolves the assigned agent's exact grants against that catalog, deep-copies the complete
authority material into `run.processPolicySnapshot`, and hashes the canonical snapshot.
Dispatch never rereads the live catalog or live agent configuration.

The snapshot is stored in the PostgreSQL run JSONB body, included in the append-only
`run.created` event, and copied to `replaySnapshot.processPolicySnapshot`. Later catalog,
grant, array, or object mutation cannot rewrite the admitted snapshot or its hash.

The capability gate is `ENABLE_PROCESS_EXECUTION_CONTRACT=true`; it is false by default.
Configured grants confer no authority while it is disabled. Workflow runs receive no
process authority. Direct agents receive only their explicitly assigned profiles.

Phase authority is explicit:

> A process profile declares its permitted runtime phase.
>
> The run snapshot captures that declaration.
>
> The runtime envelope may advertise runProcess in a phase only when at least one
> snapshotted profile is permitted in that phase.
>
> Authorization rechecks the selected profile against the current phase.

The only profile phases are `inspection`, `mutation`, and `verification`.
`allowedPhases` is nonempty, deduplicated, and canonically ordered. `runProcess` has no
global phase-catalog assignment.

## Trusted catalog

The default trusted file is `config/process-targets.json`; an operator can select another
trusted file with `PROCESS_TARGET_CATALOG_FILE`. Its closed version-1 schema is:

```json
{
  "version": 1,
  "targets": [
    {
      "id": "ticket-system-local",
      "profiles": [
        {
          "id": "syntax-check",
          "allowedPhases": ["verification"],
          "executable": "/usr/bin/node",
          "arguments": ["--check", "server.js"],
          "workingDirectory": ".",
          "environment": {
            "CI": "1"
          },
          "limits": {
            "wallTimeMs": 30000,
            "maxOutputBytes": 1048576,
            "maxProcesses": 8
          }
        }
      ]
    }
  ]
}
```

Target IDs are globally unique. Profile IDs are unique within a target. Both use the
frozen 1–128-character process identifier contract: lowercase ASCII letters, numbers,
dots, underscores, and hyphens, with an alphanumeric first character and no surrounding
whitespace or control characters.

`executable` is one normalized absolute path, at most 4,096 UTF-8 bytes. Command strings,
relative paths, shell fields, and general shell interpreters are rejected. The catalog
is not probed and the executable is not resolved or launched in this tranche.

`arguments` is an ordered string array with at most 128 entries, 16,384 UTF-8 bytes per
argument, and 131,072 bytes in aggregate. `workingDirectory` is a normalized POSIX path
relative to the run workspace; absolute paths, backslashes, and parent traversal are
rejected.

`environment` is a replacement map of at most 64 literal string values, each at most
16,384 UTF-8 bytes. Variable names use the platform-independent
`[A-Za-z_][A-Za-z0-9_]*` form. Ambient inheritance and secret-reference fields do not
exist. Secret-bearing variable names are rejected. Process profile configuration must
not contain secrets because literal values are intentionally frozen in the run snapshot.

All limits are required positive safe integers. The hard ceilings are:

- `wallTimeMs`: 300,000
- `maxOutputBytes`: 16,777,216
- `maxProcesses`: 64

Zero, omission, infinity, and values above these ceilings are rejected.

## Exact grant assignment

Trusted configured-agent storage uses the existing `runtimeConfig` JSON field:

```json
{
  "processProfileGrants": [
    {
      "targetId": "ticket-system-local",
      "profileIds": ["syntax-check"]
    }
  ]
}
```

Each reference is exact. Referring to a target never grants all of its profiles. When the
feature is enabled, an unknown target fails admission with `PROCESS_TARGET_UNKNOWN` and
an unknown profile fails admission with `PROCESS_PROFILE_UNKNOWN`; no partial run is
created. The grant list is also closed, bounded by the identifier contract, deduplicated,
and canonically ordered.

## Versioned run snapshot

Newly admitted runs store this canonical version-2 shape:

```json
{
  "version": 2,
  "capabilityEnabled": true,
  "profiles": [
    {
      "targetId": "ticket-system-local",
      "profileId": "syntax-check",
      "allowedPhases": ["verification"],
      "executable": "/usr/bin/node",
      "arguments": ["--check", "server.js"],
      "workingDirectory": ".",
      "environment": {
        "CI": "1"
      },
      "limits": {
        "wallTimeMs": 30000,
        "maxOutputBytes": 1048576,
        "maxProcesses": 8
      },
      "executionPolicy": {
        "shell": false,
        "stdin": "disabled",
        "detached": false,
        "networkAccess": "none",
        "environmentMode": "replace"
      }
    }
  ],
  "capturedAt": "2026-07-27T12:00:00.000Z",
  "snapshotHash": "lowercase-sha256"
}
```

Targets, profiles, phases, and environment keys are canonicalized before hashing. The
fixed execution policy is authority for a future executor, not a claim that Tranche 1
provides kernel enforcement.

Version-1 Tranche 0 grant-reference snapshots remain readable as historical policy. They
are never resolved through the live catalog and expose no executable authority. Stored
historical runs are not rewritten.

## Model request and envelope

The closed direct-action request remains:

```json
{
  "operation": "runProcess",
  "args": {
    "targetId": "configured-target-id",
    "profileId": "configured-profile-id",
    "operationId": "stable-operation-id"
  }
}
```

The model cannot supply a command, executable, arguments, environment, working directory,
shell syntax, redirection, pipeline, timeout, resource limit, background option, or
detached option.

For the current phase, the runtime envelope reads only the immutable version-2 snapshot
and projects:

```json
{
  "processTargets": [
    {
      "targetId": "ticket-system-local",
      "profileIds": ["syntax-check"]
    }
  ],
  "processOperation": {
    "requiredArgs": ["targetId", "profileId", "operationId"]
  }
}
```

It advertises `runProcess` only when this projection is nonempty. Executable paths,
arguments, working directories, environment values, and limits never enter the model
envelope.

Dispatch parses the closed request, reads only the run snapshot, distinguishes unknown
target from unknown profile, checks `allowedPhases` against `run.currentPhase`, records
`authority.allowed` or `authority.denied`, and records one
`process.operation_resolution`. The typed results are:

- `PROCESS_CAPABILITY_DISABLED`
- `PROCESS_TARGET_UNKNOWN`
- `PROCESS_PROFILE_UNKNOWN`
- `PROCESS_PHASE_DENIED`
- `PROCESS_EXECUTOR_UNAVAILABLE`

Successful authorization always records `authority.allowed` before terminating with
`PROCESS_EXECUTOR_UNAVAILABLE`. No process-start evidence, PID, output, operation receipt,
or effect claim is created.

`operationId` identifies one process request within a run; it is not globally unique.
The runtime hashes `(runId, operationId)` for evidence identity and looks up prior
`processOperations` replay evidence before appending. Repeating the same ID, target, and
profile is request-resolution replay and appends no duplicate resolution. Reusing the ID
for a different target or profile fails with `PROCESS_OPERATION_ID_CONFLICT`. This is not
execution idempotency because no executor exists.

## Terminal outcome and future evidence contracts

The frozen process outcomes remain:

- `completed`
- `failed_to_start`
- `exited_nonzero`
- `signaled`
- `timed_out`
- `cancelled`
- `output_limit_exceeded`
- `policy_denied`
- `runtime_interrupted`

`runtime/process-execution-contract.js` remains the machine-readable future evidence
field authority and structural validator. It enforces identifiers, positive run/ticket
IDs, canonical UTC timestamps, nonnegative measurements, typed arrays and booleans,
outcome-specific requirements, and stdout/stderr inline-versus-artifact exclusivity.
Inline output has a 65,536-byte UTF-8 ceiling.

Pre-execution identity consists of `operationId`, `runId`, `ticketId`, `targetId`,
`profileId`, `resolvedExecutable`, `argumentVector`, `workingDirectory`,
`declaredEnvironmentVariableNames`, `policySnapshotHash`, and `startedAt`. Environment
values are forbidden from evidence.

Terminal evidence consists of `finishedAt`, `durationMs`, `pid`, `processGroupId`,
`exitCode`, `terminatingSignal`, `terminalOutcome`, `enforcementCause`, stdout/stderr byte
counts and truncation states, and one bounded inline value or artifact reference per
stream. Process output remains evidence and can never alter the prior authority decision.
