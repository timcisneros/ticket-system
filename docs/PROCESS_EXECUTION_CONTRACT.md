# Bounded process execution contract — Tranche 2A1

Tranche 2A0 froze executable-authority version 3 and the private immutable launch-plan
contract. Tranche 2A1 adds the trusted immutable execution-input materializer described
in `docs/PROCESS_INPUT_MATERIALIZER.md`. It still provides no rootfs registry, sandbox
capability probe, launcher, or executor and cannot start a process. Version-1 and
version-2 process-policy snapshots remain readable historical records and are
permanently non-executable. A valid version-3 snapshot and a materialized input are
necessary but not sufficient for future execution.

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

## Historical catalog version 1

The default trusted file is `config/process-targets.json`; an operator can select another
trusted file with `PROCESS_TARGET_CATALOG_FILE`. The closed version-1 schema is retained
only to preserve existing admission behavior that produces historical, executor-free
version-2 snapshots:

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
exist. A conservative sensitive-name denylist rejects names containing common secret,
token, password, API-key, private-key, or credential markers as defense in depth. This
name heuristic cannot determine whether an arbitrary literal value is sensitive.
Trusted operators must not put secrets in process-profile literal environment values
because those values are intentionally frozen in the run snapshot.

All limits are required positive safe integers. The hard ceilings are:

- `wallTimeMs`: 300,000
- `maxOutputBytes`: 16,777,216
- `maxProcesses`: 64

Zero, omission, infinity, and values above these ceilings are rejected.

Authority configuration and snapshots also have fixed cardinality ceilings:

- targets per catalog: 64
- profiles per target: 64
- total profiles per catalog: 256
- grant entries per configured agent: 32
- profile IDs per grant entry: 32
- resolved profiles per version-2 run snapshot: 128

The catalog, configured-agent grant normalizer, admission grant resolver, snapshot
builder, and persisted snapshot reader all enforce the applicable ceilings. A matching
snapshot hash does not make an oversized snapshot authoritative.

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

## Catalog version 2

Catalog version 2 is the first executable-authority catalog schema. It declares trusted
versioned runtime rootfs identities and profiles refer to those entries exactly:

```json
{
  "version": 2,
  "runtimeRootfs": [
    {
      "id": "node-24-fedora-runtime-v1",
      "manifestSha256": "lowercase-sha256"
    }
  ],
  "targets": [
    {
      "id": "ticket-system-local",
      "profiles": [
        {
          "id": "syntax-check",
          "allowedPhases": ["verification"],
          "runtimeRootfsId": "node-24-fedora-runtime-v1",
          "executableIdentity": {
            "path": "/usr/bin/node",
            "sha256": "lowercase-sha256",
            "format": "elf"
          },
          "arguments": ["--check", "server.js"],
          "workingDirectory": ".",
          "environment": {"CI": "1"},
          "filesystemPolicy": {
            "inputMode": "materialized_read_only",
            "writableRoots": [],
            "allowSymlinks": false,
            "allowSpecialFiles": false,
            "maxInputFiles": 10000,
            "maxInputBytes": 268435456
          },
          "limits": {
            "wallTimeMs": 30000,
            "maxOutputBytes": 1048576,
            "maxProcesses": 8,
            "memoryBytes": 268435456,
            "cpuQuotaMicrosPer100ms": 100000,
            "maxOpenFiles": 128,
            "maxFileBytes": 16777216,
            "maxTempBytes": 67108864
          }
        }
      ]
    }
  ]
}
```

The rootfs deployment contract is root-owned, versioned, non-writable by the runtime and
future launcher UID, represented by a complete canonical manifest, verified before a
future backend becomes healthy, and retained while an admitted or executing operation
references it. Live host `/usr`, `/lib`, `/lib64`, `/bin`, and operator home directories
are never substitutes. A future trusted operator mapping may associate the rootfs ID with
an installed host path, but that mapping is not model input and is not dispatch authority.

Executable paths are normalized absolute paths interpreted inside the selected rootfs.
Their lowercase SHA-256 and `format: "elf"` are mandatory. Scripts, shebangs, command
strings, host `PATH` resolution, and model-derived executable identity cannot be
represented. No dependency layer exists in the initial schema; a later layer must be
explicitly identified and manifest-hashed before it can become authority.

The initial filesystem policy is read-only and closed. `writableRoots` must be empty,
symlinks and special files cannot be enabled, and `maxInputFiles`/`maxInputBytes` are
positive integers no larger than 10,000 and 268,435,456 respectively.

All eight resource values are required positive safe integers. Their hard ceilings are:

- `wallTimeMs`: 300,000
- `maxOutputBytes`: 16,777,216
- `maxProcesses`: 64 kernel tasks
- `memoryBytes`: 1,073,741,824
- `cpuQuotaMicrosPer100ms`: 100,000
- `maxOpenFiles`: 256
- `maxFileBytes`: 67,108,864
- `maxTempBytes`: 268,435,456

`maxProcesses` counts kernel tasks, including threads and future namespace-init overhead,
but excludes the trusted launcher daemon.

## Versioned run snapshots

### Historical version 2

Catalog-version-1 admissions retain this canonical version-2 shape:

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

Targets, profiles, phases, grant references, and environment keys are canonicalized
before hashing with one locale-independent ordinal string comparator. The runtime phase
list, fixed execution policy, identifier rules, comparator, and authority cardinality
ceilings live in the dependency-neutral
`runtime/process-authority-constants.js` module. The fixed execution policy is authority
for a future executor, not a claim that Tranche 1 provides kernel enforcement.

Version-1 grant-reference and version-2 resolved-profile snapshots remain readable as
historical policy. They are never upgraded through the live catalog and can never produce
a launch plan. Stored historical runs are not rewritten.

### Executable-authority version 3

Catalog-version-2 admissions store complete resolved authority:

```json
{
  "version": 3,
  "capabilityEnabled": true,
  "profiles": [
    {
      "targetId": "ticket-system-local",
      "profileId": "syntax-check",
      "allowedPhases": ["verification"],
      "runtimeRootfs": {
        "id": "node-24-fedora-runtime-v1",
        "manifestSha256": "lowercase-sha256"
      },
      "executableIdentity": {
        "path": "/usr/bin/node",
        "sha256": "lowercase-sha256",
        "format": "elf"
      },
      "arguments": ["--check", "server.js"],
      "workingDirectory": ".",
      "environment": {"CI": "1"},
      "filesystemPolicy": {
        "inputMode": "materialized_read_only",
        "writableRoots": [],
        "allowSymlinks": false,
        "allowSpecialFiles": false,
        "maxInputFiles": 10000,
        "maxInputBytes": 268435456
      },
      "limits": {
        "wallTimeMs": 30000,
        "maxOutputBytes": 1048576,
        "maxProcesses": 8,
        "memoryBytes": 268435456,
        "cpuQuotaMicrosPer100ms": 100000,
        "maxOpenFiles": 128,
        "maxFileBytes": 16777216,
        "maxTempBytes": 67108864
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

All nested authority is deep-copied, canonically ordered with the shared ordinal
comparator, hashed with canonical JSON, and deeply frozen. Version 3 remains
non-dispatchable in 2A0. `processAuthorityReferences` does not project it into the model
envelope; a future healthy sandbox-capability generation is an additional mandatory gate.

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

For existing historical compatibility, the runtime envelope can read an immutable
version-2 snapshot
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

Version-3 snapshots do not produce this projection in 2A0. Executable paths,
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
- `PROCESS_SANDBOX_UNAVAILABLE`
- `PROCESS_EXECUTOR_UNAVAILABLE`

Version-3 resolution has an additional mandatory sandbox-capability gate. The current
runtime capability value is permanently `null` in this tranche, so a hidden or direct
version-3 request resolves exactly as:

```json
{
  "code": "PROCESS_SANDBOX_UNAVAILABLE",
  "disposition": "policy_denied",
  "authorityStatus": "denied",
  "terminalOutcome": "policy_denied"
}
```

It records `authority.denied`, never `authority.allowed`. Missing, malformed, unhealthy,
future-dated, or stale capability data has the same fail-closed result. Historical
version-2 requests retain their executor-unavailable compatibility behavior, but remain
permanently unable to create launch plans. No process-start evidence, PID, output,
operation receipt, launch plan, or effect claim is created.

The future sandbox capability descriptor is closed and time-bounded:

```json
{
  "version": 1,
  "status": "healthy",
  "generationId": "sandbox-generation-001",
  "launcherProtocolVersion": 1,
  "launcherIdentityHash": "lowercase-sha256",
  "sandboxBackendIdentityHash": "lowercase-sha256",
  "seccompPolicyHash": "lowercase-sha256",
  "rootfsRegistryGeneration": "rootfs-registry-001",
  "materializerGeneration": "materializer-001",
  "verifiedAt": "canonical UTC timestamp",
  "validUntil": "canonical UTC timestamp"
}
```

Generation identifiers use the process identifier contract. Protocol versions are
positive and at most 16. Validity is positive and at most five minutes, and the
descriptor is healthy only between `verifiedAt` and `validUntil`. Tranche 2A0 defines
validation only; it does not probe or produce this descriptor.

`operationId` identifies one process request within a run; it is not globally unique.
The runtime hashes `(runId, operationId)` for evidence identity and looks up prior
`processOperations` replay evidence before appending. Repeating the same ID, target, and
profile is request-resolution replay and appends no duplicate authority or resolution
evidence. Exact replay returns the original persisted resolution without checking the
run's later phase again. Reusing the ID for a different target or profile fails with
`PROCESS_OPERATION_ID_CONFLICT`. This is not execution idempotency because no executor
exists.

Each `process.operation_resolution` replay item persists this closed reconstruction
shape:

```json
{
  "operationId": "stable-operation-id",
  "runId": 123,
  "ticketId": 45,
  "targetId": "ticket-system-local",
  "profileId": "syntax-check",
  "disposition": "unsupported",
  "code": "PROCESS_EXECUTOR_UNAVAILABLE",
  "authorityStatus": "allowed",
  "terminalOutcome": null,
  "runtimePhase": "verification",
  "policySnapshotHash": "lowercase-sha256",
  "message": "stable resolution message",
  "enforcementCause": {
    "kind": "contract_resolution",
    "disposition": "unsupported",
    "errorCode": "PROCESS_EXECUTOR_UNAVAILABLE",
    "authorityStatus": "allowed",
    "runtimePhase": "verification"
  }
}
```

`runId` and `ticketId` retain evidence ownership. The remaining fields reconstruct the
typed original result exactly. The redundant `enforcementCause` projection is validated
against the top-level fields for existing event consumers; it cannot override them.

## Terminal outcome and future evidence contracts

The frozen process outcomes remain:

- `completed`
- `failed_to_start`
- `exited_nonzero`
- `signaled`
- `timed_out`
- `cancelled`
- `output_limit_exceeded`
- `resource_limit_exceeded`
- `policy_denied`
- `runtime_interrupted`

`resource_limit_exceeded` uses an exact structured cause:

```json
{
  "kind": "resource_limit",
  "cause": "memory"
}
```

Allowed causes are `memory`, `process_count`, `cpu`, `open_files`, `file_size`, and
`temporary_storage`. A resource-limit outcome requires an established process identity
and ownership identity.

Launcher capacity is a pre-start refusal instead:

```json
{
  "terminalOutcome": "failed_to_start",
  "enforcementCause": {
    "kind": "launcher_capacity"
  }
}
```

It retains request and resolved launch identity plus finish timestamp and duration, but
forbids PID, process-group, exit, signal, stdout, and stderr claims. It cannot be encoded
as `resource_limit_exceeded`.

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

## Immutable execution-input materialization

Neither process authority nor a launch plan contains a mutable host workspace path. A
dedicated Rust materializer now runs while holding the PostgreSQL workspace-root mutation
boundary and:

- include only authorized regular files;
- reject symlinks and special files;
- apply the separately versioned process-input exclusion policy;
- enforce the snapshotted file-count and byte bounds;
- create a service-owned sealed read-only tree;
- hash a canonical file manifest; and
- rescan and verify the source against the copied manifest before releasing the boundary.

Its trusted output descriptor is:

```json
{
  "id": "snapshot-lowercase-random-hex",
  "runId": 123,
  "policySnapshotHash": "lowercase-sha256",
  "materializerGeneration": "materializer-v1-lowercase-sha256",
  "manifestSha256": "lowercase-sha256",
  "fileCount": 123,
  "totalBytes": 456789
}
```

The descriptor is bounded by the selected profile's immutable filesystem policy and
bound to the run, process-policy snapshot, operation, and current materializer
generation. A service-owned durable registry maps the opaque ID to sealed private state
and `getSnapshot` revalidates every ownership field, manifest, count, and byte total.
The descriptor is not a path and cannot select a mutable source location. The exact
configuration, protocol, generation derivation, traversal/race rules, manifest, registry,
sealing sequence, failures, and cross-UID release proof are specified in
`docs/PROCESS_INPUT_MATERIALIZER.md`.

## Private launch-plan contract

`runtime/process-launch-plan.js` is a pure builder and validator. It has no launcher
client or side-effecting dependency. The builder accepts one closed immutable
launch-authority context:

```json
{
  "runId": 123,
  "ticketId": 45,
  "currentPhase": "verification",
  "processPolicySnapshot": {"version": 3}
}
```

It validates positive run/ticket IDs, normalizes and copies the version-3 snapshot,
validates the runtime phase, resolves the selected target/profile only from that
snapshot, verifies the selected profile permits the phase, rejects extra fields, and
deep-freezes the normalized context. The builder accepts `operationId`, not a precomputed
operation identity, and derives
`buildProcessOperationIdentity(context.runId, operationId)`.

A valid context, a bound workspace descriptor, and a current healthy sandbox capability
generation can produce version-1 launch-plan material:

```json
{
  "version": 1,
  "operationId": "operation-001",
  "operationIdentity": "process-operation:lowercase-sha256",
  "runId": 123,
  "ticketId": 45,
  "targetId": "ticket-system-local",
  "profileId": "syntax-check",
  "policySnapshotHash": "lowercase-sha256",
  "runtimePhase": "verification",
  "sandboxCapability": {
    "generationId": "sandbox-generation-001",
    "launcherProtocolVersion": 1,
    "launcherIdentityHash": "lowercase-sha256",
    "sandboxBackendIdentityHash": "lowercase-sha256",
    "seccompPolicyHash": "lowercase-sha256",
    "rootfsRegistryGeneration": "rootfs-registry-001",
    "materializerGeneration": "materializer-001"
  },
  "runtimeRootfs": {
    "id": "node-24-fedora-runtime-v1",
    "manifestSha256": "lowercase-sha256"
  },
  "executableIdentity": {
    "path": "/usr/bin/node",
    "sha256": "lowercase-sha256",
    "format": "elf"
  },
  "arguments": ["--check", "server.js"],
  "workingDirectory": ".",
  "environment": {"CI": "1"},
  "workspaceSnapshot": {
    "id": "runtime-generated-opaque-id",
    "runId": 123,
    "policySnapshotHash": "lowercase-sha256",
    "materializerGeneration": "materializer-001",
    "manifestSha256": "lowercase-sha256",
    "fileCount": 123,
    "totalBytes": 456789
  },
  "filesystemPolicy": {
    "inputMode": "materialized_read_only",
    "writableRoots": [],
    "allowSymlinks": false,
    "allowSpecialFiles": false,
    "maxInputFiles": 10000,
    "maxInputBytes": 268435456
  },
  "limits": {
    "wallTimeMs": 30000,
    "maxOutputBytes": 1048576,
    "maxProcesses": 8,
    "memoryBytes": 268435456,
    "cpuQuotaMicrosPer100ms": 100000,
    "maxOpenFiles": 128,
    "maxFileBytes": 16777216,
    "maxTempBytes": 67108864
  },
  "executionPolicy": {
    "shell": false,
    "stdin": "disabled",
    "detached": false,
    "networkAccess": "none",
    "environmentMode": "replace"
  },
  "launchPlanHash": "lowercase-sha256"
}
```

The builder derives run ID, ticket ID, phase, policy hash, and operation identity rather
than accepting duplicate free-standing values. Executable, arguments, environment,
filesystem, limits, and fixed execution policy are copied solely from the immutable run
snapshot. The validator recomputes the operation identity, rebuilds the plan from the
same context, verifies workspace run/policy/materializer binding, and verifies the exact
sandbox generation. A plan built under one sandbox generation cannot validate under
another. All generation and workspace fields participate in `launchPlanHash`.

The contract rejects extra fields, raw rootfs/workspace host paths, independently supplied
operation identities, and authority expansion. Versions 1 and 2 return
`PROCESS_POLICY_SNAPSHOT_NOT_EXECUTABLE`; missing or invalid sandbox health returns
`PROCESS_SANDBOX_UNAVAILABLE`.

Launch plans are private runtime-to-launcher material and never enter the model envelope.

## Network meaning

`networkAccess: "none"` means:

> The process and its descendants cannot communicate with anything outside their
> operation sandbox.

Future enforcement requires an isolated network namespace, no host interfaces or socket
mounts, no inherited sockets, and syscall filtering for external network families and
host connection paths. The contract deliberately does not require denial of unnamed
operation-local IPC such as Unix `socketpair`; that is not external communication and may
be required by a configured runtime. Standard input remains disabled, no PTY may be
allocated, and detached execution is forbidden. Process sandbox enforcement remains
absent in 2A1.

## Future authenticated launcher boundary

The future launcher protocol will use `/run/ticket-system-process` owned by the launcher
service with mode `0750`, a socket owned by the launcher service and ticket-system service
group with mode `0660`, and `SO_PEERCRED` validation against the exact configured
ticket-system service UID. It will accept only closed bounded versioned messages no larger
than 2,097,152 bytes and reject client-provided host mount paths, raw Bubblewrap options,
and raw cgroup names. It has no unsandboxed fallback.

Its pre-execution barrier is:

```text
create operation cgroup
→ set every limit
→ create blocked sandbox child
→ move child into cgroup
→ verify membership
→ release child
→ execute untrusted code
```

No untrusted code may run before membership and every limit are active.

## Remaining tranche sequence

- **2A2:** rootfs deployment mapping, retention, manifest verification, and capability
  health contract.
- **2A3:** launcher protocol/server and pre-execution cgroup barrier, still not connected
  to model dispatch.
- **2B:** connect authorized dispatch, durable start/terminal evidence, bounded output
  artifacts, cancellation/recovery, and execution idempotency.
